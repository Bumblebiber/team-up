import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.mjs";

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function capabilitySource(id = "x", version = "1") {
  const source = tmpdir("tu-cap-");
  fs.mkdirSync(path.join(source, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", "x", "SKILL.md"), "# X\n");
  fs.writeFileSync(
    path.join(source, "capability.json"),
    JSON.stringify({
      schema_version: 1,
      id,
      version,
      display_name: "X",
      provides: { skills: ["skills/x/SKILL.md"] },
      permissions: { network: false, commands: [] },
    })
  );
  return source;
}

async function withHome(fn) {
  const home = tmpdir("tu-home-");
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
  }
}

test("install is inert until explicit enable and list is JSON", async () => {
  await withHome(async () => {
    const source = capabilitySource();
    const c = capture();
    assert.equal(await runCli(["capability", "install", source], c.io), 0);
    const installed = JSON.parse(c.out[0]);
    assert.equal(installed.package, "x@1");

    assert.equal(await runCli(["capability", "list"], c.io), 0);
    const listed = JSON.parse(c.out.at(-1));
    assert.equal(listed.packages.length, 1);
    assert.deepEqual(listed.assignments, []);
    assert.match(c.out.at(-1), /"assignments": \[\]/);

    assert.equal(
      await runCli(
        ["capability", "enable", "x@1", "--checksum", installed.checksum, "--for", "all"],
        c.io
      ),
      0
    );
    assert.equal(await runCli(["capability", "list"], c.io), 0);
    assert.deepEqual(JSON.parse(c.out.at(-1)).assignments, [
      {
        package: "x@1",
        checksum: installed.checksum,
        targets: ["all"],
        exclude: [],
      },
    ]);
  });
});

test("inspect works on a source path without touching the pool", async () => {
  await withHome(async (home) => {
    const source = capabilitySource();
    const c = capture();
    assert.equal(await runCli(["capability", "inspect", source], c.io), 0);
    const preview = JSON.parse(c.out[0]);
    assert.match(preview.checksum, /^sha256:/);
    assert.deepEqual(preview.files, ["skills/x/SKILL.md"]);
    assert.equal(preview.mcp_tool_count, 0);
    assert.ok(preview.estimated_description_tokens >= 0);
    assert.equal(fs.existsSync(path.join(home, "capability-pool")), false);
  });
});

test("inspect resolves an installed selector by checksum", async () => {
  await withHome(async () => {
    const c = capture();
    await runCli(["capability", "install", capabilitySource()], c.io);
    const { checksum } = JSON.parse(c.out[0]);
    assert.equal(
      await runCli(["capability", "inspect", "x@1", "--checksum", checksum], c.io),
      0
    );
    assert.equal(JSON.parse(c.out.at(-1)).checksum, checksum);
  });
});

test("enable and disable require an explicit target and checksum", async () => {
  await withHome(async () => {
    const c = capture();
    await runCli(["capability", "install", capabilitySource()], c.io);
    const { checksum } = JSON.parse(c.out[0]);
    assert.equal(await runCli(["capability", "enable", "x@1", "--for", "all"], c.io), 1);
    assert.equal(
      await runCli(["capability", "enable", "x@1", "--checksum", checksum], c.io),
      1
    );
    assert.equal(await runCli(["capability", "enable"], c.io), 1);
    assert.equal(await runCli(["capability", "list"], c.io), 0);
    assert.deepEqual(JSON.parse(c.out.at(-1)).assignments, []);
  });
});

test("disable excludes one specialist from a dynamic all", async () => {
  await withHome(async () => {
    const c = capture();
    await runCli(["capability", "install", capabilitySource()], c.io);
    const { checksum } = JSON.parse(c.out[0]);
    await runCli(
      ["capability", "enable", "x@1", "--checksum", checksum, "--for", "all"],
      c.io
    );
    assert.equal(
      await runCli(
        [
          "capability",
          "disable",
          "x@1",
          "--checksum",
          checksum,
          "--for",
          "research.hugo",
        ],
        c.io
      ),
      0
    );
    await runCli(["capability", "list"], c.io);
    const [row] = JSON.parse(c.out.at(-1)).assignments;
    assert.deepEqual(row.targets, ["all"]);
    assert.deepEqual(row.exclude, ["research.hugo"]);
  });
});

test("reading recommendations changes no pool or assignment state", async () => {
  await withHome(async () => {
    const c = capture();
    await runCli(["capability", "install", capabilitySource()], c.io);
    const { checksum } = JSON.parse(c.out[0]);
    await runCli(
      ["capability", "enable", "x@1", "--checksum", checksum, "--for", "all"],
      c.io
    );

    await runCli(["capability", "list"], c.io);
    const before = c.out.at(-1);

    // Unknown specialist is an error, never a mutation.
    assert.equal(
      await runCli(["capability", "recommendations", "research.rick"], c.io),
      1
    );

    await runCli(["capability", "list"], c.io);
    assert.equal(c.out.at(-1), before);
  });
});

test("update installs beside the old version without activating it", async () => {
  await withHome(async () => {
    const c = capture();
    await runCli(["capability", "install", capabilitySource()], c.io);
    const first = JSON.parse(c.out[0]);
    await runCli(
      ["capability", "enable", "x@1", "--checksum", first.checksum, "--for", "all"],
      c.io
    );

    const changed = capabilitySource();
    fs.writeFileSync(
      path.join(changed, "skills", "x", "SKILL.md"),
      "# X, revised\n"
    );
    assert.equal(
      await runCli(
        ["capability", "update", "x@1", "--from-checksum", first.checksum, "--source", changed],
        c.io
      ),
      0
    );
    const { installed, plan } = JSON.parse(c.out.at(-1));
    assert.notEqual(installed.checksum, first.checksum);
    assert.equal(plan.activate, false);

    // The assignment still points at the original checksum.
    await runCli(["capability", "list"], c.io);
    const listed = JSON.parse(c.out.at(-1));
    assert.equal(listed.packages.length, 2);
    assert.deepEqual(listed.assignments[0].checksum, first.checksum);
  });
});

test("remove refuses an assigned version and succeeds once unassigned", async () => {
  await withHome(async () => {
    const c = capture();
    await runCli(["capability", "install", capabilitySource()], c.io);
    const { checksum } = JSON.parse(c.out[0]);
    await runCli(
      ["capability", "enable", "x@1", "--checksum", checksum, "--for", "all"],
      c.io
    );
    assert.equal(
      await runCli(["capability", "remove", "x@1", "--checksum", checksum], c.io),
      1
    );
    assert.match(c.err.at(-1), /CAPABILITY_REFERENCED/);

    await runCli(
      ["capability", "disable", "x@1", "--checksum", checksum, "--for", "all"],
      c.io
    );
    assert.equal(
      await runCli(["capability", "remove", "x@1", "--checksum", checksum], c.io),
      0
    );
    await runCli(["capability", "list"], c.io);
    assert.deepEqual(JSON.parse(c.out.at(-1)).packages, []);
  });
});

test("unknown subcommands and failed imports exit non-zero", async () => {
  await withHome(async () => {
    const c = capture();
    assert.equal(await runCli(["capability"], c.io), 1);
    assert.equal(await runCli(["capability", "frobnicate"], c.io), 1);
    assert.equal(await runCli(["capability", "install"], c.io), 1);
    assert.equal(
      await runCli(["capability", "install", "/nonexistent/source"], c.io),
      1
    );
    assert.ok(c.err.length > 0);
  });
});
