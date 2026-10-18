/**
 * at0694-resize-keeps-slot-split.test.ts — in a split column, dragging a
 * member's inner top or bottom edge moves the seam it borders.
 *
 * A split column divides its run by shares, so a member's height is a share
 * and its inner edges are seams. Under the deck's keep-slot rule:
 *
 *  1. Only inner edges are height handles. The top member offers its bottom
 *     edge, the bottom member its top edge; the column's two outer edges, which
 *     are the run's, offer nothing.
 *  2. Pressing the member's own edge — not the seam's hit strip beside it —
 *     drags the seam: both neighbours change height by the drag, the outer
 *     edges stand, and the column's shares record the new division.
 *  3. What the hand left is what stays: the frames at pointer-up equal the
 *     frames once every settle has run out.
 *  4. Neither member leaves its slot.
 *
 * @covers tugdeck/src/components/chrome/column-seam-drag.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Long enough for any settle a commit could arm to have run out. */
const SETTLE_MS = 900;

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 560, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
      { id: "C", componentId: "gallery-accordion", title: "Card C", closable: true },
    ],
    panes: [pane("p1", 0, "A"), pane("p2", 0, "B"), pane("p3", 1, "C")],
    activePaneId: "p1",
    imposition: {
      kind: "two-up",
      layout: "fit",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p1", "p2"] } },
    },
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

async function rectOf(app: App, paneId: string): Promise<Rect> {
  return app.evalJS<Rect>(
    `(function () {
      var r = document.querySelector(${JSON.stringify(FRAME(paneId))}).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
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

/**
 * A point on `paneId`'s `edge` handle that hits the handle itself rather than
 * the seam's hit strip lying over most of it — so the press is the member's
 * edge, and what moves the seam is the hand-off, not the seam's own handler.
 */
async function ownEdgePoint(
  app: App,
  paneId: string,
  edge: "n" | "s",
): Promise<{ x: number; y: number } | null> {
  return app.evalJS<{ x: number; y: number } | null>(
    `(function () {
      var handle = document.querySelector(${JSON.stringify(`${FRAME(paneId)} > .tug-pane-resize-${edge}`)});
      var r = handle.getBoundingClientRect();
      var x = r.left + r.width / 2;
      for (var y = Math.ceil(r.top); y < r.bottom; y += 0.5) {
        if (document.elementFromPoint(x, y) === handle) return { x: x, y: y };
      }
      return null;
    })()`,
  );
}

async function slotOf(app: App, paneId: string): Promise<number | null> {
  return app.evalJS<number | null>(
    `window.tugdeck.diag.getDeckState().panes.find(function (p) { return p.id === ${JSON.stringify(paneId)}; }).slot ?? null`,
  );
}

async function sharesOf(app: App): Promise<unknown> {
  return app.evalJS<unknown>(
    `window.tugdeck.diag.getDeckState().imposition.columns?.[0]?.shares ?? null`,
  );
}

function expectSameRect(a: Rect, b: Rect, what: string): void {
  expect(Math.abs(a.left - b.left), `${what}: left`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.right - b.right), `${what}: right`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.top - b.top), `${what}: top`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.bottom - b.bottom), `${what}: bottom`).toBeLessThanOrEqual(0.5);
}

/** Drag from `from` by `dy`, reading both members at pointer-up and settled. */
async function dragSeamFrom(
  app: App,
  from: { x: number; y: number },
  dy: number,
): Promise<{
  upper: { atUp: Rect; settled: Rect };
  lower: { atUp: Rect; settled: Rect };
}> {
  const to = { x: from.x, y: from.y + dy };
  await app.nativeDragWithoutRelease(from, to);
  await app.nativeMouseUp(to);
  const upperUp = await rectOf(app, "p1");
  const lowerUp = await rectOf(app, "p2");
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return {
    upper: { atUp: upperUp, settled: await rectOf(app, "p1") },
    lower: { atUp: lowerUp, settled: await rectOf(app, "p2") },
  };
}

function expectSeamMoved(
  before: { upper: Rect; lower: Rect },
  drag: Awaited<ReturnType<typeof dragSeamFrom>>,
  dy: number,
  what: string,
): void {
  expectSameRect(drag.upper.atUp, drag.upper.settled, `${what}: upper at pointer-up vs settled`);
  expectSameRect(drag.lower.atUp, drag.lower.settled, `${what}: lower at pointer-up vs settled`);
  const upper = drag.upper.settled;
  const lower = drag.lower.settled;
  expect(Math.abs(upper.top - before.upper.top), `${what}: the column's top stands`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(lower.bottom - before.lower.bottom), `${what}: the column's bottom stands`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(upper.bottom - before.upper.bottom - dy), `${what}: the upper member's bottom moved by the drag`).toBeLessThanOrEqual(1);
  expect(Math.abs(lower.top - before.lower.top - dy), `${what}: the lower member's top moved by the drag`).toBeLessThanOrEqual(1);
}

describe.skipIf(!SHOULD_RUN)(
  "at0694 — a split member's inner edge moves the seam it borders",
  () => {
    test(
      "inner edges only, the seam follows the hand, shares recorded, slots kept",
      async () => {
        const app = await launchTugApp({ testName: "at0694-resize-keeps-slot-split" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${FRAME("p2")} > .tug-pane-resize-n`)}) !== null &&
             document.querySelector('[data-column-seam="0:0"]') !== null`,
            { timeoutMs: 8_000 },
          );

          // ── 1. Inner edges only; the right edge is slot 0's width handle. ──
          expect(await handlesOf(app, "p1"), "top member: its bottom edge").toEqual(["s", "e"]);
          expect(await handlesOf(app, "p2"), "bottom member: its top edge").toEqual(["n", "e"]);
          expect(await handlesOf(app, "p3"), "an undivided slot: its bottom edge sets its own height").toEqual(["s", "w"]);

          // ── 2–3. The top member's own bottom edge, down by 80. ──
          const fromBelow = await ownEdgePoint(app, "p1", "s");
          expect(fromBelow, "the top member's bottom edge is reachable outside the seam strip").not.toBeNull();
          const before1 = { upper: await rectOf(app, "p1"), lower: await rectOf(app, "p2") };
          const down = await dragSeamFrom(app, fromBelow!, 80);
          note(
            `p1 bottom ${before1.upper.bottom} → ${down.upper.settled.bottom}; ` +
              `p2 top ${before1.lower.top} → ${down.lower.settled.top}`,
          );
          expectSeamMoved(before1, down, 80, "down by 80");
          expect(await sharesOf(app), "the division is recorded as shares").not.toBeNull();

          // ── The bottom member's own top edge, up by 50. ──
          const fromAbove = await ownEdgePoint(app, "p2", "n");
          expect(fromAbove, "the bottom member's top edge is reachable outside the seam strip").not.toBeNull();
          const before2 = { upper: await rectOf(app, "p1"), lower: await rectOf(app, "p2") };
          const up = await dragSeamFrom(app, fromAbove!, -50);
          note(
            `p1 bottom ${before2.upper.bottom} → ${up.upper.settled.bottom}; ` +
              `p2 top ${before2.lower.top} → ${up.lower.settled.top}`,
          );
          expectSeamMoved(before2, up, -50, "up by 50");

          // ── 4. Both members kept their slot. ──
          expect(await slotOf(app, "p1")).toBe(0);
          expect(await slotOf(app, "p2")).toBe(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
