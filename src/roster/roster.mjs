#!/usr/bin/env node
// roster.mjs — facade + CLI orchestration for team-up roster runtime.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  linkDispatchToRun,
  runDir,
  loadState,
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
  const usageOut = usageWritePath();
  fs.mkdirSync(path.dirname(usageOut), { recursive: true });
  fs.writeFileSync(usageOut, `${JSON.stringify(usage, null, 2)}\n`);
  console.log(`marked ${target} limited until ${usage.marked[target].until}`);
}

function cmdUsage(args) {
  const rosterCfg = requireRoster();
  if (args.includes("--refresh")) {
    return cmdUsageRefresh(args);
  }
  const usage = loadJson(usagePath());
  if (args.includes("--check")) {
    const out = checkThresholds({ roster: rosterCfg, usage });
    if (out) console.log(out);
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

async function spawnInTmux({ roster: rosterCfg, role, dir, prompt, runId, modelPin }) {
  const now = Date.now();
  let usage = loadJson(usagePath());
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

  const priorPick = { model: r.model, cli: r.cli, skipped: r.skipped, effort: r.effort };
  try {
    const { isSubscriptionCli, collectUsageForCli } = await import("../usage/usage-collect.mjs");
    const { isCliUsageFresh } = await import("../usage/usage-windows.mjs");
    if (
      isSubscriptionCli(r.cli, rosterCfg) &&
      !isCliUsageFresh(r.cli, usage, dispatchFreshnessMs(rosterCfg) * 1000, now)
    ) {
      const refreshed = await collectUsageForCli({ cli: r.cli, roster: rosterCfg });
      if (refreshed.ok) {
        const preUsage = usage;
        usage = loadJson(usagePath());
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
          r = resolvePickAfterRefresh({
            roster: rosterCfg,
            preUsage,
            postUsage: usage,
            priorPick,
            role,
            now,
          });
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
      }
    }
  } catch {
    // stale cache — proceed with pick above
  }
  await spawnPinnedInTmux({
    roster: rosterCfg,
    model: r.model,
    cli: r.cli,
    dir,
    prompt,
    runId,
    effort: r.effort,
    sessionPrefix: `team-up-${role}`,
  });
}

async function cmdDispatch(args) {
  const role = argValue(args, "--role");
  const promptFile = argValue(args, "--prompt-file");
  const runId = argValue(args, "--run-id");
  const modelPin = argValue(args, "--model");
  const dir = resolveDispatchDir({ dir: argValue(args, "--dir"), runId });
  if (!role || (!promptFile && !runId)) {
    console.error(
      "usage: team-up dispatch --role <role> --prompt-file <file> [--dir <taskdir>] [--run-id <id>] [--model <name|cli:model>]",
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
  await spawnInTmux({ roster: requireRoster(), role, dir, prompt, runId, modelPin });
}

async function cmdHandoff(args) {
  const role = argValue(args, "--role");
  const dir = argValue(args, "--dir") || process.cwd();
  if (!role) {
    console.error("usage: team-up handoff --role <role> [--dir <taskdir>]");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dir, "HANDOFF.md"))) {
    console.error(`no HANDOFF.md in ${dir} — write it first (state, done, open, verification), then re-run`);
    process.exit(1);
  }
  await spawnInTmux({
    roster: requireRoster(),
    role,
    dir,
    prompt: "Read HANDOFF.md in this directory and continue the task it describes.",
  });
}

async function cmdPassTo(args) {
  const { resolvePassTo } = await import("./pass-to.mjs");
  const query = argValue(args, "--model") || firstPositional(args);
  const dir = argValue(args, "--dir") || process.cwd();
  if (!query) {
    console.error("usage: team-up pass-to --model <name|cli:model> [--dir <taskdir>]");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dir, "HANDOFF.md"))) {
    console.error(`no HANDOFF.md in ${dir} — write it first (state, done, open, verification), then re-run`);
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
  console.log(`resolved: ${resolved.label} (via ${resolved.source})`);
  await spawnPinnedInTmux({
    roster: rosterCfg,
    model: resolved.model,
    cli: resolved.cli,
    dir,
    prompt: "Read HANDOFF.md in this directory and continue the task it describes.",
    sessionPrefix: "team-up-pass",
  });
}

function printProposalReport(proposals) {
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
  const { proposeRoleChanges, applyProposals } = await import("../scores/propose.mjs");

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
  printProposalReport(proposals);

  if (doApply && proposals.applied.length) {
    backupRoster(rosterWritePath());
    const next = applyProposals({ roster: rosterCfg, scoresFile: collected, proposals });
    fs.writeFileSync(rosterWritePath(), `${JSON.stringify(next, null, 2)}\n`);
    console.log(`roster updated: ${rosterWritePath()}`);
  } else if (doApply) {
    console.log("nothing to auto-apply");
  } else {
    console.log("hint: re-run with --apply for semiauto chain updates");
  }
}

async function cmdPropose() {
  const { loadScores } = await import("../scores/scores.mjs");
  const { proposeRoleChanges } = await import("../scores/propose.mjs");
  const rosterCfg = requireRoster();
  const scoresFile = loadScores();
  if (!scoresFile) {
    console.error(`no scores at scores path — run: team-up refresh`);
    process.exit(1);
  }
  printProposalReport(proposeRoleChanges({ roster: rosterCfg, scoresFile }));
}

async function cmdApplyScores() {
  const { loadScores } = await import("../scores/scores.mjs");
  const { proposeRoleChanges, applyProposals } = await import("../scores/propose.mjs");
  const rosterCfg = requireRoster();
  const scoresFile = loadScores();
  if (!scoresFile) {
    console.error(`no scores — run: team-up refresh`);
    process.exit(1);
  }
  const proposals = proposeRoleChanges({ roster: rosterCfg, scoresFile });
  printProposalReport(proposals);
  if (!proposals.applied.length) {
    console.log("nothing to auto-apply");
    return;
  }
  backupRoster(rosterWritePath());
  const next = applyProposals({ roster: rosterCfg, scoresFile, proposals });
  fs.writeFileSync(rosterWritePath(), `${JSON.stringify(next, null, 2)}\n`);
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
