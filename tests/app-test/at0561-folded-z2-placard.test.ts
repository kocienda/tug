/**
 * at0561-folded-z2-placard.test.ts — a Z2 placard on a FOLDED Session card
 * hangs below the folded frame, whole, over the peer beneath.
 *
 * ## Why this exists
 *
 * A folded card is its masthead and its Z2 row and nothing else, so a placard
 * that opens upward from the status strip has nowhere to go: above Z2 there is
 * only the masthead and then the frame's top edge, `.tug-pane-chrome` has
 * `overflow: clip`, the placard's viewport guard sizes its body from the gap up
 * to the window top, and `z-index: 20` inside the pane cannot reach over a
 * peer. On a folded card the placard therefore flips — it anchors to the bottom
 * of the Z2 row, portals to the pane frame (which clips nothing), grows down
 * over the wall, and caps its body against the visible canvas bottom.
 *
 * The open card's upward form is not this file's subject and is pinned by
 * `at0543-z2-popup-newest-reading` and `at0211-btw-side-question-overlay`.
 *
 * ## What the before-measurement found
 *
 * Taken on a folded 820x620 card at the top of the wall, before any of this
 * was built. All five placards anchored their bottom edge at y=125, inside a
 * frame running 40..184 — so the panel was in the card, not out of it, and the
 * cause the reader meets first is the **viewport guard**: it wrote
 * `--radix-popover-content-available-height: 121px` for every cell, capping
 * each body at the sliver between the Z2 row and the top of the window.
 * The **clip** bit next, and only on the one placard whose content wanted more
 * than the guard allowed: TIME measured 0..125 with 40px of it cut off by the
 * chrome. The **z-index** never bit at all in this arrangement, because the
 * folded card was the focused pane (z 2) and outranked its peer (z 1) — it is
 * the cause a reader meets only when the card beneath is the focused one.
 * Nothing overhung: `overlapsPeerPx` was 0 for all five.
 *
 * Reading the geometry under this harness: the window is occluded, so the
 * document timeline never advances and the placard's 120ms enter animation
 * stays parked on its first frame — `getBoundingClientRect` is displaced by its
 * `translateY(4px)` until the animation is finished. Every case here finishes
 * the placard's animations before it measures.
 *
 * @covers tugdeck/src/components/tugways/tug-placard.tsx
 * @covers tugdeck/src/components/tugways/tug-placard.css
 * @covers tugdeck/src/components/tugways/pane-raise.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0561-session";
const CARD = '[data-card-id="A"]';
const PLACARD = ".session-telemetry-status-placard";

/** Every Z2 cell that opens a placard, in row order. */
const CELLS = ["state", "time", "context", "tasks", "jobs"] as const;
type Cell = (typeof CELLS)[number];

interface Measure {
  /** The placard's own box. */
  placard: { top: number; bottom: number; left: number; right: number; height: number; width: number };
  /** The value of the placard's upward guard custom property, in px. */
  availableHeightPx: number | null;
  /** Computed `z-index` on the placard. */
  zIndex: string;
  /** The class list of the placard's `offsetParent` — the pane frame, folded. */
  offsetParent: string | null;
  /** Whether the placard is a descendant of the clipping chrome. */
  insideChrome: boolean;
  frame: { top: number; bottom: number };
  chrome: { top: number; bottom: number; overflow: string };
  canvas: { top: number; bottom: number };
  /** The activating cell's own box, for the horizontal anchoring. */
  cell: { left: number; right: number; center: number };
  /** How much of the placard the chrome's clip cuts off, top and bottom. */
  clippedTopPx: number;
  /** How far the placard hangs past the chrome — the overhang, folded. */
  overhangsChromePx: number;
  /** The peer pane's box, so a zero overlap can be read rather than guessed. */
  peer: { top: number; bottom: number };
  /** How far the placard reaches over the peer pane below. */
  overlapsPeerPx: number;
  /** Focus-order z of the two panes, and the folded card's lift attribute. */
  paneA: { z: number; lifted: boolean };
  paneB: { z: number };
}

function measureScript(cell: Cell): string {
  return `(function(){
  var p = document.querySelector(${JSON.stringify(PLACARD)});
  if (p === null) return null;
  var frame = document.querySelector('.tug-pane[data-pane-id="p1"]');
  var peer = document.querySelector('.tug-pane[data-pane-id="p2"]');
  var chrome = frame.querySelector(".tug-pane-chrome");
  var canvas = frame.parentElement;
  var cellEl = document.querySelector(${JSON.stringify(CARD)} + ' [data-priority=' + ${JSON.stringify(JSON.stringify(cell))} + ']');
  var r = function (x) { return Math.round(x * 10) / 10; };
  var pr = p.getBoundingClientRect();
  var fr = frame.getBoundingClientRect();
  var kr = chrome.getBoundingClientRect();
  var vr = canvas.getBoundingClientRect();
  var br = peer.getBoundingClientRect();
  var cr = cellEl === null ? null : cellEl.getBoundingClientRect();
  var avail = getComputedStyle(p).getPropertyValue("--radix-popover-content-available-height").trim();
  var op = p.offsetParent;
  return {
    placard: { top: r(pr.top), bottom: r(pr.bottom), left: r(pr.left), right: r(pr.right), height: r(pr.height), width: r(pr.width) },
    availableHeightPx: avail === "" ? null : r(parseFloat(avail)),
    zIndex: getComputedStyle(p).zIndex,
    offsetParent: op === null ? null : (op.className || op.tagName),
    insideChrome: chrome.contains(p),
    frame: { top: r(fr.top), bottom: r(fr.bottom) },
    chrome: { top: r(kr.top), bottom: r(kr.bottom), overflow: getComputedStyle(chrome).overflow },
    canvas: { top: r(vr.top), bottom: r(vr.bottom) },
    cell: cr === null ? { left: 0, right: 0, center: 0 } : { left: r(cr.left), right: r(cr.right), center: r(cr.left + cr.width / 2) },
    clippedTopPx: r(Math.max(0, kr.top - pr.top)),
    overhangsChromePx: r(Math.max(0, pr.bottom - kr.bottom)),
    peer: { top: r(br.top), bottom: r(br.bottom) },
    overlapsPeerPx: r(Math.max(0, Math.min(pr.bottom, br.bottom) - Math.max(pr.top, br.top))),
    paneA: { z: Number(getComputedStyle(frame).zIndex), lifted: frame.hasAttribute("data-sheet-open") },
    paneB: { z: Number(getComputedStyle(peer).zIndex) },
  };
})()`;
}

/**
 * Two panes, the folded one FIRST in the deck's array — so the peer below it
 * outranks it in focus order, and a placard that only had the strip's
 * `z-index: 20` could not paint over it even where nothing clipped.
 */
function wallShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
      { id: "B", componentId: "session", title: "Session B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        // Directly under the FOLDED frame's bottom edge (40 + 144), so the
        // overhang has something to be over. Unfolded, A simply covers it.
        position: { x: 40, y: 190 },
        size: { width: 820, height: 620 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function seedWall(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: wallShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A");
}

async function fold(app: App, folded: boolean): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.__tug.getPaneRecord("p1").folded === ${folded}`,
    { timeoutMs: 8000 },
  );
  await new Promise((r) => setTimeout(r, 1200));
}

/**
 * Open a cell's placard through the cell's own `onClick`. A folded card's
 * status row is on screen, but the harness window is occluded and a native
 * click through the window server is the slower gesture for a loop over five
 * cells; the click handler is the same one either way.
 */
async function openPlacard(app: App, cell: Cell): Promise<void> {
  const selector = `${CARD} [data-priority="${cell}"]`;
  expect(
    await app.evalJS<boolean>(
      `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return false;
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      })()`,
    ),
    `the ${cell} cell is present on the folded card`,
  ).toBe(true);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PLACARD)}) !== null`,
    { timeoutMs: 8000 },
  );
  await new Promise((r) => setTimeout(r, 250));
  await app.evalJS<null>(
    `(document.querySelectorAll(${JSON.stringify(PLACARD)}).forEach(function (e) { e.getAnimations().forEach(function (a) { a.finish(); }); }), null)`,
  );
}

async function closePlacard(app: App, cell: Cell): Promise<void> {
  const selector = `${CARD} [data-priority="${cell}"]`;
  await app.evalJS<null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el !== null) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PLACARD)}) === null`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0561: a Z2 placard on a folded card hangs downward",
  () => {
    test(
      "every Z2 cell's placard hangs below the folded frame, whole, over the peer",
      async () => {
        const app = await launchTugApp({ testName: "at0561-folded-placard" });
        try {
          await seedWall(app);
          await fold(app, true);

          for (const cell of CELLS) {
            await openPlacard(app, cell);
            const m = await app.evalJS<Measure | null>(measureScript(cell));
            note(`measure-folded-${cell}`, m);
            expect(m, `the ${cell} placard opened`).not.toBeNull();
            const g = m as Measure;

            // It left the clipping chrome for the frame, which clips nothing.
            expect(g.insideChrome, "the placard portals out of the chrome").toBe(false);
            expect(g.clippedTopPx).toBeLessThanOrEqual(0.5);

            // It hangs DOWN from the Z2 row, past the folded frame's bottom.
            expect(g.placard.top).toBeGreaterThanOrEqual(g.frame.top);
            expect(
              g.placard.bottom,
              "the placard reaches past the folded frame",
            ).toBeGreaterThan(g.frame.bottom);

            // Whole: a real body, capped against the visible canvas bottom.
            expect(g.placard.height).toBeGreaterThan(40);
            expect(g.placard.bottom).toBeLessThanOrEqual(g.canvas.bottom + 0.5);
            expect(
              g.availableHeightPx,
              "the guard measures downward room, not the gap to the window top",
            ).not.toBeNull();
            expect(g.availableHeightPx as number).toBeGreaterThan(40);

            // Over the peer beneath, and lifted so it paints there.
            expect(g.overlapsPeerPx, "it reaches over the peer below").toBeGreaterThan(0);
            expect(g.paneA.lifted, "the folded frame takes the sheet lift").toBe(true);
            expect(g.paneA.z).toBeGreaterThan(g.paneB.z);

            // Pointing at its cell: the placard spans the cell's centre.
            expect(g.placard.left).toBeLessThanOrEqual(g.cell.center + 0.5);
            expect(g.placard.right).toBeGreaterThanOrEqual(g.cell.center - 0.5);

            // The tallest of the five, shot while it is up: the picture of the
            // whole claim, for a reader who would rather look than read rects.
            if (cell === "time") note("at0561 folded TIME placard", (await app.screenshot()).path);

            await closePlacard(app, cell);
            // And the lift is released with it.
            expect(
              await app.evalJS<boolean>(
                `document.querySelector('.tug-pane[data-pane-id="p1"]').hasAttribute("data-sheet-open")`,
              ),
              "closing the placard releases the frame lift",
            ).toBe(false);
          }

        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    // The open card's upward form does not move: the same cell, unfolded,
    // opens above the status strip and stays inside the chrome.
    test(
      "unfolded, the same placard keeps its upward in-card form",
      async () => {
        const app = await launchTugApp({ testName: "at0561-unfolded-placard" });
        try {
          await seedWall(app);

          await openPlacard(app, "state");
          const m = await app.evalJS<Measure | null>(measureScript("state"));
          note("measure-unfolded-state", m);
          const g = m as Measure;
          expect(g.insideChrome, "an open card's placard stays in the chrome").toBe(true);
          expect(g.placard.bottom).toBeLessThanOrEqual(g.frame.bottom + 0.5);
          expect(g.paneA.lifted, "an open card's placard takes no lift").toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
