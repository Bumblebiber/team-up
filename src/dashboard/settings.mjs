// Every roster setting the dashboard edits, as data. One row is the whole
// contract for one knob: where it lives in roster.json, what it means in plain
// words, its unit and default, how a value is checked, and when a change takes
// effect. The browser renders the list as it comes, so adding a knob here is
// all it takes to make it editable.
//
// `clis.*.cmd` and friends are deliberately absent — see EXCLUDED.

import { PLAN_TIERS } from "../roster/config.mjs";
import { limits as limitDefaults } from "../roster/chain.mjs";
import { DEFAULT_ADMISSION } from "../admission/admission.mjs";
import { DEFAULT_CONFIG as WATCHER } from "../usage/usage-watcher.mjs";
import { DEFAULT_RETENTION_DAYS } from "../telemetry/store.mjs";
import { DEFAULT_THRESHOLDS } from "../telemetry/restart.mjs";

// Defaults of scripts/usage-spender.py; keep in sync with the constants there.
export const SPENDER_DEFAULTS = Object.freeze({
  subscriptions: ["claude", "codex", "cursor"],
  spawn_hours: [23, 0, 1, 2],
  implement: true,
  implement_model: { claude: "claude:claude-sonnet" },
  max_run_h: 4,
  task_cost: 0.3,
});

const EFFECT = {
  pick: "Next pick or dispatch.",
  watcher: "Within a minute (the usage watcher re-reads the roster every tick).",
  spender: "Next usage-spender tick (every 10 minutes).",
  gc: "Next cleanup sweep (`runs gc`, every 5 minutes).",
  telemetry: "Next telemetry sample.",
  info: "Information for the usage-spender only.",
};

export const GROUPS = [
  {
    id: "accounts",
    title: "Accounts",
    intro: "Every model belongs to an account. Switch one off and all its models drop out of every role chain until you switch it back on. The plan only tells the usage-spender how much spare work a night can buy; a credit account at 0 is blocked.",
  },
  {
    id: "limits",
    title: "Usage limits",
    intro: "What a running agent does as a subscription window fills up. Shares are of the window, e.g. 90 % of the weekly limit.",
  },
  {
    id: "workers",
    title: "Workers & machine",
    intro: "How many agents may run at once on this server, and when idle ones are cleaned up.",
  },
  {
    id: "usage",
    title: "Usage collection",
    intro: "Which subscriptions team-up watches and how often it reads their limits. The Usage panel on the overview shows what it collected.",
  },
  {
    id: "spender",
    title: "Usage spender",
    intro: "At night, spare subscription quota is spent on PR reviews, audits and small fixes in your repos — paced so a weekly window is used up by its reset, never more. One task at a time.",
  },
  {
    id: "telemetry",
    title: "Telemetry",
    intro: "Memory and pressure samples every 30 seconds. They size the worker limit on auto and judge whether team-up caused a restart.",
    advanced: true,
  },
];

/** Settings that exist but are not editable from a browser, and why. */
export const EXCLUDED = [
  {
    what: "CLI command templates (clis.*.cmd, clis.*.headless_cmd)",
    why: "Whoever can edit them can run any command on this server. Edit ~/.team-up/roster.json by hand.",
  },
  {
    what: "OpenRouter key file (openrouter.key_file)",
    why: "Pointing it at another file from the browser would read that file. Set the key under Providers.",
  },
  {
    what: "Per-model wiring (cli_model, reasoning, efforts, limit_windows)",
    why: "Written by the model scan when a model is added under Roles & Models → Roster. Hand edits go in roster.json.",
  },
  {
    what: "Adding or removing accounts",
    why: "An account is created with the first model that needs it. Edit roster.json for anything else.",
  },
];

const own = (obj, key) => !!obj && typeof obj === "object" && Object.hasOwn(obj, key);

export function getPath(obj, dotted) {
  let node = obj;
  for (const key of dotted.split(".")) {
    if (!own(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Why `value` does not fit `field`, or null. */
export function checkValue(field, value) {
  if (value === null) return field.nullable ? null : "a value is required";
  switch (field.type) {
    case "bool":
      return typeof value === "boolean" ? null : "must be on or off";
    case "int":
    case "number":
    case "ratio": {
      if (!isNum(value)) return "must be a number";
      if (field.type === "int" && !Number.isInteger(value)) return "must be a whole number";
      const min = field.type === "ratio" ? 0 : field.min;
      const max = field.type === "ratio" ? 1 : field.max;
      if (field.type === "ratio" && value <= 0) return "must be above 0 %";
      if (min != null && value < min) return `must be at least ${min}`;
      if (max != null && value > max) return `must be at most ${max}`;
      return null;
    }
    case "enum":
      return field.options.some((o) => o.value === value) ? null : "is not one of the choices";
    case "set": {
      if (!Array.isArray(value)) return "must be a list";
      if (new Set(value).size !== value.length) return "lists a choice twice";
      if (!value.every((v) => field.options.some((o) => o.value === v))) return "lists an unknown choice";
      if (field.minItems && value.length < field.minItems) return `needs at least ${field.minItems}`;
      return null;
    }
    default:
      return "has an unknown type";
  }
}

const opts = (values, label = String) => values.map((v) => ({ value: v, label: label(v) }));

/**
 * The fields for one roster, each with its current `value` (undefined: not set,
 * the default applies). Rows that depend on the roster — accounts, CLIs,
 * models — are built from it.
 */
export function settingsFields(roster = {}) {
  const fields = [];
  const add = (field) => fields.push({ ...field, value: getPath(roster, field.path) });
  const clis = Object.keys(roster.clis || {}).sort();
  const watched = Array.isArray(roster.subscriptions) && roster.subscriptions.length
    ? roster.subscriptions
    : ["claude", "codex", "cursor"];

  for (const [id, account] of Object.entries(roster.accounts || {})) {
    const row = `${id} (${account?.kind === "credit" ? "credit" : "subscription"})`;
    add({
      group: "accounts", row, path: `accounts.${id}.enabled`, type: "bool", label: "Enabled",
      help: account?.$comment || "",
      default: true, effect: EFFECT.pick, required: true,
    });
    if (account?.kind === "credit") {
      add({
        group: "accounts", row, path: `accounts.${id}.remaining`, type: "number", label: "Credit left",
        help: "", min: -1e9, effect: EFFECT.pick,
      });
    } else if (PLAN_TIERS[id]) {
      add({
        group: "accounts", row, path: `accounts.${id}.plan`, type: "enum", label: "Plan",
        help: "",
        options: opts(PLAN_TIERS[id]), nullable: true, nullLabel: "not set", effect: EFFECT.info,
      });
    }
  }

  const lim = limitDefaults({});
  add({
    group: "limits", path: "limits.warn_at", type: "ratio", label: "Wrap-up warning at",
    help: "At this share of a usage window a running agent is told to finish what it is doing.",
    default: lim.warn_at, effect: EFFECT.pick,
  });
  add({
    group: "limits", path: "limits.handoff_at", type: "ratio", label: "Hand off at",
    help: "At this share the agent hands off and stops; the next model in its role chain takes over.",
    default: lim.handoff_at, effect: EFFECT.pick,
  });
  add({
    group: "limits", path: "limits.handoff_at_burst", type: "ratio", label: "Hand off at (5-hour windows)",
    help: "The same for short windows (5 hours, sessions). They refill fast, so stopping earlier costs little.",
    default: lim.handoff_at_burst, effect: EFFECT.pick,
  });
  add({
    group: "limits", path: "limits.project_min", type: "int", label: "Look-ahead", unit: "min",
    help: "Routing projects a short window's burn rate this far ahead and skips a model that would run out. 0 turns the projection off.",
    min: 0, max: 1440, default: lim.project_min, effect: EFFECT.pick, advanced: true,
  });
  add({
    group: "limits", path: "limits.usage_max_age_min", type: "int", label: "Hand-off needs a reading younger than", unit: "min",
    help: "A hand-off that blocks a model only trusts a usage reading this fresh.",
    min: 1, max: 1440, default: lim.usage_max_age_min, effect: EFFECT.pick, advanced: true,
  });

  add({
    group: "workers", path: "admission.max_workers", type: "int", label: "Max. parallel workers",
    help: "Hard cap on workers running at once. On auto, it is derived from memory telemetry.",
    min: 1, max: 64, nullable: true, nullLabel: "auto", default: DEFAULT_ADMISSION.max_workers, effect: EFFECT.pick,
  });
  add({
    group: "workers", path: "admission.fallback_max_workers", type: "int", label: "Cap while telemetry is thin",
    help: "Used on auto until enough worker samples exist to trust the derived cap.",
    min: 1, max: 64, default: DEFAULT_ADMISSION.fallback_max_workers, effect: EFFECT.pick,
  });
  add({
    group: "workers", path: "limits.idle_session_hours", type: "number", label: "Stop idle worker sessions after", unit: "h",
    help: "A worker's terminal session that has been idle this long is closed.",
    min: 0.25, max: 168, default: 2, effect: EFFECT.gc,
  });
  add({
    group: "workers", path: "admission.reserve_mb", type: "int", label: "Memory to keep free", unit: "MB",
    help: "A new worker only starts if at least this much memory stays available after it.",
    min: 1, max: 1e6, default: DEFAULT_ADMISSION.reserve_mb, effect: EFFECT.pick, advanced: true,
  });
  add({
    group: "workers", path: "admission.psi_some_max", type: "number", label: "Refuse above memory pressure (some)", unit: "%",
    help: "No new worker while PSI memory 'some' (10 s average) is above this.",
    min: 0.1, max: 100, default: DEFAULT_ADMISSION.psi_some_max, effect: EFFECT.pick, advanced: true,
  });
  add({
    group: "workers", path: "admission.psi_full_max", type: "number", label: "Refuse above memory pressure (full)", unit: "%",
    help: "No new worker while PSI memory 'full' (10 s average) is above this.",
    min: 0.1, max: 100, default: DEFAULT_ADMISSION.psi_full_max, effect: EFFECT.pick, advanced: true,
  });
  add({
    group: "workers", path: "admission.min_samples", type: "int", label: "Samples before telemetry is trusted",
    help: "Worker memory samples needed before auto derives the cap from them.",
    min: 1, max: 100000, default: DEFAULT_ADMISSION.min_samples, effect: EFFECT.pick, advanced: true,
  });

  add({
    group: "usage", path: "subscriptions", type: "set", label: "Watched subscriptions",
    help: "CLIs whose usage windows are read and shown. An unwatched CLI still runs; its limits just go unchecked.",
    options: opts(clis), minItems: 1, default: ["claude", "codex", "cursor"], effect: EFFECT.watcher,
  });
  for (const [key, label] of [["idle_min", "when nothing runs"], ["active_min", "while one agent runs"], ["busy_min", "while several run"]]) {
    add({
      group: "usage", path: `usage_watcher.intervals.${key}`, type: "int", label: `Read limits every … ${label}`, unit: "min",
      help: "How often each watched subscription's limits are read. Per-CLI overrides below win.",
      min: 1, max: 1440, default: WATCHER.intervals[key], effect: EFFECT.watcher,
    });
  }
  for (const cli of watched) {
    for (const [key, label] of [["idle_min", "idle"], ["active_min", "active"], ["busy_min", "busy"]]) {
      add({
        group: "usage", row: `${cli} override`, path: `usage_watcher.cli_intervals.${cli}.${key}`, type: "int",
        label, unit: "min", help: `Overrides the general pace for ${cli} (reading codex and cursor is slow).`,
        min: 1, max: 1440, default: WATCHER.cli_intervals[cli]?.[key] ?? WATCHER.intervals[key],
        effect: EFFECT.watcher, advanced: true,
      });
    }
  }
  add({
    group: "usage", path: "usage_watcher.tick_sec", type: "int", label: "Watcher wakes every", unit: "s",
    help: "How often the watcher checks which CLIs are running and which reading is due.",
    min: 10, max: 3600, default: WATCHER.tick_sec, effect: EFFECT.watcher, advanced: true,
  });
  add({
    group: "usage", path: "usage_watcher.dispatch_freshness_sec", type: "int", label: "Dispatch wants a reading younger than", unit: "s",
    help: "An older reading is refreshed before a worker starts.",
    min: 30, max: 86400, default: 300, effect: EFFECT.pick, advanced: true,
  });

  add({
    group: "spender", path: "usage_spender.subscriptions", type: "set", label: "Spend the quota of",
    help: "Subscriptions whose spare quota may be spent. Untick all to switch the spender off.",
    options: opts(watched), default: SPENDER_DEFAULTS.subscriptions, effect: EFFECT.spender,
  });
  add({
    group: "spender", path: "usage_spender.spawn_hours", type: "set", label: "Start new tasks during",
    help: "Local hours in which a new task may start. Results are collected at any hour.",
    options: opts([...Array(24).keys()], (h) => `${String(h).padStart(2, "0")}:00`), minItems: 1,
    default: SPENDER_DEFAULTS.spawn_hours, effect: EFFECT.spender,
  });
  add({
    group: "spender", path: "usage_spender.implement", type: "bool", label: "Implement fixes",
    help: "On: TIM tasks and GitHub issues are implemented in a throwaway clone and opened as pull requests. Off: reviews and triage only.",
    default: SPENDER_DEFAULTS.implement, effect: EFFECT.spender,
  });
  for (const cli of watched) {
    const models = Object.entries(roster.models || {})
      .filter(([, spec]) => Array.isArray(spec?.cli) && spec.cli.includes(cli))
      .map(([id]) => `${cli}:${id}`)
      .sort();
    if (!models.length) continue;
    add({
      group: "spender", path: `usage_spender.implement_model.${cli}`, type: "enum", label: `Implementing model on ${cli}`,
      help: "Overrides the implementer role chain for spender runs only — spare quota can afford a stronger model.",
      // "" = no override: the spender asks the implementer role chain.
      options: [{ value: "", label: "implementer role chain" }, ...opts(models)],
      default: SPENDER_DEFAULTS.implement_model[cli] ?? "", effect: EFFECT.spender, advanced: true,
    });
  }
  add({
    group: "spender", path: "usage_spender.max_run_h", type: "number", label: "Cancel a task after", unit: "h",
    help: "A spender task still running after this long is cancelled so it cannot block the queue.",
    min: 0.5, max: 48, default: SPENDER_DEFAULTS.max_run_h, effect: EFFECT.spender, advanced: true,
  });
  add({
    group: "spender", path: "usage_spender.task_cost", type: "ratio", label: "One task burns about",
    help: "Share of a weekly window one task uses on the smallest paid plan. Raise it if the spender overshoots, lower it if quota is left over.",
    default: SPENDER_DEFAULTS.task_cost, effect: EFFECT.spender, advanced: true,
  });

  add({
    group: "telemetry", path: "telemetry.retention_days", type: "int", label: "Keep samples for", unit: "days",
    min: 1, max: 365, default: DEFAULT_RETENTION_DAYS, effect: EFFECT.telemetry,
  });
  add({
    group: "telemetry", path: "telemetry.verdict.mem_available_ratio", type: "ratio", label: "Restart verdict: free memory below",
    help: "A restart counts as memory-caused when free memory fell below this share.",
    default: DEFAULT_THRESHOLDS.mem_available_ratio, effect: EFFECT.telemetry,
  });
  add({
    group: "telemetry", path: "telemetry.verdict.psi_full_avg10", type: "number", label: "Restart verdict: pressure (full) above", unit: "%",
    min: 0, max: 100, default: DEFAULT_THRESHOLDS.psi_full_avg10, effect: EFFECT.telemetry,
  });
  add({
    group: "telemetry", path: "telemetry.verdict.team_up_share", type: "ratio", label: "Restart verdict: team-up's share at least",
    help: "…and team-up held at least this share of used memory, it is blamed.",
    default: DEFAULT_THRESHOLDS.team_up_share, effect: EFFECT.telemetry,
  });

  return fields;
}

export function buildSettingsView(roster) {
  return { groups: GROUPS, fields: settingsFields(roster), excluded: EXCLUDED };
}

/**
 * One edit per call: `{ path, value }` sets a field, `{ path, reset: true }`
 * removes the key so the default applies again. Only paths settingsFields
 * lists are reachable; the roster is never mutated in place.
 */
export function applySettingsEdit(roster, { path: dotted, value, reset } = {}) {
  const field = settingsFields(roster).find((f) => f.path === dotted);
  if (!field) throw new Error(`not editable here: ${dotted}`);
  // Every nullable field defaults to null (auto, not set): null is the default.
  if (value === null && field.nullable) reset = true;
  const next = structuredClone(roster);
  const keys = dotted.split(".");
  if (reset) {
    if (field.required) throw new Error(`${dotted} has no default to go back to`);
    const parents = [next];
    for (const key of keys.slice(0, -1)) {
      const node = parents.at(-1);
      if (!own(node, key)) return next;
      parents.push(node[key]);
    }
    delete parents.at(-1)[keys.at(-1)];
    // Drop objects the reset left empty, so `usage_spender: {}` does not linger.
    for (let i = keys.length - 1; i > 0; i--) {
      if (Object.keys(parents[i]).length) break;
      delete parents[i - 1][keys[i - 1]];
    }
    return next;
  }
  const problem = checkValue(field, value);
  if (problem) throw new Error(`invalid value for ${dotted}: ${field.label} ${problem}`);
  let node = next;
  for (const key of keys.slice(0, -1)) {
    if (!own(node, key) || typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
  return next;
}
