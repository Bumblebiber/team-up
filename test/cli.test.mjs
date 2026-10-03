import "./helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.mjs";
import { debugLog } from "../src/debug.mjs";

test("version prints package version", async () => {
  const lines = [];
  const code = await runCli(["version"], { out: line => lines.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(lines, ["0.6.0"]);
});

test("runs gc --dry-run reports without mutating temp runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-cli-gc-"));
  const previous = process.env.TEAM_UP_RUNS;
  process.env.TEAM_UP_RUNS = root;
  const output = [];
  const errors = [];
  try {
    const code = await runCli(["runs", "gc", "--dry-run"], {
      out: line => output.push(line),
      err: line => errors.push(line),
    });
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
  } finally {
    if (previous === undefined) delete process.env.TEAM_UP_RUNS;
    else process.env.TEAM_UP_RUNS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// debugLog runs inside the limit-watch hook of every Claude session. The flag
// was inverted (TEAM_UP_DEBUG silenced it) and the log ignored TEAM_UP_HOME.
function debugLogged(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-debug-"));
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    debugLog("scope-x", new Error("boom"), { ...env, TEAM_UP_HOME: home });
    const file = path.join(home, "logs", "hook-errors.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  } finally {
    process.stderr.write = write;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("TEAM_UP_DEBUG=1 logs hook errors under TEAM_UP_HOME", () => {
  assert.match(debugLogged({ TEAM_UP_DEBUG: "1" }) ?? "", /\[scope-x\] Error: boom/);
});

test("the legacy O9K_DEBUG=1 still turns hook error logging on", () => {
  assert.match(debugLogged({ O9K_DEBUG: "1" }) ?? "", /\[scope-x\]/);
});

test("hook error logging stays off without a debug flag", () => {
  assert.equal(debugLogged({}), null);
});
