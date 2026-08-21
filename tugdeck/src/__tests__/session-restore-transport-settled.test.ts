/**
 * `session-restore` — transport_settled wiring on binding arrival
 * (Step 5 of tugplan-session-connection-health).
 *
 * Verifies the production wire: when a binding arrives in
 * `cardSessionBindingStore` for a card that's currently in the
 * `sessionRestoreRegistry`, the binding subscriber dispatches
 * `transport_settled` into that card's `CodeSessionStore` via
 * `cardServicesStore.getServices(cardId)?.codeSessionStore.notifyTransportSettled()`.
 *
 * The store-internal contract (`transport_settled` flips
 * `transportState` from `restoring` → `online`) is tested directly in
 * `code-session-store.transport-state.test.ts`. This file pins the
 * cross-module wiring: lifecycle dispatches into the store, the
 * binding subscriber finds the same store, and the snapshot reflects
 * the full `online → offline → restoring → online` walk.
 *
 * Connection + lifecycle singletons are mocked so `cardServicesStore`
 * actually constructs services for new bindings (the real singletons
 * are not initialized in the test environment).
 */

import { describe, it, expect, afterEach, afterAll, mock } from "bun:test";
import { setTugbankClient } from "@/lib/tugbank-singleton";
import type { TugbankClient } from "@/lib/tugbank-client";

import type { TugConnection } from "@/connection";

// Stub `getConnection` so cardServicesStore._construct returns a real
// services bag instead of warning + returning null. The connection is
// only reached for `send` / `onFrame` — both are no-op stubs here.
const fakeConnection = {
  send: (_feedId: number, _payload: Uint8Array, _flags?: number) => {},
  trySend: (_feedId: number, _payload: Uint8Array, _flags?: number) => true,
  onFrame: (_feedId: number, _cb: (payload: Uint8Array) => void) => () => {},
} as unknown as TugConnection;

mock.module("@/lib/connection-singleton", () => ({
  getConnection: () => fakeConnection,
  setConnection: () => {},
}));

// Single shared lifecycle so the store cardServicesStore constructs
// is observably driven from the test. The real `ConnectionLifecycle`
// class is imported and re-exported from the mock so other consumers
// (e.g., the gallery card or future hooks) keep their type contract.
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
const sharedLifecycle = new ConnectionLifecycle();
mock.module("@/lib/connection-lifecycle", () => ({
  ConnectionLifecycle,
  getConnectionLifecycle: () => sharedLifecycle,
  registerConnectionLifecycle: () => {},
}));

// Tugbank stub. `cardServicesStore._construct` reads dev recents on
// every successful bind; the test doesn't care about that side effect,
// so the read returns nothing and the writer is a no-op. Wired through
// the real `setTugbankClient` seam rather than `mock.module` — a module
// mock on the singleton leaks across files in bun's single-process run
// and would starve other suites' hydrate.
const fakeTugbank = {
  get: (_domain: string, _key: string) => undefined,
  readDomain: (_domain: string) => undefined,
  onDomainChanged: (_cb: (domain: string) => void) => () => {},
};
setTugbankClient(fakeTugbank as unknown as TugbankClient);
afterAll(() => setTugbankClient(null));

// `cardServicesStore._construct` calls `putSessionRecentProjects` —
// stubbed here so it doesn't reach for `globalThis.fetch`.
import * as actualSettingsApi from "@/settings-api";
mock.module("@/settings-api", () => ({
  ...actualSettingsApi,
  putSessionRecentProjects: (_paths: string[]) => {},
}));

// Imports must come AFTER the mock.module calls so the modules pick
// up the mocked singletons.
import { cardServicesStore } from "@/lib/card-services-store";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "@/lib/card-session-binding-store";
import {
  restoreSessions,
  sessionRestoreRegistry,
} from "@/lib/session-restore";

interface FakeCard {
  id: string;
  componentId: string;
}

function createFakeDeck(cards: FakeCard[]) {
  let snapshot = { cards };
  const destructionObservers = new Set<(cardId: string) => void>();
  return {
    observeCardWillBeginDestruction(
      _cardId: string | null,
      cb: (cardId: string) => void,
    ): () => void {
      destructionObservers.add(cb);
      return () => destructionObservers.delete(cb);
    },
    getSnapshot(): { cards: FakeCard[] } {
      return snapshot;
    },
    setCards(next: FakeCard[]): void {
      const staying = new Set(next.map((c) => c.id));
      for (const card of snapshot.cards) {
        if (staying.has(card.id)) continue;
        for (const cb of destructionObservers) cb(card.id);
      }
      snapshot = { cards: next };
    },
  };
}

const TOUCHED_CARD_IDS = new Set<string>();

function bind(cardId: string, tugSessionId: string): CardSessionBinding {
  TOUCHED_CARD_IDS.add(cardId);
  const binding: CardSessionBinding = {
    tugSessionId,
    workspaceKey: "/work/restore-test",
    projectDir: "/work/restore-test",
    sessionMode: "resume",
  };
  cardSessionBindingStore.setBinding(cardId, binding);
  return binding;
}

afterEach(() => {
  for (const id of TOUCHED_CARD_IDS) {
    cardSessionBindingStore.clearBinding(id);
  }
  TOUCHED_CARD_IDS.clear();
});

describe("session-restore — transport_settled on binding arrival (Step 5)", () => {
  it("clears the registry entry and dispatches transport_settled into the store", () => {
    const cardId = "session-restore-card-1";
    const tugSessionId = "tug-session-restore-1";
    const projectDir = "/work/restore-test";

    // Wire the deck-manager subscription so cardServicesStore's
    // binding-store subscription is registered before
    // installRegistrySubscriptions runs. Fake deck is empty — the
    // restore loop has nothing to do, but installRegistrySubscriptions
    // still runs once and arms the binding subscriber.
    const fakeDeck = createFakeDeck([]);
    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<
        typeof cardServicesStore.attachDeckManager
      >[0],
    );
    restoreSessions(
      fakeDeck as unknown as Parameters<typeof restoreSessions>[0],
      fakeConnection,
    );

    // Pre-arm the registry as if a `spawn_session(mode=resume)` were
    // in flight. Use a no-op timeout — the binding arriving below
    // clears the entry before the timer would fire.
    sessionRestoreRegistry._register(
      cardId,
      { tugSessionId, projectDir },
      () => {},
    );
    expect(sessionRestoreRegistry.has(cardId)).toBe(true);

    // First binding arrival constructs the store via cardServicesStore.
    bind(cardId, tugSessionId);
    const services = cardServicesStore.getServices(cardId);
    expect(services).not.toBeNull();
    const store = services!.codeSessionStore;

    // The registry entry is cleared by the binding subscriber.
    expect(sessionRestoreRegistry.has(cardId)).toBe(false);

    // Walk the store through the full transport-state lifecycle to
    // prove the wiring drives it home: drop the wire, reconnect,
    // re-bind. The re-bind goes through the binding-arrival
    // subscriber and calls `notifyTransportSettled` on this same
    // store, returning it to `online`.
    expect(store.getSnapshot().transportState).toBe("online");

    sharedLifecycle.notifyConnectionDidClose();
    expect(store.getSnapshot().transportState).toBe("offline");

    // Prime [D08]: the lifecycle needs a prior open before
    // `connectionDidReconnect` fires. The initial app-boot open
    // happens before the close above; here we add the post-close
    // open to drive the reconnect path.
    sharedLifecycle.notifyConnectionDidOpen();
    // Without a prior open on this lifecycle the previous line was
    // the very first open and did NOT fire reconnect. Drive a second
    // close + open to satisfy the gate.
    sharedLifecycle.notifyConnectionDidClose();
    sharedLifecycle.notifyConnectionDidOpen();
    expect(store.getSnapshot().transportState).toBe("restoring");

    // Re-arm the registry, then re-bind to drive the binding
    // subscriber again. The same store gets `notifyTransportSettled`
    // and flips back to `online`.
    sessionRestoreRegistry._register(
      cardId,
      { tugSessionId, projectDir },
      () => {},
    );
    cardSessionBindingStore.setBinding(cardId, {
      tugSessionId,
      workspaceKey: projectDir,
      projectDir,
      sessionMode: "resume",
    });
    expect(store.getSnapshot().transportState).toBe("online");
    expect(store.getSnapshot().canSubmit).toBe(true);
  });

  it("a binding-arrival without a registry entry does not dispatch transport_settled", () => {
    // First-time picker bind: no restore expectation was registered.
    // The binding subscriber sees no matching registry entry and
    // skips the dispatch entirely. The store's `transportState`
    // therefore reflects only the lifecycle history — which here is
    // whatever the shared lifecycle is in (carried over from prior
    // tests in this file or fresh; either way, `online` because the
    // store was just constructed).
    const cardId = "session-restore-card-2";
    const tugSessionId = "tug-session-restore-2";

    const fakeDeck = createFakeDeck([]);
    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<
        typeof cardServicesStore.attachDeckManager
      >[0],
    );
    restoreSessions(
      fakeDeck as unknown as Parameters<typeof restoreSessions>[0],
      fakeConnection,
    );

    bind(cardId, tugSessionId);
    const services = cardServicesStore.getServices(cardId);
    expect(services).not.toBeNull();

    // No registry entry for this card → no `_clear` ran, no
    // `notifyTransportSettled` dispatched. `transportState` stays at
    // its construction default (`online`).
    expect(services!.codeSessionStore.getSnapshot().transportState).toBe(
      "online",
    );
  });
});
