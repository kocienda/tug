/**
 * at0677-rail-width-drag-cancel.test.ts — a rail width drag that loses its
 * pointer gives everything back.
 *
 * A pointer capture can be lost mid-drag — the system takes the pointer, the
 * window loses it — and the gesture never hears its `pointerup`; and the user
 * can take it back themselves with Escape. Either way, everything acquired at
 * pointer-down then has to be given back by the cancel: the `data-gesture`
 * and `data-pointer-owned` marks, the scroll-preservation episodes on every
 * frame, the pointer listeners themselves, and the width the drag previewed.
 * The listeners are read through their one visible effect: a `pointerup`
 * arriving after the cancel finds nobody listening and commits nothing.
 *
 * The claim is read twice: in the shell, where the stored widths and the
 * marks are the shell's own state, and in the host, which carries every
 * member's view and the chain's cards from the pointer. A stand-in's rect
 * says where the shell's model put a pane, not where a view stands, so the
 * host's own snapshot says the rest: mid-drag the host holds the dragged
 * member and has drawn every member narrower, together; after the cancel,
 * and after the release that follows it, every view stands back at its
 * press frame, out of the hand.
 *
 * The rail card draws its edge grip in its own page, and the host carries
 * the press (`cardGesture` of kind `rail`). So the pointer is lost the way
 * the host loses one: the window resigns key, the host puts the views back
 * and cancels its gesture, and the shell gives the draft back. The cancel
 * hides the app to take its window's pointer away; in a background launch
 * the hide is the harness's in-process one, which resigns the window's key
 * status as AppKit's does.
 *
 * The gesture's own code lives in `tug-pane.tsx`, `deck-canvas.tsx`,
 * `deck-manager.ts` and `BodyViewController.swift`, which are named by none
 * of the lines below: each already fans out past the selection budget. Run
 * this file by name with any change to the rail width drag. Its commit
 * cases are `at0677-rail-width-drag-commit`.
 *
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugapp/Sources/CardGeometry.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  AFTER_LAND_MS,
  DRAGGED,
  FRAMES_MS,
  NARROW_PX,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  count,
  expectEveryMember,
  expectHostAtPress,
  expectHostCarrying,
  frame,
  grip,
  hostViews,
  memberWidths,
  seed,
  storedWidths,
  wait,
} from "./rail-width-commit-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0677 — a rail width drag that loses its pointer releases everything it took",
  () => {
    test(
      "a drag whose window loses the mouse releases everything it took",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-cancel" });
        try {
          await seed(app);
          const press = await hostViews(app);

          const from = await grip(app);
          await app.nativeDragWithoutRelease(from, {
            x: from.x - NARROW_PX,
            y: from.y,
          });
          await wait(FRAMES_MS);

          // The gesture is under way: the frame is marked as held.
          expect(
            await count(app, `${frame(DRAGGED)}[data-pointer-owned]`),
            "the drag latched",
          ).toBe(1);
          await expectHostCarrying(app, press);

          // ── The moment: the window loses the mouse. ──────────────────────
          // The press is the card's page's and the host carries the pointer,
          // so what takes it away is the window resigning key — here, the app
          // hidden: the host cancels the gesture there, and the shell's draft
          // is given back.
          await app.simulateAppHide({ timeoutMs: 5_000 });
          // Shown again before anything is read: a hidden window paints no
          // frames, and the deck's quiet below waits on them.
          await app.simulateAppUnhide({ timeoutMs: 5_000 });
          await wait(FRAMES_MS);

          expect(
            await count(app, "[data-gesture]"),
            "no frame is still marked mid-gesture",
          ).toBe(0);
          expect(
            await count(app, "[data-pointer-owned]"),
            "no frame is still marked as held",
          ).toBe(0);
          expect(
            await count(app, "[data-resize-episode]"),
            "every scroll-preservation episode is closed",
          ).toBe(0);
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "rolled back");
          await expectHostAtPress(app, press, "after the cancel");

          // The gesture is gone: a release arriving now commits nothing.
          await app.nativeMouseUp({ x: from.x - NARROW_PX, y: from.y });
          await wait(AFTER_LAND_MS);
          expectEveryMember(await storedWidths(app), RAIL_WIDTH, "after release");
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "after release");
          await expectHostAtPress(app, press, "after the release");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "Escape mid-drag cancels it, and the release that follows commits nothing",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-escape" });
        try {
          await seed(app);
          const press = await hostViews(app);

          const from = await grip(app);
          await app.nativeDragWithoutRelease(from, {
            x: from.x - NARROW_PX,
            y: from.y,
          });
          await wait(FRAMES_MS);
          expect(
            await count(app, `${frame(DRAGGED)}[data-pointer-owned]`),
            "the drag latched",
          ).toBe(1);
          await expectHostCarrying(app, press);

          // ── The moment: the user changes their mind. ─────────────────────
          await app.nativeKey("Escape");
          await wait(FRAMES_MS);

          expect(await count(app, "[data-gesture]"), "no frame is still mid-gesture").toBe(0);
          expect(await count(app, "[data-pointer-owned]"), "no frame is still held").toBe(0);
          expect(
            await count(app, "[data-resize-episode]"),
            "every scroll-preservation episode is closed",
          ).toBe(0);
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "rolled back");
          await expectHostAtPress(app, press, "after the cancel");

          // The button is still down; letting it go is not a second chance
          // at the commit the user just declined.
          await app.nativeMouseUp({ x: from.x - NARROW_PX, y: from.y });
          await wait(AFTER_LAND_MS);
          expectEveryMember(await storedWidths(app), RAIL_WIDTH, "after release");
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "after release");
          await expectHostAtPress(app, press, "after the release");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
