/**
 * The ask's session lookup, as `initActionDispatch` builds it.
 *
 * A skill asks mid-stage from a shell whose `$TUG_SESSION_ID` was frozen when
 * the shell spawned; the Wheel has rotated the card since, so the id names a
 * segment no card is seated on. `pendingAskStore` answers every path out, and
 * the path out for "no session" is the **declining fallback** — so before W1
 * taught the injected `sessionFor` to fall back to the line, a mid-arc question
 * was answered "no" with nobody having been asked. W1 shipped that fallback
 * without a test; this is it.
 *
 * The subject is the real closure inside `initActionDispatch`, which reaches
 * `cardServicesStore` — so this file stands the connection and lifecycle
 * singletons up the way `card-services-store-request-replay.test.ts` does, and
 * lives apart from `bind-dash-ok.test.ts` because those module mocks are
 * file-wide.
 */

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { setTugbankClient } from "@/lib/tugbank-singleton";
import type { TugbankClient } from "@/lib/tugbank-client";
import type { TugConnection } from "@/connection";

const fakeConnection = {
  send: () => {},
  trySend: () => true,
  onFrame: (_feedId: number, _cb: (payload: Uint8Array) => void) => () => {},
} as unknown as TugConnection;

mock.module("@/lib/connection-singleton", () => ({
  getConnection: () => fakeConnection,
  setConnection: () => {},
}));

import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
const sharedLifecycle = new ConnectionLifecycle();
mock.module("@/lib/connection-lifecycle", () => ({
  ConnectionLifecycle,
  getConnectionLifecycle: () => sharedLifecycle,
  registerConnectionLifecycle: () => {},
}));

const fakeTugbank = {
  get: (_domain: string, _key: string) => undefined,
  readDomain: (_domain: string) => undefined,
  onDomainChanged: (_cb: (domain: string) => void) => () => {},
};
setTugbankClient(fakeTugbank as unknown as TugbankClient);
afterAll(() => setTugbankClient(null));

// After the mocks, so these modules pick the mocked singletons up.
import {
  initActionDispatch,
  dispatchAction,
  _resetForTest,
} from "@/action-dispatch";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "@/lib/card-session-binding-store";
import { cardServicesStore } from "@/lib/card-services-store";
import { pendingAskStore } from "@/lib/pending-ask-store";
import { sessionLineStore } from "@/lib/session-line-store";

interface SentControlFrame {
  action: string;
  payload: Record<string, unknown>;
}

const TOUCHED_CARDS = new Set<string>();

function seatCard(cardId: string, tugSessionId: string, lineId: string): void {
  TOUCHED_CARDS.add(cardId);
  const binding: CardSessionBinding = {
    tugSessionId,
    lineId,
    workspaceKey: "/work/ask-line-routing",
    projectDir: "/work/ask-line-routing",
    sessionMode: "new",
  };
  cardSessionBindingStore.setBinding(cardId, binding);
}

let sent: SentControlFrame[] = [];
let dispose: () => void = () => {};

function init(): void {
  _resetForTest();
  sent = [];
  dispose = initActionDispatch(
    {
      onFrame: (_feedId: number, _cb: (payload: Uint8Array) => void) => () => {},
      sendControlFrame: (action: string, payload: Record<string, unknown>) => {
        sent.push({ action, payload });
      },
    } as never,
    {
      addCard: () => null,
      showSingletonCard: () => null,
      prepareForReload: () => Promise.resolve(),
      getFocusedCardId: () => null,
    } as never,
  );
}

function askFrom(sessionId: string, requestId: string): void {
  dispatchAction({
    action: "ask",
    requestId,
    sessionId,
    title: "Proceed?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  });
}

afterEach(() => {
  for (const requestId of [...pendingAskStore.getSnapshot().keys()]) {
    pendingAskStore.respond(requestId, "");
  }
  dispose();
  dispose = () => {};
  for (const cardId of TOUCHED_CARDS) cardSessionBindingStore.clearBinding(cardId);
  TOUCHED_CARDS.clear();
  _resetForTest();
});

describe("sessionFor, as initActionDispatch builds it", () => {
  it("shows a question addressed to a retired segment of the card's line", () => {
    init();
    seatCard("card-ask-1", "seg-new", "line-ask-1");
    // The frozen id the asking shell still holds, and the pair a
    // `session_updated` push taught the deck.
    sessionLineStore.bind("seg-old", "line-ask-1");

    const services = cardServicesStore.getServices("card-ask-1");
    expect(services).not.toBeNull();

    askFrom("seg-old", "req-rotated");

    expect(
      services?.codeSessionStore.getSnapshot().pendingAsk?.requestId,
    ).toBe("req-rotated");
    expect(
      sent.filter((f) => f.action === "ask-response"),
      "nobody has answered yet, so nothing goes back on the wire",
    ).toEqual([]);
  });

  it("still shows one addressed to the seated segment directly", () => {
    init();
    seatCard("card-ask-2", "seg-seated", "line-ask-2");

    const services = cardServicesStore.getServices("card-ask-2");
    askFrom("seg-seated", "req-direct");

    expect(
      services?.codeSessionStore.getSnapshot().pendingAsk?.requestId,
    ).toBe("req-direct");
  });

  it("declines a question naming a session no card and no line holds", () => {
    init();
    seatCard("card-ask-3", "seg-seated", "line-ask-3");

    askFrom("seg-nobody-holds", "req-orphan");

    // The caller is blocked on an answer, so an unroutable question is
    // answered rather than dropped — with the declining choice.
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "req-orphan", choice: "no" } },
    ]);
  });
});
