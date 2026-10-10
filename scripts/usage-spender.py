#!/usr/bin/env python3
"""usage-spender: spend subscription quota that would otherwise reset unused.

Cron every 10 minutes (flock), stateless tick. Reads team-up's live quota windows (usage.json, refreshed every
~5 min by the usage watcher) and holds each window to a pacing curve: the share of the window
that should be used by now, given the days until it resets. A window below its curve, with a
gap worth at least one task on that account's plan, gets ONE team-up worker per tick
(admission allows one worker on this box). New spawns only inside SPAWN_HOURS. The knobs below
are defaults; roster usage_spender.* (dashboard Settings) overrides them, see apply_knobs. Per tick:

  1. ledger runs: reconcile (`runs wait --ceiling-sec 1`, which also runs the verify command);
     a question gets one canned answer, then a cancel; a run older than MAX_RUN_H is cancelled
  2. a finished implement run with a passing verify and new commits -> push its usage-spender/*
     branch and open a DRAFT PR (never merge; no verify command -> local branch only)
  3. finished, uncollected ledger runs -> start one Claude Code intake host in tmux
     on the CLI from ~/.team-up/cron-jobs.ini [usage-spender-host] (scripts/usage-spender-host.md): check results, record in TIM, collect, Telegram summary
  4. no ledger run active and a window below its curve -> spawn exactly one task

Tasks, in order: review an open PR in our repos (read-only, TIM + Telegram only, no GitHub
comment), implement an open TIM task/bug, implement a GitHub issue (both in a fresh clone; triage
only when the repo has no GitHub remote), else v1's audit/research pool on the most recently
committed repos. Workers never write memory; the host does.

  scripts/usage-spender.py              tick: act, write <day>/tick-HHMM.json + ledger
  scripts/usage-spender.py --dry-run    decide only: no spawn, no host, no writes
  --any-hour                            ignore SPAWN_HOURS (manual runs and dry runs by day)
  scripts/usage-spender.py --selftest
"""
import configparser
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
REPO = Path(__file__).resolve().parents[1]
ENV = os.environ
TU_HOME = Path(ENV.get("TEAM_UP_HOME") or HOME / ".team-up")
# Same precedence as src/paths.mjs and usage-collect-cron.sh.
USAGE = Path(ENV.get("TEAM_UP_USAGE") or ENV.get("O9K_USAGE") or TU_HOME / "usage.json")
ROSTER = Path(ENV.get("TEAM_UP_ROSTER") or ENV.get("O9K_ROSTER") or TU_HOME / "roster.json")
RUNS = Path(ENV.get("TEAM_UP_RUNS") or ENV.get("O9K_RUNS") or TU_HOME / "runs")
# The entry point directly, not `team-up`: a cron PATH may lack nvm's bin.
TEAMUP = ["node", str(REPO / "bin/team-up.mjs")]
OUT_ROOT = Path(ENV.get("TEAM_UP_REPORT_DIR") or ENV.get("O9K_REPORT_DIR") or TU_HOME / "reports") / "usage-spender"
LEDGER = OUT_ROOT / "ledger.json"
PROJECTS = HOME / "projects"
# .tim-project -> P0073; the host session binds there. Must be a folder Claude Code already trusts,
# or the host sits in the trust dialog forever (a test run from a fresh clone sets it).
HOST_CWD = Path(ENV.get("USAGE_SPENDER_HOST_CWD") or REPO)
CRON_JOBS = TU_HOME / "cron-jobs.ini"  # [usage-spender-host] model = cli:model picks the host CLI
HOST_DEFAULT = "claude:claude-opus"
TELEGRAM = HOME / ".hermes/bin/send-cron-telegram"
LABEL = ENV.get("USAGE_SPENDER_LABEL") or "usage-spender"  # Telegram headline; a test run sets its own
CLONES = TU_HOME / "spender" / "clones"
# `tim` command as argv; TIM_CMD overrides until `tim read` ships on PATH.
TIM = (ENV.get("TIM_CMD") or "tim").split()

# Tuning knobs.
# Pacing curve: (days until reset, share that should be used by then), linear in between.
# Benni 2026-10-09: 4d -> 30%, 3d -> 40%, 2d -> 60%, 1d -> 80%. Capped at 80% on the last day.
CURVE = [(7, 0.0), (4, 0.3), (3, 0.4), (2, 0.6), (1, 0.8), (0, 0.8)]
# One task's burn as a share of a window on the smallest paid plan. ponytail: a guess, not measured;
# Benni's own usage swamps any before/after delta. Tune by hand if spend is visibly off.
TASK_COST = 0.3
# Plan weight relative to the smallest paid plan of that provider (PLAN_TIERS in src/roster/config.mjs).
# Knobs, not published ratios. Unset plan -> weight 1 (cautious).
PLAN_WEIGHT = {
    "claude": {"pro": 1, "max5x": 5, "max20x": 20},
    "codex": {"plus": 1, "pro": 6, "business": 1, "enterprise": 6},
    "cursor": {"hobby": 0, "pro": 1, "pro_plus": 3, "ultra": 20, "teams": 1},
}
ACCOUNT_FOR_CLI = {"agy": "gemini"}
# Whose quota the spender may spend: roster usage_spender.subscriptions, edited in the dashboard
# Settings panel. Without the key: these three. agy stays out unless switched on (Benni 2026-10-10:
# Google quota only deliberately). Keep in sync with SPENDER_DEFAULT in src/dashboard/roles.mjs.
SPEND_DEFAULT = ["claude", "codex", "cursor"]
BUSY_BURST_USED = 0.8     # burst window this full -> someone is working on that CLI, leave it alone
MAX_AGE_H = 6             # older usage reading counts as unknown -> no spawn
ACTIVE_DAYS = 7           # fallback target repos: committed to within this many days
DEDUPE_DAYS = 7           # a task key spawned within this many days is not spawned again
# TIM mixes P-labels and words; a bug without a severity counts as medium. low / P3 never spend.
TIM_RANK = {"P0": 0, "critical": 0, "P1": 1, "high": 1, "P2": 2, "medium": 2}
AUTHORS = {"Bumblebiber"}  # issues are implemented unattended: only from these GitHub logins
SELF_TAG = "#usage-spender"  # the host files findings with this tag; never feed them back in
# Spender-only model for implement runs, overriding the roster's implementer chain on that cli.
# Benni 2026-10-09: the roster pins claude-haiku as implementer on claude (right for quick jobs), but
# spare Max 20x quota should buy real implementation work, so the spender uses claude-sonnet there.
IMPLEMENT_MODEL = {"claude": "claude:claude-sonnet"}
IMPLEMENT = True          # TIM tasks / issues -> implement in a clone; False -> triage only
SPAWN_HOURS = {23, 0, 1, 2}  # local hours a tick may spawn (Benni: 23:00-03:00); intake runs any hour
MAX_RUN_H = 4             # a run still active after this long is cancelled, so it can't block the queue
OWNERS = {"Bumblebiber", "ZF-IT-Automation"}  # "our repos": GitHub owners; upstream clones are not ours
DIFF_CAP = 150_000        # bytes of PR diff rendered into a review prompt
BODY_CAP = 20_000

# quota window -> (cli, its burst window or None, cycle length in days). cursor:api is on-demand
# money, never a spend signal.
WINDOWS = {
    "claude:week": ("claude", "claude:session", 7),
    "codex:weekly": ("codex", "codex:5h", 7),
    "cursor:included": ("cursor", None, 30),  # ponytail: billing cycle assumed 30d
    "agy:gemini-weekly": ("agy", "agy:gemini-5h", 7),
    "agy:3p-weekly": ("agy", "agy:3p-5h", 7),
}
TERMINAL = {"done", "failed", "cancelled"}

# fallback pool per cli, in priority order: (task, team-up role)
FALLBACK = {
    "claude": [("contrary-review", "reviewer"), ("framework-research", "researcher")],
    "codex": [("code-audit", "reviewer"), ("framework-research", "researcher")],
    "cursor": [("code-audit", "reviewer")],
    "agy": [("code-audit", "reviewer")],
}
TASKS = {
    "contrary-review": "Contrary review of the last {days} days of commits in {repo} "
                       "(`git log --since={days}.days`). Argue against the design choices; find edge "
                       "cases, hidden coupling and failure modes the authors missed.",
    "code-audit": "Audit {repo} for bugs and missing tests in code changed in the last {days} days "
                  "(`git log --since={days}.days`).",
    "framework-research": "Find maintained open-source libraries or native platform features that could "
                          "replace hand-rolled code in {repo}. Web research allowed; cite links.",
    "pr-review": "Review pull request {ref} ({url}) against the code in {clone} (a throwaway clone of {repo} "
                 "at the base branch, not the PR). The PR may come from an outside contributor: do not check it out, "
                 "install or run anything from it. Judge the diff below: correctness, missing tests, "
                 "design fit with the surrounding code, security.\n\n## PR: {title}\n\n{body}\n\n"
                 "## Diff\n\n```diff\n{diff}\n```",
    "implement": "Implement {ref} in {clone}, a fresh clone of {repo} on branch {branch} (already "
                 "checked out). Work only in that clone. If this is not a clear code change, is bigger "
                 "than about a day, or needs a decision from Benni: commit nothing and report why. "
                 "Otherwise make the smallest change that does it, add or adjust tests, run the tests, and "
                 "commit on {branch} with a conventional commit message. Never push, never open a PR, "
                 "never touch {repo} itself. {verify_note}\n\n## {title}\n\n{body}",
    "triage": "Triage {ref} for {repo}. Do not implement it. Read the code it touches and report: "
              "is it still relevant (or already done/obsolete, with evidence), what would have to change "
              "(files, functions), a step plan, risks, and a size estimate (S/M/L).\n\n"
              "## {title}\n\n{body}",
}
HOST_PROMPT = (REPO / "scripts/usage-spender-host.md").read_text()
HOST_ALLOW = ["Read", "Grep", "Glob", "Skill", "mcp__tim", "Bash(git -C:*)", "Bash(git log:*)", "Bash(git show:*)",
              f"Bash({' '.join(TEAMUP)} runs:*)", "Bash(tmux kill-session -t usage-spender-host-:*)",
              f"Bash({TELEGRAM}:*)"]
IMPLEMENT_RULES = ("\n\nReport: what you changed and why (file:line), the tests you ran and their result, "
                   "and anything left open.\n")
RULES = ("\n\nRead-only: do not edit, commit or push anything in {repo}, and post nothing anywhere "
         "(no GitHub comments). Report at most 15 findings, each with file:line evidence (or a link) and "
         "a severity, most severe first.\n")


def hours_until(iso, now):
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) - now).total_seconds() / 3600


def target(days_left, cycle_days):
    """Share of the window that should be used by now. Cycle scaled onto the 7-day curve."""
    d = days_left * 7 / cycle_days
    for (d1, t1), (d0, t0) in zip(CURVE, CURVE[1:]):
        if d0 <= d <= d1:
            return t0 + (t1 - t0) * (d - d0) / (d1 - d0)
    return CURVE[0][1] if d > CURVE[0][0] else CURVE[-1][1]


def apply_knobs(roster):
    """Dashboard-editable knobs from roster usage_spender.* (Settings panel, src/dashboard/settings.mjs).
    A value of the wrong type keeps the built-in one and says so: one bad edit must not stop every tick."""
    global SPAWN_HOURS, IMPLEMENT, IMPLEMENT_MODEL, MAX_RUN_H, TASK_COST
    knobs = roster.get("usage_spender") or {}
    if not isinstance(knobs, dict):
        return

    def num(v, lo, hi):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi

    checks = {
        "spawn_hours": lambda v: isinstance(v, list) and v and all(
            isinstance(h, int) and not isinstance(h, bool) and 0 <= h <= 23 for h in v),
        "implement": lambda v: isinstance(v, bool),
        "implement_model": lambda v: isinstance(v, dict) and all(
            isinstance(k, str) and isinstance(m, str) and (m == "" or m.startswith(k + ":")) for k, m in v.items()),
        "max_run_h": lambda v: num(v, 0.5, 48),
        "task_cost": lambda v: num(v, 0.001, 1),
    }
    for key, ok in checks.items():
        if key not in knobs:
            continue
        v = knobs[key]
        if not ok(v):
            ERRORS.append(f"usage_spender.{key} = {v!r} ignored, built-in value kept")
        elif key == "spawn_hours":
            SPAWN_HOURS = set(v)
        elif key == "implement":
            IMPLEMENT = v
        elif key == "implement_model":
            # "" = no override for that cli: the implementer role chain decides.
            IMPLEMENT_MODEL = {k: m for k, m in {**IMPLEMENT_MODEL, **v}.items() if m}
        elif key == "max_run_h":
            MAX_RUN_H = v
        else:
            TASK_COST = v


def task_cost(roster, cli):
    account = ACCOUNT_FOR_CLI.get(cli, cli)
    plan = ((roster.get("accounts") or {}).get(account) or {}).get("plan")
    w = PLAN_WEIGHT.get(account, {}).get(plan, 1)
    return TASK_COST / w if w else float("inf")


def decide(usage, roster, now):
    """Pure. -> ({window: verdict}, [(window, cli, gap, cost)] most tasks' worth of gap first)."""
    windows = usage.get("windows", {})
    verdicts, wanted = {}, []
    spend = (roster.get("usage_spender") or {}).get("subscriptions", SPEND_DEFAULT)
    for key, (cli, burst, cycle) in WINDOWS.items():
        if cli not in spend:
            verdicts[key] = "off (not in usage_spender.subscriptions)"
            continue
        w = windows.get(key) or {}
        used, resets, seen = w.get("used"), w.get("resets_at"), w.get("updated_at") or w.get("updated")
        if not isinstance(used, (int, float)) or not resets or not seen:
            verdicts[key] = "no data"
            continue
        age, left = -hours_until(seen, now), hours_until(resets, now)
        burst_used = (windows.get(burst) or {}).get("used") if burst else None
        t, cost = target(left / 24, cycle), task_cost(roster, cli)
        gap = t - used
        head = f"used {used:.0%}, target {t:.0%}, resets in {left / 24:.1f}d"
        if age > MAX_AGE_H:
            verdicts[key] = f"stale reading ({age:.0f}h old)"
        elif left <= 0:
            verdicts[key] = f"reset time passed ({resets})"
        elif isinstance(burst_used, (int, float)) and burst_used >= BUSY_BURST_USED:
            verdicts[key] = f"busy ({burst} at {burst_used:.0%})"
        elif gap < cost:
            verdicts[key] = f"{head}: gap {gap:.0%} below one task ({cost:.1%})"
        else:
            verdicts[key] = f"{head}: gap {gap:.0%} = {gap / cost:.0f} tasks of {cost:.1%}"
            wanted.append((key, cli, gap, cost))
    wanted.sort(key=lambda x: -x[2] / x[3])
    return verdicts, wanted


def pin(roster, role, cli):
    """First entry of the roster's chain for role that runs on cli, as 'cli:model'."""
    for e in roster["roles"].get(role, {}).get("chain", []):
        c, m = e.split(":", 1) if isinstance(e, str) else (e.get("cli"), e.get("model"))
        if c == cli:
            return f"{c}:{m}"
    return None


def sh(*cmd, cwd=None, timeout=120):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return subprocess.CompletedProcess(cmd, 124, "", str(e))
    return r


ERRORS = []  # gh / tim failures this tick, written into the tick JSON so a broken cron env shows


def ghjson(*args):
    r = sh("gh", *args)
    try:
        if r.returncode == 0:
            return json.loads(r.stdout)
    except ValueError:
        pass
    ERRORS.append(f"gh {' '.join(args[:3])} rc={r.returncode}: {(r.stderr or r.stdout).strip()[-200:]}")
    return None


# --- task sources ---------------------------------------------------------------------------

def local_repos():
    """{path: {'gh': 'owner/name' or None, 'tim': 'P00xx' or None, 'last': commit ts}} under ~/projects."""
    out = {}
    for git in PROJECTS.glob("*/.git"):
        p = git.parent
        last = sh("git", "-C", str(p), "log", "-1", "--format=%ct").stdout.strip()
        url = sh("git", "-C", str(p), "remote", "get-url", "origin").stdout.strip()
        m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", url)
        tim = None
        try:
            tim = json.loads((p / ".tim-project").read_text()).get("project")
        except (OSError, ValueError):
            pass
        gh = m.group(1) if m and m.group(1).split("/")[0] in OWNERS else None
        if gh and (ghjson("repo", "view", gh, "--json", "isArchived") or {}).get("isArchived", True):
            gh = None  # archived (or unreachable): no PRs, no push
        out[p] = {"gh": gh, "tim": tim, "last": int(last) if last.isdigit() else 0}
    return out


def pr_candidates(repos):
    seen = set()  # two local clones of one GitHub repo -> its PRs once
    for path, r in sorted(repos.items(), key=lambda kv: -kv[1]["last"]):
        if not r["gh"] or r["gh"] in seen:
            continue
        seen.add(r["gh"])
        for pr in ghjson("pr", "list", "-R", r["gh"], "--state", "open", "--json",
                         "number,title,body,url,headRefOid,isDraft") or []:
            ref = f"{r['gh']}#{pr['number']}"
            yield {"key": f"pr:{ref}@{pr['headRefOid'][:12]}", "kind": "pr-review", "role": "reviewer",
                   "repo": str(path), "gh": r["gh"], "ref": ref, "url": pr["url"], "title": pr["title"],
                   "body": (pr.get("body") or "")[:BODY_CAP]}


def tim_read(ids):
    """{id: entry} via one batched `tim read`; secret / not_found entries left out."""
    if not ids:
        return {}
    r = sh(*TIM, "read", *ids, "--json")
    try:
        return {e["id"]: e for e in json.loads(r.stdout) if "error" not in e}
    except (ValueError, TypeError, KeyError):
        ERRORS.append(f"tim read rc={r.returncode}: {(r.stderr or r.stdout).strip()[-200:]}")
        return {}


def tim_candidates(repos):
    by_project = {r["tim"]: p for p, r in repos.items() if r["tim"]}
    r = sh(*TIM, "open-work")
    try:
        items = json.loads(r.stdout)["items"]
    except (ValueError, KeyError):
        ERRORS.append(f"tim open-work rc={r.returncode}: {(r.stderr or r.stdout).strip()[-200:]}")
        items = []
    def rank(i):
        return TIM_RANK.get(i.get("priority") or ("medium" if i.get("kind") == "bug" else None))
    items = [i for i in items if i.get("kind") in ("task", "bug") and i.get("status") in ("todo", "open")
             and rank(i) is not None and i.get("project") in by_project]
    details = tim_read([i["id"] for i in items])
    items = [dict(i, body=details[i["id"]].get("body"), truncated=details[i["id"]].get("truncated"))
             for i in items if i["id"] in details and SELF_TAG not in (details[i["id"]].get("tags") or [])]
    for i in sorted(items, key=rank):
        path = by_project[i["project"]]
        yield work({"key": f"tim:{i['id']}", "repo": str(path), "gh": repos[path]["gh"],
                    "ref": f"TIM {i['kind']} {i['id']} ({i['project']}, {i['priority']})", "title": i["title"],
                    "tim_id": i["id"], "body": (i["body"] or "") + ("\n[body truncated]" if i["truncated"] else "")})


def work(c):
    """A TIM task or issue: implement in a clone when allowed and pushable, else triage."""
    if IMPLEMENT and c["gh"]:
        return dict(c, kind="implement", role="implementer")
    return dict(c, kind="triage", role="planner")


def issue_candidates(repos):
    seen = set()
    for path, r in sorted(repos.items(), key=lambda kv: -kv[1]["last"]):
        if not r["gh"] or r["gh"] in seen:
            continue
        seen.add(r["gh"])
        for iss in ghjson("issue", "list", "-R", r["gh"], "--state", "open", "--json",
                          "number,title,body,url,author") or []:
            if (iss.get("author") or {}).get("login") not in AUTHORS:
                continue
            ref = f"{r['gh']} issue #{iss['number']}"
            yield work({"key": f"issue:{r['gh']}#{iss['number']}", "repo": str(path), "gh": r["gh"],
                        "ref": ref, "url": iss["url"], "title": iss["title"], "body": (iss.get("body") or "")[:BODY_CAP]})


def fallback_candidates(repos, cli, now):
    active = [p for p, r in sorted(repos.items(), key=lambda kv: -kv[1]["last"])
              if now.timestamp() - r["last"] <= ACTIVE_DAYS * 86400]
    for task, role in FALLBACK.get(cli, []):
        for p in active:
            yield {"key": f"{task}:{p.name}", "kind": task, "role": role, "repo": str(p)}


def candidates(repos, cli, now):
    yield from pr_candidates(repos)
    yield from tim_candidates(repos)
    yield from issue_candidates(repos)
    yield from fallback_candidates(repos, cli, now)


def recently_taken(ledger, now):
    cutoff = now - timedelta(days=DEDUPE_DAYS)
    # an implement key never twice: its branch / PR exists, a second clone would collide
    return {e["key"] for e in ledger if datetime.fromisoformat(e["at"]) >= cutoff
            or e.get("status") not in TERMINAL or e.get("kind") == "implement" and e.get("run_id")}


def choose(cands, roster, cli, taken):
    """First candidate not taken whose role has a roster pin on cli -> (candidate + model) or None."""
    for c in cands:
        if c["key"] in taken:
            continue
        model = (c["role"] == "implementer" and IMPLEMENT_MODEL.get(cli)) or pin(roster, c["role"], cli)
        if model:  # roster has no entry for this CLI in that role -> next, never vibe-pick
            return dict(c, cli=cli, model=model)
    return None


def render(c):
    if c["kind"] == "pr-review":
        num = c["ref"].rsplit("#", 1)[1]
        diff = sh("gh", "pr", "diff", num, "-R", c["ref"].rsplit("#", 1)[0]).stdout
        if len(diff) > DIFF_CAP:
            diff = diff[:DIFF_CAP] + "\n[diff truncated]"
        text = TASKS["pr-review"].format(diff=diff, **c)
    elif c["kind"] in ("triage", "implement"):
        body = c.get("body") or "(no body available, work from the title)"
        if c["kind"] == "implement":
            note = (f"The parent runs `{c['verify']}` after you finish; it must pass." if c.get("verify")
                    else "This repo has no test command the parent can run; your branch stays local.")
            return TASKS["implement"].format(body=body, verify_note=note, **c) + IMPLEMENT_RULES
        text = TASKS["triage"].format(body=body, **c)
    else:
        text = TASKS[c["kind"]].format(repo=c["repo"], days=ACTIVE_DAYS)
    return text + RULES.format(repo=c["repo"])


# --- runs -----------------------------------------------------------------------------------

def teamup(*args, timeout=600):
    return sh(*TEAMUP, *args, timeout=timeout)


def run_state(run_id):
    try:
        return json.loads((RUNS / run_id / "STATE.json").read_text())
    except (OSError, ValueError):
        return {}


def slug(key):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", key).strip("-")[:80]


def verify_command(clone):
    """The repo's own test command, or None (-> no push)."""
    pkg = clone / "package.json"
    if pkg.exists():
        try:
            has_test = bool(json.loads(pkg.read_text()).get("scripts", {}).get("test"))
        except ValueError:
            has_test = False
        if has_test:
            install = "npm ci" if (clone / "package-lock.json").exists() else "npm install"
            return f'bash -c "{install} --no-audit --no-fund && npm test"'
    if (clone / "pytest.ini").exists() or (clone / "pyproject.toml").exists() or (clone / "tests").is_dir():
        return "python3 -m pytest -q"
    return None


def prepare_clone(a):
    """Fresh clone of the GitHub repo on branch usage-spender/<key>. Fills clone/branch/verify; error or None."""
    clone, branch = CLONES / slug(a["key"]), f"usage-spender/{slug(a['key'])}"
    if clone.exists():
        return f"clone {clone} already exists"
    CLONES.mkdir(parents=True, exist_ok=True)
    r = sh("gh", "repo", "clone", a["gh"], str(clone), timeout=600)
    if r.returncode:
        return f"gh repo clone rc={r.returncode}: {r.stderr.strip()[-300:]}"
    r = sh("git", "-C", str(clone), "checkout", "-b", branch)
    if r.returncode:
        return f"git checkout rc={r.returncode}: {r.stderr.strip()[-300:]}"
    a.update(clone=str(clone), branch=branch,
             verify=verify_command(clone) if a["kind"] == "implement" else None)
    return None


def spawn(a, day_dir):
    """runs create + dispatch --run-id, no wake-up parent (later ticks reconcile, the intake host
    collects). Fills a['run_id'] / a['spawned'] / a['error']."""
    if a["kind"] in ("implement", "pr-review"):  # PR text is outside input: never in Benni's checkout
        err = prepare_clone(a)
        if err:
            a.update(spawned=False, error=err)
            return
    _spawn(a, day_dir)
    if not a.get("spawned") and a.get("clone"):
        shutil.rmtree(a["clone"], ignore_errors=True)


def _spawn(a, day_dir):
    cwd = a.get("clone") or a["repo"]
    prompt = day_dir / f"{slug(a['key'])}.md"
    prompt.write_text(render(a))
    model = a["model"].split(":", 1)[1]
    verify = ["--verify-command", a["verify"], "--verify-runs", "1"] if a.get("verify") else []
    r = teamup("runs", "create", "--cwd", cwd, "--role", a["role"], "--worker-cli", a["cli"],
               "--worker-model", model, "--prompt-file", str(prompt),
               "--parent-cli", "claude", "--parent-attach", "manual", *verify)
    run_id = next((ln.split()[1] for ln in r.stdout.splitlines() if ln.startswith("runId:")), None)
    if r.returncode or not run_id:
        a.update(spawned=False, rc=r.returncode, error=f"runs create rc={r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")
        return
    a["run_id"] = run_id
    r = teamup("dispatch", "--role", a["role"], "--prompt-file", str(prompt), "--dir", cwd,
               "--run-id", run_id, "--model", a["model"])
    if r.returncode:  # 2 = pinned model blocked by quota, 3 = admission refused (machine full)
        teamup("runs", "cancel", run_id)
        a.update(spawned=False, rc=r.returncode, error=f"dispatch rc={r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")
    else:
        a["spawned"] = True


def publish(e, st):
    """Done implement run: push its branch and open a draft PR when verify passed and it committed.
    Sets e['pr'] (url) or e['publish'] (why not). Never merges."""
    clone = e["clone"]
    if not e.get("verify"):
        e["publish"] = "no verify command: branch stays local"
        return
    if (st.get("verification") or {}).get("verdict") != "pass":
        e["publish"] = f"verify verdict {(st.get('verification') or {}).get('verdict')}: not pushed"
        return
    ahead = sh("git", "-C", clone, "rev-list", "--count", "origin/HEAD..HEAD").stdout.strip()
    if ahead in ("", "0"):
        e["publish"] = "no commits: nothing to push"
        return
    r = sh("git", "-C", clone, "push", "-u", "origin", f"HEAD:refs/heads/{e['branch']}", timeout=300)
    if r.returncode:
        e["publish"] = f"push rc={r.returncode}: {r.stderr.strip()[-300:]}"
        return
    body = (f"Opened unattended by team-up usage-spender (run {e['run_id']}, {e['model']}) for {e['ref']}.\n\n"
            f"Verify `{e['verify']}` passed. Draft: review before merging; usage-spender never merges.")
    r = sh("gh", "pr", "create", "-R", e["gh"], "--draft", "--head", e["branch"],
           "--title", f"usage-spender: {e['title']}"[:120], "--body", body, cwd=clone)
    if r.returncode:
        e["publish"] = f"pushed {e['branch']}, gh pr create rc={r.returncode}: {r.stderr.strip()[-300:]}"
    else:
        e["pr"] = r.stdout.strip().splitlines()[-1]


def triage_runs(ledger, now, dry):
    """Reconcile ledger runs, answer/cancel stuck ones, publish implement results. -> (active, to_intake)."""
    active, intake = [], []
    for e in ledger:
        if e.get("status") in TERMINAL and e.get("collected"):
            continue
        if not dry and e.get("status") not in TERMINAL:
            teamup("runs", "wait", e["run_id"], "--ceiling-sec", "1", timeout=1800)  # reconcile + verify
        st = run_state(e["run_id"])
        e["status"], e["collected"] = st.get("status", "failed"), bool(st.get("collected"))
        if not dry and e["status"] not in TERMINAL:
            if datetime.fromisoformat(e["at"]) < now - timedelta(hours=MAX_RUN_H):
                teamup("runs", "cancel", e["run_id"])
                e["status"] = "cancelled"
            elif e["status"] == "question" and e.get("answered"):
                teamup("runs", "cancel", e["run_id"])
                e["status"] = "cancelled"
            elif e["status"] == "question":
                teamup("runs", "answer", e["run_id"], "--text", "No human available. Finish with what you have.")
                e["answered"] = True
        if not dry and e["status"] == "done" and e.get("kind") == "implement" and "pr" not in e and "publish" not in e:
            publish(e, st)
        if e["status"] not in TERMINAL:
            active.append(e)
        elif not e["collected"] and e.get("intake_tries", 0) < 2:
            intake.append(e)
    return active, intake


def host_alive(host):
    return sh("tmux", "has-session", "-t", host).returncode == 0


def host_prompt(runs, verdicts, date, host):
    def line(e):
        extra = [e.get("ref"), e.get("branch") and f"branch {e['branch']} in {e['clone']}",
                 e.get("pr") and f"draft PR {e['pr']}", e.get("publish")]
        return (f"- {e['run_id']} ({e['status']}): {e['kind']} on {e['repo']} ({e['model']}, role {e['role']})"
                + "".join(f" — {x}" for x in extra if x))
    windows = "\n".join(f"- {k}: {v}" for k, v in verdicts.items())
    return HOST_PROMPT.format(date=date, teamup=" ".join(TEAMUP), runs="\n".join(map(line, runs)), host=host,
                              windows=windows, telegram=TELEGRAM, label=LABEL)


def cron_model(job, default, path=CRON_JOBS):
    """'cli:model' for job from cron-jobs.ini, else default."""
    ini = configparser.ConfigParser()
    ini.read(path)
    value = ini.get(job, "model", fallback="").strip()
    return value if ":" in value else default


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
    r = sh("node", "--input-type=module", "-e", js, str(REPO / "src/roster/command.mjs"),
           str(ROSTER), mid, cli, prompt, str(HOST_CWD))
    if r.returncode:
        raise RuntimeError(f"buildCommand for {model}: {r.stderr.strip()[-300:]}")
    return json.loads(r.stdout)


def start_host(runs, verdicts, day_dir, host, model):
    """The chosen host CLI in detached tmux, told to follow host.md. The runs are already finished
    (later ticks reconcile them), so the host waits for nothing. Returns an error string or None."""
    prompt, settings = day_dir / f"{host}.md", day_dir / f"{host}-settings.json"
    prompt.write_text(host_prompt(runs, verdicts, day_dir.name, host))
    settings.write_text(json.dumps({"permissions": {"allow": HOST_ALLOW}}, indent=2) + "\n")
    try:
        argv = host_argv(build_command(model, f"Read {prompt} and follow it."), model.split(":", 1)[0], settings)
    except (RuntimeError, ValueError) as e:
        return str(e)
    r = sh("tmux", "new-session", "-d", "-s", host, "-c", str(HOST_CWD), shlex.join(argv))
    return f"tmux rc={r.returncode}: {r.stderr.strip()[-300:]}" if r.returncode else None


LEDGER_KEYS = ("key", "kind", "role", "repo", "gh", "ref", "title", "cli", "model", "window", "run_id",
               "clone", "branch", "verify")


def main(argv):
    dry = "--dry-run" in argv
    now = datetime.now(timezone.utc)
    local = now.astimezone()
    day_dir = OUT_ROOT / local.strftime("%Y-%m-%d")
    try:
        ledger = json.loads(LEDGER.read_text())
    except (OSError, ValueError):
        ledger = []
    try:
        usage = json.loads(USAGE.read_text())
    except (OSError, ValueError) as e:
        usage = {"windows": {}}
        print(f"cannot read {USAGE}: {e}", file=sys.stderr)
    try:
        roster = json.loads(ROSTER.read_text())
    except (OSError, ValueError) as e:  # still reconcile and run intake; just spawn nothing
        roster = {"roles": {}, "accounts": {}}
        ERRORS.append(f"cannot read {ROSTER}: {e}")
    apply_knobs(roster)
    if not dry:
        day_dir.mkdir(parents=True, exist_ok=True)

    active, intake = triage_runs(ledger, now, dry)
    verdicts, wanted = decide(usage, roster, now)
    tick = {"run_at": now.isoformat(), "dry_run": dry, "source": str(USAGE), "windows": verdicts,
            "active": [e["run_id"] for e in active], "action": None}

    host = f"usage-spender-host-{local.strftime('%Y%m%d-%H%M')}"
    if intake and not any(host_alive(e["intake_host"]) for e in ledger if e.get("intake_host")):
        host_model = cron_model("usage-spender-host", HOST_DEFAULT)
        tick["intake"] = {"tmux": host, "model": host_model, "runs": [e["run_id"] for e in intake]}
        if not dry:
            tick["intake"]["error"] = start_host(intake, verdicts, day_dir, host, host_model)
            for e in intake:
                e["intake_host"], e["intake_tries"] = host, e.get("intake_tries", 0) + 1

    if local.hour not in SPAWN_HOURS and "--any-hour" not in argv:
        tick["action"] = f"outside spawn hours {sorted(SPAWN_HOURS)}"
    elif active:
        tick["action"] = "a usage-spender run is still active, one at a time"
    elif wanted:
        repos, taken, a = local_repos(), recently_taken(ledger, now), None
        for key, cli, gap, cost in wanted:
            a = choose(candidates(repos, cli, now), roster, cli, taken)
            if a:
                a.update(window=key, gap=round(gap, 3))
                break
        if not a:
            tick["action"] = "below curve, but no task left with a roster pin on that cli"
        else:
            if not dry:
                spawn(a, day_dir)
                if a.get("spawned"):
                    ledger.append({k: a[k] for k in LEDGER_KEYS if a.get(k)} | {"at": now.isoformat(),
                                                                               "status": "starting"})
                elif a.get("rc") != 3:  # admission refusal = machine busy, retry next tick; else back off
                    ledger.append({k: a[k] for k in LEDGER_KEYS if a.get(k) and k != "run_id"}
                                  | {"at": now.isoformat(), "status": "failed", "collected": True,
                                     "error": a["error"]})
            tick["action"] = {k: v for k, v in a.items() if k != "body"}

    if ERRORS:
        tick["errors"] = ERRORS
    if not dry:  # the ledger every tick (statuses, answered flags); a tick file only when something happened
        LEDGER.write_text(json.dumps(ledger, indent=2) + "\n")
        if isinstance(tick["action"], dict) or "intake" in tick or ERRORS:
            (day_dir / f"tick-{local.strftime('%H%M')}.json").write_text(json.dumps(tick, indent=2) + "\n")
    print(json.dumps(tick, indent=2))


def selftest():
    global SPAWN_HOURS, IMPLEMENT, IMPLEMENT_MODEL, MAX_RUN_H, TASK_COST
    now = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
    fresh = "2026-10-09T11:30:00Z"

    def win(used, resets, seen=fresh):
        return {"used": used, "resets_at": resets, "updated_at": seen}

    # curve: Benni's points, linear in between, 0 beyond a week, 80% cap on the last day
    for d, t in [(4, .3), (3, .4), (2, .6), (1, .8), (0.3, .8), (7, 0), (10, 0), (5.5, .15), (2.5, .5)]:
        assert abs(target(d, 7) - t) < 1e-9, (d, target(d, 7))
    assert abs(target(30 * 4 / 7, 30) - .3) < 1e-9  # monthly cycle scaled onto the week

    pro = {"accounts": {}}
    max20 = {"accounts": {"claude": {"plan": "max20x"}, "cursor": {"plan": "hobby"}}}
    assert task_cost(pro, "claude") == TASK_COST and task_cost(max20, "claude") == TASK_COST / 20
    assert task_cost(max20, "cursor") == float("inf")
    assert task_cost({"accounts": {"gemini": {"plan": "pro"}}}, "agy") == TASK_COST

    u = {"windows": {"claude:week": win(0.14, "2026-10-12T07:59:59Z"), "claude:session": win(0.1, fresh),
                     "codex:weekly": win(0.04, "2026-10-14T09:29:04Z"), "codex:5h": win(0.1, fresh),
                     "cursor:included": win(0.01, "2026-10-26T23:00:00Z")}}
    v, w = decide(u, max20, now)
    assert [x[0] for x in w] == ["claude:week"], (v, w)  # codex gap 16% < a plus-plan task's 30%
    assert "target 43%" in v["claude:week"] and "below one task" in v["codex:weekly"], v
    assert "below one task" in v["cursor:included"], v  # hobby: never
    agy, wanted = decide(
        {"windows": {"agy:gemini-weekly": win(0.1, "2026-10-12T12:00:00Z"),
                     "agy:gemini-5h": win(0.1, "2026-10-09T13:00:00Z")}},
        {"accounts": {"gemini": {"plan": "pro"}}}, now,
    )
    assert wanted == [] and agy["agy:gemini-weekly"].startswith("off"), (agy, wanted)  # default: no agy
    agy, wanted = decide(
        {"windows": {"agy:gemini-weekly": win(0.1, "2026-10-12T12:00:00Z"),
                     "agy:gemini-5h": win(0.1, "2026-10-09T13:00:00Z")}},
        {"accounts": {"gemini": {"plan": "pro"}}, "usage_spender": {"subscriptions": ["agy"]}}, now,
    )
    assert wanted and wanted[0][0] == "agy:gemini-weekly" and wanted[0][1] == "agy", (agy, wanted)
    v, w = decide(u, {**max20, "usage_spender": {"subscriptions": []}}, now)
    assert w == [] and v["claude:week"].startswith("off"), (v, w)  # all off in the dashboard
    # tier scaling: same gap, bigger plan -> spend
    v, w = decide(u, {"accounts": {"codex": {"plan": "pro"}, "claude": {"plan": "pro"}}}, now)
    assert [x[0] for x in w] == ["codex:weekly"], (v, w)
    u["windows"]["claude:session"]["used"] = 0.9
    assert "busy" in decide(u, max20, now)[0]["claude:week"]
    u["windows"]["claude:session"]["used"] = 0.0
    u["windows"]["claude:week"]["updated_at"] = "2026-10-09T01:00:00Z"
    assert "stale" in decide(u, max20, now)[0]["claude:week"]
    assert decide({"windows": {}}, max20, now)[1] == []

    roster = {"roles": {"reviewer": {"chain": ["hermes:kimi", "claude:claude-opus", {"cli": "codex", "model": "terra"}]},
                        "planner": {"chain": ["codex:sol"]}}}
    assert pin(roster, "reviewer", "codex") == "codex:terra" and pin(roster, "nope", "codex") is None
    cands = [{"key": "pr:a#1@x", "role": "reviewer"}, {"key": "tim:T1", "role": "planner"},
             {"key": "code-audit:r", "role": "reviewer"}]
    assert choose(iter(cands), roster, "claude", set())["key"] == "pr:a#1@x"
    assert choose(iter(cands), roster, "claude", {"pr:a#1@x"})["key"] == "code-audit:r"  # planner has no claude pin
    assert choose(iter(cands), roster, "codex", {"pr:a#1@x"})["model"] == "codex:sol"
    impl = [{"key": "tim:T2", "role": "implementer"}]
    assert choose(iter(impl), roster, "claude", set())["model"] == "claude:claude-sonnet"  # spender override
    assert choose(iter(impl), roster, "codex", set()) is None  # no override, no roster pin -> skip
    old = (now - timedelta(days=8)).isoformat()
    ledger = [{"key": "a", "at": old, "status": "done"}, {"key": "b", "at": old, "status": "watching"},
              {"key": "c", "at": now.isoformat(), "status": "done"}]
    assert recently_taken(ledger, now) == {"b", "c"}
    # a failed spawn is a fresh terminal entry -> backs off; an old implement with a run never repeats
    ledger += [{"key": "d", "at": now.isoformat(), "status": "failed", "collected": True},
               {"key": "e", "at": old, "status": "done", "kind": "implement", "run_id": "R"}]
    assert recently_taken(ledger, now) == {"b", "c", "d", "e"}

    hp = host_prompt([{"run_id": "R1", "status": "done", "kind": "pr-review", "repo": "/r1", "ref": "o/r#9",
                       "model": "claude:claude-opus", "role": "reviewer"}], {"claude:week": "x"},
                     "2026-10-12", "usage-spender-host-20261012-0000")
    assert "- R1 (done): pr-review on /r1 (claude:claude-opus, role reviewer) — o/r#9" in hp, hp
    assert "kill-session -t usage-spender-host-20261012-0000" in hp and '"team_up_run": "<run_id>"' in hp, hp
    assert str(TELEGRAM) in hp and "- claude:week: x" in hp, hp

    # TIM task / issue: implement only with a GitHub remote to push to
    assert work({"key": "k", "gh": "o/r"})["kind"] == "implement" and work({"key": "k", "gh": None})["role"] == "planner"

    # verify command from the repo's own test setup; none -> no push
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        assert verify_command(d) is None
        (d / "package.json").write_text('{"scripts": {"test": "node --test"}}')
        assert verify_command(d) == 'bash -c "npm install --no-audit --no-fund && npm test"'
        (d / "package-lock.json").write_text("{}")
        assert verify_command(d).startswith('bash -c "npm ci ')
        e = {"clone": str(d), "verify": None}
        publish(e, {})
        assert "local" in e["publish"] and "pr" not in e
        e = {"clone": str(d), "verify": "x"}
        publish(e, {"verification": {"verdict": "fail"}})
        assert "fail" in e["publish"] and "pr" not in e
    assert slug("pr:o/r#9@abc") == "pr-o-r-9-abc"

    # host CLI from cron-jobs.ini (main 16f0f68)
    built = ["claude", "--dangerously-skip-permissions", "--model", "opus", "Read x"]
    assert host_argv(built, "claude", "/s.json") == ["claude", "--settings", "/s.json", "--model", "opus", "Read x"]
    assert host_argv(["codex", "--model", "m", "Read x"], "codex", "/s.json") == ["codex", "--model", "m", "Read x"]
    with tempfile.NamedTemporaryFile("w", suffix=".ini") as f:
        f.write("# c\n[usage-spender-host]\nmodel = codex:gpt-6-luna\n[other]\nmodel = nope\n")
        f.flush()
        assert cron_model("usage-spender-host", HOST_DEFAULT, f.name) == "codex:gpt-6-luna"
        assert cron_model("other", HOST_DEFAULT, f.name) == HOST_DEFAULT
        assert cron_model("missing", HOST_DEFAULT, f.name) == HOST_DEFAULT
    # dashboard knobs: valid values replace the built-ins, a wrong type keeps them and is reported
    saved = (SPAWN_HOURS, IMPLEMENT, IMPLEMENT_MODEL, MAX_RUN_H, TASK_COST, list(ERRORS))
    apply_knobs({"usage_spender": {"spawn_hours": [22, 23], "implement": False, "max_run_h": 2,
                                   "task_cost": 0.2, "implement_model": {"claude": "", "codex": "codex:gpt-6-sol"}}})
    assert SPAWN_HOURS == {22, 23} and IMPLEMENT is False and MAX_RUN_H == 2 and TASK_COST == 0.2
    assert IMPLEMENT_MODEL == {"codex": "codex:gpt-6-sol"}, IMPLEMENT_MODEL  # "" drops claude's override
    SPAWN_HOURS, IMPLEMENT, IMPLEMENT_MODEL, MAX_RUN_H, TASK_COST = saved[:5]
    apply_knobs({"usage_spender": {"spawn_hours": [25], "implement": "yes", "max_run_h": True,
                                   "implement_model": {"claude": "codex:x"}}})
    assert (SPAWN_HOURS, IMPLEMENT, IMPLEMENT_MODEL, MAX_RUN_H) == saved[:4]
    assert len(ERRORS) == len(saved[5]) + 4 and "spawn_hours" in ERRORS[len(saved[5])], ERRORS
    ERRORS[:] = saved[5]
    print("selftest ok")


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main(sys.argv[1:])
