#!/usr/bin/env bash
# Mutation test: break parent verification guardrails, see if the suite notices.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/runs/verification.mjs"
PAD=/tmp/mutate-verification
mkdir -p "$PAD"
ORIG="$PAD/verification.orig.mjs"
cp "$SRC" "$ORIG"
cd "$ROOT"

run() {
  local name="$1"
  local out
  out=$(node --test test/runs/verification.test.mjs 2>&1 | grep -E "^# (pass|fail)|^ℹ (pass|fail)")
  local fail
  fail=$(echo "$out" | grep -oP '(?<=fail )\d+' | head -1)
  if [[ "$fail" == "0" ]]; then
    echo "SURVIVED  $name  (suite still green)"
  else
    echo "caught    $name  ($fail failing)"
  fi
  cp "$ORIG" "$SRC"
}

# M1: verdict uses .some instead of .every
cp "$ORIG" "$SRC"
perl -0pi -e 's/runs\.every\(\(row\) => row\.exitCode === 0\)/runs.some((row) => row.exitCode === 0)/' "$SRC"
run "M1 verdict uses some instead of every"

# M2: skip writing VERIFICATION.json
cp "$ORIG" "$SRC"
perl -0pi -e 's/  atomicWriteJson\(path\.join\(mailboxDir\(runId\), "VERIFICATION\.json"\), report\);\n/  \/* skip write *\/\n/' "$SRC"
run "M2 parent never writes VERIFICATION.json"

# M3: always pass verdict
cp "$ORIG" "$SRC"
perl -0pi -e 's/const verdict = runs\.every\(\(row\) => row\.exitCode === 0\) \? "pass" : "fail";/const verdict = "pass";/' "$SRC"
run "M3 verdict always pass"

# M4: reconcileMailbox never downgrades done to failed (runs.mjs)
RUNS_SRC="$ROOT/src/runs/runs.mjs"
RUNS_ORIG="$PAD/runs.orig.mjs"
cp "$RUNS_SRC" "$RUNS_ORIG"
cp "$RUNS_ORIG" "$RUNS_SRC"
perl -0pi -e 's/if \(report\.verdict === "fail"\) \{\n      classified = \{\n        status: "failed",\n        error: "parent verification failed",\n        resultPath: classified\.resultPath,\n      \};\n    \}\n//' "$RUNS_SRC"
run_runs() {
  local name="$1"
  local out
  out=$(node --test test/runs/verification.test.mjs 2>&1 | grep -E "^# (pass|fail)|^ℹ (pass|fail)")
  local fail
  fail=$(echo "$out" | grep -oP '(?<=fail )\d+' | head -1)
  if [[ "$fail" == "0" ]]; then
    echo "SURVIVED  $name  (suite still green)"
  else
    echo "caught    $name  ($fail failing)"
  fi
  cp "$RUNS_ORIG" "$RUNS_SRC"
}
run_runs "M4 reconcileMailbox ignores verification failure"

cp "$ORIG" "$SRC"
cp "$RUNS_ORIG" "$RUNS_SRC"
echo "--- restored ---"
