/**
 * at0678-rail-width-drag-frames.test.ts — a rail width drag costs a frame
 * less than half a frame to draw, moves nothing but its ghost while the hand
 * is down, and lands by the settle.
 *
 * Dragging a rail's edge moves one thing: the ghost of the rail's new
 * footprint, a translucent layer with an accent edge that the host draws
 * above every card and moves in step with the hand. The rail's members, the
 * shadow they cast, and the cards in the chain beside the rail all stand
 * still until the release commits the width, and the deck's own settle then
 * carries them there. This file is the reading that says so.
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
 * **The ghost moves and nothing else does.** A second drag grows the rail
 * under a capture burst, read against a still of the standing deck taken
 * before the press. On every frame with the hand down, the ghost's edge — on
 * each member's row, one past its accent edge line, the one saturated line
 * on the deck — stands within 1 device px of an edge the host reported for
 * the frame on screen. Reports are stamped when the shell hears them, which
 * jitters against the host's draw, so a frame is matched to every report
 * heard in the two display periods before it, the bar the grounding readings
 * admit, and to one heard up to a period after it. Each member's
 * deck-facing edge and the chain's first card's leading edge stand within 1
 * device px of where they stood at the press, each read at its strongest
 * step in colour: the ghost's translucent fill over it, and the chain card
 * repainted as the press takes the deck's focus off it, change the colours
 * either side of that step and leave it where it is. A frame where the
 * ghost's own edge line stands across an edge leaves that edge unread on
 * that frame, and the count is reported: the line's steps would be read in
 * its place. A stand-in's rect is not evidence of any of this:
 * it is the shell's model, and the host draws the views. The burst's frames
 * are kept under `/tmp` for a reader judging the ghost's fill.
 *
 * **The release lands by the settle.** From the release, every member is
 * sampled on every painted frame and must stay fully opaque: a member the
 * settle mistook for an arrival is held invisible and faded back up, which
 * reads as the rail vanishing at the release, and only a per-frame sample can
 * see it. Each member's page samples its own frame's width on every frame,
 * and reads its press width until it takes the committed width once, under
 * the settle's track, and keeps it. The host's snapshot is polled until the
 * deck is quiet: every member's view travels between its press width and the
 * committed one and lands at the committed one, the chain's first card lands
 * where its travel puts it at that width, and no ghost stands.
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
  expectedEdgeAt,
  railReader,
  railTravelShift,
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
/** How far the ghost's composite edge may stand from the host's reported edge, device px. */
const GHOST_TOL_DEVICE = 1;
/** How far a member's or the chain card's composite edge may stand from where it was pressed, device px. */
const STILL_TOL_DEVICE = 1;
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
      "the ghost moves under the hand while the members and the chain stand still, and the release lands them by the settle",
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
          const chainLeft = reader.chain!.restLeft;

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

          // ---- With the hand down, the ghost moves and nothing else does ----
          const last = moves[moves.length - 1];
          note(
            `${moves.length} move reports over ${(last.wall - downAt).toFixed(0)} ms; ` +
              `last shown ${last.rail?.shown}, edge ${last.rect.x + last.rect.width}; rest edge ${dragged.restEdge}`,
          );
          expect(
            Math.abs((last.rail?.shown ?? 0) - (RAIL_WIDTH + GROW_PX)),
            "the host drew the ghost at the hand's width by the last move",
          ).toBeLessThanOrEqual(PIXEL_TOL);

          // Kept beside the run, for a reader judging the ghost's fill.
          const kept = join("/tmp", `at0678-burst-${Date.now()}`);
          mkdirSync(kept, { recursive: true });
          for (const f of reading.frames) copyFileSync(f.path, join(kept, basename(f.path)));
          note(`burst frames kept at ${kept} (${reading.frames.length})`);

          const toDevice = reader.toDevice;
          // The frame on screen shows one of the host's moves heard in the
          // two display periods before it, and a report heard up to a period
          // after the composite may already be on it.
          const period = (await app.bodies()).find((b) => b.cardId === "J")?.displayPeriodMs ?? 1000 / 60;
          const latencyMs = 2 * period;
          let judged = 0;
          let lined = 0;
          const unread: string[] = [];
          const offGhost: string[] = [];
          const moved: string[] = [];
          const chainMoved: string[] = [];
          for (const f of reading.frames) {
            if (f.wall < downAt || f.wall >= upAt) continue;
            const at = `+${(f.wall - downAt).toFixed(0)}ms`;
            judged += 1;
            const hand = expectedEdgeAt(f.wall, reports, dragged.restEdge, latencyMs, period);
            const lo = toDevice(hand.lo) - GHOST_TOL_DEVICE;
            const hi = toDevice(hand.hi) + GHOST_TOL_DEVICE;
            // A row the standing deck's whole is a ghost not yet drawn: one at
            // the rail's own width.
            reader.ghostEdges(f).forEach((g, i) => {
              const e = g ?? toDevice(reader.members[i].restEdge);
              if (e < lo || e > hi) offGhost.push(`${at} ${MEMBER_CARDS[i]} ghost ${e} not in ${lo.toFixed(1)}..${hi.toFixed(1)}`);
            });
            const still = reader.edgesMoved(f);
            still.members.forEach((d, i) => {
              if (d === "line") lined += 1;
              else if (d === null) unread.push(`${at} ${MEMBER_CARDS[i]}`);
              else if (Math.abs(d) > STILL_TOL_DEVICE) moved.push(`${at} ${MEMBER_CARDS[i]} moved ${d} device px`);
            });
            if (still.chain === "line") lined += 1;
            else if (still.chain === null) unread.push(`${at} ${CHAIN_FIRST}`);
            else if (Math.abs(still.chain) > STILL_TOL_DEVICE) chainMoved.push(`${at} moved ${still.chain} device px`);
          }
          note(
            `${judged} frames judged with the hand down over a ${latencyMs.toFixed(1)} ms window; ` +
              `ghost off the hand ${offGhost.length}; members moved ${moved.length}; chain moved ${chainMoved.length}; ` +
              `unread ${unread.length}; edges under the ghost's line ${lined}`,
          );
          for (const [what, list] of [["ghost off the hand", offGhost], ["members moved", moved], ["chain moved", chainMoved], ["unread", unread]] as const) {
            if (list.length > 0) note(`${what}:\n${list.join("\n")}`);
          }
          expect(judged, "frames were judged with the hand down").toBeGreaterThanOrEqual(10);
          expect(offGhost.length, "on every frame the ghost's edge stands where the host drew it").toBe(0);
          expect(unread.length, "every edge not under the ghost's line is read by colour").toBe(0);
          expect(moved.length, "on every frame every member's edge stands where it was pressed").toBe(0);
          expect(chainMoved.length, "on every frame the chain's first card stands where it was pressed").toBe(0);

          // ---- The release lands by the settle ----
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
          const landed = await memberWidths(app);
          for (const member of MEMBERS) {
            expect(
              Math.abs((landed[member] ?? 0) - expected),
              `${member} landed at ${expected}px (read ${landed[member]?.toFixed(1)})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
          }
          // Where the views are: each member's page, held at its press
          // width through the drag, took the committed width once and kept
          // it; and each member's view travelled from its press width to the
          // committed one and landed there.
          const pressView = RAIL_WIDTH + 2 * CARD_APRON_PX;
          const landedView = expected + 2 * CARD_APRON_PX;
          for (const card of MEMBER_CARDS) {
            const page = pages[card];
            const views = host.widths[card];
            note(`${card} after release: page ${page.length} frames ${spanOf(page)}; host ${spanOf(views)}`);
            expect(page.length, `${card}'s page drew frames after the release`).toBeGreaterThanOrEqual(MIN_FRAMES);
            const took = page.findIndex((w) => Math.abs(w - expected) <= PIXEL_TOL);
            expect(took, `${card}'s page took the committed width`).toBeGreaterThanOrEqual(0);
            expect(
              Math.max(...page.slice(0, took).map((w) => Math.abs(w - RAIL_WIDTH)), 0),
              `${card}'s page stood at its press width ${RAIL_WIDTH}px until it took the committed one (read ${spanOf(page.slice(0, took))})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
            expect(
              Math.max(...page.slice(took).map((w) => Math.abs(w - expected))),
              `${card}'s page stood at ${expected}px on every frame once it took it (read ${spanOf(page.slice(took))})`,
            ).toBeLessThanOrEqual(PIXEL_TOL);
            expect(views.length, `${card}'s view was read after the release`).toBeGreaterThan(0);
            expect(
              views.every((w) => w >= pressView - 1 && w <= landedView + 1),
              `${card}'s view travelled between its press width and the committed one (read ${spanOf(views)})`,
            ).toBe(true);
            expect(
              Math.abs(views[views.length - 1] - landedView),
              `${card}'s view landed at the committed width (read ${views[views.length - 1]?.toFixed(1)})`,
            ).toBeLessThanOrEqual(1);
          }
          expect(host.inHand, "the hand held no member after the release").toBe(0);
          const after = await app.bodies();
          const chainView = after.find((b) => b.cardId === CHAIN_FIRST && b.visible);
          expect(chainView, `the host holds ${CHAIN_FIRST}'s view`).toBeDefined();
          const chainLanding = chainLeft + railTravelShift(travel!, "left", facts.band, GROW_PX) * facts.zoom;
          expect(
            Math.abs(chainView!.presentedFrame.x + CARD_APRON_PX - chainLanding),
            `${CHAIN_FIRST} landed where its travel puts it at ${expected}px (read ${chainView!.presentedFrame.x + CARD_APRON_PX}, want ${chainLanding.toFixed(1)})`,
          ).toBeLessThanOrEqual(1);
          for (const b of after) {
            if (b.cardId === null || !(MEMBER_CARDS as readonly string[]).includes(b.cardId) || !b.visible) continue;
            expect(b.rail?.ghost ?? null, `no ghost stands over ${b.cardId}'s rail once the hand let go`).toBeNull();
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
