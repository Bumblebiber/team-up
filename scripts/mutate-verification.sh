#!/usr/bin/env bash
# Mutation test: break parent verification guardrails, see if the suite notices.
# Exits 1 when a mutant no longer applies (its substitution changed nothing):
# a stale pattern would otherwise report a false SURVIVED.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/runs/verification.mjs"
RUNS_SRC="$ROOT/src/runs/runs.mjs"
PAD=$(mktemp -d)
ORIG="$PAD/verification.orig.mjs"
RUNS_ORIG="$PAD/runs.orig.mjs"
cp "$SRC" "$ORIG"
cp "$RUNS_SRC" "$RUNS_ORIG"
trap 'cp "$ORIG" "$SRC"; cp "$RUNS_ORIG" "$RUNS_SRC"; rm -rf "$PAD"; echo "--- restored ---"' EXIT
cd "$ROOT"
status=0

# mutate <file> <original copy> <perl substitution> <name>
mutate() {
  local file="$1" orig="$2" expr="$3" name="$4"
  cp "$orig" "$file"
  perl -0pi -e "$expr" "$file"
  if cmp -s "$file" "$orig"; then
    echo "NO-OP     $name  (substitution matched nothing; update the pattern)"
    status=1
  else
    local fail
    fail=$(node --test test/runs/verification.test.mjs 2>&1 | grep -E "^# (pass|fail)|^ℹ (pass|fail)" | grep -oP '(?<=fail )\d+' | head -1)
    if [[ "$fail" == "0" ]]; then
      echo "SURVIVED  $name  (suite still green)"
    else
      echo "caught    $name  ($fail failing)"
    fi
  fi
  cp "$orig" "$file"
}

mutate "$SRC" "$ORIG" 's/runs\.every\(\(row\) => row\.exitCode === 0\)/runs.some((row) => row.exitCode === 0)/' \
  "M1 verdict uses some instead of every"
mutate "$SRC" "$ORIG" 's/  atomicWriteJson\(path\.join\(mailboxDir\(runId\), "VERIFICATION\.json"\), report\);\n/  \/* skip write *\/\n/' \
  "M2 parent never writes VERIFICATION.json"
mutate "$SRC" "$ORIG" 's/const verdict = runs\.every\(\(row\) => row\.exitCode === 0\) \? "pass" : "fail";/const verdict = "pass";/' \
  "M3 verdict always pass"
mutate "$RUNS_SRC" "$RUNS_ORIG" 's/  if \(report\.verdict !== "fail"\) return classified;\n/  return classified;\n/' \
  "M4 verifyDoneOnce ignores verification failure"

exit $status
