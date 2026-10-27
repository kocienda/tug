/**
 * sc-zoom.test.ts — the site's whole-app zoom clip: a deck of two cards
 * zoomed in two steps and returned to actual size.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the site's placeholders (`_placeholders.ts`) — the `picker-keys`
 * Session card and `tides.ts` — in a two-up under Fit at Slim width, so the
 * zoom is read in a transcript and in code. The burst performs
 * View ▸ Zoom In twice, holding at each step, then View ▸ Actual Size. The
 * whole content area is recorded, since the zoom is the window's.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { RUNS, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARDS = [
  { id: "sc-zoom-a", session: "pickerKeys" },
  { id: "sc-zoom-b", file: "tides.ts" },
] as const satisfies readonly Placeholder[];

/** Rest, the hold at each zoom step, and the settle back at actual size. */
const REST_MS = 800;
const STEP_MS = 1_400;
const SETTLE_MS = 1_600;

function deck(): Record<string, unknown> {
  return {
    cards: CARDS.map(placeholderCard),
    panes: CARDS.map((p, slot) => kindPane("session" in p ? "session" : "text", p.id, slot)),
    activePaneId: `${CARDS[1].id}-pane`,
    imposition: { kind: "two-up", layout: "fit", contentWidth: "slim", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: zoom", () => {
  test(
    "records the app zooming in two steps and back to actual size",
    async () => {
      const app = await launchForMode("sc-zoom", deck(), undefined, {
        cardStates: placeholderStates(CARDS),
        settings: placeholderSettings(),
      });
      try {
        await standUpPlaceholders(app, CARDS);
        await app.dispatchControlAction("focus-pane", { paneId: `${CARDS[1].id}-pane` });
        await Bun.sleep(1_000);

        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => app.performMenuItem("view.zoomIn"))
          .at(REST_MS + STEP_MS, () => app.performMenuItem("view.zoomIn"))
          .at(REST_MS + 2 * STEP_MS, () => app.performMenuItem("view.actualSize"))
          .mark("loop-end", REST_MS + 2 * STEP_MS + SETTLE_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("zoom") }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
