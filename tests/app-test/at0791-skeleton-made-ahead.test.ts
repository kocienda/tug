/**
 * at0791-skeleton-made-ahead.test.ts — a parked workspace's pages are made
 * ahead, hidden, once the shown workspace has painted, so a switch onto it
 * shows the real cards at the cut and no skeleton at all.
 *
 * Two Text cards on a workspace never shown. After the home workspace has
 * painted, each away card must come to have a page of its own — painted,
 * not visible — without being shown. Then the switch, under the host's
 * layer rows: no away card may be faced, and each must show its own page
 * within the cut's commit time. The made-ahead path runs as it ships;
 * nothing holds it off or asks for it.
 *
 * @covers tugapp/Sources/BodyLane.swift
 * @covers tugapp/Sources/BodyLifecycle.swift
 * @covers tugdeck/src/lib/body-make-ahead.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import { armLayers, AWAY_SPACE, firstPage, launchSkeletonDeck, readLayers, SHOULD_RUN, switchTo, TEST_TIMEOUT_MS } from "./skeleton-switch-fixture";

const CARDS = ["sk791-a", "sk791-b"];
/** How long after home has painted the parked pages have to be made and painted. */
const AHEAD_MS = 6_000;
const WINDOW_MS = 600;
/** How long after the cut a page already made may take to show: the switch's commit and a frame. */
const CUT_MS = 120;

describe.skipIf(!SHOULD_RUN)("at0791 — a parked workspace made ahead", () => {
  test(
    "a parked workspace's cards have hidden painted pages before the switch, and the switch shows no skeleton",
    async () => {
      const deck = await launchSkeletonDeck("at0791-skeleton-made-ahead", CARDS);
      const { app } = deck;
      try {
        const bad: string[] = [];
        const ahead = await settleFor(
          () => Promise.all(CARDS.map((id) => bodyOf(app, id))),
          (all) => all.every((s) => s?.state === "ready" && s.painted === true),
          AHEAD_MS,
        );
        for (const [i, id] of CARDS.entries()) {
          const b = ahead[i];
          note(`${id} before the switch: ${b === null ? "no page" : `${b.state}, painted ${b.painted}, visible ${b.visible}`}`);
          if (b === null || b.painted !== true) bad.push(`${id}: no page was made ahead for it in ${AHEAD_MS} ms after home painted`);
          else if (b.visible) bad.push(`${id}: its page made ahead was shown before the switch`);
        }
        await armLayers(app, WINDOW_MS);
        await Bun.sleep(50);
        const cut = await switchTo(app, AWAY_SPACE);
        for (const id of CARDS) await settleFor(() => bodyOf(app, id), (b) => b?.painted === true && b.visible, 10_000);
        const rows = (await readLayers(app, WINDOW_MS)) ?? [];
        const shown = firstPage(rows, CARDS, cut);
        note(`first page shown: ${CARDS.map((id) => `${id} ${shown[id] === null ? "never" : `${Math.round(shown[id] as number)} ms`}`).join("; ")}`);
        for (const id of CARDS) {
          const faced = rows.filter((r) => r.cardId === id && r.wall >= cut && r.faced);
          if (faced.length > 0) bad.push(`${id}: the switch faced it for ${faced.length} rows — a skeleton was seen`);
          const at = shown[id];
          if (at === null || at > CUT_MS) bad.push(`${id}: its page showed ${at === null ? "never in the window" : `at ${Math.round(at)} ms`}, not at the cut`);
        }
        expect(bad, "a switch onto pages made ahead lands the real cards at the cut").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
