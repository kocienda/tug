/**
 * settlePickedPath — the file chooser's Browse delivers the panel's choice
 * only to a host that is still there.
 *
 * The system file panel stays up as long as the user leaves it, and the
 * chooser's host can close under it. A targeted dispatch to a responder that
 * has unregistered throws, so a choice arriving after the host is gone used to
 * surface as an unhandled rejection. These resolve the pick against a real
 * `ResponderChainManager` before and after the host goes.
 */

import { describe, expect, test } from "bun:test";

import { TUG_ACTIONS } from "../../action-vocabulary";
import { ResponderChainManager, type ActionEvent } from "../../responder-chain";
import { settlePickedPath, type PickedPathTarget } from "../file-chooser-browse";

/** A pick the test resolves by hand, as the panel would. */
function deferredPick(): { picked: Promise<string | null>; choose: (p: string | null) => void } {
  let choose: (p: string | null) => void = () => {};
  const picked = new Promise<string | null>((resolve) => {
    choose = resolve;
  });
  return { picked, choose };
}

/** A chain with one host that records every `set-value` it is sent. */
function hostChain(): { chain: ResponderChainManager; received: ActionEvent[] } {
  const chain = new ResponderChainManager();
  const received: ActionEvent[] = [];
  chain.register({
    id: "host",
    parentId: null,
    actions: { [TUG_ACTIONS.SET_VALUE]: (e: ActionEvent) => void received.push(e) },
  });
  return { chain, received };
}

describe("settlePickedPath", () => {
  test("a choice reaching a standing host settles it with a change and a commit", async () => {
    const { chain, received } = hostChain();
    const target: PickedPathTarget = { mounted: true, manager: chain, parentId: "host" };
    const { picked, choose } = deferredPick();
    const settled = settlePickedPath(picked, "chooser", () => target);
    choose("/tmp/project");
    expect(await settled).toBe(true);
    expect(received.map((e) => [e.value, e.phase, e.sender])).toEqual([
      ["/tmp/project", "change", "chooser"],
      ["/tmp/project", "commit", "chooser"],
    ]);
  });

  test("a choice arriving after the host unregistered is dropped, not thrown", async () => {
    const { chain, received } = hostChain();
    const target: PickedPathTarget = { mounted: true, manager: chain, parentId: "host" };
    const { picked, choose } = deferredPick();
    const settled = settlePickedPath(picked, "chooser", () => target);
    // The host closes while the panel is up: the chooser unmounts and its
    // parent responder leaves the chain.
    target.mounted = false;
    chain.unregister("host");
    choose("/tmp/project");
    expect(await settled).toBe(false);
    expect(received).toEqual([]);
  });

  test("an unregistered target is dropped even while the chooser reads mounted", async () => {
    const { chain, received } = hostChain();
    const target: PickedPathTarget = { mounted: true, manager: chain, parentId: "host" };
    const { picked, choose } = deferredPick();
    const settled = settlePickedPath(picked, "chooser", () => target);
    chain.unregister("host");
    choose("/tmp/project");
    expect(await settled).toBe(false);
    expect(received).toEqual([]);
  });

  test("a cancelled panel dispatches nothing", async () => {
    const { chain, received } = hostChain();
    const target: PickedPathTarget = { mounted: true, manager: chain, parentId: "host" };
    expect(await settlePickedPath(Promise.resolve(null), "chooser", () => target)).toBe(false);
    expect(received).toEqual([]);
  });
});
