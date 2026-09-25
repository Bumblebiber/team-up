import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSpecialistsView,
  buildCapabilityPoolView,
  parseGithubSource,
  installSpecialistFromGithub,
} from "../../src/dashboard/specialists.mjs";

const CHECKSUM = "sha256:" + "a".repeat(64);
const CAP_CHECKSUM = "sha256:" + "b".repeat(64);

function plant(home) {
  const dir = path.join(home, "specialists", "coding.codey", "0.1.2", "aaa");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "specialist.json"),
    JSON.stringify({
      schema_version: 2,
      id: "coding.codey",
      display_name: "Codey",
      version: "0.1.2",
      remit: ["implementing one ticket against a spec"],
      anti_remit: ["changing the spec"],
      call_types: ["delegate"],
      capabilities: { skills: ["implementing"], tools: ["filesystem.write"], mcps: [], frameworks: [] },
      permissions: { filesystem: "project", writes: true, network: false, commands: [] },
      budget: { timeout_seconds: 3600 },
    }),
  );
  const entry = {
    id: "coding.codey",
    version: "0.1.2",
    checksum: CHECKSUM,
    path: dir,
    installed_at: "2026-08-29T14:37:11.477Z",
  };
  fs.writeFileSync(
    path.join(home, "specialists-index.json"),
    JSON.stringify({ specialists: { "coding.codey": entry }, versions: { "coding.codey": [entry] } }),
  );
  fs.mkdirSync(path.join(home, "capability-pool"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "capability-pool", "index.json"),
    JSON.stringify({
      packages: [{
        package: "ponytail.build@4.8.4",
        id: "ponytail.build",
        version: "4.8.4",
        display_name: "Ponytail",
        checksum: CAP_CHECKSUM,
        provides: { skills: ["skills/ponytail/SKILL.md"], plugins: [], mcps: [], frameworks: [] },
      }],
    }),
  );
}

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-spec-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    plant(home);
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assign(home, doc) {
  fs.writeFileSync(
    path.join(home, "capability-assignments.json"),
    JSON.stringify({ schema_version: 1, assignments: doc }),
  );
}

test("a specialist reports what its package bundles", () =>
  withHome(() => {
    const [codey] = buildSpecialistsView().specialists;
    assert.equal(codey.id, "coding.codey");
    assert.equal(codey.display_name, "Codey");
    assert.equal(codey.version, "0.1.2");
    assert.equal(codey.checksum, "a".repeat(12));
    assert.deepEqual(codey.bundled.skills, ["implementing"]);
    assert.equal(codey.permissions.writes, true);
    assert.deepEqual(codey.assigned, []);
    assert.equal(codey.error, null);
  }));

test("an assigned package shows up with the reason it applies", () =>
  withHome((home) => {
    assign(home, [
      { package: "ponytail.build@4.8.4", checksum: CAP_CHECKSUM, targets: ["all"], exclude: [] },
    ]);
    const [codey] = buildSpecialistsView().specialists;
    assert.equal(codey.assigned.length, 1);
    assert.equal(codey.assigned[0].package, "ponytail.build@4.8.4");
    assert.equal(codey.assigned[0].reason, "target:all");
    assert.deepEqual(codey.assigned[0].provides.skills, ["skills/ponytail/SKILL.md"]);
  }));

test("an exclusion keeps the package off the specialist and says so", () =>
  withHome((home) => {
    assign(home, [
      {
        package: "ponytail.build@4.8.4",
        checksum: CAP_CHECKSUM,
        targets: ["all"],
        exclude: ["coding.codey"],
      },
    ]);
    const [codey] = buildSpecialistsView().specialists;
    assert.deepEqual(codey.assigned, []);
    assert.equal(codey.exclusions[0].reason, "exclude:coding.codey");
  }));

test("an assignment pointing at a package the pool lacks is reported, not thrown", () =>
  withHome((home) => {
    assign(home, [
      { package: "ghost.pkg@1.0.0", checksum: CAP_CHECKSUM, targets: ["coding.codey"], exclude: [] },
    ]);
    const [codey] = buildSpecialistsView().specialists;
    assert.match(codey.error, /CAPABILITY_MISSING/);
    assert.deepEqual(codey.assigned, []);
  }));

test("only approvals matching the installed checksum count", () =>
  withHome((home) => {
    fs.writeFileSync(
      path.join(home, "approvals.json"),
      JSON.stringify({
        approvals: {
          a: { project: "/home/bbbee/projects/team-up", id: "coding.codey", version: "0.1.2", checksum: CHECKSUM },
          b: { project: "/home/bbbee/projects/old", id: "coding.codey", version: "0.1.1", checksum: "sha256:" + "c".repeat(64) },
        },
      }),
    );
    const [codey] = buildSpecialistsView().specialists;
    assert.deepEqual(codey.approved_for, ["/home/bbbee/projects/team-up"]);
  }));

test("only https github URLs are accepted as an install source", () => {
  const good = parseGithubSource("https://github.com/Bumblebiber/team-up-with-codey.git#v1.0");
  assert.equal(good.ok, true);
  assert.equal(good.url, "https://github.com/Bumblebiber/team-up-with-codey.git");
  assert.equal(good.ref, "v1.0");

  for (const bad of [
    "ssh://git@github.com/a/b",
    "file:///etc/passwd",
    "https://evil.example/a/b",
    "https://github.com/a/b/c",
    "https://github.com/--upload-pack=touch/b",
    "https://github.com/a/b#--exec=touch",
    "",
  ]) {
    assert.equal(parseGithubSource(bad).ok, false, bad);
  }
});

test("a refused source never reaches git", async () => {
  let called = false;
  const result = await installSpecialistFromGithub("ssh://git@github.com/a/b", {
    exec: async () => { called = true; },
    install: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("a subdir escaping the checkout is refused and the clone is cleaned up", async () =>
  withHome(async (home) => {
    const tmpRoot = path.join(home, "clones");
    fs.mkdirSync(tmpRoot, { recursive: true });
    const result = await installSpecialistFromGithub("https://github.com/a/b", {
      subdir: "../../etc",
      tmpRoot,
      exec: async () => {},
      install: async () => ({ ok: true, id: "should.not.happen" }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  }));

test("a clone installs from the requested subdir", async () =>
  withHome(async (home) => {
    const tmpRoot = path.join(home, "clones");
    fs.mkdirSync(tmpRoot, { recursive: true });
    let installedFrom = null;
    let gitArgs = null;
    const result = await installSpecialistFromGithub("https://github.com/o/r#main", {
      subdir: "bundle",
      tmpRoot,
      exec: async (_bin, args) => { gitArgs = args; },
      install: async (dir) => { installedFrom = dir; return { ok: true, id: "x.y", version: "1" }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "o/r#main");
    assert.equal(path.basename(installedFrom), "bundle");
    assert.ok(gitArgs.includes("--branch") && gitArgs.includes("main"));
    assert.equal(gitArgs[gitArgs.length - 3], "--");
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  }));

test("the pool view reports which specialists already hold a package", () =>
  withHome((home) => {
    assign(home, [
      { package: "ponytail.build@4.8.4", checksum: CAP_CHECKSUM, targets: ["all"], exclude: ["testing.tessa"] },
    ]);
    const [pkg] = buildCapabilityPoolView().packages;
    assert.equal(pkg.package, "ponytail.build@4.8.4");
    assert.deepEqual(pkg.targets, ["all"]);
    assert.deepEqual(pkg.exclude, ["testing.tessa"]);
    assert.equal(pkg.checksum, CAP_CHECKSUM);
  }));

test("git is run without a credential prompt", async () =>
  withHome(async (home) => {
    const tmpRoot = path.join(home, "clones");
    fs.mkdirSync(tmpRoot, { recursive: true });
    let opts = null;
    await installSpecialistFromGithub("https://github.com/o/r", {
      tmpRoot,
      exec: async (_bin, _args, o) => { opts = o; },
      install: async () => ({ ok: true }),
    });
    assert.equal(opts.env.GIT_TERMINAL_PROMPT, "0");
  }));
