/**
 * at0686 — a drag begun on a card mid-settle takes the card from the settle.
 *
 * A Session card draws its own chrome and is one view the host carries: its
 * grab handle's press hands the card to the host, which moves the view under
 * the hand until the mouse comes up. A settle already carrying that view when
 * the press lands is the one other mover there is — its beats run on the view
 * as Core Animation — so a card grabbed while the flow slides would ride the
 * beats rather than the hand, and then jump when they landed.
 *
 * The probe activates the last card of a flow deck so every band frame
 * slides, presses a moving card's grab handle where the host has it, drags it
 * down and holds it still through the moment the slide would have landed.
 * While the pointer is still, the card must stand still too: the host's
 * presented frame may not move by more than a pixel.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/settle-take.ts
 * @covers tugapp/Sources/BodyViewController.swift
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
/** The card in that pane: a Session card, which draws its own chrome and is one view the host carries. */
const CARD = "at0622-c2";
/**
 * The press goes on the grab handle, in the card's own page: the one surface
 * a content card's drag starts from (`06889db93`).
 */
const HANDLE = ".tug-pane-title-bar .tug-pane-grab-handle";
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
  // card-dom: shell — the stand-in frame's rect, and the shell's own pointer events.
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
        // The slide, started; the grab is timed from its first moving frame,
        // not from the dispatch. Under set-up-and-go the frame stands at First
        // for the lead, which varies run to run, so a fixed wait sometimes
        // pressed before the settle launched and read a take of a frame that
        // was not sliding yet.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("focus-session-card", { cardId: "at0622-c${COUNT}" }), null)`,
        );
        await app.waitForCondition<boolean>(
          `(function () {
            var s = window.__at0686.samples;
            return s.length > 1 && Math.abs(s[s.length - 1].left - s[0].left) > 20;
          })()`,
          { timeoutMs: 2_000 },
        );
        // The card draws its own chrome, and the host carries its view: the
        // press goes on its grab handle where the host has the view now, mid-
        // slide, which is where the user sees it.
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.presentedFrame;
        const handle = (await app.body(CARD).evalJS<{ x: number; y: number; width: number; height: number }>(
          `(function () {
            var r = document.querySelector(${JSON.stringify(HANDLE)}).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })()`,
        ))!;
        const from = { x: view.x + handle.x + handle.width / 2, y: view.y + handle.y + handle.height / 2 };
        const grabbedAt = await app.evalJS<number>(`window.__at0686.samples.length`);
        const to = { x: from.x, y: from.y + DRAG_DY };
        await app.nativeDragWithoutRelease(from, to);
        // The hold: the pointer still, the card in the host's hand, the slide
        // landing under it. Read the view where the host has it, repeatedly.
        const held: Array<{ x: number; y: number }> = [];
        const holdEnd = Date.now() + HOLD_MS;
        while (Date.now() < holdEnd) {
          const f = (await app.bodies()).find((b) => b.cardId === CARD)?.presentedFrame;
          if (f !== undefined) held.push({ x: f.x, y: f.y });
          await wait(25);
        }
        await app.nativeMouseUp(to);
        await wait(AFTER_LAND_MS);
        const samples = await app.evalJS<Sample[]>(
          `(window.__at0686.stop = true, window.__at0686.samples)`,
        );

        // The pane was moving when it was grabbed.
        const preGrab = samples.slice(0, grabbedAt);
        const travelled =
          preGrab.length > 1
            ? Math.abs(preGrab[preGrab.length - 1].left - preGrab[0].left)
            : 0;
        const spread = (xs: number[]): number =>
          xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
        note(
          "drag",
          `grab at ${Math.round(from.x)},${Math.round(from.y)} travelled before the grab=${travelled.toFixed(1)}px ` +
            `held readings=${held.length} spread x=${spread(held.map((h) => h.x)).toFixed(2)} y=${spread(held.map((h) => h.y)).toFixed(2)}`,
        );

        expect(travelled, "the pane was sliding when it was grabbed").toBeGreaterThan(1);
        expect(held.length, "the hold was read with the card in the host's hand").toBeGreaterThan(10);
        expect(
          { x: spread(held.map((h) => h.x)) <= 1, y: spread(held.map((h) => h.y)) <= 1 },
          "a card held still under a still pointer stands still: nothing but the hand moves it",
        ).toEqual({ x: true, y: true });
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
