// Cron schedules: check one strictly, say it in plain words, find its next run.
//
// The check is also the injection guard. A schedule is written into the
// user's crontab, where a newline or a sixth field would add a command — so
// only the five standard fields of digits, `*`, `/`, `-` and `,` pass, or one
// of the named shortcuts. Step and range values are bounds-checked per field.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

export const SHORTCUTS = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const PART = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/;

/** The set of values one field matches, or throws naming the field. */
function expand(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(",")) {
    const m = part.match(PART);
    if (!m) throw new Error(`${name}: "${part}" is not a cron value`);
    let [lo, hi] = m[1] === "*" ? [min, max] : m[1].split("-").map(Number);
    if (hi === undefined) hi = m[2] ? max : lo;
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi) throw new Error(`${name}: ${part} is outside ${min}-${max}`);
    if (step < 1) throw new Error(`${name}: step must be at least 1`);
    for (let v = lo; v <= hi; v += step) values.add(name === "day of week" && v === 7 ? 0 : v);
  }
  return values;
}

/** `{ expr, fields }` for a valid schedule; throws with a readable reason otherwise. */
export function parseSchedule(input) {
  const raw = String(input ?? "").trim();
  if (/[\r\n]/.test(String(input ?? ""))) throw new Error("schedule must be one line");
  const expr = SHORTCUTS[raw] ?? raw;
  const parts = expr.split(/[ \t]+/);
  if (parts.length !== 5) throw new Error("schedule needs exactly 5 fields: minute hour day month weekday");
  return {
    expr: raw,
    parts,
    fields: parts.map((p, i) => expand(p, FIELDS[i])),
  };
}

export function isValidSchedule(input) {
  try {
    parseSchedule(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * The next minute the schedule fires after `from`, in the server's local time
 * (cron's own clock), or null within a year. Standard cron semantics: when
 * both day fields are restricted, either one matching is enough.
 * ponytail: minute-by-minute scan, ≤ 527k steps for a once-a-year schedule.
 */
export function nextRun(input, from = new Date()) {
  const { parts, fields: [min, hour, dom, mon, dow] } = parseSchedule(input);
  const domStar = parts[2] === "*";
  const dowStar = parts[4] === "*";
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = domStar && dowStar ? true
      : domStar ? dow.has(t.getDay())
        : dowStar ? dom.has(t.getDate())
          : dom.has(t.getDate()) || dow.has(t.getDay());
    if (mon.has(t.getMonth() + 1) && dayOk && hour.has(t.getHours()) && min.has(t.getMinutes())) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n) => {
  if (n >= 11 && n <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
};
const single = (p) => /^\d+$/.test(p);
const everyN = (p) => p.match(/^\*\/(\d+)$/)?.[1];

/** Plain words for the common shapes; anything else is shown as cron text. */
export function describeSchedule(input) {
  let parsed;
  try {
    parsed = parseSchedule(input);
  } catch (e) {
    return `invalid: ${e.message}`;
  }
  const [m, h, dom, mon, dow] = parsed.parts;
  const time = single(m) && single(h) ? `${pad(h)}:${pad(m)}` : null;
  if (mon === "*") {
    if (dom === "*" && dow === "*") {
      if (m === "*" && h === "*") return "every minute";
      if (everyN(m) && h === "*") return `every ${everyN(m)} minutes`;
      if (single(m) && h === "*") return `every hour at :${pad(m)}`;
      if (single(m) && everyN(h)) return `every ${everyN(h)} hours at :${pad(m)}`;
      if (time) return `daily at ${time}`;
      if (single(m) && /^\d+(,\d+)+$/.test(h)) return `daily at ${h.split(",").map((x) => `${pad(x)}:${pad(m)}`).join(", ")}`;
    }
    if (time && dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
      return `every ${dow.split(",").map((d) => DAYS[Number(d) % 7]).join(", ")} at ${time}`;
    }
    if (time && dom === "*" && dow === "1-5") return `weekdays at ${time}`;
    if (time && single(dom) && dow === "*") return `monthly on the ${ordinal(Number(dom))} at ${time}`;
  }
  return `cron "${parsed.expr}"`;
}
