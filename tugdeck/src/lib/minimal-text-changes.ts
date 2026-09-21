/**
 * minimal-text-changes — the smallest set of edits that turns one text into
 * another, in the `{from, to, insert}` shape a CM6 transaction takes.
 *
 * This is what makes an in-place reload read as "the text changed under me"
 * rather than "the editor jumped". A whole-document replace tells CM6 that
 * every position in the old document is gone: the selection collapses to an
 * end, the measured height map is discarded for estimates, the scroll anchor
 * maps to offset 0, and folds, search matches, and the undo history's
 * positions all go with it. A minimal change set tells it the truth — these
 * lines changed, the rest did not — and CM6's own position mapping then keeps
 * the caret, the selection, the scroll anchor, and the history where they
 * belong, with nothing to restore by hand afterwards.
 *
 * The diff is by LINE: common leading and trailing lines are trimmed, the
 * middle is diffed with Myers' O(ND) algorithm, and each changed line run is
 * then tightened by its own common character prefix and suffix. Line
 * granularity is what an out-of-process writer produces (a formatter, a
 * checkout, an agent's edit), and it keeps the cost bounded on a large file.
 * When the middle is too different to be worth diffing (`MAX_EDIT_DISTANCE`),
 * it is replaced as one span — still never the whole document unless the
 * whole document really changed.
 *
 * Pure string logic; no CM6 import, so it is testable on its own.
 *
 * @module lib/minimal-text-changes
 */

/** One replacement, in offsets of the ORIGINAL text. Sorted, non-overlapping. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Edit-distance ceiling for the line diff. Past it the two middles share too
 * little for a finer answer to help the reader keep their place, and Myers'
 * trace grows with the square of the distance.
 */
export const MAX_EDIT_DISTANCE = 1500;

/** Split into lines that KEEP their terminator, so offsets sum exactly. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** True when `code` is a UTF-16 low surrogate (the second half of a pair). */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Tighten one replaced span by its common character prefix and suffix, never
 * splitting a surrogate pair — a caret mapped into half a pair is a caret in
 * the middle of a character.
 */
function tighten(prev: string, from: number, to: number, insert: string): TextChange | null {
  const oldLen = to - from;
  const max = Math.min(oldLen, insert.length);
  let pre = 0;
  while (pre < max && prev.charCodeAt(from + pre) === insert.charCodeAt(pre)) pre++;
  if (pre > 0 && pre < insert.length && isLowSurrogate(insert.charCodeAt(pre))) pre--;
  if (pre > 0 && pre < oldLen && isLowSurrogate(prev.charCodeAt(from + pre))) pre--;
  let suf = 0;
  const sufMax = max - pre;
  while (
    suf < sufMax &&
    prev.charCodeAt(to - 1 - suf) === insert.charCodeAt(insert.length - 1 - suf)
  ) {
    suf++;
  }
  if (suf > 0 && isLowSurrogate(prev.charCodeAt(to - suf))) suf--;
  const change: TextChange = {
    from: from + pre,
    to: to - suf,
    insert: insert.slice(pre, insert.length - suf),
  };
  if (change.from === change.to && change.insert === "") return null;
  return change;
}

/**
 * Myers' O(ND) diff over two line arrays. Returns the matched index pairs'
 * complement as `[aStart, aEnd, bStart, bEnd]` hunks, or `null` when the edit
 * distance passes `maxD`.
 */
function diffLines(
  a: readonly string[],
  b: readonly string[],
  maxD: number,
): Array<[number, number, number, number]> | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const offset = limit + 1;
  let v: Int32Array = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found === -1) return null;

  // Backtrack into unit edits, then coalesce adjacent ones into hunks.
  const hunks: Array<[number, number, number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    // The snake ran from (midX, midY) to (x, y); the edit precedes it.
    const midX = down ? prevX : prevX + 1;
    const midY = down ? prevY + 1 : prevY;
    const hunk: [number, number, number, number] = [prevX, midX, prevY, midY];
    const last = hunks[hunks.length - 1];
    if (last !== undefined && last[0] === hunk[1] && last[2] === hunk[3]) {
      last[0] = hunk[0];
      last[2] = hunk[2];
    } else {
      hunks.push(hunk);
    }
    x = prevX;
    y = prevY;
  }
  return hunks.reverse();
}

/**
 * The changes that turn `prev` into `next`: sorted, non-overlapping, in
 * offsets of `prev`. Empty when the texts are equal.
 */
export function minimalTextChanges(prev: string, next: string): TextChange[] {
  if (prev === next) return [];
  const a = splitLines(prev);
  const b = splitLines(next);

  // Trim common leading and trailing lines; the diff sees only the middle.
  let head = 0;
  const headMax = Math.min(a.length, b.length);
  while (head < headMax && a[head] === b[head]) head++;
  let tail = 0;
  const tailMax = headMax - head;
  while (tail < tailMax && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  let headOffset = 0;
  for (let i = 0; i < head; i++) headOffset += a[i].length;

  const hunks = diffLines(aMid, bMid, MAX_EDIT_DISTANCE) ?? [
    [0, aMid.length, 0, bMid.length] as [number, number, number, number],
  ];

  // Line index → offset in `prev`, for the middle only.
  const aStarts = new Array<number>(aMid.length + 1);
  aStarts[0] = headOffset;
  for (let i = 0; i < aMid.length; i++) aStarts[i + 1] = aStarts[i] + aMid[i].length;

  const changes: TextChange[] = [];
  for (const [a0, a1, b0, b1] of hunks) {
    const change = tighten(prev, aStarts[a0], aStarts[a1], bMid.slice(b0, b1).join(""));
    if (change !== null) changes.push(change);
  }
  return changes;
}
