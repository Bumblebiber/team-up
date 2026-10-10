import path from "node:path";
import { teamUpHome } from "../paths.mjs";

export function cronJobsPath(env = process.env) {
  return path.join(teamUpHome(env), "cron-jobs.ini");
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\r" && text[i] !== "\n") continue;
    const ending = text[i] === "\r" && text[i + 1] === "\n" ? "\r\n" : text[i];
    lines.push({ text: text.slice(start, i), ending });
    i += ending.length - 1;
    start = i + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

function sectionName(line) {
  const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
  return match ? match[1].trim() : null;
}

function keyValue(line) {
  if (/^\s*[#;]/.test(line)) return null;
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/);
  return match ? [match[1].toLowerCase(), match[2]] : null;
}

/** Every section with its `key = value` pairs (first one wins, as in ops-run.sh). */
export function parseCronSections(text) {
  const sections = [];
  let current = null;
  for (const { text: line } of splitLines(String(text ?? ""))) {
    const name = sectionName(line);
    if (name !== null) {
      current = { name, values: {} };
      sections.push(current);
    } else if (current) {
      const kv = keyValue(line);
      if (kv && !Object.hasOwn(current.values, kv[0])) current.values[kv[0]] = kv[1];
    }
  }
  return sections;
}

export function parseCronJobs(text) {
  return parseCronSections(text).map(({ name, values }) => ({
    name,
    model: values.model ? values.model.split(/\s/)[0] : null,
  }));
}

/**
 * Replace section `name` with `[name]` + `lines`, append it when missing, or
 * remove it when `lines` is null. Comments and blank lines right before the
 * next header belong to that next section and stay where they are.
 */
export function replaceCronSection(text, name, lines) {
  const all = splitLines(String(text ?? ""));
  const start = all.findIndex((line) => sectionName(line.text) === name);
  const eol = all.find((l) => l.ending)?.ending || "\n";
  const fresh = lines === null ? [] : [`[${name}]`, ...lines].map((t) => ({ text: t, ending: eol }));
  if (start === -1) {
    if (!fresh.length) return String(text ?? "");
    if (all.length && !all.at(-1).ending) all.at(-1).ending = eol;
    const gap = all.length && all.at(-1).text.trim() ? [{ text: "", ending: eol }] : [];
    return [...all, ...gap, ...fresh].map((l) => `${l.text}${l.ending}`).join("");
  }
  let end = all.findIndex((line, i) => i > start && sectionName(line.text) !== null);
  if (end === -1) end = all.length;
  else while (end - 1 > start && (!all[end - 1].text.trim() || /^\s*[#;]/.test(all[end - 1].text))) end--;
  if (!fresh.length && start > 0 && !all[start - 1].text.trim()) {
    all.splice(start - 1, end - start + 1);
  } else {
    all.splice(start, end - start, ...fresh);
  }
  return all.map((l) => `${l.text}${l.ending}`).join("");
}

export function setCronJobModel(text, name, model) {
  const lines = splitLines(String(text ?? ""));
  const wanted = String(name);
  const first = lines.findIndex((line) => sectionName(line.text) === wanted);
  if (first === -1) throw new Error(`unknown cron job: ${wanted}`);
  const end = lines.findIndex((line, index) => index > first && sectionName(line.text) !== null);
  const stop = end === -1 ? lines.length : end;

  for (let i = first + 1; i < stop; i++) {
    const match = lines[i].text.match(/^(\s*model\s*=\s*)(\S*)(.*)$/);
    if (!match) continue;
    lines[i].text = `${match[1]}${model}${match[3]}`;
    return lines.map((line) => `${line.text}${line.ending}`).join("");
  }

  if (lines[first].ending) {
    lines.splice(first + 1, 0, { text: `model = ${model}`, ending: lines[first].ending });
  } else {
    lines[first].ending = "\n";
    lines.splice(first + 1, 0, { text: `model = ${model}`, ending: "" });
  }
  return lines.map((line) => `${line.text}${line.ending}`).join("");
}

export function cronModelOptions(roster) {
  const clis = roster?.clis || {};
  const options = new Set();
  for (const [id, spec] of Object.entries(roster?.models || {})) {
    if (!Array.isArray(spec?.cli)) continue;
    for (const cli of spec.cli) {
      if (typeof cli === "string" && Object.hasOwn(clis, cli) && Array.isArray(clis[cli]?.cmd)) {
        options.add(`${cli}:${id}`);
      }
    }
  }
  return [...options].sort();
}
