/**
 * A body card hears its pane's fold on the frame its page draws.
 *
 * The generic folded form (`holdFoldedBody`, `lib/folded-body.ts`) watches the
 * frame's `data-folded` to land `data-card-fold="settled"` and `inert` on the
 * card host. A card that carries its chrome draws its pane in its own page,
 * `.body-chrome-frame` (`body-chrome-frame.tsx`), and its body root writes the
 * fold there from the shell's `card.context` store (`body-root.tsx`): the
 * shell's pane is a stand-in that holds nothing. With motion off the fold lands at once;
 * with it on, the fold waits for the crossing the shell relays to end, which
 * `applyCrossingMirror` announces on the same frame. The unfold takes both
 * off, and hands the first responder's keyboard back to the card's content
 * once the host is no longer `inert` — the shell's hand-back cannot reach a
 * body's content.
 * And the fold puts that keyboard on the fold glyph the page's title bar
 * draws, the one live stop a folded card offers.
 *
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugdeck/src/lib/folded-body.ts
 * @covers tugdeck/src/components/chrome/card-fold-glyph.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import type { CardContextValue } from "../../bus/declarations/card";
import { installJsdom, settle } from "../../__tests__/jsdom-deck";
import { createTestBus, type TestBus } from "../../bus/test-bus";

const substrate = installJsdom();
const { container, win } = substrate;

// A document kind, which carries its chrome: the probe stands in its
// registration for the length of the file, and the kind's own is put back.
const COMPONENT = "commit";
const CARD = "c-body-fold";

let deck: import("../body-card-deck").BodyCardDeck;
let unmount: () => void = () => {};
let restoreRegistration: () => void = () => {};
let testBus: TestBus;
let applyCrossingMirror: typeof import("../../lib/fold-crossing").applyCrossingMirror;
let getFocusManager: typeof import("../../components/tugways/focus-manager").getFocusManager;

function context(over: Partial<CardContextValue> = {}): CardContextValue {
  return {
    folded: false,
    arriving: false,
    firstResponderCardId: CARD,
    layerShown: true,
    spaceId: null,
    geometry: { moves: 0, resizes: 0 },
    ...over,
  };
}

const frame = (): HTMLElement => container.querySelector<HTMLElement>(".body-chrome-frame")!;
const host = (): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-card-host][data-card-id="${CARD}"]`)!;
const landed = (): { fold: string | null; inert: boolean } => ({
  fold: host().getAttribute("data-card-fold"),
  inert: host().hasAttribute("inert"),
});

beforeAll(async () => {
  const { registerCard, getRegistration } = await import("../../card-registry");
  const { createBodyCardDeck } = await import("../body-card-deck");
  const { renderBodyRoot } = await import("../body-root");
  const { AppLifecycle } = await import("../../lib/app-lifecycle");
  const { SheetLifecycle } = await import("../../lib/sheet-lifecycle");
  const { BannerLifecycle } = await import("../../lib/banner-lifecycle");
  const { UsageStore } = await import("../../lib/usage-store");
  const { TugConnection } = await import("../../connection");
  const { createRoot } = await import("react-dom/client");
  ({ applyCrossingMirror } = await import("../../lib/fold-crossing"));
  ({ getFocusManager } = await import("../../components/tugways/focus-manager"));

  const kind = getRegistration(COMPONENT);
  restoreRegistration = () => {
    if (kind !== undefined) registerCard(kind);
  };
  registerCard({
    componentId: COMPONENT,
    contentFactory: () => <div data-probe="fold">probe</div>,
    defaultMeta: { title: "Fold probe", closable: true },
  });
  deck = createBodyCardDeck({
    cardId: CARD,
    componentId: COMPONENT,
    putCardState: () => Promise.resolve(true),
  });
  // The chrome frame reads its pane's facts off this page's bus.
  testBus = createTestBus();
  testBus.shell();
  testBus.install(testBus.body(CARD, COMPONENT));
  const root = createRoot(container);
  root.render(
    renderBodyRoot({
      deck,
      view: null,
      componentId: COMPONENT,
      appLifecycle: new AppLifecycle(),
      sheetLifecycle: new SheetLifecycle(),
      bannerLifecycle: new BannerLifecycle(),
      usageStore: new UsageStore(new TugConnection("ws://localhost/ws")),
    }),
  );
  unmount = () => root.unmount();
  deck.applyContext(context());
  await settle();
});

afterAll(async () => {
  unmount();
  restoreRegistration();
  testBus.dispose();
  win.document.documentElement.style.removeProperty("--tug-motion");
  await settle();
  substrate.restore();
});

describe("a body card's fold", () => {
  test("the open card's chrome frame and host carry no fold", () => {
    expect(host()).not.toBeNull();
    expect(container.querySelector(".body-pane-frame")).toBeNull();
    expect(frame().hasAttribute("data-folded")).toBe(false);
    expect(landed()).toEqual({ fold: null, inert: false });
  });

  test("with motion off, the fold lands on the host at once and the unfold lifts it", async () => {
    win.document.documentElement.style.setProperty("--tug-motion", "0");
    deck.applyContext(context({ folded: true }));
    await settle();
    expect(frame().getAttribute("data-folded")).toBe("true");
    expect(landed()).toEqual({ fold: "settled", inert: true });

    deck.applyContext(context());
    await settle();
    expect(frame().hasAttribute("data-folded")).toBe(false);
    expect(landed()).toEqual({ fold: null, inert: false });
  });

  test("with motion on, the fold lands when the relayed crossing ends", async () => {
    win.document.documentElement.style.setProperty("--tug-motion", "1");
    // As `body-main.ts` does: the crossing is mirrored on the frame before
    // the context that carries the fold reaches the card deck.
    applyCrossingMirror(frame(), { still: 7, settled: false, width: false, heightFree: false, fold: 7, held: {} });
    deck.applyContext(context({ folded: true }));
    await settle();
    expect(frame().getAttribute("data-folded")).toBe("true");
    expect(landed()).toEqual({ fold: null, inert: false });

    applyCrossingMirror(frame(), null);
    await settle();
    expect(landed()).toEqual({ fold: "settled", inert: true });

    deck.applyContext(context());
    await settle();
    expect(landed()).toEqual({ fold: null, inert: false });
  });

  test("the unfold hands the first responder's keyboard back to its content, after the host is open", async () => {
    win.document.documentElement.style.setProperty("--tug-motion", "0");
    const manager = getFocusManager()!;
    const adopted: Array<{ cardId: string; inert: boolean }> = [];
    const original = manager.adoptKeyCard.bind(manager);
    manager.adoptKeyCard = ((cardId: string) => {
      adopted.push({ cardId, inert: host().hasAttribute("inert") });
      return original(cardId);
    }) as typeof manager.adoptKeyCard;
    try {
      deck.applyContext(context({ folded: true }));
      await settle();
      expect(adopted).toEqual([]);
      deck.applyContext(context());
      await settle();
      expect(adopted).toEqual([{ cardId: CARD, inert: false }]);

      // A card that is not the first responder is handed nothing.
      deck.applyContext(context({ folded: true, firstResponderCardId: null }));
      await settle();
      deck.applyContext(context({ firstResponderCardId: null }));
      await settle();
      expect(adopted).toHaveLength(1);
    } finally {
      manager.adoptKeyCard = original as typeof manager.adoptKeyCard;
    }
  });

  test("the fold puts the first responder's keyboard on the glyph its page draws", async () => {
    win.document.documentElement.style.setProperty("--tug-motion", "0");
    const { CARD_FOLD_FOCUS_KEY } = await import("../../components/chrome/card-fold-glyph");
    const manager = getFocusManager()!;
    const placed: unknown[] = [];
    const original = manager.place.bind(manager);
    manager.place = ((cardId: string, target: unknown, opts: unknown) => {
      placed.push({ cardId, target });
      return original(cardId, target as never, opts as never);
    }) as typeof manager.place;
    try {
      deck.applyContext(context({ folded: true }));
      await settle();
      expect(placed).toContainEqual({ cardId: CARD, target: { kind: "focus-key", focusKey: CARD_FOLD_FOCUS_KEY } });
      deck.applyContext(context());
      await settle();
    } finally {
      manager.place = original as typeof manager.place;
    }
  });
});
