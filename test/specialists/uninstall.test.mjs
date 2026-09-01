// Removal has to refuse the same things install refuses to do silently: it
// must not repoint a selection on its own, and it must not pull a package out
// from under a run that will re-verify its checksum on resume.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import {
  installPackage,
  pinSpecialist,
  resolveInstalled,
  listInstalled,
  uninstallSpecialist,
} from "../../src/specialists/store.mjs";

function validManifest(overrides = {}) {
  return {
    schema_version: 1,
    id: "testing.gone",
    display_name: "Gone",
    version: "0.1.0",
    remit: ["x"],
    anti_remit: ["y"],
    call_types: ["consult", "delegate", "review"],
    accepted_inputs: ["task_description"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project_readonly", writes: false, network: false, commands: [] },
    budget: { timeout_seconds: 60, max_tokens: 1000 },
    model_profile: { tier: "medium", reasoning: "low" },
    eval_suite: "evals/evals.json",
    ...overrides,
  };
}

function writePkg(dir, manifest) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

async function installVersions(env, versions, overrides = {}) {
  for (const version of versions) {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
    writePkg(pkg, validManifest({ version, ...overrides }));
    const r = await installPackage(pkg, env);
    assert.equal(r.ok, true, r.errors?.join("; "));
    fs.rmSync(pkg, { recursive: true, force: true });
  }
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-uninst-"));
  const env = { ...process.env, TEAM_UP_HOME: home };
  return Promise.resolve()
    .then(() => fn({ home, env }))
    .finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

test("uninstall removes one version and leaves its siblings alone", async () => {
  await withHome(async ({ env }) => {
    await installVersions(env, ["0.1.0", "0.2.0"]);
    const removed = listInstalled(env).versions["testing.gone"].find(
      (v) => v.version === "0.2.0"
    );

    const result = uninstallSpecialist("testing.gone", { version: "0.2.0", env });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.equal(fs.existsSync(removed.path), false, "package tree must be gone");

    const index = listInstalled(env);
    assert.deepEqual(
      index.versions["testing.gone"].map((v) => v.version),
      ["0.1.0"]
    );
    assert.equal(resolveInstalled("testing.gone", { env }).version, "0.1.0");
  });
});

test("uninstall refuses the selected version while siblings remain", async () => {
  await withHome(async ({ env }) => {
    await installVersions(env, ["0.1.0", "0.2.0"]);
    const result = uninstallSpecialist("testing.gone", { version: "0.1.0", env });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /selected version; pin another first/);
    assert.equal(resolveInstalled("testing.gone", { env }).version, "0.1.0");

    // Repointing first is what makes it removable.
    assert.equal(pinSpecialist("testing.gone", { version: "0.2.0", env }).ok, true);
    assert.equal(
      uninstallSpecialist("testing.gone", { version: "0.1.0", env }).ok,
      true
    );
  });
});

test("uninstalling the last version drops the id entirely", async () => {
  await withHome(async ({ env, home }) => {
    await installVersions(env, ["0.1.0"]);
    const result = uninstallSpecialist("testing.gone", { version: "0.1.0", env });
    assert.equal(result.ok, true, result.errors?.join("; "));
    const index = listInstalled(env);
    assert.equal(index.specialists["testing.gone"], undefined);
    assert.equal(index.versions["testing.gone"], undefined);
    assert.equal(
      fs.existsSync(path.join(home, "specialists", "testing.gone")),
      false,
      "the id directory must not linger empty"
    );
    assert.equal(resolveInstalled("testing.gone", { env }), null);
  });
});

test("uninstall refuses while an unfinished run depends on the version", async () => {
  await withHome(async ({ env }) => {
    await installVersions(env, ["0.1.0"]);
    const result = uninstallSpecialist("testing.gone", {
      version: "0.1.0",
      env,
      activeRuns: [{ runId: "20260101T000000Z-aaaa", id: "testing.gone", version: "0.1.0" }],
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /unfinished run depends on/);
    assert.equal(resolveInstalled("testing.gone", { env }).version, "0.1.0");
  });
});

test("uninstall clears approvals bound to the removed version", async () => {
  await withHome(async ({ home, env }) => {
    await installVersions(env, ["0.1.0", "0.2.0"]);
    fs.writeFileSync(
      path.join(home, "approvals.json"),
      JSON.stringify({
        approvals: {
          stale: { project: "/tmp/p", id: "testing.gone", version: "0.2.0" },
          keep: { project: "/tmp/p", id: "testing.gone", version: "0.1.0" },
          other: { project: "/tmp/p", id: "testing.other", version: "0.2.0" },
        },
      })
    );
    const result = uninstallSpecialist("testing.gone", { version: "0.2.0", env });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.deepEqual(result.dropped_approvals, ["stale"]);
    const after = JSON.parse(fs.readFileSync(path.join(home, "approvals.json"), "utf8"));
    assert.deepEqual(Object.keys(after.approvals).sort(), ["keep", "other"]);
  });
});

test("uninstall drops pins that named the removed version", async () => {
  await withHome(async ({ env }) => {
    await installVersions(env, ["0.1.0", "0.2.0"]);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-proj-"));
    assert.equal(
      pinSpecialist("testing.gone", { version: "0.2.0", project, env }).ok,
      true
    );
    const result = uninstallSpecialist("testing.gone", { version: "0.2.0", env });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.ok(result.dropped_pins.length >= 1, "project pin must not survive its package");
    assert.equal(resolveInstalled("testing.gone", { project, env }).version, "0.1.0");
    fs.rmSync(project, { recursive: true, force: true });
  });
});

test("uninstall requires <id>@<version> and reports an unknown one", async () => {
  const errs = [];
  assert.equal(
    await runCli(["specialist", "uninstall", "testing.gone"], {
      out: () => {},
      err: (l) => errs.push(l),
    }),
    1
  );
  assert.match(errs.join("\n"), /<id>@<version>/);

  await withHome(async ({ env }) => {
    const result = uninstallSpecialist("testing.gone", { version: "9.9.9", env });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /not installed/);
  });
});
