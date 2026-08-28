import test from "node:test";
import assert from "node:assert/strict";
import { builtinsForPermissions } from "../../src/specialists/permissions.mjs";

test("a read-only specialist is not handed the write tools", () => {
  const tools = builtinsForPermissions({ writes: false, network: false });
  assert.deepEqual(tools, ["Read", "Glob", "Grep", "ToolSearch", "Skill"]);
  // The two that matter: the adapter default would have granted both.
  assert.equal(tools.includes("Write"), false);
  assert.equal(tools.includes("Edit"), false);
});

test("delegated writes and network widen the list, nothing else does", () => {
  assert.deepEqual(
    builtinsForPermissions({ writes: "delegated_only", network: true }),
    ["Read", "Glob", "Grep", "ToolSearch", "Skill", "Edit", "Write", "WebFetch", "WebSearch"]
  );
  assert.equal(
    builtinsForPermissions({ writes: true, network: false }).includes("WebFetch"),
    false
  );
});

test("Skill survives a read-only manifest", () => {
  // A capsule materializes skills into its own home; dropping Skill from the
  // allowlist would leave the worker unable to invoke what it was given.
  assert.equal(builtinsForPermissions({}).includes("Skill"), true);
});
