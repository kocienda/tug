/**
 * smart-insert.ts — the one padding decision every insert door asks.
 *
 * macOS smart paste, applied to atom insertion: an inserted run gets a
 * space on a side only when that side is missing air. The decision is a
 * pure function of the document, the range being replaced, and the run
 * itself, so every door — file drop, jot substrate, atom picker,
 * text-card link — gets the same answer and the rule is testable as a
 * table rather than through the drag-and-drop machinery.
 */

import type { EditorState } from "@codemirror/state";

/**
 * Characters that seat the insert *inside* something rather than after
 * it. `--paths=⟨atom⟩` and `"⟨atom⟩"` must not acquire a space that
 * changes what the line means.
 */
const OPENERS = new Set(["(", "[", "{", "<", '"', "'", "`", "=", "@"]);

/**
 * Characters that belong to what precedes them. Dropping just before a
 * period leaves the sentence intact rather than pushing its punctuation
 * away from it.
 */
const CLOSERS = new Set([
  ")",
  "]",
  "}",
  ">",
  '"',
  "'",
  "`",
  ",",
  ";",
  ":",
  ".",
  "?",
  "!",
]);

/** Whether the padding decision needs a space on each outer edge. */
export interface InsertPadding {
  before: boolean;
  after: boolean;
}

/** `true` for a space, a tab, or a newline — never for U+FFFC. */
function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Decide the outer padding for inserting `insert` over `[from, to)`.
 *
 * Only the two outer edges are considered: whatever `insert` carries
 * inside it is the caller's business (a multi-item drop's interior
 * single-space join, a carried substrate's own separators). A run that
 * already begins or ends with whitespace needs no pad on that side,
 * which is what keeps the jot-substrate append rule's leading newline
 * from acquiring a space in front of it.
 *
 * Note that `to` — not `from` — is what the trailing side reads, so a
 * drop over a selection compares against the characters that will
 * actually abut the result rather than against the text being replaced.
 */
export function padForInsert(
  state: EditorState,
  from: number,
  to: number,
  insert: string,
): InsertPadding {
  const doc = state.doc;

  let before = false;
  if (insert.length > 0 && !isWhitespace(insert[0]!) && from > 0) {
    const prev = doc.sliceString(from - 1, from);
    before = !isWhitespace(prev) && !OPENERS.has(prev);
  }

  let after = false;
  const last = insert[insert.length - 1];
  if (last !== undefined && !isWhitespace(last) && to < doc.length) {
    const next = doc.sliceString(to, to + 1);
    after = !isWhitespace(next) && !CLOSERS.has(next);
  }

  return { before, after };
}

/** A padded run, ready to ride an insert's own transaction. */
export interface PaddedInsert {
  /** The text to write over `[from, to)`, pads included. */
  insert: string;
  /**
   * Where the run's own first character lands — `from`, plus one if a
   * leading pad was added. This is the position an atom effect wants.
   */
  start: number;
  /**
   * Where the caret lands: the end of the whole insert, trailing pad
   * included, per the house convention, so typing continues in clean
   * air rather than welding to the chip.
   */
  caret: number;
}

/** Apply `padForInsert`'s answer to a run. */
export function padInsert(
  state: EditorState,
  from: number,
  to: number,
  insert: string,
): PaddedInsert {
  const { before, after } = padForInsert(state, from, to, insert);
  const padded = (before ? " " : "") + insert + (after ? " " : "");
  return {
    insert: padded,
    start: from + (before ? 1 : 0),
    caret: from + padded.length,
  };
}
