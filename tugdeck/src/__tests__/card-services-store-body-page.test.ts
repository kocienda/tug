/**
 * `cardServicesStore` in a body page — a page builds a session store only
 * for the card it shows.
 *
 * A body page mirrors what the shell holds about *other* cards into its own
 * `cardSessionBindingStore` (`body-main.ts` `createCardFactsMirror`): an
 * arrangement body (Layout, Workspaces) mirrors every bound card's binding,
 * and a following body (Arcs, DevTools) mirrors the binding of the card it
 * follows — the last key card that is not it, which the shell resends on
 * every key-card change. A mirrored binding is a fact about another card,
 * never a session for this page to drive.
 *
 * On 2026-10-16 the Arcs body drove them anyway: each time the user focused
 * a Session card — which a prompt submission does — the shell moved the Arcs
 * body's `followed` to that card, the mirror wrote the binding, `_reconcile`
 * built a whole `CodeSessionStore` for it, and `_construct` ended with a
 * `request_replay` for a session the page never shows. The replay's frames
 * then landed in the Session card's own body mid-turn and the live turn was
 * lost with them. This file pins the invariant that ends that:
 *
 *   in a body page, `getServices(x)` is `null` for every `x` but the page's
 *   own card, whatever bindings the page mirrors, and exactly one
 *   `request_replay` goes out — the page's own card's, read by the ack of the
 *   spawn this page sent for it.
 *
 * Connection, lifecycle and tugbank singletons are wired the way
 * `card-services-store-request-replay.test.ts` wires them.
 */

import { describe, it, expect, afterEach, afterAll, mock } from "bun:test";
import { setTugbankClient } from "@/lib/tugbank-singleton";
import type { TugbankClient } from "@/lib/tugbank-client";

import type { TugConnection } from "@/connection";

interface SentFrame {
  feedId: number;
  payload: Uint8Array;
}
const sentFrames: SentFrame[] = [];

const fakeConnection = {
  send: (feedId: number, payload: Uint8Array, _flags?: number) => {
    sentFrames.push({ feedId, payload });
  },
  trySend: (feedId: number, payload: Uint8Array, _flags?: number) => {
    sentFrames.push({ feedId, payload });
    return true;
  },
  onFrame: (_feedId: number, _cb: (payload: Uint8Array) => void) => () => {},
} as unknown as TugConnection;

import { setConnection as _realSetConnection } from "@/lib/connection-singleton";
const realSetConnection = _realSetConnection;
mock.module("@/lib/connection-singleton", () => ({
  getConnection: () => fakeConnection,
  setConnection: realSetConnection,
}));

import {
  ConnectionLifecycle,
  registerConnectionLifecycle,
} from "@/lib/connection-lifecycle";
const sharedLifecycle = new ConnectionLifecycle();
registerConnectionLifecycle(sharedLifecycle);
afterAll(() => registerConnectionLifecycle(null));

const fakeTugbank = {
  get: (_domain: string, _key: string) => undefined,
  readDomain: (_domain: string) => undefined,
  onDomainChanged: (_cb: (domain: string) => void) => () => {},
};
setTugbankClient(fakeTugbank as unknown as TugbankClient);
afterAll(() => setTugbankClient(null));

const realFetch = globalThis.fetch;
globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

import { cardServicesStore } from "@/lib/card-services-store";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "@/lib/card-session-binding-store";
import { FeedId } from "@/protocol";
import { sendSpawnSession } from "@/lib/session-lifecycle";
import { registerSessionControlActions } from "@/lib/session-control-actions";
import { _resetActionRegistryForTest, getRegistryHandler } from "@/action-registry";
import { _resetPendingReloadsForTests } from "@/lib/reload-reasons";

const TOUCHED_CARD_IDS = new Set<string>();

function bindingFor(tugSessionId: string): CardSessionBinding {
  return {
    tugSessionId,
    lineId: tugSessionId,
    workspaceKey: "/work/body-page-test",
    projectDir: "/work/body-page-test",
    sessionMode: "resume",
  };
}

/**
 * The page's own card spawning at launch: the spawn this page sends, and the
 * real `spawn_session_ok` handler binding the card and reading its transcript.
 */
function bindOwn(cardId: string, tugSessionId: string): void {
  TOUCHED_CARD_IDS.add(cardId);
  const binding = bindingFor(tugSessionId);
  sendSpawnSession(fakeConnection, cardId, tugSessionId, binding.projectDir, "resume", "launch");
  registerSessionControlActions();
  getRegistryHandler("spawn_session_ok")!({
    action: "spawn_session_ok",
    card_id: cardId,
    tug_session_id: tugSessionId,
    workspace_key: binding.workspaceKey,
    project_dir: binding.projectDir,
    session_mode: "resume",
  });
}

/** What `createCardFactsMirror` writes for a card the shell listed. */
function mirror(cardId: string, tugSessionId: string): void {
  TOUCHED_CARD_IDS.add(cardId);
  cardSessionBindingStore.setBinding(cardId, bindingFor(tugSessionId));
}

function requestReplaySessions(): string[] {
  const decoder = new TextDecoder();
  const found: string[] = [];
  for (const f of sentFrames) {
    if (f.feedId !== FeedId.CONTROL) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(f.payload));
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { action?: unknown }).action === "request_replay"
    ) {
      found.push(String((parsed as { tug_session_id: unknown }).tug_session_id));
    }
  }
  return found;
}

afterEach(() => {
  for (const id of TOUCHED_CARD_IDS) cardSessionBindingStore.clearBinding(id);
  TOUCHED_CARD_IDS.clear();
  sentFrames.length = 0;
  _resetPendingReloadsForTests();
  _resetActionRegistryForTest();
  cardServicesStore.detachBodyForTest();
});

describe("cardServicesStore in a body page — services for the page's card only", () => {
  it("builds no services and sends no request_replay for a binding the page mirrors", () => {
    const own = "arcs-body-card";
    const sessionA = "sess-followed-a";
    const sessionB = "sess-followed-b";

    cardServicesStore.attachBody(own);
    // The Arcs card holds no session of its own; the shell lists the card it
    // follows, and the mirror writes that card's binding into this page.
    mirror("session-card-a", sessionA);
    // The key card moves — a prompt submitted in the other Session card —
    // and the shell's `followed` moves with it: the first binding goes, the
    // second arrives.
    cardSessionBindingStore.clearBinding("session-card-a");
    mirror("session-card-b", sessionB);
    // And back.
    cardSessionBindingStore.clearBinding("session-card-b");
    mirror("session-card-a", sessionA);

    expect(
      cardServicesStore.getServices("session-card-a"),
      "a mirrored binding is a fact about another card, not a session this page drives",
    ).toBeNull();
    expect(cardServicesStore.getServices("session-card-b")).toBeNull();
    expect(cardServicesStore.getServices(own)).toBeNull();
    expect(
      requestReplaySessions(),
      "no replay is asked for a session the page never shows",
    ).toEqual([]);
  });

  it("builds services for the page's own card, and for no other card the shell lists", () => {
    const own = "layout-body-card";
    const ownSession = "sess-own";

    cardServicesStore.attachBody(own);
    bindOwn(own, ownSession);
    // An arrangement body mirrors every bound card on every workspace.
    mirror("session-card-1", "sess-1");
    mirror("session-card-2", "sess-2");
    mirror("session-card-3", "sess-3");

    expect(cardServicesStore.getServices(own)?.tugSessionId).toBe(ownSession);
    for (const other of ["session-card-1", "session-card-2", "session-card-3"]) {
      expect(cardServicesStore.getServices(other), `${other} is another page's card`).toBeNull();
    }
    expect(
      requestReplaySessions(),
      "exactly one replay goes out: the page's own card's",
    ).toEqual([ownSession]);
  });
});
