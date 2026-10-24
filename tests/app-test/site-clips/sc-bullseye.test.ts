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
 * that has already run out, the second card focused. The burst spans a rest,
 * the press into bullseye, a hold, the press out and the settle, so the clip
 * loops from the deck at rest back to the deck at rest. The whole content
 * area is recorded; the site crops at encode time.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { cardAtRest, sessionPaneDeck, spawnWithTranscript } from "../one-view-fixture";
import { stubDirectory } from "../streaming-stub-fixture";
import { RUNS, burstTo, launchForMode, outDirFor } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARDS = ["sc-bull-a", "sc-bull-b", "sc-bull-c", "sc-bull-d"];

/** Rest before the press, the hold in bullseye, and the settle after the release. */
const REST_MS = 700;
const HOLD_MS = 1_600;
const SETTLE_MS = 1_300;

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

        const reading = await burstTo(app, undefined, REST_MS + HOLD_MS + SETTLE_MS, outDirFor("bullseye"), async () => {
          await Bun.sleep(REST_MS);
          await app.performMenuItem("view.bullseye");
          await Bun.sleep(HOLD_MS);
          await app.performMenuItem("view.bullseye");
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
