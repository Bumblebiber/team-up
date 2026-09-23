import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExpectScript,
  redactPaneExcerpt,
  normalizeForRedaction,
  formatPtyTimeoutError,
  isClosedSpawnExit,
  shouldReturnPtyTranscript,
  CODEX_LIMIT_READY_RE,
  CODEX_LIMIT_WAIT,
  CODEX_LIMIT_WAIT_ALT,
  CODEX_HIT_LIMIT_WAIT,
  CODEX_STATUS_BAR_RE,
  codexTrustFlag,
} from "../../src/usage/usage-pty.mjs";

const HOME = process.env.HOME || "/home/test";

test("buildExpectScript codex waits for quota patterns with retry on timeout", () => {
  const script = buildExpectScript("codex", 180);
  assert.equal(script.split('send "/status\\r"').length - 1, 2);
  assert.ok(script.includes(CODEX_LIMIT_READY_RE));
  assert.ok(script.includes(CODEX_HIT_LIMIT_WAIT));
  assert.ok(script.includes(CODEX_STATUS_BAR_RE));
  assert.match(script, /timeout \{\s*send "\/status\\r"/);
  assert.equal(/sleep [1-9]/.test(script.split('send "/status\\r"')[1].split('send "/exit')[0]), false);
});

test("buildExpectScript codex passes invocation-only trust override from HOME", () => {
  const script = buildExpectScript("codex", 180);
  assert.ok(script.includes("trust_level"));
  assert.ok(script.includes("projects={"));
  assert.ok(script.includes("check_for_update_on_startup=false"));
  assert.ok(script.includes(`cd '${HOME}'`));
});

test("buildExpectScript codex handles update, continue, and directory-trust dialogs", () => {
  const script = buildExpectScript("codex", 180);
  assert.match(script, /Update available.*send "\\033"/);
  assert.match(script, /Continue anyway.*send "y\\r"/);
  assert.match(script, /Do you trust the contents of this directory.*Yes, continue/);
  assert.equal(/Update available.*send "1/.test(script), false);
});

test("buildExpectScript codex uses fast exit instead of long expect eof", () => {
  const script = buildExpectScript("codex", 180);
  assert.ok(script.includes('send "/exit\\r"'));
  assert.match(script, /set timeout 3/);
  assert.equal(/expect eof/.test(script), false);
});

test("buildExpectScript codex fast exit catches send to closed spawn", () => {
  const script = buildExpectScript("codex", 180);
  assert.match(script, /catch \{ send "\/exit\\r" \}/);
});

test("buildExpectScript codex retry block repeats quota patterns", () => {
  const script = buildExpectScript("codex", 180);
  assert.ok(script.includes(CODEX_LIMIT_WAIT));
  assert.ok(script.includes(CODEX_LIMIT_WAIT_ALT));
  const retryBlock = script.split("timeout {")[1] || "";
  assert.ok(retryBlock.includes(CODEX_LIMIT_WAIT));
  assert.ok(retryBlock.includes(CODEX_STATUS_BAR_RE));
});

test("closed-spawn exit is benign when transcript was captured", () => {
  assert.equal(isClosedSpawnExit('send: spawn id exp3 not open\n    while executing\n"send "/exit\\r""'), true);
  assert.equal(
    shouldReturnPtyTranscript({
      status: 1,
      stdout: "Weekly limit: 50% left (resets tomorrow)",
      stderr: 'send: spawn id exp3 not open',
    }),
    true,
  );
  assert.equal(
    shouldReturnPtyTranscript({
      status: 2,
      stdout: "partial",
      stderr: "PTY_TIMEOUT_TAIL:\nfoo",
      combined: "partial\nPTY_TIMEOUT_TAIL:\nfoo",
    }),
    false,
  );
  assert.equal(
    shouldReturnPtyTranscript({
      status: 3,
      stdout: "partial panel",
      stderr: "",
    }),
    false,
  );
});

test("normalizeForRedaction strips ANSI and unwraps continuation lines", () => {
  assert.equal(normalizeForRedaction("\x1b[31mvisible\x1b[0m"), "visible");
  assert.equal(normalizeForRedaction("line one\n line two"), "line one line two");
});

test("buildExpectScript claude waits on Current session without blind sleeps after command", () => {
  const script = buildExpectScript("claude", 45);
  assert.ok(script.includes('-re "Current session"'));
  const afterCmd = script.split('send "/usage\\r"')[1] || "";
  assert.equal(/sleep \d/.test(afterCmd), false);
});

test("buildExpectScript cursor slow-types /usage and waits for panel, no long sleeps", () => {
  const script = buildExpectScript("cursor", 180);
  assert.ok(script.includes('send "/"'));
  assert.ok(script.includes('send "usage"'));
  assert.ok(script.includes('-re "Show plan"'));
  assert.ok(script.lastIndexOf('-re "Esc to close"') > 0);
  for (const [, secs] of script.matchAll(/sleep (\d+(?:\.\d+)?)/g)) {
    assert.ok(Number(secs) <= 1, `unexpected sleep ${secs}s in cursor script`);
  }
});

test("timeout errors include redacted pane excerpt", () => {
  const err = formatPtyTimeoutError(
    "codex",
    "booting\nlimit: 50% left (resets tomorrow)\nPTY_TIMEOUT_TAIL:\nsk-or-v1-secretkey1234567890\nline2",
    "",
  );
  assert.match(err, /codex collect timed out/);
  assert.match(err, /\[REDACTED\]/);
  assert.doesNotMatch(err, /sk-or-v1/);
});

test("redactPaneExcerpt keeps last N non-empty lines", () => {
  const out = redactPaneExcerpt("a\n\nb\nc\nd\ne", 3);
  assert.match(out, /c/);
  assert.match(out, /e/);
  assert.doesNotMatch(out, /^a/m);
});
