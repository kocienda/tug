/**
 * sc-flow-scroll.test.ts — the site's Flow clip: a row of cards that overruns
 * the band's right edge, the last card activated so the band slides to bring
 * it into view, and the first activated so it slides back.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the factory rails up on both sides (`_rails.ts`), and five
 * placeholders (`_placeholders.ts`) at Slim width — the `picker-keys` Session
 * card and the four Harbor files — in a five-up flow, the widest imposition
 * the deck has, in a window that holds about two of them between the rails, and
 * far wider than the band. The burst focuses the last card, so it becomes
 * the active card and the band travels to show it, holds, and focuses the
 * first again. The whole content area is recorded.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { factoryRails, railsEnv, standUpRails } from "./_rails";
import { RUNS, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
/** The `picker-keys` Session card first, the four Harbor files after it. */
const CARDS = [
  { id: "sc-flow-a", session: "pickerKeys" },
  { id: "sc-flow-b", file: "README.md" },
  { id: "sc-flow-c", file: "notes.md" },
  { id: "sc-flow-d", file: "fetch_tides.py" },
  { id: "sc-flow-e", file: "tides.ts" },
] as const satisfies readonly Placeholder[];
const FIRST = `${CARDS[0].id}-pane`;
const LAST = `${CARDS[CARDS.length - 1]!.id}-pane`;
/**
 * Wide enough that the band between the rails holds about two Slim cards,
 * and no wider than 2040 points, so the whole window encoded at its own
 * pixels (2×) stays inside H.264 level 5.1's frame size (`sc-fit-flow`).
 */
const WINDOW = { width: 2040, height: 1051 };

/** Rest before the travel, the hold at the far end, and the return to the first card. */
const REST_MS = 700;
const HOLD_MS = 1_500;
const RETURN_MS = 1_500;

function deck(): Record<string, unknown> {
  const rails = factoryRails();
  return {
    cards: [...CARDS.map(placeholderCard), ...rails.cards],
    panes: [...CARDS.map((p, slot) => kindPane("session" in p ? "session" : "text", p.id, slot)), ...rails.panes],
    activePaneId: FIRST,
    imposition: { kind: "five-up", layout: "flow", contentWidth: "slim", sidebars: rails.sidebars, rails: rails.rails },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: flow scroll", () => {
  test(
    "records the band travelling to the last card as it becomes active, and back",
    async () => {
      const app = await launchForMode("sc-flow-scroll", deck(), undefined, {
        contentSize: WINDOW,
        env: railsEnv(),
        cardStates: placeholderStates(CARDS),
        settings: placeholderSettings(),
      });
      try {
        await standUpRails(app);
        // The cards the band shows stand up before the burst; the ones past
        // its edge are stood up by the travel that brings them in.
        await standUpPlaceholders(app, CARDS.slice(0, 2));
        await app.dispatchControlAction("focus-pane", { paneId: FIRST });
        await Bun.sleep(1_500);

        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => app.dispatchControlAction("focus-pane", { paneId: LAST }))
          .at(REST_MS + HOLD_MS, () => app.dispatchControlAction("focus-pane", { paneId: FIRST }))
          .mark("loop-end", REST_MS + HOLD_MS + RETURN_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("flow-scroll") }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
