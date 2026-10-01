// strip-ansi.mjs — shared PTY transcript cleanup for the /usage collectors.

/**
 * Remove terminal control sequences from a PTY transcript.
 *
 * Every collector needs this and the reason is not cosmetic: the CLIs render
 * their usage panels with per-row colour, so a row-anchored regex like
 * `/^\s*Auto\s+\d+%/m` sees an escape sequence where it expects whitespace and
 * silently matches nothing. That is how the cursor collector reported one of
 * its three rows for weeks — the fixture it was tested against had already
 * been stripped by hand.
 */
export function stripAnsi(text) {
  return fillSkippedCells(String(text))
    // Cursor moves stand in for the blanks they skip: codex repaints its
    // /status panel in place (`(resets\e[25;72H01:55`), and deleting the move
    // glues the words together so no row parses.
    .replace(/\x1b\[[0-9;]*[HfCG]/g, " ")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\r/g, "");
}

const WIDE_RE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Emoji_Presentation}/u;
const ZERO_WIDTH_RE = /[\p{M}​-‏︎️]/u;
const TOKEN_RE =
  /\x1b\[([?<>=]?)([0-9;]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][AB012]|\x1b\\|\x1b[^[\]]|[\s\S]/gu;

/**
 * Put back the cells a diff renderer skipped. codex repaints /status over its
 * "Limits: refresh requested" placeholder and jumps the cursor over every cell
 * that already holds the right character: `(\e[25;67Hesets` — the "r" of
 * "resets" was left over from "…run /status again shortly". A space there
 * breaks the row (codex 0.157 lost its 5h window that way), and a
 * skipped digit (`\e[..H9%` over an old "9") would read 99% left as 9%.
 *
 * Tracks a grid of the cells this transcript wrote and, when a same-row forward
 * move skips a written non-blank cell, emits those cells instead of the move.
 * Anything it does not model (scrolling, insert/delete, unknown escapes) drops
 * the grid, so the move falls back to the plain blank stripAnsi always used.
 * ponytail: no autowrap and no bottom-of-screen scroll; a newline drops the grid.
 */
function fillSkippedCells(text) {
  let grid = new Map();
  let row = 0;
  let col = 0;
  let known = true; // cursor position is trustworthy
  const line = (r) => {
    if (!grid.has(r)) grid.set(r, []);
    return grid.get(r);
  };
  const forget = () => {
    grid = new Map();
    known = false;
  };
  const skipTo = (target, seq) => {
    const cells = known ? line(row).slice(col, target) : [];
    col = target;
    if (!cells.some((c) => c && c.trim())) return seq;
    return Array.from({ length: cells.length }, (_, i) => cells[i] ?? " ").join("");
  };

  return text.replace(TOKEN_RE, (tok, priv, params, final) => {
    if (final !== undefined) {
      const p = params.split(";").map((n) => Number(n) || 0);
      if (priv) {
        // Alternate-screen switches start from a blank (or unknown) screen.
        if (/^(1049|1047|47)$/.test(params) && (final === "h" || final === "l")) grid = new Map();
        return tok;
      }
      switch (final) {
        case "H":
        case "f": {
          const r = (p[0] || 1) - 1;
          const c = (p[1] || 1) - 1;
          if (known && r === row && c > col) return skipTo(c, tok);
          row = r;
          col = c;
          known = true;
          return tok;
        }
        case "C":
          return known ? skipTo(col + (p[0] || 1), tok) : tok;
        case "G":
          if (known && (p[0] || 1) - 1 > col) return skipTo((p[0] || 1) - 1, tok);
          col = (p[0] || 1) - 1;
          return tok;
        case "K":
          if (!known) grid = new Map();
          else if (p[0] === 0) line(row).length = col;
          else if (p[0] === 1) line(row).fill(undefined, 0, col + 1);
          else grid.delete(row);
          return tok;
        case "J":
          if (!known || p[0] !== 0) grid = new Map();
          else {
            line(row).length = col;
            for (const r of grid.keys()) if (r > row) grid.delete(r);
          }
          return tok;
        case "m":
        case "n":
        case "c":
        case "q":
        case "t":
          return tok;
        default:
          forget();
          return tok;
      }
    }
    if (tok[0] === "\x1b") {
      if (tok[1] === "]" || tok[1] === "(" || tok[1] === ")" || tok[1] === "\\") return tok;
      forget();
      return tok;
    }
    if (tok === "\r") col = 0;
    else if (tok === "\n") {
      grid = new Map();
      row += 1;
    } else if (tok === "\b") col = Math.max(0, col - 1);
    else if (tok === "\t") col = (Math.floor(col / 8) + 1) * 8;
    else if (tok >= " " && known && !ZERO_WIDTH_RE.test(tok)) {
      const cells = line(row);
      cells[col++] = tok;
      if (WIDE_RE.test(tok)) cells[col++] = "";
    }
    return tok;
  });
}
