// Markdown an agent wrote (a question, a task, a result) as safe HTML. A
// classic script loaded before app.js; it adds one global, renderMarkdown.
//
// Everything is escaped first; the only tags in the output are the ones made
// here: headings (h1 becomes h3, the page owns h1 and h2), bold, italic,
// inline code, fenced code, ordered and unordered lists, tables with a
// separator row, hr and paragraphs. No raw HTML, no images (one becomes its
// link); a link only when it is http(s), opening in a new tab without an opener.
// ponytail: flat lists, no blockquotes or nesting; add when agents write them.

// eslint-disable-next-line no-unused-vars
const renderMarkdown = (() => {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function inline(text) {
    // Code spans first, so nothing inside them is formatted; an unclosed backtick stays a backtick.
    // \u0000 marks a code span below; the agent's own would pull in another span's text.
    const codes = [];
    let s = escape(text.replace(/\u0000/g, "")).replace(/`([^`\n]+)`/g, (m, code) => `\u0000${codes.push(code) - 1}\u0000`);
    // Bounded and without "[" in the label, so a run of brackets stays linear. An image is its link.
    s = s.replace(/!?\[([^[\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/gi,
      (m, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    // No `_` emphasis: identifiers like todo_participants are everywhere in agent text.
    // A list item's continuation lines arrive joined by \n, so emphasis may span them.
    s = s.replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([\p{L}\p{N}](?:[^*]*?[\p{L}\p{N}.)!?])?)\*(?![*\w])/gu, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[i]}</code>`);
  }

  const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
  // Linear on purpose: a lazy text before optional closing #s backtracks cubically on long space runs.
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
  const isTable = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("|")
    && TABLE_SEP.test(lines[i + 1]);
  const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i])
    || ITEM.test(lines[i]) || isTable(lines, i);

  return function renderMarkdown(src) {
    const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = line.match(FENCE);
      if (fence) {
        const body = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
        i++; // the closing fence; an unclosed one runs to the end
        out.push(`<pre><code>${escape(body.join("\n"))}</code></pre>`);
        continue;
      }
      const heading = line.match(HEADING);
      if (heading) {
        const level = Math.min(heading[1].length + 2, 6);
        const text = heading[2].trimEnd().replace(/(?:^|\s)#+$/, "").trimEnd();
        out.push(`<h${level}>${inline(text)}</h${level}>`);
        i++;
        continue;
      }
      if (RULE.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (isTable(lines, i)) {
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
        const row = (r, tag) => `<tr>${head.map((h, c) => `<${tag}>${inline(r[c] ?? "")}</${tag}>`).join("")}</tr>`;
        out.push(`<div class="md-table"><table><thead>${row(head, "th")}</thead><tbody>${rows.map((r) => row(r, "td")).join("")}</tbody></table></div>`);
        continue;
      }
      const item = line.match(ITEM);
      if (item) {
        const ordered = /\d/.test(item[1]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(ITEM);
          if (m && /\d/.test(m[1]) === ordered) items.push(m[2]);
          else if (!m && lines[i].trim() && /^\s/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`;
          else break;
          i++;
        }
        const start = ordered ? parseInt(item[1], 10) : 1;
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag}${start !== 1 ? ` start="${start}"` : ""}>${items.map((t) => `<li>${inline(t).replace(/\n/g, "<br>")}</li>`).join("")}</${tag}>`);
        continue;
      }
      const para = [];
      for (; i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines, i)); i++) para.push(lines[i].trim());
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return out.join("\n");
  };
})();
