/**
 * at0810-switch-cut-within-bar.test.ts — a switch onto made-ahead pages cuts
 * to the arriving workspace within the bar, however slow its pages are to
 * confirm.
 *
 * Home is one Text card; away is two Text cards, both made ahead. The
 * shell's switched frame is made 40 ms late (`switchFrameDelay`), and every
 * away page, shown again, waits a full second before it says `painted`
 * (`shownPaintDelayMs`). The switch's held picture must lift within the bar:
 * the host's `barMs` when its account carries one, else 100 ms. The 40 ms
 * leaves the shell's own frame, its snapshot and the lift's two host frames
 * the rest of the bar: on the harness deck the shell's snapshot answered at
 * a median 23 ms, max 31 (the arc's reading of the user-shaped deck).
 *
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import {
  AWAY_SPACE,
  holdFrom,
  launchSkeletonDeck,
  madeAhead,
  setSwitchFrameDelay,
  SHOULD_RUN,
  slowConfirm,
  switchTo,
  TEST_TIMEOUT_MS,
} from "./skeleton-switch-fixture";

const CARDS = ["sk810-a", "sk810-b"];
const FRAME_DELAY_MS = 40;
const CONFIRM_DELAY_MS = 1_000;
/** The bar until the host's account carries its own. */
const DEFAULT_BAR_MS = 100;

describe.skipIf(!SHOULD_RUN)("at0810 — the cut within the bar", () => {
  test(
    "a switch onto pages slow to confirm lifts its held picture within the bar",
    async () => {
      const deck = await launchSkeletonDeck("at0810-switch-cut-within-bar", CARDS);
      const { app } = deck;
      try {
        expect(await madeAhead(app, CARDS), "both away pages were made ahead").toBe(true);
        await setSwitchFrameDelay(app, FRAME_DELAY_MS);
        await slowConfirm(app, Object.fromEntries(CARDS.map((id) => [id, CONFIRM_DELAY_MS])));
        const cut = await switchTo(app, AWAY_SPACE);
        for (const id of CARDS) await settleFor(() => bodyOf(app, id), (b) => b?.painted === true && b.visible, 5_000);
        const hold = await settleFor(() => holdFrom(app, cut), (h) => h !== null && h.toWall !== null, 3_000);
        const bar = (hold as { barMs?: number } | null)?.barMs ?? DEFAULT_BAR_MS;
        note(`hold: ${hold === null ? "none" : `${hold.outcome}, held ${Math.round(hold.heldMs ?? -1)} ms, shell ${Math.round(hold.shellMs ?? -1)} ms, pages ${JSON.stringify(hold.pages ?? {})}`}; bar ${bar} ms`);
        expect(hold, "the switch held a picture").not.toBeNull();
        expect(hold?.heldMs ?? Infinity, `the cut lands within the ${bar} ms bar`).toBeLessThanOrEqual(bar);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
