import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage } from "../../src/specialists/store.mjs";
import { approveSpecialist, isApproved } from "../../src/specialists/approvals.mjs";

/**
 * `pipeline` gives every parallel writer its own full clone, so an exact-path
 * grant meant one permission prompt per disposable directory. A clone-root
 * grant loosens the path and nothing else: the package, the permissions and
 * the project command policy are still the approved ones, or the launch is
 * refused exactly as before.
 */
const policy = {
  schema_version: 1,
  commands: {
    "project-test": {
      argv: ["npm", "test"],
      cwd: ".",
      timeout_seconds: 1800,
      environment: {},
    },
  },
};

const manifest = {
  schema_version: 1,
  id: "coding.cloney",
  display_name: "Cloney",
  version: "0.1.0",
  remit: ["x"],
  anti_remit: ["y"],
  call_types: ["consult"],
  accepted_inputs: ["task_description"],
  output_contract: "team-up.result/v1",
  capabilities: { skills: [], tools: ["command.test"], mcps: [], frameworks: [] },
  permissions: {
    filesystem: "project",
    writes: true,
    network: false,
    commands: ["project-test"],
  },
  budget: { timeout_seconds: 60 },
  model_profile: { tier: "medium", reasoning: "low" },
  eval_suite: "evals/evals.json",
};

function writeCommands(project, body = policy) {
  fs.mkdirSync(path.join(project, ".team-up"), { recursive: true });
  fs.writeFileSync(path.join(project, ".team-up", "commands.json"), JSON.stringify(body));
}

function writePkg(dir) {
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "evals.json"), "[]");
}

/** A home, a source project, a clone root, and the installed package. */
async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-clone-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tu-clone-proj-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-clone-root-"));
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "tu-clone-pkg-"));
  const env = { ...process.env, TEAM_UP_HOME: home, TEAM_UP_RUNS: path.join(home, "runs") };
  writeCommands(project);
  writePkg(pkg);
  assert.equal((await installPackage(pkg, env)).ok, true);
  const dirs = [home, project, root, pkg];
  return {
    env,
    project,
    root,
    installed: () => JSON.parse(
      fs.readFileSync(path.join(home, "specialists-index.json"), "utf8")
    ),
    clone(name, body = policy) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      writeCommands(dir, body);
      return dir;
    },
    cleanup: () => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

/** The launch-side question, with the fields a launch would carry. */
function approvedFor(f, project, over = {}) {
  const entry = Object.values(f.installed().specialists ?? f.installed())[0];
  return isApproved({
    project,
    id: "coding.cloney",
    version: "0.1.0",
    checksum: over.checksum ?? entry.checksum,
    permissions: over.permissions ?? manifest.permissions,
    command_policy_checksum: over.command_policy_checksum
      ?? Object.values(f.grants)[0].command_policy_checksum,
    env: f.env,
  });
}

test("one clone-root grant covers every clone under it, and nothing beside it", async () => {
  const f = await fixture();
  try {
    const ap = await approveSpecialist({
      idAtVersion: "coding.cloney@0.1.0",
      project: f.project,
      cloneRoot: f.root,
      env: f.env,
    });
    assert.equal(ap.ok, true, ap.errors?.join("; "));
    assert.equal(ap.approval.scope, "clone_root");
    assert.equal(ap.approval.clone_root, fs.realpathSync(f.root));
    f.grants = { [ap.key]: ap.approval };

    // Two disposable clones of the same repo: no further grant.
    assert.equal(approvedFor(f, f.clone("ticket-01")), true);
    assert.equal(approvedFor(f, f.clone("ticket-02")), true);
    // Nested deeper is still inside the root.
    assert.equal(approvedFor(f, f.clone(path.join("ticket-03", "repo"))), true);

    // The root itself is a container, not a project: launching in it would
    // hand a writer every sibling clone as its working tree.
    assert.equal(approvedFor(f, f.root), false);

    // A directory outside the root is not covered.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tu-clone-out-"));
    writeCommands(outside);
    assert.equal(approvedFor(f, outside), false);
    fs.rmSync(outside, { recursive: true, force: true });

    // Containment alone proves nothing: another version, another checksum,
    // wider permissions or another command policy are all still refused.
    const inside = f.clone("ticket-04");
    assert.equal(approvedFor(f, inside, { checksum: "sha256:other" }), false);
    assert.equal(
      approvedFor(f, inside, { permissions: { ...manifest.permissions, network: true } }),
      false
    );
    assert.equal(approvedFor(f, inside, { command_policy_checksum: "sha256:other" }), false);
  } finally {
    f.cleanup();
  }
});

test("an exact grant stays exact, and a symlink no longer needs its own", async () => {
  const f = await fixture();
  try {
    const ap = await approveSpecialist({
      idAtVersion: "coding.cloney@0.1.0",
      project: f.project,
      env: f.env,
    });
    assert.equal(ap.ok, true, ap.errors?.join("; "));
    assert.equal(ap.approval.scope, undefined);
    f.grants = { [ap.key]: ap.approval };

    assert.equal(approvedFor(f, f.project), true);
    // No clone root was named, so a sibling directory is not covered.
    assert.equal(approvedFor(f, f.clone("ticket-01")), false);

    // The same directory reached through a symlink is the same directory:
    // `path.resolve` hashed it differently and demanded a second grant.
    const link = path.join(f.root, "link-to-project");
    fs.symlinkSync(f.project, link);
    assert.equal(approvedFor(f, link), true);
  } finally {
    f.cleanup();
  }
});

test("a symlink out of the root is outside it, however it is spelled", async () => {
  const f = await fixture();
  try {
    const escape = fs.mkdtempSync(path.join(os.tmpdir(), "tu-clone-escape-"));
    writeCommands(escape);
    const ap = await approveSpecialist({
      idAtVersion: "coding.cloney@0.1.0",
      project: f.project,
      cloneRoot: f.root,
      env: f.env,
    });
    f.grants = { [ap.key]: ap.approval };

    fs.symlinkSync(escape, path.join(f.root, "sneaky"));
    assert.equal(approvedFor(f, path.join(f.root, "sneaky")), false);
    assert.equal(approvedFor(f, path.join(f.root, "..", path.basename(escape))), false);
    fs.rmSync(escape, { recursive: true, force: true });
  } finally {
    f.cleanup();
  }
});

test("a root that is too wide, absent, or holds the project is refused", async () => {
  const f = await fixture();
  try {
    const approve = (cloneRoot) => approveSpecialist({
      idAtVersion: "coding.cloney@0.1.0",
      project: f.project,
      cloneRoot,
      env: f.env,
    });
    assert.equal((await approve(path.join(f.root, "nope"))).code, "CLONE_ROOT_INVALID");
    assert.equal((await approve("/")).code, "CLONE_ROOT_INVALID");
    assert.equal((await approve(os.homedir())).code, "CLONE_ROOT_INVALID");
    // The project lives in the OS temp dir, so that dir is not a clone root.
    assert.equal((await approve(path.dirname(f.project))).code, "CLONE_ROOT_INVALID");
    // A refused root writes no grant at all.
    assert.equal(fs.existsSync(path.join(f.env.TEAM_UP_HOME, "approvals.json")), false);
  } finally {
    f.cleanup();
  }
});
