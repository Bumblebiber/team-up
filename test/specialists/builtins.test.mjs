import test from "node:test";
import assert from "node:assert/strict";
import { builtinsForPermissions } from "../../src/specialists/launcher.mjs";

// The adapter default is Read/Edit/Write/Glob/Grep/ToolSearch/Skill for everyone.
// That handed a `writes: false` researcher the write tools, and gave a
// `network: true` one no way to reach the network at all — the sandbox opened it,
// the tool list did not. ToolSearch and Skill stay on the floor: neither writes
// nor reaches the network, and a `--tools` list without Skill silently disables
// every skill the capsule just materialized.
test("builtin tools follow the approved permissions", () => {
  assert.deepEqual(
    builtinsForPermissions({ filesystem: "project_readonly", writes: false, network: true }),
    ["Read", "Glob", "Grep", "ToolSearch", "Skill", "WebFetch", "WebSearch"]
  );
  assert.deepEqual(
    builtinsForPermissions({ filesystem: "project", writes: "delegated_only", network: false }),
    ["Read", "Glob", "Grep", "ToolSearch", "Skill", "Edit", "Write"]
  );
  // Absent permissions grant the read-only floor, never the union.
  assert.deepEqual(builtinsForPermissions({}), ["Read", "Glob", "Grep", "ToolSearch", "Skill"]);
  assert.deepEqual(builtinsForPermissions(), ["Read", "Glob", "Grep", "ToolSearch", "Skill"]);
});
