import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.mjs";

test("version prints package version", async () => {
  const lines = [];
  const code = await runCli(["version"], { out: line => lines.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(lines, ["0.1.0"]);
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
