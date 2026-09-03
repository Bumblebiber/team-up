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
  return String(text)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\r/g, "");
}
