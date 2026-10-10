import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { teamUpHome, usageWatcherStatePath } from "../paths.mjs";
import { readRepairState, readRepairReport, spawnUsageRepair } from "./repair.mjs";
import { loadJson, configPath, usagePath, saveRoster } from "../roster/config.mjs";
import { specialistAssignment } from "../roster/profile.mjs";
import { listAllStates, loadState, runDir } from "../runs/runs.mjs";
import { listTmuxSessions, tmuxSessionExists } from "../runs/tmux.mjs";
import { assertPathInsideRoot } from "../specialists/safe-id.mjs";
import {
  buildSpecialistsView,
  buildCapabilityPoolView,
  installSpecialistFromGithub,
} from "./specialists.mjs";
import {
  listProjects,
  startProjectSession,
  writeProjectPolicy,
  trustProjectPolicyForProject,
} from "./projects.mjs";
import { buildTimView, promptClis, readOpenWork, startTaskSession } from "./tim.mjs";
import { readTrending, trendingDir } from "./trending.mjs";
import { buildCatalogueView, applyCatalogueToggle } from "./catalogue.mjs";
import { buildRolesView, applyRoleEdit, modelLabel, applySpecialistAssignment } from "./roles.mjs";
import { applySettingsEdit, buildSettingsView } from "./settings.mjs";
import { bringToLatest } from "../roster/latest.mjs";
import { loadModelsStore } from "../collectors/models-store.mjs";
import { subscriptionsFromRoster } from "../usage/usage-collect.mjs";
import { atomicWriteText } from "../json-store.mjs";
import { enableCapability, disableCapability } from "../capabilities/assignments.mjs";
import { loadInstalledManifest } from "../specialists/store.mjs";
import { assertSafeSpecialistSegment } from "../specialists/safe-id.mjs";
import {
  isValidRunId,
  buildRunsView,
  joinTmuxSessions,
  buildUsageView,
  buildPickAllView,
  readMailboxFiles,
  sanitizeForDashboard,
} from "./data.mjs";
import { createAdminGate } from "./admin.mjs";
import { createTimViewerProxy, PREFIX as TIM_VIEWER_PREFIX } from "./tim-viewer.mjs";
import { describeSchedule, nextRun, parseSchedule } from "./cron-schedule.mjs";
import {
  admissionResetAction,
  clearMarkAction,
  markLimitedAction,
  markTargets,
  runAction,
  startModelsScan,
} from "./actions.mjs";
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
import { cronJobsPath, cronModelOptions, parseCronJobs, setCronJobModel } from "./cron-jobs.mjs";
import {
  buildAutomationView,
  deleteCustomJob,
  editBuiltin,
  JOB_NAME,
  readJobLog,
  runCustomJobNow,
  saveCustomJob,
  setCustomJobEnabled,
} from "./automation.mjs";
import {
  isValidCliId,
  bootstrapAvailable,
  updateAvailable,
  loginAvailable,
  hermesInstallRefusal,
  spawnCliJob,
  uninstallAvailable,
  readInstallLog,
  classifyVerificationVerdict,
  installState,
  installSessionName,
} from "./installers.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const COOKIE_NAME = "team_up_dashboard";
const MAX_BODY = 4096;
const PREFS_MAX_BODY = 64 * 1024;
/** 90 days. Revoke early with `team-up dashboard --rotate-token`. */
const COOKIE_MAX_AGE_SEC = 90 * 24 * 60 * 60;

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
    // A write that changes what a memoised view reports must not wait out the
    // TTL, or the panel shows the old answer right after the click.
    invalidate(key) {
      cache.delete(key);
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

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
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

/**
 * Keys tmux names instead of sending literally. Anything outside this list and
 * the C-<char> form is refused: send-keys reads its argument as a key name, so
 * an unchecked string is a way to press keys nobody typed.
 */
const TMUX_NAMED_KEYS = new Set([
  "Enter", "Escape", "Tab", "BTab", "BSpace", "Space", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "IC", "DC",
]);

export function sendPaneKeys(session, { text, key }, { exec = execFileSync } = {}) {
  // A pane someone scrolled is in copy-mode, and copy-mode eats every key
  // instead of passing it to the program: send-keys still exits 0, the
  // keystroke simply never arrives. Leaving the mode first is the difference
  // between "nothing happens" and a working terminal.
  try {
    exec("tmux", ["copy-mode", "-q", "-t", session], { stdio: "ignore" });
  } catch { /* not in a mode */ }
  const args = text != null
    ? ["send-keys", "-t", session, "-l", text]
    : ["send-keys", "-t", session, key];
  exec("tmux", args, { stdio: "ignore" });
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
  requireAdminConfirm = false,
  adminGate = createAdminGate({ now, log: (msg) => io.out(msg) }),
  fetchFn = globalThis.fetch,
  allowInstall = false,
  publicOrigin = env.TEAMUP_DASHBOARD_ORIGIN || "",
  sessionExists = (session) => tmuxSessionExists(session, { exec }),
  sendKeys = sendPaneKeys,
  timViewer = createTimViewerProxy({ env }),
} = {}) {
  const expectedToken = token ?? ensureDashboardToken(env);
  // A tailnet or proxy reaches the same dashboard under more than one name
  // (short MagicDNS name and FQDN, say). Reads work under any of them, so a
  // single accepted origin means "everything loads but nothing saves".
  const publicOrigins = new Set(
    (Array.isArray(publicOrigin) ? publicOrigin : String(publicOrigin).split(","))
      .map((o) => o.trim())
      .filter(Boolean),
  );
  const memo = createMemo();
  const clisMemo = createMemo(30_000);
  const timMemo = createMemo(30_000);
  const openrouterValidation = {};
  const auditedJobCompletion = new Set();
  const keyAuditAt = new Map();

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
      if (origin !== allowed && !publicOrigins.has(origin)) {
        jsonResponse(res, 403, { error: "origin not allowed" });
        return false;
      }
    }
    return true;
  }

  // A refused write is the one worth a line: without this, an attempt that
  // never reached its handler left no trace anywhere.
  function auditDeniedWrite(req, detail) {
    appendAudit(
      {
        actor: "127.0.0.1",
        action: "write.denied",
        target: String(req.url || "").split("?")[0],
        result: "fail",
        detail,
      },
      { env },
    );
  }

  function requireWriteAccess(req, res) {
    if (!isLoopbackHost(host)) {
      auditDeniedWrite(req, "non-loopback bind");
      jsonResponse(res, 403, { error: "write endpoints disabled on non-loopback bind" });
      return false;
    }
    if (!checkCsrf(req, res)) {
      auditDeniedWrite(req, "csrf check failed");
      return false;
    }
    if (!requireAdminConfirm) return true;
    const cookie = authCookie(req);
    if (!cookie || !adminGate.hasCapability(cookie)) {
      auditDeniedWrite(req, "admin confirmation required");
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
          // Without Max-Age this is a session cookie, so the token has to be
          // pasted again after every browser restart — on every device. It is
          // the same secret either way; expiring it at the window close buys
          // nothing and is the whole of the friction.
          "Set-Cookie":
            `${COOKIE_NAME}=${expectedToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}`,
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

    // Login and uninstall: one catalogue command each, run in the job session.
    const cliLoginMatch = pathname.match(/^\/api\/clis\/([^/]+)\/(login|uninstall)$/);
    if (req.method === "POST" && cliLoginMatch) {
      if (!requireWriteAccess(req, res)) return;
      const [, cli, phase] = cliLoginMatch;
      try {
        const roster = loadRoster(env);
        if (!isValidCliId(cli, roster)) {
          jsonResponse(res, 400, { error: "unknown cli id" });
          return;
        }
        const login = phase === "login" ? loginAvailable(cli) : uninstallAvailable(cli);
        if (!login.available) {
          jsonResponse(res, 400, { error: `${phase} not available for this cli` });
          return;
        }
        const running = installState(cli, { env, sessionExists });
        if (running.state === "running") {
          jsonResponse(res, 200, { ok: true, joined: true, job: running });
          return;
        }
        const spawned = spawnCliJob(cli, phase, { env, exec, sessionExists });
        if (!spawned.ok) {
          jsonResponse(res, spawned.status, spawned);
          return;
        }
        appendAudit(
          { actor: "127.0.0.1", action: `cli.${phase}`, target: cli, result: "ok", detail: "spawned" },
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
          { actor: "127.0.0.1", action: `cli.${phase}`, target: cli, result: "fail" },
          { env },
        );
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    const keysMatch = pathname.match(/^\/api\/tmux\/([^/]+)\/keys$/);
    if (req.method === "POST" && keysMatch) {
      if (!requireWriteAccess(req, res)) return;
      const session = keysMatch[1];
      if (!listSessions().includes(session)) {
        jsonResponse(res, 404, { error: "session not found" });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req) || "{}");
      } catch {
        jsonResponse(res, 400, { error: "invalid json" });
        return;
      }
      const text = typeof body.text === "string" ? body.text : null;
      const key = typeof body.key === "string" ? body.key : null;
      if (text != null) {
        // Control characters belong in `key`, where the allowlist can see them.
        if (!text.length || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
          jsonResponse(res, 400, { error: "text must be 1-256 printable characters" });
          return;
        }
      } else if (!key || !(TMUX_NAMED_KEYS.has(key) || /^C-[a-z0-9[\]\\^_]$/.test(key))) {
        jsonResponse(res, 400, { error: "unknown key" });
        return;
      }
      try {
        sendKeys(session, { text, key }, { exec });
      } catch (e) {
        jsonResponse(res, 500, { error: String(e.message || e) });
        return;
      }
      // One line per session per minute. A line per keystroke would bury the
      // log in the very typing it is there to make reviewable.
      const keyTs = now();
      if (keyTs - (keyAuditAt.get(session) ?? 0) > 60_000) {
        keyAuditAt.set(session, keyTs);
        appendAudit(
          { actor: "127.0.0.1", action: "tmux.keys", target: session, result: "ok" },
          { env },
        );
      }
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // One click on a STALE badge starts one repair per CLI — cursor goes stale
    // in three windows at once, and that is one cause, not three.
    const repairMatch = pathname.match(/^\/api\/usage\/([^/]+)\/repair$/);
    if (req.method === "POST" && repairMatch) {
      if (!requireWriteAccess(req, res)) return;
      const cli = repairMatch[1];
      const roster = loadRoster(env);
      const subs = subscriptionsFromRoster(roster);
      if (!subs.includes(cli)) {
        jsonResponse(res, 404, { error: "not a subscription cli" });
        return;
      }
      const watcher = loadJson(usageWatcherStatePath(env)) || {};
      let result;
      try {
        result = spawnUsageRepair(cli, {
          env,
          usage: loadJson(usagePath(env)) || {},
          failures: watcher?.collect_failures?.[cli] || [],
          // `ts` is only declared further down, in the read-endpoint section.
          now: now(),
          exec,
          sessionExists,
        });
      } catch (e) {
        appendAudit(
          { actor: "127.0.0.1", action: "usage.repair", target: cli, result: "fail" },
          { env },
        );
        jsonResponse(res, 500, { error: String(e.message || e) });
        return;
      }
      appendAudit(
        {
          actor: "127.0.0.1",
          action: "usage.repair",
          target: cli,
          result: result.ok ? (result.joined ? "joined" : "ok") : "fail",
        },
        { env },
      );
      jsonResponse(res, result.ok ? 200 : (result.status ?? 500), result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/specialists/install") {
      if (!requireWriteAccess(req, res)) return;
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const result = await installSpecialistFromGithub(body.repo, {
          subdir: String(body.subdir || ""),
          env,
        });
        appendAudit(
          {
            actor: "127.0.0.1",
            action: "specialist.install",
            target: result.source || String(body.repo || ""),
            result: result.ok ? "ok" : "fail",
          },
          { env },
        );
        clisMemo.invalidate("specialists");
        clisMemo.invalidate("capability-pool");
        // The client reads `error`; without it a refused install reaches the
        // panel as a bare "Bad Request" and the reason is lost.
        jsonResponse(res, result.ok ? 200 : 400, {
          ...result,
          ...(result.ok ? {} : { error: (result.errors || []).join("; ") }),
        });
      } catch (e) {
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    const specialistAssignMatch = pathname.match(/^\/api\/specialists\/([^/]+)\/assign$/);
    if (req.method === "POST" && specialistAssignMatch) {
      if (!requireWriteAccess(req, res)) return;
      const specialistId = decodeURIComponent(specialistAssignMatch[1]);
      try {
        assertSafeSpecialistSegment(specialistId, "id");
        const body = JSON.parse(await readBody(req) || "{}");
        if (!loadInstalledManifest(specialistId, { env })) throw new Error(`not installed: ${specialistId}`);
        const written = saveRoster(applySpecialistAssignment(loadRoster(env),
          { id: specialistId, role: body.role ?? null, chain: body.chain ?? null }), { env });
        appendAudit({ actor: "127.0.0.1", action: "specialist.assign",
          target: `${specialistId}:${body.role ?? (body.chain ? "chain" : "none")}`, result: "ok" }, { env });
        clisMemo.invalidate("specialists");
        jsonResponse(res, 200, { ok: true, backup: path.basename(written.backup) });
      } catch (e) {
        appendAudit({ actor: "127.0.0.1", action: "specialist.assign", target: specialistId, result: "fail" }, { env });
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    // Models tab: check or uncheck one provider model. Unchecking a model a
    // chain still names answers 409 with the roles, and the browser asks for a
    // replacement (or to strike it) before sending `resolve`.
    if (req.method === "POST" && pathname === "/api/catalogue/toggle") {
      if (!requireWriteAccess(req, res)) return;
      let body = {};
      try {
        body = JSON.parse(await readBody(req) || "{}");
        const next = applyCatalogueToggle(loadRoster(env), body, loadModelsStore(env));
        const written = saveRoster(next, { env });
        appendAudit({ actor: "127.0.0.1", action: "roster.catalogue.toggle",
          target: `${body.cli}:${body.cli_id}:${body.on ? "on" : "off"}`, result: "ok" }, { env });
        memo.invalidate("pick");
        memo.invalidate("roles");
        jsonResponse(res, 200, { ok: true, backup: path.basename(written.backup) });
      } catch (e) {
        if (e.roles) {
          jsonResponse(res, 409, { error: String(e.message), roles: e.roles });
          return;
        }
        appendAudit({ actor: "127.0.0.1", action: "roster.catalogue.toggle",
          target: `${body.cli}:${body.cli_id}`, result: "fail" }, { env });
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    // Layout, columns, widget colours: the browser's `teamup.*` localStorage
    // keys, mirrored here so every device shows the same dashboard. Strings
    // only, prefix-checked, replaced wholesale — it is a preference file, not
    // a roster, so no backup and no write gate beyond login + CSRF.
    if (pathname === "/api/prefs") {
      const file = path.join(teamUpHome(env), "dashboard-prefs.json");
      if (req.method === "POST") {
        if (!checkCsrf(req, res)) return;
        try {
          const prefs = JSON.parse(await readBody(req, PREFS_MAX_BODY) || "{}");
          const valid = prefs && typeof prefs === "object" && !Array.isArray(prefs)
            && Object.entries(prefs).every(([k, v]) => k.startsWith("teamup.") && typeof v === "string");
          if (!valid) throw new Error("prefs must map teamup.* keys to strings");
          atomicWriteText(file, `${JSON.stringify(prefs, null, 2)}\n`);
          jsonResponse(res, 200, { ok: true });
        } catch (e) {
          jsonResponse(res, 400, { error: String(e.message || e) });
        }
        return;
      }
      jsonResponse(res, 200, loadJson(file) || {});
      return;
    }

    // Roles, chains and roster settings: one edit per request, validated,
    // backed up, audited.
    const cronJobMatch = pathname.match(/^\/api\/cron-jobs\/([^/]+)$/);
    if (req.method === "POST" && cronJobMatch) {
      if (!requireWriteAccess(req, res)) return;
      const name = decodeURIComponent(cronJobMatch[1]);
      const action = "cron.job.model";
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const roster = loadRoster(env);
        if (!cronModelOptions(roster).includes(body.model)) {
          appendAudit({ actor: "127.0.0.1", action, target: name, result: "fail" }, { env });
          jsonResponse(res, 400, { error: "model is not an available CLI:model option" });
          return;
        }
        const file = cronJobsPath(env);
        if (!fs.existsSync(file)) {
          appendAudit({ actor: "127.0.0.1", action, target: name, result: "fail" }, { env });
          jsonResponse(res, 404, { error: "cron-jobs.ini does not exist" });
          return;
        }
        const text = fs.readFileSync(file, "utf8");
        const next = setCronJobModel(text, name, body.model);
        const backup = `${file}.bak`;
        fs.copyFileSync(file, backup);
        atomicWriteText(file, next);
        appendAudit({ actor: "127.0.0.1", action, target: name, result: "ok" }, { env });
        jsonResponse(res, 200, { ok: true, backup: path.basename(backup) });
      } catch (e) {
        appendAudit({ actor: "127.0.0.1", action, target: name, result: "fail" }, { env });
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    const runActionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/action$/);
    const ACTIONS = {
      "/api/actions/mark-limited": "usage.mark_limited",
      "/api/actions/clear-mark": "usage.clear_mark",
      "/api/actions/admission-reset": "admission.reset",
      "/api/actions/models-scan": "models.scan",
    };
    if (req.method === "POST" && (runActionMatch || Object.hasOwn(ACTIONS, pathname))) {
      if (!requireWriteAccess(req, res)) return;
      const action = runActionMatch ? "run.action" : ACTIONS[pathname];
      let target = runActionMatch ? decodeURIComponent(runActionMatch[1]) : "";
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        let result;
        if (runActionMatch) {
          target = `${target} ${body.action}`;
          result = runAction(decodeURIComponent(runActionMatch[1]), String(body.action || ""), { reason: body.reason });
          memo.invalidate(`run:${decodeURIComponent(runActionMatch[1])}`);
        } else if (pathname === "/api/actions/mark-limited") {
          target = String(body.target || "");
          result = markLimitedAction(body, { roster: loadRoster(env), env, now: now() });
        } else if (pathname === "/api/actions/clear-mark") {
          target = String(body.target || "");
          result = clearMarkAction(body, { env });
        } else if (pathname === "/api/actions/admission-reset") {
          result = admissionResetAction({ env });
        } else {
          result = startModelsScan({ env });
        }
        appendAudit({ actor: "127.0.0.1", action, target, result: "ok" }, { env });
        memo.invalidate("usage");
        memo.invalidate("pick");
        memo.invalidate("roles");
        jsonResponse(res, 200, { ok: true, ...result });
      } catch (e) {
        appendAudit({ actor: "127.0.0.1", action, target, result: "fail" }, { env });
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    // Automation writes: a built-in job's crontab line, or a custom job (ini +
    // prompt file + the crontab's managed block). Every one re-reads the
    // crontab, backs it up and verifies the result (crontab.mjs).
    const builtinMatch = pathname.match(/^\/api\/automation\/builtin\/([a-z0-9-]+)$/);
    const jobMatch = pathname.match(/^\/api\/automation\/jobs(?:\/([a-z0-9-]+)\/(enabled|delete|run))?$/);
    if (req.method === "POST" && (builtinMatch || jobMatch)) {
      if (!requireWriteAccess(req, res)) return;
      const verb = builtinMatch ? "builtin" : jobMatch[2] || "save";
      const action = `automation.${verb}`;
      let target = builtinMatch?.[1] || jobMatch?.[1] || "";
      try {
        const body = JSON.parse(await readBody(req, PREFS_MAX_BODY) || "{}");
        let result;
        if (builtinMatch) {
          result = editBuiltin({ id: target, enabled: body.enabled, schedule: body.schedule, knob: body.knob }, { exec, env });
        } else if (verb === "save") {
          target = String(body.name || "");
          result = saveCustomJob(body, { exec, env, modelOptions: cronModelOptions(loadRoster(env)) });
        } else if (!JOB_NAME.test(target)) {
          throw new Error("bad job name");
        } else if (verb === "enabled") {
          result = setCustomJobEnabled(target, body.enabled === true, { exec, env });
        } else if (verb === "delete") {
          result = deleteCustomJob(target, { exec, env });
        } else {
          result = runCustomJobNow(target, { env });
        }
        appendAudit({ actor: "127.0.0.1", action, target, result: "ok" }, { env });
        jsonResponse(res, 200, { ok: true, backup: result?.backup ? path.basename(result.backup) : null });
      } catch (e) {
        appendAudit({ actor: "127.0.0.1", action, target, result: "fail" }, { env });
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    const roleMatch = pathname.match(/^\/api\/roles\/([^/]+)$/);
    const isSettings = pathname === "/api/settings";
    const isUpgrade = pathname === "/api/roles-upgrade";
    if (req.method === "POST" && (roleMatch || isSettings || isUpgrade)) {
      if (!requireWriteAccess(req, res)) return;
      const target = roleMatch ? decodeURIComponent(roleMatch[1]) : isSettings ? "settings" : "latest";
      const action = roleMatch ? "roster.role.edit" : isSettings ? "roster.settings.edit" : "roster.chains.upgrade";
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const roster = loadRoster(env);
        let next;
        let changes;
        let added;
        let removed;
        if (roleMatch) next = applyRoleEdit(roster, { ...body, role: target });
        else if (isSettings) next = applySettingsEdit(roster, body);
        else ({ next, changes, added, removed } = bringToLatest(roster, loadModelsStore(env)));
        const written = changes?.length === 0 && added?.length === 0 && removed?.length === 0 ? null : saveRoster(next, { env });
        appendAudit({ actor: "127.0.0.1", action, target: isSettings ? body.path : target, result: "ok" }, { env });
        memo.invalidate("pick");
        memo.invalidate("roles");
        jsonResponse(res, 200, {
          ok: true,
          backup: written ? path.basename(written.backup) : null,
          ...(changes ? { changes, added, removed } : {}),
        });
      } catch (e) {
        appendAudit({ actor: "127.0.0.1", action, target, result: "fail" }, { env });
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    const capabilityMatch = pathname.match(/^\/api\/specialists\/([^/]+)\/capabilities$/);
    if (req.method === "POST" && capabilityMatch) {
      if (!requireWriteAccess(req, res)) return;
      const specialistId = decodeURIComponent(capabilityMatch[1]);
      try {
        assertSafeSpecialistSegment(specialistId, "id");
        const body = JSON.parse(await readBody(req) || "{}");
        const pkg = String(body.package || "");
        const checksum = String(body.checksum || "");
        const enable = body.action !== "disable";
        // Assign only what the pool actually holds: a hand-written package or
        // checksum would otherwise write an assignment no launch can resolve.
        const known = buildCapabilityPoolView({ env }).packages.some(
          (item) => item.package === pkg && item.checksum === checksum,
        );
        if (!known) {
          jsonResponse(res, 400, { error: "unknown package or checksum" });
          return;
        }
        // A well-formed id is not an installed one; without this an assignment
        // can be written for a specialist that does not exist.
        const targets = buildSpecialistsView({ env }).specialists;
        if (!targets.some((item) => item.id === specialistId)) {
          jsonResponse(res, 400, { error: "unknown specialist" });
          return;
        }
        const mutate = enable ? enableCapability : disableCapability;
        mutate({ package: pkg, checksum, target: specialistId, env });
        appendAudit(
          {
            actor: "127.0.0.1",
            action: enable ? "capability.enable" : "capability.disable",
            target: `${pkg} -> ${specialistId}`,
            result: "ok",
          },
          { env },
        );
        clisMemo.invalidate("specialists");
        clisMemo.invalidate("capability-pool");
        jsonResponse(res, 200, { ok: true });
      } catch (e) {
        appendAudit(
          {
            actor: "127.0.0.1",
            action: "capability.assign",
            target: specialistId,
            result: "fail",
          },
          { env },
        );
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    if (pathname === "/api/projects") {
      const dir = url.searchParams.get("dir") || "";
      try {
        const data = memo.get(`projects:${dir}`, () => listProjects(dir, { exec, env }));
        jsonResponse(res, 200, { ...data, clis: Object.keys(loadRoster(env).clis || {}).sort() });
      } catch (e) {
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    if (pathname === "/api/tim") {
      const dir = url.searchParams.get("dir") || "";
      try {
        // Spawning `tim open-work` on every 5s poll would put a TimStore open
        // (migrations, FTS triggers) against TIM's own writer that often. The
        // backlog is not a live feed; running sessions stay on the 1s memo.
        const work = timMemo.get("open-work", () => readOpenWork({ exec }));
        const roster = loadRoster(env);
        const store = loadModelsStore(env);
        jsonResponse(res, 200, {
          ...buildTimView(dir, { exec, work }),
          clis: promptClis(roster),
          models: Object.entries(roster.models || {})
            .map(([id, spec]) => ({ id, label: modelLabel(roster, store, id), clis: spec.cli ?? [] }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        });
      } catch (e) {
        jsonResponse(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/tim/session") {
      if (!requireWriteAccess(req, res)) return;
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const result = startTaskSession({
          id: body.id,
          cli: body.cli,
          prompt: body.prompt,
          specialist: body.specialist,
          model: body.model,
          projectsDir: body.projects_dir,
          roster: loadRoster(env),
          env,
          exec,
        });
        appendAudit(
          {
            actor: "127.0.0.1",
            action: "tim.session",
            target: `${body.cli}:${body.id}`,
            result: result.ok ? (result.existing ? "existing" : "ok") : "fail",
          },
          { env },
        );
        timMemo.invalidate("open-work");
        memo.invalidate("tmux");
        memo.invalidate("tmux-sessions");
        jsonResponse(res, result.ok ? 200 : (result.status ?? 500), result);
      } catch (e) {
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/session") {
      if (!requireWriteAccess(req, res)) return;
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const result = startProjectSession({
          dir: body.dir,
          cli: body.cli,
          projectsDir: body.projects_dir,
          roster: loadRoster(env),
          exec,
        });
        appendAudit(
          {
            actor: "127.0.0.1",
            action: "project.session",
            target: `${body.cli}:${body.dir}`,
            result: result.ok ? (result.existing ? "existing" : "ok") : "fail",
          },
          { env },
        );
        // The pane endpoint 404s on a session the 1s memo has not seen yet, and
        // the overlay reads any 404 as "session gone" and closes itself.
        memo.invalidate("tmux");
        memo.invalidate("tmux-sessions");
        jsonResponse(res, result.ok ? 200 : (result.status ?? 500), result);
      } catch (e) {
        jsonResponse(res, 500, { error: String(e.message || e) });
      }
      return;
    }

    // Policy creation writes into a project; policy trust records its checksum.
    const projectWrite = {
      "/api/projects/policy": ["project.policy", (body) =>
        writeProjectPolicy({ dir: body.dir, projectsDir: body.projects_dir, policy: body.policy ?? null })],
      "/api/projects/trust-policy": ["project.trust_policy", (body) =>
        trustProjectPolicyForProject({ dir: body.dir, projectsDir: body.projects_dir, env })],
    }[pathname];
    if (req.method === "POST" && projectWrite) {
      if (!requireWriteAccess(req, res)) return;
      const [action, run] = projectWrite;
      let body = {};
      let result;
      try {
        body = JSON.parse(await readBody(req) || "{}");
        result = await run(body);
      } catch (e) {
        result = { ok: false, status: 400, error: String(e.message || e) };
      }
      const detail = result.ok ? null : result.error || result.errors?.join("; ");
      appendAudit(
        {
          actor: "127.0.0.1",
          action,
          target: String(body.dir ?? ""),
          result: result.ok ? "ok" : "fail",
          ...(detail ? { detail } : {}),
        },
        { env },
      );
      memo.invalidate(`projects:${body.projects_dir ?? ""}`);
      jsonResponse(res, result.ok ? 200 : (result.status ?? 500), result);
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

    if (pathname === TIM_VIEWER_PREFIX || pathname.startsWith(`${TIM_VIEWER_PREFIX}/`)) {
      if (!requireAuth(req, res)) return;
      if (pathname === TIM_VIEWER_PREFIX) {
        // The viewer's requests are relative: they need the trailing slash.
        res.writeHead(302, { Location: `${TIM_VIEWER_PREFIX}/${url.search}` });
        res.end();
        return;
      }
      await timViewer.handle(req, res, pathname.slice(TIM_VIEWER_PREFIX.length), url.search);
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
        const watcher = loadJson(usageWatcherStatePath(env)) || {};
        const repairs = {};
        for (const cli of Object.keys(watcher?.last_collect || {})) {
          repairs[cli] = {
            ...readRepairState(cli, { env, sessionExists }),
            report: readRepairReport(cli, { env }).present,
          };
        }
        return { ...buildUsageView(usage, roster, ts, { watcher, repairs }), mark_targets: markTargets(roster) };
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/specialists") {
      // Reads a handful of JSON indexes and no subprocess, but nothing here
      // changes between polls — the 30s memo keeps it off the 5s cycle.
      const data = clisMemo.get("specialists", () => {
        const roster = loadRoster(env);
        const view = buildSpecialistsView({ env });
        for (const s of view.specialists) s.assignment = specialistAssignment(roster, s.id);
        return sanitizeForDashboard(view);
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/capability-pool") {
      const data = clisMemo.get("capability-pool", () =>
        sanitizeForDashboard(buildCapabilityPoolView({ env })));
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/roles") {
      const data = memo.get("roles", () => {
        const roster = loadRoster(env);
        const usage = loadJson(usagePath(env)) || {};
        return sanitizeForDashboard(buildRolesView(roster, usage, loadModelsStore(env), ts), { stripAccounts: true });
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (pathname === "/api/settings") {
      // accounts here are the on/off switches the panel edits; nothing secret
      // lives in them, and the sanitizer still drops anything key-shaped.
      jsonResponse(res, 200, sanitizeForDashboard(buildSettingsView(loadRoster(env))));
      return;
    }

    if (pathname === "/api/automation/preview") {
      const schedule = url.searchParams.get("schedule") || "";
      try {
        parseSchedule(schedule);
        jsonResponse(res, 200, { text: describeSchedule(schedule), next: nextRun(schedule)?.toISOString() ?? null });
      } catch (e) {
        jsonResponse(res, 200, { error: String(e.message || e) });
      }
      return;
    }

    if (pathname === "/api/automation") {
      jsonResponse(res, 200, buildAutomationView({ env, exec, modelOptions: cronModelOptions(loadRoster(env)) }));
      return;
    }

    const logMatch = pathname.match(/^\/api\/automation\/jobs\/([a-z0-9-]+)\/log$/);
    if (logMatch) {
      jsonResponse(res, 200, { log: readJobLog(logMatch[1], { env }) });
      return;
    }

    if (pathname === "/api/cron-jobs") {
      const file = cronJobsPath(env);
      const exists = fs.existsSync(file);
      jsonResponse(res, 200, {
        path: file,
        exists,
        jobs: exists ? parseCronJobs(fs.readFileSync(file, "utf8")) : [],
        options: cronModelOptions(loadRoster(env)),
      });
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

    if (pathname === "/api/trending") {
      // The newest scraper report; readTrending re-parses only when its mtime moves.
      const data = readTrending({ env });
      if (data) jsonResponse(res, 200, data);
      else jsonResponse(res, 404, { error: `no trending-YYYY-MM-DD.md in ${trendingDir(env)}` });
      return;
    }

    if (pathname === "/api/catalogue") {
      jsonResponse(res, 200, sanitizeForDashboard(buildCatalogueView(loadRoster(env), loadModelsStore(env)), { stripAccounts: true }));
      return;
    }

    if (pathname === "/api/clis") {
      const data = clisMemo.get("clis", () => {
        const roster = loadRoster(env);
        return sanitizeForDashboard(buildClisView(roster, { exec, env, allowInstall }));
      });
      jsonResponse(res, 200, { ...data, requires_admin_confirm: requireAdminConfirm });
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

  server.on("close", () => timViewer.stop());
  return { server, token: expectedToken, adminGate, timViewer };
}

export function startDashboard({
  host = "127.0.0.1",
  port = 8556,
  rotateToken = false,
  allowInstall = false,
  requireAdminConfirm = false,
  publicOrigin = "",
  env = process.env,
  io = { out: console.log, err: console.error },
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    io.err(`warning: dashboard binding to ${host} — use ssh -L for remote access`);
  }
  const token = ensureDashboardToken(env, { rotate: rotateToken });
  const { server, timViewer } = createDashboardServer({
    env, host, token, io, allowInstall, requireAdminConfirm, publicOrigin,
  });
  process.once("exit", () => timViewer.stop());
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
