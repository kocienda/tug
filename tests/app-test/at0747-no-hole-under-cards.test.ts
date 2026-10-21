/**
 * at0747-no-hole-under-cards.test.ts — the cards stand over the shell, so no
 * frame shows the canvas through a card.
 *
 * Three cards stand side by side in the flow band. The front one is dragged
 * by its grab handle across both its neighbours and dropped on the first,
 * where the flow re-divides and its neighbours settle around where it lands.
 * A capture burst runs across the drag and the settle, and the shell's
 * own record of every stand-in's rect is sampled on each animation frame
 * beside it. On every captured frame, inside every pane a still card stands
 * in (its rect on each shell sample within a period either side, intersected,
 * so the reading never judges where a card has just left), the composite
 * shows the card's paint — never the canvas's colour nor its grid, by more
 * than the card itself shows at rest. The dragged card is the host's while
 * it is in the hand, and is read once the settle has landed it.
 *
 * Beside it, a census of the shell's document: no stand-in, nor anything
 * inside it nor any pseudo-element it shows, clips or paints a background,
 * a border or a shadow, and nothing inside it has a box but the frame's content
 * holders and the card's placeholder. The shell's pane is the arrangement's
 * model, and nothing in it is seen.
 *
 * @visible
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import type { CaptureBurstFrame, CaptureBurstReading } from "./_harness/client";
import { decodePngFile } from "./_harness/png";
import { asRgbJs, near, parseRgb, pollFor, type Rgb } from "./body-grounding/_frames";
import { standUpKind } from "./body-grounding/_kind-bodies";
import { cardKind, kindPane } from "./body-grounding/_kinds";
import { rectIn, still, type Rect } from "./one-view-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const CARDS = ["at0747-a", "at0747-b", "at0747-c"] as const;
const FRONT = CARDS[2];
const BURST_MS = 1_800;
const BURST_INTERVAL_MS = 33;
/** How far either side of a frame's capture the shell's samples are taken to bound where a card stood. */
const SKEW_MS = 50;
/** Kept clear of a pane's rounded corners and its border when it is read. */
const INSET_PX = 8;
/** How much more of a pane may read as canvas or grid in motion than at rest. */
const FLOOR_MARGIN = 0.01;

interface Sample {
  wall: number;
  settling: boolean;
  rects: Record<string, Rect>;
  /** Whether the placer's last placement posts each card shown. */
  posted: Record<string, boolean>;
}

function deck(): Record<string, unknown> {
  return {
    cards: CARDS.map((id) => ({ id, componentId: "hello", title: id, closable: true })),
    panes: CARDS.map((id, slot) => kindPane("hello", id, slot)),
    activePaneId: `${FRONT}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** A function answering every stand-in's rect, by its card, as the shell lays it out now. */
// card-dom: shell — the stand-ins are the shell's model of where each card stands.
const READ_STAND_INS = `function () {
  var out = {};
  document.querySelectorAll('.tug-pane:not([data-departing])').forEach(function (f) {
    var ph = f.querySelector('[data-body-placeholder][data-card-id]');
    if (!ph) return;
    var r = f.getBoundingClientRect();
    out[ph.getAttribute('data-card-id')] = { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  return out;
}`;

const STAND_INS = `(${READ_STAND_INS})()`;

/** The census: what any stand-in, or anything inside it, paints or holds. Empty when the stand-ins are paintless. */
// card-dom: shell — the census reads the shell's own document.
const CENSUS = `(function () {
  var faults = [];
  var holders = ['tug-pane-chrome', 'tug-pane-content'];
  function transparent(c) { return c === 'transparent' || /rgba\\(.*,\\s*0\\)$/.test(c); }
  function paints(s, label) {
    if (s.clipPath !== 'none') faults.push(label + ' clips: ' + s.clipPath);
    if (!transparent(s.backgroundColor) || s.backgroundImage !== 'none') faults.push(label + ' paints a background: ' + s.backgroundColor + ' ' + s.backgroundImage);
    if (s.boxShadow !== 'none') faults.push(label + ' casts a shadow: ' + s.boxShadow);
    if (['Top', 'Right', 'Bottom', 'Left'].some(function (e) { return parseFloat(s['border' + e + 'Width']) > 0 && s['border' + e + 'Style'] !== 'none'; })) faults.push(label + ' draws a border');
  }
  function judge(el, label) {
    paints(getComputedStyle(el), label);
    ['::before', '::after'].forEach(function (which) {
      var p = getComputedStyle(el, which);
      if (p.content === 'none' || p.content === 'normal' || p.display === 'none') return;
      paints(p, label + which);
    });
  }
  var frames = document.querySelectorAll('.tug-pane');
  frames.forEach(function (f) {
    var id = f.getAttribute('data-pane-id');
    judge(f, id);
    f.querySelectorAll('*').forEach(function (el) {
      var label = id + ' > ' + el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : '');
      judge(el, label);
      var r = el.getBoundingClientRect();
      var structural = holders.some(function (h) { return el.classList.contains(h); }) || el.hasAttribute('data-body-placeholder');
      if (!structural && r.width > 0 && r.height > 0) faults.push(label + ' has a box inside the stand-in');
    });
  });
  return { frames: frames.length, faults: faults };
})()`;

/** Arm a per-animation-frame sampler of every stand-in, and whether a settle is running, for `ms`. */
async function armSampler(app: App, ms: number): Promise<void> {
  // card-dom: shell — the sampler reads the shell's stand-ins.
  await app.evalJS<null>(`(function () {
    var rec = (window.__noHole = []);
    var until = performance.now() + ${ms};
    var read = ${READ_STAND_INS};
    var posted = function () {
      var out = {};
      var p = window.tugdeck.diag.getBodyPlacement();
      var last = p && p.lastPosted;
      if (last) last.bodies.forEach(function (b) { out[b.cardId] = b.visible === true; });
      return out;
    };
    function step() {
      rec.push({ wall: performance.timeOrigin + performance.now(), settling: document.querySelector('[data-imposer-settling]') !== null, rects: read(), posted: posted() });
      if (performance.now() < until) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    return null;
  })()`);
}

/** The rect `cardId` covered on every sample within {@link SKEW_MS} of `wall`, or null when no sample bounds it. */
function heldRect(samples: readonly Sample[], cardId: string, wall: number): Rect | null {
  const near = samples.filter((s) => Math.abs(s.wall - wall) <= SKEW_MS && s.rects[cardId] !== undefined);
  if (near.length === 0) return null;
  let x0 = -Infinity;
  let y0 = -Infinity;
  let x1 = Infinity;
  let y1 = Infinity;
  for (const s of near) {
    const r = s.rects[cardId];
    x0 = Math.max(x0, r.x);
    y0 = Math.max(y0, r.y);
    x1 = Math.min(x1, r.x + r.width);
    y1 = Math.min(y1, r.y + r.height);
  }
  return x1 - x0 > 2 * INSET_PX && y1 - y0 > 2 * INSET_PX ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The commonest colour inside `rect` (viewport points, inset clear of its corners) of a frame cropped at `crop`. */
function commonestIn(frame: CaptureBurstFrame, crop: Rect, scale: number, rect: Rect): Rgb {
  const png = decodePngFile(frame.path);
  const x0 = Math.max(0, Math.floor((rect.x + INSET_PX - crop.x) * scale));
  const y0 = Math.max(0, Math.floor((rect.y + INSET_PX - crop.y) * scale));
  const x1 = Math.min(png.width, Math.ceil((rect.x + rect.width - INSET_PX - crop.x) * scale));
  const y1 = Math.min(png.height, Math.ceil((rect.y + rect.height - INSET_PX - crop.y) * scale));
  const counts = new Map<number, number>();
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * png.width + x) * 4;
      const key = (png.rgba[i] << 16) | (png.rgba[i + 1] << 8) | png.rgba[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let key = 0;
  let most = -1;
  for (const [k, n] of counts) if (n > most) [key, most] = [k, n];
  return { r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 };
}

/** How near a pixel must be to a colour to be read as it. */
const TOLERANCE = 8;
/** How far from the canvas colour a pixel may lie and still be its grid line (`_frames.ts`). */
const GRID_REACH = 44;

/**
 * The share of `rect` (viewport points, inset clear of its corners) the
 * frame paints as the canvas or its grid. Any card's surface is a card's
 * paint first — the key card's and its neighbours' differ, and either may
 * stand over the pane being read — so only what is neither a card's surface
 * nor clear of the canvas's grid reach is the floor.
 */
function floorShare(frame: CaptureBurstFrame, canvas: Rgb, surfaces: readonly Rgb[], crop: Rect, scale: number, rect: Rect): number {
  const png = decodePngFile(frame.path);
  const x0 = Math.max(0, Math.floor((rect.x + INSET_PX - crop.x) * scale));
  const y0 = Math.max(0, Math.floor((rect.y + INSET_PX - crop.y) * scale));
  const x1 = Math.min(png.width, Math.ceil((rect.x + rect.width - INSET_PX - crop.x) * scale));
  const y1 = Math.min(png.height, Math.ceil((rect.y + rect.height - INSET_PX - crop.y) * scale));
  let floor = 0;
  let pixels = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      pixels += 1;
      if (surfaces.some((s) => near(p, s, TOLERANCE))) continue;
      if (near(p, canvas, GRID_REACH)) floor += 1;
    }
  }
  return pixels === 0 ? 0 : floor / pixels;
}

describe.skipIf(!SHOULD_RUN)("at0747: no frame shows the canvas through a card", () => {
  test(
    "the front card dragged across two neighbours into a settle: no captured frame shows canvas or grid inside a card's pane",
    async () => {
      const app = await launchTugApp({ testName: "at0747-no-hole", visible: true });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: FRONT });
        const hello = cardKind("hello");
        for (const id of CARDS) await standUpKind(app, hello, id);
        await Bun.sleep(300);

        // ---- The census ----
        const census = await app.evalJS<{ frames: number; faults: string[] }>(CENSUS);
        note(`census: ${census.frames} stand-ins; ${census.faults.length === 0 ? "nothing painted" : census.faults.join("; ")}`);
        expect(census.frames, "every card has its stand-in").toBe(CARDS.length);
        expect(census.faults, "no stand-in clips, paints, or holds anything with a box").toEqual([]);

        // ---- At rest ----
        const rest = await app.evalJS<Record<string, Rect>>(STAND_INS);
        for (const id of CARDS) expect(rest[id], `${id} stands in the flow`).toBeDefined();
        const [a, b, c] = CARDS.map((id) => rest[id]);
        note(`at rest: ${JSON.stringify(Object.fromEntries(CARDS.map((id) => [id, rest[id]])))}`);
        expect(a.x < b.x && b.x < c.x, "the three cards stand left to right").toBe(true);
        // card-dom: shell
        const canvas = parseRgb(
          await app.evalJS<string>(asRgbJs("getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')")),
        );
        const left = Math.max(0, Math.floor(a.x) - 4);
        const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)) - 4);
        const crop = {
          x: left,
          y: top,
          width: Math.ceil(c.x + c.width) + 4 - left,
          height: Math.ceil(Math.max(a.y + a.height, b.y + b.height, c.y + c.height)) + 4 - top,
        };
        const standing = await still(app, crop);
        // Each card's surface, off the standing card, is classed before the
        // canvas's grid reach: in a dark theme a card's surface is a step of
        // the very ramp the canvas and its grid line are, and the key card
        // paints a tone of its own.
        const surfaces: Rgb[] = [];
        for (const id of CARDS) {
          const surface = commonestIn(standing.frame, crop, standing.scale, rest[id]);
          expect(near(surface, canvas, TOLERANCE), `${id}'s surface is told apart from the canvas`).toBe(false);
          surfaces.push(surface);
          // And its title bar's, which a carried card brings over the pane it crosses.
          const bar = commonestIn(standing.frame, crop, standing.scale, { ...rest[id], height: 2 * INSET_PX + 16 });
          if (!near(bar, canvas, TOLERANCE)) surfaces.push(bar);
        }
        note(`canvas ${JSON.stringify(canvas)}; the cards' surfaces ${JSON.stringify(surfaces)}`);
        const restShare = Object.fromEntries(CARDS.map((id) => [id, floorShare(standing.frame, canvas, surfaces, crop, standing.scale, rest[id])]));
        note(`at rest, the share of each pane read as canvas or grid: ${JSON.stringify(restShare)}`);
        // A hole between the cards is canvas: the reading tells it from a card's paint.
        const between = { x: a.x + a.width + 1, y: a.y + 40, width: Math.max(1, b.x - (a.x + a.width) - 2), height: 200 };
        if (between.width > 2 * INSET_PX + 2) {
          const gap = floorShare(standing.frame, canvas, surfaces, crop, standing.scale, between);
          note(`the gutter between the first two cards reads ${gap.toFixed(3)} canvas or grid`);
          expect(gap, "the canvas between two cards is read as the canvas").toBeGreaterThan(0.5);
        }
        for (const id of CARDS) expect(restShare[id], `at rest ${id}'s pane shows its own paint`).toBeLessThan(0.05);

        // ---- The drag and its settle, under a burst ----
        const front = app.body(FRONT);
        const handle = await rectIn(front, ".tug-pane-title-bar .tug-pane-grab-handle");
        expect(handle, "the front card offers its grab handle").not.toBeNull();
        const view = (await app.bodies()).find((s) => s.cardId === FRONT)!.frame;
        const from = { x: view.x + handle!.x + Math.min(20, handle!.width / 2), y: view.y + handle!.y + handle!.height / 2 };
        // Over the first card, inside the window, and below its title band,
        // so the drop asks for its slot, not a tab on its bar.
        const to = { x: Math.max(a.x, 0) + Math.min(80, a.width / 3), y: from.y + 120 };
        await armSampler(app, BURST_MS + 400);
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
        await app.nativeDragWithoutRelease(from, to, { interpolationSteps: 20, interpolationDelayMs: 30, mouseDownDelayMs: 80 });
        const upWall = Date.now();
        await app.nativeMouseUp(to);
        const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
        expect(reading.done, "the burst finished").toBe(true);
        // card-dom: shell
        const samples = await app.evalJS<Sample[]>(`window.__noHole`);
        const settled = await pollFor(() => app.evalJS<boolean>(`document.querySelector('[data-imposer-settling]') === null`), (v) => v, 3_000);
        expect(settled, "the settle landed").toBe(true);
        const after = await app.evalJS<Record<string, Rect>>(STAND_INS);
        note(`after the drop: ${JSON.stringify(Object.fromEntries(CARDS.map((id) => [id, Math.round(after[id]?.x ?? -1)])))}; ${samples.filter((s) => s.settling).length} of ${samples.length} shell samples settling`);
        expect(samples.some((s) => s.settling), "the drop settled the deck").toBe(true);
        expect(Math.abs(after[FRONT].x - c.x), "the dropped card moved across its neighbours").toBeGreaterThan(c.width);
        const moved = CARDS.filter((id) => id !== FRONT && (Math.abs(after[id].x - rest[id].x) > 1 || Math.abs(after[id].y - rest[id].y) > 1));
        expect(moved.length, "its neighbours settled around where it landed").toBeGreaterThan(0);

        // ---- Every frame, inside every still card's pane ----
        // Three cards of one kind carry the same ink: the most any showed at
        // rest is each one's baseline, whichever part of it the crop saw.
        const baseline = Math.max(...CARDS.map((id) => restShare[id]));
        // The front card is the host's from the press until its settle lands it.
        const landedWall = Math.max(upWall, ...samples.filter((s) => s.settling).map((s) => s.wall)) + SKEW_MS;
        const worst: Array<{ t: number; cardId: string; share: number }> = [];
        let judged = 0;
        for (const f of reading.frames) {
          for (const id of CARDS) {
            if (id === FRONT && f.wall <= landedWall) continue;
            const rect = heldRect(samples, id, f.wall);
            if (rect === null) continue;
            const share = floorShare(f, canvas, surfaces, crop, reading.scale, rect);
            judged += 1;
            if (share > baseline + FLOOR_MARGIN) worst.push({ t: f.t, cardId: id, share });
          }
        }
        note(`${reading.frames.length} frames, ${judged} pane readings; ${worst.length} over the bar`);
        // card-dom: shell — the placer's own account of the plans it ran.
        const placer = await app.evalJS<{ planRuns: number; lastPlan: unknown }>(`(function () { var p = window.tugdeck.diag.getBodyPlacement(); return { planRuns: p.planRuns, lastPlan: p.lastPlan }; })()`);
        const hiddenSpans = CARDS.map((id) => `${id} posted hidden on ${samples.filter((s) => s.posted[id] === false).length} of ${samples.length} samples`);
        note(`the placer ran ${placer.planRuns} plan(s); last ${JSON.stringify(placer.lastPlan)}; ${hiddenSpans.join("; ")}`);
        if (worst.length > 0) note(`panes showing the canvas\n${worst.map((w) => `${Math.round(w.t)}ms ${w.cardId} ${w.share.toFixed(3)}`).join("\n")}`);
        expect(judged, "panes were read across the drag and the settle").toBeGreaterThan(reading.frames.length);
        expect(worst.length, "no captured frame shows the canvas or its grid inside a card's pane").toBe(0);

        // ---- The landing ----
        const landed = await still(app, crop);
        for (const id of CARDS) {
          const share = floorShare(landed.frame, canvas, surfaces, crop, landed.scale, after[id]);
          expect(share, `landed, ${id}'s pane shows its own paint`).toBeLessThanOrEqual(baseline + FLOOR_MARGIN);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
