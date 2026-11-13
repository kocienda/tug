/**
 * at0791-skeleton-made-ahead.test.ts — a parked workspace's pages are made
 * ahead, hidden, once the shown workspace has painted, so a switch onto it
 * shows each card's own page, or its last frame, within the cut's bar.
 *
 * Two Text cards on a workspace never shown. After the home workspace has
 * painted, each away card must come to have a page of its own — painted,
 * not visible — without being shown. Then the switch, under the host's
 * layer rows: from the switch's start — its held picture going up, the
 * bar's own origin, else the dispatch — each away card must show its own
 * page or its last frame (a `lastFrame` row) within the bar: the hold's
 * `barMs`, else 100 ms. The made-ahead path runs as it ships; nothing holds
 * it off or asks for it.
 *
 * Until 2026-11-12 this asserted that no away card was ever faced, the
 * skeletons brief's [B06] "no gaps" rule. That rule is reversed (see the
 * dated note under [B06] in `briefs/workspace-skeletons-brief.md`): a
 * switch onto made-ahead pages cuts at the shell's
 * frame, and a page that has not confirmed by then shows its last frame or
 * its skeleton. So the assertion is now the one above.
 *
 * @covers tugapp/Sources/BodyLane.swift
 * @covers tugapp/Sources/BodyLifecycle.swift
 * @covers tugdeck/src/lib/body-make-ahead.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import {
  armLayers,
  AWAY_SPACE,
  firstPage,
  launchSkeletonDeck,
  readLayers,
  SHOULD_RUN,
  showsLastFrame,
  showsPage,
  switchTo,
  TEST_TIMEOUT_MS,
} from "./skeleton-switch-fixture";

const CARDS = ["sk791-a", "sk791-b"];
/** How long after home has painted the parked pages have to be made and painted. */
const AHEAD_MS = 6_000;
const WINDOW_MS = 600;
/** The bar until the host's account carries its own. */
const DEFAULT_BAR_MS = 100;

describe.skipIf(!SHOULD_RUN)("at0791 — a parked workspace made ahead", () => {
  test(
    "a parked workspace's cards have hidden painted pages before the switch, and the switch shows each one's page or last frame within the bar",
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
        const hold = ((await app.handOvers()).switchHolds ?? []).filter((h) => h.fromWall >= cut - 50).at(-1);
        note(`switch hold: ${hold === undefined ? "none" : JSON.stringify(hold)}`);
        for (const id of CARDS) {
          const stale = await app
            .body(id)
            .evalJS<{ parts: string[]; at: number } | null>("window.__tugBodyStale ?? null", { timeoutMs: 1_000 })
            .catch(() => null);
          note(`${id} stale parts: ${stale === null ? "none" : `${stale.parts.join(", ")} at ${Math.round(stale.at - cut)} ms from the switch`}`);
        }
        const bar = hold?.barMs ?? DEFAULT_BAR_MS;
        // The bar runs from the shell's start of the switch, which the held
        // picture records; the dispatch here leads it by the eval's trip.
        const start = hold?.fromWall ?? cut;
        note(`the switch started ${Math.round(start - cut)} ms after the dispatch`);
        for (const id of CARDS) {
          const first = rows
            .filter((r) => r.cardId === id && r.wall >= start && (showsPage(r) || showsLastFrame(r)))
            .sort((a, b) => a.wall - b.wall)[0];
          const at = first === undefined ? null : first.wall - start;
          if (at === null || at > bar) {
            bad.push(`${id}: its page or last frame showed ${at === null ? "never in the window" : `at ${Math.round(at)} ms`}, past the ${bar} ms bar`);
          }
        }
        expect(bad, "a switch onto pages made ahead shows each card's page or last frame within the bar").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
