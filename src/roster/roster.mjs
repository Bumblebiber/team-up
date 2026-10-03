#!/usr/bin/env node
// roster.mjs — facade + CLI orchestration for team-up roster runtime.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { detectParent } from "../runs/parent.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import {
  linkDispatchToRun,
  runDir,
  loadState,
  updateState,
  recordRunEscalation,
  wrapPromptWithMailboxProtocol,
  promptHasMailboxProtocol,
  atomicWriteText,
} from "../runs/runs.mjs";
import {
  configPath, usagePath, loadJson, validateRoster, requireRoster, rosterWritePath, usageWritePath,
} from "./config.mjs";
import {
  parseChainEntry, resolveLimitWindows, pick, parseTtl, markLimited, checkThresholds,
  resolvePickAfterRefresh, resolvePinnedAfterRefresh, dispatchFreshnessMs, limits,
  evaluatePickCell, chainEntryEffortForPin,
} from "./chain.mjs";
import {
  firstPositional, buildCommand, tmuxArgs, spawnPinnedInTmux, resolveEffort,
} from "./command.mjs";

export {
  configPath, usagePath, loadJson, validateRoster, requireRoster, rosterWritePath, usageWritePath,
  parseChainEntry, resolveLimitWindows, pick, parseTtl, markLimited, checkThresholds,
  resolvePickAfterRefresh, resolvePinnedAfterRefresh, dispatchFreshnessMs, limits,
  evaluatePickCell, chainEntryEffortForPin,
  firstPositional, buildCommand, tmuxArgs, spawnPinnedInTmux, resolveEffort,
};

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Resolve dispatch cwd: explicit --dir wins, else run cwd, else process.cwd(). */
export function resolveDispatchDir({ dir, runId, cwd = process.cwd(), loadRun = loadState } = {}) {
  if (dir) return dir;
  if (runId) {
    const st = loadRun(runId);
    if (st?.cwd) return st.cwd;
  }
  return cwd;
}

function cmdInit() {
  const dest = rosterWritePath();
  if (fs.existsSync(dest)) {
    console.log(`exists, not touching: ${dest}`);
    return;
  }
  const src = new URL("../../roster.example.json", import.meta.url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`created ${dest} — curate models/roles/chains before first use`);
}

function cmdPick(args) {
  const role = argValue(args, "--role");
  if (!role) {
    console.error("usage: team-up pick --role <role>");
    process.exit(1);
  }
  const roster = requireRoster();
  const usage = loadJson(usagePath());
  const r = pick({ roster, usage, role });
  for (const s of r.skipped) console.log(`skipped ${s.model}: ${s.reason}`);
  if (!r.model) {
    console.error(`chain exhausted for role ${role} — no viable model`);
    process.exit(2);
  }
  console.log(`model: ${r.model}`);
  console.log(`cli: ${r.cli}`);
  if (r.effort) console.log(`effort: ${r.effort}`);
}

function cmdMarkLimited(args) {
  const target = firstPositional(args);
  const ttl = argValue(args, "--ttl");
  if (!target || !ttl) {
    console.error("usage: team-up mark-limited <model|provider> --ttl <30m|5h|1d> [--reason txt]");
    process.exit(1);
  }
  const usage = markLimited({
    usage: loadJson(usagePath()),
    target,
    ttlMs: parseTtl(ttl),
    reason: argValue(args, "--reason"),
  });
  // Atomic: the watcher, hooks and every dispatch read usage.json meanwhile.
  atomicWriteJson(usageWritePath(), usage);
  console.log(`marked ${target} limited until ${usage.marked[target].until}`);
}

async function cmdUsage(args) {
  const rosterCfg = requireRoster();
  if (args.includes("--refresh")) {
    return cmdUsageRefresh(args);
  }
  const usage = loadJson(usagePath());
  if (args.includes("--check")) {
    const { checkThresholdsWithRefresh } = await import("./chain.mjs");
    const { collectUsageForCli } = await import("../usage/usage-collect.mjs");
    // Only the calling session's own CLI can end it, as in the limit-watch
    // hook: an exhausted codex window says nothing about a claude session.
    let hostCli = null;
    try {
      const { cli } = detectParent();
      hostCli = cli && cli !== "manual" ? cli : null;
    } catch {
      // Unknown host: every window counts, as before.
    }
    const out = await checkThresholdsWithRefresh({
      roster: rosterCfg,
      usage,
      collectCli: (cli) => collectUsageForCli({ cli, roster: rosterCfg }),
      readUsage: () => loadJson(usagePath()),
      hostCli,
    });
    if (out.message) console.log(out.message);
    return;
  }
  if (!usage) {
    console.log(`no usage data at ${usagePath()} (no known limits — chains run in config order)`);
    return;
  }
  for (const [wkey, info] of Object.entries(usage.windows || {})) {
    console.log(`${wkey}: ${Math.round((info.used ?? 0) * 100)}%${info.updated ? ` (as of ${info.updated})` : ""}`);
  }
  for (const [p, info] of Object.entries(usage.providers || {})) {
    console.log(`${p}: ${Math.round((info.used ?? 0) * 100)}%${info.updated ? ` (as of ${info.updated})` : ""}`);
  }
  for (const [t, m] of Object.entries(usage.marked || {})) {
    console.log(`marked ${t}: until ${m.until}${m.reason ? ` (${m.reason})` : ""}`);
  }
}

async function cmdUsageRefresh(args) {
  const { collectUsage } = await import("../usage/usage-collect.mjs");
  const cli = argValue(args, "--cli");
  const rosterCfg = requireRoster();
  const results = await collectUsage({ clis: cli ? [cli] : undefined, roster: rosterCfg });
  for (const r of results) {
    if (r.ok) console.log(`refreshed ${r.cli}: ${Object.keys(r.windows).join(", ")}`);
    else console.log(`skip ${r.cli}: ${r.reason}`);
  }
  if (!results.some((r) => r.ok)) process.exit(1);
}

export async function spawnInTmux({
  roster: rosterCfg,
  role,
  dir,
  prompt,
  runId,
  modelPin,
  env = process.env,
  usageSnapshot,
  readUsage = () => loadJson(usagePath()),
  refreshUsage,
  spawn = spawnPinnedInTmux,
  createRun = null,
  detectParent: detectParentFn = detectParent,
  // async ({ cli }) => { ok, reason }: plan 3's admission check. Null skips it
  // (handoff and pass-to replace a session rather than add a worker).
  admit = null,
}) {
  const now = Date.now();
  let usage = usageSnapshot ?? loadJson(usagePath());
  let r;
  let pinResolved = null;

  if (modelPin) {
    const { resolvePassTo } = await import("./pass-to.mjs");
    const resolved = resolvePassTo(modelPin, rosterCfg);
    if (resolved.status === "ambiguous") {
      console.error(`ambiguous model "${modelPin}" — pick one and re-run with --model <exact>:`);
      for (const m of resolved.matches) console.error(`  ${m.label}`);
      process.exit(3);
    }
    if (resolved.status !== "ok") {
      console.error(
        `unresolved model "${modelPin}"${resolved.reason ? ` — ${resolved.reason}` : ""}`
      );
      console.error("use a roster model id, cli:model pin, or a recognizable free string (opus, composer-2.5, gpt-…)");
      process.exit(4);
    }
    pinResolved = resolved;
    const entryEffort = chainEntryEffortForPin(
      rosterCfg,
      role,
      resolved.model,
      resolved.cli,
    );
    r = evaluatePickCell({
      roster: rosterCfg,
      usage,
      role,
      model: resolved.model,
      cli: resolved.cli,
      entryEffort,
      now,
    });
    for (const s of r.skipped) console.log(`skipped ${s.model}: ${s.reason}`);
    if (!r.model) {
      console.error(`pinned model "${modelPin}" cannot run`);
      process.exit(2);
    }
  } else {
    r = pick({ roster: rosterCfg, usage, role, now });
    for (const s of r.skipped) console.log(`skipped ${s.model}: ${s.reason}`);
    if (!r.model) {
      console.error(`chain exhausted for role ${role} — no viable model`);
      process.exit(2);
    }
  }

  // null: the reading was fresh enough; "ok": re-picked on a fresh one;
  // "failed": dispatched on the stale reading because the refresh failed.
  let refresh = null;
  try {
    const { isSubscriptionCli, collectUsageForCli } = await import("../usage/usage-collect.mjs");
    const { isCliUsageFresh } = await import("../usage/usage-windows.mjs");
    if (
      isSubscriptionCli(r.cli, rosterCfg) &&
      !isCliUsageFresh(r.cli, usage, dispatchFreshnessMs(rosterCfg) * 1000, now)
    ) {
      refresh = "failed";
      const refreshed = await (refreshUsage ?? collectUsageForCli)({ cli: r.cli, roster: rosterCfg });
      if (refreshed.ok) {
        usage = readUsage();
        if (modelPin && pinResolved) {
          const entryEffort = chainEntryEffortForPin(
            rosterCfg,
            role,
            pinResolved.model,
            pinResolved.cli,
          );
          r = resolvePinnedAfterRefresh({
            roster: rosterCfg,
            postUsage: usage,
            role,
            model: pinResolved.model,
            cli: pinResolved.cli,
            entryEffort,
            now,
          });
        } else {
          r = resolvePickAfterRefresh({ roster: rosterCfg, postUsage: usage, role, now });
        }
        for (const s of r.skipped) console.log(`skipped ${s.model}: ${s.reason}`);
        if (!r.model) {
          console.error(
            modelPin
              ? `pinned model "${modelPin}" cannot run after usage refresh`
              : `chain exhausted for role ${role} after usage refresh`,
          );
          process.exit(2);
        }
        refresh = "ok";
      }
    }
  } catch {
    // stale cache — proceed with pick above
  }
  if (admit) {
    // Before the run exists: a refusal leaves nothing behind to clean up.
    const decision = await admit({ cli: r.cli });
    if (!decision.ok) {
      console.error(`ADMISSION_REFUSED: ${decision.reason}`);
      console.error("dispatch later, or pass --force-admission if you know the machine has room");
      process.exit(3);
    }
  }
  let effectiveRunId = runId;
  if (!effectiveRunId) {
    // Injectable: a test that fakes `spawn` still reached the real
    // ~/.team-up/runs through this import and left a `starting` run behind
    // on every suite run — 44 of them before anybody noticed.
    const create = createRun ?? (await import("../runs/runs.mjs")).createRun;
    const state = create({
      cwd: dir,
      role,
      parent: detectParentFn({ env }),
      worker: { cli: r.cli, model: r.model },
      prompt,
    });
    effectiveRunId = state.runId;
  }
  recordPick(effectiveRunId, {
    cli: r.cli,
    model: r.model,
    effort: r.effort ?? null,
    pinned: Boolean(modelPin),
    skipped: r.skipped,
    refresh,
  });
  return spawn({
    roster: rosterCfg,
    model: r.model,
    cli: r.cli,
    dir,
    prompt,
    runId: effectiveRunId,
    effort: r.effort,
    sessionPrefix: `team-up-${role}`,
  });
}

const PICKS_KEPT = 10;

/**
 * Append this dispatch's (or specialist launch's) routing decision to the
 * run's STATE.picks, so a run can show which limits it was routed around.
 * Best effort: an audit record must never stop a dispatch.
 */
export function recordPick(runId, pick) {
  try {
    updateState(runId, (state) => {
      state.picks = [...(state.picks || []), { at: new Date().toISOString(), ...pick }].slice(-PICKS_KEPT);
      return state;
    });
  } catch (e) {
    console.error(`warning: routing decision not recorded on run ${runId}: ${e.message}`);
  }
}

async function cmdDispatch(args) {
  const role = argValue(args, "--role");
  const promptFile = argValue(args, "--prompt-file");
  const runId = argValue(args, "--run-id");
  const modelPin = argValue(args, "--model");
  const forceAdmission = args.includes("--force-admission");
  const rosterCfg = requireRoster();
  const dir = resolveDispatchDir({ dir: argValue(args, "--dir"), runId });
  if (!role || (!promptFile && !runId)) {
    console.error(
      "usage: team-up dispatch --role <role> --prompt-file <file> [--dir <taskdir>] [--run-id <id>] [--model <name|cli:model>] [--force-admission]",
    );
    console.error("  with --run-id: prefers ~/.team-up/runs/<id>/mailbox/PROMPT.md (mailbox-wrapped)");
    console.error("  --model: pin CLI×model (no role-chain fallback); same query language as pass-to");
    process.exit(1);
  }
  let prompt = null;
  if (runId) {
    const mbPrompt = path.join(runDir(runId), "mailbox", "PROMPT.md");
    if (fs.existsSync(mbPrompt)) {
      prompt = fs.readFileSync(mbPrompt, "utf8").trim();
      if (!promptHasMailboxProtocol(prompt) && promptFile) {
        const bare = fs.readFileSync(promptFile, "utf8");
        prompt = wrapPromptWithMailboxProtocol(bare, {
          runId,
          runDirectory: runDir(runId),
        }).trim();
        atomicWriteText(mbPrompt, prompt);
      }
    } else if (promptFile) {
      const bare = fs.readFileSync(promptFile, "utf8");
      prompt = wrapPromptWithMailboxProtocol(bare, {
        runId,
        runDirectory: runDir(runId),
      }).trim();
      fs.mkdirSync(path.dirname(mbPrompt), { recursive: true });
      atomicWriteText(mbPrompt, prompt);
    }
  }
  if (!prompt) {
    if (!promptFile) {
      console.error("dispatch: need --prompt-file or an existing mailbox PROMPT for --run-id");
      process.exit(1);
    }
    prompt = fs.readFileSync(promptFile, "utf8").trim();
  }
  await spawnInTmux({
    roster: rosterCfg,
    role,
    dir,
    prompt,
    runId,
    modelPin,
    admit: forceAdmission ? null : async ({ cli }) => {
      const { checkAdmission } = await import("../admission/admission.mjs");
      return checkAdmission({ cli });
    },
  });
}

async function cmdHandoff(args) {
  const {
    closeHandoff,
    resolveHandoffForSpawn,
    successorPrompt,
  } = await import("../handoff/store.mjs");

  const closePath = argValue(args, "--close");
  if (closePath) {
    const note = argValue(args, "--note");
    try {
      const result = closeHandoff(closePath, { note });
      if (result.status === "already_closed") {
        console.log(`handoff already closed: ${result.path}`);
        return;
      }
      console.log(`handoff closed: ${result.path}`);
    } catch (error) {
      console.error(String(error.message || error));
      process.exit(1);
    }
    return;
  }

  const role = argValue(args, "--role");
  const dir = argValue(args, "--dir") || process.cwd();
  const handoffFile = argValue(args, "--handoff-file");
  if (!role) {
    console.error(
      "usage: team-up handoff --role <role> [--dir <taskdir>] [--handoff-file <path>]\n" +
      "       team-up handoff --close <path> [--note <text>]"
    );
    process.exit(1);
  }
  const rosterCfg = requireRoster();
  let handoffPath;
  try {
    handoffPath = resolveHandoffForSpawn({ dir, handoffFile, label: role });
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(1);
  }
  console.log(`handoff stored: ${handoffPath}`);
  await spawnInTmux({
    roster: rosterCfg,
    role,
    dir,
    prompt: successorPrompt(handoffPath),
  });
  recordRunEscalation(process.env.TEAMUP_RUN_ID, "handoff");
}

async function cmdPassTo(args) {
  const { resolvePassTo } = await import("./pass-to.mjs");
  const {
    resolveHandoffForSpawn,
    successorPrompt,
  } = await import("../handoff/store.mjs");
  const query = argValue(args, "--model") || firstPositional(args);
  const dir = argValue(args, "--dir") || process.cwd();
  const handoffFile = argValue(args, "--handoff-file");
  if (!query) {
    console.error("usage: team-up pass-to --model <name|cli:model> [--dir <taskdir>] [--handoff-file <path>]");
    process.exit(1);
  }
  const rosterCfg = requireRoster();
  const resolved = resolvePassTo(query, rosterCfg);
  if (resolved.status === "ambiguous") {
    console.error(`ambiguous model "${query}" — pick one and re-run with --model <exact>:`);
    for (const m of resolved.matches) console.error(`  ${m.label}`);
    process.exit(3);
  }
  if (resolved.status !== "ok") {
    console.error(
      `unresolved model "${query}"${resolved.reason ? ` — ${resolved.reason}` : ""}`
    );
    console.error("use a roster model id, cli:model pin, or a recognizable free string (opus, composer-2.5, gpt-…)");
    process.exit(4);
  }
  let handoffPath;
  try {
    handoffPath = resolveHandoffForSpawn({ dir, handoffFile, label: resolved.model });
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(1);
  }
  console.log(`handoff stored: ${handoffPath}`);
  console.log(`resolved: ${resolved.label} (via ${resolved.source})`);
  await spawnPinnedInTmux({
    roster: rosterCfg,
    model: resolved.model,
    cli: resolved.cli,
    dir,
    prompt: successorPrompt(handoffPath),
    sessionPrefix: "team-up-pass",
  });
  recordRunEscalation(process.env.TEAMUP_RUN_ID, "pass-to");
}

function printProposalReport(proposals, unlisted = []) {
  console.log(`== roster scores report (${proposals.at}) ==`);
  console.log(`applied: ${proposals.applied.length}`);
  for (const a of proposals.applied) {
    console.log(
      `  APPLY ${a.role}: ${a.current ? `${a.current.cli}:${a.current.model} (${a.current.score})` : "(empty)"} → ${a.entry} (${a.proposed.score}, blended=${a.proposed.blended})`
    );
  }
  console.log(`skipped: ${proposals.skipped.length}`);
  for (const s of proposals.skipped) {
    console.log(`  SKIP  ${s.role}: ${s.reason}`);
  }
  if (unlisted.length) {
    console.log(`not in roster: ${unlisted.length}`);
    for (const u of unlisted) {
      console.log(
        `  NEW   ${u.model} scores ${u.score} — ${u.gap.toFixed(1)} above ${u.head} (${u.headScore}) on ${u.role}; add it to models to make it a candidate`
      );
    }
  }
}

function backupRoster(rosterFile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${rosterFile}.bak-${stamp}`;
  fs.copyFileSync(rosterFile, bak);
  console.log(`backup: ${bak}`);
  return bak;
}

async function cmdRefresh(args) {
  const { collectScores, buildRoleScores, writeScores } =
    await import("../scores/scores.mjs");
  const { proposeRoleChanges, applyProposals, unlistedHighScorers } =
    await import("../scores/propose.mjs");

  const fixtureDir = argValue(args, "--fixture-dir");
  const doApply = args.includes("--apply");
  let collected;
  try {
    collected = await collectScores({
      fixtureDir: fixtureDir || undefined,
    });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  const rosterCfg = loadJson(configPath());
  collected.role_scores = buildRoleScores(collected, rosterCfg || { clis: {} });
  const dest = writeScores(collected);
  console.log(`scores written: ${dest}`);

  if (!rosterCfg) {
    console.log("no roster.json — scores only (run init + curate before apply)");
    return;
  }

  const proposals = proposeRoleChanges({ roster: rosterCfg, scoresFile: collected });
  printProposalReport(proposals, unlistedHighScorers({ roster: rosterCfg, scoresFile: collected }));

  if (doApply && proposals.applied.length) {
    backupRoster(rosterWritePath());
    const next = applyProposals({ roster: rosterCfg, scoresFile: collected, proposals });
    atomicWriteJson(rosterWritePath(), next);
    console.log(`roster updated: ${rosterWritePath()}`);
  } else if (doApply) {
    console.log("nothing to auto-apply");
  } else {
    console.log("hint: re-run with --apply for semiauto chain updates");
  }
}

async function cmdPropose() {
  const { loadScores } = await import("../scores/scores.mjs");
  const { proposeRoleChanges, unlistedHighScorers } = await import("../scores/propose.mjs");
  const rosterCfg = requireRoster();
  const scoresFile = loadScores();
  if (!scoresFile) {
    console.error(`no scores at scores path — run: team-up refresh`);
    process.exit(1);
  }
  printProposalReport(
    proposeRoleChanges({ roster: rosterCfg, scoresFile }),
    unlistedHighScorers({ roster: rosterCfg, scoresFile })
  );
}

async function cmdApplyScores() {
  const { loadScores } = await import("../scores/scores.mjs");
  const { proposeRoleChanges, applyProposals, unlistedHighScorers } =
    await import("../scores/propose.mjs");
  const rosterCfg = requireRoster();
  const scoresFile = loadScores();
  if (!scoresFile) {
    console.error(`no scores — run: team-up refresh`);
    process.exit(1);
  }
  const proposals = proposeRoleChanges({ roster: rosterCfg, scoresFile });
  printProposalReport(proposals, unlistedHighScorers({ roster: rosterCfg, scoresFile }));
  if (!proposals.applied.length) {
    console.log("nothing to auto-apply");
    return;
  }
  backupRoster(rosterWritePath());
  const next = applyProposals({ roster: rosterCfg, scoresFile, proposals });
  atomicWriteJson(rosterWritePath(), next);
  console.log(`roster updated: ${rosterWritePath()}`);
}

const HANDLERS = {
  init: cmdInit,
  pick: cmdPick,
  "mark-limited": cmdMarkLimited,
  usage: cmdUsage,
  dispatch: cmdDispatch,
  handoff: cmdHandoff,
  "pass-to": cmdPassTo,
  refresh: cmdRefresh,
  propose: cmdPropose,
  "apply-scores": cmdApplyScores,
};

export async function runRosterCli(argv) {
  const [cmd, ...args] = argv;
  const handler = HANDLERS[cmd];
  if (!handler) {
    console.error(`usage: team-up <${Object.keys(HANDLERS).join("|")}> [options]`);
    return 1;
  }
  await handler(args);
  return 0;
}

async function main() {
  const code = await runRosterCli(process.argv.slice(2));
  if (code) process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
