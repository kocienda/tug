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
 * The positions are the cards' views, read from the host: a card draws its
 * chrome in its own page and is one view the host carries under the hand and
 * lands, while its pane in the shell is a stand-in that shows nothing.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/lib/card-plan.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import type { HostFrameReading } from "./_harness/client";
import { PIXEL_TOL } from "./_harness/tolerances";
import { chromePoint, heldRectOf } from "./card-chrome-fixture";
import { RAIL_GUTTER_PX } from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
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

/** How far a card's view reaches past its pane (`CARD_APRON_PX`). */
const APRON_PX = 10;

/**
 * Record where the dropped card (A, in p1) and its neighbour (B, in p2) stand
 * on screen — the left edges of their panes in the views the host presents —
 * as fast as the host answers, until the returned `stop`.
 */
function startSampler(app: App): { stop: () => Promise<Sample[]> } {
  const samples: Sample[] = [];
  const t0 = Date.now();
  let running = true;
  const loop = (async () => {
    while (running) {
      const views = await app.bodies();
      const a = views.find((v) => v.cardId === "A");
      const b = views.find((v) => v.cardId === "B");
      if (a !== undefined && b !== undefined) {
        samples.push({ t: Date.now() - t0, dropped: a.presentedFrame.x + APRON_PX, neighbour: b.presentedFrame.x + APRON_PX });
      }
      await wait(4);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return samples;
    },
  };
}

const frameBox = (
  app: App,
  paneId: string,
): Promise<{ left: number; right: number; top: number; bottom: number }> =>
  // card-dom: shell — the arranged rect is the shell's stand-in's.
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
        await app.body("L").waitForCondition<boolean>(
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
        ).toBeGreaterThan(PIXEL_TOL);

        // ── The drop: onto the tile, short of its centre ──────────────────
        // p1's card, A, draws its title bar in its own page; its centre is
        // read there, in the shell's viewport points the drag is made in.
        const grab = await chromePoint(app, "A", '[data-testid="tug-pane-title-bar"]');
        // Into the tile's body, below every title band: a whole card released
        // over another pane's title band merges into it.
        const target = { x: tile.left + 80, y: Math.round((tile.top + tile.bottom) / 2) };
        const sampler = startSampler(app);
        await app.nativeDragWithoutRelease(grab, target);
        await wait(120);
        // Where the hand holds it: the view the host carries.
        const released = (await heldRectOf(app, "A"))!;
        // The host's own frame meter, armed over the landing: the plan that
        // lands A names its container to the meter, so the landing is read
        // tick by tick on the render server's clock rather than at the pace
        // the host answers polls.
        await app.hostFrames({ op: "arm", windowMs: 2_400 });
        await app.nativeMouseUp(target);
        await wait(1800);
        const samples = await sampler.stop();
        const frames = (await app.hostFrames({ op: "read" })) as HostFrameReading & {
          layers?: Record<string, { samples: { t: number; x: number; y: number }[]; active: { fromMs: number; toMs: number }[] }>;
        };
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
        const afterRelease = samples.filter((s) => s.dropped > released.left - PIXEL_TOL);
        const landedAt = afterRelease.findIndex((s) => Math.abs(s.dropped - tile.left) <= PIXEL_TOL);
        expect(landedAt, "the card reached the tile's edge").toBeGreaterThan(0);
        const landing = afterRelease.slice(0, landedAt + 1);
        const neighbourMovedDuringLanding = landing.some(
          (s) => Math.abs(s.neighbour - neighbourBefore) > PIXEL_TOL,
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
              Math.abs(s.dropped - tile.left) <= PIXEL_TOL &&
              Math.abs(s.neighbour - neighbourBefore) <= PIXEL_TOL,
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
        ).toBeLessThanOrEqual(PIXEL_TOL);
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
        ).toBeLessThanOrEqual(PIXEL_TOL * 2);

        // ── No hop: the landing on the host's frame meter ─────────────────
        // The dropped card lands as a one-card plan from where the hand let
        // go, and the meter samples its container on every display tick
        // over the plan's active spans. A landing that hops shows as one
        // window's move far past the curve's own pace, and the curve's pace
        // scales with the travel: the settle's spring peaks near 0.85% of
        // the travel per ms, so the bar is a tenth of the travel per 8ms —
        // about 1.5× that peak — and never under 24px, the bound the
        // shell's own landing was held to on a short drop. The poll-paced
        // samples above are noted beside it.
        let worstStep = 0;
        for (let i = 1; i < afterRelease.length; i += 1) {
          worstStep = Math.max(
            worstStep,
            Math.abs(afterRelease[i].dropped - afterRelease[i - 1].dropped),
          );
        }
        note(`largest single-poll move of the dropped card: ${worstStep.toFixed(1)}px`);
        const track = frames.layers?.A;
        expect(track, "the host's frame meter sampled A's view under its landing plan").toBeDefined();
        const inActive = (t: number): boolean => track!.active.some((s) => t >= s.fromMs && t <= s.toMs);
        // Read over a window of at least 8ms rather than tick to tick: a
        // display link that missed a frame fires a catch-up tick a moment
        // after the late one, and two samples a millisecond apart would
        // read the curve's ordinary advance as a hop.
        const WINDOW_MS = 8;
        let worstRate = 0;
        let worstPair = "";
        let worstTick = { step: 0, dt: 0 };
        for (let i = 1; i < track!.samples.length; i += 1) {
          const b = track!.samples[i];
          if (!inActive(b.t)) continue;
          const prev = track!.samples[i - 1];
          const tickStep = Math.hypot(b.x - prev.x, b.y - prev.y);
          if (tickStep > worstTick.step) worstTick = { step: tickStep, dt: b.t - prev.t };
          let j = i - 1;
          while (j > 0 && b.t - track!.samples[j].t < WINDOW_MS) j -= 1;
          const a = track!.samples[j];
          const dt = b.t - a.t;
          if (dt < WINDOW_MS) continue;
          const rate = Math.hypot(b.x - a.x, b.y - a.y) / dt;
          if (rate > worstRate) {
            worstRate = rate;
            worstPair = `${(rate * WINDOW_MS).toFixed(1)}px over ${dt.toFixed(1)}ms at +${b.t.toFixed(0)}ms`;
          }
        }
        note(
          `landing on the host's frame meter: ${track!.samples.length} samples over ${track!.active.length} active span(s); ` +
            `largest move ${(worstRate * WINDOW_MS).toFixed(1)}px per ${WINDOW_MS}ms (${worstPair}); ` +
            `largest single tick ${worstTick.step.toFixed(1)}px over a ${worstTick.dt.toFixed(1)}ms tick`,
        );
        expect(track!.active.length, "a plan carried A's landing").toBeGreaterThan(0);
        const landingSpan = track!.active[0];
        const inLanding = track!.samples.filter((s) => s.t >= landingSpan.fromMs && s.t <= landingSpan.toMs);
        const first = inLanding[0];
        const final = inLanding[inLanding.length - 1];
        const travel = Math.hypot(final.x - first.x, final.y - first.y);
        const hopBar = Math.max(24, travel / 10);
        note(
          `landing travel ${travel.toFixed(0)}px over ${Math.round(landingSpan.toMs - landingSpan.fromMs)}ms ` +
            `(${inLanding.length} ticks); no-hop bar ${hopBar.toFixed(1)}px per ${WINDOW_MS}ms`,
        );
        expect(worstRate * WINDOW_MS, `the landing moves the card no more than ${hopBar.toFixed(1)}px in an 8ms window: no hop`).toBeLessThanOrEqual(hopBar);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
