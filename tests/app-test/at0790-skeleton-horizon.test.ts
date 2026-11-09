/**
 * at0790-skeleton-horizon.test.ts — past the set's horizon the cards that
 * have painted land together in one frame, and a straggler keeps its
 * skeleton until its own content paints, then lands alone.
 *
 * Three Text cards on a workspace never shown; one page is made slow by
 * 3.5 s, well past the 2 s horizon, so its chrome paints with the others and
 * its content long after. The host's layer rows over the switch say when
 * each card first showed its own page. The two that painted must first
 * show within a display frame of each other, at the horizon — which runs
 * from the set's opening at the hand-over, read off the host's reveal log.
 * The straggler
 * must show no page of its own before its content could have painted — the
 * cut plus its delay — so through the horizon it stays the skeleton, and it
 * shows its page after. The switch runs with the made-ahead path as it
 * ships, cut as soon as home has painted so the away pages are cold.
 *
 * @covers tugapp/Sources/BodyHandOver.swift
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import { SET_FRAME_MS, SET_HORIZON_MS } from "./body-grounding/_row-44";
import { armLayers, AWAY_SPACE, firstPage, launchSkeletonDeck, readLayers, revealLog, SHOULD_RUN, slowPages, switchTo, TEST_TIMEOUT_MS } from "./skeleton-switch-fixture";

const PAINTED = ["sk790-a", "sk790-b"];
const SLOW = "sk790-slow";
const CARDS = [...PAINTED, SLOW];
const SLOW_MS = 3_500;
const WINDOW_MS = 4_800;
/** How late after the horizon the painted cards may land: the horizon's own timer and a frame or two. */
const HORIZON_SLACK_MS = 120;

describe.skipIf(!SHOULD_RUN)("at0790 — the horizon lands the painted cards and leaves the straggler", () => {
  test(
    "the painted cards land as one at the horizon, and the straggler stays a skeleton until its content paints",
    async () => {
      const deck = await launchSkeletonDeck("at0790-skeleton-horizon", CARDS);
      const { app } = deck;
      try {
        await slowPages(app, { [SLOW]: SLOW_MS });
        await armLayers(app, WINDOW_MS);
        await Bun.sleep(50);
        const cut = await switchTo(app, AWAY_SPACE);
        for (const id of CARDS) await settleFor(() => bodyOf(app, id), (b) => b?.painted === true && b.visible, 10_000);
        const rows = await readLayers(app, WINDOW_MS);
        expect(rows, "the host's layer rows finished").not.toBeNull();
        const shown = firstPage(rows ?? [], CARDS, cut);
        note(`first page shown: ${CARDS.map((id) => `${id} ${shown[id] === null ? "never" : `${Math.round(shown[id] as number)} ms`}`).join("; ")}`);
        const log = await revealLog(app, cut);
        note(`reveal set: ${log.join("; ") || "nothing"}`);
        // The host's horizon runs from the set's opening, at the hand-over.
        const opened = log.map((line) => line.match(/^(\d+) ms open/)).find((m) => m !== null);
        const horizon = (opened === undefined || opened === null ? 0 : Number(opened[1])) + SET_HORIZON_MS;
        note(`the set opened ${opened?.[1] ?? "?"} ms after the cut; its horizon falls at ${horizon} ms`);
        const bad: string[] = [];
        const painted = PAINTED.map((id) => shown[id]);
        if (painted.some((v) => v === null)) {
          bad.push(`a painted card never showed its page: ${PAINTED.map((id) => `${id} ${shown[id]}`).join(", ")}`);
        } else {
          const ts = painted as number[];
          if (Math.max(...ts) - Math.min(...ts) > SET_FRAME_MS) bad.push(`the painted cards landed across ${Math.round(Math.max(...ts) - Math.min(...ts))} ms, not one frame`);
          for (const [i, t] of ts.entries()) {
            if (t < horizon - SET_FRAME_MS || t > horizon + HORIZON_SLACK_MS) {
              bad.push(`${PAINTED[i]} landed at ${Math.round(t)} ms, not at the horizon at ${horizon} ms`);
            }
          }
        }
        const late = shown[SLOW];
        if (late === null) bad.push(`${SLOW}: its page never showed in the window`);
        else if (late < SLOW_MS) bad.push(`${SLOW}: its page showed at ${Math.round(late)} ms, before its content could paint at ${SLOW_MS} ms — the horizon took its skeleton down`);
        expect(bad, "the horizon lands the painted set as one and the straggler keeps its skeleton").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
