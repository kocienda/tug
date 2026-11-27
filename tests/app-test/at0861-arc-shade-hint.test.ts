/**
 * at0861-arc-shade-hint.test.ts — the arc shade for a session
 * with no arc: it says `None`, centered, and nothing else.
 *
 * What is read:
 *
 *   1. A press on the ARC cell of a session with no arc raises the shade,
 *      and the shade holds no panels.
 *   2. The shade says `None` in the shared empty line, centered, with no
 *      link and no button.
 *   3. The project has an arc no session is working, and the shade neither
 *      lists it nor offers Bind: it holds no control that starts an arc or
 *      binds one.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/components/tugways/tug-empty-line.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  createArc,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000861";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const NONE = `${SHADE} [data-slot="session-arc-shade-none"]`;
const ARC_CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="arc"]`;

/** An arc in the project that no session is working. */
const ARC_NAME = "at0861-loose";

/** This checkout — the build under test. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // A project and a session in it with no arc, and an arc in the project
  // that no session is working.
  scratch = makeArcScratchRepo({ prefix: "at0861", checkout: CHECKOUT });
  fixtureDir = seedScratchSession(projectDir(), SID);
  createArc(projectDir(), ARC_NAME, "at0861 fixture", scratch.cli);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

describe.skipIf(!SHOULD_RUN)("AT0861: the arc shade with no arc", () => {
  test(
    "the shade says None, centered, and holds no control",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0861-arc-shade-hint",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        await restoreSettled(app, "A");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(NONE)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // ── The cell raises the shade, with no panels ─────────────────────
        await app.body("A").click(ARC_CELL);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE)})?.getAttribute("data-raised") === "true"`,
          { timeoutMs: 10_000 },
        );
        const shade = await app.body("A").evalJS<{
          panels: boolean;
          none: string;
          justify: string;
          links: number;
          buttons: string[];
          unbound: number;
        }>(
          `(() => {
             const shade = document.querySelector(${JSON.stringify(SHADE)});
             const none = document.querySelector(${JSON.stringify(NONE)});
             const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
             return {
               panels: shade.querySelector('[data-slot="session-arc-panels"]') !== null,
               none: text(none),
               justify: getComputedStyle(none).justifyContent,
               links: shade.querySelectorAll("a").length,
               buttons: Array.from(none.querySelectorAll("button")).map(text),
               unbound: shade.querySelectorAll('[data-arc="${ARC_NAME}"]').length,
             };
           })()`,
        );
        note("at0861 shade", JSON.stringify(shade));
        expect(shade.panels, "no arc, no panels").toBe(false);
        expect(shade.none, "the shade says None").toBe("None");
        expect(shade.justify, "centered").toBe("center");
        expect(shade.links, "no link").toBe(0);
        expect(shade.buttons, "no button").toEqual([]);
        expect(shade.unbound, "the project's unbound arc is not listed").toBe(0);

      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
