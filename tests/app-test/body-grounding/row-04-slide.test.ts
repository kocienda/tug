/**
 * row-04-slide.test.ts — a slide moves a body card as one piece: the
 * interim hides the body at the beat's start and shows it at the land.
 *
 * The bar's fourth row ([B02] row 4). A body card stands second in a
 * four-up flow band beside unbound neighbours, with a Layout card on the
 * left rail, and every slide the row names is driven through the deck's own
 * actions: Go to slot (the flow slide, out and back), bullseye (in and out),
 * the sidebars (hidden and shown) and resize-sidebars-to-fit. Across each
 * gesture the composite is read every frame beside a per-animation-frame
 * sampler of the shell's own rects.
 *
 * What the row forbids is a body standing still under moving chrome. Until
 * the host carries bodies through a beat itself (stage 3), the interim is
 * that the settle engine hides every body under a frame its beats will move
 * in the pass that plans them, and the land's measurement shows it again
 * where the chrome stopped (`lib/body-placement.ts`, `bodyHideUnder`). So
 * on every composited frame where the chrome moves the card's content box
 * is the lid — the pane's own surface colour, which the classifier knows
 * exactly — never the floor, never the bare window, never a body standing
 * where the chrome was; and the shell's own record says the lid is on in
 * every sample where the frame moved. At rest the host's container stands
 * on the placeholder and the lid is lifted.
 *
 * The composite is judged while the chrome moves and until the lid lifts,
 * and the body's own paint is not read by colour: a session body's page is
 * the canvas colour over much of its height, and a body that lost focus
 * recedes darker still, so neither can be told from the floor the way the
 * lid can ([B05] is met by the lid's colour, which is exact). Go to slot
 * focuses the slot's card, so after each land the body card is focused
 * again before the next leg.
 *
 * The settle engine's call into the placer is one line and the engine's
 * `@covers` fan-out is at the selection budget, so this file covers the
 * placer, whose interim it reads, and not the engine.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { classifyFrame, describeFrames, framesDiffer, pollFor, readPalette, showsBareHole, type FrameClasses, type Palette } from "./_frames";

const TEST_NAME = "body-grounding-row-04-slide";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const CARD = "row04-body";
const FRAME = `.tug-pane[data-pane-id="${CARD}-pane"]`;
const PLACEHOLDER = `${FRAME} [data-body-placeholder][data-card-id="${CARD}"]`;
const CANVAS = "[data-deck-canvas-background]";
const BODY_READY_MS = 30_000;
const PLACED_MS = 3_000;
/** How long a settle may take to be seen and to land, and the lid to lift after it. */
const SETTLE_MS = 6_000;
const LID_MS = 5_000;
/** The burst over one gesture: its beats and its land. */
const BURST_MS = 3_000;
const BURST_INTERVAL_MS = 33;
/** The crop: the window's width, this much of the card's height from its top. */
const CROP_HEIGHT_PX = 320;
/** How much of the placeholder's rect the lid must fill on a frame where the chrome moves. */
const LID_SHARE = 0.9;
/** How far the host's container may stand from the placeholder at rest. */
const REST_TOLERANCE_PX = 2;
/** Kept clear of the pane's rounded corners when a region is read. */
const CORNER_INSET_PX = 12;
/** A frame moved between two samples when an edge shifted by more than this. */
const MOVED_PX = 0.5;

const BAND = 6;
const RAIL_WIDTH = 360;

/** Six session cards in a four-up flow — the body card second — and a Layout card on the left rail. */
function deck(): Record<string, unknown> {
  const ids = Array.from({ length: BAND }, (_, i) => (i === 1 ? CARD : `row04-n${i}`));
  return {
    cards: [
      ...ids.map((id) => ({ id, componentId: "session", title: id === CARD ? "Body" : id, closable: true })),
      { id: "row04-layout", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `${id}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      {
        id: "row04-layout-pane",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["row04-layout"],
        activeCardId: "row04-layout",
        title: "Layout",
        acceptsFamilies: [] as string[],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: { layout: { side: "left" } } },
    hasFocus: true,
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Sample {
  wall: number;
  frame: Rect;
  placeholder: Rect;
  /** The canvas wears `data-imposer-settling`: a settle is running. */
  settling: boolean;
  /** The placeholder wears `data-body-shown`: the lid is lifted. */
  shown: boolean;
}

const promptPhase = `(function () {
  var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
  return entry === null ? null : entry.getAttribute("data-phase");
})()`;

const rectOf = (app: App, selector: string): Promise<Rect | null> =>
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );

async function bodyOf(app: App): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === CARD) ?? null;
}

/** Arm a per-animation-frame sampler of the frame's and the placeholder's rects, the settle and the lid. */
async function armSampler(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__row04 = { samples: [], stop: false });
      var read = function (el) {
        var r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      var tick = function () {
        if (rec.stop) return;
        var frame = document.querySelector(${JSON.stringify(FRAME)});
        var ph = document.querySelector(${JSON.stringify(PLACEHOLDER)});
        var canvas = document.querySelector(${JSON.stringify(CANVAS)});
        if (frame !== null && ph !== null) {
          rec.samples.push({
            wall: Date.now(),
            frame: read(frame),
            placeholder: read(ph),
            settling: canvas !== null && canvas.hasAttribute("data-imposer-settling"),
            shown: ph.hasAttribute("data-body-shown"),
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

const samplerState = (app: App): Promise<{ saw: boolean; now: boolean; count: number }> =>
  app.evalJS<{ saw: boolean; now: boolean; count: number }>(
    `(function () {
      var r = window.__row04;
      var saw = false;
      for (var i = 0; i < r.samples.length; i++) if (r.samples[i].settling) { saw = true; break; }
      var last = r.samples[r.samples.length - 1];
      return { saw: saw, now: last !== undefined && last.settling, count: r.samples.length };
    })()`,
  );

async function readSampler(app: App): Promise<Sample[]> {
  return app.evalJS<Sample[]>(`(function () { var r = window.__row04; r.stop = true; return r.samples; })()`);
}

/** The index of the latest sample taken at or before `wall`, or -1 before the first. */
function sampleIndexAt(samples: readonly Sample[], wall: number): number {
  let found = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].wall > wall) break;
    found = i;
  }
  return found;
}

const edgeGap = (a: Rect, b: Rect): number =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );

/** How far two rects' left and right edges differ, at most. */
const horizontalStep = (a: Rect, b: Rect): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.x + a.width - (b.x + b.width)));

/** The host's container stands on the placeholder, shown, with the lid lifted. */
async function expectAtRest(app: App, label: string): Promise<Rect> {
  const placeholder = await rectOf(app, PLACEHOLDER);
  const body = await bodyOf(app);
  expect(placeholder, `${label}: the placeholder stands`).not.toBeNull();
  expect(body?.visible, `${label}: the body is placed visible`).toBe(true);
  const gap = edgeGap(placeholder!, body!.frame);
  const lifted = await app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(PLACEHOLDER)})?.hasAttribute("data-body-shown") ?? false`,
  );
  note(
    `${label}: placeholder ${JSON.stringify(placeholder)}; host frame ${JSON.stringify(body!.frame)}; worst edge gap ${gap.toFixed(2)} px; lid lifted ${lifted}`,
  );
  expect(gap, `${label}: the host's container stands on the placeholder`).toBeLessThanOrEqual(REST_TOLERANCE_PX);
  expect(lifted, `${label}: the lid is lifted`).toBe(true);
  return placeholder!;
}

interface Leg {
  label: string;
  /** The deck action, as a page expression. */
  js: string;
  /** Whether the gesture must move the card's frame for the leg to have tested anything. */
  moves: boolean;
}

const LEGS: Leg[] = [
  { label: "go to slot 2", js: `window.__tug.dispatchControlAction("go-to-slot", { value: 2 })`, moves: true },
  { label: "go to slot 1", js: `window.__tug.dispatchControlAction("go-to-slot", { value: 1 })`, moves: true },
  { label: "bullseye in", js: `window.__tug.dispatchControlAction("toggle-bullseye", {})`, moves: true },
  { label: "bullseye out", js: `window.__tug.dispatchControlAction("toggle-bullseye", {})`, moves: true },
  { label: "sidebars hide", js: `window.__tug.dispatchControlAction("toggle-sidebars", {})`, moves: true },
  { label: "sidebars show", js: `window.__tug.dispatchControlAction("toggle-sidebars", {})`, moves: true },
  { label: "resize sidebars to fit", js: `window.__tug.dispatchControlAction("resize-sidebars-to-fit", {})`, moves: false },
];

interface Judged {
  frame: FrameClasses;
  whole: FrameClasses;
  path: string;
  /** The shell's record at the capture: the frame off its standing place and short of its landing. */
  inMotion: boolean;
}

async function runLeg(app: App, leg: Leg, palette: Palette, crop: Rect, keep: string): Promise<void> {
  const before = await expectAtRest(app, `${leg.label}: before`);
  await armSampler(app);
  const armed = (await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop })) as { armed: true };
  expect(armed.armed, `${leg.label}: the burst armed`).toBe(true);
  const gestureWall = Date.now();
  await app.evalJS<null>(`(${leg.js}, null)`);

  // The settle: seen, then over. A gesture that armed none is said so.
  const settle = await pollFor(() => samplerState(app), (s) => s.saw && !s.now, SETTLE_MS);
  note(`${leg.label}: settle seen ${settle.saw}, running ${settle.now}, ${settle.count} shell samples so far`);
  const lid = await pollFor(
    async () => ({
      lifted: await app.evalJS<boolean>(`document.querySelector(${JSON.stringify(PLACEHOLDER)})?.hasAttribute("data-body-shown") ?? false`),
      body: await bodyOf(app),
    }),
    (r) => r.lifted && r.body !== null && r.body.visible,
    LID_MS,
  );
  expect(lid.lifted, `${leg.label}: the lid lifts after the land`).toBe(true);
  // The lid's fade, then the body card focused again (Go to slot moves
  // focus, and an unfocused body recedes) so the landed frame reads as the
  // body's own paint.
  await Bun.sleep(400);
  await app.dispatchControlAction("focus-session-card", { cardId: CARD });
  await pollFor(() => app.getFocusedCardId(), (id) => id === CARD, PLACED_MS);
  await Bun.sleep(400);
  const after = await expectAtRest(app, `${leg.label}: after`);
  const travelled = horizontalStep(before, after);
  note(`${leg.label}: the card travelled ${travelled.toFixed(1)} px across the gesture`);

  const samples = await readSampler(app);
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
  expect(reading.done, `${leg.label}: the burst finished`).toBe(true);
  const scale = reading.scale;

  // ---- The shell's own record: the lid is on wherever the frame moved ----
  let fastestStep = 0;
  let movingSamples = 0;
  let shownWhileMoving = 0;
  for (let i = 1; i < samples.length; i++) {
    const step = horizontalStep(samples[i].frame, samples[i - 1].frame);
    if (step <= MOVED_PX) continue;
    movingSamples += 1;
    fastestStep = Math.max(fastestStep, step);
    if (samples[i].shown) shownWhileMoving += 1;
  }
  note(
    `${leg.label}: ${samples.length} shell samples, ${movingSamples} with the frame moving (fastest step ${fastestStep.toFixed(1)} px), ` +
      `${shownWhileMoving} of those with the lid lifted`,
  );
  if (leg.moves) {
    expect(travelled, `${leg.label}: the gesture moved the card`).toBeGreaterThan(20);
    expect(movingSamples, `${leg.label}: the sampler saw the frame move`).toBeGreaterThan(2);
  }
  expect(shownWhileMoving, `${leg.label}: the lid is on in every sample where the frame moved`).toBe(0);

  // ---- The composite: while the chrome moves, the content box is the lid ----
  // A frame is judged in motion when the shell's record at its capture and
  // at the sample before both have the frame off its standing place and
  // short of its landing — the settle's mark goes on at the arm, before the
  // commit that lids, and bullseye's prepare beat recedes the neighbours
  // before any frame moves, so neither the mark nor a changed composite
  // says the chrome is moving — AND the composite itself has left the
  // standing deck, the window server being a frame behind the shell.
  const standing = reading.frames.find((f) => f.wall >= gestureWall) ?? reading.frames[0];
  const moved = (k: number): boolean =>
    k >= 0 && horizontalStep(samples[k].placeholder, before) > MOVED_PX && horizontalStep(samples[k].placeholder, after) > MOVED_PX;
  const judged: Judged[] = [];
  for (const f of reading.frames) {
    if (f.wall < gestureWall) continue;
    const i = sampleIndexAt(samples, f.wall);
    if (i < 0) continue;
    const s = samples[i];
    const ph = s.placeholder;
    const region = {
      x: (ph.x - crop.x + CORNER_INSET_PX) * scale,
      y: (ph.y - crop.y + CORNER_INSET_PX) * scale,
      width: (ph.width - 2 * CORNER_INSET_PX) * scale,
      height: (Math.min(ph.height, crop.y + crop.height - ph.y) - 2 * CORNER_INSET_PX) * scale,
    };
    const inRect = classifyFrame(f, palette, 8, region);
    const whole = classifyFrame(f, palette);
    const inMotion = moved(i) && moved(i - 1) && framesDiffer(f, standing);
    judged.push({ frame: inRect, whole, path: f.path, inMotion });
  }
  expect(judged.length, `${leg.label}: frames were captured across the gesture`).toBeGreaterThan(10);
  const motion = judged.filter((j) => j.inMotion);
  const worst = motion.length > 0 ? motion.reduce((a, b) => (b.frame.surface < a.frame.surface ? b : a)) : judged[0];
  const bare = motion.filter((j) => showsBareHole(j.whole));
  const offenders = motion.filter((j) => j.frame.surface < LID_SHARE);
  const pct = (v: number): string => (v * 100).toFixed(2) + "%";
  note(
    `${leg.label}: ${judged.length} frames captured, ${motion.length} judged in motion; the lid's smallest share of the placeholder ${pct(worst.frame.surface)} ` +
      `at ${Math.round(worst.frame.t)} ms (${describeFrames([worst.frame])}); ${bare.length} show a bare hole in the crop; ${offenders.length} under the lid bar`,
  );
  if (offenders.length > 0) note(`${leg.label}: frames where the placeholder is not the lid\n${describeFrames(offenders.map((j) => j.frame))}`);

  copyFileSync(worst.path, join(keep, `${leg.label.replace(/\s+/g, "-")}-worst-${Math.round(worst.frame.t)}ms.png`));
  const last = judged[judged.length - 1];
  copyFileSync(last.path, join(keep, `${leg.label.replace(/\s+/g, "-")}-last-${Math.round(last.frame.t)}ms.png`));

  expect(bare.length, `${leg.label}: no frame shows the bare window through a hole the body left behind`).toBe(0);
  if (leg.moves) expect(motion.length, `${leg.label}: frames were captured while the chrome moved`).toBeGreaterThan(3);
  expect(
    offenders.length,
    `${leg.label}: on every frame where the chrome moves the placeholder's rect is the lid (at least ${pct(LID_SHARE)} of it)`,
  ).toBe(0);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 4: slide", () => {
  test(
    "across every slide the body hides at the beat's start and shows with its chrome at the land",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: CARD });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-row04-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
        await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
        const shown = await pollFor(() => bodyOf(app), (b) => b !== null && b.visible, BODY_READY_MS);
        expect(shown?.visible, "the body card's body is placed visible").toBe(true);

        // The turn the stub replays runs out, and the card is focused so
        // bullseye has a card to centre.
        const body = app.body(CARD);
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 90_000 });
        await app.dispatchControlAction("focus-session-card", { cardId: CARD });
        await pollFor(() => app.getFocusedCardId(), (id) => id === CARD, PLACED_MS);
        await Bun.sleep(400);
        const start = await expectAtRest(app, "at the start");

        // The palette, from a probe of the standing body, and the crop: the
        // window's width across the top of the card.
        const probeCrop = {
          x: Math.ceil(start.x) + 2,
          y: Math.ceil(start.y) + 2,
          width: Math.floor(start.width) - 4,
          height: Math.floor(start.height) - 4,
        };
        await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop: probeCrop });
        const probe = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, PLACED_MS);
        const standingFrame = probe.frames[probe.frames.length - 1];
        const palette = await readPalette(app, probe.windowBackground, standingFrame);
        const standing = classifyFrame(standingFrame, palette);
        note(`palette ${JSON.stringify(palette)}; body standing: ${describeFrames([standing])}`);
        expect(standing.surface + standing.other, "the standing body fills its rect with its own paint").toBeGreaterThan(0.95);
        const frame = (await rectOf(app, FRAME))!;
        const crop = { x: 0, y: Math.floor(frame.y), width: probe.contentWidth, height: CROP_HEIGHT_PX };
        const keep = join(tmpdir(), `tug-row04-${Date.now()}`);
        mkdirSync(keep, { recursive: true });
        note(`crop ${JSON.stringify(crop)} at scale ${probe.scale}; frames kept at ${keep}`);

        for (const leg of LEGS) await runLeg(app, leg, palette, crop, keep);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
