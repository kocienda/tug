/**
 * row-22-compaction-cover.test.ts — a body's Compacting cover rests where the
 * card's does: on the rest line above Z2, not at the top of the transcript.
 *
 * The cover is a bottom-anchored sheet: it pins its clip's bottom edge to the
 * view slot's (`MODAL_REST_LINE`) and sizes itself against the visible canvas
 * (`paneCanvasOf`). A body's page had no canvas, so the sheet's measure
 * refused every reading and the cover kept its default top anchor, hanging
 * from the masthead. The body page now stands its viewport as the canvas.
 *
 * A body Session card on a stub whose one turn streams long enough to hold
 * the run open, `/compact` submitted through its composer on the session tap.
 * Read in the body's own DOM (the clip's written `bottom`, the panel's box
 * against the view slot and Z2) and by composite colour: a column through
 * the panel, where its paint ends, against the rest line in window points.
 *
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/components/tugways/cards/session-compaction-run.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, focusBody, pollFor, spawnStub, waitForBody } from "./_bodies";
import { near, type Rgb } from "./_frames";

const TEST_NAME = "body-grounding-row-22-compaction-cover";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "r22-a";
const COMPACTION = '[data-slot="compaction-progress"]';
/** How far above the rest line a resting panel's bottom may stand: its own margin, not a transcript's height. */
const REST_REACH_PT = 32;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface CoverReading {
  panel: Box;
  slot: Box;
  z2: Box | null;
  clipBottom: string;
  canvas: boolean;
}

const READ_COVER = `(function () {
  var box = function (el) { if (el === null) return null; var r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  var c = document.querySelector(${JSON.stringify(COMPACTION)});
  if (c === null) return null;
  var panel = c.closest('[data-slot="tug-sheet"]');
  var clip = c.closest('.tug-sheet-clip');
  return {
    panel: box(panel),
    slot: box(document.querySelector('.session-view-slot')),
    z2: box(document.querySelector('.session-card-status-bar')),
    clipBottom: clip === null ? "" : clip.style.bottom,
    canvas: document.querySelector('[data-deck-canvas-background]') !== null,
  };
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 22: a body's Compacting cover rests on the rest line", () => {
  test(
    "the cover's bottom edge stands on the view slot's, above Z2, by DOM and by composite",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [{ id: A, componentId: "session", title: "A", closable: true }],
            panes: [
              {
                id: `${A}-pane`,
                position: { x: 40, y: 40 },
                size: { width: 900, height: 720 },
                cardIds: [A],
                activeCardId: A,
                title: "",
                acceptsFamilies: ["maker"],
              },
            ],
            activePaneId: `${A}-pane`,
            hasFocus: true,
          },
          focusCardId: A,
        });
        // One turn, long enough to stream through the whole reading: the
        // `/compact` is that turn, and the run stays open while it streams.
        await spawnStub(app, A, stubDir, 40, 1);
        await waitForBody(app, A);
        await focusBody(app, A);
        const body = app.body(A);

        await app.nativeType("/compact");
        await Bun.sleep(200);
        await app.nativeKey("Escape"); // the completion popup
        await Bun.sleep(200);
        await app.nativeKey("Return", ["cmd"]);
        await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(COMPACTION)}) !== null`, { timeoutMs: 8_000 });
        // The entrance runs; read the cover at rest.
        await Bun.sleep(800);

        const dom = await body.evalJS<CoverReading | null>(READ_COVER);
        note(`cover in the body: ${JSON.stringify(dom)}`);
        expect(dom, "the Compacting cover stands in the body").not.toBeNull();
        expect(dom!.canvas, "the body page stands a canvas").toBe(true);
        expect(dom!.clipBottom, "the sheet measured and wrote its clip's bottom edge").not.toBe("");
        const rest = dom!.slot.bottom;
        expect(dom!.panel.bottom, "the panel's bottom stands at or above the rest line").toBeLessThanOrEqual(rest + 1);
        expect(dom!.panel.bottom, "the panel rests on the rest line, not under the masthead").toBeGreaterThan(rest - REST_REACH_PT);
        if (dom!.z2 !== null) expect(dom!.panel.bottom, "the panel leaves Z2 clear").toBeLessThanOrEqual(dom!.z2.top + 1);

        // The composite: a column through the panel's left padding, from
        // inside it down past the rest line; where its fill ends.
        const frame = (await bodyOf(app, A))!.frame;
        const x = frame.x + dom!.panel.left + 6;
        const mid = (dom!.panel.top + dom!.panel.bottom) / 2;
        const crop = {
          x: Math.floor(x),
          y: Math.floor(frame.y + mid),
          width: 2,
          height: Math.ceil(rest + 40 - mid),
        };
        await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop });
        const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
        const png = decodePngFile(reading.frames[reading.frames.length - 1].path);
        const at = (row: number): Rgb => {
          const i = row * png.width * 4;
          return { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
        };
        const fill = at(0);
        let edge: number | null = null;
        for (let row = 1; row + 2 < png.height; row++) {
          if (!near(at(row), fill, 6) && !near(at(row + 1), fill, 6) && !near(at(row + 2), fill, 6)) {
            edge = row;
            break;
          }
        }
        const edgePt = edge === null ? null : crop.y + edge / reading.scale;
        const restPt = frame.y + rest;
        note(`panel fill ${JSON.stringify(fill)}; its paint ends at ${edgePt} pt; the rest line at ${restPt} pt`);
        expect(edgePt, "the panel's paint ends inside the column read").not.toBeNull();
        expect(edgePt!, "by composite, the cover ends at or above the rest line").toBeLessThanOrEqual(restPt + 1);
        expect(edgePt!, "by composite, the cover rests on the rest line").toBeGreaterThan(restPt - REST_REACH_PT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
