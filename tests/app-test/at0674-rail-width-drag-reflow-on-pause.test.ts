/**
 * at0674-rail-width-drag-reflow-on-pause.test.ts — content that cannot
 * reflow in a frame waits for the hand to rest.
 *
 * A rail width drag moves the rail's frames every frame, and a member whose
 * content is cheap to lay out reflows with them. The Overview's is not: its
 * posts are prose, and rewrapping them is more than a frame's budget. So its
 * registration says `railReflow: "pause"`, and while the edge moves its body
 * is held at the width it last laid out at — anchored to the rail's outer
 * edge, clipped by its frame — and reflows only once the hand has rested and
 * at the release. This file reads all three moments, and the cheap member
 * beside it reflowing live throughout.
 *
 * The reading is an in-page sampler: every animation frame it records each
 * member's frame width, its body's width and offset inside the frame, whether
 * the button is down, and how long since the last pointer move. Samples are
 * classed by that last figure, so the claims hold whatever the harness's
 * timing between RPCs happens to be.
 *
 * **The window is visible** (`foreground`): a covered app-test window gets
 * no animation frames, and the preview is written in one.
 *
 * @foreground
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/components/overview/overview-card-registration.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Every member's seeded width, with room to grow under the slim ceiling. */
const RAIL_WIDTH = 480;
const GROW_PX = 120;
const STEPS = 30;
const STEP_MS = 16;
/** Well past the reflow pause, so a rest is read as one. */
const REST_MS = 400;
/** A sample this soon after a move is inside a moving drag. */
const MOVING_MS = 40;
/** A sample this long after a move is inside a rest. */
const RESTED_MS = 200;
const TOL = 1.5;
const AFTER_LAND_MS = 900;

const MEMBERS = ["overview", "jots"] as const;
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
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "B", componentId: "hello", title: "Card B", closable: true },
    ],
    panes: [
      chainPane("p1", "A", 0),
      chainPane("p2", "B", 1),
      railPane("pOverview", "G", "Overview"),
      railPane("pJots", "J", "Jots"),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "two-up",
      layout: "fit",
      sidebars: {
        overview: { side: "left" },
        jots: { side: "left" },
      },
      rails: { left: { order: [...MEMBERS] } },
    },
    hasFocus: true,
  };
}

interface Sample {
  down: boolean;
  sinceMove: number;
  /** Per member: frame width, body width, body's left offset in the frame,
   *  and the body's inline width. */
  m: Record<string, { frame: number; body: number; offset: number; inline: string }>;
}

async function armSampler(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = { samples: [], down: false, lastMove: performance.now(), running: true };
      window.__at0674 = rec;
      window.addEventListener("pointerdown", function () { rec.down = true; }, true);
      window.addEventListener("pointerup", function () { rec.down = false; }, true);
      window.addEventListener("pointermove", function () { rec.lastMove = performance.now(); }, true);
      var tick = function () {
        if (!rec.running) return;
        var m = {};
        document.querySelectorAll('.tug-pane[data-rail-side="left"]').forEach(function (el) {
          var body = el.querySelector(".tug-pane-body");
          var fr = el.getBoundingClientRect();
          var br = body.getBoundingClientRect();
          m[el.getAttribute("data-rail-member")] = {
            frame: fr.width,
            body: br.width,
            offset: br.left - fr.left,
            inline: body.style.width,
          };
        });
        rec.samples.push({ down: rec.down, sinceMove: performance.now() - rec.lastMove, m: m });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

async function takeSamples(app: App): Promise<Sample[]> {
  return app.evalJS<Sample[]>(
    `(function () {
      var rec = window.__at0674;
      rec.running = false;
      return rec.samples;
    })()`,
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

describe.skipIf(!SHOULD_RUN)(
  "at0674 — a rail member whose content cannot reflow in a frame waits for the hand to rest",
  () => {
    test(
      "the Overview holds its measure while the edge moves, and reflows on a rest and at the release",
      async () => {
        const app = await launchTugApp({
          testName: "at0674-rail-width-drag-reflow-on-pause",
          foreground: true,
        });
        try {
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
          expect(
            await app.evalJS<string | null>(
              `document.querySelector('.tug-pane[data-pane-id="pOverview"]').getAttribute("data-rail-reflow")`,
            ),
            "the Overview's frame says its content reflows on a pause",
          ).toBe("pause");
          expect(
            await app.evalJS<boolean>(
              `document.querySelector('.tug-pane[data-pane-id="pJots"]').hasAttribute("data-rail-reflow")`,
            ),
            "Jots says nothing, and reflows live",
          ).toBe(false);

          await armSampler(app);
          await wait(100);

          const from = await grip(app);
          const to = { x: from.x + GROW_PX, y: from.y };
          await app.nativeDragWithoutRelease(from, to, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          await wait(REST_MS);
          await app.nativeMouseUp(to);
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-pointer-owned]") === null`,
            { timeoutMs: 3_000 },
          );
          await wait(AFTER_LAND_MS);
          const samples = await takeSamples(app);

          const rest = samples[0];
          const inset = rest.m.overview.frame - rest.m.overview.body;
          const bodyAtRest = rest.m.overview.body;

          // Moving: the rail has grown well past where it stood, the hand
          // moved within the last few frames.
          const moving = samples.filter(
            (s) =>
              s.down &&
              s.sinceMove < MOVING_MS &&
              s.m.overview.frame > rest.m.overview.frame + 30,
          );
          const rested = samples.filter(
            (s) => s.down && s.sinceMove > RESTED_MS,
          );
          note(
            `samples: ${samples.length}; moving ${moving.length}; rested ${rested.length}; inset ${inset.toFixed(1)}`,
          );
          expect(moving.length, "frames were sampled mid-drag").toBeGreaterThanOrEqual(5);
          expect(rested.length, "frames were sampled in the rest").toBeGreaterThanOrEqual(3);

          for (const s of moving) {
            // The Overview's content holds its measure, anchored at the
            // rail's outer edge — the left, on a left rail.
            expect(
              Math.abs(s.m.overview.body - bodyAtRest),
              `moving: the Overview's body holds ${bodyAtRest.toFixed(1)} (read ${s.m.overview.body.toFixed(1)} in a ${s.m.overview.frame.toFixed(1)} frame)`,
            ).toBeLessThanOrEqual(TOL);
            expect(
              Math.abs(s.m.overview.offset - rest.m.overview.offset),
              "moving: the held body stays at the rail's outer edge",
            ).toBeLessThanOrEqual(TOL);
            // Jots reflows live, with its frame.
            expect(
              Math.abs(s.m.jots.frame - s.m.jots.body - inset),
              `moving: Jots' body fills its frame (frame ${s.m.jots.frame.toFixed(1)}, body ${s.m.jots.body.toFixed(1)})`,
            ).toBeLessThanOrEqual(TOL);
          }

          // Rested: the held content has reflowed to the frame it stands in.
          for (const s of rested) {
            expect(
              Math.abs(s.m.overview.frame - s.m.overview.body - inset),
              `rested: the Overview's body fills its frame (frame ${s.m.overview.frame.toFixed(1)}, body ${s.m.overview.body.toFixed(1)})`,
            ).toBeLessThanOrEqual(TOL);
          }

          // Released: the hold is gone, and the body stands in the committed
          // frame by the stylesheet alone.
          const last = samples[samples.length - 1];
          expect(last.down, "the last sample is after the release").toBe(false);
          expect(last.m.overview.inline, "no hold is left on the body").toBe("");
          expect(
            Math.abs(last.m.overview.frame - (RAIL_WIDTH + GROW_PX)),
            `the rail landed at ${RAIL_WIDTH + GROW_PX} (read ${last.m.overview.frame.toFixed(1)})`,
          ).toBeLessThanOrEqual(TOL);
          expect(
            Math.abs(last.m.overview.frame - last.m.overview.body - inset),
            "released: the Overview's body fills its frame",
          ).toBeLessThanOrEqual(TOL);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
