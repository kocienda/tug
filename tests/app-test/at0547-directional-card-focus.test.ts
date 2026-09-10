/**
 * at0547-directional-card-focus.test.ts — ⌥⌘←/→/↑/↓ hand the keyboard to the
 * card that is spatially there.
 *
 * ## What this gates, and what it deliberately does not
 *
 * The reckoning itself — which card is left of which, split against stacked,
 * ragged divisions, every edge — is pinned at the unit layer over constructed
 * arrangements (`lib/__tests__/directional-focus.test.ts`), where a shape can be
 * built in three lines and no deck has to be mounted. Repeating any of that here
 * would buy nothing and cost an app launch.
 *
 * What only a real app can answer is the ROUND TRIP, and that is this file:
 *
 *   1. **The chord is an AppKit key equivalent, and it arrives.** The four
 *      entries are `menuEligible`, so ⌥⌘← is resolved by the menu bar before the
 *      web view ever sees a keydown ([P15]). A synthetic `KeyboardEvent` on
 *      `document` — the drive at0330 and at0333 use for the bracket chords —
 *      cannot test that path at all, because it starts downstream of it. So
 *      every press here is native.
 *   2. **Focus actually transfers.** The handler goes through
 *      `transferFocusForActivation` rather than a raw `activateCard`, so what is
 *      read after each press is `getFocusedCardId` — the composite first
 *      responder — not a class on a frame.
 *   3. **The travel's memory survives a real run** ([B06]). ← then → returns to
 *      the card it left rather than to whichever band of that column happens to
 *      overlap the wider one it landed on. The memory lives in module scope
 *      beside the handlers, so a run is a sequence of separate dispatches and
 *      nothing but a real one exercises it.
 *   4. **A card off the visible band is still reachable, and the band comes to
 *      it** ([B08]). The reckoning names a target without consulting the flow
 *      offset; the handler travels. Under flow with a strip longer than the
 *      band, that is a measurable fact about where the arriving pane stands.
 *
 * **The arrangement's edge answers TWICE, and both answers are real** ([B09]).
 * `focusTravel` answers per direction, so the Window row for a direction with
 * nothing that way is dark — at0181 reads that on a deck where all four are.
 * A dark row does not swallow the keystroke, though: `disabledChord: "keep"`
 * leaves AppKit uninterested in it, the keydown reaches the web view's own
 * funnel, where the same command has a JS binding, and the handler resolves the
 * move, gets `null`, and flashes the pane that is not going anywhere. So the
 * menu says "not from here" before the press and the border says it after, and
 * the assertion below is both of them together — the dark row AND the flash on
 * the source, with the keyboard where it was.
 *
 * @covers tugdeck/src/lib/directional-focus.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The imposer's settle window, with room for the tween. */
const AFTER_LAND_MS = 900;
/** Room for the chain round trip and the activation transition. */
const AFTER_CHORD_MS = 400;

const RAIL_WIDTH = 380;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function card(id: string, componentId = "gallery-input") {
  return { id, componentId, title: `Card ${id}`, closable: true };
}

function contentPane(id: string, slot: number, cardId: string, width = 420) {
  return {
    id,
    position: { x: 40, y: 40 },
    size: { width, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  };
}

function railPane(cardId: string) {
  return {
    id: "pRail",
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "Layout",
    acceptsFamilies: [],
  };
}

/**
 * Three slots and a right rail. Slot 0 is DIVIDED — A above B — so the deck
 * holds all three kinds of place a move can start in or land on: a band of a
 * split column, a whole column, and a rail member.
 *
 * Left to right the places read: slot 0 (A, B), slot 1 (C), slot 2 (D), rail (L).
 */
function crossingShape() {
  return {
    cards: [card("A"), card("B"), card("C"), card("D"), {
      id: "L",
      componentId: "layout",
      title: "Layout",
      closable: true,
    }],
    panes: [
      contentPane("p0a", 0, "A"),
      contentPane("p0b", 0, "B"),
      contentPane("p1", 1, "C"),
      contentPane("p2", 2, "D"),
      railPane("L"),
    ],
    activePaneId: "p0a",
    imposition: {
      kind: "three-up",
      layout: "fit",
      sidebars: { layout: { side: "right" } },
      columns: { 0: { mode: "split", order: ["p0a", "p0b"] } },
    },
    hasFocus: true,
  };
}

/**
 * Five wide cards in a six-up under FLOW — a strip several times the band, so
 * the far slots start outside it. No rail: the band is the whole canvas, which
 * makes "is the arriving card inside it" a reading of the canvas alone.
 */
function flowShape() {
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: ids.map((id) => card(id)),
    panes: ids.map((id, index) => contentPane(`p${index}`, index, id, 900)),
    activePaneId: "p0",
    imposition: { kind: "six-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

const DIRECTION_KEY = {
  left: "ArrowLeft",
  right: "ArrowRight",
  above: "ArrowUp",
  below: "ArrowDown",
} as const;

/** One press of the real chord, resolved by AppKit. */
async function move(
  app: App,
  direction: keyof typeof DIRECTION_KEY,
): Promise<void> {
  await app.nativeKey(DIRECTION_KEY[direction], ["cmd", "alt"]);
  await wait(AFTER_CHORD_MS);
}

/** The composite first responder — the deck's own answer. */
async function focused(app: App): Promise<string | null> {
  return app.evalJS<string | null>(`window.__tug.getFocusedCardId()`);
}

async function flowOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** A pane's frame against the canvas', both in viewport coordinates. */
async function paneAgainstCanvas(
  app: App,
  paneId: string,
): Promise<{ left: number; right: number; canvasLeft: number; canvasRight: number }> {
  return app.evalJS(
    `(function () {
      var pane = document
        .querySelector('.tug-pane[data-pane-id="${paneId}"]')
        .getBoundingClientRect();
      var canvas = document
        .querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      return {
        left: pane.left, right: pane.right,
        canvasLeft: canvas.left, canvasRight: canvas.right,
      };
    })()`,
  );
}

async function seed(app: App, state: unknown, panes: number, focusCardId: string) {
  await app.seedDeckState({ state, focusCardId });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-pane-id]').length === ${panes}`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
  await app.expectFocusedCard(focusCardId, { timeoutMs: 8_000 });
}

describe.skipIf(!SHOULD_RUN)(
  "at0547 — the ⌥⌘ arrows move the keyboard through the arrangement",
  () => {
    test(
      "the four chords cross a split, the slots, and into a showing rail — and the run remembers its line",
      async () => {
        const app = await launchTugApp({ testName: "at0547-crossing" });
        try {
          await seed(app, crossingShape(), 5, "A");

          // ── Down inside the divided column: a band move, not a ring step.
          await move(app, "below");
          await app.expectFocusedCard("B", { timeoutMs: 8_000 });

          // ── Right, out of the lower band and into the next whole column.
          await move(app, "right");
          await app.expectFocusedCard("C", { timeoutMs: 8_000 });

          // ── Left again. THE MEMORY: C spans the whole run and both bands of
          // slot 0 overlap it equally, so without a remembered line the tie
          // would break topmost and land on A. The run entered at B's band and
          // carries it, so it comes home to B.
          await move(app, "left");
          note("after ← back across", String(await focused(app)));
          await app.expectFocusedCard("B", { timeoutMs: 8_000 });

          // ── Up, back to the band above.
          await move(app, "above");
          await app.expectFocusedCard("A", { timeoutMs: 8_000 });

          // ── Right, right, right: A → C → D → the rail's Layout card.
          await move(app, "right");
          await app.expectFocusedCard("C", { timeoutMs: 8_000 });
          await move(app, "right");
          await app.expectFocusedCard("D", { timeoutMs: 8_000 });
          await move(app, "right");
          await app.expectFocusedCard("L", { timeoutMs: 8_000 });

          // ── The rail is the last place there is. Clear any flash the arrival
          // just raised, so what is read below is the refusal's own.
          await app.evalJS<null>(
            `(function () {
              document
                .querySelectorAll(".tug-pane")
                .forEach(function (el) { el.classList.remove("tug-pane-flash"); });
              return null;
            })()`,
          );
          const atEdge = await app.menuItemState("window.focusCardRight");
          expect(
            atEdge.found ? atEdge.enabled : true,
            "the Window row for a direction with nothing that way is dark",
          ).toBe(false);
          await move(app, "right");
          expect(
            await focused(app),
            "past the rail there is nothing, so the keyboard stays put",
          ).toBe("L");
          const flashed = await app.evalJS<string[]>(
            `Array.prototype.filter
              .call(document.querySelectorAll(".tug-pane"), function (el) {
                return el.classList.contains("tug-pane-flash");
              })
              .map(function (el) { return el.getAttribute("data-pane-id"); })`,
          );
          note("panes flashed by the edge press", JSON.stringify(flashed));
          expect(
            flashed,
            "and the pane that is not moving says so — visible refusal, not silence",
          ).toEqual(["pRail"]);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a card outside the visible band is still a target, and the band travels to it",
      async () => {
        const app = await launchTugApp({ testName: "at0547-off-band" });
        try {
          await seed(app, flowShape(), 5, "A");

          const atRest = await flowOffset(app);
          const before = await paneAgainstCanvas(app, "p4");
          note(
            "at rest",
            `offset ${atRest}, p4 left ${Math.round(before.left)}, canvas right ${Math.round(
              before.canvasRight,
            )}`,
          );
          expect(
            before.left,
            "the strip is long enough that the last slot starts off the band",
          ).toBeGreaterThan(before.canvasRight);

          // Four presses right, each one landing focus on a card that is
          // further off the band than the last.
          for (const want of ["B", "C", "D", "E"]) {
            await move(app, "right");
            await app.expectFocusedCard(want, { timeoutMs: 8_000 });
          }

          await wait(AFTER_LAND_MS);
          const after = await paneAgainstCanvas(app, "p4");
          note(
            "after arriving",
            `offset ${await flowOffset(app)}, p4 left ${Math.round(
              after.left,
            )}, right ${Math.round(after.right)}`,
          );
          expect(
            await flowOffset(app),
            "the strip slid to bring the arrival into the band",
          ).not.toBe(atRest);
          expect(
            after.left,
            "and the arriving card is inside the band's left edge",
          ).toBeGreaterThanOrEqual(before.canvasLeft - 1);
          expect(
            after.left,
            "and inside its right edge — it is on screen, not merely named",
          ).toBeLessThan(before.canvasRight);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
