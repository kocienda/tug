/**
 * sc-slot-move.test.ts — the site's Moving Cards clip: a card sent to another
 * slot by naming the destination, first through the slot badge's picker and
 * then back home by the slot chord's own action.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the site's placeholders (`_placeholders.ts`) in a three-up under
 * Flow at Slim width, no rails — the `picker-keys` Session card first and
 * focused, two Harbor files after it. The slot badge the burst presses is
 * the Session card's, in its masthead tier, which is the one
 * `at0462-card-slot-badge-picker` drives.
 * The burst presses the first card's slot badge, so the arrangement opens as
 * a picker, holds, presses the picker's last slot, so the card travels there
 * and stacks on the card already standing in it, holds, and dispatches
 * `assign-slot` to slot 1 — what ⌘1 does — to bring it home. The whole content area
 * is recorded.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { RUNS, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";
import { press } from "./_components";

const TEST_TIMEOUT_MS = 110_000;
/** The Session card moves; two Harbor files hold the other slots. */
const CARDS = [
  { id: "sc-sm-a", session: "pickerKeys" },
  { id: "sc-sm-b", file: "README.md" },
  { id: "sc-sm-c", file: "tides.ts" },
] as const satisfies readonly Placeholder[];
const MOVER = CARDS[0].id;
/** The badge's trigger button and its picker's chips, in the card's own page (`card-slot-badge-fixture.ts`). */
const BADGE = '[data-testid="card-slot-badge-trigger"]';
const PICKER_SLOT = '[data-testid="card-slot-badge-picker"] [data-slot="tug-slot"]';

/** Rest, the picker's hold, the settle after the move, and the settle after the return. */
const REST_MS = 700;
const PICKER_MS = 1_300;
const SETTLE_MS = 1_800;
const RETURN_SETTLE_MS = 1_800;

function deck(): Record<string, unknown> {
  return {
    cards: CARDS.map(placeholderCard),
    panes: CARDS.map((p, slot) => kindPane("session" in p ? "session" : "text", p.id, slot)),
    activePaneId: `${MOVER}-pane`,
    imposition: { kind: "three-up", layout: "flow", contentWidth: "slim", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: slot move", () => {
  test(
    "records a card sent to the last slot by the picker and home by the chord's action",
    async () => {
      const app = await launchForMode("sc-slot-move", deck(), undefined, {
        cardStates: placeholderStates(CARDS),
        settings: placeholderSettings(),
      });
      try {
        await standUpPlaceholders(app, CARDS);
        await app.dispatchControlAction("focus-session-card", { cardId: MOVER });
        await Bun.sleep(1_000);
        const body = app.body(MOVER);

        const picked = REST_MS + PICKER_MS;
        const home = picked + SETTLE_MS;
        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, async () => {
            await press(body, BADGE, { index: 0 });
            await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(PICKER_SLOT)}) !== null`, { timeoutMs: 5_000 });
          })
          .at(picked, () => press(body, PICKER_SLOT, { index: CARDS.length - 1 }))
          // ⌘1's `move-to-slot` acts on the layout selection, which does not
          // follow the card the picker moved, so the scene sends the
          // `assign-slot` it dispatches with the mover named.
          .at(home, () => app.dispatchControlAction("assign-slot", { cardId: MOVER, slot: 0 }))
          .mark("loop-end", home + RETURN_SETTLE_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("slot-move") }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
