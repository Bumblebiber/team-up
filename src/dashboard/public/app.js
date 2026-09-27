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
    <div class="usage-row"${providerAttr(key)}>
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

async function refreshPick() {
  const data = await api("/api/pick");
  const rows = data.picks.map((p) => `
    <tr${providerAttr(p.cli, p.model)}>
      <td>${esc(p.role)}</td>
      <td>${p.model ? esc(`${p.cli}:${p.model}`) : "<em>exhausted</em>"}</td>
      <td>${esc(p.effort || "—")}</td>
      <td class="skipped">${p.skipped.map((s) => esc(`${s.model}: ${s.reason}`)).join("<br>")}</td>
    </tr>`).join("");
  $("#pick-table").innerHTML = `<table>
    <thead><tr><th>Role</th><th>Pick</th><th>Effort</th><th>Skipped</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No roles</td></tr>'}</tbody></table>`;
}

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
    let body = `<div class="provider-card"${providerAttr(p.id)}><strong>${esc(p.id)}</strong> ${providerStatus(p)}`;
    if (p.class === "A" && p.writable) {
      body += `<form class="provider-form" data-id="${esc(p.id)}">
        <input type="password" name="key" placeholder="OpenRouter API key" autocomplete="off">
        <button type="submit">${p.configured ? "Rotate" : "Connect"}</button>
        ${p.configured ? '<button type="button" class="remove-key">Remove</button>' : ""}
        <button type="button" class="validate-key">Validate</button>
      </form>`;
    } else if (p.class === "A" && p.configured) {
      body += `<p class="muted">Read-only (${esc(p.source || "external")}) · ${esc(p.hint || "")}</p>`;
    } else if (p.login_command) {
      body += `<p class="muted mono">${esc(p.login_command)}</p>`;
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
      <td>${esc(m.model)}</td>
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
    } else if (c.install_disabled_reason) {
      actions.push(`<span class="muted">${esc(c.install_disabled_reason)}</span>`);
    }
    if (c.login_available) {
      actions.push(`<button type="button" class="cli-login" data-cli="${esc(c.cli)}">Start login</button>`);
    }
    return `
    <tr class="clickable ${selectedCli === c.cli ? "selected" : ""}" data-cli="${esc(c.cli)}"${providerAttr(c.cli)}>
      <td>${esc(c.cli)}</td>
      <td>${c.present ? '<span class="badge ok">installed</span>' : '<span class="badge stale">missing</span>'}</td>
      <td class="mono">${esc(c.version || "—")}</td>
      <td>${esc(c.harness_label || c.harness?.status || "—")}</td>
      <td>${verdictBadge(c.post_update_verdict)}</td>
      <td>${esc(state)}</td>
      <td class="path">${esc(c.path || "—")}</td>
      <td>${actions.join(" ")}</td>
    </tr>`;
  }).join("");
  $("#clis-table").innerHTML = `<table>
    <thead><tr><th>CLI</th><th>Present</th><th>Version</th><th>Harness</th><th>Verify</th><th>Job</th><th>Path</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8">No CLIs</td></tr>'}</tbody></table>`;
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

function specialistSource(entry) {
  const provides = entry.provides || {};
  const gives = ["skills", "plugins", "mcps", "frameworks"]
    .flatMap((kind) => (provides[kind] || []).map((v) => `${kind.replace(/s$/, "")}: ${v}`));
  return `<li>
    <strong>${esc(entry.display_name)}</strong>
    <span class="muted">${esc(entry.package)} · ${esc(entry.checksum)} · ${esc(entry.reason)}</span>
    <button type="button" class="capability-remove"
      data-package="${esc(entry.package)}" data-checksum="${esc(entry.checksum_full)}">Remove</button>
    <div>${chips(gives)}</div>
  </li>`;
}

function renderSpecialist() {
  const body = $("#specialist-detail");
  const id = $("#specialist-select").value;
  const s = (specialistsData?.specialists || []).find((item) => item.id === id);
  if (!s) {
    body.innerHTML = '<p class="muted">No specialist installed.</p>';
    return;
  }
  const perms = s.permissions || {};
  const budget = s.budget || {};
  body.innerHTML = `
    <p class="muted">${esc(s.id)} · v${esc(s.version)} · ${esc(s.checksum)}</p>
    ${
      (s.versions || []).length > 1
        ? `<p class="muted">Selected version:
            ${s.versions.map((v) => `
              <button type="button" class="version-pin" data-version="${esc(v.version)}"
                ${v.selected ? "disabled" : ""}>${esc(v.version)}${v.selected ? " ✓" : ""}</button>`).join(" ")}
          </p>`
        : ""
    }
    ${s.error ? `<p class="error">${esc(s.error)}</p>` : ""}
    <h3>Remit</h3>
    <ul class="remit">${(s.remit || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <h3>Never</h3>
    <ul class="anti-remit">${(s.anti_remit || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <h3>Bundled in the package</h3>
    <dl class="kv">
      <dt>Skills</dt><dd>${chips(s.bundled?.skills)}</dd>
      <dt>MCPs</dt><dd>${chips(s.bundled?.mcps)}</dd>
      <dt>Tools</dt><dd>${chips(s.bundled?.tools)}</dd>
      <dt>Frameworks</dt><dd>${chips(s.bundled?.frameworks)}</dd>
    </dl>
    <h3>Assigned capability packages</h3>
    <ul class="assigned">${
      (s.assigned || []).map(specialistSource).join("") ||
      '<li class="muted">none assigned</li>'
    }</ul>
    ${
      s.exclusions?.length
        ? `<p class="muted">Excluded: ${s.exclusions.map((e) => esc(`${e.package} (${e.reason})`)).join(", ")}</p>`
        : ""
    }
    <h3>Permissions</h3>
    <dl class="kv">
      <dt>Filesystem</dt><dd>${esc(perms.filesystem || "—")}</dd>
      <dt>Writes</dt><dd>${perms.writes ? "yes" : "no"}</dd>
      <dt>Network</dt><dd>${perms.network ? "yes" : "no"}</dd>
      <dt>Commands</dt><dd>${chips(perms.commands)}</dd>
      <dt>Call types</dt><dd>${chips(s.call_types)}</dd>
      <dt>Timeout</dt><dd>${budget.timeout_seconds ? esc(`${budget.timeout_seconds}s`) : "—"}</dd>
    </dl>
    <h3>Approved for</h3>
    ${
      s.approved_for?.length
        ? `<ul class="approved">${s.approved_for.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>`
        : '<p class="muted">No project has approved this version.</p>'
    }`;
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

// ── Panel layout ──────────────────────────────────────────────────────────
// Panels live in columns the script builds, not in the markup: the number of
// columns is the user's choice. Each column is its own flex container, so it
// stacks independently and a tall panel in one leaves no gap in the next.
// Order comes from dragging a panel by its <h2>, size from the browser's
// native resize handle. All of it is per-browser preference, so localStorage
// is the right home for it.
const LAYOUT_KEY = "teamup.layout";
const MAX_COLUMNS = 6;
// What a fresh browser gets: the narrow-content panels left, the wide ones right.
const DEFAULT_COLUMNS = [
  ["panel-usage", "panel-tmux", "panel-projects", "panel-specialists", "panel-setup"],
  ["panel-runs", "panel-pick"],
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
    if (panel.style.width || panel.style.height) {
      size[panel.id] = { w: panel.style.width, h: panel.style.height };
    }
  }
  const order = columns().map((column) =>
    [...column.querySelectorAll(".panel")].map((p) => p.id));
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ order, size }));
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
  for (const panel of [...mainEl.children].filter((el) => el.classList.contains("panel"))) {
    if (!placed.has(panel.id)) built[0].append(panel);
  }

  for (const [id, size] of Object.entries(layout.size || {})) {
    const panel = document.getElementById(id);
    if (!panel) continue;
    if (size.w) panel.style.width = size.w;
    if (size.h) panel.style.height = size.h;
  }
}

// A resize writes both width and height, so a panel dragged into another
// column would carry the old column's pixel width with it. Height is the
// user's choice and stays.
function movePanel(panel, place) {
  const from = panel.parentElement;
  place(panel);
  if (panel.parentElement !== from) panel.style.width = "";
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

  // The native resize handle sets inline width/height and fires no event of its
  // own; a pointerup anywhere is the cheapest "the drag is over" signal.
  document.addEventListener("pointerup", () => {
    const layout = readLayout();
    const changed = panels().some((panel) => {
      const saved = layout.size?.[panel.id] || {};
      return panel.style.width !== (saved.w || "") || panel.style.height !== (saved.h || "");
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
    } catch {
      // Nothing stored means nothing to clear.
    }
    for (const panel of panels()) {
      panel.style.width = "";
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
  status.textContent = data.dir;
  if (!$("#projects-dir").value) $("#projects-dir").value = dir || data.dir;

  const cliSel = $("#projects-cli");
  const selected = cliSel.value;
  const options = (data.clis || []).map((c) => `<option>${esc(c)}</option>`).join("");
  if (cliSel.innerHTML !== options) cliSel.innerHTML = options;
  if (selected && (data.clis || []).includes(selected)) cliSel.value = selected;

  const rows = data.projects.map((p) => `
    <tr>
      <td>${esc(p.name)}${p.dirty ? " <span class=\"muted\">*</span>" : ""}</td>
      <td>${esc(p.git ? (p.branch || "detached") : "—")}</td>
      <td>${p.sessions.map((s) => `<a href="#" class="session-link" data-session="${esc(s)}">${esc(s.replace(/^team-up-proj-/, ""))}</a>`).join(" ") || "—"}</td>
      <td><button type="button" class="project-start" data-dir="${esc(p.path)}">Start</button></td>
    </tr>`).join("");
  $("#projects-table").innerHTML = `<table>
    <thead><tr><th>Project</th><th>Branch</th><th>Sessions</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No projects</td></tr>'}</tbody></table>`;

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
}

$("#projects-dir").addEventListener("change", () => {
  try {
    localStorage.setItem(PROJECTS_DIR_KEY, $("#projects-dir").value.trim());
  } catch {
    // Private mode: the folder just stops surviving reloads.
  }
  refreshProjects().catch(() => {});
});

function refreshAll() {
  return Promise.allSettled([
    refreshUsage(),
    refreshRuns(),
    refreshTmux(),
    refreshProjects(),
    refreshPick(),
    refreshSetup(),
  ]);
}

function startPolling() {
  refreshSpecialists().catch(() => {});
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

// Panels live in the DOM while #app is hidden, so the layout wires up once
// here rather than in probe() — the login path never runs probe() again, and
// registering the drop handlers twice would undo every move.
applyLayout();
enableLayoutEditing();

probe();
