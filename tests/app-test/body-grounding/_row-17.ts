/**
 * _row-17.ts — what the pieces of row 17 share: a gesture that changes a
 * body card's size carries the body to its new size on the host, with the
 * bottom edge clean and the transcript pinned.
 *
 * The bar's seventeenth row. A settle whose beats change a body's box posts
 * the host a beat plan whose entry carries the landing size, and the host
 * tells the body (`onBodyCrossing`, called into its page) in the task it
 * runs the plan in. The
 * body pins its scrollers across a resize episode and acknowledges on the
 * host channel (`crossingReady`); only then does the host give its page the
 * final size, top-left pinned in a flipped container, while the container's
 * own track is still at First or in its prepare beat. The container wears
 * the page's surface for the crossing, so where a shrinking box is still
 * larger than the page the strip below and beside it is the body's surface.
 * At the land, or a cancel, the host says `land`, the body ends its episode, and the
 * page follows its container again.
 *
 * Every gesture that changes the box is driven: bullseye in and out and
 * the sidebars hidden and shown in a four-up flow, resize-sidebars-to-fit,
 * a column split, and a new card opened beside the body card by ⌘N's own
 * action, `show-card` (its neighbours ride the arrival's fused room beat,
 * which carries size terms). Bullseye and the split must change the body's
 * box and the new card must move it; the sidebars and fit carry it as a
 * slide or not at all in this deck, and are read as whichever they are.
 * Wherever the body moved: the placer planned
 * the body card and the host said it landed; on every composited frame
 * where the chrome moves the lid stays lifted, the content box — its
 * bottom strip included — shows no more floor than two frames of travel
 * would uncover, and no frame shows the bare window; the host's presented
 * container stands within two frames of travel of the placeholder; the
 * body's transcript is scrolled to its bottom before and after. Wherever the
 * box changed size, the host also
 * had `crossingReady` within a display period of the first beat that moves
 * the box (one hop to the body's page and one back; until it comes the
 * container clips the page at its old size over the page's surface); and
 * at rest the page is the container's size.
 *
 * The container's corners are named in its own, flipped, geometry: at rest
 * the content box's top corners, which stand square under the masthead,
 * show none of the canvas; the bottom corner's reading, where the pane's
 * own rounding lets the canvas through, is noted beside it.
 *
 * Every other kind that is a body is crossed by the gestures that change its
 * box. A pinned rail changes size when another rail card joins its edge and
 * when that card goes, and when the sidebars are resized to fit; the
 * Overview's column, given posts enough to scroll, is pinned to its bottom
 * across each as a transcript is.
 *
 * One launch driving every leg ran three minutes, so each piece drives one
 * gesture (or a gesture and its inverse) on its own launch:
 * `row-17-crossing-<gesture>` for the Session card and
 * `row-17-crossing-kinds-<gesture>` for every other kind under test.
 */

import { expect } from "bun:test";
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, promptPhase, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { classifyFrame, describeFrames } from "./_frames";
import { kindDeck, standUpKind } from "./_kind-bodies";
import type { CardKind } from "./_kinds";
import {
  BURST_INTERVAL_MS,
  armSampler,
  bodyOf,
  edgeGap,
  expectAtRest,
  judgeCarried,
  planDiag,
  pollPresented,
  readSampler,
  readStanding,
  rectOf,
  samplerState,
  setUpGesture,
  type Rect,
  type Standing,
} from "./_motion";

const TEST_NAME = "body-grounding-row-17-crossing";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
/** Per test, and a piece's wedge cap before it has a recorded time: one launch streaming a turn. */
export const TEST_TIMEOUT_MS = 120_000;

/**
 * How a piece launches, stated in the piece itself: every row-17 launch
 * takes the screen, and `@foreground` is read off the file that says so.
 */
export interface Launch {
  foreground: boolean;
}

/** The composite burst: the settle runs about 400 ms, so this covers its set-up, motion and land with room. */
const BURST_MS = 1_500;
const SETTLE_MS = 6_000;
/** How far from its bottom a scroller may stand and still read pinned, px. */
const PINNED_PX = 2;
/** A gesture changed the box when an edge of its size moved by more than this. */
const RESIZED_PX = 20;
/** How many messages the stub's turn streams: it runs for minutes, through every leg. */
const MESSAGES = 40;
/** How many of them arrive whole, so the transcript is taller than the box at once and streams on behind. */
const PREFILL = 4;

interface CrossingAccount {
  planId: number;
  width: number;
  height: number;
  readyLeadMs: number | null;
  restored?: boolean;
}

type CrossingSnapshot = BodyViewSnapshot & {
  crossing?: CrossingAccount | null;
  pageSize?: { width: number; height: number };
};

/** In a body page: its tallest scroller's distance from its bottom, or null when nothing scrolls. */
const scrollReading = `(function () {
  var best = null;
  document.querySelectorAll("*").forEach(function (e) {
    var cs = getComputedStyle(e);
    if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && e.scrollHeight > e.clientHeight + 1) {
      if (best === null || e.clientHeight > best.clientHeight) best = e;
    }
  });
  return best === null ? null : { top: best.scrollTop, max: best.scrollHeight - best.clientHeight };
})()`;

/**
 * The transcript's scroll, read until it stands at its bottom or a second
 * passes: the stub is streaming, and a line that lands between the
 * scroller's follow and the read is followed on the next frame.
 */
async function scrollOf(app: App, cardId: string): Promise<{ top: number; max: number } | null> {
  return pollFor(
    () => app.body(cardId).evalJS<{ top: number; max: number } | null>(scrollReading),
    (r) => r !== null && r.max - r.top <= PINNED_PX,
    1_000,
  );
}

/** Six session cards in a four-up flow — the body card second — and a Layout card on the left rail. */
function flowDeck(card: string): Record<string, unknown> {
  const ids = Array.from({ length: 6 }, (_, i) => (i === 1 ? card : `r17-n${i}`));
  return {
    cards: [
      ...ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
      { id: "r17-layout", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, slot) => sessionPane(id, slot)),
      {
        id: "r17-layout-pane",
        position: { x: 0, y: 0 },
        size: { width: 360, height: 900 },
        cardIds: ["r17-layout"],
        activeCardId: "r17-layout",
        title: "Layout",
        acceptsFamilies: [] as string[],
      },
    ],
    activePaneId: `${card}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: { layout: { side: "left" } } },
    hasFocus: true,
  };
}

/**
 * Four session cards in a four-up flow, the body card and a second card
 * sharing slot 0's column, the body card in front: splitting the column
 * shares its height, and a new card opening into the split column is seated
 * at its bottom, the sitters giving up height to it.
 */
function stackDeck(card: string): Record<string, unknown> {
  const ids = [card, "r17-s1", "r17-s2", "r17-s3"];
  const slots = [0, 0, 1, 2];
  return {
    cards: ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: ids.map((id, i) => sessionPane(id, slots[i])),
    activePaneId: `${card}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/**
 * The body card stood up: a stub turn streaming, its transcript already
 * taller than the box, the card focused. The legs run while it streams, so
 * the transcript is following its bottom through every crossing.
 */
async function standUpBody(app: App, card: string, stubDir: string): Promise<void> {
  await spawnStub(app, card, stubDir, MESSAGES, 1, undefined, PREFILL);
  await waitForBody(app, card);
  await focusBody(app, card);
  const body = app.body(card);
  await body.driveSession({ op: "send", text: "stream the transcript" });
  await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 30_000 });
  await body.waitForCondition<boolean>(`${scrollReading} !== null`, { timeoutMs: 60_000 });
  await focusBody(app, card, { composer: false });
  await Bun.sleep(400);
}

/**
 * The palette and a crop of the whole window's height, so the content box's
 * bottom strip is in every frame. With `rail`, the crop starts at that
 * pane's right edge: a body carried under a rail is covered by the rail's
 * own chrome, which is in front of it by design, and only what the rail
 * leaves uncovered is the body's to fill.
 */
async function standing(app: App, card: string, rail?: string): Promise<{ standing: Standing; crop: Rect }> {
  const start = await expectAtRest(app, card, `${card}: at the start`);
  const s = await readStanding(app, card, start);
  const height = await app.evalJS<number>("window.innerHeight");
  const railRect = rail === undefined ? null : await rectOf(app, `.tug-pane[data-pane-id="${rail}"]`);
  const x = railRect === null ? 0 : Math.ceil(railRect.x + railRect.width);
  const crop = { x, y: 0, width: s.contentWidth - x, height: Math.floor(height) };
  note(`${card}: crop ${JSON.stringify(crop)} at scale ${s.scale}`);
  return { standing: s, crop };
}

/**
 * The content box's top-left corner, read off the composite at rest: square
 * under the masthead, so none of it is canvas. A container rounding its top
 * corners shows the canvas there. (The pane's border line crosses the
 * patch and reads as grid, so the canvas alone is the reading.)
 */
export async function expectSquareTop(app: App, card: string, palette: Standing["palette"]): Promise<void> {
  const box = await expectAtRest(app, card, `${card}: corner`);
  const read = async (y: number) => {
    await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop: { x: Math.ceil(box.x), y, width: 4, height: 4 } });
    const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
    return classifyFrame(reading.frames[reading.frames.length - 1], palette);
  };
  const top = await read(Math.ceil(box.y));
  const bottom = await read(Math.floor(box.y + box.height) - 4);
  note(`${card}: the content box's top-left corner ${describeFrames([top])}; its bottom-left corner ${describeFrames([bottom])}`);
  expect(top.canvas + top.bare, `${card}: the content box's top corner is square, never the canvas`).toBeLessThan(0.05);
}

export interface Leg {
  label: string;
  /** The gesture. */
  run: (app: App) => Promise<unknown>;
  /** Whether the gesture must change the body's box for the leg to have tested anything. */
  resizes: boolean;
  /** Whether the gesture must move the body card at all: carried as a slide when its box keeps its size. */
  moves?: boolean;
}

/**
 * One gesture: read the transcript's scroll, arm the shell's sampler and
 * the composite burst, run `js`, read the host's presented frame until the
 * settle is over, then judge the crossing.
 */
export async function crossLeg(app: App, card: string, leg: Leg, s: Standing, crop: Rect): Promise<void> {
  const { label } = leg;
  const before = await expectAtRest(app, card, `${label}: before`);
  const scrollBefore = await scrollOf(app, card);
  note(`${label}: transcript scroll before ${JSON.stringify(scrollBefore)}`);
  expect(scrollBefore, `${label}: the transcript scrolls`).not.toBeNull();
  expect(scrollBefore!.max - scrollBefore!.top, `${label}: the transcript stands at its bottom before`).toBeLessThanOrEqual(PINNED_PX);
  const runsBefore = (await planDiag(app)).runs;
  await armSampler(app, card);
  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const gestureWall = Date.now();
  await leg.run(app);
  let polling = true;
  const presentedRead = pollPresented(app, card, () => !polling, SETTLE_MS + 2_000);
  const settle = await pollFor(() => samplerState(app), (v) => v.saw && !v.now, SETTLE_MS);
  polling = false;
  const presented = await presentedRead;
  note(`${label}: settle seen ${settle.saw}, running ${settle.now}`);

  const plan = await pollFor(
    () => planDiag(app),
    (p) => p.runs > runsBefore && (p.last?.landed.some((l) => l.cardId === card) ?? false),
    3_000,
  );
  note(`${label}: ${plan.runs - runsBefore} plan run(s); last plan ${JSON.stringify(plan.last)}`);

  // ⌘N focuses the card it opens: the body card is focused again so the
  // landed frame reads as its own paint.
  await focusBody(app, card, { composer: false });
  await Bun.sleep(300);
  const after = await expectAtRest(app, card, `${label}: after`);
  const resized = Math.max(Math.abs(after.width - before.width), Math.abs(after.height - before.height));
  note(`${label}: the box went ${before.width.toFixed(1)}×${before.height.toFixed(1)} → ${after.width.toFixed(1)}×${after.height.toFixed(1)}`);
  if (leg.resizes) expect(resized, `${label}: the gesture changed the body's box`).toBeGreaterThan(RESIZED_PX);
  const travelled = edgeGap(before, after);
  if (leg.moves === true) expect(travelled, `${label}: the gesture moved the body card`).toBeGreaterThan(RESIZED_PX);
  if (travelled <= 0.5) {
    note(`${label}: the box stood still; nothing to carry`);
    return;
  }

  expect(plan.last?.planned.includes(card), `${label}: the host carried the body`).toBe(true);
  expect(plan.last?.landed.some((l) => l.cardId === card), `${label}: the host said the body landed`).toBe(true);
  expect(plan.last?.cancelled ?? [], `${label}: no carried body was cancelled`).toEqual([]);

  const body = (await bodyOf(app, card)) as CrossingSnapshot | null;
  const crossing = body?.crossing ?? null;
  note(`${label}: host crossing ${JSON.stringify(crossing)}; page ${JSON.stringify(body?.pageSize)}; frame ${JSON.stringify(body?.frame)}`);
  if (resized > 0.5) {
    expect(crossing?.planId, `${label}: the host crossed the body on the last plan`).toBe(plan.last?.planId ?? -1);
    expect(crossing?.readyLeadMs, `${label}: the body said crossingReady`).not.toBeNull();
    // One hop to the body's page and one back: the page takes its size within a display period of
    // the first moving beat, the container's surface standing in for it until then.
    const periodMs = (body as { displayPeriodMs?: number }).displayPeriodMs ?? 16.7;
    expect(crossing!.readyLeadMs!, `${label}: crossingReady came within a display period of the first moving beat`).toBeGreaterThan(-periodMs);
    expect(crossing?.restored, `${label}: the page follows its container again`).toBe(true);
  }
  expect(edgeGap({ x: 0, y: 0, ...body!.pageSize! }, { x: 0, y: 0, width: body!.frame.width, height: body!.frame.height }), `${label}: at rest the page is the container's size`).toBeLessThanOrEqual(0.5);

  const scrollAfter = await scrollOf(app, card);
  note(`${label}: transcript scroll after ${JSON.stringify(scrollAfter)}`);
  expect(scrollAfter, `${label}: the transcript still scrolls`).not.toBeNull();
  expect(scrollAfter!.max - scrollAfter!.top, `${label}: the transcript stands at its bottom after`).toBeLessThanOrEqual(PINNED_PX);

  const samples = await readSampler(app);
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
  expect(reading.done, `${label}: the burst finished`).toBe(true);
  const v = judgeCarried(label, reading, samples, presented, gestureWall, before, after, s.palette, crop);
  if (v.floorOffenders.length > 0) {
    const worst = v.floorOffenders[Math.floor(v.floorOffenders.length / 2)];
    const kept = join(tmpdir(), `tug-row17-${label.replace(/\s+/g, "-")}-${Math.round(worst.frame.t)}ms.png`);
    copyFileSync(worst.path, kept);
    note(`${label}: a frame the floor bar caught kept at ${kept}`);
  }
  expect(v.motion, `${label}: frames were captured while the chrome moved`).toBeGreaterThan(3);
  expect(v.lidOnWhileMoving, `${label}: the lid stays lifted in every sample where the frame moved`).toBe(0);
  expect(v.bare, `${label}: no frame shows the bare window`).toBe(0);
  expect(v.floorOffenders.length, `${label}: on every frame where the chrome moves the body fills its content box, its bottom strip included`).toBe(0);
  expect(v.tracked, `${label}: the host was read while the chrome moved`).toBeGreaterThan(0);
  expect(v.worstTrackPx, `${label}: the host's container stands within two frames of travel of the placeholder`).toBeLessThanOrEqual(v.trackBarPx);
}

/** A deck action, dispatched in the shell. */
export const control = (id: string, payload: Record<string, unknown> = {}) => (app: App): Promise<null> =>
  app.evalJS<null>(`(window.__tug.dispatchControlAction(${JSON.stringify(id)}, ${JSON.stringify(payload)}), null)`);

export { setUpGesture };

/** A launch's body card, its palette and the crop every leg's burst reads. */
export interface Stood {
  app: App;
  card: string;
  s: Standing;
  crop: Rect;
}

/**
 * Launch with a body of `kind` stood up — the Overview given posts enough
 * to scroll — and run `legs`; then its body asked the shell for nothing.
 */
export async function withKind(launch: Launch, kind: CardKind, name: string, legs: (at: Stood) => Promise<void>): Promise<void> {
  const card = `r17-${kind.componentId}`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}-${kind.componentId}`, ...launch });
  try {
    if (kind.componentId === "overview") {
      const now = Date.now();
      app.seedLedger({
        overview_posts: Array.from({ length: MESSAGES }, (_, i) => ({
          at_ms: now - (MESSAGES - i) * 60_000,
          author: "observer" as const,
          body: `Post ${i + 1}: a line of work narrated, long enough to wrap once in a rail and so give the column something to scroll.`,
          refs: [],
        })),
      });
    }
    await app.seedDeckState({ state: kindDeck(kind, card, { sessions: ["r17-n0", "r17-n1"] }), focusCardId: card });
    await standUpKind(app, kind, card);
    await focusBody(app, card, { composer: false });
    await Bun.sleep(600);
    const { standing: s, crop } = await standing(app, card);
    await legs({ app, card, s, crop });
  } finally {
    await app.close();
  }
}

/**
 * The gesture that changes a kind's box, or with `inverse` the gesture that
 * takes it back (the first made as its set-up): a rail's when another rail
 * card joins its edge and when that card goes, a content kind's bullseye in
 * and out.
 */
export async function kindResizeLeg(kind: CardKind, inverse: boolean, { app, card, s, crop }: Stood): Promise<void> {
  const other = kind.componentId === "jots" ? "dashes" : "jots";
  if (kind.rail) {
    await control("set-sidebar-side", { componentId: other, side: "right" })(app);
    const join = control("set-sidebar-open", { componentId: other, open: true });
    if (!inverse) return crossLeg(app, card, { label: `${other} joins its edge`, run: join, resizes: true }, s, crop);
    await setUpGesture(app, card, `${other} joins its edge`, join);
    await crossLeg(app, card, { label: `${other} leaves it`, run: control("set-sidebar-open", { componentId: other, open: false }), resizes: true }, s, crop);
  } else {
    if (!inverse) return crossLeg(app, card, { label: "bullseye in", run: control("toggle-bullseye"), resizes: true }, s, crop);
    await setUpGesture(app, card, "bullseye in", control("toggle-bullseye"));
    await crossLeg(app, card, { label: "bullseye out", run: control("toggle-bullseye"), resizes: true }, s, crop);
  }
}

/**
 * Launch with the Session body card second in a four-up flow of six,
 * streaming, and a Layout card on the left rail, and run `legs`.
 */
export async function withFlow(launch: Launch, name: string, legs: (at: Stood) => Promise<void>): Promise<void> {
  const stubDir = stubDirectory();
  const card = "r17-a";
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}`, ...launch, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  try {
    await app.seedDeckState({ state: flowDeck(card), focusCardId: card });
    await standUpBody(app, card, stubDir);
    const { standing: s, crop } = await standing(app, card, "r17-layout-pane");
    await legs({ app, card, s, crop });
  } finally {
    await app.close();
  }
}

/** Launch with the Session body card in front of a column it shares, streaming, and run `legs`. */
export async function withStack(launch: Launch, name: string, legs: (at: Stood) => Promise<void>): Promise<void> {
  const stubDir = stubDirectory();
  const card = "r17-c";
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}`, ...launch, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  try {
    await app.seedDeckState({ state: stackDeck(card), focusCardId: card });
    await standUpBody(app, card, stubDir);
    const { standing: s, crop } = await standing(app, card);
    await legs({ app, card, s, crop });
  } finally {
    await app.close();
  }
}
