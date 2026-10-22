/**
 * at0679-rail-width-drag-reflow-on-pause.test.ts — content that cannot
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
 * **The window renders** (`visible`): a covered app-test window otherwise gets
 * no animation frames, and the preview is written in one.
 *
 * **The host carries the views; the page holds its content.** The host
 * resizes every member's web view from the pointer, chrome included, so a
 * `pause` member's frame follows the hand with the others; its page holds
 * the *content* at its rest width, driven at the aim the host reports. Its
 * very first moved frame can still lay the content out once at the start
 * width plus the move threshold before that hold arrives, and the reading
 * notes the widest such deviation over the first moving samples rather than
 * asserting it away. After the release the host's own snapshot says every
 * member's view stands at the committed width and none is still in the hand:
 * the frames read here are the pages', and the views they stand in are the
 * host's.
 *
 * The host's half of the gesture lives in `BodyViewController.swift`, which
 * fans out past the selection budget, so it is named by none of the lines
 * below. Run this file by name with any change to the host's rail gesture.
 *
 * @visible
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/components/overview/overview-card-registration.tsx
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugapp/Sources/RailView.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { chromePoint } from "./card-chrome-fixture";
import { PIXEL_TOL } from "./_harness/tolerances";
import { CARD_APRON_PX } from "./rail-width-fixture";

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
const AFTER_LAND_MS = 900;

const MEMBERS = ["overview", "jots"] as const;

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

/** The card each member is: a rail card draws its chrome and lays out its content in its own page. */
const CARD_OF: Record<(typeof MEMBERS)[number], string> = { overview: "G", jots: "J" };

/** One member's frame in its own page, on one animation frame. */
interface PageSample {
  t: number;
  frame: number;
  body: number;
  offset: number;
  inline: string;
}

/** One of the host's reports of the hand, as the shell hears it. */
interface HandReport {
  t: number;
  phase: string;
}

/**
 * Arm the samplers. Each member's page records, every animation frame, its
 * own frame's width and its body's width, offset and inline width; the shell
 * records the host's reports of the hand (`onCardGesture`), since the press
 * is the Jots page's and the host carries it. Every clock is the epoch's
 * (`timeOrigin + now`), so the pages' samples line up.
 */
async function armSampler(app: App): Promise<void> {
  // card-dom: shell — the host's gesture reports arrive in the shell's page.
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__at0679 = { hand: [] });
      var b = window.__tugBridge; var take = b.onCardGesture;
      b.onCardGesture = function (r) {
        rec.hand.push({ t: performance.timeOrigin + performance.now(), phase: r.phase });
        return take(r);
      };
      return null;
    })()`,
  );
  for (const member of MEMBERS) {
    await app.body(CARD_OF[member]).evalJS<null>(
      `(function () {
        var rec = (window.__at0679 = { samples: [], running: true });
        var tick = function () {
          if (!rec.running) return;
          var frame = document.querySelector(".body-chrome-frame");
          var body = frame.querySelector(".tug-pane-body");
          var fr = frame.getBoundingClientRect();
          var br = body.getBoundingClientRect();
          rec.samples.push({
            t: performance.timeOrigin + performance.now(),
            frame: fr.width,
            body: br.width,
            offset: br.left - fr.left,
            inline: body.style.width,
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return null;
      })()`,
    );
  }
}

/**
 * Stop the samplers and read them as one series, on the Overview's frames:
 * whether the button was down (between the hand's first report and its
 * last), how long since the hand's last move, and each member's frame as its
 * page last drew it.
 */
async function takeSamples(app: App): Promise<Sample[]> {
  const take = `(function () { var rec = window.__at0679; rec.running = false; return rec.samples; })()`;
  const pages: Record<string, PageSample[]> = {};
  for (const member of MEMBERS) pages[member] = await app.body(CARD_OF[member]).evalJS<PageSample[]>(take);
  // card-dom: shell — the host's gesture reports arrive in the shell's page.
  const hand = await app.evalJS<HandReport[]>(`window.__at0679.hand`);
  const firstMove = hand.find((h) => h.phase === "move")?.t ?? Number.POSITIVE_INFINITY;
  const end = hand.find((h) => h.phase === "end" || h.phase === "cancel")?.t ?? Number.POSITIVE_INFINITY;
  const lastAt = (series: PageSample[], t: number): PageSample => {
    let last = series[0];
    for (const s of series) if (s.t <= t) last = s;
    return last;
  };
  return pages.overview.map((s) => {
    const moves = hand.filter((h) => h.phase === "move" && h.t <= s.t);
    const lastMove = moves.length > 0 ? moves[moves.length - 1].t : firstMove;
    const m: Sample["m"] = {};
    for (const member of MEMBERS) {
      const p = lastAt(pages[member], s.t);
      m[member] = { frame: p.frame, body: p.body, offset: p.offset, inline: p.inline };
    }
    return { down: s.t >= firstMove && s.t < end, sinceMove: Math.max(0, s.t - lastMove), m };
  });
}

async function grip(app: App): Promise<{ x: number; y: number }> {
  // The rail card draws its edge grip in its own page.
  return chromePoint(app, "J", ".tug-pane-resize-e");
}

describe.skipIf(!SHOULD_RUN)(
  "at0679 — a rail member whose content cannot reflow in a frame waits for the hand to rest",
  () => {
    test(
      "the Overview holds its measure while the edge moves, and reflows on a rest and at the release",
      async () => {
        const app = await launchTugApp({
          testName: "at0679-rail-width-drag-reflow-on-pause",
          visible: true,
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
          // The first moving frames: the host resized the view at its first
          // moved step, and the page's hold arrives one report later, so its
          // content may lay out once at a near-identical width (Risk R05).
          const firstMoving = samples.filter((s) => s.down && s.sinceMove < MOVING_MS).slice(0, 5);
          const firstDeviation = Math.max(0, ...firstMoving.map((s) => Math.abs(s.m.overview.body - bodyAtRest)));
          note(
            `first ${firstMoving.length} moving samples: the Overview's body deviates from its rest ${bodyAtRest.toFixed(1)} ` +
              `by at most ${firstDeviation.toFixed(1)} px (frames ${firstMoving.map((s) => s.m.overview.frame.toFixed(1)).join(", ")})`,
          );
          expect(moving.length, "frames were sampled mid-drag").toBeGreaterThanOrEqual(5);
          expect(rested.length, "frames were sampled in the rest").toBeGreaterThanOrEqual(3);

          for (const s of moving) {
            // The Overview's content holds its measure, anchored at the
            // rail's outer edge — the left, on a left rail.
            expect(
              Math.abs(s.m.overview.body - bodyAtRest),
              `moving: the Overview's body holds ${bodyAtRest.toFixed(1)} (read ${s.m.overview.body.toFixed(1)} in a ${s.m.overview.frame.toFixed(1)} frame)`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
            expect(
              Math.abs(s.m.overview.offset - rest.m.overview.offset),
              "moving: the held body stays at the rail's outer edge",
            ).toBeLessThanOrEqual(PIXEL_TOL);
            // Jots reflows live, with its frame.
            expect(
              Math.abs(s.m.jots.frame - s.m.jots.body - inset),
              `moving: Jots' body fills its frame (frame ${s.m.jots.frame.toFixed(1)}, body ${s.m.jots.body.toFixed(1)})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
          }

          // Rested: the held content has reflowed to the frame it stands in.
          for (const s of rested) {
            expect(
              Math.abs(s.m.overview.frame - s.m.overview.body - inset),
              `rested: the Overview's body fills its frame (frame ${s.m.overview.frame.toFixed(1)}, body ${s.m.overview.body.toFixed(1)})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
          }

          // Released: the hold is gone, and the body stands in the committed
          // frame by the stylesheet alone.
          const last = samples[samples.length - 1];
          expect(last.down, "the last sample is after the release").toBe(false);
          expect(last.m.overview.inline, "no hold is left on the body").toBe("");
          expect(
            Math.abs(last.m.overview.frame - (RAIL_WIDTH + GROW_PX)),
            `the rail landed at ${RAIL_WIDTH + GROW_PX} (read ${last.m.overview.frame.toFixed(1)})`,
          ).toBeLessThanOrEqual(PIXEL_TOL);
          expect(
            Math.abs(last.m.overview.frame - last.m.overview.body - inset),
            "released: the Overview's body fills its frame",
          ).toBeLessThanOrEqual(PIXEL_TOL);

          // And the views those pages stand in are the host's: each at the
          // committed width plus the apron either side, none in the hand.
          const views = await app.bodies();
          for (const member of MEMBERS) {
            const view = views.find((b) => b.cardId === CARD_OF[member] && b.visible);
            expect(view, `the host holds ${member}'s view`).toBeDefined();
            expect(view!.inHand, `${member}'s view is out of the hand`).toBe(false);
            expect(
              Math.abs(view!.frame.width - (RAIL_WIDTH + GROW_PX + 2 * CARD_APRON_PX)),
              `${member}'s view stands at the committed width (read ${view!.frame.width})`,
            ).toBeLessThanOrEqual(1);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
