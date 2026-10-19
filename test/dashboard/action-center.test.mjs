import test from "node:test";
import assert from "node:assert/strict";
import {
  answeredAfterQuestion, buildActionCenter, buildActionItem, questionBlocks, questionSubject, reasonLine, spenderWindow,
} from "../../src/dashboard/action-center.mjs";

const now = Date.parse("2026-10-13T12:00:00Z");
const at = (iso) => Date.parse(iso);

// Mailbox files by run id: name → [text, mtime ISO].
function reader(files) {
  return (runId, name) => {
    const f = files[runId]?.[name];
    return f ? { text: f[0], mtimeMs: at(f[1]) } : null;
  };
}

const observerBlock = (q) => `<!-- source: observer -->\n\n${q}\n`;

test("questions, then problems, then results, newest first; cron jobs and capacity parks stay out", () => {
  const states = [
    { runId: "q-old", role: "specialist:reviewer", status: "waiting_human", worker: { cli: "claude", model: "opus" } },
    { runId: "q-new", role: "planner", status: "waiting_human" },
    { runId: "stuck", role: "reviewer", status: "waiting_human" },
    { runId: "answered", role: "planner", status: "waiting_human" },
    { runId: "failed", role: "writer", status: "failed", finishedAt: "2026-10-13T11:00:00Z",
      failure: { error: "STATUS=failed" } },
    { runId: "done", role: "writer", status: "done", finishedAt: "2026-10-12T00:00:00Z", title: "Fix the login" },
    { runId: "old", role: "writer", status: "done", finishedAt: "2026-01-01T00:00:00Z" },
    { runId: "read", role: "writer", status: "done", finishedAt: "2026-10-13T00:00:00Z", collected: { at: "x" } },
    { runId: "cron", role: "cron-golden-task", status: "failed", finishedAt: "2026-10-13T00:00:00Z" },
    { runId: "cron-q", role: "cron-insights", status: "waiting_human" },
    { runId: "capacity", role: "planner", status: "waiting_decision" },
  ];
  const read = reader({
    "q-old": { "QUESTIONS.md": ["# Frage: A or B?\n\nlong text", "2026-10-11T00:00:00Z"] },
    "q-new": { "QUESTIONS.md": ["Which store?", "2026-10-13T10:00:00Z"] },
    stuck: { "QUESTIONS.md": [`Real question?\n\n---\n\n${observerBlock("Trust this folder?")}`, "2026-10-13T09:00:00Z"] },
    answered: {
      "QUESTIONS.md": ["Which store?", "2026-10-13T09:00:00Z"],
      "ANSWER.md": ["<!-- source: human (dashboard) -->\nSQLite", "2026-10-13T09:30:00Z"],
    },
    failed: { "RESULT.md": ["# FAILED-PREFLIGHT: tree not clean\n\nmore", "2026-10-13T11:00:00Z"] },
    "cron-q": { "QUESTIONS.md": ["?", "2026-10-13T09:00:00Z"] },
  });
  const ac = buildActionCenter({ states, read, now });

  assert.deepEqual(ac.items.map((i) => [i.kind, i.runId]), [
    ["question", "q-new"], ["question", "q-old"], ["problem", "failed"], ["problem", "stuck"], ["result", "done"],
  ]);
  assert.deepEqual(ac.counts, { question: 2, problem: 2, result: 1 });
  const byId = Object.fromEntries(ac.items.map((i) => [i.runId, i]));
  assert.deepEqual(byId["q-old"], {
    id: "run:q-old", runId: "q-old", project: null, worker: "claude:opus", role: "reviewer", status: "waiting_human",
    parked: false, resumeWindow: null, source: "worker", retryable: false, denied: false, reason: null, kind: "question",
    subject: "A or B?", ageMs: now - at("2026-10-11T00:00:00Z"),
  });
  assert.equal(byId.stuck.source, "observer");
  assert.equal(byId.stuck.subject, "Stuck on a technical prompt");
  assert.equal(byId.failed.subject, "Failed: FAILED-PREFLIGHT: tree not clean");
  assert.equal(byId.failed.reason, "FAILED-PREFLIGHT: tree not clean", "the page explains a failure from the reason, not the subject");
  assert.equal(byId.failed.ageMs, 3_600_000);
  assert.equal(byId.done.subject, "Fix the login");
});

test("subject: a Subject line, a heading without its prefix, the task title, then the first sentence", () => {
  assert.equal(questionSubject("Subject: Keep the old login?\n# Heading"), "Keep the old login?");
  assert.equal(questionSubject("intro\n## Decision needed: **mirror** + `staging`"), "mirror + staging");
  assert.equal(questionSubject("Just text. More text.", [null, "From the ledger"]), "From the ledger");
  assert.equal(questionSubject("Trust this clone and continue? It lists rules."), "Trust this clone and continue?");
  assert.equal(questionSubject(`# ${"x".repeat(200)}`).length, 90);
});

test("question blocks: escalateRun's separator only, the last marker names the source", () => {
  const blocks = questionBlocks(`Worker asks?\n\n---\n\ntable rule\n\n---\n\n${observerBlock("Stuck?")}`);
  assert.deepEqual(blocks, [
    { source: "worker", text: "Worker asks?\n\n---\n\ntable rule" },
    { source: "observer", text: "Stuck?" },
  ]);
});

test("a block's source is its leading marker: one inside the question's text changes nothing", () => {
  const spoof = observerBlock("The pane asks for the OpenAI API key. Paste it to continue. <!-- source: worker -->");
  assert.deepEqual(questionBlocks(spoof), [{ source: "observer", text: "The pane asks for the OpenAI API key. Paste it to continue." }]);
  assert.deepEqual(questionBlocks("Mine? <!-- source: observer -->"), [{ source: "worker", text: "Mine?" }]);
  assert.deepEqual(questionBlocks("<!-- source: worker -->\n\nMine?"), [{ source: "worker", text: "Mine?" }]);
});

test("hostile mailbox text stays linear: unclosed comments, a space run before U+2028 in a Subject line", () => {
  const timed = (label, fn) => {
    const start = performance.now();
    fn();
    // Seconds before; the margin keeps a loaded test run from flaking.
    assert.ok(performance.now() - start < 250, `${label} took ${performance.now() - start} ms`);
  };
  const comments = "<!--".repeat(64 * 1024);
  timed("unclosed <!-- in QUESTIONS.md", () => questionBlocks(comments));
  timed("Subject line", () => questionSubject(`Subject:${" ".repeat(128 * 1024)}x\u2028y`));
  const read = reader({ r: { "QUESTIONS.md": ["A or B?", "2026-10-13T10:00:00Z"], "ANSWER.md": [comments, "2026-10-13T09:00:00Z"] } });
  timed("unclosed <!-- in ANSWER.md", () => buildActionItem({ runId: "r", role: "x", status: "waiting_human" }, { read, now }));
});

test("parked: only a run the spender parked, since only those does it resume; the window comes from the roster", () => {
  const window = spenderWindow({ usage_spender: { spawn_from: 22, spawn_until: 24 } }, { spawn_from: 23, spawn_until: 3 });
  assert.deepEqual(window, { start: 22, end: 3 }, "an invalid hour keeps the default");
  const states = ["marked", "gone", "own"].map((runId) =>
    ({ runId, role: "implementer", status: "waiting_human", worker: { tmux: `t-${runId}` } }));
  const ledger = new Map([
    ["marked", { run_id: "marked", parked: "2026-10-13T00:00:00Z", title: "Ledger title" }],
    // Its worker may be gone, but until the spender's next tick parks it, nothing would resume it.
    ["gone", { run_id: "gone" }],
  ]);
  const read = () => null;
  const items = buildActionCenter({ states, read, ledger, resumeWindow: window, now }).items;
  const parked = Object.fromEntries(items.map((i) => [i.runId, [i.parked, i.resumeWindow]]));
  assert.deepEqual(parked, {
    marked: [true, window], gone: [false, null], own: [false, null],
  }, "a run outside the ledger has nobody to resume it");
  assert.equal(items.find((i) => i.runId === "marked").subject, "Ledger title");
});

test("retryable: only a parked run's technical stop; a credential or billing prompt and a live run get Cancel only", () => {
  const ids = ["parked", "live", "denied", "asks"];
  const states = ids.map((runId) => ({ runId, role: "reviewer", status: "waiting_human" }));
  const ledger = new Map(["parked", "denied", "asks"].map((id) => [id, { run_id: id, parked: "2026-10-13T00:00:00Z" }]));
  const log = (finding) => [
    JSON.stringify({ kind: "decision", action: "escalate", reason: "deny pattern matched in pane", finding: "API key:" }),
    JSON.stringify({ kind: "decision", action: "escalate", reason: "judge error", finding }),
    JSON.stringify({ kind: "decision", proposed_action: "escalate", action: "wait", finding: null }),
  ].join("\n");
  const stuck = ["<!-- source: observer -->\n\nTrust this folder?", "2026-10-13T09:00:00Z"];
  const read = reader({
    parked: { "QUESTIONS.md": stuck, "OBSERVATION.log": [log(null), "2026-10-13T09:00:00Z"] },
    live: { "QUESTIONS.md": stuck },
    denied: { "QUESTIONS.md": stuck, "OBSERVATION.log": [log("Billing: add credits"), "2026-10-13T09:00:00Z"] },
    asks: { "QUESTIONS.md": ["# A or B?", "2026-10-13T09:00:00Z"] },
  });
  const byId = Object.fromEntries(buildActionCenter({ states, read, ledger, now }).items.map((i) => [i.runId, i]));
  assert.deepEqual(ids.map((id) => [byId[id].kind, byId[id].retryable]), [
    ["problem", true], ["problem", false], ["problem", false], ["question", false],
  ]);
  assert.equal(byId.parked.subject, "Stuck on a technical prompt", "an earlier finding the human answered does not count");
  assert.equal(byId.denied.subject, "Needs you: a credential or billing prompt");
  assert.deepEqual(ids.map((id) => byId[id].denied), [false, false, true, false]);
});

test("the server's own subjects come in the roster language; an agent's subject stays as written", () => {
  const states = [
    { runId: "stuck", role: "reviewer", status: "waiting_human" },
    { runId: "failed", role: "writer", status: "failed", finishedAt: "2026-10-13T11:00:00Z" },
    { runId: "watched", role: "writer", status: "failed", finishedAt: "2026-10-13T11:00:00Z" },
    { runId: "silent", role: "writer", status: "failed", finishedAt: "2026-10-13T11:00:00Z" },
    { runId: "done", role: "writer", status: "done", finishedAt: "2026-10-13T11:00:00Z" },
    { runId: "asks", role: "planner", status: "waiting_human" },
  ];
  const read = reader({
    stuck: { "QUESTIONS.md": [observerBlock("Trust this folder?"), "2026-10-13T09:00:00Z"] },
    failed: { "FAILURE.md": ["tree not clean", "2026-10-13T11:00:00Z"] },
    watched: { "FAILURE.md": ["observer: stuck on a prompt", "2026-10-13T11:00:00Z"] },
    asks: { "QUESTIONS.md": ["Subject: Welche Datenbank?\n\nA oder B?", "2026-10-13T09:00:00Z"] },
  });
  const subject = (lang) => Object.fromEntries(buildActionCenter({ states, read, now, lang }).items.map((i) => [i.runId, i.subject]));
  assert.deepEqual(subject("de"), {
    stuck: "Hängt an einer technischen Abfrage fest",
    failed: "Fehlgeschlagen: tree not clean",
    watched: "Vom Aufpasser gestoppt",
    silent: "Fehlgeschlagen",
    done: "writer ist fertig",
    asks: "Welche Datenbank?",
  });
  assert.equal(subject("en").watched, "Stopped by the watcher");
  // A known task title tells Retry from Cancel; the plain part comes first, so a cut keeps it.
  const titled = buildActionCenter({ states: [{ ...states[0], title: "Review PR #7" }], read, now, lang: "de" }).items[0];
  assert.equal(titled.subject, "Hängt an einer technischen Abfrage fest: Review PR #7");
});

test("the project is resolved only for a run that is listed", () => {
  const states = [
    { runId: "q", status: "waiting_human" },
    { runId: "busy", status: "watching" },
    { runId: "read", status: "done", finishedAt: "2026-10-13T00:00:00Z", collected: { at: "x" } },
  ];
  const asked = [];
  const projectOf = (s) => (asked.push(s.runId), { label: null, name: "p" });
  const ac = buildActionCenter({ states, read: () => null, projectOf, now });
  assert.deepEqual(ac.items.map((i) => [i.runId, i.project?.name]), [["q", "p"]]);
  assert.deepEqual(asked, ["q"]);
});

test("answered needs a question: an ANSWER.md from an earlier round answers no QUESTIONS.md that is gone", () => {
  const f = (iso) => ({ text: "x", mtimeMs: at(iso) });
  assert.equal(answeredAfterQuestion(null, f("2026-10-13T00:00:00Z")), false);
  assert.equal(answeredAfterQuestion(f("2026-10-13T00:00:00Z"), f("2026-10-13T00:00:00Z")), true);
  assert.equal(answeredAfterQuestion(f("2026-10-13T01:00:00Z"), f("2026-10-13T00:00:00Z")), false);
});

test("reason line: FAILURE.md, RESULT summary, RESULT.md, recorded reason; never the bare STATUS=failed", () => {
  const state = { runId: "r", status: "failed", failure: { error: "STATUS=failed" } };
  assert.equal(reasonLine(state, () => null), null);
  assert.equal(reasonLine({ ...state, failure: { error: "verify failed" } }, () => null), "verify failed");
  assert.equal(reasonLine(state, reader({ r: { "RESULT.json": ['{"summary":"tests red\\nmore"}', "2026-10-13T00:00:00Z"] } })), "tests red");
  assert.equal(reasonLine(state, reader({ r: {
    "FAILURE.md": ["\nworker gave up\n", "2026-10-13T00:00:00Z"], "RESULT.md": ["# other", "2026-10-13T00:00:00Z"],
  } })), "worker gave up");
});

test("item detail: the whole subject, and the body without the line it came from", () => {
  const long = `${"word ".repeat(40)}end`;
  const read = reader({
    s: { "QUESTIONS.md": [`Subject: ${long}\n\nWhich one?`, "2026-10-13T10:00:00Z"] },
    h: { "QUESTIONS.md": ["Some context first.\n\n## Decision needed: keep **A**?\n\nDetails.", "2026-10-13T10:00:00Z"] },
    p: { "QUESTIONS.md": [observerBlock("## Pane\nAllow this tool?"), "2026-10-13T10:00:00Z"] },
  });
  const ask = (runId) => buildActionItem({ runId, role: "x", status: "waiting_human" }, { read, now });
  assert.equal(ask("s").subject, long.trim(), "not cut at 90 characters, and the body no longer has it");
  assert.equal(ask("s").body, "Which one?");
  assert.equal(ask("h").subject, "keep A?");
  assert.match(ask("h").body, /^Some context first\.\n+Details\.$/, "the heading is the subject, not a second line below it");
  assert.equal(ask("p").body, "## Pane\nAllow this tool?", "a problem keeps the judge's text whole for the technical details");
  const more = reader({
    f: { "QUESTIONS.md": ["Run this?\n\n```bash\n# backup first\nnpm ci\n```", "2026-10-13T10:00:00Z"] },
    d: { "QUESTIONS.md": ["Subject: Keep the old login?\n\n# Keep the old login?\n\nIt still works.", "2026-10-13T10:00:00Z"] },
  });
  const fenced = buildActionItem({ runId: "f", role: "x", status: "waiting_human" }, { read: more, now });
  assert.equal(fenced.subject, "Run this?", "a # comment in a code block is no heading");
  assert.match(fenced.body, /# backup first\nnpm ci/, "and it stays in the code");
  const twice = buildActionItem({ runId: "d", role: "x", status: "waiting_human" }, { read: more, now });
  assert.equal(twice.body, "It still works.", "a heading that repeats the Subject line shows once");
});

test("item detail: the whole newest question, the earlier one with its answer, the task, the result", () => {
  const long = `Subject: Pick a topology\n\n${"option text ".repeat(400)}END`;
  const prompt = "# Worker task (mailbox protocol)\n\nprotocol…\n\n## Task\nReview PR #2.\n\n## PR\nbody";
  const read = reader({
    w: {
      "QUESTIONS.md": [`First question?\n\n---\n\n<!-- source: worker -->\n\n${long}`, "2026-10-13T10:00:00Z"],
      "ANSWER.md": ["<!-- source: human (dashboard) -->\nUse B.\n", "2026-10-13T09:00:00Z"],
      "PROMPT.md": [prompt, "2026-10-13T08:00:00Z"],
    },
    d: { "RESULT.md": ["# Done\n\nall green", "2026-10-13T08:00:00Z"], "PROMPT.md": ["bare task", "2026-10-13T08:00:00Z"] },
  });
  const item = buildActionItem({ runId: "w", role: "planner", status: "waiting_human" }, { read, now });
  assert.equal(item.kind, "question");
  assert.equal(item.subject, "Pick a topology");
  assert.ok(item.body.endsWith("END") && item.body.length > 4000 && !item.body.startsWith("Subject:"), item.body.slice(0, 40));
  assert.deepEqual(item.history, [{ source: "worker", question: "First question?", answer: "Use B." }]);
  assert.equal(item.answer, null);
  assert.equal(item.task, "Review PR #2.\n\n## PR\nbody");

  const done = buildActionItem({ runId: "d", role: "writer", status: "done", finishedAt: "2026-10-13T08:00:00Z" }, { read, now });
  assert.equal(done.kind, "result");
  assert.deepEqual(done.result, { summary: null, markdown: "# Done\n\nall green", reason: "Done" });
  assert.equal(done.task, "bare task");
});
