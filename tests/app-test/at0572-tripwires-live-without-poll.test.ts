/**
 * at0572-tripwires-live-without-poll.test.ts — the **Tripwires** card follows
 * the ledger with no roster request in flight.
 *
 * Nothing here is stubbed. A real `tugtool tripwire lay` in a second process
 * writes a row into this launch's own `tripwires.db`, the real `TRIPWIRES`
 * snapshot feed composes the roster from that ledger, and the card draws what
 * the frame carried. The only thing the test installs in the page is a counter
 * around `window.fetch`, which observes and forwards.
 *
 * What it pins:
 *   1. A tripwire laid by another process appears on the card, with the count
 *      of `GET /api/tripwires` requests made since the counter was armed at
 *      zero. The row arrived on a frame.
 *   2. Pausing that first tripwire flips `data-tripwire-paused` on the row
 *      already drawn, still with a zero count — an *update*, not just an
 *      insert, because a feed that only ever carried inserts would leave a
 *      card that goes subtly stale rather than dark.
 *
 * The zero count and the liveness are one claim, and that is the point of
 * asserting them together: a test that only checked the timer was gone would
 * pass just as happily over a card that shows nothing at all, and a test that
 * only checked the row arrived would pass over the poll this arc retired.
 *
 * The count is of `/api/tripwires` *exactly* — the `/trips` log route and the
 * knob route are requests the store still makes on purpose, and counting them
 * would measure something the arc never claimed.
 *
 * @covers tugdeck/src/lib/tripwires-store.ts
 * @covers tugdeck/src/components/tripwires/tripwires-card.tsx
 * @covers tugrust/crates/tugcast/src/feeds/tripwires.rs
 * @covers tugrust/crates/tugtool-core/src/tripwire_roster.rs
 * @covers tugrust/crates/tugcast/src/tripwires_api.rs
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { tugtool } from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const CHECKOUT = process.env.TUG_REPO_UNIVERSE ?? process.cwd();

const CARD = `.tripwires-card`;

/** The ledger this launch writes to — the same path the harness hands the app. */
function instanceTripwiresDb(instanceId: string): string {
  return join(
    homedir(),
    "Library/Application Support/Tug/instances",
    instanceId,
    "tripwires.db",
  );
}

/** Lay a tripwire into this launch's ledger, through the real CLI in its own
 *  process — which is the whole point: nothing in the app asked for this. */
function layTripwire(app: App, name: string): void {
  tugtool(
    [
      "tripwire",
      "lay",
      name,
      "--on",
      "fact:edit_failed",
      "--brief",
      `say whether ${name} saw anything worth reporting`,
      "--description",
      `Says whether ${name} saw anything worth reporting`,
      "--json",
    ],
    {
      cwd: CHECKOUT,
      binaryRoot: CHECKOUT,
      env: { TUG_TRIPWIRES_DB: instanceTripwiresDb(app.instanceId) },
    },
  );
}

function pauseTripwire(app: App, name: string): void {
  tugtool(["tripwire", "pause", name, "--json"], {
    cwd: CHECKOUT,
    binaryRoot: CHECKOUT,
    env: { TUG_TRIPWIRES_DB: instanceTripwiresDb(app.instanceId) },
  });
}

/** Wrap `window.fetch` so every call to the roster route is counted, and start
 *  the count at zero. Installed once; `__tugRosterFetches` is read after each
 *  ledger write the card is supposed to follow without asking. */
const ARM_COUNTER = `(() => {
  if (!window.__tugRosterFetchPatched) {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const path = url.split("?")[0];
      if (path === "/api/tripwires" || path.endsWith("/api/tripwires")) {
        window.__tugRosterFetches = (window.__tugRosterFetches || 0) + 1;
      }
      return real(input, init);
    };
    window.__tugRosterFetchPatched = true;
  }
  window.__tugRosterFetches = 0;
  return true;
})()`;

async function rosterFetchCount(app: App): Promise<number> {
  return app.evalJS<number>(`window.__tugRosterFetches`);
}

describe.skipIf(!SHOULD_RUN)(
  "at0572 — the Tripwires card stays live with no roster request in flight",
  () => {
    test(
      "a tripwire laid and paused by another process reaches the card on a frame",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: "at0572-tripwires-live-without-poll",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
              timeoutMs: 5_000,
            });

            layTripwire(app, "alpha");

            await app.dispatchControlAction("toggle-tripwires");
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(CARD)}) !== null`,
              { timeoutMs: 8_000 },
            );
            await app.waitForCondition<boolean>(
              `document.querySelectorAll("[data-tripwire]").length === 1`,
              { timeoutMs: 8_000 },
            );

            // Everything above may have asked for whatever it liked. The claim
            // starts here: from this point on the card is handed nothing but
            // frames.
            expect(await app.evalJS<boolean>(ARM_COUNTER)).toBe(true);

            // An insert, written by a process the card has never heard of.
            layTripwire(app, "beta");
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='beta']") !== null`,
              { timeoutMs: 10_000 },
            );
            expect(await rosterFetchCount(app)).toBe(0);

            // And an update to a row already on screen, which is the half a
            // feed carrying only inserts would quietly fail.
            pauseTripwire(app, "alpha");
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha']").getAttribute("data-tripwire-paused") === "true"`,
              { timeoutMs: 10_000 },
            );
            expect(await rosterFetchCount(app)).toBe(0);
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
