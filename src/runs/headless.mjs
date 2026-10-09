#!/usr/bin/env node
// headless.mjs — run a non-interactive CLI inside the existing tmux session.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { atomicWriteText, loadState, mailboxDir, setWorkerMailboxStatus } from "./runs.mjs";

// ponytail: keep a long task inside one worker session while bounding orphaned runs.
export const HEADLESS_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;

function readMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function touchHeartbeat(mailbox) {
  atomicWriteText(path.join(mailbox, "HEARTBEAT"), new Date().toISOString());
}

function tailLines(text, count = 40) {
  return String(text || "").trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

function parseArgs(args) {
  const [runId, cli, separator, ...argv] = args;
  if (!runId || !["codex", "cursor", "agy"].includes(cli) || separator !== "--" || !argv.length) {
    throw new Error("usage: headless.mjs <runId> <codex|cursor|agy> -- <argv…>");
  }
  return { runId, cli, argv };
}

export function signalWorker(child, signal, { platform = process.platform, kill = process.kill } = {}) {
  if (platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") {
        try { child.kill(signal); } catch { /* already gone */ }
      }
      return;
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

function makeFailureText(mailbox, reason) {
  const stderr = readMaybe(path.join(mailbox, "STDERR.log")) || "";
  const output = readMaybe(path.join(mailbox, "OUTPUT.log")) || "";
  const logName = stderr.length ? "STDERR.log" : "OUTPUT.log";
  const tail = tailLines(stderr.length ? stderr : output);
  return tail ? `${reason}\n\nLast 40 lines of ${logName}:\n${tail}` : reason;
}

function finalMessageFor(cli, mailbox, cursorResult, agyResult) {
  if (cli === "codex") return readMaybe(path.join(mailbox, "LAST_MESSAGE.md"));
  if (cursorResult && cursorResult.is_error !== true && typeof cursorResult.result === "string") return cursorResult.result;
  if (cli === "agy" && typeof agyResult?.response === "string") return agyResult.response;
  return null;
}

function agyFailureReason(result) {
  if (!result) return "agy stream had no result event";
  if (typeof result.error === "string" && result.error.trim()) return `agy error: ${result.error.trim()}`;
  if (Array.isArray(result.denied_actions) && result.denied_actions.length) {
    const actions = result.denied_actions.map((entry) =>
      typeof entry === "string" ? entry : entry?.action || JSON.stringify(entry)
    ).join(", ");
    return `agy denied actions: ${actions}`;
  }
  if (typeof result.response !== "string" || !result.response.trim()) return "agy returned an empty response";
  if (result.status !== "SUCCESS") return `agy returned status ${result.status || "unknown"}`;
  return null;
}

function finalize({ runId, cli, mailbox, code, signal, cursorResult, agyResult, timedOut, childError }) {
  const statusPath = path.join(mailbox, "STATUS");
  const status = (readMaybe(statusPath) || "").trim();
  const finalMessage = finalMessageFor(cli, mailbox, cursorResult, agyResult);
  const resultPath = path.join(mailbox, "RESULT.md");
  if (["done", "failed", "cancelled"].includes(status)) {
    // A worker that set done but forgot RESULT.md would fail after the grace
    // window; its last message is the result it meant to write.
    const typed = loadState(runId)?.result_protocol === "RESULT.json";
    if (status === "done" && !typed && !fs.existsSync(resultPath) && finalMessage?.trim()) {
      atomicWriteText(resultPath, finalMessage);
    }
    return;
  }

  if (status === "waiting_human") {
    const questions = readMaybe(path.join(mailbox, "QUESTIONS.md")) || "";
    const reason = "worker exited while waiting for an answer; headless runs cannot take answers — re-dispatch with the answer in the prompt";
    setWorkerMailboxStatus(runId, "failed", {
      reason: questions ? `${reason}\n\n${questions}` : reason,
    });
    return;
  }

  if (timedOut) {
    setWorkerMailboxStatus(runId, "failed", {
      reason: makeFailureText(mailbox, "headless timeout after 4h"),
    });
    return;
  }

  if (cli === "agy" && !childError) {
    const failure = agyFailureReason(agyResult);
    if (failure) {
      setWorkerMailboxStatus(runId, "failed", { reason: makeFailureText(mailbox, failure) });
      return;
    }
  }

  if (code === 0 && finalMessage?.trim()) {
    const state = loadState(runId);
    if (state?.result_protocol === "RESULT.json" && !fs.existsSync(path.join(mailbox, "RESULT.json"))) {
      setWorkerMailboxStatus(runId, "failed", { reason: "typed run exited without RESULT.json" });
      return;
    }
    if (!fs.existsSync(resultPath)) atomicWriteText(resultPath, finalMessage);
    setWorkerMailboxStatus(runId, "done");
    return;
  }

  let reason;
  if (childError) reason = `worker failed to start: ${childError.message}`;
  else if (signal) reason = `worker exited on signal ${signal}`;
  else reason = `worker exited with code ${code}`;
  setWorkerMailboxStatus(runId, "failed", { reason: makeFailureText(mailbox, reason) });
}

async function main() {
  const { runId, cli, argv } = parseArgs(process.argv.slice(2));
  const mailbox = mailboxDir(runId);
  fs.mkdirSync(mailbox, { recursive: true });
  touchHeartbeat(mailbox);

  const outputPath = path.join(mailbox, "OUTPUT.log");
  const stderrPath = path.join(mailbox, "STDERR.log");
  const stdoutDecoder = new StringDecoder("utf8");
  let pendingLine = "";
  let sessionIdWritten = false;
  let cursorResult = null;
  let agyResult = null;
  let childError = null;
  let timedOut = false;
  let externalSignal = null;

  const inspectLine = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const sessionId = event.type === "thread.started" && typeof event.thread_id === "string"
      ? event.thread_id
      : typeof event.session_id === "string" ? event.session_id
        : typeof event.conversation_id === "string" ? event.conversation_id : null;
    if (!sessionIdWritten && sessionId) {
      atomicWriteText(path.join(mailbox, "SESSION_ID"), sessionId);
      sessionIdWritten = true;
    }
    if (cli === "cursor" && event.type === "result") cursorResult = event;
    if (cli === "agy" && event.event === "result" && event.result && typeof event.result === "object") {
      agyResult = event.result;
      if (!sessionIdWritten && typeof event.result.conversation_id === "string") {
        atomicWriteText(path.join(mailbox, "SESSION_ID"), event.result.conversation_id);
        sessionIdWritten = true;
      }
    }
  };

  const inspectText = (text) => {
    const lines = `${pendingLine}${text}`.split(/\r?\n/);
    pendingLine = lines.pop();
    for (const line of lines) inspectLine(line.trim());
  };

  const child = spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => {
    fs.appendFileSync(outputPath, chunk);
    process.stdout.write(chunk);
    inspectText(stdoutDecoder.write(chunk));
  });
  child.stdout.on("end", () => {
    inspectText(stdoutDecoder.end());
    if (pendingLine.trim()) inspectLine(pendingLine.trim());
    pendingLine = "";
  });
  child.stderr.on("data", (chunk) => {
    fs.appendFileSync(stderrPath, chunk);
    process.stderr.write(chunk);
  });

  const heartbeat = setInterval(() => touchHeartbeat(mailbox), 60 * 1000);
  const timeout = setTimeout(() => {
    timedOut = true;
    signalWorker(child, "SIGTERM");
    // Keep wrapper alive through the grace period so descendants that ignore
    // SIGTERM still receive SIGKILL as a process group, even if parent exits.
    setTimeout(() => signalWorker(child, "SIGKILL"), KILL_GRACE_MS);
  }, HEADLESS_TIMEOUT_MS);
  heartbeat.unref();
  timeout.unref();

  const forwardSignal = (signal) => {
    externalSignal = signal;
    signalWorker(child, signal);
  };
  const onSigterm = () => forwardSignal("SIGTERM");
  const onSighup = () => forwardSignal("SIGHUP");
  process.once("SIGTERM", onSigterm);
  process.once("SIGHUP", onSighup);

  const [code, signal] = await new Promise((resolve) => {
    child.once("error", (error) => { childError = error; });
    child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });

  clearInterval(heartbeat);
  clearTimeout(timeout);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);

  if (!externalSignal) finalize({ runId, cli, mailbox, code, signal, cursorResult, agyResult, timedOut, childError });
  process.exitCode = code ?? (signal ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`headless worker error: ${error.message}`);
    process.exitCode = 1;
  });
}
