import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCommand, tmuxArgs } from "../../src/roster/command.mjs";
import { prepareArgvFromDescriptor } from "../../src/supervisor/start.mjs";

const roster = {
  clis: { codex: { cmd: ["codex", "--dangerously-bypass-approvals-and-sandbox", "--model", "{model}", "--", "{prompt}"] } },
  models: { m: { cli: ["codex"] } },
};

test("Codex worker trusts only its canonical cwd with a TOML table override", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'task.with dots "quotes" \\ slash \' $(touch INJECTED)');
  fs.mkdirSync(dir);
  const alias = path.join(root, "alias");
  fs.symlinkSync(dir, alias);
  const prompt = "Write one sentence.";
  const argv = buildCommand({ roster, model: "m", cli: "codex", prompt, dir: alias });
  const trust = `projects={${JSON.stringify(dir)}={trust_level="trusted"}}`;
  assert.ok(argv.includes(trust), "must pre-authorize the dispatched directory before Codex starts");
  assert.ok(argv.indexOf(trust) < argv.indexOf("--"));
  assert.ok(argv.includes("check_for_update_on_startup=false"));
  assert.equal(argv.at(-1), prompt);
  // Exercise the same shell quoting used by tmux, including hostile path characters.
  const command = tmuxArgs({ session: "test", dir, argv: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...argv] }).at(-1);
  const received = JSON.parse(execFileSync("bash", ["-c", command], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(received, argv);
  assert.equal(fs.existsSync(path.join(root, "INJECTED")), false);
});

test("command previews without a worker directory and other CLIs keep their arguments", () => {
  assert.deepEqual(buildCommand({ roster, cli: "codex", model: "m", prompt: "p" }), ["codex", "--dangerously-bypass-approvals-and-sandbox", "--model", "m", "--", "p"]);
  assert.deepEqual(buildCommand({ roster: { clis: { claude: { cmd: ["claude", "{prompt}"] } } }, cli: "claude", model: "m", prompt: "p", dir: "/tmp" }), ["claude", "p"]);
});

test("supervisor rebuilds Codex trust for the actual worker context directory", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-trust-supervisor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const promptPath = path.join(dir, "PROMPT.md");
  fs.writeFileSync(promptPath, "Do work.");
  const prepared = prepareArgvFromDescriptor({ cli: "codex", model: "m", context_dir: dir, prompt_path: promptPath, permissions: {} }, { roster, probe: () => false });
  assert.ok(prepared.argv.includes(`projects={${JSON.stringify(dir)}={trust_level="trusted"}}`));
  assert.equal(prepared.dir, dir);
});

test("dispatch --run-id pre-authorizes the run cwd and an explicit --dir override", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-trust-dispatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "task");
  const override = path.join(root, "override");
  for (const dir of [bin, cwd, override]) fs.mkdirSync(dir);
  const log = path.join(root, "tmux.json");
  fs.writeFileSync(path.join(bin, "tmux"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TMUX_LOG, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const fixtureRoster = structuredClone(roster);
  fixtureRoster.roles = { implementer: { chain: ["codex:m"] } };
  const rosterFile = path.join(root, "roster.json");
  fs.writeFileSync(rosterFile, JSON.stringify(fixtureRoster));
  const promptFile = path.join(root, "prompt.md");
  fs.writeFileSync(promptFile, "Do work.");
  const usageFile = path.join(root, "usage.json");
  fs.writeFileSync(usageFile, JSON.stringify({ windows: { "codex:5h": { used: 0, updated: new Date().toISOString() } } }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_LOG: log, TEAM_UP_ROSTER: rosterFile, TEAM_UP_USAGE: usageFile, TEAM_UP_RUNS: path.join(root, "runs") };
  const cli = fileURLToPath(new URL("../../bin/team-up.mjs", import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: "utf8" });
  const created = run("runs", "create", "--cwd", cwd, "--role", "implementer", "--parent-cli", "codex", "--parent-attach", "manual", "--worker-cli", "codex", "--prompt-file", promptFile);
  const runId = created.match(/runId: (\S+)/)[1];
  for (const explicitDir of [null, override]) {
    run("dispatch", "--role", "implementer", "--run-id", runId, ...(explicitDir ? ["--dir", explicitDir] : []));
    const args = JSON.parse(fs.readFileSync(log, "utf8"));
    const expectedDir = explicitDir || cwd;
    assert.equal(args[args.indexOf("-c") + 1], expectedDir);
    assert.ok(args.at(-1).includes(`projects={${JSON.stringify(expectedDir)}={trust_level="trusted"}}`));
    assert.ok(args.at(-1).includes("check_for_update_on_startup=false"));
  }
});
