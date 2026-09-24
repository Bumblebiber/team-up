import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { teamUpHome } from "../paths.mjs";
import { loadJson, configPath, usagePath } from "../roster/config.mjs";
import { listAllStates, loadState, runDir } from "../runs/runs.mjs";
import { listTmuxSessions, tmuxSessionExists } from "../runs/tmux.mjs";
import { assertPathInsideRoot } from "../specialists/safe-id.mjs";
import {
  isValidRunId,
  buildRunsView,
  joinTmuxSessions,
  buildUsageView,
  buildPickAllView,
  buildModelsView,
  readMailboxFiles,
  sanitizeForDashboard,
} from "./data.mjs";
import { loadScores, collectScores, buildRoleScores, writeScores } from "../scores/scores.mjs";
import { scoresPath } from "../paths.mjs";
import { createAdminGate } from "./admin.mjs";
import { appendAudit } from "./audit.mjs";
import {
  buildProvidersView,
  readOpenRouterKey,
  isOpenRouterWritable,
  validateOpenRouterKey,
  writeOpenRouterKey,
  removeOpenRouterKey,
} from "./providers.mjs";
import { buildClisView, commandExists } from "./clis.mjs";
import {
  isValidCliId,
  bootstrapAvailable,
  updateAvailable,
  loginAvailable,
  hermesInstallRefusal,
  spawnCliJob,
  readInstallLog,
  classifyVerificationVerdict,
  installState,
  installSessionName,
} from "./installers.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const COOKIE_NAME = "team_up_dashboard";
const MAX_BODY = 4096;

export function dashboardTokenPath(env = process.env) {
  return path.join(teamUpHome(env), "dashboard-token");
}

export function ensureDashboardToken(env = process.env, { rotate = false } = {}) {
  const tokenPath = dashboardTokenPath(env);
  if (!rotate) {
    try {
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing) {
        fs.chmodSync(tokenPath, 0o600);
        return existing;
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  return token;
}

function timingSafeTokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1);
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      /* skip malformed cookie pair */
    }
  }
  return out;
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function serverOrigin(host, req) {
  const port = req.socket?.localPort;
  if (!port) return `http://${host}`;
  return `http://${host === "::1" ? "127.0.0.1" : host}:${port}`;
}

function rejectQueryToken(url) {
  const q = url.indexOf("?");
  if (q === -1) return false;
  const search = url.slice(q + 1);
  return /(^|&)(token|auth|access_token|bearer)=/i.test(search);
}

function createMemo(ttlMs = 1000) {
  const cache = new Map();
  return {
    get(key, fn) {
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < ttlMs) return hit.value;
      const value = fn();
      cache.set(key, { at: now, value });
      return value;
    },
  };
}

function isClientRequestError(e) {
  return e instanceof SyntaxError;
}

function auditServerFailure(env, action, target) {
  appendAudit(
    { actor: "127.0.0.1", action, target, result: "fail" },
    { env },
  );
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function textResponse(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function heartbeatMtimes() {
  const out = {};
  for (const state of listAllStates()) {
    try {
      const hb = path.join(runDir(state.runId), "mailbox", "HEARTBEAT");
      out[state.runId] = fs.statSync(hb).mtimeMs;
    } catch {
      /* no heartbeat */
    }
  }
  return out;
}

function safeReadMailboxFile(name, runRoot, maxBytes = 256 * 1024) {
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("invalid mailbox file name");
  }
  const realRunsRoot = fs.realpathSync(path.dirname(runRoot));
  const realRunRoot = fs.realpathSync(runRoot);
  const realMailbox = fs.realpathSync(path.join(runRoot, "mailbox"));
  assertPathInsideRoot(realRunRoot, realRunsRoot);
  assertPathInsideRoot(realMailbox, realRunRoot);
  const filePath = assertPathInsideRoot(path.join(runRoot, "mailbox", name), runRoot);
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("invalid mailbox file");
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, read).toString("utf8");
    return stat.size > maxBytes ? `${content}\n… [truncated]` : content;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function capturePaneLines(session, lines = 200, { exec = execFileSync, listSessions = listTmuxSessions } = {}) {
  const known = listSessions({ exec });
  if (!known.includes(session)) return null;
  try {
    const raw = exec("tmux", ["capture-pane", "-t", session, "-p", "-S", `-${lines}`], {
      encoding: "utf8",
    });
    return raw;
  } catch {
    return "";
  }
}

function loadRoster(env) {
  const roster = loadJson(configPath(env));
  if (!roster) throw new Error("no roster");
  return roster;
}

export function createDashboardServer({
  env = process.env,
  host = "127.0.0.1",
  token,
  exec = execFileSync,
  listSessions = () => listTmuxSessions({ exec }),
  capturePane = (session) => capturePaneLines(session, 200, { exec, listSessions }),
  io = { out: console.log, err: console.error },
  now = () => Date.now(),
  adminGate = createAdminGate({ now, log: (msg) => io.out(msg) }),
  fetchFn = globalThis.fetch,
  allowInstall = false,
  publicOrigin = env.TEAMUP_DASHBOARD_ORIGIN || "",
  sessionExists = (session) => tmuxSessionExists(session, { exec }),
} = {}) {
  const expectedToken = token ?? ensureDashboardToken(env);
  const memo = createMemo();
  const clisMemo = createMemo(30_000);
  const openrouterValidation = {};
  const auditedJobCompletion = new Set();

  function isAuthed(req) {
    if (rejectQueryToken(req.url || "")) return false;
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
      return timingSafeTokenEqual(auth.slice(7).trim(), expectedToken);
    }
    const cookies = parseCookies(req.headers.cookie);
    return timingSafeTokenEqual(cookies[COOKIE_NAME] || "", expectedToken);
  }

  function requireAuth(req, res) {
    if (rejectQueryToken(req.url || "")) {
      jsonResponse(res, 401, { error: "query string tokens are not accepted" });
      return false;
    }
    if (!isAuthed(req)) {
      jsonResponse(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  }

  function authCookie(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[COOKIE_NAME] || "";
  }

  function checkCsrf(req, res) {
    if (req.headers["x-team-up-csrf"] !== "1") {
      jsonResponse(res, 403, { error: "csrf header required" });
      return false;
    }
    const origin = req.headers.origin;
    if (origin) {
      // Behind a reverse proxy (nginx, `tailscale serve`) the browser sends the
      // public origin, never the loopback bind — so without this the operator
      // has to rewrite the Origin header in the proxy, which is exactly the
      // check being defeated. One configured origin is the honest version.
      const allowed = serverOrigin(host, req);
      if (origin !== allowed && !(publicOrigin && origin === publicOrigin)) {
        jsonResponse(res, 403, { error: "origin not allowed" });
        return false;
      }
    }
    return true;
  }

  function requireWriteAccess(req, res) {
    if (!isLoopbackHost(host)) {
      jsonResponse(res, 403, { error: "write endpoints disabled on non-loopback bind" });
      return false;
    }
    if (!checkCsrf(req, res)) return false;
    const cookie = authCookie(req);
    if (!cookie || !adminGate.hasCapability(cookie)) {
      jsonResponse(res, 403, { error: "admin confirmation required" });
      return false;
    }
    return true;
  }

  async function handle(req, res) {
    if (rejectQueryToken(req.url || "")) {
      jsonResponse(res, 401, { error: "query string tokens are not accepted" });
      return;
    }
    let url;
    let pathname;
    try {
      url = new URL(req.url || "/", "http://localhost");
      pathname = decodeURIComponent(url.pathname);
    } catch {
      jsonResponse(res, 400, { error: "invalid path" });
      return;
    }

    if (pathname.includes("..")) {
      jsonResponse(res, 400, { error: "invalid path" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/login") {
      try {
        const body = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        if (!timingSafeTokenEqual(String(parsed.token || ""), expectedToken)) {
          jsonResponse(res, 401, { error: "invalid token" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `${COOKIE_NAME}=${expectedToken}; HttpOnly; SameSite=Strict; Path=/`,
        });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        jsonResponse(res, 400, { error: "bad request" });
      }
      return;
    }

    const isApi = pathname.startsWith("/api/");
    if (isApi && !requireAuth(req, res)) return;

    if (req.method === "POST" && pathname === "/api/admin/challenge") {
      if (!isLoopbackHost(host)) {
        jsonResponse(res, 403, { error: "write endpoints disabled on non-loopback bind" });
        return;
      }
      if (!checkCsrf(req, res)) return;
      const challenge = adminGate.issueChallenge();
      if (!challenge.ok) {
        appendAudit(
          { actor: "127.0.0.1", action: "admin.challenge", target: null, result: "fail" },
          { env },
        );
        jsonResponse(res, 429, { error: challenge.error });
        return;
      }
      appendAudit(
        { actor: "127.0.0.1", action: "admin.challenge", target: null, result: "ok" },
        { env },
      );
      jsonResponse(res, 200, { challenge_id: challenge.challenge_id, expires_at: challenge.expires_at });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/confirm") {
      if (!isLoopbackHost(host)) {
        jsonResponse(res, 403, { error: "write endpoints disabled on non-loopback bind" });
        return;
      }
      if (!checkCsrf(req, res)) return;
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const cookie = authCookie(req);
        const result = adminGate.confirm({
          challenge_id: body.challenge_id,
          code: body.code,
          cookieToken: cookie,
        });
        appendAudit(
          {
            actor: "127.0.0.1",
            action: "admin.confirm",
            target: null,
            result: result.ok ? "ok" : "fail",
          },
          { env },
        );
        if (!result.ok) {
          jsonResponse(res, 403, { error: result.error });
          return;
        }
        jsonResponse(res, 200, { ok: true, expires_at: result.expires_at });
      } catch {
        jsonResponse(res, 400, { error: "bad request" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/providers/openrouter/key") {
      if (!requireWriteAccess(req, res)) return;
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const key = String(body.key || "").trim();
        if (!key) {
          jsonResponse(res, 400, { error: "key required" });
          return;
        }
        if (/[\r\n]/.test(key)) {
          jsonResponse(res, 400, { error: "key must not contain line breaks" });
          return;
        }
        const roster = loadRoster(env);
        if (!isOpenRouterWritable({ env, roster })) {
          jsonResponse(res, 403, { error: "key is read-only (env or external file)" });
          return;
        }
        const validation = await validateOpenRouterKey(key, { fetchFn });
        if (!validation.ok) {
          appendAudit(
            {
              actor: "127.0.0.1",
              action: "provider.connect",
              target: "openrouter",
              result: "fail",
              hint: key.length >= 4 ? `…${key.slice(-4)}` : null,
            },
            { env },
          );
          jsonResponse(res, 400, { error: validation.error, status: validation.status || null });
          return;
        }
        const hadKey = !!readOpenRouterKey({ env, roster }).key;
        writeOpenRouterKey(key, { env });
        const hint = `…${key.slice(-4)}`;
        openrouterValidation.openrouter = {
          at: new Date(now()).toISOString(),
          verdict: "ok",
          label: validation.label,
          limit: validation.limit,
        };
        appendAudit(
          {
            actor: "127.0.0.1",
            action: hadKey ? "provider.rotate" : "provider.connect",
            target: "openrouter",
            result: "ok",
            hint,
          },
          { env },
        );
        jsonResponse(res, 200, {
          ok: true,
          hint,
          label: validation.label,
          limit: validation.limit,
          source: "file",
        });
      } catch (e) {
        if (isClientRequestError(e)) {
          jsonResponse(res, 400, { error: "bad request" });
          return;
        }
        auditServerFailure(env, "provider.connect", "openrouter");
        jsonResponse(res, 500, { error: "server error" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/providers/openrouter/validate") {
      if (!requireWriteAccess(req, res)) return;
      try {
        const roster = loadRoster(env);
        const { key } = readOpenRouterKey({ env, roster });
        if (!key) {
          jsonResponse(res, 400, { error: "no key configured" });
          return;
        }
        const validation = await validateOpenRouterKey(key, { fetchFn });
        const hint = `…${key.slice(-4)}`;
        openrouterValidation.openrouter = {
          at: new Date(now()).toISOString(),
          verdict: validation.ok ? "ok" : "fail",
          label: validation.label,
          limit: validation.limit,
        };
        appendAudit(
          {
            actor: "127.0.0.1",
            action: "provider.validate",
            target: "openrouter",
            result: validation.ok ? "ok" : "fail",
            hint,
          },
          { env },
        );
        jsonResponse(res, validation.ok ? 200 : 400, {
          ok: validation.ok,
          hint,
          label: validation.label,
          limit: validation.limit,
          error: validation.error || null,
        });
      } catch (e) {
        if (isClientRequestError(e)) {
          jsonResponse(res, 400, { error: "bad request" });
          return;
        }
        auditServerFailure(env, "provider.validate", "openrouter");
        jsonResponse(res, 500, { error: "server error" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/providers/openrouter/remove") {
      if (!requireWriteAccess(req, res)) return;
      try {
        const roster = loadRoster(env);
        const hit = readOpenRouterKey({ env, roster });
        if (!isOpenRouterWritable({ env, roster })) {
          jsonResponse(res, 403, { error: "key is read-only (env or external file)" });
          return;
        }
        const hint = hit.key ? `…${hit.key.slice(-4)}` : null;
        removeOpenRouterKey({ env });
        appendAudit(
          {
            actor: "127.0.0.1",
            action: "provider.remove",
            target: "openrouter",
            result: "ok",
            hint,
          },
          { env },
        );
        jsonResponse(res, 200, { ok: true });
      } catch (e) {
        if (isClientRequestError(e)) {
          jsonResponse(res, 400, { error: "bad request" });
          return;
        }
        auditServerFailure(env, "provider.remove", "openrouter");
        jsonResponse(res, 500, { error: "server error" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/refresh") {
      if (!requireWriteAccess(req, res)) return;
      try {
        const roster = loadRoster(env);
        const collected = await collectScores({ fetchFn, env });
        collected.role_scores = buildRoleScores(collected, roster);
        const dest = writeScores(collected);
        appendAudit(
          { actor: "127.0.0.1", action: "refresh", target: dest, result: "ok" },
          { env },
        );
        jsonResponse(res, 200, { ok: true, path: dest });
      } catch (e) {
        appendAudit(
          { actor: "127.0.0.1", action: "refresh", target: "scores.json", result: "fail" },
          { env },
        );
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    const cliInstallMatch = pathname.match(/^\/api\/clis\/([^/]+)\/install$/);
    if (req.method === "POST" && cliInstallMatch) {
      if (!requireWriteAccess(req, res)) return;
      const cli = cliInstallMatch[1];
      try {
        const roster = loadRoster(env);
        if (!isValidCliId(cli, roster)) {
          jsonResponse(res, 400, { error: "unknown cli id" });
          return;
        }
        const boot = bootstrapAvailable(cli, { allowInstall });
        if (!boot.available) {
          jsonResponse(res, 400, { error: boot.reason });
          return;
        }
        if (cli === "hermes") {
          const refusal = hermesInstallRefusal({ env, exec });
          if (refusal) {
            appendAudit(
              {
                actor: "127.0.0.1",
                action: "cli.install",
                target: cli,
                result: "fail",
                detail: refusal.detail,
              },
              { env },
            );
            jsonResponse(res, 409, refusal);
            return;
          }
        }
        const running = installState(cli, { env, sessionExists });
        if (running.state === "running") {
          jsonResponse(res, 409, { error: "install already running", job: running });
          return;
        }
        const spawned = spawnCliJob(cli, "install", { env, exec, sessionExists });
        if (!spawned.ok) {
          jsonResponse(res, spawned.status, spawned);
          return;
        }
        appendAudit(
          { actor: "127.0.0.1", action: "cli.install", target: cli, result: "ok", detail: "spawned" },
          { env },
        );
        jsonResponse(res, 200, { ok: true, session: spawned.session, command: boot.command, job: spawned.job });
      } catch (e) {
        appendAudit(
          { actor: "127.0.0.1", action: "cli.install", target: cli, result: "fail" },
          { env },
        );
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    const cliUpdateMatch = pathname.match(/^\/api\/clis\/([^/]+)\/update$/);
    if (req.method === "POST" && cliUpdateMatch) {
      if (!requireWriteAccess(req, res)) return;
      const cli = cliUpdateMatch[1];
      try {
        const roster = loadRoster(env);
        if (!isValidCliId(cli, roster)) {
          jsonResponse(res, 400, { error: "unknown cli id" });
          return;
        }
        const upd = updateAvailable(cli);
        if (!upd.available) {
          jsonResponse(res, 400, { error: upd.reason });
          return;
        }
        const running = installState(cli, { env, sessionExists });
        if (running.state === "running") {
          jsonResponse(res, 200, { ok: true, joined: true, job: running });
          return;
        }
        const spawned = spawnCliJob(cli, "update", { env, exec, sessionExists });
        if (!spawned.ok) {
          jsonResponse(res, spawned.status, spawned);
          return;
        }
        appendAudit(
          { actor: "127.0.0.1", action: "cli.update", target: cli, result: "ok", detail: "spawned" },
          { env },
        );
        jsonResponse(res, 200, { ok: true, session: spawned.session, command: upd.command, job: spawned.job });
      } catch (e) {
        appendAudit(
          { actor: "127.0.0.1", action: "cli.update", target: cli, result: "fail" },
          { env },
        );
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    const cliLoginMatch = pathname.match(/^\/api\/clis\/([^/]+)\/login$/);
    if (req.method === "POST" && cliLoginMatch) {
      if (!requireWriteAccess(req, res)) return;
      const cli = cliLoginMatch[1];
      try {
        const roster = loadRoster(env);
        if (!isValidCliId(cli, roster)) {
          jsonResponse(res, 400, { error: "unknown cli id" });
          return;
        }
        const login = loginAvailable(cli);
        if (!login.available) {
          jsonResponse(res, 400, { error: "login not available for this cli" });
          return;
        }
        const running = installState(cli, { env, sessionExists });
        if (running.state === "running") {
          jsonResponse(res, 200, { ok: true, joined: true, job: running });
          return;
        }
        const spawned = spawnCliJob(cli, "login", { env, exec, sessionExists });
        if (!spawned.ok) {
          jsonResponse(res, spawned.status, spawned);
          return;
        }
        appendAudit(
          { actor: "127.0.0.1", action: "cli.login", target: cli, result: "ok", detail: "spawned" },
          { env },
        );
        jsonResponse(res, 200, {
          ok: true,
          session: spawned.session,
          command: login.command,
          attach: `tmux attach -t ${installSessionName(cli)}`,
          job: spawned.job,
        });
      } catch (e) {
        appendAudit(
          { actor: "127.0.0.1", action: "cli.login", target: cli, result: "fail" },
          { env },
        );
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    if (req.method !== "GET" && isApi) {
      jsonResponse(res, 405, { error: "method not allowed" });
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (pathname === "/app.js" || pathname === "/app.css") {
      const file = path.join(PUBLIC_DIR, path.basename(pathname));
      const ext = pathname.endsWith(".css") ? "text/css" : "application/javascript";
      res.writeHead(200, { "Content-Type": `${ext}; charset=utf-8` });
      res.end(fs.readFileSync(file, "utf8"));
      return;
    }

    if (!isApi) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }

    const ts = now();

    if (pathname === "/api/runs") {
      const activeOnly = url.searchParams.get("active") === "1";
      const data = memo.get(`runs:${activeOnly}`, () => {
        const states = listAllStates();
        const heartbeats = heartbeatMtimes();
        return buildRunsView(states, { activeOnly, heartbeats, now: ts });
      });
      jsonResponse(res, 200, data);
      return;
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch) {
      const runId = runMatch[1];
      if (!isValidRunId(runId)) {
        jsonResponse(res, 400, { error: "invalid run id" });
        return;
      }
      const state = loadState(runId);
      if (!state) {
        jsonResponse(res, 404, { error: "run not found" });
        return;
      }
      const data = memo.get(`run:${runId}`, () => {
        const root = runDir(runId);
        const mailbox = readMailboxFiles(runId, {
          runRoot: root,
          readFile: (name, runRoot) => safeReadMailboxFile(name, runRoot),
        });
        const heartbeats = heartbeatMtimes();
        return sanitizeForDashboard({
          state,
          mailbox,
          row: buildRunsView([state], { heartbeats, now: ts }).runs[0],
        });
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/tmux") {
      const data = memo.get("tmux", () => {
        const sessions = listSessions();
        const states = listAllStates();
        return joinTmuxSessions(sessions, states);
      });
      jsonResponse(res, 200, data);
      return;
    }

    const paneMatch = pathname.match(/^\/api\/tmux\/([^/]+)\/pane$/);
    if (paneMatch) {
      const session = paneMatch[1];
      if (!session || session.includes("..")) {
        jsonResponse(res, 400, { error: "invalid session" });
        return;
      }
      const sessions = memo.get("tmux-sessions", () => listSessions());
      if (!sessions.includes(session)) {
        jsonResponse(res, 404, { error: "session not found" });
        return;
      }
      const pane = memo.get(`pane:${session}`, () => capturePane(session));
      if (pane === null) {
        jsonResponse(res, 404, { error: "session not found" });
        return;
      }
      jsonResponse(res, 200, { session, pane });
      return;
    }

    if (pathname === "/api/usage") {
      const data = memo.get("usage", () => {
        const usage = loadJson(usagePath(env)) || {};
        const roster = loadRoster(env);
        return buildUsageView(usage, roster, ts);
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/pick") {
      const data = memo.get("pick", () => {
        const roster = loadRoster(env);
        const usage = loadJson(usagePath(env)) || {};
        return buildPickAllView(roster, usage, ts);
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/providers") {
      const data = memo.get("providers", () => {
        const roster = loadRoster(env);
        return sanitizeForDashboard(
          buildProvidersView({
            roster,
            env,
            cliPresent: (id) => !!commandExists(roster.clis[id]?.cmd?.[0], { exec }),
            lastValidation: openrouterValidation,
          }),
        );
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/models") {
      const q = url.searchParams.get("q") || "";
      const inRosterParam = url.searchParams.get("in_roster");
      const inRoster = inRosterParam === "1" ? true : inRosterParam === "0" ? false : undefined;
      const page = Math.max(0, Number(url.searchParams.get("page") || 0) || 0);
      const data = memo.get(`models:${q}:${inRosterParam}:${page}`, () => {
        const roster = loadRoster(env);
        const scores = loadScores(scoresPath(env)) || { models: {} };
        return sanitizeForDashboard(
          buildModelsView(scores, roster, { q, in_roster: inRoster, page }),
        );
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/clis") {
      const data = clisMemo.get("clis", () => {
        const roster = loadRoster(env);
        return sanitizeForDashboard(buildClisView(roster, { exec, env, allowInstall }));
      });
      jsonResponse(res, 200, data);
      return;
    }

    const cliLogMatch = pathname.match(/^\/api\/clis\/([^/]+)\/install\/log$/);
    if (cliLogMatch) {
      const cli = cliLogMatch[1];
      try {
        const roster = loadRoster(env);
        if (!isValidCliId(cli, roster)) {
          jsonResponse(res, 400, { error: "unknown cli id" });
          return;
        }
        const log = readInstallLog(cli, { env });
        const state = installState(cli, { env, sessionExists });
        const verdict = state.state === "succeeded" && updateAvailable(cli).available
          ? classifyVerificationVerdict(cli, { env, exec, logLines: log.lines })
          : null;
        if ((state.state === "succeeded" || state.state === "failed") && state.exit_code != null) {
          const key = `${cli}:${state.exit_code}:${log.lines.length}`;
          if (!auditedJobCompletion.has(key)) {
            auditedJobCompletion.add(key);
            const phase = log.lines.some((l) => l.includes("phase: verify")) ? "update+verify" : "job";
            appendAudit(
              {
                actor: "127.0.0.1",
                action: "cli.update",
                target: cli,
                result: state.state === "succeeded" ? "ok" : "fail",
                detail: JSON.stringify({
                  phase,
                  exit_code: state.exit_code,
                  verdict: verdict?.verdict ?? null,
                }),
              },
              { env },
            );
          }
        }
        jsonResponse(res, 200, { cli, ...log, install_state: state.state, post_update_verdict: verdict });
      } catch (e) {
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) jsonResponse(res, 500, { error: "internal error" });
    });
  });

  return { server, token: expectedToken, adminGate };
}

export function startDashboard({
  host = "127.0.0.1",
  port = 8556,
  rotateToken = false,
  allowInstall = false,
  publicOrigin = "",
  env = process.env,
  io = { out: console.log, err: console.error },
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    io.err(`warning: dashboard binding to ${host} — use ssh -L for remote access`);
  }
  const token = ensureDashboardToken(env, { rotate: rotateToken });
  const { server } = createDashboardServer({ env, host, token, io, allowInstall, publicOrigin });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      io.out(`dashboard: http://${host}:${actualPort}/`);
      io.out(`token file: ${dashboardTokenPath(env)}`);
      server.on("close", () => resolve({ server, port: actualPort, tokenPath: dashboardTokenPath(env) }));
    });
  });
}
