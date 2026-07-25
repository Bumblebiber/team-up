import test from "node:test";
import assert from "node:assert/strict";
import { createBoundedStream, MAX_CAPTURE, executeApprovedAction } from "../../src/commands/execute.mjs";
import fs from "node:fs";
import os from "node:os";

test("bounded stream stops accumulating after limit", () => {
  const acc = createBoundedStream(16);
  acc.push(Buffer.alloc(10, 0x61));
  acc.push(Buffer.alloc(20, 0x62));
  acc.push(Buffer.alloc(50, 0x63));
  const r = acc.result();
  assert.equal(r.truncated, true);
  assert.ok(r.bytes <= 16);
  assert.ok(r.dropped > 0);
});

test("executeApprovedAction enforces capture limit while streaming", async () => {
  const project = fs.mkdtempSync(pathJoin());
  const runDir = fs.mkdtempSync(pathJoin());
  const result = await executeApprovedAction({
    actionId: "big",
    policy: {
      schema_version: 1,
      commands: {
        big: {
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write('x'.repeat(2000))",
          ],
          cwd: ".",
          timeout_seconds: 10,
          environment: {},
        },
      },
    },
    project,
    runDir,
    maxCapture: 100,
  });
  assert.equal(result.stdout_truncated, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 100);
  assert.ok(MAX_CAPTURE > 100);
});

function pathJoin() {
  return fs.mkdtempSync(`${os.tmpdir()}/tu-exec-`);
}
