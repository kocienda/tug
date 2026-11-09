/**
 * at0789-skeleton-set-holds.test.ts — no faced page shows before the set
 * lands: the real cards replace a switch's skeletons together, and a member
 * counts only once its content has painted, never at its chrome.
 *
 * Three Text cards on a workspace never shown; one page is made slow by
 * half a second, so its chrome paints with the others and its content
 * after, inside the set's horizon. The host's layer rows over the switch say
 * when each card first showed its own page, and the slow page's own lid,
 * read from the test every few milliseconds, says when its content painted.
 * No card may show its page before that, and the three must first show
 * within a display frame of one another. The switch
 * runs with the made-ahead path as it ships, cut as soon as home has
 * painted so the away pages are cold.
 *
 * @covers tugapp/Sources/BodyHandOver.swift
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import { SET_FRAME_MS } from "./body-grounding/_row-44";
import { armLayers, AWAY_SPACE, bodyLidWave, firstPage, launchSkeletonDeck, readLayers, revealLog, SHOULD_RUN, slowPages, switchTo, TEST_TIMEOUT_MS } from "./skeleton-switch-fixture";

const CARDS = ["sk789-a", "sk789-b", "sk789-slow"];
const SLOW = "sk789-slow";
const SLOW_MS = 500;
/** How finely the slow page's lid is read: the test's own round trip to the page. */
const LID_POLL_MS = 10;
const WINDOW_MS = 2_600;

describe.skipIf(!SHOULD_RUN)("at0789 — the set holds until its last content paint", () => {
  test(
    "no faced page shows before the slow member's content, and the set shows in one frame",
    async () => {
      const deck = await launchSkeletonDeck("at0789-skeleton-set-holds", CARDS);
      const { app } = deck;
      try {
        await slowPages(app, { [SLOW]: SLOW_MS });
        await armLayers(app, WINDOW_MS);
        await Bun.sleep(50);
        const cut = await switchTo(app, AWAY_SPACE);
        // When the slow page's lid lifts, by its own word: the moment its content painted.
        let unlidded: number | null = null;
        while (unlidded === null && Date.now() - cut < WINDOW_MS) {
          const lid = await bodyLidWave(app, SLOW);
          if (lid !== null && !lid.lidded) unlidded = Date.now() - cut;
          else await Bun.sleep(LID_POLL_MS);
        }
        for (const id of CARDS) await settleFor(() => bodyOf(app, id), (b) => b?.painted === true && b.visible, 10_000);
        const rows = await readLayers(app, WINDOW_MS);
        expect(rows, "the host's layer rows finished").not.toBeNull();
        const shown = firstPage(rows ?? [], CARDS, cut);
        note(`first page shown: ${CARDS.map((id) => `${id} ${shown[id] === null ? "never" : `${Math.round(shown[id] as number)} ms`}`).join("; ")}`);
        note(`reveal set: ${(await revealLog(app, cut)).join("; ") || "nothing"}`);
        note(`${SLOW}'s lid lifted ${unlidded === null ? "not in the window" : `by ${unlidded} ms`}`);
        const bad: string[] = [];
        if (unlidded === null) bad.push(`${SLOW}: its lid never lifted in the window`);
        // A frame and the poll's own resolution: the lid is read a little after it lifts.
        const contentAt = (unlidded ?? WINDOW_MS) - SET_FRAME_MS - 2 * LID_POLL_MS;
        for (const id of CARDS) {
          const at = shown[id];
          if (at === null) bad.push(`${id}: its page never showed in the window`);
          else if (at < contentAt) bad.push(`${id}: its page showed at ${Math.round(at)} ms, before ${SLOW}'s content painted at ${unlidded} ms`);
        }
        const times = Object.values(shown).filter((v): v is number => v !== null);
        if (times.length > 1 && Math.max(...times) - Math.min(...times) > SET_FRAME_MS) {
          bad.push(`the set's pages first showed across ${Math.round(Math.max(...times) - Math.min(...times))} ms, not one frame`);
        }
        expect(bad, "the set lands as one picture, on its last content paint").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
