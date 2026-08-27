import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialize, exists } from "../../src/sandbox/materialize.mjs";

test("materializer copies only selected package files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mat-pkg-"));
  const hannes = path.join(root, "team-up-with-hannes");
  const reanna = path.join(root, "team-up-with-reanna");
  fs.mkdirSync(hannes);
  fs.mkdirSync(reanna);
  fs.writeFileSync(path.join(hannes, "specialist.json"), JSON.stringify({ id: "testing.hannes" }));
  fs.writeFileSync(path.join(hannes, "instructions.md"), "hi");
  fs.writeFileSync(path.join(reanna, "instructions.md"), "nope");
  const out = path.join(root, "out");
  await materialize({
    packageDir: hannes,
    request: { schema: "team-up.request/v1", specialist_id: "testing.hannes" },
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
  fs.writeFileSync(path.join(pkg, "specialist.json"), JSON.stringify({ id: "testing.hannes" }));
  fs.writeFileSync(path.join(pkg, "instructions.md"), "hi");
  const out = path.join(root, "context");
  await materialize({
    packageDir: pkg,
    request: { schema: "team-up.request/v1", specialist_id: "testing.hannes" },
    destination: out,
    manifest: { capabilities: { skills: [] } },
  });
  assert.equal(
    await exists(path.join(out, "mailbox")),
    false,
    "a decoy mailbox makes a relative write succeed where it should fail"
  );
});
