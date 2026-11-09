/**
 * editor-smart-quotes.ts — Educate Quotes and Straighten Quotes, the pair
 * both CM6 editing surfaces bind.
 *
 *   - **Educate Quotes** turns straight quotes into curly ones: `"` becomes
 *     “ or ”, and `'` becomes ‘ or ’. A quote opens when it follows the
 *     start of a line, whitespace, an opening bracket or dash, or a quote
 *     that itself opened; otherwise it closes — so an apostrophe inside a
 *     word (`don't`) reads as the ’ it is.
 *   - **Straighten Quotes** turns curly quotes back into straight ones:
 *     “ ” „ ‟ become `"`, and ‘ ’ ‚ ‛ become `'`.
 *
 * Both act on the selected text, or on the whole document when every range
 * is empty. Both skip Markdown code — fenced code blocks and inline code
 * spans — since curling the quotes inside code would quietly break code the
 * user pasted into a prompt or a `.md` file. The code is found from the text
 * itself rather than from a parse tree, because the prompt carries a
 * Markdown grammar only while its styling is on, and a backtick span in any
 * other language is code too.
 *
 * Each character is replaced by exactly one, so the selection keeps its
 * place, and each press is one transaction, so ⌘Z reverts it whole.
 *
 * @module components/tugways/editor-smart-quotes
 */

import type { ChangeSpec, EditorState, TransactionSpec } from "@codemirror/state";

import { lineEditSpec } from "./editor-quote-lines";

/** A half-open span of document positions, `[from, to)`. */
export interface Span {
  from: number;
  to: number;
}

/** A fence opener or closer: indent, optional quote markers, ``` or ~~~. */
const FENCE = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})/;

/**
 * The spans of `doc` that are Markdown code: each fenced block from its
 * opening fence through its closing one (or to the end, when unclosed), and
 * each inline code span outside them, ascending and disjoint.
 */
export function markdownCodeSpans(doc: string): Span[] {
  const spans: Span[] = [];
  let pos = 0;
  let fence: string | null = null;
  let fenceFrom = 0;
  let prose = 0; // where the run of prose lines since the last fence began
  const proseSpans = (from: number, to: number) => {
    inlineCodeSpans(doc, from, to, spans);
  };
  while (pos <= doc.length) {
    const nl = doc.indexOf("\n", pos);
    const end = nl === -1 ? doc.length : nl;
    const marker = FENCE.exec(doc.slice(pos, end));
    if (fence === null) {
      if (marker !== null) {
        proseSpans(prose, pos);
        fence = marker[1];
        fenceFrom = pos;
      }
    } else if (
      marker !== null &&
      marker[1][0] === fence[0] &&
      marker[1].length >= fence.length &&
      doc.slice(pos + marker[0].length, end).trim() === ""
    ) {
      spans.push({ from: fenceFrom, to: end });
      fence = null;
      prose = end;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (fence !== null) spans.push({ from: fenceFrom, to: doc.length });
  else proseSpans(prose, doc.length);
  return spans.sort((a, b) => a.from - b.from);
}

/**
 * Push the inline code spans in `doc[from, to)`: a run of backticks opens
 * one, and the next run of the same length closes it, within its paragraph.
 * A run with no closer is literal backticks.
 */
function inlineCodeSpans(doc: string, from: number, to: number, out: Span[]): void {
  let i = from;
  while (i < to) {
    if (doc[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < to && doc[j] === "`") j++;
    const run = j - i;
    const paragraphEnd = paragraphEndFrom(doc, j, to);
    let k = j;
    let closed = -1;
    while (k < paragraphEnd) {
      if (doc[k] !== "`") {
        k++;
        continue;
      }
      let m = k;
      while (m < paragraphEnd && doc[m] === "`") m++;
      if (m - k === run) {
        closed = m;
        break;
      }
      k = m;
    }
    if (closed === -1) {
      i = j;
    } else {
      out.push({ from: i, to: closed });
      i = closed;
    }
  }
}

/** The end of the paragraph `pos` sits in: the next blank line, or `to`. */
function paragraphEndFrom(doc: string, pos: number, to: number): number {
  const blank = /\n[ \t]*\n/g;
  blank.lastIndex = pos;
  const hit = blank.exec(doc);
  return hit === null || hit.index >= to ? to : hit.index;
}

/** The spans a press acts on: the selected text, or the whole document. */
function scope(state: EditorState): Span[] {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (ranges.length === 0) return [{ from: 0, to: state.doc.length }];
  return ranges.map((r) => ({ from: r.from, to: r.to }));
}

/**
 * The single-character replacements `pick` asks for over `state`'s scope,
 * outside Markdown code. `pick` sees the document, the position, and the
 * replacement it chose for the character before (if any).
 */
function replaceChars(
  state: EditorState,
  pick: (text: string, at: number, before: string | undefined) => string | null,
): TransactionSpec | null {
  if (state.readOnly) return null;
  const text = state.doc.toString();
  const code = markdownCodeSpans(text);
  const changes: ChangeSpec[] = [];
  for (const { from, to } of scope(state)) {
    let c = 0;
    let before: string | undefined;
    for (let at = from; at < to; at++) {
      while (c < code.length && code[c].to <= at) c++;
      if (c < code.length && code[c].from <= at) {
        at = code[c].to - 1;
        before = undefined;
        continue;
      }
      const insert = pick(text, at, before);
      before = insert ?? undefined;
      if (insert !== null && insert !== text[at]) changes.push({ from: at, to: at + 1, insert });
    }
  }
  if (changes.length === 0) return null;
  return lineEditSpec(state, changes);
}

/** A character after which a quote opens. */
const OPENS_AFTER = /[\s([{<—–-]/;

/**
 * The Educate Quotes transaction for `state`: every straight quote in scope,
 * outside Markdown code, made curly. Null on a read-only document, or when
 * there is none.
 */
export function educateQuotesSpec(state: EditorState): TransactionSpec | null {
  return replaceChars(state, (text, at, before) => {
    const ch = text[at];
    if (ch !== '"' && ch !== "'") return null;
    const prev = before ?? (at > 0 ? text[at - 1] : undefined);
    const opens =
      prev === undefined || OPENS_AFTER.test(prev) || prev === "“" || prev === "‘";
    if (ch === '"') return opens ? "“" : "”";
    return opens ? "‘" : "’";
  });
}

const STRAIGHT: Record<string, string> = {
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
};

/**
 * The Straighten Quotes transaction for `state`: every curly quote in scope,
 * outside Markdown code, made straight. Null on a read-only document, or
 * when there is none.
 */
export function straightenQuotesSpec(state: EditorState): TransactionSpec | null {
  return replaceChars(state, (text, at) => STRAIGHT[text[at]] ?? null);
}
