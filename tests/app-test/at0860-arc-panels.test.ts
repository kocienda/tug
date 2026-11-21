/**
 * at0860-arc-panels.test.ts — the arc shade's four fixed panels: Idea,
 * Sketch, Brief and Arc in a 2×2 grid, read at the Session card's minimum
 * width.
 *
 * What is read:
 *
 *   1. With an arc bound, the raised shade holds the four panels in the
 *      ladder's order at their grid seats — Idea top-left, Sketch top-right,
 *      Brief bottom-left, Arc bottom-right — each wearing its number, and the
 *      shade's header carries no button and its footer Done alone.
 *   2. Each panel's progress dot says where its rung is: an empty seat is
 *      still, the recorded idea and the brief are complete, and the arc,
 *      where the work is, runs.
 *   3. The seams are tracks of their own: three of them, joined only where
 *      there is something on both sides, and none lies over a panel.
 *   4. The two columns are equal, and nothing moves on a press or when focus
 *      enters a panel.
 *   5. The Arc panel shows its whole verb row on one line, the next move in
 *      its word and the rest as icons, under the reading's scroller and
 *      never over it.
 *   6. Nothing overflows sideways: the grid is as wide as the shade's body,
 *      every panel is inside the grid, the body never scrolls across, and
 *      the Arc panel is in view with its lower edge, and so its verbs,
 *      showing.
 *      Each row is as tall as its taller panel needs: the two one-line
 *      panels' row is short, the shade holds the grid whole when it is under
 *      its cap, and when the cap binds the short row keeps its height while
 *      the other row gives way and its panels scroll inside themselves, the
 *      Arc panel's verbs still on its floor.
 *   7. The Brief panel names the arc's brief and its path and lists the
 *      findings and decisions it marks. The Idea panel shows the arc's idea
 *      record as written, without its heading or its `Source:` line, and
 *      the Sketch panel, with no record, says None.
 *   8. Discard on the Arc panel arms a confirm that stands on the panel, and
 *      Cancel dismisses it with the arc untouched.
 *   9. The Brief panel's path opens the brief's file.
 *  10. Changes on the Arc panel lowers the arc shade and opens the Changes
 *      shade.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-panels.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-panels.css
 * @covers tugdeck/src/lib/arc-panels.ts
 * @covers tugdeck/src/components/tugways/cards/session-arc-brief.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-brief.css
 * @covers tugdeck/src/lib/brief-headings-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  arcBriefPath,
  bindArc,
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000860";
const ARC_NAME = "at0860-panels";
const BRIEF_TITLE = "The panels brief";
const IDEA_TEXT = "Show the arc as four panels.";

/**
 * The Session card's minimum width, the narrowest the shade can be, and tall
 * enough that the shade's cap leaves room above the rows' floors, so the
 * rows can be read sharing it.
 */
const MIN_CARD_SIZE = { width: 675, height: 800 };

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const GRID = `${SHADE} [data-slot="session-arc-panels"]`;
const panel = (rung: string): string => `${GRID} [data-slot="session-arc-panel"][data-rung="${rung}"]`;
const panelName = (rung: string): string => `${panel(rung)} .session-arc-panel-name`;
const BRIEF_OPEN = `${panel("brief")} [data-slot="session-arc-brief-path"]`;
const arcVerb = (kind: string): string => `${panel("arc")} [data-slot="arc-verb"][data-verb="${kind}"]`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CHANGES_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0860", checkout: CHECKOUT });
  // An arc's documents are files at its own address and are never tracked.
  writeFileSync(
    arcBriefPath(projectDir(), ARC_NAME),
    [
      `# ${BRIEF_TITLE}`,
      "",
      "**[F01] The shade has four panels.** Found by reading.",
      "",
      "**[B01] The Brief panel lists these.** And nothing else.",
      "",
    ].join("\n"),
  );
  // The record of the idea the door writes beside the brief. No sketch is
  // recorded, so the Sketch panel keeps its empty seat.
  writeFileSync(
    join(dirname(arcBriefPath(projectDir(), ARC_NAME)), "idea.md"),
    ["# Idea", "", IDEA_TEXT, "", `Source: session ${SID}, turn 1`, ""].join("\n"),
  );
  createArc(projectDir(), ARC_NAME, "at0860 panels", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

interface PanelReading {
  rung: string;
  state: string | null;
  number: string;
  dot: string | null;
  box: Box;
}

interface VerbReading {
  verb: string | null;
  lead: boolean;
  shown: boolean;
  box: Box;
}

interface GridReading {
  headButtons: string[];
  footButtons: string[];
  panels: PanelReading[];
  seams: Array<{ from: string | null; state: string | null; box: Box }>;
  grid: Box;
  body: Box;
  /** How far the grid's and the body's content runs past their own boxes. */
  overflow: { gridX: number; gridY: number; bodyX: number; bodyY: number };
  verbs: VerbReading[];
  /** The Arc panel's verb row and the scroller above it. */
  verbRow: Box;
  verbRowOverflow: number;
  scroller: Box;
}

const read = (app: App): Promise<GridReading> =>
  app.body("A").evalJS<GridReading>(
    `(() => {
       const box = (el) => {
         const r = el.getBoundingClientRect();
         return { l: r.left, t: r.top, r: r.right, b: r.bottom };
       };
       const text = (el) => (el?.textContent ?? "").trim();
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const grid = document.querySelector(${JSON.stringify(GRID)});
       const body = shade.querySelector('[data-slot="session-arc-shade-body"]');
       const arc = grid.querySelector('[data-slot="session-arc-panel"][data-rung="arc"]');
       const row = arc.querySelector('[data-slot="arc-verb-row"]');
       return {
         headButtons: Array.from(shade.querySelectorAll('[data-slot="session-arc-shade-head"] button')).map(text),
         footButtons: Array.from(shade.querySelectorAll('[data-slot="session-arc-shade-foot"] button')).map(text),
         panels: Array.from(grid.querySelectorAll('[data-slot="session-arc-panel"]')).map((el) => ({
           rung: el.getAttribute("data-rung"),
           state: el.getAttribute("data-state"),
           number: text(el.querySelector(".session-arc-panel-number")),
           dot: el.querySelector('[data-slot="session-arc-panel-dot"] [data-slot="tug-progress-indicator"]')
             ?.getAttribute("data-state") ?? null,
           box: box(el),
         })),
         seams: Array.from(grid.querySelectorAll('[data-slot="session-arc-panel-seam"]')).map((el) => ({
           from: el.getAttribute("data-from"),
           state: el.getAttribute("data-state"),
           box: box(el),
         })),
         grid: box(grid),
         body: box(body),
         overflow: {
           gridX: grid.scrollWidth - grid.clientWidth,
           gridY: grid.scrollHeight - grid.clientHeight,
           bodyX: body.scrollWidth - body.clientWidth,
           bodyY: body.scrollHeight - body.clientHeight,
         },
         verbs: Array.from(arc.querySelectorAll('[data-slot="arc-verb"]')).map((el) => ({
           verb: el.getAttribute("data-verb"),
           lead: el.getAttribute("data-lead") === "true",
           shown: el.getClientRects().length > 0,
           box: box(el),
         })),
         verbRow: box(row),
         verbRowOverflow: row.scrollWidth - row.clientWidth,
         scroller: box(arc.querySelector(".tug-popup-list-scroller")),
       };
     })()`,
  );

const panelOf = (reading: GridReading, rung: string): PanelReading => {
  const found = reading.panels.find((p) => p.rung === rung);
  if (found === undefined) throw new Error(`no ${rung} panel in the grid`);
  return found;
};

const width = (b: Box): number => b.r - b.l;
const height = (b: Box): number => b.b - b.t;
const overlaps = (a: Box, b: Box): boolean => a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;
const inside = (inner: Box, outer: Box): boolean =>
  inner.l >= outer.l - 0.5 && inner.r <= outer.r + 0.5 && inner.t >= outer.t - 0.5 && inner.b <= outer.b + 0.5;

/** Every panel stands where it stood: nothing moved between two readings. */
const expectUnmoved = (before: GridReading, after: GridReading, when: string): void => {
  for (const p of before.panels) {
    const now = panelOf(after, p.rung).box;
    for (const edge of ["l", "t", "r", "b"] as const) {
      expect(Math.abs(now[edge] - p.box[edge]), `${when}: ${p.rung} has not moved`).toBeLessThanOrEqual(0.5);
    }
  }
};

/** The Arc panel's verb row is under its scroller, inside the panel, and nothing in it spills. */
const expectFloorClear = (reading: GridReading, when: string): void => {
  expect(reading.verbRow.t, `${when}: the verb row is under the scroller`).toBeGreaterThanOrEqual(
    reading.scroller.b - 0.5,
  );
  expect(inside(reading.verbRow, panelOf(reading, "arc").box), `${when}: the verb row is inside the panel`).toBe(true);
  expect(reading.verbRowOverflow, `${when}: the verb row does not spill`).toBeLessThanOrEqual(0);
  for (const verb of reading.verbs.filter((v) => v.shown)) {
    expect(inside(verb.box, reading.verbRow), `${when}: ${verb.verb} is inside the row`).toBe(true);
  }
};

/**
 * Nothing runs past the shade sideways, every panel is in the grid, no seam
 * lies over a panel, and the Arc panel is in the body's view: all of it, or
 * as much as the body is tall, with its lower edge showing.
 */
const expectNoOverflow = (reading: GridReading, when: string): void => {
  expect(
    { gridX: reading.overflow.gridX, gridY: reading.overflow.gridY, bodyX: reading.overflow.bodyX },
    `${when}: nothing spills from the grid and the body never scrolls across`,
  ).toEqual({ gridX: 0, gridY: 0, bodyX: 0 });
  const held = panelOf(reading, "arc").box;
  const seen = Math.min(held.b, reading.body.b) - Math.max(held.t, reading.body.t);
  expect(seen, `${when}: the Arc panel is in view`).toBeGreaterThanOrEqual(
    Math.min(height(held), height(reading.body)) - 1,
  );
  expect(held.b, `${when}: its lower edge shows`).toBeLessThanOrEqual(reading.body.b + 1);
  for (const p of reading.panels) {
    expect(inside(p.box, reading.grid), `${when}: ${p.rung} is inside the grid`).toBe(true);
  }
  for (const seam of reading.seams) {
    for (const p of reading.panels) {
      expect(overlaps(seam.box, p.box), `${when}: the seam from ${seam.from} is clear of ${p.rung}`).toBe(false);
    }
  }
};

/** Wait for the shade to say it is raised or lowered and for its transform to have finished. */
const shadeSettled = (app: App, raised: boolean): Promise<boolean> =>
  app.body("A").waitForCondition<boolean>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const slot = document.querySelector(${JSON.stringify(SLOT)});
       if (shade === null || slot === null) return false;
       if (shade.getAttribute("data-raised") !== ${JSON.stringify(raised ? "true" : "false")}) return false;
       const s = shade.getBoundingClientRect();
       const v = slot.getBoundingClientRect();
       return ${raised ? "Math.abs(s.bottom - v.bottom) <= 1" : "s.top >= v.bottom - 1"};
     })()`,
    { timeoutMs: 10_000 },
  );

interface CapReading {
  /** The shade stands at its four-fifths cap. */
  binds: boolean;
  /** How far each panel's reading runs past what its panel shows. */
  panelScroll: Record<string, number>;
  /**
   * The Arc panel's list: how far its head (everything above the ledger's
   * scroller and its footer) is clipped, how tall the scroller stands, and
   * the one row it never gives way below.
   */
  arcHeadClip: number;
  arcScroller: number;
  arcScrollerMin: number;
}

const readCap = (app: App): Promise<CapReading> =>
  app.body("A").evalJS<CapReading>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const slot = document.querySelector(${JSON.stringify(SLOT)});
       const grid = document.querySelector(${JSON.stringify(GRID)});
       const over = (el) => el === null ? 0 : Math.max(0, el.scrollHeight - el.clientHeight);
       const panelScroll = {};
       for (const el of grid.querySelectorAll('[data-slot="session-arc-panel"]')) {
         panelScroll[el.getAttribute("data-rung")] = Math.max(
           over(el.querySelector('[data-slot="session-arc-panel-body"]')),
           over(el.querySelector(".tug-popup-list-scroller")),
         );
       }
       return {
         binds: shade.getBoundingClientRect().height >= slot.getBoundingClientRect().height * 0.8 - 1,
         panelScroll,
         arcHeadClip: (() => {
           const list = grid.querySelector('[data-rung="arc"] .tug-popup-list');
           if (list === null) return 0;
           return Math.max(0, ...Array.from(list.children)
             .filter((el) => !el.matches(".tug-popup-list-footer, .tug-popup-list-scroller"))
             .map((el) => el.scrollHeight - el.clientHeight));
         })(),
         arcScroller: grid.querySelector('[data-rung="arc"] .tug-popup-list-scroller')?.clientHeight ?? 0,
         arcScrollerMin: (() => {
           const el = grid.querySelector('[data-rung="arc"] .tug-popup-list-scroller');
           return el === null ? 0 : parseFloat(getComputedStyle(el).minHeight) || 0;
         })(),
       };
     })()`,
  );

describe.skipIf(!SHOULD_RUN)("AT0860: the arc shade's four panels", () => {
  test(
    "four panels stand in order in equal columns, rows by content, and nothing moves or overflows",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0860-arc-panels",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(MIN_CARD_SIZE), focusCardId: "A" });
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
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(GRID)}) !== null`,
          { timeoutMs: 30_000 },
        );
        await app.dispatchControlAction("toggle-arc-shade");
        await shadeSettled(app, true);

        // ── Four panels at their seats, with their dots and seams ─────────
        const rest = await read(app);
        note("at0860 at rest", JSON.stringify(rest));
        expect(rest.panels.map((p) => p.rung)).toEqual(["idea", "sketch", "brief", "arc"]);
        expect(rest.panels.map((p) => p.number)).toEqual(["1", "2", "3", "4"]);
        expect(rest.headButtons, "the header carries no button").toEqual([]);
        expect(rest.footButtons, "the footer carries Done alone").toEqual(["Done"]);
        const [idea, sketch, brief, arc] = ["idea", "sketch", "brief", "arc"].map((r) => panelOf(rest, r).box);
        expect(Math.abs(idea.t - sketch.t), "Idea and Sketch share the top row").toBeLessThanOrEqual(0.5);
        expect(Math.abs(brief.t - arc.t), "Brief and Arc share the bottom row").toBeLessThanOrEqual(0.5);
        expect(Math.abs(idea.l - brief.l), "Idea and Brief share the left column").toBeLessThanOrEqual(0.5);
        expect(Math.abs(sketch.l - arc.l), "Sketch and Arc share the right column").toBeLessThanOrEqual(0.5);
        expect(sketch.l, "Sketch is right of Idea").toBeGreaterThan(idea.r);
        expect(brief.t, "Brief is under Idea").toBeGreaterThan(idea.b);
        expect(rest.panels.map((p) => p.state)).toEqual(["done", "pending", "done", "active"]);
        expect(rest.panels.map((p) => p.dot)).toEqual(["completed", "stopped", "completed", "running"]);
        expect(rest.seams.map((s) => [s.from, s.state])).toEqual([
          ["idea", "pending"],
          ["sketch", "pending"],
          ["brief", "linked"],
        ]);

        // ── Equal columns, rows by content ────────────────────────────────
        // As wide as the body's own content box: the body's rect also holds
        // its scrollbar when the shade is shorter than the grid.
        const spare = width(rest.body) - width(rest.grid);
        expect(spare, "and no wider than it").toBeGreaterThanOrEqual(-1);
        expect(spare, "and narrower by no more than a scrollbar").toBeLessThanOrEqual(20);
        expect(height(rest.body), "the body has real height").toBeGreaterThan(100);
        expect(Math.abs(height(idea) - height(sketch)), "a row's two panels are one height").toBeLessThanOrEqual(0.5);
        expect(Math.abs(height(brief) - height(arc)), "in both rows").toBeLessThanOrEqual(0.5);
        expect(height(idea), "the row of two one-line panels is short").toBeLessThan(90);
        expect(height(idea), "and shorter than the row holding the arc").toBeLessThan(height(arc));
        const cap = await readCap(app);
        note("at0860 cap at rest", JSON.stringify(cap));
        // The ledger gives way before the reading's head does, down to one
        // row: the head is clipped only once the scroller is at that row.
        expect(cap.arcScrollerMin, "the ledger keeps a row").toBeGreaterThan(20);
        expect(cap.arcScroller, "and never stands shorter").toBeGreaterThanOrEqual(cap.arcScrollerMin - 1);
        expect(cap.arcHeadClip === 0 || cap.arcScroller <= cap.arcScrollerMin + 1, "at rest the head keeps its height while the ledger can give").toBe(true);
        if (!cap.binds) {
          expect(rest.overflow.bodyY, "under its cap the shade holds the grid whole").toBeLessThanOrEqual(0);
          expect(cap.panelScroll, "and no panel scrolls").toEqual({ idea: 0, sketch: 0, brief: 0, arc: 0 });
        }
        expectNoOverflow(rest, "at rest");
        expect(Math.abs(width(idea) - width(sketch)), "the two columns are equal").toBeLessThanOrEqual(0.5);
        expect(Math.abs(width(brief) - width(arc)), "in both rows").toBeLessThanOrEqual(0.5);

        // ── The Arc panel shows its whole row on one line ─────────────────
        expect(rest.verbs.length, "the row has verbs").toBeGreaterThan(1);
        expect(rest.verbs.every((v) => v.shown), "every verb shows").toBe(true);
        for (const verb of ["changes", "unbind", "discard"]) {
          expect(rest.verbs.map((v) => v.verb), `the panel offers ${verb}`).toContain(verb);
        }
        const tops = rest.verbs.map((v) => Math.round(v.box.t + height(v.box) / 2));
        expect(Math.max(...tops) - Math.min(...tops), "the verbs stand on one line").toBeLessThanOrEqual(1);
        expectFloorClear(rest, "at rest");
        expect(rest.verbs[0]?.lead, "the next move leads the row").toBe(true);
        expect(rest.verbRow.b, "the verbs are in the shade's view when it rises").toBeLessThanOrEqual(rest.body.b + 1);

        // ── The cap binding: the short row keeps its height ───────────────
        // The shade is held 20 px shorter than it stands, as a shorter slot
        // would hold it, and read again: still above the rows' floors. The
        // Arc panel's row stands 28 px over its floor, so 20 is what it can
        // give alone.
        await app.body("A").evalJS<boolean>(
          `(() => {
             const shade = document.querySelector(${JSON.stringify(SHADE)});
             shade.style.maxHeight = (shade.getBoundingClientRect().height - 20) + "px";
             return true;
           })()`,
        );
        const capped = await read(app);
        const cappedCap = await readCap(app);
        note("at0860 capped", JSON.stringify({ capped, cap: cappedCap }));
        const [cIdea, cArc] = ["idea", "arc"].map((r) => panelOf(capped, r).box);
        expect(Math.abs(height(cIdea) - height(idea)), "capped, the short row keeps its height").toBeLessThanOrEqual(1);
        expect(height(cArc), "and the row holding the arc gives way").toBeLessThan(height(arc) - 15);
        expect(capped.overflow.bodyY, "the grid still fits the shade, so the body does not scroll").toBeLessThanOrEqual(0);
        expect(
          Math.max(cappedCap.panelScroll.arc ?? 0, cappedCap.panelScroll.brief ?? 0),
          "the row that gave way scrolls inside its panels",
        ).toBeGreaterThan(0);
        expect(cappedCap.arcScroller, "capped, the ledger keeps its row").toBeGreaterThanOrEqual(cappedCap.arcScrollerMin - 1);
        expect(cappedCap.arcHeadClip === 0 || cappedCap.arcScroller <= cappedCap.arcScrollerMin + 1, "capped, the head keeps its height while the ledger can give").toBe(true);
        expectFloorClear(capped, "capped");
        await app.body("A").evalJS<boolean>(
          `(() => { document.querySelector(${JSON.stringify(SHADE)}).style.maxHeight = ""; return true; })()`,
        );

        // ── A press expands a panel, a second puts it back, focus moves nothing ──
        const settledRest = await read(app);
        await app.body("A").nativeClickAtElement(panelName("idea"));
        const pressed = await read(app);
        note("at0860 idea pressed", JSON.stringify(pressed));
        const [pIdea, pSketch, pBrief, pArc] = ["idea", "sketch", "brief", "arc"].map((r) => panelOf(pressed, r).box);
        expect(width(pIdea) / width(pSketch), "pressed, Idea's column is two parts to one").toBeGreaterThan(1.9);
        expect(Math.abs(width(pBrief) - width(pIdea)), "and Brief, under it, is as wide").toBeLessThanOrEqual(0.5);
        expect(Math.abs(width(pArc) - width(pSketch))).toBeLessThanOrEqual(0.5);
        expect(pressed.verbs.every((v) => v.shown), "in the narrow column, the Arc panel keeps its whole row").toBe(true);
        expectFloorClear(pressed, "Idea pressed");
        expectNoOverflow(pressed, "Idea pressed");
        await app.body("A").nativeClickAtElement(panelName("idea"));
        expectUnmoved(settledRest, await read(app), "Idea pressed again");
        await app.body("A").evalJS<boolean>(
          `(() => { document.querySelector(${JSON.stringify(BRIEF_OPEN)}).focus(); return true; })()`,
        );
        const focused = await read(app);
        expectUnmoved(settledRest, focused, "Brief focused");
        expect(focused.verbs.every((v) => v.shown), "focus elsewhere, the row is whole").toBe(true);

        // ── The Brief panel shows the brief and its headings ──────────────
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${panel("brief")} [data-slot="session-arc-brief-heading"]`)}).length === 2`,
          { timeoutMs: 6_000 },
        );
        const briefPanel = await app.body("A").evalJS<{
          title: string;
          path: string;
          headings: string[];
          idea: { text: string; title: number };
          sketch: string;
        }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(panel("brief"))});
             const text = (node) => (node?.textContent ?? "").trim();
             return {
               title: text(el.querySelector(".session-arc-panel-title")),
               path: text(el.querySelector('[data-slot="session-arc-brief-path"]')),
               headings: Array.from(el.querySelectorAll('[data-slot="session-arc-brief-heading"]')).map(
                 (li) => li.getAttribute("data-kind") + ":" + Array.from(li.children).map(text).join(" "),
               ),
               idea: {
                 text: text(document.querySelector(${JSON.stringify(`${GRID} [data-rung="idea"] [data-slot="session-arc-panel-text"]`)})),
                 title: document.querySelectorAll(${JSON.stringify(`${GRID} [data-rung="idea"] .session-arc-panel-title`)}).length,
               },
               sketch: text(document.querySelector(${JSON.stringify(`${GRID} [data-rung="sketch"] [data-slot="tug-empty-line"]`)})),
             };
           })()`,
        );
        note("at0860 brief panel", JSON.stringify(briefPanel));
        expect(briefPanel.title).toBe(BRIEF_TITLE);
        expect(briefPanel.path).toBe(`.tug/arcs/${ARC_NAME}/brief.md`);
        expect(briefPanel.headings).toEqual([
          "finding:F01 The shade has four panels",
          "decision:B01 The Brief panel lists these",
        ]);
        expect(briefPanel.idea.text, "the Idea panel shows the record as written").toBe(IDEA_TEXT);
        expect(briefPanel.idea.title, "under no heading of its own").toBe(0);
        expect(briefPanel.sketch, "the Sketch panel, with no record, says so").toBe("None");

        // ── Discard's confirm stands on the Arc panel ─────────────────────
        await app.body("A").click(arcVerb("discard"));
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 6_000 },
        );
        const confirm = await app.body("A").evalJS<{ popover: Box; panel: Box }>(
          `(() => {
             const box = (el) => {
               const r = el.getBoundingClientRect();
               return { l: r.left, t: r.top, r: r.right, b: r.bottom };
             };
             return {
               popover: box(document.querySelector(${JSON.stringify(CONFIRM)})),
               panel: box(document.querySelector(${JSON.stringify(panel("arc"))})),
             };
           })()`,
        );
        note("at0860 confirm", JSON.stringify(confirm));
        expect(width(confirm.popover), "the confirm is drawn").toBeGreaterThan(0);
        expect(overlaps(confirm.popover, confirm.panel), "the confirm stands on the Arc panel").toBe(true);
        await app.body("A").click(`${CONFIRM} [data-slot="tug-confirm-cancel"]`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
          { timeoutMs: 6_000 },
        );
        expect(
          await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(panel("arc"))}) !== null`),
          "Cancel leaves the arc bound",
        ).toBe(true);

        // ── The brief's path opens the brief's own file ───────────────────
        // The proof is the document's bytes on screen: a Text card carrying
        // the brief's heading is the file, opened.
        await app.body("A").click(BRIEF_OPEN);
        await kindBody(app, "text").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll('[data-slot="text-card"]'))
             .some((card) => (card.textContent ?? "").includes(${JSON.stringify(BRIEF_TITLE)}))`,
          { timeoutMs: 20_000 },
        );

        // ── Changes lowers the arc shade and opens the Changes shade ──────
        await app.body("A").click(arcVerb("changes"));
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE)})?.getAttribute("data-raised") !== "true" &&
           document.querySelector(${JSON.stringify(CHANGES_SHEET)}) !== null`,
          { timeoutMs: 6_000 },
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
