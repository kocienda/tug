import { describe, it, expect, beforeEach } from "bun:test";
import {
  initActionDispatch,
  dispatchAction,
  registerAction,
  registerThemeSetter,
  registerThemeGetter,
  registerResponderChainManager,
  SHIPPED_THEME_NAMES,
  _resetForTest,
} from "../action-dispatch";
import { FeedId } from "../protocol";
import {
  sessionPrivateStore,
  type PrivateSettle,
} from "../lib/session-private-store";
import {
  sessionNameStore,
  type NameSettle,
} from "../lib/session-name-store";
import type { ActionEvent } from "../components/tugways/responder-chain";
import { ResponderChainManager } from "../components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { IMPOSITION_KINDS } from "@/lib/layout-imposer";

// Minimal mock DeckManager.
// addCard, showSingletonCard, and prepareForReload are stubs that record
// calls; other methods are omitted.
function createMockDeckManager() {
  const addCardCalls: string[] = [];
  const showSingletonCardCalls: string[] = [];
  let prepareForReloadCallCount = 0;
  return {
    addCard(componentId: string): string | null {
      addCardCalls.push(componentId);
      return null;
    },
    showSingletonCard(componentId: string): string | null {
      showSingletonCardCalls.push(componentId);
      return null;
    },
    prepareForReload(): Promise<void> {
      prepareForReloadCallCount++;
      return Promise.resolve();
    },
    _addCardCalls: addCardCalls,
    _showSingletonCardCalls: showSingletonCardCalls,
    get _prepareForReloadCallCount() { return prepareForReloadCallCount; },
  };
}

// Mock TugConnection -- initActionDispatch registers one onFrame callback.
function createMockConnection() {
  const frameCallbacks = new Map<number, (payload: Uint8Array) => void>();
  return {
    onFrame(feedId: number, cb: (payload: Uint8Array) => void): () => void {
      frameCallbacks.set(feedId, cb);
      return () => frameCallbacks.delete(feedId);
    },
    // Simulate a received Control frame for testing dispatchAction wiring.
    simulateFrame(feedId: number, payload: Uint8Array): void {
      frameCallbacks.get(feedId)?.(payload);
    },
  };
}

// ---- registerAction / dispatchAction ----

describe("registerAction / dispatchAction", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("dispatches to a registered handler", () => {
    const calls: Record<string, unknown>[] = [];
    registerAction("my-action", (payload) => calls.push(payload));

    dispatchAction({ action: "my-action", value: 42 });

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ action: "my-action", value: 42 });
  });

  it("warns and does nothing for an unknown action", () => {
    // Should not throw
    expect(() => dispatchAction({ action: "no-such-action" })).not.toThrow();
  });

  it("warns and does nothing when action field is missing", () => {
    expect(() => dispatchAction({ notAction: "oops" })).not.toThrow();
  });

  it("last registration wins for duplicate action names", () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    registerAction("dup", () => first.push(1));
    registerAction("dup", () => second.push(2));

    dispatchAction({ action: "dup" });

    expect(first.length).toBe(0);
    expect(second.length).toBe(1);
  });
});

// ---- _resetForTest ----

describe("_resetForTest", () => {
  it("clears all registered handlers", () => {
    registerAction("to-be-cleared", () => {});
    _resetForTest();

    // After reset, dispatching should warn (no handler) but not throw
    expect(() => dispatchAction({ action: "to-be-cleared" })).not.toThrow();
  });
});

// ---- initActionDispatch: Control frame wiring ----

describe("initActionDispatch: Control frame wiring", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("registers a CONTROL frame callback that dispatches actions", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: Record<string, unknown>[] = [];
    registerAction("test-wired", (p) => received.push(p));

    const payload = new TextEncoder().encode(JSON.stringify({ action: "test-wired", x: 1 }));
    conn.simulateFrame(FeedId.CONTROL, payload);

    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({ action: "test-wired", x: 1 });
  });

  it("does not throw on malformed Control frame JSON", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const bad = new TextEncoder().encode("not json {{");
    expect(() => conn.simulateFrame(FeedId.CONTROL, bad)).not.toThrow();
  });
});

// ---- reload handler ----

describe("initActionDispatch: reload", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("calls location.reload() once", async () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();

    // Stub location.reload
    const originalReload = globalThis.location?.reload;
    let reloadCount = 0;
    Object.defineProperty(globalThis, "location", {
      value: { reload: () => { reloadCount++; } },
      writable: true,
      configurable: true,
    });

    initActionDispatch(conn as any, deck as any);
    dispatchAction({ action: "reload" });

    // location.reload() is called after the async prepareForReload() resolves
    await Promise.resolve();
    expect(reloadCount).toBe(1);

    // Restore
    Object.defineProperty(globalThis, "location", {
      value: { reload: originalReload },
      writable: true,
      configurable: true,
    });
  });

  it("calls prepareForReload() before location.reload()", async () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();

    Object.defineProperty(globalThis, "location", {
      value: { reload: () => {} },
      writable: true,
      configurable: true,
    });

    initActionDispatch(conn as any, deck as any);
    dispatchAction({ action: "reload" });

    // prepareForReload is called synchronously
    expect(deck._prepareForReloadCallCount).toBe(1);
  });

  it("deduplicates: second reload is ignored", async () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();

    let reloadCount = 0;
    Object.defineProperty(globalThis, "location", {
      value: { reload: () => { reloadCount++; } },
      writable: true,
      configurable: true,
    });

    initActionDispatch(conn as any, deck as any);
    dispatchAction({ action: "reload" });
    dispatchAction({ action: "reload" });

    await Promise.resolve();
    expect(reloadCount).toBe(1);
  });

  it("deduplicates: prepareForReload called only once even when reload dispatched twice", async () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();

    Object.defineProperty(globalThis, "location", {
      value: { reload: () => {} },
      writable: true,
      configurable: true,
    });

    initActionDispatch(conn as any, deck as any);
    dispatchAction({ action: "reload" });
    dispatchAction({ action: "reload" });

    await Promise.resolve();
    expect(deck._prepareForReloadCallCount).toBe(1);
  });
});

// ---- source-tree handler ----

describe("initActionDispatch: source-tree", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("does not throw when webkit bridge is absent", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    expect(() => dispatchAction({ action: "source-tree" })).not.toThrow();
  });

  it("calls webkit bridge when present", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const posted: unknown[] = [];
    (globalThis as Record<string, unknown>).webkit = {
      messageHandlers: {
        sourceTree: { postMessage: (v: unknown) => posted.push(v) },
      },
    };

    dispatchAction({ action: "source-tree" });

    expect(posted.length).toBe(1);

    delete (globalThis as Record<string, unknown>).webkit;
  });
});

// ---- set-theme handler ----

describe("initActionDispatch: set-theme", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("calls the registered theme setter with a valid theme name", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: string[] = [];
    registerThemeSetter((theme) => received.push(theme));

    dispatchAction({ action: "set-theme", theme: "brio" });

    expect(received.length).toBe(1);
    expect(received[0]).toBe("brio");
  });

  it("calls the setter for the valid theme name brio", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: string[] = [];
    registerThemeSetter((theme) => received.push(theme));

    dispatchAction({ action: "set-theme", theme: "brio" });

    expect(received).toEqual(["brio"]);
  });

  it("accepts arbitrary theme name strings and delegates to the theme provider", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: string[] = [];
    registerThemeSetter((theme) => received.push(theme));

    // Arbitrary custom theme strings should be passed through to the theme provider
    dispatchAction({ action: "set-theme", theme: "my-custom-theme" });
    dispatchAction({ action: "set-theme", theme: "dark-forest" });

    expect(received).toEqual(["my-custom-theme", "dark-forest"]);
  });

  it("warns and does not throw when theme field is missing", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    expect(() => dispatchAction({ action: "set-theme" })).not.toThrow();
  });

  it("warns and does not throw when setter is not yet registered", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    // No registerThemeSetter call — themeSetterRef is null after _resetForTest
    expect(() => dispatchAction({ action: "set-theme", theme: "brio" })).not.toThrow();
  });

  it("uses the latest setter after re-registration", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const first: string[] = [];
    const second: string[] = [];
    registerThemeSetter((theme) => first.push(theme));
    registerThemeSetter((theme) => second.push(theme));

    dispatchAction({ action: "set-theme", theme: "brio" });

    expect(first.length).toBe(0);
    expect(second).toEqual(["brio"]);
  });
});

// ---- show-card handler (T23, T24) ----

describe("initActionDispatch: show-card – T23: routes singletons vs new cards", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("adds a fresh card for a non-singleton component", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    dispatchAction({ action: "show-card", component: "hello" });

    expect(deck._showSingletonCardCalls.length).toBe(0);
    expect(deck._addCardCalls).toEqual(["hello"]);
  });

  it("calls showSingletonCard for the singleton components", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    dispatchAction({ action: "show-card", component: "settings" });
    dispatchAction({ action: "show-card", component: "about" });

    expect(deck._showSingletonCardCalls).toEqual(["settings", "about"]);
    expect(deck._addCardCalls.length).toBe(0);
  });
});

describe("initActionDispatch: show-card – T24: missing component logs warning", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("warns and does not call showSingletonCard when component field is missing", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    expect(() => dispatchAction({ action: "show-card" })).not.toThrow();
    expect(deck._showSingletonCardCalls.length).toBe(0);
  });

  it("warns and does not call showSingletonCard when component is not a string", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    expect(() => dispatchAction({ action: "show-card", component: 42 })).not.toThrow();
    expect(deck._showSingletonCardCalls.length).toBe(0);
  });

  it("warns and does not call showSingletonCard when component is null", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    expect(() => dispatchAction({ action: "show-card", component: null })).not.toThrow();
    expect(deck._showSingletonCardCalls.length).toBe(0);
  });
});

// ---- next-theme handler ----

describe("initActionDispatch: next-theme", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("advances to the next shipped theme from the current theme", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: string[] = [];
    registerThemeSetter((theme) => received.push(theme));

    const firstTheme = SHIPPED_THEME_NAMES[0];
    const secondTheme = SHIPPED_THEME_NAMES[1];
    registerThemeGetter(() => firstTheme);

    dispatchAction({ action: "next-theme" });

    expect(received.length).toBe(1);
    expect(received[0]).toBe(secondTheme);
  });

  it("wraps around to the first theme after the last", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: string[] = [];
    registerThemeSetter((theme) => received.push(theme));

    const lastTheme = SHIPPED_THEME_NAMES[SHIPPED_THEME_NAMES.length - 1];
    registerThemeGetter(() => lastTheme);

    dispatchAction({ action: "next-theme" });

    expect(received.length).toBe(1);
    expect(received[0]).toBe(SHIPPED_THEME_NAMES[0]);
  });

  it("falls back to index 0 when the current theme is not in the shipped list", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: string[] = [];
    registerThemeSetter((theme) => received.push(theme));
    registerThemeGetter(() => "unknown-theme");

    dispatchAction({ action: "next-theme" });

    expect(received.length).toBe(1);
    expect(received[0]).toBe(SHIPPED_THEME_NAMES[0]);
  });

  it("warns and does not throw when setter is not registered", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    registerThemeGetter(() => SHIPPED_THEME_NAMES[0]);

    expect(() => dispatchAction({ action: "next-theme" })).not.toThrow();
  });

  it("uses the first shipped theme when getter is not registered", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const received: string[] = [];
    registerThemeSetter((theme) => received.push(theme));
    // No registerThemeGetter call -- themeGetterRef is null after _resetForTest.

    dispatchAction({ action: "next-theme" });

    // Falls back to SHIPPED_THEME_NAMES[0], so next is index 1
    expect(received.length).toBe(1);
    expect(received[0]).toBe(SHIPPED_THEME_NAMES[1]);
  });

  it("SHIPPED_THEME_NAMES starts with the base theme", () => {
    expect(SHIPPED_THEME_NAMES[0]).toBe("brio");
  });

  it("SHIPPED_THEME_NAMES includes every shipped theme", () => {
    for (const name of ["nocturne", "bravura", "harmony", "aria", "vivace"]) {
      expect(SHIPPED_THEME_NAMES).toContain(name);
    }
  });
});

// ---- add-card-to-active-pane handler ([D06], [D09]) ----

describe("initActionDispatch: add-card-to-active-pane", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("reaches the first responder's add-card handler", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const dispatched: ActionEvent[] = [];
    const chain = new ResponderChainManager();
    chain.register({
      id: "canvas",
      parentId: null,
      actions: {
        [TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE]: (e: ActionEvent) => { dispatched.push(e); },
      },
    });
    chain.makeFirstResponder("canvas");
    registerResponderChainManager(chain);

    dispatchAction({ action: TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE });

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.action).toBe(TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE);
    expect(dispatched[0]?.phase).toBe("discrete");
  });

  it("warns and does not throw when no ResponderChainManager is registered", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    // No registerResponderChainManager call -- ref is null after _resetForTest.
    expect(() => dispatchAction({ action: TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE })).not.toThrow();
  });

  it("uses the most recently registered manager (last-registration-wins)", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const first: ActionEvent[] = [];
    const second: ActionEvent[] = [];
    const chainFor = (sink: ActionEvent[]): ResponderChainManager => {
      const chain = new ResponderChainManager();
      chain.register({
        id: "canvas",
        parentId: null,
        actions: {
          [TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE]: (e: ActionEvent) => { sink.push(e); },
        },
      });
      chain.makeFirstResponder("canvas");
      return chain;
    };
    registerResponderChainManager(chainFor(first));
    registerResponderChainManager(chainFor(second));

    dispatchAction({ action: TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE });

    expect(first.length).toBe(0);
    expect(second.length).toBe(1);
    expect(second[0]?.action).toBe(TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE);
  });
});

// ---- close (Both: control-frame + chain action) ----

describe("initActionDispatch: close (Both)", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("reaches the first responder's close handler", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    const dispatched: ActionEvent[] = [];
    const chain = new ResponderChainManager();
    chain.register({
      id: "card",
      parentId: null,
      actions: { [TUG_ACTIONS.CLOSE]: (event: ActionEvent) => { dispatched.push(event); } },
    });
    chain.makeFirstResponder("card");
    registerResponderChainManager(chain);

    // Wire string and chain-action string are the same — the Both
    // convergence — so the Control-frame name is just TUG_ACTIONS.CLOSE.
    dispatchAction({ action: TUG_ACTIONS.CLOSE });

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.action).toBe(TUG_ACTIONS.CLOSE);
    expect(dispatched[0]?.phase).toBe("discrete");
  });

  it("warns and does not throw when no ResponderChainManager is registered", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    expect(() => dispatchAction({ action: TUG_ACTIONS.CLOSE })).not.toThrow();
  });
});

// ---- Menu-command adapters ----

describe("initActionDispatch: menu-command chain adapters", () => {
  beforeEach(() => {
    _resetForTest();
  });

  function setupWithStubManager() {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);
    const firstResponder: ActionEvent[] = [];
    const keyCard: ActionEvent[] = [];
    const continuations: string[] = [];
    registerResponderChainManager({
      // The first-responder adapters use the ForContinuation variant and
      // invoke any returned continuation immediately (native-menu
      // dispatches have no web-side blink to defer past). The stub
      // returns a continuation that records its own invocation.
      sendToFirstResponderForContinuation(event: ActionEvent) {
        firstResponder.push(event);
        return {
          handled: true,
          continuation: () => {
            continuations.push(event.action);
          },
        };
      },
      sendToKeyCardForContinuation(event: ActionEvent) {
        keyCard.push(event);
        return { handled: true };
      },
      sendToKeyCard(event: ActionEvent): boolean {
        keyCard.push(event);
        return true;
      },
    } as any);
    return { firstResponder, keyCard, continuations };
  }

  it("first-responder Both adapters re-dispatch their own action name", () => {
    const { firstResponder } = setupWithStubManager();
    for (const action of [
      TUG_ACTIONS.FIND,
      TUG_ACTIONS.FIND_NEXT,
      TUG_ACTIONS.FIND_PREVIOUS,
      TUG_ACTIONS.UNDO,
      TUG_ACTIONS.REDO,
      TUG_ACTIONS.NEXT_TAB,
      TUG_ACTIONS.PREVIOUS_TAB,
      TUG_ACTIONS.NEXT_STACK_CARD,
    ]) {
      dispatchAction({ action });
    }
    expect(firstResponder.map((e) => e.action)).toEqual([
      TUG_ACTIONS.FIND,
      TUG_ACTIONS.FIND_NEXT,
      TUG_ACTIONS.FIND_PREVIOUS,
      TUG_ACTIONS.UNDO,
      TUG_ACTIONS.REDO,
      TUG_ACTIONS.NEXT_TAB,
      TUG_ACTIONS.PREVIOUS_TAB,
      TUG_ACTIONS.NEXT_STACK_CARD,
    ]);
    expect(firstResponder.every((e) => e.phase === "discrete")).toBe(true);
  });

  it("a handler's returned continuation is invoked immediately", () => {
    // Two-phase handlers (CM6 undo/redo/select-all) defer their visible
    // side effect into the continuation; a dropped continuation means the
    // menu item "works" while doing nothing — the mouse-selected Undo bug.
    const { continuations } = setupWithStubManager();
    dispatchAction({ action: TUG_ACTIONS.UNDO });
    dispatchAction({ action: TUG_ACTIONS.REDO });
    expect(continuations).toEqual([TUG_ACTIONS.UNDO, TUG_ACTIONS.REDO]);
  });

  it("key-card Both adapters dispatch through the key-card scope", () => {
    const { firstResponder, keyCard } = setupWithStubManager();
    for (const action of [
      TUG_ACTIONS.FOCUS_PROMPT,
      TUG_ACTIONS.CYCLE_PERMISSION_MODE,
      TUG_ACTIONS.INTERRUPT_SESSION,
    ]) {
      dispatchAction({ action });
    }
    expect(keyCard.map((e) => e.action)).toEqual([
      TUG_ACTIONS.FOCUS_PROMPT,
      TUG_ACTIONS.CYCLE_PERMISSION_MODE,
      TUG_ACTIONS.INTERRUPT_SESSION,
    ]);
    expect(firstResponder.length).toBe(0);
  });

  it("adapters warn and do not throw when no manager is registered", () => {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);
    expect(() => dispatchAction({ action: TUG_ACTIONS.FIND })).not.toThrow();
    expect(() => dispatchAction({ action: TUG_ACTIONS.FOCUS_PROMPT })).not.toThrow();
  });
});

describe("initActionDispatch: run-card-command", () => {
  beforeEach(() => {
    _resetForTest();
  });

  function setupWithStubManager() {
    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);
    const keyCard: ActionEvent[] = [];
    registerResponderChainManager({
      sendToKeyCardForContinuation(event: ActionEvent) {
        keyCard.push(event);
        return { handled: true };
      },
      sendToKeyCard(event: ActionEvent): boolean {
        keyCard.push(event);
        return true;
      },
    } as any);
    return keyCard;
  }

  it("re-enters RUN_SLASH_COMMAND with name and defaulted args", () => {
    const keyCard = setupWithStubManager();
    dispatchAction({ action: "run-card-command", name: "model" });
    expect(keyCard.length).toBe(1);
    expect(keyCard[0]).toEqual({
      action: TUG_ACTIONS.RUN_SLASH_COMMAND,
      value: { name: "model", args: "" },
      phase: "discrete",
    });
  });

  it("passes explicit args through", () => {
    const keyCard = setupWithStubManager();
    dispatchAction({ action: "run-card-command", name: "rename", args: "My Session" });
    expect(keyCard[0]?.value).toEqual({ name: "rename", args: "My Session" });
  });

  it("drops a frame with a missing or non-string name", () => {
    const keyCard = setupWithStubManager();
    dispatchAction({ action: "run-card-command" });
    dispatchAction({ action: "run-card-command", name: 7 });
    expect(keyCard.length).toBe(0);
  });
});

// ---- initActionDispatch: spawn_session_ok ----

describe("initActionDispatch: spawn_session_ok", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("populates cardSessionBindingStore when ack payload is complete", async () => {
    const { cardSessionBindingStore } =
      await import("../lib/card-session-binding-store");

    // Clean any leftover binding from other tests sharing the singleton.
    cardSessionBindingStore.clearBinding("card-ack-ok");

    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    dispatchAction({
      action: "spawn_session_ok",
      card_id: "card-ack-ok",
      tug_session_id: "sess-ack-ok",
      workspace_key: "/work/canonical",
      project_dir: "/work/original",
    });

    const binding = cardSessionBindingStore.getBinding("card-ack-ok");
    expect(binding).toEqual({
      tugSessionId: "sess-ack-ok",
      workspaceKey: "/work/canonical",
      projectDir: "/work/original",
      sessionMode: "new",
    });

    cardSessionBindingStore.clearBinding("card-ack-ok");
  });

  it("falls back to workspace_key as projectDir when the ack omits project_dir", async () => {
    const { cardSessionBindingStore } =
      await import("../lib/card-session-binding-store");
    cardSessionBindingStore.clearBinding("card-ack-fallback");

    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    dispatchAction({
      action: "spawn_session_ok",
      card_id: "card-ack-fallback",
      tug_session_id: "sess-fallback",
      workspace_key: "/work/canonical-only",
    });

    const binding = cardSessionBindingStore.getBinding("card-ack-fallback");
    expect(binding?.projectDir).toBe("/work/canonical-only");
    expect(binding?.workspaceKey).toBe("/work/canonical-only");

    cardSessionBindingStore.clearBinding("card-ack-fallback");
  });

  it("seeds the chip name/tag caches from a resume ack so a mid-turn bind shows identity", async () => {
    const { sessionNameStore } = await import("../lib/session-name-store");
    const { sessionTagStore } = await import("../lib/session-tag-store");

    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    dispatchAction({
      action: "spawn_session_ok",
      card_id: "card-ack-seed",
      tug_session_id: "sess-ack-seed",
      workspace_key: "/work/canonical",
      name: "commit-inline-dialog",
      name_user_set: true,
      tag: "stout-finch",
    });

    expect(sessionNameStore.getName("sess-ack-seed")).toBe("commit-inline-dialog");
    expect(sessionTagStore.getTag("sess-ack-seed")).toBe("stout-finch");
  });

  it("a fresh-spawn ack (no row yet) does not clobber the optimistic tag", async () => {
    const { sessionTagStore } = await import("../lib/session-tag-store");

    // provisionSpawnTag set an optimistic tag before the ack round-trips.
    sessionTagStore.setTag("sess-ack-fresh", "azure-heron");

    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    dispatchAction({
      action: "spawn_session_ok",
      card_id: "card-ack-fresh",
      tug_session_id: "sess-ack-fresh",
      workspace_key: "/work/canonical",
      // Fresh spawn: the ledger row doesn't exist yet, so the ack carries
      // no name/tag. The null tag must not wipe the optimistic one.
      name: null,
      name_user_set: false,
      tag: null,
    });

    expect(sessionTagStore.getTag("sess-ack-fresh")).toBe("azure-heron");
  });

  it("ignores malformed ack payloads (missing workspace_key) without setting a binding", async () => {
    const { cardSessionBindingStore } =
      await import("../lib/card-session-binding-store");
    cardSessionBindingStore.clearBinding("card-ack-bad");

    const conn = createMockConnection();
    const deck = createMockDeckManager();
    initActionDispatch(conn as any, deck as any);

    dispatchAction({
      action: "spawn_session_ok",
      card_id: "card-ack-bad",
      tug_session_id: "sess-bad",
      // workspace_key is missing — handler should warn + skip.
    });

    expect(cardSessionBindingStore.getBinding("card-ack-bad")).toBeUndefined();
  });
});

// ---- manual save verbs ----

describe("initActionDispatch: manual save verbs", () => {
  beforeEach(() => {
    _resetForTest();
  });

  const verbs = [
    TUG_ACTIONS.SAVE_AS,
    TUG_ACTIONS.SAVE_A_COPY,
    TUG_ACTIONS.REVERT_TO_SAVED,
    TUG_ACTIONS.RELOAD_FROM_DISK,
  ];

  for (const action of verbs) {
    it(`dispatches '${action}' to the first responder`, () => {
      const conn = createMockConnection();
      const deck = createMockDeckManager();
      initActionDispatch(conn as any, deck as any);
      const dispatched: ActionEvent[] = [];
      const chain = new ResponderChainManager();
      chain.register({
        id: "editor",
        parentId: null,
        actions: { [action]: (e: ActionEvent) => { dispatched.push(e); } },
      });
      chain.makeFirstResponder("editor");
      registerResponderChainManager(chain);

      dispatchAction({ action });
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.action).toBe(action);
      expect(dispatched[0]?.phase).toBe("discrete");
    });
  }
});

// ---- imposition verbs ----

describe("initActionDispatch: imposition verbs", () => {
  beforeEach(() => {
    _resetForTest();
  });

  // The deck reads its own panes back after an assignment (to flash the pane
  // the card landed in), so the mock has to keep a snapshot the assignment
  // moves — a bare recorder would make the handler read `undefined`.
  function wire() {
    const impositions: (string | null)[] = [];
    const assignments: { cardId: string; slot: number }[] = [];
    const panes = [
      { id: "pane-1", cardIds: ["card-1"], slot: undefined as number | undefined },
      { id: "pane-2", cardIds: ["card-2"], slot: undefined as number | undefined },
    ];
    const conn = createMockConnection();
    const deck = {
      ...createMockDeckManager(),
      setImposition(kind: string | null): void {
        impositions.push(kind);
      },
      assignCardsToSlots(
        entries: readonly { cardId: string; slot: number }[],
      ): void {
        for (const { cardId, slot } of entries) {
          assignments.push({ cardId, slot });
          const pane = panes.find((p) => p.cardIds.includes(cardId));
          if (pane) pane.slot = slot;
        }
      },
      getSnapshot() {
        return { panes };
      },
    };
    initActionDispatch(conn as any, deck as any);
    return { impositions, assignments, panes };
  }

  it("passes each valid kind through to the deck", () => {
    const { impositions } = wire();
    // Every kind the imposer offers, so a new arrangement is covered here the
    // day it is added rather than the day someone remembers this list.
    for (const kind of IMPOSITION_KINDS) {
      dispatchAction({ action: "set-imposition", kind });
    }
    expect(impositions).toEqual([...IMPOSITION_KINDS]);
  });

  it("passes an explicit null through — that is how the feature turns off", () => {
    const { impositions } = wire();
    dispatchAction({ action: "set-imposition", kind: null });
    expect(impositions).toEqual([null]);
  });

  it("refuses a kind it does not recognize", () => {
    const { impositions } = wire();
    for (const kind of ["seven-up", "", undefined, 3, {}]) {
      dispatchAction({ action: "set-imposition", kind });
    }
    expect(impositions).toEqual([]);
  });

  it("passes a valid slot assignment through", () => {
    const { assignments } = wire();
    dispatchAction({ action: "assign-slot", cardId: "card-1", slot: 0 });
    dispatchAction({ action: "assign-slot", cardId: "card-2", slot: 3 });
    expect(assignments).toEqual([
      { cardId: "card-1", slot: 0 },
      { cardId: "card-2", slot: 3 },
    ]);
  });

  it("passes a multi-card assignment through as one batch", () => {
    const { assignments } = wire();
    dispatchAction({
      action: "assign-slot",
      cardIds: ["card-1", "card-2"],
      slot: 2,
    });
    expect(assignments).toEqual([
      { cardId: "card-1", slot: 2 },
      { cardId: "card-2", slot: 2 },
    ]);
  });

  it("refuses a missing or non-string cardId", () => {
    const { assignments } = wire();
    dispatchAction({ action: "assign-slot", slot: 1 });
    dispatchAction({ action: "assign-slot", cardId: 7, slot: 1 });
    dispatchAction({ action: "assign-slot", cardIds: [], slot: 1 });
    dispatchAction({ action: "assign-slot", cardIds: ["card-1", 7], slot: 1 });
    expect(assignments).toEqual([]);
  });

  it("refuses a slot that is not a non-negative integer", () => {
    const { assignments } = wire();
    for (const slot of [-1, 1.5, "1", null, undefined, Number.NaN]) {
      dispatchAction({ action: "assign-slot", cardId: "card-1", slot });
    }
    expect(assignments).toEqual([]);
  });
});

// ---- set_session_private acks ----

describe("set_session_private acks", () => {
  beforeEach(() => {
    _resetForTest();
    initActionDispatch(createMockConnection() as any, createMockDeckManager() as any);
    sessionPrivateStore.forget("sess");
  });

  it("takes the written value from the ok ack", () => {
    dispatchAction({ action: "set_session_private_ok", session_id: "sess", private: true });
    expect(sessionPrivateStore.isPrivate("sess")).toBe(true);
    dispatchAction({ action: "set_session_private_ok", session_id: "sess", private: false });
    expect(sessionPrivateStore.isPrivate("sess")).toBe(false);
  });

  it("puts back `public` when making it private is refused", () => {
    sessionPrivateStore.setPrivate("sess", true); // the optimistic write
    dispatchAction({
      action: "set_session_private_err",
      session_id: "sess",
      private: true,
      reason: "ledger_write_failed",
    });
    expect(sessionPrivateStore.isPrivate("sess")).toBe(false);
  });

  it("puts back `private` when making it public is refused", () => {
    // The direction that used to be lost: the optimistic write says public,
    // the ledger is still private, and no push is coming to correct it.
    sessionPrivateStore.setPrivate("sess", false);
    dispatchAction({
      action: "set_session_private_err",
      session_id: "sess",
      private: false,
      reason: "ledger_write_failed",
    });
    expect(sessionPrivateStore.isPrivate("sess")).toBe(true);
  });

  it("resolves the gesture's waiter with the outcome", () => {
    const settles: PrivateSettle[] = [];
    sessionPrivateStore.awaitSettle("sess", true, (s) => settles.push(s));
    dispatchAction({ action: "set_session_private_ok", session_id: "sess", private: true });
    expect(settles).toEqual([{ ok: true }]);

    sessionPrivateStore.awaitSettle("sess", false, (s) => settles.push(s));
    dispatchAction({
      action: "set_session_private_err",
      session_id: "sess",
      private: false,
      reason: "not_found",
    });
    expect(settles[1]).toEqual({ ok: false, reason: "not_found" });
  });

  it("does not let an ack for another value resolve the pending gesture", () => {
    // Two toggles in flight: the ack for the superseded one must not speak
    // the newer gesture's outcome.
    const settles: PrivateSettle[] = [];
    sessionPrivateStore.awaitSettle("sess", false, (s) => settles.push(s));
    dispatchAction({ action: "set_session_private_ok", session_id: "sess", private: true });
    expect(settles).toEqual([]);
    dispatchAction({ action: "set_session_private_ok", session_id: "sess", private: false });
    expect(settles).toEqual([{ ok: true }]);
  });

  it("resolves a waiter once — a repeat echo says nothing", () => {
    const settles: PrivateSettle[] = [];
    sessionPrivateStore.awaitSettle("sess", true, (s) => settles.push(s));
    dispatchAction({ action: "set_session_private_ok", session_id: "sess", private: true });
    dispatchAction({ action: "set_session_private_ok", session_id: "sess", private: true });
    expect(settles.length).toBe(1);
  });
});

// ---- rename_session acks ----

describe("rename_session acks", () => {
  beforeEach(() => {
    _resetForTest();
    initActionDispatch(createMockConnection() as any, createMockDeckManager() as any);
    sessionNameStore.setName("sess", null);
  });

  /** Mimic the rename surface: optimistic write, then arm the waiter. */
  function renameTo(name: string, settles: NameSettle[]): void {
    const previous = sessionNameStore.getName("sess");
    sessionNameStore.setName("sess", name);
    sessionNameStore.awaitSettle("sess", name, previous, (s) => settles.push(s));
  }

  it("keeps the new name when the ledger took it", () => {
    const settles: NameSettle[] = [];
    sessionNameStore.setName("sess", "old");
    renameTo("harbor light", settles);
    dispatchAction({ action: "rename_session_ok", session_id: "sess", name: "harbor light" });
    expect(sessionNameStore.getName("sess")).toBe("harbor light");
    expect(settles).toEqual([{ ok: true }]);
  });

  it("puts the replaced name back when the rename is refused", () => {
    // Nothing else would: a failed write broadcasts no `session_updated`, so
    // the optimistic name would otherwise stand for the life of the tab.
    const settles: NameSettle[] = [];
    sessionNameStore.setName("sess", "old");
    renameTo("harbor light", settles);
    expect(sessionNameStore.getName("sess")).toBe("harbor light");
    dispatchAction({
      action: "rename_session_err",
      session_id: "sess",
      name: "harbor light",
      reason: "ledger_write_failed",
    });
    expect(sessionNameStore.getName("sess")).toBe("old");
    expect(settles).toEqual([{ ok: false, reason: "ledger_write_failed" }]);
  });

  it("restores an unnamed session to unnamed", () => {
    const settles: NameSettle[] = [];
    renameTo("harbor light", settles);
    dispatchAction({
      action: "rename_session_err",
      session_id: "sess",
      name: "harbor light",
      reason: "not_found",
    });
    expect(sessionNameStore.getName("sess")).toBeNull();
  });

  it("matches a cleared name against the ack's null", () => {
    const settles: NameSettle[] = [];
    sessionNameStore.setName("sess", "old");
    renameTo("", settles);
    // tugcast normalizes a blank name to `None`, which serializes as null.
    dispatchAction({ action: "rename_session_ok", session_id: "sess", name: null });
    expect(settles).toEqual([{ ok: true }]);
  });

  it("does not let a superseded rename's ack resolve the pending one", () => {
    const settles: NameSettle[] = [];
    sessionNameStore.setName("sess", "old");
    renameTo("first", settles);
    renameTo("second", settles);
    dispatchAction({ action: "rename_session_ok", session_id: "sess", name: "first" });
    expect(settles).toEqual([]);
    dispatchAction({ action: "rename_session_ok", session_id: "sess", name: "second" });
    expect(settles).toEqual([{ ok: true }]);
  });
});
