import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelIds,
  referencedCells,
  checkModelAvailability,
} from "../../src/roster/availability.mjs";

const ROSTER = {
  clis: {
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
    opencode: { cmd: ["opencode", "run", "--model", "{model}", "{prompt}"] },
    claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
  },
  models: {
    "grok-4.6": { cli: ["cursor"], cli_model: "cursor-grok-4.6-medium" },
    "gone-alpha": { cli: ["opencode"], cli_model: "openrouter/stealth/gone-alpha" },
    "claude-opus": { cli: ["claude"] },
  },
  roles: {
    planner: { chain: ["cursor:grok-4.6"] },
    implementer: { chain: ["opencode:gone-alpha", "claude:claude-opus"] },
  },
};

const LISTINGS = {
  "cursor-agent": "Available models\n\ncursor-grok-4.6-medium - Cursor Grok 4.6 Medium\nauto - Auto (default)\n",
  opencode: "openrouter/x-ai/grok-4.6\nopenrouter/deepseek/deepseek-v4-pro\n",
};
const run = (bin, args) => {
  const out = LISTINGS[bin];
  if (out === undefined) throw new Error(`${bin} ${args.join(" ")}: not found`);
  return out;
};

test("parseModelIds takes the id and drops prose", () => {
  const ids = parseModelIds(LISTINGS["cursor-agent"]);
  assert.ok(ids.has("cursor-grok-4.6-medium"));
  assert.ok(ids.has("auto"));
  assert.equal(ids.has("Available"), true, "a bare word is indistinguishable from an id");
  assert.equal(parseModelIds("models:\nfoo\n").has("models:"), false, "a heading is not an id");
});

test("referencedCells reports the string the CLI would actually receive", () => {
  const cells = referencedCells(ROSTER);
  assert.deepEqual(
    cells.map((c) => `${c.cli}:${c.sent}`).sort(),
    ["claude:claude-opus", "cursor:cursor-grok-4.6-medium", "opencode:openrouter/stealth/gone-alpha"]
  );
});

test("a retired model is missing, a live one present", () => {
  const by = Object.fromEntries(
    checkModelAvailability({ roster: ROSTER, run }).map((c) => [`${c.cli}:${c.model}`, c])
  );
  assert.equal(by["cursor:grok-4.6"].status, "present");
  assert.equal(by["opencode:gone-alpha"].status, "missing");
});

test("a CLI that cannot enumerate is unknown, never missing", () => {
  const by = Object.fromEntries(
    checkModelAvailability({ roster: ROSTER, run }).map((c) => [`${c.cli}:${c.model}`, c])
  );
  // claude has no listing subcommand — a false "missing" here would be noise
  // on every run and get the whole check tuned out.
  assert.equal(by["claude:claude-opus"].status, "unknown");
  assert.match(by["claude:claude-opus"].reason, /cannot list/);
});

test("a failed listing is unknown too, and reports why", () => {
  const failing = () => {
    throw new Error("boom");
  };
  const cells = checkModelAvailability({ roster: ROSTER, run: failing });
  assert.ok(cells.every((c) => c.status === "unknown"));
  assert.match(cells.find((c) => c.cli === "cursor").reason, /boom/);
});

test("without a runner nothing is claimed missing", () => {
  const cells = checkModelAvailability({ roster: ROSTER });
  assert.ok(cells.every((c) => c.status === "unknown"));
});
