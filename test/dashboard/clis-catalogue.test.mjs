import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClisView } from "../../src/dashboard/clis.mjs";

test("a catalogue CLI the roster doesn't run is a row marked in_roster:false, install gated by --allow-install", () => {
  const env = { ...process.env, TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "clis-catalogue-")) };
  const roster = { clis: {} };
  const off = buildClisView(roster, { env }).clis.find((c) => c.cli === "gemini");
  assert.equal(off.in_roster, false);
  assert.match(off.install_disabled_reason, /allow-install/);
  const on = buildClisView(roster, { env, allowInstall: true }).clis.find((c) => c.cli === "gemini");
  assert.equal(on.install_command, "npm install -g @google/gemini-cli");
  assert.equal(on.uninstall_command, "npm uninstall -g @google/gemini-cli");
});
