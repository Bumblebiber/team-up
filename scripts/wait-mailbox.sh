#!/usr/bin/env bash
# wait-mailbox.sh — block until mailbox reaches a parent-wake status, or ceiling.
# Usage: wait-mailbox.sh <mailbox-dir> [--ceiling-sec N] [--result-grace-sec N]
# Exit: 0 = terminal/question status; 2 = ceiling; 1 = usage error
#
# IMPORTANT: do NOT exit on the first filesystem event. Workers touch HEARTBEAT
# and rewrite STATUS=watching on start — that must not wake the parent as "done".
# Live bug 2026-07-20: watcher returned watching in seconds after HEARTBEAT.
#
# --result-grace-sec: STATUS=done wakes only once RESULT.md or RESULT.json
# exists, or once that many seconds have passed since the STATUS write.
# Workers that set STATUS before RESULT were failed while the RESULT was
# seconds away. `runs wait` passes classifyMailbox's grace; the policy lives
# there, the default here is no grace.
set -euo pipefail
MB="${1:-}"
shift || true
CEILING=3600
GRACE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ceiling-sec) CEILING="$2"; shift 2 ;;
    --result-grace-sec) GRACE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$MB" && -d "$MB" ]] || { echo "usage: wait-mailbox.sh <mailbox-dir> [--ceiling-sec N] [--result-grace-sec N]" >&2; exit 1; }

status() { tr -d '[:space:]' <"$MB/STATUS" 2>/dev/null || true; }

# Seconds a STATUS=done still waits for its RESULT; 0 once it exists or the grace is over.
result_due() {
  local age
  if [[ -e "$MB/RESULT.md" || -e "$MB/RESULT.json" ]]; then echo 0; return; fi
  age=$(( $(date +%s) - $(stat -c %Y "$MB/STATUS" 2>/dev/null || echo 0) ))
  echo $(( age < GRACE ? GRACE - age : 0 ))
}

is_wake() {
  case "$(status)" in
    failed|cancelled|waiting_human) return 0 ;;
    done) [[ "$(result_due)" -eq 0 ]] ;;
    *) return 1 ;;
  esac
}

# Already terminal/question before we wait.
if is_wake; then exit 0; fi

deadline=$((SECONDS + CEILING))

if command -v inotifywait >/dev/null 2>&1; then
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    (( remaining < 1 )) && break
    # A done waiting for its RESULT also wakes when the grace runs out.
    timeout=$remaining
    if [[ "$(status)" == done ]]; then
      due=$(result_due)
      if (( due > 0 && due < timeout )); then timeout=$due; fi
    fi
    # inotifywait -t is seconds; exit 2 on timeout
    if inotifywait -e create,close_write,moved_to,modify -t "$timeout" --format '%w%f' "$MB" >/tmp/team-up-wait-mailbox.$$.out 2>/dev/null; then
      rm -f /tmp/team-up-wait-mailbox.$$.out
      if is_wake; then exit 0; fi
      # HEARTBEAT / non-terminal STATUS change — keep waiting
      continue
    else
      ec=$?
      rm -f /tmp/team-up-wait-mailbox.$$.out
      # Timeout: the ceiling (the loop condition ends it) or a grace that ran out.
      if [[ "$ec" -eq 2 ]]; then
        if is_wake; then exit 0; fi
        continue
      fi
      # spurious error — brief backoff then retry if time left
      sleep 1
    fi
  done
  # Final check after loop
  if is_wake; then exit 0; fi
  exit 2
fi

# Fallback: sleep loop in ONE process (still one tool invocation from the agent)
interval=5
if (( CEILING < 5 )); then interval=1; fi
while (( SECONDS < deadline )); do
  if is_wake; then exit 0; fi
  sleep "$interval"
done
if is_wake; then exit 0; fi
exit 2
