/**
 * at0808-switch-cut-shell-late.test.ts — with the shell's switched frame
 * late, a switch onto made-ahead pages shows nothing of the departed
 * workspace once the switch has begun.
 *
 * Home is one Text card across the window; away is two Text cards side by
 * side, so the departing view's rect is taken by neither arriving view —
 * the shape the shell's placer keeps a departing view shown for two of its
 * paints. Both away pages are made ahead. The shell's switched frame is made
 * 200 ms late (`switchFrameDelay`), which delays its render and its
 * placement together. Under the host's layer rows, from the switch's start
 * (its held picture going up, or the dispatch when none stands):
 *
 * - no row shows the departing card's page outside a held picture;
 * - each away card's first row outside a held picture shows its own page or
 *   a host face, never bare canvas.
 *
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import {
  armLayers,
  AWAY_SPACE,
  HOME_CARD,
  holdFrom,
  launchSkeletonDeck,
  madeAhead,
  readLayers,
  setSwitchFrameDelay,
  SHOULD_RUN,
  showsDeparted,
  showsPage,
  switchTo,
  TEST_TIMEOUT_MS,
} from "./skeleton-switch-fixture";

const CARDS = ["sk808-a", "sk808-b"];
const FRAME_DELAY_MS = 200;
const WINDOW_MS = 800;

describe.skipIf(!SHOULD_RUN)("at0808 — a switch with the shell's frame late", () => {
  test(
    "nothing of the departed workspace shows once the switch has begun, and each arriving card shows its page or a face",
    async () => {
      const deck = await launchSkeletonDeck("at0808-switch-cut-shell-late", CARDS);
      const { app } = deck;
      try {
        expect(await madeAhead(app, CARDS), "both away pages were made ahead").toBe(true);
        await setSwitchFrameDelay(app, FRAME_DELAY_MS);
        await armLayers(app, WINDOW_MS);
        await Bun.sleep(50);
        const cut = await switchTo(app, AWAY_SPACE);
        for (const id of CARDS) await settleFor(() => bodyOf(app, id), (b) => b?.painted === true && b.visible, 5_000);
        const rows = (await readLayers(app, WINDOW_MS)) ?? [];
        const hold = await holdFrom(app, cut);
        const start = hold?.fromWall ?? cut;
        note(`hold: ${hold === null ? "none" : `${hold.outcome}, held ${Math.round(hold.heldMs ?? -1)} ms, shell ${Math.round(hold.shellMs ?? -1)} ms`}`);
        const bad: string[] = [];
        const departed = rows.filter((r) => r.wall >= start && showsDeparted(r, new Set([HOME_CARD])));
        if (departed.length > 0) {
          bad.push(`${HOME_CARD}: its page showed un-held for ${departed.length} rows, first at ${Math.round(departed[0].wall - start)} ms`);
        }
        for (const id of CARDS) {
          const first = rows.filter((r) => r.cardId === id && r.wall >= start && r.held !== true).sort((a, b) => a.wall - b.wall)[0];
          if (first === undefined) bad.push(`${id}: no row outside a held picture in the window`);
          else if (!showsPage(first) && !first.faced) {
            bad.push(`${id}: its first row outside a held picture, at ${Math.round(first.wall - start)} ms, showed neither its page nor a face`);
          }
        }
        expect(bad, "the switch shows the departed workspace or the arriving one, never a piece of the departed one").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
