/**
 * A `spawn_session_ok` the shell sent no spawn for, for a Session card that
 * has no page, ends in a body.
 *
 * tugcast broadcasts every spawn ack to every page, so the shell sees acks for
 * spawns some other page sent. On 2026-11-12 a parked workspace's two Session
 * cards were resumed that way while no page drew them: the shell's handler
 * found no reason for the acks, wrote the bindings anyway, and the binding
 * built the cards' stores in the shell — where, under body views, nothing
 * draws a card. Every later route to a page refused them, because each treats
 * "bound" as somebody else's to make, and the cards stood as empty frames on
 * every visit.
 *
 * So the shell hands such a card to its body, with a `restore`, before the
 * binding is written: the stores are never built, and the card's page is
 * asked for at once when it is shown, or when its workspace is. An ack the
 * shell asked for, a card a restore pass is still deciding, and a page with
 * no body views behave as they always did.
 *
 * Connection, lifecycle and tugbank singletons are wired the way
 * `card-services-store-body-page.test.ts` wires them, so the binding really
 * builds stores and a red is a real red.
 *
 * @covers tugdeck/src/lib/session-control-actions.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setTugbankClient } from "@/lib/tugbank-singleton";
import type { TugbankClient } from "@/lib/tugbank-client";
import type { TugConnection } from "@/connection";

const fakeConnection = {
  send: () => {},
  trySend: () => true,
  onFrame: () => () => {},
  sendControlFrame: () => {},
} as unknown as TugConnection;

import { setConnection as _realSetConnection } from "@/lib/connection-singleton";
const realSetConnection = _realSetConnection;
mock.module("@/lib/connection-singleton", () => ({
  getConnection: () => fakeConnection,
  setConnection: realSetConnection,
}));

import { ConnectionLifecycle, registerConnectionLifecycle } from "@/lib/connection-lifecycle";
registerConnectionLifecycle(new ConnectionLifecycle());
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

import type { IDeckManagerStore } from "@/deck-manager-store";
import { cardServicesStore } from "@/lib/card-services-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { bodyCardsStore } from "@/lib/body-cards-store";
import {
  _resetHandOffForTest,
  _setHostCapabilitiesForTest,
  bodyIntentOf,
  releaseDeferredBody,
  setBodyDeferral,
} from "@/lib/body-handoff";
import { registerShellDeck } from "@/lib/deck-store-registry";
import { registerStubShellDeck } from "@/__tests__/shell-deck-stub";
import { registerCard } from "@/card-registry";
import { registerSessionControlActions } from "@/lib/session-control-actions";
import { restorePassCards } from "@/lib/session-restore";
import { notePendingReload, _resetPendingReloadsForTests } from "@/lib/reload-reasons";
import { _resetActionRegistryForTest, getRegistryHandler } from "@/action-registry";

// This file's own kind, handed off at its spawn funnel as the Session card is,
// so no real kind's registration is disturbed.
registerCard({
  componentId: "unasked-spawn",
  contentFactory: () => null,
  defaultMeta: { title: "Unasked", closable: true },
  bodyHandOff: "spawn",
});

/** The shown workspace holds `m1`; the parked `phraso` holds `p1`. */
const live = { cards: [{ id: "m1", componentId: "unasked-spawn" }] };
const phraso = { cards: [{ id: "p1", componentId: "unasked-spawn" }] };
const deck = {
  getSnapshot: () => live,
  spaceOf: (cardId: string) => (cardId === "p1" ? "phraso" : null),
  getSpaceDeck: (spaceId: string) => (spaceId === "phraso" ? phraso : undefined),
  getCardState: () => undefined,
} as unknown as IDeckManagerStore;

let posted: Array<{ name: string; body: { cardId: string; intent: { kind: string } } }>;
const g = globalThis as { webkit?: unknown };
let priorWebkit: unknown;

/** The resume some other page sent for `p1`, acked to every page. */
function ackUnaskedResume(): void {
  getRegistryHandler("spawn_session_ok")!({
    action: "spawn_session_ok",
    card_id: "p1",
    tug_session_id: "seg-1",
    workspace_key: "/w",
    project_dir: "/w",
    session_mode: "resume",
  });
}

const bodyCreatesFor = (cardId: string) =>
  posted.filter((p) => p.name === "bodyCreate" && p.body.cardId === cardId);

beforeEach(() => {
  posted = [];
  priorWebkit = g.webkit;
  g.webkit = {
    messageHandlers: {
      bodyCreate: {
        postMessage: (body: unknown) => posted.push({ name: "bodyCreate", body: JSON.parse(body as string) }),
      },
    },
  };
  _setHostCapabilitiesForTest({ bodyViews: true });
  registerStubShellDeck(deck);
  setBodyDeferral((id) => id === "p1");
  registerSessionControlActions();
});

afterEach(() => {
  _resetActionRegistryForTest();
  _resetPendingReloadsForTests();
  cardSessionBindingStore.clearBinding("p1");
  _resetHandOffForTest();
  _setHostCapabilitiesForTest({ bodyViews: false });
  registerShellDeck(null);
  g.webkit = priorWebkit;
});

describe("an unasked spawn ack for a pageless body-kind card", () => {
  test("an unasked resume of a parked, pageless Session card hands it to its body, and the shell builds no stores for it", () => {
    ackUnaskedResume();
    expect(bodyCardsStore.stateOf("p1")).toBe("unmade");
    expect(bodyIntentOf("p1")?.kind).toBe("restore");
    expect(cardSessionBindingStore.getBinding("p1")?.tugSessionId).toBe("seg-1");
    expect(cardServicesStore.getServices("p1")).toBeNull();
    expect(bodyCreatesFor("p1")).toEqual([]);
  });

  test("when its workspace is shown the card's page is asked for with that restore", () => {
    ackUnaskedResume();
    releaseDeferredBody("p1");
    const asked = bodyCreatesFor("p1");
    expect(asked.length).toBe(1);
    expect(asked[0]!.body.intent.kind).toBe("restore");
    expect(bodyCardsStore.stateOf("p1")).toBe("creating");
  });

  test("a shown card's page is asked for at once", () => {
    setBodyDeferral(() => false);
    ackUnaskedResume();
    const asked = bodyCreatesFor("p1");
    expect(asked.length).toBe(1);
    expect(asked[0]!.body.intent.kind).toBe("restore");
    expect(bodyCardsStore.stateOf("p1")).toBe("creating");
    expect(cardServicesStore.getServices("p1")).toBeNull();
  });
});

describe("acks the shell hands off nothing for", () => {
  test("an ack the shell asked for is not handed off here", () => {
    notePendingReload("p1", "restore-open");
    ackUnaskedResume();
    expect(bodyCardsStore.has("p1")).toBe(false);
  });

  test("a card a restore pass is still deciding is left to that pass", () => {
    const release = restorePassCards._hold(new Set(["p1"]));
    try {
      ackUnaskedResume();
      expect(bodyCardsStore.has("p1")).toBe(false);
    } finally {
      release();
    }
  });

  test("without body views nothing is handed off", () => {
    _setHostCapabilitiesForTest({ bodyViews: false });
    ackUnaskedResume();
    expect(bodyCardsStore.has("p1")).toBe(false);
    expect(cardServicesStore.getServices("p1")).not.toBeNull();
  });
});
