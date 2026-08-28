import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyProbeHomeClosedWorld } from "../../src/harness/isolation-canary.mjs";

function home(claudeJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cw-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), "{}");
  if (claudeJson !== undefined) {
    fs.writeFileSync(path.join(dir, ".claude.json"), claudeJson);
  }
  return dir;
}

test("a leaked global config is still a violation", () => {
  // The negative-control fixture plants exactly this shape.
  const dir = home(JSON.stringify({ mcpServers: { global: { command: "x" } } }));
  const result = verifyProbeHomeClosedWorld(dir);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.name === "mcpServers"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("per-project servers are caught too", () => {
  const dir = home(JSON.stringify({
    projects: { "/p": { hasTrustDialogAccepted: true, mcpServers: { x: {} } } },
  }));
  const result = verifyProbeHomeClosedWorld(dir);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.name === "projects./p.mcpServers"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the onboarding markers the capsule writes are allowed", () => {
  const dir = home(JSON.stringify({
    hasCompletedOnboarding: true,
    numStartups: 7,
    projects: { "/run/context": { hasTrustDialogAccepted: true } },
  }));
  assert.equal(verifyProbeHomeClosedWorld(dir).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unreadable .claude.json fails closed", () => {
  const dir = home("{not json");
  assert.equal(verifyProbeHomeClosedWorld(dir).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no .claude.json at all is still fine", () => {
  const dir = home();
  assert.equal(verifyProbeHomeClosedWorld(dir).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
