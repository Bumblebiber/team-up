import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, "hermetic-home.mjs");
const claudeAdapter = pathToFileURL(path.resolve(here, "../../src/harness/claude.mjs")).href;

// A capsule launch copies $HOME/.claude/.credentials.json into the run home,
// so a test that prepares one copied the host's real OAuth credential into
// /tmp. Under the preload, the defaults must never reach the real file.
test("under the test preload a capsule home never copies the invoking user's credentials", () => {
  const sentinelHome = fs.mkdtempSync(path.join(os.tmpdir(), "tu-sentinel-home-"));
  try {
    fs.mkdirSync(path.join(sentinelHome, ".claude"));
    fs.writeFileSync(path.join(sentinelHome, ".claude", ".credentials.json"), '{"token":"REAL-CREDENTIAL-SENTINEL"}');
    const code = `
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      import { materializeClaudeAuthHome } from ${JSON.stringify(claudeAdapter)};
      const run = fs.mkdtempSync(path.join(os.tmpdir(), "tu-sentinel-run-"));
      const { home } = materializeClaudeAuthHome(run);
      const copied = fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8");
      fs.rmSync(run, { recursive: true, force: true });
      console.log(JSON.stringify({ copied, homedir: os.homedir() }));
    `;
    const child = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...process.env, HOME: sentinelHome },
    });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout);
    assert.doesNotMatch(out.copied, /REAL-CREDENTIAL-SENTINEL/);
    assert.notEqual(out.homedir, sentinelHome);
  } finally {
    fs.rmSync(sentinelHome, { recursive: true, force: true });
  }
});
