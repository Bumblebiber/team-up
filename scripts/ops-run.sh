#!/usr/bin/env bash
# ops-run.sh — run one scheduled ops prompt through a team-up role and print
# the result. The role's roster chain picks the CLI×model, so which CLI runs
# cron jobs is set in the dashboard (Roles → overseer) or in roster.json —
# not in the job. stdout = the result, so a Hermes no-agent cron job delivers it.
#
# Usage: ops-run.sh [--role R] [--ceiling-sec N] <cwd> <prompt-file>
# Exit: 0 done, 1 failed/cancelled/question, 2 still running at the ceiling,
#       3 admission refused, 64 usage.
set -euo pipefail

ROLE=overseer
CEILING=3300 # under Hermes' 1 h cron script timeout
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE=$2; shift 2 ;;
    --ceiling-sec) CEILING=$2; shift 2 ;;
    *) break ;;
  esac
done
if [[ $# -ne 2 ]]; then
  echo "usage: ops-run.sh [--role R] [--ceiling-sec N] <cwd> <prompt-file>" >&2
  exit 64
fi
CWD=$1 PROMPT=$2

# Cron PATH rarely has nvm's node or ~/.local/bin (claude, cursor-agent): the
# pick, dispatch and the observer's judge all need them.
NODE=$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
TEAMUP=("$NODE" "$(dirname "$(readlink -f "$0")")/../bin/team-up.mjs")

CLI=$("${TEAMUP[@]}" pick --role "$ROLE" | sed -n 's/^cli: //p')
CREATED=$("${TEAMUP[@]}" runs create --cwd "$CWD" --role "$ROLE" --worker-cli "${CLI:-unknown}" --prompt-file "$PROMPT")
RUN=$(sed -n 's/^runId: //p' <<<"$CREATED")
MB=$(sed -n 's/^mailbox: //p' <<<"$CREATED")
[[ -n "$RUN" ]] || { echo "ops-run: runs create gave no run id" >&2; exit 1; }

set +e
"${TEAMUP[@]}" dispatch --role "$ROLE" --prompt-file "$PROMPT" --dir "$CWD" --run-id "$RUN" >&2
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  "${TEAMUP[@]}" runs cancel "$RUN" >/dev/null 2>&1 || true
  "${TEAMUP[@]}" runs collect "$RUN" --note "ops-run: dispatch failed" >/dev/null 2>&1 || true
  echo "ops-run: dispatch failed (exit $rc) for role $ROLE, run $RUN"
  exit "$rc"
fi

set +e
"${TEAMUP[@]}" runs wait "$RUN" --ceiling-sec "$CEILING" >&2
rc=$?
set -e
STATUS=$(cat "$MB/STATUS" 2>/dev/null || echo unknown)
if [[ $rc -eq 2 ]]; then
  echo "ops-run: run $RUN ($ROLE) still running after ${CEILING}s; result will land in $MB"
  exit 2
fi
if [[ "$STATUS" == done ]]; then
  cat "$MB/RESULT.md" 2>/dev/null || cat "$MB/RESULT.json"
  "${TEAMUP[@]}" runs collect "$RUN" --note "ops-run: result delivered on stdout" >/dev/null
  exit 0
fi
echo "ops-run: run $RUN ($ROLE) ended $STATUS"
cat "$MB/FAILURE.md" 2>/dev/null || true
cat "$MB/QUESTIONS.md" 2>/dev/null || true
exit 1
