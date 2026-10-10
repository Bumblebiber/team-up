import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createTimViewerProxy } from "../../src/dashboard/tim-viewer.mjs";

// A stand-in `tim viewer`: a real loopback server, announced the way the CLI does.
function fakeViewer(html) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'" });
      res.end(html);
    }
  });
  let spawned = 0;
  const spawnFn = (cmd, args) => {
    spawned++;
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => upstream.close();
    upstream.listen(0, "127.0.0.1", () => {
      proc.stdout.write(`TIM viewer (read-only) → http://127.0.0.1:${upstream.address().port}/\n`);
    });
    proc.args = [cmd, ...args];
    return proc;
  };
  return { seen, spawnFn, spawned: () => spawned };
}

function capture() {
  const res = { status: 0, headers: {}, body: "" };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; };
  res.end = (body = "") => { res.body = String(body); };
  return res;
}

test("forwards GET for the page and read endpoints only, starting the viewer once", async () => {
  const v = fakeViewer("<html>fetch('api/graph')</html>");
  const proxy = createTimViewerProxy({ spawnFn: v.spawnFn, timCmd: ["tim"] });
  const page = capture();
  await proxy.handle({ method: "GET", headers: {} }, page, "/", "?embed=1");
  assert.equal(page.status, 200);
  assert.match(page.body, /api\/graph/);
  assert.equal(page.headers["X-Frame-Options"], "SAMEORIGIN");
  const graph = capture();
  await proxy.handle({ method: "GET", headers: {} }, graph, "/api/graph", "?root=P0073");
  assert.equal(graph.body, '{"ok":true}');
  assert.deepEqual(v.seen, ["GET /?embed=1", "GET /api/graph?root=P0073"]);
  assert.equal(v.spawned(), 1);

  for (const [method, sub] of [["POST", "/api/mutate"], ["GET", "/api/mutate"], ["GET", "/api/tool"], ["GET", "/etc/passwd"]]) {
    const res = capture();
    await proxy.handle({ method, headers: {} }, res, sub, "");
    assert.equal(res.status, 404, `${method} ${sub}`);
  }
  assert.equal(v.seen.length, 2, "nothing else reached the viewer");
  proxy.stop();
});

test("an older viewer that fetches from the root is replaced by an explanation", async () => {
  const v = fakeViewer("<html>fetch('/api/stats')</html>");
  const proxy = createTimViewerProxy({ spawnFn: v.spawnFn, timCmd: ["tim"] });
  const res = capture();
  await proxy.handle({ method: "GET", headers: {} }, res, "/", "");
  assert.match(res.body, /needs a newer TIM/);
  proxy.stop();
});

test("no tim on PATH answers 503 with a reason", async () => {
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {};
    setImmediate(() => proc.emit("error", Object.assign(new Error("spawn tim ENOENT"), { code: "ENOENT" })));
    return proc;
  };
  const proxy = createTimViewerProxy({ spawnFn, timCmd: ["tim"] });
  const res = capture();
  await proxy.handle({ method: "GET", headers: {} }, res, "/", "");
  assert.equal(res.status, 503);
  assert.match(res.body, /not installed/);
});
