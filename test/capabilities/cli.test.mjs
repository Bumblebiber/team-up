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

test("install is inert until explicit enable and list is JSON", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "tu-cap-"));
  fs.mkdirSync(path.join(source, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", "x", "SKILL.md"), "# X\n");
  fs.writeFileSync(path.join(source, "capability.json"), JSON.stringify({
    schema_version: 1, id: "x", version: "1", display_name: "X",
    provides: { skills: ["skills/x/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  const prior = process.env.TEAM_UP_HOME;
  process.env.TEAM_UP_HOME = home;
  try {
    const c = capture();
    assert.equal(await runCli(["capability", "install", source], c.io), 0);
    assert.equal(await runCli(["capability", "list"], c.io), 0);
    assert.match(c.out.at(-1), /"assignments": \[\]/);
    assert.equal(await runCli([
      "capability", "enable", "x@1", "--checksum",
      JSON.parse(c.out[0]).checksum, "--for", "all",
    ], c.io), 0);
  } finally {
    if (prior === undefined) delete process.env.TEAM_UP_HOME;
    else process.env.TEAM_UP_HOME = prior;
  }
});
