/**
 * at0359-sidebar-stack.test.ts — two sidebar cards on one side are a stack by
 * default.
 *
 * The deck ships with both sidebars defaulting to the right, so "what happens
 * when the Layout card and Jots share a side" is the out-of-the-box picture rather than
 * a corner case. The answer is the one the deck already gives for two panes
 * sharing a slot: they stand **front-to-back**, same pin and same full height,
 * and z-order decides which you see.
 *
 * That is the DEFAULT, and this test is what pins it as one. The user may split
 * a side instead ([D134], `at0401`) — the picker's Split Vertically row below
 * the member rows is that door, and it is asserted here as part of the resting
 * picture. What must not drift is what a rail does when nobody has asked for
 * anything: an automatic split spent a rail to show two half-cards, which is
 * the arrangement lifting Jots out of the rail existed to escape.
 *
 * What that claim decomposes into, and what this test asserts:
 *
 *  1. **Same geometry.** Both frames occupy the same rect: same left edge, same
 *     width, same top, same bottom. Not "similar" — the same, to the pixel,
 *     because the pin is one expression and neither member varies a term of it.
 *  2. **The full run, each.** That shared rect is as tall as a lone rail's — the
 *     card behind is not paying for the card in front.
 *  3. **A stack badge, and it reaches the card behind.** Both panes render the
 *     title bar's stack badge reading 2 — the same control a slot's stack gets
 *     ([AT0347]) — and choosing the other row raises it. Raising is what makes
 *     the arrangement usable at all: with identical rects, the badge is the ONLY
 *     way to the card underneath.
 *
 * Read from `getBoundingClientRect` rather than from the style expressions,
 * because what is being claimed is about the picture the browser paints, and
 * `imposeSidebarStyle` writes `calc()` over custom properties that only the
 * browser resolves.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/serialization.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// The Layout card's own body: it renders only while its pane stands, and it
// is the address that survives a hide/show cycle, which mints a new pane.
const LAYOUT_PANE = '.layouts-section';
const JOTS_CARD = '[data-card-id] .jots-card';
const STACK_BADGE = '[data-testid="tug-pane-title-bar-stack-badge"]';
const STACK_MENU = '[data-testid="tug-pane-title-bar-stack-menu"]';


/**
 * True when the Jots card is the front member of the rail.
 *
 * Decided by `z-index`, which is where the deck expresses stacking: the canvas
 * renders panes in a stable id-sorted DOM order precisely so that raising one
 * changes only its z-index and never re-parents a frame, so DOM order says
 * nothing about what you can see.
 */
/**
 * The pane id of whichever rail member is in FRONT.
 *
 * A pointer gesture aimed at this rail has to name it: the badge now stands on
 * every pane holding a place, a lone content pane included, so an unscoped
 * `[data-testid]` resolves to whatever the deck happens to render first — and
 * the two rail members share one rect, so only the front one is clickable
 * anyway.
 */
const FRONT_RAIL_PANE_ID_JS = `(function () {
  var rail = Array.from(document.querySelectorAll(".tug-pane")).filter(function (p) {
    return p.querySelector(".jots-card") !== null || p.querySelector(".layouts-section") !== null;
  });
  if (rail.length === 0) return null;
  var zOf = function (el) {
    var z = parseInt(window.getComputedStyle(el).zIndex, 10);
    return Number.isNaN(z) ? 0 : z;
  };
  var front = rail.slice().sort(function (a, b) { return zOf(a) - zOf(b); }).pop();
  return front.getAttribute("data-pane-id");
})()`;

const FRONT_IS_JOTS_JS = `(function () {
  var rail = Array.from(document.querySelectorAll(".tug-pane")).filter(function (p) {
    return p.querySelector(".jots-card") !== null || p.querySelector(".layouts-section") !== null;
  });
  if (rail.length < 2) return false;
  var zOf = function (el) {
    var z = parseInt(window.getComputedStyle(el).zIndex, 10);
    return Number.isNaN(z) ? 0 : z;
  };
  var front = rail.slice().sort(function (a, b) { return zOf(a) - zOf(b); }).pop();
  return front.querySelector(".jots-card") !== null;
})()`;

/** Each rail member's card and z-index, for a failure to be read from. */
const RAIL_Z_JS = `Array.from(document.querySelectorAll(".tug-pane")).filter(function (p) {
  return p.querySelector(".jots-card") !== null || p.querySelector(".layouts-section") !== null;
}).map(function (p) {
  var kind = p.querySelector(".jots-card") !== null ? "jots" : "layout";
  return kind + "=" + window.getComputedStyle(p).zIndex;
}).join(" ")`;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** The rect of the pane hosting a card matching `selector`. */
const PANE_RECT_JS = (selector: string): string => `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  var pane = el === null ? null : el.closest(".tug-pane");
  if (pane === null) return null;
  var r = pane.getBoundingClientRect();
  return {
    left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    width: Math.round(r.width), height: Math.round(r.height),
  };
})()`;

async function paneRect(app: App, selector: string): Promise<Rect | null> {
  return app.evalJS<Rect | null>(PANE_RECT_JS(selector));
}

describe.skipIf(!SHOULD_RUN)(
  "at0359 — same-side sidebars stand front-to-back",
  () => {
    test(
      "the Layout card and Jots share one rail, at one rect, reachable by the stack badge",
      async () => {
        const app = await launchTugApp({ testName: "at0359-sidebar-stack" });
        try {
          // A content card for the rail to stand beside, then the Layout card. Opened
          // by its own toggle rather than left to the factory default, so this
          // test asserts the stack and not the stand-up (at0276 owns that).
          await app.dispatchControlAction("show-component-gallery");
          await app.dispatchControlAction("toggle-layout");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LAYOUT_PANE)}) !== null`,
            { timeoutMs: 10_000 },
          );
          const layoutAlone = await paneRect(app, ".layouts-section");
          expect(layoutAlone).not.toBeNull();

          // ── Jots joins it. Both default to the right, so this is the stack. ──
          await app.dispatchControlAction("toggle-jots");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(JOTS_CARD)}) !== null`,
            { timeoutMs: 10_000 },
          );

          const layout = await paneRect(app, ".layouts-section");
          const jots = await paneRect(app, JOTS_CARD);
          expect(layout).not.toBeNull();
          expect(jots).not.toBeNull();
          note(
            "rail rects",
            `layout=${JSON.stringify(layout)} jots=${JSON.stringify(jots)}`,
          );

          // 1. The same rect, not merely the same side.
          expect(jots, "the two members occupy one rail").toEqual(layout as Rect);

          // 2. The full run each — the rail did not divide to make room.
          expect(
            layout!.height,
            "the rail is as tall as it was before the second card joined",
          ).toBe(layoutAlone!.height);

          // 2b. One flush panel. A stacked rail has no seams, so its members
          // draw no rule at the window's top or foot — a hairline marks a
          // boundary with something else, and the only one here is the inner
          // edge at the gutter.
          const rules = await app.evalJS<Record<string, Record<string, number>>>(
            `(function () {
              var out = {};
              document.querySelectorAll('.tug-pane[data-rail-side="right"]').forEach(function (el) {
                var cs = getComputedStyle(el.querySelector(".tug-pane-chrome"));
                out[el.getAttribute("data-pane-id")] = {
                  top: parseFloat(cs.borderTopWidth),
                  right: parseFloat(cs.borderRightWidth),
                  bottom: parseFloat(cs.borderBottomWidth),
                  left: parseFloat(cs.borderLeftWidth),
                };
              });
              return out;
            })()`,
          );
          note("stacked hairlines", JSON.stringify(rules));
          expect(Object.keys(rules), "both members are pinned right").toHaveLength(2);
          for (const [paneId, rule] of Object.entries(rules)) {
            expect(rule.top, `${paneId} draws no rule at the window's top`).toBe(0);
            expect(rule.bottom, `${paneId} draws no rule at the window's foot`).toBe(0);
            expect(rule.right, `${paneId} draws no rule at the window's edge`).toBe(0);
            expect(rule.left, `${paneId} draws its inner-edge rule at the gutter`).toBe(1);
          }

          // 3. The badge, on both, reading the stack's depth.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(STACK_BADGE)}).length >= 1`,
            { timeoutMs: 8_000 },
          );
          // Scoped to the RAIL's two members, not to the document. The badge
          // now stands on every pane holding a place, a lone content pane
          // included — it just reads `1` there — so an unscoped sweep collects
          // the deck's panes as well and the depth claim below is no longer
          // about this rail.
          const badges = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(".tug-pane"))
              .filter(function (p) {
                return p.querySelector(".jots-card") !== null
                  || p.querySelector(".layouts-section") !== null;
              })
              .map(function (p) { return p.querySelector(${JSON.stringify(STACK_BADGE)}); })
              .filter(function (el) { return el !== null; })
              .map(function (el) { return (el.textContent || "").trim(); })`,
          );
          note("stack badges", badges.join(" · "));
          expect(
            badges.length,
            "every member of the rail carries the badge — a covered pane hides it along with everything else",
          ).toBeGreaterThanOrEqual(1);
          for (const text of badges) expect(text).toBe("2");

          // Which card is in FRONT. Read off z-order rather than off DOM order:
          // the canvas renders panes in a stable, id-sorted order and expresses
          // the stack as `z-index`, so "the first pane in the DOM" and "the one
          // you can see" are different questions — and with two identical rects
          // only the second one means anything.
          const frontIsJots = await app.evalJS<boolean>(FRONT_IS_JOTS_JS);
          note("rail z-order before", await app.evalJS<string>(RAIL_Z_JS));

          // Opening the picker and choosing the OTHER row raises it. With two
          // identical rects this is the only way to the card underneath, which
          // is why it is the assertion that matters most here.
          const frontPaneId = await app.evalJS<string | null>(
            FRONT_RAIL_PANE_ID_JS,
          );
          expect(frontPaneId, "the rail has a front member to press").not.toBe(
            null,
          );
          await app.nativeClickAtElement(
            `.tug-pane[data-pane-id="${frontPaneId}"] ${STACK_BADGE}`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(STACK_MENU)}) !== null`,
            { timeoutMs: 8_000 },
          );
          const rows = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(STACK_MENU)} + ' [role="menuitem"], ' + ${JSON.stringify(STACK_MENU)} + ' [role="menuitemradio"]'))
              .map(function (el) { return (el.textContent || "").trim(); })`,
          );
          note("picker rows", rows.join(" · "));
          expect(
            rows.some((r) => r.includes("Layout")) &&
              rows.some((r) => r.includes("Jots")),
            "the rows name the two cards",
          ).toBe(true);
          // The two members, and one verb BELOW them: on a rail the badge is
          // also the door to the arrangement, and from a stack the offer is to
          // split ([D134]). A slot's stack has no such verb — see at0347.
          // Which member leads is z-order's business and is asserted above; what
          // this pins is that the verb is one row, and the last one.
          expect(rows.length, "two members and one verb").toBe(3);
          expect(rows[rows.length - 1], "the verb sits below the members").toBe(
            "Split Vertically",
          );

          // Choose the one that is NOT in front, and it comes forward.
          const wanted = frontIsJots ? "Layout" : "Jots";
          await app.evalJS<null>(
            `(function () {
              var rows = Array.from(document.querySelectorAll(${JSON.stringify(STACK_MENU)} + ' [role="menuitem"], ' + ${JSON.stringify(STACK_MENU)} + ' [role="menuitemradio"]'));
              var row = rows.filter(function (el) {
                return (el.textContent || "").indexOf(${JSON.stringify(wanted)}) !== -1;
              })[0];
              if (row) row.click();
              return null;
            })()`,
          );
          await new Promise<void>((r) => setTimeout(r, 600));
          note("rail z-order after", await app.evalJS<string>(RAIL_Z_JS));
          await app.waitForCondition<boolean>(
            `(${FRONT_IS_JOTS_JS}) === ${wanted === "Jots" ? "true" : "false"}`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<boolean>(FRONT_IS_JOTS_JS),
            `choosing ${wanted} in the picker brought it to the front of the rail`,
          ).toBe(wanted === "Jots");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
