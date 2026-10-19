import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDashboardServer,
  ensureDashboardToken,
  sendPaneKeys as sendPaneKeysForTest,
} from "../../src/dashboard/server.mjs";
import { createAdminGate } from "../../src/dashboard/admin.mjs";
import { createRun, atomicWriteText } from "../../src/runs/runs.mjs";
import { escalateRun } from "../../src/runs/observe.mjs";
import { secretsPath } from "../../src/paths.mjs";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dash-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "roster.json"),
    JSON.stringify({
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      models: { m: { provider: "anthropic", cli: ["claude"] } },
      roles: { planner: { chain: ["m"] } },
    }),
  );
  fs.writeFileSync(path.join(home, "usage.json"), JSON.stringify({ windows: {}, marked: {} }));
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
  const { port } = server.address();
  return port;
}

async function req(port, urlPath, { method = "GET", token, cookie, body, csrf, origin, host = "127.0.0.1" } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";
  if (csrf) headers["X-Team-Up-CSRF"] = "1";
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://${host}:${port}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: res.status, headers: res.headers, json, text };
}

test("401 without token", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, "/api/runs");
    assert.equal(r.status, 401);
    server.close();
  }));

test("token in query string is rejected", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, `/api/runs?token=${token}`, { token });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /query string/i);
    server.close();
  }));

test("login rejects query string token even with valid body", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, `/api/login?token=${token}`, { method: "POST", body: { token } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("set-cookie"), null);
    server.close();
  }));

test("valid bearer returns 200", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, "/api/runs", { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.runs));
    server.close();
  }));

test("GET /api/cron-jobs reports a missing file and available model options", () =>
  withHome(async ({ home, token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, "/api/cron-jobs", { token });
    assert.equal(r.status, 200);
    assert.equal(r.json.path, path.join(home, "cron-jobs.ini"));
    assert.equal(r.json.exists, false);
    assert.deepEqual(r.json.jobs, []);
    assert.deepEqual(r.json.options, ["claude:m"]);
    server.close();
  }));

test("GET /api/cron-jobs parses the configured file", () =>
  withHome(async ({ home, token }) => {
    fs.writeFileSync(path.join(home, "cron-jobs.ini"), "# jobs\n[golden-task]\nmodel = claude:m\n[insights]\n");
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, "/api/cron-jobs", { token });
    assert.equal(r.status, 200);
    assert.equal(r.json.exists, true);
    assert.deepEqual(r.json.jobs, [
      { name: "golden-task", model: "claude:m" },
      { name: "insights", model: null },
    ]);
    server.close();
  }));

test("POST /api/cron-jobs writes selected model and copies backup first", () =>
  withHome(async ({ home, token }) => {
    const file = path.join(home, "cron-jobs.ini");
    const original = "# keep\n[golden-task]\nmodel = old\n\n[insights]\nmodel = claude:m\n";
    fs.writeFileSync(file, original);
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/cron-jobs/golden-task", {
      method: "POST", cookie, csrf: true, body: { model: "claude:m" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.backup, "cron-jobs.ini.bak");
    assert.equal(fs.readFileSync(file, "utf8"), original.replace("model = old", "model = claude:m"));
    assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), original);
    server.close();
  }));

test("POST /api/cron-jobs requires auth token and CSRF header", () =>
  withHome(async ({ home, token }) => {
    fs.writeFileSync(path.join(home, "cron-jobs.ini"), "[golden-task]\nmodel = claude:m\n");
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const noCsrf = await req(port, "/api/cron-jobs/golden-task", {
      method: "POST", cookie, body: { model: "claude:m" },
    });
    assert.equal(noCsrf.status, 403);
    const noToken = await req(port, "/api/cron-jobs/golden-task", {
      method: "POST", csrf: true, body: { model: "claude:m" },
    });
    assert.equal(noToken.status, 401);
    server.close();
  }));

test("POST /api/cron-jobs rejects an unavailable model without changing file", () =>
  withHome(async ({ home, token }) => {
    const file = path.join(home, "cron-jobs.ini");
    const original = "[golden-task]\nmodel = claude:m\n";
    fs.writeFileSync(file, original);
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/cron-jobs/golden-task", {
      method: "POST", cookie, csrf: true, body: { model: "missing:model" },
    });
    assert.equal(r.status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    server.close();
  }));

test("POST /api/cron-jobs never creates a missing section", () =>
  withHome(async ({ home, token }) => {
    const file = path.join(home, "cron-jobs.ini");
    const original = "[known]\nmodel = claude:m\n";
    fs.writeFileSync(file, original);
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/cron-jobs/missing", {
      method: "POST", cookie, csrf: true, body: { model: "claude:m" },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown cron job/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.bak`), false);
    server.close();
  }));

test("login POST sets HttpOnly cookie", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const login = await req(port, "/api/login", { method: "POST", body: { token } });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const r = await req(port, "/api/runs", { cookie: setCookie.split(";")[0] });
    assert.equal(r.status, 200);
    server.close();
  }));

test("invalid run id returns 400", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, "/api/runs/not-valid", { token });
    assert.equal(r.status, 400);
    server.close();
  }));

test("path traversal in run id is rejected", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, "/api/runs/..%2F..%2Fetc%2Fpasswd", { token });
    assert.ok(r.status === 400 || r.status === 404);
    server.close();
  }));

test("unknown tmux session returns 404", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({
      token,
      listSessions: () => ["known-session"],
    });
    const port = await listen(server);
    const r = await req(port, "/api/tmux/unknown-session/pane", { token });
    assert.equal(r.status, 404);
    server.close();
  }));

test("known tmux session returns pane", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({
      token,
      listSessions: () => ["known-session"],
      capturePane: () => "pane output\n",
    });
    const port = await listen(server);
    const r = await req(port, "/api/tmux/known-session/pane", { token });
    assert.equal(r.status, 200);
    assert.equal(r.json.pane, "pane output\n");
    server.close();
  }));

test("pane endpoint captures each session once per second", () =>
  withHome(async ({ token }) => {
    let captures = 0;
    const { server } = createDashboardServer({
      token,
      listSessions: () => ["known-session"],
      capturePane: () => { captures++; return "pane output\n"; },
    });
    const port = await listen(server);
    const first = await req(port, "/api/tmux/known-session/pane", { token });
    const second = await req(port, "/api/tmux/known-session/pane", { token });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(captures, 1);
    server.close();
  }));

test("non-GET methods return 405 except login POST", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await req(port, "/api/runs", { method, token });
      assert.equal(r.status, 405, method);
    }
    server.close();
  }));

async function loginCookie(port, token) {
  const login = await req(port, "/api/login", { method: "POST", body: { token } });
  return login.headers.get("set-cookie")?.split(";")[0] || "";
}

async function grantAdmin(port, cookie, adminGate, { viaHttp = true } = {}) {
  const gate = adminGate || createAdminGate({ log: () => {} });
  const challenge = gate.issueChallenge();
  assert.equal(challenge.ok, true);
  const code = gate.peekChallengeCode();
  assert.ok(code, "expected confirmation code on gate");
  if (viaHttp) {
    const confirm = await req(port, "/api/admin/confirm", {
      method: "POST",
      cookie,
      csrf: true,
      body: { challenge_id: challenge.challenge_id, code },
    });
    assert.equal(confirm.status, 200);
  } else {
    const cookieToken = cookie.includes("=") ? cookie.slice(cookie.indexOf("=") + 1) : cookie;
    const result = gate.confirm({
      challenge_id: challenge.challenge_id,
      code,
      cookieToken,
    });
    assert.equal(result.ok, true);
  }
  return gate;
}

test("the login cookie outlives the browser session", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const login = await req(port, "/api/login", { method: "POST", body: { token } });
    const cookie = login.headers.get("set-cookie") || "";
    // A session cookie means re-pasting the token after every browser restart.
    assert.match(cookie, /Max-Age=\d+/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    server.close();
  }));

test("POST without CSRF header is refused", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/roles/not-a-role", { method: "POST", cookie, body: {} });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /csrf/i);
    server.close();
  }));

test("foreign Origin on POST is refused", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/roles/not-a-role", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://evil.example",
      body: {},
    });
    assert.equal(r.status, 403);
    server.close();
  }));

test("the configured public origin passes the CSRF check", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token, publicOrigin: "https://dash.example", requireAdminConfirm: true });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/roles/not-a-role", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "https://dash.example",
      body: {},
    });
    // Past the origin gate, so the next gate is the one that answers.
    assert.equal(r.status, 403);
    assert.match(r.json.error, /admin confirmation/i);
    server.close();
  }));

test("several public origins are accepted, one per name the host answers to", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({
      token,
      publicOrigin: "http://strato:8556, http://strato.example.ts.net:8556",
      requireAdminConfirm: true,
    });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    for (const origin of ["http://strato:8556", "http://strato.example.ts.net:8556"]) {
      const r = await req(port, "/api/roles/not-a-role", {
        method: "POST",
        cookie,
        csrf: true,
        origin,
        body: {},
      });
      assert.match(r.json.error, /admin confirmation/i, `${origin} should pass the origin gate`);
    }
    server.close();
  }));

test("a public origin does not open the door to other origins", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token, publicOrigin: "https://dash.example" });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/roles/not-a-role", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://evil.example",
      body: {},
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /origin/i);
    server.close();
  }));

test("write without admin capability is refused when the gate is on", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token, requireAdminConfirm: true });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/roles/not-a-role", {
      method: "POST",
      cookie,
      csrf: true,
      body: {},
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /admin confirmation/i);
    server.close();
  }));

test("expired admin capability is refused", () =>
  withHome(async ({ token }) => {
    let ts = Date.now();
    const adminGate = createAdminGate({ now: () => ts });
    const { server } = createDashboardServer({ token, adminGate, requireAdminConfirm: true });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    await grantAdmin(port, cookie, adminGate);
    ts += adminGate.CAPABILITY_TTL_MS + 1;
    const r = await req(port, "/api/roles/not-a-role", {
      method: "POST",
      cookie,
      csrf: true,
      body: {},
    });
    assert.equal(r.status, 403);
    server.close();
  }));

test("write endpoint on non-loopback bind is refused", () =>
  withHome(async ({ token }) => {
    const adminGate = createAdminGate({ log: () => {} });
    const { server } = createDashboardServer({ token, host: "0.0.0.0", adminGate });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    await grantAdmin(port, cookie, adminGate, { viaHttp: false });
    const r = await req(port, "/api/roles/not-a-role", {
      method: "POST",
      cookie,
      csrf: true,
      body: {},
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /non-loopback/i);
    server.close();
  }));

test("malformed cookie does not 500", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, "/api/runs", { cookie: "%%%bad" });
    assert.equal(r.status, 401);
    server.close();
  }));

test("openrouter key write never returns full value", () =>
  withHome(async ({ token }) => {
    const adminGate = createAdminGate({ log: () => {} });
    const example = "sk-EXAMPLE-abcdef91f";
    const fetchFn = async (url) => {
      if (String(url).includes("/key")) {
        return { ok: true, status: 200, json: async () => ({ data: { label: "t" } }) };
      }
      throw new Error("unexpected fetch");
    };
    const { server } = createDashboardServer({ token, adminGate, fetchFn, requireAdminConfirm: true });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    await grantAdmin(port, cookie, adminGate);
    const r = await req(port, "/api/providers/openrouter/key", {
      method: "POST",
      cookie,
      csrf: true,
      body: { key: example },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.hint, "…f91f");
    assert.ok(!r.text.includes(example));
    const mode = fs.statSync(secretsPath()).mode & 0o777;
    assert.equal(mode, 0o600);
    server.close();
  }));

test("run detail reads mailbox inside run dir only", () =>
  withHome(async ({ token }) => {
    const state = createRun({
      cwd: "/tmp",
      role: "planner",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "claude", tmux: "team-up-test" },
      prompt: "hello task",
      now: new Date("2026-09-22T10:00:00.000Z"),
    });
    atomicWriteText(path.join(process.env.TEAM_UP_HOME, "runs", state.runId, "mailbox", "RESULT.md"), "done work");
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, `/api/runs/${state.runId}`, { token });
    assert.equal(r.status, 200);
    assert.match(r.json.mailbox["PROMPT.md"], /hello task/);
    assert.equal(r.json.mailbox["RESULT.md"], "done work\n");
    server.close();
  }));

test("mailbox read stops at 256 KB", () =>
  withHome(async ({ token }) => {
    const state = createRun({
      cwd: "/tmp",
      role: "planner",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "claude" },
      prompt: "hello task",
    });
    const result = path.join(process.env.TEAM_UP_HOME, "runs", state.runId, "mailbox", "RESULT.md");
    fs.writeFileSync(result, `${"x".repeat(300 * 1024)}TAIL_SENTINEL`);
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, `/api/runs/${state.runId}`, { token });
    assert.equal(r.status, 200);
    assert.match(r.json.mailbox["RESULT.md"], /\[truncated\]$/);
    assert.ok(!r.json.mailbox["RESULT.md"].includes("TAIL_SENTINEL"));
    server.close();
  }));

test("mailbox directory symlink cannot read outside the run", () =>
  withHome(async ({ home, token }) => {
    const state = createRun({
      cwd: "/tmp", role: "planner",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "claude" }, prompt: "hello task",
    });
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "PROMPT.md"), "OUTSIDE_SENTINEL");
    const mailbox = path.join(home, "runs", state.runId, "mailbox");
    fs.rmSync(mailbox, { recursive: true });
    fs.symlinkSync(outside, mailbox);
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const r = await req(port, `/api/runs/${state.runId}`, { token });
    assert.notEqual(r.status, 200);
    assert.ok(!r.text.includes("OUTSIDE_SENTINEL"));
    server.close();
  }));

after(() => {
  // allow server close handlers to finish
});

test("a write goes through without the admin gate", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    // An unknown CLI id: past the gate, refused by the handler itself. Any
    // endpoint that does its real work would reach the network from here.
    const r = await req(port, "/api/clis/nope/install", { method: "POST", cookie, csrf: true, body: {} });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown cli id/i);
    server.close();
  }));

test("a refused write is written to the audit log", () =>
  withHome(async ({ home, token }) => {
    const { server } = createDashboardServer({ token, requireAdminConfirm: true });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    await req(port, "/api/roles/not-a-role", { method: "POST", cookie, csrf: true, body: {} });
    server.close();
    // The refusal happens before the handler, so this line is the only record
    // that anyone tried at all.
    const lines = fs.readFileSync(path.join(home, "dashboard-audit.log"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const denied = lines.find((l) => l.action === "write.denied");
    assert.ok(denied, `expected a write.denied line, got ${JSON.stringify(lines)}`);
    assert.equal(denied.target, "/api/roles/not-a-role");
    assert.equal(denied.result, "fail");
  }));

test("a write refused for a bad origin is audited too", () =>
  withHome(async ({ home, token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    await req(port, "/api/roles/not-a-role", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://evil.example",
      body: {},
    });
    server.close();
    const lines = fs.readFileSync(path.join(home, "dashboard-audit.log"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.action === "write.denied" && /csrf/.test(l.detail)));
  }));

function withTermServer(token, sent) {
  return createDashboardServer({
    token,
    listSessions: () => ["team-up-install-cursor"],
    sendKeys: (session, payload) => sent.push({ session, ...payload }),
  });
}

test("a printable key is sent to the session literally", () =>
  withHome(async ({ token }) => {
    const sent = [];
    const { server } = withTermServer(token, sent);
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/tmux/team-up-install-cursor/keys", {
      method: "POST",
      cookie,
      csrf: true,
      body: { text: "q" },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(sent, [{ session: "team-up-install-cursor", text: "q", key: null }]);
    server.close();
  }));

test("named and control keys pass, invented ones do not", () =>
  withHome(async ({ token }) => {
    const sent = [];
    const { server } = withTermServer(token, sent);
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    for (const key of ["Enter", "C-c", "Up"]) {
      const ok = await req(port, "/api/tmux/team-up-install-cursor/keys", {
        method: "POST", cookie, csrf: true, body: { key },
      });
      assert.equal(ok.status, 200, key);
    }
    // send-keys reads its argument as a key name, so anything outside the list
    // is a way to press keys nobody typed.
    for (const key of ["kill-session", "C-", "Enter Enter", ""]) {
      const bad = await req(port, "/api/tmux/team-up-install-cursor/keys", {
        method: "POST", cookie, csrf: true, body: { key },
      });
      assert.equal(bad.status, 400, key);
    }
    assert.equal(sent.length, 3);
    server.close();
  }));

test("control characters are refused in literal text", () =>
  withHome(async ({ token }) => {
    const sent = [];
    const { server } = withTermServer(token, sent);
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    for (const text of ["\u0003", "ls\n", "", "x".repeat(257)]) {
      const r = await req(port, "/api/tmux/team-up-install-cursor/keys", {
        method: "POST", cookie, csrf: true, body: { text },
      });
      assert.equal(r.status, 400, JSON.stringify(text));
    }
    assert.deepEqual(sent, []);
    server.close();
  }));

test("keys to an unknown session are refused", () =>
  withHome(async ({ token }) => {
    const sent = [];
    const { server } = withTermServer(token, sent);
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/tmux/nope/keys", {
      method: "POST", cookie, csrf: true, body: { text: "q" },
    });
    assert.equal(r.status, 404);
    assert.deepEqual(sent, []);
    server.close();
  }));

test("sending keys without the CSRF header is refused", () =>
  withHome(async ({ token }) => {
    const sent = [];
    const { server } = withTermServer(token, sent);
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/tmux/team-up-install-cursor/keys", {
      method: "POST",
      cookie,
      body: { text: "q" },
    });
    assert.equal(r.status, 403);
    assert.deepEqual(sent, []);
    server.close();
  }));

test("a scrolled pane leaves copy-mode before the key is sent", () => {
  const calls = [];
  sendPaneKeysForTest("s1", { text: "q", key: null }, {
    exec: (cmd, args) => calls.push([cmd, ...args].join(" ")),
  });
  // copy-mode swallows keys and send-keys still exits 0, so without this the
  // terminal looks broken and the log says everything worked.
  assert.deepEqual(calls, ["tmux copy-mode -q -t s1", "tmux send-keys -t s1 -l q"]);
});

test("creating and trusting a command policy go through the audited write path", () =>
  withHome(async ({ home, token }) => {
    const root = fs.mkdtempSync(path.join(os.homedir(), ".teamup-test-projects-"));
    const project = path.join(root, "alpha");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const { server } = createDashboardServer({ token, exec: () => "", listSessions: () => [] });
    try {
      const port = await listen(server);
      const cookie = await loginCookie(port, token);
      const before = await req(port, `/api/projects?dir=${encodeURIComponent(root)}`, { cookie });
      assert.equal(before.json.projects[0].policy.state, "missing");

      const body = { dir: project, projects_dir: root };
      const noCsrf = await req(port, "/api/projects/policy", { method: "POST", cookie, body });
      assert.equal(noCsrf.status, 403);

      const created = await req(port, "/api/projects/policy", { method: "POST", cookie, csrf: true, body });
      assert.equal(created.status, 200, created.text);
      const again = await req(port, "/api/projects/policy", { method: "POST", cookie, csrf: true, body });
      assert.equal(again.status, 409);

      // The write invalidates the listing: no stale "missing" for a second.
      const after = await req(port, `/api/projects?dir=${encodeURIComponent(root)}`, { cookie });
      assert.equal(after.json.projects[0].policy.state, "valid");

      const trusted = await req(port, "/api/projects/trust-policy", { method: "POST", cookie, csrf: true, body });
      assert.equal(trusted.status, 200, trusted.text);
      assert.equal(trusted.json.ok, true);
      const trustedList = await req(port, `/api/projects?dir=${encodeURIComponent(root)}`, { cookie });
      assert.equal(trustedList.json.projects[0].policy.trusted, true);

      const lines = fs.readFileSync(path.join(home, "dashboard-audit.log"), "utf8")
        .trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(
        lines.filter((l) => l.action.startsWith("project.")).map((l) => [l.action, l.result]),
        [["project.policy", "ok"], ["project.policy", "fail"], ["project.trust_policy", "ok"]],
      );
    } finally {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

test("trending serves the newest report, 404 while there is none", () =>
  withHome(async ({ home, token }) => {
    const dir = path.join(home, "trending");
    fs.mkdirSync(dir);
    const { server } = createDashboardServer({ token, env: { ...process.env, TEAM_UP_TRENDING_DIR: dir } });
    const port = await listen(server);
    try {
      assert.equal((await req(port, "/api/trending")).status, 401);
      const none = await req(port, "/api/trending", { token });
      assert.equal(none.status, 404);
      assert.match(none.json.error, /no trending/);
      fs.writeFileSync(path.join(dir, "trending-2026-10-09.md"),
        "## 🆕 New\n| [x](https://github.com/a/x) | 1,234 | 2026-10-08 | Go | d |\n");
      const r = await req(port, "/api/trending", { token });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, {
        date: "2026-10-09",
        sections: [{ title: "🆕 New", repos: [{ name: "x", url: "https://github.com/a/x", stars: 1234, created: "2026-10-08", lang: "Go", description: "d" }] }],
      });
    } finally {
      server.close();
    }
  }));

test("prefs round-trip through the server so every device shares one layout", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    assert.deepEqual((await req(port, "/api/prefs", { token })).json, {});
    const prefs = { "teamup.layout": '{"order":[["a"],["b"],["c"],["d"]]}' };
    assert.equal((await req(port, "/api/prefs", { method: "POST", token, body: prefs })).status, 403, "csrf");
    assert.equal((await req(port, "/api/prefs", { method: "POST", token, csrf: true, body: prefs })).status, 200);
    assert.deepEqual((await req(port, "/api/prefs", { token })).json, prefs);
    const bad = await req(port, "/api/prefs", { method: "POST", token, csrf: true, body: { other: "x" } });
    assert.equal(bad.status, 400);
    server.close();
  }));

test("claude sessions: the socket stays server-side, stop is audited, long text refused", () =>
  withHome(async ({ home, token }) => {
    const calls = [];
    const session = { pid: 42, name: "chat", socket: "/run/x.sock" };
    const { server } = createDashboardServer({
      token,
      claudeSessions: {
        list: () => [session],
        stop: (pid) => (calls.push(["stop", pid]), { ok: true, session }),
        send: (pid, text) => (calls.push(["send", pid, text]), { ok: true, session }),
      },
    });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const list = await req(port, "/api/claude-sessions", { token });
    assert.deepEqual(list.json.sessions, [{ pid: 42, name: "chat", canMessage: true }]);
    const stop = await req(port, "/api/claude-sessions/42/stop", { method: "POST", cookie, csrf: true, body: {} });
    assert.equal(stop.status, 200);
    const long = await req(port, "/api/claude-sessions/42/message", {
      method: "POST", cookie, csrf: true, body: { text: "x".repeat(4001) },
    });
    assert.equal(long.status, 400);
    const noCsrf = await req(port, "/api/claude-sessions/42/stop", { method: "POST", cookie, body: {} });
    assert.equal(noCsrf.status, 403);
    assert.deepEqual(calls, [["stop", 42]]);
    const audit = fs.readFileSync(path.join(home, "dashboard-audit.log"), "utf8");
    assert.match(audit, /"action":"claude.stop","target":"42 chat","result":"ok"/);
    server.close();
  }));

// A run left waiting on a human, one QUESTIONS.md block per question, the way
// escalateRun appends them — as the worker's own questions.
function waitingRun(...questions) {
  const { runId } = createRun({
    cwd: "/tmp", role: "planner", parent: { cli: "claude", attach: "manual" }, worker: { cli: "claude" }, prompt: "p",
  });
  for (const q of questions) escalateRun(runId, q, { source: "worker" });
  return runId;
}
const acItem = (r, runId) => r.json.items.find((i) => i.runId === runId);

test("inbox: a one-line subject in the list, the whole newest question in the item, its own --- rules included", () =>
  withHome(async ({ token }) => {
    const long = `Which store?\n\n---\n\n1. Postgres\n2. SQLite\n\n${"Consequences. ".repeat(300)}END`;
    const runId = waitingRun("Old, answered question?", long);
    const { server } = createDashboardServer({ token, exec: () => "" });
    const port = await listen(server);
    try {
      const list = await req(port, "/api/action-center", { token });
      assert.deepEqual(list.json.counts, { question: 1, problem: 0, result: 0 });
      assert.equal(acItem(list, runId).subject, "Which store?");
      const item = await req(port, `/api/action-center/item/${runId}`, { token });
      assert.equal(item.status, 200, item.text);
      assert.equal(item.json.body, long);
      assert.deepEqual(item.json.history.map((h) => h.question), ["Old, answered question?"]);
      assert.equal((await req(port, "/api/action-center/item/..%2Fetc", { token })).status, 400);
      assert.equal((await req(port, "/api/action-center/item/not-a-run-id", { token })).status, 400, "the route's own id check");
      assert.equal((await req(port, "/api/action-center/item/20200101T000000Z-none", { token })).status, 404);
    } finally {
      server.close();
    }
  }));

test("an answered question leaves the inbox at once; a second answer is refused, not sent twice", () =>
  withHome(async ({ token }) => {
    const runId = waitingRun("Which store?");
    const { server } = createDashboardServer({ token, exec: () => "" });
    const port = await listen(server);
    const answer = (reason) => req(port, `/api/runs/${runId}/action`, {
      method: "POST", token, csrf: true, body: { action: "answer", reason },
    });
    try {
      assert.ok(acItem(await req(port, "/api/action-center", { token }), runId));
      const first = await answer("SQLite");
      assert.equal(first.status, 200, first.text);
      assert.equal(acItem(await req(port, "/api/action-center", { token }), runId), undefined);
      const second = await answer("Postgres");
      assert.equal(second.status, 409);
      assert.equal(second.json.error, "already answered");
      assert.equal((await req(port, `/api/action-center/item/${runId}`, { token })).json.answer, "SQLite");
    } finally {
      server.close();
    }
  }));

test("a bad collecting folder still lists waiting runs; runs carry a project name", () =>
  withHome(async ({ token }) => {
    const runId = waitingRun("Which store?");
    const { server } = createDashboardServer({ token, exec: () => "" });
    const port = await listen(server);
    try {
      const r = await req(port, "/api/action-center?dir=not-absolute", { token });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(acItem(r, runId).project, { label: null, name: "tmp" });
      const runs = await req(port, "/api/runs", { token });
      assert.equal(runs.json.runs.find((row) => row.runId === runId).project, "tmp");
    } finally {
      server.close();
    }
  }));

// ── Projects and Team routes: the wiring the unit tests cannot see ──

function plantSpecialist(home, id, displayName) {
  const dir = path.join(home, "specialists", id, "0.1.0", "aaa");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify({
    schema_version: 2, id, display_name: displayName, version: "0.1.0",
    remit: ["x"], anti_remit: [], call_types: ["delegate"],
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: { filesystem: "project", writes: false, network: false, commands: [] },
    budget: { timeout_seconds: 600 },
  }));
  const entry = { id, version: "0.1.0", checksum: "sha256:" + "a".repeat(64), path: dir, installed_at: "2026-10-01T00:00:00.000Z" };
  fs.writeFileSync(path.join(home, "specialists-index.json"),
    JSON.stringify({ specialists: { [id]: entry }, versions: { [id]: [entry] } }));
}

test("a project row lists its sessions under the roster's CLIs, task sessions included", () =>
  withHome(async ({ token }) => {
    const root = fs.mkdtempSync(path.join(os.homedir(), ".teamup-test-projects-"));
    fs.mkdirSync(path.join(root, "alpha"));
    fs.mkdirSync(path.join(root, "alpha-x"));
    const tmux = ["team-up-proj-alpha-claude", "team-up-proj-alpha-claude-01jtask", "team-up-proj-alpha-x-claude"];
    const exec = (cmd) => (cmd === "tmux" ? tmux.join("\n") : "");
    const { server } = createDashboardServer({ token, exec });
    try {
      const port = await listen(server);
      const r = await req(port, `/api/projects?dir=${encodeURIComponent(root)}`, { token });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.clis, ["claude"]);
      const row = (name) => r.json.projects.find((p) => p.name === name);
      assert.deepEqual(row("alpha").sessions, ["team-up-proj-alpha-claude", "team-up-proj-alpha-claude-01jtask"]);
      assert.deepEqual(row("alpha-x").sessions, ["team-up-proj-alpha-x-claude"]);
    } finally {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

test("the Team and Roles routes carry model, last run and who uses a role", () =>
  withHome(async ({ home, token }) => {
    plantSpecialist(home, "research.reanna", "Reanna");
    const { runId } = createRun({
      cwd: "/tmp",
      role: "specialist:research.reanna",
      parent: { cli: "claude", attach: "manual" },
      worker: { cli: "claude", tmux: "team-up-test" },
      prompt: "look it up",
    });
    const { server } = createDashboardServer({ token, exec: () => "" });
    try {
      const port = await listen(server);
      const usedBy = async () => (await req(port, "/api/roles", { token })).json.roles.find((r) => r.role === "planner").usedBy;
      assert.deepEqual(await usedBy(), []);

      const assigned = await req(port, "/api/specialists/research.reanna/assign", {
        method: "POST", token, csrf: true, body: { role: "planner" },
      });
      assert.equal(assigned.status, 200, assigned.text);
      // The assignment shows at once, not after the roles memo runs out.
      assert.deepEqual(await usedBy(), [{ id: "research.reanna", name: "Reanna" }]);

      const r = await req(port, "/api/specialists", { token });
      assert.equal(r.status, 200, r.text);
      const [reanna] = r.json.specialists;
      assert.deepEqual(reanna.assignment, { role: "planner" });
      assert.equal(reanna.category, "research");
      assert.deepEqual([reanna.model, reanna.modelReason], ["m", null]);
      assert.equal(reanna.lastRun.runId, runId);
      assert.deepEqual(reanna.lastRun.project, { label: null, name: "tmp" });
    } finally {
      server.close();
    }
  }));

test("the page carries the roster language in <html lang>, and /i18n.js loads before app.js", () =>
  withHome(async ({ home, token }) => {
    // A bot of our own, so the communication view never imports the host's.
    const botEnv = path.join(home, "bot.env");
    fs.writeFileSync(botEnv, `TELEGRAM_BOT_TOKEN=1:${"A".repeat(35)}\nTELEGRAM_CHAT_ID=42\n`);
    fs.writeFileSync(path.join(home, "communication.json"), JSON.stringify({ default: "b", routes: {}, bots: [{ id: "b", env: botEnv }] }));
    const sent = [];
    const fetchFn = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { json: async () => ({ ok: true }) };
    };
    const { server } = createDashboardServer({ token, exec: () => "", fetchFn });
    const port = await listen(server);
    try {
      assert.match((await req(port, "/")).text, /<html lang="en">/, "no language set = English");
      const cookie = await loginCookie(port, token);
      const saved = await req(port, "/api/settings", { method: "POST", cookie, csrf: true, body: { path: "language", value: "de" } });
      assert.equal(saved.status, 200, saved.text);
      const page = (await req(port, "/")).text;
      assert.match(page, /<html lang="de">/);
      assert.ok(page.indexOf('src="/i18n.js"') < page.indexOf('src="/app.js"'));
      const script = await req(port, "/i18n.js");
      assert.equal(script.status, 200);
      assert.match(script.headers.get("content-type"), /javascript/);
      const preview = await req(port, "/api/automation/preview?schedule=0%206%20*%20*%20*", { cookie });
      assert.equal(preview.json.text, "täglich um 06:00");
      // Every route that builds text passes the roster language on.
      const spender = (await req(port, "/api/automation", { cookie })).json.builtin.find((j) => j.id === "usage-spender");
      assert.equal(spender.title, "Usage-Spender");
      assert.equal(spender.where, "Nicht in deiner Crontab");
      const comm = await req(port, "/api/communication", { cookie });
      assert.ok(comm.json.senders.some((s) => s.title === "TIM-Backups"), comm.text);
      const test = await req(port, "/api/communication/bots/b/test", { method: "POST", cookie, csrf: true, body: {} });
      assert.equal(test.status, 200, test.text);
      assert.deepEqual(sent, [{ chat_id: "42", text: "Test aus dem team-up-Dashboard (Kommunikation)." }]);
      // A broken roster must not take the login page down.
      fs.writeFileSync(path.join(home, "roster.json"), "{");
      assert.match((await req(port, "/")).text, /<html lang="en">/);
    } finally {
      server.close();
    }
  }));
