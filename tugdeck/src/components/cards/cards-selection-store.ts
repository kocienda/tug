/**
 * cards-selection-store.ts — the layout selection: which cards the deck's
 * layout verbs act on.
 *
 * The Cards card's list is the surface that builds this set (plain pick,
 * ⌘-toggle, ⇧-extend), but the set is not the list's: `resolveLayoutSelection`
 * reads it from the deck canvas's command handlers, which are mounted whether
 * that card is open or not, and the selection survives its closing.
 * A module store is the house [L02] shape for that seam — the list is a view of
 * the set through `useSyncExternalStore`, never its owner.
 *
 * The set is ordered by pick sequence, and carries the anchor a ⇧-extension
 * ranges from. Transient by design: never persisted, never restored.
 *
 * Two rules keep it honest against a deck that moves underneath it:
 *
 * - **Prune, never grow.** {@link attachLayoutSelectionToDeck} subscribes to the
 *   deck and drops ids whose cards are gone. A selection that prunes to empty
 *   falls back to first-responder resolution, which is the intended degenerate
 *   case rather than a failure.
 * - **Activation outside the set collapses it.** Fronting a content card that
 *   is not selected means the user has moved on; the set becomes that card.
 *   Building a multi-selection never fronts anything, so it never trips this.
 *
 * @module components/cards/cards-selection-store
 */

import { isSidebarCard } from "@/card-registry";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { scheduleAfterPaint } from "@/lib/after-paint";
import { isTugMotionEnabled } from "@/components/tugways/scale-timing";

/** The selected card ids in pick order, plus the anchor ⇧-extension ranges from. */
export interface LensSelectionSnapshot {
  readonly ids: readonly string[];
  readonly anchorId: string | null;
}

const EMPTY: LensSelectionSnapshot = { ids: [], anchorId: null };

/**
 * The layout selection. One instance ({@link cardsSelectionStore}) serves the
 * process; the class exists so tests can hold an isolated one.
 */
export class CardsSelectionStore {
  private snapshot: LensSelectionSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private autoSelectSuppressed = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LensSelectionSnapshot => this.snapshot;

  /** The selection as a set, for membership tests in a render pass. */
  getSelectedIdSet = (): ReadonlySet<string> => new Set(this.snapshot.ids);

  /** Replace the selection with `id` alone, and anchor there. */
  pickOnly(id: string): void {
    this.publish({ ids: [id], anchorId: id });
  }

  /** Add `id` to the selection, or remove it when already a member. Either way
   *  the anchor moves to `id` — the next ⇧-extension ranges from here. */
  toggle(id: string): void {
    const present = this.snapshot.ids.includes(id);
    const ids = present
      ? this.snapshot.ids.filter((x) => x !== id)
      : [...this.snapshot.ids, id];
    // Removing the anchor leaves the anchor on the removed row deliberately:
    // ⌘-click then ⇧-click is a range from where you last clicked, which is
    // what every native list does, membership notwithstanding.
    this.publish({ ids, anchorId: id });
  }

  /**
   * Select the inclusive range from the anchor to `id` over `order` — the
   * list's current visible row order, which the caller supplies because the
   * store has no view of the list's filtering or grouping.
   *
   * With no anchor, or an anchor the order no longer contains, this degenerates
   * to picking `id` alone. The anchor does not move: successive ⇧-extensions
   * all range from the same place.
   */
  extendTo(id: string, order: readonly string[]): void {
    const anchorId = this.snapshot.anchorId;
    if (anchorId === null) {
      this.pickOnly(id);
      return;
    }
    const from = order.indexOf(anchorId);
    const to = order.indexOf(id);
    if (from === -1 || to === -1) {
      this.pickOnly(id);
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    this.publish({ ids: order.slice(lo, hi + 1), anchorId });
  }

  /** Drop the selection entirely. */
  clear(): void {
    this.publish(EMPTY);
  }

  /**
   * Skip the next auto-select in {@link attachLayoutSelectionToDeck} — the
   * collapse that turns a fresh content-card activation into a selection of
   * that card.
   *
   * Set by a programmatic focus *restore*, where the activation is not the user
   * moving on to a card: Escape's focus-out from the Cards card re-activates the one
   * that was fronted before it took focus, and without this the restore would create the
   * very selection the next Escape clears. Any future restore that must not
   * select sets this the same way, immediately before the transfer.
   *
   * One-shot: consumed by the next first-responder transition, whatever it is.
   */
  suppressNextAutoSelect(): void {
    this.autoSelectSuppressed = true;
  }

  /** Read and clear the one-shot set by {@link suppressNextAutoSelect}. */
  consumeAutoSelectSuppression(): boolean {
    const suppressed = this.autoSelectSuppressed;
    this.autoSelectSuppressed = false;
    return suppressed;
  }

  /**
   * Shrink the selection to the ids that still exist. Never grows it — a card
   * appearing does not join a selection nobody made.
   */
  pruneTo(liveIds: Iterable<string>): void {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    const ids = this.snapshot.ids.filter((id) => live.has(id));
    if (ids.length === this.snapshot.ids.length) {
      // Nothing dropped; the anchor can still be stale on its own, since a
      // ⌘-toggle can anchor on a row it just removed from the set.
      const anchorId =
        this.snapshot.anchorId !== null && !live.has(this.snapshot.anchorId)
          ? null
          : this.snapshot.anchorId;
      if (anchorId !== this.snapshot.anchorId) this.publish({ ids, anchorId });
      return;
    }
    const anchorId =
      this.snapshot.anchorId !== null && live.has(this.snapshot.anchorId)
        ? this.snapshot.anchorId
        : null;
    this.publish({ ids, anchorId });
  }

  private publish(next: LensSelectionSnapshot): void {
    if (
      next.anchorId === this.snapshot.anchorId &&
      next.ids.length === this.snapshot.ids.length &&
      next.ids.every((id, i) => id === this.snapshot.ids[i])
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/** The process-wide layout selection. */
export const cardsSelectionStore = new CardsSelectionStore();

// ---------------------------------------------------------------------------
// The cursor card
// ---------------------------------------------------------------------------
//
// Where the keyboard is standing in the Cards list, when it is standing
// anywhere. Deliberately NOT part of the selection snapshot: the cursor moves
// on every arrow, and folding it into the store the list renders from would
// re-render the list at key-repeat rate to paint nothing new.
//
// `resolveLayoutSelection` reads it at gesture time, which is the only moment
// the answer matters for a chord — the same way the deck's first responder is
// read rather than watched.
//
// The menu is the one watcher, and it has to be: the column items' enablement
// is computed at menu-state flush time and cached in the host, so a cursor move
// that changed the answer and told nobody would leave a live item dimmed — and
// a dimmed item's key equivalent is swallowed by AppKit before the web view
// sees it, which would take the chord down with it ([P05]). The notification is
// deliberately not part of the selection snapshot: the cursor moves on every
// arrow, and folding it in there would re-render the Cards list at key-repeat
// rate to paint nothing new. This fires only on a change, and its one listener
// schedules a coalesced, diffed flush.
//
// `null` means the keyboard is not in the list, published by the list itself
// from the projection that paints the cursor, so a stale cursor can never
// answer for a list nobody is in.

let cursorCardId: string | null = null;
const cursorListeners = new Set<() => void>();

/** Publish the card the Cards list's cursor is on, or `null`. */
export function setLayoutCursorCard(cardId: string | null): void {
  if (cardId === cursorCardId) return;
  cursorCardId = cardId;
  for (const listener of cursorListeners) listener();
}

/** Watch the cursor card. Returns the unsubscribe. */
export function subscribeLayoutCursorCard(listener: () => void): () => void {
  cursorListeners.add(listener);
  return () => {
    cursorListeners.delete(listener);
  };
}

/** The card the Cards list's cursor is on, or `null`. */
export function getLayoutCursorCard(): string | null {
  return cursorCardId;
}

/**
 * Keep `selection` reconciled against `deck`: prune on every deck change, and
 * collapse the set when a content card outside it becomes first responder.
 *
 * Registered from the deck canvas's layout effect, so it is live for as long as
 * there is a deck. Returns the unsubscribe.
 *
 * The collapse fires on a *transition* of the first-responder bit, not on the
 * bit's standing value — a selection built while some other card is fronted
 * (⌘-clicking rows in the Cards card never fronts anything) must survive, and only a
 * fresh activation means the user moved on.
 *
 * **The read is synchronous and the write is not ([B04]).** This rides
 * `subscribeSync`, the door for a subscriber that needs the flip's edge — the
 * transition of the first-responder bit is only visible from inside the
 * commit, because the bit's standing value a task later says nothing about
 * whether it moved. But `selection` is a store React subscribes to, and a
 * React-visible write made here re-renders the deck canvas inside
 * `transferFocusForActivation`'s `flushSync`; the canvas then reads the
 * deck's NEW snapshot (React reads `getSnapshot` on render whatever notified
 * it) and runs the whole Last pass inside the click task, which is the one
 * thing [D204]'s deferral exists to prevent. Measured on the bench at 5–11 ms
 * of Last pass inside the flush ([F05]).
 *
 * So the `pickOnly` takes the after-paint door — the same door the deck's own
 * React notify takes — coalesced to one write per painted frame and standing
 * down under reduced motion, where there is no tween to protect. The
 * semantics are unchanged: a second transition inside the same frame
 * overwrites the pending id exactly as a second synchronous `pickOnly` would
 * have overwritten the first selection.
 *
 * **The prune takes the same door, for the same reason ([B02]).** `pruneTo`
 * publishes whenever a selected id or a stale anchor drops, and a publish is
 * a React-visible write like any other — so on the commit that closes a
 * selected card it put the whole Last pass back inside the click task by the
 * route the `pickOnly` deferral had just closed. It is the same one-slot
 * coalescer and the same reduced-motion stand-down; what stays synchronous is
 * the READ of the card list, because the live ids are the ones this commit
 * published and pruning a frame later against a deck that has moved on would
 * drop a card that came back.
 *
 * **Two commits in one frame read the pending write, not the snapshot.** A
 * deferred `pickOnly` is a selection that stands from the commit's point of
 * view and has not been published yet, so the collapse test a second
 * transition makes in the same frame asks the pending id rather than the
 * store — otherwise fronting X and then Y inside one task left the selection
 * on X, where a synchronous pass would have ended on Y. And a pending pick
 * whose card was closed before the frame landed is dropped at the door: the
 * prune runs first, and a `pickOnly` after it would put a dead id back into
 * a selection the prune had just cleaned. Both are the one-frame window the
 * deferral opened, closed at the write.
 */
export function attachLayoutSelectionToDeck(
  deck: IDeckManagerStore,
  selection: CardsSelectionStore = cardsSelectionStore,
): () => void {
  let lastFirstResponder = deck.getFirstResponderCardId();
  // The coalesced deferral's one slot. Non-null means a write is scheduled
  // and has not run; a later transition replaces the id rather than queueing
  // a second pass, which is what makes N commits in one task cost one write.
  let pendingPick: string | null = null;
  // The prune's own slot, on the same terms: the last commit's live ids win,
  // because a prune against the newest card list is the one every earlier
  // prune in the same frame would have agreed with.
  let pendingPrune: ReadonlySet<string> | null = null;
  // The newest commit's card list, so a pick that reaches the door after its
  // card has gone is refused rather than published.
  let lastLive: ReadonlySet<string> = new Set(
    deck.getSnapshot().cards.map((c) => c.id),
  );
  let detached = false;
  const handle = (): void => {
    const state = deck.getSnapshot();
    const liveIds = new Set(state.cards.map((c) => c.id));
    lastLive = liveIds;
    if (!isTugMotionEnabled()) {
      selection.pruneTo(liveIds);
    } else {
      const pruneScheduled = pendingPrune !== null;
      pendingPrune = liveIds;
      if (!pruneScheduled) {
        scheduleAfterPaint(() => {
          const ids = pendingPrune;
          pendingPrune = null;
          if (detached || ids === null) return;
          selection.pruneTo(ids);
        });
      }
    }

    const fr = deck.getFirstResponderCardId();
    if (fr === lastFirstResponder) return;
    lastFirstResponder = fr;
    // Consume the one-shot on the transition itself, before any early return,
    // so a restore that lands on a rail or on nothing does not leave it armed
    // for whatever activation comes next.
    const suppressed = selection.consumeAutoSelectSuppression();
    if (fr === null) return;
    const card = state.cards.find((c) => c.id === fr);
    // A rail taking focus — the Cards card itself, most of the time — is not the
    // user leaving the selection behind; it is how the selection gets made.
    if (card === undefined || isSidebarCard(card.componentId)) return;
    // The selection as a synchronous pass would see it: the pending pick,
    // when one is scheduled, is the selection this frame already made.
    const standing =
      pendingPick !== null ? [pendingPick] : selection.getSnapshot().ids;
    if (standing.includes(fr)) return;
    if (suppressed) return;
    // Reduced motion stands down: there is no tween whose first frame the
    // React commit could land in, so the write costs nothing where it is.
    if (!isTugMotionEnabled()) {
      selection.pickOnly(fr);
      return;
    }
    const alreadyScheduled = pendingPick !== null;
    pendingPick = fr;
    if (alreadyScheduled) return;
    scheduleAfterPaint(() => {
      const id = pendingPick;
      pendingPick = null;
      if (detached || id === null) return;
      // Fronted and closed inside one frame: the prune ahead of this has
      // already dropped it, and it must not come back.
      if (!lastLive.has(id)) return;
      selection.pickOnly(id);
    });
  };
  const unsubscribe =
    deck.subscribeSync?.(handle, "cards-selection") ?? deck.subscribe(handle);
  return () => {
    detached = true;
    pendingPick = null;
    pendingPrune = null;
    unsubscribe();
  };
}
