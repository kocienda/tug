/**
 * focus-trail.ts — the cards the reader had focused, in the order they
 * focused them.
 *
 * The trail is what Back and Forward step along. It is an ordered list of
 * visits and a cursor naming the visit the reader is on, with a browser's
 * semantics:
 *
 * - a **landing** appends a visit, and a landing made while the cursor is
 *   behind the end first drops everything ahead of the cursor;
 * - a **step** moves the cursor and records no visit;
 * - a landing on the card the cursor is already on records nothing;
 * - the trail holds at most {@link FOCUS_TRAIL_LIMIT} visits and drops the
 *   oldest past that.
 *
 * It is a different record from the deck's activation history, which holds
 * each card once, most recent first. That shape answers "which card was I
 * last in" and has no forward; this one keeps repeat visits and a place in
 * them.
 *
 * **A card that no longer stands is skipped and pruned.** The trail is never
 * told that a card closed. A step asks its caller which cards still stand,
 * removes each visit it meets that does not, and carries on in the same
 * direction. Pruning can bring two visits to one card together, and a step
 * onto the card the reader is already on would move nothing, so such a visit
 * is folded away the same way.
 *
 * The module holds no DOM, no timers and no store: what counts as a landing,
 * and what "stands" means, are its caller's to say.
 *
 * @module lib/focus-trail
 */

/** The most visits the trail holds. The oldest are dropped past it. */
export const FOCUS_TRAIL_LIMIT = 64;

/** Which way a step moves the cursor. */
export type FocusTrailDirection = "back" | "forward";

/** Says whether a card still stands, so a step may land on it. */
export type FocusTrailStands = (cardId: string) => boolean;

export class FocusTrail {
  /** Visits, oldest first. */
  private _visits: string[] = [];
  /** Index of the visit the reader is on, or -1 for an empty trail. */
  private _cursor = -1;

  /** The card the cursor is on, or `null` for an empty trail. */
  get current(): string | null {
    return this._cursor < 0 ? null : this._visits[this._cursor];
  }

  /** The visits, oldest first. A copy. */
  get visits(): readonly string[] {
    return this._visits.slice();
  }

  /** Index of the cursor's visit in {@link visits}, or -1 when empty. */
  get cursor(): number {
    return this._cursor;
  }

  /**
   * Record that the reader landed on `cardId` by any means other than a step.
   *
   * Everything ahead of the cursor is dropped first: a landing made after
   * going back starts a new future. A landing on the cursor's own card
   * records nothing and drops nothing.
   */
  land(cardId: string): void {
    if (this.current === cardId) return;
    this._visits.length = this._cursor + 1;
    this._visits.push(cardId);
    const over = this._visits.length - FOCUS_TRAIL_LIMIT;
    if (over > 0) this._visits.splice(0, over);
    this._cursor = this._visits.length - 1;
  }

  /**
   * Move the cursor one standing visit in `direction` and return the card it
   * lands on, or `null` when nothing standing lies that way.
   *
   * Every visit passed over on the way — a card that no longer stands, or
   * another visit to the card the reader is already on — is removed. A
   * refused step leaves the cursor where it was, with those visits gone.
   */
  step(direction: FocusTrailDirection, stands: FocusTrailStands): string | null {
    if (this._cursor < 0) return null;
    const here = this._visits[this._cursor];
    if (direction === "back") {
      while (this._cursor > 0) {
        const candidate = this._visits[this._cursor - 1];
        if (candidate !== here && stands(candidate)) {
          this._cursor -= 1;
          return candidate;
        }
        this._visits.splice(this._cursor - 1, 1);
        this._cursor -= 1;
      }
      return null;
    }
    while (this._cursor < this._visits.length - 1) {
      const candidate = this._visits[this._cursor + 1];
      if (candidate !== here && stands(candidate)) {
        this._cursor += 1;
        return candidate;
      }
      this._visits.splice(this._cursor + 1, 1);
    }
    return null;
  }

  /**
   * Whether a {@link step} in `direction` would land somewhere. Reads only:
   * nothing is pruned, so it is safe to ask on every menu validation.
   */
  canStep(direction: FocusTrailDirection, stands: FocusTrailStands): boolean {
    if (this._cursor < 0) return false;
    const here = this._visits[this._cursor];
    const side =
      direction === "back"
        ? this._visits.slice(0, this._cursor)
        : this._visits.slice(this._cursor + 1);
    return side.some((cardId) => cardId !== here && stands(cardId));
  }
}
