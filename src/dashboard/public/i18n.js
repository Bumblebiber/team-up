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

// The glossary of docs/specs/2026-10-19-dashboard-usability.md first, then one
// block per view. Informal "du", sentence case.
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

  // Inbox (#/actions) and what links to it
  "Everything that waits for you: questions to answer, problems to look at, results to read.":
    "Alles, was auf dich wartet: Rückfragen beantworten, Probleme ansehen, Ergebnisse lesen.",
  "Waiting on you": "Wartet auf dich",
  "Questions and problems": "Rückfragen und Probleme",
  "Finished, not collected": "Fertig, noch nicht gelesen",
  "Results you have not read yet": "Ergebnisse, die du noch nicht gelesen hast",
  "{n} question is waiting for your answer": "{n} Rückfrage wartet auf deine Antwort",
  "{n} questions are waiting for your answer": "{n} Rückfragen warten auf deine Antwort",
  "{n} problem needs a look": "{n} Problem solltest du dir ansehen",
  "{n} problems need a look": "{n} Probleme solltest du dir ansehen",
  "{n} question": "{n} Rückfrage",
  "{n} questions": "{n} Rückfragen",
  "{n} problem": "{n} Problem",
  "{n} problems": "{n} Probleme",
  "{n} result": "{n} Ergebnis",
  "{n} results": "{n} Ergebnisse",
  "Show": "Anzeigen",
  "All": "Alle",
  "Questions": "Rückfragen",
  "Problems": "Probleme",
  "Results": "Ergebnisse",
  "Project": "Projekt",
  "All projects": "Alle Projekte",
  "Nothing is waiting for you.": "Nichts wartet auf dich.",
  "Nothing here with this filter.": "Mit diesem Filter gibt es hier nichts.",
  "Show all": "Alle zeigen",
  "Could not load the inbox: {error}": "Der Posteingang ließ sich nicht laden: {error}",
  "Choose an item to read it.": "Wähle einen Eintrag, um ihn zu lesen.",
  "Loading…": "Wird geladen…",
  "Could not open this item: {error}": "Der Eintrag ließ sich nicht öffnen: {error}",
  "Back to inbox": "Zurück zum Posteingang",
  "Stuck on a technical prompt": "Hängt an einer technischen Abfrage fest",
  "Needs you: a credential or billing prompt": "Braucht dich: eine Abfrage zu Zugangsdaten oder Bezahlung",
  "Failed|subject": "Fehlgeschlagen",
  "Failed: {reason}": "Fehlgeschlagen: {reason}",
  "A helper asked {ago}": "Ein Helfer hat {ago} gefragt",
  "{who} asked {ago}": "{who} hat {ago} gefragt",
  "Stopped {ago}": "Angehalten {ago}",
  "Failed {ago}": "Fehlgeschlagen {ago}",
  "Finished {ago}": "Beendet {ago}",
  "What the helper was doing": "Woran der Helfer gearbeitet hat",
  "Earlier questions and answers": "Frühere Rückfragen und Antworten",
  "This is no longer waiting for you.": "Das wartet nicht mehr auf dich.",
  "Already answered.": "Schon beantwortet.",
  "Your answer": "Deine Antwort",
  "Go with the recommendation": "Empfehlung übernehmen",
  "Go with your recommendation.": "Mach es so, wie du es empfiehlst.",
  "Ctrl+Enter or ⌘+Enter sends": "Strg+Enter oder ⌘+Enter sendet",
  "Sending…": "Wird gesendet…",
  "Answer sent — continues tonight from {start}:00.": "Antwort gesendet – geht heute Nacht ab {start}:00 weiter.",
  "Answer sent — the helper continues now.": "Antwort gesendet – der Helfer macht jetzt weiter.",
  "That did not work: {error}": "Das hat nicht geklappt: {error}",
  "The helper got stuck on a technical prompt and could not continue.":
    "Der Helfer ist an einer technischen Abfrage hängen geblieben und kam nicht weiter.",
  "The helper stopped at a prompt about a password, a login or a payment. team-up never answers those for you.":
    "Der Helfer ist an einer Abfrage zu Passwort, Anmeldung oder Bezahlung stehen geblieben. So etwas beantwortet team-up nie für dich.",
  "The watcher stopped this task because the helper was stuck on a technical prompt.":
    "Der Aufpasser hat diesen Auftrag beendet, weil der Helfer an einer technischen Abfrage festhing.",
  "This task ended with an error and did not finish.": "Dieser Auftrag ist mit einem Fehler abgebrochen und nicht fertig geworden.",
  "Retry lets it continue tonight from {start}:00. Or cancel the task.":
    "Mit „Erneut versuchen“ geht es heute Nacht ab {start}:00 weiter. Oder du brichst den Auftrag ab.",
  "This one cannot be retried from here. You can cancel the task.":
    "Das lässt sich von hier aus nicht erneut versuchen. Du kannst den Auftrag abbrechen.",
  "Nothing to answer here. Mark it as read once you have seen it.":
    "Hier gibt es nichts zu beantworten. Markiere es als gelesen, sobald du es gesehen hast.",
  "Technical details": "Technische Details",
  "The helper left no report.": "Der Helfer hat keinen Bericht hinterlassen.",
  "Full report": "Vollständiger Bericht",
  "Retry": "Erneut versuchen",
  "Cancel task": "Auftrag abbrechen",
  "Cancel this task?": "Diesen Auftrag abbrechen?",
  "The helper stops for good and the task leaves your inbox. This cannot be undone.":
    "Der Helfer hört endgültig auf und der Auftrag verschwindet aus deinem Posteingang. Das lässt sich nicht rückgängig machen.",
  "Keep it": "Nicht abbrechen",
  "More": "Mehr",
  "Kept": "Behalten",
  "Discarded": "Verworfen",
  "Retry sent — continues tonight from {start}:00.": "Neuer Versuch angestoßen – geht heute Nacht ab {start}:00 weiter.",
  "Retry sent.": "Neuer Versuch angestoßen.",
  "Task cancelled.": "Auftrag abgebrochen.",
  "Marked as read.": "Als gelesen markiert.",
  "Marked as kept.": "Als behalten markiert.",
  "Marked as discarded.": "Als verworfen markiert.",
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

/** An age in ms as "3 minutes ago" / "vor 3 Minuten", rounded down; negative = in the future. */
function fmtAgo(ms) {
  const abs = Math.abs(ms);
  const [unit, size] = I18N_UNITS.find(([, s]) => abs >= s) ?? I18N_UNITS.at(-1);
  return new Intl.RelativeTimeFormat(LANG, { numeric: "auto" }).format(-Math.trunc(ms / size) || 0, unit);
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
