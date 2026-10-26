/**
 * sc-theme.test.ts — the site's theme clip: one Session card holding still
 * while the theme steps through every theme of its mode and comes home.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card bound to the shared stub turn, run to its end,
 * with the diff block opened so a body with its own colors is on screen.
 * The burst performs the View menu's Next Theme four times — the shipped
 * order walks the dark themes and then the light ones, so a run that starts
 * in Ironclad sees Caravel, Barque, Galleon and Collier, and one that starts
 * in Sloop sees Ketch, Skiff, Kayak and Pinnace — and then picks the mode's
 * own theme from the Theme menu to end where it began.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { stubDirectory } from "../streaming-stub-fixture";
import { rectIn } from "../one-view-fixture";
import { MODE, RUNS, THEME_FOR_MODE, burstTo, contentSize, cropAround, launchForMode, outDirFor, standIns } from "./_site-clips";
import { BLOCKS, bashTurnTranscript, bindStub, press, runBashTurn, sessionDeck } from "./_components";

const TEST_TIMEOUT_MS = 120_000;
const CARD = "sc-theme";
const BURST_MS = 9_400;
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const DISCLOSURE = `${BLOCKS} [data-slot="tool-call-header-disclosure"]`;
/** Themes beyond the mode's own, each held this long. */
const STEPS = 4;
const HOLD_MS = 1_500;

describe.skipIf(!RUNS)("site clip: theme", () => {
  test(
    "records one card through every theme of its mode",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-theme", sessionDeck(CARD), stubDir);
      try {
        await bindStub(app, CARD, stubDir, bashTurnTranscript(), "sc-theme-");
        const body = app.body(CARD);
        await runBashTurn(body, "Build the site, show the last commit's stylesheet change, and check the types.");
        await press(body, DISCLOSURE, { index: 1 });
        await Bun.sleep(1_000);

        const rest = await standIns(app);
        expect(rest[CARD], "the card stands in its slot").toBeDefined();
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const bar = await rectIn(body, STATUS_BAR);
        expect(bar, "the status bar is mounted").not.toBeNull();
        const card = rest[CARD]!;
        const crop = cropAround([{ x: card.x, y: card.y, width: card.width, height: view.y + bar!.y + bar!.height - card.y }], 12, await contentSize(app));

        const reading = await burstTo(app, crop, BURST_MS, outDirFor("theme"), async () => {
          await Bun.sleep(1_000);
          for (let i = 0; i < STEPS; i++) {
            await app.performMenuItem("view.nextTheme");
            await Bun.sleep(HOLD_MS);
          }
          await app.performMenuItem(`view.theme.${THEME_FOR_MODE[MODE!]}`);
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
