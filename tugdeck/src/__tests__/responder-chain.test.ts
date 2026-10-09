/**
 * ResponderChainManager unit tests -- Step 1.
 *
 * Tests cover:
 * - register: node appears in the manager
 * - unregister: node is removed
 * - dispatch: correct handler is called
 * - chain walk: walk-up to parent when child doesn't handle
 * - canHandle: returns true for registered action, false for unknown
 * - validateAction: returns handler's validate result
 * - validateAction: defaults to true when handler has no validate function
 * - makeFirstResponder / resignFirstResponder increment validation version
 * - subscription callback fires on version increment
 * - dispatch returns false when no handler found
 * - unregister first responder auto-promotes parent
 * - unregister first responder with no parent sets firstResponderId to null
 * - register root node auto-promotes to first responder when firstResponderId is null
 * - register root node does NOT change firstResponderId when already set
 * - register non-root node does NOT auto-promote when firstResponderId is null
 */

import { describe, it, expect } from "bun:test";
import { ResponderChainManager } from "../components/tugways/responder-chain";
import type { ActionEvent, ActionHandler } from "../components/tugways/responder-chain";
import type { TugAction } from "../components/tugways/action-vocabulary";

// ---- Helpers ----

function makeManager(): ResponderChainManager {
  return new ResponderChainManager();
}

// Tests below use synthetic action names (e.g. "foo", "bar", "ping",
// "dynamic-action") to exercise ResponderChainManager's dispatch
// mechanics independent of the production `TugAction` vocabulary. The
// chain must work for any action name — the vocabulary is a separate
// layer. These two helpers cast string literals and action-keyed
// records so the synthetic names type-check without widening the
// production signatures.
const asActions = (a: Record<string, ActionHandler>) =>
  a as unknown as Partial<Record<TugAction, ActionHandler>>;
const asAction = (name: string) => name as unknown as TugAction;

// ---- register ----

describe("register", () => {
  it("node appears in the manager (dispatch reaches it)", () => {
    const mgr = makeManager();
    let called = false;
    mgr.register({ id: "root", parentId: null, actions: asActions({ foo: (_event: ActionEvent) => { called = true; } }) });
    mgr.sendToFirstResponder({ action: asAction("foo"), phase: "discrete" });
    expect(called).toBe(true);
  });

  it("auto-promotes root node to first responder when firstResponderId is null", () => {
    const mgr = makeManager();
    expect(mgr.getFirstResponder()).toBe(null);
    mgr.register({ id: "root", parentId: null, actions: {} });
    expect(mgr.getFirstResponder()).toBe("root");
  });

  it("increments validationVersion when auto-promoting root", () => {
    const mgr = makeManager();
    const v0 = mgr.getValidationVersion();
    mgr.register({ id: "root", parentId: null, actions: {} });
    expect(mgr.getValidationVersion()).toBe(v0 + 1);
  });

  it("does NOT change firstResponderId when already set (root node)", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    expect(mgr.getFirstResponder()).toBe("root");
    mgr.register({ id: "root2", parentId: null, actions: {} });
    expect(mgr.getFirstResponder()).toBe("root");
  });

  it("does NOT auto-promote non-root node when firstResponderId is null", () => {
    const mgr = makeManager();
    // Register parent first so the child's parentId exists
    mgr.register({ id: "root", parentId: null, actions: {} });
    // Reset so firstResponderId is null but root exists
    // Use makeFirstResponder then resignFirstResponder to clear it
    mgr.resignFirstResponder();
    expect(mgr.getFirstResponder()).toBe(null);

    const vBefore = mgr.getValidationVersion();
    mgr.register({ id: "child", parentId: "root", actions: {} });
    // firstResponderId should still be null
    expect(mgr.getFirstResponder()).toBe(null);
    // No auto-promote so version should not change from register
    expect(mgr.getValidationVersion()).toBe(vBefore);
  });
});

// ---- unregister ----

describe("unregister", () => {
  it("removes node from the manager (dispatch no longer reaches it)", () => {
    const mgr = makeManager();
    let called = false;
    mgr.register({ id: "root", parentId: null, actions: asActions({ bar: (_event: ActionEvent) => { called = true; } }) });
    mgr.unregister("root");
    mgr.sendToFirstResponder({ action: asAction("bar"), phase: "discrete" });
    expect(called).toBe(false);
  });

  it("auto-promotes parent when unregistered node was first responder", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({ id: "child", parentId: "root", actions: {} });
    mgr.makeFirstResponder("child");
    expect(mgr.getFirstResponder()).toBe("child");

    mgr.unregister("child");
    expect(mgr.getFirstResponder()).toBe("root");
  });

  it("sets firstResponderId to null when unregistered node has no parent", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    expect(mgr.getFirstResponder()).toBe("root");
    mgr.unregister("root");
    expect(mgr.getFirstResponder()).toBe(null);
  });

  it("increments validationVersion when first responder is removed", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    const v0 = mgr.getValidationVersion();
    mgr.unregister("root");
    expect(mgr.getValidationVersion()).toBeGreaterThan(v0);
  });

});

// ---- dispatch ----

describe("dispatch", () => {
  it("calls the correct handler", () => {
    const mgr = makeManager();
    const calls: string[] = [];
    mgr.register({ id: "root", parentId: null, actions: asActions({ ping: (_event: ActionEvent) => { calls.push("ping"); } }) });
    const result = mgr.sendToFirstResponder({ action: asAction("ping"), phase: "discrete" });
    expect(result).toBe(true);
    expect(calls).toEqual(["ping"]);
  });

  it("walks up to parent when child does not handle the action", () => {
    const mgr = makeManager();
    let parentHandled = false;
    mgr.register({ id: "root", parentId: null, actions: asActions({ bubbled: (_event: ActionEvent) => { parentHandled = true; } }) });
    mgr.register({ id: "child", parentId: "root", actions: {} });
    mgr.makeFirstResponder("child");

    const result = mgr.sendToFirstResponder({ action: asAction("bubbled"), phase: "discrete" });
    expect(result).toBe(true);
    expect(parentHandled).toBe(true);
  });

  it("returns false when no handler found in chain", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    const result = mgr.sendToFirstResponder({ action: asAction("no-such-action"), phase: "discrete" });
    expect(result).toBe(false);
  });

  it("does not consult canHandle function -- only actions map", () => {
    const mgr = makeManager();
    let canHandleCalled = false;
    mgr.register({
      id: "root",
      parentId: null,
      actions: {}, // action NOT in map
      canHandle: (_action: string) => {
        canHandleCalled = true;
        return true; // claims it can handle everything
      },
    });
    const result = mgr.sendToFirstResponder({ action: asAction("anything"), phase: "discrete" });
    expect(result).toBe(false);
    expect(canHandleCalled).toBe(false);
  });
});

// ---- canHandle ----

describe("canHandle", () => {
  it("returns true for an action in the actions map", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: { copy: (_event: ActionEvent) => {} } });
    expect(mgr.canHandle("copy")).toBe(true);
  });

  it("returns false for an unknown action", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: { copy: (_event: ActionEvent) => {} } });
    expect(mgr.canHandle("paste")).toBe(false);
  });

  it("returns true for action reported by canHandle function (dynamic override)", () => {
    const mgr = makeManager();
    mgr.register({
      id: "root",
      parentId: null,
      actions: {},
      canHandle: (action: string) => action === "dynamic-action",
    });
    expect(mgr.canHandle(asAction("dynamic-action"))).toBe(true);
  });

  it("walks up to parent when child doesn't handle", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: asActions({ "root-action": (_event: ActionEvent) => {} }) });
    mgr.register({ id: "child", parentId: "root", actions: {} });
    mgr.makeFirstResponder("child");
    expect(mgr.canHandle(asAction("root-action"))).toBe(true);
  });

  it("returns false when firstResponderId is null", () => {
    const mgr = makeManager();
    expect(mgr.canHandle(asAction("anything"))).toBe(false);
  });
});

// ---- validateAction ----

describe("validateAction", () => {
  it("returns the handler's validateAction result (false)", () => {
    const mgr = makeManager();
    mgr.register({
      id: "root",
      parentId: null,
      actions: { cut: (_event: ActionEvent) => {} },
      validateAction: (_action: string) => false,
    });
    expect(mgr.validateAction("cut")).toBe(false);
  });

  it("returns the handler's validateAction result (true)", () => {
    const mgr = makeManager();
    mgr.register({
      id: "root",
      parentId: null,
      actions: { cut: (_event: ActionEvent) => {} },
      validateAction: (_action: string) => true,
    });
    expect(mgr.validateAction("cut")).toBe(true);
  });

  it("defaults to true when handler has no validateAction function", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: { paste: (_event: ActionEvent) => {} } });
    expect(mgr.validateAction("paste")).toBe(true);
  });

  it("returns false when no responder can handle the action", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    expect(mgr.validateAction(asAction("nonexistent"))).toBe(false);
  });
});

// ---- makeFirstResponder / resignFirstResponder ----

describe("makeFirstResponder and resignFirstResponder", () => {
  it("makeFirstResponder increments validationVersion", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({ id: "child", parentId: "root", actions: {} });
    const v0 = mgr.getValidationVersion();
    mgr.makeFirstResponder("child");
    expect(mgr.getValidationVersion()).toBe(v0 + 1);
  });

  it("resignFirstResponder increments validationVersion", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    const v0 = mgr.getValidationVersion();
    mgr.resignFirstResponder();
    expect(mgr.getValidationVersion()).toBe(v0 + 1);
  });

  it("resignFirstResponder clears first responder", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    expect(mgr.getFirstResponder()).toBe("root");
    mgr.resignFirstResponder();
    expect(mgr.getFirstResponder()).toBe(null);
  });
});

// ---- subscribe ----

describe("subscribe", () => {
  it("subscription callback fires on validationVersion increment (makeFirstResponder)", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({ id: "child", parentId: "root", actions: {} });

    let callCount = 0;
    mgr.subscribe(() => { callCount++; });
    mgr.makeFirstResponder("child");
    expect(callCount).toBe(1);
  });

  it("subscription callback fires on resignFirstResponder", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    let callCount = 0;
    mgr.subscribe(() => { callCount++; });
    mgr.resignFirstResponder();
    expect(callCount).toBe(1);
  });

  it("unsubscribe stops callback from firing", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({ id: "child", parentId: "root", actions: {} });

    let callCount = 0;
    const unsubscribe = mgr.subscribe(() => { callCount++; });
    unsubscribe();
    mgr.makeFirstResponder("child");
    expect(callCount).toBe(0);
  });

  it("multiple subscribers all receive notifications", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });

    let count1 = 0;
    let count2 = 0;
    mgr.subscribe(() => { count1++; });
    mgr.subscribe(() => { count2++; });
    mgr.resignFirstResponder();
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});

// ---- sendToTarget ----

describe("sendToTarget", () => {
  it("delivers action to registered target and returns true", () => {
    const mgr = makeManager();
    let handled = false;
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({ id: "target", parentId: "root", actions: asActions({ save: (_event: ActionEvent) => { handled = true; } }) });
    const result = mgr.sendToTarget("target", { action: asAction("save"), phase: "discrete" });
    expect(result).toBe(true);
    expect(handled).toBe(true);
  });

  it("walks up the chain when target does not handle the action", () => {
    // A6: sendToTarget now starts the walk at the target and continues
    // upward via parentId until some ancestor handles the action.
    // Previously this returned false without walking.
    const mgr = makeManager();
    const calls: string[] = [];
    mgr.register({
      id: "root",
      parentId: null,
      actions: asActions({ save: (_event: ActionEvent) => { calls.push("root"); } }),
    });
    mgr.register({
      id: "target",
      parentId: "root",
      actions: asActions({ other: (_event: ActionEvent) => { calls.push("target-other"); } }),
    });
    const result = mgr.sendToTarget("target", { action: asAction("save"), phase: "discrete" });
    expect(result).toBe(true);
    expect(calls).toEqual(["root"]);
  });

  it("returns false when neither target nor any ancestor handles the action", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({
      id: "target",
      parentId: "root",
      actions: asActions({ save: (_event: ActionEvent) => {} }),
    });
    const result = mgr.sendToTarget("target", { action: asAction("delete"), phase: "discrete" });
    expect(result).toBe(false);
  });

  it("throws Error with descriptive message when target is not registered", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    expect(() => mgr.sendToTarget("ghost", { action: asAction("save"), phase: "discrete" })).toThrow(
      'sendToTargetForContinuation: target "ghost" is not registered'
    );
  });

  it("starts the walk at the target, not at the current first responder", () => {
    // A6: the walk always begins at the explicit targetId, not at
    // firstResponderId. If both target and first responder handle the
    // action, only the target's handler runs — the walk starts there
    // and stops on the first match.
    const mgr = makeManager();
    const calls: string[] = [];
    mgr.register({
      id: "root",
      parentId: null,
      actions: asActions({ save: (_event: ActionEvent) => { calls.push("root"); } }),
    });
    mgr.register({
      id: "target",
      parentId: "root",
      actions: asActions({ save: (_event: ActionEvent) => { calls.push("target"); } }),
    });
    // First responder is root (auto-promoted), but we dispatch directly to target.
    expect(mgr.getFirstResponder()).toBe("root");
    mgr.sendToTarget("target", { action: asAction("save"), phase: "discrete" });
    expect(calls).toEqual(["target"]);
  });

  it("dispatchToForContinuation walks up the chain when target does not handle", () => {
    // A6: dispatchToForContinuation gets the same walk-up treatment as
    // sendToTarget. If the target doesn't handle, an ancestor's handler
    // runs and its continuation flows back to the caller.
    const mgr = makeManager();
    const continuationCalls: string[] = [];
    mgr.register({
      id: "root",
      parentId: null,
      actions: asActions({
        cut: (_event: ActionEvent) => () => { continuationCalls.push("root-continuation"); },
      }),
    });
    mgr.register({
      id: "target",
      parentId: "root",
      actions: {},
    });
    const result = mgr.sendToTargetForContinuation("target", {
      action: asAction("cut"),
      phase: "discrete",
    });
    expect(result.handled).toBe(true);
    expect(typeof result.continuation).toBe("function");
    result.continuation?.();
    expect(continuationCalls).toEqual(["root-continuation"]);
  });

  it("notifies dispatch observers after the walk regardless of outcome", () => {
    const mgr = makeManager();
    const observerCalls: Array<{ action: string; handled: boolean }> = [];
    mgr.observeDispatch((event, handled) => {
      observerCalls.push({ action: event.action, handled });
    });
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({ id: "target", parentId: "root", actions: {} });
    // Unhandled: walk falls off the root, handled = false.
    mgr.sendToTarget("target", { action: asAction("delete"), phase: "discrete" });
    expect(observerCalls).toEqual([{ action: "delete", handled: false }]);
  });
});

// ---- nodeCanHandle ----

describe("nodeCanHandle", () => {
  it("returns true when node has action in actions map", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: { copy: (_event: ActionEvent) => {} } });
    expect(mgr.nodeCanHandle("root", "copy")).toBe(true);
  });

  it("returns true when node's canHandle callback returns true", () => {
    const mgr = makeManager();
    mgr.register({
      id: "root",
      parentId: null,
      actions: {},
      canHandle: (action: string) => action === "dynamic-action",
    });
    expect(mgr.nodeCanHandle("root", asAction("dynamic-action"))).toBe(true);
  });

  it("returns false when node does not handle action", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: { copy: (_event: ActionEvent) => {} } });
    expect(mgr.nodeCanHandle("root", "paste")).toBe(false);
  });

  it("returns false when node is not registered", () => {
    const mgr = makeManager();
    expect(mgr.nodeCanHandle("ghost", "copy")).toBe(false);
  });
});

// ---- Edge cases ----

describe("edge cases", () => {
  it("dispatch returns false when firstResponderId is null", () => {
    const mgr = makeManager();
    expect(mgr.sendToFirstResponder({ action: asAction("foo"), phase: "discrete" })).toBe(false);
  });

  it("unregister non-first-responder does not change firstResponderId", () => {
    const mgr = makeManager();
    mgr.register({ id: "root", parentId: null, actions: {} });
    mgr.register({ id: "child", parentId: "root", actions: {} });
    // root is first responder (auto-promoted)
    expect(mgr.getFirstResponder()).toBe("root");
    mgr.unregister("child");
    expect(mgr.getFirstResponder()).toBe("root");
  });

  it("dispatch only calls handler for matching action, not all actions", () => {
    const mgr = makeManager();
    const calls: string[] = [];
    mgr.register({
      id: "root",
      parentId: null,
      actions: asActions({
        a: (_event: ActionEvent) => { calls.push("a"); },
        b: (_event: ActionEvent) => { calls.push("b"); },
      }),
    });
    mgr.sendToFirstResponder({ action: asAction("a"), phase: "discrete" });
    expect(calls).toEqual(["a"]);
  });
});

// ---- getKeyResponderOfKind / getKeyCard ----

describe("getKeyResponderOfKind", () => {
  it("returns null when no first responder is set", () => {
    const mgr = makeManager();
    expect(mgr.getKeyResponderOfKind("card")).toBe(null);
    expect(mgr.getKeyCard()).toBe(null);
  });

  it("returns the first responder's id when it is itself of the requested kind", () => {
    const mgr = makeManager();
    mgr.register({ id: "card-1", parentId: null, actions: {}, kind: "card" });
    expect(mgr.getKeyCard()).toBe("card-1");
  });

  it("walks up parentId past untagged ancestors to find the nearest tagged one", () => {
    const mgr = makeManager();
    mgr.register({ id: "canvas", parentId: null, actions: {} });
    mgr.register({ id: "card-1", parentId: "canvas", actions: {}, kind: "card" });
    mgr.register({ id: "editor", parentId: "card-1", actions: {} });
    mgr.makeFirstResponder("editor");
    expect(mgr.getKeyCard()).toBe("card-1");
  });

  it("returns null when no ancestor matches the requested kind", () => {
    const mgr = makeManager();
    mgr.register({ id: "canvas", parentId: null, actions: {} });
    mgr.register({ id: "child", parentId: "canvas", actions: {} });
    mgr.makeFirstResponder("child");
    expect(mgr.getKeyCard()).toBe(null);
  });

  it("returns the innermost tagged ancestor when nested cards exist", () => {
    const mgr = makeManager();
    mgr.register({ id: "canvas", parentId: null, actions: {} });
    mgr.register({ id: "outer-card", parentId: "canvas", actions: {}, kind: "card" });
    mgr.register({ id: "inner-card", parentId: "outer-card", actions: {}, kind: "card" });
    mgr.register({ id: "editor", parentId: "inner-card", actions: {} });
    mgr.makeFirstResponder("editor");
    expect(mgr.getKeyCard()).toBe("inner-card");
  });

  it("updates as first responder moves between cards", () => {
    const mgr = makeManager();
    mgr.register({ id: "canvas", parentId: null, actions: {} });
    mgr.register({ id: "card-a", parentId: "canvas", actions: {}, kind: "card" });
    mgr.register({ id: "card-b", parentId: "canvas", actions: {}, kind: "card" });
    mgr.register({ id: "editor-a", parentId: "card-a", actions: {} });
    mgr.register({ id: "editor-b", parentId: "card-b", actions: {} });

    mgr.makeFirstResponder("editor-a");
    expect(mgr.getKeyCard()).toBe("card-a");

    mgr.makeFirstResponder("editor-b");
    expect(mgr.getKeyCard()).toBe("card-b");
  });
});

// ---- observeKeyResponder ----

describe("observeKeyResponder", () => {
  it("does not fire on initial subscription", () => {
    const mgr = makeManager();
    mgr.register({ id: "card-1", parentId: null, actions: {}, kind: "card" });

    const calls: Array<string | null> = [];
    mgr.observeKeyResponder("card", (id) => { calls.push(id); });

    expect(calls).toEqual([]);
  });

  it("fires when the derived value transitions from null to a card id", () => {
    const mgr = makeManager();
    const calls: Array<string | null> = [];
    mgr.observeKeyResponder("card", (id) => { calls.push(id); });

    mgr.register({ id: "card-1", parentId: null, actions: {}, kind: "card" });

    expect(calls).toEqual(["card-1"]);
  });

  it("fires only when the derived value changes, not on every chain change", () => {
    const mgr = makeManager();
    mgr.register({ id: "canvas", parentId: null, actions: {} });
    mgr.register({ id: "card-1", parentId: "canvas", actions: {}, kind: "card" });
    mgr.register({ id: "editor-1", parentId: "card-1", actions: {} });
    mgr.makeFirstResponder("editor-1");

    const calls: Array<string | null> = [];
    mgr.observeKeyResponder("card", (id) => { calls.push(id); });

    // Move first responder within the same card. Derived value does
    // not change, so observer must not fire.
    mgr.register({ id: "editor-2", parentId: "card-1", actions: {} });
    mgr.makeFirstResponder("editor-2");
    expect(calls).toEqual([]);

    // Move first responder to a different card. Derived value
    // changes, observer fires.
    mgr.register({ id: "card-2", parentId: "canvas", actions: {}, kind: "card" });
    mgr.makeFirstResponder("card-2");
    expect(calls).toEqual(["card-2"]);
  });

  it("fires with null when the derived value transitions from a card id to null", () => {
    const mgr = makeManager();
    mgr.register({ id: "canvas", parentId: null, actions: {} });
    mgr.register({ id: "card-1", parentId: "canvas", actions: {}, kind: "card" });
    mgr.makeFirstResponder("card-1");

    const calls: Array<string | null> = [];
    mgr.observeKeyResponder("card", (id) => { calls.push(id); });

    mgr.makeFirstResponder("canvas");
    expect(calls).toEqual([null]);
  });

  it("unsubscribe stops further notifications", () => {
    const mgr = makeManager();
    mgr.register({ id: "card-1", parentId: null, actions: {}, kind: "card" });
    mgr.makeFirstResponder("card-1");

    const calls: Array<string | null> = [];
    const unsub = mgr.observeKeyResponder("card", (id) => { calls.push(id); });
    unsub();

    mgr.register({ id: "card-2", parentId: null, actions: {}, kind: "card" });
    mgr.makeFirstResponder("card-2");

    expect(calls).toEqual([]);
  });

  it("supports unsubscribe during notification without disrupting other observers", () => {
    const mgr = makeManager();
    mgr.register({ id: "canvas", parentId: null, actions: {} });
    mgr.register({ id: "card-1", parentId: "canvas", actions: {}, kind: "card" });

    const calls: string[] = [];
    let unsubA: (() => void) | null = null;
    unsubA = mgr.observeKeyResponder("card", () => {
      calls.push("a");
      unsubA?.();
    });
    mgr.observeKeyResponder("card", () => { calls.push("b"); });

    mgr.makeFirstResponder("card-1");

    // Both observers fire on the transition; A unsubscribes itself
    // mid-notification, B still fires for the same change.
    expect(calls).toEqual(["a", "b"]);

    // A second transition: A is gone, only B fires.
    calls.length = 0;
    mgr.makeFirstResponder("canvas");
    expect(calls).toEqual(["b"]);
  });
});
