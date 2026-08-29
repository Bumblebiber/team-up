import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";

function capture() {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

function capabilitySource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-"));
  fs.mkdirSync(path.join(dir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "demo", "SKILL.md"), "# Demo\n");
  fs.writeFileSync(path.join(dir, "capability.json"), JSON.stringify({
    schema_version: 1,
    id: "demo.pkg",
    version: "1.0.0",
    display_name: "Demo",
    provides: { skills: ["skills/demo/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  return dir;
}

/**
 * Every run that ever launched with a capability leaves an
 * EFFECTIVE_CAPABILITIES.json behind. If the removal guard counts those, a
 * package becomes unremovable the first time anything uses it — which is what
 * it did.
 */
function plantRun(home, runId, status, pkg, checksum) {
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify({ runId, status }));
  fs.writeFileSync(
    path.join(dir, "EFFECTIVE_CAPABILITIES.json"),
    JSON.stringify({ packages: [{ package: pkg, checksum }] })
  );
}

async function withInstalled(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const source = capabilitySource();
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    const io = capture();
    assert.equal(await runCli(["capability", "install", source], io.io), 0);
    const installed = JSON.parse(io.out.at(-1));
    return await fn({ home, checksum: installed.checksum ?? installed.package?.checksum });
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

test("a finished run does not keep a capability alive forever", async () => {
  await withInstalled(async ({ home, checksum }) => {
    for (const [runId, status] of [
      ["r-done", "done"],
      ["r-failed", "failed"],
      ["r-cancelled", "cancelled"],
    ]) {
      plantRun(home, runId, status, "demo.pkg@1.0.0", checksum);
    }
    const io = capture();
    const code = await runCli(
      ["capability", "remove", "demo.pkg@1.0.0", "--checksum", checksum],
      io.io
    );
    assert.equal(code, 0, io.err.join("\n"));
    assert.match(io.out.at(-1), /"removed"/);
  });
});

test("a run that could still be using it blocks removal", async () => {
  await withInstalled(async ({ home, checksum }) => {
    // watching is live; handing_off is a protected mid-flight state. Neither
    // may have the package removed out from under it.
    for (const status of ["watching", "handing_off"]) {
      plantRun(home, `r-${status}`, status, "demo.pkg@1.0.0", checksum);
      const io = capture();
      const code = await runCli(
        ["capability", "remove", "demo.pkg@1.0.0", "--checksum", checksum],
        io.io
      );
      assert.equal(code, 1, `${status} must block removal`);
      assert.match(io.err.join("\n"), new RegExp(`r-${status}`));
      fs.rmSync(path.join(home, "runs", `r-${status}`), { recursive: true, force: true });
    }
  });
});

test("a run whose state cannot be read blocks removal", async () => {
  await withInstalled(async ({ home, checksum }) => {
    const dir = path.join(home, "runs", "r-corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "STATE.json"), "{ not json");
    fs.writeFileSync(
      path.join(dir, "EFFECTIVE_CAPABILITIES.json"),
      JSON.stringify({ packages: [{ package: "demo.pkg@1.0.0", checksum }] })
    );
    const io = capture();
    // Refusing to remove is recoverable; removing one out from under a live
    // worker is not, so an unreadable state fails closed.
    assert.equal(
      await runCli(["capability", "remove", "demo.pkg@1.0.0", "--checksum", checksum], io.io),
      1
    );
  });
});
