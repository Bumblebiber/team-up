import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialize, exists } from "../../src/sandbox/materialize.mjs";

test("materializer copies only selected package files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mat-pkg-"));
  const hannes = path.join(root, "team-up-with-hannes");
  const hugo = path.join(root, "team-up-with-hugo");
  fs.mkdirSync(hannes);
  fs.mkdirSync(hugo);
  fs.writeFileSync(path.join(hannes, "specialist.json"), JSON.stringify({ id: "testing.hannes" }));
  fs.writeFileSync(path.join(hannes, "instructions.md"), "hi");
  fs.writeFileSync(path.join(hugo, "instructions.md"), "nope");
  const out = path.join(root, "out");
  await materialize({
    packageDir: hannes,
    request: { schema: "team-up.request/v1", specialist_id: "testing.hannes" },
    destination: out,
    manifest: { capabilities: { skills: [] } },
  });
  assert.equal(await exists(path.join(out, "instructions.md")), true);
  assert.equal(await exists(path.join(out, "team-up-with-hugo")), false);
  assert.equal(await exists(path.join(out, "specialist.json")), true);
});
