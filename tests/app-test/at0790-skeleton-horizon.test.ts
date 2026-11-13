/**
 * at0790-skeleton-horizon.test.ts — a picture over a page that has painted
 * before comes down at its horizon, and a skeleton over a page that never
 * has stays until that page paints.
 *
 * Three workspaces of Text cards, the make-ahead pass held so nothing is
 * made but what a switch asks for. One card on `away` is shown once and
 * painted, then parked until it sleeps; its page, shown again, is made to
 * wait 3.5 s before it says it painted, well past the 2 s horizon. At the
 * switch back onto it the host stands its last frame or its skeleton, and
 * that picture must come down at the horizon — between 1.7 s and 3 s after
 * the cut — not at the slow page's paint: the card is shown as its page
 * stands rather than as a picture nobody can see past.
 *
 * One card on `cold` was never made, its page made slow by 3.5 s: at the
 * switch onto it the host stands its skeleton, and that skeleton must still
 * stand 2.5 s on, past the horizon, since its page has nothing to reveal.
 *
 * @covers tugapp/Sources/BodyStages.swift
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import {
  AWAY_SPACE,
  COLD_SPACE,
  HOME_SPACE,
  launchSkeletonDeck,
  sampleStages,
  SHOULD_RUN,
  slowConfirm,
  slowPages,
  switchTo,
  TEST_TIMEOUT_MS,
} from "./skeleton-switch-fixture";

const SEEN = "sk790-seen";
const COLD = "sk790-cold";
const SLOW_MS = 3_500;
/** The host's horizon ([P11]), with a read's slack either side. */
const HORIZON_EARLIEST_MS = 1_700;
const HORIZON_LATEST_MS = 3_000;
const DORMANT_MS = 300;

/** One letter per read: L live, F last frame, S skeleton, - unread. */
const mark = (p: string | null | undefined): string => (p === "live" ? "L" : p === "lastFrame" ? "F" : p === "skeleton" ? "S" : "-");

describe.skipIf(!SHOULD_RUN)("at0790 — a picture over a painted page has a horizon", () => {
  test(
    "a slept card's picture comes down at the horizon; a never-made card's skeleton stays past it",
    async () => {
      const deck = await launchSkeletonDeck("at0790-skeleton-horizon", [SEEN], { cold: [COLD], holdMakeAhead: true });
      const { app } = deck;
      try {
        // Seen once, painted, then parked until it sleeps.
        await switchTo(app, AWAY_SPACE);
        const seen = await settleFor(() => bodyOf(app, SEEN), (b) => b?.painted === true && b.visible, 10_000);
        expect(seen?.painted, `${SEEN}: shown and painted once`).toBe(true);
        await app.bodyDelays({ dormantAfterMs: DORMANT_MS, pageDormantAfterMs: DORMANT_MS });
        await slowConfirm(app, { [SEEN]: SLOW_MS });
        await slowPages(app, { [COLD]: SLOW_MS });
        await switchTo(app, HOME_SPACE);
        await Bun.sleep(DORMANT_MS + 400);

        // Back onto the slept card: its picture comes down at the horizon.
        const back = await switchTo(app, AWAY_SPACE);
        const seenRows = await sampleStages(app, [SEEN], HORIZON_LATEST_MS + 200, 50);
        note(`${SEEN} from the switch back, every 50 ms: ${seenRows.map((r) => mark(r.cards[SEEN]?.picture)).join("")} (L live, F last frame, S skeleton)`);
        const bad: string[] = [];
        const firstPicture = seenRows.findIndex((r) => r.cards[SEEN]?.picture === "lastFrame" || r.cards[SEEN]?.picture === "skeleton");
        if (firstPicture < 0) bad.push(`${SEEN}: no picture stood over it after it slept`);
        const live = seenRows.slice(Math.max(0, firstPicture)).find((r) => r.cards[SEEN]?.picture === "live");
        if (live === undefined) {
          bad.push(`${SEEN}: its picture never came down in ${HORIZON_LATEST_MS} ms`);
        } else {
          const at = live.wall - back;
          note(`${SEEN}: shown as its page stands ${at} ms after the switch`);
          if (at < HORIZON_EARLIEST_MS) bad.push(`${SEEN}: its picture came down at ${at} ms, before the horizon and before its page painted`);
          if (at > HORIZON_LATEST_MS) bad.push(`${SEEN}: its picture came down at ${at} ms, past the horizon`);
        }

        // Onto the never-made card: its skeleton stands past the horizon.
        const cold = await switchTo(app, COLD_SPACE);
        const coldRows = await sampleStages(app, [COLD], 2_500, 100);
        note(`${COLD} from its switch, every 100 ms: ${coldRows.map((r) => mark(r.cards[COLD]?.picture)).join("")}`);
        const last = coldRows.at(-1);
        if (last === undefined || last.cards[COLD]?.picture !== "skeleton") {
          bad.push(`${COLD}: ${last === undefined ? "never read" : `read ${last.cards[COLD]?.picture} ${last.wall - cold} ms on`}, not its skeleton past the horizon`);
        }
        expect(bad, "a picture over a painted page has a horizon; a skeleton over an unpainted one has none").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
