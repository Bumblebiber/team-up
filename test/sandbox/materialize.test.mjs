import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialize, exists } from "../../src/sandbox/materialize.mjs";

test("materializer copies only selected package files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mat-pkg-"));
  const tessa = path.join(root, "team-up-with-tessa");
  const reanna = path.join(root, "team-up-with-reanna");
  fs.mkdirSync(tessa);
  fs.mkdirSync(reanna);
  fs.writeFileSync(path.join(tessa, "specialist.json"), JSON.stringify({ id: "testing.tessa" }));
  fs.writeFileSync(path.join(tessa, "instructions.md"), "hi");
  fs.writeFileSync(path.join(reanna, "instructions.md"), "nope");
  const out = path.join(root, "out");
  await materialize({
    packageDir: tessa,
    request: { schema: "team-up.request/v1", specialist_id: "testing.tessa" },
    destination: out,
    manifest: { capabilities: { skills: [] } },
  });
  assert.equal(await exists(path.join(out, "instructions.md")), true);
  assert.equal(await exists(path.join(out, "team-up-with-reanna")), false);
  assert.equal(await exists(path.join(out, "specialist.json")), true);
});

// The capsule context dir is the worker's cwd, so `mailbox/` inside it is
// exactly where a relative mailbox path resolves. Seeding one there turned a
// wrong path into a silent success: a worker reported `done` into a directory
// nothing reads while the watcher waited on the real mailbox.
test("materializer seeds no mailbox in the worker's working directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mat-mb-"));
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify({ id: "testing.tessa" }));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi");
  const out = path.join(root, "context");
  await materialize({
    packageDir: pkg,
    request: { schema: "team-up.request/v1", specialist_id: "testing.tessa" },
    destination: out,
    manifest: { capabilities: { skills: [] } },
  });
  assert.equal(
    await exists(path.join(out, "mailbox")),
    false,
    "a decoy mailbox makes a relative write succeed where it should fail"
  );
});

// Bundle skills ship as flat `skills/<name>.md`, but harnesses register only
// skill directories. A flat file alone left every specialist's own skills
// undiscoverable: the worker found them only if it happened to read context/.
test("materializer also lays each bundle skill out as a discoverable SKILL.md", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mat-skill-"));
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(path.join(pkg, "skills"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify({ id: "marketing.martha" }));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi");
  fs.writeFileSync(
    path.join(pkg, "skills", "copywriting.md"),
    "# Copywriting\n\nWrite copy that makes one reader\ntake one action.\n\n## Rules\n"
  );
  const out = path.join(root, "context");
  await materialize({
    packageDir: pkg,
    request: { schema: "team-up.request/v1", specialist_id: "marketing.martha" },
    destination: out,
    manifest: { capabilities: { skills: ["copywriting"] } },
  });
  assert.equal(await exists(path.join(out, "skills", "copywriting.md")), true, "flat copy stays");
  const skill = fs.readFileSync(path.join(out, "skills", "copywriting", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: copywriting\ndescription: "Write copy that makes one reader take one action\."\n---\n\n# Copywriting/);
});
