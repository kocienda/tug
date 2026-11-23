/**
 * docket-card-open-registry.ts — live index of mounted Docket cards, keyed by
 * card id, exposing each card's target and a re-point hook.
 *
 * `open-docket` uses this to reuse a card already showing the docket asked
 * for, the mirror of `commit-card-open-registry.ts`: two cards over one
 * docket would be two views of one list, one of them stale to the reader's
 * eye. The key is `(projectDir, docketId)` by equality — a docket id is
 * minted per checkout, so the same id under two projects is two dockets.
 *
 * Entries are registered by the card in a layout effect and removed on
 * unmount ([L03]). Callbacks read live state at call time.
 *
 * @module lib/docket-card-open-registry
 */

/** What a Docket card shows, and what `open-docket` re-points it to. */
export interface DocketCardTarget {
  /** The checkout the docket belongs to. */
  projectDir: string;
  /** The docket's id. */
  docketId: string;
  /** A thread to scroll to and mark, once; never persisted. */
  thread?: string;
  /** A sketch id whose editor to open, once; never persisted. */
  editSketch?: string;
}

export interface DocketCardOpenEntry {
  /** The docket this card shows, or null when it shows none yet. */
  getTarget(): { projectDir: string; docketId: string } | null;
  /** Re-point this card at a docket, and mark `thread` when one is named. */
  setTarget(target: DocketCardTarget): void;
}

const entries = new Map<string, DocketCardOpenEntry>();

export function registerOpenDocketCard(cardId: string, entry: DocketCardOpenEntry): void {
  entries.set(cardId, entry);
}

export function unregisterOpenDocketCard(cardId: string): void {
  entries.delete(cardId);
}

/** The mounted Docket card with this id, or null. */
export function getOpenDocketCard(cardId: string): DocketCardOpenEntry | null {
  return entries.get(cardId) ?? null;
}

/** Whether two targets name the same docket. */
export function sameDocketTarget(
  a: { projectDir: string; docketId: string },
  b: { projectDir: string; docketId: string },
): boolean {
  return a.projectDir === b.projectDir && a.docketId === b.docketId;
}

/** The mounted Docket card showing `target`'s docket, or null. */
export function findDocketCardByTarget(
  target: DocketCardTarget,
): { cardId: string; entry: DocketCardOpenEntry } | null {
  for (const [cardId, entry] of entries) {
    const current = entry.getTarget();
    if (current !== null && sameDocketTarget(current, target)) return { cardId, entry };
  }
  return null;
}
