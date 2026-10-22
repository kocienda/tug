/**
 * at0678-rail-width-drag-frames.test.ts — a rail width drag costs a frame
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
 * **The window renders** (`visible`): a covered app-test window otherwise gets
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
 * cannot see that; only a per-frame sample can. The host carries the views,
 * so the same reading is taken where they are: each member's page samples
 * its own frame's width on every frame, and the host's snapshot is polled
 * for the members' frames, from the release until the deck is quiet.
 *
 * **The members move together, under the hand.** The host moves every
 * member's view and the cards beside the rail in one transaction, and the
 * second reading's drag is read for that too, in the composite: a capture
 * burst over its grow leg finds each member's deck-facing edge, and the
 * chain's first card's leading edge, by colour against the ground beside
 * them. On every frame with the hand down each member's edge stands where
 * the host drew it within the last two display frames (the pipeline's
 * latency, and no more), the chain card stands where the ported travel puts
 * it at those widths, and the members stand no further apart than the hand
 * moved in that window. They may stand that far apart: each member's page
 * repaints its view at a new size on its own clock, so on a frame one can
 * show the step before its siblings, though the host moves their views in
 * one transaction. The edge is read where the rail's shadow meets the
 * ground, which every member draws alike, rather than at its first dark
 * pixel, which the pressed member's held edge line covers. A stand-in's
 * rect is not evidence of any of this: it is the shell's model, moved on the
 * shell's clock after the host has already drawn the views. The burst's frames are
 * kept under `/tmp` for a reader judging the Overview's grow strip.
 *
 * The host's half of the gesture lives in `BodyViewController.swift`, which
 * fans out past the selection budget, so it is named by none of the lines
 * below; the rail view and the ported arithmetic are. Run this file by name
 * with any change to the host's rail gesture.
 *
 * @visible
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/lib/rail-width.ts
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/RailView.swift
 * @covers tugapp/Sources/CardGeometry.swift
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { chromePoint } from "./card-chrome-fixture";
import { PIXEL_TOL } from "./_harness/tolerances";
import { armBurst, readBurst } from "./one-view-fixture";
import {
  CARD_APRON_PX,
  armReportRecord,
  chainEdgeAt,
  expectedEdgeAt,
  railReader,
  readRailFacts,
  takeReportRecord,
} from "./rail-width-fixture";
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
const AFTER_LAND_MS = 900;

const MEMBERS = ["overview", "jots", "layout"] as const;
/** Each member's card, top to bottom. */
const MEMBER_CARDS = ["G", "J", "L"] as const;
/** The chain's first card: the one beside the rail. */
const CHAIN_FIRST = "A";
/** How far a composite edge may stand from the host's reported edge, device px. */
const EDGE_TOL_DEVICE = 2;
/** How far the members' edges may stand from one another, device px. */
const COLUMN_TOL_DEVICE = 1;
/** How often the host's snapshot is read after the release. */
const POLL_MS = 50;

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
 * it began with the hand down — read off the host's reports of the hand
 * (`onCardGesture`), since the press is the rail card's own page's and the
 * host carries it — and the idle frames between the two legs are not
 * counted toward the drag.
 */
async function armFrames(app: App): Promise<void> {
  // card-dom: shell — the shell's frames and the host's gesture reports, both the shell page's.
  await app.evalJS<null>(
    `(function () {
      var rec = { all: [], downAt: null, down: false, running: true };
      window.__at0678 = rec;
      var b = window.__tugBridge; var take = b.onCardGesture;
      b.onCardGesture = function (r) {
        if (r.phase === "move") {
          if (rec.downAt === null) rec.downAt = performance.now();
          rec.down = true;
        } else {
          rec.down = false;
        }
        return take(r);
      };
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
      var rec = window.__at0678;
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
  // The rail card draws its edge grip in its own page.
  return chromePoint(app, "J", ".tug-pane-resize-e");
}

function memberWidths(app: App): Promise<Record<string, number>> {
  // card-dom: shell — the stand-in frames are the arrangement's model, laid out in the shell.
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
  // card-dom: shell — the stand-in frames and the host's gesture reports, both the shell page's.
  await app.evalJS<null>(
    `(function () {
      var rec = { frames: 0, minOpacity: 1, widths: {}, released: false, running: true };
      window.__at0678release = rec;
      var b = window.__tugBridge; var take = b.onCardGesture;
      b.onCardGesture = function (r) {
        if (r.phase === "end") rec.released = true;
        return take(r);
      };
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
  // card-dom: shell — the release sampler ran in the shell's page.
  return app.evalJS<ReleaseSample>(
    `(function () {
      var rec = window.__at0678release;
      rec.running = false;
      return { frames: rec.frames, minOpacity: rec.minOpacity, widths: rec.widths };
    })()`,
  );
}

/** Arm a sampler in each member's own page: its frame's width on every animation frame, on the epoch's clock. */
async function armPageWidths(app: App): Promise<void> {
  for (const card of MEMBER_CARDS) {
    await app.body(card).evalJS<null>(
      `(function () {
        var rec = (window.__at0678page = { samples: [], running: true });
        var tick = function () {
          if (!rec.running) return;
          var frame = document.querySelector(".body-chrome-frame");
          rec.samples.push({ wall: Date.now(), width: frame.getBoundingClientRect().width });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return null;
      })()`,
    );
  }
}

/** Stop the page samplers, and answer each member's widths from `since` on. */
async function takePageWidths(app: App, since: number): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const card of MEMBER_CARDS) {
    const samples = await app.body(card).evalJS<{ wall: number; width: number }[]>(
      `(function () { var rec = window.__at0678page; rec.running = false; return rec.samples; })()`,
    );
    out[card] = samples.filter((s) => s.wall >= since).map((s) => s.width);
  }
  return out;
}

/** Read the host's snapshot every {@link POLL_MS} for `ms`: each member's presented frame widths, and whether the hand held any. */
async function pollHost(app: App, ms: number): Promise<{ widths: Record<string, number[]>; inHand: number }> {
  const widths: Record<string, number[]> = Object.fromEntries(MEMBER_CARDS.map((c) => [c, []]));
  let inHand = 0;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const b of await app.bodies()) {
      if (b.cardId === null || !(MEMBER_CARDS as readonly string[]).includes(b.cardId) || !b.visible) continue;
      widths[b.cardId].push(b.presentedFrame.width);
      if (b.inHand) inHand += 1;
    }
    await wait(POLL_MS);
  }
  return { widths, inHand };
}

const spanOf = (xs: readonly number[]): string =>
  xs.length === 0 ? "none" : `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}`;

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
  "at0678 — a rail width drag over a three-member rail stays inside half a frame",
  () => {
    test(
      "a pre-armed recorder reads p95 frame cost under 8.3 ms across the drag",
      async () => {
        const app = await launchTugApp({
          testName: "at0678-rail-width-drag-frames",
          visible: true,
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
            ).toBeLessThanOrEqual(PIXEL_TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the members move together under the hand, and stay opaque and at the released width on every frame after the release",
      async () => {
        const app = await launchTugApp({
          testName: "at0678-rail-width-drag-release",
          visible: true,
        });
        try {
          await seedRail(app);
          const facts = await readRailFacts(app);
          const travel = facts.travel[CHAIN_FIRST];
          expect(travel, `${CHAIN_FIRST} stands on a rail travel`).toBeDefined();
          const reader = await railReader(app, MEMBER_CARDS, CHAIN_FIRST, GROW_PX + 40);
          const dragged = reader.members[MEMBER_CARDS.indexOf("J")];
          const restShown = RAIL_WIDTH;
          const chainRest = { edge: reader.chain!.restLeft, shown: restShown };

          await armRelease(app);
          await armReportRecord(app);
          await armPageWidths(app);
          await armBurst(app, reader.crop);
          const from = await grip(app);
          await app.nativeDrag(from, { x: from.x + GROW_PX, y: from.y }, {
            interpolationSteps: STEPS,
            interpolationDelayMs: STEP_MS,
          });
          const host = await pollHost(app, AFTER_LAND_MS);
          const sample = await takeRelease(app);
          const reading = await readBurst(app);
          const reports = await takeReportRecord(app);

          const moves = reports.filter((r) => r.phase === "move");
          expect(moves.length, "the host reported the hand's moves").toBeGreaterThan(10);
          expect(moves.every((r) => r.rail !== null), "every report of the rail's hand carries the host's aim").toBe(true);
          const downAt = moves[0].wall;
          const releasedAt = reports.find((r) => r.phase === "end")?.wall;
          expect(releasedAt, "the host reported the release").toBeDefined();
          const upAt = releasedAt!;
          const pages = await takePageWidths(app, upAt);

          // ---- The release moves nothing ----
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
            ).toBeLessThanOrEqual(PIXEL_TOL);
          }
          // Where the views are: each member's page drew its frame at the
          // released width on every frame from the release on, and the host
          // never moved a member's view, nor held one, once the hand let go.
          for (const card of MEMBER_CARDS) {
            const page = pages[card];
            note(`${card} after release: page ${page.length} frames ${spanOf(page)}; host ${spanOf(host.widths[card])}`);
            expect(page.length, `${card}'s page drew frames after the release`).toBeGreaterThanOrEqual(MIN_FRAMES);
            expect(
              Math.max(...page.map((w) => Math.abs(w - expected))),
              `${card}'s page stood at ${expected}px on every frame after the release (read ${spanOf(page)})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
            expect(host.widths[card].length, `${card}'s view was read after the release`).toBeGreaterThan(0);
            expect(
              Math.max(...host.widths[card].map((w) => Math.abs(w - (expected + 2 * CARD_APRON_PX)))),
              `${card}'s view stood at the released width on every reading (read ${spanOf(host.widths[card])})`,
            ).toBeLessThanOrEqual(1);
          }
          expect(host.inHand, "the hand held no member after the release").toBe(0);

          // ---- The members move together, under the hand ----
          const last = moves[moves.length - 1];
          note(
            `${moves.length} move reports over ${(last.wall - downAt).toFixed(0)} ms; ` +
              `last shown ${last.rail?.shown}, edge ${last.rect.x + last.rect.width}; rest edge ${dragged.restEdge}`,
          );
          expect(
            Math.abs((last.rail?.shown ?? 0) - (RAIL_WIDTH + GROW_PX)),
            "the host drew the rail at the hand's width by the last move",
          ).toBeLessThanOrEqual(PIXEL_TOL);

          // Kept beside the run, for a reader judging the Overview's grow
          // strip against a stretch.
          const kept = join("/tmp", `at0678-burst-${Date.now()}`);
          mkdirSync(kept, { recursive: true });
          for (const f of reading.frames) copyFileSync(f.path, join(kept, basename(f.path)));
          note(`burst frames kept at ${kept} (${reading.frames.length})`);

          const toDevice = reader.toDevice;
          // Two display frames of pipeline latency, and no more ([B05]).
          // A report heard up to a frame after the composite may already be on it.
          const period = (await app.bodies()).find((b) => b.cardId === "J")?.displayPeriodMs ?? 1000 / 60;
          const latencyMs = 2 * period;
          let judged = 0;
          let together = 0;
          const unread: string[] = [];
          const apart: string[] = [];
          const offHand: string[] = [];
          const offChain: string[] = [];
          for (const f of reading.frames) {
            if (f.wall < downAt || f.wall >= upAt) continue;
            const at = `+${(f.wall - downAt).toFixed(0)}ms`;
            const edges = reader.memberEdges(f);
            const chain = reader.chainEdge(f);
            if (edges.some((e) => e === null) || chain === null) {
              unread.push(`${at} members ${JSON.stringify(edges)} chain ${chain}`);
              continue;
            }
            judged += 1;
            const es = edges as number[];
            const spread = Math.max(...es) - Math.min(...es);
            const hand = expectedEdgeAt(f.wall, reports, dragged.restEdge, latencyMs, period);
            const lo = toDevice(hand.lo) - EDGE_TOL_DEVICE;
            const hi = toDevice(hand.hi) + EDGE_TOL_DEVICE;
            // Each member's page repaints its view at a new size on its own
            // clock, so on a frame one may show the step before its
            // siblings ([B03]); none may stand further from another than
            // the hand moved inside the latency window.
            if (spread <= COLUMN_TOL_DEVICE) together += 1;
            else if (spread > toDevice(hand.hi) - toDevice(hand.lo) + COLUMN_TOL_DEVICE) apart.push(`${at} ${JSON.stringify(es)}`);
            es.forEach((e, i) => {
              if (e < lo || e > hi) offHand.push(`${at} ${MEMBER_CARDS[i]} ${e} not in ${lo.toFixed(1)}..${hi.toFixed(1)}`);
            });
            const cards = expectedEdgeAt(f.wall, reports, chainRest.edge, latencyMs, period, (r) => chainEdgeAt(r, chainRest, travel!, facts));
            const clo = toDevice(cards.lo) - EDGE_TOL_DEVICE;
            const chi = toDevice(cards.hi) + EDGE_TOL_DEVICE;
            if (chain < clo || chain > chi) offChain.push(`${at} ${chain} not in ${clo.toFixed(1)}..${chi.toFixed(1)}`);
          }
          note(
            `${judged} frames judged with the hand down over a ${latencyMs.toFixed(1)} ms window; ${together} in one column; ` +
              `unread ${unread.length}; apart ${apart.length}; ` +
              `off the hand ${offHand.length}; chain off ${offChain.length}`,
          );
          for (const [what, list] of [["unread", unread], ["apart", apart], ["off the hand", offHand], ["chain off", offChain]] as const) {
            if (list.length > 0) note(`${what}:\n${list.join("\n")}`);
          }
          expect(judged, "frames were judged with the hand down").toBeGreaterThanOrEqual(10);
          expect(unread.length, "every frame with the hand down is read by colour").toBe(0);
          expect(apart.length, "on no frame do the members stand further apart than the hand moved in two display frames").toBe(0);
          expect(offHand.length, "on every frame each edge stands where the host drew it within two display frames").toBe(0);
          expect(offChain.length, "on every frame the chain stands where its travel puts it").toBe(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
