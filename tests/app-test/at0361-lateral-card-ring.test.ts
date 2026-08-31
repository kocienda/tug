/**
 * at0361-lateral-card-ring.test.ts — ⇧⌘] / ⇧⌘[ walk the whole deck, Lens
 * included.
 *
 * The lateral axis of card navigation ([D129]) is one ring over every
 * *visible* card position: each tab of each pane the user can see. Two
 * things about that are worth a real chord round-trip rather than a unit
 * test, and this file is the two of them.
 *
 * **It crosses pane boundaries.** Previous/Next Card used to walk one pane's
 * tabs and stop at its edges, with a separate ⌃` Cycle Panes for hopping
 * panes; retiring that command is only honest if the lateral pair now
 * reaches the next pane by itself. So the walk here goes tab → tab inside a
 * pane and then *out* of it, and the assertion is which card holds focus
 * after each press, read through `getFocusedCardId` — the composite first
 * responder, not a class on a frame.
 *
 * **The sidebars are on it.** The Lens is the card most likely to be on
 * screen at any moment and it was the one the first cut skipped, by analogy
 * to `move-to-slot`'s exclusion — which is a fact about *slots*, a thing no
 * sidebar takes. Jots, with no such special case, rode the ring the whole
 * time, so the deck had two sidebars with two behaviors. The ring's
 * membership rules are pinned exactly at the unit layer
 * (`lib/__tests__/card-ring.test.ts`); what this adds is that the real
 * chord, resolved by AppKit and round-tripped through the responder chain,
 * actually lands focus in the Lens.
 *
 * Why a seeded deck rather than the default one: the ring's order is
 * structural — left rail, slots by number, free panes, right rail — so a
 * test that did not state the arrangement would be asserting against
 * whatever the default layout happened to be.
 *
 * @covers tugdeck/src/lib/card-ring.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const AFTER_LAND_MS = 900;
/** Room for the chain round-trip and the activation transition. */
const AFTER_CHORD_MS = 400;

function card(id: string, componentId = "gallery-input") {
  return { id, componentId, title: `Card ${id}`, closable: true };
}

/**
 * Two slotted panes — the first holding two tabs, so the walk has both an
 * inside-a-pane step and a crossing step — plus the Lens on the right rail.
 * Ring order is therefore A → B → C → L and back to A.
 */
function deckShape() {
  return {
    cards: [
      card("A"),
      card("B"),
      card("C"),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      {
        id: "p0",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 400 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
      {
        id: "p1",
        position: { x: 520, y: 40 },
        size: { width: 460, height: 400 },
        cardIds: ["C"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 1,
      },
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: 300, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p0",
    imposition: { kind: "two-up", lens: "right" },
    hasFocus: true,
  };
}

async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
    { timeoutMs: 5_000 },
  );
  await new Promise<void>((r) => setTimeout(r, AFTER_LAND_MS));
}

async function pressNext(app: App): Promise<void> {
  await app.nativeKey("]", ["cmd", "shift"]);
  await new Promise<void>((r) => setTimeout(r, AFTER_CHORD_MS));
}

async function pressPrevious(app: App): Promise<void> {
  await app.nativeKey("[", ["cmd", "shift"]);
  await new Promise<void>((r) => setTimeout(r, AFTER_CHORD_MS));
}

/** The composite first responder — the deck's own answer, not a CSS class. */
async function focused(app: App): Promise<string | null> {
  return app.evalJS<string | null>(`window.__tug.getFocusedCardId()`);
}

describe.skipIf(!SHOULD_RUN)("at0361 — the lateral ring walks the whole deck", () => {
  test(
    "⇧⌘] steps within a pane, crosses into the next, reaches the Lens, and wraps",
    async () => {
      const app = await launchTugApp({ testName: "at0361-ring-forward" });
      try {
        await seed(app);
        await app.expectFocusedCard("A", { timeoutMs: 5_000 });

        // Inside p0: A → B is an ordinary tab switch.
        await pressNext(app);
        note("at0361 after press 1", String(await focused(app)));
        await app.expectFocusedCard("B", { timeoutMs: 5_000 });

        // Out of p0: at the pane's last tab the step CROSSES rather than
        // wrapping back to A. This is what retires Cycle Panes.
        await pressNext(app);
        note("at0361 after press 2", String(await focused(app)));
        await app.expectFocusedCard("C", { timeoutMs: 5_000 });

        // Into the Lens — the regression this file exists for.
        await pressNext(app);
        note("at0361 after press 3", String(await focused(app)));
        await app.expectFocusedCard("L", { timeoutMs: 5_000 });

        // And home: four positions, four presses.
        await pressNext(app);
        note("at0361 after press 4", String(await focused(app)));
        await app.expectFocusedCard("A", { timeoutMs: 5_000 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "⇧⌘[ is the same ring in reverse, Lens first",
    async () => {
      const app = await launchTugApp({ testName: "at0361-ring-backward" });
      try {
        await seed(app);
        await app.expectFocusedCard("A", { timeoutMs: 5_000 });

        // Backwards from the ring's first position is its last — the Lens,
        // one press away rather than three.
        await pressPrevious(app);
        note("at0361 back 1", String(await focused(app)));
        await app.expectFocusedCard("L", { timeoutMs: 5_000 });

        await pressPrevious(app);
        note("at0361 back 2", String(await focused(app)));
        await app.expectFocusedCard("C", { timeoutMs: 5_000 });

        // Crossing INTO a multi-tab pane lands on the tab that was active
        // there, which is the one the forward walk left — so the two
        // directions retrace one path rather than two.
        await pressPrevious(app);
        note("at0361 back 3", String(await focused(app)));
        await app.expectFocusedCard("B", { timeoutMs: 5_000 });

        await pressPrevious(app);
        note("at0361 back 4", String(await focused(app)));
        await app.expectFocusedCard("A", { timeoutMs: 5_000 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Window ▸ Next Card is live once the ring has a second position",
    async () => {
      // The gate reads `visibleCardCount` off the same function that
      // computes the step, so a Lens that is on the ring for the walk must
      // be on it for the gate too — a deck of one content card plus the
      // Lens is exactly the shape that separates the two.
      const app = await launchTugApp({ testName: "at0361-ring-gate" });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              card("A"),
              { id: "L", componentId: "layout", title: "Layout", closable: true },
            ],
            panes: [
              {
                id: "p0",
                position: { x: 40, y: 40 },
                size: { width: 460, height: 400 },
                cardIds: ["A"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["maker"],
                slot: 0,
              },
              {
                id: "pLens",
                position: { x: 0, y: 0 },
                size: { width: 300, height: 900 },
                cardIds: ["L"],
                activeCardId: "L",
                title: "Lens",
                acceptsFamilies: [],
              },
            ],
            activePaneId: "p0",
            imposition: { kind: "one-up", lens: "right" },
            hasFocus: true,
          },
          focusCardId: "A",
        });
        await new Promise<void>((r) => setTimeout(r, AFTER_LAND_MS));

        const state = await app.menuItemState("window.nextCard");
        if (!state.found) throw new Error("window.nextCard is not in the Window menu");
        expect(
          state.enabled,
          "one content card + the Lens is a two-position ring",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
