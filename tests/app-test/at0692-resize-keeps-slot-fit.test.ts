/**
 * at0692-resize-keeps-slot-fit.test.ts — on a fit deck, resizing a slotted
 * card by its edge keeps it in its slot, under the deck's default rule.
 *
 * A fit slot is the card's own width, standing at its travel fraction of the
 * band, so a width change moves each edge at its own rate: the first slot's
 * left edge and the last slot's right edge are pinned to the arrangement and
 * the other edge follows the hand one for one. What the test holds:
 *
 *  1. Only the edges with somewhere to go are handles. Slot 0 offers its right
 *     edge, the last slot its left edge — and each its bottom edge, which sets
 *     its height in the slot; no top and no corner, because the top of a card
 *     standing in its slot is the run's.
 *  2. The drag keeps the slot and clears the preset stamp: the width is a raw
 *     one nobody named, committed the way the width menu commits.
 *  3. The dragged edge lands under the pointer, the pinned edge does not move,
 *     and the frame's rect at pointer-up is its settled rect — nothing lands
 *     after the gesture ends.
 *  4. Freeing a card by its title bar (the ⌘-drag) still evicts it: the rule
 *     covers edges, never the gesture that means "out of the arrangement".
 *  5. Under "Releases" every edge is a handle again, as it always was.
 *
 * `tug-pane.tsx`, where the resize machine runs, and `layout-imposer.ts`,
 * whose fit `left` the gesture mirrors, are deliberately NOT named: both
 * already fan out to the selection budget, and one more namer would turn a
 * one-line edit there into a sweep. What this file holds is the gesture's
 * geometry — the edge rates, the inverse that keeps the edge under the hand,
 * and the twin of the imposer's `left` — which is the module named below.
 *
 * @covers tugdeck/src/lib/keep-slot-resize.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Long enough for any settle a commit could arm to have run out. */
const SETTLE_MS = 900;

const START_WIDTH = 560;

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
    ],
    panes: [pane("p1", 0, "A"), pane("p2", 1, "B")],
    activePaneId: "p1",
    imposition: { kind: "two-up", layout: "fit", sidebars: {} },
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

async function gripOf(
  app: App,
  paneId: string,
  edge: string,
): Promise<{ x: number; y: number }> {
  return app.evalJS(
    `(function () {
      var r = document.querySelector(${JSON.stringify(`${FRAME(paneId)} > .tug-pane-resize-${edge}`)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
}

/** Drag a handle, and read the frame at pointer-up and again once settled. */
async function dragEdge(
  app: App,
  paneId: string,
  edge: string,
  dx: number,
): Promise<{ grip: { x: number; y: number }; atUp: Rect; settled: Rect }> {
  const grip = await gripOf(app, paneId, edge);
  const to = { x: grip.x + dx, y: grip.y };
  await app.nativeDragWithoutRelease(grip, to);
  await app.nativeMouseUp(to);
  const atUp = await rectOf(app, paneId);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const settled = await rectOf(app, paneId);
  return { grip, atUp, settled };
}

function expectSameRect(a: Rect, b: Rect, what: string): void {
  expect(Math.abs(a.left - b.left), `${what}: left`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.right - b.right), `${what}: right`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.top - b.top), `${what}: top`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.bottom - b.bottom), `${what}: bottom`).toBeLessThanOrEqual(0.5);
}

describe.skipIf(!SHOULD_RUN)(
  "at0692 — an edge resize on a fit deck keeps the card in its slot",
  () => {
    test(
      "pinned edges are inert, the dragged edge follows the hand, and nothing lands after",
      async () => {
        const app = await launchTugApp({ testName: "at0692-resize-keeps-slot-fit" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${FRAME("p2")} > .tug-pane-resize`)}) !== null`,
            { timeoutMs: 8_000 },
          );

          // ── 1. Only the edges with somewhere to go. ──
          expect(await handlesOf(app, "p1"), "slot 0: the bottom and right edges").toEqual(["s", "e"]);
          expect(await handlesOf(app, "p2"), "the last slot: the bottom and left edges").toEqual(["s", "w"]);

          // ── 2–3. Slot 0, right edge in by 150. ──
          const p1Before = await rectOf(app, "p1");
          const p1 = await dragEdge(app, "p1", "e", -150);
          note(`p1 right ${p1Before.right} → ${p1.atUp.right} (pointer ${p1.grip.x - 150})`);
          expectSameRect(p1.atUp, p1.settled, "slot 0 at pointer-up vs settled");
          expect(Math.abs(p1.settled.left - p1Before.left), "the pinned left edge stands").toBeLessThanOrEqual(0.5);
          expect(
            Math.abs(p1.settled.right - p1Before.right - -150),
            "the right edge moved with the hand",
          ).toBeLessThanOrEqual(1);
          expect(p1.settled.top).toBeCloseTo(p1Before.top, 0);
          expect(p1.settled.bottom).toBeCloseTo(p1Before.bottom, 0);
          const p1Stored = await storedPane(app, "p1");
          expect(p1Stored.slot, "slot 0 kept").toBe(0);
          expect(p1Stored.widthPreset, "a width nobody named clears the stamp").toBeNull();
          expect(Math.abs(p1Stored.width - (START_WIDTH - 150))).toBeLessThanOrEqual(1);

          // ── The last slot, left edge in by 120. ──
          const p2Before = await rectOf(app, "p2");
          const p2 = await dragEdge(app, "p2", "w", 120);
          note(`p2 left ${p2Before.left} → ${p2.atUp.left} (pointer ${p2.grip.x + 120})`);
          expectSameRect(p2.atUp, p2.settled, "last slot at pointer-up vs settled");
          expect(Math.abs(p2.settled.right - p2Before.right), "the pinned right edge stands").toBeLessThanOrEqual(0.5);
          expect(
            Math.abs(p2.settled.left - p2Before.left - 120),
            "the left edge moved with the hand",
          ).toBeLessThanOrEqual(1);
          const p2Stored = await storedPane(app, "p2");
          expect(p2Stored.slot, "the last slot kept").toBe(1);
          expect(p2Stored.widthPreset).toBeNull();

          // ── 5. Under "Releases", every edge is a handle again. ──
          await app.dispatchControlAction("set-resize-slot", { resizeSlot: "release" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(`${FRAME("p1")} > .tug-pane-resize`)}).length === 8`,
            { timeoutMs: 8_000 },
          );
          await app.dispatchControlAction("set-resize-slot", { resizeSlot: "keep" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(`${FRAME("p1")} > .tug-pane-resize`)}).length === 2`,
            { timeoutMs: 8_000 },
          );

          // ── 4. The title bar's ⌘-drag still frees the card. ──
          const bar = await app.evalJS<{ x: number; y: number }>(
            `(function () {
              var r = document.querySelector(${JSON.stringify(`${FRAME("p1")} [data-testid="tug-pane-title-bar"]`)}).getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })()`,
          );
          await app.holdModifier(["cmd"], async (inner) => {
            await inner.rpcCall<void>("nativeDrag", {
              from: bar,
              to: { x: bar.x + 40, y: bar.y + 160 },
            });
          });
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getDeckState().panes.find(function (p) { return p.id === "p1"; }).slot === undefined`,
            { timeoutMs: 8_000 },
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
