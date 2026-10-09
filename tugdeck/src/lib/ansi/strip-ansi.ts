/**
 * `stripAnsi` — remove ANSI escape sequences from text, purely.
 *
 * The transcript search index projects shell / terminal output as plain
 * text; the DOM side renders the same bytes through `ansiToHtml` (ANSI →
 * styled spans), whose `textContent` is the input minus the escape
 * sequences. This stripper is the index-side mirror: same bytes in, same
 * visible text out — no DOM, no `AnsiUp` instance, safe in pure unit tests.
 *
 * The pattern covers the escape families terminals emit in practice: CSI
 * sequences (`ESC [ params final` — colors, cursor movement, including the
 * single-byte CSI `U+009B` form), OSC sequences (`ESC ] … BEL` /
 * `ESC ] … ESC \` — titles, hyperlinks), and lone two-character escapes.
 *
 * @module lib/ansi/strip-ansi
 */

const ANSI_PATTERN = new RegExp(
  [
    // OSC: ESC ] … terminated by BEL or ST (ESC \).
    "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)",
    // CSI: ESC [ (or single-byte CSI) params/intermediates + final byte.
    "[\\u001b\\u009b]\\[[0-9;?]*[ -/]*[@-~]",
    // Other escapes: ESC + intermediates + one final byte (e.g. ESC c,
    // ESC =, ESC 7). Ordered AFTER the CSI/OSC alternatives, which
    // consume their longer forms first.
    "\\u001b[ -/]*[0-~]",
  ].join("|"),
  "g",
);

/** Remove ANSI escape sequences, returning the visible text. */
export function stripAnsi(text: string): string {
  if (text.indexOf("\u001b") === -1 && text.indexOf("\u009b") === -1) {
    return text;
  }
  return text.replace(ANSI_PATTERN, "");
}
