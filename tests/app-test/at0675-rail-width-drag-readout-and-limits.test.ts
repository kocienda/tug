/**
 * at0675-rail-width-drag-readout-and-limits.test.ts — a rail width drag says
 * where it will land, gives at its limits, and springs back to them.
 *
 * While the hand drags a rail's edge, a readout pill rides beside the pointer
 * showing the width the release would commit, and every member is marked as
 * held. Between the floor and the ceiling the edge follows the hand exactly
 * and the release lands where it stands, with nothing left to move. Past a
 * limit the edge keeps following with diminishing returns, the rail is marked
 * as at its limit, and the readout reads the limit rather than the hand's
 * overshoot; the release then springs the edge back to the limit — the one
 * motion a release makes — and commits the limit. Either way the readout
 * fades once the hand lets go and is gone shortly after.
 *
 * The spring is read by an in-page sampler: every animation frame records the
 * rail's rendered width and whether the button is down, so the frames between
 * the release and the landing are counted rather than guessed at.
 *
 * **The window is visible** (`foreground`): a covered app-test window gets
 * no animation frames, and the preview, the readout and the spring are all
 * written in one.
 *
 * @foreground
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/lib/rail-width.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

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
const TOL = 1.5;
const AFTER_LAND_MS = 900;
const FRAMES_MS = 250;
/** The readout's fade, and the draft's removal after it, with room. */
const READOUT_GONE_MS = 800;

const MEMBERS = ["jots", "layout"] as const;
const HANDLE = `.tug-pane[data-pane-id="pJots"] .tug-pane-resize-e`;

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

/** Record, every animation frame, the rail's rendered width and whether the
 *  button is down. */
async function armSampler(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = { samples: [], down: false, running: true };
      window.__at0675 = rec;
      window.addEventListener("pointerdown", function () { rec.down = true; }, true);
      window.addEventListener("pointerup", function () { rec.down = false; }, true);
      var tick = function () {
        if (!rec.running) return;
        var el = document.querySelector('.tug-pane[data-pane-id="pJots"]');
        rec.samples.push({ down: rec.down, width: el.getBoundingClientRect().width });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

function takeSamples(app: App): Promise<{ down: boolean; width: number }[]> {
  return app.evalJS<{ down: boolean; width: number }[]>(
    `(function () {
      var rec = window.__at0675;
      rec.running = false;
      return rec.samples;
    })()`,
  );
}

interface Mid {
  readout: string | null;
  readoutLimit: string | null;
  held: number;
  limit: (string | null)[];
  width: number;
}

/** The drag as it stands mid-gesture. */
function readMid(app: App): Promise<Mid> {
  return app.evalJS<Mid>(
    `(function () {
      var r = document.querySelector(".tug-rail-readout:not([data-leaving])");
      var members = document.querySelectorAll('.tug-pane[data-rail-side="left"]');
      var limit = [];
      var held = 0;
      members.forEach(function (el) {
        if (el.hasAttribute("data-rail-held")) held++;
        limit.push(el.getAttribute("data-rail-limit"));
      });
      return {
        readout: r === null ? null : r.textContent,
        readoutLimit: r === null ? null : r.getAttribute("data-limit"),
        held: held,
        limit: limit,
        width: document.querySelector('.tug-pane[data-pane-id="pJots"]').getBoundingClientRect().width,
      };
    })()`,
  );
}

function storedWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var p = window.tugdeck.diag.getDeckState().panes.filter(function (p) { return p.id === ${JSON.stringify(paneId)}; })[0];
      return p === undefined ? -1 : p.size.width;
    })()`,
  );
}

function count(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

async function grip(app: App): Promise<{ x: number; y: number }> {
  return app.evalJS<{ x: number; y: number }>(
    `(function () {
      var r = document.querySelector(${JSON.stringify(HANDLE)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
}

const readoutWidth = (text: string | null): number =>
  text === null ? NaN : parseFloat(text);

describe.skipIf(!SHOULD_RUN)(
  "at0675 — a rail width drag shows where it will land, and springs back from its limits",
  () => {
    test(
      "between the limits the readout reads the width, and the release lands with no spring",
      async () => {
        const app = await launchTugApp({
          testName: "at0675-rail-width-readout",
          foreground: true,
        });
        try {
          await seed(app);
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
          ).toBeLessThanOrEqual(TOL);
          expect(mid.readoutLimit, "the readout is at no limit").toBeNull();
          expect(mid.limit.every((l) => l === null), "no member is at a limit").toBe(true);

          await armSampler(app);
          await app.nativeMouseUp(to);
          await wait(FRAMES_MS);
          const samples = await takeSamples(app);
          const after = samples.filter((s) => !s.down);
          const between = after.filter(
            (s) => Math.abs(s.width - target) > TOL,
          );
          expect(
            between.length,
            `the release moves nothing: ${JSON.stringify(between.slice(0, 5))}`,
          ).toBe(0);

          expect(
            await count(app, ".tug-rail-readout[data-leaving]"),
            "the readout is fading once the hand lets go",
          ).toBe(1);
          await wait(READOUT_GONE_MS);
          expect(await count(app, ".tug-rail-readout"), "the readout is gone").toBe(0);
          expect(await count(app, "[data-rail-held]"), "nothing is still held").toBe(0);
          expect(Math.abs((await storedWidth(app, "pLayout")) - target)).toBeLessThanOrEqual(TOL);
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
          testName: "at0675-rail-width-limit",
          foreground: true,
        });
        try {
          await seed(app);
          const ceiling = CONTENT_WIDTH_SLIM_PX;
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
          ).toBeLessThanOrEqual(TOL);
          expect(mid.readoutLimit, "the readout says it is at the ceiling").toBe("ceiling");
          expect(mid.limit, "every member is marked at the ceiling").toEqual(
            MEMBERS.map(() => "ceiling"),
          );
          expect(mid.width, "the edge gives past the ceiling").toBeGreaterThan(ceiling + 10);
          expect(mid.width, "and never by the whole give").toBeLessThan(
            ceiling + RAIL_LIMIT_GIVE_PX,
          );

          await armSampler(app);
          await app.nativeMouseUp(to);
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-pointer-owned]") === null`,
            { timeoutMs: 3_000 },
          );
          await wait(FRAMES_MS);
          const samples = await takeSamples(app);
          const after = samples.filter((s) => !s.down);
          const spring = after.filter(
            (s) => s.width > ceiling + TOL && s.width < mid.width - TOL,
          );
          note(
            `after release: ${after.length} frames; spring frames: ${spring
              .map((s) => s.width.toFixed(1))
              .join(", ")}`,
          );
          expect(spring.length, "the edge springs back over several frames").toBeGreaterThanOrEqual(3);
          for (let i = 1; i < after.length; i++) {
            expect(
              after[i].width,
              "the spring only ever moves toward the ceiling",
            ).toBeLessThanOrEqual(after[i - 1].width + TOL);
          }
          expect(
            Math.abs(after[after.length - 1].width - ceiling),
            "the rail lands on the ceiling",
          ).toBeLessThanOrEqual(TOL);

          await wait(READOUT_GONE_MS);
          expect(await count(app, ".tug-rail-readout"), "the readout is gone").toBe(0);
          expect(await count(app, "[data-rail-limit]"), "no member is still at a limit").toBe(0);
          expect(await count(app, "[data-rail-held]"), "nothing is still held").toBe(0);
          for (const pane of ["pJots", "pLayout"]) {
            expect(
              Math.abs((await storedWidth(app, pane)) - ceiling),
              `${pane} committed the ceiling`,
            ).toBeLessThanOrEqual(TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
