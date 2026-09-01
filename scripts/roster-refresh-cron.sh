#!/usr/bin/env bash
# roster-refresh-cron.sh — weekly matrix refresh (disk-first report).
# Cron contract: run this script; do not inline collectors. Needs
# OPENROUTER_API_KEY in the cron environment (wrapper script or env file).
#
# Optional env:
#   TEAM_UP_REPORT_DIR  base dir for reports (default ~/.team-up/reports)
#   O9K_NOTIFY_CMD      command invoked as: $O9K_NOTIFY_CMD <report-path>
#                    after each run (e.g. a script that mails/pings you)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROSTER_JS="$ROOT/src/roster/roster.mjs"
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

OUT_DIR="$REPORT_BASE/roster-refresh"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/report-$STAMP.md"

STATUS=0
# Write, then echo. Piping the group into tee would run it in a subshell,
# so STATUS set inside would never reach the exit below — a failing run
# would report success to cron.
{
  echo "# roster-refresh $STAMP"
  echo
  if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    echo "FAILED: OPENROUTER_API_KEY not set"
    STATUS=1
  elif [[ ! -f "$ROSTER" ]]; then
    echo "SKIP: no roster.json yet — run roster.mjs init and curate first"
    STATUS=0
  else
    node "$ROSTER_JS" refresh --apply || STATUS=$?
  fi
  echo
  echo "_exit code: ${STATUS}_"
} > "$REPORT" 2>&1
cat "$REPORT"

echo "report: $REPORT"

# Optional notification hook (full report stays on disk).
if [[ -n "${O9K_NOTIFY_CMD:-}" ]]; then
  "$O9K_NOTIFY_CMD" "$REPORT" || echo "WARN: O9K_NOTIFY_CMD failed" >&2
fi

exit "$STATUS"
