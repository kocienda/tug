/**
 * row-06-menus-kinds-shows.test.ts — Zoom In and Close show in the body of
 * each other kind.
 *
 * A piece of row 6 ([B02] row 6): with the body of each kind under test but
 * the Session card holding the keyboard, View › Zoom In changes its placed
 * width and Actual Size restores it. File › Close on a rail raises the
 * shell's popover — a rail always asks (`tug-pane.tsx`'s
 * `paneConfirmClose`) — which Escape dismisses with the keyboard handed
 * back and whose confirm button closes it; any other kind closes at once.
 * Either way its body goes with the card.
 *
 * @foreground
 * @family row-06-menus
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "../_harness";
import { SETTLE_MS, bodyOf, pollFor, popoverPresent } from "./_bodies";
import { expectNoShellReads } from "./_kind-bodies";
import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, withKind } from "./_row-06";

const CONFIRM = '[data-slot="tug-confirm-popover"] [data-slot="tug-confirm-confirm"]';

describe.skipIf(!SHOULD_RUN)("body-grounding row 6: what the body of every other kind shows", () => {
  for (const kind of kindsUnderTest(6)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: Zoom In changes its body's width, and Close closes it, asking first on a rail`,
      () =>
        withKind({ foreground: true }, kind, "shows", async (app, card) => {
          const widthBefore = (await bodyOf(app, card))!.frame.width;
          const zoom = await app.performMenuItem("view.zoomIn");
          expect(zoom.found && zoom.performed, "View › Zoom In performs").toBe(true);
          const zoomed = await pollFor(() => bodyOf(app, card), (x) => x !== null && x.frame.width !== widthBefore, SETTLE_MS);
          expect(zoomed?.frame.width, "the body's placed width changes").not.toBe(widthBefore);
          await app.performMenuItem("view.actualSize");
          await pollFor(() => bodyOf(app, card), (x) => x !== null && x.frame.width === widthBefore, SETTLE_MS);
          await expectNoShellReads(app, card);

          await app.dispatchControlAction("focus-session-card", { cardId: card });
          await pollFor(() => bodyOf(app, card), (x) => x?.firstResponder === true, SETTLE_MS);
          const cardsBefore = await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`);
          const close = await app.performMenuItem("file.closeCard");
          expect(close.found && close.performed, "File › Close performs").toBe(true);
          const raised = await pollFor(
            async () => ({ popover: await app.evalJS<boolean>(popoverPresent), cards: await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`) }),
            (r) => r.popover || r.cards < cardsBefore,
            SETTLE_MS,
          );
          note(`after File › Close: popover ${raised.popover}, cards ${cardsBefore} → ${raised.cards}`);
          expect(raised.popover, kind.rail ? "File › Close on a rail asks" : "File › Close asks nothing").toBe(kind.rail);
          if (kind.rail) {
            await app.nativeKey("Escape");
            expect(await pollFor(() => app.evalJS<boolean>(popoverPresent), (v) => !v, SETTLE_MS), "Escape dismisses it").toBe(false);
            const handedBack = await pollFor(() => bodyOf(app, card), (x) => x?.firstResponder === true, SETTLE_MS);
            expect(handedBack?.firstResponder, "the card's body holds the keyboard again").toBe(true);
            expect(await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`), "no card was closed").toBe(cardsBefore);
            await app.performMenuItem("file.closeCard");
            expect(await pollFor(() => app.evalJS<boolean>(popoverPresent), (v) => v, SETTLE_MS), "File › Close asks again").toBe(true);
            await app.nativeClickAtElement(CONFIRM);
          }
          const left = await pollFor(() => app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`), (n) => n < cardsBefore, SETTLE_MS);
          expect(left, "the card closed").toBe(cardsBefore - 1);
          expect(await pollFor(() => bodyOf(app, card), (x) => x === null, SETTLE_MS), "its body went with it").toBeNull();
        }),
      TEST_TIMEOUT_MS,
    );
  }
});
