const $ = (sel) => document.querySelector(sel);

let adminChallengeId = null;

// The markup is the list of views: a new <section class="view"> routes without
// touching this file.
const VIEW_NAMES = new Set([...document.querySelectorAll(".view")].map((view) => view.dataset.view));

// Old links keep working after a view was renamed or split.
const ROUTE_ALIASES = { cron: "automation" };
// Views whose hash has a second part: the open item (#/actions/<runId>, #/specialists/<id>).
const ROUTES_WITH_ITEM = new Set(["actions", "specialists"]);

// Expert view: per browser, never synced (LOCAL_ONLY_KEYS). Off, the nav and
// the views leave out what is technical ([data-expert] in the markup, isExpert()
// in the renderers); a direct link still opens a hidden view.
const EXPERT_KEY = "teamup.expert";
const isExpert = () => readStored(EXPERT_KEY, false) === true;
document.documentElement.classList.toggle("is-expert", isExpert());
// Views that load on entry rather than on the five-second cycle.
const onEnter = {};

function applyRoute() {
  const match = location.hash.match(/^#\/([^/?#]+)(?:\/([\w.-]*))?$/);
  const wanted = match ? ROUTE_ALIASES[match[1]] || match[1] : null;
  const route = wanted && VIEW_NAMES.has(wanted) ? wanted : "overview";
  const canonicalHash = ROUTES_WITH_ITEM.has(route) && match?.[2] ? `#/${route}/${match[2]}` : `#/${route}`;
  if (location.hash !== canonicalHash) history.replaceState(null, "", canonicalHash);
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.dataset.view === route);
  });
  document.querySelectorAll(".sidebar-nav [data-route]").forEach((link) => {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (!$("#app").classList.contains("hidden")) onEnter[route]?.();
  if (route === "tim") requestAnimationFrame(fitTimFrame);
  document.title = `${document.querySelector(`.view[data-view="${route}"] .page-head h1`)?.textContent || "team-up"} · team-up`;
}

window.addEventListener("hashchange", applyRoute);
// Before the first route: the page title is read from the view's translated h1.
translateStatic();
applyRoute();

const dashboardMetrics = { runCounts: null, usage: null, tim: null };

function usageLevelName(level) {
  return ({ red: t("Critical"), amber: t("Warning"), ok: t("OK") })[level] || t("Unknown");
}

function updateNavBadge(id, text, tone = "", visible = Boolean(text), title = "") {
  const badge = $(`#${id}`);
  badge.textContent = text;
  badge.classList.toggle("hidden", !visible);
  badge.classList.toggle("is-red", tone === "red");
  badge.classList.toggle("is-amber", tone === "amber");
  badge.title = title;
}

// Rank 0–1 on TIM's scale (taskPriorityRank): P0/P1 or the older critical/high.
const URGENT_PRIORITIES = new Set(["P0", "P1", "0", "1", "CRITICAL", "HIGH"]);

function updateDashboardMetrics() {
  const { active = 0, waiting = 0, failedUncollected: failed = 0 } = dashboardMetrics.runCounts || {};
  // Waiting runs count as active; they wait for you and are in the inbox.
  $("#kpi-active-runs").textContent = String(Math.max(0, active - waiting));

  const runsTone = waiting || failed ? "red" : "";
  const runsBadge = active ? String(active) : failed ? "!" : "";
  updateNavBadge("badge-runs", runsBadge, runsTone, Boolean(runsBadge), [
    waiting ? tp(waiting, { one: "{n} run waiting for you", other: "{n} runs waiting for you" }) : "",
    failed ? tp(failed, { one: "{n} failed run not read yet", other: "{n} failed runs not read yet" }) : "",
  ].filter(Boolean).join(" · "));

  const windows = Object.entries(dashboardMetrics.usage?.windows || {})
    .filter(([, window]) => typeof window.usedPct === "number")
    .sort(([keyA, a], [keyB, b]) => b.usedPct - a.usedPct || keyA.localeCompare(keyB));
  const worst = windows[0];
  $("#kpi-worst-usage").textContent = worst ? `${worst[1].usedPct}%` : "—";
  $("#kpi-worst-usage-detail").textContent = worst
    ? `${worst[0]} · ${usageLevelName(worst[1].level)}`
    : t("No usage readings yet");
  const usageLevel = Object.values(dashboardMetrics.usage?.windows || {}).some((window) => window.level === "red")
    ? "red"
    : Object.values(dashboardMetrics.usage?.windows || {}).some((window) => window.level === "amber")
      ? "amber"
      : "";
  updateNavBadge("badge-overview", usageLevel ? usageLevelName(usageLevel) : "",
    usageLevel, Boolean(usageLevel), usageLevel ? t("Usage level: {level}", { level: usageLevelName(usageLevel) }) : "");

  const tim = dashboardMetrics.tim;
  const installed = Boolean(tim?.installed);
  const p1p2 = installed
    ? (tim.projects || []).flatMap((project) => project.items || [])
      .filter((item) => item.kind === "task" && URGENT_PRIORITIES.has(String(item.priority || "").trim().toUpperCase())).length
    : 0;
  $("#kpi-tim-tile").classList.toggle("hidden", !installed);
  $("#kpi-tim-tasks").textContent = String(p1p2);
  updateNavBadge("badge-tim", p1p2 ? String(p1p2) : "", "", p1p2 > 0,
    p1p2 ? tp(p1p2, { one: "{n} open high-priority TIM task", other: "{n} open high-priority TIM tasks" }) : "");
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.method && opts.method !== "GET") headers["X-Team-Up-CSRF"] = "1";
  const res = await fetch(path, {
    credentials: "same-origin",
    ...opts,
    headers,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { status: res.status });
  }
  return res.json();
}

function showLogin() {
  $("#login").classList.remove("hidden");
  $("#app").classList.add("hidden");
}

function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("#token-input").value.trim();
  const errEl = $("#login-error");
  errEl.classList.add("hidden");
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      errEl.textContent = t("This access key is not valid.");
      errEl.classList.remove("hidden");
      return;
    }
    $("#token-input").value = "";
    await pullPrefs().catch(() => {});
    showApp();
    startPolling();
  } catch {
    errEl.textContent = t("Could not sign in. Try again.");
    errEl.classList.remove("hidden");
  }
});

let selectedRun = null;
let selectedSession = null;
let listTimer = null;
let paneTimer = null;

$("#active-only").addEventListener("change", () => refreshRuns());

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  // innerHTML leaves `"` alone; templates put this inside title="…" too.
  return d.innerHTML.replace(/"/g, "&quot;");
}

/**
 * A yes/no question in a <dialog>, for what cannot be undone. `title` and
 * `text` are HTML (esc() or withNames()); resolves true on yes, and focus goes
 * back to where it was.
 */
function confirmDialog({ title, text, yes, no = t("Cancel") }) {
  const dialog = $("#confirm");
  // A second click while it is open: one question, one answer.
  if (dialog.open) return Promise.resolve(false);
  $("#confirm-title").innerHTML = title;
  $("#confirm-text").innerHTML = text;
  $("#confirm-yes").textContent = yes;
  $("#confirm-no").textContent = no;
  const back = document.activeElement;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      back?.focus?.();
      resolve(dialog.returnValue === "yes");
    }, { once: true });
  });
}

// Brand colours live in app.css; this only decides which one a string earns.
// Last match wins, so "cursor:grok-4.5-high" is xAI and "hermes:deepseek-v4-pro"
// is DeepSeek — the model says more than the CLI that runs it.
const PROVIDER_TOKENS = {
  anthropic: "anthropic", claude: "anthropic",
  openai: "openai", codex: "openai", gpt: "openai",
  cursor: "cursor", composer: "cursor",
  xai: "xai", grok: "xai",
  deepseek: "deepseek",
  moonshotai: "moonshot", moonshot: "moonshot", kimi: "moonshot",
  openrouter: "openrouter",
  google: "google", gemini: "google", agy: "google",
  meta: "meta", llama: "meta",
  mistral: "mistral",
  qwen: "qwen", alibaba: "qwen",
  hermes: "hermes", opencode: "opencode",
};

function providerOf(...hints) {
  let hit = null;
  for (const token of hints.filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9]+/)) {
    if (PROVIDER_TOKENS[token]) hit = PROVIDER_TOKENS[token];
  }
  return hit;
}

function providerAttr(...hints) {
  const hit = providerOf(...hints);
  return hit ? ` data-provider="${hit}"` : "";
}

function levelBadge(level) {
  const tone = level === "red" ? "red" : level === "amber" ? "amber" : "ok";
  return `<span class="badge ${tone}">${esc(usageLevelName(tone))}</span>`;
}

/**
 * STALE is a button, not a label: the cause differs every time a vendor changes
 * its TUI, so one click dispatches an agent to fix the collector and prove it.
 */
function collectorBadge(key, collector, stale) {
  // Auth first, and independent of staleness: a dead login is visible in the
  // collector ring long before the window crosses the 40-minute stale mark, and
  // "FIX IT" would dispatch a repair agent that cannot log in for you.
  if (collector?.auth_failure) {
    const n = collector.auth_failure_streak;
    const cli = key.split(":")[0];
    const title = n > 1 ? t("The usage reader could not sign in, {n} times in a row: sign in to {cli} again.", { n, cli })
      : t("The usage reader could not sign in: sign in to {cli} again.", { cli });
    return ` <span class="badge red" title="${esc(title)}">${esc(t("Sign-in failed"))}</span>`;
  }
  return stale ? staleBadge(key, collector) : "";
}

function staleBadge(key, collector) {
  const cli = key.split(":")[0];
  const reason = collector?.last_reason;
  const title = reason ? ` title="${esc(t("Last reading failed: {reason}", { reason }))}"` : "";
  if (collector?.repair?.running) {
    return ` <button class="badge stale" data-repair-session="${esc(collector.repair.session)}"${title}>${esc(t("Being fixed…"))}</button>`;
  }
  return ` <button class="badge stale" data-repair="${esc(cli)}"${title}>${esc(t("Out of date · fix it"))}</button>`;
}

/** Derived from /api/usage, so a reload shows the same thing. */
function repairStatusLine(collectors = {}) {
  const entries = Object.entries(collectors);
  // Collector-level, not per row: a CLI whose login died may have no windows in
  // usage.json at all, and then no row exists to carry the warning.
  const dead = entries.filter(([, c]) => c?.suggest_disable).map(([cli]) => cli);
  if (dead.length) {
    return dead.map((cli) => t("⚠ {cli}: sign-in failed {n} times in a row. If the subscription is gone, switch the account off under Settings → Accounts; nothing is switched off by itself.",
      { cli, n: collectors[cli].auth_failure_streak })).join(" ");
  }
  const running = entries.filter(([, c]) => c?.repair?.running).map(([cli]) => cli);
  if (running.length) {
    return t("⟳ Fixing the usage reading for {clis}. This panel updates itself.", { clis: new Intl.ListFormat(LANG, { type: "conjunction" }).format(running) });
  }
  const DAY = 24 * 3600 * 1000;
  const reported = entries.filter(([, c]) =>
    c?.repair?.report && Date.now() - Date.parse(c.repair.started_at || 0) < DAY);
  if (reported.length) {
    return t("The last repair wrote a report: {file}", { file: `~/.team-up/usage-repair-${reported[0][0]}.report.md` });
  }
  return "";
}

/** A header cell under its English key: saved hidden columns (tagColumns) stay hidden in every language. */
const th = (key, label) => `<th data-col-key="${esc(key)}">${esc(label)}</th>`;

async function refreshRuns() {
  const data = await api(`/api/runs?active=${$("#active-only").checked ? "1" : "0"}`);
  dashboardMetrics.runCounts = data.counts;
  runsRows = data.runs;
  updateDashboardMetrics();
  updateAttention();
  renderProjects();
  const visibleRuns = data.runs;
  const rows = visibleRuns.map((r) => `
    <tr class="clickable" data-run="${esc(r.runId)}"${providerAttr(r.worker)}>
      <td><code>${esc(r.runId.slice(-8))}</code></td>
      <td translate="no">${esc(r.role)}</td>
      <td translate="no">${esc(r.status)}</td>
      <td translate="no">${esc(r.worker || "—")}</td>
      <td translate="no">${esc(r.project || "—")}</td>
      <td class="path" translate="no">${esc(r.cwd || "—")}</td>
      <td translate="no">${esc(r.age || "—")}</td>
      <td translate="no">${esc(r.heartbeatAge || "—")}</td>
    </tr>`).join("");
  $("#runs-table").innerHTML = `<table>
    <thead><tr>${th("Run", t("Run"))}${th("Role", t("Role"))}${th("Status", t("Status"))}${th("Worker", t("Worker"))}${
      th("Project", t("Project"))}${th("CWD", t("Folder"))}${th("Age", t("Age"))}${th("HB", t("Last sign of life"))}</tr></thead>
    <tbody>${rows || `<tr><td colspan="8">${esc(t("No runs"))}</td></tr>`}</tbody></table>`;
  $("#runs-table").querySelectorAll("tr[data-run]").forEach((tr) => {
    tr.addEventListener("click", () => selectRun(tr.dataset.run));
  });
  if (selectedRun) selectRun(selectedRun);
}

const RUN_BUTTONS = [
  { action: "cancel", label: t("Cancel run"), when: (s) => !TERMINAL_RUN.has(s), title: t("Mark it cancelled and stop the worker's terminal") },
  { action: "fail", label: t("Mark failed…"), when: (s) => !TERMINAL_RUN.has(s), title: t("With a reason: the insights job counts failures by reason") },
  { action: "collect", label: t("Mark as read"), when: (s, r) => TERMINAL_RUN.has(s) && !r.collected, title: t("You have read the result; it leaves the open list") },
  { action: "merged", label: t("Outcome: merged"), when: (s, r) => TERMINAL_RUN.has(s) && !r.outcome, title: t("The work landed") },
  { action: "discarded", label: t("Outcome: discarded"), when: (s, r) => TERMINAL_RUN.has(s) && !r.outcome, title: t("The work was not kept") },
];
const TERMINAL_RUN = new Set(["done", "failed", "cancelled"]);

function renderRunActions(runId, state) {
  const el = $("#run-actions");
  const status = state?.status || "unknown";
  const buttons = RUN_BUTTONS.filter((b) => b.when(status, state || {}));
  el.innerHTML = `<strong><code>${esc(runId.slice(-8))}</code> · <span translate="no">${esc(status)}</span>${state?.collected ? ` · ${esc(t("read"))}` : ""}${
    state?.outcome?.value ? ` · <span translate="no">${esc(state.outcome.value)}</span>` : ""}</strong>${buttons.map((b) =>
    `<button type="button" data-run-action="${b.action}" title="${esc(b.title)}"${b.action === "cancel" || b.action === "fail" ? ' class="danger"' : ""}>${esc(b.label)}</button>`).join("")}`;
  el.dataset.run = runId;
  el.classList.remove("hidden");
}

$("#run-actions").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-run-action]");
  if (!btn) return;
  const runId = $("#run-actions").dataset.run;
  const action = btn.dataset.runAction;
  let reason;
  if (action === "fail") {
    reason = prompt(t("Why did this run fail? (one line)"));
    if (!reason) return;
  } else if (action === "cancel" && !confirm(t("Cancel this run and stop its worker?"))) {
    return;
  }
  btn.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/action`, { method: "POST", body: JSON.stringify({ action, reason }) });
  } catch (err) {
    alert(t("Refused: {error}", { error: err.message }));
  }
  await refreshRuns();
});

async function selectRun(runId) {
  selectedRun = runId;
  const data = await api(`/api/runs/${runId}`);
  renderRunActions(runId, data.state);
  $("#runs-table").querySelectorAll("tr[data-run]").forEach((tr) => tr.classList.toggle("selected", tr.dataset.run === runId));
  const parts = [];
  if (data.mailbox?.STATUS) parts.push(`=== STATUS ===\n${data.mailbox.STATUS}`);
  if (data.mailbox?.["PROMPT.md"]) parts.push(`=== PROMPT.md ===\n${data.mailbox["PROMPT.md"]}`);
  if (data.mailbox?.["RESULT.md"]) parts.push(`=== RESULT.md ===\n${data.mailbox["RESULT.md"]}`);
  const el = $("#run-detail");
  el.textContent = parts.join("\n\n") || t("No mailbox files");
  el.classList.remove("hidden");
}

async function refreshTmux() {
  const data = await api("/api/tmux");
  const rows = data.sessions.map((s) => `
    <tr class="clickable ${s.orphan ? "orphan" : ""}" data-session="${esc(s.session)}">
      <td>${esc(s.session)}${s.orphan ? " ⚠" : ""}</td>
      <td>${esc(s.runId || "—")}</td>
      <td>${esc(s.role || "—")}</td>
      <td>${esc(s.status || "—")}</td>
    </tr>`).join("");
  $("#tmux-table").innerHTML = `<table>
    <thead><tr>${th("Session", t("Session"))}${th("Run", t("Run"))}${th("Role", t("Role"))}${th("Status", t("Status"))}</tr></thead>
    <tbody>${rows || `<tr><td colspan="4">${esc(t("No sessions"))}</td></tr>`}</tbody></table>`;
  $("#tmux-table").querySelectorAll("tr[data-session]").forEach((tr) => {
    tr.addEventListener("click", () => selectSession(tr.dataset.session));
  });
}

async function refreshClaudeSessions() {
  const data = await api("/api/claude-sessions");
  const home = /^\/home\/[^/]+/;
  const rows = data.sessions.map((s) => {
    const where = s.tmux ? `tmux ${s.tmux}` : s.entrypoint === "claude-desktop" ? t("desktop app") : (s.entrypoint || "—");
    // A session in tmux has a real keyboard in the terminal overlay; the
    // message inbox is only for the ones without one.
    const steer = s.tmux
      ? `<button type="button" data-claude-open="${esc(s.tmux)}">${esc(t("Terminal"))}</button>`
      : s.canMessage ? `<button type="button" data-claude-message>${esc(t("Message"))}</button>` : "";
    return `<tr data-pid="${s.pid}" data-name="${esc(s.name || "")}" data-status="${esc(s.status || "")}">
      <td>${esc(s.name || "—")}</td>
      <td>${esc(where)}</td>
      <td>${esc(s.status || "—")}</td>
      <td title="${esc(s.cwd || "")}">${esc((s.cwd || "—").replace(home, "~"))}</td>
      <td>${s.updatedAt ? esc(fmtDateTime(new Date(s.updatedAt).toISOString())) : "—"}</td>
      <td class="row-actions">${steer} <button type="button" data-claude-stop class="danger">${esc(t("Stop"))}</button></td>
    </tr>`;
  }).join("");
  $("#claude-table").innerHTML = `<table>
    <thead><tr>${th("Name", t("Name"))}${th("Where", t("Where"))}${th("Status", t("Status"))}${th("CWD", t("Folder"))}${
      th("Last active", t("Last active"))}<th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6">${esc(t("No sessions"))}</td></tr>`}</tbody></table>`;
}

$("#claude-table").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  const tr = btn?.closest("tr[data-pid]");
  if (!tr) return;
  if (btn.dataset.claudeOpen) {
    selectSession(btn.dataset.claudeOpen);
    return;
  }
  const who = { name: tr.dataset.name || t("this session"), pid: tr.dataset.pid };
  try {
    if (btn.dataset.claudeStop !== undefined) {
      const ask = [t("Stop {name} (pid {pid})?", who),
        tr.dataset.status === "busy" ? t("It is working right now: the running turn is cut off.") : "",
        t("The conversation is kept and can be resumed.")];
      if (!confirm(ask.filter(Boolean).join("\n\n"))) return;
      await api(`/api/claude-sessions/${tr.dataset.pid}/stop`, { method: "POST", body: "{}" });
    } else if (btn.dataset.claudeMessage !== undefined) {
      const text = prompt(`${t("Message to {name} (pid {pid}):", who)}\n\n${t("It arrives as a note from another session.")}`);
      if (!text?.trim()) return;
      await api(`/api/claude-sessions/${tr.dataset.pid}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    }
    await refreshClaudeSessions();
  } catch (err) {
    alert(t("That did not work: {error}", { error: err.message }));
  }
});

/** Browser key name → the name tmux send-keys knows it by. */
const TMUX_KEYS = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "BSpace",
  Delete: "DC",
  Insert: "IC",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

async function sendKey(body) {
  if (!selectedSession) return;
  try {
    await api(`/api/tmux/${encodeURIComponent(selectedSession)}/keys`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    await refreshPane();
  } catch (err) {
    $("#term-state").textContent = t("That did not work: {error}", { error: err.message });
  }
}

async function refreshPane() {
  if (!selectedSession) return;
  try {
    const data = await api(`/api/tmux/${encodeURIComponent(selectedSession)}/pane`);
    // Trailing blank lines are the unused rest of the pane; they push the
    // prompt off the top of a scrolled screen for no reason.
    $("#pane-output").textContent = (data.pane || "").replace(/\s+$/, "") || t("(empty)");
    $("#term-state").textContent = "";
  } catch {
    $("#term-state").textContent = t("The session has ended.");
    closeTerm();
  }
}

function closeTerm() {
  selectedSession = null;
  if (paneTimer) clearInterval(paneTimer);
  paneTimer = null;
  $("#term").classList.add("hidden");
}

async function selectSession(session) {
  selectedSession = session;
  $("#term-title").textContent = session;
  $("#term-state").textContent = "";
  $("#term").classList.remove("hidden");
  $("#pane-output").focus();
  if (paneTimer) clearInterval(paneTimer);
  await refreshPane();
  // Faster than the read-only view was: the pane is the only feedback that a
  // keystroke arrived.
  paneTimer = setInterval(refreshPane, 700);
}

$("#term-close").addEventListener("click", closeTerm);
$("#term").addEventListener("click", (e) => {
  if (e.target.id === "term") closeTerm();
});

$("#pane-output").addEventListener("keydown", (e) => {
  if (!selectedSession) return;
  // Escape goes to the session, not the overlay: every TUI in here uses it to
  // back out of a dialog. Closing is the button, the backdrop, or Ctrl-Esc.
  if (e.key === "Escape" && e.ctrlKey) {
    closeTerm();
    return;
  }
  e.preventDefault();
  if (e.ctrlKey && /^[a-z0-9[\]\\^_]$/i.test(e.key)) {
    sendKey({ key: `C-${e.key.toLowerCase()}` });
    return;
  }
  if (TMUX_KEYS[e.key]) {
    sendKey({ key: TMUX_KEYS[e.key] });
    return;
  }
  if (e.key.length === 1 && !e.metaKey && !e.altKey) sendKey({ text: e.key });
});

async function refreshUsage() {
  const data = await api("/api/usage");
  dashboardMetrics.usage = data;
  updateDashboardMetrics();
  // Grouped by provider so the windows of one account sit together; the key
  // breaks ties, which keeps the order stable across refreshes.
  const rows = Object.entries(data.windows)
    .sort(([a], [b]) =>
      (providerOf(a) || "\uffff").localeCompare(providerOf(b) || "\uffff") || a.localeCompare(b))
    .map(([key, w]) => `
    <div class="usage-row" data-row="${esc(key)}"${providerAttr(key)}>
      <div class="key">${esc(key)}</div>
      <div class="bar"><span style="width:${w.usedPct != null ? Math.min(100, w.usedPct) : 0}%"></span></div>
      <div class="pct">${w.usedPct != null ? w.usedPct + "%" : "—"}</div>
      <div class="badges">${w.stale ? `<span class="badge unknown">${esc(t("Unknown"))}</span>` : levelBadge(w.level)}${collectorBadge(key, data.collectors?.[key.split(":")[0]], w.stale)}</div>
      <div class="marked-item">${w.resets_at ? esc(t("Resets {when}")).replace("{when}", () => `<span class="nowrap">${esc(fmtDateTime(w.resets_at))}</span>`) : "—"}</div>
    </div>`).join("");
  $("#usage-grid").innerHTML = rows || `<p>${esc(t("No usage readings yet"))}</p>`;
  const status = repairStatusLine(data.collectors);
  const statusEl = $("#usage-repair-status");
  statusEl.textContent = status;
  statusEl.classList.toggle("hidden", !status);
  $("#marked-list").innerHTML = data.marked.length
    ? `<h3>${esc(t("Marked as limited"))}</h3>${data.marked.map((m) => `<div class="marked-item">
        ${withNames(t("{target} is limited until {when}.", { when: fmtDateTime(m.until) }), { target: m.key })}${m.reason ? ` · <span translate="no">${esc(m.reason)}</span>` : ""}
        <button type="button" class="link" data-clear-mark="${esc(m.key)}">${esc(t("Lift now"))}</button></div>`).join("")}`
    : "";
  const select = $("#mark-target");
  const targets = data.mark_targets || [];
  if (select.dataset.keys !== targets.join(",")) {
    const keep = select.value;
    select.innerHTML = targets.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    if (targets.includes(keep)) select.value = keep;
    select.dataset.keys = targets.join(",");
  }
  updateAttention();
}

$("#marked-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-clear-mark]");
  if (!btn) return;
  btn.disabled = true;
  try {
    await api("/api/actions/clear-mark", { method: "POST", body: JSON.stringify({ target: btn.dataset.clearMark }) });
  } catch (err) {
    alert(t("Could not lift the mark: {error}", { error: err.message }));
  }
  await refreshUsage();
});

$("#mark-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#mark-status");
  const body = { target: $("#mark-target").value, hours: Number($("#mark-hours").value), reason: $("#mark-reason").value };
  try {
    const res = await api("/api/actions/mark-limited", { method: "POST", body: JSON.stringify(body) });
    status.textContent = t("{target} is out of every chain until {when}.", { target: body.target, when: fmtDateTime(res.until) });
    $("#mark-reason").value = "";
  } catch (err) {
    status.textContent = t("Refused: {error}", { error: err.message });
  }
  await refreshUsage();
});

// Delegated, because refreshUsage replaces the whole grid every poll.
$("#usage-grid").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-repair], [data-repair-session]");
  if (!btn) return;
  const running = btn.dataset.repairSession;
  if (running) {
    await selectSession(running);
    return;
  }
  const cli = btn.dataset.repair;
  btn.disabled = true;
  btn.textContent = t("Starting…");
  try {
    const res = await api(`/api/usage/${encodeURIComponent(cli)}/repair`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    // No terminal overlay: the repair reports into its own file and the badge
    // clears itself once the collector produces a fresh reading again.
    void res;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = t("Out of date · fix it");
    alert(t("The repair did not start: {error}", { error: err.message }));
  }
  await refreshUsage();
});

// ── Roles & Models ────────────────────────────────────────────────────────
// Left: one row per role, its chain as chips — the one `pick` would choose
// right now outlined, the ones it skips right now faded. Right: the roster as
// a palette. Chains are edited by dragging: roster → chain inserts, chip →
// chip reorders, chip → roster (or ✕) removes. Every drop saves the whole
// chain, each entry with its effort and pin. The ✎ dialog keeps per-entry
// effort and pinning, and is the keyboard and touch path.
let rolesData = null;
let rolesDrag = null;
let rolesKeyDrawn = "";
// Until a save and its redraw land, the chips show the old chain; a second
// edit built on them would overwrite the first.
let rolesSaving = false;

const CELL_STATE = {
  gone: ["red", t("gone: the CLI no longer offers it")],
  missing: ["red", t("not in the roster's models")],
  unknown: ["", t("no fresh scan of this CLI: availability unknown")],
};

function chainChip(c, i, r) {
  if (c.invalid) return `<span class="chip missing" title="${esc(c.invalid)}">${esc(t("invalid"))}</span>`;
  const [cls, why] = c.state === "gone" && !c.newest
    ? ["red", t("gone: the CLI no longer offers it and no newer version of this model exists. Delete it from the chain or pick another model.")]
    : CELL_STATE[c.state] || ["", ""];
  // pick walks the chain in order and records one skip per entry it passes,
  // so skipped[i] belongs to chain[i] and the pick sits right after them.
  const skip = i < r.skipped.length ? r.skipped[i].reason : "";
  const now = r.pick && i === r.skipped.length;
  const notes = [now ? t("picked now") : "", skip ? t("skipped now: {reason}", { reason: skip }) : "", why,
    c.newest ? t("newer: {model}", { model: c.newest }) : "", c.pinned ? t("version pinned") : "",
    c.effort ? t("effort {effort}", { effort: c.effort }) : "", c.fast ? t("fast (more quota)") : ""].filter(Boolean).join(" · ");
  const movable = !r.chain.some((x) => x.invalid);
  return `<span class="chip chain-chip ${cls}${now ? " is-pick" : ""}${skip ? " is-skipped" : ""}"${providerAttr(c.cli, c.model)}${
    movable ? ` draggable="true" data-index="${i}"` : ""} title="${esc(`${c.cli}:${c.model}${notes ? ` — ${notes}` : ""}${movable ? `\n${t("Double-click to change CLI, model or effort")}` : ""}`)}">${
    i + 1}. ${esc(c.label)}${c.effort ? ` <small>${esc(c.effort)}</small>` : ""}${c.fast ? " ⚡" : ""}${c.pinned ? " 📌" : ""}${c.newest ? " ⬆" : ""}${
    c.state === "gone" ? " ✗" : ""}${movable ? `<button type="button" class="chip-x" data-index="${i}" title="${esc(t("Remove from the chain"))}" aria-label="${esc(t("Remove {model}", { model: c.label }))}">✕</button>` : ""}</span>`;
}

function roleRow(r) {
  const broken = r.chain.some((x) => x.invalid);
  // Names come from installed manifests.
  const users = (r.usedBy || []).map((u) => u.name || u.id);
  const usedBy = users.length
    ? `<small class="role-used">${withNames(t("Used by: {names}"), { names: new Intl.ListFormat(LANG, { type: "conjunction" }).format(users) })}</small>` : "";
  return `<div class="role-row" data-role="${esc(r.role)}">
    <div class="role-name"><strong>${esc(r.role)}</strong>${r.effort ? ` <span class="muted" title="${esc(t("Effort for the whole role"))}">${esc(r.effort)}</span>` : ""}${usedBy}</div>
    <div class="chain-drop" data-role="${esc(r.role)}"${broken ? ` data-locked="1" title="${esc(t("This chain has an entry team-up cannot read: fix it with ✎ first"))}"` : ""}>${
      r.chain.map((c, i) => chainChip(c, i, r)).join("")}${r.pick ? "" : `<span class="badge red" title="${esc(t("Every model in the chain is skipped right now"))}">${esc(t("exhausted"))}</span>`}</div>
    <div class="row-actions">
      <button type="button" class="role-edit" data-role="${esc(r.role)}" title="${esc(t("Effort, pinning, chain as a form"))}" aria-label="${esc(t("Edit {role}", { role: r.role }))}">✎</button>
      ${r.protected
        ? `<span class="role-pin" title="${esc(r.protected)}" role="img" aria-label="${esc(t("Cannot be deleted"))}">🔒</span>`
        : `<button type="button" class="role-delete" data-role="${esc(r.role)}" title="${esc(t("Delete role"))}" aria-label="${esc(t("Delete {role}", { role: r.role }))}">🗑</button>`}
    </div>
  </div>`;
}

/** The roster as drag sources: one chip per model and CLI, grouped by CLI. */
function renderPalette() {
  const used = new Map();
  for (const r of rolesData.roles) {
    for (const c of r.chain) if (!c.invalid) used.set(`${c.cli}:${c.model}`, [...(used.get(`${c.cli}:${c.model}`) || []), r.role]);
  }
  const groups = rolesData.clis.map((cli) => {
    const chips = rolesData.models.filter((m) => m.clis.includes(cli)).map((m) => {
      const roles = used.get(`${cli}:${m.id}`) || [];
      return `<span class="chip palette-chip${roles.length ? "" : " unused"}" draggable="true" data-cli="${esc(cli)}" data-model="${esc(m.id)}"${
        providerAttr(cli, m.id)} title="${esc(`${cli}:${m.id} — ${roles.length ? t("in {roles}", { roles: roles.join(", ") }) : t("in no chain yet")}`)}">${esc(m.label)}</span>`;
    }).join("");
    return chips ? `<div class="palette-group"><span class="palette-cli">${esc(cli)}</span><div>${chips}</div></div>` : "";
  }).join("");
  $("#roster-palette").innerHTML = groups || `<p class="muted">${esc(t("No models in the roster yet: add some below."))}</p>`;
}

let specialistRolesKey = "";

async function refreshRoles() {
  const data = await api("/api/roles");
  // A redraw mid-drag drops the chip in the user's hand; dragend redraws.
  if (rolesDrag) return;
  rolesData = data;
  // The Team detail's role select lists the roles; redraw it only when they
  // change (a pick not saved yet survives that too).
  const rolesKey = data.roles.map((r) => r.role).join(",");
  if (rolesKey !== specialistRolesKey) {
    specialistRolesKey = rolesKey;
    renderTeamDetail();
  }
  // An unchanged redraw would only flicker the hover state.
  const key = JSON.stringify(data);
  if (key === rolesKeyDrawn) return;
  rolesKeyDrawn = key;
  const upgrades = data.roles.flatMap((r) => r.chain.filter((c) => c.newest && (!c.pinned || c.state === "gone")));
  const addable = data.addable || [];
  const btn = $("#roles-upgrade");
  btn.classList.toggle("hidden", !upgrades.length && !addable.length);
  btn.textContent = t("⬆ Bring to the newest versions ({changes})", { changes: [
    addable.length ? t("{n} new: {models}", { n: addable.length, models: addable.map((a) => a.id).join(", ") }) : "",
    upgrades.length ? tp(upgrades.length, { one: "{n} chain entry", other: "{n} chain entries" }) : "",
  ].filter(Boolean).join(" · ") });
  $("#roles-list").innerHTML = data.roles.map(roleRow).join("") || `<p class="muted">${esc(t("No roles yet."))}</p>`;
  renderPalette();
}

async function roleWrite(role, body, note) {
  const status = $("#roles-status");
  try {
    const res = await api(`/api/roles/${encodeURIComponent(role)}`, { method: "POST", body: JSON.stringify(body) });
    status.textContent = `${note} · ${t("Backup: {file}", { file: res.backup })}`;
    await refreshRoles();
    return true;
  } catch (err) {
    status.textContent = t("Refused: {error}", { error: err.message });
    return false;
  }
}

$("#roles-list").addEventListener("click", async (e) => {
  const x = e.target.closest(".chip-x");
  if (x) {
    const role = x.closest(".chain-drop").dataset.role;
    saveChain(role, (chain) => t("{entry} removed", { entry: chainEntryLabel(chain.splice(Number(x.dataset.index), 1)[0]) }));
    return;
  }
  const btn = e.target.closest("button[data-role]");
  if (!btn) return;
  const role = btn.dataset.role;
  const roleData = rolesData?.roles.find((x) => x.role === role);
  if (btn.classList.contains("role-edit")) openRoleEditor(roleData);
  else if (btn.classList.contains("role-delete") && await confirmDialog({
    title: withNames(t("Delete the role {role}?"), { role }),
    text: withNames(t("Anything that still runs team-up pick --role {role} will fail."), { role }),
    yes: t("Delete role"),
  })) {
    roleWrite(role, { delete: true }, t("{role} deleted", { role }));
  }
});

const chainEntry = (c) => ({ cli: c.cli, model: c.model, effort: c.effort || null, pinned: !!c.pinned, fast: !!c.fast });
const chainEntryLabel = (c) => `${c.cli}:${c.model}`;

/** Apply `edit` (returns the status note) to a copy of the role's chain and save it, unless nothing changed. */
function saveChain(role, edit) {
  if (rolesSaving) return;
  const current = rolesData?.roles.find((r) => r.role === role)?.chain || [];
  if (current.some((c) => c.invalid)) return;
  const chain = current.map(chainEntry);
  const before = JSON.stringify(chain);
  const note = edit(chain);
  if (JSON.stringify(chain) === before) return;
  if (!chain.length) {
    $("#roles-status").textContent = t("{role} needs at least one model: delete the role instead", { role });
    return;
  }
  rolesSaving = true;
  roleWrite(role, { chain }, `${role}: ${note}`).finally(() => { rolesSaving = false; });
}

/** Where a drop at (x, y) lands among the zone's chips: before the first chip after the pointer. */
function dropIndex(zone, x, y) {
  const chips = [...zone.querySelectorAll(".chain-chip")];
  const at = chips.findIndex((chip) => {
    const b = chip.getBoundingClientRect();
    return y < b.top || (y <= b.bottom && x < b.left + b.width / 2);
  });
  return at < 0 ? chips.length : at;
}

// The insertion point is a highlight on a chip edge, not an element: an
// element would shift the chips under the pointer and make the index flicker.
function dropMark(zone, index) {
  clearDropMark();
  const chips = zone?.querySelectorAll(".chain-chip") || [];
  if (chips[index]) chips[index].classList.add("drop-before");
  else chips[chips.length - 1]?.classList.add("drop-after");
}

function clearDropMark() {
  for (const el of document.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
}

function endRolesDrag() {
  rolesDrag = null;
  clearDropMark();
  for (const el of document.querySelectorAll(".is-over, .is-dragging")) el.classList.remove("is-over", "is-dragging");
  refreshRoles().catch(() => {});
}

const board = $(".roles-board");
// Drag events may target a text node; every lookup starts from its element.
const dragEl = (e) => (e.target instanceof Element ? e.target : e.target?.parentElement) || board;
board.addEventListener("dragstart", (e) => {
  const chip = dragEl(e).closest(".chain-chip[draggable], .palette-chip");
  if (!chip) return;
  if (rolesSaving) {
    e.preventDefault();
    $("#roles-status").textContent = t("Still saving the last change…");
    return;
  }
  if (chip.classList.contains("palette-chip")) {
    rolesDrag = { entry: { cli: chip.dataset.cli, model: chip.dataset.model, effort: null, pinned: false } };
  } else {
    const role = chip.closest(".chain-drop").dataset.role;
    const index = Number(chip.dataset.index);
    rolesDrag = { from: role, index, entry: chainEntry(rolesData.roles.find((r) => r.role === role).chain[index]) };
  }
  e.dataTransfer.setData("text/plain", `${rolesDrag.entry.cli}:${rolesDrag.entry.model}`);
  e.dataTransfer.effectAllowed = "copyMove";
  requestAnimationFrame(() => chip.classList.add("is-dragging"));
});
board.addEventListener("dragover", (e) => {
  if (!rolesDrag) return;
  const zone = dragEl(e).closest(".chain-drop:not([data-locked])");
  const back = rolesDrag.from && dragEl(e).closest("#panel-roster");
  for (const el of board.querySelectorAll(".is-over")) if (el !== zone && el !== back) el.classList.remove("is-over");
  if (!zone && !back) {
    clearDropMark();
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = zone && rolesDrag.from === zone.dataset.role ? "move" : zone ? "copy" : "move";
  (zone || back).classList.add("is-over");
  if (zone) dropMark(zone, dropIndex(zone, e.clientX, e.clientY));
  else clearDropMark();
});
board.addEventListener("dragleave", (e) => {
  if (rolesDrag && !board.contains(e.relatedTarget)) {
    clearDropMark();
    for (const el of board.querySelectorAll(".is-over")) el.classList.remove("is-over");
  }
});
board.addEventListener("drop", (e) => {
  const drag = rolesDrag;
  if (!drag) return;
  e.preventDefault();
  const zone = dragEl(e).closest(".chain-drop:not([data-locked])");
  if (zone?.dataset.new) {
    createRole(drag.entry);
  } else if (zone) {
    const role = zone.dataset.role;
    saveChain(role, (chain) => {
      let at = dropIndex(zone, e.clientX, e.clientY);
      // From the same chain, or already in it: move rather than duplicate.
      const from = drag.from === role ? drag.index : chain.findIndex((c) => c.cli === drag.entry.cli && c.model === drag.entry.model);
      const entry = from >= 0 ? chain[from] : drag.entry;
      if (from >= 0) {
        chain.splice(from, 1);
        if (at > from) at -= 1;
      }
      chain.splice(at, 0, entry);
      return t("{entry} at place {n}", { entry: chainEntryLabel(entry), n: at + 1 });
    });
  } else if (drag.from && dragEl(e).closest("#panel-roster")) {
    saveChain(drag.from, (chain) => t("{entry} removed", { entry: chainEntryLabel(chain.splice(drag.index, 1)[0]) }));
  }
  endRolesDrag();
});
document.addEventListener("dragend", () => {
  if (rolesDrag) endRolesDrag();
});

// New role: name it, drop its first model. The form is the keyboard path.
function createRole(entry) {
  const input = $("#role-new-name");
  const role = input.value.trim();
  if (!input.checkValidity() || !role) {
    $("#roles-status").textContent = t("Name the role first: lowercase letters, digits, . _ -");
    input.focus();
    return;
  }
  if (rolesData?.roles.some((r) => r.role === role)) {
    $("#roles-status").textContent = t("{role} already exists: drop the model on its row instead", { role });
    return;
  }
  rolesSaving = true;
  roleWrite(role, { chain: [entry] }, t("{role} created", { role })).then((ok) => {
    if (ok) $("#role-new").classList.add("hidden");
  }).finally(() => { rolesSaving = false; });
}

$("#role-add").addEventListener("click", () => {
  $("#role-new").classList.remove("hidden");
  $("#role-new-name").value = "";
  $("#role-new-name").focus();
});
$("#role-new-cancel").addEventListener("click", () => $("#role-new").classList.add("hidden"));
$("#role-new-form").addEventListener("click", () => {
  $("#role-new").classList.add("hidden");
  openRoleEditor(null);
  $("#role-editor-name").value = $("#role-new-name").value.trim();
});

$("#roles-upgrade").addEventListener("click", async () => {
  const status = $("#roles-status");
  try {
    const res = await api("/api/roles-upgrade", { method: "POST", body: JSON.stringify({}) });
    const done = [...res.added.map((a) => t("added {model}", { model: a.id })), ...(res.removed || []).map((r) => t("removed {model}", { model: r.id })),
      ...res.changes.map((c) => `${c.role}: ${c.from} → ${c.to}`)];
    status.textContent = done.length ? `${done.join(", ")} · ${t("Backup: {file}", { file: res.backup })}` : t("Already on the newest versions.");
    refreshSpecialists().catch(() => {});
    await refreshRoles();
  } catch (err) {
    status.textContent = t("Refused: {error}", { error: err.message });
  }
});

const roleDialog = $("#role-editor");
let roleTarget = null;

function chainRow(entry = {}) {
  const models = rolesData?.models || [];
  const cli = entry.cli || models[0]?.clis[0] || "";
  const row = document.createElement("div");
  row.className = "chain-row";
  row.innerHTML = `
    <select class="ce-cli" aria-label="CLI">${(rolesData?.clis || []).map((c) =>
      `<option${c === cli ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
    <select class="ce-model" aria-label="${esc(t("Model"))}"></select>
    <select class="ce-effort" title="${esc(t("Overrides the model's default effort for this role"))}" aria-label="${esc(t("Effort"))}"></select>
    <label class="ce-fast-label"><input type="checkbox" class="ce-fast"${entry.fast ? " checked" : ""}> ⚡ ${esc(t("fast"))}</label>
    <label title="${esc(t("Stay on exactly this version; never move to a newer one"))}"><input type="checkbox" class="ce-pinned"${entry.pinned ? " checked" : ""}> ${esc(t("pin version"))}</label>
    <button type="button" class="ce-up" title="${esc(t("Move up"))}" aria-label="${esc(t("Move up"))}">↑</button>
    <button type="button" class="ce-down" title="${esc(t("Move down"))}" aria-label="${esc(t("Move down"))}">↓</button>
    <button type="button" class="ce-remove" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))}">✕</button>`;
  const fill = () => {
    const c = row.querySelector(".ce-cli").value;
    const keep = row.querySelector(".ce-model").value || entry.model;
    row.querySelector(".ce-model").innerHTML = models.filter((m) => m.clis.includes(c)).map((m) =>
      `<option value="${esc(m.id)}"${m.id === keep ? " selected" : ""}>${esc(m.label)}</option>`).join("");
    fillEffort();
  };
  // Effort values are the model's own (codex says xhigh, claude says max), so
  // the list follows the model picked. A value no longer in the map stays
  // selectable rather than being dropped silently — for that model only.
  const fillEffort = () => {
    const m = models.find((x) => x.id === row.querySelector(".ce-model").value);
    const sel = row.querySelector(".ce-effort");
    const same = m?.id === entry.model;
    const keep = sel.dataset.touched ? sel.value : same ? entry.effort || "" : "";
    const values = [...new Set([...(m?.efforts || []), ...(keep && same ? [keep] : [])])];
    sel.innerHTML = `<option value="">${esc(m?.default_effort ? t("default ({effort})", { effort: m.default_effort }) : t("default|effort"))}</option>`
      + values.map((v) => `<option${v === keep ? " selected" : ""}>${esc(v)}</option>`).join("");
    // Fast only where the CLI can do it for this model; hidden means off.
    const note = m?.fast?.[row.querySelector(".ce-cli").value];
    const canFast = note !== undefined;
    row.querySelector(".ce-fast-label").hidden = !canFast;
    row.querySelector(".ce-fast-label").title = note ? t("Fast mode: {note}", { note }) : t("Fast mode: uses more quota");
    if (!canFast) row.querySelector(".ce-fast").checked = false;
  };
  row.querySelector(".ce-cli").addEventListener("change", fill);
  row.querySelector(".ce-model").addEventListener("change", fillEffort);
  row.querySelector(".ce-effort").addEventListener("change", (e) => { e.target.dataset.touched = "1"; });
  fill();
  return row;
}

// Set while the role editor edits a specialist's own chain instead of a role.
let specialistChainTarget = null;

function openRoleEditor(role, specialist = null) {
  specialistChainTarget = specialist;
  roleTarget = specialist ? null : role?.role || null;
  $("#role-editor-title").textContent = specialist ? t("Own model list for {name}", { name: specialist })
    : role ? t("Edit {role}", { role: role.role }) : t("New role");
  $("#role-editor-name").value = specialist || role?.role || "";
  $("#role-editor-name").readOnly = !!(role || specialist);
  $("#role-editor-status").textContent = "";
  const effort = $("#role-editor-effort");
  effort.innerHTML = [`<option value="">${esc(t("per model (default)"))}</option>`,
    ...(rolesData?.efforts || []).map((x) => `<option value="${esc(x)}">${esc(x)}</option>`)].join("");
  effort.value = role?.effort || "";
  effort.dataset.current = role?.effort || "";
  effort.hidden = !!specialist;
  effort.previousElementSibling.hidden = !!specialist;
  const list = $("#role-editor-chain");
  list.innerHTML = "";
  const rows = role?.chain?.filter((x) => !x.invalid);
  for (const c of rows?.length ? rows : [{}]) list.append(chainRow(c));
  roleDialog.showModal();
}

$("#role-editor-add").addEventListener("click", () => $("#role-editor-chain").append(chainRow()));
$("#role-editor-cancel").addEventListener("click", () => {
  roleDialog.close();
});
// Double-click a chain chip: change that one entry's CLI, model, effort, pin.
const chipDialog = $("#chip-editor");
let chipTarget = null;
$("#roles-list").addEventListener("dblclick", (e) => {
  const chip = e.target.closest(".chain-chip[data-index]");
  if (!chip || e.target.closest(".chip-x")) return;
  const role = chip.closest(".chain-drop").dataset.role;
  const index = Number(chip.dataset.index);
  const entry = rolesData?.roles.find((r) => r.role === role)?.chain[index];
  if (!entry) return;
  chipTarget = { role, index };
  $("#chip-editor-title").textContent = t("{role} · entry {n}", { role, n: index + 1 });
  $("#chip-editor-row").replaceChildren(chainRow(entry));
  chipDialog.showModal();
});
$("#chip-editor-cancel").addEventListener("click", () => chipDialog.close());
$("#chip-editor-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const row = $("#chip-editor-row .chain-row");
  const entry = {
    cli: row.querySelector(".ce-cli").value,
    model: row.querySelector(".ce-model").value,
    effort: row.querySelector(".ce-effort").value || null,
    pinned: row.querySelector(".ce-pinned").checked,
    fast: row.querySelector(".ce-fast").checked,
  };
  const { role, index } = chipTarget;
  saveChain(role, (chain) => {
    chain[index] = entry;
    return `${t("entry {n} → {entry}", { n: index + 1, entry: chainEntryLabel(entry) })}${entry.effort ? ` · ${entry.effort}` : ""}${entry.fast ? ` · ${t("fast")}` : ""}`;
  });
  chipDialog.close();
});
$("#role-editor-chain").addEventListener("click", (e) => {
  const row = e.target.closest(".chain-row");
  if (!row) return;
  if (e.target.classList.contains("ce-remove")) row.remove();
  else if (e.target.classList.contains("ce-up")) row.previousElementSibling?.before(row);
  else if (e.target.classList.contains("ce-down")) row.nextElementSibling?.after(row);
});
$("#role-editor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = $("#role-editor-name").value.trim();
  if (!roleTarget && rolesData?.roles.some((r) => r.role === role)) {
    $("#role-editor-status").textContent = t("{role} already exists: edit it instead", { role });
    return;
  }
  const chain = [...$("#role-editor-chain").querySelectorAll(".chain-row")].map((row) => ({
    cli: row.querySelector(".ce-cli").value,
    model: row.querySelector(".ce-model").value,
    effort: row.querySelector(".ce-effort").value.trim() || null,
    pinned: row.querySelector(".ce-pinned").checked,
    fast: row.querySelector(".ce-fast").checked,
  }));
  if (specialistChainTarget) {
    const name = teamName(findSpecialist(specialistChainTarget) ?? { id: specialistChainTarget });
    if (await assignSpecialist(specialistChainTarget, { chain }, withNames(t("{name} now uses its own model list."), { name }))) roleDialog.close();
    else $("#role-editor-status").textContent = $("#team-status").textContent;
    return;
  }
  let ok = await roleWrite(role, { chain }, t("{role} saved", { role }));
  const effort = $("#role-editor-effort");
  if (ok && effort.value !== effort.dataset.current) {
    ok = await roleWrite(role, { effort: effort.value || null }, t("{role} saved", { role }));
  }
  if (ok) roleDialog.close();
  else $("#role-editor-status").textContent = $("#roles-status").textContent;
});

// ── Add or remove models ───────────────────────────────────────────────────
// Per provider, every model it offers; checked = in the roster, so the
// palette offers it. It stays out of `refreshAll`: it redraws when opened and
// after a toggle, so open providers stay open.
const CATALOGUE_OPEN_KEY = "teamup.catalogueOpen";
const CATALOGUE_KIND_KEY = "teamup.catalogueKind";
const catalogueOpen = new Set();
let catalogueData = null;

function renderCatalogue() {
  if (!catalogueData) return;
  const kind = readStored(CATALOGUE_KIND_KEY, "subscription");
  for (const btn of $("#catalogue-tabs").querySelectorAll(".tim-tab")) {
    btn.classList.toggle("is-active", btn.dataset.kind === kind);
    btn.setAttribute("aria-pressed", String(btn.dataset.kind === kind));
  }
  const q = $("#catalogue-search").value.trim().toLowerCase();
  const html = catalogueData.providers.filter((p) => p.tab === kind).map((p) => {
    const models = p.models.filter((m) => !q || `${m.cli_id} ${m.name || ""}`.toLowerCase().includes(q));
    if (q && !models.length) return "";
    const inRoster = p.models.filter((m) => m.checked).length;
    const rows = models.map((m) => `<tr>
      <td><input type="checkbox" class="catalogue-toggle" data-provider="${esc(p.id)}" data-cli="${esc(m.cli)}"
        data-cli-id="${esc(m.cli_id)}"${m.checked ? " checked" : ""}></td>
      <td class="mono">${esc(m.cli_id.replace("-{effort}", ""))}</td>
      <td>${m.name && m.name !== m.cli_id && m.name !== m.cli_id.replace("-{effort}", "") ? esc(m.name) : ""}${
        m.efforts ? `<span class="muted" title="${esc(t("Picked per role or specialist, not here"))}">${esc(t("effort: {efforts}", { efforts: m.efforts.join(" · ") }))}</span>` : ""}</td>
      <td class="muted">${esc(m.cli)}${m.unscanned ? ` · ${esc(t("not in any scan"))}` : ""}</td>
    </tr>`).join("");
    return `<details class="catalogue-provider" data-provider="${esc(p.tab)}:${esc(p.id)}"${catalogueOpen.has(`${p.tab}:${p.id}`) || q ? " open" : ""}>
      <summary><strong>${esc(p.label)}</strong> <span class="muted">${esc(t("{n} of {total} in the roster", { n: inRoster, total: p.models.length }))}</span></summary>
      <table><thead><tr><th></th>${th("Model", t("Model"))}${th("Name", t("Name"))}${th("CLI", "CLI")}</tr></thead><tbody>${rows}</tbody></table>
    </details>`;
  }).join("");
  $("#catalogue-list").innerHTML = html || `<p class="muted">${esc(t("No models yet. Run this in a terminal:"))} <code>team-up models scan</code></p>`;
}

async function refreshCatalogue() {
  catalogueData = await api("/api/catalogue");
  renderCatalogue();
}

$("#catalogue-box").addEventListener("toggle", (e) => {
  writeStored(CATALOGUE_OPEN_KEY, e.target.open ? "1" : "");
  if (e.target.open) refreshCatalogue().catch((err) => { $("#catalogue-status").textContent = t("That did not work: {error}", { error: err.message }); });
});
$("#catalogue-tabs").addEventListener("click", (e) => {
  const kind = e.target.closest(".tim-tab")?.dataset.kind;
  if (!kind) return;
  writeStored(CATALOGUE_KIND_KEY, kind);
  renderCatalogue();
});
$("#catalogue-search").addEventListener("input", renderCatalogue);
$("#catalogue-list").addEventListener("toggle", (e) => {
  const id = e.target.dataset?.provider;
  if (!id || $("#catalogue-search").value.trim()) return;
  if (e.target.open) catalogueOpen.add(id);
  else catalogueOpen.delete(id);
}, true);

/** Raw POST: a 409 carries the roles that still name the model. */
async function catalogueToggle(body) {
  const res = await fetch("/api/catalogue/toggle", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Team-Up-CSRF": "1" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) showLogin();
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** Ask what replaces the model in those chains: { model, cli }, "strike", or null for cancel. */
function askReplacement(cliId, cli, roles) {
  const dialog = $("#model-replace");
  $("#model-replace-msg").textContent = t("{model} ({cli}) is in the chain of {roles}. Pick a replacement, or remove it from those chains.",
    { model: cliId, cli, roles: roles.join(", ") });
  const gone = new Set((catalogueData?.providers || []).flatMap((p) => p.models)
    .filter((m) => m.cli === cli && m.cli_id === cliId).flatMap((m) => m.roster_ids));
  const options = (rolesData?.models || []).flatMap((m) => m.clis
    .filter((c) => !(gone.has(m.id) && c === cli))
    .map((c) => `<option value="${esc(`${c}:${m.id}`)}">${esc(m.label || m.id)} · ${esc(c)}</option>`));
  $("#model-replace-select").innerHTML = options.join("");
  return new Promise((resolve) => {
    const done = (value) => {
      dialog.removeEventListener("close", onClose);
      dialog.close();
      resolve(value);
    };
    const onClose = () => done(null);
    dialog.addEventListener("close", onClose);
    $("#model-replace-cancel").onclick = () => done(null);
    $("#model-replace-strike").onclick = () => done("strike");
    $("#model-replace-form").onsubmit = (e) => {
      e.preventDefault();
      const value = $("#model-replace-select").value;
      if (!value) return;
      const i = value.indexOf(":");
      done({ cli: value.slice(0, i), model: value.slice(i + 1) });
    };
    dialog.showModal();
  });
}

$("#catalogue-list").addEventListener("change", async (e) => {
  const box = e.target.closest(".catalogue-toggle");
  if (!box) return;
  const status = $("#catalogue-status");
  const body = { cli: box.dataset.cli, cli_id: box.dataset.cliId, provider: box.dataset.provider, on: box.checked };
  box.disabled = true;
  try {
    let r = await catalogueToggle(body);
    if (r.status === 409) {
      const resolve = await askReplacement(body.cli_id, body.cli, r.data.roles || []);
      if (resolve == null) {
        box.checked = !body.on;
        status.textContent = "";
        return;
      }
      r = await catalogueToggle({ ...body, resolve });
    }
    if (r.status !== 200) throw new Error(r.data.error || `HTTP ${r.status}`);
    const done = body.on ? t("{model} added to the roster", { model: body.cli_id }) : t("{model} removed from the roster", { model: body.cli_id });
    status.textContent = `${done} · ${t("Backup: {file}", { file: r.data.backup })}`;
  } catch (err) {
    status.textContent = t("Refused: {error}", { error: err.message });
  } finally {
    await Promise.allSettled([refreshCatalogue(), refreshRoles(), refreshSpecialists()]);
  }
});

function providerStatus(p) {
  if (p.class === "A") {
    if (!p.configured) return `<span class="badge stale">${esc(t("not connected"))}</span>`;
    const bits = [esc(t("connected")), esc(p.hint || ""), p.label ? esc(p.label) : "", p.last_verdict === "ok" ? esc(t("valid")) : ""].filter(Boolean);
    const src = p.source_file ? ` · ${esc(p.source_file)}` : p.source ? ` · ${esc(p.source)}` : "";
    return `<span class="badge ok">${bits.join(" · ")}${src}</span>`;
  }
  if (p.class === "B") {
    return `<span class="badge ${p.configured ? "ok" : "stale"}">${esc(t("subscription login"))}</span>`;
  }
  return `<span class="badge ${p.configured ? "ok" : "stale"}">${esc(t("key kept by the CLI"))}</span>`;
}

async function refreshProviders() {
  const list = $("#providers-list");
  const activeInput = list.querySelector('.provider-form input[name="key"]');
  if (activeInput && (activeInput === document.activeElement || activeInput.value)) {
    return;
  }
  const data = await api("/api/providers");
  const html = data.providers.map((p) => {
    let body = `<div class="provider-card"${providerAttr(p.id)} data-row="${esc(p.id)}"><strong>${esc(p.id)}</strong> ${providerStatus(p)}`;
    if (p.class === "A" && p.writable) {
      body += `<form class="provider-form" data-id="${esc(p.id)}">
        <input type="password" name="key" placeholder="${esc(t("OpenRouter API key"))}" aria-label="${esc(t("OpenRouter API key"))}" autocomplete="off">
        <button type="submit">${esc(p.configured ? t("Replace key") : t("Connect"))}</button>
        ${p.configured ? `<button type="button" class="remove-key">${esc(t("Remove"))}</button>` : ""}
        <button type="button" class="validate-key">${esc(t("Check"))}</button>
      </form>`;
    } else if (p.class === "A" && p.configured) {
      body += ` <span class="muted">${esc(p.source ? t("read-only ({source})", { source: p.source }) : t("read-only"))}</span>`;
    } else if (p.login_command) {
      body += ` <span class="muted mono">${esc(p.login_command)}</span>`;
    }
    return `${body}</div>`;
  }).join("");
  $("#providers-list").innerHTML = html || `<p>${esc(t("No providers"))}</p>`;
  $("#providers-list").querySelectorAll(".provider-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = form.querySelector('input[name="key"]').value.trim();
      if (!key) return;
      try {
        await api("/api/providers/openrouter/key", { method: "POST", body: JSON.stringify({ key }) });
        form.querySelector('input[name="key"]').value = "";
        await refreshProviders();
      } catch (err) {
        alert(t("That did not work: {error}", { error: err.message }));
      }
    });
    form.querySelector(".validate-key")?.addEventListener("click", async () => {
      try {
        await api("/api/providers/openrouter/validate", { method: "POST", body: JSON.stringify({}) });
        await refreshProviders();
      } catch (err) {
        alert(t("That did not work: {error}", { error: err.message }));
      }
    });
    form.querySelector(".remove-key")?.addEventListener("click", async () => {
      try {
        await api("/api/providers/openrouter/remove", { method: "POST", body: JSON.stringify({}) });
        await refreshProviders();
      } catch (err) {
        alert(t("That did not work: {error}", { error: err.message }));
      }
    });
  });
}

let selectedCli = null;
let cliLogTimer = null;

// clis.mjs harnessLabel's words; a status it passes through stays as it is.
const HARNESS_LABEL = {
  unknown: t("unknown"), "installed, capabilities denied": t("installed, capabilities denied"), "not installed": t("not installed"),
};

function harnessCell(c) {
  if (c.verification_verdict?.verdict === "harness_verification_unsupported") {
    return `${esc(t("not checkable"))} · <span translate="no">${esc(c.verification_verdict.reason || "")}</span>`;
  }
  const label = c.harness_label || c.harness?.status;
  if (!label) return "—";
  return Object.hasOwn(HARNESS_LABEL, label) ? esc(HARNESS_LABEL[label]) : `<span translate="no">${esc(label)}</span>`;
}

function verdictBadge(v) {
  if (!v) return "—";
  if (v.verdict === "verified") return `<span class="badge ok">${esc(t("verified"))}</span>`;
  if (v.verdict === "harness_verification_unsupported") {
    return `<span class="badge stale">${esc(t("not checkable"))}${v.reason ? ` · <span translate="no">${esc(v.reason)}</span>` : ""}</span>`;
  }
  return `<span class="badge red">${esc(t("Failed|job"))}${v.reason ? ` · <span translate="no">${esc(v.reason)}</span>` : ""}</span>`;
}

async function refreshCliLog(cli) {
  if (!cli) return;
  try {
    const data = await api(`/api/clis/${encodeURIComponent(cli)}/install/log`);
    const lines = (data.lines || []).join("\n");
    const verdict = data.post_update_verdict ? t("Check: {verdict}", { verdict: data.post_update_verdict.verdict }) : "";
    const el = $("#cli-log");
    el.textContent = [lines, verdict].filter(Boolean).join("\n\n") || t("(no log yet)");
    el.classList.remove("hidden");
  } catch {
    /* ignore */
  }
}

function selectCli(cli) {
  selectedCli = cli;
  if (cliLogTimer) clearInterval(cliLogTimer);
  refreshCliLog(cli);
  cliLogTimer = setInterval(() => refreshCliLog(cli), 2000);
}

async function refreshClis() {
  const data = await api("/api/clis");
  // Off by default: the token already proves who you are, and the code only
  // reaches someone reading the service journal. Start the dashboard with
  // --require-admin-confirm to bring the second step back.
  $("#admin-gate").classList.toggle("hidden", !data.requires_admin_confirm);
  const rows = data.clis.map((c) => {
    const state = c.install_state || "idle";
    const actions = [];
    if (c.update_available) {
      actions.push(`<button type="button" class="cli-update" data-cli="${esc(c.cli)}">${esc(t("Update"))}</button>`);
    }
    if (c.present) {
      if (c.uninstall_command) {
        actions.push(`<button type="button" class="cli-uninstall" data-cli="${esc(c.cli)}">${esc(t("Uninstall"))}</button>`);
      }
    } else if (c.install_available) {
      actions.push(`<button type="button" class="cli-install" data-cli="${esc(c.cli)}">${esc(t("Install"))}</button>`);
    } else if (c.install_disabled_reason) {
      actions.push(`<span class="muted">${esc(c.install_disabled_reason)}</span>`);
    }
    if (c.login_available && c.present) {
      actions.push(`<button type="button" class="cli-login" data-cli="${esc(c.cli)}">${esc(t("Start login"))}</button>`);
    }
    // A CLI the roster doesn't run is a row the user switches on in ✎.
    return `
    <tr class="clickable ${selectedCli === c.cli ? "selected" : ""}" data-cli="${esc(c.cli)}" data-row="clis:${esc(c.cli)}"${
      c.in_roster ? "" : ' data-row-default="hidden"'}${providerAttr(c.cli)}>
      <td title="${esc(c.path || t("not on PATH"))}">${esc(c.cli)}</td>
      <td>${c.present ? `<span class="badge ok">${esc(t("installed"))}</span>` : `<span class="badge stale">${esc(t("missing"))}</span>`}</td>
      <td class="mono">${esc(c.version || "—")}</td>
      <td>${harnessCell(c)}</td>
      <td>${verdictBadge(c.post_update_verdict)}</td>
      <td>${esc(state)}</td>
      <td>${actions.join(" ")}</td>
    </tr>`;
  }).join("");
  $("#clis-table").innerHTML = `<table>
    <thead><tr>${th("CLI", "CLI")}${th("Present", t("Present"))}${th("Version", t("Version"))}${th("Harness", "Harness")}${
      th("Verify", t("Check"))}${th("Job", t("Job"))}${th("Actions", t("Actions"))}</tr></thead>
    <tbody>${rows || `<tr><td colspan="7">${esc(t("No CLIs"))}</td></tr>`}</tbody></table>`;
  $("#clis-table").querySelectorAll("tr[data-cli]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      selectCli(tr.dataset.cli);
    });
  });
  $("#clis-table").querySelectorAll(".cli-update").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cli = btn.dataset.cli;
      try {
        const cmd = data.clis.find((c) => c.cli === cli)?.update_command;
        if (cmd && !confirm(`${t("Run the update and check it?")}\n\n${cmd}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/update`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(t("That did not work: {error}", { error: err.message }));
      }
    });
  });
  $("#clis-table").querySelectorAll(".cli-install").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cli = btn.dataset.cli;
      try {
        const row = data.clis.find((c) => c.cli === cli);
        if (row?.install_command && !confirm(`${t("Run the install?")}\n\n${row.install_command}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/install`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(t("That did not work: {error}", { error: err.message }));
      }
    });
  });
  $("#clis-table").querySelectorAll(".cli-uninstall").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cli = btn.dataset.cli;
      try {
        const row = data.clis.find((c) => c.cli === cli);
        if (!confirm(`${t("Uninstall {cli}?", { cli })}\n\n${row?.uninstall_command}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/uninstall`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(t("That did not work: {error}", { error: err.message }));
      }
    });
  });
  $("#clis-table").querySelectorAll(".cli-login").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cli = btn.dataset.cli;
      try {
        const row = data.clis.find((c) => c.cli === cli);
        if (row?.login_command && !confirm(`${t("Start the login in tmux?")}\n\n${row.login_command}\n\n${t("Finish it in a terminal:")} tmux attach -t team-up-install-${cli}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/login`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(t("That did not work: {error}", { error: err.message }));
      }
    });
  });
}

async function refreshSetup() {
  await Promise.allSettled([refreshProviders(), refreshClis()]);
}

$("#admin-challenge-btn").addEventListener("click", async () => {
  try {
    const data = await api("/api/admin/challenge", { method: "POST", body: JSON.stringify({}) });
    adminChallengeId = data.challenge_id;
    $("#admin-confirm-form").classList.remove("hidden");
    $("#admin-status").textContent = t("Enter the code your terminal shows.");
  } catch (err) {
    $("#admin-status").textContent = t("That did not work: {error}", { error: err.message });
  }
});

$("#admin-confirm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/confirm", {
      method: "POST",
      body: JSON.stringify({ challenge_id: adminChallengeId, code: $("#admin-code-input").value.trim() }),
    });
    $("#admin-gate").classList.add("hidden");
    $("#admin-status").textContent = t("Confirmed: changes work for the next 10 minutes.");
  } catch (err) {
    $("#admin-status").textContent = t("That did not work: {error}", { error: err.message });
  }
});

// ── Team ──────────────────────────────────────────────────────────────────
// A card per installed specialist; the open one shows below the cards and
// lives in the hash (#/specialists/<id>), so back and reload keep it. Loaded
// on entry, not on the five-second cycle: a redraw while you work in the
// detail would take your place in it.
let specialistsData = null;
let capabilityPool = null;
let teamSeq = 0;
/** The specialist the detail shows: focus moves only when it changes. */
let teamOpenId = null;
// Left Team: coming back is a fresh visit, not a closed detail to return focus from.
window.addEventListener("hashchange", () => {
  if (!location.hash.startsWith("#/specialists")) teamOpenId = null;
});

const TEAM_TITLE = {
  coding: t("Developer"),
  testing: t("Tester"),
  review: t("Reviewer"),
  research: t("Researcher"),
  marketing: t("Marketing"),
  other: t("Team member"),
};

const teamSelectedId = () => location.hash.match(/^#\/specialists\/([\w.-]+)$/)?.[1] ?? null;
const findSpecialist = (id) => (specialistsData?.specialists || []).find((s) => s.id === id);
const teamName = (s) => s.display_name || s.id;
// A manifest's own words, not a translation: only its first letter changes.
const capitalised = (text) => String(text ?? "").replace(/^\p{Ll}/u, (c) => c.toUpperCase());

/** A translated sentence as HTML: escaped, each named value (agent text, a name, an id) in a translate="no" span. */
function withNames(text, names) {
  return esc(text).replace(/\{(\w+)\}/g, (m, key) => (Object.hasOwn(names, key) ? `<span translate="no">${esc(names[key])}</span>` : m));
}

function chips(items) {
  if (!items?.length) return '<span class="muted">—</span>';
  return items.map((item) => `<span class="chip">${esc(item)}</span>`).join(" ");
}

function teamNote(html, tone = "") {
  const el = $("#team-status");
  el.innerHTML = html;
  el.className = `status-line ${tone}`;
}

const teamActive = (s) => Boolean(s.assignment) && !s.error;

function teamStatus(s) {
  if (teamActive(s)) return `<span class="tag ok">${esc(t("Active"))}</span>`;
  const why = s.error ? t("It cannot start: {error}", { error: s.error }) : t("It has no role, so it does not start.");
  return `<span class="tag off" title="${esc(why)}">${esc(t("Off"))}</span>`;
}

/** What it may do, in plain words. */
function teamBadges(s) {
  const p = s.permissions || {};
  const out = [p.writes === true ? t("Edits code") : p.writes ? t("Edits code through a helper") : t("Read-only")];
  if (p.network) out.push(t("Uses the internet"));
  if ((p.commands || []).length) out.push(t("Runs tests"));
  if (s.budget?.timeout_seconds) out.push(t("Up to {n} min", { n: Math.round(s.budget.timeout_seconds / 60) }));
  return out.map((b) => `<span class="tag">${esc(b)}</span>`).join(" ");
}

/** One whole sentence per kind of ending; the age from createdAt, which the 30 s memo does not freeze. */
function teamLastJob(s) {
  const r = s.lastRun;
  if (!r) return esc(t("No job yet"));
  const at = Date.parse(r.createdAt ?? "");
  const ago = fmtAgo(Number.isFinite(at) ? Date.now() - at : r.ageMs ?? 0);
  const names = { project: r.project?.name ?? "—" };
  if (r.status === "done") return withNames(t("Last job: done {ago}, in {project}", { ago }), names);
  if (r.status === "failed") return withNames(t("Last job: failed {ago}, in {project}", { ago }), names);
  if (r.status === "cancelled") return withNames(t("Last job: cancelled {ago}, in {project}", { ago }), names);
  if (WAITING_STATUSES.has(r.status)) return withNames(t("Last job: started {ago}, waiting for you, in {project}", { ago }), names);
  return withNames(t("Last job: started {ago}, still working, in {project}", { ago }), names);
}

function teamModelHtml(s) {
  if (s.model) return withNames(t("Works with: {model}"), { model: s.model });
  return `<span title="${esc(s.modelReason || "")}">${esc(t("No model can take it right now"))}</span>`;
}

const avatar = (s) => `<span class="avatar cat-${esc(s.category || "other")}" aria-hidden="true">${esc(Array.from(teamName(s))[0] || "?")}</span>`;

function teamCard(s, selected) {
  return `<li><a class="team-card" href="#/specialists/${esc(s.id)}" data-id="${esc(s.id)}"${selected ? ' aria-current="true"' : ""}>
    <span class="team-card-head">${avatar(s)}
      <span class="team-who"><span class="team-name" translate="no">${esc(teamName(s))}</span><span class="team-title">${esc(TEAM_TITLE[s.category] ?? TEAM_TITLE.other)}</span></span>
      ${teamStatus(s)}
    </span>
    <span class="team-purpose" translate="no">${esc(capitalised(s.remit?.[0]))}</span>
    <span class="team-model">${teamModelHtml(s)}</span>
    <span class="team-badges">${teamBadges(s)}</span>
    <span class="team-last">${teamLastJob(s)}</span>
  </a></li>`;
}

function renderTeam() {
  if (!specialistsData) return;
  const list = specialistsData.specialists || [];
  const selected = teamSelectedId();
  const focused = document.activeElement?.closest?.("#team-grid .team-card")?.dataset.id;
  $("#team-grid").innerHTML = list.length
    ? `<ul class="team-grid">${list.map((s) => teamCard(s, s.id === selected)).join("")}</ul>`
    : `<div class="empty">${esc(t("No specialists installed yet."))}</div>`;
  // Closed: back to the card it was opened from; a redraw: to the card that had focus.
  const back = teamOpenId && !selected ? teamOpenId : focused;
  renderTeamDetail();
  if (back && location.hash.startsWith("#/specialists")) $(`#team-grid [data-id="${CSS.escape(back)}"]`)?.focus({ preventScroll: Boolean(focused) });
}

function teamExtras(s) {
  const name = teamName(s);
  const rows = (s.assigned || []).map((a) => {
    const shared = a.reason === "target:all";
    return `<li><span translate="no">${esc(a.display_name)}</span>
      <span class="muted">${shared ? esc(t("shared by the whole team")) : withNames(t("added for {name}"), { name })}</span>
      <button type="button" class="team-extra-remove" data-package="${esc(a.package)}" data-checksum="${esc(a.checksum_full)}"
        data-name="${esc(a.display_name)}"${shared ? " data-shared" : ""}>${esc(t("Remove…"))}</button></li>`;
  }).join("");
  const held = new Set((s.assigned || []).map((a) => `${a.package}:${a.checksum_full}`));
  const pool = (capabilityPool?.packages || []).filter((p) => !held.has(`${p.package}:${p.checksum}`));
  const options = pool.map((p) => `<option value="${esc(p.package)}" data-checksum="${esc(p.checksum)}" translate="no">${esc(p.display_name)}</option>`).join("");
  return `<ul class="team-extras">${rows || `<li class="muted">${esc(t("None yet."))}</li>`}</ul>
    <div class="form-row">
      <label for="team-extra-add">${esc(t("Add an extra"))}</label>
      <select id="team-extra-add"${pool.length ? "" : " disabled"}>${options || `<option value="">${esc(capabilityPool ? t("Nothing left to add") : t("The extras could not be loaded"))}</option>`}</select>
      <button type="button" id="team-extra-add-btn"${pool.length ? "" : " disabled"}>${esc(t("Add"))}</button>
    </div>`;
}

function teamModelSection(s) {
  const a = s.assignment;
  const current = a?.role ? `role:${a.role}` : a?.chain ? "chain" : "";
  const roles = [...new Set([...(rolesData?.roles || []).map((r) => r.role), ...(a?.role ? [a.role] : [])])];
  // Model ids are for experts; the select already says "Its own model list".
  const chain = a?.chain && isExpert()
    ? `<p class="muted">${withNames(t("Its own model list: {chain}"), {
      chain: a.chain.map((e) => (typeof e === "string" ? e : `${e.cli ? `${e.cli}:` : ""}${e.model}`)).join(" → ") })}</p>` : "";
  return `<p>${teamModelHtml(s)}</p>${s.model || !isExpert() ? "" : `<p class="muted" translate="no">${esc(s.modelReason || "")}</p>`}
    <div class="form-row">
      <label for="team-role">${esc(t("Role"))}</label>
      <select id="team-role" data-current="${esc(current)}">
        <option value="">${esc(t("No role: it does not start"))}</option>
        ${roles.map((r) => `<option value="role:${esc(r)}" translate="no">${esc(r)}</option>`).join("")}
        ${current === "chain" ? `<option value="chain">${esc(t("Its own model list"))}</option>` : ""}
      </select>
      <button type="button" id="team-role-save" class="primary">${esc(t("Save"))}</button>
      <button type="button" id="team-chain">${esc(t("Custom model list…"))}</button>
    </div>
    <p class="muted" id="team-role-hint" aria-live="polite"></p>
    <p class="muted">${esc(t("The role decides which AI models it works with: the first one with quota left does the job."))}</p>${chain}`;
}

/**
 * What the picked role means: who else is in it and, for a new pick, the model
 * it would start with now. Its current role has "Works with" above: the model
 * a launch of this specialist gets, which can differ from the role's own pick.
 */
function teamRoleHint(s, value, current) {
  if (!value) return esc(t("Without a role it does not start."));
  if (value === "chain") return esc(t("Its own list of models, set with “Custom model list…”."));
  const r = rolesData?.roles.find((x) => x.role === value.slice(5));
  if (!r) return "";
  const others = (r.usedBy || []).filter((u) => u.id !== s.id).map((u) => u.name || u.id);
  return [
    value === current ? ""
      : r.pick?.label ? withNames(t("This role starts with {model} right now."), { model: r.pick.label })
        : esc(t("No model in this role has quota right now.")),
    others.length ? withNames(t("Also in this role: {names}."), { names: new Intl.ListFormat(LANG, { type: "conjunction" }).format(others) })
      : esc(t("No one else is in this role.")),
  ].filter(Boolean).join(" ");
}

function teamTechnical(s) {
  const p = s.permissions || {};
  const versions = (s.versions || []).map((v) => `${v.version}${v.selected ? " ✓" : ""}`).join(", ");
  const row = (label, html) => `<dt>${esc(label)}</dt><dd translate="no">${html}</dd>`;
  return `<details class="team-tech"><summary>${esc(t("Technical details"))}</summary><dl class="kv">
    ${row(t("Id"), `<span class="mono">${esc(s.id)}</span>`)}
    ${row(t("Version"), esc(s.version || "—"))}
    ${(s.versions || []).length > 1 ? row(t("Installed versions"), esc(versions)) : ""}
    ${row(t("Checksum"), `<span class="mono">${esc(s.checksum || "—")}</span>`)}
    ${row(t("Call types"), chips(s.call_types))}
    ${row(t("Timeout"), esc(s.budget?.timeout_seconds ? `${s.budget.timeout_seconds} s` : "—"))}
    ${row(t("Tools"), chips(s.bundled?.tools))}
    ${row(t("Files"), esc(`filesystem: ${p.filesystem ?? "—"} · writes: ${p.writes ?? false} · network: ${p.network ?? false}`))}
    ${row(t("Commands"), chips(p.commands))}
    ${s.exclusions?.length ? row(t("Left out"), esc(s.exclusions.map((e) => `${e.package} (${e.reason})`).join(", "))) : ""}
  </dl></details>`;
}

function renderTeamDetail() {
  const box = $("#team-detail");
  const s = findSpecialist(teamSelectedId());
  if (!s) {
    teamOpenId = null;
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  // A role picked and not saved yet survives a redraw (a roles change, an extra added),
  // unless what it runs on changed meanwhile (a saved custom model list): then the new one shows.
  const old = teamOpenId === s.id ? $("#team-role") : null;
  const picked = old && old.value !== old.dataset.current ? { value: old.value, current: old.dataset.current } : null;
  // A redraw (after a save, an extra added or removed) puts focus back where it was, or near it.
  const a = document.activeElement;
  const had = teamOpenId === s.id && box.contains(a) ? (a.id ? `#${a.id}` : "#team-extra-add") : null;
  const name = teamName(s);
  const bundled = [...(s.bundled?.skills || []), ...(s.bundled?.mcps || []).map((m) => `mcp:${m}`)];
  box.innerHTML = `<div class="team-detail-head">${avatar(s)}
      <div class="team-who"><h2 id="team-detail-name" tabindex="-1" translate="no">${esc(name)}</h2>
        <span class="team-title">${esc(TEAM_TITLE[s.category] ?? TEAM_TITLE.other)}</span></div>
      ${teamStatus(s)}
      <a class="team-close" href="#/specialists" aria-label="${esc(t("Close"))}"><span aria-hidden="true">✕</span></a>
    </div>
    ${s.error ? `<p class="status-line err" translate="no">${esc(s.error)}</p>` : ""}
    <p class="team-last">${teamLastJob(s)}</p>
    <div class="team-cols">
      <section><h3>${esc(t("Good at"))}</h3><ul translate="no">${(s.remit || []).map((r) => `<li>${esc(capitalised(r))}</li>`).join("") || "<li>—</li>"}</ul></section>
      <section><h3>${esc(t("Won't do"))}</h3><ul translate="no">${(s.anti_remit || []).map((r) => `<li>${esc(capitalised(r))}</li>`).join("") || "<li>—</li>"}</ul></section>
    </div>
    <section><h3>${esc(t("Skills"))}</h3>
      <h4>${esc(t("Built-in skills"))}</h4>
      <p class="muted">${withNames(t("They come with {name} and always stay."), { name })}</p>
      <p class="caps" translate="no">${chips(bundled)}</p>
      <h4>${esc(t("Added extras"))}</h4>
      ${teamExtras(s)}
    </section>
    <section><h3>${esc(t("Model"))}</h3>${teamModelSection(s)}</section>
    ${isExpert() ? teamTechnical(s) : ""}`;
  box.classList.remove("hidden");
  const role = $("#team-role");
  role.value = picked && picked.current === role.dataset.current && [...role.options].some((o) => o.value === picked.value)
    ? picked.value : role.dataset.current;
  teamRoleChanged();
  if (teamOpenId !== s.id) {
    teamOpenId = s.id;
    $("#team-detail-name").focus({ preventScroll: true });
    box.scrollIntoView({ block: "nearest" });
  } else if (had) {
    // A disabled control takes no focus: then the heading.
    box.querySelector(had)?.focus({ preventScroll: true });
    if (!box.contains(document.activeElement)) $("#team-detail-name").focus({ preventScroll: true });
  }
}

/** Save only when the pick differs from what it runs on now. */
function teamRoleChanged() {
  const role = $("#team-role");
  $("#team-role-save").disabled = role.value === role.dataset.current;
  const s = findSpecialist(teamSelectedId());
  if (s) $("#team-role-hint").innerHTML = teamRoleHint(s, role.value, role.dataset.current);
}

async function assignCapability(id, pkg, checksum, action, note) {
  try {
    await api(`/api/specialists/${encodeURIComponent(id)}/capabilities`, {
      method: "POST",
      body: JSON.stringify({ package: pkg, checksum, action }),
    });
    await refreshSpecialists();
    teamNote(note, "ok");
  } catch (err) {
    teamNote(esc(t("Not saved: {error}", { error: err.message })), "err");
  }
}

/**
 * Never throws: a failure shows on the page. Without data yet that is the
 * grid's place, with a retry; with data, the cards stay and a note says so.
 * The extras list on its own failing only leaves "Add an extra" empty.
 */
async function refreshSpecialists() {
  const seq = ++teamSeq;
  const [specialists, pool] = await Promise.allSettled([api("/api/specialists"), api("/api/capability-pool")]);
  if (seq !== teamSeq) return;
  capabilityPool = pool.status === "fulfilled" ? pool.value : null;
  if (specialists.status === "rejected") {
    const text = t("Could not load the team: {error}", { error: specialists.reason.message });
    if (specialistsData) teamNote(esc(text), "err");
    else {
      teamNote("");
      $("#team-grid").innerHTML = `<div class="empty"><p>${esc(text)}</p><button type="button" id="team-retry">${esc(t("Retry"))}</button></div>`;
    }
    return;
  }
  if ($("#team-status").classList.contains("err")) teamNote("");
  specialistsData = specialists.value;
  renderTeam();
}

$("#team-grid").addEventListener("click", (e) => {
  if (e.target.closest("#team-retry")) refreshSpecialists();
});

// The cards at once from what is loaded, then fresh: the model a launch gets moves with quota.
onEnter.specialists = () => {
  renderTeam();
  refreshSpecialists();
};

async function assignSpecialist(id, body, note) {
  try {
    await api(`/api/specialists/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify(body) });
    teamNote(note, "ok");
    await refreshSpecialists();
    return true;
  } catch (err) {
    teamNote(esc(t("Not saved: {error}", { error: err.message })), "err");
    return false;
  }
}

/** Raw roster chain entries → the editor's {cli, model, effort, pinned}. */
function editorChain(chain) {
  return (chain || []).map((e) => {
    if (typeof e !== "string") return e;
    const i = e.indexOf(":");
    return i === -1 ? { model: e } : { cli: e.slice(0, i), model: e.slice(i + 1) };
  });
}

function openSpecialistChain(s) {
  // Start from what it runs on now, so "own chain" is an edit, not a blank.
  const a = s.assignment;
  const chain = a?.chain ? editorChain(a.chain) : rolesData?.roles.find((r) => r.role === a?.role)?.chain;
  openRoleEditor({ chain }, s.id);
}

$("#team-detail").addEventListener("change", (e) => {
  if (e.target.id === "team-role") teamRoleChanged();
});

$("#team-detail").addEventListener("click", async (e) => {
  const s = findSpecialist(teamSelectedId());
  if (!s) return;
  const name = teamName(s);
  if (e.target.closest("#team-role-save")) {
    const value = $("#team-role").value;
    const role = value.startsWith("role:") ? value.slice(5) : null;
    if (!role && !await confirmDialog({
      title: withNames(t("Turn {name} off?"), { name }),
      text: withNames(t("Without a role {name} does not start, and nothing hands it work. Pick a role again to turn it back on."), { name }),
      yes: t("Turn off"),
    })) return;
    await assignSpecialist(s.id, role ? { role } : {}, role
      ? withNames(t("{name} now works in the role {role}."), { name, role })
      : withNames(t("{name} has no role now and does not start."), { name }));
  } else if (e.target.closest("#team-chain")) {
    openSpecialistChain(s);
  } else if (e.target.closest("#team-extra-add-btn")) {
    const option = $("#team-extra-add").selectedOptions[0];
    if (option?.value) {
      await assignCapability(s.id, option.value, option.dataset.checksum, "enable",
        withNames(t("{name} now has {extra}."), { name, extra: option.textContent }));
    }
  } else if (e.target.closest(".team-extra-remove")) {
    const btn = e.target.closest(".team-extra-remove");
    const extra = btn.dataset.name;
    // ✕ meant two things: a shared extra is left out for this one, an own one is removed.
    const shared = btn.hasAttribute("data-shared");
    const ok = await confirmDialog(shared ? {
      title: withNames(t("Leave {extra} out for {name}?"), { extra, name }),
      text: withNames(t("{extra} is shared by the whole team. {name} no longer gets it; everyone else keeps it. You can add it back any time."), { extra, name }),
      yes: t("Leave it out"),
    } : {
      title: withNames(t("Remove {extra} from {name}?"), { extra, name }),
      text: withNames(t("{name} no longer gets this extra. You can add it again any time."), { name }),
      yes: t("Remove"),
    });
    if (ok) {
      await assignCapability(s.id, btn.dataset.package, btn.dataset.checksum, "disable",
        withNames(t("{name} no longer gets {extra}."), { name, extra }));
    }
  }
});

const installDialog = $("#specialist-install-dialog");
$("#specialist-add").addEventListener("click", () => {
  $("#specialist-install-status").textContent = "";
  installDialog.showModal();
});

$("#specialist-install-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#specialist-install-status");
  const repo = $("#specialist-repo").value.trim();
  const btn = e.submitter;
  btn.disabled = true;
  status.textContent = t("Installing {repo}…", { repo });
  try {
    const result = await api("/api/specialists/install", {
      method: "POST",
      body: JSON.stringify({ repo, subdir: $("#specialist-subdir").value.trim() }),
    });
    $("#specialist-repo").value = "";
    $("#specialist-subdir").value = "";
    installDialog.close();
    teamNote(withNames(t("Installed {name}."), { name: `${result.id}@${result.version}` }), "ok");
    await refreshSpecialists();
  } catch (err) {
    status.textContent = t("That did not work: {error}", { error: err.message });
  } finally {
    btn.disabled = false;
  }
});

// ── Synced preferences ────────────────────────────────────────────────────
// Every `teamup.*` key also lives on the server. localStorage stays the working
// copy and the server copy replaces it once the login is known. The last device
// to change something wins.
const PREF_PREFIX = "teamup.";
const LEGACY_LAYOUT_KEY = "teamup.layout";
// Per browser, never synced: a filter, tab or view choice, and a half-typed answer.
const LOCAL_ONLY_KEYS = new Set(["teamup.acFilter", "teamup.acProject", "teamup.timView", "teamup.timKind",
  "teamup.trendingSection", "teamup.catalogueKind", "teamup.rolesTab", "teamup.sessionCli", EXPERT_KEY]);
const isLocalOnly = (key) => LOCAL_ONLY_KEYS.has(key) || key.startsWith("teamup.draft.");
// Keys nothing reads any more: they leave this browser and the server copy.
const DEAD_KEYS = [LEGACY_LAYOUT_KEY, "teamup.acClosed", "teamup.projectsAutoFix"];

function localPrefs() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(PREF_PREFIX) && !DEAD_KEYS.includes(key) && !isLocalOnly(key)) out[key] = localStorage.getItem(key);
    }
    for (const key of DEAD_KEYS) localStorage.removeItem(key);
  } catch {
    // storage blocked: nothing local to sync
  }
  return out;
}

const sameKeys = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function pushPrefs() {
  // Keepalive lets a preference update finish during a page reload.
  api("/api/prefs", { method: "POST", body: JSON.stringify(localPrefs()), keepalive: true }).catch(() => {});
}

/** Adopt the server's prefs; reloads once when they differ from this browser's. */
async function pullPrefs() {
  const remote = await api("/api/prefs");
  // Dead keys, and per-browser keys an older page synced: they leave the server copy too.
  const stale = Object.keys(remote).filter((key) => DEAD_KEYS.includes(key) || isLocalOnly(key));
  for (const key of stale) delete remote[key];
  const local = localPrefs();
  if (!Object.keys(remote).length) {
    // First device after the switch to server prefs: seed it from here.
    if (Object.keys(local).length || stale.length) pushPrefs();
    return;
  }
  if (sameKeys(remote, local)) {
    if (stale.length) pushPrefs();
    return;
  }
  try {
    for (const key of Object.keys(local)) if (!(key in remote)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(remote)) localStorage.setItem(key, value);
  } catch {
    return; // storage blocked: keep what is on screen
  }
  if (stale.length) {
    await api("/api/prefs", { method: "POST", body: JSON.stringify(localPrefs()) }).catch(() => {});
  }
  location.reload();
}

// ── Projects ──────────────────────────────────────────────────────────────
// One row per project in the projects folder: what waits for you there (the
// inbox), what is being worked on there (the runs list, resolved to its real
// project), and a session to work in it yourself. Folders that are no project
// of yours (clone roots, folders without git, specialist packages) fold away
// under "Other folders". The projects folder is a synced preference (every
// browser talks to the same server), set in Settings → General: the server
// takes it per request and never stores it.
const PROJECTS_DIR_KEY = "teamup.projectsDir";
const SESSION_CLI_KEY = "teamup.sessionCli";
const WAITING_STATUSES = new Set(["waiting_human", "waiting_decision"]);
const OTHER_REASON = {
  clones: t("clone folder"),
  "not-git": t("not a git repository"),
  "specialist-bundle": t("specialist package"),
};
let projectsData = null;
/** The folder the server listed, for the Settings placeholder. */
let projectsDirShown = "";
let projectsKey = "";
let projectsByPath = new Map();
let projectsNote = "";
/** /api/runs rows, kept by refreshRuns for "Working now". */
let runsRows = [];

function readProjectsDir() {
  try {
    return localStorage.getItem(PROJECTS_DIR_KEY) || "";
  } catch {
    return "";
  }
}

async function refreshProjects() {
  try {
    projectsData = await api(`/api/projects?dir=${encodeURIComponent(readProjectsDir())}`);
  } catch (err) {
    projectsData = null;
    projectsKey = "";
    $("#projects-status").textContent = t("Could not load the projects: {error}", { error: err.message });
    $("#projects-table").innerHTML = "";
    $("#projects-other").classList.add("hidden");
    $("#projects-other-list").innerHTML = "";
    return;
  }
  projectsDirShown = projectsData.dir;
  projectsByPath = new Map(projectsData.projects.map((p) => [p.path, p]));
  renderProjects();
}

function policyCell(p) {
  const pol = p.policy || { state: "none" };
  const tag = (tone, text, title = "") => `<span class="tag ${tone}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  const create = `<button type="button" class="policy-create" data-dir="${esc(p.path)}">${esc(t("Create…"))}</button>`;
  if (pol.state === "valid" || pol.state === "inherited") {
    // Approving stays a terminal step on purpose; the command is in sight, not only in a tooltip.
    const ready = pol.trusted === false
      ? `${tag("warn", t("Not approved yet"), t("Changed since it was approved, or never approved."))}
        <span class="policy-approve">${esc(t("Approve it in a terminal:"))} <code translate="no">team-up specialist trust-policy --project ${esc(p.path)}</code></span>`
      : tag("ok", t("Ready"));
    return pol.state === "inherited" ? `${ready} ${tag("", t("from the folder above"))}` : ready;
  }
  if (pol.state === "invalid") return tag("err", t("Broken"), (pol.errors || []).join("\n"));
  if (pol.state === "missing") {
    return `${tag("warn", t("Missing"), pol.proposal?.auto ? t("Found one test command: check it and create it.") : t("Several candidates: check the proposal."))} ${create}`;
  }
  return `${tag("off", t("No tests found"))} ${create}`;
}

function renderProjects() {
  const data = projectsData;
  if (!data) return;
  const expert = isExpert();
  // Questions and problems, like the inbox badge; results wait too, but not on you.
  const waiting = new Map();
  for (const i of acData?.items || []) {
    if (i.kind !== "result" && i.project?.name) waiting.set(i.project.name, (waiting.get(i.project.name) || 0) + 1);
  }
  // A waiting run is not working: it waits for you, and is counted there.
  const working = new Map();
  for (const r of runsRows) {
    if (r.active && !WAITING_STATUSES.has(r.status) && r.project) working.set(r.project, (working.get(r.project) || 0) + 1);
  }
  const count = (n) => (n ? String(n) : '<span class="muted">0</span>');
  // data-label: on a phone the header row goes and each cell names itself.
  const label = (text) => ` data-label="${esc(text)}"`;
  const row = (p) => {
    const w = waiting.get(p.name) || 0;
    const chips = expert ? [
      p.git && !p.mainBranch ? `<span class="tag warn">${esc(t("side branch {branch}")).replace("{branch}", () => `<span translate="no">${esc(p.branch)}</span>`)}</span>` : "",
      p.dirty ? `<span class="tag">${esc(t("uncommitted changes"))}</span>` : "",
    ].filter(Boolean).join(" ") : "";
    return `<tr data-row="${esc(p.name)}">
      <td><span class="project-name" translate="no">${esc(p.name)}</span>${chips ? ` ${chips}` : ""}</td>
      <td${label(t("Waiting for you"))}>${w ? `<a href="#/actions" class="project-inbox" data-project="${esc(p.name)}"
        aria-label="${esc(t("{n} waiting in {project}: open the inbox", { n: w, project: p.name }))}">${w}</a>` : count(0)}</td>
      <td${label(t("Working now"))}>${count(working.get(p.name) || 0)}</td>
      ${expert ? `<td class="nowrap"${label(t("Test command"))}>${policyCell(p)}</td>
      <td translate="no"${label(t("Sessions"))}>${p.sessions.map((s) => `<a href="#" class="session-link" data-session="${esc(s)}">${esc(s.replace(/^team-up-proj-/, ""))}</a>`).join(" ") || "—"}</td>` : ""}
      <td class="project-action"><button type="button" class="project-open" data-dir="${esc(p.path)}">${esc(t("Open session…"))}</button></td>
    </tr>`;
  };
  // Something waiting or working first; the rest by name, as listed.
  const busy = (p) => (waiting.get(p.name) || 0) + (working.get(p.name) || 0);
  const mine = data.projects.filter((p) => !p.other).sort((a, b) => busy(b) - busy(a));
  const other = data.projects.filter((p) => p.other);
  const table = `<table>
    <thead><tr><th data-col-key="Project">${esc(t("Project"))}</th><th data-col-key="Waiting for you">${esc(t("Waiting for you"))}</th><th data-col-key="Working now">${esc(t("Working now"))}</th>${
      expert ? `<th data-col-key="Test command">${esc(t("Test command"))}</th><th data-col-key="Sessions">${esc(t("Sessions"))}</th>` : ""}<th></th></tr></thead>
    <tbody>${mine.map(row).join("") || `<tr><td colspan="${expert ? 6 : 4}">${esc(t("No projects in this folder yet."))}</td></tr>`}</tbody></table>`;
  const otherList = other.map((p) => `<li><span translate="no">${esc(p.name)}</span> <span class="muted">${esc(OTHER_REASON[p.otherReason] ?? "")}</span></li>`).join("");
  $("#projects-status").textContent = projectsNote;
  // Unchanged: no redraw, so focus and the open "Other folders" stay where they are.
  const key = table + otherList;
  if (key === projectsKey) return;
  projectsKey = key;
  const a = document.activeElement;
  const refocus = a && $("#projects-table").contains(a) && a.classList[0]
    ? `.${a.classList[0]}${["dir", "project", "session"].filter((k) => a.dataset[k]).map((k) => `[data-${k}="${CSS.escape(a.dataset[k])}"]`).join("")}`
    : null;
  $("#projects-table").innerHTML = table;
  if (refocus) $(`#projects-table ${refocus}`)?.focus({ preventScroll: true });
  $("#projects-other").classList.toggle("hidden", !other.length);
  $("#projects-other-summary").textContent = t("Other folders ({n})", { n: other.length });
  $("#projects-other-list").innerHTML = otherList;
}

$("#projects-table").addEventListener("click", (e) => {
  const inbox = e.target.closest(".project-inbox");
  if (inbox) {
    // The link goes to the inbox; this makes it show that project only, for this visit.
    acVisit = { project: inbox.dataset.project };
    return;
  }
  const session = e.target.closest(".session-link");
  if (session) {
    e.preventDefault();
    selectSession(session.dataset.session);
    return;
  }
  const policy = e.target.closest(".policy-create");
  if (policy) openPolicyEditor(projectsByPath.get(policy.dataset.dir));
  const open = e.target.closest(".project-open");
  if (open) openSessionDialog(projectsByPath.get(open.dataset.dir));
});

// Any dialog's Cancel.
document.addEventListener("click", (e) => {
  e.target.closest("dialog [data-close]")?.closest("dialog").close();
});

const sessionDialog = $("#project-session");

/** Which CLI: the one this browser started last, else claude, else the first. */
function openSessionDialog(p) {
  if (!p) return;
  const clis = projectsData?.clis || [];
  const last = readStored(SESSION_CLI_KEY, "");
  const select = $("#project-session-cli");
  select.innerHTML = clis.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  select.value = clis.includes(last) ? last : clis.includes("claude") ? "claude" : clis[0] || "";
  $("#project-session-title").innerHTML = esc(t("Open a session in {project}")).replace("{project}", () => `<span translate="no">${esc(p.name)}</span>`);
  $("#project-session-status").textContent = "";
  sessionDialog.dataset.dir = p.path;
  sessionDialog.showModal();
}

$("#project-session-form").addEventListener("submit", async (e) => {
  // Not method="dialog": a refused start leaves the dialog open and says why.
  e.preventDefault();
  const cli = $("#project-session-cli").value;
  const btn = e.submitter;
  btn.disabled = true;
  $("#project-session-status").textContent = "";
  try {
    const res = await api("/api/projects/session", {
      method: "POST",
      body: JSON.stringify({ dir: sessionDialog.dataset.dir, cli, projects_dir: readProjectsDir() }),
    });
    writeStored(SESSION_CLI_KEY, cli);
    sessionDialog.close();
    refreshProjects().catch(() => {});
    selectSession(res.session);
  } catch (err) {
    $("#project-session-status").textContent = t("Could not start the session: {error}", { error: err.message });
  } finally {
    btn.disabled = false;
  }
});

const newProjectDialog = $("#project-new");
$("#projects-new").addEventListener("click", () => {
  $("#project-new-status").textContent = "";
  newProjectDialog.showModal();
});

$("#project-new-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#project-new-name");
  const name = input.value.trim();
  const btn = e.submitter;
  btn.disabled = true;
  $("#project-new-status").textContent = "";
  try {
    const res = await api("/api/projects/create", {
      method: "POST",
      body: JSON.stringify({ name, projects_dir: readProjectsDir() }),
    });
    // A failed TIM setup still created the folder; its reason is technical.
    projectsNote = res.warning ? `${t("Created {name}.", { name })} ${res.warning}` : t("Created {name}.", { name });
    input.value = "";
    newProjectDialog.close();
    await refreshProjects();
  } catch (err) {
    $("#project-new-status").textContent = t("Not created: {error}", { error: err.message });
  } finally {
    btn.disabled = false;
  }
});

// The editor is a <dialog> outside the table: the table is redrawn when the
// data changes and would throw away half-typed JSON. It only creates: an
// existing file is never overwritten, and approving one stays in a terminal.
const policyDialog = $("#policy-editor");
let policyTarget = null;

const EMPTY_POLICY = {
  schema_version: 1,
  commands: {
    "project-test": { argv: ["npm", "test"], cwd: ".", timeout_seconds: 900, environment: {} },
  },
};

function openPolicyEditor(p) {
  if (!p) return;
  policyTarget = p;
  $("#policy-editor-where").textContent = p.path;
  $("#policy-editor-json").value = JSON.stringify(p.policy?.proposal?.policy || EMPTY_POLICY, null, 2);
  $("#policy-editor-status").textContent = p.policy?.proposal
    ? (p.policy.proposal.auto ? t("Found one test command.") : t("A proposal only: check the command before you create it."))
    : t("No test command found: fill in the one this project uses.");
  policyDialog.showModal();
}

$("#policy-editor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#policy-editor-status");
  let policy;
  try {
    policy = JSON.parse($("#policy-editor-json").value);
  } catch (err) {
    status.textContent = t("Not valid JSON: {error}", { error: err.message });
    return;
  }
  try {
    await api("/api/projects/policy", {
      method: "POST",
      body: JSON.stringify({ dir: policyTarget.path, projects_dir: readProjectsDir(), policy }),
    });
    policyDialog.close();
    projectsNote = t("Test command written into {project} (not committed).", { project: policyTarget.name });
    await refreshProjects();
  } catch (err) {
    status.textContent = t("That did not work: {error}", { error: err.message });
  }
});

// ── TIM ───────────────────────────────────────────────────────────────────
// Only there when `tim open-work` answers: no TIM, no panel. Tasks, ideas and
// bugs of every project in three tabs, each project its own <details> so a
// backlog of ten projects is still one screen. The collecting folder is the
// Projects panel's — the same repos, read through the .tim-project markers.
const TIM_KIND_KEY = "teamup.timKind";
const TIM_CLOSED_KEY = "teamup.timClosed";
// How many are open, per kind, in whole words.
const TIM_KINDS = {
  task: (n) => tp(n, { one: "{n} open task", other: "{n} open tasks" }),
  idea: (n) => tp(n, { one: "{n} open idea", other: "{n} open ideas" }),
  bug: (n) => tp(n, { one: "{n} open bug", other: "{n} open bugs" }),
};
// TIM's status words; one TIM does not know stays as it is.
const TIM_STATUS = {
  todo: t("to do"), open: t("open"), in_progress: t("in progress"), review: t("in review"), blocked: t("blocked"), done: t("done"),
};
// The older word scale of priorities; P0–P3 stay as they are.
const TIM_PRIORITY = { critical: t("critical"), high: t("high"), medium: t("medium"), low: t("low") };

function readStored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    if (!isLocalOnly(key)) pushPrefs();
  } catch {
    // Private mode: the choice just stops surviving reloads.
  }
}

// Rank 0-1 red, rank 2 amber — the same scale as the overview's TIM tile.
function priorityTone(p) {
  const v = String(p).trim().toUpperCase();
  return URGENT_PRIORITIES.has(v) ? "err" : ["P2", "2", "MEDIUM"].includes(v) ? "warn" : "off";
}

function timKind() {
  const kind = readStored(TIM_KIND_KEY, "task");
  return TIM_KINDS[kind] ? kind : "task";
}

async function refreshTim() {
  const status = $("#tim-status");
  let data;
  try {
    data = await api(`/api/tim?dir=${encodeURIComponent(readProjectsDir())}`);
  } catch (err) {
    status.textContent = t("That did not work: {error}", { error: err.message });
    return;
  }
  dashboardMetrics.tim = data;
  updateDashboardMetrics();
  // The panel and its nav link exist in the markup but stay hidden until TIM
  // answers, so a dashboard without TIM never shows an empty box. The class,
  // not the attribute: `nav a` sets display and would win over [hidden].
  $("#nav-tim").classList.toggle("hidden", !data.installed);
  if (!timViewShown) showTimView(readStored(TIM_VIEW_KEY, "work"));
  if (!data.installed) return;

  fillSelect($("#tim-launch-cli"), (data.clis || []).map((c) => ({ value: c, label: c })));
  timModels = data.models || [];
  fillModels();

  const kind = timKind();
  for (const tab of $("#tim-tabs").querySelectorAll(".tim-tab")) {
    tab.classList.toggle("is-active", tab.dataset.kind === kind);
    tab.setAttribute("aria-pressed", String(tab.dataset.kind === kind));
  }
  const closed = new Set(readStored(TIM_CLOSED_KEY, []));

  const groups = data.projects
    .map((p) => ({ ...p, items: p.items.filter((i) => i.kind === kind) }))
    .filter((p) => p.items.length > 0);
  const total = groups.reduce((n, p) => n + p.items.length, 0);
  status.textContent = `${TIM_KINDS[kind](total)} · ${tp(groups.length, { one: "{n} project", other: "{n} projects" })}`;

  $("#tim-list").innerHTML = groups.map((p) => `
    <details class="tim-project" data-project="${esc(p.label)}"${closed.has(p.label) ? "" : " open"}>
      <summary><span translate="no">${esc(p.title.split(" | ")[0])}</span> <span class="muted">${p.items.length}</span></summary>
      <ul class="tim-items">${p.items.map((item) => `
        <li>
          <span class="muted">${esc(TIM_STATUS[item.status] ?? item.status)}${item.priority ? ` <span class="tag ${priorityTone(item.priority)}">${esc(TIM_PRIORITY[String(item.priority).toLowerCase()] ?? item.priority)}</span>` : ""}</span>
          <span translate="no">${esc(item.title)}</span>
          ${item.sessions.length
            ? item.sessions.map((sess) => `<a href="#" class="session-link" data-session="${esc(sess)}">${esc(t("running"))}</a>`).join(" ")
            : p.dir
              ? `<button type="button" class="tim-start" data-id="${esc(item.id)}">${esc(t("Start…"))}</button>`
              : `<span class="muted">${esc(t("no project folder"))}</span>`}
        </li>`).join("")}</ul>
    </details>`).join("") || `<p class="muted">${esc(t("Nothing open."))}</p>`;

  $("#tim-list").querySelectorAll(".tim-project").forEach((el) => {
    el.addEventListener("toggle", () => {
      const shut = new Set(readStored(TIM_CLOSED_KEY, []));
      if (el.open) shut.delete(el.dataset.project);
      else shut.add(el.dataset.project);
      writeStored(TIM_CLOSED_KEY, [...shut]);
    });
  });
  $("#tim-list").querySelectorAll(".session-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      selectSession(a.dataset.session);
    });
  });
  // Start opens the dialog instead of spawning: the prompt is the user's to
  // rewrite before an agent acts on it.
  const items = new Map(groups.flatMap((p) => p.items.map((i) => [i.id, { ...i, project: p }])));
  $("#tim-list").querySelectorAll(".tim-start").forEach((btn) => {
    btn.addEventListener("click", () => openLaunchDialog(items.get(btn.dataset.id)));
  });
}

const launchDialog = $("#tim-launch");
let timModels = [];

/** Only the models the chosen CLI actually runs — the roster says which. */
function fillModels() {
  const cli = $("#tim-launch-cli").value;
  fillSelect($("#tim-launch-model"), [
    { value: "", label: t("— the CLI's default —") },
    ...timModels
      .filter((m) => !cli || (m.clis || []).includes(cli))
      .map((m) => ({ value: m.id, label: m.label || m.id })),
  ]);
}

$("#tim-launch-cli").addEventListener("change", fillModels);

/** Rewrite a <select> without losing what the user had picked. */
function fillSelect(select, options) {
  const keep = select.value;
  const html = options
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  if (select.innerHTML !== html) select.innerHTML = html;
  if (options.some((o) => o.value === keep)) select.value = keep;
}

/** The specialist's remit, so what the framing will say is visible beforehand. */
function showRemit() {
  const id = $("#tim-launch-specialist").value;
  const spec = (specialistsData?.specialists || []).find((s) => s.id === id);
  if (!spec) {
    $("#tim-launch-remit").textContent = "";
    return;
  }
  $("#tim-launch-remit").textContent =
    `${spec.display_name || spec.id}: ${(spec.remit || []).join("; ")}. ${t("An interactive session: no sandbox, no approval, no RESULT.json.")}`;
}

$("#tim-launch-specialist").addEventListener("change", showRemit);

function openLaunchDialog(item) {
  if (!item) return;
  $("#tim-launch-title").textContent = item.title;
  $("#tim-launch-where").textContent = `${item.kind} ${item.id} · ${item.project.dir}`;
  $("#tim-launch-prompt").value = item.prompt;
  $("#tim-launch-status").textContent = "";
  // The Specialists panel already holds the installed list; the specialist
  // contributes its remit as prompt framing, built server-side from the
  // manifest — the browser never authors a specialist's contract text.
  fillSelect($("#tim-launch-specialist"), [
    { value: "", label: t("— none —") },
    ...(specialistsData?.specialists || [])
      .filter((s) => !s.error)
      .map((s) => ({ value: s.id, label: s.display_name || s.id })),
  ]);
  fillModels();
  showRemit();
  launchDialog.dataset.id = item.id;
  launchDialog.showModal();
}

$("#tim-launch-cancel").addEventListener("click", () => launchDialog.close());

$("#tim-launch-form").addEventListener("submit", async (event) => {
  // Not method="dialog": a refused start has to leave the dialog open with the
  // typed prompt still in it.
  event.preventDefault();
  const status = $("#tim-launch-status");
  status.textContent = t("Starting…");
  try {
    const res = await api("/api/tim/session", {
      method: "POST",
      body: JSON.stringify({
        id: launchDialog.dataset.id,
        cli: $("#tim-launch-cli").value,
        prompt: $("#tim-launch-prompt").value,
        specialist: $("#tim-launch-specialist").value || null,
        model: $("#tim-launch-model").value || null,
        projects_dir: readProjectsDir(),
      }),
    });
    launchDialog.close();
    await refreshTim();
    selectSession(res.session);
  } catch (err) {
    status.textContent = t("That did not work: {error}", { error: err.message });
  }
});

$("#tim-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest(".tim-tab");
  if (!tab) return;
  writeStored(TIM_KIND_KEY, tab.dataset.kind);
  refreshTim().catch(() => {});
});

// ── Settings ──────────────────────────────────────────────────────────────
// Rendered from the server's registry (src/dashboard/settings.mjs): every
// field arrives with its label, help, unit, default and bounds, so this file
// knows no setting by name. Not on the five-second cycle — it would reset a
// field mid-edit; it loads on entering the view and after each save.
const SETTINGS_ADVANCED_KEY = "teamup.settingsAdvanced";
let settingsData = null;

// Buttons that act rather than set, shown under their group.
const GROUP_ACTIONS = {
  workers: [{
    label: t("Lift the post-restart cap"),
    title: t("After a memory-caused restart team-up limits the helpers for 24 h; this lifts the limit now"),
    endpoint: "/api/actions/admission-reset",
    done: (r) => (r.lifted ? t("Cap lifted.") : t("There was no cap to lift.")),
  }],
};

const pct = (v) => `${Math.round(v * 1000) / 10} %`;

function formatSetting(f, v) {
  if (v === undefined) return "—";
  if (v === null) return f.nullLabel || t("not set");
  if (f.type === "bool") return v ? t("on") : t("off");
  if (f.type === "ratio") return pct(v);
  if (f.type === "set") {
    if (!v.length) return t("none");
    return v.map((x) => f.options.find((o) => o.value === x)?.label ?? x).join(", ");
  }
  if (f.type === "enum") return f.options.find((o) => o.value === v)?.label ?? String(v);
  return `${v}${f.unit ? ` ${f.unit}` : ""}`;
}

function settingControl(f) {
  const id = `set-${f.path.replace(/[^a-z0-9]/gi, "-")}`;
  const cur = f.value === undefined ? f.default : f.value;
  const attrs = `id="${id}" data-path="${esc(f.path)}" data-type="${f.type}"`;
  const label = f.row ? `<label for="${id}" class="muted">${esc(f.label)}</label>` : "";
  switch (f.type) {
    case "bool":
      return `<label class="switch">${f.row ? esc(f.label) : ""}<input type="checkbox" ${attrs}${cur ? " checked" : ""}
        aria-label="${esc(f.label)}"></label>`;
    case "ratio":
      return `${label}<input type="number" ${attrs} min="0" max="100" step="0.5" value="${f.value === undefined ? "" : Math.round(f.value * 1000) / 10}"
        placeholder="${f.default == null ? "" : Math.round(f.default * 1000) / 10}" aria-label="${esc(f.label)}"><span class="unit">%</span>`;
    case "int":
    case "number":
      return `${label}<input type="number" ${attrs} step="${f.type === "int" ? 1 : "any"}"${f.min != null ? ` min="${f.min}"` : ""}${f.max != null ? ` max="${f.max}"` : ""}
        value="${f.value == null ? "" : f.value}" placeholder="${f.default == null ? esc(f.nullLabel || "") : f.default}" aria-label="${esc(f.label)}">${
        f.unit ? `<span class="unit">${esc(f.unit)}</span>` : ""}`;
    case "enum":
      return `${label}<select ${attrs} aria-label="${esc(f.label)}">${f.nullable ? `<option value="__null__"${cur == null ? " selected" : ""}>${esc(f.nullLabel || t("not set"))}</option>` : ""}${
        f.options.map((o) => `<option value="${esc(o.value)}"${o.value === cur ? " selected" : ""}>${esc(o.label || "—")}</option>`).join("")}</select>`;
    case "set":
      return `<span class="chips" role="group" aria-label="${esc(f.label)}">${f.options.map((o) =>
        `<label><input type="checkbox" data-set="${esc(f.path)}" value="${esc(JSON.stringify(o.value))}"${
          (cur || []).includes(o.value) ? " checked" : ""}> ${esc(o.label)}</label>`).join("")}</span>`;
    default:
      return "";
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function settingMeta(f) {
  const changed = f.value !== undefined && !same(f.value, f.default);
  const def = f.default === undefined ? "" : t("default {value}", { value: formatSetting(f, f.default) });
  return `<span class="set-meta">${changed ? `<span class="tag changed">${esc(t("changed"))}</span> ` : ""}${esc(def)}${
    changed && !f.required ? ` · <button type="button" class="link" data-reset="${esc(f.path)}">${esc(t("reset"))}</button>` : ""}</span>`;
}

function settingRow(fields) {
  const [first] = fields;
  const title = first.row
    ? `${esc(first.row)}`
    : `${esc(first.label)}`;
  const help = [...new Set(fields.map((f) => f.help).filter(Boolean))].join(" ");
  // Written by hand in roster.json, in whatever language: experts only, never translated.
  const note = isExpert() ? fields.map((f) => f.note).filter(Boolean).join(" ") : "";
  const effect = first.effect ? `<span class="effect">${esc(t("Takes effect: {effect}", { effect: first.effect }))}</span>` : "";
  // The roster path of a setting is for experts.
  return `<div class="set-row" data-paths="${esc(fields.map((f) => f.path).join(" "))}">
    <div class="set-label">${title}${first.row || !isExpert() ? "" : `<span class="row-name mono">${esc(first.path)}</span>`}</div>
    <div class="set-control">${fields.map((f) => `<span class="set-field">${settingControl(f)}</span>${fields.length === 1 ? settingMeta(f) : ""}`).join("")}</div>
    <p class="set-help">${esc(help)}${note ? `<span translate="no">${esc(note)}</span>` : ""}${fields.length > 1 ? ` ${fields.map(settingMeta).filter((m) => m.includes("changed")).length ? "" : ""}` : ""}${effect}</p>
  </div>`;
}

/** Settings → General rows kept in this browser rather than in roster.json. */
function browserSettingRows(q) {
  const rows = [{
    label: t("Expert view"),
    help: t("Also shows the technical views and details: sessions and runs, roles and models, providers, CLIs, ids and paths. Only in this browser."),
    control: `<label class="switch"><input type="checkbox" class="expert-toggle" aria-label="${esc(t("Expert view"))}"${isExpert() ? " checked" : ""}></label>`,
  }, {
    label: t("Projects folder"),
    help: t("The folder that holds your projects: Projects lists every folder in it. The same in every browser you sign in from."),
    control: `<input type="text" id="projects-dir" class="mono" data-client="projects-dir" value="${esc(readProjectsDir())}"
      placeholder="${esc(projectsDirShown || "~/projects")}" autocomplete="off" spellcheck="false" aria-label="${esc(t("Projects folder"))}">`,
  }];
  return rows.filter((r) => !q || `${r.label} ${r.help}`.toLowerCase().includes(q)).map((r) => `<div class="set-row">
    <div class="set-label">${esc(r.label)}</div>
    <div class="set-control">${r.control}</div>
    <p class="set-help">${esc(r.help)}</p>
  </div>`).join("");
}

function renderSettings() {
  if (!settingsData) return;
  // The toggle is an expert control: hidden, a synced "advanced" must not stick.
  const advanced = isExpert() && $("#settings-advanced").checked;
  const q = $("#settings-search").value.trim().toLowerCase();
  const hit = (f) => !q || [f.label, f.help, f.path, f.row, f.group].some((text) => String(text || "").toLowerCase().includes(q));
  const html = settingsData.groups.map((g) => {
    if (g.advanced && !advanced && !q) return "";
    const fields = settingsData.fields.filter((f) => f.group === g.id && (advanced || q || !f.advanced) && (hit(f) || g.title.toLowerCase().includes(q)));
    const local = g.id === "general" ? browserSettingRows(q) : "";
    if (!fields.length && !local) return "";
    const rows = [];
    for (const f of fields) {
      const last = rows.at(-1);
      if (f.row && last?.[0].row === f.row) last.push(f);
      else rows.push([f]);
    }
    const hidden = settingsData.fields.filter((f) => f.group === g.id && f.advanced).length;
    const actions = (GROUP_ACTIONS[g.id] || []).map((a, i) =>
      `<button type="button" data-group-action="${g.id}:${i}" title="${esc(a.title)}">${esc(a.label)}</button>`).join(" ");
    return `<section class="set-group" id="group-${g.id}">
      <h2>${esc(g.title)}</h2>
      <p class="intro">${esc(g.intro)}</p>
      ${rows.map(settingRow).join("")}${local}
      ${actions ? `<div class="toolbar" style="margin-top:.6rem">${actions}</div>` : ""}
      ${isExpert() && !advanced && !q && hidden ? `<p class="muted">${esc(tp(hidden, {
        one: "{n} advanced setting hidden: tick “Show advanced”.", other: "{n} advanced settings hidden: tick “Show advanced”." }))}</p>` : ""}
    </section>`;
  }).join("");
  $("#settings-body").innerHTML = html || `<p class="empty">${esc(t("No setting matches “{query}”.", { query: q }))}</p>`;
  $("#settings-excluded").innerHTML = settingsData.excluded.map((x) =>
    `<li><strong>${esc(x.what)}</strong> — ${esc(x.why)}</li>`).join("");
}

async function refreshSettings() {
  settingsData = await api("/api/settings");
  renderSettings();
}

function settingsNote(text, tone = "") {
  const el = $("#settings-status");
  el.textContent = text;
  el.className = `status-line ${tone}`;
}

async function saveSetting(body, rowPaths) {
  try {
    const res = await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
    // The whole page is in the old language; the effect text promises a reload.
    if (body.path === "language") return location.reload();
    const f = settingsData.fields.find((x) => x.path === body.path);
    const label = `${f?.row ? `${f.row} · ` : ""}${f?.label || body.path}`;
    const note = body.reset ? t("Back to the default: {label}.", { label }) : t("Saved: {label}.", { label });
    settingsNote(res.backup && isExpert() ? `${note} ${t("Backup: {file}", { file: res.backup })}` : note, "ok");
    refreshRoles().catch(() => {});
  } catch (err) {
    settingsNote(t("Not saved: {error}", { error: err.message }), "err");
  }
  await refreshSettings();
  const row = [...$("#settings-body").querySelectorAll(".set-row")].find((r) => r.dataset.paths.split(" ").includes(rowPaths));
  row?.classList.add("saved");
}

$("#settings-body").addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.client === "projects-dir") {
    // Raw, like readProjectsDir reads it; the server takes it per request and never stores it.
    // Empty is the default folder. One the server cannot list is not saved.
    const dir = el.value.trim();
    try {
      await api(`/api/projects?dir=${encodeURIComponent(dir)}`);
    } catch (err) {
      settingsNote(t("Not saved: {error}", { error: err.message }), "err");
      return;
    }
    try {
      localStorage.setItem(PROJECTS_DIR_KEY, dir);
      pushPrefs();
    } catch {
      // Private mode: the folder just stops surviving reloads.
    }
    settingsNote(t("Saved: {label}.", { label: t("Projects folder") }), "ok");
    refreshProjects().catch(() => {});
    refreshTim().catch(() => {});
    return;
  }
  if (el.dataset.set) {
    const path = el.dataset.set;
    const value = [...$("#settings-body").querySelectorAll(`[data-set="${CSS.escape(path)}"]:checked`)].map((x) => JSON.parse(x.value));
    saveSetting({ path, value }, path);
    return;
  }
  const path = el.dataset.path;
  if (!path) return;
  const type = el.dataset.type;
  let body;
  if (type === "bool") body = { path, value: el.checked };
  else if (type === "enum") body = el.value === "__null__" ? { path, value: null } : { path, value: el.value };
  else if (el.value.trim() === "") body = { path, reset: true };
  else if (type === "ratio") body = { path, value: Number(el.value) / 100 };
  else body = { path, value: Number(el.value) };
  saveSetting(body, path);
});

$("#settings-body").addEventListener("click", async (e) => {
  const reset = e.target.closest("[data-reset]");
  if (reset) {
    saveSetting({ path: reset.dataset.reset, reset: true }, reset.dataset.reset);
    return;
  }
  const act = e.target.closest("[data-group-action]");
  if (!act) return;
  const [group, i] = act.dataset.groupAction.split(":");
  const action = GROUP_ACTIONS[group][Number(i)];
  act.disabled = true;
  try {
    settingsNote(action.done(await api(action.endpoint, { method: "POST", body: "{}" })), "ok");
  } catch (err) {
    settingsNote(t("Refused: {error}", { error: err.message }), "err");
  }
  act.disabled = false;
});

$("#settings-search").addEventListener("input", renderSettings);
$("#settings-advanced").checked = readStored(SETTINGS_ADVANCED_KEY, false) === true;
$("#settings-advanced").addEventListener("change", () => {
  writeStored(SETTINGS_ADVANCED_KEY, $("#settings-advanced").checked);
  renderSettings();
});
onEnter.settings = () => refreshSettings().catch((err) => settingsNote(t("That did not work: {error}", { error: err.message }), "err"));

// ── Automation ────────────────────────────────────────────────────────────
// Built-in jobs (explained, switchable where they live in the crontab) and
// jobs of your own. Loaded on entering the view and once a minute for the
// overview's attention list; never on the five-second cycle.
let automationData = null;

function automationNote(text, tone = "") {
  const el = $("#automation-status");
  el.textContent = text;
  el.className = `status-line ${tone}`;
}

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  // "today" / "heute" from Intl, in the UI language; one 24-hour clock everywhere.
  const near = [-1, 0, 1].find((n) => d.toDateString() === new Date(now.getTime() + n * 86_400_000).toDateString());
  const day = near !== undefined
    ? new Intl.RelativeTimeFormat(LANG, { numeric: "auto" }).format(near, "day")
    : d.toLocaleDateString(LANG, { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${d.toLocaleTimeString(LANG, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

function lastRunTag(run) {
  if (!run) return `<span class="tag off">${esc(t("Never ran"))}</span>`;
  if (run.running) return `<span class="tag warn">${esc(t("Running since {when}", { when: fmtWhen(run.at) }))}</span>`;
  return `<span class="tag ${run.exit === 0 ? "ok" : "err"}">${esc(run.exit === 0 ? t("Succeeded") : t("Exit code {code}", { code: run.exit }))}</span> ${esc(fmtWhen(run.at))}`;
}

/** The on/off switch of a job, named after it for a screen reader. */
const jobSwitch = (name, on, attr) => `<label class="switch" title="${esc(t("On: it starts on schedule"))}"><input type="checkbox" ${attr}${on ? " checked" : ""}
  aria-label="${esc(t("{job} on schedule", { job: name }))}"></label>`;

function customJobCard(j) {
  const sync = j.inSync === false ? `<span class="tag warn" title="${esc(t("The crontab does not match this job; save it again"))}">${esc(t("Not in the crontab"))}</span>` : "";
  return `<article class="job${j.enabled ? "" : " is-off"}" data-job="${esc(j.name)}">
    <div class="job-head">
      <h3 translate="no">${esc(j.name)}</h3>${sync}
      <span class="spacer"></span>
      ${jobSwitch(j.name, j.enabled, "data-job-toggle")}
      <button type="button" data-job-run title="${esc(t("Start it now; its output goes to the log"))}">${esc(t("Run now"))}</button>
      <button type="button" data-job-edit>${esc(t("Edit"))}</button>
      <button type="button" data-job-log>${esc(t("Log"))}</button>
      <button type="button" data-job-delete class="danger">${esc(t("Delete"))}</button>
    </div>
    ${j.description ? `<p translate="no">${esc(j.description)}</p>` : ""}
    <div class="job-when">
      <span><b>${esc(t("When"))}</b> ${esc(j.when?.text || j.schedule)}</span>
      <span><b>${esc(t("Next|run"))}</b> ${j.enabled ? esc(fmtWhen(j.when?.next)) : esc(t("off"))}</span>
      <span><b>${esc(t("Last run"))}</b> ${lastRunTag(j.lastRun)}</span>
      <span><b>${esc(t("Model"))}</b> <span translate="no">${esc(j.model || "—")}</span></span>
      <span><b>${esc(t("Folder"))}</b> <code>${esc((j.cwd || "").replace(/^\/home\/[^/]+/, "~"))}</code></span>
      ${j.notify ? `<span>${esc(t("Reports to Telegram"))}</span>` : ""}
    </div>
  </article>`;
}

/** How the job's last run through ops-run ended, in words; never colour alone. */
function outcomeTag(o) {
  if (o.status === "done") return `<span class="tag ok">${esc(t("Succeeded"))}</span>`;
  if (o.status === "failed") return `<span class="tag err">${esc(t("Failed|job"))}</span>`;
  if (o.status === "cancelled") return `<span class="tag off">${esc(t("Cancelled"))}</span>`;
  return `<span class="tag warn">${esc(t("Running"))}</span>`;
}

function builtinJobCard(j) {
  const state = !j.installed ? `<span class="tag off">${esc(t("not installed"))}</span>`
    : j.enabled ? `<span class="tag ok">${esc(t("on"))}</span>` : `<span class="tag off">${esc(t("off"))}</span>`;
  const toggle = j.editable ? jobSwitch(j.title, j.enabled, "data-builtin-toggle") : "";
  const modelRow = j.model ? `<label for="bm-${j.id}">${esc(j.model.label)}</label>
    <select id="bm-${j.id}" data-builtin-model="${esc(j.model.job)}">${
      (j.model.value && !automationData.options.models.includes(j.model.value) ? [j.model.value] : []).concat(automationData.options.models)
        .map((m) => `<option value="${esc(m)}"${m === j.model.value ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>` : "";
  const knobs = (j.knobs || []).map((k) => k.type === "flag"
    ? `<span></span><label class="inline"><input type="checkbox" data-knob="${esc(k.key)}"${k.value ? " checked" : ""}${j.editable ? "" : " disabled"}> ${esc(k.label)}</label>`
    : `<label for="kn-${j.id}-${k.key}">${esc(k.label)}</label><span><input type="number" id="kn-${j.id}-${k.key}" data-knob="${esc(k.key)}" min="${k.min}" max="${k.max}" step="1"
        value="${k.value ?? ""}" placeholder="${k.default}"${j.editable ? "" : " disabled"}> ${esc(k.unit || "")} <span class="muted">${esc(t("(default {value})", { value: k.default }))}</span></span>`).join("");
  const schedule = j.editable
    ? `<label for="bs-${j.id}">${esc(t("Schedule (cron)"))}</label><span class="form-row"><input type="text" id="bs-${j.id}" class="mono" data-builtin-schedule value="${esc(j.schedule || "")}">
        <button type="button" data-builtin-schedule-save>${esc(t("Save"))}</button></span>`
    : "";
  // The result is of the last run through ops-run; lighter activity since then is not a run.
  const outcomeOld = j.lastOutcome && Date.parse(j.lastRun) - Date.parse(j.lastOutcome.at) > 864e5;
  return `<article class="job${j.installed && j.enabled ? "" : " is-off"}" data-builtin="${esc(j.id)}">
    <div class="job-head">
      <h3>${esc(j.title)}</h3>${state}<span class="tag">${esc(j.llm ? t("uses AI") : t("no AI"))}</span>
      <span class="spacer"></span>${toggle}
    </div>
    <div class="job-when">
      <span><b>${esc(t("When"))}</b> ${esc(j.when?.text || "—")}</span>
      <span><b>${esc(t("Next|run"))}</b> ${j.installed && j.enabled ? esc(fmtWhen(j.when?.next)) : "—"}</span>
      <span><b>${esc(t("Last activity"))}</b> ${esc(fmtWhen(j.lastRun))}</span>
      ${j.lastOutcome ? `<span><b>${esc(outcomeOld ? t("Last full run") : t("Last result"))}</b> ${outcomeTag(j.lastOutcome)} ${esc(fmtWhen(j.lastOutcome.at))}</span>` : ""}
    </div>
    ${j.lastOutcome?.status === "failed" && j.lastOutcome.reason
      ? `<p class="job-fail">${withNames(t("Why: {reason}"), { reason: j.lastOutcome.reason })}</p>` : ""}
    <p>${esc(j.what)}</p>
    <p class="cost">${esc(t("Cost: {cost}", { cost: j.cost }))}</p>
    <details><summary>${esc(t("Details & settings"))}</summary>
      <div class="knobs">
        ${modelRow}${knobs}${schedule}
        <span class="muted">${esc(t("Scheduled in"))}</span><span>${esc(j.where)}</span>
        ${j.output ? `<span class="muted">${esc(t("Output"))}</span><code>${esc(j.output)}</code>` : ""}
        ${j.off ? `<span class="muted">${esc(t("To stop it"))}</span><span>${esc(j.off)}</span>` : ""}
        ${j.settings ? `<span></span><a href="#/settings" data-settings-group="${esc(j.settings)}">${esc(t("Open its settings"))} <span aria-hidden="true">→</span></a>` : ""}
      </div>
    </details>
  </article>`;
}

let automationKey = "";
/** True while renderAutomation swaps the job cards: a change event then is not the user's. */
let automationDrawing = false;

/**
 * The job cards are drawn again only when their content changed, and never
 * over a field the user is typing in: removing a focused, edited knob fires
 * its change, which would save "4" on the way to "48" into the crontab.
 * force (after the user's own save) draws over a focused field that holds no
 * unsaved text; the timer waits until focus leaves the fields.
 */
function renderAutomation(force = false) {
  const d = automationData;
  if (!d) return;
  if (!d.crontab.readable) automationNote(t("Cannot read your crontab: {error}", { error: d.crontab.error }), "err");
  const lists = [$("#custom-jobs"), $("#builtin-jobs")];
  const a = lists.some((el) => el.contains(document.activeElement)) ? document.activeElement : null;
  const field = a?.matches("input:not([type=checkbox]), select");
  const unsaved = field && a.tagName === "INPUT" && a.value !== a.defaultValue;
  const custom = d.custom.length
    ? `<div class="job-list">${d.custom.map(customJobCard).join("")}</div>`
    : `<div class="empty">${esc(t("No jobs of your own yet. A job is a prompt that a helper runs in one of your projects on a schedule — say a weekly dependency check, or a nightly “read the logs and file what looks wrong”."))}</div>`;
  const builtin = d.builtin.map(builtinJobCard).join("");
  // Forced even when unchanged: a refused toggle must flip back.
  if (!unsaved && (force || (!field && custom + builtin !== automationKey))) {
    automationKey = custom + builtin;
    const open = [...$("#builtin-jobs").querySelectorAll("details[open]")].map((el) => el.closest("[data-builtin]").dataset.builtin);
    const card = a?.closest("[data-builtin], [data-job]");
    const control = card && (a.id ? `#${CSS.escape(a.id)}` : [...a.attributes].map((x) => x.name).find((n) => n.startsWith("data-")));
    automationDrawing = true;
    try {
      lists[0].innerHTML = custom;
      lists[1].innerHTML = builtin;
    } finally {
      automationDrawing = false;
    }
    for (const id of open) {
      const el = $(`#builtin-jobs [data-builtin="${CSS.escape(id)}"] details`);
      if (el) el.open = true;
    }
    if (control) {
      const sel = control.startsWith("#") ? control
        : `[${card.dataset.builtin ? "data-builtin" : "data-job"}="${CSS.escape(card.dataset.builtin || card.dataset.job)}"] [${control}]`;
      document.querySelector(sel)?.focus({ preventScroll: true });
    }
  }
  $("#services").innerHTML = `<table><thead><tr>${th("Service", t("Service"))}${th("What it does", t("What it does"))}${th("State", t("State"))}</tr></thead><tbody>${
    d.services.map((s) => `<tr><td>${esc(s.title)}<div class="muted mono">${esc(s.unit)}</div></td><td>${esc(s.what)}</td>
      <td><span class="tag ${s.active === "active" ? "ok" : s.active === "failed" ? "err" : "off"}" translate="no">${esc(s.active)}${s.sub ? ` · ${esc(s.sub)}` : ""}</span></td></tr>`).join("")
  }</tbody></table>${d.crontab.otherLines ? `<p class="muted">${esc(tp(d.crontab.otherLines, {
    one: "Your crontab also runs {n} job that team-up does not manage. It is left alone.",
    other: "Your crontab also runs {n} jobs that team-up does not manage. They are left alone." }))}</p>` : ""}`;
  const failing = d.custom.filter((j) => j.lastRun && !j.lastRun.running && j.lastRun.exit !== 0).length;
  updateNavBadge("badge-automation", failing ? String(failing) : "", "red", failing > 0,
    failing ? tp(failing, { one: "{n} job failed on its last run", other: "{n} jobs failed on their last run" }) : "");
}

async function refreshAutomation(force = false) {
  automationData = await api("/api/automation");
  dashboardMetrics.automation = automationData;
  renderAutomation(force);
  updateAttention();
}
onEnter.automation = () => refreshAutomation().catch((err) => automationNote(t("That did not work: {error}", { error: err.message }), "err"));

async function automationWrite(url, body, done) {
  try {
    const res = await api(url, { method: "POST", body: JSON.stringify(body) });
    automationNote(`${done}${res.backup ? ` · ${t("Crontab backup: {file}", { file: res.backup })}` : ""}`, "ok");
    return true;
  } catch (err) {
    automationNote(t("Refused: {error}", { error: err.message }), "err");
    return false;
  } finally {
    await refreshAutomation(true).catch(() => {});
  }
}

$("#builtin-jobs").addEventListener("change", async (e) => {
  // Fired by our own redraw removing an edited field, or after it: never a save.
  if (automationDrawing || !e.target.isConnected) return;
  const card = e.target.closest("[data-builtin]");
  if (!card) return;
  const id = card.dataset.builtin;
  const title = automationData.builtin.find((j) => j.id === id)?.title || id;
  if (e.target.matches("[data-builtin-toggle]")) {
    await automationWrite(`/api/automation/builtin/${id}`, { enabled: e.target.checked },
      e.target.checked ? t("{job} switched on", { job: title }) : t("{job} switched off", { job: title }));
  } else if (e.target.matches("[data-builtin-model]")) {
    try {
      await api(`/api/cron-jobs/${encodeURIComponent(e.target.dataset.builtinModel)}`, { method: "POST", body: JSON.stringify({ model: e.target.value }) });
      automationNote(t("{job} now runs on {model}", { job: title, model: e.target.value }), "ok");
    } catch (err) {
      automationNote(t("Refused: {error}", { error: err.message }), "err");
    }
    await refreshAutomation(true).catch(() => {});
  } else if (e.target.matches("[data-knob]")) {
    // Committed (Enter or leaving the field): no longer unsaved text for renderAutomation.
    e.target.defaultValue = e.target.value;
    const key = e.target.dataset.knob;
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value.trim() === "" ? null : Number(e.target.value);
    const knob = automationData.builtin.find((j) => j.id === id)?.knobs?.find((k) => k.key === key)?.label || key;
    await automationWrite(`/api/automation/builtin/${id}`, { knob: { key, value } }, t("{job}: {setting} saved", { job: title, setting: knob }));
  }
});

$("#builtin-jobs").addEventListener("click", async (e) => {
  const link = e.target.closest("[data-settings-group]");
  if (link) {
    setTimeout(() => $(`#group-${link.dataset.settingsGroup}`)?.scrollIntoView({ behavior: "smooth" }), 400);
    return;
  }
  if (!e.target.matches("[data-builtin-schedule-save]")) return;
  const card = e.target.closest("[data-builtin]");
  const schedule = card.querySelector("[data-builtin-schedule]").value;
  await automationWrite(`/api/automation/builtin/${card.dataset.builtin}`, { schedule }, t("Schedule saved."));
});

$("#custom-jobs").addEventListener("change", async (e) => {
  if (automationDrawing || !e.target.isConnected || !e.target.matches("[data-job-toggle]")) return;
  const name = e.target.closest("[data-job]").dataset.job;
  await automationWrite(`/api/automation/jobs/${name}/enabled`, { enabled: e.target.checked },
    e.target.checked ? t("{job} switched on", { job: name }) : t("{job} switched off", { job: name }));
});

$("#custom-jobs").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-job]");
  if (!card) return;
  const name = card.dataset.job;
  const job = automationData.custom.find((j) => j.name === name);
  if (e.target.matches("[data-job-edit]")) openJobEditor(job);
  else if (e.target.matches("[data-job-log]")) openJobLog(name);
  else if (e.target.matches("[data-job-run]")) {
    if (await automationWrite(`/api/automation/jobs/${name}/run`, {}, t("{job} started: its output goes to the log", { job: name }))) {
      setTimeout(() => refreshAutomation().catch(() => {}), 3000);
    }
  } else if (e.target.matches("[data-job-delete]") && await confirmDialog({
    title: withNames(t("Delete the job {name}?"), { name }),
    text: esc(t("Its prompt goes too. This cannot be undone.")),
    yes: t("Delete job"),
  })) {
    await automationWrite(`/api/automation/jobs/${name}/delete`, {}, t("{job} deleted", { job: name }));
  }
});

const jobDialog = $("#job-editor");
let jobOriginal = null;
let previewTimer = null;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const out = $("#job-schedule-preview");
    const schedule = $("#job-schedule").value.trim();
    if (!schedule) {
      out.textContent = "";
      return;
    }
    try {
      const p = await api(`/api/automation/preview?schedule=${encodeURIComponent(schedule)}`);
      out.textContent = p.error ? `✗ ${p.error}` : `${p.text} · ${t("next run {when}", { when: fmtWhen(p.next) })}`;
    } catch (err) {
      out.textContent = t("That did not work: {error}", { error: err.message });
    }
  }, 250);
}

function openJobEditor(job = null) {
  jobOriginal = job?.name || null;
  $("#job-editor-title").textContent = job ? t("Edit {job}", { job: job.name }) : t("New job");
  $("#job-editor-status").textContent = "";
  $("#job-name").value = job?.name || "";
  $("#job-description").value = job?.description || "";
  const schedule = job?.schedule || "0 6 * * *";
  $("#job-schedule").value = schedule;
  const preset = [...$("#job-schedule-preset").options].find((o) => o.value === schedule);
  $("#job-schedule-preset").value = preset ? schedule : "";
  $("#job-cwd").value = (job?.cwd || "").replace(/^\/home\/[^/]+/, "~");
  $("#job-cwd-options").innerHTML = [...projectsByPath.keys()].map((p) => `<option value="${esc(p)}">`).join("");
  const models = automationData?.options.models || [];
  $("#job-model").innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  $("#job-model").value = job?.model && models.includes(job.model) ? job.model : (models.includes("claude:claude-sonnet") ? "claude:claude-sonnet" : models.find((m) => m.startsWith("claude:"))) || models[0] || "";
  $("#job-prompt").value = job?.prompt?.trim() || "";
  $("#job-notify").checked = job ? job.notify : true;
  $("#job-enabled").checked = job ? job.enabled : true;
  schedulePreview();
  jobDialog.showModal();
}

$("#job-new").addEventListener("click", async () => {
  if (!automationData) await refreshAutomation().catch(() => {});
  openJobEditor(null);
});
$("#job-editor-cancel").addEventListener("click", () => jobDialog.close());
$("#job-schedule-preset").addEventListener("change", () => {
  const v = $("#job-schedule-preset").value;
  if (v) $("#job-schedule").value = v;
  $("#job-schedule").focus();
  schedulePreview();
});
$("#job-schedule").addEventListener("input", () => {
  const v = $("#job-schedule").value.trim();
  $("#job-schedule-preset").value = [...$("#job-schedule-preset").options].some((o) => o.value === v) ? v : "";
  schedulePreview();
});
$("#job-editor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    original: jobOriginal,
    name: $("#job-name").value.trim(),
    description: $("#job-description").value,
    schedule: $("#job-schedule").value.trim(),
    cwd: $("#job-cwd").value.trim(),
    model: $("#job-model").value,
    prompt: $("#job-prompt").value,
    notify: $("#job-notify").checked,
    enabled: $("#job-enabled").checked,
  };
  try {
    const res = await api("/api/automation/jobs", { method: "POST", body: JSON.stringify(body) });
    jobDialog.close();
    automationNote(`${t("{job} saved", { job: body.name })}${res.backup ? ` · ${t("Crontab backup: {file}", { file: res.backup })}` : ""}`, "ok");
  } catch (err) {
    $("#job-editor-status").textContent = t("Not saved: {error}", { error: err.message });
  }
  await refreshAutomation().catch(() => {});
});

async function openJobLog(name) {
  $("#job-log-title").textContent = `${t("Log")} · ${name}`;
  $("#job-log-body").textContent = t("Loading…");
  $("#job-log").showModal();
  try {
    const { log } = await api(`/api/automation/jobs/${name}/log`);
    $("#job-log-body").textContent = log || t("No runs yet.");
    $("#job-log-body").scrollTop = $("#job-log-body").scrollHeight;
  } catch (err) {
    $("#job-log-body").textContent = t("That did not work: {error}", { error: err.message });
  }
}

// ── Needs attention ───────────────────────────────────────────────────────
// The overview's to-do list, assembled from what the other views already
// fetched. Empty means nothing is waiting on you, and the panel hides.
function updateAttention() {
  // Questions and problems are the "Waiting on you" tile above; not twice.
  // html: a translated sentence with the names (a usage window, a CLI, a job) left as they are.
  const items = [];
  for (const [key, w] of Object.entries(dashboardMetrics.usage?.windows || {})) {
    if (w.level === "red" || w.level === "amber") {
      const names = { window: key, pct: w.usedPct, when: w.resets_at ? fmtWhen(w.resets_at) : "" };
      items.push({ tone: w.level === "red" ? "red" : "", href: "#/overview",
        html: withNames(w.resets_at ? t("{window} is at {pct}%; it resets {when}.") : t("{window} is at {pct}%."), names) });
    }
  }
  for (const [cli, c] of Object.entries(dashboardMetrics.usage?.collectors || {})) {
    if (c?.stale) items.push({ tone: "", href: "#/overview", html: withNames(t("The usage readings for {cli} are out of date, so its limits are not checked."), { cli }) });
  }
  const auto = dashboardMetrics.automation;
  if (auto && !auto.crontab.readable) items.push({ tone: "red", href: "#/automation", html: esc(t("The crontab cannot be read, so it is unknown which jobs are scheduled.")) });
  for (const j of auto?.custom || []) {
    if (j.lastRun && !j.lastRun.running && j.lastRun.exit !== 0) {
      items.push({ tone: "red", href: "#/automation", html: withNames(t("The job {job} failed on its last run (exit code {code})."), { job: j.name, code: j.lastRun.exit }) });
    }
    if (j.inSync === false) items.push({ tone: "", href: "#/automation", html: withNames(t("The job {job} is not in the crontab: open it and save it again."), { job: j.name }) });
  }
  $("#attention-list").innerHTML = items.map((i) =>
    `<li class="${i.tone}"><span>${i.html}</span><a href="${i.href}">${esc(t("Open|verb"))} <span aria-hidden="true">→</span></a></li>`).join("");
  $("#panel-attention").classList.toggle("hidden", items.length === 0);
}

// ── Inbox ─────────────────────────────────────────────────────────────────
// Everything that waits on the human, like an e-mail inbox: short rows (kind,
// project, age, subject) and the open item beside them, or instead of them
// below 1000px. The open item lives in the hash (#/actions/<runId>), so back
// and reload keep the place. The five-second poll redraws the list; the item
// redraws only when its content changed, and never takes away an answer that
// is being typed.
const AC_FILTER_KEY = "teamup.acFilter";
const AC_PROJECT_KEY = "teamup.acProject";
const AC_DRAFT_PREFIX = "teamup.draft.";
const AC_FILTERS = [["all", t("All")], ["question", t("Questions")], ["problem", t("Problems")], ["result", t("Results")]];
const AC_KIND = { question: t("Question"), problem: t("Problem"), result: t("Result") };
// A recommendation the agent made; "I do not recommend" or "nicht empfehlenswert" is none.
// [ \t], not \s: with the m flag, \s* spans newlines and a run of blank lines turns quadratic.
const AC_RECOMMENDS = /\*\*(?:my |meine )?(?:recommendation|recommended|empfehlung|empfohlen)\b|^[ \t]*(?:my |meine )?(?:recommendation|empfehlung)[ \t]*:|\b(?:I|I'd|I would) recommend\b|\bich empfehle\b|\bmeine empfehlung\b/im;
// Server errors a person can hit from the inbox, in their words.
const AC_ERRORS = [
  [/^already answered/, t("Already answered.")],
  [/^run is already /, t("This task has already ended.")],
  [/^run is no longer waiting/, t("This task is no longer waiting for you.")],
  [/^run is still /, t("This task is still running.")],
];
const acErrorText = (message) => AC_ERRORS.find(([re]) => re.test(message))?.[1] ?? message;
// List or item, not both, below 1000px: with the sidebar, two panes leave the item too narrow
// for a table. The same width as the @media rule for .inbox in app.css.
const isNarrow = () => matchMedia("(max-width: 999px)").matches;
const hour = (h) => String(h).padStart(2, "0");

let acData = null;
let acSeq = 0;
let acListKey = "";
let acProjectsKey = "";
/** The open item: { runId, key, data }; key is its content without the age. */
let acDetail = null;
let acDetailSeq = 0;
// Focus moves to the item's heading when it opens as a page of its own (below
// 1000px), replaces one that was just dealt with, or was opened by keyboard; a
// click on a row on a wide screen keeps focus on the row.
let acFocusDetail = false;
/** The item opened from the bare list: "Back to inbox" steps back instead of piling up history. */
let acFromList = null;
/** Runs with an action on its way: Ctrl+Enter twice must not send twice. */
const acBusy = new Set();
let acLastOpen = null;

const acSelectedId = () => location.hash.match(/^#\/actions\/([\w.-]+)$/)?.[1] ?? null;
const acViewActive = () => location.hash.startsWith("#/actions");

/**
 * A project's "Waiting for you" link shows that project, every kind, for this
 * visit only: the stored filters are what you chose yourself, and leaving the
 * inbox drops it. Choosing a filter here ends it.
 */
let acVisit = null;
window.addEventListener("hashchange", () => {
  if (!acViewActive()) acVisit = null;
});

function acFilter() {
  const f = acVisit ? "all" : readStored(AC_FILTER_KEY, "all");
  return AC_FILTERS.some(([k]) => k === f) ? f : "all";
}

const acProjectNames = () => [...new Set(acData.items.map((i) => i.project?.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));

function acProject(names = acProjectNames()) {
  const p = acVisit?.project ?? readStored(AC_PROJECT_KEY, "");
  return names.includes(p) ? p : "";
}

function acVisible() {
  const filter = acFilter();
  const project = acProject();
  return acData.items.filter((i) => (filter === "all" || i.kind === filter) && (!project || i.project?.name === project));
}

/** An agent's subject, or the server's own sentence for a problem, already in the UI language: never translated again. */
const acSubjectHtml = (subject) => `<span translate="no">${esc(subject ?? "")}</span>`;

function acWhenHtml(item) {
  const ago = fmtAgo(item.ageMs ?? 0);
  if (item.kind === "result") return esc(t("Finished {ago}", { ago }));
  if (item.status === "failed") return esc(t("Failed {ago}", { ago }));
  if (item.kind === "problem") return esc(t("Stopped {ago}", { ago }));
  if (!isExpert()) return esc(t("A helper asked {ago}", { ago }));
  return esc(t("{who} asked {ago}", { ago })).replace("{who}", () => `<span translate="no">${esc(`${item.role} (${item.worker})`)}</span>`);
}

function acCountsText(c) {
  return new Intl.ListFormat(LANG, { type: "conjunction" }).format([
    tp(c.question, { one: "{n} question", other: "{n} questions" }),
    tp(c.problem, { one: "{n} problem", other: "{n} problems" }),
    tp(c.result, { one: "{n} result", other: "{n} results" }),
  ]);
}

async function refreshActions() {
  const seq = ++acSeq;
  let data;
  try {
    data = await api(`/api/action-center?dir=${encodeURIComponent(readProjectsDir())}`);
  } catch (err) {
    if (seq === acSeq) $("#ac-status").textContent = t("Could not load the inbox: {error}", { error: err.message });
    return;
  }
  // An action finished while this was on its way: its item would come back.
  if (seq !== acSeq) return;
  acData = data;
  $("#ac-status").textContent = "";
  acDropDrafts();
  acCountsChanged();
  renderInbox();
  renderProjects();
  const selected = acSelectedId();
  if (selected && acDetail?.runId === selected && acDetail.key) loadDetail(selected);
}

/** Drafts of items that left the inbox (answered here or elsewhere); the open one keeps its text. */
function acDropDrafts() {
  const keep = new Set(acData.items.map((i) => i.runId));
  keep.add(acSelectedId());
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key.startsWith(AC_DRAFT_PREFIX) && !keep.has(key.slice(AC_DRAFT_PREFIX.length))) localStorage.removeItem(key);
    }
  } catch {
    // storage blocked: no drafts to drop
  }
}

function acCountsChanged() {
  const c = acData.counts;
  const urgent = c.question + c.problem;
  updateNavBadge("badge-actions", urgent ? String(urgent) : c.result ? String(c.result) : "", urgent ? "red" : "",
    urgent + c.result > 0, acCountsText(c));
  $("#kpi-waiting-runs").textContent = String(urgent);
  $("#kpi-uncollected-runs").textContent = String(c.result);
  updateAttention();
}

function renderInbox() {
  if (!acData) return;
  let selected = acSelectedId();
  // A wide screen has room for the item: open the first one rather than an empty pane.
  if (!selected && acViewActive() && !isNarrow() && acVisible()[0]) {
    selected = acVisible()[0].runId;
    history.replaceState(null, "", `#/actions/${selected}`);
  }
  $("#inbox").classList.toggle("has-selection", Boolean(selected));
  renderInboxList();
  if (!selected) {
    acDetail = null;
    acFocusDetail = false;
    $("#ac-detail").innerHTML = acVisible().length ? `<p class="inbox-hint">${esc(t("Choose an item to read it."))}</p>` : "";
    // Back from an item on a narrow screen: to the row it came from.
    const row = acLastOpen && $(`#ac-list [data-run="${CSS.escape(acLastOpen)}"]`);
    if (row && isNarrow()) row.focus();
    acLastOpen = null;
    return;
  }
  acLastOpen = selected;
  if (acDetail?.runId !== selected) {
    acDetail = { runId: selected, key: null, data: null };
    $("#ac-detail").innerHTML = `<p class="inbox-hint">${esc(t("Loading…"))}</p>`;
    loadDetail(selected);
  }
}

function renderInboxList() {
  const filter = acFilter();
  const names = acProjectNames();
  const project = acProject(names);
  // The chips count what the project filter leaves.
  const n = { all: 0, question: 0, problem: 0, result: 0 };
  for (const i of acData.items) {
    if (project && i.project?.name !== project) continue;
    n.all += 1;
    n[i.kind] += 1;
  }
  const select = $("#ac-project");
  if (JSON.stringify(names) !== acProjectsKey) {
    acProjectsKey = JSON.stringify(names);
    select.innerHTML = `<option value="">${esc(t("All projects"))}</option>`
      + names.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  }
  select.value = project;
  select.classList.toggle("hidden", names.length < 2);

  const filterHtml = AC_FILTERS.map(([k, label]) =>
    `<button type="button" data-ac-filter="${k}" aria-pressed="${k === filter}">${esc(label)} <span class="count">${n[k]}</span></button>`).join("");
  const selected = acSelectedId();
  const rows = acVisible().map((i) => `<li><a class="ac-row" href="#/actions/${esc(i.runId)}" data-run="${esc(i.runId)}"${i.runId === selected ? ' aria-current="true"' : ""}>
      <span class="ac-row-meta"><span class="ac-kind ${esc(i.kind)}"><span class="dot" aria-hidden="true"></span>${esc(AC_KIND[i.kind])}</span>${i.project ? `<span class="ac-row-project" translate="no">${esc(i.project.name)}</span>` : ""}<span class="ac-row-age">${esc(fmtAgo(i.ageMs ?? 0))}</span></span>
      <span class="ac-row-subject">${acSubjectHtml(i.subject)}</span></a></li>`).join("");
  // A project filter hides items the nav badge counts: say so, with the way back.
  const scope = project ? `<p class="ac-scope">${withNames(t("Showing only {project}."), { project })}
    <button type="button" class="link" data-ac-allprojects>${esc(t("Show all projects"))}</button></p>` : "";
  let html;
  if (rows) html = `${scope}<ul class="ac-rows">${rows}</ul>`;
  else if (!acData.items.length) html = `<div class="ac-empty">${esc(t("Nothing is waiting for you."))}</div>`;
  else html = `${scope}<div class="ac-empty"><p>${esc(t("Nothing here with this filter."))}</p><button type="button" data-ac-showall>${esc(t("Show all"))}</button></div>`;

  const key = filterHtml + html;
  if (key === acListKey) return;
  acListKey = key;
  // The ages change every few seconds; a keyboard user's place in the list must not.
  const active = document.activeElement;
  const focus = active?.closest?.("#ac-filter, #ac-list") && (active.dataset.run ? `[data-run="${CSS.escape(active.dataset.run)}"]`
    : active.dataset.acFilter ? `[data-ac-filter="${active.dataset.acFilter}"]` : active.matches("[data-ac-showall]") ? "[data-ac-showall]" : null);
  $("#ac-filter").innerHTML = filterHtml;
  $("#ac-list").innerHTML = html;
  if (focus) $(`#ac-filter ${focus}, #ac-list ${focus}`)?.focus({ preventScroll: true });
}

async function loadDetail(runId) {
  const seq = ++acDetailSeq;
  let data;
  try {
    data = await api(`/api/action-center/item/${encodeURIComponent(runId)}?dir=${encodeURIComponent(readProjectsDir())}`);
  } catch (err) {
    if (seq !== acDetailSeq || acDetail?.runId !== runId || acDetail.key) return;
    $("#ac-detail").innerHTML = `${acBackHtml()}<p class="status-line err">${esc(t("Could not open this item: {error}", { error: err.message }))}</p>`;
    return;
  }
  if (seq !== acDetailSeq || acDetail?.runId !== runId) return;
  const { ageMs, ...content } = data;
  const key = JSON.stringify(content);
  const ago = $("#ac-detail .ac-ago");
  if (key === acDetail.key) {
    acDetail.data = data;
    if (ago) ago.innerHTML = acWhenHtml(data);
    return;
  }
  // Never rebuild the answer box while it is in use; the next poll tries again.
  const box = $("#ac-answer-text");
  if (acDetail.key && box && (box.value.trim() || document.activeElement === box)) return;
  renderDetail(data, key);
}

const acBackHtml = () => `<a class="ac-back" href="#/actions"><span aria-hidden="true">←</span> ${esc(t("Back to inbox"))}</a>`;

/**
 * A question's subject and body. A first heading that repeats the subject
 * leaves the body; it also stands in for a subject the server cut at 90
 * characters, so the whole of it stays readable.
 */
function acQuestion(body, subject) {
  const text = String(body ?? "");
  const s = String(subject ?? "");
  const [first, ...rest] = text.split("\n");
  // As the server reads it: no ** or `, one space, without a "Question:" prefix.
  const heading = first.match(/^#{1,6}\s+(.+)/)?.[1].replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim()
    .replace(/^(?:frage|question|decision needed)\s*:\s*/i, "");
  const same = heading && (heading === s || (s.endsWith("…") && heading.startsWith(s.slice(0, -1))));
  return same ? { subject: heading, body: rest.join("\n") } : { subject: s, body: text };
}

const acMd = (text) => `<div class="md" translate="no">${renderMarkdown(text)}</div>`;

function acProblemHtml(item) {
  const failed = item.status === "failed";
  // The item's reason line is cut to 300 characters; RESULT's is the whole first line.
  const reason = item.result?.reason || item.reason || "";
  const cut = !item.result?.reason && reason.endsWith("…");
  let explain;
  if (item.denied) {
    explain = t("The helper stopped at a prompt about a password, a login or a payment. team-up never answers those for you.");
  } else if (failed && reason.startsWith("observer:")) {
    explain = t("The watcher stopped this task because the helper was stuck on a technical prompt.");
  } else if (failed) {
    explain = t("This task ended with an error and did not finish.");
  } else {
    explain = t("The helper got stuck on a technical prompt and could not continue.");
  }
  let next;
  if (failed) next = t("Nothing to answer here. Mark it as read once you have seen it.");
  else if (item.retryable) next = t("Retry lets it continue tonight from {start}:00. Or cancel the task.", { start: hour(item.resumeWindow?.start ?? 23) });
  else next = t("This one cannot be retried from here: someone has to answer the prompt in the helper's terminal. Or cancel the task.");
  const raw = failed ? [reason, item.result?.markdown].filter(Boolean).join("\n\n") : item.body;
  return `<p class="ac-explain">${esc(explain)}</p><p>${esc(next)}</p>${raw
    ? `<details class="ac-more-info"><summary>${esc(t("Technical details"))}</summary><pre class="ac-raw" translate="no">${esc(raw)}</pre>${cut
      ? `<p class="muted">${esc(t("Only the beginning is shown here."))}</p>` : ""}</details>` : ""}`;
}

function acResultHtml(item) {
  const r = item.result;
  if (!r) return `<p class="muted">${esc(t("The helper left no report."))}</p>`;
  if (!r.summary) return acMd(r.markdown);
  return acMd(r.summary) + (r.markdown
    ? `<details class="ac-more-info"><summary>${esc(t("Full report"))}</summary>${acMd(r.markdown)}</details>` : "");
}

function acActionsHtml(item) {
  const button = (action, label, cls = "") => `<button type="button" data-ac-act="${action}"${cls ? ` class="${cls}"` : ""}>${esc(label)}</button>`;
  if (item.kind === "question") {
    return `<form class="ac-answer" data-run="${esc(item.runId)}">
      <label for="ac-answer-text">${esc(t("Your answer"))}</label>
      ${AC_RECOMMENDS.test(item.body || "") ? `<button type="button" class="chip-btn" data-ac-recommend>${esc(t("Go with the recommendation"))}</button>` : ""}
      <textarea id="ac-answer-text" rows="5" required></textarea>
      <div class="ac-answer-foot"><button type="submit" class="primary">${esc(t("Send answer"))}</button><span class="muted ac-keys">${esc(t("Ctrl+Enter or ⌘+Enter sends"))}</span></div>
      <p class="ac-error" role="alert"></p>
    </form>`;
  }
  let buttons = "";
  if (item.kind === "problem" && item.status !== "failed") {
    if (item.retryable) buttons += button("retry", t("Retry"), "primary");
    buttons += button("cancel", t("Cancel task"), "danger");
  } else if (item.kind === "problem" || item.kind === "result") {
    buttons += button("collect", t("Mark as read"), "primary");
  }
  if (item.kind === "result" && isExpert()) {
    buttons += `<details class="ac-menu"><summary>${esc(t("More"))}</summary><div>${button("merged", t("Kept"))}${button("discarded", t("Discarded"))}</div></details>`;
  }
  return buttons ? `<div class="ac-actions">${buttons}</div><p class="ac-error" role="alert"></p>` : "";
}

function acAnsweredHtml(item) {
  return `<div class="ac-note"><p><strong>${esc(t("Already answered."))}</strong></p>${item.answer ? acMd(item.answer) : ""}</div>`;
}

function renderDetail(item, key) {
  const fresh = acDetail?.data?.runId !== item.runId;
  acDetail = { runId: item.runId, key, data: item };
  const meta = [
    item.kind ? `<span class="ac-kind ${esc(item.kind)}"><span class="dot" aria-hidden="true"></span>${esc(AC_KIND[item.kind])}</span>` : "",
    item.project ? `<span translate="no">${esc(item.project.name)}</span>` : "",
    item.kind ? `<span class="ac-ago">${acWhenHtml(item)}</span>` : "",
  ].filter(Boolean).join('<span aria-hidden="true">·</span>');
  const question = item.kind === "problem" || item.kind === "result" ? { subject: item.subject, body: "" }
    : acQuestion(item.body, item.subject);
  let body = "";
  if (!item.kind && !item.answer) body += `<p class="ac-note">${esc(t("This is no longer waiting for you."))}</p>`;
  if (item.kind === "problem") body += acProblemHtml(item);
  else if (item.kind === "result") body += acResultHtml(item);
  else if (question.body) body += acMd(question.body);
  if (item.task) {
    body += `<details class="ac-more-info"><summary>${esc(t("What the helper was doing"))}</summary>${acMd(item.task)}</details>`;
  }
  const history = (item.history || []).filter((h) => h.question || h.answer);
  if (history.length) {
    body += `<details class="ac-more-info"><summary>${esc(t("Earlier questions and answers"))}</summary>${history.map((h) =>
      `<div class="ac-history">${h.question ? acMd(h.question) : ""}${h.answer
        ? `<p class="ac-history-label">${esc(t("Your answer"))}</p>${acMd(h.answer)}` : ""}</div>`).join("")}</details>`;
  }
  body += item.answer ? acAnsweredHtml(item) : acActionsHtml(item);
  if (isExpert()) body += `<p class="ac-expert"><a href="#/runs" data-ac-open-run>${esc(t("Open run"))}</a></p>`;
  const box = $("#ac-detail");
  box.innerHTML = `${acBackHtml()}${meta ? `<p class="ac-detail-meta">${meta}</p>` : ""}
    <h2 class="ac-subject" tabindex="-1">${acSubjectHtml(question.subject)}</h2>${body}`;
  const answer = $("#ac-answer-text");
  if (answer) answer.value = acDraft(item.runId);
  if (fresh) {
    box.scrollTop = 0;
    if (acFocusDetail) box.querySelector(".ac-subject").focus({ preventScroll: !isNarrow() });
  }
  acFocusDetail = false;
}

function acDraft(runId, text) {
  try {
    if (text === undefined) return localStorage.getItem(AC_DRAFT_PREFIX + runId) || "";
    if (text.trim()) localStorage.setItem(AC_DRAFT_PREFIX + runId, text);
    else localStorage.removeItem(AC_DRAFT_PREFIX + runId);
  } catch {
    // storage blocked: the draft lives as long as the page
  }
  return "";
}

function acDoneText(action, item) {
  const start = item?.parked && item.resumeWindow ? hour(item.resumeWindow.start) : null;
  if (action === "answer") return start ? t("Answer sent — continues tonight from {start}:00.", { start }) : t("Answer sent — the helper continues now.");
  if (action === "retry") return start ? t("Retry sent — continues tonight from {start}:00.", { start }) : t("Retry sent.");
  if (action === "cancel") return t("Task cancelled.");
  if (action === "merged") return t("Marked as kept.");
  if (action === "discarded") return t("Marked as discarded.");
  return t("Marked as read.");
}

let toastTimer = null;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ""; }, 7000);
}

async function acAct(runId, action, reason, btn) {
  if (acBusy.has(runId) || btn.disabled) return;
  acBusy.add(runId);
  const item = acDetail?.runId === runId ? acDetail.data : acData?.items.find((i) => i.runId === runId);
  const label = btn.textContent;
  const error = $("#ac-detail .ac-error");
  btn.disabled = true;
  btn.textContent = action === "answer" ? t("Sending…") : t("Working…");
  if (error) error.textContent = "";
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/action`, { method: "POST", body: JSON.stringify({ action, reason }) });
  } catch (err) {
    btn.textContent = label;
    btn.disabled = false;
    const form = acDetail?.runId === runId && err.status === 409 && $("#ac-detail .ac-answer");
    if (form) {
      // Answered elsewhere (another tab, Telegram). The typed text stays where it is,
      // and with text in the box the poll leaves the form alone.
      form.insertAdjacentHTML("beforebegin", acAnsweredHtml({}));
      btn.disabled = true;
      if (error) error.textContent = t("Your answer was not sent.");
      refreshActions();
      return;
    }
    if (error) error.textContent = t("That did not work: {error}", { error: acErrorText(err.message) });
    return;
  } finally {
    acBusy.delete(runId);
  }
  if (action === "answer") acDraft(runId, "");
  toast(acDoneText(action, item));
  // The item leaves the list now, and the next one opens in its place.
  const visible = acData ? acVisible() : [];
  const at = visible.findIndex((i) => i.runId === runId);
  const next = at === -1 ? null : visible[at + 1] ?? visible[at - 1] ?? null;
  if (acData && at !== -1) {
    acData.items = acData.items.filter((i) => i.runId !== runId);
    acData.counts[visible[at].kind] -= 1;
    acCountsChanged();
  }
  acSeq++;
  // Someone who opened another item while this was sending stays there.
  if (acSelectedId() === runId) {
    acLastOpen = next?.runId ?? null;
    acFocusDetail = !isNarrow();
    if (isNarrow() && acFromList === runId) {
      // Back to the list it came from; the hashchange draws it and refreshes.
      acFromList = null;
      history.back();
      return;
    }
    history.replaceState(null, "", next && !isNarrow() ? `#/actions/${next.runId}` : "#/actions");
  }
  renderInbox();
  refreshActions();
}

/** A filter that hides the open item on a wide screen: the first item it shows opens instead. */
function acFilterChanged() {
  const selected = acSelectedId();
  if (selected && !isNarrow() && !acVisible().some((i) => i.runId === selected)) history.replaceState(null, "", "#/actions");
  renderInbox();
}

$("#ac-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-ac-filter]");
  if (!btn) return;
  // From a project's link: the kind is the new choice, the project stays chosen.
  if (acVisit) writeStored(AC_PROJECT_KEY, acVisit.project);
  acVisit = null;
  writeStored(AC_FILTER_KEY, btn.dataset.acFilter);
  acFilterChanged();
});

$("#ac-project").addEventListener("change", (e) => {
  acVisit = null;
  writeStored(AC_PROJECT_KEY, e.target.value);
  acFilterChanged();
});

$("#ac-list").addEventListener("click", (e) => {
  const row = e.target.closest(".ac-row");
  if (row) {
    acFromList = acSelectedId() ? null : row.dataset.run;
    // Opened by keyboard (Enter has no click count): the reader goes to the item, not the next row.
    if (e.detail === 0) {
      acFocusDetail = true;
      if (row.dataset.run === acSelectedId()) $("#ac-detail .ac-subject")?.focus();
    }
    return;
  }
  if (e.target.closest("[data-ac-allprojects]")) {
    if (acVisit) writeStored(AC_FILTER_KEY, "all");
    acVisit = null;
    writeStored(AC_PROJECT_KEY, "");
    acFilterChanged();
    ($("#ac-project:not(.hidden)") || $('#ac-filter [data-ac-filter="all"]'))?.focus();
    return;
  }
  if (!e.target.closest("[data-ac-showall]")) return;
  acVisit = null;
  writeStored(AC_FILTER_KEY, "all");
  writeStored(AC_PROJECT_KEY, "");
  acFilterChanged();
  $('#ac-filter [data-ac-filter="all"]')?.focus();
});

const acDetailBox = $("#ac-detail");
acDetailBox.addEventListener("input", (e) => {
  if (e.target.id === "ac-answer-text") acDraft(acDetail.runId, e.target.value);
});

acDetailBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.id === "ac-answer-text") {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
  // The expert "More" menu closes like a menu: Escape, or a click outside (below).
  const menu = e.key === "Escape" && e.target.closest(".ac-menu[open]");
  if (menu) {
    menu.removeAttribute("open");
    menu.querySelector("summary").focus();
  }
});

document.addEventListener("click", (e) => {
  for (const menu of document.querySelectorAll(".ac-menu[open]")) if (!menu.contains(e.target)) menu.removeAttribute("open");
});

acDetailBox.addEventListener("submit", (e) => {
  const form = e.target.closest(".ac-answer");
  if (!form) return;
  e.preventDefault();
  acAct(form.dataset.run, "answer", form.querySelector("textarea").value, form.querySelector('[type="submit"]'));
});

const acCancelDialog = $("#ac-cancel");
let acCancelTarget = null;

acDetailBox.addEventListener("click", (e) => {
  if (e.target.closest("[data-ac-open-run]") && acDetail) {
    e.preventDefault();
    location.hash = "#/runs";
    selectRun(acDetail.runId);
    return;
  }
  if (e.target.closest(".ac-back") && acFromList && acFromList === acSelectedId()) {
    e.preventDefault();
    history.back();
    return;
  }
  if (e.target.closest("[data-ac-recommend]")) {
    const box = $("#ac-answer-text");
    const sentence = t("Go with your recommendation.");
    // Never over what is typed: the sentence goes below it.
    if (!box.value.includes(sentence)) box.value = box.value.trim() ? `${box.value.trimEnd()}\n${sentence}` : sentence;
    acDraft(acDetail.runId, box.value);
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    return;
  }
  const btn = e.target.closest("[data-ac-act]");
  if (!btn || !acDetail) return;
  if (btn.dataset.acAct === "cancel") {
    acCancelTarget = { runId: acDetail.runId, btn };
    acCancelDialog.returnValue = "";
    acCancelDialog.showModal();
    return;
  }
  acAct(acDetail.runId, btn.dataset.acAct, null, btn);
});

acCancelDialog.addEventListener("close", () => {
  const target = acCancelTarget;
  acCancelTarget = null;
  if (!target) return;
  if (acCancelDialog.returnValue === "cancel") acAct(target.runId, "cancel", null, target.btn);
  else target.btn.focus();
});

onEnter.actions = () => {
  acFocusDetail ||= isNarrow();
  renderInbox();
  refreshActions().catch(() => {});
};

// ── TIM: open work | explorer ─────────────────────────────────────────────
const TIM_VIEW_KEY = "teamup.timView";
let timViewShown = false;

function showTimView(view) {
  timViewShown = true;
  const which = view === "explorer" ? "explorer" : "work";
  writeStored(TIM_VIEW_KEY, which);
  for (const b of $("#tim-views").querySelectorAll("[data-tim-view]")) {
    b.classList.toggle("is-active", b.dataset.timView === which);
    b.setAttribute("aria-pressed", String(b.dataset.timView === which));
  }
  for (const pane of document.querySelectorAll("[data-tim-pane]")) pane.classList.toggle("hidden", pane.dataset.timPane !== which);
  requestAnimationFrame(fitTimFrame);
  if (which === "explorer") {
    const frame = $("#tim-frame");
    if (!frame.src) {
      $("#tim-explorer-status").textContent = t("Starting the TIM viewer…");
      frame.addEventListener("load", () => {
        $("#tim-explorer-status").textContent = "";
        frame.classList.remove("hidden");
        fitTimFrame();
      }, { once: true });
      frame.src = "/tim-viewer/?embed=1";
    }
  }
}
// The explorer fills the window down to its bottom edge, so the embedded
// viewer is the only thing that scrolls on that view.
function fitTimFrame() {
  const frame = $("#tim-frame");
  if (!frame.offsetParent) return;
  const top = frame.getBoundingClientRect().top + window.scrollY;
  const pad = parseFloat(getComputedStyle($("main")).paddingBottom) || 0;
  frame.style.height = `${Math.max(416, window.innerHeight - top - pad - 2)}px`;
}
window.addEventListener("resize", fitTimFrame);

$("#tim-views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tim-view]");
  if (b) showTimView(b.dataset.timView);
});

// Models tab: ask every CLI what it offers now.
$("#models-scan").addEventListener("click", async () => {
  const btn = $("#models-scan");
  btn.disabled = true;
  try {
    await api("/api/actions/models-scan", { method: "POST", body: "{}" });
    $("#catalogue-status").textContent = t("Scan started: every CLI is asked for its models; the list updates in about two minutes.");
    setTimeout(() => {
      btn.disabled = false;
      refreshCatalogue().catch(() => {});
    }, 120_000);
  } catch (err) {
    $("#catalogue-status").textContent = t("Refused: {error}", { error: err.message });
    btn.disabled = false;
  }
});

// ── AI Trending ───────────────────────────────────────────────────────────
// The newest report the hermes trending scraper wrote. It changes once a day,
// so it is fetched on login and every ten minutes rather than on the 5s cycle;
// switching sections redraws from what is already here.
const TRENDING_SECTION_KEY = "teamup.trendingSection";
let trendingData = null;
let trendingTimer = null;

async function refreshTrending() {
  try {
    trendingData = await api("/api/trending");
  } catch (err) {
    trendingData = null;
    $("#trending-status").textContent = t("That did not work: {error}", { error: err.message });
  }
  renderTrending();
}

// ── Communication: where messages go, replies, bots ──
let commData = null;

function commNote(text, tone = "") {
  const el = $("#comm-status");
  el.textContent = text;
  el.className = `status-line ${tone}`;
}

/** ariaLabel: a whole sentence naming what the select routes. */
function commDestSelect(value, ariaLabel) {
  const d = commData;
  return `<select class="comm-dest" data-comm-dest aria-label="${esc(ariaLabel)}">${
    d.bots.map((b) => `<option value="${esc(b.id)}"${value === b.id ? " selected" : ""} translate="no">📱 Telegram · @${esc(b.username)}</option>`).join("")
  }<option value="bell"${value === "bell" ? " selected" : ""}>🔔 ${esc(t("Only the bell in this dashboard"))}</option></select>`;
}

function renderCommunication() {
  const d = commData;
  if (!d) return;
  // The server's group ids; only "Your jobs" is a word to translate.
  const groups = [["team-up", "team-up"], ["TIM", "TIM"], ["Your jobs", t("Your jobs")]];
  const table = (rows) => `<table class="comm-table"><thead><tr>${th("Job — what it sends", t("Job: what it sends"))}<th class="comm-dest-col" data-col-key="Goes to">${
    esc(t("Goes to"))}</th></tr></thead><tbody>${
    rows.map((s) => `<tr data-sender="${esc(s.key)}">
      <td>${esc(s.title)}${!s.scheduled ? ` <span class="tag off">${esc(t("not scheduled"))}</span>` : s.enabled ? "" : ` <span class="tag off">${esc(t("switched off"))}</span>`}
        <div class="muted">${esc(s.notifies)}</div></td>
      <td>${commDestSelect(s.dest ?? d.default, t("Where messages from {job} go", { job: s.title }))}</td></tr>`).join("")}</tbody></table>`;
  $("#comm-routes").innerHTML = groups.map(([g, title]) => {
    const rows = d.senders.filter((s) => s.group === g);
    return rows.length ? `<h3 class="comm-group">${esc(title)}</h3>${table(rows)}` : "";
  }).join("") + `<h3 class="comm-group">${esc(t("Everything else"))}</h3>
    <table class="comm-table"><tbody><tr data-sender="*">
      <td>${esc(t("Anything not listed above"))}<div class="muted">${esc(t("Any other script that sends to Telegram, and new jobs until you choose a place for them."))}</div></td>
      <td>${commDestSelect(d.default, t("Where all other messages go"))}</td></tr></tbody></table>`;

  // Replies: which bots listen, and how a new session starts.
  const listening = d.bots.filter((b) => b.listen);
  const usedBots = new Set(d.senders.map((s) => s.dest ?? d.default).concat(d.default));
  const deaf = d.bots.filter((b) => usedBots.has(b.id) && !b.listen && !b.owner);
  const owned = d.bots.filter((b) => usedBots.has(b.id) && b.owner);
  const handles = (bots) => bots.map((b) => `@${b.username}`).join(", ");
  const ownedNote = owned.length
    ? `<div class="comm-notice">${withNames(t("Messages now arrive through {bots}. Replies there are read by {owner}, not by team-up, so they do not continue the session in the footer. To continue sessions, send the jobs through a bot team-up listens to."),
      { bots: handles(owned), owner: owned[0].owner })}</div>` : "";
  const imported = deaf.find((b) => b.imported);
  const notice = !listening.length && !(owned.length && !deaf.length)
    ? `<div class="comm-notice"><strong>${esc(t("No bot listens yet, so replying does nothing."))}</strong> ${imported
      ? withNames(t("Switch on listening for the bot your messages come from. For {bot} that ends its old send-only rule (it was kept so that no second program would compete for its replies; team-up is the only reader here). Or add a bot of its own for this."), { bot: `@${imported.username}` })
      : esc(t("Switch on listening for the bot your messages come from."))}</div>`
    : deaf.length ? `<div class="comm-notice">${withNames(tp(deaf.length, {
      one: "Messages also arrive through {bots}, which does not listen: replies there do nothing.",
      other: "Messages also arrive through {bots}, which do not listen: replies there do nothing." }), { bots: handles(deaf) })}</div>` : "";
  const botRows = d.bots.map((b) => {
    const poll = b.poll ? (b.poll.ok ? `<span class="tag ok">${esc(t("listening"))}</span>`
      : `<span class="tag err" title="${esc(b.poll.error || "")}">${esc(t("cannot read replies: {error}", { error: b.poll.error || "" }))}</span>`) : "";
    const ctl = b.owner
      ? `<span class="muted">${withNames(t("Replies are read by {owner}: Telegram gives each reply to one reader only."), { owner: b.owner })}</span>`
      : `<label class="switch"><input type="checkbox" data-comm-listen${b.listen ? " checked" : ""}> ${esc(t("Listen for replies"))}</label>${poll}`;
    return `<div class="comm-bot-row" data-bot="${esc(b.id)}"><span class="name" translate="no">@${esc(b.username)}</span>${ctl}</div>`;
  }).join("");
  const r = d.replies;
  const models = (d.modelOptions.includes(r.model) ? [] : [r.model]).concat(d.modelOptions);
  $("#comm-replies").innerHTML = `${notice}${ownedNote}${botRows}
    <div class="comm-new job">
      <h3>${esc(t("New sessions"))}</h3>
      <p class="muted">${esc(t("Used when you reply to a script's report, or write to a bot without replying to a message. A reply to a message with a 🧵 claude session always continues that session, in its own folder and with its own model."))}</p>
      <div class="knobs">
        <label for="comm-r-model">${esc(t("Model"))}</label>
        <select id="comm-r-model" translate="no">${models.map((m) => `<option value="${esc(m)}"${m === r.model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>
        <label for="comm-r-cwd">${esc(t("Folder"))}</label>
        <input id="comm-r-cwd" class="mono" type="text" value="${esc(r.cwd)}" size="40">
        <label for="comm-r-instr">${esc(t("Extra instructions"))}</label>
        <textarea id="comm-r-instr" rows="3" placeholder="${esc(t("Optional, e.g. “You may cancel stuck runs with team-up runs cancel.”"))}">${esc(r.instructions || "")}</textarea>
        <span></span><span><button type="button" class="primary" id="comm-r-save">${esc(t("Save"))}</button></span>
      </div>
    </div>`;

  $("#comm-bots").innerHTML = d.bots.length
    ? `<table><thead><tr>${th("Bot", t("Bot"))}${th("Token", t("Token"))}${th("Carries", t("Sends"))}<th></th></tr></thead><tbody>${
      d.bots.map((b) => `<tr data-bot="${esc(b.id)}">
        <td translate="no">@${esc(b.username)}<div class="muted mono">${esc(b.env)}</div></td>
        <td class="mono">${b.missing ? `<span class="tag err">${esc(t("token file missing"))}</span>` : esc(b.tokenTail || "—")}</td>
        <td>${[b.jobs ? esc(tp(b.jobs, { one: "{n} job", other: "{n} jobs" })) : "", b.isDefault ? esc(t("everything else")) : ""].filter(Boolean).join(" + ")
          || `<span class="muted">${esc(t("nothing"))}</span>`}</td>
        <td class="row-actions"><button type="button" data-comm-test>${esc(t("Send test"))}</button>
          <button type="button" data-comm-remove${b.jobs || b.isDefault ? ` disabled title="${esc(t("Send its messages elsewhere first"))}"` : ""}>${esc(t("Remove"))}</button></td>
      </tr>`).join("")}</tbody></table>`
    : `<div class="empty">${esc(t("No bots yet: add one below."))}</div>`;
  const broken = d.bots.filter((b) => b.missing || (b.poll && !b.poll.ok)).length;
  updateNavBadge("badge-communication", broken ? String(broken) : "", "red", broken > 0,
    broken ? tp(broken, { one: "{n} bot needs attention", other: "{n} bots need attention" }) : "");
}

async function refreshCommunication() {
  commData = await api("/api/communication");
  renderCommunication();
}
onEnter.communication = () => refreshCommunication().catch((err) => commNote(t("That did not work: {error}", { error: err.message }), "err"));

async function commWrite(url, body, done) {
  try {
    await api(url, { method: "POST", body: JSON.stringify(body) });
    commNote(done, "ok");
    return true;
  } catch (err) {
    commNote(t("Refused: {error}", { error: err.message }), "err");
    return false;
  } finally {
    await refreshCommunication().catch(() => {});
  }
}

$("#comm-routes").addEventListener("change", async (e) => {
  if (!e.target.matches("[data-comm-dest]")) return;
  const sender = e.target.closest("[data-sender]").dataset.sender;
  const label = e.target.selectedOptions[0]?.textContent || e.target.value;
  const job = sender === "*" ? t("everything else") : commData.senders.find((s) => s.key === sender)?.title || sender;
  await commWrite("/api/communication/routes", { sender, dest: e.target.value }, t("Saved: {job} → {place}", { job, place: label }));
});

$("#comm-replies").addEventListener("change", async (e) => {
  if (!e.target.matches("[data-comm-listen]")) return;
  const id = e.target.closest("[data-bot]").dataset.bot;
  const on = e.target.checked;
  await commWrite(`/api/communication/bots/${id}/listen`, { listen: on },
    on ? t("Listening: replies to this bot now continue their session.") : t("Stopped listening."));
});

$("#comm-replies").addEventListener("click", async (e) => {
  if (e.target.id !== "comm-r-save") return;
  await commWrite("/api/communication/replies", {
    model: $("#comm-r-model").value, cwd: $("#comm-r-cwd").value.trim(), instructions: $("#comm-r-instr").value,
  }, t("Settings for new sessions saved."));
});

$("#comm-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  commNote(t("Checking the token with Telegram…"));
  const chat = $("#comm-chat").value.trim();
  if (await commWrite("/api/communication/bots", { token: $("#comm-token").value.trim(), chat_id: chat || undefined },
    t("Bot added: send it a test, then send jobs to it above."))) {
    $("#comm-token").value = "";
    $("#comm-chat").value = "";
    $("#comm-add-box").open = false;
  }
});

$("#comm-bots").addEventListener("click", async (e) => {
  const id = e.target.closest("[data-bot]")?.dataset.bot;
  if (!id) return;
  if (e.target.matches("[data-comm-test]")) {
    await commWrite(`/api/communication/bots/${id}/test`, {}, t("Test message sent: check Telegram."));
  } else if (e.target.matches("[data-comm-remove]") && confirm(t("Remove this bot from the list?"))) {
    await commWrite(`/api/communication/bots/${id}/remove`, {}, t("Bot removed."));
  }
});

function renderTrending() {
  const sections = trendingData?.sections || [];
  $("#trending-date").textContent = trendingData?.date || "";
  $("#trending-section").classList.toggle("hidden", !sections.length);
  if (!trendingData) {
    $("#trending-table").innerHTML = "";
    return;
  }
  // The stored pick, else the first section that has rows: the scraper's
  // "Fastest Growing" table has been empty in every report so far.
  const stored = readStored(TRENDING_SECTION_KEY, null);
  const section = sections.find((s) => s.title === stored)
    || sections.find((s) => s.repos.length) || sections[0];
  fillSelect($("#trending-section"), sections.map((s) => ({ value: s.title, label: `${s.title} (${s.repos.length})` })));
  if (section) $("#trending-section").value = section.title;
  $("#trending-status").textContent = !section ? t("The report has no sections.")
    : section.repos.length ? "" : t("No repositories in this section.");
  $("#trending-table").innerHTML = section?.repos.length ? `<table>
    <thead><tr>${th("Repo", t("Repository"))}<th aria-label="${esc(t("Stars"))}">⭐</th>${th("Lang", t("Language"))}${th("Created", t("Created"))}${th("Description", t("Description"))}</tr></thead>
    <tbody>${section.repos.map((r) => `<tr>
      <td translate="no">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.name)}</a>` : esc(r.name)}</td>
      <td>${r.stars == null ? "" : r.stars.toLocaleString(LANG)}</td>
      <td>${esc(r.lang)}</td>
      <td>${esc(r.created)}</td>
      <td class="desc" translate="no" title="${esc(r.description)}">${esc(r.description)}</td>
    </tr>`).join("")}</tbody></table>` : "";
}

$("#trending-section").addEventListener("change", (e) => {
  writeStored(TRENDING_SECTION_KEY, e.target.value);
  renderTrending();
});

// ── Widget help, colour and visible columns ───────────────────────────────
// Every panel gets a tooltip on its title and a pencil. The pencil edits two
// per-browser preferences: a colour, and which table columns (or rows, where a
// panel lists things rather than tabulating them) to show. Hiding is CSS on
// data-col / data-row, so the five-second redraw keeps the choice without any
// renderer knowing about it.
const PANEL_HELP = {
  "panel-usage": t("How much of each subscription is used, how close it is to its limit, and when it resets. “Out of date” means the readings stopped coming in; one click sends a helper to fix it."),
  "panel-sessions": t("Live tmux sessions (click one to open its terminal), every live Claude Code session including the desktop app's (message or stop it), and team-up runs with their mailbox (click a run for STATUS / PROMPT / RESULT)."),
  "panel-projects": t("Your projects: what waits for you in each, what is being worked on there, and a session to work in one yourself."),
  "panel-tim": t("Open tasks, ideas and bugs of every project in the folder. Start opens a session with the item as its prompt."),
  "panel-roles": t("Every role and its fallback chain. The outlined chip is what `team-up pick` would choose right now; faded chips are skipped right now (hover for why). Drag chips to reorder, drop a model from the roster to add it, ✕ to remove; dragging a chip onto another role copies it. ✎ sets effort and pinning. ⬆ marks a newer version, ✗ a model the CLI no longer offers."),
  "panel-roster": t("Every model in the roster, grouped by the CLI it runs on: the drag sources for the chains. Dashed: in no chain yet. Under “Add or remove models” each provider lists what it offers; a checked model is in the roster."),
  "panel-providers": t("How each provider authenticates: an API key team-up holds, a CLI's own login, or a key the CLI keeps itself."),
  "panel-trending": t("New AI repositories on GitHub from the newest daily report of the hermes trending scraper (~/.hermes/cron-outputs/framework-scout). Pick a section; hover a description for all of it."),
  "panel-clis": t("Agent CLIs: version, harness check, update, install and login. CLIs team-up can install but the roster does not run yet are rows you switch on in ✎. Hover a CLI name for its path; click a row for the job log."),
};
// Only panels with an id: prefs are keyed by it, and `# [data-…]` would be an
// invalid selector that voids the whole hiding rule.
const panels = () => [...document.querySelectorAll("main .panel[id]")];
const PANEL_PREFS_KEY = "teamup.panelPrefs";
const prefStyle = document.createElement("style");
document.head.append(prefStyle);

function applyPanelPrefs() {
  const prefs = readStored(PANEL_PREFS_KEY, {});
  const rules = [];
  for (const panel of panels()) {
    const p = prefs[panel.id] || {};
    if (p.color) panel.style.setProperty("--panel-color", p.color);
    else panel.style.removeProperty("--panel-color");
    panel.classList.toggle("tinted", !!p.color);
    for (const col of p.cols || []) rules.push(`#${panel.id} [data-col="${CSS.escape(col)}"]`);
    for (const row of p.rows || []) rules.push(`#${panel.id} [data-row="${CSS.escape(row)}"]`);
    rules.push(`#${panel.id} [data-row-default="hidden"]${(p.rowsShown || [])
      .map((row) => `:not([data-row="${CSS.escape(row)}"])`).join("")}`);
  }
  prefStyle.textContent = rules.length ? `${rules.join(",\n")} { display: none !important; }` : "";
}

/**
 * Give every header and body cell a data-col named after its header. Group
 * rows that span the whole table stay untagged, so hiding a column never
 * hides a section heading.
 */
function tagColumns(table) {
  const scope = table.closest(".table-wrap")?.id?.replace(/-table$/, "") || "t";
  const heads = [...(table.tHead?.rows[0]?.cells || [])];
  // data-col-key: the English header of a translated one, so a hidden column stays hidden in every language.
  const keys = heads.map((th) => {
    const text = (th.dataset.colKey || th.textContent).trim().toLowerCase();
    return text ? `${scope}:${text}` : null;
  });
  heads.forEach((th, i) => { if (keys[i]) th.dataset.col = keys[i]; });
  for (const row of table.tBodies[0]?.rows || []) {
    let i = 0;
    for (const cell of row.cells) {
      if (cell.colSpan === 1 && keys[i]) cell.dataset.col = keys[i];
      i += cell.colSpan;
    }
  }
}

function openPanelEditor(panel) {
  const dialog = $("#panel-editor");
  const prefs = readStored(PANEL_PREFS_KEY, {});
  const mine = prefs[panel.id] || {};
  dialog.dataset.panel = panel.id;
  $("#panel-editor-title").textContent = panel.querySelector("h2 .title").textContent;
  $("#panel-editor-color").value = mine.color || "#2563eb";
  const cols = new Map();
  // A column by its header as shown; the key under it stays English (tagColumns).
  panel.querySelectorAll("th[data-col]").forEach((cell) => cols.set(cell.dataset.col, cell.textContent.trim() || cell.dataset.col));
  const rows = new Map();
  panel.querySelectorAll("[data-row]").forEach((el) => rows.set(el.dataset.row, el.dataset.row));
  // Rows that start hidden (a CLI team-up can install but the roster doesn't
  // run) are stored as shown, the rest as hidden.
  const offByDefault = new Set([...panel.querySelectorAll('[data-row-default="hidden"]')].map((el) => el.dataset.row));
  const shownRows = new Set(mine.rowsShown || []);
  const hiddenCols = new Set(mine.cols || []);
  const hiddenRows = new Set([...(mine.rows || []), ...[...offByDefault].filter((r) => !shownRows.has(r))]);
  const list = (kind, items, hidden, label) => items.size
    ? `<label>${esc(label)}</label><div class="pref-list">${[...items].map(([k, name]) =>
      `<label><input type="checkbox" data-kind="${kind}" value="${esc(k)}"${
        offByDefault.has(k) ? " data-default-off" : ""}${hidden.has(k) ? "" : " checked"}> ${
        esc(kind === "cols" ? name : name.replace(":", " › "))}</label>`).join("")}</div>`
    : "";
  $("#panel-editor-items").innerHTML = list("cols", cols, hiddenCols, t("Visible columns"))
    + list("rows", rows, hiddenRows, t("Visible rows"));
  dialog.showModal();
}

function savePanelEditor(patch) {
  const id = $("#panel-editor").dataset.panel;
  const prefs = readStored(PANEL_PREFS_KEY, {});
  prefs[id] = { ...(prefs[id] || {}), ...patch };
  writeStored(PANEL_PREFS_KEY, prefs);
  applyPanelPrefs();
}

$("#panel-editor-color").addEventListener("input", (e) => savePanelEditor({ color: e.target.value }));
$("#panel-editor-color-reset").addEventListener("click", () => savePanelEditor({ color: null }));
$("#panel-editor-items").addEventListener("change", () => {
  const pick = (sel) => [...$("#panel-editor-items").querySelectorAll(sel)].map((x) => x.value);
  savePanelEditor({
    cols: pick('input[data-kind="cols"]:not(:checked)'),
    rows: pick('input[data-kind="rows"]:not([data-default-off]):not(:checked)'),
    rowsShown: pick('input[data-kind="rows"][data-default-off]:checked'),
  });
});
$("#panel-editor-reset").addEventListener("click", () => {
  const id = $("#panel-editor").dataset.panel;
  const prefs = readStored(PANEL_PREFS_KEY, {});
  delete prefs[id];
  writeStored(PANEL_PREFS_KEY, prefs);
  applyPanelPrefs();
  $("#panel-editor").close();
});

function enablePanelChrome() {
  for (const panel of panels()) {
    const h2 = panel.querySelector("h2");
    if (!h2) continue;
    h2.innerHTML = `<span class="title"${PANEL_HELP[panel.id] ? ` title="${esc(PANEL_HELP[panel.id])}"` : ""}>${h2.innerHTML}</span>
      <button type="button" class="panel-edit" title="${esc(t("Colour and visible columns"))}" aria-label="${esc(t("Colour and visible columns"))}">✎</button>`;
    h2.querySelector(".panel-edit").addEventListener("click", () => openPanelEditor(panel));
    // Renderers replace their tables wholesale; tag whatever they just drew.
    new MutationObserver(() => panel.querySelectorAll("table").forEach(tagColumns))
      .observe(panel, { childList: true, subtree: true });
  }
  applyPanelPrefs();
}

// ── Notifications (the bell) ───────────────────────────────────────────────
// Things worth knowing but not urgent — a CLI offering a new model family.
// Opening the panel marks what it shows read.
let notifications = [];

async function refreshNotifications() {
  notifications = (await api("/api/notifications")).items || [];
  const unread = notifications.filter((n) => !n.read).length;
  $("#bell-count").textContent = unread > 9 ? "9+" : String(unread);
  $("#bell-count").classList.toggle("hidden", !unread);
  if (!$("#bell-panel").classList.contains("hidden")) renderBell();
}

function renderBell() {
  $("#bell-list").innerHTML = notifications.map((n) => `<li class="${n.read ? "" : "unread"}">
    <strong>${esc(n.title)}</strong><p>${esc(n.text || "")}</p>
    <small class="muted">${esc(fmtDateTime(n.at))}</small>${
      n.link?.startsWith("#/") ? ` <a href="${esc(n.link)}" class="bell-link">${esc(t("Open|verb"))}</a>` : ""}</li>`).join("")
    || `<li class="muted">${esc(t("Nothing new."))}</li>`;
}

async function markBellRead(ids) {
  try {
    await api("/api/notifications/read", { method: "POST", body: JSON.stringify(ids ? { ids } : {}) });
  } catch { /* read-only token: the badge just stays */ }
  await refreshNotifications().catch(() => {});
}

$("#bell").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#bell-panel").classList.toggle("hidden") === false;
  $("#bell").setAttribute("aria-expanded", String(open));
  if (!open) return;
  renderBell();
  const unread = notifications.filter((n) => !n.read).map((n) => n.id);
  if (unread.length) setTimeout(() => markBellRead(unread), 1500);
});
$("#bell-read-all").addEventListener("click", () => markBellRead(null));
$("#bell-list").addEventListener("click", (e) => {
  if (e.target.closest(".bell-link")) $("#bell-panel").classList.add("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#bell-panel, #bell")) $("#bell-panel").classList.add("hidden");
});

// ── Expert view and language (sidebar, Settings → General) ───────────────
function setExpert(on) {
  writeStored(EXPERT_KEY, on);
  document.documentElement.classList.toggle("is-expert", on);
  const fromSettings = document.activeElement?.closest?.("#settings-body");
  for (const box of document.querySelectorAll(".expert-toggle")) box.checked = on;
  // What the renderers drew with or without technical detail, drawn again.
  renderSettings();
  if (fromSettings) $("#settings-body .expert-toggle")?.focus();
  projectsKey = "";
  renderProjects();
  renderTeam();
  if (acDetail?.key) {
    acDetail.key = "expert";
    loadDetail(acDetail.runId);
  }
}

for (const box of document.querySelectorAll(".expert-toggle")) box.checked = isExpert();
document.addEventListener("change", (e) => {
  if (e.target.matches?.(".expert-toggle")) setExpert(e.target.checked);
});

// The same edit as Settings → General → Language; the page reloads in the new one.
for (const b of document.querySelectorAll(".lang-switch [data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === LANG));
$(".lang-switch").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-lang]");
  if (!b || b.dataset.lang === LANG) return;
  b.disabled = true;
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify({ path: "language", value: b.dataset.lang }) });
    location.reload();
  } catch (err) {
    b.disabled = false;
    toast(t("Could not switch the language: {error}", { error: err.message }));
  }
});

function refreshAll() {
  return Promise.allSettled([
    refreshUsage(),
    refreshRuns(),
    refreshTmux(),
    refreshClaudeSessions(),
    refreshProjects(),
    refreshTim(),
    refreshActions(),
    refreshRoles(),
    refreshSetup(),
    refreshNotifications(),
  ]);
}

let automationTimer = null;

function startPolling() {
  refreshSpecialists().catch(() => {});
  $("#catalogue-box").open = readStored(CATALOGUE_OPEN_KEY, "") === "1";
  refreshSettings().catch(() => {});
  refreshAutomation().catch(() => {});
  refreshCommunication().catch(() => {});
  clearInterval(automationTimer);
  // Communication is not polled: a re-render would wipe a half-edited reply form.
  automationTimer = setInterval(() => refreshAutomation().catch(() => {}), 60_000);
  refreshTrending();
  clearInterval(trendingTimer);
  trendingTimer = setInterval(refreshTrending, 10 * 60_000);
  refreshAll();
  if (listTimer) clearInterval(listTimer);
  listTimer = setInterval(refreshAll, 5000);
}

async function probe() {
  try {
    await api("/api/runs?active=1");
    await pullPrefs();
    showApp();
    startPolling();
  } catch {
    showLogin();
  }
}

enablePanelChrome();

probe();
