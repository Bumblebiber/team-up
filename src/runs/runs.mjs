#!/usr/bin/env node
// runs.mjs — disk-first cross-CLI run registry + mailbox + agentless resume.
// State: ~/.team-up/runs/<runId>/ (TEAM_UP_RUNS / O9K_RUNS override). Zero dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function runsRoot() {
  return process.env.TEAM_UP_RUNS || process.env.O9K_RUNS || path.join(os.homedir(), ".team-up/runs");
}

export function runDir(runId) {
  return path.join(runsRoot(), runId);
}

export function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function atomicWriteText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`);
  fs.renameSync(tmp, filePath);
}

function newRunId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const short = Math.random().toString(36).slice(2, 6);
  return `${iso}-${short}`;
}

/** Plugin root (…/o9k-roster) — templates live beside scripts/. */
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/** @deprecated alias — templates live at package root */
export function rosterPluginRoot() {
  return packageRoot();
}

/** True when the prompt already carries the mailbox closeout contract. */
export function promptHasMailboxProtocol(text) {
  const t = text || "";
  return /mailbox\/STATUS|STATUS\s*=\s*`?done`?/i.test(t) && /HEARTBEAT/i.test(t);
}

/**
 * Wrap a bare task prompt with templates/worker-prompt.md so the worker
 * knows to set mailbox STATUS=done. Without this, parents hang on `runs wait`
 * while PLAN.md already exists on disk (2026-07-20 live failure).
 *
 * @param {string} taskBody
 * @param {{ runId?: string, runDirectory?: string, resultProtocol?: string }} [opts]
 *   resultProtocol "RESULT.json" → typed specialist closeout;
 *   omitted / "RESULT.md" → generic Path-B RESULT.md closeout.
 */
export function wrapPromptWithMailboxProtocol(taskBody, { runId, runDirectory, resultProtocol } = {}) {
  const body = (taskBody || "").trim();
  if (promptHasMailboxProtocol(body)) return body.endsWith("\n") ? body : `${body}\n`;
  const typed = resultProtocol === "RESULT.json";
  const tplName = typed ? "worker-prompt.md" : "worker-prompt-legacy.md";
  const tplPath = path.join(rosterPluginRoot(), "templates", tplName);
  let tpl = fs.readFileSync(tplPath, "utf8");
  const rd = runDirectory || (runId ? runDir(runId) : "{{RUN_DIR}}");
  tpl = tpl
    .replaceAll("{{RUN_DIR}}", rd)
    .replaceAll("{{RUN_ID}}", runId || "{{RUN_ID}}")
    .replace("{{TASK_BODY}}", body);
  return tpl.endsWith("\n") ? tpl : `${tpl}\n`;
}

export function createRun({
  cwd, project, role, parent, worker, prompt, now = new Date(),
  result_protocol,
}) {
  const runId = newRunId(now);
  const attach = parent.attach || (parent.tmux ? "tmux" : "manual");
  const state = {
    runId,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cwd,
    project: project || null,
    role,
    status: "starting",
    parent: {
      cli: parent.cli,
      sessionId: parent.sessionId || null,
      tmux: attach === "tmux" ? (parent.tmux || null) : null,
      attach,
    },
    worker: {
      cli: worker.cli,
      model: worker.model || null,
      sessionId: worker.sessionId || null,
      tmux: worker.tmux || null,
    },
    watcher: { kind: "internal_subagent", attached: false },
    mailbox: "mailbox/",
  };
  if (result_protocol) state.result_protocol = result_protocol;
  const rd = runDir(runId);
  const mb = path.join(rd, "mailbox");
  fs.mkdirSync(mb, { recursive: true });
  atomicWriteJson(path.join(rd, "STATE.json"), state);
  atomicWriteText(path.join(mb, "STATUS"), "starting");
  const wrapped = wrapPromptWithMailboxProtocol(prompt, {
    runId,
    runDirectory: rd,
    resultProtocol: result_protocol,
  });
  atomicWriteText(path.join(mb, "PROMPT.md"), wrapped);
  return state;
}

export function loadState(runId) {
  const p = path.join(runDir(runId), "STATE.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(path.join(runDir(state.runId), "STATE.json"), state);
  return state;
}

export function mailboxDir(runId) {
  return path.join(runDir(runId), "mailbox");
}

function readMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Inspect mailbox once; return { status, question?, resultPath?, error? }.
 * Only runs whose STATE declares result_protocol: "RESULT.json" require typed JSON.
 * Generic/legacy Path-B runs succeed with RESULT.md.
 */
export function classifyMailbox(runId) {
  const mb = mailboxDir(runId);
  const statusLine = (readMaybe(path.join(mb, "STATUS")) || "").trim();
  const questions = readMaybe(path.join(mb, "QUESTIONS.md"));
  const resultMd = readMaybe(path.join(mb, "RESULT.md"));
  const resultJsonRaw = readMaybe(path.join(mb, "RESULT.json"));
  const resultJsonPath = path.join(mb, "RESULT.json");
  const resultMdPath = path.join(mb, "RESULT.md");
  const state = loadState(runId);
  const typed = state?.result_protocol === "RESULT.json";

  if (statusLine === "failed") {
    return {
      status: "failed",
      error: "STATUS=failed",
      resultPath: resultJsonRaw ? resultJsonPath : (resultMd ? resultMdPath : null),
    };
  }

  if (statusLine === "done") {
    if (!typed) {
      if (!resultMd && !resultJsonRaw) {
        return {
          status: "failed",
          error: "STATUS=done but RESULT.md missing",
          resultPath: null,
        };
      }
      return {
        status: "done",
        resultPath: resultMd ? resultMdPath : resultJsonPath,
        summary: String(resultMd || resultJsonRaw || "").slice(0, 500),
      };
    }
    if (!resultJsonRaw) {
      return {
        status: "failed",
        error: "STATUS=done but RESULT.json missing (RESULT.md is not sufficient)",
        resultPath: resultMd ? resultMdPath : null,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(resultJsonRaw);
    } catch (e) {
      return {
        status: "failed",
        error: `malformed RESULT.json: ${e.message}`,
        resultPath: resultJsonPath,
      };
    }
    if (parsed?.schema && parsed.schema !== "team-up.result/v1") {
      return {
        status: "failed",
        error: `unsupported RESULT.json schema: ${parsed.schema}`,
        resultPath: resultJsonPath,
      };
    }
    if (!["success", "partial", "blocked", "failed"].includes(parsed?.status)) {
      return {
        status: "failed",
        error: `invalid RESULT.json status: ${parsed?.status}`,
        resultPath: resultJsonPath,
      };
    }
    if (parsed.status === "failed") {
      return { status: "failed", error: parsed.summary || "RESULT.json status=failed", resultPath: resultJsonPath };
    }
    if (parsed.status === "blocked") {
      return { status: "question", question: (parsed.questions || []).join("\n") || parsed.summary || "blocked", resultPath: resultJsonPath };
    }
    return {
      status: "done",
      resultPath: resultJsonPath,
      summary: String(parsed.summary || resultMd || "").slice(0, 500),
      result: parsed,
    };
  }

  if (questions && questions.trim() && statusLine !== "done") {
    const qStat = fs.statSync(path.join(mb, "QUESTIONS.md"));
    const aPath = path.join(mb, "ANSWER.md");
    let answered = false;
    try {
      const aStat = fs.statSync(aPath);
      answered = aStat.mtimeMs >= qStat.mtimeMs;
    } catch { /* no answer yet */ }
    if (!answered) {
      return { status: "question", question: questions.trim().slice(0, 2000) };
    }
  }
  return { status: "watching" };
}

export function setStatus(runId, status) {
  const state = loadState(runId);
  if (!state) throw new Error(`unknown run ${runId}`);
  state.status = status;
  saveState(state);
  atomicWriteText(path.join(mailboxDir(runId), "STATUS"), status);
  return state;
}

/** After roster dispatch spawns tmux, link session to run registry. */
export function linkDispatchToRun(runId, session) {
  if (!runId) return false;
  const st = loadState(runId);
  if (!st) return false;
  st.worker = st.worker || {};
  st.worker.tmux = session;
  st.watcher = { ...(st.watcher || { kind: "internal_subagent" }), attached: true };
  saveState(st);
  setStatus(runId, "watching");
  return true;
}

export function writeAnswer(runId, body, { source = "parent" } = {}) {
  const header = `<!-- source: ${source} -->\n`;
  atomicWriteText(path.join(mailboxDir(runId), "ANSWER.md"), header + body.trim() + "\n");
  return setStatus(runId, "watching");
}

export const INJECT = {
  worker:
    "Host crash recovery. Read mailbox/STATUS and mailbox/PROMPT.md; continue the task. Do not re-init from scratch.",
  parent: (runId) =>
    `Host crash recovery. Read ${path.join(runsRoot(), runId, "STATE.json")}. Continue orchestration; do not re-dispatch if worker tmux is alive.`,
  waitingHuman: " You were blocked on a human question — re-surface it; do not invent an answer.",
};

function defaultTmuxExists(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Returns { actions: [...] } without spawning. */
export function buildResumePlan(state, { tmuxExists = defaultTmuxExists } = {}) {
  if (["done", "failed", "cancelled"].includes(state.status)) {
    return { actions: [] };
  }
  const actions = [];
  const injectWorker = INJECT.worker;
  let injectParent = INJECT.parent(state.runId);
  if (state.status === "waiting_human") injectParent += INJECT.waitingHuman;

  const crashSpawnDisabled =
    state.recovery?.crash_spawn === false ||
    state.capacity?.wait_cancelled === true ||
    state.status === "waiting_decision" ||
    state.status === "waiting_capacity";

  if (
    !crashSpawnDisabled &&
    state.worker?.tmux &&
    !tmuxExists(state.worker.tmux)
  ) {
    actions.push({
      kind: "spawn_worker",
      tmux: state.worker.tmux,
      cwd: state.cwd,
      cli: state.worker.cli,
      sessionId: state.worker.sessionId,
      inject: injectWorker,
      promptPath: path.join(runDir(state.runId), "mailbox", "PROMPT.md"),
    });
  }
  if (state.parent?.attach === "tmux" && state.parent.tmux && !tmuxExists(state.parent.tmux)) {
    actions.push({
      kind: "spawn_parent",
      tmux: state.parent.tmux,
      cwd: state.cwd,
      cli: state.parent.cli,
      sessionId: state.parent.sessionId,
      inject: injectParent,
    });
  } else if (state.parent?.attach === "manual") {
    actions.push({ kind: "parent_awaiting_attach", runId: state.runId, sessionId: state.parent.sessionId });
  }
  actions.push({ kind: "flag_reattach_watcher", runId: state.runId });
  return { actions };
}

export function buildCliArgv({ cli, sessionId, coldStart }) {
  if (cli === "claude") {
    if (sessionId && !coldStart) return ["claude", "--resume", sessionId];
    return ["claude"];
  }
  if (cli === "codex") {
    if (sessionId && !coldStart) return ["codex", "resume", sessionId];
    return ["codex"];
  }
  return null; // unknown → cold_start signal
}

export function resumeLockPath() {
  return path.join(runsRoot(), ".resume.lock");
}

export function listActiveStates({ onCorrupt } = {}) {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".")) continue;
    let st;
    try {
      st = loadState(name);
    } catch (e) {
      if (typeof onCorrupt === "function") onCorrupt(name, e);
      else console.error(`skip corrupt run ${name}: ${e.message}`);
      continue;
    }
    if (!st) continue;
    if (["done", "failed", "cancelled"].includes(st.status)) continue;
    out.push(st);
  }
  return out;
}

export function shellQuote(s) {
  return /^[A-Za-z0-9_\-./=]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Unknown-CLI cold start: echo hint then exec. No nested-quote traps. */
export function buildColdStartArgv({ runId, promptPath, cli }) {
  const msg = `cold_start run ${runId}; read mailbox/PROMPT.md at ${promptPath || "(none)"}`;
  return ["bash", "-lc", `echo ${shellQuote(msg)}; exec ${shellQuote(cli || "bash")}`];
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true;
    throw e;
  }
}

/** Acquire lock; steal if holder PID is dead (host-crash mid-resume). */
export function acquireResumeLock(lockPath = resumeLockPath()) {
  // O_EXCL create so two concurrent resumes can't both "win" the lock
  // (same pattern as usage-pty-lock.mjs).
  const tryCreate = () => {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
  };
  try {
    tryCreate();
    return;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const raw = fs.readFileSync(lockPath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
    throw new Error(`resume lock held: ${lockPath} (pid ${pid})`);
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* raced */
  }
  tryCreate();
}

export function captureTmuxPane(session) {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", session, "-p"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function sleepMs(ms) {
  const sec = Math.max(0.05, ms / 1000);
  execFileSync("sleep", [String(sec)], { stdio: "ignore" });
}

/** Poll pane until non-empty or timeout (CLI TUI boot). */
export function waitTmuxReady(session, {
  timeoutMs = 10000,
  intervalMs = 500,
  capture = captureTmuxPane,
  sleep = sleepMs,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capture(session);
    if (pane && pane.trim().length > 0) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    sleep(Math.min(intervalMs, remaining));
  }
  return false;
}

export function pasteInject(session, text, {
  waitReady = waitTmuxReady,
  readyTimeoutMs = 10000,
} = {}) {
  waitReady(session, { timeoutMs: readyTimeoutMs });
  const tmp = path.join(os.tmpdir(), `o9k-inject-${session}-${process.pid}.txt`);
  fs.writeFileSync(tmp, text || "");
  try {
    execFileSync(
      "bash",
      [
        "-lc",
        `tmux load-buffer -b o9k ${shellQuote(tmp)} && tmux paste-buffer -b o9k -t ${shellQuote(session)} && sleep 0.3 && tmux send-keys -t ${shellQuote(session)} Enter`,
      ],
      { stdio: "ignore" },
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* */
    }
  }
}

export function executeResumeAction(action, state, {
  waitReady = waitTmuxReady,
  readyTimeoutMs = 10000,
} = {}) {
  if (action.kind === "parent_awaiting_attach" || action.kind === "flag_reattach_watcher") {
    return;
  }
  if (action.kind !== "spawn_worker" && action.kind !== "spawn_parent") return;

  let argv = buildCliArgv({
    cli: action.cli,
    sessionId: action.sessionId,
    coldStart: !action.sessionId,
  });
  if (!argv) {
    argv = buildColdStartArgv({
      runId: state.runId,
      promptPath: action.promptPath,
      cli: action.cli,
    });
    state.recovery = "cold_start";
    saveState(state);
  }
  const cmd = argv.map(shellQuote).join(" ");
  execFileSync("tmux", ["new-session", "-d", "-s", action.tmux, "-c", action.cwd || process.cwd(), cmd], {
    stdio: "ignore",
  });
  pasteInject(action.tmux, action.inject || "", { waitReady, readyTimeoutMs });
}

export function resumeAll({
  dryRun = false,
  tmuxExists = defaultTmuxExists,
  logDir = null,
  now = new Date(),
  execute = executeResumeAction,
} = {}) {
  fs.mkdirSync(runsRoot(), { recursive: true });
  const lock = resumeLockPath();
  acquireResumeLock(lock);
  const resolvedLogDir = logDir || path.join(os.homedir(), ".team-up/logs");
  const report = { at: now.toISOString(), runs: [] };
  try {
    for (const state of listActiveStates()) {
      const plan = buildResumePlan(state, { tmuxExists });
      report.runs.push({ runId: state.runId, status: state.status, actions: plan.actions });
      if (dryRun) continue;
      for (const action of plan.actions) {
        execute(action, state);
      }
      atomicWriteText(path.join(mailboxDir(state.runId), "REATTACH_WATCHER"), "1\n");
    }
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* */
    }
  }
  fs.mkdirSync(resolvedLogDir, { recursive: true });
  const logFile = path.join(resolvedLogDir, `resume-${now.toISOString().replace(/[:.]/g, "-")}.log`);
  fs.writeFileSync(logFile, `${JSON.stringify(report, null, 2)}\n`);
  report.logFile = logFile;
  return report;
}

export function waitMailbox(runId, { ceilingSec = 3600 } = {}) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/wait-mailbox.sh");
  const r = spawnSync(script, [mailboxDir(runId), "--ceiling-sec", String(ceilingSec)], { encoding: "utf8" });
  const classified = classifyMailbox(runId);
  return { waitExit: r.status ?? 1, classified };
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function printClassified(c) {
  console.log(`status: ${c.status}`);
  if (c.question) console.log(`question: ${c.question}`);
}

function cmdCreate(args) {
  const promptFile = argValue(args, "--prompt-file");
  const cwd = argValue(args, "--cwd");
  const role = argValue(args, "--role");
  const parentCli = argValue(args, "--parent-cli");
  const parentAttach = argValue(args, "--parent-attach");
  const workerCli = argValue(args, "--worker-cli");
  if (!cwd || !role || !parentCli || !parentAttach || !workerCli || !promptFile) {
    console.error(
      "usage: runs.mjs create --cwd <dir> --role <role> --parent-cli <cli> --parent-attach <mode>"
      + " [--parent-session <id>] [--parent-tmux <name>] --worker-cli <cli>"
      + " [--worker-model <model>] [--worker-tmux <name>] --prompt-file <file> [--project <id>]",
    );
    process.exit(1);
  }
  const prompt = fs.readFileSync(promptFile, "utf8");
  const state = createRun({
    cwd,
    project: argValue(args, "--project"),
    role,
    parent: {
      cli: parentCli,
      sessionId: argValue(args, "--parent-session"),
      tmux: argValue(args, "--parent-tmux"),
      attach: parentAttach,
    },
    worker: {
      cli: workerCli,
      model: argValue(args, "--worker-model"),
      tmux: argValue(args, "--worker-tmux"),
    },
    prompt,
  });
  console.log(`runId: ${state.runId}`);
  console.log(`dir: ${runDir(state.runId)}`);
  console.log(`mailbox: ${mailboxDir(state.runId)}`);
}

function cmdClassify(args) {
  const runId = args[0];
  if (!runId) {
    console.error("usage: runs.mjs classify <runId>");
    process.exit(1);
  }
  printClassified(classifyMailbox(runId));
}

function cmdAnswer(args) {
  const runId = args[0];
  const text = argValue(args, "--text");
  const file = argValue(args, "--file");
  if (!runId || (!text && !file)) {
    console.error("usage: runs.mjs answer <runId> --text <text> | --file <path>");
    process.exit(1);
  }
  const body = text ?? fs.readFileSync(file, "utf8");
  writeAnswer(runId, body);
}

function cmdSetStatus(args) {
  const [runId, status] = args;
  if (!runId || !status) {
    console.error("usage: runs.mjs set-status <runId> <status>");
    process.exit(1);
  }
  setStatus(runId, status);
}

function cmdWait(args) {
  const runId = args[0];
  const ceilingRaw = argValue(args, "--ceiling-sec");
  if (!runId) {
    console.error("usage: runs.mjs wait <runId> [--ceiling-sec N]");
    process.exit(1);
  }
  const ceilingSec = ceilingRaw ? Number(ceilingRaw) : 3600;
  const { waitExit, classified } = waitMailbox(runId, { ceilingSec });
  printClassified(classified);
  process.exitCode = waitExit;
}

function cmdResume(args) {
  const dryRun = args.includes("--dry-run");
  const report = resumeAll({ dryRun });
  for (const r of report.runs) {
    console.log(`runId: ${r.runId} status: ${r.status}`);
    for (const a of r.actions) {
      const parts = [`  action: ${a.kind}`];
      if (a.tmux) parts.push(`tmux=${a.tmux}`);
      if (a.runId) parts.push(`runId=${a.runId}`);
      console.log(parts.join(" "));
    }
  }
  // Durable automatic resume for due capacity waits (unified start path).
  import("../supervisor/waits.mjs")
    .then(async ({ resumeDueWaits }) => {
      const { loadJson, requireRoster, usagePath } = await import("../roster/config.mjs");
      const { resolveProfile } = await import("../roster/profile.mjs");
      const { startFromLaunchDescriptor } = await import("../supervisor/start.mjs");
      const roster = requireRoster();
      const usage = loadJson(usagePath()) || {};
      if (dryRun) {
        const { listDueWaits } = await import("../supervisor/waits.mjs");
        for (const id of listDueWaits({ now: new Date().toISOString() })) {
          console.log(`due-wait: ${id}`);
        }
        return;
      }
      const results = await resumeDueWaits({
        now: new Date().toISOString(),
        usage,
        roster,
        resolveProfileForRun: async (runId, state) => {
          const profile = state.specialist_profile || state.profile || {
            tier: "frontier",
            reasoning: "max",
          };
          return resolveProfile({
            roster,
            usage,
            profile,
            requirements:
              state.harness_requirements ||
              state.launch_descriptor?.harness_requirements ||
              {},
          });
        },
        startWorker: async ({ attempt, runId }) => {
          const started = startFromLaunchDescriptor({
            runId,
            runtimeOverride: attempt.runtime,
            attempt,
          });
          console.log(
            `resumed-wait: ${runId} attempt=${attempt.id} tmux=${started.session}`
          );
        },
      });
      for (const r of results) {
        console.log(
          `capacity-resume: ${r.runId} ok=${r.ok} resumed=${Boolean(r.resumed)} reason=${r.reason || ""}`
        );
      }
    })
    .catch((e) => {
      console.error(`capacity resume error: ${e.message || e}`);
    });
  console.log(`log: ${report.logFile}`);
}

function cmdCapacity(args) {
  const runId = args[0];
  if (!runId) {
    console.error("usage: runs.mjs capacity <runId>");
    process.exit(1);
  }
  const state = loadState(runId);
  console.log(JSON.stringify(state?.capacity || null, null, 2));
}

async function cmdWaitCapacity(args) {
  const runId = args[0];
  const reset = argValue(args, "--next-reset-at") || argValue(args, "--at");
  if (!runId || !reset) {
    console.error("usage: runs.mjs wait-capacity <runId> --next-reset-at <iso>");
    process.exit(1);
  }
  const { approveCapacityWait } = await import("../supervisor/waits.mjs");
  const cap = approveCapacityWait({ runId, nextResetAt: reset });
  console.log(JSON.stringify(cap, null, 2));
}

async function cmdCancelWait(args) {
  const runId = args[0];
  const reason = argValue(args, "--reason") || "cancelled";
  if (!runId) {
    console.error("usage: runs.mjs cancel-wait <runId> --reason <text>");
    process.exit(1);
  }
  const { cancelCapacityWait } = await import("../supervisor/waits.mjs");
  const state = cancelCapacityWait({ runId, reason });
  console.log(JSON.stringify({ status: state.status, capacity: state.capacity }, null, 2));
}

async function cmdRecheckCapacity(args) {
  const runId = args[0];
  if (!runId) {
    console.error("usage: runs.mjs recheck-capacity <runId>");
    process.exit(1);
  }
  const { recheckCapacity } = await import("../supervisor/waits.mjs");
  const { loadJson, requireRoster, usagePath } = await import("../roster/config.mjs");
  const { resolveProfile } = await import("../roster/profile.mjs");
  const { startFromLaunchDescriptor } = await import("../supervisor/start.mjs");
  const roster = requireRoster();
  const usage = loadJson(usagePath()) || {};
  const state = loadState(runId);
  const profile = state?.specialist_profile || state?.profile || {
    tier: "frontier",
    reasoning: "max",
  };
  const profileResult = resolveProfile({
    roster,
    usage,
    profile,
    requirements:
      state?.harness_requirements ||
      state?.launch_descriptor?.harness_requirements ||
      {},
  });
  const result = await recheckCapacity({
    runId,
    usage,
    roster,
    profileResult,
    startWorker: async ({ attempt }) => {
      startFromLaunchDescriptor({
        runId,
        runtimeOverride: attempt.runtime,
        attempt,
      });
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

function cmdCancel(args) {
  const runId = args[0];
  if (!runId) {
    console.error("usage: runs.mjs cancel <runId>");
    process.exit(1);
  }
  setStatus(runId, "cancelled");
  const state = loadState(runId);
  state.status = "cancelled";
  saveState(state);
  console.log(`cancelled ${runId}`);
}

const HANDLERS = {
  create: cmdCreate,
  classify: cmdClassify,
  answer: cmdAnswer,
  "set-status": cmdSetStatus,
  wait: cmdWait,
  resume: cmdResume,
  capacity: cmdCapacity,
  "wait-capacity": (args) => {
    cmdWaitCapacity(args);
  },
  "cancel-wait": (args) => {
    cmdCancelWait(args);
  },
  "recheck-capacity": (args) => {
    cmdRecheckCapacity(args);
  },
  cancel: cmdCancel,
};

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const handler = HANDLERS[cmd];
  if (!handler) {
    console.error(`usage: runs.mjs <${Object.keys(HANDLERS).join("|")}> [options]`);
    process.exit(1);
  }
  handler(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}


import { writeTypedResult as writeTypedResultImpl, validateResult } from "../specialists/request.mjs";

export function writeTypedResult(runId, result) {
  return writeTypedResultImpl(runId, result, {
    runDir,
    atomicWriteJson,
    atomicWriteText,
    setStatus,
    classifyMailbox,
  });
}

export { validateResult };
