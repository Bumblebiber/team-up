import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { teamUpHome } from "../paths.mjs";
import { loadJson, configPath, usagePath } from "../roster/config.mjs";
import { listAllStates, loadState, runDir } from "../runs/runs.mjs";
import { listTmuxSessions } from "../runs/tmux.mjs";
import { assertPathInsideRoot } from "../specialists/safe-id.mjs";
import {
  isValidRunId,
  buildRunsView,
  joinTmuxSessions,
  buildUsageView,
  buildPickAllView,
  readMailboxFiles,
} from "./data.mjs";

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
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function rejectQueryToken(url) {
  const q = url.indexOf("?");
  if (q === -1) return false;
  const search = url.slice(q + 1);
  return /(^|&)(token|auth|access_token|bearer)=/i.test(search);
}

function createMemo() {
  const cache = new Map();
  return {
    get(key, fn) {
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < 1000) return hit.value;
      const value = fn();
      cache.set(key, { at: now, value });
      return value;
    },
  };
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
  now = () => Date.now(),
} = {}) {
  const expectedToken = token ?? ensureDashboardToken(env);
  const memo = createMemo();

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

    if (req.method !== "GET") {
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

    if (!pathname.startsWith("/api/")) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }

    if (!requireAuth(req, res)) return;

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
        return {
          state,
          mailbox,
          row: buildRunsView([state], { heartbeats, now: ts }).runs[0],
        };
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
      if (!listSessions().includes(session)) {
        jsonResponse(res, 404, { error: "session not found" });
        return;
      }
      const pane = capturePane(session);
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

    jsonResponse(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) jsonResponse(res, 500, { error: "internal error" });
    });
  });

  return { server, token: expectedToken };
}

export function startDashboard({
  host = "127.0.0.1",
  port = 8556,
  rotateToken = false,
  env = process.env,
  io = { out: console.log, err: console.error },
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    io.err(`warning: dashboard binding to ${host} — use ssh -L for remote access`);
  }
  const token = ensureDashboardToken(env, { rotate: rotateToken });
  const { server } = createDashboardServer({ env, host, token });
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
