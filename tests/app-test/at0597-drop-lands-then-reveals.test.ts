/**
 * at0597-drop-lands-then-reveals.test.ts — a slot drop in flow is TWO MOVES.
 *
 * Drop a card onto a tile that straddles the band's far edge, released short
 * of the tile's centre so the landing has a distance to travel. What the
 * reader should see, in order:
 *
 *   1. The card lands: it is carried from under the hand into the tile the
 *      indicator promised, and the rest of the strip does not move while it
 *      does. The card comes to rest at the TILE — still straddling the band.
 *   2. A beat later the strip slides to show the card whole, and the card
 *      rides the strip with its neighbours.
 *
 * What used to happen: the reveal slide was spread into the same commit as
 * the slot move, so the tile the card was landing INTO moved while the
 * landing was measuring it, and the dropped frame — which the settle skips
 * because the landing owns it — jumped by the slide's distance the instant
 * its landing ended. The card hopped backwards.
 *
 * The pin is the sampled run of positions, because two commits are not two
 * moves unless the eye can tell them apart: the card's rest at the tile must
 * exist as samples with the neighbours still standing, and no sample may show
 * the card moving other than with its landing or with the strip.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/card-lifecycle.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { RAIL_GUTTER_PX } from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
/** Frames are measured in device pixels; a rounded pin is within a pixel. */
const TOL = 1.5;
/** The largest move one 8ms sample may show. A landing spring covers ~5px a
 *  sample and a settle ~2px; the hop this test exists to catch was the whole
 *  reveal distance (48px here) in one sample. */
const MAX_STEP_PX = 24;
const KIND_TILES = '[data-testid="layout-card-kind"] [data-choice-value]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Five 420px cards in a six-up flow strip, the Layout card on the right: the
 *  third card's tile straddles the band's far edge, which is what leaves a
 *  reveal owed after a drop onto it. */
function deckShape() {
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
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => pane(`p${index + 1}`, index, id)),
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
      kind: "six-up",
      layout: "flow",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

interface Sample {
  t: number;
  dropped: number;
  neighbour: number;
}

/** Record where the dropped pane and a neighbour stand, every 8ms, until
 *  {@link stopSampler}. A timer rather than rAF: an occluded harness window
 *  suspends rAF, and `getBoundingClientRect` answers regardless. */
const startSampler = (app: App): Promise<null> =>
  app.evalJS<null>(
    `(function () {
      window.__drop = { samples: [], t0: performance.now() };
      window.__drop.timer = setInterval(function () {
        var a = document.querySelector('.tug-pane[data-pane-id="p1"]');
        var b = document.querySelector('.tug-pane[data-pane-id="p2"]');
        if (a === null || b === null) return;
        window.__drop.samples.push({
          t: Math.round(performance.now() - window.__drop.t0),
          dropped: a.getBoundingClientRect().left,
          neighbour: b.getBoundingClientRect().left,
        });
      }, 8);
      return null;
    })()`,
  );

const stopSampler = (app: App): Promise<Sample[]> =>
  app.evalJS<Sample[]>(
    `(function () { clearInterval(window.__drop.timer); return window.__drop.samples; })()`,
  );

const frameBox = (
  app: App,
  paneId: string,
): Promise<{ left: number; right: number; top: number; bottom: number }> =>
  app.evalJS<{ left: number; right: number; top: number; bottom: number }>(
    `(function () {
      var b = document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    })()`,
  );

describe.skipIf(!SHOULD_RUN)("at0597 — a drop lands, then reveals", () => {
  test(
    "the card lands at its tile with the strip still, then rides the strip into view",
    async () => {
      const app = await launchTugApp({ testName: "at0597-drop-lands-then-reveals" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(900);

        // ── The fixture earns its assertions ──────────────────────────────
        const tile = await frameBox(app, "p3");
        const rail = await frameBox(app, "pRail");
        const bandRight = rail.left - RAIL_GUTTER_PX;
        const neighbourBefore = (await frameBox(app, "p2")).left;
        const owed = tile.right - bandRight;
        note(
          `tile ${Math.round(tile.left)}..${Math.round(tile.right)}, band right ${Math.round(
            bandRight,
          )}, reveal owed ${Math.round(owed)}px`,
        );
        expect(
          owed,
          "the target tile must straddle the band edge, or no reveal is owed",
        ).toBeGreaterThan(TOL);

        // ── The drop: onto the tile, short of its centre ──────────────────
        const titleBar = `.tug-pane[data-pane-id="p1"] [data-testid="tug-pane-title-bar"]`;
        const grab = await app.evalJS<{ x: number; y: number }>(
          `(function(){var b=document.querySelector(${JSON.stringify(titleBar)}).getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`,
        );
        const target = { x: tile.left + 80, y: grab.y };
        await startSampler(app);
        await app.nativeDragWithoutRelease(grab, target);
        await wait(120);
        const released = await frameBox(app, "p1");
        await app.nativeMouseUp(target);
        await wait(1800);
        const samples = await stopSampler(app);
        const after = await frameBox(app, "p1");
        const neighbourAfter = (await frameBox(app, "p2")).left;
        note(
          `released at ${Math.round(released.left)}; at rest ${Math.round(after.left)}..${Math.round(
            after.right,
          )}; neighbour ${Math.round(neighbourBefore)} → ${Math.round(neighbourAfter)}`,
        );
        expect(
          released.left,
          "the card was released short of the tile, so the landing has a distance",
        ).toBeLessThan(tile.left - 40);

        // ── 1. The landing: to the TILE, with the strip standing still ────
        const afterRelease = samples.filter((s) => s.dropped > released.left - TOL);
        const landedAt = afterRelease.findIndex((s) => Math.abs(s.dropped - tile.left) <= TOL);
        expect(landedAt, "the card reached the tile's edge").toBeGreaterThan(0);
        const landing = afterRelease.slice(0, landedAt + 1);
        const neighbourMovedDuringLanding = landing.some(
          (s) => Math.abs(s.neighbour - neighbourBefore) > TOL,
        );
        note(
          `landing: ${landing.length} samples from ${Math.round(landing[0].dropped)} to ${Math.round(
            landing[landing.length - 1].dropped,
          )}; neighbour moved during it = ${neighbourMovedDuringLanding}`,
        );
        expect(
          neighbourMovedDuringLanding,
          "the strip must not slide while the card is landing",
        ).toBe(false);

        // ── The rest between the beats ────────────────────────────────────
        const rest = afterRelease
          .slice(landedAt)
          .filter(
            (s) =>
              Math.abs(s.dropped - tile.left) <= TOL &&
              Math.abs(s.neighbour - neighbourBefore) <= TOL,
          );
        note(`at rest on the tile with the strip standing: ${rest.length} samples`);
        expect(
          rest.length,
          "the card stood at its tile, straddling the band, before the strip moved",
        ).toBeGreaterThan(3);

        // ── 2. The reveal: the strip slides, and the card rides it ────────
        expect(
          Math.abs(after.right - bandRight),
          "at rest the card is whole in the band, revealed by the least slide",
        ).toBeLessThanOrEqual(TOL);
        expect(
          neighbourBefore - neighbourAfter,
          "the neighbours slid by the same distance",
        ).toBeCloseTo(owed, 0);
        const slide = afterRelease.slice(landedAt);
        let worstDrift = 0;
        for (let i = 1; i < slide.length; i += 1) {
          const dDropped = slide[i].dropped - slide[i - 1].dropped;
          const dNeighbour = slide[i].neighbour - slide[i - 1].neighbour;
          worstDrift = Math.max(worstDrift, Math.abs(dDropped - dNeighbour));
        }
        note(`during the slide the card and its neighbour differed by at most ${worstDrift.toFixed(1)}px a sample`);
        expect(
          worstDrift,
          "the card moves WITH the strip during the reveal, never on its own",
        ).toBeLessThanOrEqual(TOL * 2);

        // ── No hop anywhere ───────────────────────────────────────────────
        let worstStep = 0;
        for (let i = 1; i < afterRelease.length; i += 1) {
          worstStep = Math.max(
            worstStep,
            Math.abs(afterRelease[i].dropped - afterRelease[i - 1].dropped),
          );
        }
        note(`largest single-sample move of the dropped card: ${worstStep.toFixed(1)}px`);
        expect(
          worstStep,
          "no sample shows the card jumping — every move is a tween",
        ).toBeLessThanOrEqual(MAX_STEP_PX);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
