import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/dashboard/public/md.js"), "utf8"), ctx);
const md = vm.runInContext("renderMarkdown", ctx);

// The shape of a live question (run 20261014T213019Z-14uh, QUESTIONS.md).
const QUESTION = `# Sync topology — GRILL round 1 (cold context)

Entry identity is agreed: **global entry ID is the key**; project labels like \`P0063\` are display-only.

---

## Q1 — Who and what syncs live?

| # | Choice | Consequence |
|---|--------|-------------|
| 1 | Strato only until a second device exists | Smallest server work now; laptop later drives T10–T12 |
| 2 | Strato + one laptop (full replica) | Matches Sept audit; T03 owner + mirror path |

**Recommendation:** 2

1. **No — still building.** Stop implementation; keep \`sync.staging=false\`. *Low risk; no code churn.*
2. **Yes — server deployed.** Proceed with T10.
`;

test("a live question: headings demoted, bold, code, hr, a table and a numbered list", () => {
  const html = md(QUESTION);
  assert.match(html, /^<h3>Sync topology — GRILL round 1 \(cold context\)<\/h3>/);
  assert.match(html, /<strong>global entry ID is the key<\/strong>/);
  assert.match(html, /<code>P0063<\/code>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<h4>Q1 — Who and what syncs live\?<\/h4>/);
  assert.match(html, /<table><thead><tr><th>#<\/th><th>Choice<\/th><th>Consequence<\/th><\/tr><\/thead>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3, "header and two rows");
  assert.match(html, /<td>Strato \+ one laptop \(full replica\)<\/td>/);
  assert.match(html, /<p><strong>Recommendation:<\/strong> 2<\/p>/);
  assert.match(html, /<ol><li><strong>No — still building\.<\/strong> Stop implementation; keep <code>sync\.staging=false<\/code>\. <em>Low risk; no code churn\.<\/em><\/li><li>/);
});

test("identifiers keep their underscores and asterisks inside code stay literal", () => {
  assert.equal(md("Backend has todo_participants and profiles_shared."), "<p>Backend has todo_participants and profiles_shared.</p>");
  assert.equal(md("`a *b* c` and 2 * 3 * 4"), "<p><code>a *b* c</code> and 2 * 3 * 4</p>");
});

test("fenced code is escaped and kept verbatim; an unclosed fence runs to the end", () => {
  assert.equal(md("```js\nif (a < b) **x**\n```\nafter"), "<pre><code>if (a &lt; b) **x**</code></pre>\n<p>after</p>");
  assert.equal(md("```\n<b>open"), "<pre><code>&lt;b&gt;open</code></pre>");
});

test("lists: unordered, ordered with a start, continuation lines", () => {
  assert.equal(md("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(md("3. three\n   more\n4. four"), '<ol start="3"><li>three<br>more</li><li>four</li></ol>');
  assert.equal(md("2. **Slice** *safe for\n   step 7.*"), '<ol start="2"><li><strong>Slice</strong> <em>safe for<br>step 7.</em></li></ol>');
});

test("no raw HTML, no event handlers, no images", () => {
  const html = md('<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n![img](https://x/y.png)');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("links only for http(s), with noopener; javascript: stays text", () => {
  assert.equal(md("[docs](https://example.com/a?b=1&c=2)"),
    '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
  const js = md("[x](javascript:alert(1)) [y](data:text/html,hi)");
  assert.doesNotMatch(js, /<a /);
  assert.match(js, /\[x\]\(javascript:alert\(1\)\)/);
  const quoted = md('[x](https://e.com/"onmouseover="alert(1))');
  assert.doesNotMatch(quoted, /href="[^"]*"onmouseover/);
});

test("unclosed backticks and markers stay as text", () => {
  assert.equal(md("an `unclosed <b> tick"), "<p>an `unclosed &lt;b&gt; tick</p>");
  assert.equal(md("**not closed"), "<p>**not closed</p>");
});

test("a long body stays fast", () => {
  const big = `${"*a ".repeat(20000)}\n${"| x ".repeat(5000)}\n${"`".repeat(30000)}`;
  const start = Date.now();
  md(big);
  assert.ok(Date.now() - start < 1000);
});

test("hostile shapes stay linear: long space runs in a heading, a run of brackets", () => {
  for (const input of [`# a${" ".repeat(4000)}x`, `# a${" ".repeat(4000)}x`, "[".repeat(50000), "[x](https://".repeat(5000)]) {
    const start = performance.now();
    md(input);
    // Was 1–10 s before; the margin keeps a loaded test run from flaking.
    assert.ok(performance.now() - start < 250, `${JSON.stringify(input.slice(0, 12))}… took ${performance.now() - start} ms`);
  }
});

test("headings drop closing hashes; an image is its link; HTTPS in capitals links; NUL cannot spoof code", () => {
  assert.equal(md("## Title ##"), "<h4>Title</h4>");
  assert.equal(md("# C#"), "<h3>C#</h3>");
  assert.equal(md("![shot](https://e.com/a.png)"), '<p><a href="https://e.com/a.png" target="_blank" rel="noopener noreferrer">shot</a></p>');
  assert.match(md("[x](HTTPS://e.com)"), /<a href="HTTPS:\/\/e\.com"/);
  assert.equal(md("`a` \u00000\u0000"), "<p><code>a</code> 0</p>");
});
