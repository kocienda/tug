/**
 * at0824-slot-rows-live-on-a-body-card.test.ts — View's slot rows light for
 * the card that holds the keyboard.
 *
 * Every content card is its own page, and while one is key its page posts the
 * gates of the menu items routed to the first responder, which the host merges
 * over the shell's. The slot rows — Split or Stack Slot and the four Move Card
 * rows — route there, but what they could do is a fact about the slot, which a
 * page holding one card cannot see: until the shell relayed it, every one of
 * them sat dark under the neutral "Split or Stack Slot" over a card standing
 * in a split slot with a member below it. A unit test pins the relay
 * (`host-menu-state.test.ts`); this file pins it where the bug lived, on the
 * real menu bar.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/bus/declarations/deck.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugapp/Sources/MenuStateSync.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
/** How long the menu gets to catch up with a seeded deck. */
const GATE_DEADLINE_MS = 5_000;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Slot 0 split two deep (A over B), slot 1 holding C alone; A is key. */
function deckShape(): Record<string, unknown> {
  const pane = (id: string, card: string, slot: number) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 675, height: 400 },
    cardIds: [card],
    activeCardId: card,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: ["A", "B", "C"].map((id) => ({
      id,
      componentId: "hello",
      title: `Card ${id}`,
      closable: true,
    })),
    panes: [pane("pA", "A", 0), pane("pB", "B", 0), pane("pC", "C", 1)],
    activePaneId: "pA",
    imposition: {
      kind: "two-up",
      sidebars: {},
      layout: "flow",
      columns: { 0: { mode: "split", order: ["pA", "pB"] } },
    },
    hasFocus: true,
  };
}

interface Row {
  enabled: boolean;
  title: string;
}

async function row(app: App, identifier: string): Promise<Row> {
  const state = await app.menuItemState(identifier);
  expect(state.found, `${identifier} present in the menu`).toBe(true);
  if (!state.found) throw new Error(`${identifier} missing`);
  return { enabled: state.enabled, title: state.title };
}

/** Read `identifier` until it is enabled or the deadline passes. */
async function settledRow(app: App, identifier: string): Promise<Row> {
  const deadline = Date.now() + GATE_DEADLINE_MS;
  let last = await row(app, identifier);
  while (!last.enabled && Date.now() < deadline) {
    await wait(100);
    last = await row(app, identifier);
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)("View's slot rows on a body card", () => {
  test(
    "a card in a split slot lights Stack Slot and the moves it can make",
    async () => {
      const app = await launchTugApp({ testName: "at0824-slot-rows-live-on-a-body-card" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });

        const split = await settledRow(app, "view.slotSplit");
        note(`split row: ${split.enabled ? "on" : "off"} "${split.title}"`);
        expect(split.enabled, "the split row is live over a slotted card").toBe(true);
        expect(split.title, "and names the verb the press performs").toBe("Stack Slot");

        const down = await row(app, "view.slotMoveDown");
        const bottom = await row(app, "view.slotMoveBottom");
        const up = await row(app, "view.slotMoveUp");
        const top = await row(app, "view.slotMoveTop");
        note(
          `moves: up ${up.enabled} down ${down.enabled} top ${top.enabled} bottom ${bottom.enabled}`,
        );
        expect(down.enabled, "A has B below it").toBe(true);
        expect(bottom.enabled, "and can go to the bottom").toBe(true);
        expect(up.enabled, "A is already first").toBe(false);
        expect(top.enabled, "and already at the top").toBe(false);

        const equalize = await row(app, "view.equalizeHeights");
        expect(equalize.enabled, "a split slot two deep can be equalized").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
