import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { importGitCapability } from "../../src/capabilities/git-source.mjs";
import {
  importLocalCapability,
  listInstalledCapabilities,
} from "../../src/capabilities/store.mjs";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitFixture() {
  const repo = tmpdir("tu-git-");
  fs.mkdirSync(path.join(repo, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skills", "x", "SKILL.md"), "# X\n");
  fs.writeFileSync(
    path.join(repo, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id: "x",
      version: "1",
      display_name: "X",
      provides: { skills: ["skills/x/SKILL.md"] },
      permissions: { network: false, commands: [] },
    })
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: repo, stdio: "pipe" }
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  return { repo, commit };
}

test("branch resolves to exact commit and matches local content checksum", () => {
  const { repo, commit } = gitFixture();
  const env = { TEAM_UP_HOME: tmpdir("tu-home-") };
  const record = importGitCapability({ url: repo, ref: "main" }, { env });
  assert.equal(record.source.commit, commit);
  assert.equal(record.source.ref, "main");
  assert.equal(record.source.type, "git");

  // The same contents imported from a plain directory hash identically.
  const localEnv = { TEAM_UP_HOME: tmpdir("tu-home-") };
  const local = importLocalCapability(repo, { env: localEnv });
  assert.equal(record.checksum, local.checksum);
});

test("a tag resolves to its commit and a moving branch does not mutate the entry", () => {
  const { repo, commit } = gitFixture();
  execFileSync("git", ["tag", "v1"], { cwd: repo, stdio: "pipe" });
  const env = { TEAM_UP_HOME: tmpdir("tu-home-") };
  const tagged = importGitCapability({ url: repo, ref: "v1" }, { env });
  assert.equal(tagged.source.commit, commit);

  // Move main forward; the already-imported entry keeps its original commit.
  fs.writeFileSync(path.join(repo, "skills", "x", "SKILL.md"), "# X changed\n");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "moved",
    ],
    { cwd: repo, stdio: "pipe" }
  );
  const moved = importGitCapability({ url: repo, ref: "main" }, { env });
  assert.notEqual(moved.source.commit, tagged.source.commit);
  assert.notEqual(moved.checksum, tagged.checksum);
  assert.equal(
    listInstalledCapabilities({ env }).find(
      (item) => item.checksum === tagged.checksum
    ).source.commit,
    commit
  );
});

test("a bad ref leaves no index entry and no temporary clone", () => {
  const { repo } = gitFixture();
  const home = tmpdir("tu-home-");
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("team-up-git-"));
  assert.throws(() =>
    importGitCapability({ url: repo, ref: "no-such-ref" }, { env: { TEAM_UP_HOME: home } })
  );
  assert.equal(
    fs.existsSync(path.join(home, "capability-pool", "index.json")),
    false
  );
  const after = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("team-up-git-"));
  assert.deepEqual(after, before);
});
