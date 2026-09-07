/**
 * zz-probe-layout-miniature.test.ts — the Layout card's miniature as an instrument.
 *
 * The committed drawing is the one layer that tracks the deck: given the live
 * flow offset, the band, and each occupied slot's extent, it draws the strip
 * the deck actually stands on and puts the viewport window where the offset
 * has slid it. Preview layers — arrangements being auditioned, which the deck
 * has never stood under — keep drawing the synthetic strip at rest ([P06]).
 *
 * Both halves are asserted through scale-free identities rather than by
 * recomputing the component's arithmetic, which would only prove the test can
 * copy it:
 *
 *  1. **The blocks are in the extents' proportions.** Block widths are compared
 *     as RATIOS against the ratios of the panes' real painted widths, so the
 *     drawn gap, the band, and the fit-into-frame scale all cancel. On a deck
 *     of identical cards this would hold trivially, so the fixture is
 *     deliberately uneven — and that unevenness is asserted before it is used.
 *  2. **The window stands at the offset, in band units.** The window IS the
 *     band, so `left / width` is exactly how far along the strip the band has
 *     travelled measured in bands — which is `flowOffset / band`. Gaps and
 *     scale cancel here too.
 *
 * The two screenshots are kept as diagnostics: a drawing is the one thing a
 * numeric assertion cannot show you.
 *
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.css
 * @covers tugdeck/src/components/layout/layout-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";

import { launchTugApp, note, type App } from "./_harness";
import {
  IMPOSITION_GAP_PX,
  RAIL_GUTTER_PX,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const RAIL_WIDTH = 420;
/** Deliberately uneven, and wide enough that no stack's minimum flattens them
 *  — the drawing has nothing to say about proportions a deck does not hold. */
const PANE_WIDTHS = [720, 480, 620, 540, 500];
/** Percentages are written from floating-point arithmetic at both ends. */
const TOL = 0.02;
/** The settle window, with room for the reveal's tween to land. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Five cards of five different widths in a six-up, the Layout card on the right —
 *  a strip comfortably longer than the band on any window this harness opens. */
function deckShape(): Record<string, unknown> {
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
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: PANE_WIDTHS[index], height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
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

/** One drawing's parts, read from the inline percentages the component wrote.
 *  Read from `style` rather than from measured boxes so a hidden preview layer
 *  — which paints nothing — answers the same question the committed layer does. */
interface Drawing {
  blocks: number[];
  windowLeft: number | null;
  windowWidth: number | null;
}

async function drawing(app: App, selector: string): Promise<Drawing> {
  return app.evalJS<Drawing>(
    `(function () {
      var layer = document.querySelector(${JSON.stringify(selector)});
      if (layer === null) return null;
      var pct = function (value) { return parseFloat(value); };
      var win = layer.querySelector(".layout-mini-window");
      return {
        blocks: Array.prototype.map.call(
          layer.querySelectorAll(".layout-mini-block"),
          function (el) { return pct(el.style.width); },
        ),
        windowLeft: win === null ? null : pct(win.style.left),
        windowWidth: win === null ? null : pct(win.style.width),
      };
    })()`,
  );
}

/** Every imposed pane's painted width, in slot order — the extents the strip
 *  is built from, read off the pixels the deck actually drew. */
async function paintedWidths(app: App): Promise<number[]> {
  return app.evalJS<number[]>(
    `(function () {
      var state = window.tugdeck.diag.getDeckState();
      var out = [];
      state.panes.forEach(function (pane) {
        if (pane.slot === undefined) return;
        var el = document.querySelector('.tug-pane[data-pane-id="' + pane.id + '"]');
        if (el === null) return;
        out.push({ slot: pane.slot, width: el.getBoundingClientRect().width });
      });
      out.sort(function (a, b) { return a.slot - b.slot; });
      return out.map(function (entry) { return entry.width; });
    })()`,
  );
}

/**
 * The band's width in viewport pixels — what the strip is seen through.
 *
 * Measured off the rail's own painted frame rather than off the
 * `--tug-imposer-inset-*` properties, which resolve to a `calc()` that
 * `parseFloat` reads as NaN. The band begins one card gap in from the canvas
 * edge and ends one rail gutter short of the rail's near edge, which is the
 * arithmetic `resolveSpan` does — read here from pixels instead.
 */
async function bandWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var box = document
        .querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      var rail = document
        .querySelector('.tug-pane[data-pane-id="pRail"]')
        .getBoundingClientRect();
      return (rail.left - ${RAIL_GUTTER_PX}) - (box.left + ${IMPOSITION_GAP_PX});
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("zz probe — layout miniature", () => {
  test(
    "the committed drawing tracks the strip and the offset; previews stay at rest",
    async () => {
      const app = await launchTugApp({ testName: "zz-probe-layout-miniature" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-plan"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await app.evalJS(
          `document.querySelector('[data-testid="layout-card-section"]')
             .scrollIntoView({ block: "center" })`,
        );
        await wait(AFTER_LAND_MS);

        // ── The fixture earns its assertions ────────────────────────────────
        // Uneven extents, and a live offset: on a deck of identical cards at
        // rest every assertion below would hold of the at-rest drawing too.
        const widths = await paintedWidths(app);
        note(`painted widths: ${widths.map(Math.round).join(", ")}`);
        expect(widths.length, "every seeded card stands").toBe(
          PANE_WIDTHS.length,
        );
        expect(
          new Set(widths.map(Math.round)).size,
          "the fixture must be a deck of UNEQUAL cards",
        ).toBeGreaterThan(1);

        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);
        const offset = await app.evalJS<number>(
          `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
        );
        const band = await bandWidth(app);
        note(`offset ${Math.round(offset)}px over a ${Math.round(band)}px band`);
        expect(
          offset,
          "revealing the last card must have moved the strip",
        ).toBeGreaterThan(0);

        // ── 1. The committed blocks are in the extents' proportions ─────────
        const committed = await drawing(
          app,
          '[data-plan-layer="committed"] .layout-mini',
        );
        note(
          `committed blocks: ${committed.blocks
            .map((b) => b.toFixed(2))
            .join(", ")}`,
        );
        // Every slot of the kind holds its place in the strip, occupied or
        // not — the sixth block here is six-up's empty slot, drawn as the
        // placeholder the real strip carries for it. The occupied blocks are
        // the first five, in slot order, and their proportions are the claim.
        expect(committed.blocks.length).toBe(6);
        // Each block is its card at one scale, LESS the seam it gives up off
        // its own right edge — a constant, because the deck's real gap is a
        // fraction of a pixel here and a drawing that added the seam BETWEEN
        // the blocks instead would measure a strip longer than the deck's.
        //
        // So the claim is that one line fits all five: recover the scale from
        // the first two blocks, and every remaining block must give back the
        // same seam. That is stronger than the ratio it replaces — a drawing
        // that flattened the extents would satisfy no line at all — and it
        // pins the seam's existence too, which is the half that regressed
        // when the real positions first landed.
        const scale =
          (committed.blocks[0] - committed.blocks[1]) / (widths[0] - widths[1]);
        const seamAt = (i: number): number => scale * widths[i] - committed.blocks[i];
        const seam = seamAt(0);
        note(`recovered seam: ${seam.toFixed(2)}% of the field`);
        expect(seam, "the blocks are drawn apart, not butted together").toBeGreaterThan(1);
        for (let i = 1; i < widths.length; i += 1) {
          expect(
            seamAt(i),
            `block ${i} is drawn at slot ${i}'s own extent, one seam in`,
          ).toBeCloseTo(seam, 1);
        }

        // ── 2. The window stands at the offset, measured in bands ──────────
        expect(committed.windowLeft, "the strip overflows, so there is a window")
          .not.toBeNull();
        const left = committed.windowLeft as number;
        const width = committed.windowWidth as number;
        note(`window left ${left.toFixed(2)}% of width ${width.toFixed(2)}%`);
        expect(
          left / width,
          "the window has travelled the offset, in band units",
        ).toBeCloseTo(offset / band, 2);

        const shot = await app.screenshot();
        copyFileSync(shot.path, "/tmp/mini-committed.png");

        // ── 3. A preview under the same state draws at rest ─────────────────
        // Same deck, same mode, one axis changed: an arrangement nobody has
        // committed has no offset to track and no extents to measure.
        const preview = await drawing(
          app,
          '[data-plan-preview-id="width:wide"] .layout-mini',
        );
        note(
          `preview blocks: ${preview.blocks.map((b) => b.toFixed(2)).join(", ")}`,
        );
        expect(
          new Set(preview.blocks.map((b) => b.toFixed(2))).size,
          "a preview draws every card at one preset width",
        ).toBe(1);
        expect(preview.windowLeft, "a preview's window is flush left").toBe(0);
        expect(
          Math.abs(left),
          "the committed window is NOT flush left — the two layers differ",
        ).toBeGreaterThan(TOL);

        // Raise the layer for the second shot the one way it can be raised:
        // the KEYBOARD cursor standing on the segment. A pointer auditions
        // nothing — it travels across controls on its way to the one it means,
        // and the drawing does not answer travel.
        await app.dispatchControlAction("toggle-layout");
        await wait(300);
        for (let i = 0; i < 24; i += 1) {
          const on = await app.evalJS<boolean>(
            `document.querySelector('[data-testid="layout-card-width"][data-key-view-kbd]') !== null`,
          );
          if (on) break;
          await app.nativeKey("Tab");
          await wait(200);
        }
        for (let i = 0; i < 8; i += 1) {
          const on = await app.evalJS<boolean>(
            `document.querySelector('[data-testid="layout-card-width"] [data-key-cursor][data-choice-value="wide"]') !== null`,
          );
          if (on) break;
          await app.nativeKey("ArrowRight");
          await wait(150);
        }
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-plan"]')
             .hasAttribute("data-previewing")`,
          { timeoutMs: 4_000 },
        );
        const previewShot = await app.screenshot();
        copyFileSync(previewShot.path, "/tmp/mini-preview.png");
      } finally {
        await app.close();
      }
    },
    120_000,
  );

  test(
    "the committed drawing animates to its new place; previews swap crisp",
    async () => {
      const app = await launchTugApp({ testName: "zz-probe-layout-miniature" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-plan"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // What is animated is asserted from the rule, never from a value read
        // while it is in flight — a mid-transition read is an interpolation,
        // and asserting one would pin the clock rather than the choreography.
        const rule = await app.evalJS<{
          property: string;
          duration: string;
          previewDuration: string;
        }>(
          `(function () {
             var style = getComputedStyle(
               document.querySelector(
                 '[data-plan-layer="committed"] .layout-mini-window',
               ),
             );
             var preview = getComputedStyle(
               document.querySelector(
                 '[data-plan-preview-id="width:wide"] .layout-mini-block',
               ),
             );
             return {
               property: style.transitionProperty,
               duration: style.transitionDuration,
               previewDuration: preview.transitionDuration,
             };
           })()`,
        );
        note(`committed transition: ${rule.property} over ${rule.duration}`);
        for (const pin of ["left", "width", "top", "bottom"]) {
          expect(
            rule.property,
            `the committed drawing animates ${pin}`,
          ).toContain(pin);
        }
        expect(
          rule.duration,
          "the committed drawing has a duration to animate over",
        ).not.toBe("0s");
        expect(
          rule.previewDuration,
          "an audition swap is crisp — a preview carries no transition",
        ).toBe("0s");

        // The END position moved: activating an off-band card slides the strip,
        // and the window follows it to a place it was not standing before.
        const at = async (): Promise<number> =>
          (await drawing(app, '[data-plan-layer="committed"] .layout-mini'))
            .windowLeft as number;
        const before = await at();
        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);
        const after = await at();
        note(`window ${before.toFixed(2)}% → ${after.toFixed(2)}%`);
        expect(before, "the deck is seeded at rest").toBeCloseTo(0, 2);
        expect(
          after - before,
          "revealing an off-band card moved the window's end position",
        ).toBeGreaterThan(TOL);
      } finally {
        await app.close();
      }
    },
    120_000,
  );
});
