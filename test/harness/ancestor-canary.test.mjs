import "../helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeAdapter } from "../../src/harness/claude.mjs";
import { capsuleContextDir } from "../../src/capabilities/capsule.mjs";
import {
  ANCESTOR_CANARY_INSTRUCTIONS,
  ANCESTOR_CANARY_SKILL,
  ISOLATION_FORBIDDEN_CANARIES,
  PLUGIN_CANARY_SKILL,
  buildIsolationCanaryFixture,
  collectLiveIsolationObservation,
  parseClaudeStructuredCapabilityProofs,
} from "../../src/harness/isolation-canary.mjs";
import { assertIsoFailure } from "../helpers/isolation-assert.mjs";

/**
 * Production capsule workers listed the host's skills and loaded its CLAUDE.md
 * because Claude reads project config from every directory above the cwd, and
 * a run's cwd sits under the user's home. The canary probed a neutral temp dir
 * with nothing above it, so it could not see that. These tests pin the
 * canary to the production layout and prove it now fails without the fix.
 */

const SESSION = "sess-ancestor-1";

function prepare(fixture) {
  return claudeAdapter.prepareLaunch({
    argv: ["claude", "--print", "probe"],
    runDir: fixture.runRoot,
    capsule: fixture.capsule,
    writeFileSync: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
    chmodSync: () => {},
  });
}

function flagValue(args, flag) {
  const i = args.lastIndexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function childDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Stand-in for the claude binary, discovering config the way 2.1.286 was
 * measured to: user skills and $HOME/.claude/CLAUDE.md from the user source,
 * and — unless --setting-sources leaves `project` out — `.claude/skills` and
 * `CLAUDE.md` from the cwd and every directory above it. CLAUDE.md lands only
 * in the session transcript, never in system/init. `instructionsAlways`
 * models a build that stops gating CLAUDE.md on the flag.
 */
function fakeClaude(fixture, { instructionsAlways = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const sources = (flagValue(args, "--setting-sources") ?? "user,project,local").split(",");
    const home = opts.env.HOME;
    const skills = sources.includes("user") ? childDirs(path.join(home, ".claude", "skills")) : [];
    const instructions = [];
    const userMd = path.join(home, ".claude", "CLAUDE.md");
    if (sources.includes("user") && fs.existsSync(userMd)) {
      instructions.push({ path: userMd, type: "User", content: fs.readFileSync(userMd, "utf8") });
    }
    for (let dir = opts.cwd; ; dir = path.dirname(dir)) {
      if (sources.includes("project")) skills.push(...childDirs(path.join(dir, ".claude", "skills")));
      const md = path.join(dir, "CLAUDE.md");
      if ((sources.includes("project") || instructionsAlways) && fs.existsSync(md)) {
        instructions.push({ path: md, type: "Project", content: fs.readFileSync(md, "utf8") });
      }
      if (dir === path.dirname(dir)) break;
    }
    const { nonces } = fixture.expected;
    const skillBody = `Base directory for this skill: ${home}/.claude/skills/capsule.selected-skill\n\nnonce:${nonces.skill}\n`;
    const transcript = [
      { type: "attachment", sessionId: SESSION, attachment: { type: "skill_listing", content: skills.join("\n") } },
      ...(instructions.length
        ? [{ type: "attachment", sessionId: SESSION, attachment: { type: "instructions", files: instructions } }]
        : []),
      { type: "user", sessionId: SESSION, isMeta: true, message: { content: [{ type: "text", text: skillBody }] } },
    ];
    const slugDir = path.join(home, ".claude", "projects", opts.cwd.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, `${SESSION}.jsonl`), transcript.map((l) => JSON.stringify(l)).join("\n"));

    const fwPath = path.join(fixture.capsule.frameworkDirs[0], "capsule.selected-framework", "framework.json");
    const ev = (o) => JSON.stringify({ session_id: SESSION, ...o });
    const use = (id, name, input) => ev({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (id, content) => ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
    const synthetic = (text) => ev({ type: "user", isSynthetic: true, message: { content: [{ type: "text", text }] } });
    const stdout = [
      ev({
        type: "system",
        subtype: "init",
        tools: ["Read", "Skill", "ToolSearch", "mcp__selected__lookup"],
        mcp_servers: [{ name: "selected", status: "connected" }],
        skills: [...skills, PLUGIN_CANARY_SKILL],
        plugins: ["capsule.selected-plugin"],
        claude_code_version: "2.1.286",
      }),
      use("tu-skill", "Skill", { skill: "capsule.selected-skill" }),
      result("tu-skill", "Launching skill: capsule.selected-skill"),
      synthetic(skillBody),
      use("tu-plugin", "Skill", { skill: PLUGIN_CANARY_SKILL }),
      result("tu-plugin", `Launching skill: ${PLUGIN_CANARY_SKILL}`),
      synthetic(`Base directory for this skill: /p/${PLUGIN_CANARY_SKILL}\n\nnonce:${nonces.plugin}\n`),
      use("tu-fw", "Read", { file_path: fwPath }),
      result("tu-fw", JSON.stringify({ name: "capsule.selected-framework", content_nonce: nonces.framework })),
      use("tu-mcp", "mcp__selected__lookup", {}),
      result("tu-mcp", `team-up-canary-ok:${nonces.mcp}`),
    ].join("\n");
    return { status: 0, stdout: `${stdout}\n`, stderr: "" };
  };
  spawn.calls = calls;
  return spawn;
}

function observe(fixture, prepared, spawnSyncFn) {
  return collectLiveIsolationObservation({
    prepared,
    capsule: fixture.capsule,
    globalHome: fixture.globalHome,
    expected: fixture.expected,
    adapterId: "claude",
    spawnSyncFn,
  });
}

function withoutSettingSources(prepared) {
  const argv = [...prepared.argv];
  const i = argv.indexOf("--setting-sources");
  if (i !== -1) argv.splice(i, 2);
  return { ...prepared, argv };
}

test("both ancestor canaries are required absent", () => {
  assert.ok(ISOLATION_FORBIDDEN_CANARIES.includes(ANCESTOR_CANARY_SKILL));
  assert.ok(ISOLATION_FORBIDDEN_CANARIES.includes(ANCESTOR_CANARY_INSTRUCTIONS));
});

test("the probe runs in the production cwd layout, under the planted ancestor canaries", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const spawn = fakeClaude(fixture);
    const observed = observe(fixture, prepare(fixture), spawn);
    assert.equal(observed.ok, undefined, JSON.stringify(observed));
    const cwd = spawn.calls[0].cwd;
    assert.equal(cwd, capsuleContextDir(fixture.runRoot));
    assert.equal(fixture.capsule.contextDir, cwd);
    // Planted strictly above the cwd, where the host's own home sits in production.
    const ancestor = fixture.root;
    assert.ok(cwd.startsWith(`${ancestor}${path.sep}`));
    assert.ok(fs.existsSync(path.join(ancestor, ".claude", "skills", ANCESTOR_CANARY_SKILL, "SKILL.md")));
    assert.match(
      fs.readFileSync(path.join(ancestor, "CLAUDE.md"), "utf8"),
      new RegExp(fixture.expected.ancestor_nonce)
    );
    assert.ok(observed.absent.includes(ANCESTOR_CANARY_SKILL));
    assert.ok(observed.absent.includes(ANCESTOR_CANARY_INSTRUCTIONS));
  } finally {
    fixture.cleanup();
  }
});

test("negative control: without --setting-sources the canary sees the ancestor and refuses", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const observed = observe(fixture, withoutSettingSources(prepare(fixture)), fakeClaude(fixture));
    assertIsoFailure(observed);
    assert.match(`${observed.reason}: ${observed.detail}`, new RegExp(ANCESTOR_CANARY_SKILL.replace(".", "\\.")));
  } finally {
    fixture.cleanup();
  }
});

test("an ancestor CLAUDE.md is caught on its own, from the session transcript", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const observed = observe(fixture, prepare(fixture), fakeClaude(fixture, { instructionsAlways: true }));
    assertIsoFailure(observed, "forbidden_canary_present");
    assert.equal(observed.detail, ANCESTOR_CANARY_INSTRUCTIONS);
  } finally {
    fixture.cleanup();
  }
});

test("no transcript proves nothing about CLAUDE.md, so isolation is not granted", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const fake = fakeClaude(fixture);
    const noTranscript = (cmd, args, opts) => {
      const out = fake(cmd, args, opts);
      fs.rmSync(path.join(opts.env.HOME, ".claude", "projects"), { recursive: true, force: true });
      return out;
    };
    const observed = observe(fixture, prepare(fixture), noTranscript);
    assertIsoFailure(observed, "absent_list_incomplete");
    // A CLI that stops keeping -p transcripts fails every verification here; the
    // record has to say which canary went unobserved.
    assert.equal(observed.detail, `not observed: ${ANCESTOR_CANARY_INSTRUCTIONS}`);
  } finally {
    fixture.cleanup();
  }
});

// The CLAUDE.md check needs proof that this build records instructions in the
// transcript at all: builds before 2.1.284 loaded CLAUDE.md without recording
// it. A user-level CLAUDE.md the user source still loads is that proof.
test("the CLAUDE.md control is a user CLAUDE.md planted in the probe's home, never a production one", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepare(fixture);
    const userMd = path.join(prepared.env.HOME, ".claude", "CLAUDE.md");
    // prepareLaunch builds the production capsule home; it holds none.
    assert.equal(fs.existsSync(userMd), false);
    const observed = observe(fixture, prepared, fakeClaude(fixture));
    assert.ok(observed.absent?.includes(ANCESTOR_CANARY_INSTRUCTIONS), JSON.stringify(observed));
    assert.match(fs.readFileSync(userMd, "utf8"), new RegExp(`nonce:${fixture.expected.user_instructions_nonce}`));
  } finally {
    fixture.cleanup();
  }
});

test("a transcript with tool results but no recorded user CLAUDE.md is no positive control", () => {
  const fixture = buildIsolationCanaryFixture();
  try {
    const prepared = prepare(fixture);
    const stream = fakeClaude(fixture)("claude", prepared.argv, {
      cwd: fixture.capsule.contextDir,
      env: { HOME: prepared.env.HOME },
    }).stdout;
    const parse = (transcriptText) => parseClaudeStructuredCapabilityProofs(stream, {
      expected: fixture.expected, capsule: fixture.capsule, prepared, transcriptText,
    });
    assertIsoFailure(parse('{"type":"user"}'), "absent_list_incomplete");
    // The selected skill's body shows a transcript exists, not that it records instructions.
    assertIsoFailure(parse(`{"text":"nonce:${fixture.expected.nonces.skill}"}`), "absent_list_incomplete");
    assert.ok(parse(`{"text":"nonce:${fixture.expected.user_instructions_nonce}"}`).absent.includes(ANCESTOR_CANARY_INSTRUCTIONS));
  } finally {
    fixture.cleanup();
  }
});
