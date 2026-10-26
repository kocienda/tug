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
 * the three blocks stand collapsed. The burst opens the build, opens the
 * diff (which renders as a diff, not a terminal), closes the build, and
 * opens the failed check, whose header dot is red. The crop is the column
 * of blocks down to the status row.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { stubDirectory } from "../streaming-stub-fixture";
import { rectIn } from "../one-view-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor, standIns } from "./_site-clips";
import { BLOCKS, bashTurnTranscript, bindStub, press, runBashTurn, sessionDeck } from "./_components";

const TEST_TIMEOUT_MS = 120_000;
const CARD = "sc-blocks";
const BURST_MS = 9_600;
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

        const rest = await standIns(app);
        expect(rest[CARD], "the card stands in its slot").toBeDefined();
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const bar = await rectIn(body, STATUS_BAR);
        expect(bar, "the status bar is mounted").not.toBeNull();
        const first = await rectIn(body, BLOCKS);
        expect(first, "the first block is mounted").not.toBeNull();
        const card = rest[CARD]!;
        const top = view.y + first!.y - 20;
        const crop = cropAround([{ x: card.x, y: top, width: card.width, height: view.y + bar!.y + bar!.height - top }], 12, await contentSize(app));

        const reading = await burstTo(app, crop, BURST_MS, outDirFor("tool-blocks"), async () => {
          await Bun.sleep(800);
          await press(body, DISCLOSURE, { index: 0 });
          await Bun.sleep(1_900);
          await press(body, DISCLOSURE, { index: 1 });
          await Bun.sleep(2_200);
          await press(body, DISCLOSURE, { index: 0 });
          await Bun.sleep(1_300);
          await press(body, DISCLOSURE, { index: 2 });
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
