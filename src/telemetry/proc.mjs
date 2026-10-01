import fs from "node:fs";
import path from "node:path";

// Readers for the few /proc and cgroup files the sampler needs. Every one takes
// its root as an argument so tests can plant a fake tree, and every one returns
// null instead of throwing: a missing file on an older kernel degrades a field,
// it never costs the sample.

// USER_HZ is part of the Linux ABI and 100 on every architecture team-up runs on.
const USER_HZ = 100;

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readBootId(procRoot = "/proc") {
  const raw = readText(path.join(procRoot, "sys", "kernel", "random", "boot_id"));
  return raw ? raw.trim() : null;
}

export function readUptime(procRoot = "/proc") {
  const raw = readText(path.join(procRoot, "uptime"));
  const value = raw ? Number(raw.trim().split(/\s+/)[0]) : NaN;
  return Number.isFinite(value) ? value : null;
}

export function readLoad(procRoot = "/proc") {
  const raw = readText(path.join(procRoot, "loadavg"));
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/).slice(0, 3).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
}

const MEMINFO_FIELDS = ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"];

export function readMeminfo(procRoot = "/proc") {
  const raw = readText(path.join(procRoot, "meminfo"));
  if (!raw) return null;
  const out = {};
  for (const line of raw.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m && MEMINFO_FIELDS.includes(m[1])) out[m[1]] = Number(m[2]);
  }
  return MEMINFO_FIELDS.every((key) => key in out) ? out : null;
}

/** `some`/`full` averages from one PSI file, or null before kernel 4.20. */
export function parsePressure(text) {
  if (!text) return null;
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)/.exec(line.trim());
    if (m) out[m[1]] = { avg10: Number(m[2]), avg60: Number(m[3]) };
  }
  return out.some ? { some: out.some, full: out.full ?? null } : null;
}

export function readPressure(procRoot = "/proc") {
  const out = {};
  for (const kind of ["memory", "cpu", "io"]) {
    out[kind] = parsePressure(readText(path.join(procRoot, "pressure", kind)));
  }
  return out;
}

/**
 * `pid (comm) state ppid …` — comm may itself hold spaces and parentheses, so
 * the fields are counted from the last `)`.
 */
export function parseStat(text) {
  if (!text) return null;
  const close = text.lastIndexOf(")");
  const open = text.indexOf("(");
  if (close === -1 || open === -1) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return {
    pid: Number(text.slice(0, open).trim()),
    comm: text.slice(open + 1, close),
    ppid: Number(fields[1]),
    cpu_ticks: (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0),
  };
}

export function readProcess(pid, procRoot = "/proc") {
  const stat = parseStat(readText(path.join(procRoot, String(pid), "stat")));
  if (!stat) return null;
  const status = readText(path.join(procRoot, String(pid), "status")) ?? "";
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  // Kernel threads and zombies have no VmRSS; they hold no user memory either.
  return { ...stat, rss_kb: m ? Number(m[1]) : 0 };
}

function numericEntries(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
}

/**
 * Child lookup for one sample. Uses `task/<tid>/children` where the kernel has
 * it (CONFIG_PROC_CHILDREN) and falls back to a single scan of every
 * `/proc/<pid>/stat` for the ppid, built only when first needed.
 */
export function childLookup(procRoot = "/proc") {
  let byParent = null;
  const scan = () => {
    byParent = new Map();
    for (const name of numericEntries(procRoot)) {
      const stat = parseStat(readText(path.join(procRoot, name, "stat")));
      if (!stat) continue;
      if (!byParent.has(stat.ppid)) byParent.set(stat.ppid, []);
      byParent.get(stat.ppid).push(stat.pid);
    }
  };
  return (pid) => {
    if (byParent === null) {
      const tasks = numericEntries(path.join(procRoot, String(pid), "task"));
      const files = tasks.map((tid) => readText(path.join(procRoot, String(pid), "task", tid, "children")));
      if (files.length && files.every((text) => text !== null)) {
        return files.flatMap((text) => text.trim().split(/\s+/).filter(Boolean).map(Number));
      }
      scan();
    }
    return byParent.get(pid) ?? [];
  };
}

/** The process and all its descendants that are still alive. */
export function processTree(rootPid, { procRoot = "/proc", children = childLookup(procRoot) } = {}) {
  const seen = new Set();
  const queue = [Number(rootPid)];
  const out = [];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = readProcess(pid, procRoot);
    if (!proc) continue;
    out.push(proc);
    queue.push(...children(pid));
  }
  return out;
}

/** RSS, CPU and process names summed over a set of processes. */
export function sumProcesses(processes) {
  return {
    pids: processes.map((p) => p.pid),
    comms: [...new Set(processes.map((p) => p.comm))].sort(),
    rss_kb: processes.reduce((sum, p) => sum + p.rss_kb, 0),
    cpu_ms: processes.reduce((sum, p) => sum + p.cpu_ticks, 0) * (1000 / USER_HZ),
  };
}

/**
 * A cgroup v2 directory's processes and charged memory. `memory.current`
 * includes page cache, so it is kept beside the RSS sum rather than replacing
 * it: RSS stays comparable with workers that run outside a cgroup of their own.
 */
export function readCgroup(cgroupPath, { cgroupRoot = "/sys/fs/cgroup", procRoot = "/proc" } = {}) {
  const dir = path.join(cgroupRoot, cgroupPath);
  const current = readText(path.join(dir, "memory.current"));
  if (current === null) return null;
  const peak = readText(path.join(dir, "memory.peak"));
  const procs = (readText(path.join(dir, "cgroup.procs")) ?? "")
    .split(/\s+/).filter(Boolean).map(Number);
  const processes = procs.map((pid) => readProcess(pid, procRoot)).filter(Boolean);
  const cpuStat = readText(path.join(dir, "cpu.stat")) ?? "";
  const usage = /^usage_usec\s+(\d+)/m.exec(cpuStat);
  const summed = sumProcesses(processes);
  return {
    ...summed,
    cpu_ms: usage ? Math.round(Number(usage[1]) / 1000) : summed.cpu_ms,
    cgroup_kb: Math.round(Number(current.trim()) / 1024),
    cgroup_peak_kb: peak === null ? null : Math.round(Number(peak.trim()) / 1024),
  };
}
