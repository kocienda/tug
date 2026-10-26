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
 * The scene: three Session cards in their own slots of a three-up flow, each
 * bound to a stub transcript that has already run out, the middle card
 * focused and folded. The capture is cropped to the first two cards — the
 * folded card's slot and the neighbour it folds beside — with a margin.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import { stubDirectory } from "../streaming-stub-fixture";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARDS = ["sc-fold-a", "sc-fold-b", "sc-fold-c"] as const;
const FOLDED = CARDS[1];

/** Rest before the press, the hold folded, and the return after the unfold. */
const REST_MS = 700;
const HOLD_MS = 1_500;
const RETURN_MS = 1_300;

function deck(): Record<string, unknown> {
  return {
    cards: CARDS.map((id) => ({ id, componentId: "session", title: "Session", closable: true })),
    panes: CARDS.map((id, slot) => kindPane("session", id, slot)),
    activePaneId: `${FOLDED}-pane`,
    imposition: { kind: "three-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: fold", () => {
  test(
    "records View ▸ Fold Card folding the middle card and unfolding it",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-fold", deck(), stubDir);
      try {
        const session = cardKind("session");
        for (const id of CARDS) await standUpKind(app, session, id, stubDir);
        await app.dispatchControlAction("focus-session-card", { cardId: FOLDED });
        await Bun.sleep(800);

        const crop = await cropFor(app, [CARDS[0], FOLDED], { pad: 24 });
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
