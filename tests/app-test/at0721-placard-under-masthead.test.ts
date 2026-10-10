/**
 * at0721-placard-under-masthead.test.ts — an open card's Z2 placard fits
 * between its anchor and the masthead, and scrolls rather than being cut off.
 *
 * The placard renders in-DOM inside the card's body, and the body clips
 * (`.tug-pane-body { overflow: clip }`). Its upward guard measured to the
 * WINDOW top, so in a card whose transcript area was shorter than the panel,
 * the panel grew past the body's top edge and the masthead's bottom edge cut
 * off its header and first rows — the ARC step list lost its first steps, the
 * TIME table its top sections. The guard now measures to the nearest clipping
 * ancestor and the panel takes that height as its `max-height`, so the
 * composed list's scroller absorbs the squeeze.
 *
 * The panel's natural height has to exceed the room, or the case passes
 * without asking its question. The session card's size policy floors the pane
 * well above the panel an unloaded session shows (~124px against ~236px of
 * room), so the test stands the empty-state row up to a long table's height
 * rather than seeding a transcript to fill the real one.
 *
 * @covers tugdeck/src/components/tugways/tug-placard.tsx
 * @covers tugdeck/src/components/tugways/tug-placard.css
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
  /** Top of the pane body — the masthead's bottom edge, where the clip runs. */
  clipTop: number;
  placardTop: number;
  placardBottom: number;
  /** Header plus the list's full content: what the panel wants uncapped. */
  naturalHeight: number;
  /** The room between the panel's anchored bottom and the clip. */
  room: number;
  /** The footer's bottom, which must stay inside the panel. */
  footerBottom: number | null;
  /** What paints just inside the panel's top edge. */
  headerHitInPlacard: boolean;
}

const READ = `(function(){
  var pane = document.querySelector('.tug-pane[data-pane-id="p1"]');
  var body = pane.querySelector('.tug-pane-body');
  var placard = pane.querySelector('[data-slot="tug-placard"]');
  var r = function (x) { return Math.round(x * 10) / 10; };
  if (placard === null) {
    return { open: false, clipTop: 0, placardTop: 0, placardBottom: 0, naturalHeight: 0, room: 0, footerBottom: null, headerHitInPlacard: false };
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
  var hit = document.elementFromPoint(Math.round((pr.left + pr.right) / 2), Math.round(pr.top + 4));
  return {
    open: true,
    clipTop: r(bt),
    placardTop: r(pr.top),
    placardBottom: r(pr.bottom),
    naturalHeight: r(natural),
    room: r(pr.bottom - bt),
    footerBottom: footer === null ? null : r(footer.getBoundingClientRect().bottom),
    headerHitInPlacard: hit !== null && placard.contains(hit),
  };
})()`;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0721: a Z2 placard stays under the masthead", () => {
  test(
    "a placard taller than the room caps at the body's top and scrolls",
    async () => {
      const app = await launchTugApp({ testName: "at0721-placard-under-masthead" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: shortCard(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: "at0721-a" });
        await app.awaitEngineReady("A");

        // A long table's worth of content, so the panel wants more than the room.
        await app.evalJS<null>(
          `(function(){ var s = document.createElement("style"); s.textContent = '[data-card-id="A"] .tug-placard .tug-popup-list-empty { min-height: 400px; }'; document.head.appendChild(s); return null; })()`,
        );
        await app.nativeClickAtElement(TIME_CELL);
        await wait(700);

        const reading = await app.evalJS<Reading>(READ);
        note("at0721 short card, TIME placard open", reading);
        note("at0721 screenshot", (await app.screenshot()).path);
        expect(reading.open).toBe(true);
        // The premise: uncapped, the panel would reach past the masthead.
        expect(reading.naturalHeight, "the panel wants more than the room").toBeGreaterThan(reading.room);
        // The fix: the whole panel, header included, stands below the clip.
        expect(reading.placardTop).toBeGreaterThanOrEqual(reading.clipTop);
        expect(reading.headerHitInPlacard, "the header paints, not the masthead").toBe(true);
        // And the squeeze went to the scroller, not off the panel's bottom.
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
