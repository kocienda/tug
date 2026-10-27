/**
 * sc-fold.test.ts — the site's Fold clip: View ▸ Fold Card collapses a card
 * to its title bar beside a neighbour that stays open, and a second press
 * unfolds it.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the site's placeholders (`_placeholders.ts`) in their own slots
 * of a three-up flow at Slim width — `README.md`, the `picker-keys` Session
 * card, `tides.ts` — the Session card in the middle focused and folded. The
 * capture is cropped to the first two cards — the
 * folded card's slot and the neighbour it folds beside — with a margin.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const PLACEHOLDERS = [
  { id: "sc-fold-a", file: "README.md" },
  { id: "sc-fold-b", session: "pickerKeys" },
  { id: "sc-fold-c", file: "tides.ts" },
] as const satisfies readonly Placeholder[];
const CARDS = PLACEHOLDERS.map((p) => p.id);
const FOLDED = PLACEHOLDERS[1].id;

/** Rest before the press, the hold folded, and the return after the unfold. */
const REST_MS = 700;
const HOLD_MS = 1_500;
const RETURN_MS = 1_300;

function deck(): Record<string, unknown> {
  return {
    cards: PLACEHOLDERS.map(placeholderCard),
    panes: PLACEHOLDERS.map((p, slot) => kindPane("session" in p ? "session" : "text", p.id, slot)),
    activePaneId: `${FOLDED}-pane`,
    imposition: { kind: "three-up", layout: "flow", contentWidth: "slim", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: fold", () => {
  test(
    "records View ▸ Fold Card folding the middle card and unfolding it",
    async () => {
      const app = await launchForMode("sc-fold", deck(), undefined, {
        cardStates: placeholderStates(PLACEHOLDERS),
        settings: placeholderSettings(),
      });
      try {
        // The third card stands past the band's edge until the fold makes room.
        await standUpPlaceholders(app, PLACEHOLDERS.slice(0, 2));
        await app.dispatchControlAction("focus-session-card", { cardId: FOLDED });
        await Bun.sleep(800);

        const crop = await cropFor(app, [CARDS[0]!, FOLDED], { pad: 24 });
        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => app.performMenuItem("view.foldCard"))
          .at(REST_MS + HOLD_MS, () => app.performMenuItem("view.foldCard"))
          .mark("loop-end", REST_MS + HOLD_MS + RETURN_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("fold"), crop }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
