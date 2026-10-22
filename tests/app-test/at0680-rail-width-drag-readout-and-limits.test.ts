/**
 * at0680-rail-width-drag-readout-and-limits.test.ts — a rail width drag says
 * where it will land, gives at its limits, and springs back to them.
 *
 * While the hand drags a rail's edge, a readout pill rides beside the pointer
 * showing the width the release would commit, and every member is marked as
 * held. The edge the hand moves is the ghost's — the host's layer showing the
 * rail's new footprint — and nothing of the rail moves until the release
 * commits. Between the floor and the ceiling the ghost's edge follows the
 * hand exactly, and the release removes it at once and commits where it
 * stood. Past a limit the ghost's edge keeps following with diminishing
 * returns, the rail is marked as at its limit, and the readout reads the
 * limit rather than the hand's overshoot; the release then springs the
 * ghost's edge back to the limit, the members still standing where they were
 * pressed, and commits the limit when the spring lands. Either way the
 * settle then carries the members to the committed width, and the readout
 * fades once the hand lets go and is gone shortly after.
 *
 * The held marks and the limit marks are the shell's own state, and are read
 * in the shell; the readout is the shell's answer drawn by the overlay page
 * above every card, and is read there. Where the ghost and the rail stand is
 * neither: the host draws both, and the shell's stand-ins are only its model.
 * So the ghost's width, its give past the ceiling and the members standing
 * still are read off the host's snapshot, and the spring is read in the
 * composite: a capture burst from the release finds the ghost's edge by its
 * accent line on every frame until the commit, so the
 * frames of the spring are counted rather than guessed at, and the host's
 * snapshot after the settle says every member stands at the ceiling.
 *
 * **The window renders** (`visible`): a covered app-test window otherwise gets
 * no animation frames, and the ghost, the readout and the spring are all
 * written in one.
 *
 * @visible
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/overlay/overlay-indication.ts
 * @covers tugdeck/src/lib/rail-width.ts
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugapp/Sources/CardGeometry.swift
 * @covers tugapp/Sources/RailView.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { chromePoint } from "./card-chrome-fixture";
import { PIXEL_TOL } from "./_harness/tolerances";
import { armBurst, readBurst } from "./one-view-fixture";
import { overlayReady } from "./overlay-fixture";
import { CARD_APRON_PX, armReportRecord, railReader, readRailFacts, takeReportRecord } from "./rail-width-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// Stated here rather than imported: either module pulls the deck's whole
// import graph into this project's typecheck.
/** The rail ceiling — the allocator's slim content width
 *  (`CONTENT_WIDTH_SLIM_PX` in `layout-imposer.ts`). */
const CONTENT_WIDTH_SLIM_PX = 675;
/** The most the edge gives past a limit (`RAIL_LIMIT_GIVE_PX` in
 *  `rail-width.ts`). */
const RAIL_LIMIT_GIVE_PX = 48;
/** Every member's seeded width: well inside both limits. */
const RAIL_WIDTH = 600;
/** Far enough past the slim ceiling that the edge is well into its give. */
const PAST_CEILING_PX = 200;
const NARROW_PX = 100;
const STEPS = 20;
const STEP_MS = 16;
const AFTER_LAND_MS = 900;
const FRAMES_MS = 250;
/** The readout's fade, and the draft's removal after it, with room. */
const READOUT_GONE_MS = 800;
/** How far a composite edge may stand from where it should, device px. */
const EDGE_TOL_DEVICE = 2;

const MEMBERS = ["jots", "layout"] as const;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function railPane(id: string, cardId: string, title: string) {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  };
}

function chainPane(id: string, cardId: string, slot: number) {
  return {
    id,
    position: { x: 40, y: 40 },
    size: { width: 360, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  };
}

function deckShape() {
  return {
    cards: [
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "B", componentId: "hello", title: "Card B", closable: true },
    ],
    panes: [
      chainPane("p1", "A", 0),
      chainPane("p2", "B", 1),
      railPane("pJots", "J", "Jots"),
      railPane("pLayout", "L", "Layout"),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "two-up",
      layout: "fit",
      sidebars: {
        jots: { side: "left" },
        layout: { side: "left" },
      },
      rails: { left: { order: [...MEMBERS] } },
    },
    hasFocus: true,
  };
}

// Kept local: every file's `seed` builds its own deck and waits on its own
// readiness, so the name is shared and the function is not.
async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length === 2`,
    { timeoutMs: 15_000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** The pane width the host shows a member's view at now, points: its presented frame less the apron. */
async function hostWidth(app: App, card: string): Promise<number> {
  const view = (await app.bodies()).find((b) => b.cardId === card && b.visible);
  expect(view, `the host holds ${card}'s view`).toBeDefined();
  return view!.presentedFrame.width - 2 * CARD_APRON_PX;
}

/** The ghost standing over `card`'s rail, as the host's snapshot reports it: its width in layout px and whether it is past a limit; null when none stands. */
async function hostGhost(app: App, card: string, zoom: number): Promise<{ width: number; pastLimit: boolean } | null> {
  const view = (await app.bodies()).find((b) => b.cardId === card && b.visible);
  expect(view, `the host holds ${card}'s view`).toBeDefined();
  const ghost = view!.rail?.ghost ?? null;
  return ghost === null ? null : { width: ghost.frame.width / zoom, pastLimit: ghost.pastLimit };
}

/** Every member's view, placed and shown, at `width` plus the apron, and out of the hand. */
async function expectHostAt(app: App, width: number, phase: string): Promise<void> {
  const views = await app.bodies();
  for (const card of ["J", "L"]) {
    const view = views.find((b) => b.cardId === card && b.visible);
    expect(view, `${phase}: the host holds ${card}'s view`).toBeDefined();
    expect(view!.inHand, `${phase}: ${card} is out of the hand`).toBe(false);
    for (const [what, rect] of [["placed", view!.frame], ["shown", view!.presentedFrame]] as const) {
      expect(
        Math.abs(rect.width - (width + 2 * CARD_APRON_PX)),
        `${phase}: ${card}'s view ${what} at ${width} (read ${rect.width - 2 * CARD_APRON_PX})`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

interface Mid {
  readout: string | null;
  readoutLimit: string | null;
  held: number;
  limit: (string | null)[];
}

/** The drag as it stands mid-gesture: the marks in the shell, the readout in the overlay. */
async function readMid(app: App): Promise<Mid> {
  const pill = await (await overlayReady(app)).evalJS<{ text: string | null; limit: string | null } | null>(
    `(function () {
      var r = document.querySelector(".tug-rail-readout:not([data-leaving])");
      return r === null ? null : { text: r.textContent, limit: r.getAttribute("data-limit") };
    })()`,
  );
  const marks = await app.evalJS<{ held: number; limit: (string | null)[] }>(
    `(function () {
      var members = document.querySelectorAll('.tug-pane[data-rail-side="left"]');
      var limit = [];
      var held = 0;
      members.forEach(function (el) {
        if (el.hasAttribute("data-rail-held")) held++;
        limit.push(el.getAttribute("data-rail-limit"));
      });
      return { held: held, limit: limit };
    })()`,
  );
  return { readout: pill?.text ?? null, readoutLimit: pill?.limit ?? null, ...marks };
}

function storedWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var p = window.tugdeck.diag.getDeckState().panes.filter(function (p) { return p.id === ${JSON.stringify(paneId)}; })[0];
      return p === undefined ? -1 : p.size.width;
    })()`,
  );
}

/** How many elements match `selector` in `page`: the shell, or the overlay. */
function count(page: Pick<App, "evalJS">, selector: string): Promise<number> {
  return page.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

async function grip(app: App): Promise<{ x: number; y: number }> {
  // The rail card draws its edge grip in its own page.
  return chromePoint(app, "J", ".tug-pane-resize-e");
}

const readoutWidth = (text: string | null): number =>
  text === null ? NaN : parseFloat(text);

describe.skipIf(!SHOULD_RUN)(
  "at0680 — a rail width drag shows where it will land, and springs back from its limits",
  () => {
    test(
      "between the limits the readout reads the width, and the release lands with no spring",
      async () => {
        const app = await launchTugApp({
          testName: "at0680-rail-width-readout",
          visible: true,
        });
        try {
          await seed(app);
          const { zoom } = await readRailFacts(app);
          const from = await grip(app);
          const to = { x: from.x - NARROW_PX, y: from.y };
          await app.nativeDragWithoutRelease(from, to, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          await wait(FRAMES_MS);

          const target = RAIL_WIDTH - NARROW_PX;
          const mid = await readMid(app);
          note(`mid-drag: ${JSON.stringify(mid)}`);
          expect(mid.held, "every member is marked held").toBe(MEMBERS.length);
          expect(
            Math.abs(readoutWidth(mid.readout) - target),
            `the readout reads ${target} (read ${mid.readout})`,
          ).toBeLessThanOrEqual(PIXEL_TOL);
          expect(mid.readoutLimit, "the readout is at no limit").toBeNull();
          expect(await count(app, ".tug-rail-readout"), "the shell draws no readout of its own").toBe(0);
          expect(mid.limit.every((l) => l === null), "no member is at a limit").toBe(true);

          const ghost = await hostGhost(app, "J", zoom);
          note(`mid-drag ghost: ${JSON.stringify(ghost)}`);
          expect(ghost, "the host draws the ghost while the hand is down").not.toBeNull();
          expect(
            Math.abs(ghost!.width - target),
            `the ghost stands at the hand's width (read ${ghost!.width.toFixed(1)})`,
          ).toBeLessThanOrEqual(PIXEL_TOL);
          expect(ghost!.pastLimit, "the ghost is at no limit").toBe(false);
          expect(
            Math.abs((await hostWidth(app, "J")) - RAIL_WIDTH),
            "the rail itself stands where it was pressed",
          ).toBeLessThanOrEqual(PIXEL_TOL);
          await app.nativeMouseUp(to);
          await wait(FRAMES_MS);
          expect(await hostGhost(app, "J", zoom), "the release takes the ghost away with no spring").toBeNull();

          expect(
            await count(await overlayReady(app), ".tug-rail-readout[data-leaving]"),
            "the readout is fading once the hand lets go",
          ).toBe(1);
          await wait(READOUT_GONE_MS);
          expect(await count(await overlayReady(app), ".tug-rail-readout"), "the readout is gone").toBe(0);
          expect(await count(app, "[data-rail-held]"), "nothing is still held").toBe(0);
          expect(Math.abs((await storedWidth(app, "pLayout")) - target)).toBeLessThanOrEqual(PIXEL_TOL);
          await expectHostAt(app, target, "after the land");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "past the ceiling the edge gives, the readout reads the ceiling, and the release springs back to it",
      async () => {
        const app = await launchTugApp({
          testName: "at0680-rail-width-limit",
          visible: true,
        });
        try {
          await seed(app);
          const ceiling = CONTENT_WIDTH_SLIM_PX;
          const { zoom } = await readRailFacts(app);
          // Calibrated on the standing deck, with room for the give.
          const reader = await railReader(app, ["J", "L"], null, ceiling - RAIL_WIDTH + RAIL_LIMIT_GIVE_PX + 20);
          const jots = reader.members[0];
          const paneLeft = jots.restEdge - RAIL_WIDTH * zoom;
          await armReportRecord(app);
          const from = await grip(app);
          const to = { x: from.x + (ceiling - RAIL_WIDTH) + PAST_CEILING_PX, y: from.y };
          await app.nativeDragWithoutRelease(from, to, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          await wait(FRAMES_MS);

          const mid = await readMid(app);
          note(`past the ceiling: ${JSON.stringify(mid)}`);
          expect(
            Math.abs(readoutWidth(mid.readout) - ceiling),
            `the readout reads the ceiling, ${ceiling} (read ${mid.readout})`,
          ).toBeLessThanOrEqual(PIXEL_TOL);
          expect(mid.readoutLimit, "the readout says it is at the ceiling").toBe("ceiling");
          expect(mid.limit, "every member is marked at the ceiling").toEqual(
            MEMBERS.map(() => "ceiling"),
          );
          // The give is the ghost's: the host draws it past the ceiling, and
          // the rail itself stands where it was pressed.
          const ghost = await hostGhost(app, "J", zoom);
          expect(ghost, "the host draws the ghost while the hand is down").not.toBeNull();
          const given = ghost!.width;
          note(`the host shows the rail at ${given.toFixed(1)} past a ${ceiling} ceiling`);
          expect(given, "the edge gives past the ceiling").toBeGreaterThan(ceiling + 10);
          expect(given, "and never by the whole give").toBeLessThan(ceiling + RAIL_LIMIT_GIVE_PX);
          expect(ghost!.pastLimit, "the ghost's edge is drawn past its limit").toBe(true);
          expect(
            Math.abs((await hostWidth(app, "J")) - RAIL_WIDTH),
            "the rail itself stands where it was pressed",
          ).toBeLessThanOrEqual(PIXEL_TOL);

          // The spring, in the composite: the ghost's edge against the
          // standing deck on every frame from the release until the commit,
          // read on the row the readout beside the pointer does not cross,
          // and the members' edges read through it.
          await armBurst(app, reader.crop);
          const upAt = Date.now();
          await app.nativeMouseUp(to);
          const reading = await readBurst(app);
          const committedAt = (await takeReportRecord(app)).find((r) => r.phase === "end")?.wall;
          expect(committedAt, "the host reported the commit when the spring landed").toBeDefined();
          const releaseEdge = reader.toDevice(paneLeft + given * zoom);
          const ceilingEdge = reader.toDevice(paneLeft + ceiling * zoom);
          const after = reading.frames
            .filter((f) => f.wall >= upAt && f.wall < committedAt!)
            .map((f) => ({ t: f.wall - upAt, edge: reader.ghostEdges(f)[1], members: reader.edgesMoved(f).members }));
          note(
            `from release to commit, ${(committedAt! - upAt).toFixed(0)} ms (release edge ${releaseEdge.toFixed(1)}, ceiling edge ${ceilingEdge.toFixed(1)} device px): ` +
              after.map((a) => `+${a.t.toFixed(0)}ms ${a.edge} members ${JSON.stringify(a.members)}`).join(", "),
          );
          expect(after.length, "the burst caught frames of the spring").toBeGreaterThanOrEqual(5);
          expect(after.every((a) => a.edge !== null), "the ghost stands on every frame until the commit").toBe(true);
          const edges = after.map((a) => a.edge!);
          const spring = edges.filter((e) => e > ceilingEdge + EDGE_TOL_DEVICE && e < releaseEdge - EDGE_TOL_DEVICE);
          expect(spring.length, "the edge springs back over several frames").toBeGreaterThanOrEqual(3);
          for (let i = 1; i < edges.length; i++) {
            expect(
              edges[i],
              "the spring only ever moves toward the ceiling",
            ).toBeLessThanOrEqual(edges[i - 1] + 1);
          }
          expect(
            Math.abs(edges[edges.length - 1] - ceilingEdge),
            "the ghost's edge lands on the ceiling before the commit",
          ).toBeLessThanOrEqual(EDGE_TOL_DEVICE);
          after.forEach((a) =>
            a.members.forEach((d, i) => {
              if (d === "line") return;
              expect(d, `${MEMBERS[i]}'s edge is read through the ghost at +${a.t.toFixed(0)}ms`).not.toBeNull();
              expect(
                Math.abs(d as number),
                `${MEMBERS[i]} stands where it was pressed through the spring, at +${a.t.toFixed(0)}ms`,
              ).toBeLessThanOrEqual(EDGE_TOL_DEVICE);
            }),
          );
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-pointer-owned]") === null`,
            { timeoutMs: 3_000 },
          );
          await wait(AFTER_LAND_MS);
          await expectHostAt(app, ceiling, "after the spring");
          expect(await hostGhost(app, "J", zoom), "no ghost stands once the spring has landed").toBeNull();

          await wait(READOUT_GONE_MS);
          expect(await count(await overlayReady(app), ".tug-rail-readout"), "the readout is gone").toBe(0);
          expect(await count(app, "[data-rail-limit]"), "no member is still at a limit").toBe(0);
          expect(await count(app, "[data-rail-held]"), "nothing is still held").toBe(0);
          for (const pane of ["pJots", "pLayout"]) {
            expect(
              Math.abs((await storedWidth(app, pane)) - ceiling),
              `${pane} committed the ceiling`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
