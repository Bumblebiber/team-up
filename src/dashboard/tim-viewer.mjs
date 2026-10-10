// The TIM explorer tab: `tim viewer`, embedded through the dashboard.
//
// TIM owns the read (decision 2026-09-29): the dashboard never opens the TIM
// database. It starts TIM's own read-only viewer on a loopback port and
// forwards GET requests for the page and its read endpoints under
// /tim-viewer/, behind the dashboard's login. The viewer itself has no
// authentication, so it must never be reachable any other way — which is why
// only these paths pass, only GET, and the viewer binds 127.0.0.1.
// Not proxied: /api/mutate (tree edits) and /api/tool (MCP forwards).

import http from "node:http";
import { spawn } from "node:child_process";

export const PREFIX = "/tim-viewer";
const ALLOWED = new Set(["/", "/index.html", "/api/stats", "/api/projects", "/api/children", "/api/node", "/api/graph"]);
const READY = /→\s*http:\/\/127\.0\.0\.1:(\d+)\//;
const START_TIMEOUT_MS = 15_000;

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem;color:#555}@media(prefers-color-scheme:dark){body{background:#16181d;color:#aaa}}code{font-size:.9em}</style>
<h2>${title}</h2><p>${body}</p>`;

/**
 * `{ handle(req, res, subpath), stop() }`. The viewer starts on the first
 * request and is restarted if it dies. `timCmd` is argv; TIM_CMD overrides
 * it the same way scripts/usage-spender.py does.
 */
export function createTimViewerProxy({ env = process.env, spawnFn = spawn, timCmd = (env.TIM_CMD || "tim").split(/\s+/) } = {}) {
  let child = null;
  let ready = null;

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const proc = spawnFn(timCmd[0], [...timCmd.slice(1), "viewer", "--host", "127.0.0.1", "--port", "0"], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      child = proc;
      let out = "";
      const timer = setTimeout(() => fail(new Error("tim viewer did not start in time")), START_TIMEOUT_MS);
      const fail = (err) => {
        clearTimeout(timer);
        if (child === proc) {
          child = null;
          ready = null;
        }
        try {
          proc.kill();
        } catch { /* already gone */ }
        reject(err);
      };
      proc.on("error", (e) => fail(e.code === "ENOENT" ? new Error("TIM is not installed (no `tim` on PATH)") : e));
      proc.on("exit", (code) => {
        if (child === proc) {
          child = null;
          ready = null;
        }
        fail(new Error(`tim viewer exited (${code})${out ? `: ${out.trim().split("\n").at(-1)}` : ""}`));
      });
      const onData = (chunk) => {
        out = `${out}${chunk}`.slice(-4000);
        const m = out.match(READY);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      };
      proc.stdout.setEncoding("utf8").on("data", onData);
      proc.stderr.setEncoding("utf8").on("data", (c) => { out = `${out}${c}`.slice(-4000); });
    });
    return ready;
  }

  function forward(port, req, res, subpath, search) {
    return new Promise((resolve) => {
      const upstream = http.request({
        host: "127.0.0.1", port, method: "GET", path: `${subpath}${search}`,
        headers: { accept: req.headers.accept || "*/*" },
      }, (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          let body = Buffer.concat(chunks);
          const type = String(up.headers["content-type"] || "");
          // An older TIM serves a page that fetches /api/… from the root — the
          // dashboard's own API, not the viewer's. Say so instead of breaking.
          if (type.startsWith("text/html") && !body.includes("api/graph")) {
            body = Buffer.from(page("TIM explorer needs a newer TIM",
              "The installed <code>tim viewer</code> cannot be embedded yet. Update TIM (the viewer with the graph view), then reload this tab."));
          }
          res.writeHead(up.statusCode || 502, {
            "Content-Type": type || "application/octet-stream",
            "Cache-Control": "no-store",
            "X-Frame-Options": "SAMEORIGIN",
            ...(up.headers["content-security-policy"] ? { "Content-Security-Policy": up.headers["content-security-policy"] } : {}),
          });
          res.end(body);
          resolve();
        });
      });
      upstream.on("error", () => {
        res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("TIM viewer unreachable", "It may have just restarted — reload this tab."));
        resolve();
      });
      upstream.end();
    });
  }

  return {
    async handle(req, res, subpath, search = "") {
      if (req.method !== "GET" || !ALLOWED.has(subpath)) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not available through the dashboard" }));
        return;
      }
      let port;
      try {
        port = await start();
      } catch (e) {
        res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("TIM explorer unavailable", String(e.message || e).replace(/[<>&]/g, "")));
        return;
      }
      await forward(port, req, res, subpath, search);
    },
    stop() {
      try {
        child?.kill();
      } catch { /* already gone */ }
      child = null;
      ready = null;
    },
  };
}
