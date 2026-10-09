// Removal picks newest remaining version and refuses to pull a package out
// from under a run that will re-verify its checksum on resume.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import {
  installPackage,
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

test("uninstall removes an unselected version and leaves selected sibling alone", async () => {
  await withHome(async ({ env }) => {
    await installVersions(env, ["0.1.0", "0.2.0"]);
    const removed = listInstalled(env).versions["testing.gone"].find(
      (v) => v.version === "0.1.0"
    );

    const result = uninstallSpecialist("testing.gone", { version: "0.1.0", env });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.equal(fs.existsSync(removed.path), false, "package tree must be gone");

    const index = listInstalled(env);
    assert.deepEqual(
      index.versions["testing.gone"].map((v) => v.version),
      ["0.2.0"]
    );
    assert.equal(resolveInstalled("testing.gone", { env }).version, "0.2.0");
  });
});

test("uninstalling selected version falls back to newest remaining", async () => {
  await withHome(async ({ env }) => {
    await installVersions(env, ["0.1.0", "0.2.0", "0.3.0"]);
    const result = uninstallSpecialist("testing.gone", { version: "0.3.0", env });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.equal(resolveInstalled("testing.gone", { env }).version, "0.2.0");
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

test("uninstall leaves legacy rows and policy trust records untouched", async () => {
  await withHome(async ({ home, env }) => {
    await installVersions(env, ["0.1.0", "0.2.0"]);
    const legacy = {
      approvals: { stale: { project: "/tmp/p", id: "testing.gone", version: "0.2.0" } },
      trusted_policies: { "sha256:policy": { project: "/tmp/p", trusted_at: "2026-01-01T00:00:00Z" } },
    };
    fs.writeFileSync(path.join(home, "approvals.json"), JSON.stringify(legacy));
    const result = uninstallSpecialist("testing.gone", { version: "0.2.0", env });
    assert.equal(result.ok, true, result.errors?.join("; "));
    const after = JSON.parse(fs.readFileSync(path.join(home, "approvals.json"), "utf8"));
    assert.deepEqual(after, legacy);
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
