const CALL_DEFAULTS = {
  consult: { writes: false },
  delegate: { writes: "delegated_only" },
  review: { writes: false },
};

const RESULT_STATUSES = new Set(["success", "partial", "blocked", "failed"]);

export function normalizeRequest(input) {
  if (!input || typeof input !== "object") {
    throw new Error("request must be an object");
  }
  const call_type = input.call_type;
  if (!["consult", "delegate", "review"].includes(call_type)) {
    throw new Error(`invalid call_type: ${call_type}`);
  }
  if (!input.specialist_id) throw new Error("specialist_id required");
  if (!input.objective) throw new Error("objective required");

  const defaults = CALL_DEFAULTS[call_type];
  const permissions = {
    writes: defaults.writes,
    ...(input.permissions || {}),
  };
  // review is read-only by default unless explicitly overridden to true later stages
  if (call_type === "review" && input.permissions?.writes === undefined) {
    permissions.writes = false;
  }
  if (call_type === "consult" && input.permissions?.writes === undefined) {
    permissions.writes = false;
  }

  return {
    schema: "team-up.request/v1",
    run_id: input.run_id ?? null,
    specialist_id: input.specialist_id,
    specialist_version: input.specialist_version ?? null,
    call_type,
    objective: input.objective,
    inputs: Array.isArray(input.inputs) ? input.inputs : [],
    expected_result: input.expected_result ?? null,
    permissions,
    budget: input.budget ?? null,
    parent_run: input.parent_run ?? null,
    depth: input.depth ?? 0,
  };
}

export function validateResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("result must be an object");
  }
  if (result.schema && result.schema !== "team-up.result/v1") {
    throw new Error(`unsupported result schema: ${result.schema}`);
  }
  if (!RESULT_STATUSES.has(result.status)) {
    throw new Error(`invalid status: ${result.status}`);
  }
  return {
    schema: "team-up.result/v1",
    status: result.status,
    summary: result.summary ?? "",
    deliverables: result.deliverables ?? [],
    evidence: result.evidence ?? [],
    risks: result.risks ?? [],
    questions: result.questions ?? [],
    runtime: result.runtime ?? null,
    usage: result.usage ?? null,
    children: result.children ?? [],
  };
}

export function writeTypedResult(runId, result, { runDir, atomicWriteJson, atomicWriteText, setStatus, classifyMailbox }) {
  let validated;
  try {
    validated = validateResult(result);
  } catch (e) {
    validated = {
      schema: "team-up.result/v1",
      status: "failed",
      summary: "malformed terminal JSON",
      deliverables: [],
      evidence: [],
      risks: [],
      questions: [],
      runtime: null,
      usage: null,
      children: [],
      validation_error: e.message,
    };
  }
  const dir = runDir(runId);
  atomicWriteJson(`${dir}/mailbox/RESULT.json`, validated);
  // Keep text RESULT.md for backward compatibility
  atomicWriteText(
    `${dir}/mailbox/RESULT.md`,
    `# Result\n\nstatus: ${validated.status}\n\n${validated.summary}\n`
  );
  const statusMap = {
    success: "done",
    partial: "done",
    blocked: "waiting_human",
    failed: "failed",
  };
  setStatus(runId, statusMap[validated.status] || "failed");
  return { validated, classified: classifyMailbox(runId) };
}
