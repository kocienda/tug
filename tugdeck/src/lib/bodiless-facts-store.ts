/**
 * What the shell says of a card whose body is not listening: its phase,
 * and whether it is mid-turn.
 *
 * A body card's facts are what its body last published (`card.facts`,
 * read through `bodyFactsStore`). A dormant body publishes nothing more —
 * it has dropped its session subscription — and an evicted one has no page
 * to publish from, so those facts stop at the moment the body went quiet,
 * while the card's session works on in tugcast. A parked card that froze
 * mid-turn would read mid-turn for ever; one that froze idle would never
 * read the turn something else started in it. A card in a workspace nobody
 * has shown this run has no page at all, and no facts to freeze, while its
 * session — one a reloaded shell left running — may be working.
 *
 * So for such a card the shell follows the session with what it already
 * hears for every session, card or no card:
 *
 * - the app-wide ACTIVITY meters (`session-activity-store.ts`): a rate
 *   sample — text, tokens, tools, subagents — is the session working, now;
 * - the session ledger's row (`session-ledger-store.ts`), which tugcast
 *   pushes as `session_updated` whenever it writes it. Its `last_used_at`
 *   moves at a live turn's end (`record_turn`), and also when the turn
 *   count is set from a transcript (`set_turn_count`), at a rewind
 *   (`record_rewound_facts`) and when activity revives a closed session
 *   (`revive_on_activity`): a stamp past the mark is a turn over in every
 *   case, since a working session is never rewound or revived. Its `state`
 *   is whether the session is still there: a row that is not `live`, its
 *   session closed or failed, ends a turn whatever the stamp says.
 *
 * The reading starts from the frozen facts and moves on those two events
 * ({@link enterBodiless}, {@link onActivity}, {@link onLedger}, pure over
 * data), with one horizon: a working reading that has heard no sample for
 * {@link WORKING_HORIZON_MS} falls to idle ({@link onHorizon}), and says so
 * in the dev log, so a session whose end the ledger never stamped cannot
 * turn a dot for ever. When the card's body is listening again — awake, or
 * a new page that has published its own facts — this store lets go of the
 * card and its readers answer from the body as before.
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
import { getShellDeck } from "./deck-store-registry";
import { getSessionActivityStore, type ActivityChannel } from "./session-activity-store";
import { getSessionLedgerStore, subscribeSessionLedger } from "./session-ledger-store";
import { Subscribable } from "./subscribable";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/** The phase keys a session reads while a turn is in flight. */
const WORKING_KEYS: ReadonlySet<string> = new Set([
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

/**
 * How long a working reading stands with no rate sample before it falls to
 * idle. The ledger keeps no turn's duration to measure against, so this is
 * longer than any quiet stretch a live turn has: a turn's tool that runs
 * for minutes with no output, or a question waiting on an answer, is still
 * sampled at its ends. It is a horizon for a session whose end was never
 * written, not a turn's budget.
 */
export const WORKING_HORIZON_MS = 30 * 60_000;

/** The ledger row's fields a reading moves on. */
export type LedgerReading = Pick<SessionRow, "last_used_at" | "state">;

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
 * ended, and so is a row that is no longer `live` — its session closed or
 * failed: a working session, or one that stood waiting on an answer, is
 * idle. Any other phase it froze at — ready, errored — stands.
 */
export function onLedger(reading: BodilessReading, row: LedgerReading | null, atMs: number): BodilessReading {
  const lastUsedAt = row?.last_used_at ?? null;
  const stamped = lastUsedAt !== null && lastUsedAt > reading.mark;
  const gone = row !== null && row.state !== "live";
  const ended = reading.working || reading.activity === "awaiting_approval";
  if (!stamped && !(gone && ended)) return reading;
  return {
    activity: ended ? "idle" : reading.activity,
    working: false,
    mark: stamped ? lastUsedAt : reading.mark,
    endedAt: atMs,
  };
}

/**
 * The horizon: a working reading whose last sign of work was
 * {@link WORKING_HORIZON_MS} or more ago is idle. Anything else stands.
 */
export function onHorizon(reading: BodilessReading, sinceWorkMs: number): BodilessReading {
  if (!reading.working || sinceWorkMs < WORKING_HORIZON_MS) return reading;
  return { ...reading, activity: "idle", working: false };
}

/** The facts the shell shows for a bodiless card. */
export interface BodilessFacts {
  readonly activity: string | null;
  readonly canInterrupt: boolean;
}

/** What the store reads from the running deck; a test hands its own. */
export interface BodilessSources {
  /** Every body card, and every card in a workspace nobody has shown this run. */
  cardIds(): readonly string[];
  /** Whether the shell has made the card a body. */
  hasBody(cardId: string): boolean;
  /** The card's body's facts as the shell holds them, by identity. */
  facts(cardId: string): CardFactsValue | null;
  /** Whether the host has the card's body evicted. */
  evicted(cardId: string): boolean;
  /**
   * The session address the card is bound to, which ACTIVITY is tagged
   * with; for a card with no page, the live ledger row that names it.
   */
  sessionOf(cardId: string): string | null;
  /** The ledger's row for the card's seated segment. */
  row(cardId: string, address: string): SessionRow | null;
  /** Wake on any change to the above. */
  subscribe(listener: () => void): () => void;
  /** Wake on every rate or gauge sample for one session. */
  subscribeActivity(session: string, listener: (channel: ActivityChannel) => void): () => void;
  now(): number;
  /** Run `fire` once, `ms` from now; the return cancels it. */
  after(ms: number, fire: () => void): () => void;
}

/** The cards of every workspace nobody has shown this run, which have no page. */
function unshownCardIds(): string[] {
  const deck = getShellDeck();
  if (deck === null) return [];
  const spaces = deck.getSpacesSnapshot();
  const mounted = new Set(spaces.mountedSpaceIds);
  const ids: string[] = [];
  for (const space of spaces.spaces) {
    if (mounted.has(space.id)) continue;
    for (const card of deck.getSpaceDeck(space.id)?.cards ?? []) ids.push(card.id);
  }
  return ids;
}

const DECK_SOURCES: BodilessSources = {
  cardIds: () => {
    const unshown = unshownCardIds();
    return unshown.length === 0 ? bodyCardsStore.cardIds() : [...bodyCardsStore.cardIds(), ...unshown];
  },
  hasBody: (cardId) => bodyCardsStore.has(cardId),
  facts: (cardId) => bodyFactsStore.factsOf(cardId),
  evicted: (cardId) => bodyCardsStore.stateOf(cardId) === "evicted",
  sessionOf: (cardId) =>
    cardSessionBindingStore.getBinding(cardId)?.tugSessionId ??
    (bodyCardsStore.has(cardId) ? null : (getSessionLedgerStore()?.liveRowForCard(cardId)?.session_id ?? null)),
  row: (cardId, address) => getSessionLedgerStore()?.findRow(ledgerSegmentForCard(cardId, address)) ?? null,
  subscribe: (listener) => {
    const releases = [
      bodyCardsStore.subscribe(listener),
      bodyFactsStore.subscribe(listener),
      cardSessionBindingStore.subscribe(listener),
      subscribeSessionLedger(listener),
      getShellDeck()?.subscribeSpaces(listener) ?? (() => {}),
    ];
    return () => {
      for (const release of releases) release();
    };
  },
  subscribeActivity: (session, listener) => getSessionActivityStore()?.subscribeActivity(session, listener) ?? (() => {}),
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

interface Entry {
  readonly session: string;
  /** The facts the body had when it stopped listening; a new object is a body that has spoken again. */
  readonly frozen: CardFactsValue | null;
  reading: BodilessReading;
  row: SessionRow | null;
  facts: BodilessFacts;
  /** When the reading last had a sign of work: its start, or a rate sample. */
  workAt: number;
  /** The horizon's pending check while the reading is working, or null. */
  horizon: (() => void) | null;
  readonly release: () => void;
}

function factsOf(reading: BodilessReading): BodilessFacts {
  return Object.freeze({ activity: reading.activity, canInterrupt: reading.working });
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
    for (const entry of this.entries.values()) this.drop(entry);
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

  /**
   * Whether the card's body is not listening: no page made for it, dormant,
   * evicted, or a new page that has not spoken.
   */
  private bodiless(cardId: string, facts: CardFactsValue | null): boolean {
    if (!this.sources.hasBody(cardId) || facts?.dormant === true || this.sources.evicted(cardId)) return true;
    const entry = this.entries.get(cardId);
    return entry !== undefined && entry.frozen === facts;
  }

  private reconcile(): void {
    let changed = false;
    const live = new Set(this.sources.cardIds());
    for (const [cardId, entry] of this.entries) {
      if (live.has(cardId)) continue;
      this.drop(entry);
      this.entries.delete(cardId);
      changed = true;
    }
    for (const cardId of live) {
      const facts = this.sources.facts(cardId);
      const session = this.sources.sessionOf(cardId);
      const entry = this.entries.get(cardId);
      if (session === null || !this.bodiless(cardId, facts)) {
        if (entry !== undefined) {
          this.drop(entry);
          this.entries.delete(cardId);
          changed = true;
        }
        continue;
      }
      if (entry !== undefined && entry.session === session) {
        if (this.follow(cardId, entry)) changed = true;
        continue;
      }
      if (entry !== undefined) this.drop(entry);
      this.enter(cardId, session, facts);
      changed = true;
    }
    if (changed) this.notify();
  }

  private drop(entry: Entry): void {
    entry.horizon?.();
    entry.horizon = null;
    entry.release();
  }

  private enter(cardId: string, session: string, frozen: CardFactsValue | null): void {
    const row = this.sources.row(cardId, session);
    const now = this.sources.now();
    const reading = onLedger(enterBodiless(frozen, row?.last_used_at ?? null, now), row, now);
    const release = this.sources.subscribeActivity(session, (channel) => {
      const current = this.entries.get(cardId);
      if (current === undefined) return;
      const at = this.sources.now();
      const next = onActivity(current.reading, channel, at);
      if (next.working) current.workAt = at;
      if (next === current.reading) return;
      this.take(cardId, current, next);
      this.notify();
    });
    const entry: Entry = { session, frozen, reading, row, facts: factsOf(reading), workAt: now, horizon: null, release };
    this.entries.set(cardId, entry);
    this.armHorizon(cardId, entry);
  }

  /** Take `reading` as the card's, and set the horizon for it. */
  private take(cardId: string, entry: Entry, reading: BodilessReading): void {
    entry.reading = reading;
    entry.facts = factsOf(reading);
    this.armHorizon(cardId, entry);
  }

  /**
   * While the reading is working, one pending check at its horizon from the
   * last sign of work; a sample since moves the next check on rather than
   * setting a timer per sample. Nothing while it is not working.
   */
  private armHorizon(cardId: string, entry: Entry): void {
    if (!entry.reading.working) {
      entry.horizon?.();
      entry.horizon = null;
      return;
    }
    if (entry.horizon !== null) return;
    const wait = Math.max(0, entry.workAt + WORKING_HORIZON_MS - this.sources.now());
    entry.horizon = this.sources.after(wait, () => {
      entry.horizon = null;
      if (this.entries.get(cardId) !== entry) return;
      const since = this.sources.now() - entry.workAt;
      const next = onHorizon(entry.reading, since);
      if (next === entry.reading) {
        this.armHorizon(cardId, entry);
        return;
      }
      tugDevLogStore.warn("bodiless-facts", "a working reading heard nothing past its horizon and falls to idle", {
        cardId,
        session: entry.session,
        activity: entry.reading.activity,
        quietMs: since,
      });
      this.take(cardId, entry, next);
      this.notify();
    });
  }

  /** Take the ledger's row as it stands; true when the card's facts moved. */
  private follow(cardId: string, entry: Entry): boolean {
    const row = this.sources.row(cardId, entry.session);
    if (row === entry.row) return false;
    entry.row = row;
    const reading = onLedger(entry.reading, row, this.sources.now());
    if (reading === entry.reading) return false;
    const prev = entry.facts;
    this.take(cardId, entry, reading);
    return entry.facts.activity !== prev.activity || entry.facts.canInterrupt !== prev.canInterrupt;
  }
}

export const bodilessFactsStore = new BodilessFactsStore();
