/**
 * sc-flow-scroll.test.ts — the site's Flow clip: a row of cards that overruns
 * the window's right edge, the band moved along it to the last card and back.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: five `hello` cards in a five-up flow — the widest imposition the
 * deck has, and already wider than the window — moved with Go ▸ Go to Slot,
 * the same travel ⌃⌘N commits (`at0466-go-to-slot.test.ts`), to the last
 * slot and back to the first. The whole content area is recorded.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import { RUNS, burstTo, launchForMode, outDirFor } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARDS = ["sc-flow-a", "sc-flow-b", "sc-flow-c", "sc-flow-d", "sc-flow-e"] as const;

/** Rest before the travel, the hold at the far end, and the settle after the return. */
const REST_MS = 700;
const HOLD_MS = 1_500;
const SETTLE_MS = 1_500;

function deck(): Record<string, unknown> {
  return {
    cards: CARDS.map((id) => ({ id, componentId: "hello", title: id, closable: true })),
    panes: CARDS.map((id, slot) => kindPane("hello", id, slot)),
    activePaneId: `${CARDS[0]}-pane`,
    imposition: { kind: "five-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: flow scroll", () => {
  test(
    "records the band travelling to the last slot and back",
    async () => {
      const app = await launchForMode("sc-flow-scroll", deck());
      try {
        const hello = cardKind("hello");
        // The cards the window shows stand up before the burst; the ones past
        // its edge are stood up by the travel that brings them in.
        for (const id of CARDS.slice(0, 2)) await standUpKind(app, hello, id);
        await Bun.sleep(1_500);

        const reading = await burstTo(app, undefined, REST_MS + HOLD_MS + SETTLE_MS, outDirFor("flow-scroll"), async () => {
          await Bun.sleep(REST_MS);
          await app.performMenuItem(`go.goToSlot.${CARDS.length}`);
          await Bun.sleep(HOLD_MS);
          await app.performMenuItem("go.goToSlot.1");
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
