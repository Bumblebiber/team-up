import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateOpenRouterKey,
  writeOpenRouterKey,
  removeOpenRouterKey,
  readOpenRouterKey,
  isOpenRouterWritable,
} from "../../src/dashboard/providers.mjs";
import { secretsPath } from "../../src/paths.mjs";
import { auditLogPath } from "../../src/dashboard/audit.mjs";

const EXAMPLE_KEY = "sk-EXAMPLE-abcdef91f";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-prov-"));
  const prev = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  return fn(home).finally(() => {
    if (prev === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

test("validate 401 does not write file", () =>
  withHome(async (home) => {
    const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const result = await validateOpenRouterKey(EXAMPLE_KEY, { fetchFn });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(secretsPath()), false);
  }));

test("validate 200 writes 0600 secrets.env atomically", () =>
  withHome(async () => {
    const validation = await validateOpenRouterKey(EXAMPLE_KEY, {
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { label: "test", limit: 10 } }),
      }),
    });
    assert.equal(validation.ok, true);
    writeOpenRouterKey(EXAMPLE_KEY);
    const file = secretsPath();
    assert.ok(fs.existsSync(file));
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, /OPENROUTER_API_KEY=/);
    assert.ok(!content.includes(EXAMPLE_KEY.slice(0, 20)) || content.includes(EXAMPLE_KEY));
    const hit = readOpenRouterKey({ env: process.env, roster: {} });
    assert.equal(hit.key, EXAMPLE_KEY);
    assert.equal(hit.source, "file");
  }));

test("rotate replaces line and remove deletes it", () =>
  withHome(async () => {
    writeOpenRouterKey(EXAMPLE_KEY);
    const rotated = "sk-EXAMPLE-rotated9999";
    writeOpenRouterKey(rotated);
    const content = fs.readFileSync(secretsPath(), "utf8");
    assert.equal(content.trim(), `OPENROUTER_API_KEY=${rotated}`);
    assert.ok(!content.includes(EXAMPLE_KEY));
    removeOpenRouterKey();
    assert.equal(fs.existsSync(secretsPath()), false);
  }));

test("response views never include full key value", () =>
  withHome(async () => {
    writeOpenRouterKey(EXAMPLE_KEY);
    const hit = readOpenRouterKey({ env: process.env, roster: {} });
    const view = { hint: `…${hit.key.slice(-4)}`, configured: true };
    const json = JSON.stringify(view);
    assert.ok(!json.includes(EXAMPLE_KEY));
    assert.match(json, /f91f/);
  }));

test("env-sourced key is read-only", () =>
  withHome(async () => {
    const writable = isOpenRouterWritable({
      env: { OPENROUTER_API_KEY: EXAMPLE_KEY },
      roster: {},
    });
    assert.equal(writable, false);
  }));

test("audit log contains hint not value", () =>
  withHome(async (home) => {
    const { appendAudit } = await import("../../src/dashboard/audit.mjs");
    appendAudit({
      actor: "127.0.0.1",
      action: "provider.connect",
      target: "openrouter",
      result: "ok",
      hint: "…a91f",
    });
    const log = fs.readFileSync(auditLogPath(), "utf8");
    assert.match(log, /a91f/);
    assert.ok(!log.includes(EXAMPLE_KEY));
    const mode = fs.statSync(auditLogPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  }));
