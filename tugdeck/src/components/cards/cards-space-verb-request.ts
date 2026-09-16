/**
 * cards-space-verb-request.ts — one menu-originated workspace verb, waiting
 * for the Workspaces card to answer it.
 *
 * **Two of the four workspace verbs cannot be performed where they are
 * answered.** Rename and Delete both need a surface — the inline field on the
 * header row, and the confirm popover anchored to it — and both surfaces live
 * in `cards-card.tsx`, which is the one place a workspace name is typed and
 * the one place a workspace delete is confirmed ([P03]). A second field or a
 * second dialog raised from the menu would be a second copy to keep in step
 * with the first. So the chain-root handler reveals the card and leaves the
 * verb here; the card picks it up.
 *
 * It is a module store rather than a call because [L02] leaves no other
 * route: a handler outside the card cannot reach into the card's state, and
 * **the card may not be mounted yet** at the instant the request is made —
 * `revealSidebarCard` stands it up in the same commit, so the request has to
 * survive until that card's first layout effect. A direct call would have
 * nothing to call.
 *
 * The slot holds ONE request. A second request replaces the first, which is
 * the right reading of two verbs fired in a row: the later one is what the
 * person meant. `token` is monotonic so two consecutive requests naming the
 * same workspace are still distinguishable — without it the second would
 * produce a snapshot identical to the first and wake no subscriber.
 *
 * It clears on consumption, which is what keeps it view scope ([L24]): a
 * rename nobody committed is not worth remembering, and a request that
 * outlived a card close would re-fire on the next open.
 *
 * @module components/cards/cards-space-verb-request
 */

/** A workspace verb the Workspaces card has yet to answer. */
export interface SpaceVerbRequest {
  readonly verb: "rename" | "delete";
  readonly spaceId: string;
  /**
   * Monotonic, so two requests naming the same workspace differ by identity.
   * Nothing reads its value; it exists to make the snapshot change.
   */
  readonly token: number;
}

class SpaceVerbRequestStore {
  private slot: SpaceVerbRequest | null = null;

  private nextToken = 1;

  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable by identity until a request, a clear, or a prune moves it. */
  getSnapshot = (): SpaceVerbRequest | null => this.slot;

  /** Put a verb in the slot for the card to answer. */
  request = (verb: "rename" | "delete", spaceId: string): void => {
    this.slot = { verb, spaceId, token: this.nextToken };
    this.nextToken += 1;
    this.notify();
  };

  /** Empty the slot — what the card does once it has answered. */
  clear = (): void => {
    if (this.slot === null) return;
    this.slot = null;
    this.notify();
  };

  /**
   * Drop a request naming a workspace no longer in `live`. The same
   * defensive shape `collapsedSpacesStore.prune` takes, and for a sharper
   * reason: a rename field or a confirm opened over a workspace that is gone
   * has nothing to act on.
   *
   * A no-op when the slot is empty or still names a live workspace, so the
   * snapshot's identity holds.
   */
  prune = (live: ReadonlySet<string>): void => {
    if (this.slot === null || live.has(this.slot.spaceId)) return;
    this.slot = null;
    this.notify();
  };

  /** Test seam: forget the slot and every subscriber. */
  _resetForTest = (): void => {
    this.slot = null;
    this.nextToken = 1;
    this.listeners.clear();
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const cardsSpaceVerbRequest = new SpaceVerbRequestStore();
