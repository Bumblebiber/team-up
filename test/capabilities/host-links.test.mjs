import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";
import {
  listInstalledCapabilities,
  verifyInstalledCapability,
} from "../../src/capabilities/store.mjs";
import { loadAssignments } from "../../src/capabilities/assignments.mjs";
import { resolveCapabilities } from "../../src/capabilities/resolve.mjs";

function capture() {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

function source({ id = "style.x", version = "1", scope = null, mcp = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-"));
  fs.mkdirSync(path.join(dir, "skills", "x"), { recursive: true });
  const meta = scope ? `metadata:\n  team-up-scope: ${scope}\n` : "";
  fs.writeFileSync(path.join(dir, "skills", "x", "SKILL.md"),
    `---\nname: x\ndescription: d\n${meta}---\n\n# X\n`);
  const provides = { skills: ["skills/x/SKILL.md"] };
  if (mcp) {
    fs.mkdirSync(path.join(dir, "mcps"), { recursive: true });
    fs.writeFileSync(path.join(dir, "mcps", "m.json"), JSON.stringify({ mcpServers: {} }));
    provides.mcps = ["mcps/m.json"];
  }
  fs.writeFileSync(path.join(dir, "capability.json"), JSON.stringify({
    schema_version: 1, id, version, display_name: "X", provides,
    permissions: { network: false, commands: [] },
  }));
  return dir;
}

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-host-skills-"));
  const prior = {
    TEAM_UP_HOME: process.env.TEAM_UP_HOME,
    TEAM_UP_HOST_SKILL_ROOTS: process.env.TEAM_UP_HOST_SKILL_ROOTS,
  };
  process.env.TEAM_UP_HOME = home;
  process.env.TEAM_UP_HOST_SKILL_ROOTS = hostRoot;
  try {
    await fn({ home, hostRoot });
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function install(src) {
  const c = capture();
  assert.equal(await runCli(["capability", "install", src], c.io), 0, c.err.join("\n"));
  return JSON.parse(c.out[0]);
}

test("--for host links the pool copy into the host and --for all leaves the host alone", async () => {
  await withHome(async ({ hostRoot }) => {
    const rec = await install(source());
    const c = capture();
    assert.equal(await runCli(["capability", "enable", rec.package,
      "--checksum", rec.checksum, "--for", "all"], c.io), 0);
    assert.deepEqual(fs.readdirSync(hostRoot), [], "all is the specialists, not the host");

    assert.equal(await runCli(["capability", "enable", rec.package,
      "--checksum", rec.checksum, "--for", "host"], c.io), 0, c.err.join("\n"));
    const link = path.join(hostRoot, "x");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(rec.packageDir, "skills", "x")));
    assert.equal(fs.statSync(path.join(link, "SKILL.md")).mode & 0o222, 0,
      "the shared copy is read-only through the link");

    const row = loadAssignments().assignments[0];
    assert.deepEqual(row.targets, ["all", "host"]);
    // `host` never turns into a specialist delivery, and `all` still does.
    const resolved = resolveCapabilities({
      specialistId: "coding.codey", assignments: [row], installed: listInstalledCapabilities(),
    });
    assert.equal(resolved.packages.length, 1);

    assert.equal(await runCli(["capability", "disable", rec.package,
      "--checksum", rec.checksum, "--for", "host"], c.io), 0);
    assert.equal(fs.existsSync(link), false);
    assert.deepEqual(loadAssignments().assignments[0].targets, ["all"]);
  });
});

test("a host skill that is not team-up's blocks the share and records nothing", async () => {
  await withHome(async ({ hostRoot }) => {
    const rec = await install(source());
    fs.mkdirSync(path.join(hostRoot, "x"));
    fs.writeFileSync(path.join(hostRoot, "x", "SKILL.md"), "# mine\n");
    const c = capture();
    assert.equal(await runCli(["capability", "enable", rec.package,
      "--checksum", rec.checksum, "--for", "host"], c.io), 1);
    assert.match(c.err.join("\n"), /HOST_SKILL_COLLISION/);
    assert.equal(fs.readFileSync(path.join(hostRoot, "x", "SKILL.md"), "utf8"), "# mine\n");
    assert.deepEqual(loadAssignments().assignments, []);
  });
});

test("foreign entries in the host directory are never touched by a sync", async () => {
  await withHome(async ({ hostRoot }) => {
    fs.mkdirSync(path.join(hostRoot, "handmade"));
    fs.symlinkSync(os.tmpdir(), path.join(hostRoot, "elsewhere"));
    const rec = await install(source());
    const c = capture();
    await runCli(["capability", "enable", rec.package, "--checksum", rec.checksum, "--for", "host"], c.io);
    await runCli(["capability", "disable", rec.package, "--checksum", rec.checksum, "--for", "host"], c.io);
    assert.deepEqual(fs.readdirSync(hostRoot).sort(), ["elsewhere", "handmade"]);
  });
});

test("main-only packages go to the host only; specialist-only never to the host", async () => {
  await withHome(async ({ hostRoot }) => {
    const main = await install(source({ id: "mem.x", scope: "main" }));
    const c = capture();
    for (const target of ["all", "coding.codey"]) {
      assert.equal(await runCli(["capability", "enable", main.package,
        "--checksum", main.checksum, "--for", target], c.io), 1);
    }
    assert.match(c.err.join("\n"), /CAPABILITY_SCOPE_MAIN/);
    assert.equal(await runCli(["capability", "enable", main.package,
      "--checksum", main.checksum, "--for", "host"], c.io), 0);
    assert.equal(fs.existsSync(path.join(hostRoot, "x")), true);

    const spec = await install(source({ id: "spec.y", scope: "specialist" }));
    assert.equal(await runCli(["capability", "enable", spec.package,
      "--checksum", spec.checksum, "--for", "host"], c.io), 1);
    assert.match(c.err.at(-1), /CAPABILITY_SCOPE_SPECIALIST/);
  });
});

test("a package with more than skills cannot be shared by link", async () => {
  await withHome(async () => {
    const rec = await install(source({ mcp: true }));
    const c = capture();
    assert.equal(await runCli(["capability", "enable", rec.package,
      "--checksum", rec.checksum, "--for", "host"], c.io), 1);
    assert.match(c.err.join("\n"), /HOST_LINK_UNSUPPORTED/);
    assert.deepEqual(loadAssignments().assignments, []);
  });
});

test("an edit through the host link is caught before any specialist runs it", async () => {
  await withHome(async () => {
    const rec = await install(source());
    assert.equal(verifyInstalledCapability(rec), rec);
    const file = path.join(rec.packageDir, "skills", "x", "SKILL.md");
    fs.chmodSync(file, 0o644);
    fs.appendFileSync(file, "edited\n");
    assert.throws(() => verifyInstalledCapability(rec), /CAPABILITY_TAMPERED/);
  });
});

test("enable and disable still work while another shared skill is blocked on the host", async () => {
  await withHome(async ({ hostRoot }) => {
    const a = await install(source({ id: "a.x" }));
    const c = capture();
    assert.equal(await runCli(["capability", "enable", a.package,
      "--checksum", a.checksum, "--for", "host"], c.io), 0);
    // The human later replaces the link with a skill of their own.
    fs.rmSync(path.join(hostRoot, "x"));
    fs.mkdirSync(path.join(hostRoot, "x"));
    const b = await install(source({ id: "b.y" }));
    assert.equal(await runCli(["capability", "enable", b.package,
      "--checksum", b.checksum, "--for", "all"], c.io), 0, "another package's collision does not block");
    assert.match(c.out.at(-1), /"conflicts": \[\s*\{\s*"path": ".*\/x"/);
    assert.equal(await runCli(["capability", "disable", a.package,
      "--checksum", a.checksum, "--for", "host"], c.io), 0, c.err.join("\n"));
    assert.equal(fs.lstatSync(path.join(hostRoot, "x")).isDirectory(), true, "the human's dir stays");
  });
});
