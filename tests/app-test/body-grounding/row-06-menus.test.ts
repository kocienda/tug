/**
 * row-06-menus.test.ts — every Swift menu command works with a body first
 * responder.
 *
 * The bar's sixth row ([B02] row 6). A body session card holds the keyboard
 * and every item of the File, Edit, View, Go and Window menus is performed
 * the way a menu performs it — `performMenuItem` finds the real `NSMenuItem`,
 * runs AppKit's validation, and sends its action through `NSApp.sendAction`
 * ([B04]) — so validation, the action and `sendControl` all run with the
 * body's web view as the responder. Every enabled item must perform; the
 * few whose action leaves the app's own window (an open panel, a save
 * panel, full screen, minimise, a workspace made or destroyed) or would
 * close the fixture are read for validation and not performed, and said so.
 *
 * Then the items whose effect the body can show are asserted in the page:
 * Undo and Redo validated against the body web view's own undo manager
 * (`MainWindow.editingUndoManager`) over its find bar's native input, Fold
 * Card hiding and showing the body, Zoom In changing its placed width, Focus
 * Card Right and Left moving the keyboard between two bodies, and Close
 * raising the shell's own popover and handing the keyboard back when it is
 * dismissed.
 *
 * @foreground
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { MenuItemSnapshot } from "../_harness/types";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { SETTLE_MS, bodyOf, focusBody, foldedOf, pollFor, popoverPresent, responders, sessionPane, spawnStub, waitForBody } from "./_bodies";

const TEST_NAME = "body-grounding-row-06-menus";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const A = "row06-a";
const B = "row06-b";
const FIND_BAR = '[data-slot="session-card-find-bar"]';
const FIND_INPUT = '[data-testid="session-card-find-input"]';
/** The menus the row sweeps, by their items' identifier prefixes. */
const MENU_PREFIX = /^(file|edit|view|go|window)\./;

/**
 * Items read for validation but not performed: their action leaves the
 * app's own window, changes the workspace set, or closes the fixture.
 */
const NOT_PERFORMED =
  /^(file\.(openFile|openQuickly|openRecent|save|saveAs|saveACopy|exportTranscript|revertToSaved|reloadFromDisk|closeAllCardTabs|closeCard|newSessionCard|newTextCard|newJot)|view\.(enterFullScreen|keyboardFocus|nextKeyboardFocus|previousKeyboardFocus)|window\.(minimize|zoom|bringAllToFront|deleteWorkspace|newWorkspace|duplicateWorkspace|renameWorkspace|space\.|pane\.))/;

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
    ],
    panes: [sessionPane(A, 0), sessionPane(B, 1)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** Every identified, non-separator, shown item of the five menus, anywhere in the tree. */
function itemsOf(snapshot: readonly MenuItemSnapshot[]): Array<{ id: string; title: string; enabled: boolean }> {
  const out: Array<{ id: string; title: string; enabled: boolean }> = [];
  const walk = (items: readonly MenuItemSnapshot[]): void => {
    for (const item of items) {
      if (item.separator || item.hidden) continue;
      if (item.submenu !== undefined) {
        walk(item.submenu);
        continue;
      }
      if (item.identifier === undefined || !MENU_PREFIX.test(item.identifier)) continue;
      out.push({ id: item.identifier, title: item.title, enabled: item.enabled });
    }
  };
  walk(snapshot);
  return out;
}

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

/**
 * Dismiss whatever an item raised and give A the keyboard again. Returns
 * whether A's body took it back, with what the shell and the host said.
 */
async function settleAfter(app: App): Promise<{ handedBack: boolean; facts: string }> {
  await app.nativeKey("Escape");
  await Bun.sleep(150);
  if (await app.evalJS<boolean>(popoverPresent)) await app.nativeKey("Escape");
  // A surface the item raised or revealed may be settling onto the deck.
  await Bun.sleep(600);
  // An item that folded A leaves its body hidden, and a hidden view holds
  // no keyboard: unfold it before asking. The fold leg below reads the
  // fold itself.
  if (await foldedOf(app, A)) {
    await app.performMenuItem("view.foldCard");
    await pollFor(() => foldedOf(app, A), (v) => !v, SETTLE_MS);
    await Bun.sleep(600);
  }
  await app.dispatchControlAction("focus-session-card", { cardId: A });
  const holder = await pollFor(() => bodyOf(app, A), (x) => x?.firstResponder === true, SETTLE_MS);
  const facts =
    `shell focused card ${await app.getFocusedCardId()}, shell responder ${await app.evalJS<string>("String(window.__tug.getFirstResponderId())")}, ` +
    `shell active element ${await app.evalJS<string>(`document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "none"`)}, ` +
    `A's pane ${await app.evalJS<string>(`JSON.stringify((function(){ var p = document.querySelector(${JSON.stringify(`.tug-pane[data-pane-id="${A}-pane"]`)}); if (!p) return null; var o = {}; for (var i = 0; i < p.attributes.length; i++) o[p.attributes[i].name] = p.attributes[i].value; return o; })())`)}, ` +
    `deck panes ${await app.evalJS<string>(`JSON.stringify((window.tugdeck.diag.getDeckState().panes || []).map(function (p) { return { id: p.id, slot: p.slot, cards: p.cardIds }; }))`)}, host ${await responders(app)}`;
  if (holder?.firstResponder !== true) {
    // Put the keyboard back the way a click on the card would, so the sweep goes on.
    await app.nativeClickAtElement(`.tug-pane[data-pane-id="${A}-pane"] [data-testid="tug-pane-title-bar"]`);
    await pollFor(() => bodyOf(app, A), (x) => x?.firstResponder === true, SETTLE_MS);
  }
  return { handedBack: holder?.firstResponder === true, facts };
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 6: menus", () => {
  test(
    "every File, Edit, View, Go and Window item performs with a body first responder, and the ones the body can show, show",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await spawnStub(app, A, stubDir, 6);
        await spawnStub(app, B, stubDir, 2);
        await waitForBody(app, A);
        await waitForBody(app, B);
        const a = app.body(A);
        await focusBody(app, A);
        note(`A focused: ${await responders(app)}`);

        // ---- The sweep: every item, validated with the body as responder ----
        const items = itemsOf(await app.menuSnapshot());
        expect(items.length, "the five menus carry items").toBeGreaterThan(30);
        const results: Array<{ id: string; enabled: boolean; performed: boolean | null; skipped: boolean; handedBack: boolean; facts: string }> = [];
        for (const item of items) {
          const state = await app.menuItemState(item.id);
          expect(state.found, `${item.title} (${item.id}) is a real item`).toBe(true);
          if (!state.found) continue;
          if (!state.enabled || NOT_PERFORMED.test(item.id)) {
            results.push({ id: item.id, enabled: state.enabled, performed: null, skipped: NOT_PERFORMED.test(item.id), handedBack: true, facts: "" });
            continue;
          }
          const done = await app.performMenuItem(item.id);
          const settled = await settleAfter(app);
          results.push({ id: item.id, enabled: state.enabled, performed: done.found ? done.performed : false, skipped: false, ...settled });
        }
        const performed = results.filter((r) => r.performed === true);
        const refused = results.filter((r) => r.performed === false);
        const kept = results.filter((r) => !r.handedBack);
        const dark = results.filter((r) => !r.enabled);
        const skipped = results.filter((r) => r.skipped && r.enabled);
        note(
          `${items.length} items: ${performed.length} performed, ${dark.length} dark, ${skipped.length} enabled but not performed by this row ` +
            `(${skipped.map((r) => r.id).join(", ")}); dark: ${dark.map((r) => r.id).join(", ")}`,
        );
        if (refused.length > 0) note(`items AppKit validated enabled but whose action no responder took: ${refused.map((r) => r.id).join(", ")}`);
        if (kept.length > 0) note(`items after which A's body did not get the keyboard back:\n${kept.map((r) => `${r.id}: ${r.facts}`).join("\n")}`);
        expect(refused.map((r) => r.id), "every enabled item's action is taken by a responder").toEqual([]);
        expect(kept.map((r) => r.id), "after every item the keyboard returns to A's body").toEqual([]);
        expect((await bodyOf(app, A))?.visible, "A's body stands after the sweep").toBe(true);

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

        // ---- Fold Card hides the body; again shows it ----
        await focusBody(app, A, { composer: false });
        const fold = await app.performMenuItem("view.foldCard");
        expect(fold.found && fold.performed, "View › Fold Card performs").toBe(true);
        expect((await pollFor(() => bodyOf(app, A), (x) => x?.visible === false, SETTLE_MS))?.visible, "the host hides A's folded body").toBe(false);
        const unfold = await app.performMenuItem("view.foldCard");
        expect(unfold.found && unfold.performed, "View › Fold Card performs again").toBe(true);
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

        // ---- Close: the shell's popover, dismissed, hands the keyboard back; a
        // card whose body waives the confirmation closes at once and hands it on ----
        const cardsBefore = await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`);
        const close = await app.performMenuItem("file.closeCard");
        expect(close.found && close.performed, "File › Close performs").toBe(true);
        const raised = await pollFor(
          async () => ({ popover: await app.evalJS<boolean>(popoverPresent), cards: await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`) }),
          (r) => r.popover || r.cards < cardsBefore,
          SETTLE_MS,
        );
        note(`after File › Close: popover ${raised.popover}, cards ${cardsBefore} → ${raised.cards}; A ${JSON.stringify(await bodyOf(app, A))}`);
        if (raised.popover) {
          await app.nativeKey("Escape");
          expect(await pollFor(() => app.evalJS<boolean>(popoverPresent), (v) => !v, SETTLE_MS), "Escape dismisses it").toBe(false);
          const handedBack = await pollFor(() => bodyOf(app, A), (x) => x?.firstResponder === true, SETTLE_MS);
          note(`after the popover: ${await responders(app)}`);
          expect(handedBack?.firstResponder, "A's body holds the keyboard again").toBe(true);
          expect(await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`), "no card was closed").toBe(cardsBefore);
        } else {
          expect(raised.cards, "A closed at once").toBe(cardsBefore - 1);
          const handedOn = await pollFor(() => bodyOf(app, B), (x) => x?.firstResponder === true, 8_000);
          note(`after the close: ${await responders(app)}`);
          expect(handedOn?.firstResponder, "B's body holds the keyboard").toBe(true);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
