import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installGcTimer, renderGcUnits } from "../../src/runs/gc-timer.mjs";

test("renderGcUnits uses absolute executables and five minute cadence", () => {
  const units = renderGcUnits({
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/team-up/bin/team-up.mjs",
  });
  assert.match(units.service, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/team-up\/bin\/team-up\.mjs" runs gc/);
  assert.match(units.timer, /OnBootSec=5min/);
  assert.match(units.timer, /OnUnitActiveSec=5min/);
  assert.match(units.timer, /Persistent=true/);
});

test("installGcTimer writes units then enables timer", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-gc-timer-"));
  const calls = [];
  try {
    const result = installGcTimer({
      home,
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/team-up/bin/team-up.mjs",
      exec: (bin, args) => calls.push([bin, args]),
    });
    assert.equal(fs.existsSync(result.servicePath), true);
    assert.equal(fs.existsSync(result.timerPath), true);
    assert.deepEqual(calls, [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", "team-up-gc.timer"]],
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
