/**
 * at0686 — a drag begun on a pane mid-settle takes the frame from the settle.
 *
 * A pane dragged past the threshold is pointer-owned: the drag writes the
 * frame's inline `transform` every frame and nothing else may. A settle
 * already running on that frame when the drag begins is the one other writer
 * there is — its beat's effect sits over the inline transform until the beat
 * ends, and its landing then takes the inline transform off — so a pane
 * grabbed while the flow slides would ride the beat rather than the hand, and
 * then jump when the beat landed.
 *
 * The probe activates the last card of a flow deck so every band frame
 * slides, presses a moving pane's grab handle while it travels, drags it down
 * and holds it still through the moment the slide would have landed. While the
 * pointer is still, the frame must stand still too: the offset between the
 * frame and the pointer may not move by more than a pixel.
 *
 * `tug-pane.tsx` is the hub at its fan-out ceiling, so the pane's half is
 * named by the module its drag and resize thresholds call.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/settle-take.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  blobFor,
  home,
  launch,
  wait,
} from "./settle-frames-fixture";

const TEST_NAME = "at0686-drag-takes-frame-from-settle";
const COUNT = 6;
const PANE_ID = "at0622-p2";
const FRAME = `[data-space-layer][data-space-shown] .tug-pane[data-pane-id="${PANE_ID}"]`;
/**
 * The press goes on the grab handle, the one surface a content card's drag
 * starts from (`06889db93`). The bar's centre was pressed until the settle
 * fixture bound every card to a real transcript, whose masthead fills that
 * centre: the press then landed on the title text, started no gesture, and
 * the pane was never pointer-owned.
 */
const BAR = `${FRAME} .tug-pane-title-bar .tug-pane-grab-handle`;
/** How far down the drag carries the pane. */
const DRAG_DY = 120;
/** How long the pointer is held still after the trail: past the slide's land. */
const HOLD_MS = 900;

interface Sample {
  t: number;
  left: number;
  top: number;
  owned: boolean;
  px: number | null;
  py: number | null;
  transform: string;
}

/** Arm a per-frame sampler of the pane's rect and the pointer's last position. */
async function armSampler(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__at0686 = { samples: [], px: null, py: null, stop: false });
      var t0 = performance.now();
      window.addEventListener("pointermove", function (e) { rec.px = e.clientX; rec.py = e.clientY; }, true);
      window.addEventListener("pointerdown", function (e) { rec.px = e.clientX; rec.py = e.clientY; }, true);
      var tick = function () {
        var frame = document.querySelector(${JSON.stringify(FRAME)});
        if (frame !== null) {
          var r = frame.getBoundingClientRect();
          rec.samples.push({
            t: performance.now() - t0,
            left: r.left,
            top: r.top,
            owned: frame.hasAttribute("data-pointer-owned"),
            px: rec.px,
            py: rec.py,
            transform: frame.style.transform,
          });
        }
        if (!rec.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0686 — a drag begun mid-settle owns its frame", () => {
  test(
    "a pane grabbed while the flow slides follows the hand, and stands still when the hand does",
    async () => {
      const { app, tugbankPath } = await launch(COUNT, blobFor(COUNT), TEST_NAME);
      try {
        await home(app);
        await armSampler(app);
        // The slide, and the grab while the pane is travelling.
        const grab = await app.evalJS<{ x: number; y: number; t: number }>(
          `(function () {
            window.__tug.dispatchControlAction("focus-session-card", { cardId: "at0622-c${COUNT}" });
            var r = document.querySelector(${JSON.stringify(BAR)}).getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: performance.now() };
          })()`,
        );
        // The grab is timed from the slide's first moving frame, not from the
        // dispatch. Under set-up-and-go the frame stands at First for the
        // lead, which varies run to run (70 ms and longer on real
        // transcripts), so a fixed wait sometimes pressed before the settle
        // launched and read a take of a frame that was not sliding yet.
        await app.waitForCondition<boolean>(
          `(function () {
            var s = window.__at0686.samples;
            return s.length > 1 && Math.abs(s[s.length - 1].left - s[0].left) > 20;
          })()`,
          { timeoutMs: 2_000 },
        );
        const from = await app.evalJS<{ x: number; y: number; t: number }>(
          `(function () {
            var r = document.querySelector(${JSON.stringify(BAR)}).getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: performance.now() };
          })()`,
        );
        // Where the bar was at the dispatch, and where and when the slide's
        // first moving frames had carried it.
        note(
          `at0686 grab: bar at dispatch x=${grab.x.toFixed(1)}, ` +
            `read ${(from.t - grab.t).toFixed(1)} ms later at x=${from.x.toFixed(1)}`,
        );
        const to = { x: from.x, y: from.y + DRAG_DY };
        await app.nativeDragWithoutRelease(from, to);
        const holdFrom = await app.evalJS<number>(
          `window.__at0686.samples.length`,
        );
        await wait(HOLD_MS);
        const holdTo = await app.evalJS<number>(
          `window.__at0686.samples.length`,
        );
        await app.nativeMouseUp(to);
        await wait(AFTER_LAND_MS);
        const samples = await app.evalJS<Sample[]>(
          `(window.__at0686.stop = true, window.__at0686.samples)`,
        );

        // The pane was moving when it was grabbed.
        const preGrab = samples.filter((s) => !s.owned && s.px === null);
        const travelled =
          preGrab.length > 1
            ? Math.abs(preGrab[preGrab.length - 1].left - preGrab[0].left)
            : 0;
        // The hold: the pointer still, the pane owned, the slide landing under it.
        const held = samples
          .slice(holdFrom, holdTo)
          .filter((s) => s.owned && s.px !== null && s.py !== null);
        const dxs = held.map((s) => s.left - (s.px as number));
        const dys = held.map((s) => s.top - (s.py as number));
        const spread = (xs: number[]): number =>
          xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
        const changes = held
          .map((s, i) => (i > 0 && s.transform !== held[i - 1].transform ? `${Math.round(s.t)}ms ${s.transform}` : null))
          .filter((s) => s !== null);
        note(
          "drag",
          `grab at ${Math.round(grab.x)},${Math.round(grab.y)} travelled before the grab=${travelled.toFixed(1)}px ` +
            `held samples=${held.length} spread x=${spread(dxs).toFixed(2)} y=${spread(dys).toFixed(2)} ` +
            `transform changes under a still pointer=${changes.length}${changes.length > 0 ? ` (${changes.slice(0, 4).join("; ")})` : ""}`,
        );

        expect(travelled, "the pane was sliding when it was grabbed").toBeGreaterThan(1);
        expect(held.length, "the hold was sampled with the pane pointer-owned").toBeGreaterThan(20);
        expect(
          { x: spread(dxs) <= 1, y: spread(dys) <= 1 },
          "a pane held still under a still pointer stands still: nothing but the drag moves it",
        ).toEqual({ x: true, y: true });
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
