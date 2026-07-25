import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../../src/specialists/manifest.mjs";
import { findSpecialistRepos } from "../helpers/specialist-repos.mjs";

const repos = findSpecialistRepos(path.dirname(fileURLToPath(import.meta.url)));
const hannesPath = path.join(repos, "team-up-with-hannes", "specialist.json");
const hugoPath = path.join(repos, "team-up-with-hugo", "specialist.json");

test("hannes and hugo packages validate without concrete models", () => {
  const hannes = JSON.parse(fs.readFileSync(hannesPath, "utf8"));
  const hugo = JSON.parse(fs.readFileSync(hugoPath, "utf8"));
  assert.equal(validateManifest(hannes).ok, true, validateManifest(hannes).errors.join("; "));
  assert.equal(validateManifest(hugo).ok, true, validateManifest(hugo).errors.join("; "));
  assert.equal(hannes.id, "testing.hannes");
  assert.deepEqual(hannes.model_profile, { tier: "frontier", reasoning: "max" });
  assert.deepEqual(hannes.capabilities.tools, ["filesystem.read", "command.test"]);
  assert.deepEqual(hannes.permissions.commands, ["project-test"]);
  assert.equal(hannes.budget.max_tokens, 80000);
  assert.equal(hugo.id, "research.hugo");
  assert.deepEqual(hugo.model_profile, { tier: "medium", reasoning: "low" });
  assert.equal(hugo.budget.max_tokens, 80000);
  assert.equal(JSON.stringify(hannes).includes("grok"), false);
  assert.equal(JSON.stringify(hugo).includes("claude"), false);
});
