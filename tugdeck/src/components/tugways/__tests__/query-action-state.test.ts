/**
 * `queryActionState` — the display-state sibling of `validateAction`.
 *
 * Validity answers "is this command available"; state answers "what does it
 * currently show" — a checkmark for a toggle, a value string for a radio
 * family. Both are asked of the responder that would perform, and both walk
 * the chain the same way, so the two can never disagree about who answered.
 *
 * The key-card variants ask from the key card's `card-content` responder
 * instead of the first responder, because that is the node a key-card-routed
 * command dispatches to. Locating that node is a DOM-subtree walk (portaled
 * card content makes the React parent the wrong answer), so the with-a-key-card
 * half is pinned by the real-app menu tests; what is testable here is the
 * without-a-key-card answer, which is the one a mirror recompute hits on every
 * deck with nothing focused.
 */

import { describe, expect, test } from "bun:test";

import { ResponderChainManager } from "../responder-chain";
import { TUG_ACTIONS } from "../action-vocabulary";

describe("queryActionState", () => {
  test("the first responder that handles the action answers", () => {
    const chain = new ResponderChainManager();
    chain.register({
      id: "parent",
      parentId: null,
      actions: { [TUG_ACTIONS.TOGGLE_JOTS]: () => {} },
      queryActionState: () => false,
    });
    chain.register({
      id: "child",
      parentId: "parent",
      actions: { [TUG_ACTIONS.TOGGLE_JOTS]: () => {} },
      queryActionState: () => true,
    });
    chain.makeFirstResponder("child");

    expect(chain.queryActionState(TUG_ACTIONS.TOGGLE_JOTS)).toBe(true);
  });

  test("the walk terminates at the handler, not at the first state hook", () => {
    // The inner node handles the action and offers no state; the outer node
    // has a state hook. First-handler-terminates means the answer is
    // "nothing to show", not the ancestor's opinion.
    const chain = new ResponderChainManager();
    chain.register({
      id: "parent",
      parentId: null,
      actions: { [TUG_ACTIONS.TOGGLE_JOTS]: () => {} },
      queryActionState: () => true,
    });
    chain.register({
      id: "child",
      parentId: "parent",
      actions: { [TUG_ACTIONS.TOGGLE_JOTS]: () => {} },
    });
    chain.makeFirstResponder("child");

    expect(chain.queryActionState(TUG_ACTIONS.TOGGLE_JOTS)).toBeUndefined();
  });

  test("an unhandled action answers undefined", () => {
    const chain = new ResponderChainManager();
    chain.register({
      id: "node",
      parentId: null,
      actions: { [TUG_ACTIONS.TOGGLE_JOTS]: () => {} },
      queryActionState: () => true,
    });
    chain.makeFirstResponder("node");

    expect(chain.queryActionState(TUG_ACTIONS.SAVE)).toBeUndefined();
  });

  test("a string return survives the walk", () => {
    // The radio-family shape: one resolver answers the current value and
    // the caller narrows it per entry.
    const chain = new ResponderChainManager();
    chain.register({
      id: "session",
      parentId: null,
      actions: { [TUG_ACTIONS.SET_PANE_WIDTH]: () => {} },
      queryActionState: () => "comfy",
    });
    chain.makeFirstResponder("session");

    expect(chain.queryActionState(TUG_ACTIONS.SET_PANE_WIDTH)).toBe("comfy");
  });

  test("the advisory canHandle makes a node the answering responder", () => {
    const chain = new ResponderChainManager();
    chain.register({
      id: "last-resort",
      parentId: null,
      actions: {},
      canHandle: () => true,
      queryActionState: () => false,
    });
    chain.makeFirstResponder("last-resort");

    expect(chain.queryActionState(TUG_ACTIONS.TOGGLE_JOTS)).toBe(false);
  });

  test("state is read live, so a re-query sees the new value", () => {
    let jotsVisible = false;
    const chain = new ResponderChainManager();
    chain.register({
      id: "canvas",
      parentId: null,
      actions: { [TUG_ACTIONS.TOGGLE_JOTS]: () => {} },
      queryActionState: () => jotsVisible,
    });
    chain.makeFirstResponder("canvas");

    expect(chain.queryActionState(TUG_ACTIONS.TOGGLE_JOTS)).toBe(false);
    jotsVisible = true;
    expect(chain.queryActionState(TUG_ACTIONS.TOGGLE_JOTS)).toBe(true);
  });

  test("no first responder answers undefined", () => {
    const chain = new ResponderChainManager();
    expect(chain.queryActionState(TUG_ACTIONS.TOGGLE_JOTS)).toBeUndefined();
  });
});

describe("key-card-scoped validation and state", () => {
  test("no key card answers false / undefined rather than the focused node", () => {
    // A first responder that would happily answer the first-responder walk.
    // The key-card walk must not borrow it: with no key card there is no one
    // to ask, and a key-card-routed command is unavailable.
    const chain = new ResponderChainManager();
    chain.register({
      id: "focused",
      parentId: null,
      actions: { [TUG_ACTIONS.INTERRUPT_SESSION]: () => {} },
      validateAction: () => true,
      queryActionState: () => true,
    });
    chain.makeFirstResponder("focused");

    expect(chain.validateAction(TUG_ACTIONS.INTERRUPT_SESSION)).toBe(true);
    expect(chain.validateActionInKeyCard(TUG_ACTIONS.INTERRUPT_SESSION)).toBe(false);
    expect(
      chain.queryActionStateInKeyCard(TUG_ACTIONS.INTERRUPT_SESSION),
    ).toBeUndefined();
  });
});
