import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSpecialistRepos } from "./specialist-repos.mjs";

test("finds starter specialists in projects beside team-up clones", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-specialist-repos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repos = path.join(root, "projects");
  for (const name of ["team-up-with-tessa", "team-up-with-reanna"]) {
    const specialistDir = path.join(repos, name);
    fs.mkdirSync(specialistDir, { recursive: true });
    fs.writeFileSync(path.join(specialistDir, "specialist.json"), "{}");
  }

  const integrationTests = path.join(root, ".team-up", "clones", "insights", "test", "integration");
  fs.mkdirSync(integrationTests, { recursive: true });

  assert.equal(findSpecialistRepos(integrationTests, {}), repos);
});
