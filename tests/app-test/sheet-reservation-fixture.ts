/**
 * sheet-reservation-fixture.ts — the constants, the launch and the store
 * readers the at0569-sheet-reservation* files share.
 *
 * `at0569-sheet-reservation` carries the seeded-bid tests and
 * `-measured` the production-path one, split to fit the 20 s file budget: the
 * three tests ran 17–18 s together when they were green, and the Roomy 15px
 * card gap's arrival put the file on the budget's edge.
 *
 * @module tests/app-test/sheet-reservation-fixture
 */

import { launchTugApp, type App } from "./_harness";
import { testTmpDir } from "./_harness/test-cleanup";
import {
  mkTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { IMPOSITION_GAP_PX } from "../../tugdeck/src/lib/layout-imposer";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/** The settle window, with room for the tween to land. */
export const AFTER_LAND_MS = 900;

/**
 * How far the deck's claim may sit from a fresh reading of the panel.
 *
 * The two use the IDENTICAL formula — `scrollHeight` plus borders plus margins
 * — so this is not a tolerance on the arithmetic. It is a tolerance on WHEN:
 * the sheet reports on change and re-measures from a `ResizeObserver` on the
 * panel's own box, and a late content reflow that changes `scrollHeight`
 * without changing that box does not re-fire it. So the standing claim can be
 * a pixel or two behind a reading taken afterwards.
 *
 * What the assertion is for survives it whole: the alternatives a wrong number
 * would be — the card's floor, the frame's height, nothing at all — are tens or
 * hundreds of pixels away, not two.
 */
export const REPORTER_DRIFT = 3;

/**
 * How far a MEASURED bid may sit from a fresh reading of the panel it was
 * measured off.
 *
 * Tighter than {@link REPORTER_DRIFT} on purpose, and the tightness is the
 * claim: the bid and the live report come from the identical component through
 * the identical formula, taken a second apart with nothing between them but
 * the commit that appended the pane. Sub-pixel layout rounding is the whole of
 * what may differ. A looser bar here would let a bid that was merely CLOSE
 * pass, and close is what a constant is.
 */
export const MEASURED_BID_DRIFT = 1;

/**
 * What the deck adds between a sheet's panel and the member under it —
 * `memberFloorForSheetPanel`'s sum, copied for the reason every other constant
 * here is: `--jsx` is off for app-tests, so nothing under `components/` can be
 * imported, and `lib/sheet-reservation.ts` reaches the card registry through
 * the `@` alias these files do not resolve.
 *
 * 37 (the pane's title bar and the 1px its sheet clip drops below it) + 32
 * (`SHEET_CANVAS_GAP`) − the card gap (`IMPOSITION_GAP_PX`, already under a
 * column's last member). A copy that drifts fails the assertions rather
 * than passing quietly — and the card gap is the one term that is not a
 * constant at all: it is the default `IMPOSITION_GAP_PX`, imported, because
 * the Roomy 15px default (`5fa88c72a`) moved it from 10 and a typed 64 then
 * read every claim 10px off.
 */
export const SHEET_PANEL_TO_MEMBER_PX = 37 + 32 - IMPOSITION_GAP_PX;

export const PICKER_FORM = ".session-card-picker-form";
export const SHEET_PANEL = '[data-slot="tug-sheet"].tug-sheet-content';

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Let the deck land before a reading: the landing window, then until no settle
 * is in flight. The picker's claim can reach its height in more than one
 * report, and a later one arms a second settle late in the window — the deck
 * trace shows that settle planned and not yet landed at the reading — so a
 * reading taken on the clock alone catches the frames mid-flight, short of
 * what the store already says.
 */
export async function landed(app: App): Promise<void> {
  await wait(AFTER_LAND_MS);
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
}

/**
 * Launch with `default-project-path` pointed at an empty directory.
 *
 * An unbound card's picker opens on that project. Left unseeded, a debug build
 * opens it on the source tree, and whatever sessions this machine holds there
 * fill the picker's list — so the picker's first height, and every reading
 * that leans on it, would be this machine's rather than this file's.
 */
export async function launchOnQuietProject(
  testName: string,
): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.app",
    "default-project-path",
    "string",
    testTmpDir("at0569-quiet-project-"),
  );
  const app = await launchTugApp({ testName, env: { TUGBANK_PATH: tugbankPath } });
  return { app, tugbankPath };
}

/** The reservations the live store holds, keyed by member. */
export async function reservations(app: App): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(window.tugdeck.diag.getDeckState().sheetReservations || null)`,
  );
}

/**
 * Every `opening-bid-mismatch` the deck has recorded this run.
 *
 * The kind is always-recorded — it does not wait on `enable(true)` — because a
 * first live report disagreeing with the bid is the one thing the deck wants
 * on the record whether or not anybody armed the trace ([Spec S04]).
 */
export async function bidMismatches(
  app: App,
): Promise<{ memberId: string; bid: number; report: number }[]> {
  return app.evalJS(
    `(function () {
      var out = [];
      var events = window.__deckTrace.since(0);
      for (var i = 0; i < events.length; i += 1) {
        var e = events[i];
        if (e.kind === "opening-bid-mismatch") {
          out.push({ memberId: e.memberId, bid: e.bid, report: e.report });
        }
      }
      return out;
    })()`,
  );
}

/** The opening bids the live store holds, keyed by member. */
export async function pins(app: App): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(window.tugdeck.diag.getDeckState().openingBids || null)`,
  );
}
