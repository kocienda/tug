/**
 * The text-editing context menu dims from the same validity the native Edit
 * menu is gated on.
 *
 * It used to dim from capability flags the calling surface asserted for
 * itself — a second, independent definition of "can this surface be pasted
 * into", which is how the two menus came to disagree about the same six
 * commands in the same state.
 *
 * The one fact that stays the caller's is the selection, and deliberately:
 * the menu-state mirror republishes on focus and registration changes, not
 * on caret moves, so the chain's answer is not selection-granular. A context
 * menu is built at the instant it opens and can read the live selection.
 */

import { describe, expect, test } from "bun:test";

import { ResponderChainManager } from "../responder-chain";
import { TUG_ACTIONS } from "../action-vocabulary";
import { EMPTY_MENU_FACTS } from "../command-registry";
import type { CommandValidationSource } from "../command-registry";
import { buildTextEditingMenuItems } from "../text-editing-menu";

function source(chain: ResponderChainManager): CommandValidationSource {
  return {
    validateAction: (action) => chain.validateAction(action),
    validateActionInKeyCard: (action) => chain.validateActionInKeyCard(action),
    queryActionState: (action) => chain.queryActionState(action),
    queryActionStateInKeyCard: (action) => chain.queryActionStateInKeyCard(action),
    menu: EMPTY_MENU_FACTS,
  };
}

function disabledOf(
  entries: ReturnType<typeof buildTextEditingMenuItems>,
  action: string,
): boolean | undefined {
  return entries.find((e) => e.action === action)?.disabled;
}

/** An editable surface: handles the clipboard verbs, all of them live. */
function editableChain(): ResponderChainManager {
  const chain = new ResponderChainManager();
  chain.register({
    id: "editor",
    parentId: null,
    actions: {
      [TUG_ACTIONS.CUT]: () => {},
      [TUG_ACTIONS.COPY]: () => {},
      [TUG_ACTIONS.COPY_ALTERNATE]: () => {},
      [TUG_ACTIONS.PASTE]: () => {},
      [TUG_ACTIONS.PASTE_AS_QUOTE]: () => {},
      [TUG_ACTIONS.PASTE_AS_PLAIN_TEXT]: () => {},
      [TUG_ACTIONS.SELECT_ALL]: () => {},
    },
  });
  chain.makeFirstResponder("editor");
  return chain;
}

describe("text-editing menu validity", () => {
  test("an editable surface with a selection offers everything", () => {
    const entries = buildTextEditingMenuItems({
      hasSelection: true,
      source: source(editableChain()),
    });

    expect(disabledOf(entries, TUG_ACTIONS.CUT)).toBe(false);
    expect(disabledOf(entries, TUG_ACTIONS.COPY)).toBe(false);
    expect(disabledOf(entries, TUG_ACTIONS.PASTE)).toBe(false);
    expect(disabledOf(entries, TUG_ACTIONS.SELECT_ALL)).toBe(false);
  });

  test("no selection dims the verbs that need one, and only those", () => {
    const entries = buildTextEditingMenuItems({
      hasSelection: false,
      source: source(editableChain()),
    });

    expect(disabledOf(entries, TUG_ACTIONS.CUT)).toBe(true);
    expect(disabledOf(entries, TUG_ACTIONS.COPY)).toBe(true);
    expect(disabledOf(entries, TUG_ACTIONS.COPY_ALTERNATE)).toBe(true);
    // Paste needs somewhere to land, not something selected.
    expect(disabledOf(entries, TUG_ACTIONS.PASTE)).toBe(false);
    expect(disabledOf(entries, TUG_ACTIONS.SELECT_ALL)).toBe(false);
  });

  test("a read-only surface's own validateAction dims the mutating verbs", () => {
    // The markdown view's shape: it absorbs Cut and Paste so they stop at a
    // read-only surface, and says so through validateAction. Without the
    // predicate, absorbing them would read as handling them.
    const chain = new ResponderChainManager();
    chain.register({
      id: "read-only",
      parentId: null,
      actions: {
        [TUG_ACTIONS.CUT]: () => {},
        [TUG_ACTIONS.COPY]: () => {},
        [TUG_ACTIONS.PASTE]: () => {},
        [TUG_ACTIONS.SELECT_ALL]: () => {},
      },
      validateAction: (action) =>
        action !== TUG_ACTIONS.CUT && action !== TUG_ACTIONS.PASTE,
    });
    chain.makeFirstResponder("read-only");

    const entries = buildTextEditingMenuItems({
      hasSelection: true,
      source: source(chain),
    });

    expect(disabledOf(entries, TUG_ACTIONS.CUT)).toBe(true);
    expect(disabledOf(entries, TUG_ACTIONS.PASTE)).toBe(true);
    expect(disabledOf(entries, TUG_ACTIONS.COPY)).toBe(false);
    expect(disabledOf(entries, TUG_ACTIONS.SELECT_ALL)).toBe(false);
  });

  test("a surface that handles nothing offers nothing", () => {
    const chain = new ResponderChainManager();
    chain.register({ id: "label", parentId: null, actions: {} });
    chain.makeFirstResponder("label");

    const entries = buildTextEditingMenuItems({
      hasSelection: true,
      source: source(chain),
    });

    for (const action of [
      TUG_ACTIONS.CUT,
      TUG_ACTIONS.COPY,
      TUG_ACTIONS.PASTE,
      TUG_ACTIONS.SELECT_ALL,
    ]) {
      expect(disabledOf(entries, action), `${action} dimmed`).toBe(true);
    }
  });

  test("the context menu and the native Edit menu agree, command by command", () => {
    // Both sides ask `validateCommand` over the same source; the context
    // menu narrows Cut and Copy further by the selection it sampled. With a
    // selection present there is nothing left to differ about.
    const chain = editableChain();
    const src = source(chain);
    const entries = buildTextEditingMenuItems({ hasSelection: true, source: src });

    for (const action of [
      TUG_ACTIONS.CUT,
      TUG_ACTIONS.COPY,
      TUG_ACTIONS.PASTE,
      TUG_ACTIONS.SELECT_ALL,
    ]) {
      expect(disabledOf(entries, action), `${action} agrees with the chain`).toBe(
        !src.validateAction(action),
      );
    }
  });
});
