<!-- o9k-provenance
who: codex:gpt-5
when: 2026-07-26T10:32:29Z
why: Create the TDD implementation plan for the approved capability pool and specialist context isolation design
trigger: User approved the written specification and asked to continue
host: codex
-->
# Capability Pool and Specialist Context Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-controlled, content-addressed capability pool that gives each specialist run only its explicitly selected skills, plugins, MCPs, and frameworks.

**Architecture:** Immutable capability packages are imported into `~/.team-up`, while a separate atomic assignment document records dynamic `all` and per-specialist selections. A pure resolver produces an effective set, a capsule builder materializes only that set, and version-verified harness adapters must prove `team-up.context-isolation/v1` before a worker can start. One supervisor-only `/team-up-manage` skill drives deterministic CLI operations; specialist recommendations remain inert metadata.

**Tech Stack:** Node.js ES modules with Node `>=18`, native `node:test`, JSON state through the existing atomic store, `git` through `execFileSync`, existing specialist/run/harness modules, Claude Code CLI and TMUX.

---

## Execution Context

Work in:

```bash
cd /home/bbbee/projects/team-up
```

Read the approved design before starting:

```bash
sed -n '1,520p' docs/specs/2026-07-26-capability-pool-context-isolation-design.md
```

Before implementation, use `superpowers:using-git-worktrees`. Do not change
the live files below `~/.team-up`; every test must set `TEAM_UP_HOME` to a
temporary directory. Do not publish, merge, or modify sibling specialist
repositories while executing this plan.

## Target File Structure

Create focused modules:

```text
src/capabilities/
  manifest.mjs       # normalize and validate generic capability manifests
  store.mjs          # atomic content-addressed local imports and lookup
  assignments.mjs    # atomic human-controlled assignment mutations
  resolve.mjs        # pure all/include/exclude/conflict resolution
  cli.mjs            # deterministic capability command surface
  git-source.mjs     # resolve and import immutable Git revisions
  recommendations.mjs # normalize inert specialist recommendations
  capsule.mjs        # materialize only effective package contents
  lifecycle.mjs      # update, rollback, remove and reference checks
  scan.mjs           # read-only discovery of known local roots
skills/team-up-manage/
  SKILL.md            # compact supervisor-only operator workflow
test/capabilities/
  manifest.test.mjs
  store.test.mjs
  assignments.test.mjs
  resolve.test.mjs
  cli.test.mjs
  git-source.test.mjs
  recommendations.test.mjs
  capsule.test.mjs
  lifecycle.test.mjs
  scan.test.mjs
test/integration/
  capability-isolation.test.mjs
```

Modify only the existing integration points:

```text
src/paths.mjs
src/cli.mjs
src/specialists/manifest.mjs
src/specialists/launcher.mjs
src/harness/capabilities.mjs
src/harness/registry.mjs
src/harness/claude.mjs
src/harness/codex.mjs
src/harness/cli-verify.mjs
package.json
README.md
docs/specialists.md
```

Keep capability-package validation separate from specialist-package
validation. Keep assignment resolution pure and filesystem-free. Keep the
existing `src/sandbox/materialize.mjs` responsible for intrinsic specialist
files; `capsule.mjs` composes its output with pool capabilities.

### Task 1: Capability Paths and Manifest Validation

**Files:**

- Create: `src/capabilities/manifest.mjs`
- Modify: `src/paths.mjs`
- Test: `test/capabilities/manifest.test.mjs`

- [ ] **Step 1: Write failing manifest and path tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeCapabilityManifest,
  declaredCapabilityFiles,
} from "../../src/capabilities/manifest.mjs";
import {
  capabilityPoolRoot,
  capabilityAssignmentsPath,
} from "../../src/paths.mjs";

test("normalizes all provider arrays and validates declared files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-cap-"));
  fs.mkdirSync(path.join(root, "skills", "caveman"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "caveman", "SKILL.md"), "# Caveman\n");
  const manifest = normalizeCapabilityManifest({
    schema_version: 1,
    id: "o9k.caveman",
    version: "1.2.0",
    display_name: "Caveman",
    provides: { skills: ["skills/caveman/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }, { packageDir: root });
  assert.deepEqual(manifest.provides, {
    skills: ["skills/caveman/SKILL.md"],
    plugins: [],
    mcps: [],
    frameworks: [],
  });
  assert.deepEqual(declaredCapabilityFiles(root, manifest), [
    "skills/caveman/SKILL.md",
  ]);
});

test("rejects escapes, symlinks, concrete models, and lifecycle hooks", () => {
  assert.throws(() => normalizeCapabilityManifest({
    schema_version: 1,
    id: "bad",
    version: "1",
    display_name: "Bad",
    model: "fixed-model",
    provides: { skills: ["../secret"] },
    permissions: { network: false, commands: [] },
    scripts: { install: "curl example" },
  }), /forbidden key|safe relative path/);
});

test("capability state paths honor TEAM_UP_HOME", () => {
  const env = { TEAM_UP_HOME: "/tmp/team-up-test" };
  assert.equal(capabilityPoolRoot(env), "/tmp/team-up-test/capability-pool");
  assert.equal(
    capabilityAssignmentsPath(env),
    "/tmp/team-up-test/capability-assignments.json"
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/capabilities/manifest.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`src/capabilities/manifest.mjs`.

- [ ] **Step 3: Implement the manifest contract**

Create `src/capabilities/manifest.mjs` with these exports and rules:

```js
import fs from "node:fs";
import path from "node:path";
import {
  assertPathInsideRoot,
  assertSafeRelPath,
  assertSafeSpecialistSegment,
} from "../specialists/safe-id.mjs";

const PROVIDE_TYPES = ["skills", "plugins", "mcps", "frameworks"];
const FORBIDDEN = new Set([
  "model", "provider", "preferred_model", "model_id", "model_name",
  "install", "preinstall", "postinstall", "scripts",
]);

function walk(value, visit, parts = []) {
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, visit, [...parts, i]));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, [...parts, key]);
    walk(child, visit, [...parts, key]);
  }
}

export function normalizeCapabilityManifest(input, { packageDir } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("capability manifest must be an object");
  }
  walk(input, (key, parts) => {
    if (FORBIDDEN.has(key)) throw new Error(`forbidden key "${key}" at ${parts.join(".")}`);
  });
  if (input.schema_version !== 1) throw new Error("unsupported capability schema_version");
  assertSafeSpecialistSegment(String(input.id), "capability id");
  assertSafeSpecialistSegment(String(input.version), "capability version");
  if (!input.display_name || typeof input.display_name !== "string") {
    throw new Error("display_name must be a non-empty string");
  }
  const provides = {};
  for (const type of PROVIDE_TYPES) {
    const entries = input.provides?.[type] ?? [];
    if (!Array.isArray(entries)) throw new Error(`provides.${type} must be an array`);
    provides[type] = entries.map((entry) => assertSafeRelPath(String(entry), `${type} path`));
  }
  const permissions = {
    network: input.permissions?.network ?? false,
    commands: input.permissions?.commands ?? [],
    filesystem: input.permissions?.filesystem ?? "none",
  };
  if (typeof permissions.network !== "boolean" ||
      !Array.isArray(permissions.commands) ||
      !["none", "project_readonly", "project", "home"].includes(
        permissions.filesystem)) {
    throw new Error(
      "permissions require boolean network, commands array, and valid filesystem"
    );
  }
  const manifest = { ...input, provides, permissions };
  if (packageDir) declaredCapabilityFiles(packageDir, manifest);
  return manifest;
}

export function declaredCapabilityFiles(packageDir, manifest) {
  const root = fs.realpathSync(packageDir);
  const files = [];
  const collect = (abs, rel) => {
    assertPathInsideRoot(abs, root);
    if (!fs.existsSync(abs)) throw new Error(`declared capability path missing: ${rel}`);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink: ${rel}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        collect(path.join(abs, name), path.join(rel, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported capability file type: ${rel}`);
    files.push(rel);
  };
  for (const type of PROVIDE_TYPES) {
    for (const rel of manifest.provides[type]) {
      const abs = path.join(root, rel);
      collect(abs, rel);
    }
  }
  return [...new Set(files)].sort();
}
```

Add to `src/paths.mjs`:

```js
export function capabilityPoolRoot(env = process.env) {
  return env.TEAM_UP_CAPABILITY_POOL ||
    path.join(teamUpHome(env), "capability-pool");
}

export function capabilityAssignmentsPath(env = process.env) {
  return env.TEAM_UP_CAPABILITY_ASSIGNMENTS ||
    path.join(teamUpHome(env), "capability-assignments.json");
}
```

- [ ] **Step 4: Run focused tests and the full suite**

Run:

```bash
node --test test/capabilities/manifest.test.mjs
npm test
```

Expected: focused tests PASS and the existing suite remains green.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/manifest.mjs src/paths.mjs test/capabilities/manifest.test.mjs
git commit -m "feat: validate capability package manifests"
```

### Task 2: Atomic Content-Addressed Local Pool

**Files:**

- Create: `src/capabilities/store.mjs`
- Test: `test/capabilities/store.test.mjs`

- [ ] **Step 1: Write failing atomic import tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importLocalCapability,
  inspectInstalledCapability,
  listInstalledCapabilities,
} from "../../src/capabilities/store.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-source-"));
  fs.mkdirSync(path.join(root, "skills", "short"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "short", "SKILL.md"), "# Short\n");
  fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
    schema_version: 1,
    id: "example.short",
    version: "1.0.0",
    display_name: "Short",
    provides: { skills: ["skills/short/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  return root;
}

test("identical local imports collapse to one checksum path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-home-"));
  const env = { TEAM_UP_HOME: home };
  const first = importLocalCapability(fixture(), { env });
  const second = importLocalCapability(fixture(), { env });
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.packageDir, second.packageDir);
  assert.equal(listInstalledCapabilities({ env }).length, 1);
  assert.equal(inspectInstalledCapability("example.short@1.0.0", {
    checksum: first.checksum, env,
  }).checksum, first.checksum);
});

test("invalid import leaves neither destination nor index entry", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-home-"));
  const source = fixture();
  fs.rmSync(path.join(source, "skills", "short", "SKILL.md"));
  assert.throws(() => importLocalCapability(source, {
    env: { TEAM_UP_HOME: home },
  }), /missing/);
  assert.equal(fs.existsSync(path.join(home, "capability-pool", "index.json")), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/capabilities/store.test.mjs
```

Expected: FAIL because `store.mjs` is absent.

- [ ] **Step 3: Implement deterministic hashing and atomic promotion**

Create `src/capabilities/store.mjs`. Copy only `capability.json` plus the
declared paths; sort paths and hash the relative filename, NUL separator, file
length, NUL separator, and bytes:

```js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityPoolRoot } from "../paths.mjs";
import {
  declaredCapabilityFiles,
  normalizeCapabilityManifest,
} from "./manifest.mjs";

export function checksumFiles(root, files, manifest) {
  const hash = crypto.createHash("sha256");
  const normalizedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  hash.update("capability.json"); hash.update("\0");
  hash.update(String(Buffer.byteLength(normalizedManifest))); hash.update("\0");
  hash.update(normalizedManifest);
  for (const rel of [...files].sort()) {
    const bytes = fs.readFileSync(path.join(root, rel));
    hash.update(rel); hash.update("\0");
    hash.update(String(bytes.length)); hash.update("\0");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function capabilityMetrics(root, manifest) {
  const skillBytes = manifest.provides.skills.reduce((sum, rel) =>
    sum + fs.statSync(path.join(root, rel)).size, 0);
  const mcpToolCount = manifest.provides.mcps.reduce((sum, rel) => {
    const doc = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    return sum + (Array.isArray(doc.tools) ? doc.tools.length : 0);
  }, 0);
  return {
    estimated_description_tokens: Math.ceil(skillBytes / 4),
    mcp_tool_count: mcpToolCount,
    plugin_metadata: manifest.provides.plugins,
    framework_metadata: manifest.provides.frameworks,
    permissions: manifest.permissions,
    warnings: manifest.warnings ?? [],
  };
}

export function inspectCapabilitySource(source, { manifestOverride } = {}) {
  const root = fs.realpathSync(source);
  const input = manifestOverride ?? JSON.parse(fs.readFileSync(
    path.join(root, "capability.json"), "utf8"
  ));
  const manifest = normalizeCapabilityManifest(input, { packageDir: root });
  const files = declaredCapabilityFiles(root, manifest);
  return {
    root, manifest, files,
    checksum: checksumFiles(root, files, manifest),
    ...capabilityMetrics(root, manifest),
  };
}

export function importLocalCapability(source, {
  env = process.env,
  sourceMetadata = { type: "local", path: path.resolve(source) },
  manifestOverride,
} = {}) {
  const preview = inspectCapabilitySource(source, { manifestOverride });
  const { root, manifest, files, checksum } = preview;
  const digest = checksum.slice("sha256:".length);
  const pool = capabilityPoolRoot(env);
  const destination = path.join(pool, manifest.id, manifest.version, digest);
  const indexPath = path.join(pool, "index.json");
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".import-"));
    try {
      const packageDir = path.join(staging, "package");
      fs.mkdirSync(packageDir, { recursive: true });
      for (const rel of files) {
        fs.mkdirSync(path.dirname(path.join(packageDir, rel)), { recursive: true });
        fs.copyFileSync(path.join(root, rel), path.join(packageDir, rel));
      }
      fs.writeFileSync(path.join(packageDir, "capability.json"),
        `${JSON.stringify(manifest, null, 2)}\n`);
      atomicWriteJson(path.join(staging, "source.json"), sourceMetadata);
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const record = {
    package: `${manifest.id}@${manifest.version}`,
    id: manifest.id,
    version: manifest.version,
    checksum,
    packageDir: path.join(destination, "package"),
    source: sourceMetadata,
    imported_at: new Date().toISOString(),
    estimated_description_tokens: preview.estimated_description_tokens,
    mcp_tool_count: preview.mcp_tool_count,
    plugin_metadata: preview.plugin_metadata,
    framework_metadata: preview.framework_metadata,
    permissions: preview.permissions,
    warnings: preview.warnings,
  };
  const index = loadJson(indexPath) ?? { schema_version: 1, packages: [] };
  if (!index.packages.some((item) => item.checksum === checksum &&
      item.package === record.package)) {
    index.packages.push(record);
    index.packages.sort((a, b) =>
      `${a.package}:${a.checksum}`.localeCompare(`${b.package}:${b.checksum}`));
    atomicWriteJson(indexPath, index);
  }
  return record;
}

export function listInstalledCapabilities({ env = process.env } = {}) {
  return loadJson(path.join(capabilityPoolRoot(env), "index.json"))?.packages ?? [];
}

export function inspectInstalledCapability(selector, {
  checksum, env = process.env,
} = {}) {
  const matches = listInstalledCapabilities({ env }).filter((item) =>
    item.package === selector && (!checksum || item.checksum === checksum));
  if (matches.length !== 1) {
    throw new Error(`capability selector must resolve exactly once: ${selector}`);
  }
  return matches[0];
}
```

- [ ] **Step 4: Verify atomicity, metadata, and regressions**

Run:

```bash
node --test test/capabilities/store.test.mjs
npm test
```

Expected: all tests PASS; a failed import leaves no `.import-*` directory.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/store.mjs test/capabilities/store.test.mjs
git commit -m "feat: add content-addressed capability pool"
```

### Task 3: Assignment Storage and Pure Resolution

**Files:**

- Create: `src/capabilities/assignments.mjs`
- Create: `src/capabilities/resolve.mjs`
- Test: `test/capabilities/assignments.test.mjs`
- Test: `test/capabilities/resolve.test.mjs`

- [ ] **Step 1: Write failing assignment mutation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import {
  enableCapability,
  disableCapability,
  loadAssignments,
} from "../../src/capabilities/assignments.mjs";

test("all remains dynamic and specialist disable adds an exclusion", () => {
  const env = { TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tu-")) };
  enableCapability({
    package: "o9k.caveman@1.2.0", checksum: "sha256:abc", target: "all", env,
  });
  disableCapability({
    package: "o9k.caveman@1.2.0", checksum: "sha256:abc",
    target: "research.hugo", env,
  });
  assert.deepEqual(loadAssignments({ env }).assignments[0], {
    package: "o9k.caveman@1.2.0",
    checksum: "sha256:abc",
    targets: ["all"],
    exclude: ["research.hugo"],
  });
  enableCapability({
    package: "o9k.caveman@1.2.0", checksum: "sha256:abc",
    target: "research.hugo", env,
  });
  assert.deepEqual(loadAssignments({ env }).assignments[0].exclude, []);
});
```

Include `import path from "node:path";` in this test.

- [ ] **Step 2: Write failing resolver tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../../src/capabilities/resolve.mjs";

const installed = [
  { package: "o9k.caveman@1.2.0", id: "o9k.caveman", version: "1.2.0",
    checksum: "sha256:a", packageDir: "/pool/a" },
  { package: "hugo.search@1.0.0", id: "hugo.search", version: "1.0.0",
    checksum: "sha256:b", packageDir: "/pool/b" },
];

test("exclusion wins over all and explicit target is included", () => {
  const assignments = [
    { package: "o9k.caveman@1.2.0", checksum: "sha256:a",
      targets: ["all"], exclude: ["research.hugo"] },
    { package: "hugo.search@1.0.0", checksum: "sha256:b",
      targets: ["research.hugo"], exclude: [] },
  ];
  assert.deepEqual(
    resolveCapabilities({ specialistId: "research.hugo", assignments, installed })
      .packages.map((item) => [item.package, item.reason]),
    [["hugo.search@1.0.0", "target:research.hugo"]]
  );
});

test("different selected versions of one id fail deterministically", () => {
  assert.throws(() => resolveCapabilities({
    specialistId: "research.hugo",
    assignments: [
      { package: "x@1", checksum: "sha256:1", targets: ["all"], exclude: [] },
      { package: "x@2", checksum: "sha256:2",
        targets: ["research.hugo"], exclude: [] },
    ],
    installed: [
      { package: "x@1", id: "x", version: "1", checksum: "sha256:1" },
      { package: "x@2", id: "x", version: "2", checksum: "sha256:2" },
    ],
  }), /CAPABILITY_VERSION_CONFLICT.*x@1.*x@2/);
});
```

- [ ] **Step 3: Run both files and verify RED**

Run:

```bash
node --test test/capabilities/assignments.test.mjs test/capabilities/resolve.test.mjs
```

Expected: FAIL with missing modules.

- [ ] **Step 4: Implement assignment mutations**

Create `src/capabilities/assignments.mjs`:

```js
import { atomicWriteJson, loadJson } from "../json-store.mjs";
import { capabilityAssignmentsPath } from "../paths.mjs";

export function loadAssignments({ env = process.env } = {}) {
  return loadJson(capabilityAssignmentsPath(env)) ??
    { schema_version: 1, assignments: [] };
}

function mutate({ package: pkg, checksum, target, env }, update) {
  if (!pkg?.includes("@") || !checksum?.startsWith("sha256:") || !target) {
    throw new Error("package, sha256 checksum, and target are required");
  }
  const doc = loadAssignments({ env });
  let row = doc.assignments.find((item) =>
    item.package === pkg && item.checksum === checksum);
  if (!row) {
    row = { package: pkg, checksum, targets: [], exclude: [] };
    doc.assignments.push(row);
  }
  update(row);
  row.targets = [...new Set(row.targets)].sort();
  row.exclude = [...new Set(row.exclude)].sort();
  doc.assignments = doc.assignments
    .filter((item) => item.targets.length > 0)
    .sort((a, b) => `${a.package}:${a.checksum}`.localeCompare(
      `${b.package}:${b.checksum}`));
  atomicWriteJson(capabilityAssignmentsPath(env), doc);
  return doc;
}

export function enableCapability(args) {
  return mutate(args, (row) => {
    if (args.target === "all") row.targets.push("all");
    else if (!row.targets.includes("all")) row.targets.push(args.target);
    row.exclude = row.exclude.filter((id) => id !== args.target);
  });
}

export function disableCapability(args) {
  return mutate(args, (row) => {
    if (args.target === "all") row.targets = row.targets.filter((id) => id !== "all");
    else if (row.targets.includes("all")) row.exclude.push(args.target);
    else row.targets = row.targets.filter((id) => id !== args.target);
  });
}
```

- [ ] **Step 5: Implement pure effective-set resolution**

Create `src/capabilities/resolve.mjs`:

```js
export function resolveCapabilities({ specialistId, assignments, installed }) {
  const byKey = new Map(installed.map((item) =>
    [`${item.package}:${item.checksum}`, item]));
  const selected = [];
  const exclusions = [];
  for (const row of assignments) {
    const targeted = row.targets.includes("all") ||
      row.targets.includes(specialistId);
    if (!targeted) continue;
    if (row.exclude.includes(specialistId)) {
      exclusions.push({ package: row.package, reason: `exclude:${specialistId}` });
      continue;
    }
    const found = byKey.get(`${row.package}:${row.checksum}`);
    if (!found) {
      throw new Error(`CAPABILITY_MISSING: ${row.package} ${row.checksum}`);
    }
    selected.push({
      ...found,
      reason: row.targets.includes(specialistId)
        ? `target:${specialistId}` : "target:all",
    });
  }
  const versions = new Map();
  for (const item of selected) {
    const prior = versions.get(item.id);
    if (prior && (prior.version !== item.version ||
        prior.checksum !== item.checksum)) {
      throw new Error(`CAPABILITY_VERSION_CONFLICT: ${prior.package}, ${item.package}`);
    }
    versions.set(item.id, item);
  }
  return {
    packages: [...versions.values()].sort((a, b) => a.id.localeCompare(b.id)),
    exclusions,
  };
}
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
node --test test/capabilities/assignments.test.mjs test/capabilities/resolve.test.mjs
npm test
git add src/capabilities/assignments.mjs src/capabilities/resolve.mjs \
  test/capabilities/assignments.test.mjs test/capabilities/resolve.test.mjs
git commit -m "feat: resolve capability assignments"
```

Expected: all tests PASS and one commit is created.

### Task 4: Deterministic CLI and Supervisor Operator Skill

**Files:**

- Create: `src/capabilities/cli.mjs`
- Create: `skills/team-up-manage/SKILL.md`
- Modify: `src/cli.mjs`
- Modify: `package.json`
- Test: `test/capabilities/cli.test.mjs`

- [ ] **Step 1: Use the skill-writing workflow**

Invoke `superpowers:writing-skills` before editing `SKILL.md`. Its validation
steps apply in addition to the tests below. The skill is intentionally stored
only in the main repository; no capsule code may reference it.

- [ ] **Step 2: Write failing noninteractive CLI tests**

```js
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
```

- [ ] **Step 3: Run and verify RED**

Run:

```bash
node --test test/capabilities/cli.test.mjs
```

Expected: FAIL because `capability` is not routed.

- [ ] **Step 4: Add the capability facade**

Create `src/capabilities/cli.mjs` with `install`, `inspect`, `list`, `enable`,
and `disable`; return JSON for every successful command:

```js
import { importLocalCapability, inspectInstalledCapability,
  listInstalledCapabilities } from "./store.mjs";
import { enableCapability, disableCapability, loadAssignments }
  from "./assignments.mjs";

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export async function runCapabilityCli(args, io, { env = process.env } = {}) {
  const [sub, subject, ...rest] = args;
  if (sub === "install") {
    if (!subject) return usage(io);
    io.out(JSON.stringify(importLocalCapability(subject, { env }), null, 2));
    return 0;
  }
  if (sub === "inspect") {
    if (!subject) return usage(io);
    const inspected = fs.existsSync(subject)
      ? inspectCapabilitySource(subject)
      : inspectInstalledCapability(subject, {
          checksum: value(rest, "--checksum"), env,
        });
    io.out(JSON.stringify(inspected, null, 2));
    return 0;
  }
  if (sub === "list") {
    io.out(JSON.stringify({
      packages: listInstalledCapabilities({ env }),
      assignments: loadAssignments({ env }).assignments,
    }, null, 2));
    return 0;
  }
  if (sub === "enable" || sub === "disable") {
    const target = value(rest, "--for");
    const checksum = value(rest, "--checksum");
    if (!subject || !target || !checksum) return usage(io);
    const fn = sub === "enable" ? enableCapability : disableCapability;
    io.out(JSON.stringify(fn({ package: subject, checksum, target, env }), null, 2));
    return 0;
  }
  return usage(io);
}

function usage(io) {
  io.err("usage: team-up capability <install|inspect|list|enable|disable>");
  return 1;
}
```

Import `fs` and `inspectCapabilitySource`; the latter reads and validates a
source but never calls the importer. Its JSON output contains source,
resolved manifest, checksum preview, all provided types, context estimate,
permissions, and warnings.

Import and route `runCapabilityCli` in `src/cli.mjs`:

```js
if (cmd === "capability") return runCapabilityCli(rest, io);
```

- [ ] **Step 5: Create the compact opt-in operator skill**

Create `skills/team-up-manage/SKILL.md` with this exact behavioral core:

```markdown
---
name: team-up-manage
description: Human-only management of team-up skills, plugins, MCPs, frameworks, bundles, assignments, updates, rollback, removal, and scans.
---

# Team-up Manage

Use only in the human-facing supervisor session. Never delegate these state
mutations to a specialist worker.

1. Run `team-up capability inspect SOURCE` before installation.
2. Show source revision, checksum, provided types, context estimate,
   permissions, every installed specialist, and `all`.
3. Present an opt-in list with nothing preselected.
4. After explicit human selection, run install, then enable separately with
   `--for TARGET` and the exact `--checksum`.
5. Treat recommendations as display-only suggestions.
6. For disable, update, rollback, remove, or scan, show the exact proposed
   state change and obtain explicit human confirmation before mutation.

Never invent a target, activate during install, convert `all` into current
specialist IDs, or bypass a conflict/removal refusal.
```

Add `"files": ["bin", "src", "skills", "README.md", "LICENSE"]` to
`package.json`.

- [ ] **Step 6: Validate, test, and commit**

Run the validation command required by `superpowers:writing-skills`, then:

```bash
node --test test/capabilities/cli.test.mjs
npm pack --dry-run
npm test
git add src/capabilities/cli.mjs src/cli.mjs skills/team-up-manage/SKILL.md \
  package.json test/capabilities/cli.test.mjs
git commit -m "feat: add capability management interface"
```

Expected: tests PASS; dry-run package contains
`skills/team-up-manage/SKILL.md`.

### Task 5: Immutable Git Imports

**Files:**

- Create: `src/capabilities/git-source.mjs`
- Modify: `src/capabilities/cli.mjs`
- Modify: `src/capabilities/store.mjs`
- Test: `test/capabilities/git-source.test.mjs`

- [ ] **Step 1: Write failing local-Git tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { importGitCapability } from "../../src/capabilities/git-source.mjs";

test("branch resolves to exact commit and matches local content checksum", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tu-git-"));
  fs.mkdirSync(path.join(repo, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skills", "x", "SKILL.md"), "# X\n");
  fs.writeFileSync(path.join(repo, "capability.json"), JSON.stringify({
    schema_version: 1, id: "x", version: "1", display_name: "X",
    provides: { skills: ["skills/x/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c",
    "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: repo });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo, encoding: "utf8",
  }).trim();
  const record = importGitCapability({ url: repo, ref: "main" }, {
    env: { TEAM_UP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tu-home-")) },
  });
  assert.equal(record.source.commit, commit);
  assert.equal(record.source.ref, "main");
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/capabilities/git-source.test.mjs
```

Expected: FAIL with missing `git-source.mjs`.

- [ ] **Step 3: Implement exact-revision checkout without scripts**

Create `src/capabilities/git-source.mjs`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { importLocalCapability } from "./store.mjs";

export function importGitCapability({ url, ref = "HEAD" }, {
  env = process.env, exec = execFileSync,
} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-git-"));
  const repo = path.join(temp, "repo");
  try {
    exec("git", ["clone", "--no-checkout", "--filter=blob:none", "--", url, repo],
      { stdio: "pipe" });
    exec("git", ["checkout", "--detach", ref], { cwd: repo, stdio: "pipe" });
    const commit = String(exec("git", ["rev-parse", "HEAD"], {
      cwd: repo, encoding: "utf8",
    })).trim();
    return importLocalCapability(repo, {
      env,
      sourceMetadata: { type: "git", url, ref, commit },
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
```

Add `--git-ref REF` to `capability install`; URLs with that flag call
`importGitCapability`, while local paths continue through
`importLocalCapability`. Do not run package-manager commands or any checked-in
script.

- [ ] **Step 4: Verify identical checksums and cleanup**

Add assertions that a local import and Git import of the fixture have the same
checksum, and that a bad ref leaves no index entry. Then run:

```bash
node --test test/capabilities/git-source.test.mjs test/capabilities/store.test.mjs
npm test
```

Expected: PASS, with no surviving `team-up-git-*` directory created by the
test.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/git-source.mjs src/capabilities/cli.mjs \
  src/capabilities/store.mjs test/capabilities/git-source.test.mjs
git commit -m "feat: import pinned Git capabilities"
```

### Task 6: Inert Specialist Recommendations

**Files:**

- Create: `src/capabilities/recommendations.mjs`
- Modify: `src/specialists/manifest.mjs`
- Modify: `src/specialists/store.mjs`
- Modify: `src/capabilities/cli.mjs`
- Test: `test/capabilities/recommendations.test.mjs`
- Modify: `test/specialists/manifest.test.mjs`

- [ ] **Step 1: Write failing recommendation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecommendations }
  from "../../src/capabilities/recommendations.mjs";

test("recommendations normalize as inert display metadata", () => {
  assert.deepEqual(normalizeRecommendations([{
    package: "o9k.caveman",
    source: "https://github.com/example/caveman.git",
    reason: "Reduces routine output",
    suggested_target: "research.hugo",
  }]), [{
    package: "o9k.caveman",
    source: "https://github.com/example/caveman.git",
    reason: "Reduces routine output",
    suggested_target: "research.hugo",
    selected: false,
  }]);
});

test("recommendations reject embedded credentials and concrete models", () => {
  assert.throws(() => normalizeRecommendations([{
    package: "x", source: "https://user:secret@example.invalid/x",
    reason: "x", model: "fixed",
  }]), /credentials|forbidden/);
});
```

Extend `test/specialists/manifest.test.mjs` to assert a valid
`recommendations` array passes without changing package checksum assignment
state, and an invalid `suggested_target: "all/../../x"` fails.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/capabilities/recommendations.test.mjs \
  test/specialists/manifest.test.mjs
```

Expected: FAIL because recommendation validation does not exist.

- [ ] **Step 3: Implement recommendation normalization**

Create `src/capabilities/recommendations.mjs`:

```js
import { assertSafeSpecialistSegment } from "../specialists/safe-id.mjs";

export function normalizeRecommendations(input = []) {
  if (!Array.isArray(input)) throw new Error("recommendations must be an array");
  return input.map((item) => {
    for (const key of ["model", "provider", "install", "scripts"]) {
      if (item[key] != null) throw new Error(`forbidden recommendation key: ${key}`);
    }
    if (!item.package || !item.source || !item.reason) {
      throw new Error("recommendation requires package, source, and reason");
    }
    const parsed = new URL(item.source, "file:///");
    if (parsed.username || parsed.password) {
      throw new Error("recommendation source must not contain credentials");
    }
    if (item.suggested_target) {
      assertSafeSpecialistSegment(item.suggested_target, "suggested_target");
    }
    return { ...item, selected: false };
  });
}
```

Call it from `validateManifest` and add recommendation source metadata to
specialist inspection output. Add
`team-up capability recommendations <specialist-id>` which prints only the
normalized list and never writes pool or assignment state.

- [ ] **Step 4: Prove recommendations stay inactive**

Add a CLI test comparing `capability list` before and after
`capability recommendations`; both `packages` and `assignments` must be
byte-equivalent. Run:

```bash
node --test test/capabilities/recommendations.test.mjs \
  test/capabilities/cli.test.mjs test/specialists/manifest.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/recommendations.mjs src/capabilities/cli.mjs \
  src/specialists/manifest.mjs src/specialists/store.mjs \
  test/capabilities/recommendations.test.mjs \
  test/capabilities/cli.test.mjs test/specialists/manifest.test.mjs
git commit -m "feat: expose inert capability recommendations"
```

### Task 7: Minimal Run Capsule Materialization

**Files:**

- Create: `src/capabilities/capsule.mjs`
- Test: `test/capabilities/capsule.test.mjs`

- [ ] **Step 1: Write failing capsule isolation test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeCapabilityCapsule }
  from "../../src/capabilities/capsule.mjs";

test("capsule contains selected declared files and exact audit record", () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-pkg-"));
  fs.mkdirSync(path.join(packageDir, "skills", "selected"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "skills", "hidden"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "skills", "selected", "SKILL.md"), "# Yes\n");
  fs.writeFileSync(path.join(packageDir, "skills", "hidden", "SKILL.md"), "# No\n");
  fs.writeFileSync(path.join(packageDir, "capability.json"), JSON.stringify({
    schema_version: 1, id: "selected", version: "1", display_name: "Selected",
    provides: { skills: ["skills/selected/SKILL.md"] },
    permissions: { network: false, commands: [] },
  }));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tu-run-"));
  const result = materializeCapabilityCapsule({
    runRoot,
    specialistId: "research.hugo",
    packages: [{
      package: "selected@1", id: "selected", version: "1",
      checksum: "sha256:a", packageDir, reason: "target:research.hugo",
    }],
    exclusions: [{ package: "hidden@1", reason: "exclude:research.hugo" }],
  });
  assert.equal(fs.existsSync(path.join(
    runRoot, "context", "skills", "selected", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(
    runRoot, "context", "skills", "hidden", "SKILL.md")), false);
  assert.equal(result.schema_version, 1);
  assert.deepEqual(result.packages[0].resolved.skills,
    ["context/skills/selected/SKILL.md"]);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/capabilities/capsule.test.mjs
```

Expected: FAIL with missing capsule module.

- [ ] **Step 3: Implement typed materialization**

Create `src/capabilities/capsule.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../json-store.mjs";
import { normalizeCapabilityManifest } from "./manifest.mjs";

const DESTINATIONS = {
  skills: ["context", "skills"],
  frameworks: ["context", "framework"],
  plugins: ["harness", "plugins"],
  mcps: ["harness", "mcp"],
};

export function materializeCapabilityCapsule({
  runRoot, specialistId, packages, exclusions = [],
}) {
  const records = [];
  try {
    for (const item of packages) {
    const manifest = normalizeCapabilityManifest(JSON.parse(fs.readFileSync(
      path.join(item.packageDir, "capability.json"), "utf8"
    )), { packageDir: item.packageDir });
    const resolved = { skills: [], plugins: [], mcps: [], frameworks: [] };
    for (const [type, entries] of Object.entries(manifest.provides)) {
      for (const rel of entries) {
        const prefix = `${type}/`;
        const typedRel = rel.startsWith(prefix)
          ? rel.slice(prefix.length)
          : path.join(item.id, rel);
        const destination = path.join(runRoot, ...DESTINATIONS[type], typedRel);
        if (fs.existsSync(destination)) {
          throw new Error(`CAPSULE_PATH_COLLISION: ${path.relative(runRoot, destination)}`);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const source = path.join(item.packageDir, rel);
        const stat = fs.lstatSync(source);
        if (stat.isDirectory()) {
          fs.cpSync(source, destination, {
            recursive: true,
            dereference: false,
            errorOnExist: true,
          });
        } else {
          fs.copyFileSync(source, destination);
        }
        resolved[type].push(path.relative(runRoot, destination));
      }
    }
      records.push({
        package: item.package, id: item.id, version: item.version,
        checksum: item.checksum, reason: item.reason, resolved,
        estimated_description_tokens: item.estimated_description_tokens ?? 0,
        mcp_tool_count: item.mcp_tool_count ?? 0,
      });
    }
  } catch (error) {
    fs.rmSync(path.join(runRoot, "context"), { recursive: true, force: true });
    fs.rmSync(path.join(runRoot, "harness"), { recursive: true, force: true });
    throw error;
  }
  const record = {
    schema_version: 1,
    specialist_id: specialistId,
    packages: records,
    exclusions,
    totals: {
      estimated_description_tokens: records.reduce(
        (sum, item) => sum + item.estimated_description_tokens, 0),
      mcp_tool_count: records.reduce((sum, item) => sum + item.mcp_tool_count, 0),
    },
  };
  atomicWriteJson(path.join(runRoot, "EFFECTIVE_CAPABILITIES.json"), record);
  return record;
}

export function buildStrictMcpConfig(effective, runRoot) {
  const mcpServers = {};
  for (const item of effective.packages) {
    for (const rel of item.resolved.mcps) {
      const document = JSON.parse(fs.readFileSync(path.join(runRoot, rel), "utf8"));
      for (const [name, server] of Object.entries(document.mcpServers ?? {})) {
        if (mcpServers[name]) {
          throw new Error(`MCP_NAME_COLLISION: ${name}`);
        }
        mcpServers[name] = server;
      }
    }
  }
  return { mcpServers };
}
```

- [ ] **Step 4: Test bundle expansion, cleanup, and context invariance**

Add tests with a package providing all four types and a collision fixture.
Record total skill bytes and MCP schema bytes before and after adding an
unselected pool package; both must stay equal. Run:

```bash
node --test test/capabilities/capsule.test.mjs
npm test
```

Expected: all tests PASS and failed construction leaves no `context` or
`harness` subtree.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/capsule.mjs test/capabilities/capsule.test.mjs
git commit -m "feat: materialize minimal capability capsules"
```

### Task 8: Versioned Harness Isolation Contract and Claude Adapter

**Files:**

- Modify: `src/harness/capabilities.mjs`
- Modify: `src/harness/registry.mjs`
- Modify: `src/harness/claude.mjs`
- Modify: `test/harness/registry.test.mjs`
- Modify: `test/harness/claude.test.mjs`

- [ ] **Step 1: Write failing contract tests**

Add to `test/harness/registry.test.mjs`:

```js
import { CONTEXT_ISOLATION_CAPABILITY }
  from "../../src/harness/capabilities.mjs";

test("unverified harness never advertises context isolation", () => {
  assert.equal(defaultHarnessCapabilities("claude", {
    verification: null,
  }).context_isolation, null);
});

test("verified Claude advertises the versioned contract", () => {
  assert.equal(defaultHarnessCapabilities("claude", {
    verification: { status: "verified" },
  }).context_isolation, CONTEXT_ISOLATION_CAPABILITY);
});
```

Add to `test/harness/claude.test.mjs`:

```js
test("capsule launch uses bare mode and only explicit plugin and MCP paths", () => {
  const writes = new Map();
  const prepared = claudeAdapter.prepareLaunch({
    argv: ["claude", "-p", "work"],
    runDir: "/run",
    capsule: {
      pluginDirs: ["/run/harness/plugins/x"],
      mcpConfig: { mcpServers: { selected: {
        type: "stdio", command: "node", args: ["/run/harness/mcp/x/server.mjs"],
      } } },
      codexHome: "/run/harness/home",
    },
    writeFileSync: (file, text) => writes.set(file, text),
    mkdirSync: () => {},
    chmodSync: () => {},
  });
  assert.equal(prepared.argv.includes("--bare"), true);
  assert.deepEqual(prepared.argv.slice(
    prepared.argv.indexOf("--plugin-dir"),
    prepared.argv.indexOf("--plugin-dir") + 2
  ), ["--plugin-dir", "/run/harness/plugins/x"]);
  assert.equal(prepared.argv.includes("--strict-mcp-config"), true);
  assert.match(writes.get("/run/harness/claude-mcp.json"), /"selected"/);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/harness/registry.test.mjs test/harness/claude.test.mjs
```

Expected: FAIL because context isolation and capsule input are absent.

- [ ] **Step 3: Add the fail-closed capability**

In `src/harness/capabilities.mjs`:

```js
export const CONTEXT_ISOLATION_CAPABILITY =
  "team-up.context-isolation/v1";

export const UNVERIFIED_CAPABILITIES = Object.freeze({
  command_broker: null,
  context_isolation: null,
  native_shell: "unverified",
  mcp: "unverified",
});

export const CLAUDE_DECLARED_CAPABILITIES = Object.freeze({
  command_broker: COMMAND_BROKER_CAPABILITY,
  context_isolation: CONTEXT_ISOLATION_CAPABILITY,
  native_shell: "denied",
  mcp: "stdio",
});
```

In `prepareHarnessLaunch`, accept `capsule`; if present and
`caps.context_isolation !== CONTEXT_ISOLATION_CAPABILITY`, throw an error with
code `HARNESS_CONTEXT_ISOLATION_UNVERIFIED`. Pass `capsule` to the adapter.

- [ ] **Step 4: Make Claude launch only from the capsule**

Extend `claudeAdapter.prepareLaunch` with `capsule = null`. When capsule is
present, add `--bare`, one `--plugin-dir DIR` per selected directory, write
the strict MCP file from `capsule.mcpConfig`, and keep the command broker
server only when `broker` is non-null:

```js
const mcpServers = {
  ...(capsule?.mcpConfig?.mcpServers ?? {}),
  ...(broker ? { team_up_command_broker: {
    type: "stdio",
    command: nodePath,
    args: [brokerBin],
    env: {
      TEAM_UP_COMMAND_POLICY_SNAPSHOT: broker.policySnapshot,
      TEAM_UP_COMMAND_POLICY_CHECKSUM: broker.policyChecksum,
      TEAM_UP_PROJECT: broker.project,
      TEAM_UP_RUN_DIR: broker.runDir,
    },
  } } : {}),
};
if (capsule && !next.includes("--bare")) next.push("--bare");
for (const pluginDir of capsule?.pluginDirs ?? []) {
  next.push("--plugin-dir", pluginDir);
}
next.push("--strict-mcp-config", "--mcp-config", mcpPath);
```

Build `--tools`, `--allowedTools`, and `--disallowedTools` exactly from
selected MCP tool names, broker tools, and approved built-ins. Never include
global MCP names.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test test/harness/registry.test.mjs test/harness/claude.test.mjs
npm test
git add src/harness/capabilities.mjs src/harness/registry.mjs \
  src/harness/claude.mjs test/harness/registry.test.mjs \
  test/harness/claude.test.mjs
git commit -m "feat: enforce harness context isolation contract"
```

Expected: all tests PASS.

### Task 9: Resolve and Materialize Before Worker Creation

**Files:**

- Modify: `src/specialists/launcher.mjs`
- Modify: `test/specialists/launcher.test.mjs`
- Test: `test/integration/capability-isolation.test.mjs`

- [ ] **Step 1: Write a failing launch-order test**

Add dependency injection to the launch test harness, then assert:

```js
test("capsule failure prevents worker creation and requires isolation", async () => {
  const events = [];
  await assert.rejects(() => launch(fixtureLaunch({
    dependencyOverrides: {
      resolveEffectiveCapabilities: () => {
        events.push("resolve");
        return { packages: [], exclusions: [] };
      },
      materializeCapabilityCapsule: () => {
        events.push("capsule");
        throw Object.assign(new Error("broken capsule"), {
          code: "CAPSULE_BUILD_FAILED",
        });
      },
      createRun: () => {
        events.push("run-record");
        return { runId: "fixture-run" };
      },
      startFromLaunchDescriptor: () => events.push("worker"),
    },
  })), /broken capsule/);
  assert.deepEqual(events, ["resolve", "run-record", "capsule"]);
});
```

Add a profile test where the top chain cell is verified for command broker
but not context isolation; resolution must skip it before any worker process
or TMUX session is created.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/specialists/launcher.test.mjs
```

Expected: FAIL because launch does not resolve capability assignments.

- [ ] **Step 3: Wire the effective-set pipeline**

In `src/specialists/launcher.mjs`, load and resolve before `createRun`:

```js
const capabilityResolution = resolveCapabilities({
  specialistId,
  assignments: loadAssignments({ env }).assignments,
  installed: listInstalledCapabilities({ env }),
});
const requirements = {
  context_isolation: CONTEXT_ISOLATION_CAPABILITY,
  ...((manifest.permissions?.commands || []).length > 0
    ? { command_broker: "team-up.command-broker/v1" } : {}),
};
```

Create the run registry entry only after profile resolution succeeds. Build
intrinsic context with the existing `materialize`, then build the capsule and
derive harness input:

```js
const effective = materializeCapabilityCapsule({
  runRoot: runDir(state.runId),
  specialistId,
  packages: capabilityResolution.packages,
  exclusions: capabilityResolution.exclusions,
});
const capsule = {
  pluginDirs: effective.packages.flatMap((item) =>
    item.resolved.plugins.map((rel) => path.join(runDir(state.runId), rel))),
  mcpConfig: buildStrictMcpConfig(effective, runDir(state.runId)),
  skillDirs: [path.join(runDir(state.runId), "context", "skills")],
  frameworkDirs: [path.join(runDir(state.runId), "context", "framework")],
  codexHome: path.join(runDir(state.runId), "harness", "home"),
  effective,
};
```

Pass `capsule` into `prepareHarnessLaunch`. Write only a short prompt line
pointing at `context/specialist` and selected skill/framework directories;
never paste pool inventory or `EFFECTIVE_CAPABILITIES.json` into the prompt.
If capsule construction fails after the run registry record exists, mark the
run failed and prove `startFromLaunchDescriptor` was never called.

- [ ] **Step 4: Add two-specialist isolation integration coverage**

In `test/integration/capability-isolation.test.mjs`, install three fixtures:
shared, Hannes-only, and Hugo-only. Assign shared to `all`, exclude Hugo, and
assign Hugo-only to Hugo. Materialize both capsules and assert:

```js
assert.deepEqual(hannes.packages.map((x) => x.id),
  ["example.hannes", "example.shared"]);
assert.deepEqual(hugo.packages.map((x) => x.id), ["example.hugo"]);
assert.equal(JSON.stringify(hannes).includes("example.hugo"), false);
assert.equal(JSON.stringify(hugo).includes("example.hannes"), false);
```

Also assert that adding an inert pool package changes neither specialist's
prompt bytes nor MCP schema bytes.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test test/specialists/launcher.test.mjs \
  test/integration/capability-isolation.test.mjs
npm test
git add src/specialists/launcher.mjs test/specialists/launcher.test.mjs \
  test/integration/capability-isolation.test.mjs
git commit -m "feat: launch specialists from isolated capsules"
```

Expected: PASS; failure fixtures create no worker process.

### Task 10: Update, Rollback, and Reference-Safe Removal

**Files:**

- Create: `src/capabilities/lifecycle.mjs`
- Modify: `src/capabilities/cli.mjs`
- Test: `test/capabilities/lifecycle.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  planCapabilityUpdate,
  rollbackCapability,
  removeCapability,
} from "../../src/capabilities/lifecycle.mjs";

test("update installs beside old checksum and does not mutate assignment", () => {
  const plan = planCapabilityUpdate({
    current: { package: "x@1", checksum: "sha256:a" },
    candidate: { package: "x@2", checksum: "sha256:b" },
    assignments: [{ package: "x@1", checksum: "sha256:a",
      targets: ["all"], exclude: [] }],
  });
  assert.equal(plan.activate, false);
  assert.equal(plan.assignmentChanges.length, 0);
});

test("removal refuses assignment and active-run references", () => {
  const target = { package: "x@1", checksum: "sha256:a",
    packageDir: "/pool/x" };
  assert.throws(() => removeCapability(target, {
    assignments: [{ package: "x@1", checksum: "sha256:a",
      targets: ["all"], exclude: [] }],
    activeRuns: [],
  }), /CAPABILITY_REFERENCED.*assignment/);
  assert.throws(() => removeCapability(target, {
    assignments: [],
    activeRuns: [{ runId: "r1", capabilities: [{
      package: "x@1", checksum: "sha256:a",
    }] }],
  }), /CAPABILITY_REFERENCED.*r1/);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/capabilities/lifecycle.test.mjs
```

Expected: FAIL with missing lifecycle module.

- [ ] **Step 3: Implement pure plans plus atomic mutations**

Create `src/capabilities/lifecycle.mjs`:

```js
export function planCapabilityUpdate({ current, candidate, assignments }) {
  if (current.package === candidate.package &&
      current.checksum === candidate.checksum) {
    throw new Error("CAPABILITY_UPDATE_UNCHANGED");
  }
  return {
    from: current, to: candidate, activate: false,
    assignmentChanges: [],
    pinnedAssignments: assignments.filter((row) =>
      row.package === current.package && row.checksum === current.checksum),
  };
}

export function rollbackCapability({
  current, prior, assignments, writeAssignments,
}) {
  if (!prior?.checksum) throw new Error("ROLLBACK_TARGET_NOT_INSTALLED");
  const next = structuredClone(assignments);
  for (const row of next) {
    if (row.package === current.package && row.checksum === current.checksum) {
      row.package = prior.package;
      row.checksum = prior.checksum;
    }
  }
  writeAssignments({ schema_version: 1, assignments: next });
  return { from: current, to: prior };
}

export function removeCapability(target, {
  assignments, activeRuns, removeFiles = () => {},
}) {
  const assignment = assignments.find((row) =>
    row.package === target.package && row.checksum === target.checksum);
  if (assignment) throw new Error("CAPABILITY_REFERENCED: assignment");
  const run = activeRuns.find((item) => item.capabilities?.some((cap) =>
    cap.package === target.package && cap.checksum === target.checksum));
  if (run) throw new Error(`CAPABILITY_REFERENCED: active run ${run.runId}`);
  removeFiles(target);
  return { removed: target.package, checksum: target.checksum };
}
```

The CLI commands must:

- `update ID --git-ref REF`: import the new immutable entry and print the
  non-activating plan;
- `rollback ID --to VERSION --checksum SHA`: atomically replace only matching
  assignment selectors;
- `remove ID@VERSION --checksum SHA`: read active run
  `EFFECTIVE_CAPABILITIES.json` records, refuse references, then remove the
  exact digest directory and its exact index row.

No lifecycle command may rewrite historical run files.

- [ ] **Step 4: Verify mutation safety**

Add filesystem tests proving failed rollback and removal leave assignment and
index JSON byte-identical, and successful removal preserves sibling versions.
Run:

```bash
node --test test/capabilities/lifecycle.test.mjs \
  test/capabilities/cli.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/lifecycle.mjs src/capabilities/cli.mjs \
  test/capabilities/lifecycle.test.mjs test/capabilities/cli.test.mjs
git commit -m "feat: manage immutable capability lifecycle"
```

### Task 11: Read-Only Existing-Installation Scan

**Files:**

- Create: `src/capabilities/scan.mjs`
- Modify: `src/capabilities/cli.mjs`
- Test: `test/capabilities/scan.test.mjs`

- [ ] **Step 1: Write failing scan tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCapabilityRoots } from "../../src/capabilities/scan.mjs";

test("scan reports candidates without importing or changing sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-scan-"));
  const skill = path.join(root, "skills", "caveman");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# Caveman\n");
  const before = fs.readFileSync(path.join(skill, "SKILL.md"));
  const result = scanCapabilityRoots([root]);
  assert.deepEqual(result.map((item) => item.type), ["skill"]);
  assert.equal(result[0].path, skill);
  assert.deepEqual(fs.readFileSync(path.join(skill, "SKILL.md")), before);
  assert.equal(fs.existsSync(path.join(root, "capability-pool")), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/capabilities/scan.test.mjs
```

Expected: FAIL with missing scan module.

- [ ] **Step 3: Implement bounded layout detection**

Create `src/capabilities/scan.mjs`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKERS = [
  ["SKILL.md", "skill"],
  [".codex-plugin/plugin.json", "plugin"],
  ["mcp.json", "mcp"],
  ["framework.json", "framework"],
  ["capability.json", "bundle"],
];

export function scanCapabilityRoots(roots) {
  const results = [];
  for (const configured of roots) {
    if (!fs.existsSync(configured)) continue;
    const root = fs.realpathSync(configured);
    for (const parent of [root, ...fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name))]) {
      const matches = MARKERS.filter(([marker]) =>
        fs.existsSync(path.join(parent, marker)));
      if (matches.length === 1) {
        results.push({ type: matches[0][1], path: parent, marker: matches[0][0] });
      } else if (matches.length > 1) {
        results.push({
          type: "ambiguous",
          path: parent,
          markers: matches.map(([marker, type]) => ({ marker, type })),
        });
      }
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeDetectedCandidate(candidate, {
  id, version, displayName, selectedType,
}) {
  const type = selectedType ?? candidate.type;
  if (type === "ambiguous") throw new Error("CAPABILITY_TYPE_REQUIRED");
  if (!id || !version || !displayName) {
    throw new Error("detected import requires id, version, and display name");
  }
  const marker = {
    skill: "SKILL.md",
    plugin: ".codex-plugin/plugin.json",
    mcp: "mcp.json",
    framework: "framework.json",
    bundle: "capability.json",
  }[type];
  if (!marker) throw new Error(`unsupported detected capability type: ${type}`);
  return {
    schema_version: 1,
    id,
    version,
    display_name: displayName,
    provides: {
      skills: type === "skill" ? [marker] : [],
      plugins: type === "plugin" ? [marker] : [],
      mcps: type === "mcp" ? [marker] : [],
      frameworks: type === "framework" ? [marker] : [],
    },
    permissions: { network: false, commands: [], filesystem: "none" },
  };
}
```

`team-up capability scan` uses explicit repeated `--root PATH` flags when
provided; otherwise it scans existing known roots below `~/.claude`,
`~/.codex`, and `~/.agents`. It returns candidates only. Ambiguous candidates
contain `type: "ambiguous"` and all matching markers; install refuses them
until a human supplies `--type`.

Extend `importLocalCapability` with an optional `manifestOverride`. For a
detected source without `capability.json`,
`team-up capability install PATH --type skill --id ID --version VERSION
--display-name NAME` calls `normalizeDetectedCandidate`, passes the returned
manifest as that override, copies into staging, and never writes the source
directory. Add a test that imports a bare `SKILL.md` this way and confirms the
source still contains exactly one file.

- [ ] **Step 4: Prove scan is read-only and commit**

Run:

```bash
node --test test/capabilities/scan.test.mjs test/capabilities/cli.test.mjs
npm test
git add src/capabilities/scan.mjs src/capabilities/cli.mjs \
  test/capabilities/scan.test.mjs test/capabilities/cli.test.mjs
git commit -m "feat: scan local capability installations"
```

Expected: PASS; source mtimes and bytes remain unchanged.

### Task 12: Run-Specific Codex Home Adapter

**Files:**

- Create: `src/harness/codex.mjs`
- Modify: `src/harness/registry.mjs`
- Modify: `src/harness/capabilities.mjs`
- Test: `test/harness/codex.test.mjs`
- Modify: `test/harness/registry.test.mjs`

- [ ] **Step 1: Write failing Codex isolation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAdapter } from "../../src/harness/codex.mjs";

test("Codex receives a minimal run-specific home and separate auth bridge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-codex-"));
  const sourceHome = path.join(root, "global");
  const capsuleHome = path.join(root, "run", "harness", "home");
  fs.mkdirSync(path.join(sourceHome, "skills", "global"), { recursive: true });
  fs.writeFileSync(path.join(sourceHome, "skills", "global", "SKILL.md"), "# Global\n");
  fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"token\":\"fixture\"}\n");
  const prepared = codexAdapter.prepareLaunch({
    argv: ["codex", "exec", "work"],
    runDir: path.join(root, "run"),
    capsule: {
      codexHome: capsuleHome,
      skillDirs: [path.join(root, "run", "context", "skills")],
      mcpConfig: { mcpServers: {} },
    },
    authSource: path.join(sourceHome, "auth.json"),
  });
  assert.equal(prepared.env.CODEX_HOME, capsuleHome);
  assert.equal(fs.existsSync(path.join(capsuleHome, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(capsuleHome, "skills", "global")), false);
  assert.equal(prepared.argv.includes("--strict-config"), true);
  assert.equal(fs.readFileSync(path.join(capsuleHome, "config.toml"), "utf8")
    .includes(sourceHome), false);
});

test("Codex adapter rejects launch without capsule", () => {
  assert.throws(() => codexAdapter.prepareLaunch({
    argv: ["codex", "exec", "work"], runDir: "/run", capsule: null,
  }), /CODEX_CAPSULE_REQUIRED/);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/harness/codex.test.mjs test/harness/registry.test.mjs
```

Expected: FAIL because Codex still uses the unsupported adapter.

- [ ] **Step 3: Implement the minimal-home adapter**

Create `src/harness/codex.mjs`:

```js
import fs from "node:fs";
import path from "node:path";

export const codexAdapter = {
  id: "codex",
  capabilities: {
    command_broker: null,
    context_isolation: "team-up.context-isolation/v1",
    native_shell: "unverified",
    mcp: "stdio",
  },

  version({ execFileSync }) {
    const text = String(execFileSync("codex", ["--version"], {
      encoding: "utf8", timeout: 10_000,
    })).trim();
    return text.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? text;
  },

  prepareLaunch({
    argv, capsule, authSource = path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
      "auth.json"
    ),
  }) {
    if (!capsule?.codexHome) throw new Error("CODEX_CAPSULE_REQUIRED");
    fs.mkdirSync(capsule.codexHome, { recursive: true });
    fs.mkdirSync(path.join(capsule.codexHome, "skills"), { recursive: true });
    for (const source of capsule.skillDirs ?? []) {
      if (!fs.existsSync(source)) continue;
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        fs.cpSync(path.join(source, entry.name),
          path.join(capsule.codexHome, "skills", entry.name),
          { recursive: true, errorOnExist: true });
      }
    }
    const quote = (value) => JSON.stringify(String(value));
    const lines = [];
    for (const [name, server] of Object.entries(
      capsule.mcpConfig?.mcpServers ?? {}
    ).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`invalid Codex MCP name: ${name}`);
      }
      lines.push(`[mcp_servers.${name}]`);
      lines.push(`command = ${quote(server.command)}`);
      lines.push(`args = [${(server.args ?? []).map(quote).join(", ")}]`);
      if (server.env && Object.keys(server.env).length > 0) {
        const env = Object.entries(server.env).sort(([a], [b]) =>
          a.localeCompare(b)).map(([key, value]) =>
          `${quote(key)} = ${quote(value)}`).join(", ");
        lines.push(`env = { ${env} }`);
      }
      lines.push("");
    }
    const config = `${lines.join("\n")}\n`;
    fs.writeFileSync(path.join(capsule.codexHome, "config.toml"), config);
    if (authSource && fs.existsSync(authSource)) {
      fs.copyFileSync(authSource, path.join(capsule.codexHome, "auth.json"));
      fs.chmodSync(path.join(capsule.codexHome, "auth.json"), 0o600);
    }
    const next = argv.includes("--strict-config")
      ? [...argv] : [...argv, "--strict-config"];
    return {
      argv: next,
      env: { CODEX_HOME: capsule.codexHome },
      files: [
        path.join(capsule.codexHome, "config.toml"),
        ...(fs.existsSync(path.join(capsule.codexHome, "auth.json"))
          ? [path.join(capsule.codexHome, "auth.json")] : []),
      ],
    };
  },
};
```

Replace `codex: unsupportedAdapter("codex")` with `codex: codexAdapter` in the
registry. Generate exact `[mcp_servers.NAME]` TOML blocks from
`capsule.mcpConfig.mcpServers`, rejecting names outside
`^[A-Za-z0-9_-]+$`; do not copy the global `config.toml`, skills, plugins,
rules, hooks, or memory. If authentication is absent, preparation succeeds
but the live verifier cannot mark the executable version verified.

- [ ] **Step 4: Add version-gated registry coverage**

Extend `test/harness/registry.test.mjs`:

```js
test("Codex isolation is eligible only with a matching verification record", () => {
  assert.equal(harnessCapabilities("codex", {
    verification: null,
  }).context_isolation, null);
  assert.equal(harnessCapabilities("codex", {
    verification: { status: "verified", version: "0.145.0" },
  }).context_isolation, "team-up.context-isolation/v1");
});
```

Also test that Cursor, Hermes, and OpenCode remain ineligible through
`unsupportedAdapter` until each has its own live verified implementation.
This is the deliberate maintenance boundary: harness-specific differences
stay in one small adapter, while pool, resolver, capsule, and assignment code
remain shared.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test test/harness/codex.test.mjs test/harness/registry.test.mjs
npm test
git add src/harness/codex.mjs src/harness/registry.mjs \
  src/harness/capabilities.mjs test/harness/codex.test.mjs \
  test/harness/registry.test.mjs
git commit -m "feat: isolate Codex specialist context"
```

Expected: all tests PASS; only a matching live verification record makes
Codex eligible.

### Task 13: Live Conformance, Documentation, and Release Verification

**Files:**

- Modify: `src/harness/cli-verify.mjs`
- Modify: `test/harness/cli-verify-conformance.test.mjs`
- Modify: `README.md`
- Modify: `docs/specialists.md`
- Modify: `package.json`

- [ ] **Step 1: Write failing full-canary conformance test**

Extend `test/harness/cli-verify-conformance.test.mjs` with an observed report:

```js
const expected = {
  skills: ["capsule.selected-skill"],
  plugins: ["capsule.selected-plugin"],
  mcp_tools: ["mcp__selected__lookup"],
  frameworks: ["capsule.selected-framework"],
};
const observed = {
  skills: ["capsule.selected-skill"],
  plugins: ["capsule.selected-plugin"],
  mcp_tools: ["mcp__selected__lookup"],
  frameworks: ["capsule.selected-framework"],
  absent: [
    "global.canary-skill", "global.canary-plugin", "mcp__global__canary",
    "pool.unselected-skill", "mcp__excluded__lookup",
    "pool.unselected-framework",
  ],
};
assert.deepEqual(validateIsolationObservation({ expected, observed }), {
  ok: true, errors: [],
});
```

Add negative cases for every global, unselected, and excluded canary plus an
MCP tool-list mismatch.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/harness/cli-verify-conformance.test.mjs
```

Expected: FAIL because the existing verifier covers command mediation only.

- [ ] **Step 3: Extend live verification and version invalidation**

In `src/harness/cli-verify.mjs`, export and use:

```js
export function validateIsolationObservation({ expected, observed }) {
  const errors = [];
  for (const key of ["skills", "plugins", "mcp_tools", "frameworks"]) {
    const want = [...(expected[key] ?? [])].sort();
    const got = [...(observed[key] ?? [])].sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      errors.push(`${key} mismatch: expected ${want.join(",")} got ${got.join(",")}`);
    }
  }
  const forbidden = [
    "global.canary-skill", "global.canary-plugin", "mcp__global__canary",
    "pool.unselected-skill", "mcp__excluded__lookup",
    "pool.unselected-framework",
  ];
  for (const name of forbidden) {
    if (!(observed.absent ?? []).includes(name)) {
      errors.push(`forbidden capability visible: ${name}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
```

The live fixture must create global canaries in a temporary fake home and
selected/unselected/excluded fixtures in the pool, launch the real Claude
executable from a capsule, and collect its exact visible skill/plugin/tool/
framework report. Store `context_isolation:
"team-up.context-isolation/v1"` in the version-keyed verification record only
when both command-broker and isolation checks pass. Existing
`loadVerificationRecord(adapter.id, adapter.version())` behavior ensures a
harness version change has no matching record.

- [ ] **Step 4: Document opt-in management and isolation limits**

Update `README.md` with:

```markdown
## Capability isolation

`team-up` keeps shared skills, plugins, MCPs, frameworks, and bundles inert in
a content-addressed pool. Installation does not activate a package. The human
enables an exact checksum for `all` or named specialists; an explicit
exclusion wins over `all`.

Use the supervisor-only `/team-up-manage` skill or deterministic
`team-up capability` commands. Specialist recommendations are opt-in and
start unselected.

This isolates model context, not Unix files. Workers run as the same trusted
user. A harness must pass `team-up.context-isolation/v1` conformance before it
is eligible for specialist work.
```

Update `docs/specialists.md` with the manifest `recommendations` schema, the
effective-set formula, capsule tree, CLI examples for local/Git
install-enable-disable-update-rollback-remove-scan, and the statement that
there is no mandatory baseline.

- [ ] **Step 5: Run complete verification**

Run:

```bash
node --test test/harness/cli-verify-conformance.test.mjs
npm test
npm pack --dry-run
git diff --check
```

Expected:

- every test passes;
- the package includes `skills/team-up-manage/SKILL.md`;
- no whitespace errors;
- no specialist capsule contains the operator skill;
- adding an unassigned package changes neither prompt-token estimate nor MCP
  schema bytes.

Run the real conformance fixture for installed adapters:

```bash
team-up harness verify claude --fixture-project "$(mktemp -d)"
team-up harness verify codex --fixture-project "$(mktemp -d)"
```

Expected: each JSON record contains the detected harness version, `status: "verified"`,
and `context_isolation: "team-up.context-isolation/v1"`. If credentials or
the executable are unavailable, retain the automated fixture result but do
not mark any live harness version verified.

- [ ] **Step 6: Commit the completed feature**

```bash
git add src/harness/cli-verify.mjs \
  test/harness/cli-verify-conformance.test.mjs README.md \
  docs/specialists.md package.json
git commit -m "docs: finish capability isolation rollout"
```

At this point use `superpowers:verification-before-completion`, then
`superpowers:requesting-code-review`. Address verified review findings with
their own test-first commits. Finally use
`superpowers:finishing-a-development-branch` to present merge, PR, keep, or
cleanup options; do not choose one without the human.
