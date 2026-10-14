import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendCodexShellDisable, codexAdapter } from "../../src/harness/codex.mjs";

test("appendCodexShellDisable inserts flag before -- separator", () => {
  const argv = ["codex", "exec", "--model", "m", "--", "prompt"];
  const out = appendCodexShellDisable(argv);
  const dash = out.indexOf("--");
  assert.ok(out.indexOf("--disable") < dash);
  assert.equal(out[out.indexOf("--disable") + 1], "shell_tool");
});

test("Codex prepareLaunch uses capsule home and disables shell on argv", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "run", "harness", "home");
  const prepared = codexAdapter.prepareLaunch({
    argv: ["codex", "exec", "work"],
    runDir: path.join(root, "run"),
    capsule: {
      codexHome,
      skillDirs: [],
      mcpConfig: { mcpServers: {} },
    },
  });
  assert.equal(prepared.env.CODEX_HOME, codexHome);
  assert.equal(prepared.argv.includes("--strict-config"), true);
  assert.equal(prepared.argv.includes("--disable"), true);
  assert.equal(prepared.argv[prepared.argv.indexOf("--disable") + 1], "shell_tool");
});

test("Codex adapter rejects launch without capsule", () => {
  assert.throws(
    () =>
      codexAdapter.prepareLaunch({
        argv: ["codex", "exec", "work"],
        runDir: "/run",
        capsule: null,
      }),
    /CODEX_CAPSULE_REQUIRED/
  );
});
