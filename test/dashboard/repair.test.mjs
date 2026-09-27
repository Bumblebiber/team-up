import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REPAIR_ROLE,
  buildRepairPrompt,
  repairStatePath,
  parseSpawnedSession,
  readRepairState,
  readRepairReport,
  repairReportPath,
  spawnUsageRepair,
} from "../../src/dashboard/repair.mjs";
import { buildCollectorView, buildUsageView } from "../../src/dashboard/data.mjs";

function withHome(fn) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-"));
    try {
      return fn({ TEAM_UP_HOME: dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const NOW = Date.parse("2026-09-25T16:00:00.000Z");

test("prompt names the stale windows, the recorded reason, and the CLI under test", () => {
  const prompt = buildRepairPrompt({
    cli: "cursor",
    windows: {
      "cursor:auto": { used: 0.54, updated_at: "2026-09-23T12:09:56.278Z" },
      "codex:weekly": { used: 0.19, updated_at: "2026-09-25T15:59:00.000Z" },
    },
    failures: [{ at: "2026-09-25T15:57:18.106Z", reason: "cursor collect timed out" }],
    now: NOW,
  });
  assert.match(prompt, /cursor:auto/);
  assert.match(prompt, /cursor collect timed out/);
  // Other CLIs' windows are noise for this investigation.
  assert.ok(!prompt.includes("codex:weekly"));
  // The technique that actually found the last bug of this kind must survive.
  assert.match(prompt, /STAGE n done/);
  assert.match(prompt, /buildExpectScript\("cursor"/);
  // The point is a verified fix, not a write-up.
  assert.match(prompt, /node src\/usage\/usage-collect\.mjs --cli cursor/);
  assert.match(prompt, /npm test/);
  // Anti-cheat: the gate downstream trusts these numbers.
  assert.match(prompt, /forbidden/i);
  assert.match(prompt, /usage\.json by hand/);
  assert.match(prompt, /widening the stale threshold/);
  assert.match(prompt, /never `git add -A`/);
  // "cannot be collected" must stay a legal answer, or it will invent one.
  assert.match(prompt, /STOP, change nothing/);
});

test("prompt says so plainly when no window for that CLI exists at all", () => {
  const prompt = buildRepairPrompt({ cli: "cursor", windows: {}, failures: [], now: NOW });
  assert.match(prompt, /no cursor: windows in usage\.json/);
  assert.match(prompt, /none recorded/);
});

test("parseSpawnedSession reads the session name dispatch prints", () => {
  assert.equal(
    parseSpawnedSession("model: claude-opus\ntmux session: team-up-team-up-architect-ab12\nattach: tmux attach -t x"),
    "team-up-team-up-architect-ab12",
  );
  assert.equal(parseSpawnedSession("no session here"), null);
});

test("state is absent until a spawn records one", withHome((env) => {
  assert.deepEqual(readRepairState("cursor", { env, sessionExists: () => true }), {
    running: false,
    session: null,
    started_at: null,
  });
}));

test("spawn dispatches the architect role and remembers the session", withHome((env) => {
  const calls = [];
  const result = spawnUsageRepair("cursor", {
    env,
    usage: { windows: { "cursor:auto": { used: 0.5, updated_at: "2026-09-23T12:09:56.278Z" } } },
    failures: [{ at: "2026-09-25T15:57:18.106Z", reason: "empty-parse" }],
    now: NOW,
    exec: (bin, args) => {
      calls.push({ bin, args });
      return "tmux session: team-up-arch-1\n";
    },
    sessionExists: () => false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.session, "team-up-arch-1");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("dispatch"));
  assert.ok(calls[0].args.includes("--role"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--role") + 1], REPAIR_ROLE);
  // No --model pin: the role chain is the point (Opus first, GPT-6-Sol on fallback).
  assert.ok(!calls[0].args.includes("--model"));
  const promptFile = calls[0].args[calls[0].args.indexOf("--prompt-file") + 1];
  assert.match(fs.readFileSync(promptFile, "utf8"), /empty-parse/);
  assert.equal(JSON.parse(fs.readFileSync(repairStatePath("cursor", env), "utf8")).session, "team-up-arch-1");
}));

test("a second click joins the live session instead of spawning a rival agent", withHome((env) => {
  fs.writeFileSync(
    repairStatePath("cursor", env),
    JSON.stringify({ session: "team-up-arch-1", started_at: "2026-09-25T15:00:00.000Z" }),
  );
  let spawned = 0;
  const result = spawnUsageRepair("cursor", {
    env,
    now: NOW,
    exec: () => { spawned += 1; return "tmux session: other\n"; },
    sessionExists: (s) => s === "team-up-arch-1",
  });
  assert.equal(spawned, 0, "must not dispatch a second agent");
  assert.deepEqual(
    { ok: result.ok, joined: result.joined, session: result.session },
    { ok: true, joined: true, session: "team-up-arch-1" },
  );
}));

test("a dead session is not joined — the next click starts a fresh repair", withHome((env) => {
  fs.writeFileSync(repairStatePath("cursor", env), JSON.stringify({ session: "gone" }));
  const result = spawnUsageRepair("cursor", {
    env,
    now: NOW,
    exec: () => "tmux session: team-up-arch-2\n",
    sessionExists: () => false,
  });
  assert.equal(result.joined, undefined);
  assert.equal(result.session, "team-up-arch-2");
}));

test("a dispatch that reports no session is an error, not a half-recorded state", withHome((env) => {
  const result = spawnUsageRepair("cursor", {
    env,
    now: NOW,
    exec: () => "skipped claude-opus: window claude:week at 96%\n",
    sessionExists: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.ok(!fs.existsSync(repairStatePath("cursor", env)));
}));

test("the report survives the pane and is readable back", withHome((env) => {
  assert.deepEqual(readRepairReport("cursor", { env }), { present: false, text: null });
  fs.writeFileSync(repairReportPath("cursor", env), "# root cause\nanchor moved\n");
  const report = readRepairReport("cursor", { env });
  assert.equal(report.present, true);
  assert.match(report.text, /anchor moved/);
}));

test("a new repair clears the previous report, so a stale one cannot pose as this result", withHome((env) => {
  fs.writeFileSync(repairReportPath("cursor", env), "# from an earlier attempt\n");
  spawnUsageRepair("cursor", {
    env,
    now: NOW,
    exec: () => "tmux session: team-up-arch-3\n",
    sessionExists: () => false,
  });
  assert.equal(readRepairReport("cursor", { env }).present, false);
}));

test("collector view surfaces the newest failure reason per CLI", () => {
  const view = buildCollectorView({
    last_collect: { cursor: "2026-09-23T12:09:06.993Z", codex: "2026-09-25T16:13:10.237Z" },
    collect_failures: {
      cursor: [
        { at: "2026-09-25T15:57:18.106Z", reason: "old" },
        { at: "2026-09-25T16:13:10.237Z", reason: "cursor collect timed out" },
      ],
      codex: [],
    },
  });
  assert.equal(view.cursor.last_reason, "cursor collect timed out");
  assert.equal(view.cursor.failure_count, 2);
  assert.equal(view.codex.last_reason, null);
  assert.deepEqual(view.cursor.repair, { running: false, session: null, started_at: null });
});

test("usage view carries collectors so the badge can explain itself", () => {
  const view = buildUsageView(
    { windows: { "cursor:auto": { used: 0.5, updated_at: "2026-09-23T12:09:56.278Z" } } },
    { usage_watcher: { intervals: { active_min: 5 } } },
    NOW,
    {
      watcher: { last_collect: { cursor: "2026-09-23T12:09:06.993Z" }, collect_failures: { cursor: [{ at: "x", reason: "empty-parse" }] } },
      repairs: { cursor: { running: true, session: "s1", started_at: "t" } },
    },
  );
  assert.equal(view.windows["cursor:auto"].stale, true);
  assert.equal(view.collectors.cursor.last_reason, "empty-parse");
  assert.equal(view.collectors.cursor.repair.running, true);
});

test("usage view still builds with no watcher state at all", () => {
  const view = buildUsageView({ windows: {} }, {}, NOW);
  assert.deepEqual(view.collectors, {});
});

// --- endpoint ---------------------------------------------------------------

import { createDashboardServer, ensureDashboardToken } from "../../src/dashboard/server.mjs";

function withServerHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-diag-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  fs.writeFileSync(
    path.join(home, "roster.json"),
    JSON.stringify({
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      models: { m: { provider: "anthropic", cli: ["claude"] } },
      roles: { planner: { chain: ["m"] } },
      usage_watcher: { intervals: { active_min: 5 } },
    }),
  );
  fs.writeFileSync(
    path.join(home, "usage.json"),
    JSON.stringify({ windows: { "cursor:auto": { used: 0.5, updated_at: "2026-09-23T12:09:56.278Z" } }, marked: {} }),
  );
  fs.writeFileSync(
    path.join(home, "usage-watcher.json"),
    JSON.stringify({
      last_collect: { cursor: "2026-09-23T12:09:06.993Z" },
      collect_failures: { cursor: [{ at: "2026-09-25T15:57:18.106Z", reason: "cursor collect timed out" }] },
    }),
  );
  const token = ensureDashboardToken(process.env);
  return fn({ home, token }).finally(() => {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

/** A failed assert must not leave the server listening — node --test would hang. */
async function withServer(opts, fn) {
  const { server } = createDashboardServer(opts);
  const port = await listen(server);
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

async function post(port, urlPath, token) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Team-Up-CSRF": "1",
    },
    body: "{}",
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("one POST starts the repair and returns the session to open", () =>
  withServerHome(async ({ token }) => {
    const calls = [];
    await withServer({
      token,
      exec: (bin, args) => {
        calls.push({ bin, args });
        return "tmux session: team-up-arch-9\n";
      },
      sessionExists: () => false,
    }, async (port) => {
      const r = await post(port, "/api/usage/cursor/repair", token);
      assert.equal(r.status, 200);
      assert.equal(r.json.session, "team-up-arch-9");
      const dispatched = calls.find((c) => c.args.includes("dispatch"));
      assert.ok(dispatched, "expected a team-up dispatch");
      assert.equal(dispatched.args[dispatched.args.indexOf("--role") + 1], REPAIR_ROLE);
    });
  }));

test("a CLI that is not a subscription cannot be repaired", () =>
  withServerHome(async ({ token }) => {
    await withServer({ token, exec: () => "", sessionExists: () => false }, async (port) => {
      const r = await post(port, "/api/usage/bogus/repair", token);
      assert.equal(r.status, 404);
    });
  }));

test("the usage endpoint ships the collector reason behind the STALE badge", () =>
  withServerHome(async ({ token }) => {
    await withServer({ token, exec: () => "", sessionExists: () => false }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/usage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      assert.equal(data.windows["cursor:auto"].stale, true);
      assert.equal(data.collectors.cursor.last_reason, "cursor collect timed out");
    });
  }));

test("an auth_failure streak is kept apart from parse reasons and earns a suggestion", () => {
  const auth = (at) => ({ at, reason: "auth_failure" });
  const view = buildCollectorView({
    collect_failures: {
      // three in a row: account, not parser — suggest disabling
      cursor: [{ at: "t0", reason: "empty-parse" }, auth("t1"), auth("t2"), auth("t3")],
      // a parse failure after the auth ones: the login is not the current story
      codex: [auth("t1"), auth("t2"), { at: "t3", reason: "cursor collect timed out" }],
      // one is enough to say "login", not enough to suggest an account change
      claude: [auth("t1")],
    },
  });
  assert.equal(view.cursor.auth_failure_streak, 3);
  assert.equal(view.cursor.suggest_disable, true);
  assert.equal(view.codex.auth_failure, false);
  assert.equal(view.codex.auth_failure_streak, 0);
  assert.equal(view.claude.auth_failure, true);
  assert.equal(view.claude.suggest_disable, false);
});
