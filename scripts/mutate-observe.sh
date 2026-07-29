#!/usr/bin/env bash
# Mutation test: break one thing, see if the suite notices.
set -u
SRC=/home/bbbee/projects/team-up/.worktrees/adaptive-observation/src/runs/observe.mjs
PAD=/tmp/mutate-adaptive-observation
mkdir -p "$PAD"
ORIG="$PAD/observe.orig.mjs"
cp "$SRC" "$ORIG"
cd /home/bbbee/projects/team-up/.worktrees/adaptive-observation

run() {
  local name="$1"
  local out
  out=$(node --test test/runs/observe.test.mjs 2>&1 | grep -E "^# (pass|fail)|^ℹ (pass|fail)")
  local fail
  fail=$(echo "$out" | grep -oP '(?<=fail )\d+' | head -1)
  if [[ "$fail" == "0" ]]; then
    echo "SURVIVED  $name  (suite still green)"
  else
    echo "caught    $name  ($fail failing)"
  fi
  cp "$ORIG" "$SRC"
}

# M1: never count stall episodes
cp "$ORIG" "$SRC"
perl -0pi -e 's/  loop\.stallEpisodeCount \+= 1;\n  loop\.lastJudgeAt = now\(\);\n//' "$SRC"
grep -q "loop.stallEpisodeCount += 1" "$SRC" && echo "M1 PATCH FAILED"
run "M1 handleStall never increments stallEpisodeCount"

# M2: stall ceiling never escalates
cp "$ORIG" "$SRC"
perl -0pi -e 's/if \(loop\.stallEpisodeCount >= MAX_STALL_EPISODES\) \{/if (false) {/' "$SRC"
grep -q "if (false) {" "$SRC" || echo "M2 PATCH FAILED"
run "M2 stall ceiling never fires"

# M3: key-count cap removed
cp "$ORIG" "$SRC"
perl -0pi -e 's/if \(verdict\.keys\.length > MAX_KEYS_PER_ANSWER\) \{/if (false) {/' "$SRC"
run "M3 MAX_KEYS_PER_ANSWER cap removed"

# M4: observer's own files counted in mailbox age again
cp "$ORIG" "$SRC"
perl -0pi -e 's/    if \(OBSERVER_OWNED_MAILBOX_FILES\.has\(name\)\) continue;\n//' "$SRC"
run "M4 mailbox age counts observer files"

# M5: episode latch never re-opens on trigger change
cp "$ORIG" "$SRC"
perl -0pi -e 's/  if \(loop\.lastEpisodeKey != null && trigger !== loop\.lastEpisodeKey\) \{\n    loop\.judgeCalledThisEpisode = false;\n  \}\n//' "$SRC"
run "M5 trigger change does not clear episode latch"

# M6: mailbox progress never resets stall counter
cp "$ORIG" "$SRC"
perl -0pi -e 's/  if \(loop\.prevMailboxAgeSec != null && mailboxAgeSec < loop\.prevMailboxAgeSec\) \{\n    loop\.stallEpisodeCount = 0;\n    loop\.deferredEscalateVerdict = false;\n  \} else if \(\n    loop\.prevMailboxAgeSec != null\n    && loop\.prevMailboxAgeSec >= silenceSec\n    && mailboxAgeSec < silenceSec\n  \) \{\n    loop\.stallEpisodeCount = 0;\n    loop\.deferredEscalateVerdict = false;\n  \}\n//' "$SRC"
run "M6 mailbox progress never resets stall counter"

# M7: deny pattern check removed entirely
cp "$ORIG" "$SRC"
perl -0pi -e 's/  if \(matchesDenyPattern\(pane\)\) \{/  if (false) {/' "$SRC"
run "M7 deny-pattern gate removed"

# M8: post-answer stall never fires
cp "$ORIG" "$SRC"
perl -0pi -e 's/    if \(loop\.postAnswerTicks >= stallTicks\) \{/    if (false) {/' "$SRC"
run "M8 post-answer stall never escalates"

# M9: defer-escalate removed
cp "$ORIG" "$SRC"
perl -0pi -e 's/  if \(\n    verified\.action === "escalate"\n    && verdict\.action === "escalate"\n    && mailboxAgeSec < silenceSec\n    && \(verdict\.state === "working"\n      \|\| verdict\.state === "finished"\n      \|\| verdict\.state === "waiting_input"\)\n  \) \{\n    if \(!loop\.deferredEscalateVerdict\) \{\n      loop\.deferredEscalateVerdict = true;\n      log\(\{\n        kind: "decision",\n        proposed_action: "escalate",\n        action: "wait",\n        reason: "deferred escalate; fresh mailbox contradicts verdict",\n      \}\);\n      return \{ loop, stop: false \};\n    \}\n  \}\n\n//' "$SRC"
run "M9 escalate deferral removed"

cp "$ORIG" "$SRC"
echo "--- restored ---"
