#!/usr/bin/python3
"""telegram.py — team-up's Telegram messages: send, listen for replies, answer.

  telegram.py send [--job NAME] [--pid PID] TEXT...
      Called by ~/.hermes/bin/send-cron-telegram for every cron report. TEXT is
      Telegram HTML (callers escape & < >). The sender is --job (or
      $TEAMUP_NOTIFY_JOB), else the script PID runs (stale-runs.sh ->
      stale-runs). ~/.team-up/communication.json routes it to a bot or to the
      dashboard bell (dashboard -> Communication). A footer names the cwd, CLI
      and session that wrote it: from $TEAMUP_NOTIFY_RUN's run, else
      $CLAUDE_CODE_SESSION_ID, else "script". Exit 1 = nothing sent; the shim
      then sends the old way through CronBot.
  telegram.py serve
      team-up-telegram-replies.service. Polls (getUpdates, timeout 0) the bots
      that listen and no other program owns. A message from the bot's own chat
      that quotes a footer with a claude session continues that session;
      anything else starts a new claude session. Each one runs detached as
      `telegram.py handle FILE`; the answer comes back as a reply, footer on.
  telegram.py --selftest

Stdlib only: cron's PATH has no node.
"""
import fcntl
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
TU = Path(os.environ.get("TEAM_UP_HOME") or HOME / ".team-up")
RUNS = Path(os.environ.get("TEAM_UP_RUNS") or TU / "runs")
DIR = TU / "telegram"
CLAUDE = os.environ.get("TEAMUP_CLAUDE_BIN") or str(HOME / ".local/bin/claude")
TICK = 3
REPLY_CEILING = 3600
MAX_TEXT = 4096
RULE = "──────────"
TERMINAL = {"done", "failed", "cancelled"}


def now():
    return datetime.now(timezone.utc).isoformat()


def tilde(p):
    p = str(p)
    return "~" + p[len(str(HOME)):] if p.startswith(str(HOME)) else p


def untilde(p):
    return str(HOME) + p[1:] if p.startswith("~") else p


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n")
    tmp.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def read_env(file):
    out = {}
    for line in Path(file).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip().removeprefix("export ").strip()] = v.strip().strip('"')
    return out


def load_cfg():
    return read_json(TU / "communication.json", {}) or {}


def roster_cli_model(model_id):
    """claude-opus -> opus (roster models.<id>.cli_model); unknown ids pass through."""
    spec = (read_json(TU / "roster.json", {}) or {}).get("models", {}).get(model_id) or {}
    return spec.get("cli_model") or model_id


# What Benni reads, in roster.json "language" (missing = en). The footer's
# 📂 🤖 🧵 lines are the reply contract (FOOT_RE) and stay as they are; an
# unknown session must never look like an id there (8+ id characters).
TEXT = {
    "en": {
        "language": "English",
        "script": "script",
        "no_session": "no session",
        "session_unknown": "session unknown",
        "reply_new": "↩️ A reply starts a new session",
        "reply_resumes": "↩️ A reply continues this session",
        "busy": "This session is still running{where} — I won't write into it. Reply again once it has finished.",
        "resuming": "⏳ continuing session <code>{session}…</code>",
        "cannot_resume": " (I can't continue the {cli} session)",
        "new_session": "⏳ new session: {model} in <code>{cwd}</code>{note}",
        "timed_out": "cancelled after {minutes} min",
        "no_answer": "(no answer)",
        "failed": "❌ failed",
        "message": "message",
    },
    "de": {
        "language": "German",
        "script": "Skript",
        "no_session": "keine Session",
        "session_unknown": "Session unbekannt",
        "reply_new": "↩️ Antwort startet eine neue Session",
        "reply_resumes": "↩️ Antwort setzt diese Session fort",
        "busy": "Diese Session läuft gerade noch{where} — ich schreibe nicht hinein. Antworte noch einmal, wenn sie fertig ist.",
        "resuming": "⏳ weiter in Session <code>{session}…</code>",
        "cannot_resume": " (die {cli}-Session kann ich nicht fortsetzen)",
        "new_session": "⏳ neue Session: {model} in <code>{cwd}</code>{note}",
        "timed_out": "nach {minutes} min abgebrochen",
        "no_answer": "(keine Antwort)",
        "failed": "❌ fehlgeschlagen",
        "message": "Nachricht",
    },
}


def language():
    lang = (read_json(TU / "roster.json", {}) or {}).get("language")
    return lang if lang in TEXT else "en"


def say(key, lang=None, **values):
    return TEXT[lang or language()][key].format(**values)


# ── Telegram API ──────────────────────────────────────────────────────────

def api(token, method, **params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except ValueError:
            return {"ok": False, "description": f"HTTP {e.code}"}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return {"ok": False, "description": str(e)}


def strip_html(text):
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def send_html(token, chat, text, reply_to=None):
    params = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    if reply_to:
        params["reply_to_message_id"] = reply_to
        params["allow_sending_without_reply"] = "true"
    res = api(token, "sendMessage", **params)
    if not res.get("ok") and "parse" in str(res.get("description", "")).lower():
        # A caller's unescaped < or a body cut inside an entity: send it plain.
        params.pop("parse_mode")
        params["text"] = strip_html(text)
        res = api(token, "sendMessage", **params)
    return res


# ── Footer: the contract between a message and a reply to it ──────────────

def footer_info(env=os.environ, cwd=None):
    """{cwd, cli, model, session} of whoever is sending, or {script}."""
    run = env.get("TEAMUP_NOTIFY_RUN", "").strip()
    if re.fullmatch(r"\d{8}T\d{6}Z-[a-z0-9]{4}", run):
        state = read_json(RUNS / run / "STATE.json", {}) or {}
        worker = state.get("worker") or {}
        session = (RUNS / run / "mailbox" / "SESSION_ID")
        sid = session.read_text().strip() if session.exists() else worker.get("sessionId")
        return {"cwd": state.get("cwd"), "cli": worker.get("cli"), "model": worker.get("model"), "session": sid}
    if env.get("CLAUDE_CODE_SESSION_ID"):
        return {"cwd": cwd or os.getcwd(), "cli": "claude", "model": None, "session": env["CLAUDE_CODE_SESSION_ID"]}
    return {"script": env.get("TEAMUP_NOTIFY_SCRIPT") or None}


def render_footer(info, listening, lang=None):
    e = html.escape
    lang = lang or language()
    if "script" in info:
        lines = [f"⚙️ {e(info['script'] or say('script', lang))} · {say('no_session', lang)}"]
        hint = say("reply_new", lang)
    else:
        lines = []
        if info.get("cwd"):
            lines.append(f"📂 <code>{e(tilde(info['cwd']))}</code>")
        lines.append(f"🤖 {e(info.get('cli') or '?')}" + (f" · {e(info['model'])}" if info.get("model") else ""))
        lines.append(f"🧵 <code>{e(info['session'])}</code>" if info.get("session") else f"🧵 {say('session_unknown', lang)}")
        hint = say("reply_resumes", lang) if info.get("session") and info.get("cli") == "claude" else say("reply_new", lang)
    return "\n".join([RULE, *lines, *([hint] if listening else [])])


FOOT_RE = re.compile(r"(?:📂 (?P<cwd>[^\n]+)\n)?🤖 (?P<cli>\S+)(?: · (?P<model>\S+))?\n🧵 (?P<session>[0-9A-Za-z-]{8,})")


def parse_footer(text):
    """The footer of a message as Telegram returns it (plain text, no HTML)."""
    tail = (text or "").rsplit(RULE, 1)
    if len(tail) < 2:
        return None
    m = FOOT_RE.search(tail[1])
    if not m:
        return None
    d = m.groupdict()
    return {"cwd": untilde(d["cwd"].strip()) if d["cwd"] else None, "cli": d["cli"], "model": d["model"], "session": d["session"]}


def with_footer(body, footer):
    room = MAX_TEXT - len(footer) - 40
    if len(body) > room:
        body = body[:room] + "\n…"
    return f"{body}\n\n{footer}"


# ── send ──────────────────────────────────────────────────────────────────

def sender_of(pid):
    try:
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return None, None
    args = [a.decode(errors="replace") for a in args if a]
    script = next((a for a in args if a.endswith((".sh", ".py"))), args[0] if args else None)
    if not script:
        return None, None
    name = os.path.basename(script)
    return (name.rsplit(".", 1)[0] if name.endswith((".sh", ".py")) else name), name


def destination(cfg, sender):
    """The bot (dict) or "bell" a sender's messages go to, then the fallbacks."""
    bots = {b.get("id"): b for b in cfg.get("bots", [])}
    out = []
    for dest in (cfg.get("routes", {}).get(sender), cfg.get("default")):
        if dest == "bell":
            out.append("bell")
        elif dest in bots and os.path.isfile(bots[dest].get("env", "")):
            out.append(bots[dest])
    return out


def ring_bell(title, text):
    file = TU / "notifications.json"
    items = (read_json(file, {}) or {}).get("items", [])
    stamp = now()
    items.insert(0, {"id": f"tg-{int(time.time() * 1000):x}", "at": stamp, "read": False,
                     "key": f"message:{title}:{stamp}", "title": title, "text": strip_html(text)[:4000]})
    write_json(file, {"items": items[:100]})


def cmd_send(argv):
    job = os.environ.get("TEAMUP_NOTIFY_JOB") or None
    pid = None
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] in ("--job", "--pid") and i + 1 < len(argv):
            job, pid = (argv[i + 1], pid) if argv[i] == "--job" else (job, argv[i + 1])
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    text = " ".join(rest) if rest else sys.stdin.read()
    if not text.strip():
        print("telegram.py send: no text", file=sys.stderr)
        return 2
    cfg = load_cfg()
    if not cfg:
        return 1
    script_key, script_name = sender_of(pid) if pid else (None, None)
    sender = job or script_key
    info = footer_info({**os.environ, "TEAMUP_NOTIFY_SCRIPT": script_name or job or ""})
    for dest in destination(cfg, sender):
        if dest == "bell":
            ring_bell(f"team-up: {sender or say('message')}", text)
            return 0
        env = read_env(dest["env"])
        chat = env.get("TELEGRAM_CHAT_ID") or any_chat(cfg)
        res = send_html(env.get("TELEGRAM_BOT_TOKEN", ""), chat, with_footer(text, render_footer(info, bool(dest.get("listen")))))
        if res.get("ok"):
            return 0
        print(f"telegram.py: @{dest.get('username')} failed: {res.get('description')}", file=sys.stderr)
    return 1


def any_chat(cfg):
    for b in cfg.get("bots", []):
        try:
            chat = read_env(b["env"]).get("TELEGRAM_CHAT_ID")
        except OSError:
            continue
        if chat:
            return chat
    return None


# ── serve: poll the listening bots ────────────────────────────────────────

def poll_bot(bot, cfg):
    env = read_env(bot["env"])
    token = env.get("TELEGRAM_BOT_TOKEN")
    chat = env.get("TELEGRAM_CHAT_ID") or any_chat(cfg)
    if not token or not chat:
        return "no TELEGRAM_BOT_TOKEN / chat id"
    me = token.split(":", 1)[0]
    off_file = DIR / "offsets" / bot["id"]
    first = not off_file.exists()
    offset = int(off_file.read_text() or 0) if not first else 0
    res = api(token, "getUpdates", offset=offset, timeout=0)
    if not res.get("ok"):
        return res.get("description", "getUpdates failed")
    off_file.parent.mkdir(parents=True, exist_ok=True)
    off_file.write_text(str(offset))
    for u in res["result"]:
        # Offset first: a reply whose handler crashes is not acted on twice.
        offset = max(offset, u["update_id"] + 1)
        off_file.write_text(str(offset))
        msg = u.get("message")
        if first or not msg or str((msg.get("from") or {}).get("id")) != str(chat) or not msg.get("text"):
            continue
        quoted = msg.get("reply_to_message") or {}
        target = parse_footer(quoted.get("text")) if str((quoted.get("from") or {}).get("id")) == me else None
        start_handler(bot, msg, quoted.get("text"), target, cfg)
    return None


def start_handler(bot, msg, quoted, target, cfg):
    jobs = DIR / "replies"
    jobs.mkdir(parents=True, exist_ok=True)
    base = jobs / f"{bot['id']}-{msg['message_id']}"
    write_json(base.with_suffix(".json"), {
        "bot": bot, "chat_id": msg["chat"]["id"], "message_id": msg["message_id"], "text": msg["text"],
        "quoted": quoted, "target": target, "replies": cfg.get("replies") or {},
    })
    log = open(base.with_suffix(".log"), "ab")
    env = {k: v for k, v in os.environ.items() if k not in ("TEAMUP_RUN_ID", "CLAUDE_CODE_SESSION_ID")}
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "handle", str(base.with_suffix(".json"))],
                     stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True,
                     env={**env, "TEAMUP_WORKER": ""})


def cmd_serve():
    while True:
        cfg = load_cfg()
        status = {}
        for bot in cfg.get("bots", []):
            if not bot.get("listen") or bot.get("owner"):
                continue
            try:
                err = poll_bot(bot, cfg)
            except Exception as e:  # one broken bot must not stop the others
                err = str(e)[:300]
            status[bot["id"]] = {"ok": err is None, "error": err, "at": now()}
        write_json(DIR / "poller.json", {"at": now(), "bots": status})
        time.sleep(TICK)


# ── handle: one reply ─────────────────────────────────────────────────────

def pid_alive(pid, start):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    return start is None or stat.rsplit(")", 1)[1].split()[19] == str(start)


def live_session(session):
    """The session record of a still-running process holding `session`, if any."""
    for f in (TU / "sessions").glob("*.json"):
        rec = read_json(f, {}) or {}
        if rec.get("session_id") == session and pid_alive(rec.get("pid"), rec.get("pid_start")):
            return rec
    return None


def finished_worker_tmux(tmux):
    """True when `tmux` is the terminal of a team-up run that has ended."""
    if not tmux or not tmux.startswith("team-up-"):
        return False
    for state_file in RUNS.glob("*/STATE.json"):
        state = read_json(state_file, {}) or {}
        if (state.get("worker") or {}).get("tmux") == tmux:
            return state.get("status") in TERMINAL
    return False


def free_session(session):
    """None when the session can be resumed now, else why not (for Benni, in his language)."""
    rec = live_session(session)
    if not rec:
        return None
    if finished_worker_tmux(rec.get("tmux")):
        # The run is over and its terminal idles: close it like `runs gc` would,
        # so two processes never write one transcript.
        subprocess.run(["tmux", "kill-session", "-t", f"={rec['tmux']}"], capture_output=True)
        for _ in range(20):
            if not pid_alive(rec.get("pid"), rec.get("pid_start")):
                return None
            time.sleep(0.5)
    where = f" (tmux {rec['tmux']})" if rec.get("tmux") else ""
    return say("busy", where=where)


RESUME_FRAME = """[Telegram] Benni replied on Telegram to your last message. If you were a team-up
worker: that job is over — do not touch its mailbox (no RESULT.md, STATUS, runs collect).
Ask before anything destructive or irreversible. Your final message is sent back to him:
{language}, plain text, at most 15 lines.

His reply:
{text}"""

NEW_PROMPT = """Benni wrote on Telegram to the bot @{bot}, which delivers team-up and TIM reports.
{quoted}His message:

<message>
{text}
</message>

{extra}
Do what he asks if it is clear and safe from this working directory. Ask before anything
destructive or irreversible — say what you would do instead of doing it. Your final message
is sent back to him on Telegram: {language}, plain text, at most 15 lines."""


def claude(args, cwd):
    proc = subprocess.run([CLAUDE, "-p", "--output-format", "json", "--dangerously-skip-permissions", *args],
                          cwd=cwd, capture_output=True, text=True, timeout=REPLY_CEILING)
    try:
        out = json.loads(proc.stdout)
    except ValueError:
        out = {"is_error": True, "result": (proc.stdout or proc.stderr).strip()[-1500:]}
    if isinstance(out, list):  # some claude builds print every event; the last "result" is the answer
        out = next((e for e in reversed(out) if isinstance(e, dict) and e.get("type") == "result"), {"is_error": True})
    if proc.returncode != 0:
        out["is_error"] = True
    return out


def cmd_handle(job_file):
    job = json.loads(Path(job_file).read_text())
    bot, target, cfg_r = job["bot"], job.get("target"), job.get("replies") or {}
    env = read_env(bot["env"])
    token, chat, reply_to = env["TELEGRAM_BOT_TOKEN"], job["chat_id"], job["message_id"]
    resume = bool(target and target.get("cli") == "claude" and target.get("session"))
    if resume:
        cwd, model = target.get("cwd") or str(HOME), target.get("model")
        why = free_session(target["session"])
        if why:
            send_html(token, chat, html.escape(why), reply_to)
            return 0
        send_html(token, chat, say("resuming", session=html.escape(target["session"][:8])), reply_to)
    else:
        cwd = untilde(cfg_r.get("cwd") or str(HOME / "projects/team-up"))
        model = (cfg_r.get("model") or "claude:claude-sonnet").split(":", 1)[-1]
        note = say("cannot_resume", cli=html.escape(target["cli"])) if target else ""
        send_html(token, chat, say("new_session", model=html.escape(model), cwd=html.escape(tilde(cwd)), note=note), reply_to)
    lock = DIR / "locks" / f"{(target or {}).get('session') or 'new'}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with open(lock, "w") as fh:
        if resume:
            fcntl.flock(fh, fcntl.LOCK_EX)  # one answer at a time per session
        args = ["--model", roster_cli_model(model)] if model else []
        try:
            if resume:
                out = claude([*args, "--resume", target["session"],
                              RESUME_FRAME.format(text=job["text"], language=say("language"))], cwd)
            else:
                quoted = f"The message he replied to:\n\n<quoted>\n{job['quoted']}\n</quoted>\n\n" if job.get("quoted") else ""
                prompt = NEW_PROMPT.format(bot=bot.get("username", bot["id"]), quoted=quoted, text=job["text"],
                                           extra=cfg_r.get("instructions") or "", language=say("language"))
                out = claude([*args, prompt], cwd)
        except subprocess.TimeoutExpired:
            out = {"is_error": True, "result": say("timed_out", minutes=REPLY_CEILING // 60)}
    body = html.escape(str(out.get("result") or say("no_answer")))
    if out.get("is_error"):
        body = f"{say('failed')}\n\n{body}"
    info = {"cwd": cwd, "cli": "claude", "model": model, "session": out.get("session_id") or (target or {}).get("session")}
    res = send_html(token, chat, with_footer(body, render_footer(info, True)), reply_to)
    if not res.get("ok"):
        print(f"send back failed: {res.get('description')}", file=sys.stderr)
    return 0 if not out.get("is_error") else 1


# ── self-test ─────────────────────────────────────────────────────────────

def selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        a, b = Path(d, "a.env"), Path(d, "b.env")
        a.write_text("x"); b.write_text("x")
        cfg = {"default": "a", "bots": [{"id": "a", "env": str(a)}, {"id": "b", "env": str(b)}],
               "routes": {"stale-runs": "b", "gone": "zzz", "quiet": "bell"}}
        ids = lambda xs: [x if x == "bell" else x["id"] for x in xs]
        assert ids(destination(cfg, "stale-runs")) == ["b", "a"]
        assert ids(destination(cfg, "unknown")) == ["a"]
        assert ids(destination(cfg, "gone")) == ["a"]            # removed bot -> default
        assert ids(destination(cfg, "quiet")) == ["bell", "a"]
        b.unlink()
        assert ids(destination(cfg, "stale-runs")) == ["a"]      # env file gone -> default
        assert ids(destination({**cfg, "default": "bell"}, "x")) == ["bell"]
    assert sender_of(os.getpid())[0] == "telegram"

    # Footer round trip, as Telegram hands the quoted text back: HTML gone.
    info = {"cwd": str(HOME / "projects/team-up"), "cli": "claude", "model": "claude-opus",
            "session": "8b29ac88-269e-4593-af6e-1606997c5448"}
    sent = with_footer("Bericht <b>x</b> &amp; y", render_footer(info, True))
    back = parse_footer(strip_html(sent))
    assert back == info, back
    assert parse_footer(strip_html(with_footer("x", render_footer({"cwd": "/w", "cli": "codex", "model": None, "session": "abc12345"}, False)))) \
        == {"cwd": "/w", "cli": "codex", "model": None, "session": "abc12345"}
    assert parse_footer(strip_html(with_footer("x", render_footer({"script": "stale-runs.sh"}, True)))) is None
    assert parse_footer("no footer here") is None
    # Every language: the same keys, the same round trip, and no footer
    # without a session parses as one (a reply would resume a made-up id).
    assert all(TEXT[lang].keys() == TEXT["en"].keys() for lang in TEXT)
    unknown = {"cwd": "/w", "cli": "claude", "model": None, "session": None}
    for lang in TEXT:
        assert parse_footer(strip_html(with_footer("x", render_footer(info, True, lang)))) == info, lang
        assert parse_footer(strip_html(with_footer("x", render_footer(unknown, True, lang)))) is None, lang
    # Footers sent before the language setting still parse.
    old = f"Bericht\n\n{RULE}\n📂 ~/projects/team-up\n🤖 claude · claude-opus\n🧵 8b29ac88-269e-4593-af6e-1606997c5448\n" \
          "↩️ Antwort setzt diese Session fort"
    assert parse_footer(old) == info, parse_footer(old)
    long = with_footer("y" * 9000, render_footer(info, True))
    assert len(long) <= MAX_TEXT and long.endswith(render_footer(info, True))
    print("ok")


if __name__ == "__main__":
    cmd = sys.argv[1:2]
    if cmd == ["--selftest"]:
        selftest()
    elif cmd == ["send"]:
        sys.exit(cmd_send(sys.argv[2:]))
    elif cmd == ["serve"]:
        cmd_serve()
    elif cmd == ["handle"] and len(sys.argv) == 3:
        sys.exit(cmd_handle(sys.argv[2]))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(64)
