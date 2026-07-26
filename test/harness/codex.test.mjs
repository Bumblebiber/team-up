import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAdapter } from "../../src/harness/codex.mjs";

test("Codex receives a minimal run-specific home and separate auth bridge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-"));
  const sourceHome = path.join(root, "global");
  const capsuleHome = path.join(root, "run", "harness", "home");
  fs.mkdirSync(path.join(sourceHome, "skills", "global"), { recursive: true });
  fs.writeFileSync(path.join(sourceHome, "skills", "global", "SKILL.md"), "# Global\n");
  fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"token\":\"fixture\"}\n");
  const prepared = codexAdapter.prepareLaunch({
    argv: ["codex", "exec", "work"],
    runDir: path.join(root, "run"),
    capsule: {
      codexHome: capsuleHome,
      skillDirs: [path.join(root, "run", "context", "skills")],
      mcpConfig: { mcpServers: {} },
    },
    authSource: path.join(sourceHome, "auth.json"),
  });
  assert.equal(prepared.env.CODEX_HOME, capsuleHome);
  assert.equal(fs.existsSync(path.join(capsuleHome, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(capsuleHome, "skills", "global")), false);
  assert.equal(prepared.argv.includes("--strict-config"), true);
  assert.equal(fs.readFileSync(path.join(capsuleHome, "config.toml"), "utf8")
    .includes(sourceHome), false);
});

test("Codex adapter rejects launch without capsule", () => {
  assert.throws(() => codexAdapter.prepareLaunch({
    argv: ["codex", "exec", "work"], runDir: "/run", capsule: null,
  }), /CODEX_CAPSULE_REQUIRED/);
});
