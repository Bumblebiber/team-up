import test from "node:test";
import assert from "node:assert/strict";
import { builtinsForPermissions } from "../../src/specialists/launcher.mjs";

// The adapter default is Read/Edit/Write/Glob/Grep for everyone. That handed a
// `writes: false` researcher Edit, and gave a `network: true` one no way to
// reach the network at all — the sandbox opened it, the tool list did not.
test("builtin tools follow the approved permissions", () => {
  assert.deepEqual(
    builtinsForPermissions({ filesystem: "project_readonly", writes: false, network: true }),
    ["Read", "Glob", "Grep", "ToolSearch", "Skill", "Write", "WebFetch", "WebSearch"]
  );
  assert.deepEqual(
    builtinsForPermissions({ filesystem: "project", writes: "delegated_only", network: false }),
    ["Read", "Glob", "Grep", "ToolSearch", "Skill", "Write", "Edit"]
  );
  // Absent permissions grant the floor, never the union.
  assert.deepEqual(builtinsForPermissions({}), ["Read", "Glob", "Grep", "ToolSearch", "Skill", "Write"]);
  assert.deepEqual(builtinsForPermissions(), ["Read", "Glob", "Grep", "ToolSearch", "Skill", "Write"]);
});

// Removing Write from a read-only specialist does not make it safer, it makes
// it unable to report: the mailbox protocol requires creating RESULT.json and
// setting STATUS, and a specialist that cannot do that finishes the work and
// strands it in a terminal nobody reads while the watcher waits.
test("every specialist can close its own mailbox", () => {
  for (const writes of [false, true, "delegated_only", undefined]) {
    assert.ok(
      builtinsForPermissions({ filesystem: "project_readonly", writes }).includes("Write"),
      `writes:${String(writes)} must still be able to write RESULT.json`
    );
  }
  // Edit is the tool that changes existing files, so it stays gated.
  assert.ok(!builtinsForPermissions({ writes: false }).includes("Edit"));
});
