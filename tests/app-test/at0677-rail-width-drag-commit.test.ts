/**
 * at0677-rail-width-drag-commit.test.ts — a rail width drag lands the whole
 * rail.
 *
 * A rail is as wide as its widest member: the deck reads a side's width as the
 * max of its members' widths, and every member stands at that one width. So
 * the commit has to land every member: narrow a three-member left rail by
 * dragging one member's deck-facing edge, and every member stands at the new
 * width. A commit that writes only the dragged pane's width leaves its two
 * siblings at the old one, and the rail — as wide as its widest member —
 * snaps straight back to where it started. A release with no move before it
 * is still a drag when it travelled, and commits too.
 *
 * The claim is read twice: in the shell, where the stored widths and the
 * marks are the shell's own state, and in the host, whose settle carries
 * every member's view and the chain's cards to the committed width at the
 * release, nothing having moved while the hand was down. A stand-in's rect
 * says where the shell's model put a pane, not where a view stands, so the
 * host's own snapshot says the rest: after each commit every member's view
 * stands at the committed width, the chain's first card on its rest, and
 * nothing in the hand.
 *
 * The shell's occlusion bracket is not read here any more. Every pane in the
 * shell is a stand-in that paints nothing, so the shell proves no pane
 * covered and hides none; a card buried under another is beneath it in the
 * host's stacking, which `at0347` reads.
 *
 * The gesture's own code lives in `tug-pane.tsx`, `deck-canvas.tsx`,
 * `deck-manager.ts` and `BodyViewController.swift`, which are named by none
 * of the lines below: each already fans out past the selection budget, so a
 * diff touching one selects nothing by derivation and naming it here would
 * only raise its recorded debt. Run this file by name with any change to the
 * rail width drag. Its cancel cases are `at0677-rail-width-drag-cancel`.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/lib/rail-width.ts
 * @covers tugdeck/src/lib/host-card-gesture.ts
 * @covers tugapp/Sources/CardGeometry.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  AFTER_LAND_MS,
  FRAMES_MS,
  NARROW_PX,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  count,
  expectEveryMember,
  expectHostLanded,
  grip,
  memberWidths,
  seed,
  storedWidths,
  wait,
} from "./rail-width-commit-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0677 — a rail width drag lands the whole rail",
  () => {
    test(
      "narrowing a three-member rail lands every member at the new width",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-commit" });
        try {
          await seed(app);
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "at rest");

          // A left rail's one handle is its east edge; leftward narrows it.
          const from = await grip(app);
          await app.nativeDrag(from, { x: from.x - NARROW_PX, y: from.y });
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") === null`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const target = RAIL_WIDTH - NARROW_PX;
          expectEveryMember(await storedWidths(app), target, "stored");
          expectEveryMember(await memberWidths(app), target, "rendered");
          await expectHostLanded(app, target, "after the commit");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a release with no move before it still commits the width it landed at",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-bare-release" });
        try {
          await seed(app);
          // A press and a release 60px apart, with nothing between them —
          // what reaches the page when the event merger folds every move of a
          // quick drag into its release. The release travelled, so it is a
          // drag, and it commits.
          const from = await grip(app);
          await app.nativeMouseDown(from);
          await wait(FRAMES_MS);
          await app.nativeMouseUp({ x: from.x - NARROW_PX, y: from.y });
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") === null`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const target = RAIL_WIDTH - NARROW_PX;
          expectEveryMember(await storedWidths(app), target, "stored");
          expectEveryMember(await memberWidths(app), target, "rendered");
          expect(await count(app, "[data-pointer-owned]"), "no frame is still held").toBe(0);
          await expectHostLanded(app, target, "after the bare release");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
