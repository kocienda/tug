/**
 * at0787-skeleton-wave-delay.test.ts — a skeleton shows that it is loading:
 * an arriving card's skeleton wears the deck's progress wave after two
 * display frames on screen, not before, and keeps it until its page lands;
 * and a body page whose content has not painted wears it on its own lid.
 *
 * Two Text cards on a workspace never shown, both pages made slow by 1.5 s.
 * The switch is made as soon as home has painted, so the away pages are
 * cold and each arriving card stands as the host's skeleton in its stage.
 * The host's `stages` account is read from the switch on: each card's
 * skeleton schedules its wave after two display frames, starts it no sooner
 * than two frames and no later than six after it came on screen, and wears
 * it on every read until the card's own page lands. Then each card's own
 * page, loaded and still lidded, must show the wave on its lid.
 *
 * @covers tugapp/Sources/BodyStages.swift
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-wave.tsx
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { settleFor } from "./body-grounding/_bodies";
import {
  AWAY_SPACE,
  bodyLidWave,
  launchSkeletonDeck,
  sampleStages,
  SHOULD_RUN,
  slowPages,
  switchTo,
  TEST_TIMEOUT_MS,
  WAVE_DELAY_FRAMES,
} from "./skeleton-switch-fixture";

const CARDS = ["sk787-a", "sk787-b"];
const SLOW_MS = 1_500;
/** How long the account is read from the switch: well short of the slow pages' paint. */
const WINDOW_MS = 900;
/** The shortest a display frame runs (120 Hz), and the longest (60 Hz) with a busy cut's slack. */
const FRAME_MIN_MS = 1000 / 120;
const WAVE_BY_MS = 6 * (1000 / 60) + 50;

describe.skipIf(!SHOULD_RUN)("at0787 — the skeleton's wave and its delay", () => {
  test(
    "an arriving skeleton wears the wave after two frames and not before, and a lidded page wears it too",
    async () => {
      const deck = await launchSkeletonDeck("at0787-skeleton-wave-delay", CARDS);
      const { app } = deck;
      try {
        await slowPages(app, Object.fromEntries(CARDS.map((id) => [id, SLOW_MS])));
        await switchTo(app, AWAY_SPACE);
        const samples = await sampleStages(app, CARDS, WINDOW_MS);
        const bad: string[] = [];
        for (const id of CARDS) {
          const rows = samples.map((s) => s.cards[id]);
          note(`${id}: ${rows.map((r) => (r === null ? "-" : r.picture === "skeleton" ? (r.wave ? "W" : "s") : r.picture === "live" ? "L" : "f")).join("")} (W wave, s skeleton waiting, L live, f last frame)`);
          const skeletons = rows.filter((r) => r?.picture === "skeleton");
          if (skeletons.length === 0) {
            bad.push(`${id}: never stood as a skeleton after the switch`);
            continue;
          }
          const delay = skeletons.find((r) => r!.waveDelayFrames !== null)?.waveDelayFrames ?? null;
          if (delay !== WAVE_DELAY_FRAMES) bad.push(`${id}: its skeleton schedules its wave after ${delay} frames, not ${WAVE_DELAY_FRAMES}`);
          const timed = skeletons.find((r) => r!.waveWall !== null && r!.onScreenWall !== null);
          if (timed === undefined) {
            bad.push(`${id}: its skeleton's wave never began in ${WINDOW_MS} ms`);
            continue;
          }
          const afterMs = timed!.waveWall! - timed!.onScreenWall!;
          note(`${id}: its wave began ${afterMs.toFixed(1)} ms after its skeleton came on screen`);
          if (afterMs < WAVE_DELAY_FRAMES * FRAME_MIN_MS - 1) bad.push(`${id}: its wave began ${afterMs.toFixed(1)} ms on, inside its ${WAVE_DELAY_FRAMES}-frame delay`);
          if (afterMs > WAVE_BY_MS) bad.push(`${id}: its wave began ${afterMs.toFixed(1)} ms on, past six frames`);
          const firstWave = rows.findIndex((r) => r?.wave === true);
          const dropped = rows.slice(firstWave).findIndex((r) => r?.picture === "skeleton" && !r.wave);
          if (firstWave >= 0 && dropped >= 0) bad.push(`${id}: its skeleton's wave dropped on read ${firstWave + dropped} while its page was still loading`);
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
