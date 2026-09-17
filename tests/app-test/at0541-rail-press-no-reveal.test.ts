/**
 * at0541-rail-press-no-reveal.test.ts — a press on a clipped rail member
 * moves nothing.
 *
 * An activation reveals: raising a member of an overflowing rail slides the
 * rail's strip by the least that shows it. The POINTER's activation is the
 * exception. The hand is already on the card it named, and a strip that slid
 * under the press would carry the title bar out from under a mouse that is
 * still holding it — which is the one thing a press must never do. So the
 * pointer path passes `reveal: false` to `activateCard`, and the strip stays
 * where it stood for as long as the hand holds. A release that travelled
 * nowhere is a click, and a click's ending is when the card may come fully
 * in — so the release reveals, and a card merely clicked still arrives. It
 * arrives by CROSSING: the reveal commits while the frame still wears
 * `data-gesture`, and the settle must not take that as "skip me" — it reads
 * `data-pointer-owned`, which a press that never travelled never wrote.
 *
 * Five members on the right rail put its floors past the run, which is what
 * puts the rail under the overflow rule — a sidebar card's floor is 240px and
 * this harness's canvas is a little over 1000px tall, so it takes five before
 * they stop fitting ([P01]). Past it each member stands at its own floor and
 * the strip runs off the window's foot, so the members at the bottom of it
 * stand clipped at rest.
 *
 * The second test is the same law one level in. A press must not move the
 * card's CONTENT either, and the panel livery used to move it: the rules that
 * zero a pinned rail's top, bottom and outer borders were keyed on
 * `data-gesture`, which goes on at the press, so touching a title bar handed
 * the frame a 1px hairline on every edge under a border-box chrome and put
 * everything in the card a pixel down. The carry is `data-gesture="true"` AND
 * `data-pointer-owned` together, and a press that never travels writes only
 * the first.
 *
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/gesture-interpreter.ts
 * @covers tugdeck/src/lib/press-travel.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const AFTER_LAND_MS = 900;
const EPSILON = 1;
/* A hairline coming and going is a whole pixel, so "did not move" is measured
   against nothing rather than against a tolerance that would swallow it. */
const SUBPIXEL = 0.01;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const PANES: Record<string, string> = {
  layout: "pLayout",
  jots: "pJots",
  overview: "pOverview",
  cards: "pCards",
  dashes: "pDashes",
};
const frame = (paneId: string): string => `.tug-pane[data-pane-id="${paneId}"]`;

function deckShape(): Record<string, unknown> {
  const rail = (componentId: string) => ({
    id: PANES[componentId],
    position: { x: 0, y: 0 },
    size: { width: 400, height: 900 },
    cardIds: [componentId.toUpperCase()],
    activeCardId: componentId.toUpperCase(),
    title: componentId,
    acceptsFamilies: [],
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "LAYOUT", componentId: "layout", title: "Layout", closable: true },
      { id: "JOTS", componentId: "jots", title: "Jots", closable: true },
      { id: "OVERVIEW", componentId: "overview", title: "Overview", closable: true },
      { id: "CARDS", componentId: "cards", title: "Cards", closable: true },
      { id: "DASHES", componentId: "dashes", title: "Arcs", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 400, height: 400 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
      rail("layout"),
      rail("jots"),
      rail("overview"),
      rail("cards"),
      rail("dashes"),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: {
        layout: { side: "right" },
        jots: { side: "right" },
        overview: { side: "right" },
        cards: { side: "right" },
        dashes: { side: "right" },
      },
      rails: {
        right: {
          mode: "split",
          order: ["layout", "jots", "overview", "cards", "dashes"],
        },
      },
    },
    hasFocus: true,
  };
}

async function railOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `((window.tugdeck.diag.getDeckState().railOffsets || {}).right || 0)`,
  );
}

async function top(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('${frame(paneId)}').getBoundingClientRect().top`,
  );
}

/** The chrome's four border widths, as the browser resolves them. */
async function chromeBorders(app: App, paneId: string): Promise<number[]> {
  return app.evalJS<number[]>(
    `(function () {
      var s = getComputedStyle(
        document.querySelector('${frame(paneId)} .tug-pane-chrome'),
      );
      return [
        parseFloat(s.borderTopWidth),
        parseFloat(s.borderRightWidth),
        parseFloat(s.borderBottomWidth),
        parseFloat(s.borderLeftWidth),
      ];
    })()`,
  );
}

/** Where the card's own content starts, inside the chrome's borders. */
async function barOrigin(app: App, paneId: string): Promise<{ x: number; y: number }> {
  return app.evalJS<{ x: number; y: number }>(
    `(function () {
      var r = document
        .querySelector('${frame(paneId)} .tug-pane-title-bar')
        .getBoundingClientRect();
      return { x: r.left, y: r.top };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0541 — a press on a clipped rail member moves nothing", () => {
  test(
    "the strip stays put under the press, and the click's release brings the member in",
    async () => {
      const app = await launchTugApp({ testName: "at0541-rail-press-no-reveal" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 5`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const order = await app.evalJS<string[]>(
          `((window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}).order || []`,
        );
        const vh = await app.evalJS<number>("window.innerHeight");
        // The clipped member a pointer can actually press: the lowest one whose
        // title bar is still inside the window while its foot hangs past it.
        // WHICH member that is follows from the members' own heights now rather
        // than from a constant, so it is read off the live frames — the deck's
        // answer to the same question the pointer would ask.
        const lastPane = await app.evalJS<string>(
          `(function () {
            var frames = Array.prototype.slice.call(
              document.querySelectorAll('.tug-pane[data-rail-side="right"]'),
            );
            var pressable = frames.filter(function (el) {
              var r = el.getBoundingClientRect();
              return r.top + 40 < window.innerHeight && r.bottom > window.innerHeight;
            });
            return pressable[pressable.length - 1].getAttribute("data-pane-id");
          })()`,
        );
        expect(
          order.indexOf(
            Object.keys(PANES).find((c) => PANES[c] === lastPane) as string,
          ),
          "the pressable clipped member is one the rail's own order knows",
        ).toBeGreaterThan(0);
        const restTop = await top(app, lastPane);
        const restOffset = await railOffset(app);
        note(`rail order ${JSON.stringify(order)}; pressing ${lastPane}, top ${restTop.toFixed(1)} of ${vh}, offset ${restOffset}`);
        expect(restOffset, "the strip starts at rest").toBe(0);
        expect(restTop, "the last member is clipped past the foot at rest").toBeGreaterThan(vh * 0.6);

        // ── The press. ──
        const bar = await app.getElementBounds(`${frame(lastPane)} .tug-pane-title-bar`);
        const pt = { x: Math.round(bar.x + 40), y: Math.round(bar.y + bar.height / 2) };
        await app.nativeMouseDown(pt);
        await wait(AFTER_LAND_MS);
        const heldTop = await top(app, lastPane);
        const heldOffset = await railOffset(app);
        note(`pressed at ${pt.x},${pt.y}: top ${heldTop.toFixed(1)}, offset ${heldOffset}`);
        expect(
          await app.evalJS<string | undefined>(`window.tugdeck.diag.getDeckState().activePaneId`),
          "the press activated the member",
        ).toBe(lastPane);
        expect(heldOffset, "and slid nothing").toBe(0);
        expect(Math.abs(heldTop - restTop), "the title bar is where the mouse pressed it").toBeLessThanOrEqual(EPSILON);
        // Sample the frame across the release so a cut and a crossing can be
        // told apart — both land in the same place.
        await app.evalJS<boolean>(`(() => {
          window.__tops = [];
          const el = document.querySelector('${frame(lastPane)}');
          document.addEventListener('pointerup', () => {
            const t0 = performance.now();
            const tick = () => {
              window.__tops.push(el.getBoundingClientRect().top);
              if (performance.now() - t0 < 500) requestAnimationFrame(tick);
            };
            window.__tops.push(el.getBoundingClientRect().top);
            requestAnimationFrame(tick);
          }, { capture: true, once: true });
          return true;
        })()`);
        await app.nativeMouseUp(pt);
        await wait(AFTER_LAND_MS);
        // ── The release of a click is when the card comes in. ──
        const clickedOffset = await railOffset(app);
        const clickedTop = await top(app, lastPane);
        note(`released without travel: offset ${clickedOffset.toFixed(1)}, top ${clickedTop.toFixed(1)}`);
        expect(clickedOffset, "the click's release reveals the member").toBeGreaterThan(0);
        expect(clickedTop, "which brings it up the run").toBeLessThan(restTop - EPSILON);
        const clickedBottom = await app.evalJS<number>(
          `document.querySelector('${frame(lastPane)}').getBoundingClientRect().bottom`,
        );
        expect(clickedBottom, "fully in: its foot is inside the window").toBeLessThanOrEqual(vh + EPSILON);
        // ── And it crossed rather than cut. ──
        const tops = await app.evalJS<number[]>(`window.__tops`);
        const between = tops.filter((t) => t < restTop - EPSILON && t > clickedTop + EPSILON);
        note(`release sampled ${tops.length} frames; ${between.length} strictly between rest and landed`);
        expect(between.length, "the member travelled through intermediate positions").toBeGreaterThanOrEqual(3);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a press on a seated member's title bar leaves the panel's frame alone",
    async () => {
      const app = await launchTugApp({ testName: "at0541-rail-press-livery" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 5`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // The rail's FIRST member: fully seated, not the last, so at rest it
        // wears the panel's whole rule set — no top rule, the inner edge's
        // hairline on its left, and the seam's hairline at its foot.
        const paneId = PANES.layout as string;
        const restBorders = await chromeBorders(app, paneId);
        const restOrigin = await barOrigin(app, paneId);
        note(`at rest: borders ${JSON.stringify(restBorders)}, bar origin ${restOrigin.x.toFixed(1)},${restOrigin.y.toFixed(1)}`);
        expect(restBorders[0], "a panel draws no top rule").toBe(0);

        const bar = await app.getElementBounds(`${frame(paneId)} .tug-pane-title-bar`);
        const pt = { x: Math.round(bar.x + 40), y: Math.round(bar.y + bar.height / 2) };
        await app.nativeMouseDown(pt);
        await wait(AFTER_LAND_MS);
        const heldBorders = await chromeBorders(app, paneId);
        const heldOrigin = await barOrigin(app, paneId);
        note(`held: borders ${JSON.stringify(heldBorders)}, bar origin ${heldOrigin.x.toFixed(1)},${heldOrigin.y.toFixed(1)}`);
        expect(
          await app.evalJS<string | null>(
            `document.querySelector('${frame(paneId)}').getAttribute('data-gesture')`,
          ),
          "the press is a gesture the frame knows about",
        ).toBe("true");
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${frame(paneId)}').hasAttribute('data-pointer-owned')`,
          ),
          "but one that never latched",
        ).toBe(false);
        expect(heldBorders, "so the panel keeps its borders under the hand").toEqual(restBorders);
        expect(Math.abs(heldOrigin.y - restOrigin.y), "and nothing in the card moved down").toBeLessThanOrEqual(SUBPIXEL);
        expect(Math.abs(heldOrigin.x - restOrigin.x), "or in").toBeLessThanOrEqual(SUBPIXEL);

        await app.nativeMouseUp(pt);
        await wait(AFTER_LAND_MS);
        const doneBorders = await chromeBorders(app, paneId);
        const doneOrigin = await barOrigin(app, paneId);
        note(`released: borders ${JSON.stringify(doneBorders)}, bar origin ${doneOrigin.x.toFixed(1)},${doneOrigin.y.toFixed(1)}`);
        expect(doneBorders, "and the release changes nothing either").toEqual(restBorders);
        expect(Math.abs(doneOrigin.y - restOrigin.y), "the card is where it was").toBeLessThanOrEqual(SUBPIXEL);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
