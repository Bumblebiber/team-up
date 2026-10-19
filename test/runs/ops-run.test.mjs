import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/ops-run.sh", import.meta.url));
const RUN_ID = "20261019T000000Z-oprn";

// ops-run calls the team-up beside it (../bin/team-up.mjs): a copy next to a fake that logs each call,
// and whose `runs wait` ends the run as FAKE_STATUS.
const FAKE = `import fs from "node:fs";
const args = process.argv.slice(2);
const mb = process.env.FAKE_MB;
fs.appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\\n");
if (args[0] === "runs" && args[1] === "create") {
  fs.mkdirSync(mb, { recursive: true });
  console.log("runId: ${RUN_ID}\\nmailbox: " + mb);
}
if (args[0] === "runs" && args[1] === "wait") {
  fs.writeFileSync(mb + "/STATUS", process.env.FAKE_STATUS);
  fs.writeFileSync(mb + "/RESULT.md", "FAILED-PREFLIGHT: tree not clean\\n");
}
`;

function opsRun(status) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-run-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "ops-run.sh"));
  fs.writeFileSync(path.join(dir, "bin", "team-up.mjs"), FAKE);
  fs.writeFileSync(path.join(dir, "prompt.md"), "do it\n");
  const log = path.join(dir, "calls.log");
  const r = spawnSync("bash", [path.join(dir, "scripts", "ops-run.sh"), "--job", "golden-task", "--model", "claude:x",
    dir, path.join(dir, "prompt.md")], {
    encoding: "utf8",
    env: { ...process.env, FAKE_MB: path.join(dir, "mailbox"), FAKE_LOG: log, FAKE_STATUS: status },
  });
  const calls = fs.readFileSync(log, "utf8");
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, calls };
}

test("ops-run puts a failed run's RESULT.md in the report and collects it; a question stays open", () => {
  const failed = opsRun("failed");
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /ended failed\nFAILED-PREFLIGHT: tree not clean/);
  assert.match(failed.calls, new RegExp(`^runs collect ${RUN_ID} --note ops-run: failed, reported on stdout$`, "m"));
  const asking = opsRun("waiting_human");
  assert.equal(asking.status, 1, asking.stderr);
  assert.doesNotMatch(asking.calls, /runs collect/);
});
