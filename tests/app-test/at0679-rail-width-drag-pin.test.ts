/**
 * at0679-rail-width-drag-pin.test.ts — a rail width drag holds every
 * member's page still, and the host draws the moving edge.
 *
 * A member's page is a web process of its own, and a page asked to lay out
 * at a new width shows that width on its own clock, a frame or more after
 * the host moved its view. So while the hand is down no member's page
 * changes size at all: the host widens each member's view from the one frame
 * write the rail view takes, holds the page inside it at the size the press
 * found it, anchored at the rail's outer edge, and draws the strip from the
 * page's clip to the pane's deck-facing edge — the pane's surface, the
 * border, the shadow — in the colours the page reported at the press. At the
 * release each page takes its new size once, and the host takes its strip
 * away only once the page has painted there.
 *
 * This file reads all of that, both ways round. In the pages: an in-page
 * sampler records, every animation frame, each member's frame width; with
 * the button down it stands at the press width on every frame, through the
 * moves and through a rest, and after the release at the committed width.
 * In the host: its snapshot, read with the hand down, says every member's
 * page is held at its press width inside a view the hand has widened, with a
 * strip the width the rail grew plus the border, painted in the page's
 * colours; and after the release, that no crossing is left and every view
 * stands at the committed width, out of the hand.
 *
 * **The window renders** (`visible`): a covered app-test window otherwise
 * gets no animation frames, and the samplers run in one.
 *
 * The host's half of the gesture lives in `BodyViewController.swift`, which
 * fans out past the selection budget, so it is named by none of the lines
 * below. Run this file by name with any change to the host's rail gesture.
 *
 * @visible
 * @covers tugapp/Sources/RailView.swift
 * @covers tugdeck/src/body/rail-edge.ts
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/lib/host-card-gesture.ts
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
/** A rest with the hand down: a page held still stays held through one. */
const REST_MS = 400;
const AFTER_LAND_MS = 900;

const MEMBERS = ["overview", "jots"] as const;

/** The card each member is: a rail card draws its chrome and lays out its content in its own page. */
const CARD_OF: Record<(typeof MEMBERS)[number], string> = { overview: "G", jots: "J" };

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

/** One member's frame in its own page, on one animation frame. */
interface PageSample {
  t: number;
  frame: number;
}

/** One of the host's reports of the hand, as the shell hears it. */
interface HandReport {
  t: number;
  phase: string;
}

/**
 * Arm the samplers. Each member's page records, every animation frame, its
 * own frame's width; the shell records the host's reports of the hand
 * (`onCardGesture`), since the press is the Jots page's and the host carries
 * it. Every clock is the epoch's (`timeOrigin + now`), so the pages' samples
 * line up with the reports.
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
          rec.samples.push({ t: performance.timeOrigin + performance.now(), frame: frame.getBoundingClientRect().width });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return null;
      })()`,
    );
  }
}

/** Stop the samplers: each member's samples, split at the hand's first move and its release. */
async function takeSamples(app: App): Promise<Record<string, { down: PageSample[]; after: PageSample[] }>> {
  // card-dom: shell — the host's gesture reports arrive in the shell's page.
  const hand = await app.evalJS<HandReport[]>(`window.__at0679.hand`);
  const firstMove = hand.find((h) => h.phase === "move")?.t ?? Number.POSITIVE_INFINITY;
  const end = hand.find((h) => h.phase === "end" || h.phase === "cancel")?.t ?? Number.POSITIVE_INFINITY;
  const out: Record<string, { down: PageSample[]; after: PageSample[] }> = {};
  for (const member of MEMBERS) {
    const samples = await app.body(CARD_OF[member]).evalJS<PageSample[]>(
      `(function () { var rec = window.__at0679; rec.running = false; return rec.samples; })()`,
    );
    out[member] = {
      down: samples.filter((s) => s.t >= firstMove && s.t < end),
      after: samples.filter((s) => s.t >= end),
    };
  }
  return out;
}

async function grip(app: App): Promise<{ x: number; y: number }> {
  // The rail card draws its edge grip in its own page.
  return chromePoint(app, "J", ".tug-pane-resize-e");
}

const spanOf = (xs: readonly number[]): string =>
  xs.length === 0 ? "none" : `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}`;

describe.skipIf(!SHOULD_RUN)(
  "at0679 — a rail width drag holds every member's page still, and the host draws the edge",
  () => {
    test(
      "no member's page changes size while the hand is down, and each takes the committed width once the hand lets go",
      async () => {
        const app = await launchTugApp({
          testName: "at0679-rail-width-drag-pin",
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

          const atRest = await app.bodies();
          const restView = (card: string) => atRest.find((b) => b.cardId === card && b.visible)!;

          await armSampler(app);
          await wait(100);

          const from = await grip(app);
          const to = { x: from.x + GROW_PX, y: from.y };
          await app.nativeDragWithoutRelease(from, to, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          await wait(REST_MS);

          // ---- The host, with the hand down ----
          const held = await app.bodies();
          for (const member of MEMBERS) {
            const card = CARD_OF[member];
            const view = held.find((b) => b.cardId === card && b.visible);
            expect(view, `the host holds ${member}'s view`).toBeDefined();
            const crossing = view!.railCrossing;
            note(`${member} held: view ${view!.frame.width}; page ${view!.pageSize.width}; crossing ${JSON.stringify(crossing)}`);
            expect(view!.inHand, `${member}'s view is in the hand`).toBe(true);
            expect(crossing, `${member}'s page is held in a crossing`).not.toBeNull();
            expect(crossing!.painted, `${member}'s page said its edge's colours`).toBe(true);
            expect(
              Math.abs(crossing!.contentWidth - restView(card).pageSize.width),
              `${member}'s page is held at its press width`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
            expect(
              Math.abs(view!.pageSize.width - crossing!.contentWidth),
              `${member}'s page view has not been resized (read ${view!.pageSize.width})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
            // The view has grown with the hand; the strip spans what it grew
            // by, from the page's clip to the pane's edge, and the border.
            const grown = view!.presentedFrame.width - restView(card).presentedFrame.width;
            expect(Math.abs(grown - GROW_PX), `${member}'s view grew with the hand (by ${grown})`).toBeLessThanOrEqual(PIXEL_TOL);
            expect(
              crossing!.strip.width > grown && crossing!.strip.width <= grown + 4,
              `${member}'s strip spans the growth and the border (read ${crossing!.strip.width})`,
            ).toBe(true);
          }

          await app.nativeMouseUp(to);
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-pointer-owned]") === null`,
            { timeoutMs: 3_000 },
          );
          await wait(AFTER_LAND_MS);
          const samples = await takeSamples(app);

          // ---- The pages ----
          for (const member of MEMBERS) {
            const { down, after } = samples[member];
            const pressWidth = restView(CARD_OF[member]).pageSize.width - 2 * CARD_APRON_PX;
            note(`${member} page: ${down.length} frames down ${spanOf(down.map((s) => s.frame))}; ${after.length} after ${spanOf(after.map((s) => s.frame))}`);
            expect(down.length, `${member}'s page drew frames with the hand down`).toBeGreaterThanOrEqual(10);
            expect(
              Math.max(...down.map((s) => Math.abs(s.frame - pressWidth))),
              `${member}'s page held its frame at ${pressWidth} on every frame with the hand down`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
            const last = after[after.length - 1];
            expect(last, `${member}'s page drew frames after the release`).toBeDefined();
            expect(
              Math.abs(last.frame - (RAIL_WIDTH + GROW_PX)),
              `${member}'s page landed at ${RAIL_WIDTH + GROW_PX} (read ${last.frame.toFixed(1)})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
          }

          // ---- The host, after the release ----
          const views = await app.bodies();
          for (const member of MEMBERS) {
            const view = views.find((b) => b.cardId === CARD_OF[member] && b.visible);
            expect(view, `the host holds ${member}'s view`).toBeDefined();
            expect(view!.inHand, `${member}'s view is out of the hand`).toBe(false);
            expect(view!.railCrossing, `${member}'s crossing came off once its page painted`).toBeNull();
            expect(
              Math.abs(view!.frame.width - (RAIL_WIDTH + GROW_PX + 2 * CARD_APRON_PX)),
              `${member}'s view stands at the committed width (read ${view!.frame.width})`,
            ).toBeLessThanOrEqual(1);
            expect(
              Math.abs(view!.pageSize.width - view!.frame.width),
              `${member}'s page fills its view again (read ${view!.pageSize.width})`,
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
