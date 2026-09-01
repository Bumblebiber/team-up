#!/usr/bin/env bash
# usage-collect-cron.sh — daily safety net when usage-watcher is stale/dead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COLLECT_JS="$ROOT/src/usage/usage-collect.mjs"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Reads may still find state left by an older o9k install; writes never do.
read_path() {
  local primary="$1" legacy="$2"
  if [[ -f "$primary" ]]; then printf '%s' "$primary"
  elif [[ -f "$legacy" ]]; then printf '%s' "$legacy"
  else printf '%s' "$primary"; fi
}
REPORT_BASE="${TEAM_UP_REPORT_DIR:-${O9K_REPORT_DIR:-$HOME/.team-up/reports}}"
ROSTER="$(read_path "${TEAM_UP_ROSTER:-$HOME/.team-up/roster.json}" "$HOME/.o9k/roster.json")"
WATCHER_STATE="$(read_path "${TEAM_UP_USAGE_WATCHER_STATE:-$HOME/.team-up/usage-watcher.json}" "$HOME/.o9k/usage-watcher.json")"

# Report location: override the base dir via TEAM_UP_REPORT_DIR (e.g. a cron
# runner's collected-outputs dir). Default is inside ~/.team-up.
OUT_DIR="$REPORT_BASE/usage-collector"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/report-$STAMP.md"

STATUS=0
# Write, then echo. Piping the group into tee would run it in a subshell,
# so STATUS set inside would never reach the exit below — a failing run
# would report success to cron.
{
  echo "# usage-collector $STAMP"
  echo
  if [[ ! -f "$ROSTER" ]]; then
    echo "SKIP: no roster.json"
  elif [[ -f "$WATCHER_STATE" ]]; then
    mtime=$(stat -c %Y "$WATCHER_STATE" 2>/dev/null || stat -f %m "$WATCHER_STATE")
    now=$(date +%s)
    age=$((now - mtime))
    if (( age < 90000 )); then
      echo "SKIP: watcher state fresh (${age}s old)"
    else
      node "$COLLECT_JS" --all || STATUS=$?
    fi
  else
    node "$COLLECT_JS" --all || STATUS=$?
  fi
  echo
  echo "_exit code: ${STATUS}_"
} > "$REPORT" 2>&1
cat "$REPORT"

echo "report: $REPORT"
exit "$STATUS"
