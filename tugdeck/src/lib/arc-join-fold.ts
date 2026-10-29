/**
 * What the Changes shade's arc fold *says*, as pure functions over data, so
 * the words are testable without a DOM.
 *
 * @module lib/arc-join-fold
 */

import type { ArcResolvedBaseWire } from "@/lib/changeset-types";

/**
 * A document's path as the fold shows it: relative to the checkout when it
 * lies under it, absolute otherwise.
 *
 * The wire carries absolute paths because the open needs them; a reader needs
 * only the part that tells two documents apart. A path outside the checkout
 * keeps its full spelling, since a shortened one would name a file that is not
 * there.
 */
export function documentDisplayPath(abs: string, root: string | undefined): string {
  if (root === undefined || root === "") return abs;
  const trimmed = root.replace(/\/+$/, "");
  if (trimmed === "") return abs;
  const prefix = `${trimmed}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

/** What a fold receipt says: the title row, and the sentence under it. */
export interface FoldReceiptText {
  title: string;
  sentence: string;
}

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

/**
 * The words on a fold's receipt.
 *
 * The title names what happened in the reader's terms — whose edit, which
 * file, on which base — and the sentence says what each of the receipt's two
 * answers does, so Keep and Undo are weighed before either is pressed.
 *
 * The user's own dirt folds with no holder, so the own-edit arm is the common
 * one; a single path held by another live session names its holder.
 */
export function foldReceiptText(rb: ArcResolvedBaseWire): FoldReceiptText {
  const folded = rb.folded ?? [];
  const dropped = rb.dropped ?? [];
  if (rb.commit === undefined) {
    const n = dropped.length;
    return {
      title: `Dropped ${n} identical ${plural(n, "file", "files")}`,
      sentence: `The arc already carries the same bytes, so the base's ${plural(n, "copy was", "copies were")} dropped rather than committed. Keep leaves it that way and the join proceeds; Undo restores the dropped ${plural(n, "copy", "copies")}.`,
    };
  }
  let title: string;
  if (folded.length === 1) {
    const path = folded[0]!;
    const holder = rb.folded_from?.[path];
    title =
      holder !== undefined
        ? `${holder}'s edit to ${path} is now a commit on ${rb.base}`
        : `Your edit to ${path} is now a commit on ${rb.base}`;
  } else {
    const n = folded.length;
    title = `Committed ${n} ${plural(n, "file", "files")} of base work on ${rb.base}`;
  }
  return {
    title,
    sentence: `Keep leaves the commit on ${rb.base} and the join proceeds. Undo takes it back off ${rb.base}, returns the ${plural(folded.length, "edit", "edits")} uncommitted, and blocks the join again.`,
  };
}
