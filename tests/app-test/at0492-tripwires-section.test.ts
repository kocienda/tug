/**
 * at0492-tripwires-section.test.ts — the **Tripwires** Lens section over the
 * real `/api/tripwires` surface.
 *
 * Nothing here is stubbed. A real `tugutil tripwire lay` writes rows into the
 * launch's own `tripwires.db` — the harness points `TUG_TRIPWIRES_DB` into the
 * per-instance data dir, so a test can arm a tripwire without arming one on the
 * developer's machine — and the section reads them back through the HTTP
 * surface the running tugcast is serving.
 *
 * What it pins:
 *   1. The Lens is the door: `toggle-lens` shows the rail, the Tripwires band
 *      is in it, and the section lists the tripwires the ledger holds, in the
 *      order they were laid.
 *   2. A paused tripwire reads as paused. This is the projection the section
 *      exists to show: an armed tripwire and a paused one look identical
 *      unless something says so.
 *   3. The chevron opens that tripwire's trip log — the second level — and the
 *      back control returns to the roster.
 *
 * The trip log is asserted as *empty and present*: a tripwire that has never
 * fired has a log, and the section must show the log rather than nothing.
 * Seeding a settled trip would mean running a tripwire, which is the engine's
 * own suite.
 *
 * @covers tugdeck/src/components/lens/sections/tripwires-section.tsx
 * @covers tugdeck/src/components/lens/sections/tripwire-presentation.ts
 * @covers tugdeck/src/components/lens/sections/tripwires-data-source.ts
 * @covers tugdeck/src/lib/tripwires-store.ts
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
import { tugutil } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const CHECKOUT = process.env.TUG_REPO_UNIVERSE ?? process.cwd();

const SECTION = `.lens-section[data-lens-section="tripwires"]`;

/** The ledger this launch writes to — the same path the harness hands the app. */
function instanceTripwiresDb(instanceId: string): string {
  return join(
    homedir(),
    "Library/Application Support/Tug/instances",
    instanceId,
    "tripwires.db",
  );
}

/** Lay a tripwire into this launch's ledger, through the real CLI. */
function layTripwire(app: App, name: string, extra: string[] = []): void {
  tugutil(
    [
      "tripwire",
      "lay",
      name,
      "--on",
      "commit",
      "--brief",
      `watch ${name}`,
      "--json",
      ...extra,
    ],
    {
      cwd: CHECKOUT,
      binaryRoot: CHECKOUT,
      env: { TUG_TRIPWIRES_DB: instanceTripwiresDb(app.instanceId) },
    },
  );
}

function pauseTripwire(app: App, name: string): void {
  tugutil(["tripwire", "pause", name, "--json"], {
    cwd: CHECKOUT,
    binaryRoot: CHECKOUT,
    env: { TUG_TRIPWIRES_DB: instanceTripwiresDb(app.instanceId) },
  });
}

async function tripwireNames(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll("[data-tripwire]")).map((el) => el.getAttribute("data-tripwire"))`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0492 — the Tripwires Lens section over the real ledger",
  () => {
    test(
      "the section lists the laid tripwires, says which are paused, and opens a trip log",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: "at0492-tripwires-section",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
              timeoutMs: 5_000,
            });

            // Seeded before the Lens opens, so the section's first read already
            // has them and the assertion is not waiting out a poll interval.
            layTripwire(app, "alpha");
            layTripwire(app, "beta");
            pauseTripwire(app, "beta");

            await app.dispatchControlAction("toggle-lens");
            // The band exists whether or not anything is laid — the section
            // declares no `presence`, and a watch facility that vanished when
            // empty would be undiscoverable.
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(SECTION)}) !== null`,
              { timeoutMs: 8_000 },
            );
            await app.waitForCondition<boolean>(
              `document.querySelectorAll("[data-tripwire]").length === 2`,
              { timeoutMs: 8_000 },
            );

            expect(await tripwireNames(app)).toEqual(["alpha", "beta"]);
            expect(
              await app.evalJS<string | null>(
                `document.querySelector("[data-tripwire='beta']").getAttribute("data-tripwire-paused")`,
              ),
            ).toBe("true");
            expect(
              await app.evalJS<string | null>(
                `document.querySelector("[data-tripwire='alpha']").getAttribute("data-tripwire-paused")`,
              ),
            ).toBe("false");

            // The second level, through the affordance a pointer takes.
            await app.click(`[data-tripwires-open='alpha']`);
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire-detail='alpha']") !== null`,
              { timeoutMs: 5_000 },
            );
            expect(
              await app.evalJS<number>(`document.querySelectorAll("[data-trip-id]").length`),
            ).toBe(0);

            // What the tripwire IS, before what it has done, and in English:
            // the stored trigger is `{"commit":{}}` and no reader should ever
            // meet it in that form.
            expect(
              await app.evalJS<string>(
                `document.querySelector("[data-tripwires-definition]").textContent`,
              ),
            ).toContain("Any commit, on any branch");
            // The post control names itself and says what the setting does.
            expect(
              await app.evalJS<string>(
                `document.querySelector("[data-tripwires-post-caption]").textContent`,
              ),
            ).toContain("Overview");

            await app.click(`[data-tripwires-back]`);
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwires-level='list']") !== null`,
              { timeoutMs: 5_000 },
            );
            expect(await tripwireNames(app)).toEqual(["alpha", "beta"]);
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
