/**
 * Which body cards the shell stands a face in for.
 *
 * Every card draws its chrome in its own page, so a card whose page has not
 * painted yet — being made, made and not yet painted, or evicted and asked
 * for again — has no face at all: its pane in the shell is a paintless
 * stand-in, so what shows there is the shell's canvas. A workspace switch
 * onto such cards showed a pane with no title for the frames before its page
 * painted.
 *
 * So the shell stands one in, in the card's placeholder, from the facts it
 * already holds for the card (`components/chrome/body-stand-in.tsx`): the
 * card's chrome, and its content box lidded in the pane's surface, as the
 * card's own first frame draws it. The shell's page lies beneath every card,
 * so the card's view covers the face the moment the host shows it, and a card
 * brought back from an eviction stands under its last frame, which the host
 * stands over the face as it always has.
 *
 * The face goes two frames after the page's first frame, so the hand-off
 * from the stand-in to the page has no frame with neither.
 *
 * Laws: [L02] read through `useSyncExternalStore`; [L22] `bodyCardsStore` is
 * subscribed to directly.
 *
 * @module lib/body-stand-in-store
 */

import { bodyCardsStore, type BodyCardState } from "./body-cards-store";
import { Subscribable } from "./subscribable";

/** The facts {@link standInOf} reads. */
export interface StandInFacts {
  readonly state: BodyCardState | null;
  /** The page has said its first chrome frame is on screen. */
  readonly chromeShown: boolean;
}

/** Whether a body card wants a face, by its body's state: its page is being made, made and not painted, or evicted. */
export function standInOf(facts: StandInFacts): boolean {
  if (facts.state === null || facts.state === "painted" || facts.state === "failed") return false;
  return !facts.chromeShown;
}

/** What the store reads of the deck's bodies, and how it waits a frame; a test hands its own. */
export interface StandInSources {
  cardIds(): readonly string[];
  facts(cardId: string): StandInFacts;
  subscribe(listener: () => void): () => void;
  /** Run `fn` after the next frame. */
  nextFrame(fn: () => void): void;
}

const DECK_SOURCES: StandInSources = {
  cardIds: () => bodyCardsStore.cardIds(),
  facts: (cardId) => ({
    state: bodyCardsStore.stateOf(cardId),
    chromeShown: bodyCardsStore.chromeShown(cardId),
  }),
  subscribe: (listener) => bodyCardsStore.subscribe(listener),
  nextFrame: (fn) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fn());
    else setTimeout(fn, 16);
  },
};

/** How many frames a face outlives the page's first frame. */
export const STAND_IN_LINGER_FRAMES = 2;

export class BodyStandInStore extends Subscribable {
  /** Cards standing a face now. */
  private readonly faces = new Set<string>();
  /** Cards whose face is waiting out its frames before it goes. */
  private readonly leaving = new Set<string>();
  private release: (() => void) | null = null;

  constructor(private readonly sources: StandInSources = DECK_SOURCES) {
    super();
  }

  /** Start following the deck's bodies. Idempotent. */
  attach(): () => void {
    if (this.release === null) {
      this.release = this.sources.subscribe(() => this.reconcile());
      this.reconcile();
    }
    return () => this.detach();
  }

  detach(): void {
    this.release?.();
    this.release = null;
    this.leaving.clear();
    if (this.faces.size === 0) return;
    this.faces.clear();
    this.notify();
  }

  /** Whether a face stands for `cardId` now. */
  standing = (cardId: string): boolean => this.faces.has(cardId);

  private reconcile(): void {
    let changed = false;
    const live = new Set(this.sources.cardIds());
    for (const cardId of [...this.faces]) {
      if (live.has(cardId)) continue;
      this.faces.delete(cardId);
      this.leaving.delete(cardId);
      changed = true;
    }
    for (const cardId of live) {
      const standing = this.faces.has(cardId);
      if (standInOf(this.sources.facts(cardId))) {
        this.leaving.delete(cardId);
        if (!standing) {
          this.faces.add(cardId);
          changed = true;
        }
        continue;
      }
      if (standing && !this.leaving.has(cardId)) this.leave(cardId, STAND_IN_LINGER_FRAMES);
    }
    if (changed) this.notify();
  }

  /** Let the face go after `frames` frames, unless the card wants one again by then. */
  private leave(cardId: string, frames: number): void {
    this.leaving.add(cardId);
    this.sources.nextFrame(() => {
      if (!this.leaving.has(cardId)) return;
      if (frames > 1) {
        this.leaving.delete(cardId);
        this.leave(cardId, frames - 1);
        return;
      }
      this.leaving.delete(cardId);
      if (!this.faces.delete(cardId)) return;
      this.notify();
    });
  }
}

export const bodyStandInStore = new BodyStandInStore();
