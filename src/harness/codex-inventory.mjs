import http from "node:http";
import { spawn } from "node:child_process";

/**
 * Extract model-visible tool names from a Codex Responses API request body.
 * Code-mode models expose nested tools as `### \`name\`` headings on `exec`.
 */
export function parseCodexResponsesToolInventory(requestBody) {
  const body =
    typeof requestBody === "string" ? JSON.parse(requestBody) : requestBody ?? {};
  const names = [];
  const tools = body.tools ?? [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.name) names.push(tool.name);
    if (tool.type === "function" && tool.function?.name) {
      names.push(tool.function.name);
    }
    const desc = tool.description ?? tool.function?.description ?? "";
    if (typeof desc === "string" && desc.includes("### `")) {
      const re = /###\s*`([^`]+)`/g;
      let m;
      while ((m = re.exec(desc))) {
        names.push(m[1]);
      }
    }
  }
  return [...new Set(names.filter(Boolean))];
}

function minimalResponsesSse() {
  return [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"probe","status":"in_progress"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","id":"msg_probe","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"probe","status":"completed"}}\n\n',
  ].join("");
}

/**
 * Run `codex exec` against a local fake Responses server and return tool names
 * from the first POST `/v1/responses` body (no API billing).
 */
export function captureCodexToolInventory({
  codexHome,
  model = "gpt-5-codex",
  spawnFn = spawn,
  port = 0,
  host = "127.0.0.1",
} = {}) {
  if (!codexHome) throw new Error("codexHome required");
  let capturedBody = null;
  let child = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (req.method === "POST" && /\/v1\/responses/.test(req.url ?? "")) {
        capturedBody = raw;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "close",
      });
      res.end(minimalResponsesSse());
      if (capturedBody && child) {
        setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        }, 200);
      }
    });
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGTERM");
      } catch {
        // ignore
      }
      server.close();
      reject(new Error("codex inventory probe timed out waiting for /v1/responses"));
    }, 90_000);

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      const listenPort = typeof addr === "object" && addr ? addr.port : port;
      const baseUrl = `http://${host}:${listenPort}/v1`;
      const argv = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--strict-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "-c",
        "model_provider=teamup_probe",
        "-c",
        `model_providers.teamup_probe={name="teamup_probe",base_url="${baseUrl}",wire_api="responses",env_key="FAKE_KEY"}`,
        "-m",
        model,
        "--disable",
        "shell_tool",
        "inventory probe",
      ];
      child = spawnFn("codex", argv, {
        env: { ...process.env, FAKE_KEY: "x", CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        server.close();
        reject(e);
      });
      child.on("close", () => {
        clearTimeout(timer);
        server.close(() => {
          if (!capturedBody) {
            reject(new Error("codex inventory probe saw no /v1/responses body"));
            return;
          }
          try {
            resolve(parseCodexResponsesToolInventory(capturedBody));
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  });
}
