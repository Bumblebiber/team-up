#!/usr/bin/python3
"""telegram-replies.py — act on Benni's replies to the team-up Telegram bots.

Runs as team-up-telegram-replies.service. Every few seconds it re-reads
~/.team-up/communication.json and calls getUpdates (timeout 0) on each bot whose
reply action is not "off" and that no other process owns. Per bot:
  bell  the reply lands in the dashboard's bell (notifications.json)
  run   the reply, with the message it quotes, goes to an LLM via ops-run.sh on
        the bot's cli:model in its working directory; the result is sent back
        as a reply. Each run is a detached `--handle FILE` child of this script.
Only messages from the bot's own chat id are acted on; everything else is
dropped. A bot polled for the first time skips its backlog. Status per bot
goes to ~/.team-up/telegram/poller.json for the dashboard.
"""
import json
import os
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
DIR = TU / "telegram"
REPO = Path(__file__).resolve().parent.parent
OPS_RUN = REPO / "scripts" / "ops-run.sh"
TICK = 3


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n")
    tmp.replace(path)


def read_env(file):
    out = {}
    for line in Path(file).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip().removeprefix("export ").strip()] = v.strip().strip('"')
    return out


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


def send(token, chat, text, reply_to=None):
    params = {"chat_id": chat, "text": text[:4000] or "(empty)"}
    if reply_to:
        params["reply_to_message_id"] = reply_to
        params["allow_sending_without_reply"] = "true"
    return api(token, "sendMessage", **params)


def bell(bot, msg):
    file = TU / "notifications.json"
    try:
        items = json.loads(file.read_text()).get("items", [])
    except (OSError, ValueError):
        items = []
    quoted = (msg.get("reply_to_message") or {}).get("text", "")
    text = msg.get("text", "") + (f"\n\n↳ on: {quoted[:300]}" if quoted else "")
    items.insert(0, {"id": f"tg-{bot['id']}-{msg['message_id']}", "at": now(), "read": False,
                     "key": f"telegram:{bot['id']}:{msg['message_id']}",
                     "title": f"Telegram reply to @{bot.get('username', bot['id'])}", "text": text[:2000]})
    write_json(file, {"items": items[:100]})


def prompt_for(bot, msg):
    quoted = (msg.get("reply_to_message") or {}).get("text") or "(he did not quote a message)"
    extra = bot["reply"].get("instructions") or ""
    return f"""Benni answered on Telegram, to the bot @{bot.get('username', bot['id'])} that delivers
team-up cron reports. The message he replied to:

<quoted>
{quoted}
</quoted>

His reply:

<reply>
{msg.get('text', '')}
</reply>

{extra}

Do what the reply asks if it is clear and safe to do from this working directory. Ask
before anything destructive or irreversible — say what you would do instead of doing it.
Your final answer is sent back to him on Telegram as plain text: German, at most 15 lines.
"""


def start_run(bot, msg, token, chat):
    jobs = DIR / "replies"
    jobs.mkdir(parents=True, exist_ok=True)
    base = jobs / f"{bot['id']}-{msg['message_id']}"
    base.with_suffix(".md").write_text(prompt_for(bot, msg))
    write_json(base.with_suffix(".json"), {"bot": bot, "message_id": msg["message_id"], "prompt": str(base.with_suffix(".md"))})
    send(token, chat, f"⏳ an {bot['reply']['model']} übergeben …", msg["message_id"])
    log = open(base.with_suffix(".log"), "ab")
    subprocess.Popen([sys.executable, __file__, "--handle", str(base.with_suffix(".json"))],
                     stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True,
                     env={**os.environ, "TEAMUP_WORKER": ""})


def handle(job_file):
    job = json.loads(Path(job_file).read_text())
    bot = job["bot"]
    env = read_env(bot["env"])
    r = bot["reply"]
    proc = subprocess.run([str(OPS_RUN), "--job", f"reply-{bot['id']}", "--model", r["model"], r["cwd"], job["prompt"]],
                          capture_output=True, text=True)
    out = proc.stdout.strip()
    if proc.returncode != 0:
        out = f"❌ fehlgeschlagen (exit {proc.returncode})\n\n{out or proc.stderr.strip()[-1500:]}"
    sent = send(env["TELEGRAM_BOT_TOKEN"], env.get("TELEGRAM_CHAT_ID"), out, job["message_id"])
    if not sent.get("ok"):
        print(f"send back failed: {sent.get('description')}\n{out}", file=sys.stderr)
    return proc.returncode


def poll_bot(bot):
    env = read_env(bot["env"])
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return "env file has no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID"
    off_file = DIR / "offsets" / bot["id"]
    first = not off_file.exists()
    offset = int(off_file.read_text()) if not first else 0
    res = api(token, "getUpdates", offset=offset, timeout=0)
    if not res.get("ok"):
        return res.get("description", "getUpdates failed")
    off_file.parent.mkdir(parents=True, exist_ok=True)
    off_file.write_text(str(offset))
    for u in res["result"]:
        # Offset first: a reply that crashes its handler is not acted on twice.
        offset = max(offset, u["update_id"] + 1)
        off_file.write_text(str(offset))
        msg = u.get("message")
        if first or not msg or str((msg.get("from") or {}).get("id")) != str(chat) or not msg.get("text"):
            continue
        if bot["reply"]["action"] == "bell":
            bell(bot, msg)
        elif bot["reply"]["action"] == "run":
            start_run(bot, msg, token, chat)
    return None


def loop():
    while True:
        try:
            cfg = json.loads((TU / "communication.json").read_text())
        except (OSError, ValueError):
            cfg = {}
        status = {}
        for bot in cfg.get("bots", []):
            if (bot.get("reply") or {}).get("action", "off") == "off" or bot.get("owner"):
                continue
            try:
                err = poll_bot(bot)
            except Exception as e:  # one broken bot must not stop the others
                err = str(e)[:300]
            status[bot["id"]] = {"ok": err is None, "error": err, "at": now()}
        write_json(DIR / "poller.json", {"at": now(), "bots": status})
        time.sleep(TICK)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--handle"]:
        sys.exit(handle(sys.argv[2]))
    loop()
