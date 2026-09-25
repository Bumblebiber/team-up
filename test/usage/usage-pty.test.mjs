import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildExpectScript,
  runPtyCollect,
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
  // Assembled at runtime so repo-wide secret scans stay clean.
  const fakeKey = ["sk", "or", "v1", "0123456789abcdef"].join("-");
  const err = formatPtyTimeoutError(
    "codex",
    `booting\nlimit: 50% left (resets tomorrow)\nPTY_TIMEOUT_TAIL:\n${fakeKey}\nline2`,
    "",
  );
  assert.match(err, /codex collect timed out/);
  assert.match(err, /\[REDACTED\]/);
  assert.ok(!err.includes(fakeKey));
});

test("redactPaneExcerpt keeps last N non-empty lines", () => {
  const out = redactPaneExcerpt("a\n\nb\nc\nd\ne", 3);
  assert.match(out, /c/);
  assert.match(out, /e/);
  assert.doesNotMatch(out, /^a/m);
});

function pidsWithCmdline(marker) {
  const hits = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (cmd.includes(marker)) hits.push(Number(name));
    } catch {
      /* exited between readdir and read */
    }
  }
  return hits;
}

test("probe whose child never answers returns within the hard timeout and leaves no child", { timeout: 20_000 }, async () => {
  const marker = `teamup-probe-hang-${process.pid}-${Date.now()}`;
  // setsid grandchild survives expect dying (SIGHUP) and a SIGTERM to expect's pid.
  // It never prints the prompt, so only the hard kill can reap it.
  const script = `
set timeout 60
spawn bash -c {setsid bash -c 'exec -a ${marker} sleep 90' & exec -a ${marker} sleep 90}
expect {
  -re "never-answers-teamup" {}
  timeout { exit 2 }
}
`;
  const hardTimeoutMs = 1500;
  const started = Date.now();
  try {
    assert.throws(
      () => runPtyCollect("cursor", { hardTimeoutMs, script }),
      /cursor collect timed out/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < hardTimeoutMs + 5000, `returned in ${elapsed}ms`);
    let left = pidsWithCmdline(marker);
    for (let i = 0; i < 20 && left.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      left = pidsWithCmdline(marker);
    }
    assert.deepEqual(left, [], `child still alive: ${left.join(",")}`);
  } finally {
    for (const pid of pidsWithCmdline(marker)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
});

test("bounded probe returns the transcript when the child answers", { timeout: 15_000 }, () => {
  const script = `
set timeout 5
spawn bash -c {echo probe-ok}
expect {
  -re "probe-ok" {}
  timeout { exit 2 }
}
`;
  const out = runPtyCollect("cursor", { hardTimeoutMs: 5000, script });
  assert.match(out, /probe-ok/);
});

test("buildExpectScript cursor starts cursor-agent with --trust so its trust dialog never blocks", () => {
  const script = buildExpectScript("cursor", 30);
  assert.match(script, /exec env [^\n]*cursor-agent --trust/);
});
