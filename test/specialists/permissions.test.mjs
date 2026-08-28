import test from "node:test";
import assert from "node:assert/strict";
import { intersectPermissions, assertCallTypeAllowed, credentialDenyRules } from "../../src/specialists/permissions.mjs";

const approved = {
  filesystem: "project",
  writes: "delegated_only",
  network: false,
  commands: ["project-test"],
};

test("request may reduce permissions but not expand", () => {
  const reduced = intersectPermissions(approved, {
    network: false,
    writes: false,
    filesystem: "project_readonly",
    commands: [],
  });
  assert.equal(reduced.network, false);
  assert.equal(reduced.writes, false);
  assert.equal(reduced.filesystem, "project_readonly");
  assert.deepEqual(reduced.commands, []);
});

test("rejects network enable", () => {
  assert.throws(
    () => intersectPermissions(approved, { network: true }),
    /escalation: network/
  );
});

test("rejects filesystem expansion", () => {
  assert.throws(
    () => intersectPermissions(
      { ...approved, filesystem: "project_readonly" },
      { filesystem: "project" }
    ),
    /escalation: filesystem/
  );
});

test("rejects writable escalation and undeclared commands", () => {
  assert.throws(
    () => intersectPermissions(approved, { writes: true }),
    /escalation: writes/
  );
  assert.throws(
    () => intersectPermissions(approved, { commands: ["project-test", "rm"] }),
    /undeclared|escalation/
  );
});

test("rejects tools/mcps/frameworks beyond capabilities", () => {
  assert.throws(
    () => intersectPermissions(approved, { tools: ["shell"] }, { capabilities: { tools: [] } }),
    /undeclared|escalation/
  );
});

test("assertCallTypeAllowed", () => {
  assert.doesNotThrow(() => assertCallTypeAllowed("review", { call_types: ["consult", "review"] }));
  assert.throws(() => assertCallTypeAllowed("delegate", { call_types: ["consult"] }), /call_type/);
});

test("credential deny rules use the absolute-path rule syntax", () => {
  const rules = credentialDenyRules("/home/x");
  // Verified against the CLI: an absolute path in a permission rule carries a
  // leading `//`. A rule that parses but matches nothing raises no error and is
  // indistinguishable from a working one, so the syntax is asserted here.
  for (const r of rules) {
    assert.match(r, /^Read\(\/\/home\/x\//);
    assert.ok(r.endsWith(")"));
  }
  assert.ok(rules.includes("Read(//home/x/.mcp.json)"));
  assert.ok(rules.includes("Read(//home/x/.ssh/**)"));
  // Narrow on purpose: the gh token lives in hosts.yml, config.yml beside it
  // does not, and ~/.claude holds a capsule's own config.
  assert.ok(rules.includes("Read(//home/x/.config/gh/hosts.yml)"));
  assert.ok(!rules.some((r) => r === "Read(//home/x/.claude/**)"));
});
