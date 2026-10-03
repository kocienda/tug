/**
 * FocusManager — pure-logic tests for the first-responder axis of the focus-mode
 * restore ([#cfrunloop-model]).
 *
 * The mode stack restores TWO projections of the focus state at pop: the key
 * view (exercised in focus-walk.test.ts) and the chain's first responder. A
 * trapped surface (a modal confirm popover) claims first responder on open so
 * its own Cmd-. cancel reaches it; on close the stack must return first
 * responder to whatever held it at push, or a first-responder-routed accelerator
 * keeps landing on the now-closed surface's stale handler. These pin that
 * restore as data-in / data-out, with no DOM — bun:test has no document, so the
 * chain's first-responder bookkeeping is the exact surface under test.
 */

import { describe, expect, test } from "bun:test";

import { FocusManager } from "../focus-manager";
import { ResponderChainManager } from "../responder-chain";

/** A FocusManager bound to a fresh chain with `editor` as the root first responder. */
function setup(): { fm: FocusManager; chain: ResponderChainManager } {
  const chain = new ResponderChainManager();
  const fm = new FocusManager();
  fm.attach(chain);
  // `editor` is a root responder, so registering it auto-promotes it to first
  // responder.
  chain.register({ id: "editor", parentId: null, actions: {} });
  chain.register({ id: "popover", parentId: "editor", actions: {} });
  // Establish `editor` as the key view the way the live app would: a
  // placement (in the app, the user's focus lands there and the settled-focus
  // derivation records it; DOM-free tests assert the same state via `place`).
  fm.place(null, { kind: "responder", responderId: "editor" }, {
    modality: "pointer",
  });
  return { fm, chain };
}

describe("FocusManager first-responder restore on mode pop", () => {
  test("pop restores the first responder a trapped surface displaced on open", () => {
    const { fm, chain } = setup();
    expect(chain.getFirstResponder()).toBe("editor");

    // Surface opens: push captures the prior first responder (editor)…
    fm.pushFocusMode("trap", { trapped: true });
    // …then the surface claims first responder for itself (the modal popover's
    // handleContentFocus → makeFirstResponder, so its Cmd-. cancel lands).
    chain.makeFirstResponder("popover");
    expect(chain.getFirstResponder()).toBe("popover");

    // Surface closes: the stack restores both axes.
    fm.popFocusMode("trap");
    expect(chain.getFirstResponder()).toBe("editor");
    expect(fm.keyView()).toBe("editor");
  });

  test("{moveDomFocus:false, restoreFirstResponder:false} leaves both to the caller (cycle pointer-exit)", () => {
    const { fm, chain } = setup();
    fm.pushFocusMode("trap", { trapped: true });
    chain.makeFirstResponder("popover");

    // The pointer-exit pop hands the next focus to the click that triggered it —
    // the engine must NOT reinstate the captured responder.
    fm.popFocusMode("trap", { moveDomFocus: false, restoreFirstResponder: false });
    expect(chain.getFirstResponder()).toBe("popover");
  });

  test("{moveDomFocus:false, restoreFirstResponder:true} restores the first responder and key-view state", () => {
    const { fm, chain } = setup();
    fm.pushFocusMode("trap", { trapped: true });
    chain.makeFirstResponder("popover");

    // A deferring surface (popover/sheet) restores the LOGICAL state — first
    // responder + key view — while its own teardown writer owns the DOM move.
    fm.popFocusMode("trap", { moveDomFocus: false, restoreFirstResponder: true });
    expect(chain.getFirstResponder()).toBe("editor");
    expect(fm.keyView()).toBe("editor");
  });

  test("a captured responder that unmounted before pop is not forced back", () => {
    const { fm, chain } = setup();
    fm.pushFocusMode("trap", { trapped: true });
    chain.makeFirstResponder("popover");
    // The captured prior responder's surface unmounted while the trap was open.
    chain.unregister("editor");

    fm.popFocusMode("trap");
    // No dangling restore: the engine only reinstates a still-registered responder.
    expect(chain.getFirstResponder()).toBe("popover");
  });

  test("a card's pop does not reclaim first responder once another card is key", () => {
    const chain = new ResponderChainManager();
    const fm = new FocusManager();
    fm.attach(chain);
    chain.register({ id: "session-editor", parentId: null, actions: {} });
    chain.register({ id: "commit-card", parentId: null, actions: {} });
    chain.makeFirstResponder("session-editor");
    fm.setKeyCard("session");

    // A context menu over the session card's transcript pushes its trap on
    // that card's context, capturing the session editor as first responder…
    const ctx = fm.contextFor("session");
    ctx.pushFocusMode("menu", { trapped: true, kbf: false });
    // …and its Open Commit item raises the Commit card, which takes key and
    // first responder before the menu closes.
    fm.setKeyCard("commit");
    chain.makeFirstResponder("commit-card");

    // The menu closes. Restoring would route ⌘W to the session card while
    // the Commit card still looks active.
    ctx.popFocusMode("menu");
    expect(chain.getFirstResponder()).toBe("commit-card");
  });
});
