import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  addBot, buildCommunicationView, listSenders, loadComm, removeBot, senderKey, setListen, setReplies, setRoute,
} from "../../src/dashboard/communication.mjs";
import { BUILTIN_JOBS } from "../../src/dashboard/automation.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/telegram.py");
const TOKEN = (n) => `${n}23456:${"A".repeat(35)}`;
const fakeFetch = (url) => {
  const token = url.match(/bot([^/]+)\//)[1];
  const ok = token.endsWith("A".repeat(35));
  return Promise.resolve({ json: async () => (ok ? { ok: true, result: { username: `Bot${token[0]}` } } : { ok: false, description: "Unauthorized" }) });
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comm-"));
  const env = { ...process.env, TEAM_UP_HOME: path.join(dir, "tu") };
  const cron = path.join(dir, "cron.env");
  const owned = path.join(dir, "owned.env");
  fs.writeFileSync(cron, `TELEGRAM_BOT_TOKEN=${TOKEN(1)}\nTELEGRAM_CHAT_ID=42\n`);
  fs.writeFileSync(owned, `TELEGRAM_BOT_TOKEN=${TOKEN(2)}\n`);
  const known = [{ file: cron, owner: null, isDefault: true }, { file: owned, owner: "someone else" }];
  return { dir, env, cron, known, opts: { env, fetchFn: fakeFetch } };
}

test("first load imports the host's bots, none listening; the cron bot carries everything else", async () => {
  const { env, known } = setup();
  const cfg = await loadComm({ env, fetchFn: fakeFetch, known });
  assert.deepEqual(cfg.bots.map((b) => [b.id, b.imported, b.owner, b.listen]), [["bot1", true, null, false], ["bot2", true, "someone else", false]]);
  assert.equal(cfg.default, "bot1");
});

test("a v1 file keeps working: a reply action other than off becomes listening", async () => {
  const { env } = setup();
  fs.mkdirSync(env.TEAM_UP_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.TEAM_UP_HOME, "communication.json"), JSON.stringify({
    default: "a", routes: {}, bots: [{ id: "a", env: "/x", reply: { action: "run" } }, { id: "b", env: "/y", reply: { action: "off" } }],
  }));
  const cfg = await loadComm({ env });
  assert.deepEqual(cfg.bots.map((b) => [b.id, b.listen, "reply" in b]), [["a", true, false], ["b", false, false]]);
  assert.equal(cfg.replies.model, "claude:claude-sonnet");
});

test("add, route to a bot or the bell, refuse unsafe removes; imported env files stay", async () => {
  const { env, known, cron, opts } = setup();
  await loadComm({ env, fetchFn: fakeFetch, known });
  await assert.rejects(addBot({ token: "nope" }, opts), /does not look like/);
  const added = await addBot({ token: TOKEN(3) }, opts);
  const file = path.join(env.TEAM_UP_HOME, "telegram", "bot3.env");
  assert.equal(added.id, "bot3");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /TELEGRAM_CHAT_ID=42/); // chat id taken from the existing bot

  await setRoute("stale-runs", "bot3", opts);
  await setRoute("harness-health", "bell", opts);
  await assert.rejects(setRoute("stale-runs", "ghost", opts), /unknown bot/);
  await assert.rejects(removeBot("bot3", opts), /still carries stale-runs/);
  await assert.rejects(removeBot("bot1", opts), /Everything not listed/);
  await setRoute("stale-runs", null, opts);
  await removeBot("bot3", opts);
  assert.equal(fs.existsSync(file), false);

  // Moving "everything else" pins the listed jobs that followed it.
  await setRoute("*", "bot2", { ...opts, listed: ["stale-runs", "harness-health"] });
  const cfg = await loadComm({ env });
  assert.deepEqual([cfg.default, cfg.routes["stale-runs"], cfg.routes["harness-health"]], ["bot2", "bot1", "bell"]);
  await setRoute("stale-runs", "bell", opts);
  await removeBot("bot1", opts);
  assert.equal(fs.existsSync(cron), true); // imported: someone else's file

  const view = await buildCommunicationView({ env, fetchFn: fakeFetch, exec: () => "" });
  assert.equal(JSON.stringify(view).includes("A".repeat(35)), false, "a view never carries a token");
});

test("listening: owned bots stay with their owner; a change drops the offset so no backlog replays", async () => {
  const { env, known, opts } = setup();
  await loadComm({ env, fetchFn: fakeFetch, known });
  await assert.rejects(setListen("bot2", true, opts), /read by someone else/);
  const offset = path.join(env.TEAM_UP_HOME, "telegram", "offsets", "bot1");
  fs.mkdirSync(path.dirname(offset), { recursive: true });
  fs.writeFileSync(offset, "7");
  await setListen("bot1", true, opts);
  assert.equal(fs.existsSync(offset), false);
  assert.equal((await loadComm({ env })).bots[0].listen, true);
});

test("new sessions run on a claude model in an existing folder", async () => {
  const { env, known, dir, opts } = setup();
  await loadComm({ env, fetchFn: fakeFetch, known });
  const modelOptions = ["claude:claude-sonnet", "codex:gpt-6-luna"];
  await assert.rejects(setReplies({ model: "codex:gpt-6-luna", cwd: dir }, { ...opts, modelOptions }), /claude/);
  await assert.rejects(setReplies({ model: "claude:claude-sonnet", cwd: "/no/such" }, { ...opts, modelOptions }), /folder/);
  await setReplies({ model: "claude:claude-sonnet", cwd: dir, instructions: "hi" }, { ...opts, modelOptions });
  assert.deepEqual((await loadComm({ env })).replies, { model: "claude:claude-sonnet", cwd: dir, instructions: "hi" });
});

test("every listed sender's key is the one telegram.py derives from the script that sends", () => {
  const scripts = BUILTIN_JOBS.filter((j) => j.notifies).map((j) => j.match)
    .concat(["tim-db-header-watchdog.sh", "tim-wal-watchdog.sh", "tim-snapshot-watchdog.sh"]);
  const py = spawnSync("python3", ["-c", `
import sys, os
for s in sys.argv[1:]:
    n = os.path.basename(s); print(n.rsplit(".", 1)[0] if n.endswith((".sh", ".py")) else n)`, ...scripts], { encoding: "utf8" });
  const keys = listSenders({ exec: () => "" }).filter((s) => s.group !== "Your jobs").map((s) => s.key);
  assert.deepEqual(keys, py.stdout.trim().split("\n"));
  assert.deepEqual(keys, scripts.map(senderKey));
});

test("telegram.py self-test: routing fallbacks and the footer round trip", () => {
  const r = spawnSync("python3", [SCRIPT, "--selftest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
