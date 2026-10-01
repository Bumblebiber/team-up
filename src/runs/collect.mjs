import fs from "node:fs";
import path from "node:path";
import { runsPath } from "../paths.mjs";

/** Finished runs whose result somebody still has to read. */
const COLLECTABLE = new Set(["done", "failed"]);

export const DEFAULT_UNCOLLECTED_DAYS = 7;

/**
 * Results that are sitting in a mailbox with nobody having lifted them.
 *
 * `resumeAll` brings a run back after the host session dies; it does not
 * bring back the session's intention to read the result. That gap is the
 * open risk in PLAN.md, and this is the list that closes it: whatever the
 * next host session is, `runs uncollected` says what the last one left.
 *
 * `cancelled` is left out — a human stopped it and already knows. The window
 * keeps hundreds of runs from before collection existed out of the report.
 */
export function findUncollectedRuns({
  env = process.env,
  now = Date.now(),
  days = DEFAULT_UNCOLLECTED_DAYS,
  root = null,
} = {}) {
  const dir = root ?? runsPath(env);
  if (!fs.existsSync(dir)) return [];
  const cutoff = days === null ? -Infinity : now - days * 86_400_000;
  const out = [];
  for (const runId of fs.readdirSync(dir).sort()) {
    const statePath = path.join(dir, runId, "STATE.json");
    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      continue;
    }
    if (!COLLECTABLE.has(state.status) || state.collected) continue;
    let finished = Date.parse(state.finishedAt ?? "");
    if (Number.isNaN(finished)) {
      try {
        finished = fs.statSync(statePath).mtimeMs;
      } catch {
        continue;
      }
    }
    if (finished < cutoff) continue;
    out.push({
      runId,
      status: state.status,
      role: state.role ?? null,
      finishedAt: new Date(finished).toISOString(),
      result: fs.existsSync(path.join(dir, runId, "mailbox", "RESULT.json"))
        ? path.join(dir, runId, "mailbox", "RESULT.json")
        : fs.existsSync(path.join(dir, runId, "mailbox", "RESULT.md"))
          ? path.join(dir, runId, "mailbox", "RESULT.md")
          : null,
      outcome: state.outcome?.value ?? null,
      parent: state.parent ?? null,
    });
  }
  return out;
}
