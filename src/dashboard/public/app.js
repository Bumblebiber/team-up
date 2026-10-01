const $ = (sel) => document.querySelector(sel);

let adminChallengeId = null;
let modelsPage = 0;

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
  return d.innerHTML;
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
  google: "google", gemini: "google",
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
  const active = $("#active-only").checked ? "1" : "0";
  const data = await api(`/api/runs?active=${active}`);
  const rows = data.runs.map((r) => `
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
    ? `<h3>Marked</h3>${data.marked.map((m) => `<div class="marked-item">${esc(m.key)} until ${esc(m.until)}</div>`).join("")}`
    : "";
}

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
  const [cls, why] = CELL_STATE[c.state] || ["", ""];
  const notes = [why, c.newest ? `newer: ${c.newest}` : "", c.pinned ? "version pinned" : "",
    c.effort ? `effort ${c.effort}` : ""].filter(Boolean).join(" · ");
  return `<span class="chip chain-chip ${cls}"${providerAttr(c.cli, c.model)} title="${esc(`${c.cli}:${c.model}${notes ? ` — ${notes}` : ""}`)}">${
    i + 1}. ${esc(c.label)}${c.pinned ? " 📌" : ""}${c.newest ? " ⬆" : ""}${c.state === "gone" ? " ✗" : ""}</span>`;
}

async function refreshRoles() {
  rolesData = await api("/api/roles");
  const upgrades = rolesData.roles.flatMap((r) => r.chain.filter((c) => c.newest && !c.pinned));
  const addable = rolesData.addable || [];
  const btn = $("#roles-upgrade");
  btn.classList.toggle("hidden", !upgrades.length && !addable.length);
  btn.textContent = `⬆ Bring to newest versions (${[
    addable.length ? `${addable.length} new: ${addable.map((a) => a.id).join(", ")}` : "",
    upgrades.length ? `${upgrades.length} chain entr${upgrades.length === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean).join(" · ")})`;
  const rows = rolesData.roles.map((r) => `
    <tr>
      <td><strong>${esc(r.role)}</strong> <button type="button" class="role-triage${r.in_triage ? "" : " off"}" data-role="${esc(r.role)}" title="${r.in_triage
        ? "Triage routes this role (OpenRouter proposes a model per prompt). Click to stop."
        : "Not routed by triage. Click to let triage propose a model per prompt."}">⇄</button></td>
      <td class="nowrap">${r.pick ? `${esc(r.pick.label)} <span class="muted">${esc(r.pick.cli)}${r.pick.effort ? ` · ${esc(r.pick.effort)}` : ""}</span>` : "<em>exhausted</em>"}</td>
      <td class="chain-cell">${r.chain.map(chainChip).join(" ")}${r.skipped.length
        ? `<div class="skipped" title="${esc(r.skipped.map((x) => `${x.model}: ${x.reason}`).join("\n"))}">⚠ ${
          r.skipped.length} skipped right now</div>` : ""}</td>
      <td><button type="button" class="role-pin" data-role="${esc(r.role)}" title="${r.pin_head
        ? "Head pinned: the weekly score refresh leaves it alone. Click to let it propose a new head."
        : "Not pinned: the weekly score refresh may replace the first entry. Click to pin."}">${r.pin_head ? "📌" : "○"}</button></td>
      <td class="row-actions">
        <button type="button" class="role-edit" data-role="${esc(r.role)}" title="Edit chain">✎</button>
        <button type="button" class="role-delete" data-role="${esc(r.role)}" title="Delete role">🗑</button>
      </td>
    </tr>`).join("");
  $("#roles-table").innerHTML = `<table>
    <thead><tr><th>Role</th><th>Pick now</th><th>Chain</th><th>Pin</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No roles</td></tr>'}</tbody></table>`;
}

// Triage membership lives in roster.triage.roles; the role row is where it is
// toggled, since a role triage routes cannot be deleted.
async function toggleTriage(r) {
  const status = $("#roles-status");
  const current = rolesData.roles.filter((x) => x.in_triage).map((x) => x.role);
  const value = r.in_triage ? current.filter((x) => x !== r.role) : [...current, r.role];
  try {
    const res = await api("/api/settings", { method: "POST", body: JSON.stringify({ path: "triage.roles", value }) });
    status.textContent = `${r.role} ${r.in_triage ? "removed from" : "added to"} triage · backup ${res.backup}`;
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
  }
  await refreshRoles();
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
  const r = rolesData?.roles.find((x) => x.role === role);
  if (btn.classList.contains("role-edit")) openRoleEditor(r);
  else if (btn.classList.contains("role-pin")) roleWrite(role, { pin_head: !r.pin_head }, `${role} ${r.pin_head ? "unpinned" : "pinned"}`);
  else if (btn.classList.contains("role-triage")) toggleTriage(r);
  else if (btn.classList.contains("role-delete")
    && confirm(`Delete role "${role}"?\n\nAnything that still runs \`team-up pick --role ${role}\` will fail.`)) {
    roleWrite(role, { delete: true }, `${role} deleted`);
  }
});

$("#roles-upgrade").addEventListener("click", async () => {
  const status = $("#roles-status");
  try {
    const res = await api("/api/roles-upgrade", { method: "POST", body: JSON.stringify({}) });
    const done = [...res.added.map((a) => `added ${a.id}`), ...res.changes.map((c) => `${c.role}: ${c.from} → ${c.to}`)];
    status.textContent = done.length ? `${done.join(", ")} · backup ${res.backup}` : "already on the newest versions";
    refreshTiers().catch(() => {});
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

function openRoleEditor(role) {
  roleTarget = role?.role || null;
  $("#role-editor-title").textContent = role ? `Edit ${role.role}` : "New role";
  $("#role-editor-name").value = role?.role || "";
  $("#role-editor-name").readOnly = !!role;
  // A hand-written chain pins its head by default; unticking is the opt-out.
  $("#role-editor-pin").checked = true;
  $("#role-editor-status").textContent = "";
  const list = $("#role-editor-chain");
  list.innerHTML = "";
  for (const c of role?.chain?.filter((x) => !x.invalid) || [{}]) list.append(chainRow(c));
  roleDialog.showModal();
}

$("#role-add").addEventListener("click", () => openRoleEditor(null));
$("#role-editor-add").addEventListener("click", () => $("#role-editor-chain").append(chainRow()));
$("#role-editor-cancel").addEventListener("click", () => roleDialog.close());
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
  const ok = await roleWrite(role, { chain, pin_head: $("#role-editor-pin").checked }, `${role} saved`);
  if (ok) roleDialog.close();
  else $("#role-editor-status").textContent = $("#roles-status").textContent;
});

/**
 * The tier table. Deliberately outside `refreshAll`: a five-second re-render
 * would reset a dropdown mid-edit, and nothing changes this file except this
 * panel. It redraws from what the write returns.
 */
function renderTiers(data) {
  const efforts = ["", ...data.effort_values];
  const row = (m) => {
    const tierOptions = data.tiers
      .map((t) => `<option value="${esc(t)}"${t === m.tier ? " selected" : ""}>${esc(t)}</option>`)
      .join("");
    const clis = data.clis.map((cli) => `
      <label class="tier-cli"><input type="checkbox" data-kind="cli" data-model="${esc(m.model)}"
        data-cli="${esc(cli)}"${m.clis.includes(cli) ? " checked" : ""}> ${esc(cli)}</label>`).join("");
    const levels = data.reasoning_levels.map((level) => {
      const current = m.reasoning[level];
      const options = efforts.map((value) =>
        `<option value="${esc(value)}"${value === (current ?? "") ? " selected" : ""}>${
          value ? esc(value) : "—"}</option>`).join("");
      return `<td><select data-kind="effort" data-model="${esc(m.model)}"
        data-level="${esc(level)}">${options}</select></td>`;
    }).join("");
    return `<tr>
      <td>${esc(m.label || m.model)}</td>
      <td class="muted">${esc(m.provider || "—")}</td>
      <td><select data-kind="tier" data-model="${esc(m.model)}">${tierOptions}</select></td>
      <td class="tier-clis">${clis}</td>
      ${levels}
    </tr>`;
  };
  const sections = data.tiers.map((tier) => {
    const models = data.models.filter((m) => m.tier === tier);
    const body = models.length
      ? models.map(row).join("")
      : `<tr><td colspan="${4 + data.reasoning_levels.length}"><em>no model in this tier</em></td></tr>`;
    return `<tr class="tier-head"><th colspan="${4 + data.reasoning_levels.length}">${esc(tier)}</th></tr>${body}`;
  }).join("");
  const levelHeads = data.reasoning_levels.map((l) => `<th>${esc(l)}</th>`).join("");
  $("#tiers-table").innerHTML = `<table class="tiers">
    <thead><tr><th>Model</th><th>Provider</th><th>Tier</th><th>CLIs</th>${levelHeads}</tr></thead>
    <tbody>${sections}</tbody></table>`;
}

async function refreshTiers() {
  renderTiers(await api("/api/tiers"));
}

$("#tiers-table").addEventListener("change", async (e) => {
  const el = e.target;
  const model = el.dataset.model;
  if (!model) return;
  let body;
  if (el.dataset.kind === "tier") body = { tier: el.value };
  else if (el.dataset.kind === "cli") body = { cli: el.dataset.cli, action: el.checked ? "add" : "remove" };
  else if (el.dataset.kind === "effort") body = { level: el.dataset.level, effort: el.value || null };
  else return;
  const status = $("#tiers-status");
  try {
    const data = await api(`/api/tiers/models/${encodeURIComponent(model)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    status.textContent = `saved · backup ${data.backup}`;
    renderTiers(data);
    refreshRoles().catch(() => {});
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
    // The roster is unchanged, so the table has to go back to what it says.
    refreshTiers().catch(() => {});
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

async function refreshModels() {
  const q = $("#models-search").value.trim();
  const inRoster = $("#models-roster-only").checked ? "1" : "";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (inRoster) params.set("in_roster", inRoster);
  params.set("page", String(modelsPage));
  const data = await api(`/api/models?${params}`);
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
  if (modelsPage >= pageCount) modelsPage = Math.max(0, pageCount - 1);
  $("#models-meta").textContent = `${data.total} models (page ${data.page + 1} of ${pageCount}, showing ${data.models.length})`;
  $("#models-prev").disabled = data.page <= 0;
  $("#models-next").disabled = data.page + 1 >= pageCount;
  $("#apply-cli-hint").textContent = `To apply roster chain changes: ${data.apply_cli}`;
  const rows = data.models.map((m) => `
    <tr class="${m.in_roster && m.reachable === false ? "greyed" : ""}"${providerAttr(m.model, m.provider)}>
      <td>${esc(m.label || m.model)}</td>
      <td>${esc(m.display_name || "—")}</td>
      <td>${m.in_roster ? "yes" : "no"}</td>
      <td>${esc(m.tier || "—")}</td>
      <td>${m.proposal ? esc(`+${m.proposal.gap?.toFixed?.(1) ?? "?"} vs ${m.proposal.head}`) : "—"}</td>
    </tr>`).join("");
  $("#models-table").innerHTML = `<table>
    <thead><tr><th>Model</th><th>Name</th><th>Roster</th><th>Tier</th><th>Proposal</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No models — run refresh</td></tr>'}</tbody></table>`;
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
    if (c.install_available) {
      actions.push(`<button type="button" class="cli-install" data-cli="${esc(c.cli)}">Install</button>`);
    } else if (c.install_disabled_reason && !c.present) {
      actions.push(`<span class="muted">${esc(c.install_disabled_reason)}</span>`);
    }
    if (c.login_available) {
      actions.push(`<button type="button" class="cli-login" data-cli="${esc(c.cli)}">Start login</button>`);
    }
    return `
    <tr class="clickable ${selectedCli === c.cli ? "selected" : ""}" data-cli="${esc(c.cli)}"${providerAttr(c.cli)}>
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
  await Promise.allSettled([refreshProviders(), refreshModels(), refreshClis()]);
}

$("#models-search").addEventListener("input", () => {
  modelsPage = 0;
  refreshModels();
});
$("#models-roster-only").addEventListener("change", () => {
  modelsPage = 0;
  refreshModels();
});
$("#models-prev").addEventListener("click", () => {
  if (modelsPage > 0) {
    modelsPage -= 1;
    refreshModels();
  }
});
$("#models-next").addEventListener("click", () => {
  modelsPage += 1;
  refreshModels();
});
$("#refresh-scores-btn").addEventListener("click", async () => {
  try {
    await api("/api/refresh", { method: "POST", body: JSON.stringify({}) });
    await refreshModels();
  } catch (err) {
    alert(err.message);
  }
});

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


// What the specialist is for stays visible; everything that only matters when
// something goes wrong (limits, permissions, where it is approved) folds away.
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
  const approved = s.approved_for || [];
  const profile = s.model_profile ? `${s.model_profile.tier}:${s.model_profile.reasoning}` : null;
  $("#specialist-meta").textContent = [`v${s.version}`, profile, `approved in ${approved.length}`]
    .filter(Boolean).join(" · ");
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
        ? `<p class="muted">Version: ${s.versions.map((v) => `
            <button type="button" class="version-pin" data-version="${esc(v.version)}"
              ${v.selected ? "disabled" : ""}>${esc(v.version)}${v.selected ? " ✓" : ""}</button>`).join(" ")}</p>`
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
      <p class="muted">Approved for: ${approved.map((p) => esc(p.replace(/^\/home\/[^/]+\//, "~/"))).join(", ") || "no project"}</p>
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
  const pin = event.target.closest(".version-pin");
  if (!pin) return;
  const id = $("#specialist-select").value;
  const status = $("#capability-status");
  try {
    await api(`/api/specialists/${encodeURIComponent(id)}/pin`, {
      method: "POST",
      body: JSON.stringify({ version: pin.dataset.version }),
    });
    await refreshSpecialists();
    status.textContent = `${id} now runs ${pin.dataset.version}`;
  } catch (err) {
    status.textContent = err.message;
  }
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
// Every `teamup.*` key also lives on the server, so the layout set on one
// device shows on all of them. localStorage stays the working copy — the page
// reads it synchronously while it builds — and the server copy replaces it
// once the login is known. The last device to change something wins.
const PREF_PREFIX = "teamup.";

function localPrefs() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(PREF_PREFIX)) out[key] = localStorage.getItem(key);
    }
  } catch {
    // storage blocked: nothing local to sync
  }
  return out;
}

const sameKeys = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function pushPrefs() {
  // keepalive: "Reset layout" reloads right after, and the push must survive it.
  api("/api/prefs", { method: "POST", body: JSON.stringify(localPrefs()), keepalive: true }).catch(() => {});
}

/** Adopt the server's prefs; reloads once when they differ from this browser's. */
async function pullPrefs() {
  const remote = await api("/api/prefs");
  const local = localPrefs();
  if (!Object.keys(remote).length) {
    // First device after the switch to server prefs: seed it from here.
    if (Object.keys(local).length) pushPrefs();
    return;
  }
  if (sameKeys(remote, local)) return;
  try {
    for (const key of Object.keys(local)) if (!(key in remote)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(remote)) localStorage.setItem(key, value);
  } catch {
    return; // storage blocked: keep what is on screen
  }
  location.reload();
}

// ── Panel layout ──────────────────────────────────────────────────────────
// Panels live in columns the script builds, not in the markup: the number of
// columns is the user's choice. Each column is its own flex container, so it
// stacks independently and a tall panel in one leaves no gap in the next.
// Order comes from dragging a panel by its <h2>, height from the browser's
// native resize handle; the width is always the column's. Stored in
// localStorage and mirrored to the server (see pullPrefs) so every device
// shows the same layout.
const LAYOUT_KEY = "teamup.layout";
const MAX_COLUMNS = 6;
// What a fresh browser gets: the narrow-content panels left, the wide ones right.
const DEFAULT_COLUMNS = [
  ["panel-usage", "panel-sessions", "panel-projects", "panel-tim", "panel-specialists"],
  ["panel-roles", "panel-settings", "panel-providers", "panel-models", "panel-clis"],
];
const mainEl = $("main");
const columns = () => [...mainEl.querySelectorAll(".column")];
const panels = () => [...mainEl.querySelectorAll(".panel")];

function readLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLayout() {
  const size = {};
  for (const panel of panels()) {
    if (panel.style.height) size[panel.id] = { h: panel.style.height };
  }
  const order = columns().map((column) =>
    [...column.querySelectorAll(".panel")].map((p) => p.id));
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ order, size }));
    pushPrefs();
  } catch {
    // Private mode or a full quota: the layout just stops surviving reloads.
  }
}

function setColumnCount(count) {
  const wanted = Math.max(1, Math.min(MAX_COLUMNS, count));
  let existing = columns();
  while (existing.length < wanted) {
    const column = document.createElement("div");
    column.className = "column";
    mainEl.append(column);
    existing = columns();
  }
  // Removing a column must not remove its panels: they move to the last one
  // that survives, in order.
  while (existing.length > wanted) {
    const doomed = existing.pop();
    for (const panel of [...doomed.querySelectorAll(".panel")]) {
      existing[existing.length - 1].append(panel);
    }
    doomed.remove();
  }
  mainEl.style.setProperty("--column-count", String(wanted));
  $("#column-count").textContent = String(wanted);
  $("#column-remove").disabled = wanted <= 1;
  $("#column-add").disabled = wanted >= MAX_COLUMNS;
}

function applyLayout() {
  const layout = readLayout();
  // Older layouts keyed the order by column id, or were a flat array before
  // there were columns at all. Neither says how many columns the user wanted,
  // so they fall back to the default rather than being guessed at.
  const order = Array.isArray(layout.order) && Array.isArray(layout.order[0])
    ? layout.order
    : DEFAULT_COLUMNS;

  setColumnCount(order.length);
  const built = columns();
  const placed = new Set();
  order.forEach((ids, index) => {
    for (const id of ids) {
      const panel = document.getElementById(id);
      if (!panel?.classList.contains("panel")) continue;
      built[index].append(panel);
      placed.add(id);
    }
  });
  // A panel the stored layout never heard of — a new one shipped since it was
  // written — would otherwise stay outside every column and vanish from view.
  // It goes where a fresh browser would have it, so merged or renamed panels
  // land in a sensible column instead of piling up in the first.
  for (const panel of [...mainEl.children].filter((el) => el.classList.contains("panel"))) {
    if (placed.has(panel.id)) continue;
    const home = DEFAULT_COLUMNS.findIndex((ids) => ids.includes(panel.id));
    built[Math.min(Math.max(home, 0), built.length - 1)].append(panel);
  }

  for (const [id, size] of Object.entries(layout.size || {})) {
    const panel = document.getElementById(id);
    if (!panel) continue;
    // Width is the column's; a stored `w` from before widths were fixed is ignored.
    if (size.h) panel.style.height = size.h;
  }
}

function movePanel(panel, place) {
  place(panel);
  saveLayout();
}

let draggedPanel = null;

function enableLayoutEditing() {
  for (const panel of panels()) {
    const grip = panel.querySelector("h2");
    if (!grip) continue;
    grip.draggable = true;
    grip.addEventListener("dragstart", (event) => {
      draggedPanel = panel;
      panel.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      // Firefox only starts a drag once some data is set.
      event.dataTransfer.setData("text/plain", panel.id);
    });
    grip.addEventListener("dragend", () => {
      panel.classList.remove("dragging");
      draggedPanel = null;
      mainEl.querySelectorAll(".drop-target")
        .forEach((el) => el.classList.remove("drop-target"));
    });
  }

  // Delegated to <main>: columns come and go, so per-column listeners would
  // have to be rewired on every add.
  mainEl.addEventListener("dragover", (event) => {
    if (!draggedPanel) return;
    const panel = event.target.closest?.(".panel");
    const column = event.target.closest?.(".column");
    if (!panel && !column) return;
    if (panel === draggedPanel) return;
    event.preventDefault();
    for (const el of mainEl.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
    (panel || column).classList.add("drop-target");
  });

  mainEl.addEventListener("dragleave", (event) => {
    event.target.closest?.(".panel, .column")?.classList.remove("drop-target");
  });

  mainEl.addEventListener("drop", (event) => {
    if (!draggedPanel) return;
    const panel = event.target.closest?.(".panel");
    const column = event.target.closest?.(".column");
    if (panel === draggedPanel) return;
    if (panel) {
      event.preventDefault();
      // Which half of the target was hit decides above/below. Document order
      // cannot answer that once a panel crosses into another column.
      const box = panel.getBoundingClientRect();
      const above = event.clientY < box.top + box.height / 2;
      movePanel(draggedPanel, (moved) => panel[above ? "before" : "after"](moved));
    } else if (column) {
      // The blank space below the last panel parks it at the end, which is
      // also the only way into a column emptied by dragging.
      event.preventDefault();
      movePanel(draggedPanel, (moved) => column.append(moved));
    }
    for (const el of mainEl.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
  });

  // The native resize handle sets an inline height and fires no event of its
  // own; a pointerup anywhere is the cheapest "the drag is over" signal.
  document.addEventListener("pointerup", () => {
    const layout = readLayout();
    const changed = panels().some((panel) => {
      const saved = layout.size?.[panel.id] || {};
      return panel.style.height !== (saved.h || "");
    });
    if (changed) saveLayout();
  });

  $("#column-add").addEventListener("click", () => {
    setColumnCount(columns().length + 1);
    saveLayout();
  });

  $("#column-remove").addEventListener("click", () => {
    setColumnCount(columns().length - 1);
    saveLayout();
  });

  $("#reset-layout-btn").addEventListener("click", () => {
    try {
      localStorage.removeItem(LAYOUT_KEY);
      pushPrefs();
    } catch {
      // Nothing stored means nothing to clear.
    }
    for (const panel of panels()) {
      panel.style.height = "";
    }
    location.reload();
  });
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

// ── command policy and approvals ──
// A specialist that runs commands needs `.team-up/commands.json` before it
// can be approved: the grant binds the policy's checksum. So a fix is always
// policy first, then approve.
let projectsByPath = new Map();
let projectsNote = "";
const PROJECTS_AUTO_KEY = "teamup.projectsAutoFix";
// Auto-fix tries each project once per page load: a failing approval would
// otherwise be retried, and audited, on every poll.
const autoFixTried = new Set();

function policyCell(p) {
  const pol = p.policy || { state: "none" };
  const create = `<button type="button" class="policy-create" data-dir="${esc(p.path)}">Create…</button>`;
  if (pol.state === "valid") return '<span class="badge ok">valid</span>';
  if (pol.state === "invalid") {
    return `<span class="badge red" title="${esc((pol.errors || []).join("\n"))}">invalid</span>`;
  }
  if (pol.state === "missing") {
    const hint = pol.proposal?.auto ? "unambiguous" : "check the proposal";
    return `<span class="badge amber" title="${esc(hint)}">missing</span> ${create}`;
  }
  return `<span class="muted" title="no test command detected">no tests</span> ${create}`;
}

async function approveProject(p) {
  const res = await api("/api/projects/approve", {
    method: "POST",
    body: JSON.stringify({ dir: p.path, projects_dir: readProjectsDir() }),
  });
  // Blocked on a missing policy is what the Policy column already says.
  const refused = res.results.filter((r) => !r.ok && !/^COMMAND_POLICY_/.test(r.error));
  if (refused.length) {
    projectsNote = `${p.name}: not approved — ${refused.map((r) => `${r.id}: ${r.error}`).join("; ")}`;
  }
  return res;
}

/** What "Fix all" and auto-fix do to one project: only what needs no judgement. */
async function fixProject(p) {
  let wrote = false;
  if (p.policy?.state === "missing" && p.policy.proposal?.auto) {
    await api("/api/projects/policy", {
      method: "POST",
      body: JSON.stringify({ dir: p.path, projects_dir: readProjectsDir() }),
    });
    wrote = true;
  }
  const approvable = (p.specialists || []).some(
    (s) => !s.approved && (!s.reason || (wrote && s.reason === "COMMAND_POLICY_MISSING")),
  );
  if (approvable) await approveProject(p);
  return wrote;
}

const needsFix = (p) =>
  (p.policy?.state === "missing" && p.policy.proposal?.auto)
  || (p.specialists || []).some((s) => !s.approved && !s.reason);

async function fixProjects(projects) {
  const written = [];
  for (const p of projects) {
    try {
      if (await fixProject(p)) written.push(p.name);
    } catch (err) {
      projectsNote = `${p.name}: ${err.message}`;
    }
  }
  if (written.length) {
    projectsNote = `wrote .team-up/commands.json (uncommitted) in: ${written.join(", ")}`;
  }
  return written;
}

let autoFixRunning = false;
async function autoFixProjects() {
  if (autoFixRunning || !$("#projects-auto").checked) return;
  const todo = [...projectsByPath.values()].filter((p) => needsFix(p) && !autoFixTried.has(p.path));
  if (!todo.length) return;
  autoFixRunning = true;
  todo.forEach((p) => autoFixTried.add(p.path));
  try {
    await fixProjects(todo);
  } finally {
    autoFixRunning = false;
  }
  await refreshProjects();
}

$("#projects-fix-all").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    await fixProjects([...projectsByPath.values()].filter(needsFix));
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
  // The panel and its nav link exist in the markup but stay hidden until TIM
  // answers, so a dashboard without TIM never shows an empty box. The class,
  // not the attribute: `nav a` sets display and would win over [hidden].
  $("#panel-tim").classList.toggle("hidden", !data.installed);
  $("#nav-tim").classList.toggle("hidden", !data.installed);
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
          <span class="muted">${esc(item.status)}${item.priority ? ` · ${esc(item.priority)}` : ""}</span>
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
      .map((m) => ({ value: m.id, label: m.tier ? `${m.label || m.id} (${m.tier})` : m.label || m.id })),
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
  const profile = spec.model_profile
    ? ` Its profile asks for ${spec.model_profile.tier}:${spec.model_profile.reasoning}.`
    : "";
  $("#tim-launch-remit").textContent =
    `${spec.display_name || spec.id}: ${(spec.remit || []).join("; ")}.${profile}`
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
// The roster switches that used to need a text editor. Each control writes
// one path; the server holds the whitelist, so nothing here can reach the CLI
// command templates. Not on the five-second cycle: it would reset a field
// mid-edit, and only this panel changes these values.
async function refreshSettings() {
  const d = await api("/api/settings");
  const num = (path, value, step, title) =>
    `<input type="number" data-path="${path}" value="${value ?? ""}" step="${step}" title="${esc(title)}">`;
  const check = (path, on, label, title = "") =>
    `<label title="${esc(title)}"><input type="checkbox" data-path="${path}"${on ? " checked" : ""}> ${esc(label)}</label>`;
  const accounts = Object.entries(d.accounts).map(([id, a]) => `
    <tr data-row="account:${esc(id)}">
      <td>${check(`accounts.${id}.enabled`, a.enabled, id, a.comment || "")}</td>
      <td class="muted">${esc(a.kind)}</td>
      <td>${a.kind === "credit" ? num(`accounts.${id}.remaining`, a.remaining, "any", "Credit left; 0 blocks the account") : ""}</td>
    </tr>`).join("");
  const iv = d.usage_watcher.intervals || {};
  $("#settings-body").innerHTML = `
    <h3 title="A disabled account takes every model on it out of every chain">Accounts</h3>
    <table><tbody>${accounts}</tbody></table>
    <h3 title="Which CLIs run on a subscription with usage windows (the Usage panel)">Subscriptions</h3>
    <p>${d.clis.map((c) => `<label><input type="checkbox" data-list="subscriptions" value="${esc(c)}"${
      d.subscriptions.includes(c) ? " checked" : ""}> ${esc(c)}</label>`).join(" ")}</p>
    <h3>Limits</h3>
    <dl class="kv">
      <dt title="Usage share at which a window counts as amber">Warn at</dt><dd>${num("limits.warn_at", d.limits.warn_at, "0.01", "0–1")}</dd>
      <dt title="Usage share at which a running worker hands off">Hand off at</dt><dd>${num("limits.handoff_at", d.limits.handoff_at, "0.01", "0–1")}</dd>
    </dl>
    <h3 title="OpenRouter's router proposes a model per prompt for these roles">Triage</h3>
    <dl class="kv">
      <dt>On</dt><dd>${check("triage.enabled", d.triage.enabled, "enabled")}</dd>
      <dt>Mode</dt><dd><select data-path="triage.mode">${["shadow", "active"].map((m) =>
        `<option${m === d.triage.mode ? " selected" : ""}>${m}</option>`).join("")}</select>
        <span class="muted">shadow = log only</span></dd>
      <dt>Active share</dt><dd>${num("triage.active_share", d.triage.active_share, "0.05", "Share of picks the router decides in active mode, 0–1")}</dd>
      <dt>Min confidence</dt><dd>${num("triage.min_confidence", d.triage.min_confidence, "0.05", "0–1")}</dd>
    </dl>
    <h3 title="How often the usage collector reads each subscription's limits">Usage watcher</h3>
    <dl class="kv">
      <dt>Tick (s)</dt><dd>${num("usage_watcher.tick_sec", d.usage_watcher.tick_sec, "1", "")}</dd>
      ${["idle_min", "active_min", "busy_min", "idle_heartbeat_hours"].map((k) =>
        `<dt>${k.replace(/_/g, " ")}</dt><dd>${num(`usage_watcher.intervals.${k}`, iv[k], "1", "")}</dd>`).join("")}
    </dl>`;
}

$("#settings-body").addEventListener("change", async (e) => {
  const el = e.target;
  let path = el.dataset.path;
  let value;
  if (el.dataset.list) {
    path = el.dataset.list;
    value = [...$("#settings-body").querySelectorAll(`[data-list="${path}"]:checked`)].map((x) => x.value);
  } else if (!path) {
    return;
  } else if (el.type === "checkbox") {
    value = el.checked;
  } else if (el.type === "number") {
    value = Number(el.value);
  } else {
    value = el.value;
  }
  const status = $("#settings-status");
  try {
    const res = await api("/api/settings", { method: "POST", body: JSON.stringify({ path, value }) });
    status.textContent = `${path} saved · backup ${res.backup}`;
    refreshRoles().catch(() => {});
  } catch (err) {
    status.textContent = `refused: ${err.message}`;
  }
  refreshSettings().catch(() => {});
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
  "panel-projects": "Repos in the collecting folder: branch, command policy, open sessions. Start opens a CLI session in the repo; Fix all / auto-fix write missing policies and approve the specialists there.",
  "panel-tim": "Open TIM tasks, ideas and bugs of every project in the folder. Start opens a session with the item as prompt.",
  "panel-roles": "Every role, the model `team-up pick` would choose right now, and the fallback chain behind it. ✎ edits a chain, ⇄ toggles triage routing, 📌 keeps the weekly score refresh off its head, ⬆ marks entries with a newer version available, ✗ entries the CLI no longer offers. Model tiers (for specialists) fold out below.",
  "panel-specialists": "One installed specialist: what it is for, its skills and assigned capability packages. Permissions, limits and approvals are under Details.",
  "panel-settings": "Roster switches: accounts on/off, subscriptions, limit thresholds, triage routing, usage watcher intervals. Every change is validated and backs up roster.json.",
  "panel-providers": "How each provider authenticates: an API key team-up holds, a CLI's own login, or a key the CLI keeps itself.",
  "panel-models": "The scored model catalogue (OpenRouter + benchmarks). Proposal shows where a model would beat a role's current head.",
  "panel-clis": "Installed agent CLIs: version, harness verification, update/install/login. Hover a CLI name for its path; click a row for the job log.",
};
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
  const hiddenCols = new Set(mine.cols || []);
  const hiddenRows = new Set(mine.rows || []);
  const list = (kind, items, hidden, label) => items.size
    ? `<label>${label}</label><div class="pref-list">${[...items.keys()].map((k) =>
      `<label><input type="checkbox" data-kind="${kind}" value="${esc(k)}"${hidden.has(k) ? "" : " checked"}> ${
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
  const hidden = (kind) => [...$("#panel-editor-items").querySelectorAll(`input[data-kind="${kind}"]:not(:checked)`)]
    .map((x) => x.value);
  savePanelEditor({ cols: hidden("cols"), rows: hidden("rows") });
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

function startPolling() {
  refreshSpecialists().catch(() => {});
  refreshTiers().catch(() => {});
  refreshSettings().catch(() => {});
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

// Panels live in the DOM while #app is hidden, so the layout wires up once
// here rather than in probe() — the login path never runs probe() again, and
// registering the drop handlers twice would undo every move.
applyLayout();
enableLayoutEditing();
enablePanelChrome();

probe();
