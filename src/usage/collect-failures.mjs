/** Same threshold as usage-watchdog.mjs FAILURE_REPEAT, and <= COLLECT_FAILURE_RING. */
export const AUTH_FAILURE_STREAK = 3;

/**
 * Consecutive auth failures at the tail of the watcher's failure ring.
 */
export function authFailureStreak(list) {
  let n = 0;
  if (!Array.isArray(list)) return 0;
  for (let i = list.length - 1; i >= 0 && list[i]?.reason === "auth_failure"; i -= 1) n += 1;
  return n;
}
