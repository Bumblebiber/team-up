import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
