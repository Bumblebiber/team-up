#!/usr/bin/env node
/**
 * Mutation battery for grant-decision guards in isolation-canary/registry/verify.
 * Run: node scripts/mutate-grant-decision.mjs [output.json]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANARY = path.join(REPO, "src/harness/isolation-canary.mjs");
const REGISTRY = path.join(REPO, "src/harness/registry.mjs");
const VERIFY = path.join(REPO, "src/harness/verify.mjs");

const MUTANTS = [
  ["M1 decide: always grant",
    CANARY, "return result.ok ? CONTEXT_ISOLATION_CAPABILITY : null;", "return CONTEXT_ISOLATION_CAPABILITY;"],
  ["M2 validate: drop forbidden-canary check",
    CANARY, "if (!(observed.absent ?? []).includes(name)) {", "if (false) {"],
  ["M3 validate: drop nonce equality",
    CANARY, "if (want[key] != null && got[key] !== want[key]) {", "if (false) {"],
  ["M4 validate: drop selected-set equality",
    CANARY, 'if (JSON.stringify(want) !== JSON.stringify(got)) {', "if (false) {"],
  ["M5 absentListComplete: always true",
    CANARY, "  if (!Array.isArray(absent)) return false;\n  return ISOLATION_FORBIDDEN_CANARIES.every((name) => absent.includes(name));",
    "  return true;"],
  ["M6 contentNoncesMatch: always true",
    CANARY, "  if (!expectedNonces) return true;\n  if (!observedNonces || typeof observedNonces !== \"object\") return false;",
    "  return true;\n  if (!observedNonces || typeof observedNonces !== \"object\") return false;"],
  ["M7 resultContainsExactNonce: always true",
    CANARY, "  if (text == null || nonce == null) return false;\n  const raw = String(text);", "  return true;\n  const raw = String(text);"],
  ["M8 streamToolProof: drop final gate",
    CANARY, "  if (!sessionId || !toolUseId || !sawToolResult) return null;", "  if (false) return null;"],
  ["M9 streamToolProof: accept any result payload",
    CANARY, "        if (text === expectedPayload || text.trim() === expectedPayload) {", "        if (true) {"],
  ["M10 streamToolProof: allow tool_use on non-assistant events",
    CANARY, "        if (evt.type !== \"assistant\") return null;", "        if (false) return null;"],
  ["M11 streamToolProof: allow same-event use+result",
    CANARY, "    if (sawUseInThisEvent && sawResultInThisEvent) return null;", "    void sawUseInThisEvent; void sawResultInThisEvent;"],
  ["M12 structured proofs: skip skill proof",
    CANARY, "  if (!skillPair) return null;", "  if (!skillPair) { /* mutant */ }"],
  ["M13 structured proofs: skip plugin proof",
    CANARY, "  if (!pluginPair) return null;", "  if (!pluginPair) { /* mutant */ }"],
  ["M14 structured proofs: skip framework proof",
    CANARY, "  if (!frameworkPair) return null;", "  if (!frameworkPair) { /* mutant */ }"],
  ["M15 structured proofs: skip mcp proof",
    CANARY, "  if (!mcpPair) return null;", "  if (!mcpPair) { /* mutant */ }"],
  ["M16 structured proofs: framework path match loosened",
    CANARY, "    if (!expectedFwPaths.has(filePath)) return false;", "    if (false) return false;"],
  ["M17 structured proofs: drop init skill/plugin requirement",
    CANARY, "  if (!(init.skills || []).includes(wantSkill)) return null;\n  if (!(init.plugins || []).includes(wantPlugin)) return null;", "  void wantSkill; void wantPlugin;"],
  ["M18 structured proofs: drop verifyInitSurfaceExclusion",
    CANARY, "  const exclusion = verifyInitSurfaceExclusion(init, { expected, prepared });\n  if (!exclusion.ok) return null;", "  void verifyInitSurfaceExclusion;"],
  ["M19 skillNameMatches: always true",
    CANARY, "  const got = String(inputSkill || \"\");\n  if (!got || !want) return false;", "  const got = String(inputSkill || \"\"); void got; return true;"],
  ["M20 findSkillLaunchProof: skip body/nonce correlation",
    CANARY, "  if (!body) return null;\n  return { ...launch, skillBodyText: body.text };", "  return { ...launch, skillBodyText: body?.text };"],
  ["M21 decide: drop array-shape gate",
    CANARY, "    if (!Array.isArray(observed[key])) return null;", "    if (false) return null;"],
  ["M22 decide: drop absentListComplete gate",
    CANARY, "  if (!absentListComplete(observed.absent)) return null;\n  const result = validateIsolationObservation", "  const result = validateIsolationObservation"],
  ["M23 observe: liveProbe stream re-proof dropped",
    CANARY, "      if (!live.stream_text) {", "      if (false) {"],
  ["M24 observe: codex early-deny removed",
    CANARY, "    if (adapterId === \"codex\") {\n      // Codex 0.145.0 lacks native plugin/framework isolation surfaces.", "    if (false) {\n      // Codex 0.145.0 lacks native plugin/framework isolation surfaces."],
  ["M25 observe: missing observed still granted",
    CANARY, "    if (!observed) {\n      return finish({", "    if (false) {\n      return finish({"],
  ["M26 live: drop probeHome closed-world check",
    CANARY, "  const homeCheck = verifyProbeHomeClosedWorld(probeHome, {\n    expectedSkills: expected?.skills || [],\n  });\n  if (!homeCheck.ok) return null;", "  void verifyProbeHomeClosedWorld;"],
  ["M27 live: drop --strict-mcp-config requirement",
    CANARY, "  if (!prepared.argv.includes(\"--strict-mcp-config\")) return null;\n  // Production capsule launches", "  // Production capsule launches"],
  ["M28 live: drop stdout requirement (stderr-only ok)",
    CANARY, "    if (!inventoryRun.stdout) return null;", "    void 0;"],
  ["M29 live: drop structured-init requirement",
    CANARY, "    const init = extractStructuredInitInventory(inventoryText);\n    if (!init) return null;",
    "    const init = extractStructuredInitInventory(inventoryText) || { session_id: \"x\", tools: [], skills: [], plugins: [], mcp_servers: [] };\n    void init;"],
  ["M30 registry: capsule gate removed",
    REGISTRY, "  if (capsule && caps.context_isolation !== CONTEXT_ISOLATION_CAPABILITY) {", "  if (false) {"],
  ["M31 registry: unverified record still yields caps",
    REGISTRY, '  if (record?.status !== "verified") {\n    return { ...UNVERIFIED_CAPABILITIES };\n  }', "  if (false) { }"],
  ["M32 registry: declared-null no longer absolute deny",
    REGISTRY, "    context_isolation: declared.context_isolation == null ? null : verifiedIsolation,", "    context_isolation: verifiedIsolation,"],
  ["M33 verify: record isolation token regardless of checks",
    VERIFY, "      declaresIsolation && checks.context_isolation === CONTEXT_ISOLATION_CAPABILITY\n        ? CONTEXT_ISOLATION_CAPABILITY\n        : null,", "      CONTEXT_ISOLATION_CAPABILITY,"],
  ["M34 verify: verified status without isolation proof",
    VERIFY, "      if (checks.context_isolation === CONTEXT_ISOLATION_CAPABILITY) {\n        status = \"verified\";\n      } else if (checks.isolation_status === \"failed\") {", "      if (true) {\n        status = \"verified\";\n      } else if (checks.isolation_status === \"failed\") {"],
  ["M35 live: drop init negative gates",
    CANARY, "    for (const bad of [\"global.canary-skill\", \"global.canary-plugin\"]) {\n      if ((init.skills || []).includes(bad) || (init.plugins || []).includes(bad)) {\n        return null;\n      }\n    }", ""],
  ["M36 live: drop mcp_tools selected requirement",
    CANARY, "    if (!observed.mcp_tools.includes(\"mcp__selected__lookup\")) return null;", ""],
  ["M37 live: drop contentNoncesMatch gate",
    CANARY, "    if (!contentNoncesMatch(expectedNonces, observed.content_nonces)) return null;\n    return observed;", "    return observed;"],
  ["M38 live: drop globalsPlanted precondition",
    CANARY, "  if (!globalHome || !globalsPlanted(globalHome, adapterId)) return null;", ""],
  ["M39 launch surface: forbidden canaries never marked present",
    CANARY, "    const absent = ISOLATION_FORBIDDEN_CANARIES.filter((name) => !present.has(name));", "    const absent = [...ISOLATION_FORBIDDEN_CANARIES];"],
];

const TESTS = [
  "test/harness/*.test.mjs",
  "test/supervisor/*.test.mjs",
  "test/integration/*.test.mjs",
  "test/specialists/*.test.mjs",
  "test/capabilities/*.test.mjs",
];

const TARGET_FILES = [...new Set(MUTANTS.map(([, file]) => file))];
let currentFile = null;
let activeTestChild = null;
let exiting = false;

function relPath(file) {
  return path.relative(REPO, file);
}

function git(args) {
  return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function isFileDirty(file) {
  const r = git(["status", "--porcelain", "--", relPath(file)]);
  return Boolean(r.stdout.trim());
}

function refuseDirty(file) {
  const rel = relPath(file);
  console.error(
    `ERROR: working tree is dirty for ${rel}. ` +
    "An earlier interrupted mutation run may have poisoned this file. " +
    `Restore with: git checkout -- ${rel}`,
  );
  process.exit(1);
}

function restoreFile(file) {
  const rel = relPath(file);
  const r = git(["checkout", "--", rel]);
  if (r.status !== 0) {
    console.error(`ERROR: git checkout -- ${rel} failed:\n${r.stderr || r.stdout}`);
    process.exit(1);
  }
}

function fileDiff(file) {
  const r = git(["diff", "--", relPath(file)]);
  return r.stdout || r.stderr || "(no diff output)";
}

function assertFileClean(file, context) {
  if (isFileDirty(file)) {
    console.error(`ERROR: ${context}: ${relPath(file)} is still modified after restore:\n${fileDiff(file)}`);
    process.exit(1);
  }
}

function restoreAllTargets() {
  for (const file of TARGET_FILES) {
    restoreFile(file);
  }
}

function verifyAllTargetsClean(context) {
  for (const file of TARGET_FILES) {
    assertFileClean(file, context);
  }
}

function stopActiveTestChild() {
  if (!activeTestChild || activeTestChild.killed) return;
  try {
    activeTestChild.kill("SIGTERM");
  } catch {
    // child may already have exited
  }
}

function exitOnSignal(sig) {
  if (exiting) return;
  exiting = true;
  console.error(`\nReceived ${sig}; restoring mutated files...`);
  stopActiveTestChild();
  restoreAllTargets();
  verifyAllTargetsClean(`after ${sig}`);
  process.exit(1);
}

process.on("SIGINT", () => exitOnSignal("SIGINT"));
process.on("SIGTERM", () => exitOnSignal("SIGTERM"));

function runSuite() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--test", ...TESTS], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    activeTestChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("test suite timed out after 600000ms"));
    }, 600000);
    child.on("error", (err) => {
      clearTimeout(timer);
      activeTestChild = null;
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      activeTestChild = null;
      const out = `${stdout}\n${stderr}`;
      const fail = /^# fail (\d+)$/m.exec(out) || /ℹ fail (\d+)/.exec(out);
      const failing = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
      resolve({ fail: fail ? Number(fail[1]) : -1, failing: [...new Set(failing)] });
    });
  });
}

for (const file of TARGET_FILES) {
  if (isFileDirty(file)) refuseDirty(file);
}

const results = [];
for (const [name, file, from, to] of MUTANTS) {
  if (exiting) break;
  if (isFileDirty(file)) refuseDirty(file);

  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) {
    results.push({ name, status: "PATTERN-MISS" });
    console.log(`${name}: PATTERN-MISS`);
    continue;
  }
  const count = orig.split(from).length - 1;
  currentFile = file;
  fs.writeFileSync(file, orig.replace(from, to));
  let suiteResult;
  try {
    suiteResult = await runSuite();
  } catch (err) {
    restoreFile(file);
    assertFileClean(file, "after mutation restore");
    currentFile = null;
    if (exiting) process.exit(1);
    throw err;
  }
  if (exiting) {
    restoreFile(file);
    assertFileClean(file, "after mutation restore");
    currentFile = null;
    process.exit(1);
  }
  const { fail, failing } = suiteResult;
  const status = fail > 0 ? "KILLED" : "SURVIVED";
  results.push({ name, status, fail, occurrences: count, failing: failing.slice(0, 6) });
  console.log(`${name}: ${status} (fail=${fail}${count > 1 ? `, ${count} occurrences, only first patched` : ""})${fail > 0 ? " :: " + failing.slice(0, 3).join(" | ") : ""}`);
  restoreFile(file);
  assertFileClean(file, "after mutation restore");
  currentFile = null;
}

verifyAllTargetsClean("final verification");

const outPath = process.argv[2] || path.join(REPO, "mutation-results.json");
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nWrote ${outPath}`);
