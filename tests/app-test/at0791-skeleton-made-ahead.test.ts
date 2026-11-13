/**
 * at0791-skeleton-made-ahead.test.ts — a parked workspace's pages are made
 * ahead, hidden, once the shown workspace has painted, so the cut onto it
 * shows each card's own page or its last frame — never a skeleton.
 *
 * Two Text cards on a workspace never shown. After the home workspace has
 * painted, each away card must come to have a page of its own — painted,
 * not visible — without being shown, and the host must hold a picture for
 * it in its parked stage that is its page or the last frame taken as the
 * page went to sleep. Then the switch: the host's record of the cut onto
 * the away workspace must name each card `live` or `lastFrame`. The
 * made-ahead path runs as it ships; nothing holds it off or asks for it.
 *
 * Until 2026-11-12 this asserted that no away card was ever faced, the
 * skeletons brief's [B06] "no gaps" rule; until the workspace stages it
 * read each card's page or last frame off the host's layer rows within the
 * switch hold's bar. A cut is now one transaction that shows whatever each
 * arriving card's picture already is, chosen by the host's picture policy,
 * so the claim is the picture at the cut itself.
 *
 * @covers tugapp/Sources/BodyLane.swift
 * @covers tugapp/Sources/BodyLifecycle.swift
 * @covers tugapp/Sources/BodyStages.swift
 * @covers tugdeck/src/lib/body-make-ahead.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import { AWAY_SPACE, cutOnto, launchSkeletonDeck, SHOULD_RUN, stageCards, switchTo, TEST_TIMEOUT_MS } from "./skeleton-switch-fixture";

const CARDS = ["sk791-a", "sk791-b"];
/** How long after home has painted the parked pages have to be made and painted. */
const AHEAD_MS = 6_000;

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
        // The host's picture for each in its parked stage: its page, or its
        // last frame once the page has gone to sleep.
        const parked = await settleFor(
          () => stageCards(app, CARDS),
          (all) => CARDS.every((id) => all[id]?.picture === "live" || all[id]?.picture === "lastFrame"),
          AHEAD_MS,
        );
        note(`parked pictures: ${CARDS.map((id) => `${id} ${parked[id]?.picture ?? "none"}`).join("; ")}`);
        // What a parked page said moved under it, and what the host did with its last frame.
        for (const id of CARDS) {
          const stale = await app
            .body(id)
            .evalJS<{ parts: string[]; at: number } | null>("window.__tugBodyStale ?? null", { timeoutMs: 1_000 })
            .catch(() => null);
          note(`${id} stale parts: ${stale === null ? "none" : stale.parts.join(", ")}`);
        }
        const hostLines = app
          .tugappLog()
          .split("\n")
          .filter((line) => CARDS.some((id) => line.includes(id)) && /stale|park cover|cover dropped|dormant/.test(line));
        note(`host lines: ${hostLines.map((l) => l.replace(/^.*?bodies\s*/, "")).join(" | ") || "none"}`);
        const kept = (await app.stages()).parkCovers.cards;
        note(`last frames kept: ${CARDS.map((id) => `${id} ${kept[id] === undefined ? "none" : `${kept[id].bytes} bytes`}`).join("; ")}`);
        const cut = await switchTo(app, AWAY_SPACE);
        const record = await settleFor(() => cutOnto(app, AWAY_SPACE, cut), (c) => c !== null, 5_000);
        note(`the cut: ${record === null ? "none recorded" : JSON.stringify(record)}`);
        for (const id of CARDS) {
          const picture = record?.pictures[id];
          if (picture !== "live" && picture !== "lastFrame") bad.push(`${id}: stood as ${picture ?? "nothing"} at the cut, not its page or its last frame`);
        }
        expect(bad, "a cut onto pages made ahead shows each card's page or last frame").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
