/**
 * A card whose body is dormant or evicted reads its session, not the facts
 * the body froze at: a rate sample is the session working, the ledger's
 * turn-end stamp is the turn over, and a body that speaks again takes its
 * card back. The derivation is pure over data; the store is driven here by
 * sources that hold plain values.
 *
 * @covers tugdeck/src/lib/bodiless-facts-store.ts
 */
import { describe, expect, test } from "bun:test";

import type { CardFactsValue } from "../../bus/declarations/card";
import type { SessionRow } from "../../protocol";
import type { ActivityChannel } from "../session-activity-store";
import {
  BodilessFactsStore,
  enterBodiless,
  onActivity,
  onLedger,
  TURN_TAIL_MS,
  type BodilessSources,
} from "../bodiless-facts-store";

function facts(over: Partial<CardFactsValue> = {}): CardFactsValue {
  return {
    title: "tug/odd-kiln",
    masthead: null,
    activity: "idle",
    identity: null,
    titleBar: null,
    canInterrupt: false,
    compacted: false,
    dormant: false,
    ...over,
  };
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return { session_id: "s1", turn_count: 3, last_used_at: 1_000, state: "live", ...over } as unknown as SessionRow;
}

describe("the derivation", () => {
  test("a body frozen mid-turn is working; one frozen idle is not", () => {
    expect(enterBodiless(facts({ activity: "streaming", canInterrupt: true }), 1_000, 5_000)).toEqual({
      activity: "streaming",
      working: true,
      mark: 1_000,
      endedAt: null,
    });
    expect(enterBodiless(facts({ activity: "tool_work" }), null, 5_000)).toMatchObject({ working: true, mark: 5_000 });
    expect(enterBodiless(facts(), 1_000, 5_000)).toMatchObject({ activity: "idle", working: false });
    expect(enterBodiless(null, null, 5_000)).toMatchObject({ activity: null, working: false });
  });

  test("a rate sample is the session working; a gauge sample is the machine", () => {
    const idle = enterBodiless(facts(), 1_000, 5_000);
    expect(onActivity(idle, "text", 6_000)).toMatchObject({ activity: "streaming", working: true });
    expect(onActivity(idle, "tokens", 6_000)).toMatchObject({ activity: "streaming", working: true });
    expect(onActivity(idle, "tools", 6_000)).toMatchObject({ activity: "tool_work", working: true });
    expect(onActivity(idle, "subagents", 6_000)).toMatchObject({ activity: "tool_work", working: true });
    expect(onActivity(idle, "cpu", 6_000)).toBe(idle);
    expect(onActivity(idle, "memory", 6_000)).toBe(idle);
    const streaming = onActivity(idle, "text", 6_000);
    expect(onActivity(streaming, "tokens", 6_100), "the same reading keeps its object").toBe(streaming);
  });

  test("the ledger's stamp past the mark ends the turn; one at or before it does not", () => {
    const working = enterBodiless(facts({ activity: "streaming", canInterrupt: true }), 1_000, 5_000);
    expect(onLedger(working, 1_000, 6_000)).toBe(working);
    expect(onLedger(working, null, 6_000)).toBe(working);
    expect(onLedger(working, 2_000, 6_000)).toEqual({ activity: "idle", working: false, mark: 2_000, endedAt: 6_000 });
    const asking = enterBodiless(facts({ activity: "awaiting_approval" }), 1_000, 5_000);
    expect(onLedger(asking, 2_000, 6_000)).toMatchObject({ activity: "idle" });
    const errored = enterBodiless(facts({ activity: "errored" }), 1_000, 5_000);
    expect(onLedger(errored, 2_000, 6_000)).toMatchObject({ activity: "errored", mark: 2_000 });
  });

  test("a sample in the tail of a turn that just ended is that turn's, and one after is a new turn", () => {
    const ended = onLedger(enterBodiless(facts({ activity: "streaming" }), 1_000, 5_000), 2_000, 6_000);
    expect(onActivity(ended, "text", 6_000 + TURN_TAIL_MS - 1)).toBe(ended);
    expect(onActivity(ended, "text", 6_000 + TURN_TAIL_MS)).toMatchObject({ activity: "streaming", working: true });
  });
});

/** Sources holding plain values, set by the test, which wake the store when told. */
class Deck implements BodilessSources {
  cards: string[] = [];
  readonly cardFacts = new Map<string, CardFactsValue | null>();
  readonly evictedCards = new Set<string>();
  readonly sessions = new Map<string, string>();
  readonly rows = new Map<string, SessionRow>();
  clock = 10_000;
  private readonly listeners = new Set<() => void>();
  readonly activity = new Map<string, Set<(channel: ActivityChannel) => void>>();

  cardIds = (): readonly string[] => this.cards;
  facts = (cardId: string): CardFactsValue | null => this.cardFacts.get(cardId) ?? null;
  evicted = (cardId: string): boolean => this.evictedCards.has(cardId);
  sessionOf = (cardId: string): string | null => this.sessions.get(cardId) ?? null;
  row = (_cardId: string, address: string): SessionRow | null => this.rows.get(address) ?? null;
  now = (): number => this.clock;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  subscribeActivity = (session: string, listener: (channel: ActivityChannel) => void): (() => void) => {
    let set = this.activity.get(session);
    if (set === undefined) this.activity.set(session, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  };

  changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
  sample(session: string, channel: ActivityChannel): void {
    for (const listener of [...(this.activity.get(session) ?? [])]) listener(channel);
  }
}

function setup(): { deck: Deck; store: BodilessFactsStore; ticks: () => number } {
  const deck = new Deck();
  deck.cards = ["a"];
  deck.sessions.set("a", "s1");
  deck.cardFacts.set("a", facts({ activity: "streaming", canInterrupt: true }));
  deck.rows.set("s1", row({ last_used_at: 1_000, turn_count: 3 }));
  const store = new BodilessFactsStore(deck);
  let count = 0;
  store.subscribe(() => (count += 1));
  store.attach();
  return { deck, store, ticks: () => count };
}

describe("the store", () => {
  test("a listening body's card is not followed", () => {
    const { store } = setup();
    expect(store.bodilessOf("a")).toBeNull();
  });

  test("a dormant card follows its session through a turn's end and a new turn", () => {
    const { deck, store } = setup();
    deck.cardFacts.set("a", facts({ activity: "streaming", canInterrupt: true, dormant: true }));
    deck.changed();
    expect(store.bodilessOf("a")).toEqual({ activity: "streaming", canInterrupt: true, turnCount: 3, lastUsedAt: 1_000 });

    // The turn ends on tugcast: the ledger's push stamps it, with the new count.
    deck.rows.set("s1", row({ last_used_at: 2_000, turn_count: 4 }));
    deck.changed();
    expect(store.bodilessOf("a")).toEqual({ activity: "idle", canInterrupt: false, turnCount: 4, lastUsedAt: 2_000 });
    expect(store.activityOf("a")).toBe("idle");
    expect(store.canInterrupt("a")).toBe(false);

    // Something starts a new turn in the parked card.
    deck.clock += TURN_TAIL_MS;
    deck.sample("s1", "tools");
    expect(store.activityOf("a")).toBe("tool_work");
    expect(store.canInterrupt("a")).toBe(true);
  });

  test("an evicted card is followed with the facts it stood at, and its new page takes it back once it speaks", () => {
    const { deck, store } = setup();
    deck.evictedCards.add("a");
    deck.changed();
    expect(store.activityOf("a")).toBe("streaming");

    // Asked for again: the host is making a new page; the old facts still stand.
    deck.evictedCards.delete("a");
    deck.changed();
    expect(store.bodilessOf("a"), "a new page that has not spoken leaves the card followed").not.toBeNull();

    // The new page publishes its own facts.
    deck.cardFacts.set("a", facts({ activity: "idle" }));
    deck.changed();
    expect(store.bodilessOf("a")).toBeNull();
    expect(store.activityOf("a"), "the body's own facts answer once it speaks").toBeNull();
  });

  test("a woken body takes its card back, and its session's samples no longer reach the store", () => {
    const { deck, store, ticks } = setup();
    deck.cardFacts.set("a", facts({ activity: "streaming", dormant: true }));
    deck.changed();
    deck.cardFacts.set("a", facts({ activity: "idle", dormant: false }));
    deck.changed();
    expect(store.bodilessOf("a")).toBeNull();
    expect(deck.activity.get("s1")?.size ?? 0).toBe(0);
    const before = ticks();
    deck.sample("s1", "text");
    expect(ticks()).toBe(before);
  });

  test("a card that closes, or loses its session, is let go", () => {
    const { deck, store } = setup();
    deck.cardFacts.set("a", facts({ dormant: true }));
    deck.changed();
    deck.sessions.delete("a");
    deck.changed();
    expect(store.bodilessOf("a")).toBeNull();
    deck.sessions.set("a", "s1");
    deck.changed();
    expect(store.bodilessOf("a")).not.toBeNull();
    deck.cards = [];
    deck.changed();
    expect(store.bodilessOf("a")).toBeNull();
    expect(deck.activity.get("s1")?.size ?? 0).toBe(0);
  });

  test("a change that moves nothing notifies nobody", () => {
    const { deck, ticks } = setup();
    deck.cardFacts.set("a", facts({ dormant: true }));
    deck.changed();
    const before = ticks();
    deck.changed();
    deck.rows.set("s1", row({ last_used_at: 1_000, turn_count: 3 }));
    deck.changed();
    expect(ticks()).toBe(before);
  });

  test("detached, it follows nothing", () => {
    const { deck, store } = setup();
    deck.cardFacts.set("a", facts({ dormant: true }));
    deck.changed();
    store.detach();
    expect(store.bodilessOf("a")).toBeNull();
    expect(deck.activity.get("s1")?.size ?? 0).toBe(0);
  });
});
