/**
 * _row-01.ts — what the pieces of row 1 share: a new card arrives with
 * nothing of the canvas, the grid or the window showing through, at any
 * frame, warm and cold.
 *
 * The bar's first row ([B02] row 1). ⌘N through the activated session tap
 * opens a card the user's way; the card is handed to a body when its session
 * spawns, and from that hand-off every composited frame of the card's content
 * rect is read: the placeholder's lid paints the pane's own surface until the
 * host has the body on screen, the host shows the container in one step under
 * the lid (no fade through the hole), and the lid lifts in a fade from the
 * surface to the content. So no frame after the hand-off carries more of the
 * canvas colour, the grid colour or the window's background than the finished
 * body itself does, and at least one frame is the blank lid.
 *
 * The first card takes the warm spare. For the cold reading a second card
 * takes the next spare unobserved and a third is spawned at once behind it,
 * inside the second the spare takes to be replaced, so it is made cold. Both
 * observed arrivals are read the same way.
 *
 * Frames are judged by surface colour, never ink share ([B05]).
 *
 * Every other kind that is a body arrives the way it opens — a rail shown on
 * its edge, a content card added as a tab — and is handed off the moment the
 * deck holds it. Its placeholder stands in the same commit, so the burst is
 * armed over the whole window and every frame is read at the rect the
 * placeholder stood at on that frame: a rail slides in as it arrives.
 *
 * One launch per arrival: `row-01-arrival-warm` and `row-01-arrival-cold`
 * for the Session card, `row-01-arrival-kinds` for every other kind.
 */

import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading, HostFrameReading } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { classifyFrame, describeFrames, FLOOR_BY_CLASS, floorMeasure, pollFor, readPalette, type FloorMeasure, type FrameClasses } from "./_frames";
import { armPlaceholderSampler, openKind, placeholderAt, readPlaceholderSampler } from "./_kind-bodies";
import type { CardKind } from "./_kinds";

const TEST_NAME = "body-grounding-row-01-arrival";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/**
 * How a piece launches, stated in the piece itself: every row-1 launch takes
 * the screen, and `@foreground` is read off the file that says so.
 */
export interface Launch {
  foreground: boolean;
}

const SEED = "row01-seed";
const BODY_READY_MS = 30_000;
const PLACED_MS = 3_000;
/** The burst over one arrival: hand-off, body ready, shown, lid lifted. */
const BURST_MS = 4_000;
/**
 * The burst over a kind's arrival, read over the whole window. The lid lifts
 * some 50 ms after the hand-off and the body is ready by 70 ms, so two
 * seconds still watch it stand well past both, and the file keeps inside its
 * 20 s budget, which the four-second full-window burst ran past.
 */
const KIND_BURST_MS = 2_000;
const BURST_INTERVAL_MS = 33;

const oneCard = {
  cards: [{ id: SEED, componentId: "session", title: "Seed", closable: true }],
  panes: [
    {
      id: `${SEED}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 640, height: 480 },
      cardIds: [SEED],
      activeCardId: SEED,
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    },
  ],
  activePaneId: `${SEED}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const placeholderRect = (app: App, cardId: string): Promise<Rect | null> =>
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector('[data-body-placeholder][data-card-id="${cardId}"]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );

const lidLifted = (app: App, cardId: string): Promise<boolean> =>
  // card-dom: shell
  app.evalJS<boolean>(
    `document.querySelector('[data-body-placeholder][data-card-id="${cardId}"][data-body-shown]') !== null`,
  );

/** ⌘N through the tap; resolves the new card's id once the deck focuses it. */
async function newCardByChord(app: App, before: string | null): Promise<string> {
  await app.nativeKey("n", ["cmd"]);
  const id = await pollFor(() => app.getFocusedCardId(), (c) => c !== null && c !== before, PLACED_MS);
  expect(id, "⌘N opened a new card and the deck focused it").not.toBe(before);
  await deckStill(app);
  return id!;
}

/**
 * Wait for the deck's own motion to land: no pane arriving, no settle
 * running, and a beat more for the arrive beat's last frame. The row reads
 * the body's arrival, not the shell's arrival of the card that holds it.
 */
async function deckStill(app: App): Promise<void> {
  const still = await pollFor(
    () =>
      app.evalJS<boolean>(
        `document.querySelector('[data-imposer-settling]') === null && document.querySelector('.tug-pane[data-arriving]') === null`,
      ),
    (v) => v,
    PLACED_MS,
  );
  expect(still, "the deck settled after the new card arrived").toBe(true);
  await Bun.sleep(400);
}

/** Spawn a stub session onto `cardId`: the hand-off to a body. */
async function spawnStub(app: App, cardId: string, stubDir: string): Promise<void> {
  const tugSessionId = randomUUID();
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-row01-project-")));
  onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
  await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
}

async function bodyOf(app: App, cardId: string): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === cardId) ?? null;
}

interface ArrivalReading {
  frames: FrameClasses[];
  afterHandOff: FrameClasses[];
  final: FrameClasses;
  body: BodyViewSnapshot;
  host: HostFrameReading | null;
  handOffWall: number;
}

/**
 * One arrival, read on every frame: the card's content rect is captured from
 * just before the hand-off until the lid has lifted and the body has stood a
 * while; the host's meter samples the container's presented opacity over the
 * same window.
 */
async function arrive(app: App, cardId: string, stubDir: string, label: string): Promise<ArrivalReading> {
  // The card stands focused with its picker; its content box is where the
  // body lands.
  const paneRect = await app.evalJS<Rect | null>(
    `(function () {
      var content = document.querySelector('.tug-pane[data-focused="true"] .tug-pane-content');
      if (content === null) return null;
      var r = content.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
  expect(paneRect, `${label}: the card's pane has a content box`).not.toBeNull();
  const crop = {
    x: Math.ceil(paneRect!.x) + 2,
    y: Math.ceil(paneRect!.y) + 2,
    width: Math.floor(paneRect!.width) - 4,
    height: Math.floor(paneRect!.height) - 4,
  };

  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const spawnWall = Date.now();
  await spawnStub(app, cardId, stubDir);
  // The hand-off lands when the shell stands the placeholder. The lid lands
  // in that same commit, so the first frame painted after it is a lid frame,
  // and frames are judged from there; a capture inside the commit's own
  // frame still shows the card the body replaced. How far the first lid
  // frame trails the commit is asserted below, so the skew stays a frame.
  const landed = Date.now() + PLACED_MS;
  while ((await placeholderRect(app, cardId)) === null && Date.now() < landed) await Bun.sleep(5);
  const handOffWall = Date.now();
  // The host has the body as soon as the hand-off lands; sample its container.
  await pollFor(() => bodyOf(app, cardId), (b) => b !== null, PLACED_MS);
  let host: HostFrameReading | null = null;
  const armed = await app.hostFrames({ op: "arm", windowMs: BURST_MS, layer: cardId }).catch(() => null);
  const shown = await pollFor(
    () => bodyOf(app, cardId),
    (b) => b !== null && b.state === "ready" && b.painted && b.visible,
    BODY_READY_MS,
  );
  expect(shown?.visible, `${label}: the body is placed visible`).toBe(true);
  expect(shown?.painted, `${label}: a visible body has painted`).toBe(true);
  const lifted = await pollFor(() => lidLifted(app, cardId), (v) => v, PLACED_MS);
  expect(lifted, `${label}: the shell lifted the lid once the host said shown`).toBe(true);

  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    BURST_MS + 5_000,
  );
  if (armed !== null) {
    await Bun.sleep(Math.max(0, BURST_MS - (Date.now() - handOffWall)));
    host = (await app.hostFrames({ op: "read" })) as HostFrameReading;
  }
  expect(reading.done, `${label}: the burst finished`).toBe(true);
  expect(reading.frames.length, `${label}: the burst captured frames`).toBeGreaterThan(BURST_MS / BURST_INTERVAL_MS / 2);

  // The surface is calibrated from the last frame, the body standing.
  const palette = await readPalette(app, reading.windowBackground, reading.frames[reading.frames.length - 1]);
  note(`${label}: palette ${JSON.stringify(palette)}, crop ${JSON.stringify(crop)}, ${reading.frames.length} frames`);
  // Judged over the rect the card stands in once it has landed, not the crop:
  // the crop is the picker's content box before the hand-off, and a Session
  // card's masthead grows by 52 pt at the hand-off, so the crop's top band
  // becomes chrome that no lid paints.
  const standing = await placeholderRect(app, cardId);
  const s = reading.scale;
  const region =
    standing === null
      ? undefined
      : {
          x: (Math.ceil(standing.x) + 2 - crop.x) * s,
          y: (Math.ceil(standing.y) + 2 - crop.y) * s,
          width: (Math.floor(standing.width) - 4) * s,
          height: (Math.floor(standing.height) - 4) * s,
        };
  const frames = reading.frames.map((f) => classifyFrame(f, palette, 8, region));
  const firstLid = frames.findIndex((f) => f.wall >= handOffWall - BURST_INTERVAL_MS && f.surface > 0.9);
  expect(firstLid, `${label}: a lid frame follows the hand-off`).toBeGreaterThanOrEqual(0);
  const skewMs = frames[firstLid].wall - handOffWall;
  note(`${label}: the first lid frame came ${skewMs.toFixed(0)} ms after the placeholder stood`);
  expect(skewMs, `${label}: the lid is painted within a few frames of the hand-off commit`).toBeLessThanOrEqual(5 * BURST_INTERVAL_MS);
  const afterHandOff = frames.slice(firstLid);
  const beforeHandOff = frames.slice(0, firstLid);
  note(
    `${label}: hand-off landed ${handOffWall - spawnWall} ms after the spawn; ${beforeHandOff.length} frames before it` +
      (beforeHandOff.length > 0 ? ` (last: ${describeFrames([beforeHandOff[beforeHandOff.length - 1]])})` : ""),
  );
  const final = frames[frames.length - 1];
  return { frames, afterHandOff, final, body: shown!, host, handOffWall };
}

/** The row's judgement of one arrival. */
function judge(label: string, r: ArrivalReading, measure: FloorMeasure = FLOOR_BY_CLASS): void {
  const pct = (v: number): string => (v * 100).toFixed(2) + "%";
  const worstCanvas = Math.max(...r.afterHandOff.map((f) => f.canvas));
  const worstGrid = Math.max(...r.afterHandOff.map((f) => f.grid));
  const worstBare = Math.max(...r.afterHandOff.map((f) => f.bare));
  const lidFrames = r.afterHandOff.filter((f) => f.surface > 0.9).length;
  note(
    `${label}: ${r.afterHandOff.length} frames after the hand-off; worst canvas ${pct(worstCanvas)} (final ${pct(r.final.canvas)}), ` +
      `worst grid ${pct(worstGrid)} (final ${pct(r.final.grid)}), worst bare ${pct(worstBare)}; ${lidFrames} blank-lid frames; ` +
      `final surface ${pct(r.final.surface)} ink ${pct(r.final.other)}; body ${r.body.start}, ready ${r.body.readyMs?.toFixed(0)} ms`,
  );
  if (r.host !== null) {
    const samples = r.host.samples ?? [];
    const between = samples.filter((s) => s.opacity > 0.05 && s.opacity < 0.9999);
    const first = samples.findIndex((s) => s.opacity >= 0.9999);
    note(
      `${label}: host sampled the container ${samples.length} times; ${between.length} mid-opacity samples; ` +
        `opaque from sample ${first} (${first >= 0 ? Math.round(samples[first].t) : "never"} ms)`,
    );
    expect(between.length, `${label}: the container shows in one step under the lid, never a fade through the hole`).toBe(0);
  }
  const offenders = r.afterHandOff.filter(
    (f) => f.canvas > r.final.canvas + 0.005 || f.bare > r.final.bare + 0.005,
  );
  if (offenders.length > 0) note(`${label}: offending frames\n${describeFrames(offenders)}`);
  expect(
    offenders.length,
    `${label}: no frame after the hand-off shows more canvas or bare window than the finished body does`,
  ).toBe(0);
  expect(lidFrames, `${label}: the lid stood over the rect before the body showed`).toBeGreaterThan(0);
  expect(r.final.surface, `${label}: the finished rect is the body's own surface`).toBeGreaterThan(0.3);
  expect(measure.ink(r.final), `${label}: the finished rect carries the body's content`).toBeGreaterThan(0.01);
}

/**
 * A card of `kind` opened the user's way: the burst covers the window, and
 * each frame is classed inside the rect its placeholder stood at then.
 */
async function arriveKind(app: App, kind: CardKind, label: string): Promise<ArrivalReading> {
  const inner = await app.evalJS<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
  const crop = { x: 0, y: 0, width: Math.floor(inner.w), height: Math.floor(inner.h) };
  await armPlaceholderSampler(app);
  await app.captureBurst({ op: "arm", durationMs: KIND_BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const openWall = Date.now();
  const cardId = await openKind(app, kind);
  const landed = Date.now() + PLACED_MS;
  while ((await placeholderRect(app, cardId)) === null && Date.now() < landed) await Bun.sleep(5);
  const handOffWall = Date.now();
  await pollFor(() => bodyOf(app, cardId), (b) => b !== null, PLACED_MS);
  const armed = await app.hostFrames({ op: "arm", windowMs: KIND_BURST_MS, layer: cardId }).catch(() => null);
  const shown = await pollFor(
    () => bodyOf(app, cardId),
    (b) => b !== null && b.state === "ready" && b.painted && b.visible,
    BODY_READY_MS,
  );
  expect(shown?.visible, `${label}: the body is placed visible`).toBe(true);
  expect(shown?.componentId, `${label}: the body holds a ${kind.componentId} card`).toBe(kind.componentId);
  const lifted = await pollFor(() => lidLifted(app, cardId), (v) => v, PLACED_MS);
  expect(lifted, `${label}: the shell lifted the lid once the host said shown`).toBe(true);
  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    KIND_BURST_MS + 5_000,
  );
  let host: HostFrameReading | null = null;
  if (armed !== null) {
    await Bun.sleep(Math.max(0, KIND_BURST_MS - (Date.now() - handOffWall)));
    host = (await app.hostFrames({ op: "read" })) as HostFrameReading;
  }
  const samples = await readPlaceholderSampler(app);
  expect(reading.done, `${label}: the burst finished`).toBe(true);
  const scale = reading.scale;
  const inset = 4;
  const regionAt = (wall: number) => {
    const r = placeholderAt(samples, cardId, wall);
    return r === null
      ? null
      : { x: (r.x + inset) * scale, y: (r.y + inset) * scale, width: (r.width - 2 * inset) * scale, height: (r.height - 2 * inset) * scale };
  };
  const last = reading.frames[reading.frames.length - 1];
  const lastRegion = regionAt(last.wall);
  expect(lastRegion, `${label}: the placeholder stood on the last frame`).not.toBeNull();
  // The palette's surface is the body standing: the commonest colour inside its rect on the last frame.
  const base = await readPalette(app, reading.windowBackground, last);
  const [r, g, b] = classifyFrame(last, base, 8, lastRegion!).fill.match(/\d+/g)!.map(Number);
  const palette = { ...base, surface: { r, g, b } };
  note(`${label}: ${kind.componentId} ${cardId}; palette ${JSON.stringify(palette)}, ${reading.frames.length} frames`);
  const frames = reading.frames.flatMap((f) => {
    const region = regionAt(f.wall);
    return region === null ? [] : [classifyFrame(f, palette, 8, region)];
  });
  const firstLid = frames.findIndex((f) => f.wall >= handOffWall - BURST_INTERVAL_MS && f.surface > 0.9);
  expect(firstLid, `${label}: a lid frame follows the hand-off`).toBeGreaterThanOrEqual(0);
  const skewMs = frames[firstLid].wall - handOffWall;
  note(`${label}: opened ${handOffWall - openWall} ms before the placeholder stood; the first lid frame came ${skewMs.toFixed(0)} ms after it`);
  const beforeLid = frames.filter((f, i) => i < firstLid && f.wall >= handOffWall - BURST_INTERVAL_MS);
  if (beforeLid.length > 0) note(`${label}: the frames between the placeholder and the lid\n${describeFrames(beforeLid)}`);
  expect(skewMs, `${label}: the lid is painted within a few frames of the hand-off commit`).toBeLessThanOrEqual(5 * BURST_INTERVAL_MS);
  return { frames, afterHandOff: frames.slice(firstLid), final: frames[frames.length - 1], body: shown!, host, handOffWall };
}

/** A card of `kind` opened the way it opens, read from the hand-off on. */
export async function arrivalOfKind(launch: Launch, kind: CardKind): Promise<void> {
  const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}`, ...launch, bodies: true });
  try {
    await app.seedDeckState({ state: oneCard, focusCardId: SEED });
    await pollFor(() => app.bodies(), (all) => all.some((b) => b.cardId === null && b.state === "connected"), BODY_READY_MS);
    const arrival = await arriveKind(app, kind, kind.componentId);
    judge(kind.componentId, arrival, floorMeasure(kind.rail));
  } finally {
    await app.close();
  }
}

/** Launch with the seed card and a spare waiting connected, and run `body`. */
async function withSpare(launch: Launch, name: string, body: (app: App, stubDir: string) => Promise<void>): Promise<void> {
  const stubDir = stubDirectory();
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}`, ...launch, bodies: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  try {
    await app.seedDeckState({ state: oneCard, focusCardId: SEED });
    // The spare is made a beat after the shell paints, and waits connected.
    const spares = await pollFor(
      () => app.bodies(),
      (all) => all.some((b) => b.cardId === null && b.state === "connected"),
      BODY_READY_MS,
    );
    expect(spares.some((b) => b.cardId === null && b.state === "connected"), "a spare body waits, connected").toBe(true);
    await body(app, stubDir);
  } finally {
    await app.close();
  }
}

/** ⌘N: the first card takes the warm spare. */
export function arrivalWarm(launch: Launch): Promise<void> {
  return withSpare(launch, "warm", async (app, stubDir) => {
    const warmCard = await newCardByChord(app, SEED);
    const warm = await arrive(app, warmCard, stubDir, "warm");
    expect(warm.body.start, "the first card bound the spare").toBe("warm");
    judge("warm", warm);
  });
}

/** ⌘N twice: a card spawned at once behind the one that took the spare is made cold. */
export function arrivalCold(launch: Launch): Promise<void> {
  return withSpare(launch, "cold", async (app, stubDir) => {
    const takerCard = await newCardByChord(app, SEED);
    const coldCard = await newCardByChord(app, takerCard);
    await spawnStub(app, takerCard, stubDir);
    const cold = await arrive(app, coldCard, stubDir, "cold");
    expect(cold.body.start, "the card spawned behind the spare's taker was made cold").toBe("cold");
    judge("cold", cold);
    const rect = await placeholderRect(app, coldCard);
    note(`cold card placeholder ${JSON.stringify(rect)}; body frame ${JSON.stringify(cold.body.frame)}`);
  });
}
