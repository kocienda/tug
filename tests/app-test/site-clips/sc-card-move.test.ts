/**
 * sc-card-move.test.ts — the site's card-move clip: a card dragged by its
 * grab handle across its neighbours, the drop zones lighting as it passes,
 * dropped on the first and the arrangement settling around it.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene is `at0747-no-hole-under-cards.test.ts`'s, in a three-up under
 * Fit so every slot is inside the window: three `hello` cards, the front
 * dragged over both neighbours and dropped on the first, as that test drags
 * it, then dragged back to where it stood — so the clip ends in the
 * arrangement it began in and loops without a seam. The driver checks that
 * the deck really did come back. The capture is cropped to the three cards
 * with a margin, so the clip is the arrangement and not the canvas around it.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import type { App } from "../_harness";
import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import { rectIn } from "../one-view-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor, standIns } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARDS = ["sc-move-a", "sc-move-b", "sc-move-c"] as const;
const FRONT = CARDS[2];

/** Rest before the press, and the settle after each drop. */
const REST_MS = 600;
const SETTLE_MS = 1_400;
/** How far a card may stand from where it rested and still count as back. */
const BACK_TOLERANCE_PX = 4;
/** The drag's own pace: steps × delay, plus the press. */
const DRAG_STEPS = 24;
const DRAG_STEP_MS = 30;
const PRESS_MS = 120;

function deck(): Record<string, unknown> {
  return {
    cards: CARDS.map((id) => ({ id, componentId: "hello", title: id, closable: true })),
    panes: CARDS.map((id, slot) => kindPane("hello", id, slot)),
    activePaneId: `${FRONT}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** Where to press the front card's grab handle, in window content points, as it stands now. */
async function grabPoint(app: App): Promise<{ x: number; y: number }> {
  const handle = await rectIn(app.body(FRONT), ".tug-pane-title-bar .tug-pane-grab-handle");
  expect(handle, "the front card offers its grab handle").not.toBeNull();
  const view = (await app.bodies()).find((s) => s.cardId === FRONT)!.frame;
  return { x: view.x + handle!.x + Math.min(20, handle!.width / 2), y: view.y + handle!.y + handle!.height / 2 };
}

/** One drag at the clip's pace, released at `to`. */
async function drag(app: App, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await app.nativeDragWithoutRelease(from, to, {
    interpolationSteps: DRAG_STEPS,
    interpolationDelayMs: DRAG_STEP_MS,
    mouseDownDelayMs: PRESS_MS,
  });
  await app.nativeMouseUp(to);
}

describe.skipIf(!RUNS)("site clip: card move", () => {
  test(
    "records the front card dragged across two neighbours, dropped on the first, and brought back",
    async () => {
      const app = await launchForMode("sc-card-move", deck());
      try {
        const hello = cardKind("hello");
        for (const id of CARDS) await standUpKind(app, hello, id);
        await Bun.sleep(800);

        const rest = await standIns(app);
        for (const id of CARDS) expect(rest[id], `${id} stands in its slot`).toBeDefined();
        const a = rest[CARDS[0]]!;
        const c = rest[FRONT]!;
        const from = await grabPoint(app);
        // Over the first card, below its title band, so the drop asks for
        // its slot rather than a tab on its bar.
        const to = { x: Math.max(a.x, 0) + Math.min(80, a.width / 3), y: from.y + 120 };
        // And back to the tile the card rested in: the zone nearest its old centre.
        const home = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
        const crop = cropAround(Object.values(rest), 24, await contentSize(app));

        const dragMs = PRESS_MS + DRAG_STEPS * DRAG_STEP_MS;
        const reading = await burstTo(app, crop, REST_MS + 2 * (dragMs + SETTLE_MS), outDirFor("card-move"), async () => {
          await Bun.sleep(REST_MS);
          await drag(app, from, to);
          await Bun.sleep(SETTLE_MS);
          await drag(app, await grabPoint(app), home);
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);

        const after = await standIns(app);
        for (const id of CARDS) {
          const dx = Math.abs(after[id]!.x - rest[id]!.x);
          const dy = Math.abs(after[id]!.y - rest[id]!.y);
          expect(Math.max(dx, dy), `${id} is back where it rested (moved ${dx.toFixed(1)}, ${dy.toFixed(1)})`).toBeLessThanOrEqual(BACK_TOLERANCE_PX);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
