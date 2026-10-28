/**
 * What each body card says about itself, as the shell reads it.
 *
 * A body sets its card's own stores (`bus/declarations/card.ts`): its facts
 * (`card.facts`: title, masthead, session phase, whether it is mid-turn or
 * compacted), the holds the shell pulls synchronously at gesture time
 * (`card.holds`: close advice, fold guard), its cold restore, its content
 * reading and its keyboard-focus paint. The shell's readers of a card's session — the phase
 * dot, the masthead's compaction, the live-turns count, the restore gate,
 * the close advisor and the fold guard — read the replicas here for a body
 * card because no session store exists for one in the shell.
 *
 * This is a reader over those replicas, on this page's bus. It notifies
 * whenever any of them changes, and a replica keeps its object until its
 * value changes, so a reader's snapshot is reference-stable across repeats.
 * A body page's own card is its own to read, so on any page but the shell
 * — and on a page with no bus — it reads as if no card had said anything.
 *
 * Laws: [L02] read through `useSyncExternalStore`; [L22] advisors read the
 * store directly.
 *
 * @module lib/body-facts-store
 */

import { bindEveryPageBus, installedPageBus, type PageBus } from "../bus/page-bus";
import {
  cardContent,
  cardFacts,
  cardHolds,
  cardKbfPaint,
  cardRestoreHold,
  NO_CARD_HOLDS,
  type CardFactsValue,
  type CardHoldsValue,
  type RestoreHoldState,
} from "../bus/declarations/card";
import { Subscribable } from "./subscribable";

/** One body card's facts and holds. `facts` is null before its first. */
export interface BodyFacts {
  readonly facts: CardFactsValue | null;
  readonly holds: CardHoldsValue;
}

const NOTHING: BodyFacts = Object.freeze({ facts: null, holds: NO_CARD_HOLDS });

function shellPageBus(): PageBus | null {
  const bus = installedPageBus();
  return bus?.page.role === "shell" ? bus : null;
}

export class BodyFactsStore extends Subscribable {
  private readonly composed = new Map<string, BodyFacts>();
  /** Releases the binding to every page bus and the subscriptions taken on each. */
  private readonly unbind: () => void;

  /** `bus` names the page bus to read; the default is this page's, when it is the shell. */
  constructor(private readonly bus: () => PageBus | null = shellPageBus) {
    super();
    this.unbind = bindEveryPageBus((bound) => {
      const changed = (): void => {
        if (this.bus() === bound) this.notify();
      };
      const releases = [cardFacts, cardHolds, cardRestoreHold, cardKbfPaint, cardContent].map((store) =>
        store.on(bound).subscribe(changed),
      );
      return () => {
        for (const release of releases) release();
      };
    });
  }

  /** Stop reading: no page bus is bound any more, and nothing here is notified. */
  dispose(): void {
    this.unbind();
    this.composed.clear();
  }

  /** Everything the card has said. Stable by identity until it says something new. */
  get = (cardId: string): BodyFacts => {
    const bus = this.bus();
    if (bus === null) return NOTHING;
    const facts = cardFacts.on(bus).getFor(cardId);
    const holds = cardHolds.on(bus).getFor(cardId);
    const prev = this.composed.get(cardId);
    if (prev !== undefined && prev.facts === facts && prev.holds === holds) return prev;
    if (facts === null && holds === NO_CARD_HOLDS) {
      this.composed.delete(cardId);
      return NOTHING;
    }
    const next = Object.freeze({ facts, holds });
    this.composed.set(cardId, next);
    return next;
  };

  /** The card's facts, or null before its first. */
  factsOf = (cardId: string): CardFactsValue | null => this.get(cardId).facts;

  /** The session phase key the body computed, or null when it has no session. */
  activityOf = (cardId: string): string | null => this.get(cardId).facts?.activity ?? null;

  /** Whether the card's session is mid-turn. */
  canInterrupt = (cardId: string): boolean => this.get(cardId).facts?.canInterrupt === true;

  /** Whether the card's session has been compacted. */
  compacted = (cardId: string): boolean => this.get(cardId).facts?.compacted === true;

  /**
   * The card's cold restore as its body last said (`card.restoreHold`):
   * `"waiting"` while its restore is still to come, `"holding"` while the
   * restore gate holds it, or null when neither.
   */
  restoreHoldOf = (cardId: string): RestoreHoldState | null => {
    const bus = this.bus();
    return bus === null ? null : cardRestoreHold.on(bus).getFor(cardId);
  };

  /** Whether the card's page paints keyboard-focus mode, as its body last said, or null before it has. */
  kbfPaintOf = (cardId: string): boolean | null => {
    const bus = this.bus();
    return bus === null ? null : cardKbfPaint.on(bus).getFor(cardId);
  };

  /** What the card's body last read of its content — a rail card's — or null. */
  contentOf = (cardId: string): { content: number; shown: number } | null => {
    const bus = this.bus();
    return bus === null ? null : cardContent.on(bus).getFor(cardId);
  };

  /** The close advice: waive the confirm. False until the body says otherwise. */
  waives = (cardId: string): boolean => this.get(cardId).holds.waive;

  /** The fold guard: true (the fold may proceed) until the body says otherwise. */
  guarded = (cardId: string): boolean => this.get(cardId).holds.guarded;
}

export const bodyFactsStore = new BodyFactsStore();
