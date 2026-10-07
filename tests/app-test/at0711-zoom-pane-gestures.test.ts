/**
 * at0711-zoom-pane-gestures.test.ts — under View › Zoom a pane goes where the
 * hand takes it: a drag, a resize and an Option-snap read the pointer in
 * viewport px and land in the deck's layout px, at 50 %, 100 % and 200 %.
 *
 * | Test                 | What would break without it                        |
 * |----------------------|----------------------------------------------------|
 * | drag lands at N / f  | a pointer delta added raw to a layout position, so |
 * |                      | a pane at 50 % runs half as far as the hand        |
 * | resize grows N / f   | the same, on an edge                               |
 * | snap abuts exactly   | snap targets measured from rects and compared with |
 * |                      | a layout frame, so the snap lands off the edge     |
 *
 * The deck root is `transform: scale(f)`, so N viewport px of pointer travel
 * is N / f layout px of pane travel, and the pane's on-screen rect moves the
 * full N — it stays under the hand. Each reading is the pane's STORED frame
 * (`getPaneRecord`), which is what a drop commits.
 *
 * @covers tugdeck/src/components/chrome/snap-guides.ts
 * @covers tugdeck/src/lib/page-zoom-store.ts
 *
 * Not `tug-pane.tsx`, though the gestures run there: that module's fan-out is
 * ratcheted, and what this file guards is the conversion — the store's factor
 * and the snap targets — rather than anything else the pane frame stamps.
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const FACTORS = [1, 0.5, 2] as const;

/** Two free panes side by side, with a 60 layout-px gap. Both fit the root's
 *  layout box at 200 %, the smallest it gets (about 830 × 525). */
const A = { x: 40, y: 40, width: 360, height: 260 };
const B = { x: 460, y: 40, width: 340, height: 260 };

/** Pointer travel for the plain drag and the resize, viewport px. */
const DRAG = { dx: 60, dy: 40 };
const RESIZE_DX = 40;

/** The gap an adjacent-edge snap leaves (`IMPOSITION_GAP_PX`, `layout-imposer.ts`). */
const IMPOSITION_GAP_PX = 5;

function deckShape(): Record<string, unknown> {
  const pane = (id: string, card: string, f: typeof A) => ({
    id,
    position: { x: f.x, y: f.y },
    size: { width: f.width, height: f.height },
    cardIds: [card],
    activeCardId: card,
    title: "",
    acceptsFamilies: ["maker"],
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [pane("pA", "A", A), pane("pB", "B", B)],
    activePaneId: "pA",
    hasFocus: true,
  };
}

const FRAME = (id: string) => `.tug-pane[data-pane-id="${id}"]`;
const GRAB = `${FRAME("pA")} .tug-pane-title-bar .tug-pane-grab-handle`;
const RESIZE_E = `${FRAME("pA")} .tug-pane-resize-e`;

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

function record(app: App, paneId: string): Promise<Frame> {
  return app.evalJS<Frame>(`(function () {
  var p = window.__tug.getPaneRecord(${JSON.stringify(paneId)});
  return { x: p.position.x, y: p.position.y, width: p.size.width, height: p.size.height };
})()`);
}

function centre(app: App, selector: string): Promise<{ x: number; y: number }> {
  return app.evalJS<{ x: number; y: number }>(`(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) throw new Error("not found: " + ${JSON.stringify(selector)});
  var r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
}

async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );
  const a = await record(app, "pA");
  expect(a, "pane A seeded where it was put").toEqual(A);
}

/** Wait until `paneId`'s stored frame differs from `before`. */
async function changed(app: App, paneId: string, before: Frame): Promise<Frame> {
  await app.waitForCondition<boolean>(
    `(function () {
      var p = window.__tug.getPaneRecord(${JSON.stringify(paneId)});
      return p.position.x !== ${before.x} || p.position.y !== ${before.y} ||
        p.size.width !== ${before.width} || p.size.height !== ${before.height};
    })()`,
    { timeoutMs: 5_000 },
  );
  return record(app, paneId);
}

describe.skipIf(!SHOULD_RUN)("AT0711: pane gestures land in layout px under a zoom", () => {
  test(
    "a drag, a resize and an Option-snap at 50 %, 100 % and 200 %",
    async () => {
      const app = await launchTugApp({ testName: "at0711-zoom-pane-gestures" });
      const readings: Record<string, unknown> = {};
      try {
        await app.enableDeckTrace(true);
        for (const f of FACTORS) {
          const label = `at ${f}`;
          expect(await app.setPageZoom(f)).toBeCloseTo(f, 5);

          // ── Option-snap: A's right edge carried onto B's left edge snaps
          // to stand the deck's gap off it (`computeSnap` is handed
          // `-IMPOSITION_GAP_PX` for adjacent edges). An unsnapped drop would
          // land within the pointer's rounding of the edge itself, so the gap
          // is what tells a snap that ran from one that did not.
          await seed(app);
          const snapDx = (B.x - (A.x + A.width)) * f;
          const grab0 = await centre(app, GRAB);
          await app.withModifiersHeld(["alt"], async () => {
            await app.nativeDrag(grab0, { x: grab0.x + snapDx, y: grab0.y });
          });
          const snapped = await changed(app, "pA", A);

          // ── Plain drag: N viewport px is N / f layout px.
          await seed(app);
          const grab1 = await centre(app, GRAB);
          const rectBefore = await centre(app, FRAME("pA"));
          await app.nativeDrag(grab1, { x: grab1.x + DRAG.dx, y: grab1.y + DRAG.dy });
          const dragged = await changed(app, "pA", A);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(FRAME("pA"))}).getAnimations({ subtree: false }).length === 0`,
            { timeoutMs: 5_000 },
          );
          const rectAfter = await centre(app, FRAME("pA"));

          // ── Resize: the east edge follows the hand by N / f layout px.
          const handle = await centre(app, RESIZE_E);
          await app.nativeDrag(handle, { x: handle.x + RESIZE_DX, y: handle.y });
          const resized = await changed(app, "pA", dragged);

          readings[String(f)] = { snapped, dragged, resized, rectBefore, rectAfter };

          // The snap stands A one gap off B, exactly, whatever the factor.
          expect(
            Math.abs(snapped.x + snapped.width - (B.x - IMPOSITION_GAP_PX)),
            `snap ${label}`,
          ).toBeLessThanOrEqual(0.5);
          expect(snapped.y, `snap ${label}`).toBe(A.y);

          expect(Math.abs(dragged.x - (A.x + DRAG.dx / f)), `drag x ${label}`).toBeLessThanOrEqual(1);
          expect(Math.abs(dragged.y - (A.y + DRAG.dy / f)), `drag y ${label}`).toBeLessThanOrEqual(1);
          // On screen the pane moved the hand's full travel: it stayed under it.
          expect(Math.abs(rectAfter.x - rectBefore.x - DRAG.dx), `rect x ${label}`).toBeLessThanOrEqual(1);
          expect(Math.abs(rectAfter.y - rectBefore.y - DRAG.dy), `rect y ${label}`).toBeLessThanOrEqual(1);

          expect(resized.x, `resize keeps the west edge ${label}`).toBe(dragged.x);
          expect(
            Math.abs(resized.width - (dragged.width + RESIZE_DX / f)),
            `resize width ${label}`,
          ).toBeLessThanOrEqual(1);
        }
        note("frames by zoom", readings);
        await app.setPageZoom(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
