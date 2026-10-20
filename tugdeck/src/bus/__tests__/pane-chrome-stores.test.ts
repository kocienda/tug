/**
 * A card's pane as its body reads it, and the gestures a card's chrome asks
 * of the shell: the declarations of `bus/declarations/pane.ts` on the test
 * bus, with the real library on every page, and the shell's rule for which
 * pane a verb from a body may act on.
 *
 * @covers tugdeck/src/bus/declarations/pane.ts
 * @covers tugdeck/src/lib/pane-verbs.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { registerCard } from "../../card-registry";
import type { DeckState } from "../../layout-tree";
import { paneChromeFor } from "../../lib/pane-chrome-projection";
import { paneVerbAddress } from "../../lib/pane-verbs";
import { cardContext, NO_CARD_CONTEXT } from "../declarations/card";
import { paneChrome, paneCloseCard, paneSelectTab } from "../declarations/pane";
import { createTestBus, type TestBus } from "../test-bus";

registerCard({
  componentId: "pane-chrome-stores-doc",
  contentFactory: () => null,
  defaultMeta: { title: "Doc", closable: true },
});

let bus: TestBus;
afterEach(() => bus?.dispose());

function deckOf(panes: Array<{ id: string; cardIds: string[] }>): DeckState {
  return {
    cards: panes.flatMap((p) => p.cardIds.map((id) => ({ id, componentId: "pane-chrome-stores-doc", title: "", closable: true }))),
    panes: panes.map((p) => ({
      id: p.id,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
      cardIds: p.cardIds,
      activeCardId: p.cardIds[0],
      title: "",
      acceptsFamilies: ["standard"],
    })),
    imposition: { sidebars: {} },
    hasFocus: true,
  };
}

const READERS = { titleOf: () => null, waives: () => false, spaces: { list: [], ownSpaceId: null } };

describe("pane.chrome", () => {
  test("a body that attaches after a tab is added reads both tabs, and its context before them", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    await bus.flush();
    // One tab, then a second added: what stands is the two-tab pane.
    paneChrome.on(shell.bus).setFor("b", paneChromeFor(deckOf([{ id: "p", cardIds: ["a"] }]), "a", READERS));
    const twoTabs = paneChromeFor(deckOf([{ id: "p", cardIds: ["a", "b"] }]), "b", READERS);
    paneChrome.on(shell.bus).setFor("b", twoTabs);
    // The context is set last, and still goes first: the chrome declares it in `after`.
    cardContext.on(shell.bus).setFor("b", { ...NO_CARD_CONTEXT, layerShown: true });

    const body = bus.body("b", "pane-chrome-stores-doc");
    const seen: Array<{ tabs: string[]; contextArrived: boolean }> = [];
    paneChrome.on(body.bus).subscribe(() => {
      seen.push({
        tabs: paneChrome.on(body.bus).getSnapshot()?.tabs.map((t) => t.cardId) ?? [],
        contextArrived: cardContext.on(body.bus).arrived(),
      });
    });
    await bus.flush();

    expect(seen).toEqual([{ tabs: ["a", "b"], contextArrived: true }]);
    expect(paneChrome.on(body.bus).getSnapshot()).toEqual(twoTabs);
  });

  test("a tab chosen in a body reaches the shell's handler with the sending card", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const chosen: Array<{ cardId: string; from: string | null }> = [];
    paneSelectTab.on(shell.bus).handle(({ cardId }, from) => chosen.push({ cardId, from: from.cardId }));
    const body = bus.body("a", "pane-chrome-stores-doc");
    await bus.flush();
    paneSelectTab.on(body.bus).dispatch({ cardId: "b" });
    await bus.flush();
    expect(chosen).toEqual([{ cardId: "b", from: "a" }]);
  });

  test("a tab close names its card in the payload, beside the sender", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const closed: Array<{ cardId: string; from: string | null }> = [];
    paneCloseCard.on(shell.bus).handle(({ cardId }, from) => closed.push({ cardId, from: from.cardId }));
    const body = bus.body("a", "pane-chrome-stores-doc");
    await bus.flush();
    paneCloseCard.on(body.bus).dispatch({ cardId: "x" });
    await bus.flush();
    expect(closed).toEqual([{ cardId: "x", from: "a" }]);
  });
});

describe("paneVerbAddress", () => {
  const deck = deckOf([
    { id: "p1", cardIds: ["a", "b"] },
    { id: "p2", cardIds: ["x"] },
  ]);

  test("a verb from a card acts on that card's own pane", () => {
    expect(paneVerbAddress(deck, "a")).toBe("p1");
    expect(paneVerbAddress(deck, "a", "b")).toBe("p1");
  });

  test("a verb naming a card of another pane, or from a card no pane holds, acts on nothing", () => {
    expect(paneVerbAddress(deck, "a", "x")).toBeNull();
    expect(paneVerbAddress(deck, "gone", "a")).toBeNull();
  });
});
