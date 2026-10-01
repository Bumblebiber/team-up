import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAdmissionCli } from "../../src/admission/cli.mjs";
import { applyRestartCap, currentCap } from "../../src/admission/admission.mjs";

function io() {
  const out = [];
  const err = [];
  return { out: (l) => out.push(l), err: (l) => err.push(l), lines: out, errors: err };
}

test("admission check exits 3 on a refusal; reset lifts the restart cap", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-admission-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { TEAM_UP_HOME: home };
  const limits = { max_workers: 3, source: "restart_cap", reason: "capped", p95_rss_kb: 1024 * 1024, reserve_kb: 1024 * 1024, footprint_source: "cli codex" };
  const refused = io();
  const code = await runAdmissionCli(["check", "--cli", "codex"], refused, {
    env,
    check: async ({ cli }) => ({ ok: false, reason: `3 workers running, limit 3 (${cli})`, limits, headroom: { mem_kb: 0 }, notes: ["PSI unavailable: pressure not checked"] }),
  });
  assert.equal(code, 3);
  assert.match(refused.lines[0], /refused: 3 workers running, limit 3 \(codex\)/);
  assert.ok(refused.lines.some((l) => /note: PSI unavailable/.test(l)));

  applyRestartCap({ maxWorkers: 3, verdict: "team_up_suspected", restartId: "b1", env });
  const reset = io();
  assert.equal(await runAdmissionCli(["reset"], reset, { env }), 0);
  assert.match(reset.lines[0], /lifted the cap of 3 worker\(s\) set after a team_up_suspected restart/);
  assert.equal(currentCap({ env }), null);
  const again = io();
  await runAdmissionCli(["reset"], again, { env });
  assert.equal(again.lines[0], "no cap in force");
  assert.equal(await runAdmissionCli(["nope"], io(), { env }), 1);
});
