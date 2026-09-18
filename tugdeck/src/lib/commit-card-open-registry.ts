/**
 * commit-card-open-registry.ts — live index of mounted Commit cards, keyed by
 * card id, exposing each card's sha and a re-point hook.
 *
 * `open-commit` uses this for sha-keyed reuse, the mirror of
 * `diff-card-open-registry.ts`'s descriptor-keyed reuse: raising a commit a
 * card already shows activates that card instead of spawning a duplicate.
 *
 * **The match is by prefix, in either direction.** Prose writes eight
 * characters and the reply returns forty, so a card opened from a `commit:<8>`
 * pill and one opened from a History row's full sha are the same commit under
 * two spellings. Exact-string keying would open a second card for the second
 * spelling and leave the reader with two cards about one commit. The root has
 * to match exactly — the same sha in two checkouts is two different commits.
 *
 * Entries are registered by `CommitCardContent` in a layout effect and removed
 * on unmount. Callbacks read live state at call time.
 *
 * @module lib/commit-card-open-registry
 */

/** What a card raised from a commit atom is seeded with, and re-pointed to. */
export interface CommitCardTarget {
  /** Repository root the commit is read in. */
  root: string;
  /** The commit's sha — eight characters or forty. */
  sha: string;
}

export interface CommitCardOpenEntry {
  /** The commit this card currently shows, or null before it is seeded. */
  getTarget(): CommitCardTarget | null;
  /** Re-point this card at another commit (fires a fresh request). */
  setTarget(target: CommitCardTarget): void;
}

const entries = new Map<string, CommitCardOpenEntry>();

export function registerOpenCommitCard(
  cardId: string,
  entry: CommitCardOpenEntry,
): void {
  entries.set(cardId, entry);
}

export function unregisterOpenCommitCard(cardId: string): void {
  entries.delete(cardId);
}

/**
 * Whether two targets name the same commit: the same root, and one sha a
 * prefix of the other. Case-insensitive on the hash, since a sha pasted from
 * elsewhere may arrive upper-case and git does not care.
 */
export function sameCommitTarget(
  a: CommitCardTarget,
  b: CommitCardTarget,
): boolean {
  if (a.root !== b.root) return false;
  const left = a.sha.toLowerCase();
  const right = b.sha.toLowerCase();
  if (left.length === 0 || right.length === 0) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/** The Commit card currently showing `target`, or null. */
export function findCommitCardByTarget(
  target: CommitCardTarget,
): { cardId: string; entry: CommitCardOpenEntry } | null {
  for (const [cardId, entry] of entries) {
    const current = entry.getTarget();
    if (current !== null && sameCommitTarget(current, target)) {
      return { cardId, entry };
    }
  }
  return null;
}
