/**
 * `tugchartTransformer` — promotes ` ```tugchart ` fenced-code blocks to
 * the `tug-chart` body kind so the post-render `enhance-chart` walker
 * can compile them through the chart engine.
 *
 * It is the math transformer's shape with one difference in when it
 * promotes. A transformer gated on `isComplete`, the parent text's
 * status, would be wrong here: tugcast renders live assistant text as
 * though complete, so that gate alone would leave a half-streamed spec
 * promoted on one render side and not the other. It reads the block's own
 * source instead and promotes only when the fence is **closed** by
 * CommonMark's rule — the same answer on both sides at every moment of
 * a stream. `isComplete` is not consulted. The `tugmark` port in
 * `tugdeck/crates/tugmark/src/transform.rs` is byte-identical to this
 * file; the drift golden holds them together.
 */

import type { BlockTransformer } from "./index";

/** The opening `<pre><code class="language-XXX">` pulldown-cmark emits. */
const FENCE_OPEN_RE = /^<pre><code\s+class="language-([^"]+)"\s*>/i;
const FENCE_CLOSE_RE = /<\/code><\/pre>\s*$/;

/** Decode the entity set pulldown-cmark emits inside a code fence body. */
export function decodeTugchartEntities(escaped: string): string {
  return escaped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeForTextContent(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Languages this transformer promotes. Matched case-insensitively. */
const TUGCHART_LANGS = new Set(["tugchart"]);

/**
 * Extract the spec source out of a sanitized
 * `<pre><code class="language-tugchart">…</code></pre>` block, or `null`
 * when `html` is not that exact shape or another language.
 */
export function extractTugchartSource(html: string): {
  lang: string;
  source: string;
} | null {
  const openMatch = html.match(FENCE_OPEN_RE);
  if (!openMatch) return null;
  if (!FENCE_CLOSE_RE.test(html)) return null;
  const lang = openMatch[1].toLowerCase();
  if (!TUGCHART_LANGS.has(lang)) return null;
  const inner = html
    .slice(openMatch[0].length)
    .replace(FENCE_CLOSE_RE, "");
  const trimmed = inner.endsWith("\n") ? inner.slice(0, -1) : inner;
  return { lang, source: decodeTugchartEntities(trimmed) };
}

/**
 * A line with up to three leading spaces removed, or `null` when it is
 * indented further — CommonMark's rule for a fence line.
 */
function unindentFence(line: string): string | null {
  let spaces = 0;
  while (spaces < line.length && line.charCodeAt(spaces) === 0x20) spaces += 1;
  if (spaces > 3) return null;
  return line.slice(spaces);
}

/** The fence character and run length a line opens with, if any. */
function fenceRun(line: string): { ch: string; n: number } | null {
  const body = unindentFence(line);
  if (body === null) return null;
  const ch = body[0];
  if (ch !== "`" && ch !== "~") return null;
  let n = 0;
  while (n < body.length && body[n] === ch) n += 1;
  return n >= 3 ? { ch, n } : null;
}

/**
 * Whether a fenced code block's source ends in its closing fence, by
 * CommonMark's closing rule: the block has at least two lines, and its
 * last non-blank line, with up to three leading spaces and any trailing
 * whitespace removed, is a run of the opening fence's character at least
 * as long as the opening run. A four-backtick fence whose stream has so
 * far reached a three-backtick content line is still open, exactly as
 * pulldown-cmark holds it open.
 */
export function fenceIsClosed(source: string): boolean {
  const lines = source.split("\n");
  const open = fenceRun(lines[0]);
  if (open === null) return false;
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const line = lines[i].trimEnd();
    if (line.trim() === "") continue;
    const body = unindentFence(line);
    if (body === null) return false;
    if (body.length < open.n) return false;
    for (let k = 0; k < body.length; k += 1) {
      if (body[k] !== open.ch) return false;
    }
    return true;
  }
  return false;
}

/**
 * The placeholder the chart walker consumes: the spec source as
 * `textContent`, re-escaped for the `innerHTML` round-trip, so the
 * engine reads it back losslessly and until it runs the reader sees the
 * source.
 */
export function buildChartPlaceholderHtml(source: string): string {
  return `<div class="tugx-chart" data-tugx-chart-pending="true">${escapeForTextContent(source)}</div>`;
}

export const tugchartTransformer: BlockTransformer = {
  name: "tugchart",
  transform(block, ctx) {
    if (block.type !== "code") return [block];
    const extracted = extractTugchartSource(block.html);
    if (extracted === null) return [block];
    if (!fenceIsClosed(ctx.source)) return [block];
    return [
      {
        ...block,
        type: "tug-chart",
        html: buildChartPlaceholderHtml(extracted.source),
      },
    ];
  },
};
