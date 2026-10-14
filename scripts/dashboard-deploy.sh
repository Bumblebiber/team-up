#!/usr/bin/env bash
# Keeps the live dashboard on origin/main. team-up-dashboard.service runs from
# its own checkout (~/.local/share/team-up-dashboard, detached HEAD), not from
# ~/projects/team-up, where sessions leave half-done work. A timer runs this
# every two minutes: whatever reached origin/main — a push or a merged PR — is
# live shortly after, and nothing unmerged ever is.
set -euo pipefail

# One block, parsed before it runs: the checkout below rewrites this file.
{
checkout="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
git -C "$checkout" fetch -q origin main
target="$(git -C "$checkout" rev-parse origin/main)"
[[ "$(git -C "$checkout" rev-parse HEAD)" == "$target" ]] && exit 0

deps_changed=0
git -C "$checkout" diff --quiet HEAD "$target" -- package.json package-lock.json || deps_changed=1
git -C "$checkout" checkout -q --detach "$target"
if (( deps_changed )); then
  (cd "$checkout" && npm ci --omit=dev --no-audit --no-fund)
fi
systemctl --user restart team-up-dashboard.service
echo "dashboard deployed $(git -C "$checkout" log -1 --format='%h %s')"
exit 0
}
