/**
 * at0713-zoom-raster-crisp.test.ts — View › Zoom draws text at the zoom's own
 * resolution, never upscaled from a 100 % raster.
 *
 * View › Zoom is a `transform: scale(f)` on the deck root. A transform can be
 * composited two ways: by rasterizing the layer at its final scale, or by
 * rasterizing it at 1× and stretching the bitmap. The second is the soft, blurry
 * zoom this design exists to avoid, and nothing in layout can tell the two
 * apart — every rect is the same either way. So this test reads pixels.
 *
 * A run of six `I` stems, light on dark, stands on a panel of its own inside
 * the deck root (so no neighbouring ink lands in the crop, and the panel scales
 * with the deck). At each factor the panel's glyph box is cropped out of a real
 * screenshot, and every horizontal scan through the middle of the stems counts
 * the device pixels each stem edge spends between dark and light. A raster made
 * at scale keeps that transition at the antialiasing's own pixel or so at every
 * factor; a 1× raster stretched to 2.0 doubles it. The assertion is that 0.5 and
 * 2.0 are no softer than 1.0.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/page-zoom-store.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import { decodePngFile } from "./_harness/png";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const STEMS = 6;
/** How much softer than 1.0 an edge may read, in device px, before it is a stretch. */
const SOFTNESS_TOLERANCE = 0.5;

/** The probe panel, inside the deck root so the zoom's transform scales it. */
const PROBE_JS = `(function () {
  var old = document.getElementById('at0713-probe');
  if (old !== null) old.remove();
  var panel = document.createElement('div');
  panel.id = 'at0713-probe';
  panel.style.cssText = 'position:fixed;left:40px;top:40px;z-index:2147483647;' +
    'background:#000;color:#fff;padding:12px;pointer-events:none;' +
    'font:600 24px/1 -apple-system, "Helvetica Neue", sans-serif;letter-spacing:8px;';
  var run = document.createElement('span');
  run.id = 'at0713-run';
  run.textContent = '${"I".repeat(STEMS)}';
  panel.appendChild(run);
  document.getElementById('deck-container').appendChild(panel);
  return true;
})()`;

interface RunProbe {
  innerWidth: number;
  /** Viewport rect of the glyph run: left, top, width, height. */
  rect: [number, number, number, number];
}

const RUN_JS = `(function () {
  var range = document.createRange();
  range.selectNodeContents(document.getElementById('at0713-run'));
  var r = range.getBoundingClientRect();
  return { innerWidth: window.innerWidth, rect: [r.left, r.top, r.width, r.height] };
})()`;

interface EdgeReading {
  factor: number;
  /** Mean device px an edge spends between the dark and light levels. */
  meanEdgePx: number;
  /** Stems found on the median scanline — the crop's sanity check. */
  stems: number;
  /** Stem width in device px, mean over the scanlines. */
  stemPx: number;
  scanlines: number;
}

async function readEdges(app: App, factor: number): Promise<EdgeReading> {
  expect(await app.setPageZoom(factor)).toBeCloseTo(factor, 5);
  // The readout fades on its own and sits at the canvas centre, clear of the
  // probe; this wait is for the root's layer to finish its re-raster.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const probe = await app.evalJS<RunProbe>(RUN_JS);
  const shot = await app.screenshot();
  const png = decodePngFile(shot.path);
  const scale = png.width / probe.innerWidth;
  const [l, t, w, h] = probe.rect;
  const x0 = Math.round(l * scale);
  const x1 = Math.round((l + w) * scale);
  // The middle half of the run's line box: the stems' straight shafts, clear
  // of the serifless caps' ends.
  const y0 = Math.round((t + h * 0.3) * scale);
  const y1 = Math.round((t + h * 0.6) * scale);

  const edges: number[] = [];
  const widths: number[] = [];
  const stemCounts: number[] = [];
  for (let y = y0; y < y1; y++) {
    const row: number[] = [];
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      row.push(0.2126 * png.rgba[i]! + 0.7152 * png.rgba[i + 1]! + 0.0722 * png.rgba[i + 2]!);
    }
    const lo = Math.min(...row);
    const hi = Math.max(...row);
    if (hi - lo < 100) continue;
    const dark = lo + (hi - lo) * 0.15;
    const light = lo + (hi - lo) * 0.85;
    const mid = (lo + hi) / 2;
    // Walk the scanline: each run of pixels strictly between `dark` and
    // `light` that sits on a crossing of the midpoint is one edge.
    let stems = 0;
    let rising = -1;
    let x = 0;
    while (x < row.length) {
      if (row[x]! > dark && row[x]! < light) {
        const start = x;
        while (x < row.length && row[x]! > dark && row[x]! < light) x++;
        const before = start > 0 ? row[start - 1]! : lo;
        const after = x < row.length ? row[x]! : lo;
        if ((before < mid) !== (after < mid)) {
          edges.push(x - start);
          if (after >= mid) {
            rising = start;
          } else if (rising >= 0) {
            stems += 1;
            widths.push(x - rising);
            rising = -1;
          }
        }
        continue;
      }
      const prev = x > 0 ? row[x - 1]! : lo;
      if (prev <= dark && row[x]! >= light) {
        edges.push(0);
        rising = x;
      } else if (prev >= light && row[x]! <= dark) {
        edges.push(0);
        if (rising >= 0) {
          stems += 1;
          widths.push(x - rising);
          rising = -1;
        }
      }
      x++;
    }
    stemCounts.push(stems);
  }
  const mean = (xs: number[]): number =>
    xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
  stemCounts.sort((a, b) => a - b);
  return {
    factor,
    meanEdgePx: Math.round(mean(edges) * 100) / 100,
    stems: stemCounts[Math.floor(stemCounts.length / 2)] ?? 0,
    stemPx: Math.round(mean(widths) * 100) / 100,
    scanlines: stemCounts.length,
  };
}

describe.skipIf(!SHOULD_RUN)("AT0713: View › Zoom rasterizes at scale", () => {
  test(
    "a glyph run's stem edges at 0.5 and 2.0 are no softer than at 1.0",
    async () => {
      const app = await launchTugApp({ testName: "at0713-zoom-raster-crisp" });
      try {
        await app.evalJS<boolean>(PROBE_JS);
        const at1 = await readEdges(app, 1);
        const at2 = await readEdges(app, 2);
        const atHalf = await readEdges(app, 0.5);
        await app.setPageZoom(1);
        note("stem edges by factor (device px)", { at1, at2, atHalf });

        for (const reading of [at1, at2, atHalf]) {
          // The crop found the run: every stem, on scanlines with real contrast.
          expect(reading.scanlines).toBeGreaterThan(3);
          expect(reading.stems).toBe(STEMS);
        }
        // The stems themselves scaled — the zoom happened in the pixels.
        expect(at2.stemPx).toBeGreaterThan(at1.stemPx * 1.6);
        // And their edges did not soften with them.
        expect(at2.meanEdgePx).toBeLessThanOrEqual(at1.meanEdgePx + SOFTNESS_TOLERANCE);
        expect(atHalf.meanEdgePx).toBeLessThanOrEqual(at1.meanEdgePx + SOFTNESS_TOLERANCE);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
