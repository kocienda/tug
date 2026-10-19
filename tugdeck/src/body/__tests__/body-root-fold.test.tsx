/**
 * A body card hears its pane's fold on its own frame.
 *
 * The generic folded form (`holdFoldedBody`, `lib/folded-body.ts`) watches the
 * frame's `data-folded` to land `data-card-fold="settled"` and `inert` on the
 * card host. In the shell the pane writes it (`tug-pane.tsx`); a body's frame
 * is the body root's `.body-pane-frame`, which writes it from the shell's
 * `card.context` store (`body-root.tsx`). With motion off the fold lands at once;
 * with it on, the fold waits for the crossing the shell relays to end, which
 * `applyCrossingMirror` announces on the same frame. The unfold takes both
 * off, and hands the first responder's keyboard back to the card's content
 * once the host is no longer `inert` — the shell's hand-back cannot reach a
 * body's content.
 *
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/lib/folded-body.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import type { CardContextValue } from "../../bus/declarations/card";
import { installJsdom, settle } from "../../__tests__/jsdom-deck";

const substrate = installJsdom();
const { container, win } = substrate;

const COMPONENT = "body-fold-probe";
const CARD = "c-body-fold";

let bridge: import("../body-deck-bridge").BodyDeckBridge;
let unmount: () => void = () => {};
let applyCrossingMirror: typeof import("../../lib/fold-crossing").applyCrossingMirror;
let getFocusManager: typeof import("../../components/tugways/focus-manager").getFocusManager;

function context(over: Partial<CardContextValue> = {}): CardContextValue {
  return {
    folded: false,
    arriving: false,
    firstResponderCardId: CARD,
    layerShown: true,
    spaceId: null,
    ...over,
  };
}

const frame = (): HTMLElement => container.querySelector<HTMLElement>(".body-pane-frame")!;
const host = (): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-card-host][data-card-id="${CARD}"]`)!;
const landed = (): { fold: string | null; inert: boolean } => ({
  fold: host().getAttribute("data-card-fold"),
  inert: host().hasAttribute("inert"),
});

beforeAll(async () => {
  const { registerCard } = await import("../../card-registry");
  const { BodyDeckBridge } = await import("../body-deck-bridge");
  const { renderBodyRoot } = await import("../body-root");
  const { AppLifecycle } = await import("../../lib/app-lifecycle");
  const { SheetLifecycle } = await import("../../lib/sheet-lifecycle");
  const { BannerLifecycle } = await import("../../lib/banner-lifecycle");
  const { UsageStore } = await import("../../lib/usage-store");
  const { TugConnection } = await import("../../connection");
  const { createRoot } = await import("react-dom/client");
  ({ applyCrossingMirror } = await import("../../lib/fold-crossing"));
  ({ getFocusManager } = await import("../../components/tugways/focus-manager"));

  registerCard({
    componentId: COMPONENT,
    contentFactory: () => <div data-probe="fold">probe</div>,
    defaultMeta: { title: "Fold probe", closable: true },
  });
  bridge = new BodyDeckBridge({
    cardId: CARD,
    componentId: COMPONENT,
    putCardState: () => Promise.resolve(true),
  });
  const root = createRoot(container);
  root.render(
    renderBodyRoot({
      bridge,
      componentId: COMPONENT,
      appLifecycle: new AppLifecycle(),
      sheetLifecycle: new SheetLifecycle(),
      bannerLifecycle: new BannerLifecycle(),
      usageStore: new UsageStore(new TugConnection("ws://localhost/ws")),
    }),
  );
  unmount = () => root.unmount();
  bridge.applyContext(context());
  await settle();
});

afterAll(async () => {
  unmount();
  win.document.documentElement.style.removeProperty("--tug-motion");
  await settle();
  substrate.restore();
});

describe("a body card's fold", () => {
  test("the open card's frame and host carry no fold", () => {
    expect(host()).not.toBeNull();
    expect(frame().hasAttribute("data-folded")).toBe(false);
    expect(landed()).toEqual({ fold: null, inert: false });
  });

  test("with motion off, the fold lands on the host at once and the unfold lifts it", async () => {
    win.document.documentElement.style.setProperty("--tug-motion", "0");
    bridge.applyContext(context({ folded: true }));
    await settle();
    expect(frame().getAttribute("data-folded")).toBe("true");
    expect(landed()).toEqual({ fold: "settled", inert: true });

    bridge.applyContext(context());
    await settle();
    expect(frame().hasAttribute("data-folded")).toBe(false);
    expect(landed()).toEqual({ fold: null, inert: false });
  });

  test("with motion on, the fold lands when the relayed crossing ends", async () => {
    win.document.documentElement.style.setProperty("--tug-motion", "1");
    // As `body-main.ts` does: the crossing is mirrored on the frame before
    // the context that carries the fold reaches the bridge.
    applyCrossingMirror(frame(), { still: 7, settled: false, width: false, heightFree: false, fold: 7, held: {} });
    bridge.applyContext(context({ folded: true }));
    await settle();
    expect(frame().getAttribute("data-folded")).toBe("true");
    expect(landed()).toEqual({ fold: null, inert: false });

    applyCrossingMirror(frame(), null);
    await settle();
    expect(landed()).toEqual({ fold: "settled", inert: true });

    bridge.applyContext(context());
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
      bridge.applyContext(context({ folded: true }));
      await settle();
      expect(adopted).toEqual([]);
      bridge.applyContext(context());
      await settle();
      expect(adopted).toEqual([{ cardId: CARD, inert: false }]);

      // A card that is not the first responder is handed nothing.
      bridge.applyContext(context({ folded: true, firstResponderCardId: null }));
      await settle();
      bridge.applyContext(context({ firstResponderCardId: null }));
      await settle();
      expect(adopted).toHaveLength(1);
    } finally {
      manager.adoptKeyCard = original as typeof manager.adoptKeyCard;
    }
  });
});
