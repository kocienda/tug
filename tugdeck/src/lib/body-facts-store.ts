/**
 * What each body card last told the shell about itself.
 *
 * A body publishes its card's facts (`card-facts`: title, masthead, session
 * phase, telemetry) and the advice the shell pulls synchronously at gesture
 * time (`card-advice`: close advice, fold guard) only when they change, so
 * the shell answers from the last message it heard. The shell's readers of a
 * card's session — the phase dot, the masthead's telemetry, the live-turns
 * count, the close advisor and the fold guard — read here for a body card
 * because no session store exists for one in the shell.
 *
 * An identical message keeps the stored object and notifies nobody, so a
 * reader's snapshot is reference-stable across repeats.
 *
 * Laws: [L02] read through `useSyncExternalStore`; [L22] advisors read the
 * store directly.
 *
 * @module lib/body-facts-store
 */

import type { CardAdvice, CardFacts } from "@tugproto/bus";
import { Subscribable } from "./subscribable";

/** One body card's last facts and advice. Absent advice is "said nothing yet". */
export interface BodyFacts {
  readonly facts: CardFacts | null;
  readonly waive: boolean | null;
  readonly guarded: boolean | null;
}

const NOTHING: BodyFacts = Object.freeze({ facts: null, waive: null, guarded: null });

function sameRecord(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameFacts(a: CardFacts | null, b: CardFacts): boolean {
  if (a === null) return false;
  return (
    a.title === b.title &&
    a.activity === b.activity &&
    sameRecord(a.masthead, b.masthead) &&
    sameRecord(a.telemetry, b.telemetry) &&
    sameRecord(a.identity ?? null, b.identity ?? null) &&
    JSON.stringify(a.titleBar ?? null) === JSON.stringify(b.titleBar ?? null)
  );
}

export class BodyFactsStore extends Subscribable {
  private readonly entries = new Map<string, BodyFacts>();

  /** Take a `card-facts`. Returns whether anything changed. */
  applyFacts(cardId: string, facts: CardFacts): boolean {
    const prev = this.entries.get(cardId) ?? NOTHING;
    if (sameFacts(prev.facts, facts)) return false;
    this.entries.set(cardId, Object.freeze({ ...prev, facts }));
    this.notify();
    return true;
  }

  /**
   * Take the `card-advice` the shell answers from later — close advice and
   * the fold guard. Returns whether anything changed; any other advice is an
   * act rather than a fact, and is not held.
   */
  applyAdvice(cardId: string, advice: CardAdvice): boolean {
    const prev = this.entries.get(cardId) ?? NOTHING;
    let next: BodyFacts;
    if (advice.advice === "close-advice") {
      if (prev.waive === advice.waive) return false;
      next = { ...prev, waive: advice.waive };
    } else if (advice.advice === "fold-guard") {
      if (prev.guarded === advice.guarded) return false;
      next = { ...prev, guarded: advice.guarded };
    } else {
      return false;
    }
    this.entries.set(cardId, Object.freeze(next));
    this.notify();
    return true;
  }

  /** Forget a card. */
  drop(cardId: string): void {
    if (!this.entries.delete(cardId)) return;
    this.notify();
  }

  /** Everything the card has said. Stable by identity until it says something new. */
  get = (cardId: string): BodyFacts => this.entries.get(cardId) ?? NOTHING;

  /** The card's facts, or null before its first `card-facts`. */
  factsOf = (cardId: string): CardFacts | null => this.get(cardId).facts;

  /** The session phase key the body computed, or null when it has no session. */
  activityOf = (cardId: string): string | null => this.get(cardId).facts?.activity ?? null;

  /** Whether the card's session is mid-turn. */
  canInterrupt = (cardId: string): boolean => this.get(cardId).facts?.telemetry.canInterrupt === 1;

  /** Whether the card's session has been compacted. */
  compacted = (cardId: string): boolean => this.get(cardId).facts?.telemetry.compacted === 1;

  /** The close advice: waive the confirm. False until the body says otherwise. */
  waives = (cardId: string): boolean => this.get(cardId).waive === true;

  /** The fold guard: true (the fold may proceed) until the body says otherwise. */
  guarded = (cardId: string): boolean => this.get(cardId).guarded !== false;

  /** For tests. */
  _reset(): void {
    this.entries.clear();
    this.notify();
  }
}

export const bodyFactsStore = new BodyFactsStore();
