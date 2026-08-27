/**
 * The stranded-queued-send stash — the one piece of card state that
 * deliberately outlives the services bag.
 *
 * A reconnect disposes every card's `CodeSessionStore` before any
 * restore is attempted, so preserving the send queue *inside* the
 * store is not enough: the store dies moments later. These tests pin
 * the stash's own contract — hold, hand back exactly once, and forget
 * on demand — which is what makes the queue survive the rebind.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  clearQueuedSends,
  drainQueuedSends,
  stashQueuedSends,
} from "../lib/session-restore";

type Sends = Parameters<typeof stashQueuedSends>[1];

function sends(...texts: string[]): Sends {
  return texts.map((text, i) => ({
    content: [{ type: "text" as const, text }],
    text,
    atoms: [],
    turnKey: `k${i}`,
    origin: "user" as const,
    queuedAt: 1_700_000_000_000 + i,
  }));
}

const CARD = "card-stash-test";
const OTHER_CARD = "card-stash-test-other";

describe("stranded queued sends", () => {
  beforeEach(() => {
    clearQueuedSends(CARD);
    clearQueuedSends(OTHER_CARD);
  });

  it("hands back what was stashed for the card", () => {
    stashQueuedSends(CARD, sends("one", "two"));

    const drained = drainQueuedSends(CARD);

    expect(drained?.length).toBe(2);
    expect(drained?.[0].text).toBe("one");
    expect(drained?.[1].text).toBe("two");
  });

  it("drains exactly once — a second read would double-send", () => {
    stashQueuedSends(CARD, sends("one"));

    expect(drainQueuedSends(CARD)?.length).toBe(1);
    expect(drainQueuedSends(CARD)).toBeUndefined();
  });

  it("holds nothing for a card that was disposed with an empty queue", () => {
    stashQueuedSends(CARD, sends());

    expect(drainQueuedSends(CARD)).toBeUndefined();
  });

  it("keeps cards separate", () => {
    stashQueuedSends(CARD, sends("mine"));
    stashQueuedSends(OTHER_CARD, sends("theirs"));

    expect(drainQueuedSends(CARD)?.[0].text).toBe("mine");
    expect(drainQueuedSends(OTHER_CARD)?.[0].text).toBe("theirs");
  });

  it("forgets a card's sends on an explicit close", () => {
    // The user closing the card is not an accident; the queue goes
    // with it rather than resurfacing on a later session.
    stashQueuedSends(CARD, sends("one"));

    clearQueuedSends(CARD);

    expect(drainQueuedSends(CARD)).toBeUndefined();
  });

  it("preserves the original submit stamps", () => {
    // The flushed turn's row is dated to when the user hit submit, not
    // to when the recovery happened.
    const original = sends("one", "two");
    stashQueuedSends(CARD, original);

    const drained = drainQueuedSends(CARD);

    expect(drained?.[0].queuedAt).toBe(original[0].queuedAt);
    expect(drained?.[1].queuedAt).toBe(original[1].queuedAt);
  });
});
