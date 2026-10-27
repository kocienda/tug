/**
 * sc-theme.test.ts — the site's theme clip: one Session card holding still
 * while the theme steps through all ten shipped themes and comes home.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card bound to the shared stub turn, run to its end,
 * with the diff block opened so a body with its own colors is on screen.
 * The scene performs the View menu's Next Theme nine times — the shipped
 * order walks the five dark themes and then the five light ones, wrapping,
 * so a run that starts in Ironclad sees Caravel, Barque, Galleon, Collier,
 * Sloop, Ketch, Skiff, Kayak and Pinnace, and one that starts in Sloop sees
 * the light four, then the dark five — and then picks the mode's own theme
 * from the Theme menu to end where it began. Both modes' clips show all ten
 * themes; they differ in which one they start and end on. The loop runs
 * from the first step to the home theme held as long as each other, so it
 * cycles through all ten without a seam.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { stubDirectory } from "../streaming-stub-fixture";
import { MODE, RUNS, THEME_FOR_MODE, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";
import { BLOCKS, bashTurnTranscript, bindStub, press, runBashTurn, sessionDeck } from "./_components";

const TEST_TIMEOUT_MS = 120_000;
const CARD = "sc-theme";
const STATUS_BAR = '[data-slot="session-card-status-bar"]';
const DISCLOSURE = `${BLOCKS} [data-slot="tool-call-header-disclosure"]`;
/** The mode's own theme stands this long before the first step. */
const LEAD_MS = 1_000;
/** Themes beyond the mode's own, each held this long. */
const STEPS = 9;
const HOLD_MS = 1_200;

describe.skipIf(!RUNS)("site clip: theme", () => {
  test(
    "records one card through all ten themes",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-theme", sessionDeck(CARD), stubDir);
      try {
        await bindStub(app, CARD, stubDir, bashTurnTranscript(), "sc-theme-");
        const body = app.body(CARD);
        await runBashTurn(body, "Build the site, show the last commit's stylesheet change, and check the types.");
        await press(body, DISCLOSURE, { index: 1 });
        await Bun.sleep(1_000);

        const crop = await cropFor(app, [CARD], { endAt: { card: CARD, selector: STATUS_BAR } });
        const s = scene();
        for (let i = 0; i < STEPS; i++) s.at(LEAD_MS + i * HOLD_MS, () => app.performMenuItem("view.nextTheme"));
        s.mark("loop-start", LEAD_MS);
        s.at(LEAD_MS + STEPS * HOLD_MS, () => app.performMenuItem(`view.theme.${THEME_FOR_MODE[MODE!]}`));
        s.mark("loop-end", LEAD_MS + (STEPS + 1) * HOLD_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("theme"), crop }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
