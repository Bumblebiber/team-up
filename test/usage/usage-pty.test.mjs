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
} from "../../src/usage/usage-pty.mjs";

test("buildExpectScript rejects claude and codex usage collects", () => {
  assert.throws(() => buildExpectScript("claude", 45), /no PTY sequence/);
  assert.throws(() => buildExpectScript("codex", 180), /no PTY sequence/);
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

test("buildExpectScript cursor types /usage and waits for panel, no long sleeps", () => {
  const script = buildExpectScript("cursor", 180);
  assert.ok(script.includes('send "/usage"'));
  assert.ok(script.lastIndexOf('-re "Esc to close"') > 0);
  // cursor-agent prints its banner once; a second wait for it hangs forever.
  assert.equal((script.match(/-re "Tip:"/g) || []).length, 1);
  // The paginated slash menu hides the /usage row — never wait for it.
  assert.ok(!script.includes("Show plan"));
  for (const [, secs] of script.matchAll(/sleep (\d+(?:\.\d+)?)/g)) {
    assert.ok(Number(secs) <= 1, `unexpected sleep ${secs}s in cursor script`);
  }
});

test("timeout errors include redacted pane excerpt", () => {
  // Assembled at runtime so repo-wide secret scans stay clean.
  const fakeKey = ["sk", "or", "v1", "0123456789abcdef"].join("-");
  const err = formatPtyTimeoutError(
    "cursor",
    `booting\nlimit: 50% left (resets tomorrow)\nPTY_TIMEOUT_TAIL:\n${fakeKey}\nline2`,
    "",
  );
  assert.match(err, /cursor collect timed out/);
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

test("signalTree leaves a recorded pid alone once its start time no longer matches (pid reuse)", async () => {
  const { spawn } = await import("node:child_process");
  const { signalTree, readProcIds } = await import("../../src/usage/usage-pty.mjs");
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const ids = readProcIds(child.pid);
  const alive = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  signalTree([{ pid: child.pid, pgid: ids.pgid, start: String(Number(ids.start) + 1) }], new Set());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), true);
  signalTree([{ pid: child.pid, pgid: ids.pgid, start: ids.start }], new Set());
  await new Promise((r) => child.once("exit", r));
  assert.equal(alive(), false);
});
