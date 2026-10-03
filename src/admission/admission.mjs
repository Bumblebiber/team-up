import fs from "node:fs";
import path from "node:path";
import { configPath, loadJson } from "../roster/config.mjs";
import { atomicWriteJson } from "../json-store.mjs";
import { teamUpHome, telemetryDir } from "../paths.mjs";
import { workerFootprint } from "../telemetry/stats.mjs";
import { readSamples } from "../telemetry/store.mjs";

/**
 * The `admission` block of roster.json:
 *
 *   "admission": {
 *     "max_workers": null,          // null: derived from telemetry
 *     "fallback_max_workers": 2,    // too little telemetry to derive one
 *     "reserve_mb": 1024,           // MemAvailable left after a start
 *     "psi_some_max": 10,
 *     "psi_full_max": 2,
 *     "min_samples": 20,            // worker samples needed to trust a p95
 *     "memory_ceiling": { "enabled": false, "high_factor": 1.5, "max_factor": 2 }
 *   }
 */
export const DEFAULT_ADMISSION = Object.freeze({
  max_workers: null,
  fallback_max_workers: 2,
  reserve_mb: 1024,
  psi_some_max: 10,
  psi_full_max: 2,
  min_samples: 20,
  memory_ceiling: Object.freeze({ enabled: false, high_factor: 1.5, max_factor: 2 }),
});

/**
 * How to leave the fallback limit. It rides along in every fallback reason, so
 * `admission check`, each ADMISSION_REFUSED line and `doctor` all say it: the
 * fallback used to cap every dispatch at 2 with nothing naming the cause.
 */
export const FALLBACK_REMEDY =
  "set admission.max_workers in roster.json, or let telemetry derive it (team-up telemetry install-timer)";

const CAP_TTL_MS = 24 * 60 * 60 * 1000;
const SWAP_NOISE_KB = 1024;
const RECENT_WINDOW_MS = 5 * 60 * 1000;
// Share of MemTotal team-up may plan with; the rest is the machine's.
const PLANNABLE_SHARE = 0.7;

function positiveNumber(value, key, { integer = false, allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  const ok = typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value));
  if (!ok) throw new Error(`ADMISSION_CONFIG: admission.${key} must be a positive ${integer ? "integer" : "number"}`);
  return value;
}

/** A wrong value is an error: a limit that quietly fell back admits what nobody configured. */
export function admissionConfig(env = process.env, { roster } = {}) {
  const doc = roster === undefined ? loadJson(configPath(env)) : roster;
  const raw = doc?.admission ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("ADMISSION_CONFIG: admission must be an object");
  const out = { ...DEFAULT_ADMISSION, memory_ceiling: { ...DEFAULT_ADMISSION.memory_ceiling } };
  for (const [key, value] of Object.entries(raw)) {
    // The roster's comment convention, as in clis.* and openrouter.
    if (key === "$comment") continue;
    if (!(key in DEFAULT_ADMISSION)) throw new Error(`ADMISSION_CONFIG: unknown admission.${key}`);
    if (key === "memory_ceiling") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("ADMISSION_CONFIG: admission.memory_ceiling must be an object");
      }
      for (const [k, v] of Object.entries(value)) {
        if (!(k in DEFAULT_ADMISSION.memory_ceiling)) throw new Error(`ADMISSION_CONFIG: unknown admission.memory_ceiling.${k}`);
        if (k === "enabled") {
          if (typeof v !== "boolean") throw new Error("ADMISSION_CONFIG: admission.memory_ceiling.enabled must be a boolean");
          out.memory_ceiling.enabled = v;
        } else {
          out.memory_ceiling[k] = positiveNumber(v, `memory_ceiling.${k}`);
        }
      }
      continue;
    }
    const integer = ["max_workers", "fallback_max_workers", "min_samples"].includes(key);
    out[key] = positiveNumber(value, key, { integer, allowNull: key === "max_workers" });
  }
  if (out.memory_ceiling.max_factor < out.memory_ceiling.high_factor) {
    throw new Error("ADMISSION_CONFIG: admission.memory_ceiling.max_factor must not be below high_factor");
  }
  return out;
}

/** p95 RSS of one worker of `cli`, from that cli's samples, else from all. */
export function footprintFor(footprint, cli, { minSamples = DEFAULT_ADMISSION.min_samples } = {}) {
  const own = cli ? footprint?.by_cli?.[cli] : null;
  if (own?.p95_rss_kb && own.samples >= minSamples) return { p95_rss_kb: own.p95_rss_kb, samples: own.samples, source: `cli ${cli}` };
  const all = footprint?.all;
  if (all?.p95_rss_kb && all.samples >= minSamples) return { p95_rss_kb: all.p95_rss_kb, samples: all.samples, source: "all workers" };
  return { p95_rss_kb: null, samples: own?.samples ?? all?.samples ?? 0, source: null };
}

/**
 * How many workers this machine holds: what is left of 70 % of MemTotal after
 * the idle baseline, in p95-sized workers. Config wins; without enough
 * telemetry the conservative fallback applies and the reason says so.
 */
export function deriveLimits({ footprint, cli = null, memTotalKb = null, config = DEFAULT_ADMISSION, cap = null }) {
  const size = footprintFor(footprint, cli, { minSamples: config.min_samples });
  const base = {
    reserve_kb: config.reserve_mb * 1024,
    psi_some_max: config.psi_some_max,
    psi_full_max: config.psi_full_max,
    p95_rss_kb: size.p95_rss_kb,
    footprint_source: size.source,
  };
  let limits;
  if (config.max_workers != null) {
    limits = { ...base, max_workers: config.max_workers, source: "config", reason: "admission.max_workers" };
  } else if (!size.p95_rss_kb) {
    limits = {
      ...base,
      max_workers: config.fallback_max_workers,
      source: "fallback",
      reason: `fewer than ${config.min_samples} worker samples; fallback limit ${config.fallback_max_workers} — ${FALLBACK_REMEDY}`,
    };
  } else if (footprint?.baseline_used_kb == null || !memTotalKb) {
    limits = {
      ...base,
      max_workers: config.fallback_max_workers,
      source: "fallback",
      reason: `no idle baseline in telemetry; fallback limit ${config.fallback_max_workers} — ${FALLBACK_REMEDY}`,
    };
  } else {
    const room = memTotalKb * PLANNABLE_SHARE - footprint.baseline_used_kb;
    const derived = Math.max(1, Math.floor(room / size.p95_rss_kb));
    limits = {
      ...base,
      max_workers: derived,
      source: "telemetry",
      reason: `(${Math.round(memTotalKb * PLANNABLE_SHARE / 1024)} MB - ${Math.round(footprint.baseline_used_kb / 1024)} MB idle) / ${Math.round(size.p95_rss_kb / 1024)} MB p95 (${size.source})`,
    };
  }
  if (cap?.max_workers != null && cap.max_workers < limits.max_workers) {
    limits = { ...limits, max_workers: cap.max_workers, source: "restart_cap", reason: `capped at ${cap.max_workers} after a ${cap.verdict} restart (team-up admission reset lifts it)` };
  }
  return limits;
}

function swapUsed(sample) {
  const m = sample?.mem;
  return m && Number.isFinite(m.SwapTotal) && Number.isFinite(m.SwapFree) ? m.SwapTotal - m.SwapFree : null;
}

/** Swap use grew at every step of the last three samples: the machine is paging out. */
export function swapRising(samples) {
  const used = samples.slice(-3).map(swapUsed);
  if (used.length < 3 || used.some((v) => v == null)) return null;
  return used[1] > used[0] && used[2] > used[1] && used[2] - used[0] >= SWAP_NOISE_KB;
}

const mb = (kb) => `${Math.round(kb / 1024)} MB`;

/**
 * Whether one more worker may start now. Pure: `sample` is a live reading,
 * `recent` the readings before it (oldest first), `footprint.p95_rss_kb` the
 * size of the worker about to start.
 */
export function admit({ sample, footprint = {}, limits, running = { workers: 0 }, recent = [] }) {
  const notes = [];
  const p95 = footprint.p95_rss_kb ?? limits.p95_rss_kb ?? 0;
  const mem = sample?.mem;
  const headroom = {
    workers: limits.max_workers - running.workers,
    mem_kb: mem ? mem.MemAvailable - p95 - limits.reserve_kb : null,
  };
  const refuse = (reason) => ({ ok: false, reason, headroom, notes });
  if (running.workers >= limits.max_workers) {
    return refuse(`${running.workers} workers running, limit ${limits.max_workers} (${limits.reason})`);
  }
  if (!mem) return refuse("meminfo unreadable");
  if (mem.MemAvailable - p95 < limits.reserve_kb) {
    return refuse(`MemAvailable ${mb(mem.MemAvailable)} - ${mb(p95)} for the worker < reserve ${mb(limits.reserve_kb)}`);
  }
  if (!p95) notes.push("worker size unknown: memory check covers the reserve only");
  const psi = sample.psi?.memory;
  if (!psi) {
    notes.push("PSI unavailable: pressure not checked");
  } else {
    if (psi.some.avg10 >= limits.psi_some_max) {
      return refuse(`memory pressure some avg10 ${psi.some.avg10} >= ${limits.psi_some_max}`);
    }
    if (psi.full && psi.full.avg10 >= limits.psi_full_max) {
      return refuse(`memory pressure full avg10 ${psi.full.avg10} >= ${limits.psi_full_max}`);
    }
  }
  const rising = swapRising([...recent, sample]);
  if (rising === null) notes.push("fewer than three samples: swap trend not checked");
  else if (rising) {
    const series = [...recent, sample].slice(-3).map((s) => mb(swapUsed(s))).join(" → ");
    return refuse(`swap use rising: ${series}`);
  }
  return { ok: true, reason: null, headroom, notes };
}

// --- the cap a team_up_suspected restart leaves behind ---------------------

export function admissionStatePath(env = process.env) {
  return path.join(teamUpHome(env), "admission.json");
}

function readAdmissionState(env) {
  try {
    return JSON.parse(fs.readFileSync(admissionStatePath(env), "utf8"));
  } catch {
    return null;
  }
}

/** The restart cap still in force, or null: lifted, or 24 h without a refusal. */
export function currentCap({ env = process.env, now = new Date() } = {}) {
  const st = readAdmissionState(env);
  if (!st?.cap) return null;
  const last = Math.max(Date.parse(st.cap.set_at) || 0, Date.parse(st.cap.last_refusal_at ?? "") || 0);
  if (now.getTime() - last >= CAP_TTL_MS) return null;
  return st.cap;
}

export function setCap({ maxWorkers, verdict, env = process.env, now = new Date(), restartId = null }) {
  const cap = { max_workers: maxWorkers, verdict, set_at: now.toISOString(), last_refusal_at: null };
  const prev = readAdmissionState(env) ?? {};
  atomicWriteJson(admissionStatePath(env), { ...prev, cap, applied_restart: restartId ?? prev.applied_restart ?? null });
  return cap;
}

/**
 * Cap launches after a team_up_suspected restart, once per restart: a second
 * `runs resume` in the same boot must not undo `admission reset` or restart
 * the 24 hours.
 */
export function applyRestartCap({ maxWorkers, verdict, restartId, env = process.env, now = new Date() }) {
  if (restartId && readAdmissionState(env)?.applied_restart === restartId) return null;
  return setCap({ maxWorkers, verdict, env, now, restartId });
}

/** A refusal while capped keeps the cap alive for another 24 h. */
export function recordRefusal({ env = process.env, now = new Date() } = {}) {
  const cap = currentCap({ env, now });
  if (!cap) return null;
  const next = { ...cap, last_refusal_at: now.toISOString() };
  atomicWriteJson(admissionStatePath(env), { ...readAdmissionState(env), cap: next });
  return next;
}

/** Lift the cap. Which restart set it is kept, so the same one cannot set it again. */
export function resetCap({ env = process.env } = {}) {
  const prev = readAdmissionState(env);
  if (!prev?.cap) return false;
  atomicWriteJson(admissionStatePath(env), { ...prev, cap: null });
  return true;
}

// --- the impure check every start goes through ------------------------------

async function liveSample() {
  const { takeSample } = await import("../telemetry/sample.mjs");
  return takeSample();
}

/**
 * Take a fresh sample and decide. Used by launch, the resume scheduler and
 * due resource waits alike, so every start answers to the same rules.
 */
export async function checkAdmission({
  cli = null,
  env = process.env,
  now = new Date(),
  sample: provided = null,
  takeSample = liveSample,
  config = null,
  footprint = null,
  running = null,
} = {}) {
  const cfg = config ?? admissionConfig(env);
  const dir = telemetryDir(env);
  const fp = footprint ?? workerFootprint({ dir, now });
  const sample = provided ?? await takeSample();
  const recent = readSamples({ dir, since: new Date(now.getTime() - RECENT_WINDOW_MS).toISOString() })
    .filter((s) => s.at < sample.at)
    .slice(-2);
  const limits = deriveLimits({ footprint: fp, cli, memTotalKb: sample.mem?.MemTotal, config: cfg, cap: currentCap({ env, now }) });
  const decision = admit({
    sample,
    footprint: footprintFor(fp, cli, { minSamples: cfg.min_samples }),
    limits,
    running: running ?? { workers: sample.workers?.length ?? 0 },
    recent,
  });
  if (!decision.ok) recordRefusal({ env, now });
  return { ...decision, limits, sample_at: sample.at };
}

/**
 * Whether the user's systemd manager may set memory limits: the memory
 * controller must be delegated to user@UID.service. null when unreadable.
 */
export function memoryDelegation({ cgroupRoot = "/sys/fs/cgroup", uid = process.getuid?.() } = {}) {
  const file = path.join(cgroupRoot, "user.slice", `user-${uid}.slice`, `user@${uid}.service`, "cgroup.controllers");
  try {
    const controllers = fs.readFileSync(file, "utf8").trim().split(/\s+/);
    return { delegated: controllers.includes("memory"), path: file, controllers };
  } catch {
    return { delegated: null, path: file, controllers: null };
  }
}

/**
 * MemoryHigh/MemoryMax for one worker of `cli`, or null when ceilings are off
 * or no footprint is known to scale them from.
 */
export function memoryCeiling({ footprint, cli, config = DEFAULT_ADMISSION }) {
  if (!config.memory_ceiling.enabled) return null;
  const size = footprintFor(footprint, cli, { minSamples: config.min_samples });
  if (!size.p95_rss_kb) return null;
  return {
    high_kb: Math.round(size.p95_rss_kb * config.memory_ceiling.high_factor),
    max_kb: Math.round(size.p95_rss_kb * config.memory_ceiling.max_factor),
    source: size.source,
  };
}
