/**
 * at0721-placard-over-masthead.test.ts — an open card's Z2 placard is seen
 * whole: taller than the room above Z2, it stands over the masthead rather
 * than being cut off at it or squeezed under it.
 *
 * The placard used to render in the card's chrome, and the pane body clips
 * (`.tug-pane-body { overflow: clip }`), so in a card whose transcript area
 * was shorter than the panel the masthead's bottom edge cut off its header and
 * first rows — the ARC step list lost its first steps, the TIME table its top
 * sections. The first fix capped the panel at the body's top and scrolled it,
 * which fit it in the card and hid as much of it. The rule now is the one the
 * folded card already had ([B07]): the placard portals to the pane frame,
 * which clips nothing, the frame is lifted above its peers, and the panel's
 * only bound is the visible canvas — so it paints over the masthead and past
 * the frame's top, and scrolls only when the canvas itself runs out.
 *
 * The panel's natural height has to exceed the room under the masthead, or
 * the case passes without asking its question. The session card's size policy
 * floors the pane well above the panel an unloaded session shows (~124px
 * against ~236px of room), so the test stands the empty-state row up to a long
 * table's height rather than seeding a transcript to fill the real one.
 *
 * @covers tugdeck/src/components/tugways/tug-placard.tsx
 * @covers tugdeck/src/components/tugways/tug-placard.css
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const TIME_CELL = '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="time"]';

function shortCard() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 400 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface Reading {
  open: boolean;
  /** Top of the pane body — the masthead's bottom edge, where the chrome clips. */
  mastheadBottom: number;
  /** Top of the visible canvas, clamped to the window — the panel's one bound. */
  canvasTop: number;
  placardTop: number;
  placardBottom: number;
  /** Header plus the list's full content: what the panel wants uncapped. */
  naturalHeight: number;
  /** The room between the panel's anchored bottom and the masthead's bottom. */
  roomUnderMasthead: number;
  /** The footer's bottom, which must stay inside the panel. */
  footerBottom: number | null;
  /** What paints just inside the panel's top edge — over the masthead. */
  headerHitInPlacard: boolean;
  /** The placard's DOM home is the pane frame, not the chrome. */
  inFrame: boolean;
  /** The frame wears the lift while the panel is up. */
  frameLifted: boolean;
}

const READ = `(function(){
  var pane = document.querySelector('.tug-pane[data-pane-id="p1"]');
  var body = pane.querySelector('.tug-pane-body');
  var placard = pane.querySelector('[data-slot="tug-placard"]');
  var r = function (x) { return Math.round(x * 10) / 10; };
  if (placard === null) {
    return { open: false, mastheadBottom: 0, canvasTop: 0, placardTop: 0, placardBottom: 0, naturalHeight: 0, roomUnderMasthead: 0, footerBottom: null, headerHitInPlacard: false, inFrame: false, frameLifted: false };
  }
  var pr = placard.getBoundingClientRect();
  // Uncapped for one read: the panel's own cap and the list's, lifted.
  var list = placard.querySelector('.tug-popup-list');
  placard.style.maxHeight = "none";
  if (list !== null) list.style.maxHeight = "none";
  var natural = placard.getBoundingClientRect().height;
  placard.style.maxHeight = "";
  if (list !== null) list.style.maxHeight = "";
  var footer = placard.querySelector('.tug-popup-list-footer');
  var bt = body.getBoundingClientRect().top;
  var canvas = pane.closest('[data-deck-canvas-background]');
  var ct = canvas === null ? 0 : Math.max(0, canvas.getBoundingClientRect().top);
  var hit = document.elementFromPoint(Math.round((pr.left + pr.right) / 2), Math.round(pr.top + 4));
  return {
    open: true,
    mastheadBottom: r(bt),
    canvasTop: r(ct),
    placardTop: r(pr.top),
    placardBottom: r(pr.bottom),
    naturalHeight: r(natural),
    roomUnderMasthead: r(pr.bottom - bt),
    footerBottom: footer === null ? null : r(footer.getBoundingClientRect().bottom),
    headerHitInPlacard: hit !== null && placard.contains(hit),
    inFrame: placard.parentElement === pane,
    frameLifted: pane.hasAttribute("data-sheet-open"),
  };
})()`;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0721: a Z2 placard stands over the masthead", () => {
  test(
    "a placard taller than the room under the masthead paints over it, whole",
    async () => {
      const app = await launchTugApp({ testName: "at0721-placard-over-masthead" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: shortCard(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: "at0721-a" });
        await app.awaitEngineReady("A");

        // A long table's worth of content, so the panel wants more than the
        // room under the masthead. Addressed through the pane frame rather
        // than the card: the placard is portaled to the frame, outside the
        // card's own subtree.
        await app.evalJS<null>(
          `(function(){ var s = document.createElement("style"); s.textContent = '.tug-pane[data-pane-id="p1"] .tug-placard .tug-popup-list-empty { min-height: 400px; }'; document.head.appendChild(s); return null; })()`,
        );
        await app.nativeClickAtElement(TIME_CELL);
        await wait(700);

        const reading = await app.evalJS<Reading>(READ);
        note("at0721 short card, TIME placard open", reading);
        note("at0721 screenshot", (await app.screenshot()).path);
        expect(reading.open).toBe(true);
        // The premise: the panel wants more than the card has under its masthead.
        expect(reading.naturalHeight, "the panel wants more than the room under the masthead")
          .toBeGreaterThan(reading.roomUnderMasthead);
        // The rule: it leaves the chrome for the frame, and the frame is lifted.
        expect(reading.inFrame, "the placard is portaled to the pane frame").toBe(true);
        expect(reading.frameLifted, "the frame wears the lift while the panel is up").toBe(true);
        // So the panel stands over the masthead — its top edge is above the
        // masthead's bottom, and what paints there is the panel, not the masthead.
        expect(reading.placardTop, "the panel's top is above the masthead's bottom edge")
          .toBeLessThan(reading.mastheadBottom);
        expect(reading.headerHitInPlacard, "the header paints over the masthead").toBe(true);
        // Its only bound is the visible canvas: nothing of it is above that.
        expect(reading.placardTop).toBeGreaterThanOrEqual(reading.canvasTop);
        // And whatever squeeze the canvas imposes went to the scroller, not
        // off the panel's bottom.
        if (reading.footerBottom !== null) {
          expect(reading.footerBottom).toBeLessThanOrEqual(reading.placardBottom + 0.5);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
