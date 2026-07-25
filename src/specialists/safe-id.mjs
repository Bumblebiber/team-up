import path from "node:path";

/** Portable specialist id / version segment: no separators, dots-only as interior, no control chars. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function assertSafeSpecialistSegment(value, label = "segment") {
  if (value == null || typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label}: empty`);
  }
  if (/[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid ${label}: control characters`);
  }
  if (value === "." || value === ".." || value.includes("..")) {
    throw new Error(`unsafe ${label}: dot segment`);
  }
  if (value.includes("/") || value.includes("\\") || path.isAbsolute(value)) {
    throw new Error(`unsafe ${label}: path separator or absolute`);
  }
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`invalid ${label}: must match ${SAFE_SEGMENT}`);
  }
  return value;
}

export function assertPathInsideRoot(candidate, root) {
  const resolved = path.resolve(candidate);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes store root: ${candidate}`);
  }
  return resolved;
}
