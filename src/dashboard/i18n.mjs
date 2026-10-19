// Server-side text in the human's language: roster.json "language" ("en" or
// "de", missing = "en"). The English sentence is the key — t(lang, "daily at
// {time}", { time }) looks it up in DE and falls back to it, so a missing entry
// shows English, never a hole. Whole sentences only: never glue translated
// fragments together or change their case. A key may carry a context suffix
// ("Open|verb") when one English word needs two translations; English drops
// a trailing "|word".
//
// The browser side is public/i18n.js; agent-facing prompts stay English.

/** The roster's language, "en" when unset or unknown. */
export const langOf = (roster) => (roster?.language === "de" ? "de" : "en");

export function t(lang, en, vars) {
  const text = lang === "de" && Object.hasOwn(DE, en) ? DE[en] : en.replace(/\|\w+$/, "");
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, key) => (Object.hasOwn(vars, key) ? String(vars[key]) : m));
}

// Informal "du", sentence case. Paths, commands, unit names and ids stay as
// they are. Glossary: docs/specs/2026-10-19-dashboard-usability.md.
export const DE = {
  // settings.mjs — groups
  "General": "Allgemein",
  "The language of this dashboard and of the questions helpers ask you. Work between helpers stays in English.":
    "Die Sprache dieses Dashboards und der Rückfragen, die dir Helfer stellen. Was Helfer untereinander austauschen, bleibt Englisch.",
  "Accounts": "Konten",
  "Every AI model belongs to an account. Switch an account off and none of its models is used until you switch it back on. The plan only tells the usage spender how much spare work a night can buy; a credit account at 0 is blocked.":
    "Jedes KI-Modell gehört zu einem Konto. Schaltest du ein Konto ab, wird keines seiner Modelle mehr genutzt, bis du es wieder einschaltest. Der Tarif sagt nur dem Kontingent-Nutzer, wie viel übrige Arbeit eine Nacht hergibt; ein Guthaben-Konto bei 0 ist gesperrt.",
  "Usage limits": "Nutzungslimits",
  "What a running helper does as a subscription window fills up. Shares are of the window, e.g. 90 % of the weekly limit.":
    "Was ein laufender Helfer tut, wenn sich ein Abo-Fenster füllt. Anteile beziehen sich auf das Fenster, z. B. 90 % des Wochenlimits.",
  "Helpers & machine": "Helfer & Rechner",
  "How many helpers may run at once on this server, and when idle ones are closed.":
    "Wie viele Helfer auf diesem Server gleichzeitig laufen dürfen und wann untätige geschlossen werden.",
  "Usage collection": "Nutzung erfassen",
  "Which subscriptions team-up watches and how often it reads their limits. The Usage panel on the overview shows what it collected.":
    "Welche Abos team-up beobachtet und wie oft es ihre Limits liest. Das Panel „Nutzung“ in der Übersicht zeigt, was dabei herauskam.",
  "Usage spender": "Kontingent-Nutzer",
  "At night, spare subscription quota is spent on PR reviews, audits and small fixes in your repos — paced so a weekly window is used up by its reset, never more. One task at a time.":
    "Nachts wird übriges Abo-Kontingent für PR-Reviews, Audits und kleine Fixes in deinen Repos verbraucht — so dosiert, dass ein Wochenfenster bis zu seinem Reset aufgebraucht ist, nie mehr. Ein Auftrag nach dem anderen.",
  "Telemetry": "Telemetrie",
  "Memory and pressure samples every 30 seconds. They size the worker limit on auto and judge whether team-up caused a restart.":
    "Alle 30 Sekunden Messwerte zu Speicher und Speicherdruck. Sie bestimmen die Agenten-Obergrenze auf automatisch und beurteilen, ob team-up einen Neustart verursacht hat.",

  // settings.mjs — not editable here
  "CLI command templates (clis.*.cmd, clis.*.headless_cmd)": "Befehlsvorlagen der CLIs (clis.*.cmd, clis.*.headless_cmd)",
  "Whoever can edit them can run any command on this server. Edit ~/.team-up/roster.json by hand.":
    "Wer sie ändern kann, kann jeden Befehl auf diesem Server ausführen. Bearbeite ~/.team-up/roster.json von Hand.",
  "OpenRouter key file (openrouter.key_file)": "OpenRouter-Schlüsseldatei (openrouter.key_file)",
  "Pointing it at another file from the browser would read that file. Set the key under Providers.":
    "Zeigt sie vom Browser aus auf eine andere Datei, würde diese Datei gelesen. Setze den Schlüssel unter Anbieter.",
  "Per-model wiring (cli_model, reasoning, efforts, default effort, limit_windows)":
    "Verdrahtung pro Modell (cli_model, reasoning, efforts, default effort, limit_windows)",
  "Written by the model scan when a model is added under Roles & Models → Roster. Effort is set per role or per chain entry there; hand edits go in roster.json.":
    "Schreibt der Modell-Scan, wenn unter Rollen & Modelle → Roster ein Modell dazukommt. Den Aufwand (effort) stellst du dort pro Rolle oder pro Ketteneintrag ein; Handänderungen gehören in roster.json.",
  "Adding or removing accounts": "Konten hinzufügen oder entfernen",
  "An account is created with the first model that needs it. Edit roster.json for anything else.":
    "Ein Konto entsteht mit dem ersten Modell, das es braucht. Für alles andere bearbeite roster.json.",
  "Capability packages beyond one specialist (install, update, rollback, remove, --for host|all), specialist uninstall":
    "Capability-Pakete über einen Spezialisten hinaus (install, update, rollback, remove, --for host|all), Spezialisten deinstallieren",
  "They change what runs with which permissions on the whole host — `team-up capability …` / `team-up specialist uninstall` in a terminal.":
    "Sie ändern, was mit welchen Rechten auf dem ganzen Rechner läuft — `team-up capability …` / `team-up specialist uninstall` im Terminal.",
  "Background service installation (telemetry timer, cleanup timer, resume at boot)":
    "Hintergrunddienste einrichten (Telemetrie-Timer, Aufräum-Timer, Fortsetzen nach dem Booten)",
  "systemd units: `team-up telemetry install-timer`, `team-up runs gc-install`, `team-up runs resume-install`. Their state is shown under Scheduled jobs.":
    "systemd-Units: `team-up telemetry install-timer`, `team-up runs gc-install`, `team-up runs resume-install`. Ihren Zustand siehst du unter Geplante Aufgaben.",
  "Times of Hermes-scheduled jobs (golden-task, usage safety net)":
    "Zeiten der von Hermes geplanten Aufgaben (golden-task, Sicherheitsnetz für die Nutzungsabfrage)",
  "The Hermes cron daemon owns ~/.hermes/cron/jobs.json; their model is editable under Scheduled jobs.":
    "~/.hermes/cron/jobs.json gehört dem Hermes-Cron-Daemon; ihr Modell kannst du unter Geplante Aufgaben ändern.",

  // settings.mjs — when a change takes effect
  "Dashboard: now (the page reloads). Helpers: tasks started from now on.":
    "Dashboard: sofort (die Seite lädt neu). Helfer: für Aufträge, die ab jetzt starten.",
  "When the next task starts.": "Wenn der nächste Auftrag startet.",
  "Within a minute.": "Innerhalb einer Minute.",
  "Within 10 minutes.": "Innerhalb von 10 Minuten.",
  "At the next cleanup (every 5 minutes).": "Beim nächsten Aufräumen (alle 5 Minuten).",
  "Next telemetry sample.": "Bei der nächsten Telemetrie-Messung.",
  "Only the usage spender uses this.": "Zählt nur für den Kontingent-Nutzer.",

  // settings.mjs — why a value is refused
  "{label}: a value is required": "{label}: ein Wert ist nötig",
  "{label} must be on or off": "{label}: muss an oder aus sein",
  "{label} must be a number": "{label}: muss eine Zahl sein",
  "{label} must be a whole number": "{label}: muss eine ganze Zahl sein",
  "{label} must be above 0 %": "{label}: muss über 0 % liegen",
  "{label} must be at least {min}": "{label}: muss mindestens {min} sein",
  "{label} must be at most {max}": "{label}: darf höchstens {max} sein",
  "{label} is not one of the choices": "{label}: ist keine der angebotenen Möglichkeiten",
  "{label} must be a list": "{label}: muss eine Liste sein",
  "{label} lists a choice twice": "{label}: enthält eine Auswahl doppelt",
  "{label} lists an unknown choice": "{label}: enthält eine unbekannte Auswahl",
  "{label} needs at least {min}": "{label}: braucht mindestens {min}",
  "{label} has an unknown type": "{label}: hat einen unbekannten Typ",

  // settings.mjs — fields
  "Language": "Sprache",
  "For the dashboard and for the questions helpers ask you. Results, code and messages between helpers stay in English.":
    "Für das Dashboard und für die Rückfragen, die dir Helfer stellen. Ergebnisse, Code und Nachrichten zwischen Helfern bleiben auf Englisch.",
  "{id} (credit)": "{id} (Guthaben)",
  "{id} (subscription)": "{id} (Abo)",
  "Enabled": "Aktiv",
  "Credit left": "Restguthaben",
  "Plan": "Tarif",
  "not set": "nicht gesetzt",
  "Wrap-up warning at": "Warnung zum Abschließen bei",
  "At this share of a usage window a running helper is told to finish what it is doing.":
    "Ist dieser Anteil eines Nutzungsfensters verbraucht, soll ein laufender Helfer zum Ende kommen.",
  "Hand off at": "Übergabe bei",
  "At this share the helper hands its work over and stops; the next model on its role's list takes over.":
    "Bei diesem Anteil übergibt der Helfer seine Arbeit und hört auf; das nächste Modell auf der Liste seiner Rolle übernimmt.",
  "Hand off at (5-hour windows)": "Übergabe bei (5-Stunden-Fenster)",
  "The same for short windows (5 hours, sessions). They refill fast, so stopping earlier costs little.":
    "Dasselbe für kurze Fenster (5 Stunden, Sessions). Sie füllen sich schnell wieder auf, früher aufzuhören kostet also wenig.",
  "Look-ahead": "Vorausschau",
  "Routing projects a short window's burn rate this far ahead and skips a model that would run out. 0 turns the projection off.":
    "Die Modellwahl rechnet die Nutzung eines kurzen Fensters so weit voraus und überspringt ein Modell, dem das Kontingent ausgehen würde. 0 schaltet die Vorausschau ab.",
  "Hand-off needs a reading younger than": "Übergabe braucht einen Messwert jünger als",
  "A hand-off that blocks a model only trusts a usage reading this fresh.":
    "Eine Übergabe, die ein Modell sperrt, traut nur einem so frischen Nutzungs-Messwert.",
  "Max. helpers at once": "Max. gleichzeitige Helfer",
  "At most this many helpers run at once. On auto, team-up works the number out from how much memory they need.":
    "Höchstens so viele Helfer laufen gleichzeitig. Auf automatisch ermittelt team-up die Zahl aus ihrem Speicherbedarf.",
  "auto": "automatisch",
  "Limit until enough is measured": "Grenze, bis genug gemessen ist",
  "On auto, this limit applies until team-up has measured enough helpers to work out its own.":
    "Gilt auf automatisch, bis team-up genug Helfer gemessen hat, um selbst eine Grenze zu ermitteln.",
  "Close idle helpers after": "Untätige Helfer schließen nach",
  "A helper's terminal that has done nothing for this long is closed.":
    "Das Terminal eines Helfers, der so lange nichts getan hat, wird geschlossen.",
  "Memory to keep free": "Freizuhaltender Arbeitsspeicher",
  "A new worker only starts if at least this much memory stays available after it.":
    "Ein neuer Agent startet nur, wenn danach noch mindestens so viel Arbeitsspeicher frei bleibt.",
  "Refuse above memory pressure (some)": "Ablehnen ab Speicherdruck (some)",
  "No new worker while PSI memory 'some' (10 s average) is above this.":
    "Kein neuer Agent, solange PSI memory 'some' (Mittel über 10 s) darüber liegt.",
  "Refuse above memory pressure (full)": "Ablehnen ab Speicherdruck (full)",
  "No new worker while PSI memory 'full' (10 s average) is above this.":
    "Kein neuer Agent, solange PSI memory 'full' (Mittel über 10 s) darüber liegt.",
  "Samples before telemetry is trusted": "Messwerte, bevor der Telemetrie getraut wird",
  "Worker memory samples needed before auto derives the cap from them.":
    "So viele Speicher-Messwerte von Agenten braucht es, bevor automatisch die Obergrenze daraus abgeleitet wird.",
  "Watched subscriptions": "Beobachtete Abos",
  "CLIs whose usage windows are read and shown. An unwatched CLI still runs; its limits just go unchecked.":
    "CLIs, deren Nutzungsfenster gelesen und angezeigt werden. Eine nicht beobachtete CLI läuft trotzdem, nur ihre Limits prüft niemand.",
  "Read limits every … when nothing runs": "Limits lesen alle … wenn nichts läuft",
  "Read limits every … while one helper runs": "Limits lesen alle … während ein Helfer läuft",
  "Read limits every … while several run": "Limits lesen alle … während mehrere laufen",
  "How often each watched subscription's limits are read. Per-CLI overrides below win.":
    "Wie oft die Limits jedes beobachteten Abos gelesen werden. Die Einstellungen pro CLI weiter unten haben Vorrang.",
  "idle": "untätig",
  "active": "aktiv",
  "busy": "ausgelastet",
  "{cli} override": "Abweichend für {cli}",
  "Overrides the general pace for {cli} (reading codex and cursor is slow).":
    "Ersetzt den allgemeinen Takt für {cli} (codex und cursor auszulesen dauert lange).",
  "Watcher wakes every": "Nutzungsabfrage wacht auf alle",
  "How often the watcher checks which CLIs are running and which reading is due.":
    "Wie oft die Nutzungsabfrage prüft, welche CLIs laufen und welcher Messwert fällig ist.",
  "Dispatch wants a reading younger than": "Ein Auftragsstart will einen Messwert jünger als",
  "An older reading is refreshed before a worker starts.": "Ein älterer Messwert wird erneuert, bevor ein Agent startet.",
  "Spend the quota of": "Kontingent verbrauchen von",
  "Subscriptions whose spare quota may be spent. Untick all to switch the usage spender off.":
    "Abos, deren übriges Kontingent verbraucht werden darf. Nimm alle Häkchen raus, um den Kontingent-Nutzer abzuschalten.",
  "Start new tasks from": "Neue Aufträge starten ab",
  "Local time the night starts. From here, one task after another until the quota target or the end time is reached.":
    "Ortszeit, zu der die Nacht beginnt. Ab hier startet ein Auftrag nach dem anderen, bis das Kontingent-Ziel oder die Endzeit erreicht ist.",
  "Start new tasks until": "Neue Aufträge starten bis",
  "No new task starts from this time on; one already running finishes. Same as the start time = all day.":
    "Ab dieser Uhrzeit startet kein neuer Auftrag mehr; ein laufender wird noch fertig. Gleich wie die Startzeit = den ganzen Tag.",
  "Implement fixes": "Fixes umsetzen",
  "On: TIM tasks and GitHub issues are worked on in a separate copy of the repo and handed in as pull requests. Off: only reviews and sorting new issues.":
    "An: TIM-Aufgaben und GitHub-Issues werden in einer eigenen Kopie des Repos bearbeitet und als Pull Request eingereicht. Aus: nur Reviews und das Sortieren neuer Issues.",
  "Implementing model on {cli}": "Umsetzendes Modell auf {cli}",
  "Overrides the implementer role chain for spender runs only — spare quota can afford a stronger model.":
    "Ersetzt die Kette der Rolle implementer nur für Aufträge des Kontingent-Nutzers — übriges Kontingent kann sich ein stärkeres Modell leisten.",
  "implementer role chain": "Kette der Rolle implementer",
  "Cancel a task after": "Auftrag abbrechen nach",
  "A spender task still running after this long is cancelled so it cannot block the queue.":
    "Ein Auftrag des Kontingent-Nutzers, der nach dieser Zeit noch läuft, wird abgebrochen, damit sie die Warteschlange nicht blockiert.",
  "One task burns about": "Ein Auftrag verbraucht etwa",
  "Share of a weekly window one task uses on the smallest paid plan. Raise it if the spender overshoots, lower it if quota is left over.":
    "Anteil eines Wochenfensters, den ein Auftrag im kleinsten bezahlten Tarif verbraucht. Erhöhe ihn, wenn der Kontingent-Nutzer übers Ziel hinausschießt, senke ihn, wenn Kontingent übrig bleibt.",
  "Keep samples for": "Messwerte behalten für",
  "days": "Tage",
  "Restart verdict: free memory below": "Neustart-Urteil: freier Speicher unter",
  "A restart counts as memory-caused when free memory fell below this share.":
    "Ein Neustart gilt als vom Speicher verursacht, wenn der freie Speicher unter diesen Anteil fiel.",
  "Restart verdict: pressure (full) above": "Neustart-Urteil: Speicherdruck (full) über",
  "Restart verdict: team-up's share at least": "Neustart-Urteil: Anteil von team-up mindestens",
  "…and team-up held at least this share of used memory, it is blamed.":
    "…und hielt team-up dabei mindestens diesen Anteil des belegten Speichers, gilt team-up als Ursache.",

  // automation.mjs — built-in jobs
  "Spends subscription quota that would otherwise expire unused. Every 10 minutes it compares how much of each weekly limit is left with how much of the week is left; between its start and end time it starts one task after another — a PR review, a code audit, or a fix for a TIM task or GitHub issue in one of your repos. A task that needs a decision waits in the Inbox; once answered, it goes on the next night. In the morning the results are collected and reported via Telegram.":
    "Verbraucht Abo-Kontingent, das sonst ungenutzt verfallen würde. Alle 10 Minuten vergleicht er, wie viel von jedem Wochenlimit noch übrig ist, mit der verbleibenden Zeit der Woche; zwischen Start- und Endzeit startet er einen Auftrag nach dem anderen — ein PR-Review, ein Code-Audit oder einen Fix für eine TIM-Aufgabe oder ein GitHub-Issue in einem deiner Repos. Ein Auftrag, der eine Entscheidung braucht, wartet im Posteingang; sobald du antwortest, geht er in der nächsten Nacht weiter. Morgens werden die Ergebnisse eingesammelt und per Telegram gemeldet.",
  "Each morning after a night of spending: what the helpers did overnight and what is left for you.":
    "Jeden Morgen nach einer Nacht des Kontingent-Nutzers: was die Helfer in der Nacht erledigt haben und was für dich übrig bleibt.",
  "Uses subscription quota — on purpose, only what would reset unused anyway.":
    "Verbraucht Abo-Kontingent — absichtlich, und nur, was sonst ungenutzt zurückgesetzt würde.",
  "Model of the morning host that collects the results": "Modell des Morgen-Hosts, der die Ergebnisse einsammelt",
  "Untick every subscription under Settings → Usage spender, or switch the job off here.":
    "Nimm unter Einstellungen → Kontingent-Nutzer bei jedem Abo das Häkchen raus oder schalte die Aufgabe hier ab.",
  "Run insights": "Auswertung der Aufträge",
  "Reads the logs of all team-up tasks every 48 hours and turns them into findings: why tasks failed, helpers that got stuck, slow steps. Only when the findings changed does an AI model judge them, note them in TIM and prepare at most one fix — merged into main only if the tests pass in its own copy of the repo.":
    "Liest alle 48 Stunden die Logs aller team-up-Aufträge und macht daraus Befunde: warum Aufträge fehlschlugen, welche Helfer hängen blieben, welche Schritte langsam sind. Nur wenn sich die Befunde geändert haben, beurteilt ein KI-Modell sie, hält sie in TIM fest und bereitet höchstens einen Fix vor — der nur dann in main gemergt wird, wenn die Tests in seiner eigenen Kopie des Repos durchlaufen.",
  "Every 48 h, only when the logs show something new: findings and the one fix, if any.":
    "Alle 48 h, nur wenn die Logs etwas Neues zeigen: die Befunde und der eine Fix, falls es einen gibt.",
  "An AI model only when the findings changed — at most once every 2 days.":
    "Ein KI-Modell nur, wenn sich die Befunde geändert haben — höchstens einmal alle 2 Tage.",
  "Model of the evaluator": "Modell der Auswertung",
  "Stop at the pull request (no auto-merge)": "Beim Pull Request anhalten (kein Auto-Merge)",
  "Usage watchdog": "Nutzungswächter",
  "Checks every minute that usage readings keep coming in. Readings that stop, a limit that should have reset, an unexplained jump or reads that keep failing send a Telegram message; otherwise it stays silent.":
    "Prüft jede Minute, ob weiter Nutzungswerte hereinkommen. Werte, die ausbleiben, ein Limit, das sich hätte zurücksetzen sollen, ein unerklärter Sprung oder Abfragen, die immer wieder fehlschlagen, schicken eine Telegram-Nachricht; sonst bleibt er still.",
  "Only when usage readings stall or look wrong.": "Nur wenn Nutzungswerte ausbleiben oder falsch aussehen.",
  "No AI model.": "Kein KI-Modell.",
  "Stuck tasks report": "Bericht über hängende Aufträge",
  "Lists team-up tasks that are stuck — waiting for you, a helper that died, a task that never started — and helper terminals that outlived their task, and sends them to Telegram. It never stops or cancels anything: whether someone is coming back is your call.":
    "Listet team-up-Aufträge, die hängen — sie warten auf dich, ihr Helfer ist abgestürzt oder sie sind nie gestartet — und Helfer-Terminals, die ihren Auftrag überlebt haben, und schickt sie an Telegram. Er beendet und bricht nie etwas ab: Ob jemand zurückkommt, entscheidest du.",
  "Every 2 h, only while tasks are stuck: which ones and why.": "Alle 2 h, nur solange Aufträge hängen: welche und warum.",
  "Report runs quiet for longer than": "Aufträge melden, die still sind seit mehr als",
  "Health check": "Gesundheitscheck",
  "Every 2 hours it runs team-up doctor, a self-check of the AI tools: their versions, their permissions, and whether a specialist can still start. It reports serious findings. It exists because a silent update of claude once stopped every specialist from starting and nobody noticed.":
    "Führt alle 2 Stunden team-up doctor aus, einen Selbsttest der KI-Werkzeuge: ihre Versionen, ihre Rechte und ob ein Spezialist noch starten kann. Er meldet schwere Befunde. Es gibt ihn, weil ein stilles Update von claude einmal jeden Spezialisten am Starten gehindert hat und es niemand merkte.",
  "Every 2 h, only on serious findings: an update of an AI tool that stops specialists from starting.":
    "Alle 2 h, nur bei schweren Befunden: ein Update eines KI-Werkzeugs, das Spezialisten am Starten hindert.",
  "Model updates": "Modell-Updates",
  "Daily: checks which models each AI tool offers, moves roles onto the newest version of a model they already use (pinned entries stay), and reports models a tool no longer offers.":
    "Täglich: prüft, welche Modelle jedes KI-Werkzeug anbietet, stellt Rollen auf die neueste Version eines Modells um, das sie schon nutzen (festgepinnte Einträge bleiben), und meldet Modelle, die ein Werkzeug nicht mehr anbietet.",
  "Daily, only when a model changed: roles moved to a newer version, or a model disappeared.":
    "Täglich, nur wenn sich ein Modell geändert hat: Rollen auf eine neuere Version umgestellt oder ein Modell verschwunden.",
  "No AI model. Changes the model list when a newer version comes out.":
    "Kein KI-Modell. Ändert die Modellliste, wenn eine neuere Version erscheint.",
  "Monthly test task": "Monatliche Testaufgabe",
  "Once a month a helper solves the same reference task in ~/projects/golden-task, so an update of an AI tool or model that breaks real work shows up before it does harm.":
    "Einmal im Monat löst ein Helfer dieselbe Referenzaufgabe in ~/projects/golden-task, damit ein Update eines KI-Werkzeugs oder Modells, das echte Arbeit kaputt macht, auffällt, bevor es Schaden anrichtet.",
  "AI model: one task per month.": "KI-Modell: ein Auftrag pro Monat.",
  "Model that solves the task": "Modell, das die Aufgabe löst",
  "The verdict of the monthly reference task: PASS, DRIFT or FAIL.": "Das Urteil der monatlichen Referenzaufgabe: PASS, DRIFT oder FAIL.",
  "Usage collector safety net": "Sicherheitsnetz für die Nutzungsabfrage",
  "Daily at 04:00: reads the usage itself if the usage watcher has not managed to for more than 25 hours.":
    "Täglich um 04:00: liest die Nutzung selbst, wenn die Nutzungsabfrage es seit mehr als 25 Stunden nicht geschafft hat.",

  // automation.mjs — services and where a job is scheduled
  "Usage watcher": "Nutzungsabfrage",
  "Reads each subscription's limits on an adaptive schedule — faster while agents run.":
    "Liest die Limits jedes Abos in wechselndem Takt — schneller, während Agenten laufen.",
  "Cleanup": "Aufräumen",
  "Every 5 minutes: closes idle worker terminals and reaps runs whose worker is gone.":
    "Alle 5 Minuten: schließt untätige Agenten-Terminals und räumt Aufträge ab, deren Agent weg ist.",
  "Every 30 seconds: samples memory and pressure; sizes the worker limit.":
    "Alle 30 Sekunden: misst Speicher und Speicherdruck; bestimmt die Agenten-Obergrenze.",
  "Resume after boot": "Fortsetzen nach dem Booten",
  "After a reboot, wakes the sessions whose runs were still going.": "Weckt nach einem Neustart die Sessions, deren Aufträge noch liefen.",
  "Telegram replies": "Telegram-Antworten",
  "Acts on your replies to the bots that have a reply action (Communication page).":
    "Reagiert auf deine Antworten an die Bots, die eine Antwort-Aktion haben (Seite Kommunikation).",
  "Dashboard": "Dashboard",
  "This page.": "Diese Seite.",
  "Dashboard deploy": "Dashboard-Deploy",
  "Every 2 minutes: moves this page to origin/main and restarts it when main moved. Unmerged work never shows here.":
    "Alle 2 Minuten: bringt diese Seite auf den Stand von origin/main und startet sie neu, wenn main sich bewegt hat. Nicht gemergte Arbeit erscheint hier nie.",
  "Scheduled by the Hermes cron daemon (~/.hermes/cron/jobs.json) — change it there.":
    "Vom Hermes-Cron-Daemon geplant (~/.hermes/cron/jobs.json) — ändere es dort.",
  "Your crontab": "Deine Crontab",
  "Not in your crontab": "Nicht in deiner Crontab",

  // communication.mjs
  "TIM database check": "TIM-Datenbankprüfung",
  "Every 15 min, only when the database looks damaged.": "Alle 15 min, nur wenn die Datenbank beschädigt aussieht.",
  "TIM database size": "TIM-Datenbankgröße",
  "Hourly, only when TIM's working file grew past 50 MB and was trimmed.":
    "Stündlich, nur wenn die Arbeitsdatei von TIM über 50 MB gewachsen ist und gekürzt wurde.",
  "TIM backups": "TIM-Backups",
  "Hourly, only when the newest snapshot is older than 2 hours.": "Stündlich, nur wenn der neueste Snapshot älter als 2 Stunden ist.",
  "Its result after every run.": "Sein Ergebnis nach jedem Lauf.",
  "Test from the team-up dashboard (Communication).": "Test aus dem team-up-Dashboard (Kommunikation).",

  // cron-schedule.mjs — "am {day}." is the German ordinal; {suffix} is English only
  "invalid: {reason}": "ungültig: {reason}",
  "every minute": "jede Minute",
  "every {n} minutes": "alle {n} Minuten",
  "every hour at :{mm}": "stündlich zur Minute {mm}",
  "every {n} hours at :{mm}": "alle {n} Stunden zur Minute {mm}",
  "daily at {time}": "täglich um {time}",
  "every {days} at {time}": "jeden {days} um {time}",
  "weekdays at {time}": "montags bis freitags um {time}",
  "monthly on the {day}{suffix} at {time}": "am {day}. jedes Monats um {time}",

  // roles.mjs — why a role team-up's own code asks for cannot be deleted
  "The insights job and the usage spender make their fixes with this role, so it cannot be deleted.":
    "Die Auswertung der Aufträge und der Kontingent-Nutzer setzen ihre Fixes mit dieser Rolle um, deshalb kann sie nicht gelöscht werden.",
  "The usage spender's reviews and audits run on this role, so it cannot be deleted.":
    "Die Reviews und Audits des Kontingent-Nutzers laufen mit dieser Rolle, deshalb kann sie nicht gelöscht werden.",
  "The usage spender's research tasks run on this role, so it cannot be deleted.":
    "Die Recherche-Aufträge des Kontingent-Nutzers laufen mit dieser Rolle, deshalb kann sie nicht gelöscht werden.",
  "The usage spender sorts new issues with this role, so it cannot be deleted.":
    "Der Kontingent-Nutzer sortiert neue Issues mit dieser Rolle, deshalb kann sie nicht gelöscht werden.",
  "The observer that watches every running agent uses this role, so it cannot be deleted.":
    "Der Aufpasser, der jeden laufenden Agenten beobachtet, nutzt diese Rolle, deshalb kann sie nicht gelöscht werden.",

  // action-center.mjs — the subject of an inbox item the server words itself
  "Needs you: a credential or billing prompt": "Braucht dich: eine Abfrage zu Zugangsdaten oder Bezahlung",
  "Stuck on a technical prompt": "Hängt an einer technischen Abfrage fest",
  "Stuck on a technical prompt: {title}": "Hängt an einer technischen Abfrage fest: {title}",
  "{role} is waiting for your answer": "{role} wartet auf deine Antwort",
  "Failed|subject": "Fehlgeschlagen",
  "Stopped by the watcher": "Vom Aufpasser gestoppt",
  "Failed: {reason}": "Fehlgeschlagen: {reason}",
  "{role} finished": "{role} ist fertig",
};
