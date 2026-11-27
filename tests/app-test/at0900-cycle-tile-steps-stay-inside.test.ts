/**
 * at0900-cycle-tile-steps-stay-inside.test.ts — a running tile's steps stay
 * inside the tile on the Cycles & Arcs card, whose map is drawn compact.
 *
 * The fixture is a real cycle of two entries, each carried by a real arc with
 * a stamped plan whose first step is open: entry 1's arc has thirteen steps,
 * entry 2's has seven. A running tile draws its arc's own track (`TugArcTrack`),
 * the strip every surface whose subject is the arc draws, and the compact
 * tile is sized to hold it with thirteen ticks in its implement cell
 * (`tileTrackTicks`), so what is asserted is:
 *
 *   - each tile draws one track, with a tick a step: thirteen and seven;
 *   - no cell or tick of either track passes the tile's inner right edge,
 *     and no tick passes the implement cell that holds it;
 *   - the mark the work is in breathes: the track's own animation runs on it.
 *
 * The tiles' inner widths, the numbers' widths and the tracks' widths are
 * noted, which are the measures `tileTrackWidth` counts against.
 *
 * @covers tugdeck/src/components/tugways/cycle-map.tsx
 * @covers tugdeck/src/components/tugways/cycle-map.css
 * @covers tugdeck/src/components/tugways/cycle-map-layout.ts
 * @covers tugdeck/src/components/tugways/tug-arc-track.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  makeArcScratchRepo,
  recordStampedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000900";
const CYCLE_NAME = "at0900-cycle";
const LONG = "at0900-long";
const SHORT = "at0900-short";

const CARD = ".arcs-section";
const MAP = `${CARD} [data-slot="arcs-cycle-pin"] .tug-cycle-map`;
const TILES = `${MAP} .tug-cycle-map-tile`;
/** A tile by its entry's number: the map names a tile "<n>, <where it stands>". */
const tile = (n: number): string => `${TILES}[aria-label^="${n}, "]`;

/** This checkout — the build under test, and never the tree a cycle is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0900",
    checkout: CHECKOUT,
    files: {
      "briefs/long.md": "# Long brief\n\nThirteen steps.\n",
      "briefs/short.md": "# Short brief\n\nSeven steps.\n",
    },
  });
  const cli = scratch.cli;
  const run = (args: string[], stdin?: string): string =>
    tugtool(args, { cwd: projectDir(), binaryRoot: cli.binaryRoot, env: cli.env, stdin }).trim();

  const long = createArc(projectDir(), LONG, "at0900 thirteen steps", cli);
  recordStampedPlan(projectDir(), LONG, long.worktree, { ...cli, rows: 13 });
  const short = createArc(projectDir(), SHORT, "at0900 seven steps", cli);
  recordStampedPlan(projectDir(), SHORT, short.worktree, { ...cli, rows: 7 });

  // `sketch record` prints "sketch <id> v1 (minted)"; the id is its second word.
  const recorded = run(["sketch", "record"], "# Sketch\n\nKeep a tile's steps inside it.\n");
  const cycleId = run(["cycle", "create", "--name", CYCLE_NAME]);
  run(["cycle", "add-sketch", cycleId, recorded.split(/\s+/)[1] ?? ""]);
  run(["cycle", "add-entry", cycleId, "--brief", "briefs/long.md", "--from", "A"]);
  run(["cycle", "add-entry", cycleId, "--brief", "briefs/short.md", "--from", "A"]);
  run(["cycle", "attach", cycleId, "1", LONG]);
  run(["cycle", "attach", cycleId, "2", SHORT]);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface TileReading {
  state: string;
  tracks: number;
  ticks: number;
  /** The tile's inner right edge: its right edge less its right border. */
  innerRight: number;
  innerWidth: number;
  numberWidth: number;
  trackWidth: number;
  /** The rightmost edge any cell or tick reaches. */
  markRight: number;
  /** How far the last tick passes its implement cell's right edge; 0 or less is inside. */
  tickOver: number;
  /** The animation on the mark the work is in, or "" with none. */
  breath: string;
}

const readTile = (n: number): string => `(() => {
  const el = document.querySelector(${JSON.stringify(tile(n))});
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const border = parseFloat(cs.borderRightWidth) || 0;
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const marks = Array.from(el.querySelectorAll(".tug-arc-track-cell, .tug-arc-track-tick"));
  const cell = el.querySelector('.tug-arc-track-cell[data-steps="true"]');
  const ticks = Array.from(el.querySelectorAll(".tug-arc-track-tick"));
  const lastTick = ticks[ticks.length - 1];
  const active = el.querySelector('.tug-arc-track-tick[data-state="active"], .tug-arc-track-cell[data-state="active"]:not([data-steps])');
  const round = (v) => Math.round(v * 10) / 10;
  return {
    state: el.getAttribute("data-state") ?? "",
    tracks: el.querySelectorAll(".tug-arc-track").length,
    ticks: ticks.length,
    innerRight: round(box.right - border),
    innerWidth: round(box.width - 2 * border - pad),
    numberWidth: round(el.querySelector(".tug-cycle-map-tile-number")?.getBoundingClientRect().width ?? 0),
    trackWidth: round(el.querySelector(".tug-arc-track")?.getBoundingClientRect().width ?? 0),
    markRight: round(Math.max(-Infinity, ...marks.map((m) => m.getBoundingClientRect().right))),
    tickOver: cell && lastTick ? round(lastTick.getBoundingClientRect().right - cell.getBoundingClientRect().right) : 0,
    breath: active ? getComputedStyle(active).animationName : "",
  };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0900: a tile's steps stay inside the tile", () => {
  test(
    "thirteen and seven steps draw the arc's track inside the tile, its step in hand breathing",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0900-cycle-tile-steps-stay-inside",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // Spawning registers the scratch repo as a workspace, so its cycles
        // reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-arcs");
        const card = kindBody(app, "dashes");

        // Both tiles running and drawing their tracks' ticks.
        await card
          .waitForCondition<boolean>(
            `(() => {
               const ticks = (n) => document.querySelector(${JSON.stringify(TILES)} + '[aria-label^="' + n + ', "]')
                 ?.querySelectorAll(".tug-arc-track-tick").length ?? 0;
               return ticks(1) > 0 && ticks(2) > 0;
             })()`,
            { timeoutMs: 30000 },
          )
          .catch(() => undefined);
        const long = await card.evalJS<TileReading | null>(readTile(1));
        const short = await card.evalJS<TileReading | null>(readTile(2));
        note(`thirteen steps: ${JSON.stringify(long)}`);
        note(`seven steps: ${JSON.stringify(short)}`);

        expect(long, "entry 1's tile is on the map").not.toBeNull();
        expect(short, "entry 2's tile is on the map").not.toBeNull();
        expect(long!.state, "entry 1 is running").toBe("running");
        expect(short!.state, "entry 2 is running").toBe("running");

        for (const [reading, steps] of [
          [long!, 13],
          [short!, 7],
        ] as const) {
          expect(reading.tracks, `${steps} steps: the tile draws the arc's track`).toBe(1);
          expect(reading.ticks, `${steps} steps: a tick a step`).toBe(steps);
          expect(reading.markRight, `${steps} steps: no cell or tick passes the tile's edge`).toBeLessThanOrEqual(
            reading.innerRight + 0.5,
          );
          expect(reading.tickOver, `${steps} steps: no tick passes its implement cell`).toBeLessThanOrEqual(0.5);
          expect(reading.breath, `${steps} steps: the mark the work is in breathes`).toBe("tug-arc-track-breath");
        }
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
