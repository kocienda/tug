/**
 * at0898-cycle-shade.test.ts — the cycle shade and the CYCLE & ARC cell, for a
 * session working one arc of a cycle of several entries.
 *
 * The cycle is made through `tugtool cycle` in a scratch project: one
 * sketch, A, and three entries from it, the second and third waiting on the
 * first, and the first carried by the arc the session is bound to. What is
 * read:
 *
 *   1. The status row's fourth cell is labelled CYCLE & ARC and shows two
 *      readings: how many entries have landed of how many there are, and
 *      beside it the bound arc's own reading. Both stay inside the cell.
 *   2. A press on the cell raises the shade in its several-entry form: the
 *      cycle's name, the map, a list of the sketch and one asset per entry,
 *      and the two-line footer where Done would stand. The key view is on the
 *      header's lowering control.
 *   3. A press on a map tile brings that entry's asset to the top of the
 *      list. The list stays whole and the map does not move.
 *   4. A shift-press on a second tile narrows the list to the two chosen
 *      entries under a Back bar, and Back makes the list whole again.
 *   5. Nothing in the shade starts anything: it holds no Start control.
 *   6. The list is the shade's one vertical scroller: a running entry's steps
 *      are laid out in full inside it, so every popup list set into an asset
 *      scrolls nothing of its own.
 *
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade.tsx
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade.css
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts
 * @covers tugdeck/src/components/tugways/cards/use-session-cycle.ts
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/cycle-map.tsx
 * @covers tugdeck/src/lib/cycle-store.ts
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
  bindArc,
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

const SID = "a7c0d1ea-0000-4000-8000-000000000898";
const ARC_NAME = "at0898-first";
const CYCLE_NAME = "at0898 cycle";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const BODY = `${SHADE} [data-slot="session-cycle-shade"]`;
const MAP = `${BODY} [data-slot="tug-cycle-map"]`;
const LIST = `${BODY} [data-slot="session-cycle-shade-list"]`;
const BACK = `${BODY} [data-slot="session-cycle-shade-back"]`;
const CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="arc"]`;
const tile = (n: number): string => `${MAP} .tug-cycle-map-tile[aria-label^="${n},"]`;

/** This checkout — the build under test. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** Run one `tugtool cycle` verb in the scratch project. */
const cycle = (...args: string[]): string =>
  tugtool(["cycle", ...args], {
    cwd: projectDir(),
    binaryRoot: scratch?.cli.binaryRoot,
    env: scratch?.cli.env,
  }).trim();

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0898",
    checkout: CHECKOUT,
    files: {
      "briefs/first.md": "# First brief\n\nThe entry the session is working.\n",
      "briefs/second.md": "# Second brief\n\nWaits on the first.\n",
      "briefs/third.md": "# Third brief\n\nWaits on the first.\n",
    },
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
  const arc = createArc(projectDir(), ARC_NAME, "at0898 fixture", scratch.cli);
  // Three steps, the first open, so the running entry draws its steps.
  recordStampedPlan(projectDir(), ARC_NAME, arc.worktree, { ...scratch.cli, rows: 3 });
  const id = cycle("create", "--name", CYCLE_NAME);
  // `sketch record` prints "sketch <id> v1 (minted)"; the id is its second word.
  const recorded = tugtool(["sketch", "record"], {
    cwd: projectDir(),
    binaryRoot: scratch.cli.binaryRoot,
    env: scratch.cli.env,
    stdin: "# Sketch\n\nShow the cycle the session works in.\n",
  }).trim();
  cycle("add-sketch", id, recorded.split(/\s+/)[1] ?? "");
  cycle("add-entry", id, "--brief", "briefs/first.md", "--from", "A");
  cycle("add-entry", id, "--brief", "briefs/second.md", "--wait", "1", "--from", "A");
  cycle("add-entry", id, "--brief", "briefs/third.md", "--wait", "1", "--from", "A");
  cycle("attach", id, "1", ARC_NAME);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface ShadeReading {
  raised: string | null;
  form: string | null;
  frameHead: boolean;
  frameFoot: boolean;
  name: string;
  landed: string;
  mapTop: number;
  mapHeight: number;
  listTop: number;
  assets: string[];
  /** Each shown asset's top edge, measured from the list's own top edge. */
  offsets: Record<string, number>;
  chosenTiles: string[];
  back: boolean;
  narrowed: boolean;
  footerLines: string[];
  buttons: string[];
  /**
   * The buttons that are the shade's own, leaving out the bound arc's verbs
   * in its entry: those are the arc's transport, kept so the arc can be
   * stopped and landed from its entry, and a stopped arc's verbs include its
   * own Start. The shade itself starts no entry.
   */
  shadeButtons: string[];
  keyViewLabel: string | null;
}

const read = (app: App): Promise<ShadeReading> =>
  app.body("A").evalJS<ShadeReading>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const body = document.querySelector(${JSON.stringify(BODY)});
       const map = document.querySelector(${JSON.stringify(MAP)});
       const list = document.querySelector(${JSON.stringify(LIST)});
       const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
       const round = (n) => Math.round(n * 10) / 10;
       const listTop = list.getBoundingClientRect().top;
       const assets = Array.from(list.querySelectorAll('[data-slot="session-cycle-shade-asset"]'));
       const keyView = document.querySelector("[data-key-view]");
       return {
         raised: shade.getAttribute("data-raised"),
         form: shade.getAttribute("data-form"),
         frameHead: shade.querySelector('[data-slot="session-arc-shade-head"]') !== null,
         frameFoot: shade.querySelector('[data-slot="session-arc-shade-foot"]') !== null,
         name: text(body.querySelector('[data-slot="session-cycle-shade-name"]')),
         landed: text(body.querySelector('[data-slot="session-cycle-shade-landed"]')),
         mapTop: round(map.getBoundingClientRect().top),
         mapHeight: round(map.getBoundingClientRect().height),
         listTop: round(listTop),
         assets: assets.map((el) => el.getAttribute("data-asset")),
         offsets: Object.fromEntries(
           assets.map((el) => [el.getAttribute("data-asset"), round(el.getBoundingClientRect().top - listTop)]),
         ),
         chosenTiles: Array.from(map.querySelectorAll(".tug-cycle-map-tile[data-chosen]")).map(
           (el) => (el.getAttribute("aria-label") ?? "").split(",")[0],
         ),
         back: body.querySelector('[data-slot="session-cycle-shade-back"]') !== null,
         narrowed: body.hasAttribute("data-narrowed"),
         footerLines: Array.from(
           body.querySelectorAll('[data-slot="session-cycle-shade-footer"] [data-line]'),
         ).map((el) => el.getAttribute("data-line")),
         buttons: Array.from(shade.querySelectorAll("button")).map(
           (el) => (text(el) + " " + (el.getAttribute("aria-label") ?? "")).trim(),
         ),
         shadeButtons: Array.from(shade.querySelectorAll("button"))
           .filter((el) => el.closest('[data-slot="session-cycle-shade-here"]') === null)
           .map((el) => (text(el) + " " + (el.getAttribute("aria-label") ?? "")).trim()),
         keyViewLabel: keyView !== null && shade.contains(keyView) ? keyView.getAttribute("aria-label") : null,
       };
     })()`,
  );

/** Wait until an asset's top edge rests on the list's top edge. */
const atListTop = (app: App, asset: string): Promise<boolean> =>
  app.body("A").waitForCondition<boolean>(
    `(() => {
       const list = document.querySelector(${JSON.stringify(LIST)});
       const el = list?.querySelector('[data-asset="${asset}"]');
       if (!list || !el) return false;
       return Math.abs(el.getBoundingClientRect().top - list.getBoundingClientRect().top) <= 2;
     })()`,
    { timeoutMs: 8_000 },
  );

describe.skipIf(!SHOULD_RUN)("AT0898: the cycle shade and the CYCLE cell", () => {
  test(
    "a cycle of several entries reads on the cell and stands in the shade, with no Start control",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0898-cycle-shade",
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

        // ── The cell: CYCLE & ARC, landed of total, and the arc's reading ─
        await app.body("A").waitForCondition<boolean>(
          `(() => {
             const value = document.querySelector(${JSON.stringify(CELL)})?.querySelector('[data-slot="session-telemetry-arc-value"]');
             return (value?.querySelector('[data-slot="session-telemetry-cycle-fraction"]')?.textContent ?? "").trim() === "0/3"
               && (value?.querySelector('[data-slot="session-telemetry-arc-reading"]')?.textContent ?? "").trim() !== "";
           })()`,
          { timeoutMs: 30_000 },
        );
        const cell = await app.body("A").evalJS<{
          label: string;
          cycle: string;
          arc: string;
          aria: string | null;
          pairRight: number;
          cellRight: number;
        }>(
          `(() => {
             const cell = document.querySelector(${JSON.stringify(CELL)});
             const value = cell.querySelector('[data-slot="session-telemetry-arc-value"]');
             const pair = value?.querySelector(".session-telemetry-cycle-arc-pair");
             return {
               label: (cell.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim(),
               cycle: (value?.querySelector('[data-slot="session-telemetry-cycle-fraction"]')?.textContent ?? "").trim(),
               arc: (value?.querySelector('[data-slot="session-telemetry-arc-reading"]')?.textContent ?? "").trim(),
               aria: value?.getAttribute("aria-label") ?? null,
               pairRight: pair?.getBoundingClientRect().right ?? Infinity,
               cellRight: cell.getBoundingClientRect().right,
             };
           })()`,
        );
        note("at0898 cell", JSON.stringify(cell));
        expect(cell.label, "the cell is labelled CYCLE & ARC").toBe("CYCLE & ARC");
        expect(cell.cycle, "its first reading is landed of total").toBe("0/3");
        expect(cell.arc, "and its second is the bound arc's own reading").not.toBe("");
        expect(cell.pairRight, "both readings stay inside the cell").toBeLessThanOrEqual(cell.cellRight + 0.5);
        expect(cell.aria, "its accessible label names the cycle").toContain(CYCLE_NAME);
        expect(cell.aria, "and how much has landed").toContain("0 of 3 landed");
        expect(cell.aria, "and the session's own arc").toContain(`arc ${ARC_NAME}`);

        // ── The shade, raised by the cell ─────────────────────────────────
        await app.body("A").click(CELL);
        // Raised, and at rest: the rise is a transform, and a reading taken
        // during it would place the map wherever the shade had got to.
        await app.body("A").waitForCondition<boolean>(
          `(() => {
             const shade = document.querySelector(${JSON.stringify(SHADE)});
             if (shade?.getAttribute("data-raised") !== "true") return false;
             if (document.querySelector(${JSON.stringify(LIST)}) === null) return false;
             return shade.getAnimations().length === 0 && getComputedStyle(shade).transform === "none";
           })()`,
          { timeoutMs: 10_000 },
        );
        const rest = await read(app);
        note("at0898 shade at rest", JSON.stringify(rest));
        expect(rest.form, "the shade is in its several-entry form").toBe("several");
        expect(rest.name, "it names the cycle").toBe(CYCLE_NAME);
        expect(rest.landed, "and says how much has landed").toContain("0");
        expect(rest.mapHeight, "the map is drawn").toBeGreaterThan(0);
        expect(rest.assets, "the list holds the sketch and one asset per entry").toEqual(["sA", "e1", "e2", "e3"]);
        expect(rest.footerLines, "the two-line footer stands under the list").toEqual(["now", "next"]);
        expect(rest.frameHead, "the frame draws no header of its own").toBe(false);
        expect(rest.frameFoot, "and no Done footer").toBe(false);
        expect(rest.back, "a whole list has no Back bar").toBe(false);
        expect(rest.keyViewLabel, "the key view is on the lowering control").toBe("Lower the cycle");
        expect(
          rest.shadeButtons.filter((b) => /start/i.test(b)),
          "the shade holds no Start control",
        ).toEqual([]);

        // ── The list is the one scroller ──────────────────────────────────
        const inner = await app.body("A").evalJS<{ lists: number; overflows: string[]; where: string[] }>(
          `(() => {
             const body = document.querySelector(${JSON.stringify(BODY)});
             const lists = Array.from(body.querySelectorAll('[data-slot="tug-popup-list"]'));
             const scrollers = Array.from(body.querySelectorAll(".tug-popup-list-scroller"));
             return {
               lists: lists.length,
               overflows: scrollers.map((el) => getComputedStyle(el).overflowY),
               // For a failure to read: each scroller's slot, its frame's layout, and its heights.
               where: scrollers.map((el) =>
                 [
                   el.getAttribute("data-slot") ?? "-",
                   el.parentElement?.getAttribute("data-layout") ?? "no-layout",
                   el.parentElement?.getAttribute("data-slot") ?? "-",
                   getComputedStyle(el).maxHeight,
                   el.scrollHeight + "/" + el.clientHeight,
                 ].join(" "),
               ),
             };
           })()`,
        );
        note("at0898 popup lists in the shade", JSON.stringify(inner));
        expect(inner.lists, "the running entry's body is drawn in the list").toBeGreaterThan(0);
        expect(
          inner.overflows.filter((o) => o !== "visible"),
          "no popup list inside an asset scrolls on its own",
        ).toEqual([]);

        // ── A press on the map brings the asset to the list's top ─────────
        await app.body("A").click(tile(3));
        await atListTop(app, "e3");
        const picked = await read(app);
        note("at0898 one tile pressed", JSON.stringify(picked));
        expect(picked.chosenTiles, "the pressed tile is chosen").toEqual(["3"]);
        expect(picked.assets, "one chosen entry leaves the list whole").toEqual(["sA", "e1", "e2", "e3"]);
        expect(Math.abs(picked.offsets.e3 ?? 99), "its asset is at the top of the list").toBeLessThanOrEqual(2);
        expect(picked.back).toBe(false);
        expect(picked.mapTop, "the map did not move").toBe(rest.mapTop);
        expect(picked.mapHeight).toBe(rest.mapHeight);

        // ── A shift-press narrows the list under Back ─────────────────────
        await app.body("A").evalJS<boolean>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(tile(2))});
             el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
             return true;
           })()`,
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BACK)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const narrowed = await read(app);
        note("at0898 two tiles chosen", JSON.stringify(narrowed));
        expect(narrowed.chosenTiles.slice().sort(), "both tiles are chosen").toEqual(["2", "3"]);
        expect(narrowed.assets.slice().sort(), "the list shows the two chosen entries only").toEqual(["e2", "e3"]);
        expect(narrowed.narrowed).toBe(true);
        expect(narrowed.mapTop, "the map did not move").toBe(rest.mapTop);
        expect(
          narrowed.shadeButtons.filter((b) => /start/i.test(b)),
          "narrowed, there is still no Start control",
        ).toEqual([]);

        // ── Back makes the list whole again ───────────────────────────────
        await app.body("A").click(`${BACK} button`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BACK)}) === null`,
          { timeoutMs: 8_000 },
        );
        const whole = await read(app);
        expect(whole.assets, "Back shows every asset").toEqual(["sA", "e1", "e2", "e3"]);
        expect(whole.chosenTiles, "and clears what was chosen").toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
