/**
 * at0672-pane-press-raises-in-its-task.test.ts — a pane pressed on its chrome
 * from under a neighbour comes forward in the press's own task.
 *
 * A pane-chrome press defers its React commit past the next paint
 * (`mayDeferCommit`), because the card it activates is already on screen and
 * a commit in the press's task would sit in front of the first frame of any
 * motion the press launches. The pane's stacking and its title bar's focus
 * are not React's to wait for: a pane pressed from under its neighbour and
 * dragged would otherwise travel under it for a painted frame before popping
 * forward. So the deck writes each shown frame's inline `z-index` and
 * `data-focused` from a synchronous store subscriber, in the commit's own
 * task, and React's later commit renders the same values.
 *
 * The press here is dispatched from one task, and the frame's state is read
 * in that same task — before any frame could paint and before the deferred
 * React notify could run. Then, a frame later, the rendered state is read
 * again to show React agrees with what was written.
 *
 * `deck-canvas.tsx` is deliberately NOT declared, though the `pane-raise`
 * subscriber that writes the `z-index` lives there: that file sits at its
 * recorded fan-out ceiling in `ACCEPTED_FANOUT`, and the ratchet only pays
 * down. An edit to `pane-raise` or `paneZIndexMap` should run this file by
 * name.
 *
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/components/chrome/pane-occlusion-controller.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

interface Standing {
  p1z: number;
  p2z: number;
  p1focused: string | null;
  p2focused: string | null;
}

/** Each pane frame's inline z and focus, read as a script expression. */
const STANDING = `(function () {
  var p1 = document.querySelector('.tug-pane[data-pane-id="p1"]');
  var p2 = document.querySelector('.tug-pane[data-pane-id="p2"]');
  return {
    p1z: parseInt(p1.style.zIndex, 10),
    p2z: parseInt(p2.style.zIndex, 10),
    p1focused: p1.getAttribute("data-focused"),
    p2focused: p2.getAttribute("data-focused"),
  };
})()`;

/** Press p1's title from a task and read the standing in that same task. */
const PRESS_AND_READ = `(function () {
  var title = document.querySelector('[data-pane-id="p1"] [data-testid="tug-pane-title"]');
  var r = title.getBoundingClientRect();
  var init = {
    bubbles: true, cancelable: true, composed: true,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true,
  };
  title.dispatchEvent(new PointerEvent("pointerdown", init));
  var standing = ${STANDING};
  title.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, init, { buttons: 0 })));
  return standing;
})()`;

describe.skipIf(!SHOULD_RUN)("at0672: a pane press raises in its own task", () => {
  test(
    "the pressed pane is in front and focused before the press's task ends",
    async () => {
      const app = await launchTugApp({ testName: "at0672-pane-press-raises-in-its-task" });
      try {
        // p2 overlaps p1's lower right and stands above it (later in the
        // array). p1's title bar is clear of p2, so it can be pressed.
        await app.seedDeckState({
          state: {
            cards: [
              { id: "A1", componentId: "gallery-input", title: "Card A1", closable: true },
              { id: "A2", componentId: "gallery-input", title: "Card A2", closable: true },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 420, height: 320 },
                cardIds: ["A1"],
                activeCardId: "A1",
                title: "",
                acceptsFamilies: ["maker"],
              },
              {
                id: "p2",
                position: { x: 240, y: 140 },
                size: { width: 420, height: 320 },
                cardIds: ["A2"],
                activeCardId: "A2",
                title: "",
                acceptsFamilies: ["maker"],
              },
            ],
            activePaneId: "p2",
            hasFocus: true,
          },
          focusCardId: "A2",
        });
        await app.waitForCondition<boolean>(
          `window.__tug.assertHostRootRegistered("A1") && window.__tug.assertHostRootRegistered("A2")`,
        );
        await app.waitForCondition<boolean>(
          `(function () { var s = ${STANDING}; return s.p2z > s.p1z && s.p2focused === "true"; })()`,
        );

        const inTask = await app.evalJS<Standing>(PRESS_AND_READ);
        expect(inTask.p1z).toBeGreaterThan(inTask.p2z);
        expect(inTask.p1focused).toBe("true");
        expect(inTask.p2focused).toBe("false");

        // React's deferred commit lands — it is told after the next painted
        // frame — and renders the same stacking. Two painted frames past the
        // store's activation is past that notify.
        await app.settleGestureScope();
        await app.waitForCondition<boolean>(`window.__tug.getActiveCardId() === "A1"`);
        await app.evalJS<boolean>(
          `(function () {
            window.__at0672Frames = 0;
            var frame = function () {
              requestAnimationFrame(function () {
                setTimeout(function () {
                  window.__at0672Frames += 1;
                  if (window.__at0672Frames < 2) frame();
                }, 0);
              });
            };
            frame();
            return true;
          })()`,
        );
        await app.waitForCondition<boolean>(`window.__at0672Frames >= 2`);
        const rendered = await app.evalJS<Standing>(STANDING);
        expect(rendered.p1z).toBeGreaterThan(rendered.p2z);
        expect(rendered.p1focused).toBe("true");
        expect(rendered.p2focused).toBe("false");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
