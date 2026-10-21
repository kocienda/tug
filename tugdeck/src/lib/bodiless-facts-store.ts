/**
 * What the shell says of a card whose body is not listening: its phase,
 * whether it is mid-turn, its turn count and when it was last used.
 *
 * A body card's facts are what its body last published (`card.facts`,
 * read through `bodyFactsStore`). A dormant body publishes nothing more —
 * it has dropped its session subscription — and an evicted one has no page
 * to publish from, so those facts stop at the moment the body went quiet,
 * while the card's session works on in tugcast. A parked card that froze
 * mid-turn would read mid-turn for ever; one that froze idle would never
 * read the turn something else started in it.
 *
 * So for such a card the shell follows the session with what it already
 * hears for every session, card or no card:
 *
 * - the app-wide ACTIVITY meters (`session-activity-store.ts`): a rate
 *   sample — text, tokens, tools, subagents — is the session working, now;
 * - the session ledger's row (`session-ledger-store.ts`), which tugcast
 *   stamps and pushes as `session_updated` at every live turn's end
 *   (`last_used_at`), and which carries the turn count.
 *
 * The reading starts from the frozen facts and moves on those two events
 * alone ({@link enterBodiless}, {@link onActivity}, {@link onLedger}, pure
 * over data). When the card's body is listening again — awake, or a new
 * page that has published its own facts — this store lets go of the card
 * and its readers answer from the body as before.
 *
 * Nothing here names the tier: the readers answer the same kind of fact the
 * body would have, and a dormant or evicted card reads like any card not in
 * front.
 *
 * Laws: [L02] read through `useSyncExternalStore` by its callers; [L22] its
 * own sources are subscribed to directly, never through React.
 *
 * @module lib/bodiless-facts-store
 */

import type { CardFactsValue } from "../bus/declarations/card";
import type { SessionRow } from "../protocol";
import { ACTIVITY_BIN_MS } from "./activity-meter";
import { bodyCardsStore } from "./body-cards-store";
import { bodyFactsStore } from "./body-facts-store";
import { cardSessionBindingStore, ledgerSegmentForCard } from "./card-session-binding-store";
import { getSessionActivityStore, type ActivityChannel } from "./session-activity-store";
import { getSessionLedgerStore, subscribeSessionLedger } from "./session-ledger-store";
import { Subscribable } from "./subscribable";

/** The phase keys a session reads while a turn is in flight. */
export const WORKING_KEYS: ReadonlySet<string> = new Set([
  "submitting",
  "awaiting_first_token",
  "streaming",
  "tool_work",
  "replaying",
  "waking",
  "interrupting",
]);

/** The channels whose sample is the session doing work; the gauges are the OS's. */
const RATE_CHANNELS: ReadonlySet<ActivityChannel> = new Set<ActivityChannel>(["text", "tokens", "tools", "subagents"]);

/**
 * How long after the ledger stamped a turn's end a rate sample is still that
 * turn's tail rather than a new turn: two of the meters' bins, since a frame
 * carries up to a bin of samples and may land just after the push.
 */
export const TURN_TAIL_MS = 2 * ACTIVITY_BIN_MS;

/** What the shell reads of a bodiless card's session. */
export interface BodilessReading {
  /** The phase key, as the body would have computed it. */
  readonly activity: string | null;
  /** Whether a turn is in flight. */
  readonly working: boolean;
  /** The ledger's `last_used_at` the reading has accounted for. */
  readonly mark: number;
  /** When the last turn's end was heard, on this page's clock, or null. */
  readonly endedAt: number | null;
}

/**
 * The reading for a card whose body has just stopped listening: what its
 * facts last said, with the ledger's stamp as it stood then, so only a turn
 * that ends from here on moves it.
 */
export function enterBodiless(
  frozen: Pick<CardFactsValue, "activity" | "canInterrupt"> | null,
  lastUsedAt: number | null,
  nowMs: number,
): BodilessReading {
  const activity = frozen?.activity ?? null;
  return {
    activity,
    working: frozen?.canInterrupt === true || (activity !== null && WORKING_KEYS.has(activity)),
    mark: lastUsedAt ?? nowMs,
    endedAt: null,
  };
}

/**
 * A rate sample for the session: it is working. Tools and subagents read as
 * tool work, text and tokens as streaming. A sample in the tail of a turn
 * whose end was just heard changes nothing.
 */
export function onActivity(reading: BodilessReading, channel: ActivityChannel, atMs: number): BodilessReading {
  if (!RATE_CHANNELS.has(channel)) return reading;
  if (reading.endedAt !== null && atMs - reading.endedAt < TURN_TAIL_MS) return reading;
  const activity = channel === "tools" || channel === "subagents" ? "tool_work" : "streaming";
  if (reading.working && reading.activity === activity) return reading;
  return { ...reading, activity, working: true };
}

/**
 * The ledger's row moved. A `last_used_at` past the mark is a turn that
 * ended: a working session, or one that stood waiting on an answer, is idle.
 * Any other phase it froze at — ready, errored — stands.
 */
export function onLedger(reading: BodilessReading, lastUsedAt: number | null, atMs: number): BodilessReading {
  if (lastUsedAt === null || lastUsedAt <= reading.mark) return reading;
  const ended = reading.working || reading.activity === "awaiting_approval";
  return {
    activity: ended ? "idle" : reading.activity,
    working: false,
    mark: lastUsedAt,
    endedAt: atMs,
  };
}

/** The facts the shell shows for a bodiless card. */
export interface BodilessFacts {
  readonly activity: string | null;
  readonly canInterrupt: boolean;
  /** The ledger's turn count, or null while the shell has no row for the session. */
  readonly turnCount: number | null;
  /** When the session was last used, from the ledger, or null. */
  readonly lastUsedAt: number | null;
}

/** What the store reads from the running deck; a test hands its own. */
export interface BodilessSources {
  /** Every body card. */
  cardIds(): readonly string[];
  /** The card's body's facts as the shell holds them, by identity. */
  facts(cardId: string): CardFactsValue | null;
  /** Whether the host has the card's body evicted. */
  evicted(cardId: string): boolean;
  /** The session address the card is bound to, which ACTIVITY is tagged with. */
  sessionOf(cardId: string): string | null;
  /** The ledger's row for the card's seated segment. */
  row(cardId: string, address: string): SessionRow | null;
  /** Wake on any change to the above. */
  subscribe(listener: () => void): () => void;
  /** Wake on every rate or gauge sample for one session. */
  subscribeActivity(session: string, listener: (channel: ActivityChannel) => void): () => void;
  now(): number;
}

const DECK_SOURCES: BodilessSources = {
  cardIds: () => bodyCardsStore.cardIds(),
  facts: (cardId) => bodyFactsStore.factsOf(cardId),
  evicted: (cardId) => bodyCardsStore.stateOf(cardId) === "evicted",
  sessionOf: (cardId) => cardSessionBindingStore.getBinding(cardId)?.tugSessionId ?? null,
  row: (cardId, address) => getSessionLedgerStore()?.findRow(ledgerSegmentForCard(cardId, address)) ?? null,
  subscribe: (listener) => {
    const releases = [
      bodyCardsStore.subscribe(listener),
      bodyFactsStore.subscribe(listener),
      cardSessionBindingStore.subscribe(listener),
      subscribeSessionLedger(listener),
    ];
    return () => {
      for (const release of releases) release();
    };
  },
  subscribeActivity: (session, listener) => getSessionActivityStore()?.subscribeActivity(session, listener) ?? (() => {}),
  now: () => Date.now(),
};

interface Entry {
  readonly session: string;
  /** The facts the body had when it stopped listening; a new object is a body that has spoken again. */
  readonly frozen: CardFactsValue | null;
  reading: BodilessReading;
  row: SessionRow | null;
  facts: BodilessFacts;
  readonly release: () => void;
}

function factsOf(reading: BodilessReading, row: SessionRow | null): BodilessFacts {
  return Object.freeze({
    activity: reading.activity,
    canInterrupt: reading.working,
    turnCount: row?.turn_count ?? null,
    lastUsedAt: row?.last_used_at ?? null,
  });
}

export class BodilessFactsStore extends Subscribable {
  private readonly entries = new Map<string, Entry>();
  private release: (() => void) | null = null;

  constructor(private readonly sources: BodilessSources = DECK_SOURCES) {
    super();
  }

  /**
   * Start following: the shell calls this once its body cards exist. Until
   * then, and on any page but the shell, every reader answers from the body.
   */
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
    for (const entry of this.entries.values()) entry.release();
    const had = this.entries.size > 0;
    this.entries.clear();
    if (had) this.notify();
  }

  /** The facts the shell shows for the card while its body is not listening, or null when it is. */
  bodilessOf = (cardId: string): BodilessFacts | null => this.entries.get(cardId)?.facts ?? null;

  /** The card's phase key: the session's, while its body is not listening; else what the body said. */
  activityOf = (cardId: string): string | null => {
    const entry = this.entries.get(cardId);
    return entry !== undefined ? entry.facts.activity : bodyFactsStore.activityOf(cardId);
  };

  /** Whether the card's session is mid-turn, by the same rule as {@link activityOf}. */
  canInterrupt = (cardId: string): boolean => {
    const entry = this.entries.get(cardId);
    return entry !== undefined ? entry.facts.canInterrupt : bodyFactsStore.canInterrupt(cardId);
  };

  /** Whether the card's body is not listening: dormant, evicted, or a new page that has not spoken. */
  private bodiless(cardId: string, facts: CardFactsValue | null): boolean {
    if (facts?.dormant === true || this.sources.evicted(cardId)) return true;
    const entry = this.entries.get(cardId);
    return entry !== undefined && entry.frozen === facts;
  }

  private reconcile(): void {
    let changed = false;
    const live = new Set(this.sources.cardIds());
    for (const [cardId, entry] of this.entries) {
      if (live.has(cardId)) continue;
      entry.release();
      this.entries.delete(cardId);
      changed = true;
    }
    for (const cardId of live) {
      const facts = this.sources.facts(cardId);
      const session = this.sources.sessionOf(cardId);
      const entry = this.entries.get(cardId);
      if (session === null || !this.bodiless(cardId, facts)) {
        if (entry !== undefined) {
          entry.release();
          this.entries.delete(cardId);
          changed = true;
        }
        continue;
      }
      if (entry !== undefined && entry.session === session) {
        if (this.follow(cardId, entry)) changed = true;
        continue;
      }
      entry?.release();
      this.enter(cardId, session, facts);
      changed = true;
    }
    if (changed) this.notify();
  }

  private enter(cardId: string, session: string, frozen: CardFactsValue | null): void {
    const row = this.sources.row(cardId, session);
    const reading = enterBodiless(frozen, row?.last_used_at ?? null, this.sources.now());
    const release = this.sources.subscribeActivity(session, (channel) => {
      const current = this.entries.get(cardId);
      if (current === undefined) return;
      const next = onActivity(current.reading, channel, this.sources.now());
      if (next === current.reading) return;
      current.reading = next;
      current.facts = factsOf(next, current.row);
      this.notify();
    });
    this.entries.set(cardId, { session, frozen, reading, row, facts: factsOf(reading, row), release });
  }

  /** Take the ledger's row as it stands; true when the card's facts moved. */
  private follow(cardId: string, entry: Entry): boolean {
    const row = this.sources.row(cardId, entry.session);
    if (row === entry.row) return false;
    entry.row = row;
    entry.reading = onLedger(entry.reading, row?.last_used_at ?? null, this.sources.now());
    const next = factsOf(entry.reading, row);
    const prev = entry.facts;
    entry.facts = next;
    return (
      next.activity !== prev.activity ||
      next.canInterrupt !== prev.canInterrupt ||
      next.turnCount !== prev.turnCount ||
      next.lastUsedAt !== prev.lastUsedAt
    );
  }
}

export const bodilessFactsStore = new BodilessFactsStore();
