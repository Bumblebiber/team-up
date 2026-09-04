import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { ancestorPids, collectStrayPids, killCollectStrays } from "../../src/usage/usage-procs.mjs";

test("collectStrayPids never returns this process or an ancestor", () => {
  // 1 -> 10 (watcher) -> 20 (collect) -> 30 (a stray). All carry the marker,
  // e.g. a collect launched from a shell that exported it.
  const ppid = { 30: 20, 20: 10, 10: 1 };
  const keep = ancestorPids(20, (pid) => ppid[pid] ?? null);
  assert.deepEqual([...keep].sort((a, b) => a - b), [1, 10, 20]);
  const strays = collectStrayPids({
    listPids: () => [1, 10, 20, 30],
    hasEnvMarker: () => true,
    keepPids: keep,
  });
  assert.deepEqual(strays, [30]);
});

// The real check: after a collect, nothing carrying the collect marker is left.
// A test-only marker keeps the sweep off a production collect running in
// parallel (node --test runs files concurrently).
test("killCollectStrays reaps an orphaned collect grandchild", { skip: !fs.existsSync("/proc") }, async () => {
  const marker = "TEAM_UP_TEST_SWEEP";
  // bash exits immediately; the setsid'd sleep escapes both its parent and the
  // process group — exactly how an MCP server outlives a collect.
  const child = spawn("bash", ["-c", "setsid sleep 60 >/dev/null 2>&1 < /dev/null & exit 0"], {
    env: { ...process.env, [marker]: "1" },
    stdio: "ignore",
  });
  await new Promise((res) => child.on("exit", res));

  const strays = collectStrayPids({ envMarker: marker });
  assert.ok(strays.length > 0, "the orphaned grandchild is visible as a stray");

  killCollectStrays({ envMarker: marker });
  for (let i = 0; i < 50 && collectStrayPids({ envMarker: marker }).length; i++) {
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.deepEqual(collectStrayPids({ envMarker: marker }), [], "sweep left nothing behind");
});
