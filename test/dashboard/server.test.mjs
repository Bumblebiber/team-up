import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDashboardServer, ensureDashboardToken } from "../../src/dashboard/server.mjs";
import { createAdminGate } from "../../src/dashboard/admin.mjs";
import { createRun, atomicWriteText } from "../../src/runs/runs.mjs";
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
    const r = await req(port, "/api/refresh", { method: "POST", cookie, body: {} });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /csrf/i);
    server.close();
  }));

test("foreign Origin on POST is refused", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/refresh", {
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
    const { server } = createDashboardServer({ token, publicOrigin: "https://dash.example" });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/refresh", {
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
    });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    for (const origin of ["http://strato:8556", "http://strato.example.ts.net:8556"]) {
      const r = await req(port, "/api/refresh", {
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
    const r = await req(port, "/api/refresh", {
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

test("write without admin capability is refused", () =>
  withHome(async ({ token }) => {
    const { server } = createDashboardServer({ token });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const r = await req(port, "/api/refresh", {
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
    const { server } = createDashboardServer({ token, adminGate });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    await grantAdmin(port, cookie, adminGate);
    ts += adminGate.CAPABILITY_TTL_MS + 1;
    const r = await req(port, "/api/refresh", {
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
    const r = await req(port, "/api/refresh", {
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
    const { server } = createDashboardServer({ token, adminGate, fetchFn });
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
