import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateRoster } from "../../src/roster/migrate.mjs";
import { validateRoster } from "../../src/roster/config.mjs";
import { resolveProfile } from "../../src/roster/profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const examplePath = path.join(root, "roster.example.json");

test("shipped example roster migrates and resolves Hannes + Reanna exact tiers", () => {
  const legacy = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  // Simulate legacy mid tier still present on a copy
  const withMid = structuredClone(legacy);
  withMid.models["claude-sonnet-5"].tier = "mid";
  // Strip accounts/reasoning to force migration fill
  const stripped = structuredClone(withMid);
  delete stripped.accounts;
  for (const m of Object.values(stripped.models)) {
    delete m.account;
    delete m.reasoning;
  }

  const migrated = migrateRoster(stripped);
  assert.equal(migrated.models["claude-sonnet-5"].tier, "medium");
  const { errors } = validateRoster(migrated);
  assert.equal(errors.length, 0, errors.join("; "));

  const hannes = resolveProfile({
    roster: migrated,
    usage: {},
    profile: { tier: "frontier", reasoning: "max" },
    specialistId: "testing.hannes",
    callType: "review",
  });
  assert.equal(hannes.code, "OK", JSON.stringify(hannes.skipped.slice(0, 8)));
  assert.ok(hannes.chain.length >= 1);
  for (const c of hannes.chain) {
    assert.equal(migrated.models[c.model].tier, "frontier");
  }

  const reanna = resolveProfile({
    roster: migrated,
    usage: {},
    profile: { tier: "medium", reasoning: "low" },
    specialistId: "research.reanna",
    callType: "consult",
  });
  assert.equal(reanna.code, "OK", JSON.stringify(reanna.skipped.slice(0, 8)));
  for (const c of reanna.chain) {
    assert.equal(migrated.models[c.model].tier, "medium");
  }
  assert.ok(!reanna.chain.some((c) => ["frontier", "high", "low"].includes(migrated.models[c.model].tier)));
});

test("legacy Claude command gains an effort slot without losing tmux auto-approval", () => {
  const migrated = migrateRoster({
    clis: {
      claude: {
        cmd: [
          "claude",
          "--dangerously-skip-permissions",
          "--model",
          "{model}",
          "{prompt}",
        ],
      },
    },
    models: {},
    roles: {},
  });

  assert.deepEqual(migrated.clis.claude.cmd, [
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    "{model}",
    "--effort",
    "{effort}",
    "{prompt}",
  ]);
});

test("hot provider without limit_windows is gated like pick()", () => {
  const roster = {
    accounts: { cursor: { kind: "subscription", enabled: true } },
    limits: { handoff_at: 0.95 },
    clis: { cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] } },
    models: {
      grok: {
        provider: "xai",
        tier: "high",
        cli: ["cursor"],
        account: "cursor",
        reasoning: { max: "high", high: "high" },
        // intentionally no limit_windows
      },
    },
  };
  const hot = resolveProfile({
    roster,
    profile: { tier: "high", reasoning: "high" },
    usage: { providers: { xai: { used: 0.99 } } },
  });
  assert.equal(hot.code, "PROFILE_UNAVAILABLE");
  assert.ok(hot.skipped.some((s) => /provider xai/.test(s.reason)));

  const cool = resolveProfile({
    roster,
    profile: { tier: "high", reasoning: "high" },
    usage: { providers: { xai: { used: 0.1 } } },
  });
  assert.equal(cool.code, "OK");
  assert.deepEqual(cool.chain.map((c) => c.model), ["grok"]);
});
