import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../../src/specialists/manifest.mjs";
import { findSpecialistRepos } from "../helpers/specialist-repos.mjs";

const repos = findSpecialistRepos(path.dirname(fileURLToPath(import.meta.url)));
const tessaPath = path.join(repos, "team-up-with-tessa", "specialist.json");
const reannaPath = path.join(repos, "team-up-with-reanna", "specialist.json");

test("tessa and reanna packages validate without concrete models", () => {
  const tessa = JSON.parse(fs.readFileSync(tessaPath, "utf8"));
  const reanna = JSON.parse(fs.readFileSync(reannaPath, "utf8"));
  assert.equal(validateManifest(tessa).ok, true, validateManifest(tessa).errors.join("; "));
  assert.equal(validateManifest(reanna).ok, true, validateManifest(reanna).errors.join("; "));
  assert.equal(tessa.id, "testing.tessa");
  assert.deepEqual(tessa.model_profile, { tier: "frontier", reasoning: "max" });
  assert.deepEqual(tessa.capabilities.tools, ["filesystem.read", "command.test"]);
  assert.deepEqual(tessa.permissions.commands, ["project-test"]);
  assert.equal(tessa.budget.tokens.target, 80000);
  assert.equal(tessa.budget.tokens.enforcement, "advisory");
  assert.equal(reanna.id, "research.reanna");
  assert.deepEqual(reanna.model_profile, { tier: "medium", reasoning: "low" });
  assert.equal(reanna.budget.tokens.target, 80000);
  assert.equal(reanna.budget.tokens.enforcement, "advisory");
  assert.equal(JSON.stringify(tessa).includes("grok"), false);
  assert.equal(JSON.stringify(reanna).includes("claude"), false);
});
