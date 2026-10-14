import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNativeShellFromStream } from "../../src/harness/cli-verify.mjs";

test("codex shell-less inventory is denied, not a false pass from missing bash name", () => {
  const names = ["read_file", "apply_patch", "list_dir"];
  assert.equal(
    evaluateNativeShellFromStream({
      events: [{ type: "tool_inventory", names }],
    }),
    "denied"
  );
});

test("inventory listing exec_command counts as shell allowed", () => {
  assert.equal(
    evaluateNativeShellFromStream({
      events: [
        {
          type: "tool_inventory",
          names: ["read_file", "exec_command", "write_stdin"],
        },
      ],
    }),
    "allowed"
  );
});

test("Claude bash inventory without bash name still uses bash tool_use path", () => {
  assert.equal(
    evaluateNativeShellFromStream({
      events: [{ type: "tool_use", name: "Bash", input: { command: "echo x" } }],
    }),
    "allowed"
  );
});
