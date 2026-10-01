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

test("shipped example roster resolves every starter specialist through its role", () => {
  const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  assert.deepEqual(validateRoster(example).errors, []);
  for (const [id, { role }] of Object.entries(example.specialists)) {
    const r = resolveProfile({ roster: example, usage: {}, specialistId: id, harnessCapabilities: () => ({}) });
    assert.equal(r.code, "OK", `${id}: ${JSON.stringify(r.skipped.slice(0, 8))}`);
    assert.deepEqual(r.profile, { role });
  }
});

test("migration drops tiers, specialist tier profiles and triage, keeping the OpenRouter key file", () => {
  const legacy = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  delete legacy.openrouter;
  delete legacy.specialists;
  legacy.models["claude-sonnet-5"].tier = "mid";
  legacy.triage = { enabled: false, key_file: "~/.hermes/.env", roles: ["implementer"] };
  legacy.specialists = { "review.revan": { model_profile: { tier: "frontier", reasoning: "max" } } };
  delete legacy.accounts;

  const migrated = migrateRoster(legacy);
  assert.equal(migrated.models["claude-sonnet-5"].tier, undefined);
  assert.equal(migrated.triage, undefined);
  assert.deepEqual(migrated.openrouter, { key_file: "~/.hermes/.env" });
  assert.equal(migrated.specialists, undefined);
  assert.ok(migrated.accounts.claude);
  assert.deepEqual(validateRoster(migrated).errors, []);
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
        cli: ["cursor"],
        account: "cursor",
        // intentionally no limit_windows
      },
    },
    specialists: { x: { chain: ["cursor:grok"] } },
  };
  const hot = resolveProfile({
    roster,
    specialistId: "x",
    usage: { providers: { xai: { used: 0.99 } } },
  });
  assert.equal(hot.code, "PROFILE_UNAVAILABLE");
  assert.ok(hot.skipped.some((s) => /provider xai/.test(s.reason)));

  const cool = resolveProfile({
    roster,
    specialistId: "x",
    usage: { providers: { xai: { used: 0.1 } } },
  });
  assert.equal(cool.code, "OK");
  assert.deepEqual(cool.chain.map((c) => c.model), ["grok"]);
});
