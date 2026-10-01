import test from "node:test";
import assert from "node:assert/strict";
import { groupEfforts, cliModelFor } from "../../src/roster/config.mjs";
import { buildCommand } from "../../src/roster/command.mjs";
import { addOfferedVersions, upgradeChains } from "../../src/roster/latest.mjs";

const scan = (ids) => ({ supported: true, scanned_at: new Date().toISOString(), models: ids.map((cli_id) => ({ cli_id })) });
const roster = {
  clis: { cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] } },
  accounts: { cursor: { kind: "subscription", enabled: true } },
  models: {
    "grok-4.7": { cli: ["cursor"], account: "cursor", tier: "high", cli_model: "grok-4.7-{effort}",
      efforts: ["low", "medium", "high", "xhigh"], effort: "high",
      reasoning: { max: "high", high: "high", medium: null, low: null } },
  },
  roles: { r: { chain: [{ model: "grok-4.7", cli: "cursor", effort: "xhigh" }] } },
};

test("cursor ids fold per model; -fast, -thinking and bare defaults stay apart", () => {
  const g = groupEfforts(["gpt-5.2", "gpt-5.2-low", "gpt-5.2-high", "gpt-5.2-fast", "gpt-5.2-low-fast",
    "gpt-5.5-extra-high", "gpt-5.5-low", "claude-4.6-opus-high-thinking", "claude-4.6-opus-max-thinking", "composer-2.5"]);
  assert.deepEqual(g.map((x) => [x.id, x.efforts, !!x.bare]), [
    ["gpt-5.2-{effort}", ["low", "high"], true],
    ["gpt-5.2-{effort}-fast", ["low"], true],
    ["gpt-5.5-{effort}", ["low", "extra-high"], false],
    ["claude-4.6-opus-{effort}-thinking", ["high", "max"], false],
    ["composer-2.5", [], false],
  ]);
});

test("the effort lands in the model id, and never as one the model lacks", () => {
  const argv = (effort) => buildCommand({ roster, model: "grok-4.7", cli: "cursor", prompt: "P", effort })[2];
  assert.equal(argv("xhigh"), "grok-4.7-xhigh");
  assert.equal(argv(null), "grok-4.7-high"); // the model's default
  assert.equal(argv("max"), "grok-4.7-high"); // a role-wide level goes through the reasoning map
  assert.equal(argv("bogus"), "grok-4.7-high");
  assert.equal(cliModelFor(roster, "grok-4.7", "cursor"), "grok-4.7-high");
});

test("a newer cursor version arrives once, as a template, unless excluded", () => {
  const store = { clis: { cursor: scan(["grok-4.7-low", "grok-4.7-high", "grok-4.8-low", "grok-4.8-medium", "grok-4.8-high", "grok-4.8-high-fast"]) } };
  const { next, added } = addOfferedVersions(roster, store);
  assert.deepEqual(added.map((a) => a.id), ["grok-4.8"]);
  assert.deepEqual(next.models["grok-4.8"], { cli: ["cursor"], account: "cursor", tier: "high", cli_model: "grok-4.8-{effort}",
    reasoning: { max: "high", high: "high", medium: "medium", low: "low" }, efforts: ["low", "medium", "high"], effort: "medium" });
  assert.deepEqual(addOfferedVersions(next, store).added, []);
  assert.deepEqual(addOfferedVersions({ ...roster, models_excluded: ["cursor:grok-4.8-{effort}"] }, store).added, []);
  // The chain moves to it and keeps its effort.
  const moved = upgradeChains(next, store).next;
  assert.deepEqual(moved.roles.r.chain, [{ model: "grok-4.8", cli: "cursor", effort: "xhigh" }]);
  // grok-4.8 has no xhigh: the strongest step below it, not the default.
  assert.equal(buildCommand({ roster: moved, model: "grok-4.8", cli: "cursor", prompt: "P", effort: "xhigh" })[2], "grok-4.8-high");
});
