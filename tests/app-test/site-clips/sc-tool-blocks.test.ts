/**
 * sc-tool-blocks.test.ts — the site's tool-block clip for the component row:
 * three settled Bash blocks in a Session card, opened and closed by their
 * disclosure chevrons, one of them a diff.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card bound to the shared stub turn — a build, a
 * `git show`, a failing type check — run to its end before the burst, so
 * the three blocks stand collapsed. The scene opens the build, opens the
 * diff (which renders as a diff, not a terminal), closes the build, and
 * opens the failed check, whose header dot is red. The crop is the column
 * of blocks down to the status row.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { stubDirectory } from "../streaming-stub-fixture";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";
import { BLOCKS, bashTurnTranscript, bindStub, press, runBashTurn, sessionDeck } from "./_components";

const TEST_TIMEOUT_MS = 120_000;
const CARD = "sc-blocks";
/** The loop: the four presses and the last block settling open. */
const LOOP_MS = 9_000;
/** The crop starts this far above the first block. */
const ABOVE_BLOCKS = 20;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const DISCLOSURE = `${BLOCKS} [data-slot="tool-call-header-disclosure"]`;

describe.skipIf(!RUNS)("site clip: tool blocks", () => {
  test(
    "records three Bash blocks opened and closed by their chevrons",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-tool-blocks", sessionDeck(CARD), stubDir);
      try {
        await bindStub(app, CARD, stubDir, bashTurnTranscript(), "sc-blocks-");
        const body = app.body(CARD);
        await runBashTurn(body, "Build the site, show the last commit's stylesheet change, and check the types.");

        const crop = await cropFor(app, [CARD], {
          startAt: { card: CARD, selector: BLOCKS, above: ABOVE_BLOCKS },
          endAt: { card: CARD, selector: STATUS_BAR },
        });
        const s = scene()
          .mark("loop-start", 0)
          .at(800, () => press(body, DISCLOSURE, { index: 0 }))
          .at(2_700, () => press(body, DISCLOSURE, { index: 1 }))
          .at(4_900, () => press(body, DISCLOSURE, { index: 0 }))
          .at(6_200, () => press(body, DISCLOSURE, { index: 2 }))
          .mark("loop-end", LOOP_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("tool-blocks"), crop }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
