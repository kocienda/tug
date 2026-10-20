/**
 * The surfaces anchored to cards that the overlay draws, and the rule that
 * keeps the overlay from following a card: an entry stands only while its
 * card rests.
 *
 * A producer publishes a card's surface at the card's rest rect. The moment
 * the card starts to move — a gesture's first travelled report, or a settle's
 * plan that names it — its entry is withdrawn, and it is published again, at
 * the rect the card came to rest at, once nothing moves it ([B07]). So the
 * overlay never holds a rect the card is passing through: nothing in it can
 * track a moving card frame by frame, because nothing it is sent says where a
 * moving card is.
 *
 * {@link OverlaySurfaceBook} is that rule, pure; the module's book is the
 * shell's, and it writes `overlay.surfaces`.
 *
 * @module lib/overlay-surfaces
 */

import { overlaySurfaces, type OverlaySurfaceEntry } from "../bus/declarations/overlay";
import { deepEqual } from "./deep-equal";

/** Why a card is moving: a gesture the host carries, or a settle's plan. */
export type MotionReason = "gesture" | "plan";

export class OverlaySurfaceBook {
  private readonly published = new Map<string, OverlaySurfaceEntry>();
  private readonly moving = new Map<string, Set<MotionReason>>();
  private shown: Record<string, OverlaySurfaceEntry> = {};
  private refresher: ((cardId: string) => OverlaySurfaceEntry | null) | null = null;

  constructor(private readonly onChange: (shown: Record<string, OverlaySurfaceEntry>) => void) {}

  /**
   * Re-read a card's entry as it comes to rest, before it is shown again:
   * what was published while it moved was measured mid-motion, and the
   * entry the overlay is sent must be the rest rect.
   */
  setRefresher(refresher: ((cardId: string) => OverlaySurfaceEntry | null) | null): void {
    this.refresher = refresher;
  }

  /** `cardId`'s surface at its rest rect, or `null` when it has none. */
  publish(cardId: string, entry: OverlaySurfaceEntry | null): void {
    if (entry === null) this.published.delete(cardId);
    else this.published.set(cardId, entry);
    this.recompute();
  }

  /** `cardId` started to move for `reason`: its entry comes off now. */
  hold(cardId: string, reason: MotionReason): void {
    let reasons = this.moving.get(cardId);
    if (reasons === undefined) {
      reasons = new Set();
      this.moving.set(cardId, reasons);
    }
    if (reasons.has(reason)) return;
    reasons.add(reason);
    this.recompute();
  }

  /** `cardId` stopped moving for `reason`: its entry is back once nothing else moves it. */
  release(cardId: string, reason: MotionReason): void {
    const reasons = this.moving.get(cardId);
    if (reasons === undefined || !reasons.delete(reason)) return;
    if (reasons.size === 0) {
      this.moving.delete(cardId);
      this.refresh(cardId);
    }
    this.recompute();
  }

  /** Every card held for `reason` is at rest: the settle's land, which measures them all. */
  releaseAll(reason: MotionReason): void {
    let changed = false;
    for (const [cardId, reasons] of this.moving) {
      if (!reasons.delete(reason)) continue;
      changed = true;
      if (reasons.size === 0) {
        this.moving.delete(cardId);
        this.refresh(cardId);
      }
    }
    if (changed) this.recompute();
  }

  /** Whether `cardId` is moving for any reason. */
  isMoving(cardId: string): boolean {
    return this.moving.has(cardId);
  }

  /** What the overlay is sent: every published entry whose card is at rest. */
  snapshot(): Record<string, OverlaySurfaceEntry> {
    return this.shown;
  }

  private refresh(cardId: string): void {
    if (this.refresher === null || !this.published.has(cardId)) return;
    const entry = this.refresher(cardId);
    if (entry === null) this.published.delete(cardId);
    else this.published.set(cardId, entry);
  }

  private recompute(): void {
    const next: Record<string, OverlaySurfaceEntry> = {};
    for (const [cardId, entry] of this.published) {
      if (!this.moving.has(cardId)) next[cardId] = entry;
    }
    if (sameShown(this.shown, next)) return;
    this.shown = next;
    this.onChange(next);
  }
}

function sameShown(a: Record<string, OverlaySurfaceEntry>, b: Record<string, OverlaySurfaceEntry>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] !== undefined && deepEqual(a[key], b[key]));
}

/** The shell's book: what it writes is `overlay.surfaces`. */
export const overlaySurfaceBook = new OverlaySurfaceBook((shown) => overlaySurfaces.set(shown));
