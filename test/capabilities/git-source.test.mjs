import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { importGitCapability } from "../../src/capabilities/git-source.mjs";
import { importLocalCapability, listInstalledCapabilities } from "../../src/capabilities/store.mjs";

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tu-git-"));
  fs.mkdirSync(path.join(repo, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skills", "x", "SKILL.md"), "# X\n");
  fs.writeFileSync(path.join(repo, "capability.json"), JSON.stringify({
    schema_version: 1, id: "x", version: "1", display_name: "X",
    provides: { skills: ["skills/x/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c",
    "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

test("branch resolves to exact commit and matches local content checksum", () => {
  const repo = makeRepo();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo, encoding: "utf8",
  }).trim();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const env = { TEAM_UP_HOME: home };
  const record = importGitCapability({ url: repo, ref: "main" }, { env });
  assert.equal(record.source.commit, commit);
  assert.equal(record.source.ref, "main");
  const local = importLocalCapability(repo, { env });
  assert.equal(record.checksum, local.checksum);
});

test("bad ref leaves no index entry", () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const env = { TEAM_UP_HOME: home };
  assert.throws(() => importGitCapability({ url: repo, ref: "no-such-ref" }, { env }));
  assert.equal(listInstalledCapabilities({ env }).length, 0);
  assert.equal(fs.existsSync(path.join(home, "capability-pool", "index.json")), false);
});
