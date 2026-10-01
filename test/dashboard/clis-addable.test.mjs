import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClisView } from "../../src/dashboard/clis.mjs";

test("Add CLI lists catalogue CLIs the roster doesn't run, install gated by --allow-install", () => {
  const env = { ...process.env, TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "clis-addable-")) };
  const roster = { clis: {} };
  const off = buildClisView(roster, { env }).addable.find((c) => c.cli === "gemini");
  assert.equal(off.install_available, false);
  assert.match(off.install_disabled_reason, /allow-install/);
  const on = buildClisView(roster, { env, allowInstall: true }).addable.find((c) => c.cli === "gemini");
  assert.equal(on.install_command, "npm install -g @google/gemini-cli");
  assert.equal(on.install_state, "idle");
});
