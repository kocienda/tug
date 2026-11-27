/**
 * at0901-cycle-closes-when-its-arc-lands.test.ts — a cycle whose last entry
 * lands leaves every surface at once.
 *
 * The fixture is a real cycle of one entry in a scratch project, carried by
 * the arc the session is bound to, with one round committed on it. The arc is
 * landed through `tugtool arc join`, the verb the join press runs. What is
 * read:
 *
 *   1. Before the join, the CYCLE:ARC cell reads `0/1` beside the arc's own
 *      reading, and the Cycles & Arcs card holds the cycle's pin.
 *   2. After the join, the cell reads `None` and holds no cycle fraction: the
 *      cycle goes from `0/1` to nothing, with no `1/1` drawn for it.
 *   3. The Cycles & Arcs card no longer holds a pin for the cycle and names
 *      it nowhere.
 *   4. A press on the cell raises the shade, which holds the centered `None`
 *      and no cycle body.
 *
 * @covers tugrust/crates/tugarc-core/src/cycle.rs
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugdeck/src/lib/cycle-store.ts
 * @covers tugdeck/src/components/tugways/cards/use-session-cycle.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/components/arcs/arcs-projection.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  commitRound,
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000901";
const ARC_NAME = "at0901-only";
const CYCLE_NAME = "at0901-cycle";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="arc"]`;
const RAIL = ".arcs-section";
const PIN = `${RAIL} [data-slot="arcs-cycle-pin"]`;

/** This checkout — the build under test. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** Run one `tugtool` verb in the scratch project. */
const run = (args: string[], stdin?: string): string =>
  tugtool(args, {
    cwd: projectDir(),
    binaryRoot: scratch?.cli.binaryRoot,
    env: scratch?.cli.env,
    stdin,
  }).trim();

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0901",
    checkout: CHECKOUT,
    files: { "briefs/only.md": "# Only brief\n\nThe cycle's one entry.\n" },
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
  const arc = createArc(projectDir(), ARC_NAME, "at0901 fixture", scratch.cli);
  // One round, so the join has something to land.
  writeFileSync(join(arc.worktree, "at0901.txt"), "the arc's one change\n");
  commitRound(projectDir(), ARC_NAME, "at0901(round): add a file", scratch.cli);
  const id = run(["cycle", "create", "--name", CYCLE_NAME]);
  // `sketch record` prints "sketch <id> v1 (minted)"; the id is its second word.
  const recorded = run(["sketch", "record"], "# Sketch\n\nA cycle of one.\n");
  run(["cycle", "add-sketch", id, recorded.split(/\s+/)[1] ?? ""]);
  run(["cycle", "add-entry", id, "--brief", "briefs/only.md", "--from", "A"]);
  run(["cycle", "attach", id, "1", ARC_NAME]);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface CellReading {
  label: string;
  fraction: string | null;
  none: string | null;
}

const readCell = `(() => {
  const cell = document.querySelector(${JSON.stringify(CELL)});
  const text = (el) => (el ? (el.textContent ?? "").replace(/\\s+/g, " ").trim() : null);
  return {
    label: text(cell?.querySelector(".session-telemetry-endcap-label")) ?? "",
    fraction: text(cell?.querySelector('[data-slot="session-telemetry-cycle-fraction"]')),
    none: text(cell?.querySelector('[data-slot="session-telemetry-arc-none"]')),
  };
})()`;

interface RailReading {
  pins: number;
  names: string[];
  entries: number;
  text: string;
}

const readRail = `(() => ({
  pins: document.querySelectorAll(${JSON.stringify(PIN)}).length,
  names: Array.from(document.querySelectorAll(${JSON.stringify(`${PIN} [data-slot="arcs-cycle-name"]`)})).map((el) => (el.textContent ?? "").trim()),
  entries: document.querySelectorAll(${JSON.stringify(`${RAIL} [data-slot="arcs-cycle-entry"]`)}).length,
  text: (document.querySelector(${JSON.stringify(RAIL)})?.textContent ?? "").replace(/\\s+/g, " ").trim(),
}))()`;

describe.skipIf(!SHOULD_RUN)("AT0901: a cycle closes when its last arc lands", () => {
  test(
    "the cell goes from 0/1 to None, the card drops the cycle, and the shade says None",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0901-cycle-closes-when-its-arc-lands",
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
        bindArc(projectDir(), ARC_NAME, SID, {
          binaryRoot: CHECKOUT,
          env: scratch?.cli.env,
        });
        await app.dispatchControlAction("toggle-arcs");
        const rail = kindBody(app, "dashes");

        // ── Open: the cell reads 0/1 and the card holds the pin ───────────
        await app
          .body("A")
          .waitForCondition<boolean>(`(${readCell}).fraction === "0/1"`, { timeoutMs: 30_000 })
          .catch(() => undefined);
        await rail
          .waitForCondition<boolean>(`(${readRail}).pins === 1`, { timeoutMs: 30_000 })
          .catch(() => undefined);
        const openCell = await app.body("A").evalJS<CellReading>(readCell);
        const openRail = await rail.evalJS<RailReading>(readRail);
        note("at0901 open cell", JSON.stringify(openCell));
        note("at0901 open rail", JSON.stringify(openRail));
        expect(openCell.label, "the cell is labelled CYCLE:ARC").toBe("CYCLE:ARC");
        expect(openCell.fraction, "an open cycle of one reads 0/1").toBe("0/1");
        expect(openRail.names, "the card holds the cycle's pin").toEqual([CYCLE_NAME]);
        expect(openRail.entries, "and its one entry").toBe(1);

        // ── The arc lands ─────────────────────────────────────────────────
        const joined = run(["arc", "join", ARC_NAME, "--json"]);
        note("at0901 join", joined.slice(0, 400));

        // ── Closed: the cell reads None, with no fraction ─────────────────
        await app
          .body("A")
          .waitForCondition<boolean>(
            `(() => { const r = ${readCell}; return r.fraction === null && r.none === "None"; })()`,
            { timeoutMs: 30_000 },
          )
          .catch(() => undefined);
        await rail
          .waitForCondition<boolean>(`(${readRail}).pins === 0`, { timeoutMs: 30_000 })
          .catch(() => undefined);
        const closedCell = await app.body("A").evalJS<CellReading>(readCell);
        const closedRail = await rail.evalJS<RailReading>(readRail);
        note("at0901 closed cell", JSON.stringify(closedCell));
        note("at0901 closed rail", JSON.stringify(closedRail));
        expect(closedCell.label, "the label stays").toBe("CYCLE:ARC");
        expect(closedCell.fraction, "a closed cycle draws no fraction").toBeNull();
        expect(closedCell.none, "the cell reads None").toBe("None");
        expect(closedRail.pins, "the card holds no pin for the cycle").toBe(0);
        expect(closedRail.entries, "and none of its entries").toBe(0);
        expect(closedRail.text, "and names it nowhere").not.toContain(CYCLE_NAME);

        // ── The shade holds the centered None ─────────────────────────────
        await app.body("A").click(CELL);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE)})?.getAttribute("data-raised") === "true"`,
          { timeoutMs: 10_000 },
        );
        const shade = await app.body("A").evalJS<{
          none: string | null;
          justify: string | null;
          cycleBody: boolean;
        }>(
          `(() => {
             const shade = document.querySelector(${JSON.stringify(SHADE)});
             const none = shade.querySelector('[data-slot="session-arc-shade-none"]');
             return {
               none: none ? (none.textContent ?? "").replace(/\\s+/g, " ").trim() : null,
               justify: none ? getComputedStyle(none).justifyContent : null,
               cycleBody: shade.querySelector('[data-slot="session-cycle-shade"]') !== null,
             };
           })()`,
        );
        note("at0901 shade", JSON.stringify(shade));
        expect(shade.cycleBody, "the shade draws no cycle").toBe(false);
        expect(shade.none, "it says None").toBe("None");
        expect(shade.justify, "centered").toBe("center");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
