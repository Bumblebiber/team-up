import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import {
  listClaudeSessions,
  stopClaudeSession,
  sendClaudeMessage,
} from "../../src/dashboard/claude-sessions.mjs";

/** A ~/.claude/sessions registry and a fake /proc in one temp dir. */
function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-claude-"));
  const sessions = path.join(root, "sessions");
  const procRoot = path.join(root, "proc");
  fs.mkdirSync(sessions);
  for (const { registry, stat } of entries) {
    fs.writeFileSync(path.join(sessions, `${registry.pid}.json`), JSON.stringify(registry));
    if (stat !== undefined) {
      fs.mkdirSync(path.join(procRoot, String(registry.pid)), { recursive: true });
      // A command name with a space and a paren, as `comm` may be.
      const fields = ["S", ...Array.from({ length: 18 }, () => "0"), stat, "0"];
      fs.writeFileSync(path.join(procRoot, String(registry.pid), "stat"), `${registry.pid} (2.1.2 9) ${fields.join(" ")}\n`);
    }
  }
  return { root, sessions, procRoot, env: { CLAUDE_CONFIG_DIR: root } };
}

test("only sessions whose process still runs are listed", () => {
  const f = fixture([
    { registry: { pid: 10, procStart: "500", name: "live", tmux: "moonlight:@1.%1", peerProtocol: 1, messagingSocketPath: "/s", updatedAt: 1 }, stat: "500" },
    { registry: { pid: 11, procStart: "500", name: "pid reused" }, stat: "999" },
    { registry: { pid: 12, procStart: "500", name: "exited" } },
    { registry: { pid: 13, procStart: "700", name: "no inbox", entrypoint: "claude-desktop", updatedAt: 2 }, stat: "700" },
  ]);
  const list = listClaudeSessions({ env: f.env, procRoot: f.procRoot });
  assert.deepEqual(list.map((s) => s.name), ["no inbox", "live"]);
  assert.equal(list[1].tmux, "moonlight");
  assert.equal(list[1].socket, "/s");
  assert.equal(list[0].socket, null);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("stop signals a live session and nothing else", () => {
  const f = fixture([{ registry: { pid: 10, procStart: "500" }, stat: "500" }]);
  const kills = [];
  const kill = (pid, sig) => kills.push([pid, sig]);
  assert.equal(stopClaudeSession(10, { env: f.env, procRoot: f.procRoot, kill }).ok, true);
  assert.equal(stopClaudeSession(99, { env: f.env, procRoot: f.procRoot, kill }).status, 404);
  assert.deepEqual(kills, [[10, "SIGTERM"]]);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("a message goes to the inbox as an auth line and a user line", async () => {
  const f = fixture([]);
  const socket = path.join(f.root, "10.sock");
  fs.writeFileSync(path.join(f.sessions, "10.json"), JSON.stringify({
    pid: 10, procStart: "500", peerProtocol: 1, messagingSocketPath: socket,
  }));
  fs.mkdirSync(path.join(f.procRoot, "10"), { recursive: true });
  fs.writeFileSync(path.join(f.procRoot, "10", "stat"), `10 (claude) S ${"0 ".repeat(18)}500 0\n`);
  const hash = crypto.createHash("sha256").update(socket).digest("hex");
  fs.writeFileSync(path.join(f.sessions, `10.${hash}.key`), JSON.stringify({ peerToken: "a".repeat(32) }));

  let received = "";
  const server = net.createServer((c) => c.on("data", (d) => { received += d; }));
  await new Promise((r) => server.listen(socket, r));
  const result = await sendClaudeMessage(10, "status?", { env: f.env, procRoot: f.procRoot });
  server.close();

  assert.equal(result.ok, true);
  const [auth, user] = received.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(auth, { type: "auth", token: "a".repeat(32) });
  assert.equal(user.type, "user");
  assert.equal(user.message.content, "status?");
  assert.equal((await sendClaudeMessage(99, "x", { env: f.env, procRoot: f.procRoot })).status, 404);
  fs.rmSync(f.root, { recursive: true, force: true });
});
