#!/usr/bin/env node
// One-shot E2E: verify command fails on 3rd invocation → waitMailbox classifies failed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, waitMailbox, setStatus, runDir, atomicWriteText } from "../src/runs/runs.mjs";

const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-e2e-verify-"));
process.env.TEAM_UP_RUNS = runsRoot;
const counter = path.join(runsRoot, "invocations");
fs.writeFileSync(counter, "0");
const body = [
  "const fs=require('node:fs');",
  `const f=${JSON.stringify(counter)};`,
  "const n=(Number(fs.readFileSync(f,'utf8')||0))+1;",
  "fs.writeFileSync(f,String(n));",
  "process.exit(n===3?1:0);",
].join("");

const state = createRun({
  cwd: runsRoot,
  role: "implementer",
  parent: { cli: "cursor", attach: "manual" },
  worker: { cli: "cursor" },
  prompt: "e2e proof worker",
  verify: { command: [process.execPath, "-e", body], runs: 5 },
});
setStatus(state.runId, "watching");
const mb = path.join(runDir(state.runId), "mailbox");
atomicWriteText(path.join(mb, "RESULT.md"), "worker claims success\n");
atomicWriteText(path.join(mb, "STATUS"), "done");

const result = waitMailbox(state.runId, { ceilingSec: 1, observe: false });
const verification = fs.readFileSync(path.join(mb, "VERIFICATION.json"), "utf8");

console.log("=== classification ===");
console.log(`status: ${result.classified.status}`);
if (result.classified.error) console.log(`error: ${result.classified.error}`);
console.log("=== VERIFICATION.json ===");
console.log(verification.trim());
