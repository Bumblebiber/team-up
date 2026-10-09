#!/usr/bin/env python3
"""usage-spender: spend weekly subscription quota that would otherwise reset unused.

Daily cron (00:00). Reads team-up's live quota windows (usage.json, refreshed every ~5 min by
the usage watcher), decides whether a weekly window will reset with paid capacity unused, and
spawns at most MAX_SPAWNS read-only team-up workers on that CLI (runs create + dispatch).
A cron cannot wait, so on spawn nights it also starts one host session in tmux: the parent of
those runs. The tmux shell first waits for the runs (`--await`), then starts the host CLI chosen
in ~/.team-up/cron-jobs.ini [usage-spender-host] (scripts/usage-spender-host.md): it records the
runs in TIM, does intake, collects, exits. Workers never write memory; the host does.

  scripts/usage-spender.py              cron mode: decide, spawn, write <day>/decision.json
  scripts/usage-spender.py --dry-run    decide only: no spawn, no writes
  scripts/usage-spender.py --await <run_id>...   (inside the host tmux) wait, answer once, cancel
  scripts/usage-spender.py --selftest
"""
import configparser
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
REPO = Path(__file__).resolve().parents[1]
ENV = os.environ
TU_HOME = Path(ENV.get("TEAM_UP_HOME") or HOME / ".team-up")
# Same precedence as src/paths.mjs and usage-collect-cron.sh.
USAGE = Path(ENV.get("TEAM_UP_USAGE") or ENV.get("O9K_USAGE") or TU_HOME / "usage.json")
ROSTER = Path(ENV.get("TEAM_UP_ROSTER") or ENV.get("O9K_ROSTER") or TU_HOME / "roster.json")
# The entry point directly, not `team-up`: a cron PATH may lack nvm's bin.
TEAMUP = ["node", str(REPO / "bin/team-up.mjs")]
OUT_ROOT = Path(ENV.get("TEAM_UP_REPORT_DIR") or ENV.get("O9K_REPORT_DIR") or TU_HOME / "reports") / "usage-spender"
PROJECTS = HOME / "projects"
HOST_CWD = REPO  # .tim-project -> P0073; the host session binds there
CRON_JOBS = TU_HOME / "cron-jobs.ini"
HOST_DEFAULT = "claude:claude-opus"

# Tuning knobs.
HORIZON_H = 30            # a window counts only if it resets within this many hours
ONE_TASK_MAX_USED = 0.6   # used <= this -> 1 task
TWO_TASKS_MAX_USED = 0.3  # used <= this -> 2 tasks
BUSY_BURST_USED = 0.8     # burst window this full -> someone is working on that CLI, leave it alone
MAX_AGE_H = 6             # older usage reading counts as unknown -> no spawn
MAX_SPAWNS = 2            # per run, across all windows
ACTIVE_DAYS = 7           # target repos: committed to within this many days

# weekly window -> (cli, its burst window, task pool in priority order as (task, team-up role))
WINDOWS = {
    "claude:week": ("claude", "claude:session",
                    [("contrary-review", "reviewer"), ("framework-research", "researcher")]),
    "codex:weekly": ("codex", "codex:5h",
                     [("code-audit", "reviewer"), ("framework-research", "researcher")]),
}

TASKS = {
    "contrary-review": "Contrary review of the last {days} days of commits in {repo} "
                       "(`git log --since={days}.days`). Argue against the design choices; find edge "
                       "cases, hidden coupling and failure modes the authors missed.",
    "code-audit": "Audit {repo} for bugs and missing tests in code changed in the last {days} days "
                  "(`git log --since={days}.days`).",
    "framework-research": "Find maintained open-source libraries or native platform features that could "
                          "replace hand-rolled code in {repo}. Web research allowed; cite links.",
}
HOST_PROMPT = (REPO / "scripts/usage-spender-host.md").read_text()
HOST_ALLOW = ["Read", "Grep", "Glob", "Skill", "mcp__tim", "Bash(git -C:*)", "Bash(git log:*)", "Bash(git show:*)",
              f"Bash({' '.join(TEAMUP)} runs:*)", "Bash(tmux kill-session -t usage-spender-host-:*)"]
WAIT_CEILING_S = 7200     # per `runs wait`; two rounds = the 4 h a run gets
NO_HUMAN = "No human available. Finish with what you have."
RULES = ("\n\nRead-only: do not edit, commit or push anything in {repo}. Report at most 15 findings, "
         "each with file:line evidence (or a link) and a severity, most severe first.\n")


def hours_until(iso, now):
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) - now).total_seconds() / 3600


def decide(usage, now):
    """Pure. -> ({window: verdict}, [(window, n_tasks, used)] emptiest first)."""
    windows = usage.get("windows", {})
    verdicts, wanted = {}, []
    for key, (_cli, burst, _pool) in WINDOWS.items():
        w = windows.get(key) or {}
        used, resets, seen = w.get("used"), w.get("resets_at"), w.get("updated_at") or w.get("updated")
        if not isinstance(used, (int, float)) or not resets or not seen:
            verdicts[key] = "no data"
            continue
        age, left = -hours_until(seen, now), hours_until(resets, now)
        burst_used = (windows.get(burst) or {}).get("used")
        if age > MAX_AGE_H:
            verdicts[key] = f"stale reading ({age:.0f}h old)"
        elif not 0 < left <= HORIZON_H:
            verdicts[key] = f"resets in {left:.0f}h, outside {HORIZON_H}h horizon"
        elif isinstance(burst_used, (int, float)) and burst_used >= BUSY_BURST_USED:
            verdicts[key] = f"busy ({burst} at {burst_used:.0%})"
        elif used > ONE_TASK_MAX_USED:
            verdicts[key] = f"used {used:.0%}, nothing to rescue"
        else:
            n = 2 if used <= TWO_TASKS_MAX_USED else 1
            verdicts[key] = f"spawn {n}: used {used:.0%}, resets in {left:.0f}h"
            wanted.append((key, n, used))
    wanted.sort(key=lambda x: x[2])
    return verdicts, wanted


def pin(roster, role, cli):
    """First entry of the roster's chain for role that runs on cli, as 'cli:model'."""
    for e in roster["roles"][role]["chain"]:
        c, m = e.split(":", 1) if isinstance(e, str) else (e.get("cli"), e.get("model"))
        if c == cli:
            return f"{c}:{m}"
    return None


def active_repos(now):
    """Repos under ~/projects by last commit time, newest first, within ACTIVE_DAYS."""
    found = []
    for git in PROJECTS.glob("*/.git"):
        r = subprocess.run(["git", "-C", str(git.parent), "log", "-1", "--format=%ct"],
                           capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            ts = int(r.stdout.strip())
            if now.timestamp() - ts <= ACTIVE_DAYS * 86400:
                found.append((ts, git.parent))
    return [p for _, p in sorted(found, reverse=True)]


def plan(wanted, roster, repos):
    # ponytail: no cross-day memory. Two qualifying nights in a row can send the same task to the
    # same repo while the first run is still open. Add a check against open #usage-spender runs if that happens.
    actions = []
    for key, n, used in wanted:
        cli, _burst, pool = WINDOWS[key]
        for task, role in pool[:n]:
            if len(actions) >= MAX_SPAWNS or len(actions) >= len(repos):
                return actions
            model = pin(roster, role, cli)
            if model:  # roster has no entry for this CLI in that role -> skip, never vibe-pick
                actions.append({"window": key, "used": used, "task_type": task, "role": role,
                                "cli": cli, "model": model, "repo": str(repos[len(actions)])})
    return actions


def teamup(*args, timeout=600):
    try:
        return subprocess.run([*TEAMUP, *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", f"team-up timed out after {timeout}s")


def cron_model(job, default, path=CRON_JOBS):
    """'cli:model' for job from cron-jobs.ini, else default."""
    ini = configparser.ConfigParser()
    ini.read(path)
    value = ini.get(job, "model", fallback="").strip()
    return value if ":" in value else default


def spawn(a, day_dir, host, host_cli):
    """runs create + dispatch --run-id, parent = the host tmux. Fills a['run_id'] / a['spawned'] / a['error']."""
    prompt = day_dir / f"{a['task_type']}-{Path(a['repo']).name}.md"
    prompt.write_text(TASKS[a["task_type"]].format(repo=a["repo"], days=ACTIVE_DAYS) + RULES.format(repo=a["repo"]))
    model = a["model"].split(":", 1)[1]
    r = teamup("runs", "create", "--cwd", a["repo"], "--role", a["role"], "--worker-cli", a["cli"],
               "--worker-model", model, "--prompt-file", str(prompt),
               "--parent-cli", host_cli, "--parent-attach", "tmux", "--parent-tmux", host)
    run_id = next((ln.split()[1] for ln in r.stdout.splitlines() if ln.startswith("runId:")), None)
    if r.returncode or not run_id:
        a.update(spawned=False, error=f"runs create rc={r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")
        return
    a["run_id"] = run_id
    r = teamup("dispatch", "--role", a["role"], "--prompt-file", str(prompt), "--dir", a["repo"],
               "--run-id", run_id, "--model", a["model"])
    if r.returncode:  # 2 = pinned model blocked by quota, 3 = admission refused (machine full)
        teamup("runs", "cancel", run_id)
        a.update(spawned=False, error=f"dispatch rc={r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")
    else:
        a["spawned"] = True


def host_prompt(spawned, date, host):
    runs = "\n".join(f"- {a['run_id']}: {a['task_type']} on {a['repo']} ({a['model']}, role {a['role']})"
                     for a in spawned)
    return HOST_PROMPT.format(date=date, teamup=" ".join(TEAMUP), runs=runs, host=host)


def next_step(status, answered):
    """Pure. What --await does after a decided `runs wait`: 'answer' | 'cancel' | 'stop'."""
    if status == "question":
        return "cancel" if answered else "answer"
    return "stop"


def await_runs(run_ids):
    """Wait in the shell, so the host CLI needs no background tool: it starts on finished runs.
    A question gets one canned answer; a second one cancels. A run still going after two
    ceilings stays open for the host to record as unfinished."""
    for run_id in run_ids:
        answered, ceilings = False, 0
        while ceilings < 2:
            r = teamup("runs", "wait", run_id, "--ceiling-sec", str(WAIT_CEILING_S), timeout=WAIT_CEILING_S + 300)
            status = next((ln.split(":", 1)[1].strip() for ln in r.stdout.splitlines() if ln.startswith("status:")), "")
            if r.returncode == 2 or status == "watching":
                ceilings += 1
                continue
            step = next_step(status, answered)
            if step == "answer":
                teamup("runs", "answer", run_id, "--text", NO_HUMAN)
                answered = True
            elif step == "cancel":
                teamup("runs", "cancel", run_id)
                break
            else:
                break


def host_argv(built, cli, settings):
    """Pure. The roster's argv for the host CLI; claude swaps the blanket permission flag for the
    host's allow-list settings."""
    if cli != "claude":
        return built
    argv = [a for a in built if a != "--dangerously-skip-permissions"]
    return [argv[0], "--settings", str(settings), *argv[1:]]


def build_command(model, prompt):
    """team-up's own argv builder (roster template, CLI model alias, codex trust) for model 'cli:model'."""
    cli, mid = model.split(":", 1)
    js = ("const [p, r, m, c, t, d] = process.argv.slice(1); const { buildCommand } = await import(p);"
          "const fs = await import('node:fs'); console.log(JSON.stringify(buildCommand("
          "{ roster: JSON.parse(fs.readFileSync(r, 'utf8')), model: m, cli: c, prompt: t, dir: d })));")
    r = subprocess.run(["node", "--input-type=module", "-e", js, str(REPO / "src/roster/command.mjs"),
                        str(ROSTER), mid, cli, prompt, str(HOST_CWD)], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"buildCommand for {model}: {r.stderr.strip()[-300:]}")
    return json.loads(r.stdout)


def start_host(spawned, day_dir, host, model):
    """Host tmux: wait for the runs, then the chosen CLI follows host.md. Returns an error string or None."""
    prompt, settings, script = day_dir / "host.md", day_dir / "host-settings.json", day_dir / "host.sh"
    prompt.write_text(host_prompt(spawned, day_dir.name, host))
    settings.write_text(json.dumps({"permissions": {"allow": HOST_ALLOW}}, indent=2) + "\n")
    try:
        argv = host_argv(build_command(model, f"Read {prompt} and follow it."), model.split(":", 1)[0], settings)
    except (RuntimeError, ValueError) as e:
        return str(e)
    runs = " ".join(shlex.quote(a["run_id"]) for a in spawned)
    script.write_text(f"#!/bin/bash\n{shlex.join(['python3', str(Path(__file__).resolve()), '--await'])} {runs}\n"
                      f"exec {shlex.join(argv)}\n")
    r = subprocess.run(["tmux", "new-session", "-d", "-s", host, "-c", str(HOST_CWD), "bash", str(script)],
                       capture_output=True, text=True)
    return f"tmux rc={r.returncode}: {r.stderr.strip()[-300:]}" if r.returncode else None


def main(argv):
    dry = "--dry-run" in argv
    now = datetime.now(timezone.utc)
    day_dir = OUT_ROOT / now.astimezone().strftime("%Y-%m-%d")
    marker = day_dir / "decision.json"
    if not dry and marker.exists():  # idempotent: one decision per day, a re-run never re-spawns
        print(json.dumps({"skipped": f"already decided today, see {marker}"}))
        return

    try:
        usage = json.loads(USAGE.read_text())
    except (OSError, ValueError) as e:
        usage = {"windows": {}}
        print(f"cannot read {USAGE}: {e}", file=sys.stderr)
    verdicts, wanted = decide(usage, now)
    actions = plan(wanted, json.loads(ROSTER.read_text()), active_repos(now)) if wanted else []

    host = f"usage-spender-host-{day_dir.name}"
    host_model = cron_model("usage-spender-host", HOST_DEFAULT)
    if not dry:
        day_dir.mkdir(parents=True, exist_ok=True)
        for a in actions:
            spawn(a, day_dir, host, host_model.split(":", 1)[0])
    spawned = [a for a in actions if a.get("spawned")]
    decision = {"run_at": now.isoformat(), "dry_run": dry, "source": str(USAGE),
                "windows": verdicts, "actions": actions}
    if spawned:  # spawned last on purpose: a failed host start leaves the worker runs intact
        decision["host"] = {"tmux": host, "model": host_model, "error": start_host(spawned, day_dir, host, host_model)}
    if not dry:
        marker.write_text(json.dumps(decision, indent=2) + "\n")
    print(json.dumps(decision, indent=2))


def selftest():
    now = datetime(2026, 10, 11, 22, 0, tzinfo=timezone.utc)
    fresh = "2026-10-11T21:30:00Z"

    def win(used, resets, seen=fresh):
        return {"used": used, "resets_at": resets, "updated_at": seen}

    soon, late = "2026-10-12T07:59:59Z", "2026-10-14T09:29:04Z"
    u = {"windows": {"claude:week": win(0.12, soon), "claude:session": win(0.05, soon),
                     "codex:weekly": win(0.02, late)}}
    v, w = decide(u, now)
    assert w == [("claude:week", 2, 0.12)], w
    assert "horizon" in v["codex:weekly"], v
    u["windows"]["claude:week"]["used"] = 0.5
    assert decide(u, now)[1] == [("claude:week", 1, 0.5)]
    u["windows"]["claude:week"]["used"] = 0.7
    assert decide(u, now)[1] == []
    u["windows"]["claude:week"]["used"] = 0.1
    u["windows"]["claude:session"]["used"] = 0.9
    assert "busy" in decide(u, now)[0]["claude:week"]
    u["windows"]["claude:session"]["used"] = 0.0
    u["windows"]["claude:week"]["updated_at"] = "2026-10-11T08:00:00Z"
    assert "stale" in decide(u, now)[0]["claude:week"]
    assert decide({"windows": {}}, now) == ({"claude:week": "no data", "codex:weekly": "no data"}, [])
    roster = {"roles": {"reviewer": {"chain": ["hermes:kimi", "claude:claude-opus", {"cli": "codex", "model": "terra"}]},
                        "researcher": {"chain": ["codex:luna", "claude:claude-sonnet"]}}}
    assert pin(roster, "reviewer", "codex") == "codex:terra"
    acts = plan([("claude:week", 2, 0.1), ("codex:weekly", 2, 0.2)], roster, [Path("/r1"), Path("/r2"), Path("/r3")])
    assert [(a["task_type"], a["model"], a["repo"]) for a in acts] == [
        ("contrary-review", "claude:claude-opus", "/r1"), ("framework-research", "claude:claude-sonnet", "/r2")], acts
    assert plan([("claude:week", 2, 0.1)], roster, [Path("/r1")])[-1]["repo"] == "/r1"
    assert plan([("claude:week", 1, 0.1)], {"roles": {"reviewer": {"chain": ["codex:x"]}}}, [Path("/r1")]) == []
    hp = host_prompt([dict(acts[0], run_id="R1")], "2026-10-12", "usage-spender-host-2026-10-12")
    assert "- R1: contrary-review on /r1" in hp and "kill-session -t usage-spender-host-2026-10-12" in hp, hp
    assert '"team_up_run": "<run_id>"' in hp, hp
    assert next_step("question", False) == "answer" and next_step("question", True) == "cancel"
    assert next_step("done", False) == "stop" and next_step("failed", True) == "stop"
    built = ["claude", "--dangerously-skip-permissions", "--model", "opus", "Read x"]
    assert host_argv(built, "claude", "/s.json") == ["claude", "--settings", "/s.json", "--model", "opus", "Read x"]
    assert host_argv(["codex", "--model", "m", "Read x"], "codex", "/s.json") == ["codex", "--model", "m", "Read x"]
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".ini") as f:
        f.write("# c\n[usage-spender-host]\nmodel = codex:gpt-6-luna\n[other]\nmodel = nope\n")
        f.flush()
        assert cron_model("usage-spender-host", HOST_DEFAULT, f.name) == "codex:gpt-6-luna"
        assert cron_model("other", HOST_DEFAULT, f.name) == HOST_DEFAULT
        assert cron_model("missing", HOST_DEFAULT, f.name) == HOST_DEFAULT
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    elif "--await" in sys.argv:
        await_runs(sys.argv[sys.argv.index("--await") + 1:])
    else:
        main(sys.argv[1:])
