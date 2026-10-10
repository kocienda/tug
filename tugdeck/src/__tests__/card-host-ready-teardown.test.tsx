/**
 * `CardHost`'s content-ready handshake and its teardown saves, under jsdom.
 *
 * A card that owns content mounts from its bag in the `CardStateCache`: the
 * host masks its content element, hands the bag's `content` to the card's
 * `onRestore`, and lifts the mask from `onContentReady` on the card's next
 * commit — not from the deadline, which is the fallback for a card that never
 * commits. Its saves go the other way: every teardown-class trigger invokes
 * the save callback `CardHost` registered, tagged with the trigger, and the
 * bag the card's `onSave` returned lands back in the cache. A close runs that
 * save before the card unmounts, so the last edit is captured while the card
 * can still answer for it.
 *
 * All of it is read over a real `DeckManager` mounted into a jsdom container:
 * the card's own log of restore / save / unmount, the deck trace's
 * `save-callback` events, and the cache through `getCardState`.
 *
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/card-state-cache.ts
 * @covers tugdeck/src/teardown.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React, { useLayoutEffect, useRef, useState } from "react";

import type { DeckManager } from "../deck-manager";
import type { DeckTrace } from "../deck-trace";
import { errorBannerText, installJsdom, mountDeck, onePaneDeck, settle, unmountDeck } from "./jsdom-deck";

// Installed before any deck module loads; the deck is imported in `beforeAll`.
const substrate = installJsdom();
const { container, win } = substrate;

const COMPONENT = "ready-probe";
const CARD = "card-1";
const PANE = "pane-1";

interface ProbeContent {
  text: string;
}

/** What the probe card saw, in order: `restore:<text>`, `save:<source>`, `unmount`. */
const log: string[] = [];

let manager: DeckManager;
let trace: DeckTrace;
let traceFrom = 0;
let hostContent: () => HTMLDivElement | null = () => null;

beforeAll(async () => {
  const { registerCard } = await import("../card-registry");
  const { useCardStatePreservation } = await import("../components/tugways/use-card-state-preservation");
  const paneContentRegistry = await import("../components/chrome/pane-content-registry");
  ({ deckTrace: trace } = await import("../deck-trace"));
  hostContent = () => paneContentRegistry.getElement(PANE);

  function ReadyProbe(): React.ReactElement {
    const [text, setText] = useState("fresh");
    const textRef = useRef(text);
    textRef.current = text;
    useCardStatePreservation<ProbeContent>({
      onSave: (source) => {
        log.push(`save:${source}`);
        return { text: textRef.current };
      },
      onRestore: (state) => {
        log.push(`restore:${state.text}`);
        setText(state.text);
      },
    });
    useLayoutEffect(
      () => () => {
        log.push("unmount");
      },
      [],
    );
    return (
      <button type="button" data-probe="text" onClick={() => setText("edited")}>
        {text}
      </button>
    );
  }

  registerCard({
    componentId: COMPONENT,
    contentFactory: () => <ReadyProbe />,
    defaultMeta: { title: "Ready probe", closable: true },
  });

  trace.enable(true);
  traceFrom = trace.mark();
  manager = await mountDeck(substrate, onePaneDeck(COMPONENT, [CARD]), {
    cardStates: new Map([[CARD, { content: { text: "seeded" }, scroll: { x: 0, y: 40 } }]]),
  });
});

afterAll(async () => {
  trace.enable(false);
  await unmountDeck(substrate, manager);
});

// ---- Readings ----

function probeText(): string | null {
  return container.querySelector<HTMLElement>('[data-probe="text"]')?.textContent ?? null;
}

/** The sources of every `save-callback` the trace recorded for the card, in order. */
function saveSources(): string[] {
  return trace
    .since(traceFrom)
    .filter((e) => e.kind === "save-callback" && e.cardId === CARD)
    .map((e) => (e as { source: string }).source);
}

function traced(kind: string): boolean {
  return trace.since(traceFrom).some((e) => e.kind === kind);
}

/** Hide the page and fire `visibilitychange`, as WebKit does when the app hides. */
async function hidePage(): Promise<void> {
  Object.defineProperty(win.document, "hidden", { configurable: true, get: () => true });
  try {
    win.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
  } finally {
    delete (win.document as unknown as { hidden?: boolean }).hidden;
  }
}

// ---- The sequence ----

describe("card-host content-ready and teardown saves", () => {
  test("the card mounts from its cached bag, and content-ready lifts the mask", () => {
    expect(errorBannerText(container)).toBeNull();
    expect(log).toEqual(["restore:seeded"]);
    expect(probeText()).toBe("seeded");
    // Masked for the restore, unmasked by the card's commit — one settle is
    // well inside the deadline, and the deadline's own lift never fired.
    expect(hostContent()).not.toBeNull();
    expect(hostContent()?.style.opacity).toBe("");
    expect(traced("card-host-mask-deadline")).toBe(false);
  });

  test("a hidden page saves the card through the cache, tagged visibilitychange", async () => {
    container.querySelector<HTMLElement>('[data-probe="text"]')?.click();
    await settle();
    expect(probeText()).toBe("edited");
    log.length = 0;

    await hidePage();
    expect(log).toEqual(["save:visibilitychange"]);
    expect(saveSources()).toContain("visibilitychange");
    expect(manager.getCardState(CARD)?.content).toEqual({ text: "edited" });
  });

  test("closing the pane saves the card before it unmounts, tagged close-handoff", async () => {
    log.length = 0;
    traceFrom = trace.mark();
    manager._closePane(PANE);
    await settle();
    expect(log).toEqual(["save:close-handoff", "unmount"]);
    expect(saveSources()).toEqual(["close-handoff"]);
    expect(probeText()).toBeNull();
  });
});
