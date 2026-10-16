/**
 * `dispatchCommand` — one front door, five mechanisms, read from the table.
 *
 * Every case runs against a real `ResponderChainManager` with real
 * registrations, because the thing worth pinning is that the routing field
 * picks the mechanism the pre-funnel call site used: a `first-responder`
 * command walks from focus and runs its handler's continuation, a
 * `key-card` command does not walk from focus, a `target` command reaches
 * the node it names regardless of focus, and a `registry` command lands on
 * the handler `registerAction` holds.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { ResponderChainManager, setUnhandledTargetHook } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { COMMANDS_BY_ID } from "@/components/tugways/command-registry";
import { dispatchCommand, observeCommands, sendToCardContent, setCardContentForwarder } from "../command-dispatch";
import {
  _resetForTest,
  dispatchAction,
  registerAction,
  registerResponderChainManager,
} from "../action-dispatch";

afterEach(() => {
  _resetForTest();
});

function chainWith(node: Parameters<ResponderChainManager["register"]>[0]): ResponderChainManager {
  const chain = new ResponderChainManager();
  chain.register(node);
  registerResponderChainManager(chain);
  return chain;
}

describe("first-responder routing", () => {
  test("walks from the first responder and reports handled", () => {
    let ran = 0;
    const chain = chainWith({
      id: "card",
      parentId: null,
      actions: { [TUG_ACTIONS.CLOSE]: () => { ran += 1; } },
    });
    chain.makeFirstResponder("card");

    expect(dispatchCommand(TUG_ACTIONS.CLOSE)).toBe(true);
    expect(ran).toBe(1);
  });

  test("invokes the handler's continuation immediately", () => {
    // Handlers written for the in-app context menu defer their visible work
    // into a continuation so it lands after the menu blink. A native menu
    // round-trip has already blinked, so the funnel must run it here or the
    // deferred work is silently dropped.
    const order: string[] = [];
    const chain = chainWith({
      id: "card",
      parentId: null,
      actions: {
        [TUG_ACTIONS.CLOSE]: () => {
          order.push("handler");
          return () => order.push("continuation");
        },
      },
    });
    chain.makeFirstResponder("card");

    expect(dispatchCommand(TUG_ACTIONS.CLOSE)).toBe(true);
    expect(order).toEqual(["handler", "continuation"]);
  });

  test("nobody handling it is unhandled, not an error", () => {
    const chain = chainWith({ id: "card", parentId: null, actions: {} });
    chain.makeFirstResponder("card");
    expect(dispatchCommand(TUG_ACTIONS.CLOSE)).toBe(false);
  });
});

describe("key-card routing", () => {
  test("does not walk from the first responder", () => {
    // The distinction that makes the field load-bearing: a key-card command
    // starts at the active card's card-content responder, so a focused node
    // holding the same action is deliberately not reached.
    let ran = 0;
    const chain = chainWith({
      id: "focused",
      parentId: null,
      actions: { [TUG_ACTIONS.INTERRUPT_SESSION]: () => { ran += 1; } },
    });
    chain.makeFirstResponder("focused");

    expect(dispatchCommand(TUG_ACTIONS.INTERRUPT_SESSION)).toBe(false);
    expect(ran).toBe(0);
  });
});

describe("target routing", () => {
  test("reaches the named node regardless of focus", () => {
    const closed: string[] = [];
    const chain = chainWith({
      id: "pane-2",
      parentId: null,
      actions: { [TUG_ACTIONS.CLOSE_PANE]: () => { closed.push("pane-2"); } },
    });
    chain.register({
      id: "pane-1",
      parentId: null,
      actions: { [TUG_ACTIONS.CLOSE_PANE]: () => { closed.push("pane-1"); } },
    });
    chain.makeFirstResponder("pane-1");

    expect(dispatchCommand(TUG_ACTIONS.CLOSE_PANE, { targetId: "pane-2" })).toBe(true);
    expect(closed).toEqual(["pane-2"]);
  });

  test("a dispatch with no target is unhandled rather than aimed at focus", () => {
    const chain = chainWith({
      id: "pane-1",
      parentId: null,
      actions: { [TUG_ACTIONS.CLOSE_PANE]: () => {} },
    });
    chain.makeFirstResponder("pane-1");
    expect(dispatchCommand(TUG_ACTIONS.CLOSE_PANE)).toBe(false);
  });
});

describe("registry routing", () => {
  test("lands on the handler registerAction holds, with the frame's payload", () => {
    const seen: Array<Record<string, unknown>> = [];
    registerAction("next-theme", (payload) => { seen.push(payload); });

    expect(dispatchCommand("next-theme", { action: "next-theme" })).toBe(true);
    expect(seen).toEqual([{ action: "next-theme" }]);
  });

  test("an unregistered body is unhandled", () => {
    expect(dispatchCommand("next-theme")).toBe(false);
  });
});

describe("a control frame's named parameters reach a chain handler", () => {
  test("the frame's own fields become the ActionEvent value", () => {
    // `sendControl(action, params:)` puts its parameters at the top level of
    // the frame rather than under `value`, because that is the wire the
    // registered handlers were written against. A command that has since
    // moved onto a responder still has to receive them.
    let seen: unknown = "unset";
    const chain = chainWith({
      id: "canvas",
      parentId: null,
      actions: { [TUG_ACTIONS.FOCUS_PANE]: (event) => { seen = event.value; } },
    });
    chain.makeFirstResponder("canvas");

    expect(
      dispatchCommand(TUG_ACTIONS.FOCUS_PANE, { action: "focus-pane", paneId: "p1" }),
    ).toBe(true);
    // The envelope is stripped; the parameters are not.
    expect(seen).toEqual({ paneId: "p1" });
  });

  test("an explicit value still wins over the frame's other fields", () => {
    let seen: unknown = "unset";
    const chain = chainWith({
      id: "canvas",
      parentId: null,
      actions: { [TUG_ACTIONS.OPEN_FILE]: (event) => { seen = event.value; } },
    });
    chain.makeFirstResponder("canvas");

    expect(
      dispatchCommand(TUG_ACTIONS.OPEN_FILE, { action: "open-file", value: "/tmp/x", path: "/ignored" }),
    ).toBe(true);
    expect(seen).toBe("/tmp/x");
  });
});

describe("a card-content action", () => {
  test("reaches the card's content scope in this document", () => {
    let ran = 0;
    chainWith({ id: "c1-card-content", parentId: null, actions: { [TUG_ACTIONS.REVEAL_CHANGES]: () => { ran += 1; } } });
    expect(sendToCardContent("c1", TUG_ACTIONS.REVEAL_CHANGES)).toBe(true);
    expect(ran).toBe(1);
  });

  test("reports a card whose content is not mounted here, rather than throwing", () => {
    chainWith({ id: "other", parentId: null, actions: {} });
    expect(sendToCardContent("c1", TUG_ACTIONS.REVEAL_CHANGES)).toBe(false);
  });

  test("goes to the forwarder when it takes the card, and never to this chain", () => {
    let ran = 0;
    chainWith({ id: "c1-card-content", parentId: null, actions: { [TUG_ACTIONS.REVEAL_CHANGES]: () => { ran += 1; } } });
    const sent: string[] = [];
    const release = setCardContentForwarder((cardId, action) => {
      sent.push(`${cardId}:${action}`);
      return true;
    });
    try {
      expect(sendToCardContent("c1", TUG_ACTIONS.REVEAL_CHANGES)).toBe(true);
    } finally {
      release();
    }
    expect(sent).toEqual([`c1:${TUG_ACTIONS.REVEAL_CHANGES}`]);
    expect(ran).toBe(0);
  });
});

describe("a targeted dispatch that walks off the root", () => {
  test("goes to the unhandled-target hook, which can take it", () => {
    const chain = chainWith({ id: "control-parent", parentId: null, actions: {} });
    const seen: string[] = [];
    const release = setUnhandledTargetHook((event) => {
      seen.push(event.action);
      return true;
    });
    try {
      expect(chain.sendToTarget("control-parent", { action: TUG_ACTIONS.NEW_SPACE, phase: "discrete" })).toBe(true);
    } finally {
      release();
    }
    expect(seen).toEqual([TUG_ACTIONS.NEW_SPACE]);
    expect(chain.sendToTarget("control-parent", { action: TUG_ACTIONS.NEW_SPACE, phase: "discrete" })).toBe(false);
  });

  test("never reaches the hook when the chain answers it", () => {
    let ran = 0;
    const chain = chainWith({ id: "control-parent", parentId: null, actions: { [TUG_ACTIONS.NEW_SPACE]: () => { ran += 1; } } });
    let hooked = 0;
    const release = setUnhandledTargetHook(() => {
      hooked += 1;
      return true;
    });
    try {
      expect(chain.sendToTarget("control-parent", { action: TUG_ACTIONS.NEW_SPACE, phase: "discrete" })).toBe(true);
    } finally {
      release();
    }
    expect(ran).toBe(1);
    expect(hooked).toBe(0);
  });
});

describe("native routing", () => {
  test("is represented but not JS-routable", () => {
    expect(COMMANDS_BY_ID.get("quit-application")?.routing).toBe("native");
    expect(dispatchCommand("quit-application")).toBe(false);
  });
});

describe("the funnel's edges", () => {
  test("an unknown id is unhandled", () => {
    expect(dispatchCommand("no-such-command")).toBe(false);
  });

  test("observers see every dispatch, handled or not", () => {
    const seen: Array<[string, boolean]> = [];
    const unobserve = observeCommands((id, handled) => seen.push([id, handled]));

    const chain = chainWith({
      id: "card",
      parentId: null,
      actions: { [TUG_ACTIONS.CLOSE]: () => {} },
    });
    chain.makeFirstResponder("card");
    dispatchCommand(TUG_ACTIONS.CLOSE);
    dispatchCommand("quit-application");
    unobserve();
    dispatchCommand(TUG_ACTIONS.CLOSE);

    expect(seen).toEqual([
      [TUG_ACTIONS.CLOSE, true],
      ["quit-application", false],
    ]);
  });
});

describe("dispatchAction's one fork", () => {
  test("a command wire goes through the funnel", () => {
    let ran = 0;
    const chain = chainWith({
      id: "card",
      parentId: null,
      actions: { [TUG_ACTIONS.CLOSE]: () => { ran += 1; } },
    });
    chain.makeFirstResponder("card");

    dispatchAction({ action: TUG_ACTIONS.CLOSE });
    expect(ran).toBe(1);
  });

  test("a data frame still reaches its registered handler", () => {
    const seen: Array<Record<string, unknown>> = [];
    registerAction("session_updated", (payload) => { seen.push(payload); });

    dispatchAction({ action: "session_updated", session_id: "s1" });
    expect(seen).toEqual([{ action: "session_updated", session_id: "s1" }]);
  });
});
