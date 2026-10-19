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
  "The language of this dashboard and of the questions agents ask you. Work between agents stays in English.":
    "Die Sprache dieses Dashboards und der Rückfragen, die dir Agenten stellen. Was Agenten untereinander austauschen, bleibt Englisch.",
  "Accounts": "Konten",
  "Every model belongs to an account. Switch one off and all its models drop out of every role chain until you switch it back on. The plan only tells the usage-spender how much spare work a night can buy; a credit account at 0 is blocked.":
    "Jedes Modell gehört zu einem Konto. Schaltest du eines ab, fallen alle seine Modelle aus jeder Rollenkette, bis du es wieder einschaltest. Der Tarif sagt nur dem Usage-Spender, wie viel übrige Arbeit eine Nacht hergibt; ein Guthaben-Konto bei 0 ist gesperrt.",
  "Usage limits": "Nutzungslimits",
  "What a running agent does as a subscription window fills up. Shares are of the window, e.g. 90 % of the weekly limit.":
    "Was ein laufender Agent tut, wenn sich ein Abo-Fenster füllt. Anteile beziehen sich auf das Fenster, z. B. 90 % des Wochenlimits.",
  "Workers & machine": "Agenten & Rechner",
  "How many agents may run at once on this server, and when idle ones are cleaned up.":
    "Wie viele Agenten auf diesem Server gleichzeitig laufen dürfen und wann untätige aufgeräumt werden.",
  "Usage collection": "Verbrauch erfassen",
  "Which subscriptions team-up watches and how often it reads their limits. The Usage panel on the overview shows what it collected.":
    "Welche Abos team-up beobachtet und wie oft es ihre Limits liest. Das Verbrauchs-Panel in der Übersicht zeigt, was dabei herauskam.",
  "Usage spender": "Usage-Spender",
  "At night, spare subscription quota is spent on PR reviews, audits and small fixes in your repos — paced so a weekly window is used up by its reset, never more. One task at a time.":
    "Nachts wird übriges Abo-Kontingent für PR-Reviews, Audits und kleine Fixes in deinen Repos verbraucht — so dosiert, dass ein Wochenfenster bis zu seinem Reset aufgebraucht ist, nie mehr. Eine Aufgabe nach der anderen.",
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
    "Zeiten der von Hermes geplanten Aufgaben (golden-task, Sicherheitsnetz für den Verbrauch)",
  "The Hermes cron daemon owns ~/.hermes/cron/jobs.json; their model is editable under Scheduled jobs.":
    "~/.hermes/cron/jobs.json gehört dem Hermes-Cron-Daemon; ihr Modell kannst du unter Geplante Aufgaben ändern.",

  // settings.mjs — when a change takes effect
  "Dashboard: now (the page reloads). Agents: runs started from now on.":
    "Dashboard: sofort (die Seite lädt neu). Agenten: für Aufträge, die ab jetzt starten.",
  "Next pick or dispatch.": "Bei der nächsten Modellwahl oder dem nächsten Auftragsstart.",
  "Within a minute (the usage watcher re-reads the roster every tick).":
    "Innerhalb einer Minute (der Usage-Watcher liest das Roster bei jedem Durchlauf neu).",
  "Next usage-spender tick (every 10 minutes).": "Beim nächsten Durchlauf des Usage-Spenders (alle 10 Minuten).",
  "Next cleanup sweep (`runs gc`, every 5 minutes).": "Beim nächsten Aufräumen (`runs gc`, alle 5 Minuten).",
  "Next telemetry sample.": "Bei der nächsten Telemetrie-Messung.",
  "Information for the usage-spender only.": "Nur eine Information für den Usage-Spender.",

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
  "For the dashboard and for the questions agents ask you. Results, code and messages between agents stay in English.":
    "Für das Dashboard und für die Rückfragen, die dir Agenten stellen. Ergebnisse, Code und Nachrichten zwischen Agenten bleiben auf Englisch.",
  "{id} (credit)": "{id} (Guthaben)",
  "{id} (subscription)": "{id} (Abo)",
  "Enabled": "Aktiv",
  "Credit left": "Restguthaben",
  "Plan": "Tarif",
  "not set": "nicht gesetzt",
  "Wrap-up warning at": "Warnung zum Abschließen bei",
  "At this share of a usage window a running agent is told to finish what it is doing.":
    "Ist dieser Anteil eines Nutzungsfensters verbraucht, soll ein laufender Agent zum Ende kommen.",
  "Hand off at": "Übergabe bei",
  "At this share the agent hands off and stops; the next model in its role chain takes over.":
    "Bei diesem Anteil übergibt der Agent und hört auf; das nächste Modell in der Kette seiner Rolle übernimmt.",
  "Hand off at (5-hour windows)": "Übergabe bei (5-Stunden-Fenster)",
  "The same for short windows (5 hours, sessions). They refill fast, so stopping earlier costs little.":
    "Dasselbe für kurze Fenster (5 Stunden, Sessions). Sie füllen sich schnell wieder auf, früher aufzuhören kostet also wenig.",
  "Look-ahead": "Vorausschau",
  "Routing projects a short window's burn rate this far ahead and skips a model that would run out. 0 turns the projection off.":
    "Die Modellwahl rechnet den Verbrauch eines kurzen Fensters so weit voraus und überspringt ein Modell, dem das Kontingent ausgehen würde. 0 schaltet die Vorausschau ab.",
  "Hand-off needs a reading younger than": "Übergabe braucht einen Messwert jünger als",
  "A hand-off that blocks a model only trusts a usage reading this fresh.":
    "Eine Übergabe, die ein Modell sperrt, traut nur einem so frischen Verbrauchs-Messwert.",
  "Max. parallel workers": "Max. gleichzeitige Agenten",
  "Hard cap on workers running at once. On auto, it is derived from memory telemetry.":
    "Feste Obergrenze für gleichzeitig laufende Agenten. Auf automatisch wird sie aus der Speicher-Telemetrie abgeleitet.",
  "auto": "automatisch",
  "Cap while telemetry is thin": "Obergrenze, solange Telemetrie fehlt",
  "Used on auto until enough worker samples exist to trust the derived cap.":
    "Gilt auf automatisch, bis genug Messwerte von Agenten da sind, um der abgeleiteten Obergrenze zu trauen.",
  "Stop idle worker sessions after": "Untätige Agenten-Sessions beenden nach",
  "A worker's terminal session that has been idle this long is closed.":
    "Die Terminal-Session eines Agenten, die so lange untätig war, wird geschlossen.",
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
  "Read limits every … while one agent runs": "Limits lesen alle … während ein Agent läuft",
  "Read limits every … while several run": "Limits lesen alle … während mehrere laufen",
  "How often each watched subscription's limits are read. Per-CLI overrides below win.":
    "Wie oft die Limits jedes beobachteten Abos gelesen werden. Die Einstellungen pro CLI weiter unten haben Vorrang.",
  "idle": "untätig",
  "active": "aktiv",
  "busy": "ausgelastet",
  "{cli} override": "Abweichend für {cli}",
  "Overrides the general pace for {cli} (reading codex and cursor is slow).":
    "Ersetzt den allgemeinen Takt für {cli} (codex und cursor auszulesen dauert lange).",
  "Watcher wakes every": "Watcher wacht auf alle",
  "How often the watcher checks which CLIs are running and which reading is due.":
    "Wie oft der Watcher prüft, welche CLIs laufen und welcher Messwert fällig ist.",
  "Dispatch wants a reading younger than": "Ein Auftragsstart will einen Messwert jünger als",
  "An older reading is refreshed before a worker starts.": "Ein älterer Messwert wird erneuert, bevor ein Agent startet.",
  "Spend the quota of": "Kontingent verbrauchen von",
  "Subscriptions whose spare quota may be spent. Untick all to switch the spender off.":
    "Abos, deren übriges Kontingent verbraucht werden darf. Nimm alle Häkchen raus, um den Spender abzuschalten.",
  "Start new tasks from": "Neue Aufgaben starten ab",
  "Local time the night starts. From here, one task after another until the quota target or the end time is reached.":
    "Ortszeit, zu der die Nacht beginnt. Ab hier startet eine Aufgabe nach der anderen, bis das Kontingent-Ziel oder die Endzeit erreicht ist.",
  "Start new tasks until": "Neue Aufgaben starten bis",
  "No new task starts from this time on; one already running finishes. Same as the start time = all day.":
    "Ab dieser Uhrzeit startet keine neue Aufgabe mehr; eine laufende wird noch fertig. Gleich wie die Startzeit = den ganzen Tag.",
  "Implement fixes": "Fixes umsetzen",
  "On: TIM tasks and GitHub issues are implemented in a throwaway clone and opened as pull requests. Off: reviews and triage only.":
    "An: TIM-Aufgaben und GitHub-Issues werden in einem Wegwerf-Klon umgesetzt und als Pull Request eröffnet. Aus: nur Reviews und Triage.",
  "Implementing model on {cli}": "Umsetzendes Modell auf {cli}",
  "Overrides the implementer role chain for spender runs only — spare quota can afford a stronger model.":
    "Ersetzt die Kette der Rolle implementer nur für Aufträge des Spenders — übriges Kontingent kann sich ein stärkeres Modell leisten.",
  "implementer role chain": "Kette der Rolle implementer",
  "Cancel a task after": "Aufgabe abbrechen nach",
  "A spender task still running after this long is cancelled so it cannot block the queue.":
    "Eine Aufgabe des Spenders, die nach dieser Zeit noch läuft, wird abgebrochen, damit sie die Warteschlange nicht blockiert.",
  "One task burns about": "Eine Aufgabe verbraucht etwa",
  "Share of a weekly window one task uses on the smallest paid plan. Raise it if the spender overshoots, lower it if quota is left over.":
    "Anteil eines Wochenfensters, den eine Aufgabe im kleinsten bezahlten Tarif verbraucht. Erhöhe ihn, wenn der Spender übers Ziel hinausschießt, senke ihn, wenn Kontingent übrig bleibt.",
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
  "Spends subscription quota that would otherwise expire unused. Every 10 minutes it holds each weekly window against a pacing curve; between its start and end time it starts one task after another — a PR review, a code audit, or a fix for a TIM task or GitHub issue in one of your repos. A task that needs a decision waits in the Action Center; once answered, it resumes the next night. A host session collects the results and reports via Telegram.":
    "Verbraucht Abo-Kontingent, das sonst ungenutzt verfallen würde. Alle 10 Minuten hält er jedes Wochenfenster gegen eine Verbrauchskurve; zwischen Start- und Endzeit startet er eine Aufgabe nach der anderen — ein PR-Review, ein Code-Audit oder einen Fix für eine TIM-Aufgabe oder ein GitHub-Issue in einem deiner Repos. Eine Aufgabe, die eine Entscheidung braucht, wartet im Posteingang; sobald du antwortest, geht sie in der nächsten Nacht weiter. Eine Host-Session sammelt die Ergebnisse ein und berichtet per Telegram.",
  "Each morning after a spend night: what the night's workers did and what is left for you.":
    "Jeden Morgen nach einer Spender-Nacht: was die Agenten in der Nacht erledigt haben und was für dich übrig bleibt.",
  "Uses subscription quota — on purpose, only what would reset unused anyway.":
    "Verbraucht Abo-Kontingent — absichtlich, und nur, was sonst ungenutzt zurückgesetzt würde.",
  "Model of the morning host that collects the results": "Modell des Morgen-Hosts, der die Ergebnisse einsammelt",
  "Untick every subscription under Settings → Usage spender, or switch the job off here.":
    "Nimm unter Einstellungen → Usage-Spender bei jedem Abo das Häkchen raus oder schalte die Aufgabe hier ab.",
  "Run insights": "Auswertung der Aufträge",
  "Reads the logs of all team-up runs every 48 hours and turns them into findings: failure reasons, stuck workers, slow paths. Only when the findings changed does an LLM judge them, write TIM entries, and prepare at most one fix — merged into main only if the tests pass in its clone.":
    "Liest alle 48 Stunden die Logs aller team-up-Aufträge und macht daraus Befunde: Fehlerursachen, hängende Agenten, langsame Wege. Nur wenn sich die Befunde geändert haben, beurteilt ein LLM sie, schreibt TIM-Einträge und bereitet höchstens einen Fix vor — der nur dann in main gemergt wird, wenn die Tests in seinem Klon durchlaufen.",
  "Every 48 h, only when the run logs show something new: findings and the one fix, if any.":
    "Alle 48 h, nur wenn die Logs etwas Neues zeigen: die Befunde und der eine Fix, falls es einen gibt.",
  "LLM only when the findings changed — at most one evaluation every 2 days.":
    "LLM nur, wenn sich die Befunde geändert haben — höchstens eine Auswertung alle 2 Tage.",
  "Model of the evaluator": "Modell der Auswertung",
  "Stop at the pull request (no auto-merge)": "Beim Pull Request anhalten (kein Auto-Merge)",
  "Usage watchdog": "Verbrauchswächter",
  "Checks every minute that usage readings keep coming in. A stalled collector, a limit that should have reset, an unexplained jump or repeated failed reads send a Telegram message; otherwise it stays silent.":
    "Prüft jede Minute, ob weiter Verbrauchswerte hereinkommen. Ein hängender Sammler, ein Limit, das sich hätte zurücksetzen sollen, ein unerklärter Sprung oder wiederholt fehlgeschlagenes Auslesen schicken eine Telegram-Nachricht; sonst bleibt er still.",
  "Only when usage readings stall or look wrong.": "Nur wenn Verbrauchswerte ausbleiben oder falsch aussehen.",
  "No LLM.": "Kein LLM.",
  "Stuck-run report": "Bericht über hängende Aufträge",
  "Lists team-up runs that are stuck — waiting on a human, a worker that died, a run that never started — and worker terminals that outlived their run, and sends them to Telegram. It never kills or cancels anything: whether someone is coming back is your call.":
    "Listet team-up-Aufträge, die hängen — sie warten auf einen Menschen, ihr Agent ist abgestürzt oder sie sind nie gestartet — und Agenten-Terminals, die ihren Auftrag überlebt haben, und schickt sie an Telegram. Er beendet und bricht nie etwas ab: Ob jemand zurückkommt, entscheidest du.",
  "Every 2 h, only while runs are stuck: which ones and why.": "Alle 2 h, nur solange Aufträge hängen: welche und warum.",
  "Report runs quiet for longer than": "Aufträge melden, die still sind seit mehr als",
  "Harness health": "Zustand des Harness",
  "Runs `team-up doctor` every 2 hours — CLI versions, capability grants, harness verification — and reports high findings. It exists because a silent claude self-update once revoked every specialist launch and nothing noticed.":
    "Führt alle 2 Stunden `team-up doctor` aus — CLI-Versionen, Capability-Freigaben, Harness-Prüfung — und meldet schwere Befunde. Es gibt ihn, weil ein stilles Selbst-Update von claude einmal jeden Spezialisten-Start verhindert hat und es niemand merkte.",
  "Every 2 h, only on high findings: a CLI update that broke launches or grants.":
    "Alle 2 h, nur bei schweren Befunden: ein CLI-Update, das Starts oder Freigaben kaputt gemacht hat.",
  "Model drift": "Modell-Drift",
  "Daily: scans which models each CLI offers, moves role chains onto the newest version of a model family the roster already runs (pinned entries stay), and reports roster models a CLI no longer offers.":
    "Täglich: prüft, welche Modelle jede CLI anbietet, stellt Rollenketten auf die neueste Version einer Modellfamilie um, die das Roster schon nutzt (festgepinnte Einträge bleiben), und meldet Roster-Modelle, die eine CLI nicht mehr anbietet.",
  "Daily, only when a model changed: chains moved to a newer version, or a model vanished.":
    "Täglich, nur wenn sich ein Modell geändert hat: Ketten auf eine neuere Version umgestellt oder ein Modell verschwunden.",
  "No LLM. Edits roster.json when a newer version ships.": "Kein LLM. Ändert roster.json, wenn eine neuere Version erscheint.",
  "Golden-task regression": "Golden-Task-Regressionstest",
  "Once a month a worker solves a fixed reference task in ~/projects/golden-task, so a CLI or model update that breaks real work shows up before it bites.":
    "Einmal im Monat löst ein Agent eine feste Referenzaufgabe in ~/projects/golden-task, damit ein CLI- oder Modell-Update, das echte Arbeit kaputt macht, auffällt, bevor es Schaden anrichtet.",
  "LLM: one run per month.": "LLM: ein Auftrag pro Monat.",
  "Model that solves the task": "Modell, das die Aufgabe löst",
  "The verdict of the monthly reference task: PASS, DRIFT or FAIL.": "Das Urteil der monatlichen Referenzaufgabe: PASS, DRIFT oder FAIL.",
  "Usage collector safety net": "Sicherheitsnetz für den Verbrauchssammler",
  "Daily at 04:00: collects usage itself if the watcher service has not managed to for more than 25 hours.":
    "Täglich um 04:00: sammelt den Verbrauch selbst, wenn der Watcher-Dienst es seit mehr als 25 Stunden nicht geschafft hat.",

  // automation.mjs — services and where a job is scheduled
  "Usage watcher": "Usage-Watcher",
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
  "TIM database header": "TIM-Datenbank-Header",
  "Every 15 min, only when the database header looks corrupt.": "Alle 15 min, nur wenn der Datenbank-Header beschädigt aussieht.",
  "TIM write-ahead log": "TIM-Write-Ahead-Log",
  "Hourly, only when the WAL file grew past 50 MB and was truncated.":
    "Stündlich, nur wenn die WAL-Datei über 50 MB gewachsen ist und gekürzt wurde.",
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
};
