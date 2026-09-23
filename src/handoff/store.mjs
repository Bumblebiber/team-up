import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "../json-store.mjs";
import { handoffsDir, handoffsDoneDir } from "../paths.mjs";
import { assertPathInsideRoot } from "../specialists/safe-id.mjs";

export const DEFAULT_HANDOFF_RETENTION_DAYS = 14;
export const FORGOTTEN_HANDOFF_HOURS = 48;
export const FORGOTTEN_HANDOFF_MS = FORGOTTEN_HANDOFF_HOURS * 60 * 60 * 1000;

const LEGACY_NAME = "HANDOFF.md";

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

export function handoffStorePath(env = process.env) {
  return handoffsDir(env);
}

export function successorPrompt(handoffPath) {
  const abs = path.resolve(handoffPath);
  return (
    `Read ${abs} and continue the task it describes. ` +
    `When you are done, run \`team-up handoff --close ${abs}\`.`
  );
}

function writeHandoffFile(destPath, content) {
  atomicWriteText(destPath, content);
  fs.chmodSync(destPath, 0o600);
}

export function storeHandoffContent({ content, label, env = process.env, now = new Date() } = {}) {
  const dir = handoffsDir(env);
  fs.mkdirSync(dir, { recursive: true });
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
  const store = handoffsDir(env);
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
    fs.mkdirSync(store, { recursive: true });
    const filename = buildHandoffFilename({ now, label });
    const destPath = path.join(store, filename);
    fs.renameSync(legacy, destPath);
    fs.chmodSync(destPath, 0o600);
    return destPath;
  }
  throw new Error(
    `no handoff content — write ${LEGACY_NAME} in ${dir}, pass --handoff-file <path>, ` +
    `or create a file under ${store}`
  );
}

export function missingHandoffMessage(dir, env = process.env) {
  const store = handoffsDir(env);
  return (
    `no handoff content — write ${LEGACY_NAME} in ${dir}, pass --handoff-file <path>, ` +
    `or create a file under ${store}`
  );
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

export function closeHandoff(handoffPath, { note, env = process.env, now = new Date() } = {}) {
  const openRoot = handoffsDir(env);
  const doneRoot = handoffsDoneDir(env);
  const resolved = assertPathInsideRoot(path.resolve(handoffPath), openRoot);
  const basename = path.basename(resolved);
  const donePath = path.join(doneRoot, basename);

  if (!fs.existsSync(resolved)) {
    if (fs.existsSync(donePath)) {
      return { status: "already_closed", path: donePath };
    }
    throw new Error(`handoff not found: ${handoffPath}`);
  }

  const content = fs.readFileSync(resolved, "utf8");
  const closedAt = now.toISOString();
  fs.mkdirSync(doneRoot, { recursive: true });
  writeHandoffFile(donePath, appendCloseBlock(content, { closedAt, note }));
  fs.unlinkSync(resolved);
  return { status: "closed", path: donePath, closedAt };
}

export function refuseCloseOutsideStore(handoffPath, env = process.env) {
  const openRoot = handoffsDir(env);
  assertPathInsideRoot(path.resolve(handoffPath), openRoot);
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
  unlink = fs.unlinkSync.bind(fs),
  stat = fs.statSync.bind(fs),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const targets = [];
  for (const dir of [handoffsDir(env), handoffsDoneDir(env)]) {
    for (const name of listMdFiles(dir)) {
      const filePath = path.join(dir, name);
      const mtimeMs = stat(filePath).mtimeMs;
      if (handoffGcDecision({ mtimeMs, nowMs, retentionDays })) {
        targets.push(filePath);
      }
    }
  }
  for (const filePath of targets) {
    unlink(filePath);
  }
  return { deleted: targets, retentionDays, at: new Date(nowMs).toISOString() };
}

export function listOpenHandoffs(env = process.env, { now = Date.now(), stat = fs.statSync.bind(fs) } = {}) {
  const dir = handoffsDir(env);
  const findings = [];
  for (const name of listMdFiles(dir)) {
    const filePath = path.join(dir, name);
    const mtimeMs = stat(filePath).mtimeMs;
    const ageMs = now - mtimeMs;
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
