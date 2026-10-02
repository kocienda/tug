/**
 * at0673-rail-width-drag-frames.test.ts — a rail width drag costs a frame
 * less than half a frame to draw.
 *
 * Dragging a rail's edge moves the whole deck: the rail's own members, the
 * shadow it casts, and every card in the chain beside it. The preview pays
 * for each by the cheapest write that puts it where the committed width will
 * — px pins on the rail's frames, `translate` on everything else — and never
 * writes the rail's width property, which is inherited and would restyle
 * every card in the deck per frame. This file is the reading that says so.
 *
 * **The recorder is armed before the press.** A frame record that starts at
 * the gesture's first commit, as the settle's does, misses the frames the
 * press itself costs; this one is running before the pointer goes down and
 * keeps only the frames that begin while it is down. Each frame's cost
 * is read the way a main thread spends it: an animation-frame callback marks
 * the frame's start and posts a message, and the message runs once that
 * frame's rendering update — style, layout, paint — is done. Its distance
 * from the mark is what that frame cost the main thread. An interval between
 * callbacks would read the display's period instead, whatever the work was.
 *
 * **The window is visible** (`foreground`): a covered app-test window gets
 * no animation frames at all, and a reading of no frames is no reading.
 *
 * The rail is three members including the Overview — the most expensive
 * reader a rail holds — beside a three-card fit chain, dragged out and back
 * at the display's rate. The bar is a p95 frame cost under 8.3 ms, and every
 * frame over 16 ms is recorded in the report whether or not the bar holds.
 *
 * **The release moves nothing.** A second reading samples every member on
 * every painted frame from the release until the deck is long quiet, and
 * requires each one to stay fully opaque and at the width the hand left it.
 * A member the settle mistook for an arrival — measured by nobody before the
 * commit, then found unmarked after it — is held invisible and faded back
 * up, which reads as the rail vanishing at the release. An end-state check
 * cannot see that; only a per-frame sample can.
 *
 * @foreground
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/lib/rail-width.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { MIN_OVERVIEW_WIDTH_PX } from "../../tugdeck/src/lib/overview-measure";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Every member's seeded width: clear of the Overview's floor below and the
 *  slim ceiling (675) above by more than either leg travels. */
const RAIL_WIDTH = 520;
const GROW_PX = 120;
const SHRINK_PX = 200;
/** The bar: half of a 60 Hz frame. */
const P95_BAR_MS = 8.3;
/** A frame over this cost dropped a 60 Hz frame; each one is reported. */
const LONG_FRAME_MS = 16;
/** Pointer moves at the display's rate, so the drag looks like a hand's. */
const STEPS = 40;
const STEP_MS = 16;
/** Fewer frames than this inside the gesture means the window was not served. */
const MIN_FRAMES = 20;
const TOL = 1.5;
const AFTER_LAND_MS = 900;

const MEMBERS = ["overview", "jots", "layout"] as const;
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
      { id: "G", componentId: "overview", title: "Overview", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "B", componentId: "hello", title: "Card B", closable: true },
      { id: "C", componentId: "hello", title: "Card C", closable: true },
    ],
    panes: [
      chainPane("p1", "A", 0),
      chainPane("p2", "B", 1),
      chainPane("p3", "C", 2),
      railPane("pOverview", "G", "Overview"),
      railPane("pJots", "J", "Jots"),
      railPane("pLayout", "L", "Layout"),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      layout: "fit",
      sidebars: {
        overview: { side: "left" },
        jots: { side: "left" },
        layout: { side: "left" },
      },
      rails: { left: { order: [...MEMBERS] } },
    },
    hasFocus: true,
  };
}

interface FrameRecord {
  /** Frame costs inside the gesture, ms, in order. */
  costs: number[];
  /** Each long frame's offset from the press, ms, and its cost. */
  long: { atMs: number; costMs: number }[];
}

/**
 * Arm the recorder. It runs until `takeFrames`, and keeps a frame only when
 * it began with the pointer down — the press is caught on its way down,
 * before any listener of the deck's sees it, and the idle frames between
 * the two legs are not counted toward the drag.
 */
async function armFrames(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = { all: [], downAt: null, down: false, running: true };
      window.__at0673 = rec;
      window.addEventListener("pointerdown", function () {
        if (rec.downAt === null) rec.downAt = performance.now();
        rec.down = true;
      }, true);
      window.addEventListener("pointerup", function () {
        rec.down = false;
      }, true);
      var channel = new MessageChannel();
      var started = null;
      var startedDown = false;
      channel.port1.onmessage = function () {
        if (started === null) return;
        if (startedDown) rec.all.push({ t: started, cost: performance.now() - started });
        started = null;
      };
      var tick = function () {
        if (!rec.running) return;
        started = performance.now();
        startedDown = rec.down;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

/** Stop the recorder and read the frames that began with the button down. */
async function takeFrames(app: App): Promise<FrameRecord> {
  return app.evalJS<FrameRecord>(
    `(function () {
      var rec = window.__at0673;
      rec.running = false;
      var inside = rec.all;
      return {
        costs: inside.map(function (f) { return f.cost; }),
        long: inside
          .filter(function (f) { return f.cost > ${LONG_FRAME_MS}; })
          .map(function (f) { return { atMs: f.t - rec.downAt, costMs: f.cost }; }),
      };
    })()`,
  );
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

async function grip(app: App): Promise<{ x: number; y: number }> {
  return app.evalJS<{ x: number; y: number }>(
    `(function () {
      var r = document.querySelector(${JSON.stringify(HANDLE)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
}

function memberWidths(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var out = {};
      document.querySelectorAll('.tug-pane[data-rail-side="left"]').forEach(function (el) {
        out[el.getAttribute("data-rail-member")] = el.getBoundingClientRect().width;
      });
      return out;
    })()`,
  );
}

/** Every member, every painted frame, from the release until `takeRelease`. */
interface ReleaseSample {
  /** Frames sampled after the release. */
  frames: number;
  /** The lowest computed opacity any member showed on any of them. */
  minOpacity: number;
  /** Each member's width range across them, layout px. */
  widths: Record<string, { min: number; max: number }>;
}

/** Arm the release sampler: it starts at the pointer's release and reads every
 *  rail member's opacity and width on each animation frame. */
async function armRelease(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = { frames: 0, minOpacity: 1, widths: {}, released: false, running: true };
      window.__at0673release = rec;
      window.addEventListener("pointerup", function () { rec.released = true; }, true);
      var tick = function () {
        if (!rec.running) return;
        if (rec.released) {
          rec.frames += 1;
          document.querySelectorAll('.tug-pane[data-rail-side="left"]').forEach(function (el) {
            var o = parseFloat(getComputedStyle(el).opacity);
            if (o < rec.minOpacity) rec.minOpacity = o;
            var m = el.getAttribute("data-rail-member");
            var w = el.getBoundingClientRect().width;
            var r = rec.widths[m] || (rec.widths[m] = { min: w, max: w });
            if (w < r.min) r.min = w;
            if (w > r.max) r.max = w;
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

async function takeRelease(app: App): Promise<ReleaseSample> {
  return app.evalJS<ReleaseSample>(
    `(function () {
      var rec = window.__at0673release;
      rec.running = false;
      return { frames: rec.frames, minOpacity: rec.minOpacity, widths: rec.widths };
    })()`,
  );
}

async function seedRail(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length === 3`,
    { timeoutMs: 15_000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)(
  "at0673 — a rail width drag over a three-member rail stays inside half a frame",
  () => {
    test(
      "a pre-armed recorder reads p95 frame cost under 8.3 ms across the drag",
      async () => {
        const app = await launchTugApp({
          testName: "at0673-rail-width-drag-frames",
          foreground: true,
        });
        try {
          expect(RAIL_WIDTH - SHRINK_PX + GROW_PX).toBeGreaterThan(MIN_OVERVIEW_WIDTH_PX);
          await seedRail(app);

          await armFrames(app);
          await wait(200);

          // Out and back: grow the rail, then narrow it past where it started.
          const from = await grip(app);
          const out = { x: from.x + GROW_PX, y: from.y };
          await app.nativeDrag(from, out, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          await wait(AFTER_LAND_MS);
          const back = await grip(app);
          await app.nativeDrag(back, { x: back.x - SHRINK_PX, y: back.y }, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          const frames = await takeFrames(app);

          const cost95 = frames.costs.length === 0 ? Infinity : p95(frames.costs);
          note(
            `frames inside the gesture: ${frames.costs.length}; ` +
              `p95 cost ${cost95.toFixed(2)} ms; ` +
              `max ${Math.max(0, ...frames.costs).toFixed(2)} ms`,
          );
          for (const f of frames.long) {
            note(`long frame at +${f.atMs.toFixed(0)} ms: ${f.costMs.toFixed(2)} ms`);
          }

          expect(
            frames.costs.length,
            "the window was served animation frames across the drag",
          ).toBeGreaterThanOrEqual(MIN_FRAMES);
          expect(cost95, "p95 frame cost across the drag").toBeLessThan(P95_BAR_MS);

          // And the release left the rail where the hand did, every member.
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-pointer-owned]") === null`,
            { timeoutMs: 3_000 },
          );
          await wait(AFTER_LAND_MS);
          const expected = RAIL_WIDTH + GROW_PX - SHRINK_PX;
          const widths = await memberWidths(app);
          for (const member of MEMBERS) {
            expect(
              Math.abs((widths[member] ?? 0) - expected),
              `${member} stands at ${expected}px (read ${widths[member]?.toFixed(1)})`,
            ).toBeLessThanOrEqual(TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "every member stays opaque and at the released width on every frame after the release",
      async () => {
        const app = await launchTugApp({
          testName: "at0673-rail-width-drag-release",
          foreground: true,
        });
        try {
          await seedRail(app);
          await armRelease(app);

          const from = await grip(app);
          await app.nativeDrag(from, { x: from.x + GROW_PX, y: from.y }, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          await wait(AFTER_LAND_MS);
          const sample = await takeRelease(app);

          const expected = RAIL_WIDTH + GROW_PX;
          note(
            `after release: ${sample.frames} frames; min opacity ${sample.minOpacity}; ` +
              `widths ${JSON.stringify(sample.widths)}`,
          );
          expect(
            sample.frames,
            "the window was served animation frames after the release",
          ).toBeGreaterThanOrEqual(MIN_FRAMES);
          expect(
            sample.minOpacity,
            "no member faded out at the release",
          ).toBeGreaterThanOrEqual(0.999);
          for (const member of MEMBERS) {
            const w = sample.widths[member];
            expect(w, `${member} was sampled`).toBeDefined();
            expect(
              Math.max(Math.abs(w.min - expected), Math.abs(w.max - expected)),
              `${member} held ${expected}px on every frame (read ${w.min.toFixed(1)}–${w.max.toFixed(1)})`,
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
