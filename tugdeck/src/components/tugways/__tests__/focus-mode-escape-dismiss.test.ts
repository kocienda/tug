/**
 * FocusManager — pure-logic tests for the `onEscapeDismiss` axis of the mode
 * stack ([P01]/[P02] of the engine-owned-Escape model).
 *
 * The Escape ladder asks the mode stack one question — "does the top surface own
 * its own dismissal?" — via `currentFocusModeOnEscapeDismiss()`. These pin the
 * stack's data-in / data-out for that question against the real `FocusManager`:
 * the callback registered at push is what the top-of-stack accessor returns; a
 * surface mode pushed over a focus-cycle hides the cycle's `escapeExits` until it
 * pops; and neither push nor pop ever *invokes* the callback (only the ladder, in
 * the DOM listener, does). No DOM — the stack bookkeeping is the surface under
 * test (bun:test has no document).
 */

import { describe, expect, test } from "bun:test";

import { FocusManager } from "../focus-manager";
import { ResponderChainManager } from "../responder-chain";

function setup(): { fm: FocusManager } {
  const chain = new ResponderChainManager();
  const fm = new FocusManager();
  fm.attach(chain);
  chain.register({ id: "editor", parentId: null, actions: {} });
  return { fm };
}

describe("FocusManager onEscapeDismiss accessor", () => {
  test("a mode pushed with onEscapeDismiss exposes it at top-of-stack; without, null", () => {
    const { fm } = setup();
    expect(fm.currentFocusModeOnEscapeDismiss()).toBeNull(); // base mode

    const dismiss = () => {};
    fm.pushFocusMode("surface", { trapped: true, onEscapeDismiss: dismiss });
    expect(fm.currentFocusModeOnEscapeDismiss()).toBe(dismiss);

    fm.popFocusMode("surface");
    expect(fm.currentFocusModeOnEscapeDismiss()).toBeNull();

    // A trapped mode with no callback (e.g. a cycle) reports null.
    fm.pushFocusMode("cycle", { trapped: true, escapeExits: true });
    expect(fm.currentFocusModeOnEscapeDismiss()).toBeNull();
  });

  test("a callback-bearing surface pushed over a cycle hides the cycle's escapeExits until it pops", () => {
    const { fm } = setup();
    // A focus-cycle: trapped, escapeExits, no dismiss callback (the engine exits it
    // structurally via escapeCurrentMode — ladder branch 5).
    fm.pushFocusMode("cycle", { trapped: true, escapeExits: true });
    expect(fm.currentFocusModeEscapeExits()).toBe(true);
    expect(fm.currentFocusModeOnEscapeDismiss()).toBeNull();

    // A surface (popover) opens over the cycle with its own dismiss callback.
    const dismiss = () => {};
    fm.pushFocusMode("surface", { trapped: true, onEscapeDismiss: dismiss });
    // The ladder now sees the SURFACE on top: its callback is returned (branch 2),
    // and the cycle's escapeExits is masked (branch 5 is unreachable until pop).
    expect(fm.currentFocusModeOnEscapeDismiss()).toBe(dismiss);
    expect(fm.currentFocusModeEscapeExits()).toBe(false);

    // The surface closes → the cycle is top again, escapeExits resurfaces.
    fm.popFocusMode("surface");
    expect(fm.currentFocusModeOnEscapeDismiss()).toBeNull();
    expect(fm.currentFocusModeEscapeExits()).toBe(true);
  });

  test("neither push nor pop invokes the dismiss callback (only the ladder does)", () => {
    const { fm } = setup();
    let calls = 0;
    const dismiss = () => {
      calls += 1;
    };
    fm.pushFocusMode("surface", { trapped: true, onEscapeDismiss: dismiss });
    expect(calls).toBe(0);
    fm.popFocusMode("surface");
    expect(calls).toBe(0);
    // The accessor merely returns it — invoking is the ladder's job.
    fm.pushFocusMode("surface2", { trapped: true, onEscapeDismiss: dismiss });
    const got = fm.currentFocusModeOnEscapeDismiss();
    expect(got).toBe(dismiss);
    expect(calls).toBe(0);
  });
});

describe("FocusManager editorKeepsEscape", () => {
  // The ladder's tab-consume rung: a focused editor sets the marker for as long
  // as it holds focus, so the marker alone kept every Escape in the composer,
  // and a popover opened with the pointer over it could not be closed from the
  // keyboard (at0423).
  test("at the base mode, and under a non-trapped scope, the editor keeps Escape", () => {
    const { fm } = setup();
    expect(fm.editorKeepsEscape("composer")).toBe(true);
    expect(fm.editorKeepsEscape(null)).toBe(true);
    fm.pushFocusMode("row", { trapped: false });
    expect(fm.editorKeepsEscape("composer")).toBe(true);
  });

  test("under a trapped surface, an editor beneath it gives Escape to the surface", () => {
    const { fm } = setup();
    fm.registerFocusable({ id: "composer", group: "body", order: 0 });
    fm.pushFocusMode("popover", { trapped: true, onEscapeDismiss: () => {} });
    expect(fm.editorKeepsEscape("composer")).toBe(false);
    expect(fm.editorKeepsEscape(null)).toBe(false);
  });

  test("under a trapped surface, the surface's own field keeps Escape", () => {
    const { fm } = setup();
    fm.registerFocusable({ id: "sheet-field", group: "sheet", order: 0, modes: ["sheet"] });
    fm.pushFocusMode("sheet", { trapped: true, onEscapeDismiss: () => {} });
    expect(fm.editorKeepsEscape("sheet-field")).toBe(true);
    fm.popFocusMode("sheet");
    expect(fm.editorKeepsEscape("sheet-field")).toBe(true);
  });
});
