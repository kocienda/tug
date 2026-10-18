/**
 * _row-01.ts — what the pieces of row 1 share: a new card arrives with
 * nothing of the canvas, the grid or the window showing through, at any
 * frame, warm and cold.
 *
 * The bar's first row ([B02] row 1). A card is opened the user's way and
 * handed to a body the moment the deck holds it — a Session card too: with no
 * session yet it goes with a `restore` and shows its picker in the body, and
 * a later spawn re-binds that body in place. From the hand-off every
 * composited frame of the card's rect is read: the placeholder's lid paints
 * the pane's own surface until the host has the body on screen, the host
 * shows the container in one step under the lid (no fade through the hole),
 * and the lid lifts in a fade from the surface to the content. So no frame
 * after the hand-off carries more of the canvas colour, the grid colour or
 * the window's background than the finished body itself does, and at least
 * one frame is the blank lid.
 *
 * The placeholder stands in the commit that adds the card, while the deck's
 * own arrival is still moving it, so the burst is armed over the whole window
 * and every frame is read at the rect the placeholder stood at on that frame:
 * a new pane re-divides the deck, and a rail slides in as it arrives.
 *
 * ⌘N through the activated session tap opens a Session card, and the first
 * takes the warm spare. For the cold reading a second card takes the spare
 * unobserved and a third is opened behind it, inside the second the spare
 * takes to be replaced, so it is made cold. Every other kind that is a body
 * opens the way it opens — a rail shown on its edge, a content card added as
 * a tab. All are read the same way.
 *
 * Frames are judged by surface colour, never ink share ([B05]).
 *
 * A card that arrives in a pane of its own is CARRIED in: its body, painted
 * under the hidden pane, is shown by the host with the frame's arrive beat
 * and fades in with its chrome ([B24] of the bodies migration brief reverses
 * the one-step show for it). Such an arrival is judged by the same bar — no
 * frame shows more canvas or bare window than the finished body — and by the
 * plan having landed it; the one-step show under the lid is the rule for a
 * body shown by a placement.
 *
 * One launch per arrival: `row-01-arrival-warm` and `row-01-arrival-cold`
 * for the Session card, `row-01-arrival-kinds` for every other kind.
 */

import { expect } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading, HostFrameReading } from "../_harness/client";
import { classifyFrame, describeFrames, FLOOR_BY_CLASS, floorMeasure, pollFor, readPalette, type FloorMeasure, type FrameClasses } from "./_frames";
import { armPlaceholderSampler, landedFrom, openKind, placeholderAt, readPlaceholderSampler } from "./_kind-bodies";
import { planDiag } from "./_motion";
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
/**
 * The burst over an arrival, read over the whole window. A body is ready
 * some 70 ms after the hand-off warm and 260 ms cold, and the lid lifts just
 * after, so two seconds still watch it stand well past both, and a file keeps
 * inside its 20 s budget, which a four-second full-window burst ran past.
 */
const BURST_MS = 2_000;
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

/** ⌘N through the tap; resolves the new card's id as soon as the deck focuses it. */
async function pressNew(app: App, before: string | null): Promise<string> {
  await app.nativeKey("n", ["cmd"]);
  const id = await pollFor(() => app.getFocusedCardId(), (c) => c !== null && c !== before, PLACED_MS);
  expect(id, "⌘N opened a new card and the deck focused it").not.toBe(before);
  return id!;
}

/** ⌘N, and the deck's arrival of the new card landed. */
async function newCardByChord(app: App, before: string | null): Promise<string> {
  const id = await pressNew(app, before);
  await deckStill(app);
  return id;
}

/**
 * Wait for the deck's own motion to land: no pane arriving, no settle
 * running, and a beat more for the arrive beat's last frame.
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
  /**
   * Whether the frames were read from the hand-off, where the lid must stand
   * before the body shows; false when they were read from the pane's landing,
   * by which time the body may long since have shown under the hidden pane.
   */
  fromHandOff: boolean;
  /** The host carried the body in on its frame's arrive beat: the plan named it, and landed it. */
  carried: boolean;
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
  if (r.carried) {
    note(`${label}: carried in on the frame's arrive beat`);
  } else if (r.host !== null) {
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
  if (r.fromHandOff) expect(lidFrames, `${label}: the lid stood over the rect before the body showed`).toBeGreaterThan(0);
  expect(r.final.surface, `${label}: the finished rect is the body's own surface`).toBeGreaterThan(0.3);
  expect(measure.ink(r.final), `${label}: the finished rect carries the body's content`).toBeGreaterThan(0.01);
}

/**
 * A card opened the user's way by `open`, which answers its id: the burst
 * covers the window, and each frame is classed inside the rect its
 * placeholder stood at then.
 *
 * `from` says where the judgement starts. At the `hand-off` for a card that
 * opens into a pane already on screen. At the `landing` for one that brings a
 * pane of its own: the deck holds that pane hidden (`data-arriving`) and then
 * plays its arrive beat, and over both the canvas is what stands at that rect
 * because no card does yet — the deck's arrival of the card, not the body's.
 * The body hands off under the hidden pane, so from the landing every frame
 * is the body's own surface or the lid over it.
 */
async function arriveOpened(
  app: App,
  label: string,
  componentId: string,
  open: () => Promise<string>,
  from: "hand-off" | "landing" = "hand-off",
): Promise<ArrivalReading> {
  const inner = await app.evalJS<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
  const crop = { x: 0, y: 0, width: Math.floor(inner.w), height: Math.floor(inner.h) };
  await armPlaceholderSampler(app);
  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const openWall = Date.now();
  const cardId = await open();
  const landed = Date.now() + PLACED_MS;
  while ((await placeholderRect(app, cardId)) === null && Date.now() < landed) await Bun.sleep(5);
  const handOffWall = Date.now();
  await pollFor(() => bodyOf(app, cardId), (b) => b !== null, PLACED_MS);
  const armed = await app.hostFrames({ op: "arm", windowMs: BURST_MS, layer: cardId }).catch(() => null);
  const shown = await pollFor(
    () => bodyOf(app, cardId),
    (b) => b !== null && b.state === "ready" && b.painted && b.visible,
    BODY_READY_MS,
  );
  expect(shown?.visible, `${label}: the body is placed visible`).toBe(true);
  expect(shown?.componentId, `${label}: the body holds a ${componentId} card`).toBe(componentId);
  const lifted = await pollFor(() => lidLifted(app, cardId), (v) => v, PLACED_MS);
  // A body the placer planned on its own arrival was never shown before it:
  // the host carried it in, and the plan says whether it landed.
  const plan = (await planDiag(app)).last;
  const carried = plan?.planned.includes(cardId) === true;
  if (carried) {
    const landedPlan = await pollFor(() => planDiag(app), (p) => p.last?.landed.some((l) => l.cardId === cardId) ?? false, PLACED_MS);
    expect(landedPlan.last?.landed.some((l) => l.cardId === cardId), `${label}: the plan that carried the body in landed it`).toBe(true);
  }
  expect(lifted, `${label}: the shell lifted the lid once the host said shown`).toBe(true);
  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    BURST_MS + 5_000,
  );
  let host: HostFrameReading | null = null;
  if (armed !== null) {
    await Bun.sleep(Math.max(0, BURST_MS - (Date.now() - handOffWall)));
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
  note(`${label}: ${componentId} ${cardId}; palette ${JSON.stringify(palette)}, ${reading.frames.length} frames`);
  const frames = reading.frames.flatMap((f) => {
    const region = regionAt(f.wall);
    return region === null ? [] : [classifyFrame(f, palette, 8, region)];
  });
  if (from === "landing") {
    const landedWall = landedFrom(samples, cardId);
    expect(landedWall, `${label}: the card's pane landed inside the burst`).not.toBeNull();
    const judged = frames.filter((f) => f.wall >= landedWall!);
    expect(judged.length, `${label}: frames were captured after the pane landed`).toBeGreaterThan(0);
    note(`${label}: opened ${handOffWall - openWall} ms before the placeholder stood; its pane landed ${landedWall! - handOffWall} ms after it`);
    return { frames, afterHandOff: judged, final: frames[frames.length - 1], body: shown!, host, handOffWall, fromHandOff: false, carried };
  }
  const firstLid = frames.findIndex((f) => f.wall >= handOffWall - BURST_INTERVAL_MS && f.surface > 0.9);
  expect(firstLid, `${label}: a lid frame follows the hand-off`).toBeGreaterThanOrEqual(0);
  const skewMs = frames[firstLid].wall - handOffWall;
  note(`${label}: opened ${handOffWall - openWall} ms before the placeholder stood; the first lid frame came ${skewMs.toFixed(0)} ms after it`);
  const beforeLid = frames.filter((f, i) => i < firstLid && f.wall >= handOffWall - BURST_INTERVAL_MS);
  if (beforeLid.length > 0) note(`${label}: the frames between the placeholder and the lid\n${describeFrames(beforeLid)}`);
  expect(skewMs, `${label}: the lid is painted within a few frames of the hand-off commit`).toBeLessThanOrEqual(5 * BURST_INTERVAL_MS);
  return { frames, afterHandOff: frames.slice(firstLid), final: frames[frames.length - 1], body: shown!, host, handOffWall, fromHandOff: true, carried };
}

/** A card of `kind` opened the way it opens, read from the hand-off on. */
export async function arrivalOfKind(launch: Launch, kind: CardKind): Promise<void> {
  const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}`, ...launch });
  try {
    await app.seedDeckState({ state: oneCard, focusCardId: SEED });
    await pollFor(() => app.bodies(), (all) => all.some((b) => b.cardId === null && b.state === "connected"), BODY_READY_MS);
    const arrival = await arriveOpened(app, kind.componentId, kind.componentId, () => openKind(app, kind));
    judge(kind.componentId, arrival, floorMeasure(kind.rail));
  } finally {
    await app.close();
  }
}

/** Launch with the seed card and a spare waiting connected, and run `body`. */
async function withSpare(launch: Launch, name: string, body: (app: App) => Promise<void>): Promise<void> {
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}`, ...launch });
  try {
    await app.seedDeckState({ state: oneCard, focusCardId: SEED });
    // The spare is made a beat after the shell paints, and waits connected.
    const spares = await pollFor(
      () => app.bodies(),
      (all) => all.some((b) => b.cardId === null && b.state === "connected"),
      BODY_READY_MS,
    );
    expect(spares.some((b) => b.cardId === null && b.state === "connected"), "a spare body waits, connected").toBe(true);
    await body(app);
  } finally {
    await app.close();
  }
}

/** ⌘N: the first card takes the warm spare. */
export function arrivalWarm(launch: Launch): Promise<void> {
  return withSpare(launch, "warm", async (app) => {
    const warm = await arriveOpened(app, "warm", "session", () => pressNew(app, SEED), "landing");
    expect(warm.body.start, "the first card bound the spare").toBe("warm");
    // The card is unbound, so its picker is all there is to wait on: the body
    // says ready when the picker is quiet, not at its 250 ms arrival bound
    // (`ARRIVAL_REVEAL_BOUND_MS`), and the shell reveals the card on that.
    expect(
      warm.body.readyMs ?? Infinity,
      "warm: the body said ready on its picker's quiet, ahead of the arrival bound",
    ).toBeLessThan(250);
    judge("warm", warm);
  });
}

/** ⌘N twice: a card opened behind the one that took the spare, before it is replaced, is made cold. */
export function arrivalCold(launch: Launch): Promise<void> {
  return withSpare(launch, "cold", async (app) => {
    const takerCard = await newCardByChord(app, SEED);
    const cold = await arriveOpened(app, "cold", "session", () => pressNew(app, takerCard), "landing");
    expect(cold.body.start, "the card opened behind the spare's taker was made cold").toBe("cold");
    judge("cold", cold);
  });
}
