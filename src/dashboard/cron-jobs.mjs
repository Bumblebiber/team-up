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

function modelValue(line) {
  if (/^\s*[#;]/.test(line)) return null;
  const match = line.match(/^\s*model\s*=\s*(\S*)/);
  return match ? match[1] : null;
}

export function parseCronJobs(text) {
  const jobs = [];
  let current = null;
  for (const { text: line } of splitLines(String(text ?? ""))) {
    const name = sectionName(line);
    if (name !== null) {
      current = { name, model: null };
      jobs.push(current);
    } else if (current && current.model === null) {
      const value = modelValue(line);
      if (value !== null) current.model = value;
    }
  }
  return jobs;
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
