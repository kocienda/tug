/**
 * The mirror a body page keeps of the session phase the shell's arrangement
 * reported for every other card: one short key per card, notified only when
 * one moves, forgotten when the arrangement stops naming it.
 *
 * @covers tugdeck/src/lib/card-activity-elsewhere.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cardActivityElsewhere } from "../card-activity-elsewhere";

afterEach(() => {
  cardActivityElsewhere._reset();
});

describe("cardActivityElsewhere", () => {
  test("holds what was reported and forgets on null", () => {
    expect(cardActivityElsewhere.get("c1")).toBeNull();
    cardActivityElsewhere.set("c1", "streaming");
    expect(cardActivityElsewhere.get("c1")).toBe("streaming");
    cardActivityElsewhere.set("c1", "idle");
    expect(cardActivityElsewhere.get("c1")).toBe("idle");
    cardActivityElsewhere.set("c1", null);
    expect(cardActivityElsewhere.get("c1")).toBeNull();
    expect(cardActivityElsewhere.cardIds()).toEqual([]);
  });

  test("notifies only when a card's phase moves", () => {
    let heard = 0;
    const release = cardActivityElsewhere.subscribe(() => {
      heard += 1;
    });
    try {
      cardActivityElsewhere.set("c9", "tool_work");
      cardActivityElsewhere.set("c9", "tool_work");
      cardActivityElsewhere.set("c9", "streaming");
      cardActivityElsewhere.set("c9", null);
      cardActivityElsewhere.set("c9", null);
      expect(heard).toBe(3);
    } finally {
      release();
    }
  });
});
