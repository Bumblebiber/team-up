import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { handoffsDir, handoffsDoneDir } from "../paths.mjs";
import { assertPathInsideRoot } from "../specialists/safe-id.mjs";

export const DEFAULT_HANDOFF_RETENTION_DAYS = 14;
export const FORGOTTEN_HANDOFF_HOURS = 48;
export const FORGOTTEN_HANDOFF_MS = FORGOTTEN_HANDOFF_HOURS * 60 * 60 * 1000;

const LEGACY_NAME = "HANDOFF.md";
const HANDOFF_DIR_MODE = 0o700;
const HANDOFF_FILE_MODE = 0o600;

function utcStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function randomSuffix(bytes = 2) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sanitizeLabel(label) {
  const cleaned = String(label || "handoff")
    .trim()
    .replace(/[^A-Za-z0-9._+-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "handoff";
}

export function buildHandoffFilename({ now = new Date(), label, random = randomSuffix } = {}) {
  return `${utcStamp(now)}-${sanitizeLabel(label)}-${random()}.md`;
}

export function successorPrompt(handoffPath) {
  const abs = path.resolve(handoffPath);
  return (
    `Read ${abs} and continue the task it describes. ` +
    `When you are done, run \`team-up handoff --close ${abs}\`.`
  );
}

function ensureHandoffsDir(env) {
  const dir = handoffsDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: HANDOFF_DIR_MODE });
  return dir;
}

function writeHandoffFile(destPath, content) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true, mode: HANDOFF_DIR_MODE });
  const tmp = `${destPath}.${process.pid}.${Date.now()}.tmp`;
  const text = content.endsWith("\n") ? content : `${content}\n`;
  fs.writeFileSync(tmp, text, { mode: HANDOFF_FILE_MODE });
  fs.renameSync(tmp, destPath);
  fs.chmodSync(destPath, HANDOFF_FILE_MODE);
}

export function storeHandoffContent({ content, label, env = process.env, now = new Date() } = {}) {
  const dir = ensureHandoffsDir(env);
  const filename = buildHandoffFilename({ now, label });
  const destPath = path.join(dir, filename);
  writeHandoffFile(destPath, content);
  return destPath;
}

export function resolveHandoffForSpawn({
  dir,
  handoffFile,
  label,
  env = process.env,
  now = new Date(),
} = {}) {
  if (handoffFile) {
    const src = path.resolve(handoffFile);
    if (!fs.existsSync(src)) {
      throw new Error(`handoff file not found: ${src}`);
    }
    const content = fs.readFileSync(src, "utf8");
    return storeHandoffContent({ content, label, env, now });
  }
  const legacy = path.join(dir, LEGACY_NAME);
  if (fs.existsSync(legacy)) {
    const store = ensureHandoffsDir(env);
    const filename = buildHandoffFilename({ now, label });
    const destPath = path.join(store, filename);
    fs.renameSync(legacy, destPath);
    fs.chmodSync(destPath, HANDOFF_FILE_MODE);
    return destPath;
  }
  throw new Error(
    `no handoff content — write ${LEGACY_NAME} in ${dir} or pass --handoff-file <path>`
  );
}

export function missingHandoffMessage(dir) {
  return `no handoff content — write ${LEGACY_NAME} in ${dir} or pass --handoff-file <path>`;
}

function appendCloseBlock(content, { closedAt, note }) {
  const lines = [
    "",
    "---",
    `closed-at: ${closedAt}`,
  ];
  if (note?.trim()) {
    lines.push(`note: ${note.trim()}`);
  }
  lines.push("");
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return base + lines.join("\n");
}

function isInsideRoot(candidate, root) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function inspectHandoffEntry(filePath, lstat = fs.lstatSync.bind(fs)) {
  try {
    const st = lstat(filePath);
    if (!st.isFile()) {
      return {
        kind: "skipped",
        path: filePath,
        reason: st.isSymbolicLink() ? "symbolic link" : "not a regular file",
      };
    }
    return { kind: "ok", path: filePath, mtimeMs: st.mtimeMs };
  } catch (error) {
    return {
      kind: "unreadable",
      path: filePath,
      error: String(error.message || error),
    };
  }
}

export function closeHandoff(handoffPath, { note, env = process.env, now = new Date() } = {}) {
  const openRoot = handoffsDir(env);
  const doneRoot = handoffsDoneDir(env);
  const resolved = assertPathInsideRoot(path.resolve(handoffPath), openRoot);
  const basename = path.basename(resolved);
  const donePath = path.join(doneRoot, basename);

  if (isInsideRoot(resolved, doneRoot)) {
    if (fs.existsSync(resolved)) {
      return { status: "already_closed", path: resolved };
    }
    throw new Error(`handoff not found: ${handoffPath}`);
  }

  if (!fs.existsSync(resolved)) {
    if (fs.existsSync(donePath)) {
      return { status: "already_closed", path: donePath };
    }
    throw new Error(`handoff not found: ${handoffPath}`);
  }

  const lst = fs.lstatSync(resolved);
  if (!lst.isFile()) {
    throw new Error(`handoff is not a regular file: ${handoffPath}`);
  }

  const content = fs.readFileSync(resolved, "utf8");
  const closedAt = now.toISOString();
  fs.mkdirSync(doneRoot, { recursive: true, mode: HANDOFF_DIR_MODE });
  writeHandoffFile(donePath, appendCloseBlock(content, { closedAt, note }));
  fs.unlinkSync(resolved);
  return { status: "closed", path: donePath, closedAt };
}

export function readHandoffRetentionDays(roster, { warn = console.warn } = {}) {
  const value = roster?.limits?.handoff_retention_days;
  if (Number.isInteger(value) && value >= 1) return value;
  if (value !== undefined && value !== null) {
    warn(
      `ignoring invalid limits.handoff_retention_days (${value}); using ${DEFAULT_HANDOFF_RETENTION_DAYS}`
    );
  }
  return DEFAULT_HANDOFF_RETENTION_DAYS;
}

export function handoffGcDecision({ mtimeMs, nowMs, retentionDays = DEFAULT_HANDOFF_RETENTION_DAYS }) {
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return Number.isFinite(mtimeMs) && Number.isFinite(nowMs) && nowMs - mtimeMs > retentionMs;
}

function listMdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function planHandoffGc({
  entries,
  nowMs,
  retentionDays = DEFAULT_HANDOFF_RETENTION_DAYS,
}) {
  return entries
    .filter((entry) => handoffGcDecision({ mtimeMs: entry.mtimeMs, nowMs, retentionDays }))
    .map((entry) => entry.path);
}

export function gcHandoffs({
  env = process.env,
  now = new Date(),
  retentionDays = DEFAULT_HANDOFF_RETENTION_DAYS,
  dryRun = false,
  unlink = fs.unlinkSync.bind(fs),
  lstat = fs.lstatSync.bind(fs),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const entries = [];
  const skipped = [];
  for (const dir of [handoffsDir(env), handoffsDoneDir(env)]) {
    for (const name of listMdFiles(dir)) {
      const filePath = path.join(dir, name);
      const inspected = inspectHandoffEntry(filePath, lstat);
      if (inspected.kind === "ok") {
        entries.push({ path: filePath, mtimeMs: inspected.mtimeMs });
      } else {
        skipped.push(inspected);
      }
    }
  }
  const targets = planHandoffGc({ entries, nowMs, retentionDays });
  if (!dryRun) {
    for (const filePath of targets) {
      unlink(filePath);
    }
  }
  return {
    deleted: targets,
    skipped,
    retentionDays,
    dryRun,
    at: new Date(nowMs).toISOString(),
  };
}

export function listUnreadableOpenHandoffs(env = process.env, { lstat = fs.lstatSync.bind(fs) } = {}) {
  const dir = handoffsDir(env);
  const unreadable = [];
  for (const name of listMdFiles(dir)) {
    const filePath = path.join(dir, name);
    const inspected = inspectHandoffEntry(filePath, lstat);
    if (inspected.kind !== "ok") {
      unreadable.push(inspected);
    }
  }
  return unreadable;
}

export function listOpenHandoffs(
  env = process.env,
  { now = Date.now(), lstat = fs.lstatSync.bind(fs) } = {}
) {
  const dir = handoffsDir(env);
  const findings = [];
  for (const name of listMdFiles(dir)) {
    const filePath = path.join(dir, name);
    const inspected = inspectHandoffEntry(filePath, lstat);
    if (inspected.kind !== "ok") continue;
    const ageMs = now - inspected.mtimeMs;
    if (ageMs > FORGOTTEN_HANDOFF_MS) {
      findings.push({
        path: filePath,
        ageMs,
        ageHours: Math.floor(ageMs / (60 * 60 * 1000)),
      });
    }
  }
  return findings;
}
