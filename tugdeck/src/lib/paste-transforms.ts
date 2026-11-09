/**
 * paste-transforms.ts — pure text transforms for the "paste as quote"
 * and "paste as plain text" clipboard variants.
 *
 * Both transforms take the clipboard's plain-text payload and rewrite
 * it before it lands in an editing surface. They are framework-agnostic
 * (no React, no DOM) so the editor substrates (`tug-text-editor`, the
 * native-input responder) and tests can share one implementation.
 *
 *   - `quoteMarkdown` wraps the text as a GitHub-flavored blockquote —
 *     every line gains a `> ` prefix (blank lines become a bare `>`),
 *     preserving the source content verbatim.
 *   - `stripMarkdown` parses the text as Markdown and emits only its
 *     textual content: headings lose their `#`, emphasis/strong/strike
 *     unwrap, inline + fenced code unwrap, links collapse to their label,
 *     images to their alt text, list markers drop, raw HTML is removed.
 *     The walk is `tugmark`'s `strip_markdown`, the same pulldown-cmark the
 *     renderer parses with, so it needs the WASM module the page entries
 *     initialize at startup.
 */

import { strip_markdown } from "../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

/**
 * Wrap `text` as a Markdown blockquote: prefix every line with `> `.
 * A blank line becomes a bare `>` so the quote block stays contiguous
 * rather than splitting into separate blockquotes at the blank line.
 * Returns the input unchanged when it is empty.
 */
export function quoteMarkdown(text: string): string {
  if (text === "") return text;
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * Strip Markdown formatting from `text`, returning its plain-text
 * content. Block boundaries (paragraphs, headings, code blocks) are
 * separated by a blank line, list items sit one per line, a table's
 * cells are tab-separated; inline formatting is unwrapped in place.
 * Returns the input unchanged when it is empty.
 */
export function stripMarkdown(text: string): string {
  if (text === "") return text;
  return strip_markdown(text);
}

