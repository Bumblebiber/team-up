#!/usr/bin/env bash
# team-up-usage-watcher.sh — systemd/cron entrypoint (never exec .mjs without node).
set -euo pipefail

resolve_path() {
  local src="${1:-$0}"
  if command -v readlink >/dev/null 2>&1; then
    local resolved
    resolved="$(readlink -f "$src" 2>/dev/null || true)"
    if [[ -n "$resolved" ]]; then
      printf '%s' "$resolved"
      return
    fi
  fi
  while [[ -L "$src" ]]; do
    local dir link
    dir="$(cd "$(dirname "$src")" && pwd)"
    link="$(readlink "$src")"
    [[ "$link" == /* ]] && src="$link" || src="$dir/$link"
  done
  printf '%s/%s' "$(cd "$(dirname "$src")" && pwd)" "$(basename "$src")"
}

SCRIPT="$(resolve_path "$0")"
ROOT="$(cd "$(dirname "$SCRIPT")" && pwd)"
WATCHER="$ROOT/../src/usage/usage-watcher.mjs"

if [[ ! -f "$WATCHER" && -n "${TEAM_UP_SCRIPTS:-}" ]]; then
  if [[ -f "${TEAM_UP_SCRIPTS}/usage-watcher.mjs" ]]; then
    WATCHER="${TEAM_UP_SCRIPTS}/usage-watcher.mjs"
  elif [[ -f "${TEAM_UP_SCRIPTS}/../src/usage/usage-watcher.mjs" ]]; then
    WATCHER="${TEAM_UP_SCRIPTS}/../src/usage/usage-watcher.mjs"
  fi
fi

if [[ ! -f "$WATCHER" ]]; then
  cat >&2 <<'EOF'
team-up-usage-watcher: usage-watcher.mjs not found.

Install one of:
  ln -sf team-up package scripts/team-up-usage-watcher.sh ~/.local/bin/team-up-usage-watcher
  # or set TEAM_UP_SCRIPTS=team-up package scripts (systemd drop-in / cron env)
EOF
  exit 127
fi

NODE="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "team-up-usage-watcher: node not found (set NODE_BIN)" >&2
  exit 127
fi

exec "$NODE" "$WATCHER" "$@"
