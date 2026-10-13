import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  addBot, buildCommunicationView, loadComm, removeBot, setDefaultBot, setReply, setRoute,
} from "../../src/dashboard/communication.mjs";

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
  return { dir, env, cron, owned, known };
}

test("first load imports the host's bots; the cron bot is the default", async () => {
  const { env, known } = setup();
  const cfg = await loadComm({ env, fetchFn: fakeFetch, known });
  assert.deepEqual(cfg.bots.map((b) => [b.id, b.imported, b.owner]), [["bot1", true, null], ["bot2", true, "someone else"]]);
  assert.equal(cfg.default, "bot1");
});

test("add, route, refuse unsafe removes, remove keeps imported env files", async () => {
  const { env, known, cron } = setup();
  await loadComm({ env, fetchFn: fakeFetch, known });
  await assert.rejects(addBot({ token: "nope" }, { env, fetchFn: fakeFetch }), /does not look like/);
  const added = await addBot({ token: TOKEN(3) }, { env, fetchFn: fakeFetch });
  assert.equal(added.id, "bot3");
  const file = path.join(env.TEAM_UP_HOME, "telegram", "bot3.env");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /TELEGRAM_CHAT_ID=42/); // chat id taken from the existing bot

  await setRoute("stale-runs", "bot3", { env, fetchFn: fakeFetch });
  await assert.rejects(setRoute("stale-runs", "ghost", { env, fetchFn: fakeFetch }), /unknown bot/);
  await assert.rejects(removeBot("bot3", { env, fetchFn: fakeFetch }), /still carries stale-runs/);
  await assert.rejects(removeBot("bot1", { env, fetchFn: fakeFetch }), /default bot/);
  await setRoute("stale-runs", null, { env, fetchFn: fakeFetch });
  await removeBot("bot3", { env, fetchFn: fakeFetch });
  assert.equal(fs.existsSync(file), false);

  await setDefaultBot("bot2", { env, fetchFn: fakeFetch });
  await removeBot("bot1", { env, fetchFn: fakeFetch });
  assert.equal(fs.existsSync(cron), true); // imported: someone else's file

  const view = await buildCommunicationView({ env, fetchFn: fakeFetch, exec: () => "" });
  assert.equal(JSON.stringify(view).includes("A".repeat(35)), false, "a view never carries a token");
});

test("replies: owned bots stay with their owner, agent runs need a known model and a real folder", async () => {
  const { env, known, dir } = setup();
  await loadComm({ env, fetchFn: fakeFetch, known });
  const opts = { env, fetchFn: fakeFetch, modelOptions: ["claude:claude-sonnet"] };
  await assert.rejects(setReply("bot2", { action: "bell" }, opts), /handled by someone else/);
  await assert.rejects(setReply("bot1", { action: "run", model: "x:y", cwd: dir }, opts), /model/);
  await assert.rejects(setReply("bot1", { action: "run", model: "claude:claude-sonnet", cwd: "/no/such" }, opts), /working directory/);
  await setReply("bot1", { action: "run", model: "claude:claude-sonnet", cwd: dir }, opts);
  const cfg = await loadComm({ env });
  assert.deepEqual(cfg.bots[0].reply, { action: "run", model: "claude:claude-sonnet", cwd: dir, instructions: "" });
});

test("telegram-route.py: route, default, removed bot and missing file fall back", () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/telegram-route.py");
  const r = spawnSync("python3", [script, "--selftest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
