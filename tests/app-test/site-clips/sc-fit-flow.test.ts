/**
 * sc-fit-flow.test.ts — the site's Fit and Flow clip: three cards in a
 * three-up that overruns the band under Flow, switched to Fit so every card
 * comes inside the band and the neighbours overlap, and switched back.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the factory rails up on both sides (`_rails.ts`), and three
 * placeholders (`_placeholders.ts`), a Session card and two Harbor files at
 * Slim width, in a three-up flow in a window wide enough that the band holds
 * about two of them, so
 * the row runs past the band's right edge. The burst dispatches
 * `set-imposition-layout` to `fit` — the Layout card's own action — holds,
 * and dispatches it back to `flow`. The whole content area is recorded.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { factoryRails, railsEnv, standUpRails } from "./_rails";
import { RUNS, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
/** The `picker-keys` Session card first, two Harbor files after it: at the deck's own width, three overrun the band between the rails under Flow. */
const CARDS = [
  { id: "sc-ff-a", session: "pickerKeys" },
  { id: "sc-ff-b", file: "README.md" },
  { id: "sc-ff-c", file: "tides.ts" },
] as const satisfies readonly Placeholder[];

/** Rest in Flow, the hold in Fit, and the settle back in Flow. */
const REST_MS = 900;
const HOLD_MS = 2_000;
const SETTLE_MS = 1_800;
/**
 * Wide enough that the band between the rails holds about two Slim cards,
 * so Fit's overlap reads, and no wider than 2040 points: the clip is encoded
 * at the frame's own pixels, 2× on Retina, and 4080 × 2038 keeps the whole
 * window inside H.264 level 5.1's frame size.
 */
const WINDOW = { width: 2040, height: 1051 };

function deck(): Record<string, unknown> {
  const rails = factoryRails();
  return {
    cards: [...CARDS.map(placeholderCard), ...rails.cards],
    panes: [...CARDS.map((p, slot) => kindPane("session" in p ? "session" : "text", p.id, slot)), ...rails.panes],
    activePaneId: `${CARDS[0].id}-pane`,
    imposition: { kind: "three-up", layout: "flow", contentWidth: "slim", sidebars: rails.sidebars, rails: rails.rails },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: fit and flow", () => {
  test(
    "records the row switching from Flow to Fit and back",
    async () => {
      const app = await launchForMode("sc-fit-flow", deck(), undefined, {
        contentSize: WINDOW,
        env: railsEnv(),
        cardStates: placeholderStates(CARDS),
        settings: placeholderSettings(),
      });
      try {
        await standUpRails(app);
        // The cards the band shows under Flow stand up before the burst; the
        // rest are past the edge and stand up as Fit brings them in.
        await standUpPlaceholders(app, CARDS.slice(0, 2));
        await app.dispatchControlAction("focus-pane", { paneId: `${CARDS[0].id}-pane` });
        await Bun.sleep(1_200);

        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => app.dispatchControlAction("set-imposition-layout", { layout: "fit" }))
          .at(REST_MS + HOLD_MS, () => app.dispatchControlAction("set-imposition-layout", { layout: "flow" }))
          .mark("loop-end", REST_MS + HOLD_MS + SETTLE_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("fit-flow") }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
