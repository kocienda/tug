/**
 * `inline-math-walker.ts` — post-render DOM walk that promotes
 * unfenced inline math expressions (`$...$`, `$$...$$`) into KaTeX
 * placeholder spans, ready for the math renderer pass.
 *
 * **Layering.** Two layers, separately testable:
 *
 *  1. {@link findInlineMathRanges} — pure logic over a string,
 *     returns the byte ranges and display-mode flag for every math
 *     expression in the input. Exhaustively unit-tested.
 *
 *  2. {@link walkInlineMath} — DOM-mutating wrapper that walks a
 *     container's text nodes (skipping `<code>`, `<pre>`, existing
 *     `.tugx-katex` placeholders, `<script>`, `<style>`), runs the
 *     range finder, and splits each text node into KaTeX placeholder
 *     spans interleaved with literal-text fragments. No actual KaTeX
 *     call — the rendering happens in `enhance-math.ts` once the
 *     engine has loaded.
 *
 * **Grammar.** Conservative rules to avoid prose false positives
 * (`$5 and $10`):
 *
 *  - `$$...$$` (display) — opens at `$$` not preceded by `\`. Closes
 *    at the next `$$` not preceded by `\`. Content may span newlines.
 *  - `$...$` (inline) — opens at `$` not preceded by `\`, not followed
 *    by `$` (display would match), not followed by whitespace. Closes
 *    at the next `$` not preceded by `\`, not preceded by whitespace,
 *    and not followed by a digit (so `$10` cannot be mistaken for a
 *    closing delimiter when scanning resumes).
 *  - `\$` outside math is preserved (the literal-text fragment keeps
 *    the backslash; the renderer sees it as-is).
 *  - An expression that has no closing delimiter is left as plain
 *    text — no partial match.
 *
 * **Streaming.** The walker is called from `enhance-math.ts` after
 * every `innerHTML` write of a markdown block. Idempotency comes from
 * the rewrite — any previously-inserted placeholder is blown away by
 * the rewrite, and the walker re-finds expressions from the fresh
 * text content. Inside a placeholder span (the walker skips
 * `.tugx-katex` subtrees) the LaTeX source is held as text content and
 * is not re-walked, so escaped `\$` inside math survives untouched.
 *
 * @module lib/markdown/block-transformers/inline-math-walker
 */

// ---------------------------------------------------------------------------
// Pure range finder — exported for the test suite
// ---------------------------------------------------------------------------

/**
 * One match in the source text. Offsets are JS string indices into
 * the input passed to {@link findInlineMathRanges}.
 */
export interface InlineMathRange {
  /** Start index (inclusive) of the opening delimiter in the source. */
  start: number;
  /** End index (exclusive) of the closing delimiter in the source. */
  end: number;
  /** `true` for `$$...$$`, `false` for `$...$`. */
  displayMode: boolean;
  /** LaTeX source between the delimiters, with `\$` decoded to `$`. */
  source: string;
}

/** A digit char predicate — uses `>= '0' && <= '9'` to avoid `Intl`. */
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Whitespace predicate. */
function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Walk `text` and return every inline-math range it contains, in
 * source order. Pure: no DOM access, no I/O. The empty input
 * (or input with no `$`) returns `[]` cheaply.
 *
 * The function decodes escaped `\$` inside a matched expression so
 * the caller can hand the resulting `.source` to KaTeX directly. The
 * literal-text fragments around the matches are NOT decoded — callers
 * that splice them back into the DOM (`walkInlineMath`) emit the
 * fragments as-is so they continue to read literally.
 */
export function findInlineMathRanges(text: string): InlineMathRange[] {
  if (text.length === 0 || text.indexOf("$") === -1) return [];

  const ranges: InlineMathRange[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < n && text[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (ch !== "$") {
      i += 1;
      continue;
    }
    // Display delimiter — two unescaped `$` in a row.
    if (i + 1 < n && text[i + 1] === "$") {
      const closingStart = findUnescapedDouble(text, i + 2);
      if (closingStart === -1) {
        // No closing $$ — skip past the opener so we don't infinite-
        // loop and don't accidentally match the first `$` as inline.
        i += 2;
        continue;
      }
      ranges.push({
        start: i,
        end: closingStart + 2,
        displayMode: true,
        source: decodeEscapedDollars(text.slice(i + 2, closingStart)),
      });
      i = closingStart + 2;
      continue;
    }
    // Inline delimiter — single `$`. Opener may not precede a space
    // and may not be followed immediately by `$` (handled above).
    if (i + 1 < n && isSpace(text[i + 1])) {
      i += 1;
      continue;
    }
    const closing = findInlineCloser(text, i + 1);
    if (closing === -1) {
      i += 1;
      continue;
    }
    ranges.push({
      start: i,
      end: closing + 1,
      displayMode: false,
      source: decodeEscapedDollars(text.slice(i + 1, closing)),
    });
    i = closing + 1;
  }
  return ranges;
}

/**
 * Find the next unescaped `$$` at index `>= from`. Returns the
 * start index of the first `$`, or -1 if none.
 */
function findUnescapedDouble(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n - 1) {
    if (text[i] === "\\" && text[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "$") return i;
    i += 1;
  }
  return -1;
}

/**
 * Find the next valid inline-math closing `$` at index `>= from`.
 * Returns the `$`'s index, or -1 if none.
 *
 * A valid closer:
 *  - is not preceded by `\` in the source,
 *  - is not preceded by whitespace (prose-disambiguation rule),
 *  - is not followed by another `$` (those would form a `$$` instead),
 *  - is not followed by a digit (so `$10` cannot close a stray open
 *    inline range scanning from earlier).
 */
function findInlineCloser(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n) {
    if (text[i] === "\\" && i + 1 < n && text[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (text[i] === "$") {
      if (i > 0 && isSpace(text[i - 1])) {
        i += 1;
        continue;
      }
      if (i + 1 < n && text[i + 1] === "$") {
        i += 1;
        continue;
      }
      if (i + 1 < n && isDigit(text[i + 1])) {
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Replace `\$` with literal `$` (used when emitting the math source). */
function decodeEscapedDollars(s: string): string {
  return s.replace(/\\\$/g, "$");
}

// ---------------------------------------------------------------------------
// DOM-mutating walker
// ---------------------------------------------------------------------------

/**
 * Tag names whose subtrees the walker must not enter. Code fences and
 * inline code carry literal `$` characters; existing math placeholders
 * are already typeset (or about to be). `<script>` / `<style>` /
 * `<textarea>` / `<title>` are off-limits because their text nodes are
 * not regular prose nodes.
 */
const SKIP_TAGS = new Set<string>([
  "CODE",
  "PRE",
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
  "TITLE",
]);

/** Class name used by both the block-level and inline placeholders. */
const PLACEHOLDER_CLASS = "tugx-katex";

/** True if `el` is (or is inside) an existing KaTeX placeholder span. */
function inExistingPlaceholder(el: Element | null): boolean {
  let cur: Element | null = el;
  while (cur !== null) {
    if (cur.classList?.contains(PLACEHOLDER_CLASS)) return true;
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Walk `container` and convert every unfenced `$...$` / `$$...$$`
 * range inside a text node into a KaTeX placeholder span. The actual
 * KaTeX render happens later in `enhance-math.ts` once the engine has
 * loaded.
 *
 * Idempotent across re-runs because the parent block's `innerHTML`
 * is rewritten between renders; previously-inserted placeholders are
 * blown away and the walker re-finds expressions from fresh text.
 *
 * The created placeholder element shape mirrors what `mathTransformer`
 * emits for display blocks, so a single renderer pass handles both:
 *
 *   <span class="tugx-katex tugx-katex--inline"
 *         data-tugx-math="inline"
 *         data-tugx-math-pending="true">SOURCE</span>
 */
export function walkInlineMath(container: HTMLElement): void {
  // Iterate over text nodes via TreeWalker, collecting first so we
  // don't mutate during traversal.
  const doc = container.ownerDocument;
  if (doc === null) return;
  const filter: NodeFilter = {
    acceptNode(node: Node): number {
      const text = node.nodeValue;
      if (text === null || text.indexOf("$") === -1) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (inExistingPlaceholder(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  };
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, filter);
  const candidates: Text[] = [];
  let n: Node | null = walker.nextNode();
  while (n !== null) {
    candidates.push(n as Text);
    n = walker.nextNode();
  }
  for (const textNode of candidates) splitTextNodeOnMath(textNode, doc);
}

/**
 * The text of `container` with exactly the math {@link walkInlineMath} would
 * promote removed, and nothing else — the index-side mirror of this walk.
 *
 * The search index projects a block by reducing its HTML to text, and the
 * painter's DOM walk reads the same block after {@link walkInlineMath} has
 * replaced each promoted range with a `.tugx-katex` span it excludes. The
 * two only agree if the index removes the SAME ranges, and the thing that
 * decides which ranges those are is **the text-node boundary**: a paragraph
 * whose source held a hard line break renders as `$$<br>…<br>$$`, three text
 * nodes, none of which holds a whole expression — so the DOM promotes
 * nothing there and the reader sees the raw `$$`. Stripping over the
 * container's whole `textContent` removed it anyway, and every offset in
 * that row after it was wrong. So this walks node by node, exactly as the
 * promoter does, and skips what the promoter skips.
 *
 * Text the promoter skips is kept verbatim rather than dropped: `<code>` is
 * not math, but it is very much prose the painter walks.
 */
export function mathStrippedText(container: HTMLElement): string {
  const doc = container.ownerDocument;
  if (doc === null) return container.textContent ?? "";
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let out = "";
  let n: Node | null = walker.nextNode();
  while (n !== null) {
    const text = n.nodeValue ?? "";
    const parent = n.parentElement;
    const promotable =
      text.indexOf("$") !== -1 &&
      parent !== null &&
      !SKIP_TAGS.has(parent.tagName) &&
      !inExistingPlaceholder(parent);
    out += promotable ? stripMathRanges(text) : text;
    n = walker.nextNode();
  }
  return out;
}

/** `text` with every {@link findInlineMathRanges} range cut out. */
function stripMathRanges(text: string): string {
  const ranges = findInlineMathRanges(text);
  if (ranges.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/**
 * Split a text node into a sequence of (literal-text, placeholder-span)
 * fragments based on the math ranges found in its content. Replaces
 * the original node with the resulting fragment in its parent.
 */
function splitTextNodeOnMath(textNode: Text, doc: Document): void {
  const text = textNode.nodeValue ?? "";
  const ranges = findInlineMathRanges(text);
  if (ranges.length === 0) return;

  const frag = doc.createDocumentFragment();
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) {
      frag.appendChild(doc.createTextNode(text.slice(cursor, r.start)));
    }
    const span = doc.createElement("span");
    span.className = `tugx-katex ${r.displayMode ? "tugx-katex--display" : "tugx-katex--inline"}`;
    span.dataset.tugxMath = r.displayMode ? "display" : "inline";
    span.dataset.tugxMathPending = "true";
    span.textContent = r.source;
    frag.appendChild(span);
    cursor = r.end;
  }
  if (cursor < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(cursor)));
  }
  const parent = textNode.parentNode;
  if (parent !== null) parent.replaceChild(frag, textNode);
}
