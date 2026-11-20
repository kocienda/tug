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
 *      shade's header carries Transcript and nothing else.
 *   2. Each panel's progress dot says where its rung is: an empty seat is
 *      still, the brief is complete, and the arc, where the work is, runs.
 *   3. The seams are tracks of their own: three of them, joined only where
 *      there is something on both sides, and none lies over a panel.
 *   4. At rest the Arc panel holds the larger share. Pressing a panel gives
 *      its column and its row the larger share instead, focus entering a
 *      panel does the same, and lowering and raising the shade returns the
 *      share to the Arc panel.
 *   5. A small Arc panel shows only its lead verb; holding the larger share
 *      it shows the whole row on one line. Either way the verb row is under
 *      the reading's scroller and never over it.
 *   6. Nothing overflows sideways: the grid is as wide as the shade's body
 *      and at least as tall, every panel is inside the grid, and the body
 *      never scrolls across. Where the shade is shorter than the grid the
 *      body scrolls down, and the panel holding the larger share is brought
 *      into view with its lower edge, and so the Arc panel's verbs, showing.
 *   7. The Brief panel names the arc's brief and its path and lists the
 *      findings and decisions it marks. The Idea and Sketch panels say
 *      nothing is recorded.
 *   8. Discard on the Arc panel arms a confirm that stands on the panel, and
 *      Cancel dismisses it with the arc untouched.
 *   9. Open in Text Card on the Brief panel opens the brief's file.
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
import { resolve } from "node:path";

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

/** The Session card's minimum width, the narrowest the shade can be. */
const MIN_CARD_SIZE = { width: 675, height: 680 };

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const GRID = `${SHADE} [data-slot="session-arc-panels"]`;
const panel = (rung: string): string => `${GRID} [data-slot="session-arc-panel"][data-rung="${rung}"]`;
const panelName = (rung: string): string => `${panel(rung)} .session-arc-panel-name`;
const BRIEF_OPEN = `${panel("brief")} [data-slot="session-arc-brief-open"]`;
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
  focus: string | null;
  headButtons: string[];
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
         focus: grid.getAttribute("data-focus"),
         headButtons: Array.from(shade.querySelectorAll('[data-slot="session-arc-shade-head"] button')).map(text),
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

/** The panel named holds the larger share: it is wider than its row's other panel and taller than its column's. */
const expectLargerShare = (reading: GridReading, rung: string): void => {
  const beside = { idea: "sketch", sketch: "idea", brief: "arc", arc: "brief" }[rung] as string;
  const across = { idea: "brief", sketch: "arc", brief: "idea", arc: "sketch" }[rung] as string;
  const held = panelOf(reading, rung).box;
  expect(reading.focus, `${rung} holds the share`).toBe(rung);
  expect(width(held), `${rung} is wider than ${beside}`).toBeGreaterThan(width(panelOf(reading, beside).box) * 1.3);
  expect(height(held), `${rung} is taller than ${across}`).toBeGreaterThan(height(panelOf(reading, across).box) * 1.3);
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
 * lies over a panel, and the panel holding the larger share is in the body's
 * view: all of it, or as much as the body is tall, with its lower edge
 * showing.
 */
const expectNoOverflow = (reading: GridReading, when: string): void => {
  expect(
    { gridX: reading.overflow.gridX, gridY: reading.overflow.gridY, bodyX: reading.overflow.bodyX },
    `${when}: nothing spills from the grid and the body never scrolls across`,
  ).toEqual({ gridX: 0, gridY: 0, bodyX: 0 });
  const held = panelOf(reading, reading.focus ?? "").box;
  const seen = Math.min(held.b, reading.body.b) - Math.max(held.t, reading.body.t);
  expect(seen, `${when}: the panel holding the share is in view`).toBeGreaterThanOrEqual(
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

const focusIs = (app: App, rung: string): Promise<boolean> =>
  app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(GRID)})?.getAttribute("data-focus") === ${JSON.stringify(rung)}`,
    { timeoutMs: 6_000 },
  );

describe.skipIf(!SHOULD_RUN)("AT0860: the arc shade's four panels", () => {
  test(
    "four panels stand in order, a pressed panel takes the larger share, and nothing overflows",
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
        expect(rest.headButtons, "the header carries Transcript alone").toEqual(["Transcript"]);
        const [idea, sketch, brief, arc] = ["idea", "sketch", "brief", "arc"].map((r) => panelOf(rest, r).box);
        expect(Math.abs(idea.t - sketch.t), "Idea and Sketch share the top row").toBeLessThanOrEqual(0.5);
        expect(Math.abs(brief.t - arc.t), "Brief and Arc share the bottom row").toBeLessThanOrEqual(0.5);
        expect(Math.abs(idea.l - brief.l), "Idea and Brief share the left column").toBeLessThanOrEqual(0.5);
        expect(Math.abs(sketch.l - arc.l), "Sketch and Arc share the right column").toBeLessThanOrEqual(0.5);
        expect(sketch.l, "Sketch is right of Idea").toBeGreaterThan(idea.r);
        expect(brief.t, "Brief is under Idea").toBeGreaterThan(idea.b);
        expect(rest.panels.map((p) => p.state)).toEqual(["pending", "pending", "done", "active"]);
        expect(rest.panels.map((p) => p.dot)).toEqual(["stopped", "stopped", "completed", "running"]);
        expect(rest.seams.map((s) => [s.from, s.state])).toEqual([
          ["idea", "pending"],
          ["sketch", "pending"],
          ["brief", "linked"],
        ]);

        // ── The grid fills the shade, and the Arc panel holds the share ───
        expect(height(rest.grid), "the grid is at least as tall as the shade's body").toBeGreaterThanOrEqual(
          height(rest.body) - 1,
        );
        // As wide as the body's own content box: the body's rect also holds
        // its scrollbar when the shade is shorter than the grid.
        const spare = width(rest.body) - width(rest.grid);
        expect(spare, "and no wider than it").toBeGreaterThanOrEqual(-1);
        expect(spare, "and narrower by no more than a scrollbar").toBeLessThanOrEqual(20);
        expect(height(rest.body), "the body has real height").toBeGreaterThan(100);
        expectNoOverflow(rest, "at rest");
        expectLargerShare(rest, "arc");

        // ── Holding the share, the Arc panel shows its whole row on one line
        expect(rest.verbs.length, "the row has verbs").toBeGreaterThan(1);
        expect(rest.verbs.every((v) => v.shown), "every verb shows").toBe(true);
        for (const verb of ["changes", "unbind", "discard"]) {
          expect(rest.verbs.map((v) => v.verb), `the panel offers ${verb}`).toContain(verb);
        }
        const tops = rest.verbs.map((v) => Math.round(v.box.t + height(v.box) / 2));
        expect(Math.max(...tops) - Math.min(...tops), "the verbs stand on one line").toBeLessThanOrEqual(1);
        expectFloorClear(rest, "holding the share");
        expect(rest.verbRow.b, "the verbs are in the shade's view when it rises").toBeLessThanOrEqual(rest.body.b + 1);

        // ── A press gives the pressed panel the larger share ──────────────
        // In a shade shorter than the grid the top row is above the view
        // once the Arc panel has been shown, so the body is scrolled to its
        // top first, as a reader would, and the press lands on the panel.
        await app.body("A").evalJS<boolean>(
          `(() => {
             document.querySelector(${JSON.stringify(`${SHADE} [data-slot="session-arc-shade-body"]`)}).scrollTop = 0;
             return true;
           })()`,
        );
        await app.body("A").nativeClickAtElement(panelName("idea"));
        await focusIs(app, "idea");
        const pressed = await read(app);
        note("at0860 idea pressed", JSON.stringify(pressed));
        expectLargerShare(pressed, "idea");
        expectNoOverflow(pressed, "Idea pressed");

        // ── A small Arc panel keeps only its lead verb ────────────────────
        // The arc is cut and never run, so its next move is Start: exactly
        // that one verb stands, and the sheet has not hidden it with the rest.
        const shownSmall = pressed.verbs.filter((v) => v.shown);
        expect(
          shownSmall.map((v) => [v.verb, v.lead]),
          "the lead verb alone shows in a small Arc panel",
        ).toEqual([["start", true]]);
        expect(
          pressed.verbs.filter((v) => !v.lead).every((v) => !v.shown),
          "every other verb is hidden",
        ).toBe(true);
        expectFloorClear(pressed, "small");

        // ── Focus entering a panel counts as a press ──────────────────────
        await app.body("A").evalJS<boolean>(
          `(() => { document.querySelector(${JSON.stringify(BRIEF_OPEN)}).focus(); return true; })()`,
        );
        await focusIs(app, "brief");
        const focused = await read(app);
        expectLargerShare(focused, "brief");
        expectNoOverflow(focused, "Brief focused");

        // ── The pressed panel is not kept: raised again, the Arc panel has it
        await app.dispatchControlAction("toggle-arc-shade");
        await shadeSettled(app, false);
        await app.dispatchControlAction("toggle-arc-shade");
        await shadeSettled(app, true);
        await focusIs(app, "arc");
        const back = await read(app);
        expectLargerShare(back, "arc");
        expect(back.verbs.every((v) => v.shown), "the row is whole again").toBe(true);

        // ── The Brief panel shows the brief and its headings ──────────────
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${panel("brief")} [data-slot="session-arc-brief-heading"]`)}).length === 2`,
          { timeoutMs: 6_000 },
        );
        const briefPanel = await app.body("A").evalJS<{
          title: string;
          path: string;
          headings: string[];
          empties: string[];
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
               empties: ["idea", "sketch"].map((rung) =>
                 text(document.querySelector(${JSON.stringify(GRID)} + ' [data-rung="' + rung + '"] .session-arc-panel-title')),
               ),
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
        expect(briefPanel.empties).toEqual([
          "Nothing recorded for this arc yet",
          "Nothing recorded for this arc yet",
        ]);

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

        // ── Open in Text Card opens the brief's own file ──────────────────
        // The proof is the document's bytes on screen: a Text card carrying
        // the brief's heading is the file, opened.
        await app.body("A").click(BRIEF_OPEN);
        await kindBody(app, "text").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll('[data-slot="text-card"]'))
             .some((card) => (card.textContent ?? "").includes(${JSON.stringify(BRIEF_TITLE)}))`,
          { timeoutMs: 20_000 },
        );

        // ── Changes lowers the arc shade and opens the Changes shade ──────
        // The press on the Brief panel gave it the larger share, and a small
        // Arc panel keeps only its lead verb, so the Arc panel is pressed
        // first.
        await app.body("A").click(panelName("arc"));
        await focusIs(app, "arc");
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
