/**
 * at0902-cycle-shade-sized-by-content.test.ts — the cycle shade is as tall as
 * what it holds, and holds no blank space.
 *
 * The cycle is a cycle of one, made through `tugtool cycle` in a scratch
 * project by the card's own session: one sketch, A, and one ready entry from
 * it. Nothing is running and the session is bound to no arc, so the shade
 * shows the cycle the session wrote. What is read:
 *
 *   1. The shade's body is the cycle body, and its list holds the sketch and
 *      the entry, both closed.
 *   2. The shade is shorter than the four fifths it may take: it is sized by
 *      what it holds.
 *   3. Nothing stands under the last row: the list's bottom edge is the last
 *      asset's, and the list has nothing to scroll to.
 *   4. A press on the entry's tile opens it in place, and it is wholly in view
 *      in the list.
 *
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade.tsx
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade.css
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000902";
const CYCLE_NAME = "at0902 cycle";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const BODY = `${SHADE} [data-slot="session-cycle-shade"]`;
const MAP = `${BODY} [data-slot="tug-cycle-map"]`;
const LIST = `${BODY} [data-slot="session-cycle-shade-list"]`;
const CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="arc"]`;
const TILE_1 = `${MAP} .tug-cycle-map-tile[aria-label^="1,"]`;

/** This checkout — the build under test. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/**
 * Run one `tugtool cycle` verb in the scratch project, as the card's session:
 * the cycle is filed under the session that wrote it, which is how a session
 * bound to no arc finds its cycle.
 */
const cycle = (...args: string[]): string =>
  tugtool(["cycle", ...args], {
    cwd: projectDir(),
    binaryRoot: scratch?.cli.binaryRoot,
    env: { ...scratch?.cli.env, TUG_SESSION_ID: SID },
  }).trim();

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0902",
    checkout: CHECKOUT,
    files: {
      "briefs/only.md": "# The only brief\n\nThe one entry of a cycle of one.\n",
    },
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
  const id = cycle("create", "--name", CYCLE_NAME);
  // `sketch record` prints "sketch <id> v1 (minted)"; the id is its second word.
  const recorded = tugtool(["sketch", "record"], {
    cwd: projectDir(),
    binaryRoot: scratch.cli.binaryRoot,
    env: scratch.cli.env,
    stdin: "# Sketch\n\nShow a cycle of one with nothing running.\n",
  }).trim();
  cycle("add-sketch", id, recorded.split(/\s+/)[1] ?? "");
  cycle("add-entry", id, "--brief", "briefs/only.md", "--from", "A");
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface SizeReading {
  form: string | null;
  assets: string[];
  opened: string[];
  /** The shade's height, and the height of the box its four-fifths cap is taken of. */
  shadeHeight: number;
  hostHeight: number;
  /** The list's scrollable overflow: scroll height less client height. */
  overflow: number;
  /** From the last asset's bottom edge to the list's. */
  tail: number;
  /** Whether the entry's asset is wholly inside the list's visible box. */
  entryInView: boolean;
}

const read = (app: App): Promise<SizeReading> =>
  app.body("A").evalJS<SizeReading>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const list = document.querySelector(${JSON.stringify(LIST)});
       const assets = Array.from(list.querySelectorAll('[data-slot="session-cycle-shade-asset"]'));
       const last = assets[assets.length - 1];
       const box = list.getBoundingClientRect();
       const entry = list.querySelector('[data-asset="e1"]')?.getBoundingClientRect();
       const round = (n) => Math.round(n * 10) / 10;
       return {
         form: shade.getAttribute("data-form"),
         assets: assets.map((el) => el.getAttribute("data-asset")),
         opened: assets.filter((el) => el.hasAttribute("data-open")).map((el) => el.getAttribute("data-asset")),
         shadeHeight: round(shade.getBoundingClientRect().height),
         hostHeight: round(shade.offsetParent.getBoundingClientRect().height),
         overflow: list.scrollHeight - list.clientHeight,
         tail: round(box.bottom - last.getBoundingClientRect().bottom),
         entryInView: entry !== undefined && entry.top >= box.top - 1 && entry.bottom <= box.bottom + 1,
       };
     })()`,
  );

/** The shade raised and its rise over: a reading taken mid-rise measures a moving box. */
const atRest = (app: App): Promise<boolean> =>
  app.body("A").waitForCondition<boolean>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       if (shade?.getAttribute("data-raised") !== "true") return false;
       if (document.querySelector(${JSON.stringify(LIST)}) === null) return false;
       return shade.getAnimations().length === 0 && getComputedStyle(shade).transform === "none";
     })()`,
    { timeoutMs: 10_000 },
  );

describe.skipIf(!SHOULD_RUN)("AT0902: the cycle shade is sized by its content", () => {
  test(
    "a cycle of one with nothing running stands no taller than its rows, with nothing to scroll",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0902-cycle-shade-sized-by-content",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        // A tall card, so a cycle of one is well inside the shade's cap and a
        // shade that held blank space would show it as height.
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 900 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        await restoreSettled(app, "A");

        // The cell reads the session's cycle once the frame carries it.
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CELL)})?.querySelector('[data-slot="session-telemetry-cycle-fraction"]')?.textContent ?? "").trim() === "0/1"`,
          { timeoutMs: 30_000 },
        );
        await app.body("A").click(CELL);
        await atRest(app);

        const rest = await read(app);
        note("at0902 at rest", JSON.stringify(rest));
        expect(rest.form, "the shade draws the cycle body").toBe("several");
        expect(rest.assets, "its list holds the sketch and the entry").toEqual(["sA", "e1"]);
        expect(rest.opened, "both closed").toEqual([]);
        expect(rest.shadeHeight, "the shade is shorter than its four-fifths cap").toBeLessThan(rest.hostHeight * 0.8 - 1);
        expect(rest.overflow, "the list has nothing to scroll to").toBeLessThanOrEqual(1);
        expect(rest.tail, "nothing stands under the last row").toBeLessThanOrEqual(1);

        await app.body("A").click(TILE_1);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${LIST} [data-asset="e1"][data-open]`)}) !== null`,
          { timeoutMs: 8_000 },
        );
        await atRest(app);
        const pressed = await read(app);
        note("at0902 tile pressed", JSON.stringify(pressed));
        expect(pressed.opened, "the pressed entry opens in place").toEqual(["e1"]);
        expect(pressed.entryInView, "and stands wholly in view").toBe(true);
        expect(pressed.tail, "still with nothing under the last row").toBeLessThanOrEqual(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
