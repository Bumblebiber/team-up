// usage.json and roster.json are read by the watcher, the hooks and every
// dispatch while the CLI rewrites them. A write in place truncates the file
// first, so a concurrent reader can catch it empty or half written. A
// temp-file-then-rename replaces it whole: the path then names a new inode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROSTER_BIN = fileURLToPath(new URL("../../src/roster/roster.mjs", import.meta.url));

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-atomic-"));
  const rosterPath = path.join(home, "roster.json");
  const usagePath = path.join(home, "usage.json");
  const scoresPath = path.join(home, "scores.json");
  fs.writeFileSync(rosterPath, `${JSON.stringify({
    clis: {
      claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
      codex: { cmd: ["codex", "--model", "{model}", "{prompt}"] },
    },
    models: {
      a: { provider: "anthropic", cli: ["claude"] },
      b: { provider: "openai", cli: ["codex"] },
    },
    roles: { implementer: { chain: ["claude:a"] } },
  }, null, 2)}\n`);
  fs.writeFileSync(usagePath, `${JSON.stringify({ windows: {} })}\n`);
  // b outscores the head by far and costs less: proposeRoleChanges applies it.
  fs.writeFileSync(scoresPath, JSON.stringify({
    models: {},
    role_scores: {
      implementer: [
        { cli: "codex", model: "b", score: 90, blended: 1 },
        { cli: "claude", model: "a", score: 50, blended: 2 },
      ],
    },
  }));
  const env = {
    ...process.env,
    TEAM_UP_ROSTER: rosterPath,
    TEAM_UP_USAGE: usagePath,
    TEAM_UP_SCORES: scoresPath,
  };
  return { home, rosterPath, usagePath, env };
}

function cli(env, args) {
  return execFileSync(process.execPath, [ROSTER_BIN, ...args], { env, encoding: "utf8" });
}

test("mark-limited replaces usage.json whole instead of rewriting it in place", () => {
  const fx = fixture();
  const before = fs.statSync(fx.usagePath).ino;
  cli(fx.env, ["mark-limited", "b", "--ttl", "5h", "--reason", "test"]);
  assert.notEqual(fs.statSync(fx.usagePath).ino, before);
  const usage = JSON.parse(fs.readFileSync(fx.usagePath, "utf8"));
  assert.equal(usage.marked.b.reason, "test");
  assert.deepEqual(fs.readdirSync(fx.home).filter((f) => f.endsWith(".tmp")), []);
});

test("apply-scores replaces roster.json whole instead of rewriting it in place", () => {
  const fx = fixture();
  const before = fs.statSync(fx.rosterPath).ino;
  const out = cli(fx.env, ["apply-scores"]);
  assert.match(out, /roster updated/);
  assert.notEqual(fs.statSync(fx.rosterPath).ino, before);
  const roster = JSON.parse(fs.readFileSync(fx.rosterPath, "utf8"));
  assert.equal(roster.roles.implementer.chain[0], "codex:b");
});

test("saveRoster (dashboard edits) replaces roster.json whole instead of rewriting it in place", async () => {
  const { saveRoster } = await import("../../src/roster/config.mjs");
  const fx = fixture();
  const before = fs.statSync(fx.rosterPath).ino;
  const next = JSON.parse(fs.readFileSync(fx.rosterPath, "utf8"));
  next.roles.implementer.chain = ["codex:b"];
  const { backup } = saveRoster(next, { env: { TEAM_UP_ROSTER: fx.rosterPath } });
  assert.notEqual(fs.statSync(fx.rosterPath).ino, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(fx.rosterPath, "utf8")).roles.implementer.chain, ["codex:b"]);
  assert.ok(fs.existsSync(backup));
});

test("writeScores replaces scores.json whole instead of rewriting it in place", async () => {
  const { writeScores } = await import("../../src/scores/scores.mjs");
  const fx = fixture();
  const dest = path.join(fx.home, "scores.json");
  const before = fs.statSync(dest).ino;
  writeScores({ models: {}, role_scores: {} }, dest);
  assert.notEqual(fs.statSync(dest).ino, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), { models: {}, role_scores: {} });
});

test("atomicWriteJson leaves no temp file behind when the rename fails", async () => {
  const { atomicWriteJson } = await import("../../src/json-store.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-atomic-"));
  // A directory at the target: the temp file is written, the rename throws.
  fs.mkdirSync(path.join(home, "usage.json"));
  assert.throws(() => atomicWriteJson(path.join(home, "usage.json"), { a: 1 }));
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".tmp")), []);
});
