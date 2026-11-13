/**
 * at0809-switch-cut-page-unconfirmed.test.ts — a switch onto made-ahead
 * pages, one of which is slow to say it has drawn as shown, shows nothing of
 * the departed workspace, and the slow card is never left bare.
 *
 * Home is one Text card across the window; away is two Text cards side by
 * side, both made ahead. One away card's page, shown again, waits 1.5 s
 * before it says `painted` (`shownPaintDelayMs`). Under the host's layer
 * rows:
 *
 * - from the switch's start (its held picture going up, or the dispatch when
 *   none stands), no row shows the departing card's page outside a held
 *   picture;
 * - before the switch, the host keeps the slow card's last frame (a park
 *   cover, taken after the theme move in the second arm);
 * - from the held picture's lift on, the slow card stands under that last
 *   frame until its page confirms, and shows its page from then: never
 *   hidden with nothing over it, and never its last frame again after.
 *
 * A second arm moves the away workspace's theme while it is parked, then
 * switches, and asserts the same: a page whose facts moved while hidden is
 * the one a switch cannot show as it stands.
 *
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 * @covers tugapp/Sources/BodyLifecycle.swift
 * @covers tugapp/Sources/BodyCovers.swift
 * @covers tugdeck/src/body/body-main.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { bodyOf, settleFor } from "./body-grounding/_bodies";
import {
  armLayers,
  AWAY_SPACE,
  chooseSpaceTheme,
  HOME_CARD,
  holdFrom,
  launchSkeletonDeck,
  madeAhead,
  readLayers,
  SHOULD_RUN,
  showsDeparted,
  showsLastFrame,
  showsPage,
  slowConfirm,
  switchTo,
  TEST_TIMEOUT_MS,
} from "./skeleton-switch-fixture";

const SLOW = "sk809-a";
const CARDS = [SLOW, "sk809-b"];
const CONFIRM_DELAY_MS = 1_500;
const WINDOW_MS = 2_000;

/** How long the host has to take the slow card's last frame once its page is hidden. */
const COVER_MS = 6_000;

/** Wait for the host to keep a last frame of the slow card taken after `since`, wall ms; false if none came. */
async function parkCoverTaken(app: App, since: number): Promise<boolean> {
  const account = await settleFor(
    () => app.handOvers(),
    (a) => (a.parkCovers?.cards[SLOW]?.takenAt ?? 0) > since,
    COVER_MS,
  );
  const kept = account.parkCovers?.cards[SLOW];
  note(`${SLOW} park cover: ${kept === undefined ? "none" : `${kept.bytes} bytes, taken ${Math.round(kept.takenAt - since)} ms after the wait began`}; parked total ${account.parkCovers?.bytes ?? 0} bytes`);
  return kept !== undefined && kept.takenAt > since;
}

/** Switch away under the layer rows and say what was wrong with them. */
async function judgeSwitch(app: App): Promise<string[]> {
  await armLayers(app, WINDOW_MS);
  await Bun.sleep(50);
  const cut = await switchTo(app, AWAY_SPACE);
  await settleFor(() => bodyOf(app, CARDS[1]), (b) => b?.painted === true && b.visible, 5_000);
  const rows = (await readLayers(app, WINDOW_MS)) ?? [];
  const hold = await holdFrom(app, cut);
  const start = hold?.fromWall ?? cut;
  const lift = hold?.toWall ?? cut;
  note(`hold: ${hold === null ? "none" : `${hold.outcome}, held ${Math.round(hold.heldMs ?? -1)} ms, covered ${hold.covered ?? "?"}, pages ${JSON.stringify(hold.pages ?? {})}`}`);
  const bad: string[] = [];
  const departed = rows.filter((r) => r.wall >= start && showsDeparted(r, new Set([HOME_CARD])));
  if (departed.length > 0) bad.push(`${HOME_CARD}: its page showed un-held for ${departed.length} rows, first at ${Math.round(departed[0].wall - start)} ms`);
  const slowRows = rows.filter((r) => r.cardId === SLOW && r.wall >= lift).sort((a, b) => a.wall - b.wall);
  if (slowRows.length === 0) bad.push(`${SLOW}: no row after the lift`);
  const bare = slowRows.filter((r) => !showsPage(r) && !showsLastFrame(r));
  if (bare.length > 0) {
    bad.push(`${SLOW}: ${bare.length} rows after the lift showed neither its page nor its last frame, first at ${Math.round(bare[0].wall - lift)} ms past it`);
  }
  // Under its last frame from the lift until its page confirms, and its page from then.
  const firstPage = slowRows.findIndex((r) => !r.lastFrame && showsPage(r));
  if (slowRows.length > 0 && !showsLastFrame(slowRows[0])) bad.push(`${SLOW}: its first row after the lift was not its last frame`);
  const coverAfter = firstPage < 0 ? [] : slowRows.slice(firstPage).filter((r) => r.lastFrame === true);
  if (coverAfter.length > 0) bad.push(`${SLOW}: its last frame stood again ${coverAfter.length} rows after its page had shown`);
  const lastFrameMs = firstPage < 0 ? null : Math.round(slowRows[firstPage].wall - lift);
  note(`${SLOW}: under its last frame for ${slowRows.filter((r) => r.lastFrame === true).length} rows, its page from ${lastFrameMs ?? "never"} ms past the lift`);
  return bad;
}

describe.skipIf(!SHOULD_RUN)("at0809 — a switch onto a page slow to confirm", () => {
  test(
    "nothing of the departed workspace shows, and the slow card shows its page or its last frame from the lift",
    async () => {
      const deck = await launchSkeletonDeck("at0809-switch-cut-page-unconfirmed", CARDS);
      try {
        expect(await madeAhead(deck.app, CARDS), "both away pages were made ahead").toBe(true);
        await slowConfirm(deck.app, { [SLOW]: CONFIRM_DELAY_MS });
        expect(await parkCoverTaken(deck.app, 0), "the host kept the slow card's last frame").toBe(true);
        expect(await judgeSwitch(deck.app), "a page that has not confirmed never leaves its pane bare").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the same, when the away workspace's theme moved while it was parked",
    async () => {
      const deck = await launchSkeletonDeck("at0809-switch-cut-page-unconfirmed-theme", CARDS);
      try {
        expect(await madeAhead(deck.app, CARDS), "both away pages were made ahead").toBe(true);
        await slowConfirm(deck.app, { [SLOW]: CONFIRM_DELAY_MS });
        const moved = Date.now();
        await chooseSpaceTheme(deck.app, AWAY_SPACE, "sloop");
        expect(await parkCoverTaken(deck.app, moved), "the host kept a last frame of the slow card taken after its theme moved").toBe(true);
        expect(await judgeSwitch(deck.app), "a page whose theme moved while parked never leaves its pane bare").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
