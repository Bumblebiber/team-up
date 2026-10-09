import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAgyWorkspaceTrusted } from "../../src/roster/agy-trust.mjs";

test("agy trust update merges exact workspace without changing other settings", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-agy-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-agy-workspace-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const initial = {
    theme: "dark",
    trustedWorkspaces: ["/existing/workspace", "/home/user/project"],
    featureFlags: { enabled: true },
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(initial)}\n`);

  const result = ensureAgyWorkspaceTrusted(workspace, { env: { HOME: home } });
  assert.equal(result.changed, true);
  const updated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(updated, {
    ...initial,
    trustedWorkspaces: [...initial.trustedWorkspaces, workspace],
  });

  assert.equal(ensureAgyWorkspaceTrusted(workspace, { env: { HOME: home } }).changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), updated);
});

test("agy trust update creates missing settings and trustedWorkspaces", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-agy-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-agy-workspace-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  ensureAgyWorkspaceTrusted(workspace, { env: { HOME: home } });
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8",
  )), { trustedWorkspaces: [workspace] });
});
