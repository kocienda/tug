/**
 * at0672-pane-press-raises-in-its-task.test.ts — a card pressed on its chrome
 * from under a neighbour comes forward at the press, and stays forward while
 * the hand carries it.
 *
 * A card draws its chrome in its own page and is one view the host carries,
 * so a press on its title bar lands in its page, which hands the gesture to
 * the host (`cardGesture` `begin`) and asks the shell to activate the card.
 * The shell's activation raises the card's stand-in and posts the stacking to
 * the host, but that is a round trip, and a card pressed from under its
 * neighbour and dragged would travel under it until it arrived. So the host
 * raises the card's view itself when it takes the press
 * (`BodyViewController.claimGesture`), and the shell's placement then says
 * the same.
 *
 * The press here is a real mouse-down on p1's grab handle in A1's page, held
 * and carried a short way: while the button is still down, A1 is the shell's
 * focused card, its stand-in stacks above p2's, and the host stacks A1's view
 * above A2's. After the release the stacking stands.
 *
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/components/chrome/pane-stacking.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const GRAB_HANDLE = '[data-testid="tug-pane-title-bar"] .tug-pane-grab-handle';

interface Standing {
  p1z: number;
  p2z: number;
  p1focused: string | null;
  p2focused: string | null;
}

/** Each stand-in frame's inline z and focus, read as a script expression. */
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

/** The host's stacking of the two cards' views. */
async function viewZ(app: App): Promise<{ a1: number; a2: number }> {
  const views = await app.bodies();
  return {
    a1: views.find((b) => b.cardId === "A1")?.z ?? Number.NaN,
    a2: views.find((b) => b.cardId === "A2")?.z ?? Number.NaN,
  };
}

describe.skipIf(!SHOULD_RUN)("at0672: a card press raises it at the press", () => {
  test(
    "the pressed card is in front and focused while the hand still holds it",
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
        const a1 = app.body("A1");
        await a1.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(GRAB_HANDLE)}) !== null`, { timeoutMs: 10_000 });
        // card-dom: shell — the stand-ins' stacking and focus are the shell's.
        await app.waitForCondition<boolean>(
          `(function () { var s = ${STANDING}; return s.p2z > s.p1z && s.p2focused === "true"; })()`,
        );
        const before = await viewZ(app);
        expect(before.a2, "A2's view starts above A1's").toBeGreaterThan(before.a1);

        // ---- Press A1's grab handle and carry it, the button held ----
        const handle = await a1.getElementBounds(GRAB_HANDLE);
        await a1.nativeDragElementWithoutRelease(GRAB_HANDLE, { x: Math.round(handle.x + handle.width / 2) + 40, y: Math.round(handle.y + handle.height / 2) + 20 });
        // card-dom: shell — the stand-ins' stacking and focus are the shell's.
        await app
          .waitForCondition<boolean>(`(function () { var s = ${STANDING}; return s.p1z > s.p2z; })()`, { timeoutMs: 2_000 })
          .catch(() => false);
        // card-dom: shell — the stand-ins' stacking and focus are the shell's.
        const held = await app.evalJS<Standing>(STANDING);
        let heldViews = await viewZ(app);
        for (const deadline = Date.now() + 2_000; !(heldViews.a1 > heldViews.a2) && Date.now() < deadline; heldViews = await viewZ(app)) {
          await Bun.sleep(50);
        }
        note(`in hand: stand-ins ${JSON.stringify(held)}; views ${JSON.stringify(heldViews)}; focused ${await app.getFocusedCardId()}`);
        expect(await app.getFocusedCardId(), "the pressed card is the shell's focused card").toBe("A1");
        expect(held.p1z, "its stand-in stacks above its neighbour's").toBeGreaterThan(held.p2z);
        expect(held.p1focused).toBe("true");
        expect(held.p2focused).toBe("false");
        expect(heldViews.a1, "the host stacks its view above its neighbour's while it is carried").toBeGreaterThan(heldViews.a2);

        // ---- Released, the stacking stands ----
        const at = await a1.getElementBounds(GRAB_HANDLE);
        await a1.nativeMouseUp({ x: Math.round(at.x + at.width / 2), y: Math.round(at.y + at.height / 2) });
        await app.settleGestureScope();
        const landed = await viewZ(app);
        expect(landed.a1, "and after the release").toBeGreaterThan(landed.a2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
