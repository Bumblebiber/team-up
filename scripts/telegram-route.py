#!/usr/bin/python3
"""telegram-route.py — which bot env file carries a cron job's Telegram message.

Called by ~/.hermes/bin/send-cron-telegram before every send:
    telegram-route.py [--job NAME] [--pid PID]
--job wins; else the sender is the script the process PID runs (its cmdline's
first *.sh / *.py argument, extension dropped: stale-runs.sh -> stale-runs).

Prints the env file of the bot ~/.team-up/communication.json routes that sender
to (dashboard → Communication), else the default bot's. Exit 1 and no output
when there is nothing to say (no config, broken config, env file gone): the
caller then sends the way it always did. Stdlib only — cron PATH has no node.
"""
import json
import os
import sys
from pathlib import Path


def sender_of(pid):
    try:
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return None
    args = [a.decode(errors="replace") for a in args if a]
    script = next((a for a in args if a.endswith((".sh", ".py"))), args[0] if args else None)
    if not script:
        return None
    name = os.path.basename(script)
    return name.rsplit(".", 1)[0] if name.endswith((".sh", ".py")) else name


def route(cfg, sender):
    bots = {b.get("id"): b for b in cfg.get("bots", [])}
    for bot_id in (cfg.get("routes", {}).get(sender), cfg.get("default")):
        env = bots.get(bot_id, {}).get("env")
        if env and os.path.isfile(env):
            return env
    return None


def main(argv):
    job = pid = None
    i = 0
    while i < len(argv):
        if argv[i] == "--job" and i + 1 < len(argv):
            job = argv[i + 1]; i += 2
        elif argv[i] == "--pid" and i + 1 < len(argv):
            pid = argv[i + 1]; i += 2
        else:
            i += 1
    home = Path(os.environ.get("TEAM_UP_HOME") or Path.home() / ".team-up")
    try:
        cfg = json.loads((home / "communication.json").read_text())
    except (OSError, ValueError):
        return 1
    sender = job or (sender_of(pid) if pid else None)
    env = route(cfg, sender)
    if os.environ.get("TEAMUP_ROUTE_DRY"):
        print(f"{sender} -> {env}", file=sys.stderr)
    if not env:
        return 1
    print(env)
    return 0


def _selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        a, b = Path(d, "a.env"), Path(d, "b.env")
        a.write_text("x"); b.write_text("x")
        cfg = {"default": "a", "bots": [{"id": "a", "env": str(a)}, {"id": "b", "env": str(b)}],
               "routes": {"stale-runs": "b", "gone": "zzz"}}
        assert route(cfg, "stale-runs") == str(b)
        assert route(cfg, "unknown") == str(a)
        assert route(cfg, "gone") == str(a)           # removed bot -> default
        assert route(cfg, None) == str(a)
        b.unlink()
        assert route(cfg, "stale-runs") == str(a)     # env file gone -> default
        a.unlink()
        assert route(cfg, "stale-runs") is None       # nothing left -> caller's own fallback
        assert sender_of(os.getpid()) == "telegram-route"
    print("ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        _selftest()
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))
