import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildModelExpectScript,
  parseClaudeModels,
  parseCodexModels,
  CLAUDE_MODEL_WAIT,
  CODEX_MODEL_WAIT,
  CODEX_MODEL_READY,
  CODEX_MODEL_READY_ALT,
} from "../../src/collectors/models-pty.mjs";
import { formatPtyTimeoutError } from "../../src/usage/usage-pty.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/panes");
const HOME = process.env.HOME || "/home/test";

test("buildModelExpectScript claude sends /model and waits on Available", () => {
  const script = buildModelExpectScript("claude", 90);
  assert.ok(script.includes('send "/model\\r"'));
  assert.ok(script.includes(CLAUDE_MODEL_WAIT));
  assert.ok(script.includes("Quick safety check"));
  assert.equal(/sleep [1-9]/.test(script.split('send "/model\\r"')[1] || ""), false);
});

test("buildModelExpectScript codex has trust override and model picker wait", () => {
  const script = buildModelExpectScript("codex", 90);
  assert.ok(script.includes('send "/model\\r"'));
  assert.ok(script.includes(CODEX_MODEL_WAIT));
  assert.ok(script.includes(CODEX_MODEL_READY));
  assert.ok(script.includes(CODEX_MODEL_READY_ALT));
  assert.match(script, /timeout \{\s*send "\/model\\r"/);
  assert.ok(script.includes("trust_level"));
  assert.ok(script.includes(`cd '${HOME}'`));
  assert.match(script, /Update available.*send "\\033"/);
  assert.match(script, /Continue anyway.*send "y\\r"/);
  assert.match(script, /Do you trust the contents of this directory.*Yes, continue/);
  assert.equal(/Update available.*send "1/.test(script), false);
});

test("buildModelExpectScript uses fast exit after escape", () => {
  const script = buildModelExpectScript("codex", 90);
  assert.ok(script.includes('catch { send "\\033" }'));
  assert.ok(script.includes('send "/exit\\r"'));
  assert.match(script, /set timeout 3/);
});

test("parseClaudeModels reads Available line from fixture", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "claude/model-picker.txt"), "utf8");
  const models = parseClaudeModels(text);
  assert.ok(models.some((m) => m.id === "opus"));
  assert.ok(models.some((m) => m.id === "sonnet[1m]"));
});

test("parseCodexModels reads numbered picker from fixture", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "codex/model-picker.txt"), "utf8");
  const models = parseCodexModels(text);
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]
  );
  assert.deepEqual(
    models.map((m) => m.display_name),
    ["GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna"]
  );
  assert.equal(models[0].current, true);
});

test("model timeout errors include redacted pane excerpt", () => {
  const fakeKey = ["sk", "or", "v1", "0123456789abcdef"].join("-");
  const err = formatPtyTimeoutError(
    "codex",
    `boot\n${CODEX_MODEL_WAIT}\nPTY_TIMEOUT_TAIL:\n${fakeKey}\nline2`,
    ""
  );
  assert.match(err, /codex collect timed out/);
  assert.match(err, /\[REDACTED\]/);
  assert.ok(!err.includes(fakeKey));
});

/**
 * The picker prints a title-cased label; codex accepts the lowercase id, and
 * that is what the roster sends. Taking the label as the id made all five
 * roster cells read as "gone" against the live CLI — and the gone list is
 * what the daily drift alert reports.
 */
test("codex ids are the spelling the roster sends, not the picker's label", () => {
  const models = parseCodexModels(
    "  Select Model and Effort\n  › 1. GPT-6-Astra (current)\n  2. GPT-5.6-Sol\n  3. GPT-5.5\n"
  );
  assert.deepEqual(models.map((m) => m.id), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"]);
  assert.deepEqual(models.map((m) => m.display_name), ["GPT-6-Astra", "GPT-5.6-Sol", "GPT-5.5"]);
  assert.equal(models[0].current, true);
});
