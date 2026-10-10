const $ = (sel) => document.querySelector(sel);

let adminChallengeId = null;

// The markup is the list of views: a new <section class="view"> routes without
// touching this file.
const VIEW_NAMES = new Set([...document.querySelectorAll(".view")].map((view) => view.dataset.view));

// Old links keep working after a view was renamed or split.
const ROUTE_ALIASES = { cron: "automation" };
// Views that load on entry rather than on the five-second cycle.
const onEnter = {};

function applyRoute() {
  const match = location.hash.match(/^#\/([^/?#]+)$/);
  const wanted = match ? ROUTE_ALIASES[match[1]] || match[1] : null;
  const route = wanted && VIEW_NAMES.has(wanted) ? wanted : "overview";
  const canonicalHash = `#/${route}`;
  if (location.hash !== canonicalHash) history.replaceState(null, "", canonicalHash);
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.dataset.view === route);
  });
  document.querySelectorAll(".sidebar-nav [data-route]").forEach((link) => {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (!$("#app").classList.contains("hidden")) onEnter[route]?.();
  document.title = `${document.querySelector(`.view[data-view="${route}"] .page-head h1`)?.textContent || "team-up"} · team-up`;
}

window.addEventListener("hashchange", applyRoute);
applyRoute();

const dashboardMetrics = { runCounts: null, usage: null, tim: null };

function usageLevelName(level) {
  return ({ red: "Critical", amber: "Warn", ok: "OK" })[level] || "Unknown";
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
  const { active = 0, waiting = 0, uncollected = 0, failedUncollected: failed = 0 } = dashboardMetrics.runCounts || {};
  $("#kpi-active-runs").textContent = String(active);
  $("#kpi-waiting-runs").textContent = String(waiting);
  $("#kpi-uncollected-runs").textContent = String(uncollected);

  const runsTone = waiting || failed ? "red" : "";
  const runsBadge = active ? String(active) : failed ? "!" : "";
  updateNavBadge("badge-runs", runsBadge, runsTone, Boolean(runsBadge),
    [waiting ? `${waiting} waiting on the human` : "", failed ? `${failed} failed, not collected` : ""]
      .filter(Boolean).join("; "));

  const windows = Object.entries(dashboardMetrics.usage?.windows || {})
    .filter(([, window]) => typeof window.usedPct === "number")
    .sort(([keyA, a], [keyB, b]) => b.usedPct - a.usedPct || keyA.localeCompare(keyB));
  const worst = windows[0];
  $("#kpi-worst-usage").textContent = worst ? `${worst[1].usedPct}%` : "—";
  $("#kpi-worst-usage-detail").textContent = worst
    ? `${worst[0]} · ${usageLevelName(worst[1].level)}`
    : "No usage windows";
  const usageLevel = Object.values(dashboardMetrics.usage?.windows || {}).some((window) => window.level === "red")
    ? "red"
    : Object.values(dashboardMetrics.usage?.windows || {}).some((window) => window.level === "amber")
      ? "amber"
      : "";
  updateNavBadge("badge-overview", usageLevel === "red" ? "Critical" : usageLevel === "amber" ? "Warn" : "",
    usageLevel, Boolean(usageLevel), usageLevel ? `Usage level: ${usageLevelName(usageLevel)}` : "");

  const tim = dashboardMetrics.tim;
  const installed = Boolean(tim?.installed);
  const p1p2 = installed
    ? (tim.projects || []).flatMap((project) => project.items || [])
      .filter((item) => item.kind === "task" && URGENT_PRIORITIES.has(String(item.priority || "").trim().toUpperCase())).length
    : 0;
  $("#kpi-tim-tile").classList.toggle("hidden", !installed);
  $("#kpi-tim-tasks").textContent = String(p1p2);
  updateNavBadge("badge-tim", p1p2 ? String(p1p2) : "", "", p1p2 > 0,
    p1p2 ? `${p1p2} open high-priority TIM tasks` : "");
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
    throw new Error(err.error || res.statusText);
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
      errEl.textContent = "Invalid token";
      errEl.classList.remove("hidden");
      return;
    }
    $("#token-input").value = "";
    await pullPrefs().catch(() => {});
    showApp();
    startPolling();
  } catch {
    errEl.textContent = "Login failed";
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

function fmtTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso || "—";
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate();
  if (sameDay) return time;
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} - ${time}`;
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
  if (level === "red") return '<span class="badge red">RED</span>';
  if (level === "amber") return '<span class="badge amber">WARN</span>';
  return '<span class="badge ok">OK</span>';
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
    return ` <span class="badge red" title="collector could not authenticate${n > 1 ? ` (${n}x in a row)` : ""} — re-login at the CLI">LOGIN FAILED</span>`;
  }
  return stale ? staleBadge(key, collector) : "";
}

function staleBadge(key, collector) {
  const cli = key.split(":")[0];
  const reason = collector?.last_reason;
  const title = reason ? ` title="last collector failure: ${esc(reason)}"` : "";
  if (collector?.repair?.running) {
    return ` <button class="badge stale" data-repair-session="${esc(collector.repair.session)}"${title}>FIXING…</button>`;
  }
  return ` <button class="badge stale" data-repair="${esc(cli)}"${title}>STALE · FIX IT</button>`;
}

/** Derived from /api/usage, so a reload shows the same thing. */
function repairStatusLine(collectors = {}) {
  const entries = Object.entries(collectors);
  // Collector-level, not per row: a CLI whose login died may have no windows in
  // usage.json at all, and then no row exists to carry the warning.
  const dead = entries.filter(([, c]) => c?.suggest_disable).map(([cli]) => cli);
  if (dead.length) {
    const today = new Date().toISOString().slice(0, 10);
    return dead.map((cli) =>
      `⚠ ${cli}: login failed ${collectors[cli].auth_failure_streak}x in a row. If the subscription is gone, set accounts.${cli} in ~/.team-up/roster.json to "enabled": false with "$comment": "${cli} sub dead ${today}. Flip enabled:true to bring the chain entries back." — nothing is switched automatically.`,
    ).join(" ");
  }
  const running = entries.filter(([, c]) => c?.repair?.running).map(([cli]) => cli);
  if (running.length) {
    return `⟳ updating usage limits for ${running.join(", ")} — this widget refreshes itself every 5s`;
  }
  const DAY = 24 * 3600 * 1000;
  const reported = entries.filter(([, c]) =>
    c?.repair?.report && Date.now() - Date.parse(c.repair.started_at || 0) < DAY);
  if (reported.length) {
    return `last repair wrote ~/.team-up/usage-repair-${reported[0][0]}.report.md`;
  }
  return "";
}

async function refreshRuns() {
  const data = await api(`/api/runs?active=${$("#active-only").checked ? "1" : "0"}`);
  dashboardMetrics.runCounts = data.counts;
  updateDashboardMetrics();
  updateAttention();
  const visibleRuns = data.runs;
  const rows = visibleRuns.map((r) => `
    <tr class="clickable" data-run="${esc(r.runId)}"${providerAttr(r.worker)}>
      <td><code>${esc(r.runId.slice(-8))}</code></td>
      <td>${esc(r.role)}</td>
      <td>${esc(r.status)}</td>
      <td>${esc(r.worker || "—")}</td>
      <td>${esc(r.project || "—")}</td>
      <td class="path">${esc(r.cwd || "—")}</td>
      <td>${esc(r.age || "—")}</td>
      <td>${esc(r.heartbeatAge || "—")}</td>
    </tr>`).join("");
  $("#runs-table").innerHTML = `<table>
    <thead><tr><th>Run</th><th>Role</th><th>Status</th><th>Worker</th><th>Project</th><th>CWD</th><th>Age</th><th>HB</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8">No runs</td></tr>'}</tbody></table>`;
  $("#runs-table").querySelectorAll("tr[data-run]").forEach((tr) => {
    tr.addEventListener("click", () => selectRun(tr.dataset.run));
  });
  if (selectedRun) selectRun(selectedRun);
}

const RUN_BUTTONS = [
  { action: "cancel", label: "Cancel", when: (s) => !TERMINAL_RUN.has(s), title: "Mark cancelled and stop the worker's terminal" },
  { action: "fail", label: "Mark failed…", when: (s) => !TERMINAL_RUN.has(s), title: "With a reason — the insights job counts failures by reason" },
  { action: "collect", label: "Mark collected", when: (s, r) => TERMINAL_RUN.has(s) && !r.collected, title: "You have read the result; it leaves the open list" },
  { action: "merged", label: "Outcome: merged", when: (s, r) => TERMINAL_RUN.has(s) && !r.outcome, title: "The work landed" },
  { action: "discarded", label: "Outcome: discarded", when: (s, r) => TERMINAL_RUN.has(s) && !r.outcome, title: "The work was not kept" },
];
const TERMINAL_RUN = new Set(["done", "failed", "cancelled"]);

function renderRunActions(runId, state) {
  const el = $("#run-actions");
  const status = state?.status || "unknown";
  const buttons = RUN_BUTTONS.filter((b) => b.when(status, state || {}));
  el.innerHTML = `<strong><code>${esc(runId.slice(-8))}</code> · ${esc(status)}${state?.collected ? " · collected" : ""}${
    state?.outcome?.value ? ` · ${esc(state.outcome.value)}` : ""}</strong>${buttons.map((b) =>
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
    reason = prompt("Why did this run fail? (one line)");
    if (!reason) return;
  } else if (action === "cancel" && !confirm("Cancel this run and stop its worker?")) {
    return;
  }
  btn.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/action`, { method: "POST", body: JSON.stringify({ action, reason }) });
  } catch (err) {
    alert(`refused: ${err.message}`);
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
  el.textContent = parts.join("\n\n") || "No mailbox files";
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
    <thead><tr><th>Session</th><th>Run</th><th>Role</th><th>Status</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No sessions</td></tr>'}</tbody></table>`;
  $("#tmux-table").querySelectorAll("tr[data-session]").forEach((tr) => {
    tr.addEventListener("click", () => selectSession(tr.dataset.session));
  });
}

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
    $("#term-state").textContent = err.message;
  }
}

async function refreshPane() {
  if (!selectedSession) return;
  try {
    const data = await api(`/api/tmux/${encodeURIComponent(selectedSession)}/pane`);
    // Trailing blank lines are the unused rest of the pane; they push the
    // prompt off the top of a scrolled screen for no reason.
    $("#pane-output").textContent = (data.pane || "").replace(/\s+$/, "") || "(empty)";
    $("#term-state").textContent = "";
  } catch {
    $("#term-state").textContent = "session gone";
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
      <div>${levelBadge(w.level)}${collectorBadge(key, data.collectors?.[key.split(":")[0]], w.stale)}</div>
      <div class="marked-item">↻ ${esc(w.resets_at ? fmtTime(w.resets_at) : "—")}</div>
    </div>`).join("");
  $("#usage-grid").innerHTML = rows || "<p>No usage data</p>";
  const status = repairStatusLine(data.collectors);
  const statusEl = $("#usage-repair-status");
  statusEl.textContent = status;
  statusEl.classList.toggle("hidden", !status);
  $("#marked-list").innerHTML = data.marked.length
    ? `<h3>Marked as limited</h3>${data.marked.map((m) => `<div class="marked-item">
        <strong>${esc(m.key)}</strong> until ${esc(fmtTime(m.until))}${m.reason ? ` · ${esc(m.reason)}` : ""}
        <button type="button" class="link" data-clear-mark="${esc(m.key)}">Lift now</button></div>`).join("")}`
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
    alert(`could not lift the mark: ${err.message}`);
  }
  await refreshUsage();
});

$("#mark-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#mark-status");
  const body = { target: $("#mark-target").value, hours: Number($("#mark-hours").value), reason: $("#mark-reason").value };
  try {
    const res = await api("/api/actions/mark-limited", { method: "POST", body: JSON.stringify(body) });
    status.textContent = `${body.target} is out of every chain until ${fmtTime(res.until)}.`;
    $("#mark-reason").value = "";
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
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
  btn.textContent = "starting…";
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
    btn.textContent = "STALE · FIX IT";
    alert(`repair failed to start: ${err.message}`);
  }
  await refreshUsage();
});

// ── Roles & Models ────────────────────────────────────────────────────────
// One row per role: its chain, what `pick` would choose right now and why it
// skipped the rest. Editing happens in a <dialog>, so the five-second redraw
// of this table never eats a half-built chain.
let rolesData = null;

const CELL_STATE = {
  gone: ["red", "gone — the CLI no longer offers it"],
  missing: ["red", "not in the roster's models"],
  unknown: ["", "no fresh scan of this CLI — availability unknown"],
};

function chainChip(c, i) {
  if (c.invalid) return `<span class="chip missing" title="${esc(c.invalid)}">invalid</span>`;
  const [cls, why] = c.state === "gone" && !c.newest
    ? ["red", "gone — the CLI no longer offers it and no newer version of this model exists. Delete it from the chain or pick another model"]
    : CELL_STATE[c.state] || ["", ""];
  const notes = [why, c.newest ? `newer: ${c.newest}` : "", c.pinned ? "version pinned" : "",
    c.effort ? `effort ${c.effort}` : ""].filter(Boolean).join(" · ");
  return `<span class="chip chain-chip ${cls}"${providerAttr(c.cli, c.model)} title="${esc(`${c.cli}:${c.model}${notes ? ` — ${notes}` : ""}`)}">${
    i + 1}. ${esc(c.label)}${c.pinned ? " 📌" : ""}${c.newest ? " ⬆" : ""}${c.state === "gone" ? " ✗" : ""}</span>`;
}

let specialistRolesKey = "";

async function refreshRoles() {
  rolesData = await api("/api/roles");
  // The specialist's assign dropdown lists the roles; redraw it only when they
  // change, so the 5s poll never resets it mid-pick.
  const rolesKey = rolesData.roles.map((r) => r.role).join(",");
  if (rolesKey !== specialistRolesKey) {
    specialistRolesKey = rolesKey;
    renderSpecialist();
  }
  const upgrades = rolesData.roles.flatMap((r) => r.chain.filter((c) => c.newest && (!c.pinned || c.state === "gone")));
  const addable = rolesData.addable || [];
  const btn = $("#roles-upgrade");
  btn.classList.toggle("hidden", !upgrades.length && !addable.length);
  btn.textContent = `⬆ Bring to newest versions (${[
    addable.length ? `${addable.length} new: ${addable.map((a) => a.id).join(", ")}` : "",
    upgrades.length ? `${upgrades.length} chain entr${upgrades.length === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean).join(" · ")})`;
  const rows = rolesData.roles.map((r) => `
    <tr>
      <td><strong>${esc(r.role)}</strong></td>
      <td class="nowrap">${r.pick ? `${esc(r.pick.label)} <span class="muted">${esc(r.pick.cli)}${r.pick.effort ? ` · ${esc(r.pick.effort)}` : ""}</span>` : "<em>exhausted</em>"}</td>
      <td class="chain-cell">${r.chain.map(chainChip).join(" ")}${r.skipped.length
        ? `<div class="skipped" title="${esc(r.skipped.map((x) => `${x.model}: ${x.reason}`).join("\n"))}">⚠ ${
          r.skipped.length} skipped right now</div>` : ""}</td>
      <td class="row-actions">
        <button type="button" class="role-edit" data-role="${esc(r.role)}" title="Edit chain">✎</button>
        ${r.protected
          ? `<span class="role-pin" title="Used by ${esc(r.protected)} — cannot be deleted">🔒</span>`
          : `<button type="button" class="role-delete" data-role="${esc(r.role)}" title="Delete role">🗑</button>`}
      </td>
    </tr>`).join("");
  $("#roles-table").innerHTML = `<table>
    <thead><tr><th>Role</th><th>Pick now</th><th>Chain</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No roles</td></tr>'}</tbody></table>`;
}

async function roleWrite(role, body, note) {
  const status = $("#roles-status");
  try {
    const res = await api(`/api/roles/${encodeURIComponent(role)}`, { method: "POST", body: JSON.stringify(body) });
    status.textContent = `${note} · backup ${res.backup}`;
    await refreshRoles();
    return true;
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
    return false;
  }
}

$("#roles-table").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-role]");
  if (!btn) return;
  const role = btn.dataset.role;
  const roleData = rolesData?.roles.find((x) => x.role === role);
  if (btn.classList.contains("role-edit")) openRoleEditor(roleData);
  else if (btn.classList.contains("role-delete")
    && confirm(`Delete role "${role}"?\n\nAnything that still runs \`team-up pick --role ${role}\` will fail.`)) {
    roleWrite(role, { delete: true }, `${role} deleted`);
  }
});

$("#roles-upgrade").addEventListener("click", async () => {
  const status = $("#roles-status");
  try {
    const res = await api("/api/roles-upgrade", { method: "POST", body: JSON.stringify({}) });
    const done = [...res.added.map((a) => `added ${a.id}`), ...(res.removed || []).map((r) => `removed ${r.id}`), ...res.changes.map((c) => `${c.role}: ${c.from} → ${c.to}`)];
    status.textContent = done.length ? `${done.join(", ")} · backup ${res.backup}` : "already on the newest versions";
    refreshSpecialists().catch(() => {});
    await refreshRoles();
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
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
    <select class="ce-cli">${(rolesData?.clis || []).map((c) =>
      `<option${c === cli ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
    <select class="ce-model"></select>
    <select class="ce-effort" title="Overrides the model's default effort for this role"></select>
    <label title="Stay on exactly this version; never move to a newer one"><input type="checkbox" class="ce-pinned"${entry.pinned ? " checked" : ""}> pin version</label>
    <button type="button" class="ce-up" title="Move up">↑</button>
    <button type="button" class="ce-down" title="Move down">↓</button>
    <button type="button" class="ce-remove" title="Remove">✕</button>`;
  const fill = () => {
    const c = row.querySelector(".ce-cli").value;
    const keep = row.querySelector(".ce-model").value || entry.model;
    row.querySelector(".ce-model").innerHTML = models.filter((m) => m.clis.includes(c)).map((m) =>
      `<option value="${esc(m.id)}"${m.id === keep ? " selected" : ""}>${esc(m.label)}</option>`).join("");
    fillEffort();
  };
  // Effort values are the model's own (codex says xhigh, claude says max), so
  // the list follows the model picked. A value no longer in the map stays
  // selectable rather than being dropped silently.
  const fillEffort = () => {
    const m = models.find((x) => x.id === row.querySelector(".ce-model").value);
    const sel = row.querySelector(".ce-effort");
    const keep = sel.dataset.touched ? sel.value : entry.effort || "";
    const values = [...new Set([...(m?.efforts || []), ...(keep ? [keep] : [])])];
    sel.innerHTML = `<option value="">default${m?.default_effort ? ` (${esc(m.default_effort)})` : ""}</option>`
      + values.map((v) => `<option${v === keep ? " selected" : ""}>${esc(v)}</option>`).join("");
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
  $("#role-editor-title").textContent = specialist ? `Own chain for ${specialist}` : role ? `Edit ${role.role}` : "New role";
  $("#role-editor-name").value = specialist || role?.role || "";
  $("#role-editor-name").readOnly = !!(role || specialist);
  $("#role-editor-status").textContent = "";
  const effort = $("#role-editor-effort");
  effort.innerHTML = [`<option value="">per model (default)</option>`,
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

$("#role-add").addEventListener("click", () => openRoleEditor(null));
$("#role-editor-add").addEventListener("click", () => $("#role-editor-chain").append(chainRow()));
$("#role-editor-cancel").addEventListener("click", () => {
  roleDialog.close();
  // The assign dropdown already shows "own chain…"; put it back.
  if (specialistChainTarget) renderSpecialist();
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
    $("#role-editor-status").textContent = `${role} already exists — edit it instead`;
    return;
  }
  const chain = [...$("#role-editor-chain").querySelectorAll(".chain-row")].map((row) => ({
    cli: row.querySelector(".ce-cli").value,
    model: row.querySelector(".ce-model").value,
    effort: row.querySelector(".ce-effort").value.trim() || null,
    pinned: row.querySelector(".ce-pinned").checked,
  }));
  if (specialistChainTarget) {
    if (await assignSpecialist(specialistChainTarget, { chain }, `${specialistChainTarget} runs on its own chain`)) roleDialog.close();
    else $("#role-editor-status").textContent = $("#capability-status").textContent;
    return;
  }
  let ok = await roleWrite(role, { chain }, `${role} saved`);
  const effort = $("#role-editor-effort");
  if (ok && effort.value !== effort.dataset.current) {
    ok = await roleWrite(role, { effort: effort.value || null }, `${role} saved`);
  }
  if (ok) roleDialog.close();
  else $("#role-editor-status").textContent = $("#roles-status").textContent;
});

// ── Models tab ──────────────────────────────────────────────────────────────
// Per provider, every model it offers; checked = in the roster, so the chain
// dropdowns offer it. It stays out of `refreshAll`: it redraws on tab switch
// and after a toggle, so open providers stay open.
const ROLES_TAB_KEY = "teamup.rolesTab";
const CATALOGUE_KIND_KEY = "teamup.catalogueKind";
const catalogueOpen = new Set();
let catalogueData = null;

function showRolesTab(tab) {
  for (const btn of $("#roles-tabs").querySelectorAll(".tim-tab")) btn.classList.toggle("is-active", btn.dataset.tab === tab);
  for (const body of $("#panel-roles").querySelectorAll("[data-tab-body]")) body.classList.toggle("hidden", body.dataset.tabBody !== tab);
  if (tab === "models") refreshCatalogue().catch((err) => { $("#catalogue-status").textContent = err.message; });
}

function renderCatalogue() {
  if (!catalogueData) return;
  const kind = readStored(CATALOGUE_KIND_KEY, "subscription");
  for (const btn of $("#catalogue-tabs").querySelectorAll(".tim-tab")) btn.classList.toggle("is-active", btn.dataset.kind === kind);
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
        m.efforts ? `<span class="muted" title="Picked per role or specialist, not here">effort: ${esc(m.efforts.join(" · "))}</span>` : ""}</td>
      <td class="muted">${esc(m.cli)}${m.unscanned ? " · not in any scan" : ""}</td>
    </tr>`).join("");
    return `<details class="catalogue-provider" data-provider="${esc(p.tab)}:${esc(p.id)}"${catalogueOpen.has(`${p.tab}:${p.id}`) || q ? " open" : ""}>
      <summary><strong>${esc(p.label)}</strong> <span class="muted">${inRoster} of ${p.models.length} in roster</span></summary>
      <table><thead><tr><th></th><th>Model</th><th>Name</th><th>CLI</th></tr></thead><tbody>${rows}</tbody></table>
    </details>`;
  }).join("");
  $("#catalogue-list").innerHTML = html || '<p class="muted">No models — run <code>team-up models scan</code>.</p>';
}

async function refreshCatalogue() {
  catalogueData = await api("/api/catalogue");
  renderCatalogue();
}

$("#roles-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tim-tab")?.dataset.tab;
  if (!tab) return;
  writeStored(ROLES_TAB_KEY, tab);
  showRolesTab(tab);
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
  $("#model-replace-msg").textContent = `${cliId} (${cli}) is in the chain of ${roles.join(", ")}. Pick a replacement, or remove it from those chains.`;
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
    status.textContent = `${body.cli_id} ${body.on ? "added to" : "removed from"} the roster · backup ${r.data.backup}`;
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
  } finally {
    await Promise.allSettled([refreshCatalogue(), refreshRoles(), refreshSpecialists()]);
  }
});

function providerStatus(p) {
  if (p.class === "A") {
    if (!p.configured) return '<span class="badge stale">not connected</span>';
    const bits = [esc(p.hint || ""), p.label ? esc(p.label) : "", p.last_verdict === "ok" ? "valid" : ""].filter(Boolean);
    const src = p.source_file ? ` · ${esc(p.source_file)}` : p.source ? ` · ${esc(p.source)}` : "";
    return `<span class="badge ok">connected · ${bits.join(" · ")}${src}</span>`;
  }
  if (p.class === "B") {
    return `<span class="badge ${p.configured ? "ok" : "stale"}">subscription login</span>`;
  }
  return `<span class="badge ${p.configured ? "ok" : "stale"}">CLI-owned key</span>`;
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
        <input type="password" name="key" placeholder="OpenRouter API key" autocomplete="off">
        <button type="submit">${p.configured ? "Rotate" : "Connect"}</button>
        ${p.configured ? '<button type="button" class="remove-key">Remove</button>' : ""}
        <button type="button" class="validate-key">Validate</button>
      </form>`;
    } else if (p.class === "A" && p.configured) {
      body += ` <span class="muted">read-only (${esc(p.source || "external")})</span>`;
    } else if (p.login_command) {
      body += ` <span class="muted mono">${esc(p.login_command)}</span>`;
    }
    return `${body}</div>`;
  }).join("");
  $("#providers-list").innerHTML = html || "<p>No providers</p>";
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
        alert(err.message);
      }
    });
    form.querySelector(".validate-key")?.addEventListener("click", async () => {
      try {
        await api("/api/providers/openrouter/validate", { method: "POST", body: JSON.stringify({}) });
        await refreshProviders();
      } catch (err) {
        alert(err.message);
      }
    });
    form.querySelector(".remove-key")?.addEventListener("click", async () => {
      try {
        await api("/api/providers/openrouter/remove", { method: "POST", body: JSON.stringify({}) });
        await refreshProviders();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

let selectedCli = null;
let cliLogTimer = null;

function verdictBadge(v) {
  if (!v) return "—";
  if (v.verdict === "verified") return '<span class="badge ok">verified</span>';
  if (v.verdict === "harness_verification_unsupported") {
    return `<span class="badge stale">unsupported${v.reason ? ` · ${esc(v.reason)}` : ""}</span>`;
  }
  return `<span class="badge red">failed${v.reason ? ` · ${esc(v.reason)}` : ""}</span>`;
}

async function refreshCliLog(cli) {
  if (!cli) return;
  try {
    const data = await api(`/api/clis/${encodeURIComponent(cli)}/install/log`);
    const lines = (data.lines || []).join("\n");
    const verdict = data.post_update_verdict ? `verdict: ${data.post_update_verdict.verdict}` : "";
    const el = $("#cli-log");
    el.textContent = [lines, verdict].filter(Boolean).join("\n\n") || "(no log yet)";
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
      actions.push(`<button type="button" class="cli-update" data-cli="${esc(c.cli)}">Update</button>`);
    }
    if (c.present) {
      if (c.uninstall_command) {
        actions.push(`<button type="button" class="cli-uninstall" data-cli="${esc(c.cli)}">Uninstall</button>`);
      }
    } else if (c.install_available) {
      actions.push(`<button type="button" class="cli-install" data-cli="${esc(c.cli)}">Install</button>`);
    } else if (c.install_disabled_reason) {
      actions.push(`<span class="muted">${esc(c.install_disabled_reason)}</span>`);
    }
    if (c.login_available && c.present) {
      actions.push(`<button type="button" class="cli-login" data-cli="${esc(c.cli)}">Start login</button>`);
    }
    // A CLI the roster doesn't run is a row the user switches on in ✎.
    return `
    <tr class="clickable ${selectedCli === c.cli ? "selected" : ""}" data-cli="${esc(c.cli)}" data-row="clis:${esc(c.cli)}"${
      c.in_roster ? "" : ' data-row-default="hidden"'}${providerAttr(c.cli)}>
      <td title="${esc(c.path || "not on PATH")}">${esc(c.cli)}</td>
      <td>${c.present ? '<span class="badge ok">installed</span>' : '<span class="badge stale">missing</span>'}</td>
      <td class="mono">${esc(c.version || "—")}</td>
      <td>${esc(c.harness_label || c.harness?.status || "—")}</td>
      <td>${verdictBadge(c.post_update_verdict)}</td>
      <td>${esc(state)}</td>
      <td>${actions.join(" ")}</td>
    </tr>`;
  }).join("");
  $("#clis-table").innerHTML = `<table>
    <thead><tr><th>CLI</th><th>Present</th><th>Version</th><th>Harness</th><th>Verify</th><th>Job</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">No CLIs</td></tr>'}</tbody></table>`;
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
        if (cmd && !confirm(`Run update + verify?\n\n${cmd}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/update`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  $("#clis-table").querySelectorAll(".cli-install").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cli = btn.dataset.cli;
      try {
        const row = data.clis.find((c) => c.cli === cli);
        if (row?.install_command && !confirm(`Run install?\n\n${row.install_command}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/install`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  $("#clis-table").querySelectorAll(".cli-uninstall").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cli = btn.dataset.cli;
      try {
        const row = data.clis.find((c) => c.cli === cli);
        if (!confirm(`Uninstall ${cli}?\n\n${row?.uninstall_command}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/uninstall`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  $("#clis-table").querySelectorAll(".cli-login").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cli = btn.dataset.cli;
      try {
        const row = data.clis.find((c) => c.cli === cli);
        if (row?.login_command && !confirm(`Start login in tmux?\n\n${row.login_command}\n\nFinish in terminal: tmux attach -t team-up-install-${cli}`)) return;
        await api(`/api/clis/${encodeURIComponent(cli)}/login`, { method: "POST", body: JSON.stringify({}) });
        selectCli(cli);
        await refreshClis();
      } catch (err) {
        alert(err.message);
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
    $("#admin-status").textContent = "Enter the code printed in your terminal.";
  } catch (err) {
    $("#admin-status").textContent = err.message;
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
    $("#admin-status").textContent = "Admin confirmed for 10 minutes.";
  } catch (err) {
    $("#admin-status").textContent = err.message;
  }
});

// ── Specialists ───────────────────────────────────────────────────────────
// One specialist at a time: the dropdown picks, the body shows what that one
// actually holds. Fetched once per load and on demand — nothing here changes
// between polls, so it stays off the 5s cycle.
let specialistsData = null;

function chips(items) {
  if (!items?.length) return '<span class="muted">none</span>';
  return items.map((item) => `<span class="chip">${esc(item)}</span>`).join(" ");
}

let capabilityPool = null;


// What the specialist is for stays visible; limits and permissions fold away.
function renderSpecialist() {
  const body = $("#specialist-detail");
  const id = $("#specialist-select").value;
  const s = (specialistsData?.specialists || []).find((item) => item.id === id);
  if (!s) {
    $("#specialist-meta").textContent = "";
    body.innerHTML = '<p class="muted">No specialist installed.</p>';
    return;
  }
  const perms = s.permissions || {};
  const budget = s.budget || {};
  // Which chain it runs on: a role's, or its own. Unassigned does not launch.
  const a = s.assignment;
  const current = a?.role ? `role:${a.role}` : a?.chain ? "chain" : "";
  const roles = [...new Set([...(rolesData?.roles || []).map((r) => r.role), ...(a?.role ? [a.role] : [])])];
  const assign = `<select class="specialist-assign" title="The chain this specialist runs on">
    <option value=""${current ? "" : " selected"}>— unassigned, won't launch —</option>
    ${roles.map((r) => `<option value="role:${esc(r)}"${current === `role:${r}` ? " selected" : ""}>role: ${esc(r)}</option>`).join("")}
    <option value="chain"${current === "chain" ? " selected" : ""}>own chain…</option></select>${a?.chain
    ? ` <span class="muted">${a.chain.map((e) => esc(typeof e === "string" ? e : `${e.cli ? `${e.cli}:` : ""}${e.model}`)).join(" → ")}</span>
       <button type="button" class="specialist-chain-edit" title="Edit its chain">✎</button>` : ""}`;
  $("#specialist-meta").innerHTML = [`v${esc(s.version)}`, assign].join(" · ");
  const bundled = [...(s.bundled?.skills || []), ...(s.bundled?.mcps || []).map((m) => `mcp:${m}`)];
  body.innerHTML = `
    ${s.error ? `<p class="error">${esc(s.error)}</p>` : ""}
    <ul class="remit">${(s.remit || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <p class="caps">${chips(bundled)} ${(s.assigned || []).map((a) =>
      `<span class="chip assigned" title="${esc(`${a.package} · ${a.reason}`)}">${esc(a.display_name)}
        <button type="button" class="capability-remove" title="Remove"
          data-package="${esc(a.package)}" data-checksum="${esc(a.checksum_full)}">✕</button></span>`).join(" ")}</p>
    <details>
      <summary>Details</summary>
      ${(s.versions || []).length > 1
        ? `<p class="muted">Installed versions: ${s.versions.map((v) =>
            `${esc(v.version)}${v.selected ? " ✓" : ""}`).join(", ")}</p>`
        : ""}
      <dl class="kv">
        <dt>Never</dt><dd>${(s.anti_remit || []).map(esc).join("; ") || "—"}</dd>
        <dt>Tools</dt><dd>${chips(s.bundled?.tools)}</dd>
        <dt>Filesystem</dt><dd>${esc(perms.filesystem || "—")}, writes ${perms.writes ? "yes" : "no"}, network ${perms.network ? "yes" : "no"}</dd>
        <dt>Commands</dt><dd>${chips(perms.commands)}</dd>
        <dt>Call types</dt><dd>${chips(s.call_types)}</dd>
        <dt>Timeout</dt><dd>${budget.timeout_seconds ? esc(`${budget.timeout_seconds}s`) : "—"}</dd>
        <dt>Checksum</dt><dd class="mono">${esc(s.checksum)}</dd>
        ${s.exclusions?.length ? `<dt>Excluded</dt><dd>${s.exclusions.map((e) => esc(`${e.package} (${e.reason})`)).join(", ")}</dd>` : ""}
      </dl>
    </details>`;
}

// Only offer what the specialist does not already hold; assigning a package
// twice is a no-op the user would have to reason about.
function renderCapabilityChoices() {
  const select = $("#capability-select");
  const id = $("#specialist-select").value;
  const held = new Set(
    ((specialistsData?.specialists || []).find((s) => s.id === id)?.assigned || [])
      .map((a) => `${a.package}:${a.checksum_full}`),
  );
  const options = (capabilityPool?.packages || [])
    .filter((p) => !held.has(`${p.package}:${p.checksum}`))
    .map((p) => `<option value="${esc(p.package)}" data-checksum="${esc(p.checksum)}">
      ${esc(p.display_name)} — ${esc(p.package)}</option>`)
    .join("");
  select.innerHTML = options || '<option value="">nothing left to assign</option>';
}

async function assignCapability(pkg, checksum, action) {
  const id = $("#specialist-select").value;
  const status = $("#capability-status");
  status.textContent = action === "disable" ? "Removing…" : "Assigning…";
  try {
    await api(`/api/specialists/${encodeURIComponent(id)}/capabilities`, {
      method: "POST",
      body: JSON.stringify({ package: pkg, checksum, action }),
    });
    await refreshSpecialists();
    status.textContent = `${pkg} ${action === "disable" ? "removed from" : "assigned to"} ${id}`;
  } catch (err) {
    status.textContent = err.message;
  }
}

async function refreshSpecialists() {
  const select = $("#specialist-select");
  const keep = select.value;
  const [specialists, pool] = await Promise.all([
    api("/api/specialists"),
    api("/api/capability-pool"),
  ]);
  specialistsData = specialists;
  capabilityPool = pool;
  const list = specialistsData.specialists || [];
  select.innerHTML = list
    .map((s) => `<option value="${esc(s.id)}">${esc(s.display_name || s.id)}</option>`)
    .join("");
  if (list.some((s) => s.id === keep)) select.value = keep;
  renderSpecialist();
  renderCapabilityChoices();
}

$("#specialist-select").addEventListener("change", () => {
  renderSpecialist();
  renderCapabilityChoices();
});

$("#capability-assign").addEventListener("click", () => {
  const option = $("#capability-select").selectedOptions[0];
  if (!option?.value) return;
  assignCapability(option.value, option.dataset.checksum, "enable");
});

// Delegated, because renderSpecialist replaces the body on every change.
$("#specialist-detail").addEventListener("click", async (event) => {
  const remove = event.target.closest(".capability-remove");
  if (remove) {
    assignCapability(remove.dataset.package, remove.dataset.checksum, "disable");
    return;
  }
});

async function assignSpecialist(id, body, note) {
  const status = $("#capability-status");
  try {
    await api(`/api/specialists/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify(body) });
    status.textContent = note;
    await refreshSpecialists();
    return true;
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
    await refreshSpecialists();
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

$("#specialist-meta").addEventListener("change", async (event) => {
  const sel = event.target.closest(".specialist-assign");
  if (!sel) return;
  const id = $("#specialist-select").value;
  const s = (specialistsData?.specialists || []).find((item) => item.id === id);
  if (sel.value === "chain") openSpecialistChain(s);
  else if (sel.value) await assignSpecialist(id, { role: sel.value.slice(5) }, `${id} runs on ${sel.value.slice(5)}`);
  else await assignSpecialist(id, {}, `${id} unassigned — it will not launch`);
});

$("#specialist-meta").addEventListener("click", (event) => {
  if (!event.target.closest(".specialist-chain-edit")) return;
  const id = $("#specialist-select").value;
  openSpecialistChain((specialistsData?.specialists || []).find((item) => item.id === id));
});

$("#specialist-install").addEventListener("click", async () => {
  const status = $("#specialist-install-status");
  const repo = $("#specialist-repo").value.trim();
  if (!repo) return;
  status.textContent = `Cloning ${repo}…`;
  try {
    const result = await api("/api/specialists/install", {
      method: "POST",
      body: JSON.stringify({ repo, subdir: $("#specialist-subdir").value.trim() }),
    });
    status.textContent = `Installed ${result.id}@${result.version} from ${result.source}`;
    $("#specialist-repo").value = "";
    $("#specialist-subdir").value = "";
    await refreshSpecialists();
  } catch (err) {
    status.textContent = err.message;
  }
});

// ── Synced preferences ────────────────────────────────────────────────────
// Every `teamup.*` key also lives on the server. localStorage stays the working
// copy and the server copy replaces it once the login is known. The last device
// to change something wins.
const PREF_PREFIX = "teamup.";
const LEGACY_LAYOUT_KEY = "teamup.layout";

function localPrefs() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(PREF_PREFIX) && key !== LEGACY_LAYOUT_KEY) out[key] = localStorage.getItem(key);
    }
    localStorage.removeItem(LEGACY_LAYOUT_KEY);
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
  const hadLegacyLayout = Object.hasOwn(remote, LEGACY_LAYOUT_KEY);
  delete remote[LEGACY_LAYOUT_KEY];
  const local = localPrefs();
  if (!Object.keys(remote).length) {
    // First device after the switch to server prefs: seed it from here.
    if (Object.keys(local).length || hadLegacyLayout) pushPrefs();
    return;
  }
  if (sameKeys(remote, local)) {
    if (hadLegacyLayout) pushPrefs();
    return;
  }
  try {
    for (const key of Object.keys(local)) if (!(key in remote)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(remote)) localStorage.setItem(key, value);
  } catch {
    return; // storage blocked: keep what is on screen
  }
  if (hadLegacyLayout) {
    await api("/api/prefs", { method: "POST", body: JSON.stringify(localPrefs()) }).catch(() => {});
  }
  location.reload();
}

// ── Projects ──────────────────────────────────────────────────────────────
// The collecting folder is a per-browser preference, like the layout: the
// server takes it as a parameter and never stores it.
const PROJECTS_DIR_KEY = "teamup.projectsDir";

function readProjectsDir() {
  try {
    return localStorage.getItem(PROJECTS_DIR_KEY) || "";
  } catch {
    return "";
  }
}

async function refreshProjects() {
  const dir = readProjectsDir();
  const status = $("#projects-status");
  let data;
  try {
    data = await api(`/api/projects?dir=${encodeURIComponent(dir)}`);
  } catch (err) {
    status.textContent = err.message;
    $("#projects-table").innerHTML = "";
    return;
  }
  // A write note stays until the next write: the dirty star alone does not
  // say that the change came from this panel.
  status.textContent = projectsNote ? `${data.dir} — ${projectsNote}` : data.dir;
  if (!$("#projects-dir").value) $("#projects-dir").value = dir || data.dir;

  const cliSel = $("#projects-cli");
  const selected = cliSel.value;
  const options = (data.clis || []).map((c) => `<option>${esc(c)}</option>`).join("");
  if (cliSel.innerHTML !== options) cliSel.innerHTML = options;
  if (selected && (data.clis || []).includes(selected)) cliSel.value = selected;

  projectsByPath = new Map(data.projects.map((p) => [p.path, p]));
  const rows = data.projects.map((p) => `
    <tr>
      <td>${esc(p.name)}${p.dirty ? " <span class=\"muted\">*</span>" : ""}</td>
      <td>${esc(p.git ? (p.branch || "detached") : "—")}</td>
      <td>${policyCell(p)}</td>
      <td>${p.sessions.map((s) => `<a href="#" class="session-link" data-session="${esc(s)}">${esc(s.replace(/^team-up-proj-/, ""))}</a>`).join(" ") || "—"}</td>
      <td><button type="button" class="project-start" data-dir="${esc(p.path)}">Start</button></td>
    </tr>`).join("");
  $("#projects-table").innerHTML = `<table>
    <thead><tr><th>Project</th><th>Branch</th><th>Policy</th><th>Sessions</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No projects</td></tr>'}</tbody></table>`;

  $("#projects-table").querySelectorAll(".policy-create").forEach((btn) => {
    btn.addEventListener("click", () => openPolicyEditor(projectsByPath.get(btn.dataset.dir)));
  });
  $("#projects-table").querySelectorAll(".session-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      selectSession(a.dataset.session);
    });
  });
  $("#projects-table").querySelectorAll(".project-start").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await api("/api/projects/session", {
          method: "POST",
          body: JSON.stringify({
            dir: btn.dataset.dir,
            cli: $("#projects-cli").value,
            projects_dir: readProjectsDir(),
          }),
        });
        await refreshProjects();
        selectSession(res.session);
      } catch (err) {
        status.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  });
  autoFixProjects().catch(() => {});
}

// ── command policy trust ──
let projectsByPath = new Map();
let projectsNote = "";
const PROJECTS_AUTO_KEY = "teamup.projectsAutoFix";
// Auto-fix tries each project once per page load so failures do not repeat on every poll.
const autoFixTried = new Set();

function policyCell(p) {
  const pol = p.policy || { state: "none" };
  const create = `<button type="button" class="policy-create" data-dir="${esc(p.path)}">Create…</button>`;
  const trust = pol.trusted === true
    ? '<span class="badge ok">trusted</span>'
    : pol.trusted === false
      ? '<span class="badge amber">untrusted</span>'
      : "";
  if (pol.state === "valid") return `<span class="badge ok">valid</span> ${trust}`;
  if (pol.state === "inherited") return `<span class="badge ok">inherited policy</span> ${trust}`;
  if (pol.state === "invalid") {
    return `<span class="badge red" title="${esc((pol.errors || []).join("\n"))}">invalid</span>`;
  }
  if (pol.state === "missing") {
    const hint = pol.proposal?.auto ? "unambiguous" : "check the proposal";
    return `<span class="badge amber" title="${esc(hint)}">missing</span> ${create}`;
  }
  return `<span class="muted" title="no test command detected">no tests</span> ${create}`;
}

async function trustProject(p) {
  const res = await api("/api/projects/trust-policy", {
    method: "POST",
    body: JSON.stringify({ dir: p.path, projects_dir: readProjectsDir() }),
  });
  return res;
}

/**
 * What "Fix all" and auto-fix do to one project: only what needs no judgement.
 * Trusting a policy is a judgement: a delegate specialist can edit
 * commands.json, and the broker runs it outside the capsule. So "Fix all"
 * trusts only a policy it wrote in the same click, auto-fix trusts nothing,
 * and a changed policy is trusted per project with `specialist trust-policy`.
 */
async function fixProject(p, { trust }) {
  let wrote = false;
  let trusted = false;
  if (p.policy?.state === "missing" && p.policy.proposal?.auto) {
    await api("/api/projects/policy", {
      method: "POST",
      body: JSON.stringify({ dir: p.path, projects_dir: readProjectsDir() }),
    });
    wrote = true;
  }
  if (trust && wrote) {
    await trustProject(p);
    trusted = true;
  }
  return { wrote, trusted };
}

const needsWrite = (p) => p.policy?.state === "missing" && p.policy.proposal?.auto;
const needsFix = (p) =>
  needsWrite(p)
  || ((p.policy?.state === "valid" || p.policy?.state === "inherited") && p.policy.trusted === false);

async function fixProjects(projects, { trust }) {
  const written = [];
  const trusted = [];
  for (const p of projects) {
    try {
      const result = await fixProject(p, { trust });
      if (result.wrote) written.push(p.name);
      if (result.trusted) trusted.push(p.name);
    } catch (err) {
      projectsNote = `${p.name}: ${err.message}`;
    }
  }
  const changed = projects.filter((p) => (p.policy?.state === "valid" || p.policy?.state === "inherited") && p.policy.trusted === false);
  if (written.length) {
    projectsNote = `wrote .team-up/commands.json (uncommitted) in: ${written.join(", ")}`;
  } else if (trusted.length) {
    projectsNote = `trusted command policy in: ${trusted.join(", ")}`;
  }
  if (changed.length) {
    projectsNote = `${projectsNote ? `${projectsNote}. ` : ""}untrusted policy (review it, then run team-up specialist trust-policy --project <path>): ${changed.map((p) => p.path).join(", ")}`;
  }
  return { written, trusted };
}

let autoFixRunning = false;
async function autoFixProjects() {
  if (autoFixRunning || !$("#projects-auto").checked) return;
  const todo = [...projectsByPath.values()].filter((p) => needsWrite(p) && !autoFixTried.has(p.path));
  if (!todo.length) return;
  autoFixRunning = true;
  todo.forEach((p) => autoFixTried.add(p.path));
  try {
    await fixProjects(todo, { trust: false });
  } finally {
    autoFixRunning = false;
  }
  await refreshProjects();
}

$("#projects-fix-all").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    await fixProjects([...projectsByPath.values()].filter(needsFix), { trust: true });
    await refreshProjects();
  } finally {
    e.target.disabled = false;
  }
});

try {
  $("#projects-auto").checked = localStorage.getItem(PROJECTS_AUTO_KEY) === "1";
} catch {
  // storage blocked: auto-fix just starts off
}
$("#projects-auto").addEventListener("change", () => {
  try {
    localStorage.setItem(PROJECTS_AUTO_KEY, $("#projects-auto").checked ? "1" : "0");
    pushPrefs();
  } catch {
    // Private mode: the toggle stops surviving reloads.
  }
  autoFixProjects().catch(() => {});
});

// The editor is a <dialog> outside the table: the table is rebuilt on every
// poll and would throw away half-typed JSON.
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
    ? (p.policy.proposal.auto ? "Detected unambiguously." : "Proposal only — check the command before creating.")
    : "No test command detected — fill in the one this project uses.";
  policyDialog.showModal();
}

$("#policy-editor-cancel").addEventListener("click", () => policyDialog.close());
$("#policy-editor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#policy-editor-status");
  let policy;
  try {
    policy = JSON.parse($("#policy-editor-json").value);
  } catch (err) {
    status.textContent = `not JSON: ${err.message}`;
    return;
  }
  try {
    await api("/api/projects/policy", {
      method: "POST",
      body: JSON.stringify({ dir: policyTarget.path, projects_dir: readProjectsDir(), policy }),
    });
    policyDialog.close();
    projectsNote = `wrote .team-up/commands.json (uncommitted) in ${policyTarget.name}`;
    await refreshProjects();
  } catch (err) {
    status.textContent = err.message;
  }
});

$("#projects-dir").addEventListener("change", () => {
  try {
    localStorage.setItem(PROJECTS_DIR_KEY, $("#projects-dir").value.trim());
    pushPrefs();
  } catch {
    // Private mode: the folder just stops surviving reloads.
  }
  refreshProjects().catch(() => {});
  refreshTim().catch(() => {});
});

// ── TIM ───────────────────────────────────────────────────────────────────
// Only there when `tim open-work` answers: no TIM, no panel. Tasks, ideas and
// bugs of every project in three tabs, each project its own <details> so a
// backlog of ten projects is still one screen. The collecting folder is the
// Projects panel's — the same repos, read through the .tim-project markers.
const TIM_KIND_KEY = "teamup.timKind";
const TIM_CLOSED_KEY = "teamup.timClosed";
const TIM_KINDS = { task: "Tasks", idea: "Ideas", bug: "Bugs" };

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
    pushPrefs();
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
    status.textContent = err.message;
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
  }
  const closed = new Set(readStored(TIM_CLOSED_KEY, []));

  const groups = data.projects
    .map((p) => ({ ...p, items: p.items.filter((i) => i.kind === kind) }))
    .filter((p) => p.items.length > 0);
  const total = groups.reduce((n, p) => n + p.items.length, 0);
  status.textContent = `${total} open ${TIM_KINDS[kind].toLowerCase()} in ${groups.length} project${groups.length === 1 ? "" : "s"}`;

  $("#tim-list").innerHTML = groups.map((p) => `
    <details class="tim-project" data-project="${esc(p.label)}"${closed.has(p.label) ? "" : " open"}>
      <summary>${esc(p.title.split(" | ")[0])} <span class="muted">${p.items.length}</span></summary>
      <ul class="tim-items">${p.items.map((item) => `
        <li>
          <span class="muted">${esc(item.status)}${item.priority ? ` <span class="tag ${priorityTone(item.priority)}">${esc(item.priority)}</span>` : ""}</span>
          ${esc(item.title)}
          ${item.sessions.length
            ? item.sessions.map((sess) => `<a href="#" class="session-link" data-session="${esc(sess)}">running</a>`).join(" ")
            : p.dir
              ? `<button type="button" class="tim-start" data-id="${esc(item.id)}">Start</button>`
              : '<span class="muted">no repo</span>'}
        </li>`).join("")}</ul>
    </details>`).join("") || `<p class="muted">Nothing open.</p>`;

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
    { value: "", label: "— CLI default —" },
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
    `${spec.display_name || spec.id}: ${(spec.remit || []).join("; ")}.`
    + " Interactive session — no sandbox, approval or RESULT.json.";
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
    { value: "", label: "— none —" },
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
  status.textContent = "starting…";
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
    status.textContent = err.message;
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
    label: "Lift the post-restart cap",
    title: "After a memory-caused restart team-up caps workers for 24 h; this lifts it now",
    endpoint: "/api/actions/admission-reset",
    done: (r) => (r.lifted ? "Cap lifted." : "There was no cap to lift."),
  }],
};

const pct = (v) => `${Math.round(v * 1000) / 10} %`;

function formatSetting(f, v) {
  if (v === undefined) return "—";
  if (v === null) return f.nullLabel || "not set";
  if (f.type === "bool") return v ? "on" : "off";
  if (f.type === "ratio") return pct(v);
  if (f.type === "set") {
    if (!v.length) return "none";
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
      return `${label}<select ${attrs} aria-label="${esc(f.label)}">${f.nullable ? `<option value="__null__"${cur == null ? " selected" : ""}>${esc(f.nullLabel || "not set")}</option>` : ""}${
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
  const def = f.default === undefined ? "" : `default ${formatSetting(f, f.default)}`;
  return `<span class="set-meta">${changed ? `<span class="tag changed">changed</span> ` : ""}${esc(def)}${
    changed && !f.required ? ` · <button type="button" class="link" data-reset="${esc(f.path)}">reset</button>` : ""}</span>`;
}

function settingRow(fields) {
  const [first] = fields;
  const title = first.row
    ? `${esc(first.row)}`
    : `${esc(first.label)}`;
  const help = [...new Set(fields.map((f) => f.help).filter(Boolean))].join(" ");
  const effect = first.effect ? `<span class="effect">Takes effect: ${esc(first.effect)}</span>` : "";
  return `<div class="set-row" data-paths="${esc(fields.map((f) => f.path).join(" "))}">
    <div class="set-label">${title}${first.row ? "" : `<span class="row-name mono">${esc(first.path)}</span>`}</div>
    <div class="set-control">${fields.map((f) => `<span class="set-field">${settingControl(f)}</span>${fields.length === 1 ? settingMeta(f) : ""}`).join("")}</div>
    <p class="set-help">${esc(help)}${fields.length > 1 ? ` ${fields.map(settingMeta).filter((m) => m.includes("changed")).length ? "" : ""}` : ""}${effect}</p>
  </div>`;
}

function renderSettings() {
  if (!settingsData) return;
  const advanced = $("#settings-advanced").checked;
  const q = $("#settings-search").value.trim().toLowerCase();
  const hit = (f) => !q || [f.label, f.help, f.path, f.row, f.group].some((t) => String(t || "").toLowerCase().includes(q));
  const html = settingsData.groups.map((g) => {
    if (g.advanced && !advanced && !q) return "";
    const fields = settingsData.fields.filter((f) => f.group === g.id && (advanced || q || !f.advanced) && (hit(f) || g.title.toLowerCase().includes(q)));
    if (!fields.length) return "";
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
      ${rows.map(settingRow).join("")}
      ${actions ? `<div class="toolbar" style="margin-top:.6rem">${actions}</div>` : ""}
      ${!advanced && !q && hidden ? `<p class="muted">${hidden} advanced setting${hidden === 1 ? "" : "s"} hidden — tick “Show advanced”.</p>` : ""}
    </section>`;
  }).join("");
  $("#settings-body").innerHTML = html || `<p class="empty">No setting matches “${esc(q)}”.</p>`;
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
    const f = settingsData.fields.find((x) => x.path === body.path);
    settingsNote(`${f?.row ? `${f.row} · ` : ""}${f?.label || body.path}: ${body.reset ? "back to default" : "saved"}${res.backup ? ` · backup ${res.backup}` : ""}`, "ok");
    refreshRoles().catch(() => {});
  } catch (err) {
    settingsNote(`Not saved — ${err.message}`, "err");
  }
  await refreshSettings();
  const row = [...$("#settings-body").querySelectorAll(".set-row")].find((r) => r.dataset.paths.split(" ").includes(rowPaths));
  row?.classList.add("saved");
}

$("#settings-body").addEventListener("change", (e) => {
  const el = e.target;
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
    settingsNote(`Refused — ${err.message}`, "err");
  }
  act.disabled = false;
});

$("#settings-search").addEventListener("input", renderSettings);
$("#settings-advanced").checked = readStored(SETTINGS_ADVANCED_KEY, false) === true;
$("#settings-advanced").addEventListener("change", () => {
  writeStored(SETTINGS_ADVANCED_KEY, $("#settings-advanced").checked);
  renderSettings();
});
onEnter.settings = () => refreshSettings().catch((err) => settingsNote(err.message, "err"));

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
  const day = d.toDateString() === now.toDateString() ? "today"
    : d.toDateString() === new Date(now.getTime() + 86_400_000).toDateString() ? "tomorrow"
      : d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString() ? "yesterday"
        : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function lastRunTag(run) {
  if (!run) return '<span class="tag off">never ran</span>';
  if (run.running) return `<span class="tag warn">running since ${esc(fmtWhen(run.at))}</span>`;
  return `<span class="tag ${run.exit === 0 ? "ok" : "err"}">${run.exit === 0 ? "ok" : `exit ${run.exit}`}</span> ${esc(fmtWhen(run.at))}`;
}

function customJobCard(j) {
  const sync = j.inSync === false ? '<span class="tag warn" title="The crontab does not match this job; save it again">not in crontab</span>' : "";
  return `<article class="job${j.enabled ? "" : " is-off"}" data-job="${esc(j.name)}">
    <div class="job-head">
      <h3>${esc(j.name)}</h3>${sync}
      <span class="spacer"></span>
      <label class="switch" title="On: cron starts it on schedule"><input type="checkbox" data-job-toggle${j.enabled ? " checked" : ""} aria-label="Enabled"></label>
      <button type="button" data-job-run title="Start it now; output goes to the log">Run now</button>
      <button type="button" data-job-edit>Edit</button>
      <button type="button" data-job-log>Log</button>
      <button type="button" data-job-delete class="danger">Delete</button>
    </div>
    ${j.description ? `<p>${esc(j.description)}</p>` : ""}
    <div class="job-when">
      <span><b>When</b> ${esc(j.when?.text || j.schedule)}</span>
      <span><b>Next</b> ${j.enabled ? esc(fmtWhen(j.when?.next)) : "off"}</span>
      <span><b>Last</b> ${lastRunTag(j.lastRun)}</span>
      <span><b>Model</b> ${esc(j.model || "—")}</span>
      <span><b>Folder</b> <code>${esc((j.cwd || "").replace(/^\/home\/[^/]+/, "~"))}</code></span>
      ${j.notify ? "<span>→ Telegram</span>" : ""}
    </div>
  </article>`;
}

function builtinJobCard(j) {
  const state = !j.installed ? '<span class="tag off">not installed</span>'
    : j.enabled ? '<span class="tag ok">on</span>' : '<span class="tag off">off</span>';
  const toggle = j.editable
    ? `<label class="switch"><input type="checkbox" data-builtin-toggle${j.enabled ? " checked" : ""} aria-label="Enabled"></label>`
    : "";
  const modelRow = j.model ? `<label for="bm-${j.id}">${esc(j.model.label)}</label>
    <select id="bm-${j.id}" data-builtin-model="${esc(j.model.job)}">${
      (j.model.value && !automationData.options.models.includes(j.model.value) ? [j.model.value] : []).concat(automationData.options.models)
        .map((m) => `<option value="${esc(m)}"${m === j.model.value ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>` : "";
  const knobs = (j.knobs || []).map((k) => k.type === "flag"
    ? `<span></span><label class="inline"><input type="checkbox" data-knob="${esc(k.key)}"${k.value ? " checked" : ""}${j.editable ? "" : " disabled"}> ${esc(k.label)}</label>`
    : `<label for="kn-${j.id}-${k.key}">${esc(k.label)}</label><span><input type="number" id="kn-${j.id}-${k.key}" data-knob="${esc(k.key)}" min="${k.min}" max="${k.max}" step="1"
        value="${k.value ?? ""}" placeholder="${k.default}"${j.editable ? "" : " disabled"}> ${esc(k.unit || "")} <span class="muted">(default ${k.default})</span></span>`).join("");
  const schedule = j.editable
    ? `<label for="bs-${j.id}">Schedule (cron)</label><span class="form-row"><input type="text" id="bs-${j.id}" class="mono" data-builtin-schedule value="${esc(j.schedule || "")}">
        <button type="button" data-builtin-schedule-save>Save</button></span>`
    : "";
  return `<article class="job${j.installed && j.enabled ? "" : " is-off"}" data-builtin="${esc(j.id)}">
    <div class="job-head">
      <h3>${esc(j.title)}</h3>${state}<span class="tag">${j.llm ? "uses an LLM" : "no LLM"}</span>
      <span class="spacer"></span>${toggle}
    </div>
    <div class="job-when">
      <span><b>When</b> ${esc(j.when?.text || "—")}</span>
      <span><b>Next</b> ${j.installed && j.enabled ? esc(fmtWhen(j.when?.next)) : "—"}</span>
      <span><b>Last activity</b> ${esc(fmtWhen(j.lastRun))}</span>
    </div>
    <p>${esc(j.what)}</p>
    <p class="cost">Cost: ${esc(j.cost)}</p>
    <details><summary>Details &amp; settings</summary>
      <div class="knobs">
        ${modelRow}${knobs}${schedule}
        <span class="muted">Scheduled in</span><span>${esc(j.where)}</span>
        ${j.output ? `<span class="muted">Output</span><code>${esc(j.output)}</code>` : ""}
        ${j.off ? `<span class="muted">To stop it</span><span>${esc(j.off)}</span>` : ""}
        ${j.settings ? `<span></span><a href="#/settings" data-settings-group="${esc(j.settings)}">Open its settings →</a>` : ""}
      </div>
    </details>
  </article>`;
}

function renderAutomation() {
  const d = automationData;
  if (!d) return;
  if (!d.crontab.readable) automationNote(`Cannot read your crontab: ${d.crontab.error}`, "err");
  $("#custom-jobs").innerHTML = d.custom.length
    ? `<div class="job-list">${d.custom.map(customJobCard).join("")}</div>`
    : `<div class="empty">No jobs of your own yet. A job is a prompt that a worker runs in one of your repos on a schedule —
        say a weekly dependency check, or a nightly “read the logs and file what looks wrong”.</div>`;
  $("#builtin-jobs").innerHTML = d.builtin.map(builtinJobCard).join("");
  $("#services").innerHTML = `<table><thead><tr><th>Service</th><th>What it does</th><th>State</th></tr></thead><tbody>${
    d.services.map((s) => `<tr><td>${esc(s.title)}<div class="muted mono">${esc(s.unit)}</div></td><td>${esc(s.what)}</td>
      <td><span class="tag ${s.active === "active" ? "ok" : s.active === "failed" ? "err" : "off"}">${esc(s.active)}${s.sub ? ` · ${esc(s.sub)}` : ""}</span></td></tr>`).join("")
  }</tbody></table>${d.crontab.otherLines ? `<p class="muted">Your crontab also runs ${d.crontab.otherLines} job${d.crontab.otherLines === 1 ? "" : "s"} team-up does not manage; they are left alone.</p>` : ""}`;
  const failing = d.custom.filter((j) => j.lastRun && !j.lastRun.running && j.lastRun.exit !== 0).length;
  updateNavBadge("badge-automation", failing ? String(failing) : "", "red", failing > 0, failing ? `${failing} job(s) failed last time` : "");
}

async function refreshAutomation() {
  automationData = await api("/api/automation");
  dashboardMetrics.automation = automationData;
  renderAutomation();
  updateAttention();
}
onEnter.automation = () => refreshAutomation().catch((err) => automationNote(err.message, "err"));

async function automationWrite(url, body, done) {
  try {
    const res = await api(url, { method: "POST", body: JSON.stringify(body) });
    automationNote(`${done}${res.backup ? ` · crontab backup ${res.backup}` : ""}`, "ok");
    return true;
  } catch (err) {
    automationNote(`Refused — ${err.message}`, "err");
    return false;
  } finally {
    await refreshAutomation().catch(() => {});
  }
}

$("#builtin-jobs").addEventListener("change", async (e) => {
  const card = e.target.closest("[data-builtin]");
  if (!card) return;
  const id = card.dataset.builtin;
  const title = automationData.builtin.find((j) => j.id === id)?.title || id;
  if (e.target.matches("[data-builtin-toggle]")) {
    await automationWrite(`/api/automation/builtin/${id}`, { enabled: e.target.checked }, `${title} switched ${e.target.checked ? "on" : "off"}`);
  } else if (e.target.matches("[data-builtin-model]")) {
    try {
      await api(`/api/cron-jobs/${encodeURIComponent(e.target.dataset.builtinModel)}`, { method: "POST", body: JSON.stringify({ model: e.target.value }) });
      automationNote(`${title} now runs on ${e.target.value}`, "ok");
    } catch (err) {
      automationNote(`Refused — ${err.message}`, "err");
    }
    await refreshAutomation().catch(() => {});
  } else if (e.target.matches("[data-knob]")) {
    const key = e.target.dataset.knob;
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value.trim() === "" ? null : Number(e.target.value);
    await automationWrite(`/api/automation/builtin/${id}`, { knob: { key, value } }, `${title}: ${key} saved`);
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
  await automationWrite(`/api/automation/builtin/${card.dataset.builtin}`, { schedule }, "Schedule saved");
});

$("#custom-jobs").addEventListener("change", async (e) => {
  if (!e.target.matches("[data-job-toggle]")) return;
  const name = e.target.closest("[data-job]").dataset.job;
  await automationWrite(`/api/automation/jobs/${name}/enabled`, { enabled: e.target.checked }, `${name} switched ${e.target.checked ? "on" : "off"}`);
});

$("#custom-jobs").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-job]");
  if (!card) return;
  const name = card.dataset.job;
  const job = automationData.custom.find((j) => j.name === name);
  if (e.target.matches("[data-job-edit]")) openJobEditor(job);
  else if (e.target.matches("[data-job-log]")) openJobLog(name);
  else if (e.target.matches("[data-job-run]")) {
    if (await automationWrite(`/api/automation/jobs/${name}/run`, {}, `${name} started — its output lands in the log`)) {
      setTimeout(() => refreshAutomation().catch(() => {}), 3000);
    }
  } else if (e.target.matches("[data-job-delete]") && confirm(`Delete the job "${name}" and its prompt?`)) {
    await automationWrite(`/api/automation/jobs/${name}/delete`, {}, `${name} deleted`);
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
      out.textContent = p.error ? `✗ ${p.error}` : `${p.text} · next run ${fmtWhen(p.next)}`;
    } catch (err) {
      out.textContent = err.message;
    }
  }, 250);
}

function openJobEditor(job = null) {
  jobOriginal = job?.name || null;
  $("#job-editor-title").textContent = job ? `Edit ${job.name}` : "New job";
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
    automationNote(`${body.name} saved${res.backup ? ` · crontab backup ${res.backup}` : ""}`, "ok");
  } catch (err) {
    $("#job-editor-status").textContent = `Not saved — ${err.message}`;
  }
  await refreshAutomation().catch(() => {});
});

async function openJobLog(name) {
  $("#job-log-title").textContent = `Log · ${name}`;
  $("#job-log-body").textContent = "loading…";
  $("#job-log").showModal();
  try {
    const { log } = await api(`/api/automation/jobs/${name}/log`);
    $("#job-log-body").textContent = log || "No runs yet.";
    $("#job-log-body").scrollTop = $("#job-log-body").scrollHeight;
  } catch (err) {
    $("#job-log-body").textContent = err.message;
  }
}

// ── Needs attention ───────────────────────────────────────────────────────
// The overview's to-do list, assembled from what the other views already
// fetched. Empty means nothing is waiting on you, and the panel hides.
function updateAttention() {
  const items = [];
  const runs = dashboardMetrics.runCounts || {};
  if (runs.waiting) items.push({ tone: "red", text: `${runs.waiting} run${runs.waiting === 1 ? " is" : "s are"} waiting for your answer`, href: "#/runs" });
  if (runs.failedUncollected) items.push({ tone: "red", text: `${runs.failedUncollected} failed run${runs.failedUncollected === 1 ? "" : "s"} not looked at yet`, href: "#/runs" });
  for (const [key, w] of Object.entries(dashboardMetrics.usage?.windows || {})) {
    if (w.level === "red" || w.level === "amber") {
      items.push({ tone: w.level === "red" ? "red" : "", text: `${key} is at ${w.usedPct}%${w.resets_at ? ` — resets ${fmtWhen(w.resets_at)}` : ""}`, href: "#/overview" });
    }
  }
  for (const [cli, c] of Object.entries(dashboardMetrics.usage?.collectors || {})) {
    if (c?.stale) items.push({ tone: "", text: `Usage readings for ${cli} are stale — limits are not being checked`, href: "#/overview" });
  }
  const auto = dashboardMetrics.automation;
  if (auto && !auto.crontab.readable) items.push({ tone: "red", text: "The crontab cannot be read — scheduled jobs are unknown", href: "#/automation" });
  for (const j of auto?.custom || []) {
    if (j.lastRun && !j.lastRun.running && j.lastRun.exit !== 0) items.push({ tone: "red", text: `Job ${j.name} failed on its last run (exit ${j.lastRun.exit})`, href: "#/automation" });
    if (j.inSync === false) items.push({ tone: "", text: `Job ${j.name} is not installed in the crontab — open and save it again`, href: "#/automation" });
  }
  $("#attention-list").innerHTML = items.map((i) => `<li class="${i.tone}">${esc(i.text)}<a href="${i.href}">Open →</a></li>`).join("");
  $("#panel-attention").classList.toggle("hidden", items.length === 0);
}

// ── TIM: open work | explorer ─────────────────────────────────────────────
const TIM_VIEW_KEY = "teamup.timView";
let timViewShown = false;

function showTimView(view) {
  timViewShown = true;
  const which = view === "explorer" ? "explorer" : "work";
  writeStored(TIM_VIEW_KEY, which);
  for (const b of $("#tim-views").querySelectorAll("[data-tim-view]")) {
    b.classList.toggle("is-active", b.dataset.timView === which);
    b.setAttribute("aria-selected", String(b.dataset.timView === which));
  }
  for (const pane of document.querySelectorAll("[data-tim-pane]")) pane.classList.toggle("hidden", pane.dataset.timPane !== which);
  if (which === "explorer") {
    const frame = $("#tim-frame");
    if (!frame.src) {
      $("#tim-explorer-status").textContent = "Starting the TIM viewer…";
      frame.addEventListener("load", () => {
        $("#tim-explorer-status").textContent = "";
        frame.classList.remove("hidden");
      }, { once: true });
      frame.src = "/tim-viewer/?embed=1";
    }
  }
}
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
    $("#catalogue-status").textContent = "Scan started — every CLI is asked for its models; the list refreshes in about two minutes.";
    setTimeout(() => {
      btn.disabled = false;
      refreshCatalogue().catch(() => {});
    }, 120_000);
  } catch (err) {
    $("#catalogue-status").textContent = `Refused — ${err.message}`;
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
    $("#trending-status").textContent = err.message;
  }
  renderTrending();
}

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
  $("#trending-status").textContent = !section ? "The report has no sections."
    : section.repos.length ? "" : "No repos in this section.";
  $("#trending-table").innerHTML = section?.repos.length ? `<table>
    <thead><tr><th>Repo</th><th>⭐</th><th>Lang</th><th>Created</th><th>Description</th></tr></thead>
    <tbody>${section.repos.map((r) => `<tr>
      <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.name)}</a>` : esc(r.name)}</td>
      <td>${r.stars == null ? "" : r.stars.toLocaleString()}</td>
      <td>${esc(r.lang)}</td>
      <td>${esc(r.created)}</td>
      <td class="desc" title="${esc(r.description)}">${esc(r.description)}</td>
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
  "panel-usage": "Usage windows of every subscription: share used, warn level and when it resets. STALE means the collector stopped reading — one click sends an agent to fix it.",
  "panel-sessions": "Live tmux sessions (click one to open its terminal) and team-up runs with their mailbox (click a run for STATUS / PROMPT / RESULT).",
  "panel-projects": "Repos in the collecting folder: branch, command policy trust, open sessions. Start opens a CLI session in the repo; Fix all / auto-fix write unambiguous policies and trust their checksums.",
  "panel-tim": "Open TIM tasks, ideas and bugs of every project in the folder. Start opens a session with the item as prompt.",
  "panel-roles": "Every role, the model `team-up pick` would choose right now, and the fallback chain behind it. ✎ edits a chain, ⬆ marks entries with a newer version available, ✗ entries the CLI no longer offers. The Roster tab lists every model per provider; a checked one is in the roster and offered in the chains. Specialists run on a role's chain or their own — picked in the Specialists widget.",
  "panel-specialists": "One installed specialist: what it is for, its skills and assigned capability packages. Permissions and limits are under Details.",
  "panel-settings": "Roster switches: accounts on/off, subscriptions, usage-spender quota, limit thresholds, usage watcher intervals. Every change is validated and backs up roster.json.",
  "panel-cron-jobs": "Which CLI×model runs each scheduled LLM job (~/.team-up/cron-jobs.ini). No fallback: if that CLI is at its limit, the job fails and says so.",
  "panel-providers": "How each provider authenticates: an API key team-up holds, a CLI's own login, or a key the CLI keeps itself.",
  "panel-trending": "New AI repos on GitHub from the newest daily report of the hermes trending scraper (~/.hermes/cron-outputs/framework-scout). Pick a section; hover a description for all of it.",
  "panel-clis": "Agent CLIs: version, harness verification, update/install/login. CLIs team-up can install but the roster doesn't run yet are rows you switch on in ✎. Hover a CLI name for its path; click a row for the job log.",
};
const panels = () => [...document.querySelectorAll("main .panel")];
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
  const keys = heads.map((th) => {
    const text = th.textContent.trim().toLowerCase();
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
  panel.querySelectorAll("th[data-col]").forEach((th) => cols.set(th.dataset.col, th.dataset.col));
  const rows = new Map();
  panel.querySelectorAll("[data-row]").forEach((el) => rows.set(el.dataset.row, el.dataset.row));
  // Rows that start hidden (a CLI team-up can install but the roster doesn't
  // run) are stored as shown, the rest as hidden.
  const offByDefault = new Set([...panel.querySelectorAll('[data-row-default="hidden"]')].map((el) => el.dataset.row));
  const shownRows = new Set(mine.rowsShown || []);
  const hiddenCols = new Set(mine.cols || []);
  const hiddenRows = new Set([...(mine.rows || []), ...[...offByDefault].filter((r) => !shownRows.has(r))]);
  const list = (kind, items, hidden, label) => items.size
    ? `<label>${label}</label><div class="pref-list">${[...items.keys()].map((k) =>
      `<label><input type="checkbox" data-kind="${kind}" value="${esc(k)}"${
        offByDefault.has(k) ? " data-default-off" : ""}${hidden.has(k) ? "" : " checked"}> ${
        esc(k.replace(":", " › "))}</label>`).join("")}</div>`
    : "";
  $("#panel-editor-items").innerHTML = list("cols", cols, hiddenCols, "Visible columns")
    + list("rows", rows, hiddenRows, "Visible rows");
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
    h2.innerHTML = `<span class="title" title="${esc(PANEL_HELP[panel.id] || "")}">${h2.innerHTML}</span>
      <button type="button" class="panel-edit" title="Colour and visible columns">✎</button>`;
    h2.querySelector(".panel-edit").addEventListener("click", () => openPanelEditor(panel));
    // Renderers replace their tables wholesale; tag whatever they just drew.
    new MutationObserver(() => panel.querySelectorAll("table").forEach(tagColumns))
      .observe(panel, { childList: true, subtree: true });
  }
  applyPanelPrefs();
}

function refreshAll() {
  return Promise.allSettled([
    refreshUsage(),
    refreshRuns(),
    refreshTmux(),
    refreshProjects(),
    refreshTim(),
    refreshRoles(),
    refreshSetup(),
  ]);
}

let automationTimer = null;

function startPolling() {
  refreshSpecialists().catch(() => {});
  showRolesTab(readStored(ROLES_TAB_KEY, "roles") === "models" ? "models" : "roles");
  refreshSettings().catch(() => {});
  refreshAutomation().catch(() => {});
  clearInterval(automationTimer);
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
