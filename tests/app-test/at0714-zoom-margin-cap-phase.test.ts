/**
 * at0714-zoom-margin-cap-phase.test.ts — under View › Zoom a margin cap's
 * grid stays in phase with the deck's own.
 *
 * | Test                 | What would break without it                        |
 * |----------------------|----------------------------------------------------|
 * | cap lines on the     | a cap pattern anchored to its own box (what WebKit |
 * | root's 24 px lattice | does to `background-attachment: fixed` inside a    |
 * |                      | transformed ancestor), so the right cap's vertical |
 * |                      | lines sit off the grid beside it at every factor   |
 * |                      | but 1                                              |
 *
 * The root paints its grid from its own corner; a cap repeats that grid
 * (`margin-cap.css`) and must land on the same lattice. A real cap is five px
 * wide, too narrow to read a phase from, so the rule is exercised on boxes that
 * wear the real cap classes at a readable width, standing where a canvas-wide
 * host puts them, with the grid inked white on black so the lines can be found.
 * Two right-hand widths twelve px apart: whatever the window, one of them sits
 * at least six px off the lattice if the phase is not stated.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/chrome/margin-cap.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { decodePngFile } from "./_harness/png";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const FACTORS = [1, 0.5, 0.7, 2] as const;
const GRID_PX = 24;
/** Layout-px slack on a line's lattice position: antialiasing and rounding. */
const SLACK_PX = 1;
/** A pixel counts as line ink above this red level, on black. */
const LIT = 40;

const PROBES = [
  { id: "left-301", side: "left", width: 301 },
  { id: "right-301", side: "right", width: 301 },
  { id: "right-313", side: "right", width: 313 },
] as const;

/** A canvas-wide host inside the root, holding the cap-classed probes. */
const PROBE_JS = `(function () {
  var old = document.getElementById('at0714-host');
  if (old !== null) old.remove();
  var host = document.createElement('div');
  host.id = 'at0714-host';
  host.style.cssText = 'position:absolute;inset:0;z-index:2147483647;pointer-events:none;' +
    '--tug7-surface-global-primary-normal-canvas-rest:#000;' +
    '--tug7-surface-global-primary-normal-grid-rest:#fff;--tugx-rail-tint:0;';
  ${JSON.stringify(PROBES)}.forEach(function (p, i) {
    var d = document.createElement('div');
    d.id = 'at0714-' + p.id;
    d.className = 'tug-margin-cap tug-margin-cap--' + p.side;
    d.style.width = p.width + 'px';
    d.style.setProperty('--tugx-margin-cap-width', p.width + 'px');
    d.style.top = (120 + i * 60) + 'px';
    d.style.bottom = 'auto';
    d.style.height = '30px';
    host.appendChild(d);
  });
  document.getElementById('deck-container').appendChild(host);
  return true;
})()`;

const RECTS_JS = `(function () {
  return {
    innerWidth: window.innerWidth,
    rects: ${JSON.stringify(PROBES.map((p) => p.id))}.map(function (id) {
      var r = document.getElementById('at0714-' + id).getBoundingClientRect();
      return [r.left, r.top, r.width, r.height];
    }),
  };
})()`;

/**
 * Device-px centre of each grid line along one scanline: the luminance-
 * weighted centroid of every run of lit pixels, so a one-px line the
 * antialiasing split across two device px still reads as one line where it is.
 */
function lineCentres(
  png: { width: number; rgba: Uint8Array },
  y: number,
  x0: number,
  x1: number,
): number[] {
  const out: number[] = [];
  let x = x0;
  while (x < x1) {
    if (png.rgba[(y * png.width + x) * 4]! <= LIT) {
      x++;
      continue;
    }
    let sum = 0;
    let weighted = 0;
    while (x < x1 && png.rgba[(y * png.width + x) * 4]! > LIT) {
      const lum = png.rgba[(y * png.width + x) * 4]!;
      sum += lum;
      weighted += lum * (x + 0.5);
      x++;
    }
    out.push(weighted / sum);
  }
  return out;
}

/** How far a root-layout x is from the nearest grid line's centre (lines are 1 px, from each multiple of 24). */
function offLattice(layoutX: number): number {
  const r = (((layoutX - 0.5) % GRID_PX) + GRID_PX) % GRID_PX;
  return Math.min(r, GRID_PX - r);
}

describe.skipIf(!SHOULD_RUN)("AT0714: margin caps keep the grid's phase under View › Zoom", () => {
  test(
    "every cap line falls on the root's 24 px lattice at 50 %, 70 %, 100 % and 200 %",
    async () => {
      const app = await launchTugApp({ testName: "at0714-zoom-margin-cap-phase" });
      try {
        await app.evalJS<boolean>(PROBE_JS);
        for (const f of FACTORS) {
          expect(await app.setPageZoom(f)).toBeCloseTo(f, 5);
          // The root's layer re-rasters after the step settles.
          await new Promise((resolve) => setTimeout(resolve, 600));
          const m = await app.evalJS<{ innerWidth: number; rects: number[][] }>(RECTS_JS);
          const png = decodePngFile((await app.screenshot()).path);
          const s = png.width / m.innerWidth;
          const readings = PROBES.map((p, i) => {
            const [l, t, w, h] = m.rects[i]!;
            const centres = lineCentres(
              png,
              Math.round((t! + h! / 2) * s),
              Math.round(l! * s) + 1,
              Math.round((l! + w!) * s) - 1,
            );
            // Device px → root layout px: the root's corner is the window's.
            const worst = Math.max(0, ...centres.map((x) => offLattice(x / s / f)));
            return { id: p.id, lines: centres.length, worst: Math.round(worst * 100) / 100 };
          });
          note(`factor ${f}`, readings);
          for (const r of readings) {
            expect(r.lines, `${r.id} at ${f}: the probe drew grid lines`).toBeGreaterThan(5);
            expect(r.worst, `${r.id} at ${f}: lines on the root's lattice`).toBeLessThanOrEqual(
              SLACK_PX,
            );
          }
        }
        await app.setPageZoom(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
