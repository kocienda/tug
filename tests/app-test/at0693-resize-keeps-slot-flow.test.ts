/**
 * at0693-resize-keeps-slot-flow.test.ts — on a flow deck, resizing a slotted
 * card by its edge keeps it in its slot, and the slots after it travel with
 * the hand.
 *
 * In flow a slot's place is the running sum of the slots before it, so a card's
 * left edge has nowhere to go and its right edge is the whole of the gesture.
 * What the test holds:
 *
 *  1. Only the right edge is a width handle — on every card, first, middle and
 *     last — beside the bottom edge that sets a card's height in its slot. No
 *     left edge, no top, no corner.
 *  2. While the hand holds the edge, the right edge is under it, the card's
 *     left edge stands, and every later slot has already moved by the change.
 *  3. What the gesture drew is what the commit draws: every frame's rect while
 *     the hand held it equals its rect once the width is in the store and
 *     every settle has run out — nothing lands after the gesture ends.
 *  4. The card keeps its slot and its preset stamp is cleared.
 *
 * `tug-pane.tsx` and `layout-imposer.ts` are deliberately NOT named, for the
 * reason `at0692` gives: both already fan out to the selection budget. What
 * this file holds is the strip the gesture re-asks at every frame, which is
 * the module named below.
 *
 * @covers tugdeck/src/lib/keep-slot-resize.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Long enough for any settle a commit could arm to have run out. */
const SETTLE_MS = 900;

/** Long enough for the gesture's frame to have been drawn. */
const FRAME_MS = 150;

const START_WIDTH = 480;
const PANES = ["p1", "p2", "p3"] as const;

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: START_WIDTH, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
    widthPreset: "slim",
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
      { id: "C", componentId: "gallery-accordion", title: "Card C", closable: true },
    ],
    panes: [pane("p1", 0, "A"), pane("p2", 1, "B"), pane("p3", 2, "C")],
    activePaneId: "p1",
    imposition: { kind: "three-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const FRAME = (paneId: string) => `.tug-pane[data-pane-id="${paneId}"]`;

/** Every pane's frame rect, keyed by pane id. */
async function rects(app: App): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      ${JSON.stringify(PANES)}.forEach(function (id) {
        var r = document.querySelector('.tug-pane[data-pane-id="' + id + '"]').getBoundingClientRect();
        out[id] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      return out;
    })()`,
  );
}

/** The edges this pane offers as handles, in DOM order. */
async function handlesOf(app: App, paneId: string): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${FRAME(paneId)} > .tug-pane-resize`)}))
      .map(function (el) {
        var m = /tug-pane-resize-(\\w+)/.exec(el.className.replace("tug-pane-resize ", ""));
        return m ? m[1] : "?";
      })`,
  );
}

async function storedPane(
  app: App,
  paneId: string,
): Promise<{ slot: number | null; width: number; widthPreset: string | null }> {
  return app.evalJS(
    `(function () {
      var p = window.tugdeck.diag.getDeckState().panes.find(function (x) { return x.id === ${JSON.stringify(paneId)}; });
      return { slot: p.slot ?? null, width: p.size.width, widthPreset: p.widthPreset ?? null };
    })()`,
  );
}

async function gripOf(app: App, paneId: string): Promise<{ x: number; y: number }> {
  return app.evalJS(
    `(function () {
      var r = document.querySelector(${JSON.stringify(`${FRAME(paneId)} > .tug-pane-resize-e`)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
}

/**
 * Drag `paneId`'s right edge by `dx`, reading every frame before, while the
 * hand holds it, and once settled after the release.
 */
async function dragRightEdge(
  app: App,
  paneId: string,
  dx: number,
): Promise<{
  before: Record<string, Rect>;
  held: Record<string, Rect>;
  settled: Record<string, Rect>;
}> {
  const before = await rects(app);
  const grip = await gripOf(app, paneId);
  const to = { x: grip.x + dx, y: grip.y };
  await app.nativeDragWithoutRelease(grip, to);
  await new Promise((r) => setTimeout(r, FRAME_MS));
  const held = await rects(app);
  await app.nativeMouseUp(to);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const settled = await rects(app);
  return { before, held, settled };
}

function expectSameRect(a: Rect, b: Rect, what: string): void {
  expect(Math.abs(a.left - b.left), `${what}: left`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.right - b.right), `${what}: right`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.top - b.top), `${what}: top`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.bottom - b.bottom), `${what}: bottom`).toBeLessThanOrEqual(0.5);
}

/** The gesture's frames are the commit's, and the card and its followers
 *  moved as the strip says: left standing, right with the hand, later slots
 *  by the same change, earlier slots not at all. */
function expectFlowResize(
  drag: Awaited<ReturnType<typeof dragRightEdge>>,
  paneId: string,
  dx: number,
): void {
  const { before, held, settled } = drag;
  for (const id of PANES) {
    expectSameRect(held[id], settled[id], `${id} while held vs settled`);
  }
  expect(Math.abs(settled[paneId].left - before[paneId].left), `${paneId}: the left edge stands`).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(settled[paneId].right - before[paneId].right - dx),
    `${paneId}: the right edge moved with the hand`,
  ).toBeLessThanOrEqual(1);
  const index = PANES.indexOf(paneId as (typeof PANES)[number]);
  PANES.forEach((id, k) => {
    const travel = settled[id].left - before[id].left;
    const expected = k > index ? dx : 0;
    expect(Math.abs(travel - expected), `${id} travelled ${travel}, expected ${expected}`).toBeLessThanOrEqual(1);
  });
}

describe.skipIf(!SHOULD_RUN)(
  "at0693 — an edge resize on a flow deck keeps the card in its slot",
  () => {
    test(
      "the right edge alone, later slots travelling with it, and nothing lands after",
      async () => {
        const app = await launchTugApp({ testName: "at0693-resize-keeps-slot-flow" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${FRAME("p3")} > .tug-pane-resize`)}) !== null`,
            { timeoutMs: 8_000 },
          );

          // ── 1. The right edge alone, on every card. ──
          for (const id of PANES) {
            expect(await handlesOf(app, id), `${id}: the bottom and right edges`).toEqual(["s", "e"]);
          }

          // ── 2–4. The first card narrower by 60 (its floor is 400): both later
          // slots follow. ──
          const first = await dragRightEdge(app, "p1", -60);
          note(
            `p1 right ${first.before.p1.right} → ${first.settled.p1.right}; ` +
              `p2 left ${first.before.p2.left} → held ${first.held.p2.left} → ${first.settled.p2.left}; ` +
              `p3 left ${first.before.p3.left} → held ${first.held.p3.left} → ${first.settled.p3.left}`,
          );
          expectFlowResize(first, "p1", -60);
          const p1 = await storedPane(app, "p1");
          expect(p1.slot, "the first slot kept").toBe(0);
          expect(p1.widthPreset, "a width nobody named clears the stamp").toBeNull();
          expect(Math.abs(p1.width - (START_WIDTH - 60))).toBeLessThanOrEqual(1);

          // ── The middle card wider by 90: only the last slot follows. ──
          const middle = await dragRightEdge(app, "p2", 90);
          note(
            `p2 right ${middle.before.p2.right} → ${middle.settled.p2.right}; ` +
              `p3 left ${middle.before.p3.left} → held ${middle.held.p3.left} → ${middle.settled.p3.left}`,
          );
          expectFlowResize(middle, "p2", 90);
          const p2 = await storedPane(app, "p2");
          expect(p2.slot, "the middle slot kept").toBe(1);
          expect(p2.widthPreset).toBeNull();
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
