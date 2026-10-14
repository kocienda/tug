/**
 * The deck a body's card sees is synthesized from the shell's `card-context`:
 * its fold, its arrival and the deck's first responder read back through the
 * selectors the card uses, the card's activation fires on a flip to it and
 * only on one, and a verb that belongs to the deck's arrangement does nothing
 * and says so with its inert answer.
 *
 * @covers tugdeck/src/body/body-deck-bridge.ts
 */
import { describe, expect, test } from "bun:test";
import type { CardAdvice, CardContext } from "@tugproto/bus";
import { cardArrivingOf, cardFoldedOf } from "../../deck-store-selectors";
import { BodyDeckBridge, bodyPaneId } from "../body-deck-bridge";

const CARD = "c-bridge";

function context(over: Partial<CardContext> = {}): CardContext {
  return {
    folded: false,
    arriving: false,
    firstResponderCardId: null,
    layerShown: true,
    spaceId: null,
    ...over,
  };
}

function bridge(advice: CardAdvice[] = []): BodyDeckBridge {
  return new BodyDeckBridge({
    cardId: CARD,
    componentId: "session",
    advise: (a) => advice.push(a),
    putCardState: () => Promise.resolve(true),
  });
}

describe("the synthesized deck", () => {
  test("answers fold, arrival and first responder from each card-context in turn", () => {
    const b = bridge();
    expect(b.getSnapshot().panes.map((p) => p.id)).toEqual([bodyPaneId(CARD)]);
    expect(b.getSnapshot().cards.map((c) => c.id)).toEqual([CARD]);

    b.applyContext(context({ arriving: true }));
    expect(cardArrivingOf(b.getSnapshot(), CARD)).toBe(true);
    expect(cardFoldedOf(b.getSnapshot(), CARD)).toBe(false);
    expect(b.getFirstResponderCardId()).toBe(null);
    expect(b.getSnapshot().activePaneId).toBeUndefined();

    b.applyContext(context({ firstResponderCardId: CARD }));
    expect(cardArrivingOf(b.getSnapshot(), CARD)).toBe(false);
    expect(b.getFirstResponderCardId()).toBe(CARD);
    expect(b.getSnapshot().activePaneId).toBe(bodyPaneId(CARD));

    b.applyContext(context({ folded: true, firstResponderCardId: "another" }));
    expect(cardFoldedOf(b.getSnapshot(), CARD)).toBe(true);
    expect(b.getFirstResponderCardId()).toBe("another");
    expect(b.getSnapshot().activePaneId).toBeUndefined();
  });

  test("a context that changes nothing the snapshot carries does not notify", () => {
    const b = bridge();
    let notified = 0;
    b.subscribe(() => {
      notified += 1;
    });
    b.applyContext(context({ folded: true }));
    b.applyContext(context({ folded: true, spaceId: "space-2" }));
    expect(notified).toBe(1);
  });
});

describe("activation", () => {
  test("fires on the flips to and from the card, and only on them", () => {
    const b = bridge();
    const events: string[] = [];
    b.observeCardDidActivate(CARD, () => events.push("activate"));
    b.observeCardDidDeactivate(CARD, () => events.push("deactivate"));

    b.applyContext(context({ firstResponderCardId: "another" }));
    b.applyContext(context({ firstResponderCardId: CARD }));
    b.applyContext(context({ firstResponderCardId: CARD, folded: true }));
    b.applyContext(context({ firstResponderCardId: null }));
    b.applyContext(context({ firstResponderCardId: "another" }));

    expect(events).toEqual(["activate", "deactivate"]);
  });
});

describe("the shell's verbs", () => {
  test("a forwarded verb becomes advice, and an inert one answers inertly", () => {
    const advice: CardAdvice[] = [];
    const b = bridge(advice);
    b.setSheetReservation(CARD, 240);
    b.setOpeningBid(CARD, null);
    b.activateCard(CARD);
    b.removeCard(bodyPaneId(CARD), CARD);
    expect(advice).toEqual([
      { advice: "sheet-reservation", heightPx: 240 },
      { advice: "opening-bid", heightPx: null },
      { advice: "activate" },
      { advice: "close-request" },
    ]);

    expect(b.addCard("session")).toBe(null);
    expect(b.moveInColumn(bodyPaneId(CARD), "up")).toBe(false);
    expect(b.movePaneToSlot(bodyPaneId(CARD), 1)).toEqual({ ok: false });
    expect(b.getSpacesSnapshot().spaces).toEqual([]);
  });
});
