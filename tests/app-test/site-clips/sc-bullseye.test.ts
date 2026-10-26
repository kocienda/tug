/**
 * sc-bullseye.test.ts — the site's Bullseye clip: View ▸ Bullseye centres the
 * focused card in the band and a second press lets it go.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. It is run by path, once per
 * mode (`_site-clips.ts` has the invocation), and skips unless the runner and
 * both site variables are set.
 *
 * The scene: four Session cards in one pane, each bound to a stub transcript
 * that has already run out, the second card focused. The scene is a rest,
 * the press into bullseye, a hold, the press out and the return, so the clip
 * loops from the deck at rest back to the deck at rest. The whole content
 * area is recorded; the site crops at encode time.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { cardAtRest, sessionPaneDeck, spawnWithTranscript } from "../one-view-fixture";
import { stubDirectory } from "../streaming-stub-fixture";
import { RUNS, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARDS = ["sc-bull-a", "sc-bull-b", "sc-bull-c", "sc-bull-d"];

/** Rest before the press, the hold in bullseye, and the return after the release. */
const REST_MS = 700;
const HOLD_MS = 1_600;
const RETURN_MS = 1_300;

describe.skipIf(!RUNS)("site clip: bullseye", () => {
  test(
    "records View ▸ Bullseye in and out over the deck",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-bullseye", sessionPaneDeck(CARDS), stubDir);
      try {
        for (const card of CARDS) await spawnWithTranscript(app, stubDir, card);
        await app.dispatchControlAction("focus-session-card", { cardId: CARDS[1] });
        await cardAtRest(app, CARDS[1]);
        await Bun.sleep(800);

        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => app.performMenuItem("view.bullseye"))
          .at(REST_MS + HOLD_MS, () => app.performMenuItem("view.bullseye"))
          .mark("loop-end", REST_MS + HOLD_MS + RETURN_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("bullseye") }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
