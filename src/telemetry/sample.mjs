import { execFileSync } from "node:child_process";
import {
  childLookup,
  processTree,
  readBootId,
  readCgroup,
  readLoad,
  readMeminfo,
  readPressure,
  readUptime,
  sumProcesses,
} from "./proc.mjs";

export const SAMPLE_SCHEMA = "team-up.telemetry/v1";

function defaultPanePids(session, { exec = execFileSync } = {}) {
  try {
    const raw = exec("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return String(raw).split("\n").map((l) => Number(l.trim())).filter((n) => n > 0);
  } catch {
    return [];
  }
}

function defaultUnitCgroup(unit, { exec = execFileSync } = {}) {
  try {
    const raw = exec("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", unit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return String(raw).trim() || null;
  } catch {
    return null;
  }
}

async function defaultListStates() {
  const { listActiveStates } = await import("../runs/runs.mjs");
  return listActiveStates({ onCorrupt: () => {} });
}

/**
 * One row per live worker. A worker under `systemd-run --user` is not a
 * descendant of its tmux pane (the pane only holds the `systemd-run` client),
 * so it is read from its unit's cgroup; every other worker is the pane's
 * process tree. A run whose tmux session is gone has no live worker and no row.
 */
export function workerRows(states, {
  procRoot = "/proc",
  cgroupRoot = "/sys/fs/cgroup",
  panePids = defaultPanePids,
  unitCgroup = defaultUnitCgroup,
} = {}) {
  const children = childLookup(procRoot);
  const rows = [];
  for (const state of states) {
    const tmux = state.worker?.tmux;
    if (!tmux) continue;
    const panes = panePids(tmux);
    if (!panes.length) continue;
    const row = {
      runId: state.runId,
      role: state.role ?? null,
      cli: state.runtime?.cli ?? state.worker?.cli ?? null,
      tmux,
    };
    const unit = state.sandbox?.unit;
    const cgroup = unit ? unitCgroup(unit) : null;
    const fromCgroup = cgroup ? readCgroup(cgroup, { cgroupRoot, procRoot }) : null;
    if (fromCgroup) {
      rows.push({ ...row, source: "cgroup", unit, ...fromCgroup });
      continue;
    }
    const processes = panes.flatMap((pid) => processTree(pid, { procRoot, children }));
    const entry = { ...row, source: "tmux", ...sumProcesses(processes) };
    if (state.sandbox?.kind === "systemd-run-user") {
      // Started before units were named, or the unit is already gone: what the
      // pane holds is the systemd-run client, not the worker.
      entry.note = unit ? "unit cgroup unreadable; RSS covers the pane only" : "sandboxed worker without a recorded unit; RSS covers the pane only";
    }
    rows.push(entry);
  }
  return rows;
}

/**
 * One reading of the machine and of team-up's share of it.
 *
 * `states` defaults to the active runs on disk; pass a list in tests.
 */
/**
 * Live parent sessions from the registry, each with its process tree. Kept
 * apart from the team-up total: the session would run without team-up, but a
 * restart report should still see what the parents held.
 */
export function parentRows(records, { procRoot = "/proc" } = {}) {
  const children = childLookup(procRoot);
  return records.map((record) => {
    const total = sumProcesses(processTree(record.pid, { procRoot, children }));
    return {
      cli: record.cli,
      session_id: record.session_id,
      pid: record.pid,
      tmux: record.tmux?.session ?? null,
      rss_kb: total.rss_kb,
      cpu_ms: total.cpu_ms,
      processes: total.pids.length,
    };
  });
}

async function defaultSessionRecords(procRoot) {
  const { listLiveSessionRecords } = await import("../runs/parent.mjs");
  return listLiveSessionRecords({ procRoot });
}

export async function takeSample({
  now = new Date(),
  procRoot = "/proc",
  cgroupRoot = "/sys/fs/cgroup",
  states,
  panePids,
  unitCgroup,
  sessions,
} = {}) {
  const runs = states ?? await defaultListStates();
  const workers = workerRows(runs, { procRoot, cgroupRoot, panePids, unitCgroup });
  let parents = [];
  try {
    parents = parentRows(sessions ?? await defaultSessionRecords(procRoot), { procRoot });
  } catch {
    // a sample without parents still says what the workers did
  }
  return {
    schema: SAMPLE_SCHEMA,
    at: now.toISOString(),
    boot_id: readBootId(procRoot),
    uptime_s: readUptime(procRoot),
    load: readLoad(procRoot),
    mem: readMeminfo(procRoot),
    psi: readPressure(procRoot),
    workers,
    team_up_rss_kb: workers.reduce((sum, w) => sum + (w.rss_kb ?? 0), 0),
    parents,
  };
}
