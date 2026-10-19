import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DE, langOf, t } from "../../src/dashboard/i18n.mjs";
import { EXCLUDED, GROUPS, applySettingsEdit, buildSettingsView } from "../../src/dashboard/settings.mjs";
import { BUILTIN_JOBS, SERVICES, buildAutomationView } from "../../src/dashboard/automation.mjs";
import { TIM_SENDERS, listSenders } from "../../src/dashboard/communication.mjs";
import { describeSchedule } from "../../src/dashboard/cron-schedule.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

// ── Coverage: every English key has a German entry ───────────────────────
// index.html's static texts join this check with the front-end pass, which
// calls translateStatic(); today the page is not translated at all.

/** Server modules whose text goes through t(lang, "…"). */
const SERVER_SOURCES = [
  "src/dashboard/settings.mjs",
  "src/dashboard/automation.mjs",
  "src/dashboard/communication.mjs",
  "src/dashboard/cron-schedule.mjs",
];

/** Keys that are the same in every language (identifiers); none yet. */
const ALLOW = new Set([]);

const STRING = String.raw`(["'\`])((?:\\.|(?!\1)[^\\])*)\1`;
const strings = (source, prefix) =>
  [...source.matchAll(new RegExp(prefix + STRING, "g"))].map((m) => m[2].replace(/\\(.)/g, "$1"));

/**
 * The literal text keys in `source`: the first text argument of t("…") in
 * the browser and t(lang, "…") / t(opts.lang, "…") on the server, and the
 * forms of tp(n, { one: "…", other: "…" }). A template literal comes back
 * with its ${…} in it, which no dictionary holds, so the check below flags it.
 */
function literalKeys(source) {
  const forms = [...source.matchAll(/\btp\([^{;]*(\{[^;]*?\})\s*\)/g)].map((m) => m[1]);
  assert.equal(forms.length, (source.match(/\btp\(/g) || []).length, "tp(n, { one, other }) with the forms written out");
  return [
    ...strings(source, String.raw`\bt\(\s*(?:[\w.]+\s*,\s*)?`),
    ...forms.flatMap((f) => strings(f, String.raw`\b(?:one|other)\s*:\s*`)),
  ];
}

/** Text fields of the registry tables; views translate them with t(lang, row.field). */
const PROSE = new Set(["title", "intro", "what", "why", "notifies", "cost", "off", "label"]);
function tableTexts(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => tableTexts(v, out));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string" && PROSE.has(key)) out.push(v);
      else tableTexts(v, out);
    }
  }
  return out;
}

function untranslated(keys, dict) {
  return [...new Set(keys)].filter((k) => !Object.hasOwn(dict, k) && !ALLOW.has(k));
}

const placeholders = (text) => new Set(text.match(/\{\w+\}/g) || []);

/** The browser script, run against a stub page in `lang`; its globals. */
function clientI18n(lang) {
  const ctx = vm.createContext({ document: { documentElement: { lang } } });
  vm.runInContext(read("src/dashboard/public/i18n.js"), ctx);
  return vm.runInContext("({ LANG, I18N_DE, t, tp, fmtAgo, fmtDateTime })", ctx);
}

test("every t(lang, …) key in the server modules has a German entry, and no key is built from ${…}", () => {
  for (const file of SERVER_SOURCES) {
    const keys = literalKeys(read(file));
    assert.ok(keys.length, `${file}: no t(…) calls found — has the call shape changed?`);
    assert.deepEqual(keys.filter((k) => k.includes("${")), [], `${file}: whole sentences with {placeholders}`);
    assert.deepEqual(untranslated(keys, DE), [], `${file}: missing in DE`);
  }
});

test("every t(…) and tp(…) key in app.js has an entry in the browser dictionary", () => {
  const keys = literalKeys(read("src/dashboard/public/app.js"));
  assert.deepEqual(keys.filter((k) => k.includes("${")), [], "whole sentences with {placeholders}");
  assert.deepEqual(untranslated(keys, clientI18n("de").I18N_DE), []);
});

test("the key extraction sees every call shape the sources use", () => {
  const src = `t("A"); t(lang, 'B'); t(opts.lang, "C {n}", { n }); x.t(\`D\`); tp(items.length, { one: "{n} item", other: "{n} items" });`;
  assert.deepEqual(literalKeys(src), ["A", "B", "C {n}", "D", "{n} item", "{n} items"]);
  assert.throws(() => literalKeys("tp(n, forms)"), /forms written out/);
});

test("every text of the settings, jobs and senders tables has a German entry", () => {
  const texts = tableTexts([GROUPS, EXCLUDED, BUILTIN_JOBS, SERVICES, TIM_SENDERS]);
  assert.ok(texts.length > 50);
  assert.deepEqual(untranslated(texts, DE), []);
});

test("a German entry uses only the placeholders its English key provides", () => {
  for (const [en, de] of Object.entries(DE)) {
    const allowed = placeholders(en);
    for (const p of placeholders(de)) assert.ok(allowed.has(p), `${p} in DE of "${en}"`);
  }
});

test("browser dictionary: keys and placeholders in the same shape", () => {
  const { I18N_DE } = clientI18n("de");
  for (const [en, de] of Object.entries(I18N_DE)) {
    const allowed = placeholders(en);
    for (const p of placeholders(de)) assert.ok(allowed.has(p), `${p} in I18N_DE of "${en}"`);
  }
});

// ── t() ─────────────────────────────────────────────────────────────────

test("t fills {placeholders}, falls back to English, and drops a context suffix", () => {
  assert.equal(t("de", "daily at {time}", { time: "06:00" }), "täglich um 06:00");
  assert.equal(t("en", "daily at {time}", { time: "06:00" }), "daily at 06:00");
  assert.equal(t("de", "No such key {x} here", { x: 1 }), "No such key 1 here", "English when DE has no entry");
  assert.equal(t("fr", "daily at {time}", { time: "06:00" }), "daily at 06:00", "unknown language = English");
  assert.equal(t("en", "Open|verb"), "Open");
  assert.equal(t("en", "--for host|all), x"), "--for host|all), x", "a | inside the text is not a suffix");
  assert.equal(t("de", "{a} and {b}", { a: "{b}", b: "x" }), "{b} and x", "a value is not filled in again");
  assert.equal(t("de", "{missing} stays", {}), "{missing} stays");
  assert.equal(t("de", "constructor"), "constructor", "only own dictionary keys");
  assert.equal(langOf({ language: "de" }), "de");
  assert.equal(langOf({ language: "xx" }), "en");
  assert.equal(langOf(null), "en");
});

test("browser t, tp, fmtAgo and fmtDateTime follow <html lang>", () => {
  const de = clientI18n("de");
  const en = clientI18n("en");
  assert.equal(de.LANG, "de");
  assert.equal(clientI18n("fr").LANG, "en");
  assert.equal(de.t("Inbox"), "Posteingang");
  assert.equal(en.t("Inbox"), "Inbox");
  assert.equal(en.t("Open|verb"), "Open");
  assert.equal(de.t("Open|verb"), "Öffnen");
  assert.equal(de.t("Not translated {n}", { n: 2 }), "Not translated 2");
  const forms = { one: "{n} question", other: "{n} questions" };
  assert.equal(en.tp(1, forms), "1 question");
  assert.equal(en.tp(3, forms), "3 questions");
  assert.equal(en.fmtAgo(0), "now");
  assert.equal(en.fmtAgo(5 * 60e3), "5 minutes ago");
  assert.equal(en.fmtAgo(59.6e3), "59 seconds ago", "never 60 seconds");
  assert.equal(en.fmtAgo(23.6 * 36e5), "23 hours ago", "never 24 hours");
  assert.equal(de.fmtAgo(3 * 864e5), "vor 3 Tagen");
  assert.equal(de.fmtAgo(864e5), "gestern");
  assert.equal(de.fmtAgo(-2 * 36e5), "in 2 Stunden");
  assert.equal(de.fmtDateTime("not a date"), "—");
  assert.equal(de.fmtDateTime(new Date(2026, 9, 19, 14, 5).toISOString()), "19.10.26, 14:05");
});

test("i18n.js and app.js share one global scope without a clash", () => {
  // Classic scripts: a name both declare at top level stops app.js from running.
  assert.doesNotThrow(() => new vm.Script(`${read("src/dashboard/public/i18n.js")}\n;\n${read("src/dashboard/public/app.js")}`));
});

// ── The views in German ─────────────────────────────────────────────────

test("cron schedules read as whole German sentences", () => {
  assert.equal(describeSchedule("0 6 * * *", "de"), "täglich um 06:00");
  assert.equal(describeSchedule("0 3 15 * *", "de"), "am 15. jedes Monats um 03:00");
  assert.equal(describeSchedule("0 9 * * 1,3", "de"), "jeden Montag und Mittwoch um 09:00");
  assert.equal(describeSchedule("0 0 * * 0", "de"), "jeden Sonntag um 00:00");
  assert.equal(describeSchedule("*/10 * * * *", "de"), "alle 10 Minuten");
  assert.equal(describeSchedule("0 0,12 * * *", "de"), "täglich um 00:00 und 12:00");
  assert.equal(describeSchedule("0 3 1 * *"), "monthly on the 1st at 03:00");
  assert.equal(describeSchedule("0 9 * * 1,3"), "every Monday and Wednesday at 09:00");
});

test("settings: a General group first with the language row; the view and its errors follow the roster language", () => {
  const roster = { language: "de", accounts: { claude: { kind: "subscription", enabled: true } } };
  const view = buildSettingsView(roster);
  assert.equal(GROUPS[0].id, "general");
  assert.equal(view.groups[0].title, "Allgemein");
  const lang = view.fields.find((f) => f.path === "language");
  assert.equal(lang.group, "general");
  assert.deepEqual(lang.options, [{ value: "en", label: "English" }, { value: "de", label: "Deutsch" }], "endonyms");
  assert.equal(lang.value, "de");
  assert.equal(lang.default, "en");
  assert.equal(view.fields.find((f) => f.path === "accounts.claude.enabled").row, "claude (Abo)");
  assert.throws(() => applySettingsEdit(roster, { path: "limits.warn_at", value: 1.5 }), /höchstens 1/);
  assert.equal(applySettingsEdit({}, { path: "language", value: "de" }).language, "de");
  assert.throws(() => applySettingsEdit({}, { path: "language", value: "fr" }), /not one of the choices/);
  assert.equal(buildSettingsView({}).groups[0].title, "General");
});

test("scheduled jobs and message senders come in the roster language; ids stay", () => {
  const exec = () => "";
  const view = buildAutomationView({ exec, lang: "de" });
  const spender = view.builtin.find((j) => j.id === "usage-spender");
  assert.equal(spender.title, "Usage-Spender");
  assert.equal(spender.where, "Nicht in deiner Crontab");
  assert.equal(view.services.find((s) => s.unit === "team-up-dashboard.service").what, "Diese Seite.");
  assert.equal(buildAutomationView({ exec }).builtin[0].title, "Usage spender");
  const senders = listSenders({ exec, lang: "de" });
  assert.ok(senders.some((s) => s.title === "TIM-Backups"));
  assert.ok(senders.every((s) => ["team-up", "TIM", "Your jobs"].includes(s.group)), "group is the page's sort id");
});
