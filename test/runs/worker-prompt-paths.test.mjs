import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATES = ["worker-prompt.md", "worker-prompt-legacy.md"].map((name) => [
  name,
  fs.readFileSync(path.join(ROOT, "templates", name), "utf8"),
]);

// A capsule worker's cwd is the run's context dir, not the run dir. Relative
// mailbox paths therefore wrote a second mailbox under context/ that nothing
// reads: the worker reported done, the watcher waited forever.
test("worker prompts address the mailbox absolutely", () => {
  for (const [name, body] of TEMPLATES) {
    const relative = [...body.matchAll(/`mailbox\//g)];
    assert.equal(relative.length, 0, `relative mailbox paths in ${name}`);
    assert.ok(
      body.includes("{{RUN_DIR}}/mailbox/STATUS"),
      `${name} must address STATUS through {{RUN_DIR}}`
    );
  }
});
