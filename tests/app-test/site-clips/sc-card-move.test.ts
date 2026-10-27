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
 * Flow at Slim width, in a window wide enough that the whole row stands
 * inside it: the site's placeholders (`_placeholders.ts`) — two Harbor files
 * with the `picker-keys` Session card between them — the front file
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
import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene, standIns } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
/** The dragged card and the one it drops on are files, since a split slot halves its height and a Session card stands no shorter than 600px. */
const PLACEHOLDERS = [
  { id: "sc-move-a", file: "README.md" },
  { id: "sc-move-b", session: "pickerKeys" },
  { id: "sc-move-c", file: "tides.ts" },
] as const satisfies readonly Placeholder[];
const CARDS = PLACEHOLDERS.map((p) => p.id);
const FRONT = CARDS[2]!;

/** Rest before the press, the settle after the first drop, and the longer one after the return, which also restores the column it left. */
const REST_MS = 600;
const SETTLE_MS = 1_400;
const RETURN_SETTLE_MS = 2_400;
/** How far a card may stand from where it rested and still count as back. */
const BACK_TOLERANCE_PX = 4;
/** The drag's own pace: steps × delay, plus the press. */
const DRAG_STEPS = 24;
const DRAG_STEP_MS = 30;
const PRESS_MS = 120;
/** Wide enough for three Slim cards and their gaps, so the row needs no travel. */
const WINDOW = { width: 2200, height: 900 };

function deck(): Record<string, unknown> {
  return {
    cards: PLACEHOLDERS.map(placeholderCard),
    panes: PLACEHOLDERS.map((p, slot) => kindPane("session" in p ? "session" : "text", p.id, slot)),
    activePaneId: `${FRONT}-pane`,
    imposition: { kind: "three-up", layout: "flow", contentWidth: "slim", sidebars: {} },
    hasFocus: true,
  };
}

/** Where to press the front card's grab handle, in window content points, as it stands now. */
async function grabPoint(app: App): Promise<{ x: number; y: number }> {
  const handle = await app.elementRect(FRONT, ".tug-pane-title-bar .tug-pane-grab-handle");
  expect(handle, "the front card offers its grab handle").not.toBeNull();
  return { x: handle!.x + Math.min(20, handle!.width / 2), y: handle!.y + handle!.height / 2 };
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
      const app = await launchForMode("sc-card-move", deck(), undefined, {
        contentSize: WINDOW,
        cardStates: placeholderStates(PLACEHOLDERS),
        settings: placeholderSettings(),
      });
      try {
        await standUpPlaceholders(app, PLACEHOLDERS);
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
        const crop = await cropFor(app, [...CARDS], { pad: 24 });

        // A drag is the one act here longer than a key: the next entry is
        // scheduled past its pace, so it never pushes.
        const dragMs = PRESS_MS + DRAG_STEPS * DRAG_STEP_MS;
        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => drag(app, from, to))
          .at(REST_MS + dragMs + SETTLE_MS, async () => drag(app, await grabPoint(app), home))
          .mark("loop-end", REST_MS + 2 * dragMs + SETTLE_MS + RETURN_SETTLE_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("card-move"), crop }));

        const after = await standIns(app);
        for (const id of CARDS) {
          const off = (["x", "y", "width", "height"] as const).map((k) => Math.abs(after[id]![k] - rest[id]![k]));
          expect(Math.max(...off), `${id} is back where it rested, at its size (off by ${off.map((v) => v.toFixed(1)).join(", ")})`).toBeLessThanOrEqual(BACK_TOLERANCE_PX);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
