/**
 * sc-bullseye.test.ts — the site's Bullseye clip: View ▸ Bullseye centres the
 * focused card in the band and a second press lets it go.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. It is run by path, once per
 * mode (`_site-clips.ts` has the invocation), and skips unless the runner and
 * both site variables are set.
 *
 * The scene: the site's placeholders (`_placeholders.ts`) in a three-up under
 * Flow at Slim width, no rails — a Harbor file, the `picker-keys` Session
 * card, and another file — with the Session card focused. On an imposed deck
 * every card already stands at the band's full height, so the press into
 * bullseye is one motion, the card widening to Comfy and sliding to the
 * centre as its neighbours leave by their own sides; a free pane would grow
 * in height as a second motion after the slide, which reads as a judder.
 * The scene is a rest, the press into bullseye, a hold, the press out and
 * the return, so the clip loops from the deck at rest back to the deck at
 * rest. The whole content area is recorded.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { RUNS, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
/** The Session card between two Harbor files, so a neighbour leaves by each side. */
const CARDS = [
  { id: "sc-bull-a", file: "README.md" },
  { id: "sc-bull-b", session: "pickerKeys" },
  { id: "sc-bull-c", file: "tides.ts" },
] as const satisfies readonly Placeholder[];
const FOCUSED = CARDS[1].id;

/** Rest before the press, the hold in bullseye, and the return after the release. */
const REST_MS = 700;
const HOLD_MS = 1_600;
const RETURN_MS = 1_300;

function deck(): Record<string, unknown> {
  return {
    cards: CARDS.map(placeholderCard),
    panes: CARDS.map((p, slot) => kindPane("session" in p ? "session" : "text", p.id, slot)),
    activePaneId: `${FOCUSED}-pane`,
    imposition: { kind: "three-up", layout: "flow", contentWidth: "slim", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: bullseye", () => {
  test(
    "records View ▸ Bullseye in and out over the deck",
    async () => {
      const app = await launchForMode("sc-bullseye", deck(), undefined, {
        cardStates: placeholderStates(CARDS),
        settings: placeholderSettings(),
      });
      try {
        await standUpPlaceholders(app, CARDS);
        await app.dispatchControlAction("focus-session-card", { cardId: FOCUSED });
        await Bun.sleep(1_000);

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
