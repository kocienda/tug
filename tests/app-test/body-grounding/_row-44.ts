/**
 * _row-44.ts — row 44's helpers: a workspace switch onto cards whose pages
 * have not painted, read frame by frame — and the judge any gesture that
 * shows such cards is read by (`readGesture`), row 38's eviction rows among
 * them.
 *
 * Each piece launches on two workspaces from a seeded layout, arms a burst of
 * window captures over the whole window, switches, and waits for the cards'
 * pages to paint. Every frame from the gesture on is judged per pane against
 * the settled frame — all but one still showing the standing workspace while
 * the commit reaches the compositor (~80 ms and a frame): its box shows no
 * more of the canvas colour than the
 * settled pane does, and its title band holds at least three quarters of the
 * settled title's ink — or, for a card that has never had a page or that
 * stands under the host's skeleton, whose title is drawn by the host and not
 * its page, three quarters of the settled band's chrome. A box showing canvas-coloured paint
 * with no grid in it, while the host has nothing of its card's on screen, is
 * an open hole and fails too. The first switched frame shows each arriving
 * card's picture in its workspace's stage — its page, its last frame, or the
 * skeleton the host draws — so neither the departing card nor the canvas
 * shows over an arriving pane. The host's `stages` account names each
 * arriving card's picture at the cut, and once every page has painted each
 * card's picture must be its page: no skeleton or last frame left standing.
 *
 * A parked workspace is a finished picture, so two more bars hold what a
 * card in the right place may not do after the cut. Asked for, a pane's
 * content keeps the dominant colour the first switched frame gave it, so no
 * card re-tints or brightens after the cut (`holdsColour`); and a revealed
 * body that had painted never shows its content box surface-blank
 * (`revealsPainted`, {@link blankAgainst}). Beside them the judge notes, per
 * card, what the first frame after the host showed its page showed.
 *
 * Not a test: no `describe` here.
 */

import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { note, type App } from "../_harness";
import type { BodyLayerRow, BodyLayersReading, CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { bodyOf, pollFor, settleFor } from "./_bodies";
import { asRgbJs, classifyFrame, FLOOR_COLUMNS, framesDiffer, gridColumnsIn, near, parseRgb, showsBareHole, type FrameRegion, type Palette, type Rgb } from "./_frames";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;
export const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

const BURST_MS = 1_200;
const BURST_INTERVAL_MS = 16;
/** How long the burst reads the standing workspace before the switch. */
const STANDING_MS = 120;
/** The title line, from a pane's top edge, in points: inside the one-line bar every masthead begins with. */
const TITLE_TOP = 6;
const TITLE_HEIGHT = 20;
/** How far from the band's own surface a pixel must lie to be the title's ink; the canvas's grid lies far nearer the canvas colour. */
const INK_REACH = 60;
/** How much more of a pane box may be the canvas colour than in the settled frame: row 1's bar. */
const BOX_CANVAS_SLACK = 0.005;
/** On every frame from the gesture, a title band holds at least this share of the settled band's ink (or chrome). */
const HELD_TITLE_SHARE = 0.75;
/**
 * How long after the gesture a frame still identical to the standing one is
 * the commit's own way to the compositor, and not judged: the ~80 ms a
 * switch's commit has been read to take (the hand-over's snapshot answers in
 * the same time) and one display frame. Past it, a frame the gesture never
 * reached is a stall, judged like the rest.
 */
const STANDING_GRACE_MS = 100;
const TOLERANCE = 8;
/**
 * How long the host's picture over a page that has painted before stands at
 * most before the page is shown as it stands: the host's horizon, which the
 * layer window reads past.
 */
export const PICTURE_HORIZON_MS = 2_000;
/** A content box is surface-blank when it holds less than this share of its settled ink… */
export const BLANK_SHARE = 0.2;
/** …and its settled content carries at least this much ink, so a card that settles blank is never judged blank. */
export const BLANK_FLOOR = 0.005;

/** Whether a content box holding `ink` against its settled `settled` is surface-blank. */
export const blankAgainst = (ink: number, settled: number): boolean => settled >= BLANK_FLOOR && ink < BLANK_SHARE * settled;

/** A pane's content box: below its title band, inset from its edges. */
export const contentOf = (r: Rect): Rect => {
  const top = TITLE_TOP + TITLE_HEIGHT + 8;
  return { x: r.x + 8, y: r.y + top, width: r.width - 16, height: r.height - top - 8 };
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A text card's deck of one pane per card, imposed side by side. */
export function textDeck(cardIds: readonly string[]): Record<string, unknown> {
  return {
    cards: cardIds.map((id) => ({ id, componentId: "text", title: id, closable: true })),
    panes: cardIds.map((id, slot) => ({
      id: `${id}-pane`,
      position: { x: 60, y: 60 },
      size: { width: 700, height: 500 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["standard"],
      slot,
    })),
    activePaneId: `${cardIds[0]}-pane`,
    imposition: { kind: cardIds.length > 1 ? "two-up" : "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The shell's pane frame for `cardId`, in viewport points, or null while it has no box. */
export const paneRect = (app: App, cardId: string): Promise<Rect | null> =>
  // card-dom: shell — the pane stand-in is the shell's: the one holding the
  // card's placeholder, which a tab shares with its pane's other cards.
  app.evalJS<Rect | null>(
    `(function () {
      var ph = document.querySelector('[data-body-placeholder][data-card-id="${cardId}"]');
      var el = ph !== null ? ph.closest(".tug-pane") : document.querySelector('.tug-pane[data-pane-id="${cardId}-pane"]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    })()`,
  );

export async function activate(app: App, spaceId: string): Promise<void> {
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`);
  await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === spaceId, 5_000);
}

function clamp(region: FrameRegion, width: number, height: number): [number, number, number, number] {
  return [
    Math.max(0, Math.floor(region.x)),
    Math.max(0, Math.floor(region.y)),
    Math.min(width, Math.ceil(region.x + region.width)),
    Math.min(height, Math.ceil(region.y + region.height)),
  ];
}

type Png = ReturnType<typeof decodePngFile>;

/** The share of `region`'s pixels lying farther than {@link INK_REACH} from the region's commonest colour: ink on its surface. */
export function inkShare(png: Png, region: FrameRegion): number {
  const [x0, y0, x1, y1] = clamp(region, png.width, png.height);
  const counts = new Map<number, number>();
  const pixels: Rgb[] = [];
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      pixels.push(p);
      const key = (p.r << 16) | (p.g << 8) | p.b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let fillKey = 0;
  let most = -1;
  for (const [key, count] of counts) if (count > most) [fillKey, most] = [key, count];
  const fill = { r: (fillKey >> 16) & 255, g: (fillKey >> 8) & 255, b: fillKey & 255 };
  const ink = pixels.filter((p) => !near(p, fill, INK_REACH)).length;
  return ink / Math.max(1, pixels.length);
}

/** The share of `region`'s pixels within {@link TOLERANCE} of the canvas colour, sampled every fourth pixel. */
export function canvasShare(png: Png, region: FrameRegion, canvas: Rgb): number {
  const [x0, y0, x1, y1] = clamp(region, png.width, png.height);
  let hits = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      const i = (y * png.width + x) * 4;
      n += 1;
      if (near({ r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] }, canvas, TOLERANCE)) hits += 1;
    }
  }
  return hits / Math.max(1, n);
}

/**
 * Switch to `spaceId` under a burst and judge it ({@link readGesture}).
 */
export async function readSwitch(
  app: App,
  spaceId: string,
  cardIds: readonly string[],
  label: string,
  band: "title" | "chrome" = "title",
  options: GestureOptions = {},
): Promise<string[]> {
  return readGesture(
    app,
    () => app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`),
    cardIds,
    label,
    band,
    options,
  );
}

export interface GestureOptions {
  /**
   * How long the burst reads, from its arming — long enough for every page
   * to paint inside it — and how far apart its frames are: a gesture showing
   * many cards judges each frame once per card, so it reads fewer frames.
   */
  burstMs?: number;
  intervalMs?: number;
  /** Every pane's content keeps the dominant colour the first switched frame gave it. */
  holdsColour?: boolean;
  /** Every arriving card's body had painted before the gesture, so no frame showing its view may show its content box surface-blank. */
  revealsPainted?: boolean;
}

/**
 * Run `gesture` under a burst, wait for every card in `cardIds` to have its
 * page painted and shown, read each card's pane box — the arrangement's,
 * which a pane has only while it is shown — and judge every frame from the
 * gesture on. Answers the frames that failed, after noting the reading —
 * and on a red, keeping the first red frame and the settled one under the
 * temp directory to look at.
 */
export async function readGesture(
  app: App,
  gesture: () => Promise<unknown>,
  /**
   * The cards the gesture shows — or, for a gesture that makes its cards
   * (New Workspace), a read of them taken once the gesture has run.
   */
  arriving: readonly string[] | (() => Promise<readonly string[]>),
  label: string,
  /**
   * What each pane's title band must show: the card's `title`, which the
   * shell holds for a card whose page has spoken — or only its `chrome`,
   * for a card that has never had a page, whose title its page computes.
   */
  band: "title" | "chrome" = "title",
  { burstMs = BURST_MS, intervalMs = BURST_INTERVAL_MS, holdsColour = false, revealsPainted = false }: GestureOptions = {},
): Promise<string[]> {
  const width = await app.evalJS<number>("window.innerWidth");
  const height = await app.evalJS<number>("window.innerHeight");
  await app.captureBurst({ op: "arm", durationMs: burstMs, intervalMs, crop: { x: 0, y: 0, width, height } });
  // The host's layers, tick by tick, over the same window and on to just past
  // the pictures' horizon: what it put on screen for each card, so a page
  // that lands late is read landing rather than never seen.
  const layersMs = Math.max(burstMs, PICTURE_HORIZON_MS + 200);
  await app.bodyLayers({ op: "arm", windowMs: layersMs });
  await Bun.sleep(STANDING_MS);
  const choseWall = Date.now();
  await gesture();
  // Whether the placer measured the gesture's commit or deferred it to a set-up.
  const skipAtSwitch = await app.evalJS<string | null>("window.tugdeck.diag.getBodyPlacement()?.lastSkip ?? null");
  const cardIds = typeof arriving === "function" ? await arriving() : arriving;
  if (cardIds.length === 0) return ["the gesture showed no card"];
  for (const id of cardIds) {
    const b = await settleFor(() => bodyOf(app, id), (s) => s?.state === "ready" && s.painted === true && s.visible && !s.covered, 10_000);
    note(`${label} ${id}: painted and shown ${Date.now() - choseWall} ms after the switch, start ${b?.start ?? "?"}`);
    if (b?.painted !== true || b.visible !== true) return [`${id}: its page never painted and showed`];
  }
  const rects: Record<string, Rect> = {};
  for (const id of cardIds) {
    const rect = await settleFor(() => paneRect(app, id), (r) => r !== null, 5_000);
    if (rect === null) return [`${id}: its pane has no box`];
    rects[id] = rect;
  }
  const reading = await settleFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    burstMs + 5_000,
  );
  if (!reading.done) return ["the burst did not finish"];
  const layers = (await settleFor(
    () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
    (r) => r.done,
    layersMs + 5_000,
  )) as BodyLayersReading;
  if (!layers.done) return ["the host's layer rows did not finish"];
  // Each arriving card's picture at the cut, and once every page has
  // painted: its page, with nothing of the host's standing over it.
  const stages = await app.stages();
  const cut = stages.cuts.filter((c) => c.gestureWall >= choseWall - 50).at(-1) ?? null;
  const pictureBad: string[] = [];
  const now = Object.fromEntries(stages.stages.flatMap((s) => s.cards).map((c) => [c.cardId, c.picture]));
  for (const id of cardIds) {
    if (now[id] !== undefined && now[id] !== "live") pictureBad.push(`${id}: its ${now[id]} still stands once its page painted and showed`);
  }
  note(
    `${label}: ${cut === null ? "no stage cut was recorded" : `stage cut ${cut.from} → ${cut.to}, ${Math.round(cut.committedWall - cut.gestureWall)} ms in its transaction, pictures ${cardIds.map((id) => `${id} ${cut.pictures[id] ?? "not in the arriving stage"}`).join(", ")}`}; ` +
      `placer skip at the switch ${skipAtSwitch ?? "none"}`,
  );
  const last = reading.frames[reading.frames.length - 1];
  // Every frame from the gesture, but the few still identical to the
  // standing frame while the commit reaches the compositor.
  const before = reading.frames.filter((f) => f.wall < choseWall);
  const standing = before.length > 0 ? before[before.length - 1] : null;
  const switched = reading.frames.filter(
    (f) => f.wall >= choseWall && !(standing !== null && f.wall - choseWall <= STANDING_GRACE_MS && !framesDiffer(f, standing)),
  );
  if (switched.length === 0) return ["no frame was captured after the gesture"];
  const scope = heldTitleScope(layers.rows, cardIds, choseWall);
  note(
    `${label}: host layers ${layers.rows.length} rows; ` +
      cardIds.map((id) => {
        const first = scope.firstOn[id];
        return first === undefined
          ? `${id} never on screen in the window`
          : `${id} first on screen at ${Math.round(first.wall - choseWall)} ms (${first.start}, ${first.state}, painted ${first.painted}, covered ${first.covered}, shown ${first.shown}, opacity ${first.opacity.toFixed(2)})`;
      }).join("; ") +
      `; departing views last on screen at ${scope.lastLeaving === null ? "none" : `${Math.round(scope.lastLeaving - choseWall)} ms`}`,
  );
  // Each card's picture over its page, as the layer rows saw it: up from, and down after.
  const pictured = cardIds.map((id) => {
    const rows = layers.rows.filter((r) => r.cardId === id && r.wall >= choseWall && r.picture !== undefined && r.picture !== "live" && r.picture !== "none");
    return rows.length === 0
      ? `${id} no picture over its page`
      : `${id} ${rows[0].picture} ${Math.round(rows[0].wall - choseWall)}–${Math.round(rows[rows.length - 1].wall - choseWall)} ms`;
  });
  note(`${label}: host pictures ${pictured.join("; ")}`);
  const canvas = parseRgb(await app.evalJS<string>(asRgbJs(`getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')`)));
  const scale = reading.scale;
  const px = (r: Rect): FrameRegion => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale });

  const worst: Record<string, { ink: number; floor: number }> = {};
  const bad: string[] = [...pictureBad];
  let firstBad: { path: string; ms: number } | null = null;
  const titleOf = (r: Rect): FrameRegion => px({ x: r.x + 8, y: r.y + TITLE_TOP, width: r.width - 16, height: TITLE_HEIGHT });
  const boxOf = (r: Rect): FrameRegion => px({ x: r.x + 4, y: r.y + 4, width: r.width - 8, height: r.height - 8 });
  const settled = decodePngFile(last.path);
  const settledInk: Record<string, number> = {};
  const settledChrome: Record<string, number> = {};
  const settledCanvas: Record<string, number> = {};
  const settledContentInk: Record<string, number> = {};
  const contentPx = (r: Rect): FrameRegion => px(contentOf(r));
  // Each card's palette for the bare-hole read: its own settled fill, the
  // canvas, and the window's background, which is what an open hole shows.
  const palettes: Record<string, Palette> = {};
  for (const id of cardIds) {
    settledInk[id] = band === "title" ? inkShare(settled, titleOf(rects[id])) : 1 - canvasShare(settled, titleOf(rects[id]), canvas);
    settledChrome[id] = 1 - canvasShare(settled, titleOf(rects[id]), canvas);
    settledCanvas[id] = canvasShare(settled, boxOf(rects[id]), canvas);
    const probe: Palette = { surface: canvas, canvas, bare: parseRgb(reading.windowBackground) };
    palettes[id] = { ...probe, surface: parseRgb(classifyFrame(last, probe, 8, boxOf(rects[id])).fill) };
    settledContentInk[id] = inkShare(settled, contentPx(rects[id]));
  }
  // The colour each pane's content wore at the first switched frame, and the frames that moved it.
  const firstFill: Record<string, Rgb> = {};
  const moved: Record<string, { ms: number; fill: string }[]> = {};
  // The frames that showed a revealed body's content box surface-blank.
  const blank: Record<string, { ms: number; ink: number }[]> = {};
  // What the first frame after the host unhid each card's view showed.
  const unhid: Record<string, string> = {};
  const rgbText = (c: Rgb) => `rgb(${c.r}, ${c.g}, ${c.b})`;
  let firstTitleBad: { wall: number; path: string } | null = null;
  for (const f of switched) {
    const png = decodePngFile(f.path);
    for (const id of cardIds) {
      const r = rects[id];
      const host = layers.rows.filter((row) => row.cardId === id && row.wall <= f.wall).at(-1);
      // Under the card's own skeleton or last frame the frame is the host's
      // picture, not this view.
      const viewShows =
        host !== undefined && !host.hidden && host.opacity > 0 && (host.picture === undefined || host.picture === "live");
      const ms = Math.round(f.wall - choseWall);
      const firstUnhid = viewShows && unhid[id] === undefined;
      const content = holdsColour || firstUnhid ? classifyFrame(f, palettes[id], 8, contentPx(r)) : null;
      const contentInk = (revealsPainted && viewShows) || firstUnhid ? inkShare(png, contentPx(r)) : 0;
      if (firstUnhid && content !== null) {
        const box = classifyFrame(f, palettes[id], 8, boxOf(r));
        unhid[id] =
          `${id} at ${ms} ms: content ${content.fill}, ink ${(contentInk * 100).toFixed(1)}% against settled ${(settledContentInk[id] * 100).toFixed(1)}%, ` +
          `box bare ${(box.bare * 100).toFixed(1)}% canvas ${(box.canvas * 100).toFixed(1)}%`;
      }
      if (holdsColour && content !== null) {
        const fill = parseRgb(content.fill);
        const first = (firstFill[id] ??= fill);
        if (!near(fill, first, TOLERANCE)) {
          (moved[id] ??= []).push({ ms, fill: content.fill });
          firstBad ??= { path: f.path, ms };
        }
      }
      if (revealsPainted && viewShows && blankAgainst(contentInk, settledContentInk[id])) {
        (blank[id] ??= []).push({ ms, ink: contentInk });
        firstBad ??= { path: f.path, ms };
      }
      const titleRegion = titleOf(r);
      // A title band holds the settled title's ink. A never-shown card's
      // title is its page's to compute, so its band need only hold the
      // settled band's chrome, not the canvas, whatever it says.
      // Nor does a skeleton's title, which the host draws in its own
      // face, wear the page's ink: under one the band holds chrome.
      // A card with no body yet has no layer row, and its skeleton stands
      // alone in its stage: the cut's record says it is one.
      const underSkeleton = host === undefined ? cut?.pictures[id] === "skeleton" : host.picture === "skeleton";
      const byInk = band === "title" && !underSkeleton;
      const ink = byInk ? inkShare(png, titleRegion) : 1 - canvasShare(png, titleRegion, canvas);
      const against = byInk ? settledInk[id] : settledChrome[id];
      const floor = canvasShare(png, boxOf(r), canvas);
      const w = (worst[id] ??= { ink: 1, floor: 0 });
      w.ink = Math.min(w.ink, ink);
      w.floor = Math.max(w.floor, floor);
      // The floor is told by its grid as well as its colour: a card's own
      // dark surface (a Session card's restore lid) lies within the colour
      // tolerance of the canvas and draws no grid.
      if (floor > settledCanvas[id] + BOX_CANVAS_SLACK && gridColumnsIn(png, canvas, boxOf(r)) >= FLOOR_COLUMNS) {
        bad.push(`${id} at ${ms} ms: box canvas ${(floor * 100).toFixed(1)}% against settled ${(settledCanvas[id] * 100).toFixed(1)}%`);
        firstBad ??= { path: f.path, ms };
      }
      // An open hole draws no grid, so the grid gate above cannot see one.
      // Canvas-coloured paint with no grid in it is a hole only where the
      // host had nothing of the card's on screen: a lid is its page's own.
      const hostShows = host !== undefined && !host.hidden && host.opacity > 0;
      const classes = classifyFrame(f, palettes[id], 8, boxOf(r));
      if (!hostShows && showsBareHole(classes)) {
        bad.push(`${id} at ${ms} ms: an open hole in the box, canvas ${(classes.canvas * 100).toFixed(1)}% grid ${(classes.grid * 100).toFixed(1)}% bare ${(classes.bare * 100).toFixed(1)}%, nothing of the card's on screen`);
        firstBad ??= { path: f.path, ms };
      }
      const titleFails = ink < HELD_TITLE_SHARE * against;
      if (titleFails) {
        bad.push(
          byInk
            ? `${id} at ${ms} ms: title ${(ink * 100).toFixed(1)}% held against settled ${(against * 100).toFixed(1)}%`
            : `${id} at ${ms} ms: title band chrome ${(ink * 100).toFixed(1)}% held against settled ${(against * 100).toFixed(1)}%`,
        );
        firstBad ??= { path: f.path, ms };
        firstTitleBad ??= { wall: f.wall, path: f.path };
      }
    }
  }
  for (const [id, frames] of Object.entries(moved)) {
    bad.push(
      `${id}: its content moved off the ${rgbText(firstFill[id])} the first switched frame gave it in ${frames.length} frames, ` +
        `first at ${frames[0].ms} ms to ${frames[0].fill}, last at ${frames[frames.length - 1].ms} ms to ${frames[frames.length - 1].fill}`,
    );
  }
  for (const [id, frames] of Object.entries(blank)) {
    bad.push(
      `${id}: its revealed content box was surface-blank in ${frames.length} frames, ${frames[0].ms}–${frames[frames.length - 1].ms} ms, ` +
        `ink as low as ${(Math.min(...frames.map((b) => b.ink)) * 100).toFixed(2)}% against settled ${(settledContentInk[id] * 100).toFixed(2)}%`,
    );
  }
  note(`${label}: the first frame showing each card's unhidden view — ${cardIds.map((id) => unhid[id] ?? `${id} never shown unhidden in the burst`).join("; ")}`);
  note(
    `${label}: ${switched.length} frames from the gesture, the first at ${Math.round(switched[0].wall - choseWall)} ms; ` +
      cardIds.map((id) => `${id} least title band ${band} ${(worst[id].ink * 100).toFixed(1)}%, most box canvas ${(worst[id].floor * 100).toFixed(1)}%`).join("; "),
  );
  if (bad.length > 0) note(`${label}: frames without a title or showing the floor: ${bad.slice(0, 10).join("; ")}${bad.length > 10 ? ` (+${bad.length - 10} more)` : ""}`);
  if (firstTitleBad !== null) {
    // What the host had on screen for each card at the first frame whose title failed.
    const at = firstTitleBad.wall;
    const ids = [...new Set(layers.rows.map((row) => row.cardId))];
    note(
      `${label}: host layers at the first title red (${Math.round(at - choseWall)} ms): ` +
        ids.map((id) => {
          const row = layers.rows.filter((r) => r.cardId === id && r.wall <= at).at(-1);
          return row === undefined
            ? `${id} no row`
            : `${id} @${Math.round(row.wall - choseWall)} ms ${row.start} ${row.state} painted ${row.painted} covered ${row.covered} hidden ${row.hidden} opacity ${row.opacity.toFixed(2)} shown ${row.shown} at ${row.frame ?? "?"} (card ${rects[id] === undefined ? "?" : `${Math.round(rects[id].x)},${Math.round(rects[id].y)} ${Math.round(rects[id].width)}×${Math.round(rects[id].height)}`})${row.pane == null ? "" : `, skeleton ${row.pane}`}`;
        }).join("; "),
    );
    copyFileSync(firstTitleBad.path, join(tmpdir(), `${label}-first-title-red.png`));
  }
  if (firstBad !== null) {
    // The burst's frames are swept with the app; keep the first red one and the settled one to look at.
    const keptBad = join(tmpdir(), `${label}-first-red-frame.png`);
    const keptLast = join(tmpdir(), `${label}-settled-frame.png`);
    copyFileSync(firstBad.path, keptBad);
    copyFileSync(last.path, keptLast);
    note(`${label}: kept the first red frame (${firstBad.ms} ms) at ${keptBad} and the settled frame at ${keptLast}`);
  }
  return bad;
}

/**
 * When the host put each arriving card on screen and took the departing
 * views down, for the notes: each card's first host row on screen after
 * the switch (its container not hidden and not transparent, whatever the
 * host believes of it), the last on-screen row of any view the switch takes
 * down, and per card the later of the two.
 */
export function heldTitleScope(
  rows: readonly BodyLayerRow[],
  cardIds: readonly string[],
  choseWall: number,
): { firstOn: Record<string, BodyLayerRow>; lastLeaving: number | null; from: Record<string, number> } {
  const onScreen = (r: BodyLayerRow) => !r.hidden && r.opacity > 0;
  const arriving = new Set(cardIds);
  const firstOn: Record<string, BodyLayerRow> = {};
  let lastLeaving: number | null = null;
  for (const r of rows) {
    if (r.wall < choseWall || !onScreen(r)) continue;
    if (arriving.has(r.cardId)) firstOn[r.cardId] ??= r;
    else lastLeaving = Math.max(lastLeaving ?? r.wall, r.wall);
  }
  const from: Record<string, number> = {};
  for (const id of cardIds) {
    const first = firstOn[id];
    if (first !== undefined) from[id] = Math.max(first.wall, lastLeaving ?? first.wall);
  }
  return { firstOn, lastLeaving, from };
}
