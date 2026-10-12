// notifications.mjs — what the dashboard's bell lists (~/.team-up/notifications.json).
// Events a human should hear about but not be paged for: a CLI started
// offering a model family the roster has never seen, for one.

import path from "node:path";
import { loadJson, atomicWriteJson } from "./json-store.mjs";
import { teamUpHome } from "./paths.mjs";

const KEEP = 100;
const file = (env) => path.join(teamUpHome(env), "notifications.json");

export function listNotifications(env = process.env) {
  const items = loadJson(file(env))?.items;
  return Array.isArray(items) ? items : [];
}

/** Add `{ key, title, text, link? }` items; a key already listed is not added twice. */
export function addNotifications(items, { env = process.env, now = new Date() } = {}) {
  if (!items.length) return [];
  const current = listNotifications(env);
  const known = new Set(current.map((n) => n.key));
  const fresh = items.filter((n) => !known.has(n.key))
    .map((n, i) => ({ id: `${now.getTime().toString(36)}-${i}`, at: now.toISOString(), read: false, ...n }));
  if (fresh.length) atomicWriteJson(file(env), { items: [...fresh, ...current].slice(0, KEEP) });
  return fresh;
}

/** Mark the given ids read, or every item when `ids` is omitted. */
export function markNotificationsRead(ids = null, env = process.env) {
  const want = ids ? new Set(ids.map(String)) : null;
  const items = listNotifications(env).map((n) => (!want || want.has(n.id) ? { ...n, read: true } : n));
  atomicWriteJson(file(env), { items });
  return { unread: items.filter((n) => !n.read).length };
}
