/**
 * at0811-switch-loops-move.test.ts — the waves on a switched-to workspace
 * move: a page woken from sleep runs its loops while it catches up, and a
 * shell stand-in over a page still being made animates.
 *
 * (a) One Text card on the away workspace, its page's dormant clock cut to
 * 400 ms and its catch-up held open 1.5 s (`catchUpDelayMs`). Visit away,
 * go home, wait past the dormant clock, switch away again, and read the
 * page's root every 100 ms for a second: the motion switch's demotion
 * attribute (`data-tug-motion-demoted`) must be absent at every read.
 *
 * (b) One Text card on the away workspace whose page takes 3 s to paint its
 * content (`contentPaintDelayMs`). Once the made-ahead path has asked for its
 * page (it has a body, loading or loaded, not failed), but before it has
 * painted, switch away and read the wave the card wears twice, 200 ms
 * apart — the shell's stand-in's while the shell stands in for it, else the
 * page's own lid's, once a made page shows its chrome: one of its
 * animations must be running, its `currentTime` advanced between the reads.
 *
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/components/chrome/space-layer-loops.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import {
  AWAY_SPACE,
  HOME_SPACE,
  launchSkeletonDeck,
  SHOULD_RUN,
  slowCatchUp,
  slowPages,
  switchTo,
  TEST_TIMEOUT_MS,
} from "./skeleton-switch-fixture";

const DORMANT_MS = 400;
const CATCH_UP_MS = 1_500;
const PAINT_DELAY_MS = 3_000;

interface WaveClocks {
  /** Where the wave was found: the shell's stand-in, or the page's own lid. */
  at: "stand-in" | "lid";
  clocks: { state: string; t: number | null }[];
}

/** Each animation of `wave`'s subtree: its play state and its clock. */
const CLOCKS_JS = `function (w) {
  return w.getAnimations({ subtree: true }).map(function (a) {
    return { state: a.playState, t: a.currentTime === null ? null : Number(a.currentTime) };
  });
}`;

/**
 * The wave the card wears while its content has not painted, wherever it is
 * drawn: the shell's stand-in while the shell stands in for it, else the
 * page's own lid, once its page is made and showing its chrome. Null when
 * neither wears one.
 */
async function waveClocks(app: App, cardId: string): Promise<WaveClocks | null> {
  const shell = await app.evalJS<WaveClocks["clocks"] | null>(
    `(function () {
      var w = document.querySelector('[data-body-placeholder][data-card-id="${cardId}"] [data-body-stand-in] [data-slot="tug-progress-wave"]');
      return w === null ? null : (${CLOCKS_JS})(w);
    })()`,
  );
  if (shell !== null) return { at: "stand-in", clocks: shell };
  const lid = await app
    .body(cardId)
    .evalJS<WaveClocks["clocks"] | null>(
      `(function () {
        var w = document.querySelector('.body-chrome-frame .tug-pane-content [data-slot="tug-progress-wave"]');
        return w === null ? null : (${CLOCKS_JS})(w);
      })()`,
      { timeoutMs: 1_000 },
    )
    .catch(() => null);
  return lid === null ? null : { at: "lid", clocks: lid };
}

describe.skipIf(!SHOULD_RUN)("at0811 — the waves move on a switched-to workspace", () => {
  test(
    "a page woken from sleep keeps its loops running through its catch-up",
    async () => {
      const id = "sk811-a";
      const deck = await launchSkeletonDeck("at0811-switch-loops-move-catch-up", [id]);
      const { app } = deck;
      try {
        await app.bodyDelays({ dormantAfterMs: DORMANT_MS });
        await slowCatchUp(app, { [id]: CATCH_UP_MS });
        await switchTo(app, AWAY_SPACE);
        await settleFor(() => bodyOf(app, id), (b) => b?.painted === true && b.visible, 5_000);
        await switchTo(app, HOME_SPACE);
        // Past the dormant clock, so the page has gone to sleep.
        await Bun.sleep(DORMANT_MS + 600);
        await switchTo(app, AWAY_SPACE);
        const reads: (boolean | null)[] = [];
        for (let i = 0; i < 10; i++) {
          reads.push(
            await app
              .body(id)
              .evalJS<boolean>(`document.documentElement.hasAttribute("data-tug-motion-demoted")`, { timeoutMs: 1_000 })
              .catch(() => null),
          );
          await Bun.sleep(100);
        }
        note(`demoted at each read: ${reads.map((r) => (r === null ? "?" : r ? "yes" : "no")).join(" ")}`);
        expect(reads.some((r) => r !== null), "the page answered at least one read").toBe(true);
        expect(reads.filter((r) => r === true).length, "the page's loops are never stilled during its catch-up").toBe(0);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a stand-in wave over a page still being made animates on the switch",
    async () => {
      const id = "sk811-b";
      const deck = await launchSkeletonDeck("at0811-switch-loops-move-stand-in", [id]);
      const { app } = deck;
      try {
        await slowPages(app, { [id]: PAINT_DELAY_MS });
        const asked = await settleFor(() => bodyOf(app, id), (b) => b !== null && b.state !== "failed" && b.painted !== true, 8_000);
        note(`before the switch: ${asked === null ? "no page asked for" : `${asked.state}, painted ${asked.painted}`}`);
        expect(asked !== null && asked.painted !== true, "the made-ahead path asked for the page and it has not painted").toBe(true);
        await switchTo(app, AWAY_SPACE);
        // The wave shows after a couple of frames' delay ([B02] of the skeletons brief).
        const first = await settleFor(() => waveClocks(app, id), (w) => w !== null && w.clocks.length > 0, 1_500);
        await Bun.sleep(200);
        let earlier = first;
        let second = await waveClocks(app, id);
        // The page may take the card over between the reads, its own lid's
        // wave in place of the stand-in's: read the one now worn again.
        if (second !== null && second.at !== first?.at) {
          earlier = second;
          await Bun.sleep(200);
          second = await waveClocks(app, id);
        }
        note(`wave clocks: ${JSON.stringify(first)}${earlier === first ? "" : ` then ${JSON.stringify(earlier)}`} then ${JSON.stringify(second)}`);
        expect(first, "the card wears a wave, on the shell's stand-in or on its page's lid").not.toBeNull();
        const moved = (earlier?.clocks ?? []).some((a, i) => {
          const b = second?.at === earlier?.at ? second?.clocks[i] : undefined;
          return b !== undefined && b.state === "running" && a.t !== null && b.t !== null && b.t > a.t;
        });
        expect(moved, "the wave is running and its clock advanced").toBe(true);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
