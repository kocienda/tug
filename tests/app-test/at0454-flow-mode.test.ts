/**
 * at0454-flow-mode.test.ts — the deck's second geometry mode.
 *
 * In FIT a slot is an anchor at a fraction of the band, so a deck too narrow
 * for its cards overlaps them. In FLOW the occupied slots stand side by side in
 * a strip: nothing overlaps, the strip runs off the right edge when it is
 * longer than the band, and activating a card slides the viewport the minimum
 * that brings it in.
 *
 * Five things are pinned here, and each of them failed in an obvious way while
 * the mode was being built:
 *
 *  1. **Nothing overlaps.** Asserted pairwise over the occupied slots rather
 *     than by trusting the strip's arithmetic, and on a deck whose cards are
 *     wider than the band — a fixture where fit demonstrably DOES overlap, so
 *     the assertion has something to catch.
 *  2. **The reveal is minimal, and it animates.** Activating a card that is off
 *     the right edge slides the strip exactly far enough; activating one that
 *     is already in view moves nothing at all, because an activation that
 *     reveals nothing must commit no geometry.
 *  3. **The mode toggle is a census gesture.** `arrangementSignature` gains
 *     `imposition.layout` as a term of its own. Without it the toggle moves
 *     every pane's `left` while every other term holds still, no settle arms,
 *     and the one gesture the mode exists to offer is the one that cuts.
 *  4. **The offset's clamp lives in CSS.** Fit answers a window resize entirely
 *     in the browser; flow has to as well, or it is the one mode that shows a
 *     stale viewport until the 200ms settled-resize retune fires. The clamp
 *     block writes an offset past the strip's end — which is exactly the state
 *     a widened window leaves behind before the retune — and requires the
 *     browser to hold the last card against the band's right edge anyway.
 *  5. **The band's edge is real ink.** A straddling card's overhang paints on
 *     under the rail and out into the margin between the rail and the window
 *     edge unless something stops it. The rail does the stopping now — it is
 *     opaque and outranks every free card — and the five pixels it stands off
 *     the window edge, which no rail width can cover, are covered by a margin
 *     cap. So the pin is that no card answers in that margin while the same
 *     card still answers inside the band, and that what answers there is the
 *     cap, carrying the canvas-background marker so the press it takes still
 *     deselects.
 *  6. **A card that ARRIVES is revealed too.** An opener that names a slot —
 *     a file link naming the one beside the card that cited it — can name a
 *     slot the band is only half showing. The raise reveals; for a while the
 *     arrival did not, and the file the reader had just clicked landed with
 *     its near edge under the rail.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/margin-cap.css
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  IMPOSITION_GAP_PX,
  RAIL_EDGE_INSET_PX,
  RAIL_GUTTER_PX,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** Frames are measured in device pixels; a rounded pin is within a pixel. */
const TOL = 1.5;
const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
/** Part 6's cards. Wide enough that the band — three 420s across — holds one
 *  and a bit, which is the crowding that leaves a neighbouring slot straddling
 *  its near edge. */
const WIDE_PANE_WIDTH = 800;
const SLOTS = 5;
const KIND_TILES = '[data-testid="layout-card-kind"] [data-choice-value]';
const LAYOUT_TILES = '[data-testid="layout-card-layout"] [data-choice-value]';
const KIND_GROUP = '[data-testid="layout-card-kind"]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface CutRecord {
  paneId: string;
  kind: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Five cards in a six-up, plus the Layout card on the right — a strip comfortably
 *  longer than the band on any window this harness opens. */
function deckShape(paneWidth: number = PANE_WIDTH) {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: paneWidth, height: 400 },
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
      // Fit explicitly: the deck's default is flow now, and every part below
      // starts from fit and moves to flow, so the fixture has to say so.
      layout: "fit",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** Every imposed pane's frame in viewport coordinates, in slot order. */
async function slotRects(
  app: App,
): Promise<{ paneId: string; left: number; right: number }[]> {
  return app.evalJS<{ paneId: string; left: number; right: number }[]>(
    `(function () {
      var state = window.tugdeck.diag.getDeckState();
      var out = [];
      state.panes.forEach(function (pane) {
        if (pane.slot === undefined) return;
        var el = document.querySelector('.tug-pane[data-pane-id="' + pane.id + '"]');
        if (el === null) return;
        var box = el.getBoundingClientRect();
        out.push({ paneId: pane.id, slot: pane.slot, left: box.left, right: box.right });
      });
      out.sort(function (a, b) { return a.slot - b.slot; });
      return out;
    })()`,
  );
}

/**
 * The band's edges in viewport coordinates — what `imposeStyle` measures
 * against.
 *
 * Measured off the rail's own painted frame rather than off the
 * `--tug-imposer-inset-*` properties, because those resolve to a `calc()` over
 * the rail width property and `parseFloat` of a calc is NaN. The band begins
 * one card gap in from the canvas edge and ends one rail gutter short of the
 * rail's near edge — which is the same arithmetic `resolveSpan` does, read
 * from pixels the deck actually drew.
 */
async function band(app: App): Promise<{ left: number; right: number }> {
  return app.evalJS<{ left: number; right: number }>(
    `(function () {
      var el = document.querySelector("[data-deck-canvas-background]");
      var box = el.getBoundingClientRect();
      var rail = document
        .querySelector('.tug-pane[data-pane-id="pRail"]')
        .getBoundingClientRect();
      return { left: box.left + ${IMPOSITION_GAP_PX}, right: rail.left - ${RAIL_GUTTER_PX} };
    })()`,
  );
}

async function flowOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** The ids of every Text card the deck holds, for catching the one an open
 *  adds. */
const textCardIds = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `window.tugdeck.diag.getDeckState().cards
      .filter(function (c) { return c.componentId === "text"; })
      .map(function (c) { return c.id; })`,
  );

/** The painted frame of the pane holding `cardId`, in viewport coordinates. */
const cardRect = (
  app: App,
  cardId: string,
): Promise<{ left: number; right: number }> =>
  app.evalJS<{ left: number; right: number }>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.cardIds.indexOf(${JSON.stringify(cardId)}) !== -1;
      });
      var box = document
        .querySelector('.tug-pane[data-pane-id="' + pane.id + '"]')
        .getBoundingClientRect();
      return { left: box.left, right: box.right };
    })()`,
  );

async function setLayout(app: App, layout: "fit" | "flow"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: ${JSON.stringify(layout)} }), null)`,
  );
}

/** Tab until `selector` is the group carrying the keyboard ring — the walk the
 *  sidebar ladder is actually navigated by (at0277 uses the same one). */
async function tabUntilKbd(app: App, selector: string): Promise<void> {
  const reached = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(`${selector}[data-key-view-kbd]`)}) !== null`,
    );
  for (let i = 0; i < 20; i += 1) {
    if (await reached()) return;
    await app.nativeKey("Tab");
    await wait(200);
  }
  if (await reached()) return;
  throw new Error(`Tab never reached ${selector}`);
}

/** Which segment of the Layout row is the standing answer. */
async function activeLayoutTile(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var el = document.querySelector(
        '[data-testid="layout-card-layout"] [data-choice-value][data-state="active"]',
      );
      return el === null ? null : el.getAttribute("data-choice-value");
    })()`,
  );
}

async function takeCuts(app: App): Promise<CutRecord[]> {
  return app.evalJS<CutRecord[]>(`window.__tug.takeCutRecords()`);
}

function summarize(records: readonly CutRecord[]): string {
  return records
    .map((r) =>
      r.kind === "appeared"
        ? `${r.paneId} appeared with nothing animating it`
        : `${r.paneId} jumped (${Math.round(r.dx)}, ${Math.round(r.dy)})`,
    )
    .join("; ");
}

describe.skipIf(!SHOULD_RUN)("at0454 — flow mode", () => {
  test(
    "the strip never overlaps, reveals minimally, toggles without cutting, and clamps in CSS",
    async () => {
      const app = await launchTugApp({ testName: "at0454-flow-mode" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── The fixture earns its assertions ────────────────────────────────
        // In fit, five 420px cards in a six-up on this band overlap. If they
        // did not, "nothing overlaps in flow" would be true of fit too and the
        // block below would be pinning nothing.
        const fitRects = await slotRects(app);
        const fitOverlaps = fitRects.some(
          (rect, index) =>
            index > 0 && rect.left < fitRects[index - 1].right - TOL,
        );
        note(`fit: ${fitRects.length} slots, overlapping = ${fitOverlaps}`);
        expect(
          fitOverlaps,
          "the fixture must be a deck fit actually crowds",
        ).toBe(true);

        // ── 1. Nothing overlaps in flow ─────────────────────────────────────
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);
        const rects = await slotRects(app);
        expect(rects.length, "every seeded card still stands").toBe(SLOTS);
        for (let i = 1; i < rects.length; i += 1) {
          expect(
            rects[i].left,
            `slot ${i} starts at or after slot ${i - 1} ends`,
          ).toBeGreaterThanOrEqual(rects[i - 1].right - TOL);
        }
        const bandBox = await band(app);
        const stripLength = rects[rects.length - 1].right - rects[0].left;
        note(
          `flow: strip ${Math.round(stripLength)}px over a ${Math.round(
            bandBox.right - bandBox.left,
          )}px band`,
        );
        expect(
          stripLength,
          "the strip must overflow, or there is nothing to reveal",
        ).toBeGreaterThan(bandBox.right - bandBox.left);

        // ── 2. The reveal is minimal, and it animates ───────────────────────
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
        await takeCuts(app);

        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);
        const revealCuts = await takeCuts(app);
        note(`reveal cuts: ${summarize(revealCuts) || "none"}`);
        expect(
          revealCuts.length,
          "the slide is a settle, not a jump",
        ).toBe(0);

        const revealed = (await slotRects(app))[SLOTS - 1];
        const bandAfter = await band(app);
        note(
          `after reveal: offset ${await flowOffset(app)}, card right ${Math.round(
            revealed.right,
          )}, band right ${Math.round(bandAfter.right)}, canvas ${await app.evalJS<number>(
            `document.querySelector("[data-deck-canvas-background]").parentElement.clientWidth`,
          )}`,
        );
        expect(
          revealed.right,
          "the activated card is inside the band's right edge",
        ).toBeLessThanOrEqual(bandAfter.right + TOL);
        expect(
          revealed.right,
          "and no further in than it had to come — the move is minimal",
        ).toBeGreaterThanOrEqual(bandAfter.right - TOL);

        // Activating a card already in view commits nothing.
        const offsetBefore = await flowOffset(app);
        await takeCuts(app);
        await app.evalJS<null>(`(window.__tug.activateCard("D"), null)`);
        await wait(AFTER_LAND_MS);
        expect(
          await flowOffset(app),
          "an activation that reveals nothing moves nothing",
        ).toBe(offsetBefore);
        expect(
          (await takeCuts(app)).length,
          "and arms no settle either",
        ).toBe(0);

        // ── 3. The mode toggle is a census gesture ──────────────────────────
        await takeCuts(app);
        await setLayout(app, "fit");
        await wait(AFTER_LAND_MS);
        const toFit = await takeCuts(app);
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);
        const toFlow = await takeCuts(app);
        note(
          `toggle cuts: → fit ${summarize(toFit) || "none"}; → flow ${
            summarize(toFlow) || "none"
          }`,
        );
        expect(
          toFit.length,
          "leaving flow crosses — this is what the layout signature term is for",
        ).toBe(0);
        expect(toFlow.length, "and so does entering it").toBe(0);
        await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);

        // ── 4. The clamp is expressed in CSS ────────────────────────────────
        // Widening the window leaves the stored offset past the strip's end
        // until the settled-resize retune fires 200ms later. Written directly
        // here — the same property, on the same element, by the same name the
        // canvas writes it under — because what is being pinned is the
        // browser's resolution of `imposeStyle`'s expression, not the store's
        // arithmetic. Without the CSS clamp the strip stays shoved left with
        // dead air at the right edge.
        //
        // What lands on the band's edge is the strip's LAST PLACE, and on this
        // fixture that is not a card: five cards stand in a six-up, and every
        // slot of the kind holds its place whether or not a card is in it, so
        // slot 5 is a held-open vacancy at the strip's end. Measured as the
        // rightmost edge of anything imposed, which is what "the strip's far
        // end" means and what the clamp is actually pinning.
        const clamped = await app.evalJS<{ right: number; band: number }>(
          `(function () {
            var host = document.querySelector("[data-deck-canvas-background]");
            var strip = parseFloat(
              getComputedStyle(host).getPropertyValue("--tug-imposer-flow-strip"),
            ) || 0;
            host.style.setProperty("--tug-imposer-flow-offset", (strip + 4000) + "px");
            var right = -Infinity;
            document
              .querySelectorAll('.tug-pane[data-imposed], .tug-slot-vacancy[data-vacant-slot]')
              .forEach(function (el) {
                if (el.getAttribute("data-pane-id") === "pRail") return;
                right = Math.max(right, el.getBoundingClientRect().right);
              });
            var rail = document
              .querySelector('.tug-pane[data-pane-id="pRail"]')
              .getBoundingClientRect();
            return { right: right, band: rail.left - ${RAIL_GUTTER_PX} };
          })()`,
        );
        note(
          `clamped: strip's far end at ${Math.round(clamped.right)}, band right ${Math.round(clamped.band)}`,
        );
        expect(
          Math.abs(clamped.right - clamped.band),
          "an offset past the strip's end still lands its last place on the band's edge",
        ).toBeLessThanOrEqual(TOL);

        // ── 5. The band's edge is occlusion, not a cut ──────────────────────
        // A card that straddles the band's far edge keeps painting: across the
        // rail's gutter in plain sight, and then behind the rail, which is
        // opaque and outranks every free card. **That visible crossing is the
        // point.** It is what says *there is more, behind this*, and a deck
        // that hid it would be cutting the card with paint instead of with a
        // `clip-path` — which is exactly the regression this part now pins.
        // The gutter is air the card crosses, never a leak to be covered.
        //
        // So: the gutter shows CARD, the rail's own band shows RAIL, and the
        // only capped strip is the one no rail stands in. This deck's rail is
        // flush to the right window edge, so that side is uncapped and the
        // bare left side carries a cap exactly one card gap wide.
        const ink = await app.evalJS<{
          gutterPane: string | null;
          overRailPane: string | null;
          inBand: string | null;
          rightCap: boolean;
          leftCapWidth: number | null;
          leftCapCanvas: boolean;
        }>(
          `(function () {
            // At rest the strip runs 2120px into a ~1550px band, so a card is
            // guaranteed to straddle the far edge — the reveal above parked
            // the strip on a boundary, where nothing crosses the gutter and
            // the assertion would prove nothing.
            //
            // A cap carries the canvas-background marker too, so this selector
            // can match more than one element — but document order puts the
            // container first, and the container is the one the frames inherit
            // the offset from.
            var host = document.querySelector("[data-deck-canvas-background]");
            host.style.setProperty("--tug-imposer-flow-offset", "0px");
            function paneAt(x, y) {
              var el = document.elementFromPoint(x, y);
              var pane = el && el.closest ? el.closest(".tug-pane") : null;
              return pane === null ? null : pane.getAttribute("data-pane-id");
            }
            var rail = document
              .querySelector('.tug-pane[data-pane-id="pRail"]')
              .getBoundingClientRect();
            var left = document.querySelector('[data-margin-cap="left"]');
            return {
              // The gutter's middle: clear of the rail's own edge affordance,
              // which hangs a few pixels past its frame.
              gutterPane: paneAt(rail.left - ${RAIL_GUTTER_PX} / 2, 600),
              // Well inside the rail, where the card behind it must not show.
              overRailPane: paneAt(rail.left + 40, 600),
              inBand: paneAt(rail.left - ${RAIL_GUTTER_PX} - 40, 600),
              rightCap:
                document.querySelector('[data-margin-cap="right"]') !== null,
              leftCapWidth:
                left === null ? null : left.getBoundingClientRect().width,
              leftCapCanvas:
                left !== null &&
                left.hasAttribute("data-deck-canvas-background"),
            };
          })()`,
        );
        note(
          `gutter ${String(ink.gutterPane)} | over rail ${String(ink.overRailPane)} | in band ${String(ink.inBand)} | caps right=${ink.rightCap} left=${String(ink.leftCapWidth)}`,
        );
        expect(
          ink.gutterPane,
          "a straddling card crosses the rail's gutter in plain sight",
        ).not.toBeNull();
        expect(
          ink.gutterPane,
          "and it is a card standing there, not the rail reaching in",
        ).not.toBe("pRail");
        expect(
          ink.overRailPane,
          "the rail is what paints over the card, which is the whole occlusion",
        ).toBe("pRail");
        expect(
          ink.inBand,
          "the straddling card still paints inside the band",
        ).not.toBeNull();
        expect(
          ink.rightCap,
          "a rail flush to the window leaves nothing bare, so that side is uncapped",
        ).toBe(RAIL_EDGE_INSET_PX > 0);
        expect(
          ink.leftCapWidth === null ? null : Math.round(ink.leftCapWidth),
          "the bare side is capped at exactly the band's own gap, and no wider",
        ).toBe(IMPOSITION_GAP_PX);
        expect(
          ink.leftCapCanvas,
          "and that cap carries the canvas-background marker, so a press there still deselects",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "bullseye on a scrolled strip sends every pane out the side it was on",
    async () => {
      // `bullseyeAnchorCentre` sorts the other panes around the bullseyed
      // card's own former place so that exits can never cross. That line is
      // resolved through `imposeStyle().left` — so on a flow deck it has to be
      // the FLOW left. Fed the fit anchor, the line lands somewhere the deck
      // is not showing and panes slide out through one another.
      //
      // Asserted as parked SIDE rather than by eye, and on the case that can
      // tell the two anchors apart. The bullseyed card is the LEFTMOST of a
      // scrolled strip, so its flow anchor is off the left edge and every
      // other pane is to its right — all of them must park right. Its FIT
      // anchor is a fifth of the band in from the left instead, which puts the
      // second card on the wrong side of the line: fed that, one pane parks
      // left and slides out through the card arriving at the middle.
      //
      // Direction of travel is deliberately not the assertion. A pane scrolled
      // further off-canvas than the parking place travels back toward the edge
      // to reach it, which is invisible motion between two off-screen points,
      // not a crossing.
      const app = await launchTugApp({ testName: "at0454-flow-bullseye" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);

        // Activating the card is what scrolls the strip AND what makes the
        // pane bullseye-able: the posture is derived from the first responder,
        // so a card you have not focused cannot take it. Card D leaves the
        // strip part-scrolled, which is the state where the two anchors
        // disagree about a card — at either end of the travel they happen to
        // agree, and the test would pass on the bug.
        await app.evalJS<null>(`(window.__tug.activateCard("D"), null)`);
        await wait(AFTER_LAND_MS);
        const scrolled = await flowOffset(app);
        expect(scrolled, "the strip is genuinely scrolled").toBeGreaterThan(0);

        const centre = (r: { left: number; right: number }): number =>
          (r.left + r.right) / 2;
        const before = await slotRects(app);
        const bandBox = await band(app);
        const anchorCentre = centre(
          before.find((r) => r.paneId === "p4") as (typeof before)[number],
        );

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-bullseye", { paneId: "p4" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        // The posture actually engaged. Without this the whole block is a
        // no-op that reads as a pass: nothing moves, nothing crosses.
        expect(
          await app.evalJS<string | null>(
            `(window.tugdeck.diag.getDeckState().bullseyePaneId || null)`,
          ),
          "the bullseye engaged, so there is an exit to measure",
        ).toBe("p4");
        const after = await slotRects(app);

        // The two exit bounds are far apart and unambiguous: leftward parks a
        // pane's whole frame just past the canvas's left edge, rightward just
        // past its right. So the assertion is which BOUND each pane took, not
        // how far it travelled to get there — a pane already scrolled off the
        // left edge travels rightward to reach the left bound, which is
        // invisible motion between two offscreen points rather than a
        // crossing.
        const wrongSide: string[] = [];
        for (const rect of after) {
          if (rect.paneId === "p4") continue;
          const was = before.find((r) => r.paneId === rect.paneId);
          if (was === undefined) continue;
          // Where it stood relative to where the bullseyed card stood — read
          // off painted pixels, which is the line the user's eye used.
          const expectLeft = centre(was) < anchorCentre;
          const wentLeft = rect.right <= bandBox.left;
          const wentRight = rect.left >= bandBox.right;
          if (expectLeft ? !wentLeft : !wentRight) {
            wrongSide.push(
              `${rect.paneId} stood ${expectLeft ? "left" : "right"} of the bullseyed card at ${Math.round(
                anchorCentre,
              )} but parked at ${Math.round(centre(rect))}`,
            );
          }
        }
        note(
          `bullseye in flow at offset ${scrolled}: ${
            wrongSide.length === 0
              ? "every pane left by the side it stood on"
              : wrongSide.join("; ")
          }`,
        );
        expect(
          wrongSide.join("\n"),
          "each pane leaves by the side it was already on, so none can cross the arriving card",
        ).toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Layout control drives the mode, draws it, and answers the keyboard",
    async () => {
      const app = await launchTugApp({ testName: "at0454-flow-control" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(LAYOUT_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // The row offers exactly the two modes, and rests on the one the deck
        // holds — a settled control shows what the store holds.
        expect(
          await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(LAYOUT_TILES)}))
              .map(function (el) { return el.getAttribute("data-choice-value"); })`,
          ),
          "flow first, the arrangement the row rests its reader on",
        ).toEqual(["flow", "fit"]);
        expect(await activeLayoutTile(app), "the control rests on fit").toBe("fit");

        // ── Clicking it moves the deck ──────────────────────────────────────
        await app.click(`${LAYOUT_TILES}[data-choice-value="flow"]`);
        await wait(AFTER_LAND_MS);
        expect(
          await app.evalJS<string | undefined>(
            `window.tugdeck.diag.getDeckState().imposition.layout`,
          ),
          "the click wrote the record",
        ).toBe("flow");
        expect(await activeLayoutTile(app), "and the control followed it").toBe(
          "flow",
        );

        // ── The miniature draws the mode ────────────────────────────────────
        // The committed drawing carries the mode, and an overflowing strip
        // shows the viewport window — the picture states that this
        // arrangement scrolls.
        const drawing = await app.evalJS<{ layout: string | null; windows: number }>(
          `(function () {
            var mini = document.querySelector(
              '[data-testid="layout-card-plan"] [data-plan-layer="committed"] .layout-mini',
            );
            return {
              layout: mini.getAttribute("data-layout"),
              windows: mini.querySelectorAll(".layout-mini-window").length,
            };
          })()`,
        );
        note(
          `committed miniature: layout=${drawing.layout}, windows=${drawing.windows}`,
        );
        expect(drawing.layout, "the committed drawing is the flow one").toBe(
          "flow",
        );
        expect(
          drawing.windows,
          "six wide slots overflow the drawn band, so the window shows",
        ).toBe(1);

        // The fit layer is pre-rendered and draws no window — the preview the
        // other segment would show, and the proof the window is mode-borne.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(
              '[data-plan-preview-id="layout:fit"] .layout-mini-window',
            ).length`,
          ),
          "fit tiles the band, so nothing overflows and no window is drawn",
        ).toBe(0);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-plan-preview-id="layout:flow"]').length`,
          ),
          "both modes are offerable, so both have a pre-rendered layer",
        ).toBe(1);

        // ── The row is a rung on the keyboard ladder ────────────────────────
        // A row added without a `focusOrder` is invisible to the ladder, and
        // that is a silent failure — the control still works under the mouse.
        // Walked rather than asserted structurally: Tab into the Cards row,
        // run the cursor off the end of its segments, and the group below must
        // be this one. Down inside a choice group steps its run (at0118's
        // contract), so only the last press crosses rows.
        // The keyboard has to be IN the Layout card before Tab walks it, and
        // the card already holds the first responder from the clicks above —
        // so this addresses it by id rather than through `toggle-layout`,
        // which on the focused card is the gesture that takes the rail away.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("focus-session-card", { cardId: "L" }), null)`,
        );
        await tabUntilKbd(app, KIND_GROUP);
        // Tab-into parks the cursor on the SELECTED segment, and this deck is
        // six-up — the last one in the run. So a single Down is already off
        // the end, and off the end Down means down.
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector('${KIND_GROUP} [data-key-cursor]');
            return el !== null && el.getAttribute("data-choice-value") === "six-up";
          })()`,
          { timeoutMs: 3_000 },
        );
        await app.nativeKey("ArrowDown");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-layout"][data-key-view-kbd]') !== null`,
          { timeoutMs: 3_000 },
        );
        note("the Layout row takes the ring off the end of the Cards run");

        // And the cursor lands on the standing answer, not on the run's head —
        // a settled control shows what the store holds, by keyboard too.
        expect(
          await app.evalJS<string | null>(
            `(function () {
              var el = document.querySelector(
                '[data-testid="layout-card-layout"] [data-key-cursor]',
              );
              return el === null ? null : el.getAttribute("data-choice-value");
            })()`,
          ),
          "the cursor parks on flow, which is what the deck holds",
        ).toBe("flow");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── 6. A card that arrives is revealed too ─────────────────────────────────
  //
  // The strip is parked at its far end, which leaves the slot BESIDE the
  // active card straddling the band's near edge — the arrangement a reader
  // gets whenever the band is wider than one card and narrower than two, which
  // is most of them. A file opened from that card lands in that slot, and the
  // question is whether the deck brings it in.
  //
  // The pin is the card's NEAR edge against the band's, because that is what
  // the reader lost: a card wider than the band cannot come wholly in, and the
  // reveal pins the edge reading starts at instead. A card narrower than the
  // band lands flush there too, having been slid in from the same side.
  test(
    "a card that arrives is revealed, not merely placed",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0454-"));
      const file = path.join(dir, "arrival.txt");
      fs.writeFileSync(file, "arrival\n");

      const app = await launchTugApp({ testName: "at0454-flow-mode-arrival" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({
          state: deckShape(WIDE_PANE_WIDTH),
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);

        // Park the strip at its far end by raising the last card.
        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);

        // The fixture earns its assertion: the slot the open is about to name
        // is half off the band's near edge before the open runs.
        const bandBefore = await band(app);
        const neighbor = (await slotRects(app))[SLOTS - 2];
        note(
          `before the open: slot 4 spans ${Math.round(
            neighbor.left,
          )}..${Math.round(neighbor.right)}, band starts ${Math.round(
            bandBefore.left,
          )}`,
        );
        expect(
          neighbor.left,
          "the fixture must leave the neighbouring slot straddling the band",
        ).toBeLessThan(bandBefore.left - TOL);
        expect(
          neighbor.right,
          "and still partly showing, or the open would be off-screen entirely",
        ).toBeGreaterThan(bandBefore.left + TOL);

        // Open a file from the active card. `neighborSlot` names the slot to
        // its left — the straddling one — and the arrival owes the reveal.
        const before = await textCardIds(app);
        await app.dispatchControlAction("open-file", { path: file });
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getDeckState().cards.filter(function (c) {
            return c.componentId === "text";
          }).length === ${before.length + 1}`,
          { timeoutMs: 15_000 },
        );
        const fresh = (await textCardIds(app)).filter(
          (id) => !before.includes(id),
        );
        expect(fresh, "exactly one card answered the open").toHaveLength(1);
        await wait(AFTER_LAND_MS);

        const bandAfter = await band(app);
        const arrived = await cardRect(app, fresh[0]);
        note(
          `after the open: card spans ${Math.round(arrived.left)}..${Math.round(
            arrived.right,
          )}, band ${Math.round(bandAfter.left)}..${Math.round(
            bandAfter.right,
          )}, offset ${await flowOffset(app)}`,
        );
        expect(
          arrived.left,
          "the arrived card's near edge is not under the rail",
        ).toBeGreaterThanOrEqual(bandAfter.left - TOL);
        expect(
          arrived.left,
          "and no further in than it had to come — the move is minimal",
        ).toBeLessThanOrEqual(bandAfter.left + TOL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
