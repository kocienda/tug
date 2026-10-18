/**
 * at0205-atom-chip-first-paint.test.ts — an image dropped into the Dev
 * prompt must show its atom-chip label on the FIRST paint, with no view
 * "jiggle" required.
 *
 * ## The regression this pins
 *
 * The editor bakes atom chips into `<img src="data:...">` documents.
 * When the bake relied on an `@font-face` embedded inside the image's
 * own SVG document, WebKit could rasterize the image before the
 * embedded font finished loading — painting the label invisibly — and
 * never re-rasterize on its own. The chip sat labelless (icon + blank
 * width) until something invalidated the view: scroll, resize, theme
 * switch. The path only triggers on the Session card: its
 * `EditorSettingsStore` calls `setAtomFont` with the Plex editor stack,
 * whose `@font-face` faces are embeddable — a gallery editor stays on
 * `system-ui` and always took the generic-fallback path.
 *
 * DOM inspection cannot see this state — the `<img>` node, its data
 * attributes, and its `src` are all correct; only the compositor's
 * raster is wrong. So this test asserts on REAL pixels: screenshot the
 * live app (`WKWebView.takeSnapshot`), crop the chip's label region,
 * and require actual text-vs-surface contrast.
 *
 * ## Shape
 *
 *   1. Boot a Session card, bind a session, let fonts settle (the bug
 *      needs the atom-font database warm before the first bake).
 *   2. Drop a real PNG `File` on the prompt editor via a synthesized
 *      `drop` DragEvent — drives the production
 *      `processAttachmentFiles` pipeline (downsample, bytes store,
 *      `image-1` labeling) end to end.
 *   3. Screenshot as soon as the chip `<img>` has decoded; assert the
 *      chip's label region contains contrasting (text) pixels.
 *   4. Force a repaint of the chip (visibility toggle — the
 *      programmatic "jiggle"), re-screenshot, and require BOTH that
 *      the label is still detectable (detector control) AND that the
 *      label region is pixel-stable across the repaint — a first
 *      paint in a fallback font that later swaps to the real face
 *      passes the presence check but fails stability.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/tug-atom-chip.tsx
 * @covers tugdeck/src/lib/tug-atom-img.ts
 * @covers tugdeck/src/lib/atom-bytes-store.ts
 * @covers tugdeck/src/lib/image-downsample.ts
 */

import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { launchTugApp, type App } from "./_harness";
import { decodePngFile } from "./_harness/png";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 90_000;

const EDITOR_HOST_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-editor"]';

const ATOM_IMG_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content img[data-atom-label]';

const SESSION_DECK_STATE = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 720, height: 540 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

/** Viewport-relative chip rect + the CSS-px→snapshot-px scale basis. */
interface ChipRect {
  left: number;
  top: number;
  width: number;
  height: number;
  innerWidth: number;
}

async function readChipRect(app: App): Promise<ChipRect> {
  return app.body("A").evalJS<ChipRect>(
    `(function(){
      var img = document.querySelector(${JSON.stringify(ATOM_IMG_SELECTOR)});
      var r = img.getBoundingClientRect();
      return {
        left: r.left, top: r.top, width: r.width, height: r.height,
        innerWidth: window.innerWidth,
      };
    })()`,
  );
}

/** RGB bytes of the chip's label region, cropped out of a snapshot. */
interface LabelRegion {
  width: number;
  height: number;
  /** width * height * 3 bytes, row-major RGB. */
  rgb: Uint8Array;
}

/**
 * Crop the chip's label region out of a snapshot.
 *
 * Region: the right 55% of the chip (clear of the leading icon), inset
 * 4 CSS px from the right edge (clear of the inset hairline) and 25%
 * from top/bottom (clear of the recess top shade).
 */
function cropLabelRegion(pngPath: string, chip: ChipRect): LabelRegion {
  const png = decodePngFile(pngPath);
  const scale = png.width / chip.innerWidth;

  const x0 = Math.round((chip.left + chip.width * 0.45) * scale);
  const x1 = Math.round((chip.left + chip.width - 4) * scale);
  const y0 = Math.round((chip.top + chip.height * 0.25) * scale);
  const y1 = Math.round((chip.top + chip.height * 0.75) * scale);

  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const rgb = new Uint8Array(width * height * 3);
  let at = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      rgb[at++] = png.rgba[i]!;
      rgb[at++] = png.rgba[i + 1]!;
      rgb[at++] = png.rgba[i + 2]!;
    }
  }
  return { width, height, rgb };
}

/**
 * Count "text" pixels in a label region: a pixel counts when any RGB
 * channel deviates from the region's median by more than 40 — the
 * label token vs. surface token contrast is far above that; a blank
 * chip's wash + gradient stays far below.
 */
function countLabelPixels(region: LabelRegion): number {
  const n = region.width * region.height;
  const rs: number[] = new Array(n);
  const gs: number[] = new Array(n);
  const bs: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    rs[i] = region.rgb[i * 3]!;
    gs[i] = region.rgb[i * 3 + 1]!;
    bs[i] = region.rgb[i * 3 + 2]!;
  }
  const median = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    return s[s.length >> 1]!;
  };
  const mr = median(rs);
  const mg = median(gs);
  const mb = median(bs);

  let count = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.max(
      Math.abs(rs[i]! - mr),
      Math.abs(gs[i]! - mg),
      Math.abs(bs[i]! - mb),
    );
    if (d > 40) count += 1;
  }
  return count;
}

/**
 * Fraction of pixels that differ between two same-sized label regions
 * (any channel apart by more than 24). The first paint and the
 * post-repaint state must show the SAME pixels — a first paint in a
 * fallback font that later swaps to the real face has visible label
 * pixels in both shots but fails this comparison.
 */
function fractionDiffering(a: LabelRegion, b: LabelRegion): number {
  const n = Math.min(a.rgb.length, b.rgb.length) / 3;
  if (n === 0) return 1;
  let differing = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.max(
      Math.abs(a.rgb[i * 3]! - b.rgb[i * 3]!),
      Math.abs(a.rgb[i * 3 + 1]! - b.rgb[i * 3 + 1]!),
      Math.abs(a.rgb[i * 3 + 2]! - b.rgb[i * 3 + 2]!),
    );
    if (d > 24) differing += 1;
  }
  return differing / n;
}

/**
 * Synthesize a real PNG `File` in-page (canvas → blob) and dispatch a
 * `drop` DragEvent carrying it on the prompt editor host — the same
 * event the OS delivers for a Finder drag, driving the production
 * drop pipeline end to end. `evalJS` can't await, so completion is
 * signalled through `window.__at0205Dropped` and polled.
 */
async function dropPngOnEditor(app: App): Promise<void> {
  await app.body("A").evalJS<void>(
    `(function(){
      window.__at0205Dropped = false;
      var host = document.querySelector(${JSON.stringify(EDITOR_HOST_SELECTOR)});
      var canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 64;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#334455"; ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#ccddee"; ctx.fillRect(8, 8, 48, 48);
      canvas.toBlob(function(blob){
        var file = new File([blob], "sample.png", { type: "image/png" });
        var dt = new DataTransfer();
        dt.items.add(file);
        var r = host.getBoundingClientRect();
        var ev = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + 12,
        });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
        host.dispatchEvent(ev);
        window.__at0205Dropped = true;
      }, "image/png");
    })()`,
  );
  // The flag was set in A's body, by the drop above.
  await app.body("A").waitForCondition<boolean>(
    `window.__at0205Dropped === true`,
    { timeoutMs: 5_000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0205: atom chip label paints on first raster",
  () => {
    test(
      "image dropped on the Dev prompt shows its chip label without a repaint jiggle",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);

          const app = await launchTugApp({
            testName: "at0205-atom-chip-first-paint",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });

          try {
            await app.enableDeckTrace(true);
            await app.seedDeckState({ state: SESSION_DECK_STATE, focusCardId: "A" });
            await new Promise<void>((r) => setTimeout(r, 1500));
            await app.bindSession("A");
            await app.body("A").waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(`${EDITOR_HOST_SELECTOR} .cm-content`)}) !== null`,
              { timeoutMs: 10_000 },
            );

            // Let font loading fully settle BEFORE the first chip
            // bake — the regression only reproduced once the atom-font
            // database was warm (a cold bake fell back to a generic
            // family, which always painted). The bake runs in card A's
            // body, which loads its own fonts, so it is that page's
            // font set that has to settle.
            //
            // Settled is read face by face — none still `loading` — rather
            // than off the set's own `status`. In a body page the CJK Bold
            // subsets the page asks for end in `error`, and WebKit then
            // leaves the set's `status` at "loading" and its `ready`
            // unresolved for good, with no face loading at all (read in
            // probed runs, 2026-10-18).
            await app.body("A").waitForCondition<boolean>(
              `(function () {
                 if (document.fonts.size === 0) return false;
                 var loading = 0;
                 document.fonts.forEach(function (face) { if (face.status === "loading") loading++; });
                 return loading === 0 &&
                   document.fonts.check('14px "IBM Plex Sans"') &&
                   document.fonts.check('13px "IBM Plex Mono"');
               })()`,
              { timeoutMs: 10_000 },
            );
            await new Promise((r) => setTimeout(r, 1_000));

            // First chip bake of the session: real PNG file drop.
            await dropPngOnEditor(app);
            await app.body("A").waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(ATOM_IMG_SELECTOR)}) !== null`,
              { timeoutMs: 5_000 },
            );
            // Wait ONLY for the chip <img> itself to decode, then a
            // beat for the compositor to commit — the first-raster
            // window is what this test exists to observe, so no long
            // settle that would let a late font swap slip past.
            await app.body("A").waitForCondition<boolean>(
              `(function(){
                var img = document.querySelector(${JSON.stringify(ATOM_IMG_SELECTOR)});
                if (img === null) return false;
                if (window.__at0205Decoded === undefined) {
                  window.__at0205Decoded = "pending";
                  img.decode().then(
                    function(){ window.__at0205Decoded = "done"; },
                    function(){ window.__at0205Decoded = "done"; }
                  );
                  return false;
                }
                return window.__at0205Decoded === "done";
              })()`,
              { timeoutMs: 5_000 },
            );
            await new Promise((r) => setTimeout(r, 150));

            const chip = await readChipRect(app);
            expect(chip.width).toBeGreaterThan(20);

            // The chip is painted by A's body view, and its rect is in that
            // view's viewport, so the shot is of the body.
            const shot1 = await app.body("A").screenshot();
            let firstPaint: LabelRegion;
            try {
              firstPaint = cropLabelRegion(shot1.path, chip);
            } finally {
              if (process.env.AT0205_KEEP_SHOTS === "1") {
                console.log(`shot1: ${shot1.path} chip=${JSON.stringify(chip)}`);
              } else {
                unlinkSync(shot1.path);
              }
            }

            // Detector control: force a repaint of the chip (the
            // programmatic "jiggle") and require the label to be
            // detectable afterwards. Guards the threshold: if this
            // fails, the detector is broken, not the chip.
            await app.body("A").evalJS<void>(
              `(function(){
                var img = document.querySelector(${JSON.stringify(ATOM_IMG_SELECTOR)});
                img.style.visibility = "hidden";
                void img.offsetWidth;
                requestAnimationFrame(function(){ img.style.visibility = ""; });
              })()`,
            );
            await new Promise((r) => setTimeout(r, 400));

            const shot2 = await app.body("A").screenshot();
            let afterRepaint: LabelRegion;
            try {
              afterRepaint = cropLabelRegion(shot2.path, chip);
            } finally {
              if (process.env.AT0205_KEEP_SHOTS === "1") {
                console.log(`shot2: ${shot2.path}`);
              } else {
                unlinkSync(shot2.path);
              }
            }

            const firstPaintLabelPixels = countLabelPixels(firstPaint);
            const afterRepaintLabelPixels = countLabelPixels(afterRepaint);
            const flipFraction = fractionDiffering(firstPaint, afterRepaint);
            if (process.env.AT0205_KEEP_SHOTS === "1") {
              console.log(
                `labelPixels first=${firstPaintLabelPixels} after=${afterRepaintLabelPixels} flipFraction=${flipFraction.toFixed(4)}`,
              );
            }

            expect(
              afterRepaintLabelPixels,
              "detector control: label must be visible after a forced repaint",
            ).toBeGreaterThan(10);

            expect(
              firstPaintLabelPixels,
              "atom label must paint on the FIRST raster — a blank chip until a view jiggle is the regression this test pins",
            ).toBeGreaterThan(10);

            expect(
              flipFraction,
              "the first raster must BE the final raster — a label that paints in a fallback font and later swaps to the real face is the lag this test pins",
            ).toBeLessThan(0.01);
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
