import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The decision logic lives in Python next to its own selftest; this keeps it in `npm test`.
const script = fileURLToPath(new URL("../../scripts/usage-spender.py", import.meta.url));

test("usage-spender selftest passes", () => {
  const r = spawnSync("python3", [script, "--selftest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /selftest ok/);
});
