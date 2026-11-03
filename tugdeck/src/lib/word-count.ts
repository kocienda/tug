/**
 * word-count.ts — word counting for the Text card status bar.
 *
 * A "word" is a maximal run of non-whitespace, so the word count equals
 * the number of *word-start* positions: an index `i` whose character is
 * non-whitespace and whose predecessor is whitespace (or the document
 * start). Counting starts, not runs, is what makes an incremental update
 * exact and local.
 *
 * `countWords` is the O(n) full count — used once when a document opens.
 * `wordCountDelta` maintains it in **O(total change size)** per edit: a
 * CM6 change to range `[from, to)` can only flip the word-start status
 * of positions in `[from, to + 1)` (a position's status depends on its
 * own char and its predecessor's), and content outside the changed
 * ranges is byte-identical between the old and new documents, so its
 * word-starts cancel. Summing `newWindowStarts − oldWindowStarts` over
 * the changed ranges is therefore the exact delta — no full re-scan,
 * even on a multi-megabyte file.
 *
 * `selectionCounts` is the other reading the status bar takes: the lines,
 * words and characters of a ranged selection, counted fresh from the
 * selected text alone — O(selection size).
 *
 * No React, no DOM — pure functions over CM6 `Text` / `ChangeDesc`, so
 * the algorithm is unit-tested against the brute-force oracle.
 *
 * @module lib/word-count
 */

import type { ChangeDesc, SelectionRange, Text } from "@codemirror/state";

/** Full word count of `text` — O(n). Used at open and as the oracle. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches === null ? 0 : matches.length;
}

/** Whether the character at `s[idx]` is whitespace (out-of-range = yes). */
function isWhitespaceAt(s: string, idx: number): boolean {
  const c = s[idx];
  return c === undefined || /\s/.test(c);
}

/**
 * Count word-start positions in `doc` over `[start, end)`. Reads one
 * extra leading character so a position's predecessor is available;
 * O(end − start).
 */
function wordStartsIn(doc: Text, start: number, end: number): number {
  if (start >= end) return 0;
  const from = Math.max(0, start - 1);
  const s = doc.sliceString(from, end);
  let count = 0;
  for (let i = start; i < end; i++) {
    // A word start: non-whitespace here, whitespace (or doc start) before.
    if (isWhitespaceAt(s, i - from)) continue;
    if (i === 0 || isWhitespaceAt(s, i - 1 - from)) count += 1;
  }
  return count;
}

/**
 * The change in word count produced by `changes` (from `oldDoc` to
 * `newDoc`). Add it to a running count. O(total change size): each
 * changed range only re-scans its own `[from, to + 1)` window in each
 * document.
 */
export function wordCountDelta(
  changes: ChangeDesc,
  oldDoc: Text,
  newDoc: Text,
): number {
  let delta = 0;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    delta -= wordStartsIn(oldDoc, fromA, Math.min(toA + 1, oldDoc.length));
    delta += wordStartsIn(newDoc, fromB, Math.min(toB + 1, newDoc.length));
  });
  return delta;
}

/** Line / word / character counts over some span of a document. */
export interface SpanCounts {
  lines: number;
  words: number;
  chars: number;
}

/**
 * The counts of the text under `ranges`, summed; empty ranges count
 * nothing. A range's lines are those it touches, except that one ending
 * exactly at the start of a line does not claim that line — selecting a
 * whole line with its newline is one line, not two. Words are counted in
 * each range's own text, so a word the selection cuts through counts as
 * the part of it that is selected.
 */
export function selectionCounts(
  doc: Text,
  ranges: readonly SelectionRange[],
): SpanCounts {
  let lines = 0;
  let words = 0;
  let chars = 0;
  for (const range of ranges) {
    if (range.empty) continue;
    const first = doc.lineAt(range.from).number;
    const end = doc.lineAt(range.to);
    const last = range.to === end.from ? end.number - 1 : end.number;
    lines += last - first + 1;
    words += countWords(doc.sliceString(range.from, range.to));
    chars += range.to - range.from;
  }
  return { lines, words, chars };
}
