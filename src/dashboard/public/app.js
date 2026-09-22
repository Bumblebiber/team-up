const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
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
  return d.innerHTML;
}

function levelBadge(level, stale) {
  const parts = [];
  if (level === "red") parts.push('<span class="badge red">RED</span>');
  else if (level === "amber") parts.push('<span class="badge amber">WARN</span>');
  else parts.push('<span class="badge ok">OK</span>');
  if (stale) parts.push('<span class="badge stale">STALE</span>');
  return parts.join(" ");
}

async function refreshRuns() {
  const active = $("#active-only").checked ? "1" : "0";
  const data = await api(`/api/runs?active=${active}`);
  const rows = data.runs.map((r) => `
    <tr class="clickable" data-run="${esc(r.runId)}">
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

async function selectRun(runId) {
  selectedRun = runId;
  const data = await api(`/api/runs/${runId}`);
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

async function selectSession(session) {
  selectedSession = session;
  if (paneTimer) clearInterval(paneTimer);
  const refresh = async () => {
    try {
      const data = await api(`/api/tmux/${encodeURIComponent(session)}/pane`);
      const el = $("#pane-output");
      el.textContent = data.pane || "(empty)";
      el.classList.remove("hidden");
    } catch { /* session gone */ }
  };
  await refresh();
  paneTimer = setInterval(refresh, 2000);
}

async function refreshUsage() {
  const data = await api("/api/usage");
  const cards = Object.entries(data.windows).map(([key, w]) => `
    <div class="usage-card">
      <div class="key">${esc(key)}</div>
      <div class="pct">${w.usedPct != null ? w.usedPct + "%" : "—"}</div>
      <div>${levelBadge(w.level, w.stale)}</div>
      <div class="marked-item">↻ ${esc(w.resets_at || "—")}</div>
    </div>`).join("");
  $("#usage-grid").innerHTML = cards || "<p>No usage data</p>";
  $("#marked-list").innerHTML = data.marked.length
    ? `<h3>Marked</h3>${data.marked.map((m) => `<div class="marked-item">${esc(m.key)} until ${esc(m.until)}</div>`).join("")}`
    : "";
}

async function refreshPick() {
  const data = await api("/api/pick");
  const rows = data.picks.map((p) => `
    <tr>
      <td>${esc(p.role)}</td>
      <td>${p.model ? esc(`${p.cli}:${p.model}`) : "<em>exhausted</em>"}</td>
      <td>${esc(p.effort || "—")}</td>
      <td class="skipped">${p.skipped.map((s) => esc(`${s.model}: ${s.reason}`)).join("<br>")}</td>
    </tr>`).join("");
  $("#pick-table").innerHTML = `<table>
    <thead><tr><th>Role</th><th>Pick</th><th>Effort</th><th>Skipped</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No roles</td></tr>'}</tbody></table>`;
}

function refreshAll() {
  return Promise.allSettled([refreshUsage(), refreshRuns(), refreshTmux(), refreshPick()]);
}

function startPolling() {
  refreshAll();
  if (listTimer) clearInterval(listTimer);
  listTimer = setInterval(refreshAll, 5000);
}

async function probe() {
  try {
    await api("/api/runs?active=1");
    showApp();
    startPolling();
  } catch {
    showLogin();
  }
}

probe();
