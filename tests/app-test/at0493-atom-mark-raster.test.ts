/**
 * at0493-atom-mark-raster.test.ts — the session atom's mark is CENTRED IN ITS
 * RASTER, and its pill never clips the label it holds.
 *
 * ## The two regressions this pins
 *
 * Both were introduced by the register table and both are invisible to layout,
 * which is why they need a test that looks at real pixels and at ink rather
 * than at boxes.
 *
 * **1. The dot painted off-centre inside its own ring.** The register asked for
 * a 4.5px painted dot, and the settled pose quieted that to ~3.8px. Every box
 * in the glyph is centred exactly — `getBoundingClientRect` said so — but the
 * browser snaps each box onto the device grid on its own, and a circle whose
 * diameter is a half (or a fifth) of a device pixel snaps a different way than
 * the ring around it. Measured on a real screenshot, the dot's ink centre moved
 * ±0.5 device px as the host's sub-pixel offset changed — while the ring's
 * never moved at all — and the dot shed a device pixel of its own width doing
 * it. On a mark eight device pixels across that reads as a dot sitting in the
 * corner of its pulse.
 *
 * The cure is whole, same-parity geometry: a 4px dot in an 8px box, so the
 * offset between the two circles is a whole number of device pixels at 1x and
 * at 2x, and both snap together or not at all. That is what this test holds —
 * by walking the pill through a series of sub-pixel offsets and requiring the
 * two ink centroids to stay coincident at every one of them.
 *
 * **2. The pill clipped its label's descenders.** The chip tier set
 * `line-height: 1` on a 13px face whose ink is 17px tall, and the name run
 * clips (that is how it elides) — so two pixels came off the bottom of every
 * descender, and `tugtool/strong-deer` lost the tail of its `g` to what read as
 * the pill's own border. The assertion is the general one: the run's clipping
 * box must hold the ink inside it.
 *
 * **3. The diamond painted its mark off-centre inside its own pulse.** The
 * same defect as (1), arriving by the other door. The diamond shape drew its
 * three figures at 1/√2 of the circle's boxes, which put an irrational in
 * every LAYOUT box — a 12px glyph's mark became 4.2426px inside an 8.4853px
 * pulse — and the two snapped apart by half a device pixel at some sub-pixel
 * offsets while the pulse's own width flickered between 20 and 22 device px.
 * The cure is the cure from (1): the figures keep the circle's whole boxes and
 * the ROOT carries the 1/√2, so all three go down under one matrix. The two
 * marks are separated here by TONE — the diamond's mark is the working cobalt
 * and its pulse is the idle ink — so this probe splits them by colour rather
 * than by radius, and clones the glyphs onto a surface of their own so no
 * neighbouring caption lands in the crop.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/atom-register.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.css
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import { decodePngFile } from "./_harness/png";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The sub-pixel offsets a pill can land on in an ordinary row. */
const SHIFTS = [0, 0.2, 0.25, 0.3, 0.5, 0.75];

/** How far apart the two ink centroids may sit, in device px. */
const CONCENTRIC_TOLERANCE = 0.25;

/** The same, for the big treatment's fractional mark box — see the loop. */
const BIG_TOLERANCE = 0.5;

interface MarkProbe {
  innerWidth: number;
  dpr: number;
  marks: {
    label: string;
    state: string;
    /** Viewport rect of the mark's glyph box: left, top, width, height. */
    glyph: [number, number, number, number];
  }[];
}

/** Every atom mark on screen, with the glyph box the screenshot is cropped to. */
const MARKS_JS = `(function () {
  var pills = Array.from(document.querySelectorAll('.tug-session-identity[data-tier="chip"]'));
  var marks = [];
  pills.forEach(function (p) {
    var g = p.querySelector('.tug-progress-pulsing-dot');
    if (g === null) return;
    var r = g.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) return;
    marks.push({
      label: (p.textContent || '').slice(0, 18),
      state: g.getAttribute('data-state') || '',
      glyph: [r.left, r.top, r.width, r.height],
    });
  });
  return { innerWidth: window.innerWidth, dpr: window.devicePixelRatio, marks: marks };
})()`;

/**
 * Walk every pill by `shift` px. Relative positioning, so the offset lands on
 * the pill exactly as an odd row height would — nothing else about the layout
 * changes, and no transform is introduced that would create a layer of its own.
 */
const shiftJs = (shift: number): string =>
  `Array.from(document.querySelectorAll('.tug-session-identity[data-tier="chip"]')).forEach(function (p) {
     p.style.position = 'relative'; p.style.top = '${shift}px'; p.style.left = '${shift}px';
   }); true`;

/**
 * The label's ink against the box that clips it — the descender check.
 *
 * A `Range` over the run's text reports the ink's own box, which is the face's
 * ascent + descent at this size; the element's client box is what
 * `overflow: hidden` cuts at. The first must fit inside the second.
 */
const CLIP_JS = `(function () {
  var runs = Array.from(document.querySelectorAll('.tug-session-identity[data-tier="chip"] .tug-session-identity-name'));
  return runs.slice(0, 8).map(function (run) {
    var range = document.createRange();
    range.selectNodeContents(run);
    var ink = range.getBoundingClientRect();
    var box = run.getBoundingClientRect();
    return {
      text: (run.textContent || '').slice(0, 18),
      inkHeight: ink.height,
      boxHeight: box.height,
      inkTop: ink.top - box.top,
      inkBottom: box.bottom - ink.bottom,
    };
  });
})()`;

interface ClipRow {
  text: string;
  inkHeight: number;
  boxHeight: number;
  inkTop: number;
  inkBottom: number;
}

/** Ink centroid and extent of the pixels passing `keep`, in crop coordinates. */
interface Blob {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

function measure(
  lum: number[][],
  keep: (x: number, y: number, v: number) => boolean,
): Blob | null {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < lum.length; y++) {
    for (let x = 0; x < lum[y]!.length; x++) {
      const v = lum[y]![x]!;
      if (!keep(x, y, v)) continue;
      sx += x * v;
      sy += y * v;
      sw += v;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (sw === 0) return null;
  return { cx: sx / sw, cy: sy / sw, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

interface MarkRaster {
  label: string;
  state: string;
  dx: number;
  dy: number;
  dotWidth: number;
  ringWidth: number;
}

/** Screenshot the app and measure every mark's dot against its own ring. */
async function rasterAt(app: App, shift: number): Promise<MarkRaster[]> {
  await app.evalJS(shiftJs(shift));
  // One frame for the offset to land before the snapshot is taken.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const probe = await app.evalJS<MarkProbe>(MARKS_JS);
  const shot = await app.screenshot();
  const png = decodePngFile(shot.path);
  const scale = png.width / probe.innerWidth;
  const out: MarkRaster[] = [];

  for (const mark of probe.marks) {
    const [gl, gt, gw, gh] = mark.glyph;
    // The ring travels past the glyph box, so the crop is the box plus room.
    const pad = 5;
    const x0 = Math.round((gl - pad) * scale);
    const y0 = Math.round((gt - pad) * scale);
    const w = Math.round((gw + pad * 2) * scale);
    const h = Math.round((gh + pad * 2) * scale);
    const lum: number[][] = [];
    let min = 255;
    let max = 0;
    for (let y = 0; y < h; y++) {
      const row: number[] = [];
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * png.width + (x0 + x)) * 4;
        const v =
          0.2126 * png.rgba[i]! + 0.7152 * png.rgba[i + 1]! + 0.0722 * png.rgba[i + 2]!;
        row.push(v);
        if (v < min) min = v;
        if (v > max) max = v;
      }
      lum.push(row);
    }
    // The mark is the bright ink on the card's own surface; the threshold is
    // taken from the crop rather than authored, so a theme change cannot
    // silently empty the measurement.
    const floor = min + (max - min) * 0.35;
    const ink = measure(lum, (_x, _y, v) => v > floor);
    if (ink === null) continue;
    const radius = ink.w / 2;
    const from = (x: number, y: number): number => Math.hypot(x - ink.cx, y - ink.cy);
    const dot = measure(lum, (x, y, v) => v > floor && from(x, y) < radius * 0.45);
    const ring = measure(lum, (x, y, v) => v > floor && from(x, y) > radius * 0.6);
    if (dot === null || ring === null) continue;
    out.push({
      label: mark.label,
      state: mark.state,
      dx: dot.cx - ring.cx,
      dy: dot.cy - ring.cy,
      dotWidth: dot.w,
      ringWidth: ring.w,
    });
  }
  return out;
}

/**
 * The diamond probe's own surface.
 *
 * The diamond ships on the STATE cell at 12px and on the Lens row at 28px, and
 * the gallery card shows the second of those. Each indicator that holds one is
 * cloned onto a plain fixed-position panel — clone rather than measure in
 * place, because a gallery cell's caption sits a few pixels from the glyph and
 * would land in the crop — and the first clone is forced down to the STATE
 * cell's 12px, which is the size the defect was reported at. The loops are
 * paused at a fixed phase so the pulse is mid-travel and lit in every
 * screenshot; `shift` moves the whole panel onto a sub-pixel offset the way
 * an odd row height moves a pill.
 */
const diamondSetupJs = (shift: number): string => `(function () {
  var old = document.getElementById('diamond-probe');
  if (old !== null) old.remove();
  if (document.getElementById('diamond-probe-style') === null) {
    var s = document.createElement('style');
    s.id = 'diamond-probe-style';
    s.textContent = '.tug-progress-pulsing-dot-dot, .tug-progress-pulsing-dot-ring { animation-play-state: paused !important; animation-delay: -1150ms !important; }';
    document.head.appendChild(s);
  }
  var panel = document.createElement('div');
  panel.id = 'diamond-probe';
  panel.style.cssText = 'position:fixed; left:' + (60 + ${shift}) + 'px; top:' + (60 + ${shift}) + 'px; z-index:99999; background:#16181d; color:#8b93a1; padding:30px; display:flex; gap:60px;';
  Array.from(document.querySelectorAll('.tug-progress-indicator')).filter(function (n) {
    return n.querySelector('.tug-progress-pulsing-dot[data-shape="diamond"]') !== null;
  }).forEach(function (n, i) {
    var clone = n.cloneNode(true);
    if (i === 0) {
      var g = clone.querySelector('.tug-progress-pulsing-dot');
      g.style.setProperty('--tugx-progress-pulsing-dot-size', '12px');
      g.style.setProperty('--tugx-progress-pulsing-dot-dot-size', '6px');
    }
    panel.appendChild(clone);
  });
  document.body.appendChild(panel);
  var out = [];
  Array.from(panel.querySelectorAll('.tug-progress-pulsing-dot')).forEach(function (g) {
    var r = g.getBoundingClientRect();
    out.push({
      size: getComputedStyle(g).getPropertyValue('--tugx-progress-pulsing-dot-size').trim(),
      glyph: [r.left, r.top, r.width, r.height],
    });
  });
  return { innerWidth: window.innerWidth, dpr: window.devicePixelRatio, marks: out };
})()`;

interface DiamondProbe {
  innerWidth: number;
  dpr: number;
  marks: { size: string; glyph: [number, number, number, number] }[];
}

interface DiamondRaster {
  size: string;
  dx: number;
  dy: number;
  markWidth: number;
  pulseWidth: number;
}

/** Weighted centroid and extent of a set of ink samples, in crop coordinates. */
function centroidOf(
  samples: { x: number; y: number; w: number }[],
): Blob | null {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const s of samples) {
    sx += s.x * s.w;
    sy += s.y * s.w;
    sw += s.w;
    if (s.x < x0) x0 = s.x;
    if (s.x > x1) x1 = s.x;
  }
  if (sw === 0) return null;
  return { cx: sx / sw, cy: sy / sw, w: x1 - x0 + 1, h: 0 };
}

/**
 * Screenshot the probe panel and measure each diamond's mark against its pulse.
 *
 * The split is by TONE, not by radius: the mark is the working cobalt and the
 * pulse is the idle ink, so a blue-minus-red test separates them cleanly and
 * neither figure's extent has to be guessed at.
 */
async function diamondRasterAt(
  app: App,
  shift: number,
): Promise<DiamondRaster[]> {
  const probe = await app.evalJS<DiamondProbe>(diamondSetupJs(shift));
  // One frame for the panel to land before the snapshot is taken.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const shot = await app.screenshot();
  const png = decodePngFile(shot.path);
  const scale = png.width / probe.innerWidth;
  const out: DiamondRaster[] = [];

  for (const mark of probe.marks) {
    const [gl, gt, gw, gh] = mark.glyph;
    const pad = 12;
    const x0 = Math.round((gl - pad) * scale);
    const y0 = Math.round((gt - pad) * scale);
    const w = Math.round((gw + pad * 2) * scale);
    const h = Math.round((gh + pad * 2) * scale);
    const cobalt: { x: number; y: number; w: number }[] = [];
    const idle: { x: number; y: number; w: number }[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * png.width + (x0 + x)) * 4;
        const r = png.rgba[i]!;
        const g = png.rgba[i + 1]!;
        const b = png.rgba[i + 2]!;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (b - r > 30) cobalt.push({ x, y, w: b - r });
        else if (lum > 45) idle.push({ x, y, w: lum - 30 });
      }
    }
    const dot = centroidOf(cobalt);
    const pulse = centroidOf(idle);
    if (dot === null || pulse === null) continue;
    out.push({
      size: mark.size,
      dx: dot.cx - pulse.cx,
      dy: dot.cy - pulse.cy,
      markWidth: dot.w,
      pulseWidth: pulse.w,
    });
  }
  return out;
}

describe.skipIf(!SHOULD_RUN)("the session atom's mark and label", () => {
  test(
    "the dot paints concentric with its ring at every sub-pixel offset",
    async () => {
      const app = await launchTugApp({ testName: "at0493-atom-mark-raster" });
      try {
        await app.dispatchControlAction("show-card", { component: "gallery-atom" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-session-identity[data-tier="chip"] .tug-progress-pulsing-dot').length > 0`,
          { timeoutMs: 15_000 },
        );

        const widths = new Set<number>();
        for (const shift of SHIFTS) {
          const marks = await rasterAt(app, shift);
          note(`at0493 shift=${shift}: ${JSON.stringify(marks)}`);
          expect(marks.length).toBeGreaterThan(0);
          for (const mark of marks) {
            // The whole defect, stated: the two circles share a centre in the
            // raster, not just in layout.
            expect(Math.abs(mark.dx)).toBeLessThanOrEqual(CONCENTRIC_TOLERANCE);
            expect(Math.abs(mark.dy)).toBeLessThanOrEqual(CONCENTRIC_TOLERANCE);
            widths.add(mark.dotWidth);
          }
        }
        // And it is the same dot at every offset. A mark that snapped away a
        // device pixel of its own width at some offsets would read as
        // breathing when it is settled.
        expect(widths.size).toBe(1);

        // The label's ink lives inside the box that clips it — no descender is
        // cut by the run's own `overflow: hidden`.
        const clips = await app.evalJS<ClipRow[]>(CLIP_JS);
        note(`at0493 label clip: ${JSON.stringify(clips)}`);
        expect(clips.length).toBeGreaterThan(0);
        for (const clip of clips) {
          expect(clip.boxHeight).toBeGreaterThanOrEqual(clip.inkHeight);
          expect(clip.inkTop).toBeGreaterThanOrEqual(0);
          expect(clip.inkBottom).toBeGreaterThanOrEqual(0);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the diamond's mark paints concentric with its pulse at every offset",
    async () => {
      const app = await launchTugApp({ testName: "at0493-diamond-raster" });
      try {
        await app.dispatchControlAction("show-card", {
          component: "gallery-tug-progress-indicator",
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-progress-pulsing-dot[data-shape="diamond"]').length > 0`,
          { timeoutMs: 15_000 },
        );

        const widths = new Set<number>();
        for (const shift of SHIFTS) {
          const marks = await diamondRasterAt(app, shift);
          note(`at0493 diamond shift=${shift}: ${JSON.stringify(marks)}`);
          expect(marks.length).toBeGreaterThan(0);
          for (const mark of marks) {
            // 12px is the STATE cell, where the geometry is whole and the two
            // figures are coincident. The 28px cell is the big treatment,
            // whose dot ratio (0.6) makes a 16.8px mark box for the diamond
            // and the circle alike — a fractional box that snaps up to half a
            // device pixel on its own, which is a separate defect from this
            // one and not the diamond's.
            const tolerance =
              mark.size === "12px" ? CONCENTRIC_TOLERANCE : BIG_TOLERANCE;
            expect(Math.abs(mark.dx)).toBeLessThanOrEqual(tolerance);
            expect(Math.abs(mark.dy)).toBeLessThanOrEqual(tolerance);
            if (mark.size === "12px") widths.add(mark.pulseWidth);
          }
        }
        // The pulse is the same figure at every offset — the width that
        // flickered by a device pixel is what the snap was doing to it.
        expect(widths.size).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
