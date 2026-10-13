/**
 * `ansiToHtml` — convert ANSI-escaped text into sanitized HTML.
 *
 * Per [D06], ANSI parsing stays in JS (`ansi_up`); the input scale
 * never reaches the threshold where WASM would earn its build/init
 * cost. This module is a thin wrapper that:
 *
 *   1. Runs the input through `ansi_up.ansi_to_html()` in
 *      `use_classes` mode so 16-color SGR codes emit
 *      `class="ansi-{color}-fg|bg"` markup that the
 *      `--tugx-term-ansi-*` token slots can theme. (256-color and
 *      truecolor still emit inline `style="color:rgb(…)"` because
 *      `ansi_up` does not class-encode them; those code paths
 *      bypass the theme but are rare enough in real CC output that
 *      the audit treats them as out-of-scope for v1.)
 *   2. Sanitizes the result via DOMPurify with a strict allowlist
 *      (`span`, `br`, `class`, `style`). The input text is already
 *      HTML-escaped by `ansi_up` before any styling is applied, so
 *      `style` attributes can only carry the small vocabulary
 *      `ansi_up` emits (`font-weight`, `text-decoration`,
 *      `color:rgb(…)`, `background-color:rgb(…)`). DOMPurify's
 *      built-in CSS-property allowlist handles the rest.
 *
 * The function creates a fresh `AnsiUp` instance per call so the
 * SGR parser starts from a clean state — `TerminalBlock` re-parses
 * the full retained buffer on every streaming delta, so persistent
 * parser state across calls would only confuse the picture.
 *
 * Laws:
 *  - [L21] license — `ansi_up` is MIT-licensed; safe to vendor.
 */

import { AnsiUp } from "ansi_up";

import { getPlainDOMPurify } from "../markdown/dompurify-instance";

/**
 * DOMPurify config scoped to the `ansi_up` output vocabulary.
 *
 * `ansi_up` emits exactly two element shapes:
 *   - `<span class="ansi-…">…</span>` (16-color SGR)
 *   - `<span style="font-weight:bold|text-decoration:underline|
 *      color:rgb(…)|background-color:rgb(…)">…</span>` (bold /
 *      underline / 256-color / truecolor)
 *
 * The allowlist mirrors that vocabulary exactly — anything else gets
 * stripped. `style` is allowed but DOMPurify's built-in CSS-property
 * allowlist still vets the property names, so a future `ansi_up`
 * version that adds support for risky styles would not silently
 * ride through here without an opt-in.
 */
const ANSI_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["span", "br"],
  ALLOWED_ATTR: ["class", "style"],
};

/**
 * Convert ANSI-escaped text to sanitized HTML.
 *
 * Empty / non-string input returns `""`. The resulting string is
 * safe to assign to `Element.innerHTML` — `ansi_up` HTML-escapes
 * the source text before injecting any markup, then DOMPurify
 * narrows the surface to the SGR vocabulary above.
 */
export function ansiToHtml(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const ansiUp = new AnsiUp();
  ansiUp.use_classes = true;
  const raw = ansiUp.ansi_to_html(text);
  const sanitized = getPlainDOMPurify().sanitize(raw, ANSI_SANITIZE_CONFIG);
  // DOMPurify returns a string when the input is a string; the
  // declared `TrustedHTML | string` return type is satisfied either
  // way at the consumer site (assigned to innerHTML).
  return typeof sanitized === "string" ? sanitized : String(sanitized);
}
