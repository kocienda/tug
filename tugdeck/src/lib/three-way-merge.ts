/**
 * three-way-merge — a strict line diff3 over the editor's own Myers diff.
 *
 * A Tug session makes the external edit the common case: an agent rewrites
 * the file a Text card has open while the user is still typing in it. When
 * the two edits are nowhere near each other, stopping to ask which one to
 * keep is a question with an obvious answer, asked every few minutes. So the
 * store merges — and this module decides whether a merge is honest.
 *
 * It is deliberately stricter than a merge tool a person drives:
 *
 * - **Line granularity, exact comparison.** Two changes that touch the same
 *   line are a conflict, even when the characters they changed do not
 *   overlap. A character-level merge inside one line is the shape that
 *   produces text neither side wrote.
 * - **Touching is overlapping.** Hunks are compared closed — abutting hunks
 *   and two insertions at the same point both touch — because "insert my
 *   paragraph here" and "insert my paragraph here" have an order, and
 *   nothing in the inputs says which.
 * - **No fuzzy placement.** A hunk is applied at the base offsets the diff
 *   gave it or not at all; there is no searching nearby for somewhere it
 *   would fit. Fuzz is what turns a conflict into a silently wrong file.
 * - **A diff past `MAX_EDIT_DISTANCE` is a conflict.** `diffLines` returns
 *   `null` rather than a coarse answer, and a coarse answer merged against
 *   a fine one is exactly the silent-corruption case.
 *
 * The one relaxation: both sides making the *identical* change is a merge,
 * applied once, not a conflict — the case where the user saved the same
 * edit the agent had already written.
 *
 * All three inputs must be `\n`-normalized; the store's `normalizeLf` does
 * that at every call site. Pure string logic, synchronous, no dependency.
 *
 * @module lib/three-way-merge
 */

import { diffLines, splitLines, MAX_EDIT_DISTANCE } from "./minimal-text-changes";

/** A merged text, or the refusal that raises the conflict sheet. */
export type MergeResult = { ok: true; text: string } | { ok: false };

/** One side's edit, in base line indices: replace `[a0, a1)` with `lines`. */
interface Hunk {
  a0: number;
  a1: number;
  lines: string[];
}

/**
 * Merge `ours` (the live buffer) and `theirs` (what disk now holds) over
 * their common ancestor `base` (the bytes the buffer was last in step with).
 *
 * `{ ok: false }` is a refusal to guess, never a failure — every caller
 * turns it into the conflict question for the user.
 */
export function mergeThreeWay(
  base: string,
  ours: string,
  theirs: string,
): MergeResult {
  if (ours === theirs) return { ok: true, text: ours };
  if (base === theirs) return { ok: true, text: ours };
  if (base === ours) return { ok: true, text: theirs };

  const a = splitLines(base);
  const ourHunks = hunksAgainst(a, splitLines(ours));
  const theirHunks = hunksAgainst(a, splitLines(theirs));
  if (ourHunks === null || theirHunks === null) return { ok: false };

  const applied: Hunk[] = [];
  // Both sides are walked, so a hunk that touches two on the other side is
  // caught from whichever side sees the pair — the asymmetry a one-sided
  // walk would leave is the whole of this check's value.
  for (const [mine, others, keep] of [
    [ourHunks, theirHunks, true],
    [theirHunks, ourHunks, false],
  ] as Array<[Hunk[], Hunk[], boolean]>) {
    for (const hunk of mine) {
      const hits = others.filter((other) => touches(hunk, other));
      if (hits.length === 0) {
        applied.push(hunk);
        continue;
      }
      // The identical change from both sides: applied once, from the first
      // walk only, so the output does not carry it twice.
      if (hits.length === 1 && hits[0] !== undefined && same(hunk, hits[0])) {
        if (keep) applied.push(hunk);
        continue;
      }
      return { ok: false };
    }
  }

  applied.sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of applied) {
    // Non-touching hunks cannot overlap, so this is unreachable — and a
    // merge that produced overlapping output would be the silent corruption
    // this module exists to refuse.
    if (hunk.a0 < cursor) return { ok: false };
    out.push(...a.slice(cursor, hunk.a0), ...hunk.lines);
    cursor = hunk.a1;
  }
  out.push(...a.slice(cursor));
  return { ok: true, text: out.join("") };
}

/** One side's hunks in base coordinates, or `null` past the distance ceiling. */
function hunksAgainst(a: string[], b: string[]): Hunk[] | null {
  const raw = diffLines(a, b, MAX_EDIT_DISTANCE);
  if (raw === null) return null;
  return raw.map(([a0, a1, b0, b1]) => ({ a0, a1, lines: b.slice(b0, b1) }));
}

/**
 * Closed comparison, so abutting hunks and two insertions at the same point
 * both count as touching. An insertion has `a0 === a1`, which is why the
 * bounds are inclusive on both sides.
 */
function touches(x: Hunk, y: Hunk): boolean {
  return x.a0 <= y.a1 && y.a0 <= x.a1;
}

/** The same base span replaced by the same lines — the one mergeable touch. */
function same(x: Hunk, y: Hunk): boolean {
  return (
    x.a0 === y.a0 &&
    x.a1 === y.a1 &&
    x.lines.length === y.lines.length &&
    x.lines.every((line, i) => line === y.lines[i])
  );
}
