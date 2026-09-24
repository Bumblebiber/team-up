// A missing `import os from "node:os"` cost a day of usage data: the only line
// that reached os.tmpdir() sat inside the codex/cursor collector, so nothing
// threw until the watcher ran. Node has no no-undef check and this repo has no
// linter, so the namespaces we actually use get a grep-sized one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const NAMESPACES = ["fs", "os", "path", "crypto", "http", "https", "net", "zlib"];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith(".mjs") ? [full] : [];
  });
}

test("every node namespace a src file uses is imported there", () => {
  const missing = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const ns of NAMESPACES) {
      // Not preceded by a dot, word char or quote: skips `req.path.foo`,
      // `myos.x` and "os.tmpdir" inside a string.
      const used = new RegExp(`(?<![\\w.$"'\`])${ns}\\.\\w`).test(text);
      if (!used) continue;
      const imported = new RegExp(`^import\\s+${ns}\\s+from|^\\s*(const|let)\\s+${ns}\\s*=`, "m").test(text);
      if (!imported) missing.push(`${path.relative(SRC, file)}: ${ns}`);
    }
  }
  assert.deepEqual(missing, []);
});
