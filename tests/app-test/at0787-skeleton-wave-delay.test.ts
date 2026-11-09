/**
 * at0787-skeleton-wave-delay.test.ts — a skeleton shows that it is loading:
 * an arriving card's stand-in wears the deck's progress wave after about two
 * display frames, not before, and keeps it until its page lands; and a body
 * page whose content has not painted wears it on its own lid.
 *
 * Two Text cards on a workspace never shown, both pages made slow by 1.5 s.
 * A recorder in the shell reads every animation frame from before the cut:
 * per card, whether its stand-in wears a visible `TugProgressWave`. The cut
 * is the first frame the away workspace is active. The wave's delay runs
 * from its first rendered frame — a parked workspace's content has no box
 * until its layer shows — and it must be absent for that frame and the next,
 * visible from at most six frames on, and stay through the end of the
 * window, which ends before either page can paint. A stand-in the host's
 * face was drawn from is the exception: the face has shown the wave from the
 * cut, so its stand-in wears it by the frame after its first rendered one —
 * the face is read off that first frame and stands over it (`at0788`) — and
 * the box never goes bare when the face retires.
 * Then each card's own page, loaded and still lidded, must show the wave on
 * its lid. The switch runs with the made-ahead path as it ships, cut as soon
 * as home has painted so the away pages are cold.
 *
 * @covers tugdeck/src/components/chrome/body-stand-in.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-wave.tsx
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { settleFor } from "./body-grounding/_bodies";
import {
  armStandIns,
  AWAY_SPACE,
  bodyLidWave,
  launchSkeletonDeck,
  readStandIns,
  SHOULD_RUN,
  slowPages,
  switchTo,
  TEST_TIMEOUT_MS,
  WAVE_DELAY_FRAMES,
} from "./skeleton-switch-fixture";

const CARDS = ["sk787-a", "sk787-b"];
const SLOW_MS = 1_500;
/** The recorder's window from its arming: past the cut and well short of the slow pages' paint. */
const WINDOW_MS = 1_100;
/** By this many frames after the cut the wave has drawn: its delay and some slack for a busy cut. */
const WAVE_BY_FRAMES = 6;

describe.skipIf(!SHOULD_RUN)("at0787 — the skeleton's wave and its delay", () => {
  test(
    "an arriving stand-in wears the wave after two frames and not before, and a lidded page wears it too",
    async () => {
      const deck = await launchSkeletonDeck("at0787-skeleton-wave-delay", CARDS);
      const { app } = deck;
      try {
        await slowPages(app, Object.fromEntries(CARDS.map((id) => [id, SLOW_MS])));
        await armStandIns(app, CARDS, WINDOW_MS);
        await Bun.sleep(50);
        await switchTo(app, AWAY_SPACE);
        const frames = await readStandIns(app, WINDOW_MS);
        expect(frames, "the shell's stand-in recorder finished").not.toBeNull();
        const cutAt = (frames ?? []).findIndex((f) => f.space === AWAY_SPACE);
        expect(cutAt, "the recorder saw the cut").toBeGreaterThanOrEqual(0);
        const after = (frames ?? []).slice(cutAt);
        const bad: string[] = [];
        for (const id of CARDS) {
          const marks = (frames ?? []).map((f, i) => `${i === cutAt ? "|" : ""}${f.cards[id]?.wave ? "W" : f.cards[id]?.boxed ? "b" : f.cards[id]?.standIn ? "s" : "-"}`).join("");
          const drawn = after.some((f) => f.cards[id]?.drawn === true);
          note(`${id}: stand-in frames, the cut at | (W wave, b wave rendered and waiting, s stand-in with no rendered wave, - none)${drawn ? ", a face drawn from it" : ""}: ${marks}`);
          // The delay runs from the wave's first rendered frame: a parked
          // workspace's content has no box until its layer shows.
          const boxedAt = after.findIndex((f) => f.cards[id]?.boxed === true);
          const waveAt = after.findIndex((f) => f.cards[id]?.wave === true);
          if (boxedAt < 0 || waveAt < 0) {
            bad.push(`${id}: its stand-in never wore the wave in ${after.length} frames from the cut`);
            continue;
          }
          const first = waveAt - boxedAt;
          if (drawn && first > 1) bad.push(`${id}: a face was drawn from its stand-in with the wave, and the stand-in went ${first} frames bare beneath it`);
          if (!drawn && first < WAVE_DELAY_FRAMES) bad.push(`${id}: its stand-in wore the wave ${first} frames after it was rendered, inside its ${WAVE_DELAY_FRAMES}-frame delay`);
          if (first > WAVE_BY_FRAMES) bad.push(`${id}: its stand-in first wore the wave ${first} frames after it was rendered, past ${WAVE_BY_FRAMES}`);
          const gap = after.slice(waveAt).findIndex((f) => f.cards[id]?.wave !== true);
          if (gap >= 0) bad.push(`${id}: its stand-in's wave dropped at frame ${waveAt + gap} of the cut, before its page could paint`);
        }
        // Each page's own lid, once the page is up and still waiting on its content.
        for (const id of CARDS) {
          const lid = await settleFor(() => bodyLidWave(app, id), (l) => l !== null && l.lidded && l.wave, 900);
          note(`${id}: its page's lid ${JSON.stringify(lid)}`);
          if (lid === null) bad.push(`${id}: its page was not up to read before its content painted`);
          else if (lid.lidded && !lid.wave) bad.push(`${id}: its page's lid stands without the wave`);
        }
        expect(bad, "every skeleton wears the wave after its delay, and every lidded page wears it").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
