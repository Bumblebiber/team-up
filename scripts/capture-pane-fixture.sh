#!/usr/bin/env bash
# capture-pane-fixture.sh — capture tmux pane snapshots for CLI fixture ground truth.
#
# Usage:
#   capture-pane-fixture.sh <cli> <state> [options] -- <command...>
#
# Options:
#   --settle SEC          Seconds to wait after session start before first capture (default: 3)
#   --offsets SECS        Comma-separated capture offsets from session start (default: 0)
#   --cwd DIR             Working directory (default: current)
#   --cols N              Terminal width (default: 120)
#   --rows N              Terminal height (default: 40)
#   --input TEXT          Send text via tmux send-keys (+ Enter) at --input-at
#   --input-at SEC        Seconds from session start to send --input (default: --settle)
#   --fixture-root DIR    Output root (default: repo test/fixtures/panes)
#   --kill-after SEC      Kill session after this many seconds (default: last offset + 15)
#   --no-kill             Leave session running (for debugging only)
#
# Writes:
#   <fixture-root>/<cli>/<state>.txt           (single offset)
#   <fixture-root>/<cli>/<state>-<N>s.txt      (multiple offsets)
#   <fixture-root>/<cli>/<state>.meta.json
#
set -euo pipefail

MAX_BYTES=16384
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_ROOT="$REPO_ROOT/test/fixtures/panes"

CLI=""
STATE=""
SETTLE=3
OFFSETS="0"
CWD=""
COLS=120
ROWS=40
INPUT_TEXT=""
INPUT_AT=""
KILL_AFTER=""
NO_KILL=0
COMMAND=()

usage() {
  sed -n '2,20p' "$0"
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --settle) SETTLE="$2"; shift 2 ;;
    --offsets) OFFSETS="$2"; shift 2 ;;
    --cwd) CWD="$2"; shift 2 ;;
    --cols) COLS="$2"; shift 2 ;;
    --rows) ROWS="$2"; shift 2 ;;
    --input) INPUT_TEXT="$2"; shift 2 ;;
    --input-at) INPUT_AT="$2"; shift 2 ;;
    --fixture-root) FIXTURE_ROOT="$2"; shift 2 ;;
    --kill-after) KILL_AFTER="$2"; shift 2 ;;
    --no-kill) NO_KILL=1; shift ;;
    -h|--help) usage 0 ;;
    --)
      shift
      COMMAND=("$@")
      break
      ;;
    *)
      if [[ -z "$CLI" ]]; then
        CLI="$1"
      elif [[ -z "$STATE" ]]; then
        STATE="$1"
      else
        echo "unexpected argument: $1" >&2
        usage
      fi
      shift
      ;;
  esac
done

[[ -n "$CLI" && -n "$STATE" && ${#COMMAND[@]} -gt 0 ]] || usage

if [[ -z "$CWD" ]]; then
  CWD="$(pwd)"
fi
if [[ -z "$INPUT_AT" ]]; then
  INPUT_AT="$SETTLE"
fi

IFS=',' read -r -a OFFSET_LIST <<< "$OFFSETS"
LAST_OFFSET="${OFFSET_LIST[${#OFFSET_LIST[@]}-1]}"
if [[ -z "$KILL_AFTER" ]]; then
  KILL_AFTER=$((LAST_OFFSET + 15))
fi

SESSION="pane-fixture-$$-${RANDOM}"
OUT_DIR="$FIXTURE_ROOT/$CLI"
mkdir -p "$OUT_DIR"

get_cli_version() {
  local cli="$1"
  case "$cli" in
    cursor-agent|cursor)
      cursor-agent --version 2>&1 | head -1 || true
      ;;
    claude)
      claude --version 2>&1 | head -1 || true
      ;;
    codex)
      codex --version 2>&1 | head -1 || true
      ;;
    hermes)
      hermes --version 2>&1 | head -1 || true
      ;;
    opencode)
      opencode --version 2>&1 | head -1 || true
      ;;
    *)
      if command -v "$cli" >/dev/null 2>&1; then
        "$cli" --version 2>&1 | head -1 || true
      else
        echo "unknown"
      fi
      ;;
  esac
}

CLI_VERSION="$(get_cli_version "$CLI")"
START_EPOCH="$(date -u +%s)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  if [[ "$NO_KILL" -eq 0 ]]; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi
}
trap cleanup EXIT

tmux new-session -d -s "$SESSION" -c "$CWD" -x "$COLS" -y "$ROWS" -- "${COMMAND[@]}"

CAPTURE_FILES=()
CAPTURE_TIMESTAMPS=()
INPUT_SENT=0

elapsed() {
  echo $(( $(date -u +%s) - START_EPOCH ))
}

wait_until() {
  local target="$1"
  while true; do
    local now
    now="$(elapsed)"
    if (( now >= target )); then
      return 0
    fi
    sleep $(( target - now ))
  done
}

capture_to_file() {
  local offset="$1"
  local outfile="$2"
  tmux capture-pane -pJ -t "$SESSION" 2>/dev/null | tail -c "$MAX_BYTES" > "$outfile"
  CAPTURE_FILES+=("$outfile")
  CAPTURE_TIMESTAMPS+=("$(date -u +%Y-%m-%dT%H:%M:%SZ)")
}

maybe_send_input() {
  local now
  now="$(elapsed)"
  if [[ -n "$INPUT_TEXT" && "$INPUT_SENT" -eq 0 && "$now" -ge "$INPUT_AT" ]]; then
    tmux send-keys -t "$SESSION" -l -- "$INPUT_TEXT"
    tmux send-keys -t "$SESSION" Enter
    INPUT_SENT=1
  fi
}

for offset in "${OFFSET_LIST[@]}"; do
  wait_until "$offset"
  maybe_send_input
  if [[ ${#OFFSET_LIST[@]} -eq 1 ]]; then
    outfile="$OUT_DIR/${STATE}.txt"
  else
    outfile="$OUT_DIR/${STATE}-${offset}s.txt"
  fi
  capture_to_file "$offset" "$outfile"
done

# Send input if it was scheduled after the last capture.
maybe_send_input

wait_until "$KILL_AFTER"

# Write sidecar metadata via node (bash + tmux + node only).
META_PATH="$OUT_DIR/${STATE}.meta.json"
CAPTURE_FILES="$(printf '%s\0' "${CAPTURE_FILES[@]}")"
CAPTURE_TIMESTAMPS="$(printf '%s\0' "${CAPTURE_TIMESTAMPS[@]}")"
export CAPTURE_FILES CAPTURE_TIMESTAMPS INPUT_TEXT INPUT_AT FIXTURE_ROOT
node --input-type=module - "$META_PATH" <<'NODE' \
  "$CLI" "$CLI_VERSION" "$STATE" "$CWD" "$COLS" "$ROWS" "$SETTLE" "$OFFSETS" "$START_ISO" \
  "${COMMAND[@]}"
import fs from "node:fs";

const [
  metaPath,
  cli,
  cliVersion,
  state,
  cwd,
  cols,
  rows,
  settle,
  offsets,
  startIso,
  ...command
] = process.argv.slice(2);

const captureFiles = process.env.CAPTURE_FILES?.split("\0").filter(Boolean) ?? [];
const captureTimestamps = process.env.CAPTURE_TIMESTAMPS?.split("\0").filter(Boolean) ?? [];
const offsetList = offsets.split(",").map((s) => Number(s.trim()));

const fixtureRoot = process.env.FIXTURE_ROOT ?? "";
const captures = offsetList.map((offsetSec, i) => {
  const abs = captureFiles[i] ?? "";
  const file =
    abs && fixtureRoot && abs.startsWith(fixtureRoot + "/")
      ? abs.slice(fixtureRoot.length + 1)
      : abs.replace(/.*\/test\/fixtures\/panes\//, "") || null;
  return { offsetSec, timestamp: captureTimestamps[i] ?? null, file };
});

const payload = {
  cli,
  cliVersion,
  state,
  command,
  cwd,
  terminalSize: { cols: Number(cols), rows: Number(rows) },
  settleSec: Number(settle),
  offsets: offsetList,
  sessionStart: startIso,
  input: process.env.INPUT_TEXT ? {
    text: process.env.INPUT_TEXT,
    sentAtSec: Number(process.env.INPUT_AT),
  } : null,
  captures,
};

fs.writeFileSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`);
NODE

echo "captured $CLI/$STATE -> $OUT_DIR (${#OFFSET_LIST[@]} snapshot(s))"
