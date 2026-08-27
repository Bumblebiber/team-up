import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../../src/specialists/manifest.mjs";
import { findSpecialistRepos } from "../helpers/specialist-repos.mjs";

const repos = findSpecialistRepos(path.dirname(fileURLToPath(import.meta.url)));
const hannesPath = path.join(repos, "team-up-with-hannes", "specialist.json");
const reannaPath = path.join(repos, "team-up-with-reanna", "specialist.json");

test("hannes and reanna packages validate without concrete models", () => {
  const hannes = JSON.parse(fs.readFileSync(hannesPath, "utf8"));
  const reanna = JSON.parse(fs.readFileSync(reannaPath, "utf8"));
  assert.equal(validateManifest(hannes).ok, true, validateManifest(hannes).errors.join("; "));
  assert.equal(validateManifest(reanna).ok, true, validateManifest(reanna).errors.join("; "));
  assert.equal(hannes.id, "testing.hannes");
  assert.deepEqual(hannes.model_profile, { tier: "frontier", reasoning: "max" });
  assert.deepEqual(hannes.capabilities.tools, ["filesystem.read", "command.test"]);
  assert.deepEqual(hannes.permissions.commands, ["project-test"]);
  assert.equal(hannes.budget.tokens.target, 80000);
  assert.equal(hannes.budget.tokens.enforcement, "advisory");
  assert.equal(reanna.id, "research.reanna");
  assert.deepEqual(reanna.model_profile, { tier: "medium", reasoning: "low" });
  assert.equal(reanna.budget.tokens.target, 80000);
  assert.equal(reanna.budget.tokens.enforcement, "advisory");
  assert.equal(JSON.stringify(hannes).includes("grok"), false);
  assert.equal(JSON.stringify(reanna).includes("claude"), false);
});
