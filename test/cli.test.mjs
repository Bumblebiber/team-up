import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.mjs";

test("version prints package version", async () => {
  const lines = [];
  const code = await runCli(["version"], { out: line => lines.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(lines, ["0.1.0"]);
});
