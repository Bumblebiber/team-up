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
  "Showing only {project}.": "Nur {project} wird angezeigt.",
  "Show all projects": "Alle Projekte zeigen",
  "Could not load the inbox: {error}": "Der Posteingang ließ sich nicht laden: {error}",
  "Choose an item to read it.": "Wähle einen Eintrag, um ihn zu lesen.",
  "Loading…": "Wird geladen…",
  "Could not open this item: {error}": "Der Eintrag ließ sich nicht öffnen: {error}",
  "Back to inbox": "Zurück zum Posteingang",
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
  "High-priority TIM tasks": "TIM-Aufgaben mit hoher Priorität",
  "View TIM work": "TIM-Arbeit ansehen",
  "Usage": "Nutzung",
  "Critical": "Kritisch",
  "Warning": "Warnung",
  "OK": "OK",
  "Unknown": "Unbekannt",
  "Usage level: {level}": "Auslastung: {level}",
  "{window} is at {pct}%; it resets {when}.": "{window} ist zu {pct} % verbraucht; es wird {when} zurückgesetzt.",
  "{window} is at {pct}%.": "{window} ist zu {pct} % verbraucht.",
  "The usage readings for {cli} are out of date, so its limits are not checked.":
    "Die Nutzungswerte für {cli} sind veraltet, deshalb werden die Limits nicht geprüft.",
  "The crontab cannot be read, so it is unknown which jobs are scheduled.":
    "Die Crontab lässt sich nicht lesen, deshalb ist unklar, welche Aufgaben geplant sind.",
  "The job {job} failed on its last run (exit code {code}).": "Die Aufgabe {job} ist beim letzten Lauf fehlgeschlagen (Exit-Code {code}).",
  "The job {job} is not in the crontab: open it and save it again.":
    "Die Aufgabe {job} steht nicht in der Crontab: Öffne sie und speichere sie noch einmal.",

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
  "Changed since it was approved, or never approved.": "Seit der Freigabe geändert oder nie freigegeben.",
  "Approve it in a terminal:": "Gib ihn im Terminal frei:",
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
  "Tester": "Qualitätssicherung",
  "Reviewer": "Review",
  "Researcher": "Recherche",
  "Marketing": "Marketing",
  "Team member": "Teammitglied",
  "Active": "Aktiv",
  "Off": "Aus",
  "It cannot start: {error}": "Kann nicht starten: {error}",
  "It has no role, so it does not start.": "Hat keine Rolle und startet deshalb nicht.",
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
    "Die Rolle bestimmt die KI-Modelle für die Arbeit: Das erste mit freiem Kontingent übernimmt den Auftrag.",
  "{name} now works in the role {role}.": "{name} arbeitet jetzt in der Rolle {role}.",
  "{name} has no role now and does not start.": "{name} hat jetzt keine Rolle und startet nicht.",
  "The extras could not be loaded": "Die Extras ließen sich nicht laden",
  "Without a role it does not start.": "Ohne Rolle: startet nicht.",
  "Its own list of models, set with “Custom model list…”.": "Eine eigene Liste von Modellen, festgelegt über „Eigene Modellliste…“.",
  "This role starts with {model} right now.": "Diese Rolle startet gerade mit {model}.",
  "No model in this role has quota right now.": "Gerade hat kein Modell dieser Rolle freies Kontingent.",
  "Also in this role: {names}.": "Ebenfalls in dieser Rolle: {names}.",
  "No one else is in this role.": "Sonst ist niemand in dieser Rolle.",
  "Could not load the team: {error}": "Das Team ließ sich nicht laden: {error}",
  "Turn {name} off?": "{name} ausschalten?",
  "Without a role {name} does not start, and nothing hands it work. Pick a role again to turn it back on.":
    "Ohne Rolle startet {name} nicht und bekommt keine Aufträge. Wähl wieder eine Rolle, um {name} einzuschalten.",
  "Turn off": "Ausschalten",
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
  "Work that runs by itself on a schedule: what team-up does, when, and what it costs — plus jobs of your own.":
    "Arbeit, die von selbst nach Zeitplan läuft: was team-up tut, wann und was es kostet – dazu deine eigenen Aufgaben.",
  "Your jobs": "Deine Aufgaben",
  "+ New job": "+ Neue Aufgabe",
  "Built-in jobs": "Eingebaute Aufgaben",
  "Background services": "Hintergrunddienste",
  "not installed": "nicht installiert",
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
  "Never ran": "Noch nie gelaufen",
  "Running since {when}": "Läuft seit {when}",
  "Exit code {code}": "Exit-Code {code}",
  "On: it starts on schedule": "An: startet nach Zeitplan",
  "{job} on schedule": "{job} nach Zeitplan",
  "The crontab does not match this job; save it again": "Die Crontab passt nicht zu dieser Aufgabe; speichere sie noch einmal",
  "Not in the crontab": "Nicht in der Crontab",
  "Start it now; its output goes to the log": "Jetzt starten; die Ausgabe landet im Log",
  "Run now": "Jetzt ausführen",
  "Edit": "Bearbeiten",
  "Log": "Log",
  "Delete": "Löschen",
  "Last run": "Letzter Lauf",
  "Folder": "Ordner",
  "Reports to Telegram": "Meldet an Telegram",
  "(default {value})": "(Standard: {value})",
  "Schedule (cron)": "Zeitplan (cron)",
  "Last full run": "Letzter vollständiger Lauf",
  "Scheduled in": "Geplant in",
  "Output": "Ausgabe",
  "To stop it": "So stoppst du sie",
  "Open its settings": "Einstellungen öffnen",
  "Cannot read your crontab: {error}": "Deine Crontab lässt sich nicht lesen: {error}",
  "No jobs of your own yet. A job is a prompt that a helper runs in one of your projects on a schedule — say a weekly dependency check, or a nightly “read the logs and file what looks wrong”.":
    "Noch keine eigenen Aufgaben. Eine Aufgabe ist ein Prompt, den ein Helfer nach Zeitplan in einem deiner Projekte ausführt – etwa eine wöchentliche Prüfung der Abhängigkeiten oder ein nächtliches „Lies die Logs und melde, was falsch aussieht“.",
  "Your crontab also runs {n} job that team-up does not manage. It is left alone.":
    "Deine Crontab führt noch {n} Aufgabe aus, die team-up nicht verwaltet. Sie bleibt unangetastet.",
  "Your crontab also runs {n} jobs that team-up does not manage. They are left alone.":
    "Deine Crontab führt noch {n} Aufgaben aus, die team-up nicht verwaltet. Sie bleiben unangetastet.",
  "{n} job failed on its last run": "{n} Aufgabe ist beim letzten Lauf fehlgeschlagen",
  "{n} jobs failed on their last run": "{n} Aufgaben sind beim letzten Lauf fehlgeschlagen",
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
  "The folder that holds your projects: Projects lists every folder in it. The same in every browser you sign in from.":
    "Der Ordner mit deinen Projekten: Unter Projekte steht jeder Ordner darin. Gilt in jedem Browser, in dem du dich anmeldest.",
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
    "Nach einem Neustart wegen Speichermangels begrenzt team-up die Agenten 24 Stunden lang; das hebt die Begrenzung jetzt auf",
  "Cap lifted.": "Begrenzung aufgehoben.",
  "There was no cap to lift.": "Es gab keine Begrenzung aufzuheben.",
  // Static page text (index.html), translated once at boot by translateStatic()
  "team-up dashboard": "team-up-Dashboard",
  "Paste the access key from this file on the server:": "Füge den Zugangsschlüssel aus dieser Datei auf dem Server ein:",
  "Access key": "Zugangsschlüssel",
  "Sign in": "Anmelden",
  "Changes need a confirmation code. The terminal that runs the dashboard prints it:":
    "Änderungen brauchen einen Bestätigungscode. Das Terminal, in dem das Dashboard läuft, zeigt ihn an:",
  "Request code": "Code anfordern",
  "Confirm": "Bestätigen",
  "Highest usage": "Höchste Auslastung",
  "No usage readings yet": "Noch keine Nutzungswerte",
  "Mark a model, provider or CLI as limited…": "Modell, Anbieter oder CLI als begrenzt markieren…",
  "Takes it out of every chain until the time runs out — for a limit team-up cannot see (an API error, a provider outage).":
    "Nimmt es aus jeder Kette, bis die Zeit abgelaufen ist – für ein Limit, das team-up nicht sieht (ein API-Fehler, ein Ausfall beim Anbieter).",
  "Model, provider or CLI": "Modell, Anbieter oder CLI",
  "Hours": "Stunden",
  "Reason (optional)": "Grund (optional)",
  "Mark limited": "Als begrenzt markieren",
  "Live worker terminals, and the mailbox runs behind them. Click a run to read its prompt and result and to close it out.":
    "Laufende Agenten-Terminals und die Mailbox-Aufträge dahinter. Klick auf einen Auftrag, um Prompt und Ergebnis zu lesen und ihn abzuschließen.",
  "Terminals": "Terminals",
  "Claude sessions": "Claude-Sitzungen",
  "Every live Claude Code session on this host, the desktop app's chats included. A message arrives as a note from another session: the session acts on it within its own permissions. A terminal session or a working chat takes it at once; an idle desktop chat may hold it until it runs again. Stop ends the process; the conversation stays and the app restarts it on its next message.":
    "Jede laufende Claude-Code-Sitzung auf diesem Rechner, die Chats der Desktop-App eingeschlossen. Eine Nachricht kommt als Notiz aus einer anderen Sitzung an: Die Sitzung handelt im Rahmen ihrer eigenen Rechte. Eine Terminal-Sitzung oder ein arbeitender Chat nimmt sie sofort an; ein untätiger Desktop-Chat hält sie eventuell zurück, bis er wieder läuft. Stoppen beendet den Prozess; die Unterhaltung bleibt, und die App startet sie mit der nächsten Nachricht neu.",
  "outside tmux too": "auch außerhalb von tmux",
  "Runs": "Aufträge",
  "Running, or finished in the last 7 days and not yet collected": "Laufend oder in den letzten 7 Tagen beendet und noch nicht abgeholt",
  "open only": "nur offene",
  "What each project remembers: open tasks, ideas and bugs to start work on, and the whole memory to browse.":
    "Was sich jedes Projekt merkt: offene Aufgaben, Ideen und Fehler, an denen du die Arbeit starten kannst, und das ganze Gedächtnis zum Durchstöbern.",
  "View": "Ansicht",
  "Open work": "Offene Arbeit",
  "Explorer": "Explorer",
  "Tasks": "Aufgaben",
  "Ideas": "Ideen",
  "Bugs": "Fehler",
  "TIM explorer": "TIM-Explorer",
  "A role is a job description with a fallback chain of models: the first one with quota left does the work. Drag a model from the roster onto a role to add it, drag chips to reorder a chain, ✕ or drag back to the roster to remove.":
    "Eine Rolle ist eine Stellenbeschreibung mit einer Ersatzkette von Modellen: Das erste mit freiem Kontingent macht die Arbeit. Zieh ein Modell aus dem Roster auf eine Rolle, um es hinzuzufügen, zieh Chips, um eine Kette umzusortieren, und entferne einen mit ✕ oder indem du ihn zurück ins Roster ziehst.",
  "Roles": "Rollen",
  "+ Role": "+ Rolle",
  "new role name": "Name der neuen Rolle",
  "New role name": "Name der neuen Rolle",
  "drop the first model here": "erstes Modell hier ablegen",
  "Roster": "Roster",
  "Every model team-up may use, by the CLI it runs on. Drag one onto a role.":
    "Jedes Modell, das team-up nutzen darf, nach der CLI, auf der es läuft. Zieh eines auf eine Rolle.",
  "Add or remove models": "Modelle hinzufügen oder entfernen",
  "Subscription": "Abo",
  "API key": "API-Schlüssel",
  "Filter models…": "Modelle filtern…",
  "Ask every CLI which models it offers now (takes a minute or two)":
    "Jede CLI fragen, welche Modelle sie gerade anbietet (dauert ein, zwei Minuten)",
  "Rescan CLIs": "CLIs neu abfragen",
  "Always-on parts of team-up (systemd user units), shown for information. Manage them in a terminal:":
    "Dauerhaft laufende Teile von team-up (systemd-User-Units), nur zur Information. Verwalten kannst du sie im Terminal:",
  "How team-up and TIM reach you, and what happens when you answer.":
    "Wie team-up und TIM dich erreichen und was passiert, wenn du antwortest.",
  "How it works": "So funktioniert es",
  "Every job sends to one place.": "Jede Aufgabe meldet sich an genau einer Stelle.",
  "That is a Telegram bot, or only the bell at the top of this dashboard (no push on your phone).":
    "Das ist ein Telegram-Bot oder nur die Glocke oben in diesem Dashboard (ohne Push aufs Handy).",
  "Every Telegram message ends with where it came from:": "Jede Telegram-Nachricht endet mit ihrer Herkunft:",
  "📂 folder · 🤖 AI tool and model · 🧵 session.": "📂 Ordner · 🤖 KI-Werkzeug und Modell · 🧵 Sitzung.",
  "A report from a plain script says so instead.": "Bei einem Bericht von einem einfachen Skript steht stattdessen das.",
  "Reply to a message to continue its session.": "Antworte auf eine Nachricht, um ihre Sitzung fortzusetzen.",
  "In Telegram, swipe the message (or long-press → Reply) and write. Your text goes into exactly that session; its answer comes back as a reply, with the same footer. A message from a script, or a message you write without replying to one, starts a new session (settings under Replies).":
    "Wisch in Telegram über die Nachricht (oder drück lange darauf → Antworten) und schreib. Dein Text geht genau in diese Sitzung; ihre Antwort kommt als Antwort zurück, mit derselben Fußzeile. Eine Nachricht von einem Skript oder eine, die du schreibst, ohne auf eine zu antworten, startet eine neue Sitzung (Einstellungen unter Antworten).",
  "Where messages go": "Wohin Nachrichten gehen",
  "Most jobs stay silent until something needs you. A change applies to the next message.":
    "Die meisten Aufgaben bleiben still, bis etwas dich braucht. Eine Änderung gilt ab der nächsten Nachricht.",
  "Replies": "Antworten",
  "Bots": "Bots",
  "+ Add a bot": "+ Bot hinzufügen",
  "In Telegram, send /newbot to @BotFather and pick a name. It answers with a token (the bot's password).":
    "Schick in Telegram /newbot an @BotFather und such dir einen Namen aus. Als Antwort kommt ein Token (das Passwort des Bots).",
  "Open the new bot and press Start: a bot may only write to chats that opened it.":
    "Öffne den neuen Bot und tippe auf Starten: Ein Bot darf nur in Chats schreiben, die ihn geöffnet haben.",
  "Paste the token here. team-up checks it with Telegram and keeps it in a file only you can read; this page only ever shows its last four characters.":
    "Füg das Token hier ein. team-up prüft es bei Telegram und bewahrt es in einer Datei auf, die nur du lesen kannst; diese Seite zeigt immer nur seine letzten vier Zeichen.",
  "Bot token": "Bot-Token",
  "Chat ID (optional)": "Chat-ID (optional)",
  "Chat ID, only if not your own": "Chat-ID, nur wenn es nicht deine eigene ist",
  "Add bot": "Bot hinzufügen",
  "Leave the chat ID empty: the bot then writes to you, like the others.":
    "Lass die Chat-ID leer: Dann schreibt der Bot dir, wie die anderen.",
  "How each model provider authenticates: an API key team-up holds, a CLI's own login, or a key the CLI keeps itself.":
    "Wie sich jeder Modell-Anbieter anmeldet: mit einem API-Schlüssel, den team-up verwahrt, mit der eigenen Anmeldung einer CLI oder mit einem Schlüssel, den die CLI selbst aufbewahrt.",
  "The agent CLIs team-up drives: version, harness check, install, update and login. Click a row for its job log.":
    "Die Agenten-CLIs, die team-up steuert: Version, Harness-Prüfung, Installation, Update und Anmeldung. Klick auf eine Zeile für ihr Job-Log.",
  "Agent CLIs": "Agenten-CLIs",
  "New AI repositories on GitHub, from the newest daily report of the trending scraper.":
    "Neue KI-Repositorys auf GitHub, aus dem neuesten Tagesbericht des Trend-Scrapers.",
  "Repositories": "Repositorys",
  "Section": "Abschnitt",
  "Click the screen and type: keys go straight to the session. Ctrl-C, Esc and the arrow keys reach it too; Ctrl-Esc closes the overlay.":
    "Klick auf den Bildschirm und tippe: Die Tasten gehen direkt an die Sitzung. Strg-C, Esc und die Pfeiltasten kommen auch an; Strg-Esc schließt das Fenster.",
  "Prompt": "Prompt",
  "Chain entry": "Ketteneintrag",
  "CLI · model · effort · fast": "CLI · Modell · Aufwand · schnell",
  "Effort \"default\" = the model's own default, or the role's effort if it has one.":
    "Aufwand „Standard“ = der eigene Standard des Modells oder der Aufwand der Rolle, falls sie einen hat.",
  "Effort for the whole role": "Aufwand für die ganze Rolle",
  "Chain — tried top to bottom; the first model with budget left wins":
    "Kette – von oben nach unten probiert; das erste Modell mit freiem Kontingent gewinnt",
  "+ Model": "+ Modell",
  "Pinned version = the entry stays on that exact version even when a newer one ships.":
    "Festgepinnte Version = der Eintrag bleibt genau bei dieser Version, auch wenn eine neuere erscheint.",
  "Model still in use": "Modell wird noch genutzt",
  "Replace it with": "Ersetzen durch",
  "Remove from chains": "Aus den Ketten entfernen",
  "Replace": "Ersetzen",
  "New job": "Neue Aufgabe",
  "On schedule, a helper starts in the project folder and does what the prompt says, with the model you pick. What it reports goes to the job's log, and to Telegram if you like.":
    "Nach Zeitplan startet ein Helfer im Projektordner und tut, was im Prompt steht, mit dem Modell, das du auswählst. Was er berichtet, landet im Log der Aufgabe und, wenn du willst, auch in Telegram.",
  "Lowercase letters, digits and dashes.": "Kleinbuchstaben, Ziffern und Bindestriche.",
  "What it is for": "Wofür sie da ist",
  "One line, shown in the list": "Eine Zeile, erscheint in der Liste",
  "Schedule preset": "Zeitplan-Vorlage",
  "Every hour": "Stündlich",
  "Every 6 hours": "Alle 6 Stunden",
  "Daily at 06:00": "Täglich um 06:00",
  "Nightly at 02:00": "Nachts um 02:00",
  "Weekdays at 09:00": "Montags bis freitags um 09:00",
  "Mondays at 06:00": "Montags um 06:00",
  "Monthly on the 1st at 06:00": "Monatlich am 1. um 06:00",
  "Custom (cron)…": "Eigener Zeitplan (cron)…",
  "Cron schedule": "Zeitplan (cron)",
  "Project folder": "Projektordner",
  "What should the helper do each time? Be specific: where to look, what to change or report, when to stop.":
    "Was soll der Helfer jedes Mal tun? Sei konkret: wo er nachsehen soll, was er ändern oder melden soll, wann er aufhören soll.",
  "Send the result to Telegram": "Ergebnis an Telegram schicken",
  "Enabled": "Eingeschaltet",
  "Save job": "Aufgabe speichern",
  "Colour": "Farbe",
  "No colour": "Keine Farbe",
  "Reset this widget": "Dieses Widget zurücksetzen",
  "Done": "Fertig",
  // Overview usage, sessions & runs (expert)
  "{n} run waiting for you": "{n} Auftrag wartet auf dich",
  "{n} runs waiting for you": "{n} Aufträge warten auf dich",
  "{n} failed run not read yet": "{n} fehlgeschlagener Auftrag, noch nicht gelesen",
  "{n} failed runs not read yet": "{n} fehlgeschlagene Aufträge, noch nicht gelesen",
  "{n} open high-priority TIM task": "{n} offene TIM-Aufgabe mit hoher Priorität",
  "{n} open high-priority TIM tasks": "{n} offene TIM-Aufgaben mit hoher Priorität",
  "This access key is not valid.": "Dieser Zugangsschlüssel stimmt nicht.",
  "Could not sign in. Try again.": "Die Anmeldung hat nicht geklappt. Versuch es noch einmal.",
  "The usage reader could not sign in, {n} times in a row: sign in to {cli} again.":
    "Die Nutzungsabfrage konnte sich {n}-mal hintereinander nicht anmelden: Melde dich bei {cli} neu an.",
  "The usage reader could not sign in: sign in to {cli} again.":
    "Die Nutzungsabfrage konnte sich nicht anmelden: Melde dich bei {cli} neu an.",
  "Sign-in failed": "Anmeldung fehlgeschlagen",
  "Last reading failed: {reason}": "Letzte Abfrage fehlgeschlagen: {reason}",
  "Being fixed…": "Wird repariert…",
  "Out of date · fix it": "Veraltet · reparieren",
  "⚠ {cli}: sign-in failed {n} times in a row. If the subscription is gone, switch the account off under Settings → Accounts; nothing is switched off by itself.":
    "⚠ {cli}: Anmeldung {n}-mal hintereinander fehlgeschlagen. Wenn das Abo weg ist, schalte das Konto unter Einstellungen → Konten ab; von selbst wird nichts abgeschaltet.",
  "⟳ Fixing the usage reading for {clis}. This panel updates itself.":
    "⟳ Die Nutzungsabfrage für {clis} wird repariert. Diese Ansicht aktualisiert sich von selbst.",
  "The last repair wrote a report: {file}": "Die letzte Reparatur hat einen Bericht geschrieben: {file}",
  "Run": "Auftrag",
  "Status": "Status",
  "Worker": "Agent",
  "Age": "Alter",
  "Last sign of life": "Letztes Lebenszeichen",
  "No runs": "Keine Aufträge",
  "Cancel run": "Auftrag abbrechen",
  "Mark it cancelled and stop the worker's terminal": "Als abgebrochen markieren und das Terminal des Agenten beenden",
  "Mark failed…": "Als fehlgeschlagen markieren…",
  "With a reason: the insights job counts failures by reason": "Mit Grund: Die Auswertung zählt Fehlschläge nach Grund",
  "You have read the result; it leaves the open list": "Du hast das Ergebnis gelesen; es verschwindet aus der offenen Liste",
  "Outcome: merged": "Ergebnis: übernommen",
  "The work landed": "Die Arbeit wurde übernommen",
  "Outcome: discarded": "Ergebnis: verworfen",
  "The work was not kept": "Die Arbeit wurde nicht behalten",
  "read": "gelesen",
  "Why did this run fail? (one line)": "Warum ist dieser Auftrag fehlgeschlagen? (eine Zeile)",
  "Cancel this run and stop its worker?": "Diesen Auftrag abbrechen und seinen Agenten beenden?",
  "No mailbox files": "Keine Mailbox-Dateien",
  "Session": "Sitzung",
  "No sessions": "Keine Sitzungen",
  "desktop app": "Desktop-App",
  "Terminal": "Terminal",
  "Message": "Nachricht",
  "Stop": "Stoppen",
  "Where": "Wo",
  "Last active": "Zuletzt aktiv",
  "this session": "diese Sitzung",
  "Stop {name} (pid {pid})?": "{name} (PID {pid}) stoppen?",
  "It is working right now: the running turn is cut off.": "Sie arbeitet gerade: Der laufende Schritt wird abgebrochen.",
  "The conversation is kept and can be resumed.": "Die Unterhaltung bleibt erhalten und lässt sich fortsetzen.",
  "Message to {name} (pid {pid}):": "Nachricht an {name} (PID {pid}):",
  "It arrives as a note from another session.": "Sie kommt als Notiz aus einer anderen Sitzung an.",
  "(empty)": "(leer)",
  "The session has ended.": "Die Sitzung ist beendet.",
  "Resets {when}": "Neu ab {when}",
  "Marked as limited": "Als begrenzt markiert",
  "{target} is limited until {when}.": "{target} ist bis {when} begrenzt.",
  "Lift now": "Jetzt aufheben",
  "Could not lift the mark: {error}": "Die Markierung ließ sich nicht aufheben: {error}",
  "{target} is out of every chain until {when}.": "{target} ist bis {when} aus jeder Kette genommen.",
  "Starting…": "Wird gestartet…",
  "The repair did not start: {error}": "Die Reparatur ist nicht gestartet: {error}",
  // Roles & models, providers, CLIs (expert)
  "gone: the CLI no longer offers it": "weg: Die CLI bietet es nicht mehr an",
  "not in the roster's models": "nicht unter den Modellen im Roster",
  "no fresh scan of this CLI: availability unknown": "kein aktueller Scan dieser CLI: Verfügbarkeit unbekannt",
  "invalid": "ungültig",
  "gone: the CLI no longer offers it and no newer version of this model exists. Delete it from the chain or pick another model.":
    "weg: Die CLI bietet es nicht mehr an, und es gibt keine neuere Version dieses Modells. Lösch es aus der Kette oder wähl ein anderes Modell.",
  "picked now": "gerade gewählt",
  "skipped now: {reason}": "gerade übersprungen: {reason}",
  "newer: {model}": "neuer: {model}",
  "version pinned": "Version festgepinnt",
  "effort {effort}": "Aufwand {effort}",
  "fast (more quota)": "schnell (mehr Kontingent)",
  "Double-click to change CLI, model or effort": "Doppelklick, um CLI, Modell oder Aufwand zu ändern",
  "Remove from the chain": "Aus der Kette entfernen",
  "Remove {model}": "{model} entfernen",
  "This chain has an entry team-up cannot read: fix it with ✎ first":
    "Diese Kette hat einen Eintrag, den team-up nicht lesen kann: Korrigier ihn zuerst mit ✎",
  "Every model in the chain is skipped right now": "Gerade wird jedes Modell der Kette übersprungen",
  "exhausted": "erschöpft",
  "Effort, pinning, chain as a form": "Aufwand, Pinning, Kette als Formular",
  "Used by {names}: it cannot be deleted": "Genutzt von {names}: kann nicht gelöscht werden",
  "in {roles}": "in {roles}",
  "in no chain yet": "noch in keiner Kette",
  "No models in the roster yet: add some below.": "Noch keine Modelle im Roster: Füg unten welche hinzu.",
  "⬆ Bring to the newest versions ({changes})": "⬆ Auf die neuesten Versionen bringen ({changes})",
  "{n} new: {models}": "{n} neu: {models}",
  "{n} chain entry": "{n} Ketteneintrag",
  "{n} chain entries": "{n} Ketteneinträge",
  "No roles yet.": "Noch keine Rollen.",
  "{entry} removed": "{entry} entfernt",
  "{role} deleted": "{role} gelöscht",
  "{role} needs at least one model: delete the role instead": "{role} braucht mindestens ein Modell: Lösch stattdessen die Rolle",
  "Still saving the last change…": "Die letzte Änderung wird noch gespeichert…",
  "{entry} at place {n}": "{entry} an Stelle {n}",
  "Name the role first: lowercase letters, digits, . _ -": "Gib der Rolle zuerst einen Namen: Kleinbuchstaben, Ziffern, . _ -",
  "{role} already exists: drop the model on its row instead":
    "{role} gibt es schon: Leg das Modell stattdessen in ihrer Zeile ab",
  "{role} created": "{role} angelegt",
  "added {model}": "{model} hinzugefügt",
  "removed {model}": "{model} entfernt",
  "Already on the newest versions.": "Schon auf den neuesten Versionen.",
  "Overrides the model's default effort for this role": "Ersetzt den Standard-Aufwand des Modells für diese Rolle",
  "Effort": "Aufwand",
  "fast": "schnell",
  "Stay on exactly this version; never move to a newer one": "Genau bei dieser Version bleiben, nie auf eine neuere wechseln",
  "pin version": "Version festpinnen",
  "default ({effort})": "Standard ({effort})",
  "default|effort": "Standard",
  "Fast mode: {note}": "Schnellmodus: {note}",
  "Fast mode: uses more quota": "Schnellmodus: verbraucht mehr Kontingent",
  "Own model list for {name}": "Eigene Modellliste für {name}",
  "New role": "Neue Rolle",
  "per model (default)": "pro Modell (Standard)",
  "{role} · entry {n}": "{role} · Eintrag {n}",
  "entry {n} → {entry}": "Eintrag {n} → {entry}",
  "{role} already exists: edit it instead": "{role} gibt es schon: Bearbeite sie stattdessen",
  "{role} saved": "{role} gespeichert",
  "Picked per role or specialist, not here": "Wird pro Rolle oder Spezialist gewählt, nicht hier",
  "effort: {efforts}": "Aufwand: {efforts}",
  "not in any scan": "in keinem Scan",
  "{n} of {total} in the roster": "{n} von {total} im Roster",
  "No models yet. Run this in a terminal:": "Noch keine Modelle. Führ das im Terminal aus:",
  "{model} added to the roster": "{model} zum Roster hinzugefügt",
  "{model} removed from the roster": "{model} aus dem Roster entfernt",
  "{model} ({cli}) is in the chain of {roles}. Pick a replacement, or remove it from those chains.":
    "{model} ({cli}) steht in der Kette von {roles}. Wähl einen Ersatz oder entferne es aus diesen Ketten.",
  "not connected": "nicht verbunden",
  "connected": "verbunden",
  "valid": "gültig",
  "subscription login": "Abo-Anmeldung",
  "key kept by the CLI": "Schlüssel liegt bei der CLI",
  "OpenRouter API key": "OpenRouter-API-Schlüssel",
  "Replace key": "Schlüssel ersetzen",
  "Connect": "Verbinden",
  "Check": "Prüfen",
  "read-only ({source})": "nur lesbar ({source})",
  "read-only": "nur lesbar",
  "No providers": "Keine Anbieter",
  "verified": "geprüft",
  "not checkable": "nicht prüfbar",
  "Check: {verdict}": "Prüfung: {verdict}",
  "(no log yet)": "(noch kein Log)",
  "Update": "Aktualisieren",
  "Uninstall": "Deinstallieren",
  "Start login": "Anmeldung starten",
  "not on PATH": "nicht im PATH",
  "installed": "installiert",
  "missing": "fehlt",
  "Present": "Vorhanden",
  "Job": "Job",
  "Actions": "Aktionen",
  "No CLIs": "Keine CLIs",
  "Run the update and check it?": "Update ausführen und prüfen?",
  "Run the install?": "Installation ausführen?",
  "Uninstall {cli}?": "{cli} deinstallieren?",
  "Start the login in tmux?": "Anmeldung in tmux starten?",
  "Finish it in a terminal:": "Schließ sie im Terminal ab:",
  "Enter the code your terminal shows.": "Gib den Code ein, den dein Terminal zeigt.",
  "Confirmed: changes work for the next 10 minutes.": "Bestätigt: Änderungen gehen jetzt 10 Minuten lang.",
  // TIM memory, scheduled jobs
  "{n} open task": "{n} offene Aufgabe",
  "{n} open tasks": "{n} offene Aufgaben",
  "{n} open idea": "{n} offene Idee",
  "{n} open ideas": "{n} offene Ideen",
  "{n} open bug": "{n} offener Fehler",
  "{n} open bugs": "{n} offene Fehler",
  "to do": "zu tun",
  "open": "offen",
  "in progress": "in Arbeit",
  "in review": "im Review",
  "blocked": "blockiert",
  "done": "erledigt",
  "{n} project": "{n} Projekt",
  "{n} projects": "{n} Projekte",
  "running": "läuft",
  "Start…": "Starten…",
  "no project folder": "kein Projektordner",
  "Nothing open.": "Nichts offen.",
  "— the CLI's default —": "— Standard der CLI —",
  "An interactive session: no sandbox, no approval, no RESULT.json.":
    "Eine interaktive Sitzung: keine Sandbox, keine Freigabe, keine RESULT.json.",
  "— none —": "— keiner —",
  "Service": "Dienst",
  "What it does": "Was er tut",
  "State": "Zustand",
  "Crontab backup: {file}": "Crontab-Sicherung: {file}",
  "{job} switched on": "{job} eingeschaltet",
  "{job} switched off": "{job} ausgeschaltet",
  "{job} now runs on {model}": "{job} läuft jetzt mit {model}",
  "{job}: {setting} saved": "{job}: {setting} gespeichert",
  "Schedule saved.": "Zeitplan gespeichert.",
  "{job} started: its output goes to the log": "{job} gestartet: Die Ausgabe landet im Log",
  "{job} deleted": "{job} gelöscht",
  "next run {when}": "nächster Lauf {when}",
  "Edit {job}": "{job} bearbeiten",
  "{job} saved": "{job} gespeichert",
  "No runs yet.": "Noch keine Läufe.",
  "Scan started: every CLI is asked for its models; the list updates in about two minutes.":
    "Scan gestartet: Jede CLI wird nach ihren Modellen gefragt; die Liste aktualisiert sich in etwa zwei Minuten.",
  "Starting the TIM viewer…": "Der TIM-Viewer startet…",
  // Communication, AI trending, panel help, notifications
  "Where {job} goes": "Wohin {job} geht",
  "Only the bell in this dashboard": "Nur die Glocke in diesem Dashboard",
  "Job: what it sends": "Aufgabe: was sie schickt",
  "Goes to": "Geht an",
  "not scheduled": "nicht geplant",
  "switched off": "ausgeschaltet",
  "Everything else": "Alles andere",
  "Anything not listed above": "Alles, was oben nicht steht",
  "Any other script that sends to Telegram, and new jobs until you choose a place for them.":
    "Jedes andere Skript, das an Telegram schickt, und neue Aufgaben, bis du ihnen ein Ziel gibst.",
  "everything else": "alles andere",
  "Messages now arrive through {bots}. Replies there are read by {owner}, not by team-up, so they do not continue the session in the footer. To continue sessions, send the jobs through a bot team-up listens to.":
    "Nachrichten kommen jetzt über {bots}. Antworten dort liest {owner}, nicht team-up; sie setzen also nicht die Sitzung aus der Fußzeile fort. Damit Sitzungen weitergehen, schick die Aufgaben über einen Bot, dem team-up zuhört.",
  "No bot listens yet, so replying does nothing.": "Noch hört kein Bot zu, Antworten bewirken also nichts.",
  "Switch on listening for the bot your messages come from. For {bot} that ends its old send-only rule (it was kept so that no second program would compete for its replies; team-up is the only reader here). Or add a bot of its own for this.":
    "Schalte das Zuhören für den Bot ein, von dem deine Nachrichten kommen. Für {bot} endet damit seine alte Nur-Senden-Regel (sie sollte verhindern, dass ein zweites Programm um seine Antworten konkurriert; hier liest nur team-up). Oder leg dafür einen eigenen Bot an.",
  "Switch on listening for the bot your messages come from.":
    "Schalte das Zuhören für den Bot ein, von dem deine Nachrichten kommen.",
  "Messages also arrive through {bots}, which does not listen: replies there do nothing.":
    "Nachrichten kommen auch über {bots}, der nicht zuhört: Antworten dort bewirken nichts.",
  "Messages also arrive through {bots}, which do not listen: replies there do nothing.":
    "Nachrichten kommen auch über {bots}, die nicht zuhören: Antworten dort bewirken nichts.",
  "listening": "hört zu",
  "cannot read replies: {error}": "kann Antworten nicht lesen: {error}",
  "Replies are read by {owner}: Telegram gives each reply to one reader only.":
    "Antworten liest {owner}: Telegram gibt jede Antwort nur an einen Leser.",
  "Listen for replies": "Auf Antworten hören",
  "New sessions": "Neue Sitzungen",
  "Used when you reply to a script's report, or write to a bot without replying to a message. A reply to a message with a 🧵 claude session always continues that session, in its own folder and with its own model.":
    "Gilt, wenn du auf den Bericht eines Skripts antwortest oder einem Bot schreibst, ohne auf eine Nachricht zu antworten. Eine Antwort auf eine Nachricht mit einer 🧵-claude-Sitzung setzt immer genau diese Sitzung fort, in ihrem eigenen Ordner und mit ihrem eigenen Modell.",
  "Extra instructions": "Zusätzliche Anweisungen",
  "Optional, e.g. “You may cancel stuck runs with team-up runs cancel.”":
    "Optional, z. B. „Du darfst hängende Aufträge mit team-up runs cancel abbrechen.“",
  "Bot": "Bot",
  "Token": "Token",
  "Sends": "Schickt",
  "token file missing": "Token-Datei fehlt",
  "{n} job": "{n} Aufgabe",
  "{n} jobs": "{n} Aufgaben",
  "nothing": "nichts",
  "Send test": "Test schicken",
  "Send its messages elsewhere first": "Schick seine Nachrichten zuerst woandershin",
  "No bots yet: add one below.": "Noch keine Bots: Füg unten einen hinzu.",
  "{n} bot needs attention": "{n} Bot braucht Aufmerksamkeit",
  "{n} bots need attention": "{n} Bots brauchen Aufmerksamkeit",
  "Saved: {job} → {place}": "Gespeichert: {job} → {place}",
  "Listening: replies to this bot now continue their session.":
    "Hört zu: Antworten an diesen Bot setzen jetzt ihre Sitzung fort.",
  "Stopped listening.": "Hört nicht mehr zu.",
  "Settings for new sessions saved.": "Einstellungen für neue Sitzungen gespeichert.",
  "Checking the token with Telegram…": "Das Token wird bei Telegram geprüft…",
  "Bot added: send it a test, then send jobs to it above.":
    "Bot hinzugefügt: Schick ihm einen Test und leite dann oben Aufgaben an ihn.",
  "Test message sent: check Telegram.": "Testnachricht geschickt: Schau in Telegram nach.",
  "Remove this bot from the list?": "Diesen Bot aus der Liste entfernen?",
  "Bot removed.": "Bot entfernt.",
  "The report has no sections.": "Der Bericht hat keine Abschnitte.",
  "No repositories in this section.": "Keine Repositorys in diesem Abschnitt.",
  "Repository": "Repository",
  "Stars": "Sterne",
  "Created": "Erstellt",
  "Description": "Beschreibung",
  "How much of each subscription is used, how close it is to its limit, and when it resets. “Out of date” means the readings stopped coming in; one click sends a helper to fix it.":
    "Wie viel von jedem Abo verbraucht ist, wie nah es am Limit ist und wann es zurückgesetzt wird. „Veraltet“ heißt, dass keine Werte mehr hereinkommen; ein Klick schickt einen Helfer, der es repariert.",
  "Live tmux sessions (click one to open its terminal), every live Claude Code session including the desktop app's (message or stop it), and team-up runs with their mailbox (click a run for STATUS / PROMPT / RESULT).":
    "Laufende tmux-Sitzungen (klick eine an, um ihr Terminal zu öffnen), jede laufende Claude-Code-Sitzung samt denen der Desktop-App (schick ihr eine Nachricht oder stopp sie) und team-up-Aufträge mit ihrer Mailbox (klick einen Auftrag für STATUS / PROMPT / RESULT).",
  "Open tasks, ideas and bugs of every project in the folder. Start opens a session with the item as its prompt.":
    "Offene Aufgaben, Ideen und Fehler aller Projekte im Ordner. Starten öffnet eine Sitzung mit dem Eintrag als Prompt.",
  "Every role and its fallback chain. The outlined chip is what `team-up pick` would choose right now; faded chips are skipped right now (hover for why). Drag chips to reorder, drop a model from the roster to add it, ✕ to remove; dragging a chip onto another role copies it. ✎ sets effort and pinning. ⬆ marks a newer version, ✗ a model the CLI no longer offers.":
    "Jede Rolle mit ihrer Ersatzkette. Der umrandete Chip ist, was `team-up pick` gerade wählen würde; blasse Chips werden gerade übersprungen (Mauszeiger drauf zeigt warum). Zieh Chips zum Umsortieren, leg ein Modell aus dem Roster ab, um es hinzuzufügen, ✕ zum Entfernen; ein Chip auf eine andere Rolle gezogen wird kopiert. ✎ stellt Aufwand und Pinning ein. ⬆ markiert eine neuere Version, ✗ ein Modell, das die CLI nicht mehr anbietet.",
  "Every model in the roster, grouped by the CLI it runs on: the drag sources for the chains. Dashed: in no chain yet. Under “Add or remove models” each provider lists what it offers; a checked model is in the roster.":
    "Jedes Modell im Roster, gruppiert nach der CLI, auf der es läuft: die Quellen zum Ziehen in die Ketten. Gestrichelt: noch in keiner Kette. Unter „Modelle hinzufügen oder entfernen“ listet jeder Anbieter, was er anbietet; ein angehaktes Modell ist im Roster.",
  "How each provider authenticates: an API key team-up holds, a CLI's own login, or a key the CLI keeps itself.":
    "Wie sich jeder Anbieter anmeldet: mit einem API-Schlüssel, den team-up verwahrt, mit der eigenen Anmeldung einer CLI oder mit einem Schlüssel, den die CLI selbst aufbewahrt.",
  "New AI repositories on GitHub from the newest daily report of the hermes trending scraper (~/.hermes/cron-outputs/framework-scout). Pick a section; hover a description for all of it.":
    "Neue KI-Repositorys auf GitHub aus dem neuesten Tagesbericht des hermes-Trend-Scrapers (~/.hermes/cron-outputs/framework-scout). Wähl einen Abschnitt; fahr mit der Maus über eine Beschreibung, um sie ganz zu sehen.",
  "Agent CLIs: version, harness check, update, install and login. CLIs team-up can install but the roster does not run yet are rows you switch on in ✎. Hover a CLI name for its path; click a row for the job log.":
    "Agenten-CLIs: Version, Harness-Prüfung, Update, Installation und Anmeldung. CLIs, die team-up installieren kann, die das Roster aber noch nicht nutzt, sind Zeilen, die du über ✎ einblendest. Mauszeiger auf einen CLI-Namen zeigt ihren Pfad; ein Klick auf eine Zeile das Job-Log.",
  "Visible columns": "Sichtbare Spalten",
  "Visible rows": "Sichtbare Zeilen",
  "Nothing new.": "Nichts Neues.",
  // CLIs: harness check
  "unknown": "unbekannt",
  "installed, capabilities denied": "installiert, Rechte verweigert",
  // Scheduled jobs: AI tag
  "uses AI": "nutzt KI",
  "no AI": "ohne KI",
  // TIM memory: priority words
  "critical": "kritisch",
  "high": "hoch",
  "medium": "mittel",
  "low": "niedrig",
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

// Skipped with everything inside, their own attributes too: agent content, names, ids.
const I18N_SKIP = '[translate="no"], [data-no-i18n]';
// Only their text is skipped: a textarea's placeholder is still the page's own words.
const I18N_TEXT_SKIP = "code, pre, textarea, script, style";
const I18N_ATTRS = ["placeholder", "title", "aria-label"];

/** The dictionary key of a static text: trimmed, each run of whitespace one space. */
const i18nKey = (text) => text.trim().replace(/\s+/g, " ");

/**
 * Translate static markup under root once: text nodes and the placeholder,
 * title and aria-label attributes whose text (as i18nKey reads it) is a
 * dictionary key. A [translate="no"] or [data-no-i18n] subtree is left alone;
 * so is the text in code, pre and textarea. test/dashboard/i18n.test.mjs reads
 * index.html by the same rules.
 */
function translateStatic(root = document.body) {
  if (LANG === "en" || !root || (root.nodeType === 1 && root.matches(I18N_SKIP))) return;
  // The whole text between its outer whitespace, which stays.
  const swap = (text) => {
    const key = i18nKey(text);
    return key && Object.hasOwn(I18N_DE, key) ? text.replace(/^(\s*)[\s\S]*?(\s*)$/, (m, lead, tail) => lead + I18N_DE[key] + tail) : text;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const skip = n.nodeType === 1 ? n.matches(I18N_SKIP) : n.parentElement?.closest(I18N_TEXT_SKIP);
      return skip ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = root; n; n = walker.nextNode()) {
    if (n.nodeType === 3) n.nodeValue = swap(n.nodeValue);
    else if (n.nodeType === 1) {
      for (const a of I18N_ATTRS) if (n.hasAttribute(a)) n.setAttribute(a, swap(n.getAttribute(a)));
    }
  }
}
