import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESUME_UNIT, installResumeUnit, renderResumeUnit } from "../../src/runs/resume-unit.mjs";

test("the resume unit runs resume --boot once, keeps its tmux alive, and carries PATH", () => {
  const unit = renderResumeUnit({
    nodePath: "/opt/node 22/bin/node",
    cliPath: "/srv/team-up/bin/team-up.mjs",
    envPath: "/home/u/.local/bin:/usr/bin:/bin",
    teamUpHome: "/home/u/.tu%home",
  });
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^RemainAfterExit=yes$/m);
  assert.match(unit, /^ExecStartPre=\/bin\/sleep 20$/m);
  assert.match(unit, /^ExecStart="\/opt\/node 22\/bin\/node" "\/srv\/team-up\/bin\/team-up\.mjs" runs resume --boot$/m);
  assert.match(unit, /^Environment="PATH=\/home\/u\/\.local\/bin:\/usr\/bin:\/bin"$/m);
  assert.match(unit, /^Environment="TEAM_UP_HOME=\/home\/u\/\.tu%%home"$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(renderResumeUnit({ nodePath: "/n", cliPath: "/c", envPath: "/bin" }), /TEAM_UP_HOME/);
  assert.throws(() => renderResumeUnit({ nodePath: "/n\nExecStart=/evil", cliPath: "/c", envPath: "/bin" }), /control characters/);
});

test("installResumeUnit enables without starting it now", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-resume-unit-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const { servicePath } = installResumeUnit({
    home, nodePath: "/n", cliPath: "/c", envPath: "/bin", teamUpHome: null,
    exec: (cmd, args) => calls.push([cmd, ...args].join(" ")),
  });
  assert.equal(servicePath, path.join(home, ".config", "systemd", "user", RESUME_UNIT));
  assert.ok(fs.readFileSync(servicePath, "utf8").includes("runs resume --boot"));
  assert.deepEqual(calls, ["systemctl --user daemon-reload", `systemctl --user enable ${RESUME_UNIT}`]);
  assert.throws(() => installResumeUnit({ home, nodePath: "n", cliPath: "/c", exec: () => {} }), /absolute/);
});
