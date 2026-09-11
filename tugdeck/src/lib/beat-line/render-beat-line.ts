/**
 * render-beat-line — THE renderer for one-line beat strings: mixed
 * partial markdown + TeX, possibly torn mid-stream, rendered with
 * transcript-grade fidelity and a total-function guarantee.
 *
 * Why this exists as a standalone library: the strip's earlier
 * pipeline fed the WHOLE string through the markdown parser and then
 * patched math into the DOM afterwards (the transcript's streaming
 * approach). For one-line fragments that layering is structurally
 * fragile — the markdown parser mangles LaTeX before the math pass
 * ever sees it (backslash escapes, emphasis interaction), and the
 * post-DOM typesetting raced the strip's cross-fade swaps. This
 * library inverts the order:
 *
 *  1. **Math first.** `findInlineMathRanges` (the deck's own
 *     exhaustively-tested grammar) lifts every `$…$` / `$$…$$` span
 *     out of the string. The markdown parser NEVER sees LaTeX.
 *  2. Each span renders directly through KaTeX's synchronous
 *     `renderToString` — no placeholders, no DOM walking, no async
 *     enhancement pass. Malformed LaTeX renders KaTeX's inline error
 *     form (`throwOnError: false`); a thrown engine error falls back
 *     to the escaped source.
 *  3. The remaining prose — with each span replaced by a private-use
 *     sentinel — parses ONCE through `parseMarkdownToSanitizedBlocks`
 *     (the transcript's sanitized pipeline), then the sentinels are
 *     substituted with the rendered math.
 *
 * GUARANTEES (the test suite enforces every one):
 *  - never throws, for ANY input (fuzzed) — worst case returns
 *    `html: ""`, the caller's render-as-plain-text signal;
 *  - no raw `$$`/`$` delimiters survive into the output when KaTeX is
 *    available;
 *  - output is sanitized: prose HTML passes through DOMPurify; math
 *    HTML is generated locally by KaTeX from text (and a sentinel that
 *    fails to round-trip the parse aborts to the plain-text fallback
 *    rather than dropping content);
 *  - display math renders in INLINE mode — the strip is one line.
 *
 * KaTeX loads lazily ([D10]): the first math line returns
 * `pending !== null` with escaped-source math; the caller re-invokes
 * when the promise resolves and every later call is synchronous.
 *
 * @module lib/beat-line/render-beat-line
 */

import { findInlineMathRanges } from "@/lib/markdown/block-transformers/inline-math-walker";
import { parseMarkdownToSanitizedBlocks } from "@/lib/markdown/parse-markdown-to-sanitized-blocks";
import {
  getKaTeXSync,
  loadKaTeX,
  type KaTeXEngine,
} from "@/lib/lazy/load-katex";

/** One rendered line. `html: ""` ⇒ render the source as plain text. */
export interface BeatLineRender {
  html: string;
  /** Non-null while KaTeX is still loading — re-render on resolution. */
  pending: Promise<void> | null;
}

/** Private-use sentinel pair — survives the parser and sanitizer as
 *  inert text, then substitutes for the rendered math. */
const SENTINEL_OPEN = "\uE000";
const SENTINEL_CLOSE = "\uE001";

/** Minimal HTML escape for fallback paths. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render one TeX source through the engine; never throws. */
function mathHtml(engine: KaTeXEngine | null, source: string): string {
  if (engine === null) {
    return `<span class="session-beat-math-pending">${escapeHtml(source)}</span>`;
  }
  try {
    // Inline mode always: the strip is one line; display math in
    // textstyle still typesets fractions/operators correctly.
    return engine.renderToString(source, {
      displayMode: false,
      throwOnError: false,
    });
  } catch {
    return `<span class="session-beat-math-error">${escapeHtml(source)}</span>`;
  }
}

/**
 * Render a one-line beat string to sanitized inline HTML. Total: any
 * internal failure returns `{ html: "", pending: null }` and the
 * caller shows plain text.
 */
export function renderBeatLine(text: string): BeatLineRender {
  try {
    return renderInner(text);
  } catch {
    return { html: "", pending: null };
  }
}

function renderInner(text: string): BeatLineRender {
  if (text.trim().length === 0) return { html: "", pending: null };

  const ranges = findInlineMathRanges(text);
  const engine = getKaTeXSync();
  let pending: Promise<void> | null = null;
  if (ranges.length > 0 && engine === null) {
    pending = loadKaTeX().then(
      () => undefined,
      () => undefined,
    );
  }

  // Lift math out before the markdown parser can touch it.
  let prose = "";
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    prose += text.slice(cursor, ranges[i].start);
    prose += `${SENTINEL_OPEN}${i}${SENTINEL_CLOSE}`;
    cursor = ranges[i].end;
  }
  prose += text.slice(cursor);

  const blocks = parseMarkdownToSanitizedBlocks(prose);
  let html = blocks.map((b) => b.html).join(" ");
  if (html.trim().length === 0 && ranges.length === 0) {
    return { html: "", pending: null };
  }

  // Substitute every sentinel with its rendered math. A sentinel that
  // failed to round-trip the parse (eaten or split by the sanitizer)
  // aborts to plain text — dropped math is worse than unstyled prose.
  for (let i = 0; i < ranges.length; i++) {
    const sentinel = `${SENTINEL_OPEN}${i}${SENTINEL_CLOSE}`;
    if (!html.includes(sentinel)) {
      return { html: "", pending: null };
    }
    html = html.replace(sentinel, mathHtml(engine, ranges[i].source));
  }

  return { html, pending };
}
