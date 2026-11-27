/**
 * at0899-cycles-arcs-card-section.test.ts — a cycle on the Cycles & Arcs
 * card: its pin and map mount, a press on the map brings that entry's row up
 * under the pin, folding leaves the strip, and the card still has one
 * vertical scroller.
 *
 * The fixture is a real cycle, written through the verbs that write one in
 * life: `tugtool sketch record` keeps a sketch, `tugtool cycle create` opens
 * the cycle, and `add-sketch` and `add-entry` give it one sketch and three
 * entries. No arc is opened, so the first entry reads ready and the two that
 * wait on it read waiting. A cycle of three entries is a section: a pin
 * holding the fold cue, the name, how much has landed and the map, over one
 * row per asset.
 *
 * What only the rendered card can say, and so what is asserted here:
 *
 *   - the section mounts with the map: one pin, three tiles and one seal, and
 *     a row for the sketch and for each entry;
 *   - a press on a tile opens that entry's row and brings it up under the
 *     pin: the row's cell ends its scroll with its top at the pin's foot. The
 *     card is far shorter than its rail here, so this also proves the room
 *     the card makes under its last row at the press;
 *   - the card has one vertical scroller: with that room made, the card root
 *     is the only element inside it that can scroll up and down;
 *   - folding leaves the strip: the map and every asset row go, and the pin
 *     holds one segment per entry.
 *
 * The section's own parts are read into the `cycles-arcs-card` style census
 * before anything is pressed.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/arcs/arcs-projection.ts
 * @covers tugdeck/src/components/tugways/cycle-map.tsx
 * @covers tugdeck/src/components/tugways/cycle-map.css
 * @covers tugdeck/src/components/tugways/cycle-waits.tsx
 * @covers tugdeck/src/components/tugways/cycle-seal.tsx
 * @covers tugdeck/src/components/tugways/cycle-entry-mark.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { censusRead, expectCensus } from "./_harness/style-census";
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

const SID = "a7c0d1ea-0000-4000-8000-000000000899";
const CYCLE_NAME = "at0899-cycle";

const CARD = ".arcs-section";
const PIN = `${CARD} [data-slot="arcs-cycle-pin"]`;
const MAP = `${PIN} .tug-cycle-map`;
const TILES = `${MAP} .tug-cycle-map-tile`;
const SEALS = `${MAP} .tug-cycle-map-seal`;
const STRIP = `${PIN} [data-slot="arcs-cycle-strip"]`;
const FOLD = `${PIN} [data-slot="arcs-cycle-fold"]`;
const ENTRIES = `${CARD} [data-slot="arcs-cycle-entry"]`;
const SKETCHES = `${CARD} [data-slot="arcs-cycle-sketch"]`;
const entryRow = (n: number): string => `${ENTRIES}[data-asset="e${n}"]`;
/** A tile by its entry's number: the map names a tile "<n>, <its brief's title> · <where it stands>". */
const tile = (n: number): string => `${TILES}[aria-label^="${n}, "]`;

/** This checkout — the build under test, and never the tree a cycle is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0899", checkout: CHECKOUT });
  const cli = scratch.cli;
  const run = (args: string[], stdin?: string): string =>
    tugtool(args, {
      cwd: projectDir(),
      binaryRoot: cli.binaryRoot,
      env: cli.env,
      stdin,
    }).trim();

  // Three briefs on disk, so each entry's row has a brief to name.
  mkdirSync(join(projectDir(), "briefs"), { recursive: true });
  for (const name of ["one", "two", "three"]) {
    writeFileSync(
      join(projectDir(), "briefs", `at0899-${name}.md`),
      `# at0899 brief ${name}\n\nA brief the cycle carries.\n`,
    );
  }

  // `sketch record` prints "sketch <id> v1 (minted)"; the id is its second word.
  const recorded = run(
    ["sketch", "record"],
    "Draw the cycle on the card.\n\nA pin over one row per asset.\n",
  );
  const sketchId = recorded.split(/\s+/)[1] ?? "";
  const cycleId = run(["cycle", "create", "--name", CYCLE_NAME]);
  run(["cycle", "add-sketch", cycleId, sketchId]);
  run(["cycle", "add-entry", cycleId, "--brief", "briefs/at0899-one.md", "--from", "A"]);
  run(["cycle", "add-entry", cycleId, "--brief", "briefs/at0899-two.md", "--wait", "1", "--from", "A"]);
  run(["cycle", "add-entry", cycleId, "--brief", "briefs/at0899-three.md", "--wait", "1", "--from", "A"]);

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

describe.skipIf(!SHOULD_RUN)("AT0899: a cycle is a section on the Cycles & Arcs card", () => {
  test(
    "the pin and map mount, a tile press brings its row under the pin, and folding leaves the strip",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0899-cycles-arcs-card-section",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A spawned session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, so its cycles reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-arcs");
        const card = kindBody(app, "dashes");

        // ── The section mounts with the map ────────────────────────────────
        await card.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(TILES)}).length === 3`,
          { timeoutMs: 30000 },
        );
        const mounted = await card.evalJS<{
          pins: number;
          name: string;
          seals: number;
          entries: string[];
          states: string[];
          sketches: number;
          strip: number;
          kinds: string[];
          titles: string[];
        }>(
          `(() => {
             const all = (sel) => Array.from(document.querySelectorAll(sel));
             return {
               pins: all(${JSON.stringify(PIN)}).length,
               name: (document.querySelector(${JSON.stringify(`${PIN} [data-slot="arcs-cycle-name"]`)})?.textContent ?? "").trim(),
               seals: all(${JSON.stringify(SEALS)}).length,
               entries: all(${JSON.stringify(ENTRIES)}).map((el) => el.getAttribute("data-asset") ?? ""),
               states: all(${JSON.stringify(ENTRIES)}).map((el) => el.getAttribute("data-state") ?? ""),
               sketches: all(${JSON.stringify(SKETCHES)}).length,
               strip: all(${JSON.stringify(STRIP)}).length,
               kinds: all(${JSON.stringify(`${CARD} .tug-list-view-cell`)}).map((el) => el.getAttribute("data-tug-list-cell-kind") ?? ""),
               titles: all(${JSON.stringify(`${ENTRIES} [data-slot="arcs-cycle-title"]`)}).map((el) => (el.textContent ?? "").trim()),
             };
           })()`,
        );
        note(`mounted: ${JSON.stringify(mounted)}`);
        expect(mounted.pins, "one cycle, one pin").toBe(1);
        expect(mounted.name, "the pin names the cycle").toBe(CYCLE_NAME);
        expect(mounted.seals, "the map seals the cycle's one sketch").toBe(1);
        expect(mounted.entries, "one row per entry, in entry order").toEqual(["e1", "e2", "e3"]);
        expect(mounted.states, "the first entry is ready and the others wait on it").toEqual([
          "ready",
          "waiting",
          "waiting",
        ]);
        expect(mounted.sketches, "the sketch has a row").toBe(1);
        expect(mounted.titles, "each entry's row is headed by its brief's title").toEqual([
          "at0899 brief one",
          "at0899 brief two",
          "at0899 brief three",
        ]);
        expect(mounted.strip, "an open cycle draws its map, not its strip").toBe(0);
        expect(mounted.kinds, "the pin leads its assets in the one list").toEqual([
          "cycle-pin",
          "cycle-asset",
          "cycle-asset",
          "cycle-asset",
          "cycle-asset",
        ]);

        // ── The section's parts, in the style census ───────────────────────
        expectCensus(
          "cycles-arcs-card",
          await censusRead(card, [
            { selector: `${CARD} .tug-list-view-cell[data-tug-list-cell-kind="cycle-pin"]` },
            { selector: PIN },
            { selector: `${PIN} .arcs-cycle-head` },
            { selector: `${PIN} [data-slot="arcs-cycle-name"]` },
            { selector: `${PIN} .arcs-cycle-well` },
            { selector: entryRow(1) },
            { selector: `${entryRow(1)} [data-slot="arcs-cycle-number"]` },
            { selector: `${entryRow(1)} .arcs-cycle-content` },
            { selector: SKETCHES },
          ]),
        );

        // ── A press on a tile opens that row, under the pin ────────────────
        await card.click(tile(3));
        // The row's cell ends the scroll with its top at the pin cell's foot.
        const under = `(() => {
          const cellOf = (sel) => document.querySelector(sel)?.closest(".tug-list-view-cell") ?? null;
          const pin = cellOf(${JSON.stringify(PIN)});
          const row = cellOf(${JSON.stringify(entryRow(3))});
          const root = document.querySelector(${JSON.stringify(CARD)});
          if (!pin || !row || !root) return null;
          return {
            open: document.querySelector(${JSON.stringify(entryRow(3))})?.getAttribute("data-open") === "true",
            chosen: document.querySelector(${JSON.stringify(tile(3))})?.hasAttribute("data-chosen") === true,
            gap: Math.round(row.getBoundingClientRect().top - pin.getBoundingClientRect().bottom),
            pinTop: Math.round(pin.getBoundingClientRect().top - root.getBoundingClientRect().top),
            scrollTop: Math.round(root.scrollTop),
            // What the scroll had to work with, for a failure to read.
            folded: document.querySelector(${JSON.stringify(STRIP)}) !== null,
            rootOverflowY: getComputedStyle(root).overflowY,
            rootClient: root.clientHeight,
            rootScroll: root.scrollHeight,
            tail: document.querySelector('[data-slot="arcs-cycle-tail"]')?.getBoundingClientRect().height ?? -1,
            pinPosition: getComputedStyle(pin).position,
            // The pin's ground: rows pass under it, so it must be opaque.
            pinAlpha: (() => {
              const m = getComputedStyle(pin).backgroundColor.match(/\\/\\s*([\\d.]+)\\s*\\)$|rgba\\([^)]*,\\s*([\\d.]+)\\)$/);
              return m === null ? 1 : Number(m[1] ?? m[2]);
            })(),
          };
        })()`;
        // A wait that runs out is reported by the reading below, which says
        // which part of the press did not land.
        await card
          .waitForCondition<boolean>(
            `(() => { const r = ${under}; return r !== null && r.open && Math.abs(r.gap) <= 1 && r.scrollTop > 0; })()`,
            { timeoutMs: 5000 },
          )
          .catch(() => undefined);
        const pressed = await card.evalJS<{
          open: boolean;
          chosen: boolean;
          gap: number;
          pinTop: number;
          scrollTop: number;
          pinAlpha: number;
        }>(under);
        note(`pressed: ${JSON.stringify(pressed)}`);
        expect(pressed.open, "the pressed entry's row is open").toBe(true);
        expect(pressed.chosen, "the pressed tile is the chosen one").toBe(true);
        expect(pressed.scrollTop, "the card scrolled to bring the row up").toBeGreaterThan(0);
        expect(Math.abs(pressed.pinTop), "the pin holds the top of the card").toBeLessThanOrEqual(1);
        expect(Math.abs(pressed.gap), "the row's top is at the pin's foot").toBeLessThanOrEqual(1);
        expect(pressed.pinAlpha, "the pin is opaque, so the rows under it never show through").toBe(1);
        const openRows = await card.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${ENTRIES}[data-open="true"]`)})).map((el) => el.getAttribute("data-asset") ?? "")`,
        );
        expect(openRows, "only the pressed row is open").toEqual(["e3"]);

        // ── One vertical scroller ──────────────────────────────────────────
        // Read while the card has something to scroll, so the root counts.
        const scrollers = await card.evalJS<string[]>(
          `(() => {
             const root = document.querySelector(${JSON.stringify(CARD)});
             const inside = [root, ...Array.from(root.querySelectorAll("*"))];
             return inside
               .filter((el) => {
                 const y = getComputedStyle(el).overflowY;
                 return (y === "auto" || y === "scroll") && el.scrollHeight > el.clientHeight + 1;
               })
               .map((el) => el === root ? "root" : (el.getAttribute("data-slot") ?? el.className));
           })()`,
        );
        note(`vertical scrollers: ${JSON.stringify(scrollers)}`);
        expect(scrollers, "the card root is the only vertical scroller").toEqual(["root"]);

        // ── Folding leaves the strip ───────────────────────────────────────
        await card.click(FOLD);
        await card.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(STRIP)}) !== null`,
          { timeoutMs: 10000 },
        );
        const folded = await card.evalJS<{
          maps: number;
          segments: string[];
          assets: number;
          pinFolded: string | null;
        }>(
          `(() => ({
             maps: document.querySelectorAll(${JSON.stringify(MAP)}).length,
             segments: Array.from(document.querySelectorAll(${JSON.stringify(`${STRIP} > span`)})).map((el) => el.getAttribute("data-state") ?? ""),
             assets: document.querySelectorAll(${JSON.stringify(`${ENTRIES}, ${SKETCHES}`)}).length,
             pinFolded: document.querySelector(${JSON.stringify(PIN)})?.getAttribute("data-folded") ?? null,
           }))()`,
        );
        note(`folded: ${JSON.stringify(folded)}`);
        expect(folded.pinFolded, "the pin says it is folded").toBe("true");
        expect(folded.maps, "a folded cycle draws no map").toBe(0);
        expect(folded.segments, "the strip holds one segment per entry, in its state").toEqual([
          "ready",
          "waiting",
          "waiting",
        ]);
        expect(folded.assets, "a folded cycle lists no asset rows").toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
