/**
 * at0818-stage-skeletons.test.ts — the cut onto a workspace whose pages were
 * never made shows a skeleton for each card, and each card's skeleton comes
 * down at its own page's paint, on its own.
 *
 * Two Text cards on a workspace never shown, in a theme other than home's,
 * with the make-ahead pass held so neither has a page before the switch.
 * Their pages are made slow by different amounts (`contentPaintDelayMs`):
 * 600 ms and 2.4 s. The host's `stages` account must show both cards with no
 * page and its stage grounded before the switch, record the cut onto the
 * workspace with each card's picture a skeleton, and, read every 50 ms from
 * the switch, show the fast card live while the slow card is still its
 * skeleton — the slow card's skeleton coming down at least a second later.
 * No card's skeleton waits on another card's page.
 *
 * A burst of window frames across the cut is written under the temp
 * directory and noted, for reading the grounds and skeletons by eye.
 *
 * @covers tugapp/Sources/BodyStages.swift
 * @covers tugdeck/src/lib/body-make-ahead.ts
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import type { CaptureBurstReading } from "./_harness/client";
import { settleFor } from "./body-grounding/_bodies";
import {
  AWAY_SPACE,
  chooseSpaceTheme,
  cutOnto,
  launchSkeletonDeck,
  sampleStages,
  SHOULD_RUN,
  slowPages,
  stageCards,
  switchTo,
  TEST_TIMEOUT_MS,
} from "./skeleton-switch-fixture";

const FAST = "sk818-fast";
const SLOW = "sk818-slow";
const CARDS = [FAST, SLOW];
const FAST_MS = 600;
const SLOW_MS = 2_400;
/** How much later the slow card must land than the fast one: well inside the gap between their delays. */
const APART_MS = 1_000;
const READ_MS = 4_500;

/** One letter per read: L live, F last frame, S skeleton, - unread. */
const mark = (p: string | null | undefined): string => (p === "live" ? "L" : p === "lastFrame" ? "F" : p === "skeleton" ? "S" : "-");

describe.skipIf(!SHOULD_RUN)("at0818 — a cold workspace's cards stand as skeletons, each landing alone", () => {
  test(
    "the cut shows a skeleton per unmade card, and each comes down at its own page's paint",
    async () => {
      const deck = await launchSkeletonDeck("at0818-stage-skeletons", CARDS, { holdMakeAhead: true });
      const { app } = deck;
      try {
        await chooseSpaceTheme(app, AWAY_SPACE, "sloop");
        await slowPages(app, { [FAST]: FAST_MS, [SLOW]: SLOW_MS });
        const before = await settleFor(
          () => app.stages(),
          (s) => s.stages.some((st) => st.id === AWAY_SPACE && st.grounded && CARDS.every((id) => st.cards.some((c) => c.cardId === id))),
          5_000,
        );
        const away = before.stages.find((st) => st.id === AWAY_SPACE);
        note(`before the switch: ${away === undefined ? "no away stage" : `away stage ${away.theme ?? "no theme"}, grounded ${away.grounded}, ${away.cards.map((c) => `${c.cardId} ${c.picture} body ${c.hasBody}`).join(", ")}`}`);
        expect(away?.grounded, "the parked workspace has a stage, grounded").toBe(true);
        const unmade = await stageCards(app, CARDS);
        expect(CARDS.filter((id) => unmade[id]?.hasBody === true), "with the make-ahead pass held, no away card has a page before the switch").toEqual([]);

        const outDir = join(tmpdir(), `at0818-frames-${Date.now()}`);
        const width = await app.evalJS<number>("window.innerWidth");
        const height = await app.evalJS<number>("window.innerHeight");
        await app.captureBurst({ op: "arm", durationMs: 1_200, intervalMs: 100, crop: { x: 0, y: 0, width, height }, outDir });
        await Bun.sleep(150);
        const cut = await switchTo(app, AWAY_SPACE);
        const reads = await sampleStages(app, CARDS, READ_MS, 50);
        const burst = (await settleFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 5_000)) as CaptureBurstReading;
        note(`window frames across the cut: ${burst.frames.length} under ${outDir}`);

        const record = await cutOnto(app, AWAY_SPACE, cut);
        note(`the cut: ${record === null ? "none recorded" : `${record.from} → ${record.to}, pictures ${JSON.stringify(record.pictures)}`}`);
        const bad: string[] = [];
        for (const id of CARDS) {
          if (record?.pictures[id] !== "skeleton") bad.push(`${id}: stood as ${record?.pictures[id] ?? "nothing"} at the cut, not its skeleton`);
        }
        const liveAt: Record<string, number | null> = {};
        for (const id of CARDS) {
          note(`${id}, every 50 ms from the switch: ${reads.map((r) => mark(r.cards[id]?.picture)).join("")}`);
          const live = reads.find((r) => r.cards[id]?.picture === "live");
          liveAt[id] = live === undefined ? null : live.wall - cut;
        }
        note(`landed live: ${CARDS.map((id) => `${id} ${liveAt[id] === null ? "never" : `${liveAt[id]} ms`}`).join("; ")}`);
        const fast = liveAt[FAST];
        const slow = liveAt[SLOW];
        if (fast === null || slow === null) {
          bad.push(`a card never landed live in ${READ_MS} ms: ${FAST} ${fast}, ${SLOW} ${slow}`);
        } else {
          if (slow - fast < APART_MS) bad.push(`${SLOW} landed ${slow - fast} ms after ${FAST}, not on its own page's later paint`);
          const atFast = reads.find((r) => r.wall - cut === fast);
          if (atFast?.cards[SLOW]?.picture !== "skeleton") bad.push(`when ${FAST} landed, ${SLOW} was ${atFast?.cards[SLOW]?.picture ?? "unread"}, not still its skeleton`);
        }
        expect(bad, "each unmade card stands as its skeleton at the cut and lands at its own page's paint").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
