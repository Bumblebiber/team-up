import test from "node:test";
import assert from "node:assert/strict";
import { approvalKey } from "../../src/specialists/approvals.mjs";

test("approval is bound to project, version, checksum, and permissions", () => {
  const key = approvalKey({
    project: "/work/app",
    id: "testing.hannes",
    version: "0.1.0",
    checksum: "sha256:abc",
    permissions: { filesystem: "project", network: false }
  });
  assert.notEqual(key, approvalKey({
    project: "/work/app",
    id: "testing.hannes",
    version: "0.1.0",
    checksum: "sha256:def",
    permissions: { filesystem: "project", network: false }
  }));
});
