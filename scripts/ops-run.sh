#!/usr/bin/env bash
# ops-run.sh — run one scheduled LLM job on the CLI×model chosen for it and
# print the result. The choice lives in ~/.team-up/cron-jobs.ini, one section
# per job (`[golden-task]` / `model = claude:claude-sonnet`), so switching a job
# to codex, cursor or claude is a one-line edit. stdout = the result, so a
# Hermes no-agent cron job (no LLM, no cost) delivers it.
#
# Usage: ops-run.sh --job NAME [--ceiling-sec N] <cwd> <prompt-file>
# Exit: 0 done, 1 failed/cancelled/question, 2 still running at the ceiling,
#       3 admission refused, 64 usage.
set -euo pipefail

JOB=
CEILING=3300 # under Hermes' 1 h cron script timeout
INI="${TEAM_UP_HOME:-$HOME/.team-up}/cron-jobs.ini"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --job) JOB=$2; shift 2 ;;
    --ceiling-sec) CEILING=$2; shift 2 ;;
    *) break ;;
  esac
done
if [[ $# -ne 2 || -z "$JOB" ]]; then
  echo "usage: ops-run.sh --job NAME [--ceiling-sec N] <cwd> <prompt-file>" >&2
  exit 64
fi
CWD=$1 PROMPT=$2
MODEL=$(awk -v s="[$JOB]" '$0==s{f=1;next} /^\[/{f=0} f && $1=="model"{sub(/^[^=]*=[ \t]*/,""); sub(/[ \t]+$/,""); print; exit}' "$INI" 2>/dev/null)
if [[ "$MODEL" != *:* ]]; then
  echo "ops-run: no 'model = <cli>:<model>' for [$JOB] in $INI"
  exit 64
fi
CLI=${MODEL%%:*} ROLE="cron-$JOB"  # no ":" — tmux session names

# Cron PATH rarely has nvm's node or ~/.local/bin (claude, cursor-agent): the
# pick, dispatch and the observer's judge all need them.
NODE=$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
TEAMUP=("$NODE" "$(dirname "$(readlink -f "$0")")/../bin/team-up.mjs")

CREATED=$("${TEAMUP[@]}" runs create --cwd "$CWD" --role "$ROLE" --worker-cli "$CLI" --prompt-file "$PROMPT")
RUN=$(sed -n 's/^runId: //p' <<<"$CREATED")
MB=$(sed -n 's/^mailbox: //p' <<<"$CREATED")
[[ -n "$RUN" ]] || { echo "ops-run: runs create gave no run id" >&2; exit 1; }

set +e
"${TEAMUP[@]}" dispatch --role "$ROLE" --model "$MODEL" --prompt-file "$PROMPT" --dir "$CWD" --run-id "$RUN" >&2
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  "${TEAMUP[@]}" runs cancel "$RUN" >/dev/null 2>&1 || true
  "${TEAMUP[@]}" runs collect "$RUN" --note "ops-run: dispatch failed" >/dev/null 2>&1 || true
  echo "ops-run: dispatch failed (exit $rc) for [$JOB] on $MODEL, run $RUN"
  exit "$rc"
fi

set +e
"${TEAMUP[@]}" runs wait "$RUN" --ceiling-sec "$CEILING" >&2
rc=$?
set -e
STATUS=$(cat "$MB/STATUS" 2>/dev/null || echo unknown)
if [[ $rc -eq 2 ]]; then
  echo "ops-run: run $RUN [$JOB] on $MODEL still running after ${CEILING}s; result will land in $MB"
  exit 2
fi
if [[ "$STATUS" == done ]]; then
  cat "$MB/RESULT.md" 2>/dev/null || cat "$MB/RESULT.json"
  "${TEAMUP[@]}" runs collect "$RUN" --note "ops-run: result delivered on stdout" >/dev/null
  exit 0
fi
echo "ops-run: run $RUN [$JOB] on $MODEL ended $STATUS"
cat "$MB/FAILURE.md" 2>/dev/null || true
cat "$MB/QUESTIONS.md" 2>/dev/null || true
exit 1
