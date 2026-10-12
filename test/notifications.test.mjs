import "./helpers/hermetic-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addNotifications, listNotifications, markNotificationsRead } from "../src/notifications.mjs";
import { newFamilies } from "../src/roster/latest.mjs";

const store = (clis) => ({ clis: Object.fromEntries(Object.entries(clis).map(([cli, ids]) => [cli, { supported: true, models: ids.map((cli_id) => ({ cli_id })) }])) });

test("newFamilies: a new name is news, a version bump or a new effort is not", () => {
  const before = store({ codex: ["gpt-6-sol", "gpt-6-luna"], cursor: ["grok-4.7-high", "composer-2.5"], opencode: ["a/x"] });
  const after = store({
    codex: ["gpt-6-sol", "gpt-7-sol", "gpt-6-luna", "gpt-7-nova"],
    cursor: ["grok-4.7-high", "grok-4.7-low-fast", "grok-5-high", "composer-2.5", "muse-spark-1-high"],
    opencode: ["a/x", "b/brand-new"],
    agy: ["gemini-4-pro"],
  });
  assert.deepEqual(newFamilies(before, after).map((n) => `${n.cli}:${n.family}`), ["codex:gpt-nova", "cursor:muse-spark"]);
});

test("notifications: deduped by key, newest first, marked read", () => {
  const env = { ...process.env, TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tu-notes-")) };
  addNotifications([{ key: "a", title: "A" }], { env, now: new Date(1000) });
  addNotifications([{ key: "a", title: "A again" }, { key: "b", title: "B" }], { env, now: new Date(2000) });
  const items = listNotifications(env);
  assert.deepEqual(items.map((n) => n.title), ["B", "A"]);
  assert.equal(markNotificationsRead([items[0].id], env).unread, 1);
  assert.equal(markNotificationsRead(null, env).unread, 0);
});
