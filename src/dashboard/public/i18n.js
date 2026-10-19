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
  "Finished, not read yet": "Fertig, noch nicht gelesen",
  "Results you have not read yet": "Ergebnisse, die du noch nicht gelesen hast",
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
  "Stopped by the watcher": "Vom Aufpasser gestoppt",
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
  "Your answer was not sent.": "Deine Antwort wurde nicht gesendet.",
  "This task has already ended.": "Dieser Auftrag ist schon beendet.",
  "This task is no longer waiting for you.": "Dieser Auftrag wartet nicht mehr auf dich.",
  "This task is still running.": "Dieser Auftrag läuft noch.",
  "Working…": "Einen Moment…",
  "The helper got stuck on a technical prompt and could not continue.":
    "Der Helfer ist an einer technischen Abfrage hängen geblieben und kam nicht weiter.",
  "The helper stopped at a prompt about a password, a login or a payment. team-up never answers those for you.":
    "Der Helfer ist an einer Abfrage zu Passwort, Anmeldung oder Bezahlung stehen geblieben. So etwas beantwortet team-up nie für dich.",
  "The watcher stopped this task because the helper was stuck on a technical prompt.":
    "Der Aufpasser hat diesen Auftrag beendet, weil der Helfer an einer technischen Abfrage festhing.",
  "This task ended with an error and did not finish.": "Dieser Auftrag ist mit einem Fehler abgebrochen und nicht fertig geworden.",
  "Retry lets it continue tonight from {start}:00. Or cancel the task.":
    "Mit „Erneut versuchen“ geht es heute Nacht ab {start}:00 weiter. Oder du brichst den Auftrag ab.",
  "This one cannot be retried from here: someone has to answer the prompt in the helper's terminal. Or cancel the task.":
    "Einen neuen Versuch kannst du von hier aus nicht starten: Jemand muss die Abfrage im Terminal des Helfers beantworten. Oder du brichst den Auftrag ab.",
  "Nothing to answer here. Mark it as read once you have seen it.":
    "Hier gibt es nichts zu beantworten. Markiere es als gelesen, sobald du es gesehen hast.",
  "Technical details": "Technische Details",
  "Only the beginning is shown here.": "Hier steht nur der Anfang.",
  "Open run": "Auftrag öffnen",
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

  // Shell: sidebar, navigation, expert view, language
  "Language": "Sprache",
  "Notifications": "Benachrichtigungen",
  "Mark all read": "Alle als gelesen markieren",
  "Dashboard views": "Ansichten",
  "Overview": "Übersicht",
  "Projects": "Projekte",
  "TIM memory": "TIM-Gedächtnis",
  "Scheduled jobs": "Geplante Aufgaben",
  "Communication": "Kommunikation",
  "Settings": "Einstellungen",
  "Sessions & runs": "Sitzungen & Aufträge",
  "Roles & models": "Rollen & Modelle",
  "Providers": "Anbieter",
  "AI trending": "KI-Trends",
  "Could not switch the language: {error}": "Die Sprache ließ sich nicht umstellen: {error}",
  "Cancel": "Abbrechen",
  "Close": "Schließen",
  "Save": "Speichern",
  "Add": "Hinzufügen",
  "Remove": "Entfernen",
  "Not saved: {error}": "Nicht gespeichert: {error}",
  "Refused: {error}": "Abgelehnt: {error}",
  "Colour and visible columns": "Farbe und sichtbare Spalten",

  // Overview
  "What needs you right now, and how much of each subscription is left.":
    "Was dich gerade braucht und wie viel von jedem Abo noch übrig ist.",
  "Working now": "Arbeitet gerade",
  "By project": "Nach Projekt",
  "Needs attention": "Braucht deine Aufmerksamkeit",
  "Dashboard overview": "Dashboard-Übersicht",
  "Worst usage window": "Am stärksten ausgelastet",
  "No usage windows": "Keine Kontingente",
  "High-priority TIM tasks": "TIM-Aufgaben mit hoher Priorität",
  "View TIM work": "TIM-Arbeit ansehen",
  "Usage": "Nutzung",

  // Projects (#/projects)
  "Every project in your projects folder: what waits for you there, what is being worked on, and a session to work in it yourself.":
    "Jedes Projekt in deinem Projektordner: was dort auf dich wartet, woran gerade gearbeitet wird, und eine Sitzung, um selbst darin zu arbeiten.",
  "Your projects: what waits for you in each, what is being worked on there, and a session to work in one yourself.":
    "Deine Projekte: was in jedem auf dich wartet, woran dort gearbeitet wird, und eine Sitzung, um selbst darin zu arbeiten.",
  "Your projects": "Deine Projekte",
  "+ New project": "+ Neues Projekt",
  "Waiting for you": "Wartet auf dich",
  "Test command": "Testbefehl",
  "Sessions": "Sitzungen",
  "Open session…": "Sitzung öffnen…",
  "{n} waiting in {project}: open the inbox": "{n} offen in {project}: Posteingang öffnen",
  "No projects in this folder yet.": "In diesem Ordner gibt es noch keine Projekte.",
  "Could not load the projects: {error}": "Die Projekte ließen sich nicht laden: {error}",
  "Other folders ({n})": "Andere Ordner ({n})",
  "clone folder": "Klon-Ordner",
  "not a git repository": "kein Git-Repository",
  "specialist package": "Spezialisten-Paket",
  "side branch {branch}": "Nebenzweig {branch}",
  "uncommitted changes": "nicht committete Änderungen",
  "Test command: the command a specialist may run in this project to test its work, outside its sandbox. Ready means you approved exactly that command.":
    "Testbefehl: der Befehl, mit dem ein Spezialist in diesem Projekt seine Arbeit testen darf, außerhalb seiner Sandbox. Bereit heißt: Du hast genau diesen Befehl freigegeben.",
  "Ready": "Bereit",
  "Not approved yet": "Noch nicht freigegeben",
  "Changed since it was approved, or never approved. Approve it in a terminal: team-up specialist trust-policy --project {path}":
    "Seit der Freigabe geändert oder nie freigegeben. Gib ihn im Terminal frei: team-up specialist trust-policy --project {path}",
  "from the folder above": "vom übergeordneten Ordner",
  "Broken": "Fehlerhaft",
  "Missing": "Fehlt",
  "Found one test command: check it and create it.": "Ein Testbefehl gefunden: prüfe ihn und lege ihn an.",
  "Several candidates: check the proposal.": "Mehrere Kandidaten: prüfe den Vorschlag.",
  "No tests found": "Keine Tests gefunden",
  "Create…": "Anlegen…",
  "Create": "Anlegen",
  "Written into the project, not committed. An existing file is never overwritten.":
    "Wird ins Projekt geschrieben, nicht committet. Eine vorhandene Datei wird nie überschrieben.",
  "Found one test command.": "Ein Testbefehl gefunden.",
  "A proposal only: check the command before you create it.": "Nur ein Vorschlag: prüfe den Befehl, bevor du ihn anlegst.",
  "No test command found: fill in the one this project uses.": "Kein Testbefehl gefunden: trag den ein, den dieses Projekt nutzt.",
  "Not valid JSON: {error}": "Kein gültiges JSON: {error}",
  "Test command written into {project} (not committed).": "Testbefehl in {project} geschrieben (nicht committet).",
  "Open a session in {project}": "Sitzung in {project} öffnen",
  "Starts an AI assistant in this project, in a terminal you can type into. If it already runs there, this opens it.":
    "Startet einen KI-Assistenten in diesem Projekt, in einem Terminal, in das du tippen kannst. Läuft er dort schon, öffnet sich diese Sitzung.",
  "Assistant": "Assistent",
  "Start session": "Sitzung starten",
  "Could not start the session: {error}": "Die Sitzung ließ sich nicht starten: {error}",
  "New project": "Neues Projekt",
  "Creates a folder for it in your projects folder and sets it up for version control (git). With TIM installed, the project also gets its own memory.":
    "Legt dafür einen Ordner in deinem Projektordner an und richtet ihn für die Versionsverwaltung (git) ein. Ist TIM installiert, bekommt das Projekt auch ein eigenes Gedächtnis.",
  "Name": "Name",
  "Letters, digits, dots, dashes and underscores; it starts with a letter or digit.":
    "Buchstaben, Ziffern, Punkte, Binde- und Unterstriche; am Anfang ein Buchstabe oder eine Ziffer.",
  "Create project": "Projekt anlegen",
  "Created {name}.": "{name} angelegt.",
  "Not created: {error}": "Nicht angelegt: {error}",

  // Team (#/specialists)
  "Your specialists: what each one is good at, what it may do, and which AI model it works with. Open one to change its role or its extras.":
    "Deine Spezialisten: was jeder gut kann, was er darf und mit welchem KI-Modell er arbeitet. Öffne einen, um seine Rolle oder seine Extras zu ändern.",
  "Add a specialist…": "Spezialisten hinzufügen…",
  "Add a specialist": "Spezialisten hinzufügen",
  "Installs a specialist from a GitHub repository. Installing grants it the permissions its package lists: whether it may change files, use the internet and run commands. Install only from sources you trust.":
    "Installiert einen Spezialisten aus einem GitHub-Repository. Mit der Installation bekommt er die Rechte, die sein Paket nennt: ob er Dateien ändern, das Internet nutzen und Befehle ausführen darf. Installiere nur aus Quellen, denen du vertraust.",
  "GitHub repository": "GitHub-Repository",
  "Folder in the repository (optional)": "Ordner im Repository (optional)",
  "Install": "Installieren",
  "Installing {repo}…": "{repo} wird installiert…",
  "Installed {name}.": "{name} installiert.",
  "No specialists installed yet.": "Noch keine Spezialisten installiert.",
  "Developer": "Entwicklung",
  "Tester": "Tests",
  "Reviewer": "Review",
  "Researcher": "Recherche",
  "Marketing": "Marketing",
  "Team member": "Teammitglied",
  "Active": "Aktiv",
  "Off": "Aus",
  "It cannot start: {error}": "Er kann nicht starten: {error}",
  "It has no role, so it does not start.": "Er hat keine Rolle und startet deshalb nicht.",
  "Edits code": "Ändert Code",
  "Edits code through a helper": "Ändert Code über einen Helfer",
  "Read-only": "Nur lesen",
  "Uses the internet": "Nutzt das Internet",
  "Runs tests": "Führt Tests aus",
  "Up to {n} min": "Bis zu {n} Min.",
  "No job yet": "Noch kein Auftrag",
  "Last job: done {ago}, in {project}": "Letzter Auftrag: {ago} erledigt, in {project}",
  "Last job: failed {ago}, in {project}": "Letzter Auftrag: {ago} fehlgeschlagen, in {project}",
  "Last job: cancelled {ago}, in {project}": "Letzter Auftrag: {ago} abgebrochen, in {project}",
  "Last job: started {ago}, waiting for you, in {project}": "Letzter Auftrag: {ago} gestartet, wartet auf dich, in {project}",
  "Last job: started {ago}, still working, in {project}": "Letzter Auftrag: {ago} gestartet, läuft noch, in {project}",
  "Works with: {model}": "Arbeitet mit: {model}",
  "No model can take it right now": "Gerade kann kein Modell übernehmen",
  "Good at": "Kann gut",
  "Won't do": "Macht nicht",
  "Skills": "Fähigkeiten",
  "Built-in skills": "Eingebaute Fähigkeiten",
  "They come with {name} and always stay.": "Sie gehören zu {name} und bleiben immer.",
  "Added extras": "Hinzugefügte Extras",
  "shared by the whole team": "für das ganze Team",
  "added for {name}": "für {name} hinzugefügt",
  "Remove…": "Entfernen…",
  "None yet.": "Noch keine.",
  "Add an extra": "Extra hinzufügen",
  "Nothing left to add": "Nichts mehr zum Hinzufügen",
  "Model": "Modell",
  "No role: it does not start": "Keine Rolle: startet nicht",
  "Its own model list": "Eigene Modellliste",
  "Its own model list: {chain}": "Eigene Modellliste: {chain}",
  "Custom model list…": "Eigene Modellliste…",
  "The role decides which AI models it works with: the first one with quota left does the job.":
    "Die Rolle bestimmt, mit welchen KI-Modellen er arbeitet: Das erste mit freiem Kontingent übernimmt den Auftrag.",
  "{name} now works in the role {role}.": "{name} arbeitet jetzt in der Rolle {role}.",
  "{name} has no role now and does not start.": "{name} hat jetzt keine Rolle und startet nicht.",
  "{name} now uses its own model list.": "{name} nutzt jetzt eine eigene Modellliste.",
  "{name} now has {extra}.": "{name} hat jetzt {extra}.",
  "{name} no longer gets {extra}.": "{name} bekommt {extra} nicht mehr.",
  "Leave {extra} out for {name}?": "{extra} für {name} weglassen?",
  "{extra} is shared by the whole team. {name} no longer gets it; everyone else keeps it. You can add it back any time.":
    "{extra} gilt für das ganze Team. {name} bekommt es nicht mehr, alle anderen behalten es. Du kannst es jederzeit wieder hinzufügen.",
  "Leave it out": "Weglassen",
  "Remove {extra} from {name}?": "{extra} bei {name} entfernen?",
  "{name} no longer gets this extra. You can add it again any time.":
    "{name} bekommt dieses Extra nicht mehr. Du kannst es jederzeit wieder hinzufügen.",
  "Id": "ID",
  "Version": "Version",
  "Installed versions": "Installierte Versionen",
  "Checksum": "Prüfsumme",
  "Call types": "Aufrufarten",
  "Timeout": "Zeitlimit",
  "Tools": "Werkzeuge",
  "Files": "Dateien",
  "Commands": "Befehle",
  "Left out": "Weggelassen",

  // Roles & models (expert)
  "Used by: {names}": "Genutzt von: {names}",
  "Edit {role}": "{role} bearbeiten",
  "Delete {role}": "{role} löschen",
  "Cannot be deleted": "Kann nicht gelöscht werden",
  "Delete the role {role}?": "Die Rolle {role} löschen?",
  "Anything that still runs team-up pick --role {role} will fail.":
    "Alles, was noch team-up pick --role {role} aufruft, schlägt dann fehl.",
  "Delete role": "Rolle löschen",
  "Move up": "Nach oben",
  "Move down": "Nach unten",
  "Set it up in a form instead": "Lieber im Formular einrichten",

  // Scheduled jobs (#/automation)
  "Everything team-up runs on a schedule — what it does, when it runs next, what it costs — and jobs of your own: a prompt, a project folder, a model and a schedule.":
    "Alles, was team-up nach Zeitplan ausführt – was es tut, wann es als Nächstes läuft, was es kostet – und deine eigenen Aufgaben: ein Prompt, ein Projektordner, ein Modell und ein Zeitplan.",
  "Your jobs": "Deine Aufgaben",
  "+ New job": "+ Neue Aufgabe",
  "Built-in jobs": "Eingebaute Aufgaben",
  "Background services": "Hintergrunddienste",
  "not installed": "nicht installiert",
  "uses an LLM": "nutzt ein LLM",
  "no LLM": "kein LLM",
  "When": "Wann",
  "Next|run": "Nächster Lauf",
  "Last activity": "Zuletzt aktiv",
  "Last result": "Letztes Ergebnis",
  "Succeeded": "Erfolgreich",
  "Failed|job": "Fehlgeschlagen",
  "Cancelled": "Abgebrochen",
  "Running": "Läuft",
  "Why: {reason}": "Grund: {reason}",
  "Cost: {cost}": "Kosten: {cost}",
  "Details & settings": "Details & Einstellungen",
  "Delete the job {name}?": "Die Aufgabe {name} löschen?",
  "Its prompt goes too. This cannot be undone.": "Ihr Prompt wird mitgelöscht. Das lässt sich nicht rückgängig machen.",
  "Delete job": "Aufgabe löschen",

  // Settings (#/settings)
  "Every setting, explained. A change is checked and saved with a backup, and takes effect as noted under it.":
    "Jede Einstellung mit Erklärung. Eine Änderung wird geprüft, mit Sicherung gespeichert und wirkt so, wie es darunter steht.",
  "Search settings…": "Einstellungen durchsuchen…",
  "Search settings": "Einstellungen durchsuchen",
  "Show advanced": "Erweiterte zeigen",
  "Not editable here": "Hier nicht änderbar",
  "Also shows the technical views and details: sessions and runs, roles and models, providers, CLIs, ids and paths. Only in this browser.":
    "Zeigt auch die technischen Ansichten und Details: Sitzungen und Aufträge, Rollen und Modelle, Anbieter, CLIs, IDs und Pfade. Nur in diesem Browser.",
  "Projects folder": "Projektordner",
  "The folder that holds your projects: Projects lists every folder in it. Only in this browser.":
    "Der Ordner mit deinen Projekten: Unter Projekte steht jeder Ordner darin. Nur in diesem Browser.",
  "not set": "nicht gesetzt",
  "on": "an",
  "off": "aus",
  "none": "keine",
  "default {value}": "Standard: {value}",
  "changed": "geändert",
  "reset": "zurücksetzen",
  "Takes effect: {effect}": "Wann es wirkt: {effect}",
  "{n} advanced setting hidden: tick “Show advanced”.": "{n} erweiterte Einstellung ausgeblendet: Hake „Erweiterte zeigen“ an.",
  "{n} advanced settings hidden: tick “Show advanced”.": "{n} erweiterte Einstellungen ausgeblendet: Hake „Erweiterte zeigen“ an.",
  "No setting matches “{query}”.": "Keine Einstellung passt zu „{query}“.",
  "Saved: {label}.": "Gespeichert: {label}.",
  "Back to the default: {label}.": "Zurück auf Standard: {label}.",
  "Backup: {file}": "Sicherung: {file}",
  "Lift the post-restart cap": "Begrenzung nach dem Neustart aufheben",
  "After a memory-caused restart team-up caps workers for 24 h; this lifts it now":
    "Nach einem Neustart wegen Speichermangels begrenzt team-up die Worker 24 Stunden lang; das hebt die Begrenzung jetzt auf",
  "Cap lifted.": "Begrenzung aufgehoben.",
  "There was no cap to lift.": "Es gab keine Begrenzung aufzuheben.",
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
