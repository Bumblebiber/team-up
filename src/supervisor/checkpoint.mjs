const REQUIRED = [
  "schema",
  "run_id",
  "attempt_id",
  "status",
  "summary",
  "completed",
  "open",
  "artifacts",
  "verification_commands",
  "risks",
  "questions",
  "repository",
  "created_at",
];

const ALLOWED = new Set(REQUIRED);

/**
 * Validate a typed team-up.checkpoint/v1 document.
 */
export function validateCheckpoint(checkpoint, { runId, attemptId } = {}) {
  const errors = [];
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { ok: false, errors: ["checkpoint must be an object"] };
  }
  for (const key of Object.keys(checkpoint)) {
    if (!ALLOWED.has(key)) errors.push(`unknown field: ${key}`);
  }
  for (const key of REQUIRED) {
    if (!(key in checkpoint)) errors.push(`missing field: ${key}`);
  }
  if (checkpoint.schema !== "team-up.checkpoint/v1") {
    errors.push("schema must be team-up.checkpoint/v1");
  }
  if (checkpoint.status !== "complete" && checkpoint.status !== "partial") {
    errors.push("status must be complete|partial");
  }
  if (runId != null && checkpoint.run_id !== runId) {
    errors.push("run_id mismatch");
  }
  if (attemptId != null && checkpoint.attempt_id !== attemptId) {
    errors.push("attempt_id mismatch");
  }
  for (const arr of ["completed", "open", "artifacts", "verification_commands", "risks", "questions"]) {
    if (checkpoint[arr] != null && !Array.isArray(checkpoint[arr])) {
      errors.push(`${arr} must be an array`);
    }
  }
  if (checkpoint.repository != null && typeof checkpoint.repository !== "object") {
    errors.push("repository must be an object");
  }
  return { ok: errors.length === 0, errors };
}

export function materializePartialCheckpoint({
  runId,
  attemptId,
  summary = "controller-generated partial checkpoint",
  now = new Date().toISOString(),
  repository = { head: null, dirty: null, diff_stat: null },
}) {
  return {
    schema: "team-up.checkpoint/v1",
    run_id: runId,
    attempt_id: attemptId,
    status: "partial",
    summary,
    completed: [],
    open: ["worker exited without handoff_ready"],
    artifacts: [],
    verification_commands: [],
    risks: ["partial handoff"],
    questions: [],
    repository,
    created_at: now,
  };
}
