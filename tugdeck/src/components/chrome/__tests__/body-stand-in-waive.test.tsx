/**
 * A body card's stand-in face follows its pane's close advice: when a card's
 * page says its close need not confirm, the face re-renders and its key — the
 * string the placer reads to know the face's display list moved — moves with
 * it, rather than the face standing stale until something else re-renders it
 * ([L02]: the waive enters React through `useSyncExternalStore`).
 *
 * @covers tugdeck/src/components/chrome/body-stand-in.tsx
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom, onePaneDeck } from "../../../__tests__/jsdom-deck";

const substrate = installJsdom();

afterAll(() => substrate.restore());

const releases: Array<() => void> = [];
afterEach(async () => {
  const { _resetPageForTest } = await import("@/bus/page");
  _resetPageForTest();
  for (const release of releases.splice(0)) release();
  document.body.innerHTML = "";
});

describe("the stand-in face", () => {
  test("a card's waive, said by its page, re-renders the face and moves its key", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { installPage } = await import("@/bus/page");
    const { createTestBus } = await import("@/bus/test-bus");
    const { cardHolds, NO_CARD_HOLDS } = await import("@/bus/declarations/card");
    const { DeckManagerContext } = await import("@/deck-manager-context");
    const { BodyStandIn } = await import("../body-stand-in");
    const { TugTooltipProvider } = await import("@/components/tugways/tug-tooltip");
    type Store = NonNullable<React.ContextType<typeof DeckManagerContext>>;

    const { registerCard } = await import("@/card-registry");
    registerCard({
      componentId: "stand-in-waive-session",
      contentFactory: () => null,
      defaultMeta: { title: "", kindName: "Session", closable: true, confirmClose: true },
    });
    // A lone card whose close confirms unless its page says it waives.
    const state = onePaneDeck("stand-in-waive-session", ["a"]);
    const spaces = { activeSpaceId: "s", spaces: [{ id: "s", name: "Space" }], mountedDecks: new Map() };
    const known: Record<string, unknown> = {
      subscribe: () => () => {},
      getSnapshot: () => state,
      getSpacesSnapshot: () => spaces,
      spaceOf: () => "s",
    };
    const deck = new Proxy(known, {
      get: (target, key) => (typeof key === "string" && key in target ? target[key] : () => null),
    }) as unknown as Store;

    // This page is the shell; the card's page publishes its holds to it.
    const bus = createTestBus();
    releases.push(() => bus.dispose());
    installPage({ role: "shell", cardId: null, componentId: null });
    const shell = bus.shell();
    bus.install(shell);
    const body = bus.body("a", "stand-in-waive-session");
    await bus.flush();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <DeckManagerContext value={deck}>
          <TugTooltipProvider>
            <BodyStandIn cardId="a" componentId="stand-in-waive-session" />
          </TugTooltipProvider>
        </DeckManagerContext>,
      );
    });
    const faceKey = (): string | null =>
      host.querySelector<HTMLElement>("[data-body-stand-in]")?.getAttribute("data-face-key") ?? null;
    const before = faceKey();
    expect(before).not.toBeNull();

    await act(async () => {
      cardHolds.on(body.bus).set({ ...NO_CARD_HOLDS, waive: true });
      await bus.flush();
    });
    const after = faceKey();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(before).toContain('"pane":{"confirm":true');
    expect(after).toContain('"pane":{"confirm":false');
    await act(async () => root.unmount());
  });
});
