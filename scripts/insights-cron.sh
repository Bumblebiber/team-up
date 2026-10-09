#!/bin/bash
# insights-cron.sh — every 48h: read the run logs, judge them, act on them.
#
#   1. scripts/run-insights.mjs turns ~/.team-up/runs into findings (free).
#   2. Unchanged finding set, or nothing above low → silent, no model is paid.
#   3. Otherwise an evaluator runs (templates/insights-evaluator.md) on the CLI×model
#      in ~/.team-up/cron-jobs.ini [insights], through scripts/ops-run.sh:
#      TIM entries always, at most one fix. The fix is merged into main only
#      when the worker finished done AND `npm test` passed in its clone (the
#      repo has no CI; that parent verification is the gate). Benni chose
#      auto-merge on 2026-09-30; INSIGHTS_NO_MERGE=1 stops at the PR.
#
# Cron runs this daily; the stamp gate makes it 48h. `0 x */2 * *` would fire
# on the 31st and again on the 1st.
#
# Env: INSIGHTS_FORCE=1 skips the 48h gate and the dedup.
#      INSIGHTS_DRY_RUN=1 writes the report and prints the evaluator command
#      and prompt instead of running them or sending Telegram.
# Stdout only when a message goes out (watchdog pattern).

set -u

REPO="${TEAM_UP_REPO:-$HOME/projects/team-up}"
OUT_DIR="${INSIGHTS_OUT_DIR:-$HOME/.team-up/reports/insights}"
LOG_DIR="$HOME/.hermes/cron-outputs/insights"
mkdir -p "$OUT_DIR" "$LOG_DIR"
STAMP="$OUT_DIR/.last-run"
HASH_FILE="$OUT_DIR/.last-hash"
FORCE="${INSIGHTS_FORCE:-0}"
DRY="${INSIGHTS_DRY_RUN:-0}"

exec 9>"$OUT_DIR/.lock"
flock -n 9 || { echo "$(date -Is) previous run still active" >> "$LOG_DIR/cron.log"; exit 0; }

if [ "$FORCE" != "1" ] && [ -f "$STAMP" ] \
   && [ $(( $(date +%s) - $(stat -c %Y "$STAMP") )) -lt $(( 47 * 3600 )) ]; then
  exit 0
fi
[ "$DRY" = "1" ] || touch "$STAMP"

# Outcomes first: a run whose commits reached main is `merged`, which is the
# only way most runs ever get one (1 of 269 had it by hand).
[ "$DRY" = "1" ] || node "$REPO/scripts/run-merge-check.mjs" --apply >> "$LOG_DIR/merge-check.log" 2>&1

JSON=$(node "$REPO/scripts/run-insights.mjs" --since-hours 48 --out-dir "$OUT_DIR" 2>> "$LOG_DIR/stderr.log") \
  || { echo "WARN: run-insights failed, see $LOG_DIR/stderr.log"; exit 0; }
MD="${JSON%.json}.md"

read -r HASH ACTIONABLE <<<"$(python3 - "$JSON" <<'E'
import json, sys
d = json.load(open(sys.argv[1]))
print(d["findingsHash"], sum(f["severity"] != "low" for f in d["findings"]))
E
)"
echo "$(date -Is) report=$JSON actionable=$ACTIONABLE hash=${HASH:0:12}" >> "$LOG_DIR/cron.log"

if [ "$FORCE" != "1" ]; then
  [ "$ACTIONABLE" -eq 0 ] && exit 0
  [ "$HASH" = "$(cat "$HASH_FILE" 2>/dev/null)" ] && exit 0
fi

STAMP_ID=$(date +%Y%m%d-%H%M)
BRANCH="insights/$STAMP_ID"
PROMPT="${JSON%.json}.prompt.md"
TICKET="${JSON%.json}.ticket.md"
sed -e "s|{{REPORT_MD}}|$MD|g" -e "s|{{REPORT_JSON}}|$JSON|g" \
    -e "s|{{REPORT_DIR}}|$OUT_DIR|g" -e "s|{{TICKET}}|$TICKET|g" \
    -e "s|{{BRANCH}}|$BRANCH|g" -e "s|{{TIM_PROJECT}}|${INSIGHTS_TIM_PROJECT:-P0073}|g" \
    "$REPO/templates/insights-evaluator.md" > "$PROMPT"

# The evaluator runs as a team-up worker on the CLI×model chosen in
# ~/.team-up/cron-jobs.ini [insights] (claude, codex and cursor all have TIM
# MCP and a shell). Its RESULT is the Telegram text.
CMD=("$REPO/scripts/ops-run.sh" --job insights --ceiling-sec 10800 "$REPO" "$PROMPT")

if [ "$DRY" = "1" ]; then
  echo "--- would run: ${CMD[*]}"
  cat "$PROMPT"
  exit 0
fi

BEFORE=$(git -C "$REPO" status --porcelain)
DECISION="${JSON%.json}.decision.md"
"${CMD[@]}" > "$DECISION" 2>> "$LOG_DIR/stderr.log"
RC=$?
echo "$HASH" > "$HASH_FILE"
[ "$(git -C "$REPO" status --porcelain)" != "$BEFORE" ] && TAMPERED=1 || TAMPERED=0

# The one fix. Deterministic on purpose: the evaluator's Bash cannot block for
# the 90 minutes a worker takes, and a push should not hang on a model's mood.
fix_ticket() {
  local tu="$REPO/bin/team-up.mjs" clone="$HOME/projects/tasks/insights-$STAMP_ID"
  # From GitHub, not the local checkout: its main may lag, and the PR must apply.
  git clone -q -b main "$(git -C "$REPO" remote get-url origin)" "$clone" || return 1
  git -C "$clone" switch -q -c "$BRANCH" || return 1
  (cd "$clone" && npm ci --silent) >> "$LOG_DIR/stderr.log" 2>&1 || return 1
  local pick cli model run status
  pick=$(node "$tu" pick --role implementer 2>/dev/null)
  cli=$(awk '/^cli:/{print $2}' <<<"$pick"); model=$(awk '/^model:/{print $2}' <<<"$pick")
  run=$(node "$tu" runs create --cwd "$clone" --role implementer --parent-cli claude \
        --parent-attach manual --worker-cli "$cli" --worker-model "$model" \
        --prompt-file "$TICKET" --project P0073 --verify-command "npm test" | awk '/^runId:/{print $2}')
  [ -n "$run" ] || return 1
  node "$tu" dispatch --role implementer --prompt-file "$TICKET" --dir "$clone" \
       --run-id "$run" --model "$cli:$model" >> "$LOG_DIR/stderr.log" 2>&1 || return 1
  node "$tu" runs wait "$run" --ceiling-sec 5400 >> "$LOG_DIR/stderr.log" 2>&1
  status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
           "$HOME/.team-up/runs/$run/STATE.json" 2>/dev/null)
  if [ "$status" != "done" ] || [ -z "$(git -C "$clone" log --oneline main..HEAD)" ]; then
    echo "Fix-Run $run: ${status:-unbekannt}, kein PR ($clone)"
    return 0
  fi
  git -C "$clone" push -q -u origin "$BRANCH" >> "$LOG_DIR/stderr.log" 2>&1 || { echo "Fix-Run $run: push fehlgeschlagen"; return 0; }
  local pr
  pr=$(cd "$clone" && gh pr create --base main --head "$BRANCH" \
     --title "insights: $(head -1 "$TICKET" | sed 's/^#* *//')" \
     --body "Automatischer Fix aus dem 48h-Insights-Cron.

Bericht: \`$MD\` · Run: \`$run\` · parent verification: \`npm test\` grün.

$(cat "$TICKET")

🤖 Generated with [Claude Code](https://claude.com/claude-code)" 2>> "$LOG_DIR/stderr.log") \
    || { echo "Fix-Run $run: PR-Erstellung fehlgeschlagen ($BRANCH gepusht)"; return 0; }
  if [ "${INSIGHTS_NO_MERGE:-0}" = "1" ]; then
    echo "Fix-PR (nicht gemerged): $pr"
    return 0
  fi
  (cd "$clone" && gh pr merge "$pr" --squash --delete-branch) >> "$LOG_DIR/stderr.log" 2>&1 \
    || { echo "Fix-PR offen, Merge fehlgeschlagen (Konflikt?): $pr"; return 0; }
  # Crons run from the main checkout, so the fix is only live once it is there.
  # A checkout on another branch or with conflicting edits is left alone.
  if [ "$(git -C "$REPO" branch --show-current)" = "main" ] \
     && git -C "$REPO" pull -q --ff-only >> "$LOG_DIR/stderr.log" 2>&1; then
    echo "Fix gemerged und live: $pr"
  else
    echo "Fix gemerged: $pr — Main-Checkout nicht aktualisiert, bitte pullen"
  fi
}
FIX=""
# A tampered main checkout means the evaluator broke its rules: no fix on top.
[ "$RC" -eq 0 ] && [ "$TAMPERED" = "0" ] && [ -s "$TICKET" ] && FIX=$(fix_ticket || echo "Fix-Vorbereitung fehlgeschlagen, siehe $LOG_DIR/stderr.log")

MSG="🔎 team-up Insights ($ACTIONABLE auffällig)
$(head -c 3000 "$DECISION")
${FIX:+$FIX
}Bericht: $MD"
[ "$RC" -ne 0 ] && MSG="⚠️ Insights-Evaluator exit $RC — Bericht liegt trotzdem vor.
$MSG"
[ "$TAMPERED" = "1" ] && MSG="🛑 Evaluator hat den Main-Checkout verändert — bitte prüfen.
$MSG"

echo "$MSG"
ESCAPED=$(printf '%s' "$MSG" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
"$HOME/.hermes/bin/send-cron-telegram" "$ESCAPED" || echo "WARN: CronBot telegram send failed" >&2
