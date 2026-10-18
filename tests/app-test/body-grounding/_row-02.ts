/**
 * _row-02.ts — what the pieces of row 2 share: a card drags as one piece:
 * masthead, frame and content move together under the pointer, and land
 * together.
 *
 * The bar's second row ([B02] row 2). A body card's grab handle is pressed
 * and dragged through the activated session tap — a real mouse-down, a trail
 * of real drags, a hold, and a real mouse-up — and the gesture is read three
 * ways at once. A sampler in the shell records the pane frame's rect and the
 * body placeholder's rect on every animation frame; the host's body snapshot
 * says where the host has the container; and a capture burst over the whole
 * of the drag's travel reads every composited frame by colour. The row holds
 * when, at the hold and after the landing, the host's container stands on
 * the placeholder to the pixel; when on every composited frame the
 * placeholder's rect is filled by the body's own paint and not by the floor
 * showing through where the body has yet to catch up; and when no frame
 * shows the bare window through a hole the body has left behind.
 *
 * The placeholder is read where the shell's sampler saw it on the frame
 * nearest each capture, so a body that stood still while the chrome moved
 * reads as the floor filling the rect, and a body a frame or two behind the
 * hand reads as a thin strip of floor at its leading edge. The bar admits
 * the strip — two processes cannot share one vertical blank — and refuses
 * the separation.
 *
 * Frames are judged by surface colour, never ink share ([B05]).
 *
 * Every other kind that is a body is dragged the same way, by the surface
 * its chrome offers: a content card's grab handle, and a rail's whole title
 * bar, which is what a rail wears in place of a handle.
 *
 * The Session card's drag is `row-02-drag-session`, every other kind's
 * `row-02-drag-kinds`, one launch each.
 */

import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { classifyFrame, describeFrames, edgeNearOnRow, fillOnRow, FLOOR_BY_CLASS, floorMeasure, pollFor, readPalette, showsBareHole, type FloorMeasure, type FrameClasses } from "./_frames";
import { expectNoShellReads, kindDeck, standUpKind } from "./_kind-bodies";
import type { CardKind } from "./_kinds";

const TEST_NAME = "body-grounding-row-02-drag";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/**
 * How a piece launches, stated in the piece itself: every row-2 launch takes
 * the screen, and `@foreground` is read off the file that says so.
 */
export interface Launch {
  foreground: boolean;
}

const CARD = "row02-body";
const frameSel = (card: string): string => `.tug-pane:has([data-card-id="${card}"])`;
/** A content card is pressed at its grab handle; a rail wears none, and its whole bar is the surface. */
const handleSel = (card: string, rail: boolean): string =>
  rail ? `${frameSel(card)} .tug-pane-title-bar` : `${frameSel(card)} .tug-pane-title-bar .tug-pane-grab-handle`;
const placeholderSel = (card: string): string => `[data-body-placeholder][data-card-id="${card}"]`;
const BODY_READY_MS = 30_000;
const PLACED_MS = 3_000;
/** The burst over the whole gesture: the trail (about 700 ms), the hold, the release and the landing. */
const BURST_MS = 3_000;
const BURST_INTERVAL_MS = 33;
/** How far the hand carries the card, at most; shortened to what the window allows. */
const TRAVEL_X = 200;
const TRAVEL_Y = 140;
const TRAIL_STEPS = 16;
const TRAIL_STEP_MS = 40;
/** How much of the placeholder's rect may be floor or bare window on any one frame: the lag strip. */
const LAG_SHARE = 0.1;
/** How far the host's container may stand from the placeholder once the hand is still. */
const REST_TOLERANCE_PX = 2;
/** Kept clear of the pane's rounded corners when a region is read. */
const CORNER_INSET_PX = 12;
/** Where the title bar is read: below the top corners' radius, above the masthead's text. */
const MASTHEAD_ROW_PX = 14;
/** A rail's bar: square-cornered, its stripe band through the middle, so it is read just under its top edge. */
const RAIL_BAR_ROW_PX = 4;
/** How many display frames of travel the body may lead or trail the chrome by in a composite. */
const LEAD_FRAMES = 2;
const FRAME_MS = 1000 / 60;

const oneCard = {
  cards: [{ id: CARD, componentId: "session", title: "Body", closable: true }],
  panes: [
    {
      id: `${CARD}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 640, height: 480 },
      cardIds: [CARD],
      activeCardId: CARD,
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    },
  ],
  activePaneId: `${CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

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
  owned: boolean;
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

async function bodyOf(app: App, card: string): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === card) ?? null;
}

/** Arm a per-animation-frame sampler of the frame's and the placeholder's rects. */
async function armSampler(app: App, card: string): Promise<void> {
  // card-dom: shell
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__row02 = { samples: [], stop: false });
      var read = function (el) {
        var r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      var tick = function () {
        if (rec.stop) return;
        var frame = document.querySelector(${JSON.stringify(frameSel(card))});
        var ph = document.querySelector(${JSON.stringify(placeholderSel(card))});
        if (frame !== null && ph !== null) {
          rec.samples.push({
            wall: Date.now(),
            frame: read(frame),
            placeholder: read(ph),
            owned: frame.hasAttribute("data-pointer-owned"),
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

async function readSampler(app: App): Promise<Sample[]> {
  // card-dom: shell
  return app.evalJS<Sample[]>(`(function () { var r = window.__row02; r.stop = true; return r.samples; })()`);
}

/** The latest sample taken at or before `wall`, or null before the first. */
function sampleAt(samples: readonly Sample[], wall: number): Sample | null {
  let found: Sample | null = null;
  for (const s of samples) {
    if (s.wall > wall) break;
    found = s;
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

/** The host's container stands on the placeholder: every edge within the tolerance. */
async function expectAtRest(app: App, card: string, label: string): Promise<Rect> {
  const placeholder = await rectOf(app, placeholderSel(card));
  const body = await bodyOf(app, card);
  expect(placeholder, `${label}: the placeholder stands`).not.toBeNull();
  expect(body?.visible, `${label}: the body is placed visible`).toBe(true);
  const gap = edgeGap(placeholder!, body!.frame);
  note(
    `${label}: placeholder ${JSON.stringify(placeholder)}; host frame ${JSON.stringify(body!.frame)}; worst edge gap ${gap.toFixed(2)} px`,
  );
  expect(gap, `${label}: the host's container stands on the placeholder`).toBeLessThanOrEqual(REST_TOLERANCE_PX);
  return placeholder!;
}

/**
 * The gesture and its reading, for the card `card` standing as a body:
 * pressed at `handle` (a content card's grab handle, a rail's whole bar),
 * carried, held and released.
 */
async function dragLeg(app: App, card: string, handle: Rect, measure: FloorMeasure = FLOOR_BY_CLASS, rail = false): Promise<void> {
  // ---- Where the card stands, and the palette ----
  const start = await expectAtRest(app, card, "before the drag");
  const startFrame = (await rectOf(app, frameSel(card)))!;
  const inner = await app.evalJS<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
  // An imposed pane fills the window's height, so the travel is mostly
  // sideways; the hand goes down only as far as the window leaves room.
  // Toward whichever side the window leaves room on: a content card has it
  // on its right, and a rail pinned to the right edge has it on its left.
  const roomRight = Math.floor(inner.w - (startFrame.x + startFrame.width) - 24);
  const roomLeft = Math.floor(startFrame.x - 24);
  const dx = roomRight >= 60 ? Math.min(TRAVEL_X, roomRight) : -Math.min(TRAVEL_X, roomLeft);
  const dy = Math.max(0, Math.min(TRAVEL_Y, Math.floor(inner.h - (startFrame.y + startFrame.height) - 24)));
  expect(Math.abs(dx), "the window leaves room to drag the card").toBeGreaterThanOrEqual(60);
  note(`travel ${dx}, ${dy} px in a ${inner.w}×${inner.h} window; frame ${JSON.stringify(startFrame)}`);

  const probeCrop = {
    x: Math.ceil(start.x) + 2,
    y: Math.ceil(start.y) + 2,
    width: Math.floor(start.width) - 4,
    height: Math.floor(start.height) - 4,
  };
  await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop: probeCrop });
  const probe = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    PLACED_MS,
  );
  const standingFrame = probe.frames[probe.frames.length - 1];
  const palette = await readPalette(app, probe.windowBackground, standingFrame);
  const standing = classifyFrame(standingFrame, palette);
  note(`palette ${JSON.stringify(palette)}; body standing: ${describeFrames([standing])}`);
  expect(measure.own(standing), "the standing body fills its rect with its own paint").toBeGreaterThan(0.95);

  // ---- The gesture, read three ways ----
  // The crop is the union of where the card starts and where it lands,
  // so the floor it leaves behind is in frame as well as the body.
  const crop = {
    x: Math.max(0, Math.floor(Math.min(startFrame.x, startFrame.x + dx)) - 4),
    y: Math.max(0, Math.floor(startFrame.y) - 4),
    width: Math.ceil(startFrame.width + Math.abs(dx)) + 8,
    height: Math.ceil(startFrame.height + dy) + 8,
  };
  crop.width = Math.min(crop.width, Math.floor(inner.w) - crop.x);
  crop.height = Math.min(crop.height, Math.floor(inner.h) - crop.y);
  await armSampler(app, card);
  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const from = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
  const to = { x: from.x + dx, y: from.y + dy };
  const gestureWall = Date.now();
  await app.nativeDragWithoutRelease(from, to, {
    interpolationSteps: TRAIL_STEPS,
    interpolationDelayMs: TRAIL_STEP_MS,
    mouseDownDelayMs: 80,
  });
  // The hand is still, the button down: the card is where the hand took it.
  const owned = await app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(frameSel(card))})?.hasAttribute("data-pointer-owned") === true`,
  );
  expect(owned, "the drag latched: the pane frame is pointer-owned").toBe(true);
  const held = await expectAtRest(app, card, "at the hold");
  const travelled = { x: held.x - start.x, y: held.y - start.y };
  note(`the hand carried the card ${travelled.x.toFixed(1)}, ${travelled.y.toFixed(1)} px of ${dx}, ${dy}`);
  expect(Math.hypot(travelled.x, travelled.y), "the card travelled with the hand").toBeGreaterThan(
    0.8 * Math.hypot(dx, dy),
  );

  // ---- The release, and the landing ----
  const releaseWall = Date.now();
  await app.nativeMouseUp(to);
  const landed = await pollFor(
    () =>
      app.evalJS<boolean>(
        `(function () {
          var f = document.querySelector(${JSON.stringify(frameSel(card))});
          return f !== null && !f.hasAttribute("data-pointer-owned") && !f.hasAttribute("data-gesture") &&
            document.querySelector('[data-imposer-settling]') === null;
        })()`,
      ),
    (v) => v,
    PLACED_MS,
  );
  expect(landed, "the drop landed and the deck settled").toBe(true);
  await Bun.sleep(400);
  const rest = await expectAtRest(app, card, "after the landing");
  note(`landed at ${JSON.stringify(rest)}`);

  const samples = await readSampler(app);
  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    BURST_MS + 5_000,
  );
  expect(reading.done, "the burst finished").toBe(true);

  // ---- The frames ----
  // The masthead and the frame are one element's children, so the
  // placeholder's place inside the frame never changes while it moves —
  // beyond the border's width the lifted livery adds at the gesture's
  // start, which is the chrome dressing itself, not content parting
  // from it.
  const offsets = samples.map((s) => ({ x: s.placeholder.x - s.frame.x, y: s.placeholder.y - s.frame.y }));
  const offsetDrift = Math.max(
    ...offsets.map((o) => Math.max(Math.abs(o.x - offsets[0].x), Math.abs(o.y - offsets[0].y))),
  );
  const moving = samples.filter((s) => s.owned).length;
  note(`${samples.length} shell samples, ${moving} with the frame pointer-owned; placeholder-in-frame drift ${offsetDrift.toFixed(2)} px`);
  expect(moving, "the sampler saw the frame under the hand").toBeGreaterThan(3);
  expect(offsetDrift, "the content box keeps its place inside the frame as it moves").toBeLessThanOrEqual(3);

  const scale = reading.scale;
  // The chrome's own colour: the title bar on the first captured frame,
  // before the hand moved anything.
  const s0 = samples[0];
  const mastheadRowOf = (s: Sample): number => (s.frame.y + (rail ? RAIL_BAR_ROW_PX : MASTHEAD_ROW_PX) - crop.y) * scale;
  const contentRowOf = (s: Sample): number => (s.placeholder.y + s.placeholder.height / 2 - crop.y) * scale;
  const chrome = fillOnRow(
    reading.frames[0],
    mastheadRowOf(s0),
    (s0.frame.x - crop.x + CORNER_INSET_PX) * scale,
    (s0.frame.x + s0.frame.width - crop.x - CORNER_INSET_PX) * scale,
  );
  note(`chrome colour ${JSON.stringify(chrome)} read on the title bar's row`);
  // The lead the composite may show between the body and the chrome:
  // two display frames of travel at the hand's speed during the trail,
  // and at the landing's fastest step after the release.
  const trailSpeed = Math.hypot(dx, dy) / (TRAIL_STEPS * TRAIL_STEP_MS);
  let landingStep = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].wall < releaseWall) continue;
    landingStep = Math.max(landingStep, Math.abs(samples[i].frame.x - samples[i - 1].frame.x));
  }
  const trailLead = LEAD_FRAMES * trailSpeed * FRAME_MS + 2;
  const landingLead = LEAD_FRAMES * landingStep + 2;
  const judged: Array<{ frame: FrameClasses; whole: FrameClasses; lag: number; lead: number | null; path: string }> = [];
  for (const f of reading.frames) {
    if (f.wall < gestureWall) continue;
    const s = sampleAt(samples, f.wall);
    if (s === null) continue;
    const ph = s.placeholder;
    const region = {
      x: (ph.x - crop.x + CORNER_INSET_PX) * scale,
      y: (ph.y - crop.y + CORNER_INSET_PX) * scale,
      width: (ph.width - 2 * CORNER_INSET_PX) * scale,
      height: (ph.height - 2 * CORNER_INSET_PX) * scale,
    };
    const inRect = classifyFrame(f, palette, 8, region);
    const whole = classifyFrame(f, palette);
    // Where the composite shows the chrome and the body standing, each
    // by its own colour: the body's left edge less the chrome's, less the
    // content box's own inset. The edges are the composite's; the rects the
    // shell sampled on this frame only choose which run on the row is this
    // card's, where a neighbour or the card's own bar shares the colour.
    const chromeLeft = edgeNearOnRow(f, mastheadRowOf(s), chrome, 8, (s.frame.x - crop.x) * scale);
    const bodyLeft = edgeNearOnRow(f, contentRowOf(s), palette.surface, 8, (ph.x - crop.x) * scale);
    const lead =
      chromeLeft === null || bodyLeft === null
        ? null
        : (bodyLeft - chromeLeft) / scale - (ph.x - s.frame.x);
    judged.push({ frame: inRect, whole, lag: measure.floor(inRect), lead, path: f.path });
  }
  expect(judged.length, "frames were captured across the gesture").toBeGreaterThan(10);
  const worst = judged.reduce((a, b) => (b.lag > a.lag ? b : a));
  const bare = judged.filter((j) => showsBareHole(j.whole));
  const duringTrail = judged.filter((j) => j.frame.wall < releaseWall).length;
  const pct = (v: number): string => (v * 100).toFixed(2) + "%";
  note(
    `${judged.length} frames judged (${duringTrail} before the release); worst floor-or-bare share inside the placeholder ${pct(worst.lag)} ` +
      `at ${Math.round(worst.frame.t)} ms (${describeFrames([worst.frame])}); ${bare.length} frames show a bare hole anywhere in the crop`,
  );
  if (bare.length > 0) note(`bare-hole frames\n${describeFrames(bare.map((j) => j.whole))}`);
  const offenders = judged.filter((j) => j.lag > LAG_SHARE);
  if (offenders.length > 0) note(`frames with the floor inside the placeholder\n${describeFrames(offenders.map((j) => j.frame))}`);
  const withLead = judged.filter((j) => j.lead !== null);
  const worstLead = withLead.reduce((a, b) => (Math.abs(b.lead!) > Math.abs(a.lead!) ? b : a));
  const leadOffenders = withLead.filter(
    (j) => Math.abs(j.lead!) > (j.frame.wall < releaseWall ? trailLead : landingLead),
  );
  note(
    `${withLead.length} frames read for lead; the body led the chrome by at most ${worstLead.lead!.toFixed(1)} px ` +
      `at ${Math.round(worstLead.frame.t)} ms (allowed ${trailLead.toFixed(1)} px in the trail at ${(trailSpeed * 1000).toFixed(0)} px/s, ` +
      `${landingLead.toFixed(1)} px in the landing whose fastest step was ${landingStep.toFixed(1)} px); ${leadOffenders.length} over`,
  );
  if (leadOffenders.length > 0)
    note(`frames where the body led or trailed the chrome\n${leadOffenders.map((j) => `${Math.round(j.frame.t)}ms lead ${j.lead!.toFixed(1)} px`).join("\n")}`);

  // Kept for a reader's eye: the worst frame and the last.
  const keep = join(tmpdir(), `tug-row02-${Date.now()}`);
  mkdirSync(keep, { recursive: true });
  copyFileSync(worst.path, join(keep, `worst-${Math.round(worst.frame.t)}ms.png`));
  copyFileSync(worstLead.path, join(keep, `worst-lead-${Math.round(worstLead.frame.t)}ms.png`));
  const last = judged[judged.length - 1];
  copyFileSync(last.path, join(keep, `last-${Math.round(last.frame.t)}ms.png`));
  note(`frames kept at ${keep}`);

  expect(bare.length, "no frame shows the bare window through a hole the body left behind").toBe(0);
  expect(
    offenders.length,
    `on every frame the placeholder's rect is the body's own paint, not the floor (lag strip allowed up to ${pct(LAG_SHARE)})`,
  ).toBe(0);
  expect(measure.own(last.frame), "the landed rect is the body's own paint").toBeGreaterThan(0.95);
  expect(withLead.length, "the chrome and the body were both found on the frames").toBeGreaterThan(10);
  expect(
    leadOffenders.length,
    `on every frame the body stands with the chrome in the composite, within ${LEAD_FRAMES} frames of travel`,
  ).toBe(0);
}

/** Launch with a body of `kind` stood up beside a Session card, and drag it by the surface its chrome offers. */
export async function dragKind(launch: Launch, kind: CardKind): Promise<void> {
  const card = `row02-${kind.componentId}`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}`, ...launch });
  try {
    await app.seedDeckState({ state: kindDeck(kind, card, { sessions: ["row02-seed"] }), focusCardId: card });
    await standUpKind(app, kind, card);
    const handle = await pollFor(() => rectOf(app, handleSel(card, kind.rail)), (r) => r !== null && r.width > 0, PLACED_MS);
    expect(handle, `the ${kind.componentId} card's chrome offers a drag surface`).not.toBeNull();
    await Bun.sleep(400);
    await dragLeg(app, card, handle!, floorMeasure(kind.rail), kind.rail);
    await expectNoShellReads(app, card);
  } finally {
    await app.close();
  }
}

/** Launch with one Session body card, its stub turn run out, and drag it by its grab handle. */
export async function dragSession(launch: Launch): Promise<void> {
  const stubDir = stubDirectory();
  const app = await launchTugApp({ testName: TEST_NAME, ...launch, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  try {
    await app.seedDeckState({ state: oneCard, focusCardId: CARD });
    const tugSessionId = randomUUID();
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-row02-project-")));
    onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
    writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
    await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
    const shown = await pollFor(() => bodyOf(app, CARD), (b) => b !== null && b.visible, BODY_READY_MS);
    expect(shown?.visible, "the body card's body is placed visible").toBe(true);

    // The masthead — whose lead line carries the grab handle — is bound.
    const body = app.body(CARD);
    await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 90_000 });
    // The handle fills the lead line beside the masthead's identity, which
    // keeps re-laying out as the body's facts land after the turn goes idle:
    // a centre read straight away stood 8 px inside the handle's left edge by
    // the press, so a run that settles a few px further misses it. So the
    // handle is read once it has held still for half a second.
    let last: Rect | null = null;
    let still = 0;
    const handle = await pollFor(
      async () => {
        const r = await rectOf(app, handleSel(CARD, false));
        const same = r !== null && last !== null && r.x === last.x && r.y === last.y && r.width === last.width;
        still = same ? still + 1 : 0;
        last = r;
        return r;
      },
      (r) => r !== null && r.width > 0 && still >= 10,
      PLACED_MS,
    );
    expect(handle, "the body card's masthead carries a grab handle").not.toBeNull();
    expect(still, "and it holds still before the press").toBeGreaterThanOrEqual(10);

    await dragLeg(app, CARD, handle!);
  } finally {
    await app.close();
  }
}
