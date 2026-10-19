/**
 * The deck's facts and a card's context as the shell and its bodies trade
 * them: the declared stores of `bus/declarations/deck.ts` and
 * `bus/declarations/card.ts` on the test bus, with the real library on
 * every page.
 *
 * @covers tugdeck/src/bus/declarations/deck.ts
 * @covers tugdeck/src/bus/declarations/card.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cardContext, cardCrossing, NO_CARD_CONTEXT } from "../declarations/card";
import { deckFacts, deckMenu, type DeckFactsValue } from "../declarations/deck";
import { sessionIntent } from "../declarations/verbs";
import { createTestBus, type TestBus } from "../test-bus";

let bus: TestBus;
afterEach(() => bus?.dispose());

const FACTS: DeckFactsValue = {
  theme: "ironclad",
  zoom: 1,
  keyboardAccess: false,
  modifierLatch: [],
  focusRingModality: "pointer",
  appActive: true,
  motionDemoted: false,
};

describe("deck and card stores", () => {
  test("a body that attaches after a theme change reads it, and its context, before anything the shell held for it", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    deckFacts.on(shell.bus).set(FACTS);
    deckFacts.on(shell.bus).set({ ...FACTS, theme: "sloop" });
    cardContext.on(shell.bus).setFor("c1", { ...NO_CARD_CONTEXT, arriving: true });

    // What the shell sends a body when its page says hello, as `body-shell`
    // sends a decided intent: after the stores.
    const seen: Array<{ theme: string; arriving: boolean; contextArrived: boolean }> = [];
    shell.bus.onAttach((cardId) => sessionIntent.on(shell.bus).dispatch({ kind: "restore" }, { card: cardId }));
    const body = bus.body("c1", "session");
    sessionIntent.on(body.bus).handle(() => {
      seen.push({
        theme: deckFacts.on(body.bus).getSnapshot().theme,
        arriving: cardContext.on(body.bus).getSnapshot().arriving,
        contextArrived: cardContext.on(body.bus).arrived(),
      });
    });
    await bus.flush();

    expect(seen).toEqual([{ theme: "sloop", arriving: true, contextArrived: true }]);
  });

  test("a fold moves card.context for that card only", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    const a = bus.body("a", "session");
    const b = bus.body("b", "session");
    cardContext.on(shell.bus).setFor("a", NO_CARD_CONTEXT);
    cardContext.on(shell.bus).setFor("b", NO_CARD_CONTEXT);
    await bus.flush();
    let bNotified = 0;
    cardContext.on(b.bus).subscribe(() => bNotified++);
    const before = bus.frames().length;

    cardContext.on(shell.bus).setFor("a", { ...NO_CARD_CONTEXT, folded: true });
    // An unchanged value is not a change: nothing goes out.
    cardContext.on(shell.bus).setFor("b", { ...NO_CARD_CONTEXT });
    await bus.flush();

    expect(cardContext.on(a.bus).getSnapshot().folded).toBe(true);
    expect(cardContext.on(b.bus).getSnapshot().folded).toBe(false);
    expect(bNotified).toBe(0);
    const sent = bus.frames().slice(before).filter((f) => f.envelope.kind === "state");
    expect(sent.map((f) => (f.envelope as { card?: string }).card)).toEqual(["a"]);
  });

  test("a reloaded shell's stores are read afresh, at whatever version they restart from", async () => {
    bus = createTestBus();
    const first = bus.shell();
    await bus.flush();
    const body = bus.body("c1", "session");
    deckFacts.on(first.bus).set(FACTS);
    deckFacts.on(first.bus).set({ ...FACTS, zoom: 1.25 });
    deckMenu.on(first.bus).set({ projection: { panes: 2 }, focusTravel: null });
    cardCrossing.on(first.bus).setFor("c1", { still: 3, settled: false, width: false, heightFree: false, fold: null, held: {} });
    await bus.flush();
    expect(deckFacts.on(body.bus).getSnapshot().zoom).toBe(1.25);

    // The reload: a new shell page, whose versions start again at 1.
    bus.leave(first);
    const second = bus.shell();
    deckFacts.on(second.bus).set({ ...FACTS, theme: "kayak" });
    deckMenu.on(second.bus).set({ projection: { panes: 1 }, focusTravel: null });
    cardCrossing.on(second.bus).setFor("c1", null);
    await bus.flush();

    expect(deckFacts.on(body.bus).getSnapshot()).toEqual({ ...FACTS, theme: "kayak" });
    expect(deckMenu.on(body.bus).getSnapshot()).toEqual({ projection: { panes: 1 }, focusTravel: null });
    expect(cardCrossing.on(body.bus).getSnapshot()).toBeNull();
  });

  test("a context the codec refuses is dropped and logged, and the last good one stands", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    const body = bus.body("c1", "session");
    cardContext.on(shell.bus).setFor("c1", { ...NO_CARD_CONTEXT, spaceId: "s1" });
    await bus.flush();
    shell.bus.post({ to: { card: "c1" }, kind: "state", key: "card.context", card: "c1", version: 99, payload: { folded: "yes" } });
    await bus.flush();

    expect(cardContext.on(body.bus).getSnapshot().spaceId).toBe("s1");
    expect(body.log.some((l) => l.level === "warn" && l.message.includes("card.context"))).toBe(true);
  });
});
