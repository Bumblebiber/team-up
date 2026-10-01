import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lookupKey, parseEnvFileLine, keyHint, openRouterKeyFiles } from "../src/keys.mjs";
import { secretsPath } from "../src/paths.mjs";

test("parseEnvFileLine handles quotes and comments", () => {
  assert.equal(parseEnvFileLine("# comment"), null);
  assert.deepEqual(parseEnvFileLine('FOO="bar"'), { name: "FOO", value: "bar" });
});

test("lookupKey prefers env over files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-keys-"));
  const file = path.join(home, "secrets.env");
  fs.writeFileSync(file, "OPENROUTER_API_KEY=file-key\n", { mode: 0o600 });
  const hit = lookupKey({
    keyName: "OPENROUTER_API_KEY",
    keyFiles: [file],
    env: { OPENROUTER_API_KEY: "env-key" },
  });
  assert.equal(hit.key, "env-key");
  assert.equal(hit.source, "env");
  fs.rmSync(home, { recursive: true, force: true });
});

test("lookupKey reads secrets.env then the roster key_file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-keys-"));
  const secrets = path.join(home, "secrets.env");
  const hermes = path.join(home, "hermes.env");
  fs.writeFileSync(secrets, "OPENROUTER_API_KEY=secrets-key\n", { mode: 0o600 });
  fs.writeFileSync(hermes, "OPENROUTER_API_KEY=hermes-key\n", { mode: 0o600 });
  const first = lookupKey({
    keyName: "OPENROUTER_API_KEY",
    keyFiles: [secrets, hermes],
    env: {},
  });
  assert.equal(first.key, "secrets-key");
  const second = lookupKey({
    keyName: "OPENROUTER_API_KEY",
    keyFiles: [path.join(home, "missing.env"), hermes],
    env: {},
  });
  assert.equal(second.key, "hermes-key");
  fs.rmSync(home, { recursive: true, force: true });
});

test("lookupKey refuses group/world-readable files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-keys-"));
  const file = path.join(home, "leak.env");
  fs.writeFileSync(file, "OPENROUTER_API_KEY=secret-value\n", { mode: 0o644 });
  const warnings = [];
  const hit = lookupKey({
    keyName: "OPENROUTER_API_KEY",
    keyFiles: [file],
    env: {},
    warn: (m) => warnings.push(m),
  });
  assert.equal(hit.key, null);
  assert.ok(warnings.some((w) => /readable/i.test(w)));
  fs.rmSync(home, { recursive: true, force: true });
});

test("OpenRouter key files: secrets.env first, then roster openrouter.key_file", () => {
  const env = { TEAM_UP_SECRETS: "/s/secrets.env" };
  assert.deepEqual(openRouterKeyFiles(env, { openrouter: { key_file: "~/.hermes/.env" } }),
    ["/s/secrets.env", "~/.hermes/.env"]);
  assert.deepEqual(openRouterKeyFiles(env, {}), ["/s/secrets.env"]);
});

test("keyHint returns last four characters only", () => {
  assert.equal(keyHint("sk-EXAMPLE-abcdef91f"), "…f91f");
});
