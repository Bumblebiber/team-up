import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapWithSandbox, systemdAvailable } from "../../src/sandbox/systemd.mjs";

test("launcher default probe is real systemdAvailable not injected true", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/specialists/launcher.mjs"),
    "utf8"
  );
  assert.match(src, /probe = sandbox\?\.probe/);
  assert.match(src, /systemdAvailable/);
  assert.doesNotMatch(src, /sandbox\.probe \? sandbox\.probe\(\) : true/);
  assert.equal(typeof systemdAvailable, "function");
  try {
    wrapWithSandbox({
      command: ["true"],
      permissions: { network: false },
      cwd: "/tmp",
    });
  } catch (e) {
    assert.equal(e.code, "SANDBOX_UNAVAILABLE");
  }
});
