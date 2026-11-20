/**
 * at0860-arc-canvas.test.ts — the arc shade's canvas: four cards joined by
 * three connectors, a card that goes where it is dragged, and a layout that
 * is still there when the shade comes back.
 *
 * What is read:
 *
 *   1. With an arc bound, the raised shade holds the four cards in the
 *      ladder's order, each at its home position, with three connectors drawn
 *      beneath them and a port at each end of every connector.
 *   2. Dragging the Brief card by its header moves it by the pointer's travel,
 *      brings it to the front, and redraws the connector that arrives at it
 *      to end on its new edge. The other cards stay where they were.
 *   3. Lowering the shade and raising it again finds the Brief card where it
 *      was dropped.
 *   4. The Brief card names the arc's brief and its path, and the connector
 *      from it to the Arc card is linked. Opened, it is the wide width, lists
 *      the findings and decisions the brief marks, and pushes the Arc card
 *      along; closed, both go back. The Idea and Sketch cards say nothing is
 *      recorded.
 *   5. The Arc card is full size: it has no collapse, and the arc's reading
 *      and verb row fill it. It drags like the others.
 *   6. Tidy sends the dragged cards home.
 *   7. Discard on the Arc card arms a confirm that stands on the card, and
 *      Cancel dismisses it with the arc untouched.
 *   8. Open in Text Card on the Brief card opens the brief's file.
 *   9. Changes on the Arc card lowers the arc shade and opens the Changes
 *      shade.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-canvas.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-canvas.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-brief.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-brief.css
 * @covers tugdeck/src/lib/brief-headings-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/lib/arc-canvas-geometry.ts
 * @covers tugdeck/src/lib/use-arc-canvas-state.ts
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
const ARC_NAME = "at0860-canvas";
const BRIEF_TITLE = "The canvas brief";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const CANVAS = `${SHADE} [data-slot="session-arc-canvas"]`;
const rungCard = (rung: string): string => `${CANVAS} [data-slot="session-arc-canvas-card"][data-rung="${rung}"]`;
const BRIEF_GRIP = `${rungCard("brief")} .session-arc-canvas-card-name`;
const ARC_GRIP = `${rungCard("arc")} .session-arc-canvas-card-name`;
const BRIEF_TOGGLE = `${rungCard("brief")} .session-arc-canvas-card-head button`;
const BRIEF_OPEN = `${rungCard("brief")} [data-slot="session-arc-brief-open"]`;
const arcVerb = (kind: string): string => `${rungCard("arc")} [data-slot="arc-verb"][data-verb="${kind}"]`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CHANGES_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const TIDY = `${SHADE} [data-slot="session-arc-shade-head"] button:first-of-type`;

/** How far the drag carries the card, in viewport pixels. */
const DRAG = { dx: 60, dy: 30 };

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
      "**[F01] The canvas has four cards.** Found by reading.",
      "",
      "**[B01] The Brief card lists these.** And nothing else.",
      "",
    ].join("\n"),
  );
  createArc(projectDir(), ARC_NAME, "at0860 canvas", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface CardReading {
  rung: string;
  left: number;
  top: number;
  width: number;
  z: number;
  expanded: boolean;
  hasBody: boolean;
  ports: string[];
}

interface CanvasReading {
  zoom: number;
  cards: CardReading[];
  /** Each connector: where it starts, its state, and the end point of its path. */
  links: Array<{ from: string | null; state: string | null; endX: number; endY: number }>;
  /** Whether the links' SVG comes before every card in the canvas, and so beneath them. */
  linksBeneath: boolean;
  canvasWidth: number;
}

const read = (app: App): Promise<CanvasReading> =>
  app.body("A").evalJS<CanvasReading>(
    `(() => {
       const canvas = document.querySelector(${JSON.stringify(CANVAS)});
       const cards = Array.from(canvas.querySelectorAll('[data-slot="session-arc-canvas-card"]'));
       const svg = canvas.querySelector(".session-arc-canvas-links");
       const zoom = canvas.getBoundingClientRect().width / canvas.offsetWidth;
       return {
         zoom: Math.round(zoom * 1000) / 1000,
         cards: cards.map((el) => ({
           rung: el.getAttribute("data-rung"),
           left: parseFloat(el.style.left),
           top: parseFloat(el.style.top),
           width: el.offsetWidth,
           z: Number(getComputedStyle(el).zIndex),
           expanded: el.getAttribute("data-expanded") === "true",
           hasBody: el.querySelector(".session-arc-canvas-card-body") !== null,
           ports: Array.from(el.querySelectorAll(".session-arc-canvas-port")).map(
             (p) => p.getAttribute("data-side") + ":" + p.getAttribute("data-state"),
           ),
         })),
         links: Array.from(canvas.querySelectorAll('[data-slot="session-arc-canvas-link"]')).map((g) => {
           const nums = (g.querySelector("path").getAttribute("d") ?? "").match(/-?[0-9.]+/g) ?? [];
           return {
             from: g.getAttribute("data-from"),
             state: g.getAttribute("data-state"),
             endX: Number(nums[nums.length - 2]),
             endY: Number(nums[nums.length - 1]),
           };
         }),
         linksBeneath: cards.every(
           (el) => (svg.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
         ) && Number(getComputedStyle(svg).zIndex) < Math.min(...cards.map((el) => Number(getComputedStyle(el).zIndex))),
         canvasWidth: canvas.offsetWidth,
       };
     })()`,
  );

const cardOf = (reading: CanvasReading, rung: string): CardReading => {
  const found = reading.cards.find((c) => c.rung === rung);
  if (found === undefined) throw new Error(`no ${rung} card on the canvas`);
  return found;
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

describe.skipIf(!SHOULD_RUN)("AT0860: the arc shade's card canvas", () => {
  test(
    "four cards stand joined, a dragged card stays where it is dropped, and Tidy sends it home",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0860-arc-canvas",
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
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CANVAS)}) !== null`,
          { timeoutMs: 30_000 },
        );
        await app.dispatchControlAction("toggle-arc-shade");
        await shadeSettled(app, true);

        // ── Four cards at home, three connectors beneath them ─────────────
        const home = await read(app);
        note("at0860 home", JSON.stringify(home));
        expect(home.cards.map((c) => c.rung)).toEqual(["idea", "sketch", "brief", "arc"]);
        expect(home.cards.map((c) => [c.left, c.top])).toEqual([
          [16, 40],
          [272, 16],
          [528, 40],
          [784, 16],
        ]);
        expect(home.links.map((l) => l.from)).toEqual(["idea", "sketch", "brief"]);
        expect(home.linksBeneath, "the connectors are drawn beneath every card").toBe(true);
        // Each connector has a port at both ends, in its own state.
        expect(cardOf(home, "idea").ports).toEqual([`out:${home.links[0].state}`]);
        expect(cardOf(home, "sketch").ports).toEqual([`in:${home.links[0].state}`, `out:${home.links[1].state}`]);
        expect(cardOf(home, "brief").ports).toEqual([`in:${home.links[1].state}`, `out:${home.links[2].state}`]);
        expect(cardOf(home, "arc").ports).toEqual([`in:${home.links[2].state}`]);
        // The Arc card opens with its reading, and the connector into the
        // Brief card ends on that card's left edge, at port height.
        expect(cardOf(home, "arc").expanded).toBe(true);
        expect(cardOf(home, "arc").hasBody).toBe(true);
        expect(cardOf(home, "arc").width).toBe(440);
        expect(cardOf(home, "brief").width).toBe(200);
        expect([home.links[1].endX, home.links[1].endY]).toEqual([528, 40 + 64]);

        // ── A drag carries the card, raises it, and redraws its connector ─
        const grip = await app.body("A").getElementBounds(BRIEF_GRIP);
        const from = { x: Math.round(grip.x + grip.width / 2), y: Math.round(grip.y + grip.height / 2) };
        await app.body("A").nativeDrag(from, { x: from.x + DRAG.dx, y: from.y + DRAG.dy });
        await app.body("A").waitForCondition<boolean>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(rungCard("brief"))});
             return el !== null && el.style.left !== "528px" && el.getAttribute("data-dragging") === null;
           })()`,
          { timeoutMs: 6_000 },
        );
        const dragged = await read(app);
        note("at0860 dragged", JSON.stringify(dragged));
        const brief = cardOf(dragged, "brief");
        // The pointer moved in viewport pixels and the card is placed in
        // layout pixels, so the travel is divided by the deck's zoom.
        expect(Math.abs(brief.left - (528 + DRAG.dx / dragged.zoom)), "the card moved by the drag across").toBeLessThanOrEqual(2);
        expect(Math.abs(brief.top - (40 + DRAG.dy / dragged.zoom)), "and by the drag down").toBeLessThanOrEqual(2);
        for (const rung of ["idea", "sketch", "arc"]) {
          expect(cardOf(dragged, rung).left, `${rung} did not move`).toBe(cardOf(home, rung).left);
          expect(cardOf(dragged, rung).top).toBe(cardOf(home, rung).top);
          expect(brief.z, `the pressed card is in front of ${rung}`).toBeGreaterThan(cardOf(dragged, rung).z);
        }
        expect([dragged.links[1].endX, dragged.links[1].endY], "the connector follows the card").toEqual([
          brief.left,
          brief.top + 64,
        ]);

        // ── The layout is still there when the shade comes back ───────────
        await app.dispatchControlAction("toggle-arc-shade");
        await shadeSettled(app, false);
        await app.dispatchControlAction("toggle-arc-shade");
        await shadeSettled(app, true);
        const back = await read(app);
        expect([cardOf(back, "brief").left, cardOf(back, "brief").top], "the card is where it was dropped").toEqual([
          brief.left,
          brief.top,
        ]);

        // ── The Brief card shows the brief, and opens to its headings ─────
        const readBrief = (): Promise<{
          state: string | null;
          title: string;
          path: string;
          headings: string[];
          empties: string[];
        }> =>
          app.body("A").evalJS(
            `(() => {
               const card = document.querySelector(${JSON.stringify(rungCard("brief"))});
               const text = (el) => (el?.textContent ?? "").trim();
               return {
                 state: card.getAttribute("data-state"),
                 title: text(card.querySelector(".session-arc-canvas-card-title")),
                 path: text(card.querySelector('[data-slot="session-arc-brief-path"]')),
                 headings: Array.from(card.querySelectorAll('[data-slot="session-arc-brief-heading"]')).map(
                   (li) => li.getAttribute("data-kind") + ":" + Array.from(li.children).map(text).join(" "),
                 ),
                 empties: ["idea", "sketch"].map((rung) =>
                   text(document.querySelector(${JSON.stringify(CANVAS)} + ' [data-rung="' + rung + '"] .session-arc-canvas-card-title')),
                 ),
               };
             })()`,
          );
        const briefAtRest = await readBrief();
        note("at0860 brief card", JSON.stringify(briefAtRest));
        expect(briefAtRest.state).toBe("done");
        expect(briefAtRest.title).toBe(BRIEF_TITLE);
        expect(briefAtRest.path).toBe(`.tug/arcs/${ARC_NAME}/brief.md`);
        expect(briefAtRest.headings, "a closed card lists nothing").toEqual([]);
        expect(briefAtRest.empties).toEqual([
          "Nothing recorded for this arc yet",
          "Nothing recorded for this arc yet",
        ]);
        expect(home.links[2].state, "the arc is cut from its brief").toBe("linked");
        expect(home.links[0].state).toBe("pending");
        expect(home.links[1].state).toBe("pending");
        await app.body("A").click(BRIEF_TOGGLE);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${rungCard("brief")} [data-slot="session-arc-brief-heading"]`)}).length === 2`,
          { timeoutMs: 6_000 },
        );
        const opened = await read(app);
        expect(cardOf(opened, "brief").width).toBe(440);
        expect(cardOf(opened, "arc").left, "an open card pushes the one to its right along").toBe(784 + 240);
        expect((await readBrief()).headings).toEqual([
          "finding:F01 The canvas has four cards",
          "decision:B01 The Brief card lists these",
        ]);
        await app.body("A").click(BRIEF_TOGGLE);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(rungCard("brief"))})?.getAttribute("data-expanded") !== "true"`,
          { timeoutMs: 6_000 },
        );
        const closed = await read(app);
        expect(cardOf(closed, "brief").width).toBe(200);
        expect(cardOf(closed, "brief").hasBody).toBe(false);
        expect(cardOf(closed, "arc").left).toBe(784);

        // ── The Arc card is full size and moves like the others ───────────
        const arcCard = await app.body("A").evalJS<{
          full: boolean;
          headButtons: number;
          title: boolean;
          verbs: string[];
          cardWidth: number;
          listWidth: number;
        }>(
          `(() => {
             const card = document.querySelector(${JSON.stringify(rungCard("arc"))});
             // Bring the card into the shade's view: it stands at the right.
             const scroller = card.closest('[data-slot="session-arc-shade-body"]');
             if (scroller !== null) scroller.scrollLeft = scroller.scrollWidth;
             return {
               full: card.getAttribute("data-full") === "true",
               headButtons: card.querySelectorAll(".session-arc-canvas-card-head button").length,
               title: card.querySelector(".session-arc-canvas-card-title") !== null,
               verbs: Array.from(card.querySelectorAll('[data-slot="arc-verb"]')).map((b) => b.getAttribute("data-verb")),
               cardWidth: card.clientWidth,
               listWidth: card.querySelector(".session-arc-popover")?.offsetWidth ?? 0,
             };
           })()`,
        );
        note("at0860 arc card", JSON.stringify(arcCard));
        expect(arcCard.full).toBe(true);
        expect(arcCard.headButtons, "a full card has no collapse").toBe(0);
        expect(arcCard.title, "the reading says the arc's name itself").toBe(false);
        expect(arcCard.listWidth, "the reading fills the card").toBe(arcCard.cardWidth);
        for (const verb of ["changes", "unbind", "discard"]) {
          expect(arcCard.verbs, `the card offers ${verb}`).toContain(verb);
        }
        expect(back.canvasWidth, "the canvas holds the full card").toBeGreaterThanOrEqual(784 + 440);
        const arcGrip = await app.body("A").getElementBounds(ARC_GRIP);
        const arcFrom = {
          x: Math.round(arcGrip.x + arcGrip.width / 2),
          y: Math.round(arcGrip.y + arcGrip.height / 2),
        };
        await app.body("A").nativeDrag(arcFrom, { x: arcFrom.x - 40, y: arcFrom.y + 20 });
        await app.body("A").waitForCondition<boolean>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(rungCard("arc"))});
             return el !== null && el.style.left !== "784px" && el.getAttribute("data-dragging") === null;
           })()`,
          { timeoutMs: 6_000 },
        );
        const arcMoved = cardOf(await read(app), "arc");
        expect(Math.abs(arcMoved.left - (784 - 40 / back.zoom)), "the Arc card moved by the drag").toBeLessThanOrEqual(2);
        expect(Math.abs(arcMoved.top - (16 + 20 / back.zoom))).toBeLessThanOrEqual(2);

        // ── Tidy sends the card home ──────────────────────────────────────
        await app.body("A").click(TIDY);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(rungCard("brief"))})?.style.left === "528px"`,
          { timeoutMs: 6_000 },
        );
        const tidied = await read(app);
        expect(tidied.cards.map((c) => [c.left, c.top])).toEqual(home.cards.map((c) => [c.left, c.top]));
        expect(cardOf(tidied, "arc").expanded, "Tidy leaves an open card open").toBe(true);

        // ── Discard's confirm stands on the Arc card ──────────────────────
        await app.body("A").click(arcVerb("discard"));
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 6_000 },
        );
        const confirm = await app.body("A").evalJS<{
          popover: { l: number; t: number; r: number; b: number };
          card: { l: number; t: number; r: number; b: number };
        }>(
          `(() => {
             const box = (el) => {
               const r = el.getBoundingClientRect();
               return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
             };
             return {
               popover: box(document.querySelector(${JSON.stringify(CONFIRM)})),
               card: box(document.querySelector(${JSON.stringify(rungCard("arc"))})),
             };
           })()`,
        );
        note("at0860 confirm", JSON.stringify(confirm));
        expect(confirm.popover.r - confirm.popover.l, "the confirm is drawn").toBeGreaterThan(0);
        expect(
          confirm.popover.l < confirm.card.r &&
            confirm.popover.r > confirm.card.l &&
            confirm.popover.t < confirm.card.b &&
            confirm.popover.b > confirm.card.t,
          "the confirm stands on the Arc card",
        ).toBe(true);
        await app.body("A").click(`${CONFIRM} [data-slot="tug-confirm-cancel"]`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
          { timeoutMs: 6_000 },
        );
        expect(
          await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(rungCard("arc"))}) !== null`),
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
