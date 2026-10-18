/**
 * row-06-menus-session-shows.test.ts — the menu items whose effect a
 * Session body can show, show.
 *
 * A piece of row 6 ([B02] row 6). With a body Session card holding the
 * keyboard: Undo and Redo validated against the body's chain over its find
 * bar's input, and performed into it; Fold Card folding and unfolding the
 * card with its body shown throughout, since a Session body draws the card's
 * own folded form (the bodies migration's [B23]); Zoom In changing its
 * placed width; Focus Card Right and Left moving the keyboard between two
 * bodies; and Close over a draft raising the
 * shell's own popover, which Escape dismisses with the keyboard handed
 * back, and whose Close button closes the card and hands the keyboard on.
 * A Session card holding nothing closes without asking, which is the rule,
 * so the card is given a draft first.
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

import { note, type App } from "../_harness";
import { SETTLE_MS, bodyOf, closeButtonOfPopover, composerText, focusBody, foldedOf, pollFor, popoverPresent, responders } from "./_bodies";
import { sessionUnderTest } from "./_kinds";
import { A, B, SHOULD_RUN, TEST_TIMEOUT_MS, withSessions } from "./_row-06";

const FIND_BAR = '[data-slot="session-card-find-bar"]';
const FIND_INPUT = '[data-testid="session-card-find-input"]';
const findBarShown = `document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`;
/** The find field is a text editor host; its caret is a descendant and its text is its lines' (never the placeholder's). */
const findInputFocused = `document.activeElement !== null && document.activeElement.closest(${JSON.stringify(FIND_INPUT)}) !== null`;
const findValue = `(function () {
  var el = document.querySelector(${JSON.stringify(FIND_INPUT)});
  if (el === null) return null;
  var lines = el.querySelectorAll(".cm-line");
  if (lines.length === 0) return el.textContent || "";
  return Array.from(lines).map(function (l) {
    return Array.from(l.childNodes).filter(function (n) { return !(n.nodeType === 1 && n.classList.contains("cm-placeholder")); }).map(function (n) { return n.textContent || ""; }).join("");
  }).join("\\n");
})()`;
const cardCount = (app: App): Promise<number> => app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`);

describe.skipIf(!SHOULD_RUN)("body-grounding row 6: what a Session body shows", () => {
  test.skipIf(!sessionUnderTest(6))(
    "Undo and Redo, Fold, Zoom, Focus Card Right and Left, and Close show in the body",
    () =>
      withSessions({ foreground: true }, "shows", async (app) => {
        const a = app.body(A);

        // ---- Undo and Redo validated and performed against the body's editor ----
        // The find bar's query field is a text editor in the body, so Undo
        // validates from the body's chain, merged into the host's menu state
        // as the key card's, and performs through the chain round-trip into
        // the body. (A session body carries no native text control today,
        // so the host's live `NSUndoManager` path is read, not driven, here.)
        await focusBody(app, A, { composer: false });
        await app.nativeKey("f", ["cmd"]);
        expect(await pollFor(() => a.evalJS<boolean>(findBarShown), (v) => v, SETTLE_MS), "A's find bar opens").toBe(true);
        expect(await pollFor(() => a.evalJS<boolean>(findInputFocused), (v) => v, SETTLE_MS), "its input is focused").toBe(true);
        await app.nativeType("abc");
        expect(await pollFor(() => a.evalJS<string | null>(findValue), (v) => v === "abc", SETTLE_MS), "typing lands in the input").toBe("abc");
        const undoState = await pollFor(() => app.menuItemState("edit.undo"), (s) => s.found && s.enabled, SETTLE_MS);
        note(`edit.undo with the body's find input focused: ${JSON.stringify(undoState)}`);
        expect(undoState.found && undoState.enabled, "Undo validates enabled from the body's chain").toBe(true);
        const undone = await app.performMenuItem("edit.undo");
        expect(undone.found && undone.performed, "Undo performs").toBe(true);
        expect(await pollFor(() => a.evalJS<string | null>(findValue), (v) => v === "", SETTLE_MS), "the typing is undone in the body's input").toBe("");
        const redoState = await pollFor(() => app.menuItemState("edit.redo"), (s) => s.found && s.enabled, SETTLE_MS);
        expect(redoState.found && redoState.enabled, "Redo validates enabled").toBe(true);
        const redone = await app.performMenuItem("edit.redo");
        expect(redone.found && redone.performed, "Redo performs").toBe(true);
        expect(await pollFor(() => a.evalJS<string | null>(findValue), (v) => v === "abc", SETTLE_MS), "the typing is redone").toBe("abc");
        await app.nativeKey("Escape");
        await pollFor(() => a.evalJS<boolean>(findBarShown), (v) => !v, SETTLE_MS);

        // ---- Fold Card folds the card and again unfolds it; the body stays shown,
        // drawing the card's own folded form ([B23] of the bodies migration) ----
        await focusBody(app, A, { composer: false });
        const fold = await app.performMenuItem("view.foldCard");
        expect(fold.found && fold.performed, "View › Fold Card performs").toBe(true);
        expect(await pollFor(() => foldedOf(app, A), (f) => f, SETTLE_MS), "A folds").toBe(true);
        expect((await bodyOf(app, A))?.visible, "the host keeps A's folded body shown").toBe(true);
        const unfold = await app.performMenuItem("view.foldCard");
        expect(unfold.found && unfold.performed, "View › Fold Card performs again").toBe(true);
        expect(await pollFor(() => foldedOf(app, A), (f) => !f, SETTLE_MS), "A unfolds").toBe(false);
        expect((await pollFor(() => bodyOf(app, A), (x) => x?.visible === true, SETTLE_MS))?.visible, "the host shows it again").toBe(true);

        // ---- Zoom In changes the body's placed width; Actual Size restores it ----
        const widthBefore = (await bodyOf(app, A))!.frame.width;
        const zoom = await app.performMenuItem("view.zoomIn");
        expect(zoom.found && zoom.performed, "View › Zoom In performs").toBe(true);
        const zoomed = await pollFor(() => bodyOf(app, A), (x) => x !== null && x.frame.width !== widthBefore, SETTLE_MS);
        expect(zoomed?.frame.width, "the body's placed width changes").not.toBe(widthBefore);
        await app.performMenuItem("view.actualSize");
        await pollFor(() => bodyOf(app, A), (x) => x !== null && x.frame.width === widthBefore, SETTLE_MS);

        // ---- Focus Card Right and Left move the keyboard between bodies ----
        // The item's gate is the key body's, posted after the shell's travel
        // facts reach it; it is read enabled before it is performed.
        await focusBody(app, A, { composer: false });
        const rightState = await pollFor(() => app.menuItemState("go.focusCardRight"), (s) => s.found && s.enabled, SETTLE_MS);
        expect(rightState.found && rightState.enabled, "Go › Focus Card Right validates enabled with A key").toBe(true);
        const right = await app.performMenuItem("go.focusCardRight");
        expect(right.found && right.performed, "Go › Focus Card Right performs").toBe(true);
        const bHolds = await pollFor(() => bodyOf(app, B), (x) => x?.firstResponder === true, SETTLE_MS);
        expect(bHolds?.firstResponder, "B's body is the first responder").toBe(true);
        expect(await app.getFocusedCardId(), "the shell's focused card is B").toBe(B);
        const leftState = await pollFor(() => app.menuItemState("go.focusCardLeft"), (s) => s.found && s.enabled, SETTLE_MS);
        expect(leftState.found && leftState.enabled, "Go › Focus Card Left validates enabled with B key").toBe(true);
        const left = await app.performMenuItem("go.focusCardLeft");
        expect(left.found && left.performed, "Go › Focus Card Left performs").toBe(true);
        const aHolds = await pollFor(() => bodyOf(app, A), (x) => x?.firstResponder === true, SETTLE_MS);
        expect(aHolds?.firstResponder, "A's body is the first responder again").toBe(true);

        // ---- Close over a draft: the shell's popover; Escape hands the
        // keyboard back, and its Close button closes A and hands it on ----
        await focusBody(app, A);
        await app.nativeType("draft");
        expect(await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("draft") === true, SETTLE_MS), "A's composer holds a draft").toContain("draft");
        const cardsBefore = await cardCount(app);
        const close = await app.performMenuItem("file.closeCard");
        expect(close.found && close.performed, "File › Close performs").toBe(true);
        const raised = await pollFor(
          async () => ({ popover: await app.evalJS<boolean>(popoverPresent), cards: await cardCount(app) }),
          (r) => r.popover || r.cards < cardsBefore,
          SETTLE_MS,
        );
        note(`after File › Close: popover ${raised.popover}, cards ${cardsBefore} → ${raised.cards}; A ${JSON.stringify(await bodyOf(app, A))}`);
        expect(raised.popover, "File › Close over A's draft raises the shell's popover").toBe(true);
        await app.nativeKey("Escape");
        expect(await pollFor(() => app.evalJS<boolean>(popoverPresent), (v) => !v, SETTLE_MS), "Escape dismisses it").toBe(false);
        const handedBack = await pollFor(() => bodyOf(app, A), (x) => x?.firstResponder === true, SETTLE_MS);
        note(`after the popover: ${await responders(app)}`);
        expect(handedBack?.firstResponder, "A's body holds the keyboard again").toBe(true);
        expect(await cardCount(app), "no card was closed").toBe(cardsBefore);

        const again = await app.performMenuItem("file.closeCard");
        expect(again.found && again.performed, "File › Close performs again").toBe(true);
        expect(await pollFor(() => app.evalJS<boolean>(popoverPresent), (v) => v, SETTLE_MS), "and asks again").toBe(true);
        const button = await closeButtonOfPopover(app);
        expect(button, "the popover has a Close button").not.toBeNull();
        await app.nativeClick(button!);
        expect(await pollFor(() => cardCount(app), (n) => n < cardsBefore, SETTLE_MS), "Close closes A").toBe(cardsBefore - 1);
        const handedOn = await pollFor(() => bodyOf(app, B), (x) => x?.firstResponder === true, 8_000);
        note(`after the close: ${await responders(app)}`);
        expect(handedOn?.firstResponder, "B's body holds the keyboard").toBe(true);
      }),
    TEST_TIMEOUT_MS,
  );
});
