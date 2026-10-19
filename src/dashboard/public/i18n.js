// UI text in the human's language. A classic script loaded before app.js, so
// everything here is a global there. The server writes roster.json "language"
// into <html lang>; English is the key and the fallback. Whole sentences only:
// never glue translated fragments together or change their case. A key may
// carry a context suffix ("Open|verb") when one English word needs two
// translations; English drops a trailing "|word".
//
// The server's own text (settings, scheduled jobs, …) comes translated
// already: src/dashboard/i18n.mjs.

const LANG = document.documentElement.lang === "de" ? "de" : "en";

// The front-end pass fills this; so far only the spec's glossary
// (docs/specs/2026-10-19-dashboard-usability.md). Informal "du", sentence case.
const I18N_DE = {
  "Inbox": "Posteingang",
  "Question": "Rückfrage",
  "Problem": "Problem",
  "Result": "Ergebnis",
  "Team": "Team",
  "Specialist": "Spezialist",
  "Role": "Rolle",
  "Scheduled job": "Geplante Aufgabe",
  "Expert view": "Expertenansicht",
  "Mark as read": "Als gelesen markieren",
  "Send answer": "Antwort senden",
  "Open|verb": "Öffnen",
};

function t(en, vars) {
  const text = LANG === "de" && Object.hasOwn(I18N_DE, en) ? I18N_DE[en] : en.replace(/\|\w+$/, "");
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, key) => (Object.hasOwn(vars, key) ? String(vars[key]) : m));
}

/** tp(3, { one: "{n} question", other: "{n} questions" }): the plural form for n, translated. */
function tp(n, forms) {
  const form = forms[new Intl.PluralRules(LANG).select(n)] ?? forms.other;
  return t(form, { n: new Intl.NumberFormat(LANG).format(n) });
}

const I18N_UNITS = [
  ["year", 365 * 864e5], ["month", 30 * 864e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3],
];

/** An age in ms as "3 minutes ago" / "vor 3 Minuten"; negative = in the future. */
function fmtAgo(ms) {
  const abs = Math.abs(ms);
  const [unit, size] = I18N_UNITS.find(([, s]) => abs >= s) ?? I18N_UNITS.at(-1);
  return new Intl.RelativeTimeFormat(LANG, { numeric: "auto" }).format(-Math.round(ms / size) || 0, unit);
}

/** An ISO timestamp as a short local date and time ("19.10.26, 14:05"). */
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(LANG, { dateStyle: "short", timeStyle: "short" }).format(d);
}

const I18N_SKIP = 'code, pre, textarea, script, style, [translate="no"], [data-no-i18n]';
const I18N_ATTRS = ["placeholder", "title", "aria-label"];

/**
 * Translate static markup under root once: text nodes and the placeholder,
 * title and aria-label attributes whose trimmed text is a dictionary key.
 * Agent content, names and ids sit in a [translate="no"] or [data-no-i18n]
 * subtree and are left alone, as are code, pre and textarea.
 */
function translateStatic(root = document.body) {
  if (LANG === "en" || !root || (root.nodeType === 1 && root.matches(I18N_SKIP))) return;
  const swap = (text) => {
    const key = text.trim();
    return key && Object.hasOwn(I18N_DE, key) ? text.replace(key, () => I18N_DE[key]) : text;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(I18N_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = root; n; n = walker.nextNode()) {
    if (n.nodeType === 3) n.nodeValue = swap(n.nodeValue);
    else if (n.nodeType === 1) {
      for (const a of I18N_ATTRS) if (n.hasAttribute(a)) n.setAttribute(a, swap(n.getAttribute(a)));
    }
  }
}
