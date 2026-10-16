/**
 * layout-places-fixture.ts — the deck and the instruments the at0469 Layout
 * places files share: a three-up deck whose slot 1 is SET to split while it
 * holds one card, the Layout card on the right rail, and the readers for the
 * marks and the drawn blocks.
 *
 * Split out of `at0469-layout-places.test.ts` when that file was cut into
 * `at0469-places-marks`, `at0469-places-sidebar-rows` and
 * `at0469-places-drawing` to keep each under the 20 s budget.
 */

import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const RAIL_WIDTH = 420;
export const PANE_WIDTH = 420;
export const AFTER_LAND_MS = 900;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export const PLACES = '[data-testid="layout-card-places"]';
/** The toggle row under the strip — where every slot's mark stands. */
export const TOGGLES = '[data-testid="layout-card-toggles"]';
export const mark = (key: string): string => `[data-testid="layout-card-place-${key}"]`;

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** What a place's mark is saying, and where it stands. */
export interface MarkFacts {
  mode: string | null;
  rect: Rect | null;
}

/**
 * Three-up with the Layout card on the right: slot 0 shared by two cards, slot 1 held
 * by ONE card — and the imposition stores slot 1 as split.
 *
 * That is the trap, seeded as the state it is. A deck reaches it by splitting a
 * shared slot and then losing a member (at0455 covers that geometry); what
 * matters here is only that the arrangement outlives the membership, which is
 * the deck's deliberate behavior and not an edge case to be reproduced by a
 * dance of three actions.
 */
export function deckShape() {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const members: [string, number, string][] = [
    ["p1", 0, "A"],
    ["p2", 0, "B"],
    ["p3", 1, "C"],
  ];
  return {
    cards: [
      ...members.map(([, , cardId]) => ({
        id: cardId,
        componentId: "hello",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => pane(id, slot, cardId)),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { layout: { side: "right" } },
      // Slot 1 is SET to split and holds one card. Slot 0 is shared and
      // stacked, which is what an untouched shared slot is.
      columns: { 1: { mode: "split" } },
    },
    hasFocus: true,
  };
}

/**
 * Rest a pointer on an element the way the section would hear one.
 *
 * The harness has no hover verb, and a `pointerover` bubbles — so dispatching
 * it on the element itself and letting it rise is exactly what a real pointer
 * produces (`revealPaneControls` does the same). Every use of this below is
 * asking the section to answer a pointer and expecting it not to.
 */
export async function hover(app: App, selector: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) throw new Error("nothing at " + ${JSON.stringify(selector)});
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      return null;
    })()`,
  );
}

/** Tab until `selector` is the group carrying the keyboard ring — the walk the
 *  sidebar ladder is actually navigated by (at0277 and at0455 use the same one). */
export async function tabUntilKbd(app: App, selector: string): Promise<void> {
  const reached = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(`${selector}[data-key-view-kbd]`)}) !== null`,
    );
  for (let i = 0; i < 24; i += 1) {
    if (await reached()) return;
    await app.nativeKey("Tab");
    await wait(200);
  }
  if (await reached()) return;
  throw new Error(`Tab never reached ${selector}`);
}

/**
 * Stand the KEYBOARD CURSOR on one segment of one of the section's rows — the
 * only gesture that raises an audition in the plan.
 *
 * Tab carries the ring to the row; the arrows move the cursor within it, which
 * is what a segmented group's walk is. The loop is direction-agnostic because
 * where the cursor starts is the row's committed answer, which the deck's
 * state decides rather than this test.
 */
export async function cursorOnto(app: App, row: string, value: string): Promise<void> {
  const target = `[data-testid="${row}"] [data-key-cursor][data-choice-value="${value}"]`;
  const there = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(target)}) !== null`,
    );
  await app.dispatchControlAction("toggle-layout");
  await wait(300);
  await tabUntilKbd(app, `[data-testid="${row}"]`);
  for (let i = 0; i < 8; i += 1) {
    if (await there()) return;
    await app.nativeKey("ArrowRight");
    await wait(150);
  }
  if (await there()) return;
  throw new Error(`the cursor never reached ${row}/${value}`);
}

/** Take the ring off the rows and put it on the toggle row, whose marks
 *  audition nothing — the keyboard's way of ending an audition without
 *  pressing. */
export async function cursorOffTheRows(app: App): Promise<void> {
  await tabUntilKbd(app, TOGGLES);
  await wait(300);
}

/**
 * Every ARRANGEMENT mark the overlay is drawing, by place key.
 *
 * Scoped to `.layout-places-mark`, which is the stack/split kind. A sidebar
 * member is a place too and carries `data-place` as well, but what is
 * arrangeable about it is which edge it holds rather than how it stacks — a
 * different question, read by its own test below.
 */
export function readMarks(app: App): Promise<Record<string, MarkFacts>> {
  return app.evalJS<Record<string, MarkFacts>>(
    `(function () {
      var out = {};
      var nodes = document.querySelectorAll('${TOGGLES} .layout-places-mark[data-place]');
      Array.prototype.forEach.call(nodes, function (el) {
        var r = el.getBoundingClientRect();
        out[el.getAttribute("data-place")] = {
          mode: el.getAttribute("data-mode"),
          rect: {
            top: r.top, bottom: r.bottom, left: r.left, right: r.right,
            width: r.width, height: r.height,
          },
        };
      });
      return out;
    })()`,
  );
}

/** The drawn block for a slot, in the committed drawing. */
export function blockRect(app: App, slot: number): Promise<Rect | null> {
  return app.evalJS<Rect | null>(
    `(function () {
      var layer = document.querySelector('.layouts-plan-layer[data-plan-layer="committed"]');
      if (layer === null) return null;
      var blocks = layer.querySelectorAll(".layout-mini-field .layout-mini-block");
      var el = blocks[${slot}];
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return {
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        width: r.width, height: r.height,
      };
    })()`,
  );
}

