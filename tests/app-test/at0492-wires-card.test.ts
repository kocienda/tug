/**
 * at0492-wires-card.test.ts — the **Wires** sidebar card over the real
 * `/api/wires` surface.
 *
 * Nothing here is stubbed. A real `tugutil wire lay` writes rows into the
 * launch's own `tripwires.db` — the harness points `TUG_TRIPWIRES_DB` into the
 * per-instance data dir, so a test can arm a wire without arming one on the
 * developer's machine — and the card reads them back through the HTTP surface
 * the running tugcast is serving.
 *
 * What it pins:
 *   1. `toggle-wires` shows the rail, and the rail lists the wires the ledger
 *      holds, in the order they were laid.
 *   2. A paused wire reads as paused. This is the projection the card exists
 *      to show: an armed wire and a paused one look identical unless something
 *      says so.
 *   3. The chevron opens that wire's trip log — the second level — and the
 *      back control returns to the roster.
 *
 * The trip log is asserted as *empty and present*: a wire that has never fired
 * has a log, and the card must show the log rather than nothing. Seeding a
 * settled trip would mean running a wire, which is the engine's own suite.
 *
 * @covers tugdeck/src/components/wires/
 * @covers tugdeck/src/lib/wires-store.ts
 * @covers tugdeck/src/lib/wires-card-id.ts
 * @covers tugrust/crates/tugcast/src/wires_api.rs
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

/** The ledger this launch writes to — the same path the harness hands the app. */
function instanceWiresDb(instanceId: string): string {
  return join(
    homedir(),
    "Library/Application Support/Tug/instances",
    instanceId,
    "tripwires.db",
  );
}

/** Lay a wire into this launch's ledger, through the real CLI. */
function layWire(app: App, name: string, extra: string[] = []): void {
  tugutil(
    [
      "wire",
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
      env: { TUG_TRIPWIRES_DB: instanceWiresDb(app.instanceId) },
    },
  );
}

function pauseWire(app: App, name: string): void {
  tugutil(["wire", "pause", name, "--json"], {
    cwd: CHECKOUT,
    binaryRoot: CHECKOUT,
    env: { TUG_TRIPWIRES_DB: instanceWiresDb(app.instanceId) },
  });
}

async function wireNames(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll("[data-wire]")).map((el) => el.getAttribute("data-wire"))`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0492 — the Wires card over the real ledger", () => {
  test(
    "the rail lists the laid wires, says which are paused, and opens a trip log",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0492-wires-card",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
            timeoutMs: 5_000,
          });

          // Seeded before the card mounts, so the card's first read already has
          // them and the assertion is not waiting out a poll interval.
          layWire(app, "alpha");
          layWire(app, "beta");
          pauseWire(app, "beta");

          await app.dispatchControlAction("toggle-wires");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll("[data-wire]").length === 2`,
            { timeoutMs: 8_000 },
          );

          expect(await wireNames(app)).toEqual(["alpha", "beta"]);
          expect(
            await app.evalJS<string | null>(
              `document.querySelector("[data-wire='beta']").getAttribute("data-wire-paused")`,
            ),
          ).toBe("true");
          expect(
            await app.evalJS<string | null>(
              `document.querySelector("[data-wire='alpha']").getAttribute("data-wire-paused")`,
            ),
          ).toBe("false");

          // The second level, through the affordance a pointer takes.
          await app.click(`[data-wires-open='alpha']`);
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-wire-detail='alpha']") !== null`,
            { timeoutMs: 5_000 },
          );
          expect(
            await app.evalJS<number>(`document.querySelectorAll("[data-trip-id]").length`),
          ).toBe(0);

          await app.click(`[data-wires-back]`);
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-wires-level='list']") !== null`,
            { timeoutMs: 5_000 },
          );
          expect(await wireNames(app)).toEqual(["alpha", "beta"]);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
