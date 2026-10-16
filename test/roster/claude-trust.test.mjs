import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureClaudeWorkspaceTrusted } from "../../src/roster/claude-trust.mjs";

test("claude trust update merges project markers without changing other settings", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-claude-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-claude-workspace-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const configPath = path.join(home, ".claude.json");
  const initial = {
    hasCompletedOnboarding: true,
    projects: {
      "/existing/project": { hasTrustDialogAccepted: true },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(initial)}\n`);

  const result = ensureClaudeWorkspaceTrusted(workspace, { env: { HOME: home } });
  assert.equal(result.changed, true);
  const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(updated, {
    ...initial,
    projects: {
      ...initial.projects,
      [workspace]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 1,
      },
    },
  });

  assert.equal(ensureClaudeWorkspaceTrusted(workspace, { env: { HOME: home } }).changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), updated);
});

test("claude trust update creates missing config and projects", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-claude-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-claude-workspace-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  ensureClaudeWorkspaceTrusted(workspace, { env: { HOME: home } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")), {
    projects: {
      [workspace]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 1,
      },
    },
  });
});
