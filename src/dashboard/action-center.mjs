// The Inbox: every run that waits on Benni, one flat list like an e-mail inbox.
// A question is a worker asking for a decision; a problem is a run stuck on
// something technical (an observer escalation) or a run that failed; a result
// is finished work nobody has read. waiting_decision is a capacity park, not
// Benni's, and scheduled jobs (role cron-*) report on their job card instead.
//
// Pure: the server hands in the run states and a mailbox reader,
// `read(runId, name) → { text, mtimeMs } | null`.

import { buildRunRow, isCron } from "./data.mjs";
import { t } from "./i18n.mjs";
import { questionBlocks, stripSourceMarkers } from "../runs/runs.mjs";

export { questionBlocks };

/** Order of the kinds in the list; inside a kind the newest comes first. */
const KIND_RANK = { question: 0, problem: 1, result: 2 };

const SUBJECT_MAX = 90;
const TASK_MAX = 4 * 1024;
const RESULT_MAX = 64 * 1024;

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

function clip(text, max) {
  const s = oneLine(text);
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// No `$`: before a U+2028, where `.` stops, it backtracked through a space run.
const SUBJECT_LINE = /^subject:[ \t]*([^\n]+)/i;
const HEADING = /^#{1,6}\s+(?=\S)/;
const QUESTION_PREFIX = /^(?:frage|question|decision needed)\s*:\s*/i;
const plain = (s) => s.replace(/\*\*|`/g, "");

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const headingText = (line) => oneLine(plain(line.replace(HEADING, "")).replace(QUESTION_PREFIX, ""));

/** The first heading outside a fenced code block, where `# …` is a comment: its line index, or -1. */
function firstHeading(lines) {
  let fence = null;
  for (const [i, line] of lines.entries()) {
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null; // md.js closes a fence the same way
    } else if (FENCE.test(line)) fence = line.match(FENCE)[1];
    else if (HEADING.test(line)) return i;
  }
  return -1;
}

/**
 * A question's subject, whole, and its body without the line the subject came
 * from: a `Subject:` first line (and a heading right below that repeats it) or
 * the first heading. Else the task's title or the first sentence, and the body
 * stays whole.
 */
function questionParts(text, titles = []) {
  const lines = String(text ?? "").split("\n");
  const without = (...at) => lines.filter((l, i) => !at.includes(i)).join("\n").trim();
  const subject = lines[0]?.trim().match(SUBJECT_LINE)?.[1];
  if (subject) {
    const s = oneLine(plain(subject));
    const next = lines.findIndex((l, i) => i > 0 && l.trim());
    const repeats = next !== -1 && HEADING.test(lines[next]) && headingText(lines[next]) === s;
    return { subject: s, body: repeats ? without(0, next) : without(0) };
  }
  const at = firstHeading(lines);
  if (at !== -1) return { subject: headingText(lines[at]), body: without(at) };
  const title = titles.find((t) => typeof t === "string" && t.trim());
  const first = lines.map((l) => l.trim()).find(Boolean) ?? "";
  return { subject: oneLine(title ?? plain(first).split(/(?<=[.?!])\s/)[0]), body: lines.join("\n").trim() };
}

/** The list's subject: a `Subject:` first line, a first heading, the task's title, or the first sentence. */
export const questionSubject = (text, titles) => clip(questionParts(text, titles).subject, SUBJECT_MAX);

function resultJson(state, read) {
  try {
    return JSON.parse(read(state.runId, "RESULT.json")?.text ?? "");
  } catch {
    return null;
  }
}

const firstLine = (text) => String(text ?? "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? null;

/**
 * One line on how a finished run ended: the worker's FAILURE.md, its RESULT
 * summary, the first line of RESULT.md, or the reason STATE recorded.
 * `STATUS=failed` says nothing the status does not.
 */
export function reasonLine(state, read) {
  const failure = state.status === "failed" ? firstLine(read(state.runId, "FAILURE.md")?.text) : null;
  const recorded = state.failure?.error && state.failure.error !== "STATUS=failed" ? state.failure.error : null;
  const line = failure ?? firstLine(resultJson(state, read)?.summary) ?? firstLine(read(state.runId, "RESULT.md")?.text) ?? recorded;
  return line ? clip(line, 300) : null;
}

/** Answered once ANSWER.md is at least as new as QUESTIONS.md — the rule of classifyMailbox. */
export function answeredAfterQuestion(questions, answer) {
  return Boolean(answer && questions) && answer.mtimeMs >= questions.mtimeMs;
}

/**
 * The observer's newest escalation in OBSERVATION.log. Every escalation path
 * logs a decision; only a deny pattern (credential or billing wording) sets
 * its `finding`.
 */
function lastEscalation(log) {
  return String(log ?? "").split("\n").map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((e) => e?.kind === "decision" && e.action === "escalate").at(-1) ?? null;
}

/** The spender's spawn window, where an answer to a parked run takes effect. */
export function spenderWindow(roster, defaults) {
  const hour = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d);
  const knobs = roster?.usage_spender ?? {};
  return { start: hour(knobs.spawn_from, defaults.spawn_from), end: hour(knobs.spawn_until, defaults.spawn_until) };
}

/**
 * The inbox item of one run, or null when it waits on nobody.
 *
 * Retry is offered only on a technical stop of a run the usage-spender parked:
 * the spender resumes it as a fresh run with the stop explained. A live worker
 * stuck in a prompt never reads ANSWER.md and nothing would watch it again, and
 * the observer reads any answer to a credential or billing prompt as the
 * human's approval of it: those get Cancel only.
 *
 * A problem's subject is the server's own sentence in the roster language
 * (`lang`); `denied` and `reason` (a failed run's reason line) carry what the
 * page needs to explain it, so it never parses the subject.
 * @param ctx { read, projectOf, ledger, resumeWindow, now, lang }
 */
export function inboxItem(state, ctx) {
  const { read, projectOf = () => null, ledger = new Map(), resumeWindow = null, now = Date.now(), lang = "en" } = ctx;
  if (isCron(state)) return null;
  const row = buildRunRow(state, { now });
  const role = String(state.role ?? "run").replace(/^specialist:/, "");
  const spender = ledger.get(state.runId);
  // The project only for a listed run: resolving it can cost a git call, and most runs wait on nobody.
  const item = (fields) => ({
    id: `run:${state.runId}`, runId: state.runId, project: projectOf(state), worker: row.worker, role,
    status: state.status, parked: false, resumeWindow: null, source: null, retryable: false, denied: false, reason: null, ...fields,
  });
  const since = (ms) => (Number.isFinite(ms) ? now - ms : row.ageMs);

  if (state.status === "waiting_human") {
    const questions = read(state.runId, "QUESTIONS.md");
    // The answer is in and the run's status has not caught up yet: nothing to do here.
    if (answeredAfterQuestion(questions, read(state.runId, "ANSWER.md"))) return null;
    const last = questionBlocks(questions?.text).at(-1);
    const source = last?.source === "observer" ? "observer" : "worker";
    const denied = source === "observer" && Boolean(lastEscalation(read(state.runId, "OBSERVATION.log")?.text)?.finding);
    // The spender stopped this run's worker; an answer resumes it in the next window.
    const parked = Boolean(spender?.parked);
    let subject;
    if (denied) subject = t(lang, "Needs you: a credential or billing prompt");
    // The task's title, when known, tells Retry from Cancel; first the plain part, which the clip keeps.
    else if (source === "observer") {
      const title = state.title || spender?.title;
      subject = title ? t(lang, "Stuck on a technical prompt: {title}", { title }) : t(lang, "Stuck on a technical prompt");
    }
    else if (last) subject = questionSubject(last.text, [state.title, spender?.title]);
    else subject = clip(state.title || spender?.title || t(lang, "{role} is waiting for your answer", { role }), SUBJECT_MAX);
    return item({
      kind: source === "observer" ? "problem" : "question",
      subject,
      ageMs: since(questions?.mtimeMs ?? Date.parse(state.updatedAt ?? "")),
      parked,
      resumeWindow: parked ? resumeWindow : null,
      source,
      retryable: source === "observer" && !denied && parked,
      denied,
    });
  }
  if (!row.uncollected) return null;
  const ageMs = since(Date.parse(state.finishedAt ?? ""));
  if (state.status === "failed") {
    const reason = reasonLine(state, read);
    // The watcher's own reason is for whoever set team-up up: the page shows it under "Technical details".
    let subject = t(lang, "Failed|subject");
    if (reason?.startsWith("observer:")) subject = t(lang, "Stopped by the watcher");
    else if (reason) subject = t(lang, "Failed: {reason}", { reason });
    return item({ kind: "problem", subject: clip(subject, SUBJECT_MAX), ageMs, reason });
  }
  const title = state.title || spender?.title;
  return item({ kind: "result", ageMs, subject: clip(title || reasonLine(state, read) || t(lang, "{role} finished", { role }), SUBJECT_MAX) });
}

/** Every inbox item, questions first, then problems, then results; newest first inside a kind. */
export function buildActionCenter({ states, ...ctx }) {
  const items = states.map((s) => inboxItem(s, ctx)).filter(Boolean);
  items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity));
  const counts = { question: 0, problem: 0, result: 0 };
  for (const i of items) counts[i.kind] += 1;
  return { items, counts };
}

/** The task as the worker got it: PROMPT.md below the mailbox protocol's `## Task` heading. */
function taskExcerpt(prompt) {
  const text = String(prompt ?? "");
  const at = text.search(/^## Task[ \t]*$/m);
  const task = (at === -1 ? text : text.slice(at).replace(/^## Task[ \t]*\n/, "")).trim();
  return task.length > TASK_MAX ? `${task.slice(0, TASK_MAX).trimEnd()}\n…` : task || null;
}

/**
 * One item in full: the newest question untruncated, the earlier ones, the
 * task, and the result. ANSWER.md is overwritten by every answer, so only the
 * newest answer is known: it answers the newest question when it is newer
 * than QUESTIONS.md, else the one before.
 */
export function buildActionItem(state, ctx) {
  const { read } = ctx;
  const item = inboxItem(state, ctx);
  const questions = read(state.runId, "QUESTIONS.md");
  const answer = read(state.runId, "ANSWER.md");
  const blocks = questionBlocks(questions?.text);
  const last = blocks.at(-1) ?? null;
  const answerText = answer ? stripSourceMarkers(answer.text).trim() : null;
  const answeredNow = answeredAfterQuestion(questions, answer);
  const parts = last ? questionParts(last.text, [state.title, ctx.ledger?.get(state.runId)?.title]) : null;
  // A problem's subject is the server's sentence; the judge's text stays whole for "Technical details".
  const problem = item?.kind === "problem";
  const history = blocks.slice(0, -1).map((b) => ({ source: b.source, question: b.text, answer: null }));
  if (answerText && !answeredNow && questions) {
    if (history.length) history.at(-1).answer = answerText;
    else history.push({ source: null, question: null, answer: answerText });
  }
  let result = null;
  if (["done", "failed"].includes(state.status)) {
    const markdown = read(state.runId, "RESULT.md", RESULT_MAX)?.text ?? null;
    const summary = resultJson(state, read)?.summary ?? null;
    if (markdown || summary) result = { summary: summary == null ? null : String(summary), markdown, reason: reasonLine(state, read) };
  }
  return {
    ...(item ?? { id: `run:${state.runId}`, runId: state.runId, kind: null, status: state.status }),
    // The list cuts the subject to a row; the item shows it whole and leaves it out of the body.
    subject: problem || item?.kind === "result" ? item.subject : parts?.subject ?? item?.subject ?? state.title ?? null,
    body: last ? (problem ? last.text : parts.body) : null,
    source: last?.source ?? item?.source ?? null,
    answer: answeredNow ? answerText : null,
    history,
    task: taskExcerpt(read(state.runId, "PROMPT.md")?.text),
    result,
  };
}
