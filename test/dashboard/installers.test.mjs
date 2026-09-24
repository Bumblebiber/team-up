import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INSTALLERS,
  isValidCliId,
  bootstrapAvailable,
  installState,
  redactSecrets,
  classifyVerificationVerdict,
  normalizeJobState,
  spawnCliJob,
  buildJobShell,
  hermesInstallRefusal,
  readInstallLog,
  installLogPath,
  installExitPath,
  installSessionName,
  enrichCliRow,
} from "../../src/dashboard/installers.mjs";
import { HARNESS_VERIFY_CLIS, UNVERIFIABLE_ISOLATION_REASONS } from "../../src/harness/cli-verify.mjs";
import { createDashboardServer, ensureDashboardToken } from "../../src/dashboard/server.mjs";
import { createAdminGate } from "../../src/dashboard/admin.mjs";
import { appendAudit, auditLogPath } from "../../src/dashboard/audit.mjs";

const ROSTER = {
  clis: {
    claude: { cmd: ["claude", "{prompt}"] },
    codex: { cmd: ["codex", "{prompt}"] },
    cursor: { cmd: ["cursor-agent", "{prompt}"] },
    opencode: { cmd: ["opencode", "{prompt}"] },
    hermes: { cmd: ["hermes", "{prompt}"] },
  },
};

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-install-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "roster.json"), JSON.stringify(ROSTER));
  return fn(home).finally(() => {
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

async function req(port, urlPath, { method = "GET", token, cookie, body, csrf, origin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";
  if (csrf) headers["X-Team-Up-CSRF"] = "1";
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
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
  return { status: res.status, json, text, headers: res.headers };
}

async function loginCookie(port, token) {
  const login = await req(port, "/api/login", { method: "POST", body: { token } });
  return login.headers.get("set-cookie")?.split(";")[0] || "";
}

test("installer table lookup rejects unknown cli id", () => {
  assert.equal(isValidCliId("nope", ROSTER), false);
  assert.equal(isValidCliId("claude", ROSTER), true);
  assert.ok(INSTALLERS.claude.update.shell.includes("update"));
});

test("bootstrap disabled without --allow-install", () => {
  const boot = bootstrapAvailable("claude", { allowInstall: false });
  assert.equal(boot.available, false);
  assert.match(boot.reason, /--allow-install/);
  const enabled = bootstrapAvailable("claude", { allowInstall: true });
  assert.equal(enabled.available, true);
});

test("unconfirmed bootstrap would ship disabled", () => {
  const saved = INSTALLERS.claude.bootstrap.confirmed;
  INSTALLERS.claude.bootstrap.confirmed = null;
  const boot = bootstrapAvailable("claude", { allowInstall: true });
  assert.equal(boot.available, false);
  assert.match(boot.reason, /vendor/i);
  INSTALLERS.claude.bootstrap.confirmed = saved;
});

test("install_state transitions", () =>
  withHome(async (home) => {
    const cli = "claude";
    const log = installLogPath(cli);
    const exit = installExitPath(cli);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    assert.equal(installState(cli, { sessionExists: () => false }).state, "idle");
    assert.equal(installState(cli, { sessionExists: () => true }).state, "running");
    fs.writeFileSync(log, "partial\n");
    assert.equal(installState(cli, { sessionExists: () => false }).state, "interrupted");
    fs.writeFileSync(exit, "0\n");
    assert.equal(installState(cli, { sessionExists: () => false }).state, "succeeded");
    fs.writeFileSync(exit, "2\n");
    assert.equal(installState(cli, { sessionExists: () => false }).state, "failed");
  }));

test("redactSecrets strips key-shaped strings", () => {
  const key = ["sk", "or", "v1", "test", "key", "abcdefghijklmnop"].join("-");
  const out = redactSecrets(`token ${key} done`);
  assert.ok(!out.includes(key));
  assert.match(out, /REDACTED/);
});

test("normalizeJobState treats unverifiable verify exit as succeeded", () => {
  const lines = ["=== phase: verify ===", "context_isolation_reason: codex_no_live_collector"];
  const normalized = normalizeJobState("codex", { state: "failed", exit_code: 2 }, lines);
  assert.equal(normalized.state, "succeeded");
  assert.equal(normalized.exit_code, 0);
  const verdict = classifyVerificationVerdict("codex", { logLines: lines });
  assert.equal(verdict.verdict, "harness_verification_unsupported");
});

test("three post-update verdicts incl unsupported skip", () => {
  const cursorVerdict = classifyVerificationVerdict("cursor", {
    exec: () => { throw new Error("no"); },
  });
  assert.equal(cursorVerdict.verdict, "harness_verification_unsupported");
  assert.equal(cursorVerdict.rerun_helps, false);
  assert.ok(!HARNESS_VERIFY_CLIS.has("cursor"));

  const codexVerdict = classifyVerificationVerdict("codex", {
    isolationReason: "codex_no_live_collector",
  });
  assert.equal(codexVerdict.verdict, "harness_verification_unsupported");
  assert.ok(UNVERIFIABLE_ISOLATION_REASONS.has("codex_no_live_collector"));
});

test("update shell skips verify for unsupported CLIs", () => {
  const argv = buildJobShell({ cli: "cursor", phase: "update" });
  const script = argv[2];
  assert.match(script, /phase: verify \(skipped\)/);
  assert.doesNotMatch(script, /harness verify cursor/);
  const claudeArgv = buildJobShell({ cli: "claude", phase: "update" });
  assert.match(claudeArgv[2], /harness verify claude/);
});

test("spawnCliJob mutex — second spawn returns 409", () =>
  withHome(async () => {
    const execCalls = [];
    const exec = (...args) => {
      execCalls.push(args);
    };
    let exists = false;
    const sessionExists = () => exists;
    const first = spawnCliJob("claude", "update", { exec, sessionExists });
    assert.equal(first.ok, true);
    exists = true;
    const second = spawnCliJob("claude", "update", { exec, sessionExists });
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.equal(execCalls.length, 1);
  }));

test("hermes occupied directory refusal message", () =>
  withHome(async (home) => {
    const target = path.join(home, "hermes-agent");
    const prev = INSTALLERS.hermes.bootstrap.env.HERMES_DIR;
    INSTALLERS.hermes.bootstrap.env.HERMES_DIR = target;
    fs.mkdirSync(target, { recursive: true });
    const exec = (cmd, args) => {
      if (args[0] === "-C" && args[1] === target && args[2] === "rev-parse") return "true\n";
      if (args[0] === "-C" && args[1] === target && args[2] === "branch") return "feature/test\n";
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    };
    const refusal = hermesInstallRefusal({ env: process.env, exec });
    INSTALLERS.hermes.bootstrap.env.HERMES_DIR = prev;
    assert.ok(refusal);
    assert.match(refusal.detail, /already exists/);
    assert.match(refusal.detail, /git clone/);
    assert.match(refusal.detail, /branch/i);
  }));

test("readInstallLog redacts before returning", () =>
  withHome(async () => {
    const cli = "claude";
    const key = ["sk", "ant", "api03", "abcdefghijklmnop"].join("-");
    fs.mkdirSync(path.dirname(installLogPath(cli)), { recursive: true });
    fs.writeFileSync(installLogPath(cli), `line with ${key}\n`);
    const log = readInstallLog(cli);
    assert.ok(!log.lines.join("\n").includes(key));
  }));

test("admin gate expiry and CSRF on cli update endpoint", () =>
  withHome(async () => {
    const token = ensureDashboardToken(process.env);
    const adminGate = createAdminGate({ log: () => {} });
    const { server } = createDashboardServer({ token, adminGate, requireAdminConfirm: true, sessionExists: () => false });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const noAdmin = await req(port, "/api/clis/claude/update", {
      method: "POST",
      cookie,
      csrf: true,
      body: {},
    });
    assert.equal(noAdmin.status, 403);
    const noCsrf = await req(port, "/api/clis/claude/update", {
      method: "POST",
      cookie,
      body: {},
    });
    assert.equal(noCsrf.status, 403);
    server.close();
  }));

test("foreign Origin refused on cli install", () =>
  withHome(async () => {
    const token = ensureDashboardToken(process.env);
    const adminGate = createAdminGate({ log: () => {} });
    const { server } = createDashboardServer({ token, adminGate, allowInstall: true, sessionExists: () => false });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const challenge = adminGate.issueChallenge();
    const code = adminGate.peekChallengeCode();
    await req(port, "/api/admin/confirm", {
      method: "POST",
      cookie,
      csrf: true,
      body: { challenge_id: challenge.challenge_id, code },
    });
    const r = await req(port, "/api/clis/claude/install", {
      method: "POST",
      cookie,
      csrf: true,
      origin: "http://evil.example",
      body: {},
    });
    assert.equal(r.status, 403);
    server.close();
  }));

test("audit entry shape for cli job spawn", () =>
  withHome(async (home) => {
    const token = ensureDashboardToken(process.env);
    const adminGate = createAdminGate({ log: () => {} });
    let tmuxSpawned = false;
    const exec = (cmd, args) => {
      if (cmd === "tmux") tmuxSpawned = true;
    };
    const { server } = createDashboardServer({
      token,
      adminGate,
      exec,
      sessionExists: () => false,
    });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const challenge = adminGate.issueChallenge();
    await req(port, "/api/admin/confirm", {
      method: "POST",
      cookie,
      csrf: true,
      body: { challenge_id: challenge.challenge_id, code: adminGate.peekChallengeCode() },
    });
    const r = await req(port, "/api/clis/claude/update", {
      method: "POST",
      cookie,
      csrf: true,
      body: {},
    });
    assert.equal(r.status, 200);
    assert.equal(tmuxSpawned, true);
    const audit = fs.readFileSync(auditLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const entry = audit.find((e) => e.action === "cli.update" && e.target === "claude");
    assert.ok(entry);
    assert.equal(entry.actor, "127.0.0.1");
    assert.equal(entry.result, "ok");
    server.close();
  }));

test("unknown cli id on install returns 400", () =>
  withHome(async () => {
    const token = ensureDashboardToken(process.env);
    const adminGate = createAdminGate({ log: () => {} });
    const { server } = createDashboardServer({ token, adminGate, sessionExists: () => false });
    const port = await listen(server);
    const cookie = await loginCookie(port, token);
    const challenge = adminGate.issueChallenge();
    await req(port, "/api/admin/confirm", {
      method: "POST",
      cookie,
      csrf: true,
      body: { challenge_id: challenge.challenge_id, code: adminGate.peekChallengeCode() },
    });
    const r = await req(port, "/api/clis/unknown-cli/install", {
      method: "POST",
      cookie,
      csrf: true,
      body: {},
    });
    assert.equal(r.status, 400);
    server.close();
  }));

test("install session name is deterministic mutex", () => {
  assert.equal(installSessionName("claude"), "team-up-install-claude");
});


/**
 * The verdict is not only a post-update fact. Before this, a CLI that can
 * never be verified sat in the list reading "installed, capabilities denied"
 * — the wording for something a rerun could fix — with the honest verdict
 * only appearing after somebody pressed update.
 */
test("a CLI that can never be verified says so in the steady state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-dash-"));
  try {
    const env = { TEAM_UP_HOME: home, HOME: home };
    const roster = { clis: { opencode: { cmd: ["opencode"] } } };
    const row = enrichCliRow(
      { cli: "opencode", harness_label: "installed, capabilities denied" },
      roster,
      { env },
    );
    assert.equal(row.verification_verdict.verdict, "harness_verification_unsupported");
    assert.equal(row.verification_verdict.rerun_helps, false);
    assert.match(row.harness_label, /not verifiable/);
    assert.doesNotMatch(row.harness_label, /capabilities denied/);
    // No update was run, so the post-update slot stays empty.
    assert.equal(row.post_update_verdict, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
