#!/usr/bin/env bash
# cron-job.sh — run one custom scheduled job defined in the dashboard.
#
# The crontab line (in team-up's managed block) names only the job. Everything
# else is read here at run time from ~/.team-up/cron-jobs.ini [NAME]:
#   model  = cli:model        which CLI and model work on it (ops-run.sh reads it)
#   cwd    = /abs/project/dir the repo the worker starts in
#   notify = true|false       send the result to Telegram (CronBot) when done
# The prompt is ~/.team-up/cron-prompts/NAME.md.
#
# Output goes to ~/.team-up/logs/cron/NAME.log between "=== start" and
# "=== end … exit N" lines; the dashboard reads the last pair as "last run".
# A run still going when the next one is due is skipped, not doubled.
#
# Usage: cron-job.sh NAME        Exit: ops-run.sh's code, 64 usage/config error.
set -uo pipefail

NAME=${1:-}
if [[ ! "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "usage: cron-job.sh NAME (lowercase letters, digits, -)" >&2
  exit 64
fi
HOME_DIR="${TEAM_UP_HOME:-$HOME/.team-up}"
INI="$HOME_DIR/cron-jobs.ini"
PROMPT="$HOME_DIR/cron-prompts/$NAME.md"
LOG_DIR="$HOME_DIR/logs/cron"
LOG="$LOG_DIR/$NAME.log"
mkdir -p "$LOG_DIR"

# First `key = value` of [NAME], trimmed — the same reading as ops-run.sh's model.
get() {
  awk -v s="[$NAME]" -v k="$1" '
    $0 == s { f = 1; next }
    /^\[/ { f = 0 }
    f && $0 ~ "^[ \t]*" k "[ \t]*=" { sub(/^[^=]*=[ \t]*/, ""); sub(/[ \t]+$/, ""); print; exit }
  ' "$INI" 2>/dev/null
}

# ponytail: size cap instead of logrotate — keep the newest ~512 KB.
if [[ -f "$LOG" && $(stat -c %s "$LOG") -gt 1048576 ]]; then
  tail -c 524288 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exec 9>"$LOG_DIR/$NAME.lock"
if ! flock -n 9; then
  echo "=== skipped $(date -Is): the previous run is still going" >> "$LOG"
  exit 0
fi

CWD=$(get cwd)
NOTIFY=$(get notify)
echo "=== start $(date -Is)" >> "$LOG"
if [[ -z "$CWD" || ! -d "$CWD" || ! -f "$PROMPT" ]]; then
  echo "cron-job: [$NAME] needs an existing cwd in $INI and a prompt at $PROMPT" >> "$LOG"
  echo "=== end $(date -Is) exit 64" >> "$LOG"
  exit 64
fi

OUT=$("$(dirname "$(readlink -f "$0")")/ops-run.sh" --job "$NAME" "$CWD" "$PROMPT" 2>>"$LOG")
rc=$?
printf '%s\n' "$OUT" >> "$LOG"
echo "=== end $(date -Is) exit $rc" >> "$LOG"

SEND="$HOME/.hermes/bin/send-cron-telegram"
if [[ "$NOTIFY" == true && -x "$SEND" ]]; then
  # The bot sends HTML: escape the three characters that would break it.
  MSG=$(printf 'team-up job %s (exit %s)\n\n%s' "$NAME" "$rc" "$OUT" | head -c 3500 \
    | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
  "$SEND" "$MSG" >/dev/null 2>&1 || echo "cron-job: telegram send failed" >> "$LOG"
fi
exit $rc
