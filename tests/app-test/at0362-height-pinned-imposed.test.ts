/**
 * at0362-height-pinned-imposed.test.ts — a size-locked card is PLACED by the
 * imposition, not SIZED by it.
 *
 * An imposed pane normally IS its slot: `imposeStyle` runs it the whole
 * vertical band and pins it by its own width, because for every card that
 * holds content the box the arrangement gives out and the box the card fills
 * are the same box. About breaks that. It is a fixed 320×360 card — `min ==
 * max == preferred` in its registration, which is how a card type says
 * "exactly one correct size" — so it has no larger form to be stretched into.
 *
 * Two things follow, and they are the same rule read on two axes. Vertically,
 * stretching it to the height of a display leaves an about box with six
 * hundred pixels of nothing under the copyright line. Horizontally, pinning it
 * by its own 320 puts it hard against the band's near edge in slot 0 — a
 * narrow pane has more travel to give away, so it lands somewhere no other
 * card in that arrangement would. Both are the imposition treating the card's
 * size as the slot's size.
 *
 * So the slot is computed as though an ordinary content card stood there — the
 * deck's content-width preset wide, the full run tall — and About is centred
 * inside it. The slot belongs to the arrangement; the card is a thing standing
 * in it.
 *
 * What makes this worth a test rather than a glance is that nothing about the
 * About card asks for it. The opt-in is derived from the size policy already in
 * the registry (`min === max` per axis), so the failure mode is silent: a
 * refactor that drops the derivation leaves a card that still opens, still
 * lands in its slot, and is simply in the wrong place at the wrong size.
 * Geometry is the assertion.
 *
 * The neighbour in the seeded deck is the control. It is an ordinary content
 * card in the same three-up, and it must still fill its slot — proving the
 * change is a branch taken on the policy rather than a new rule for every
 * imposed pane.
 *
 * Scenario:
 *   1. Seed a three-up deck: an ordinary card in slot 0, About in slot 2.
 *   2. The ordinary card runs from the top gap to the bottom gap.
 *   3. About holds 320×360, and its centre sits on the centre of the slot an
 *      800-wide content card would have occupied.
 *   4. Clearing the imposition freezes About where it stood — the freeze reads
 *      the live frame, so the centred rect is what it keeps.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/tugways/cards/about-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** `IMPOSITION_GAP_PX` (`lib/layout-imposer.ts`). */
const GAP = 5;
/**
 * The bottom gap, which is the profile's rather than a constant. A maker's
 * canvas reserves `IMPOSITION_GAP_BOTTOM_MAKER_PX` at the foot for the host's
 * dev-info stamps; a release build draws none and keeps the ordinary gap
 * there. The app-test harness always reports maker mode OFF
 * (`AppDelegate.makerModeEnabled`), so the geometry under test is the release
 * one.
 */
const GAP_BOTTOM = GAP;
/** About's registered size policy (`cards/about-card.tsx`). */
const ABOUT_WIDTH = 320;
const ABOUT_HEIGHT = 360;
/** `CONTENT_WIDTH_PX.comfy` — the deck's default preset, so About's slot. */
const SLOT_WIDTH = 800;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

const FRAMES = ".tug-pane[data-pane-id]";

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "ABOUT", componentId: "about", title: "", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 420, height: 400 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
      {
        id: "pAbout",
        position: { x: 500, y: 40 },
        size: { width: 320, height: ABOUT_HEIGHT },
        cardIds: ["ABOUT"],
        activeCardId: "ABOUT",
        title: "",
        acceptsFamilies: [],
        slot: 2,
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "three-up" },
    hasFocus: true,
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function frameBox(app: App, paneId: string): Promise<Box> {
  return app.evalJS<Box>(
    `(() => {
      const r = document
        .querySelector('.tug-pane[data-pane-id="${paneId}"]')
        .getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`,
  );
}

async function viewport(app: App): Promise<{ width: number; height: number }> {
  return app.evalJS<{ width: number; height: number }>(
    `({ width: window.innerWidth, height: window.innerHeight })`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0362 — the imposition places a size-locked card instead of sizing it",
  () => {
    test(
      "About keeps 320×360 and centres in an ordinary card's slot",
      async () => {
        const app = await launchTugApp({
          testName: "at0362-height-pinned-imposed",
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 2`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          const vp = await viewport(app);
          const runTop = GAP;
          const runHeight = vp.height - GAP - GAP_BOTTOM;
          // The band, and the last slot of a three-up within it: an 800-wide
          // card ends its travel a gap short of the band's far edge.
          const bandRight = vp.width - GAP;
          const slotLeft = bandRight - SLOT_WIDTH;

          // --- The control: an ordinary card still runs the whole band. ----
          {
            const box = await frameBox(app, "p1");
            expect(box.top).toBeCloseTo(runTop, 0);
            expect(box.height).toBeCloseTo(runHeight, 0);
          }

          // --- About holds its size and rides the middle of its slot. ------
          // The centre is asserted on both axes rather than the near edges,
          // because the edges are only right by consequence and a formula that
          // got a halving wrong could still land a plausible-looking number.
          let aboutBox: Box;
          {
            aboutBox = await frameBox(app, "pAbout");
            expect(aboutBox.width).toBeCloseTo(ABOUT_WIDTH, 0);
            expect(aboutBox.height).toBeCloseTo(ABOUT_HEIGHT, 0);
            expect(aboutBox.left + aboutBox.width / 2).toBeCloseTo(
              slotLeft + SLOT_WIDTH / 2,
              0,
            );
            expect(aboutBox.top + aboutBox.height / 2).toBeCloseTo(
              runTop + runHeight / 2,
              0,
            );
          }

          // The bug this was written from, stated directly: pinning by the
          // card's own width would have put its left edge on the band's far
          // travel for a 320 card, well to the right of where it belongs.
          expect(aboutBox.left).toBeCloseTo(slotLeft + (SLOT_WIDTH - ABOUT_WIDTH) / 2, 0);
          expect(aboutBox.left).not.toBeCloseTo(bandRight - ABOUT_WIDTH, 0);

          // --- Turning the imposition off freezes it where it stood. -------
          // `setImposition(null)` writes the LIVE frame rect into the store,
          // so the centred geometry is what survives — a free About must not
          // snap back to the stale seeded rect.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-imposition", { kind: null }), null)`,
          );
          await wait(AFTER_LAND_MS);
          {
            const box = await frameBox(app, "pAbout");
            expect(box.width).toBeCloseTo(ABOUT_WIDTH, 0);
            expect(box.height).toBeCloseTo(ABOUT_HEIGHT, 0);
            expect(box.left).toBeCloseTo(aboutBox.left, 0);
            expect(box.top).toBeCloseTo(aboutBox.top, 0);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
