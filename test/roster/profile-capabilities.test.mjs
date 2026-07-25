import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../../src/roster/profile.mjs";

const roster = {
  accounts: {
    cursor: { kind: "subscription", enabled: true },
    anthropic: { kind: "subscription", enabled: true },
  },
  clis: {
    cursor: { cmd: ["cursor-agent", "{prompt}"] },
    claude: { cmd: ["claude", "{prompt}"] },
  },
  models: {
    "frontier-cursor": {
      tier: "frontier",
      cli: ["cursor"],
      account: "cursor",
      reasoning: { max: "xhigh" },
      priority: 1,
    },
    "frontier-claude": {
      tier: "frontier",
      cli: ["claude"],
      account: "anthropic",
      reasoning: { max: "max" },
      priority: 2,
    },
  },
};

test("command specialist chain excludes unverified harnesses", () => {
  const result = resolveProfile({
    roster,
    usage: {},
    profile: { tier: "frontier", reasoning: "max" },
    requirements: { command_broker: "team-up.command-broker/v1" },
    harnessCapabilities: (cli) =>
      cli === "claude"
        ? { command_broker: "team-up.command-broker/v1" }
        : { command_broker: null },
  });
  assert.deepEqual(result.chain.map((x) => x.cli), ["claude"]);
  assert.ok(result.skipped.some((x) => /command broker/.test(x.reason)));
});

test("capability filtering never admits another tier", () => {
  const result = resolveProfile({
    roster,
    usage: {},
    profile: { tier: "frontier", reasoning: "max" },
    requirements: { command_broker: "team-up.command-broker/v1" },
    harnessCapabilities: () => ({ command_broker: null }),
  });
  assert.equal(result.code, "PROFILE_UNAVAILABLE");
  assert.deepEqual(result.chain, []);
});
