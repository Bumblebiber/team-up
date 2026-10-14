#!/bin/sh
# worker-exit-guard.sh <mailbox-dir> <cli argv...>
#
# The pane command of every worker tmux session. Runs the worker CLI (or the
# headless wrapper) and, when that process ends while the run is still open,
# closes the mailbox as failed. Nothing else notices a worker that crashed,
# was OOM-killed or exited on a bad flag: the watcher waits on mailbox files,
# gc skips an active run whose session is gone, and the stale report needs
# 12 h. A kill-session never gets here: its hangup ends this shell too.
#
# Only open states are closed. Terminal ones are the worker's own word, and
# waiting_capacity / waiting_decision / handoff_* belong to a park that
# resumes the run later.
mb=$1
shift
"$@"
code=$?
status=$(tr -d '[:space:]' 2>/dev/null <"$mb/STATUS")
case $status in
  starting|watching|waiting_human|"") ;;
  *) exit "$code" ;;
esac
if [ "$code" -gt 128 ]; then how="was killed by signal $((code - 128))"; else how="exited with code $code"; fi
# Same order as setWorkerMailboxStatus: the reason first, then STATUS, each
# written whole so a watcher never reads half a file.
printf 'The worker process %s while STATUS was %s; nothing closed the mailbox.\n' \
  "$how" "${status:-unset}" >"$mb/FAILURE.md.tmp" && mv -f "$mb/FAILURE.md.tmp" "$mb/FAILURE.md"
printf 'failed' >"$mb/STATUS.tmp" && mv -f "$mb/STATUS.tmp" "$mb/STATUS"
exit "$code"
