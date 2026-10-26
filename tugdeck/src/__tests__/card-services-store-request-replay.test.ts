/**
 * A Session card's transcript is read only for one of a closed set of
 * reasons, and building its stores is not one of them.
 *
 * Pins the contract: constructing services for a binding sends no
 * `request_replay`. The transcript is asked for by
 * `cardServicesStore.requestTranscript`, with a reason from
 * `RELOAD_REASONS` — launch, restore-open, server-restart — which rides the
 * frame; the spawn ack makes that call with the reason its spawn was sent
 * for; and a bag is read at most once. This reverses the earlier rule that
 * every construct asked for its replay, which is what made any path that
 * built a card's stores a reload of it.
 *
 * And the directory change's held swap, which rides the same construct: a
 * move's re-bind builds the new bag and asks for its replay, but the card
 * keeps the old bag until that replay completes, the new session errors, or
 * the time limit passes — and a send made in between reaches the new session.
 *
 * Connection + lifecycle singletons are mocked the same way
 * `session-restore-transport-settled.test.ts` does — those
 * singletons aren't initialized in the test environment, but
 * `cardServicesStore._construct` early-returns null without them.
 *
 * Tuglaws posture: dispatch happens at the structure-zone seam
 * (cardServicesStore is a non-React store). No new render path,
 * no new React state, no new useEffect.
 *
 * @covers tugdeck/src/lib/card-services-store.ts
 * @covers tugdeck/src/lib/reload-reasons.ts
 * @covers tugdeck/src/lib/session-restore.ts
 *
 * And the reconnect: one to the same tugcast keeps every binding and store and
 * re-binds the card without reading it ([B03]); one to a restarted tugcast
 * clears, rebuilds and reads it for `server-restart`.
 */

import { describe, it, expect, afterEach, afterAll, mock } from "bun:test";
import { setTugbankClient } from "@/lib/tugbank-singleton";
import type { TugbankClient } from "@/lib/tugbank-client";

import type { TugConnection } from "@/connection";

// Capture every frame sent through the fake connection so the test
// can assert the request_replay frame after construction.
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

// `setConnection` is the real setter, frozen before the mock lands, so this
// process-wide mock cannot swallow another suite's call to it. [B10]
import { setConnection as _realSetConnection } from "@/lib/connection-singleton";
const realSetConnection = _realSetConnection;
mock.module("@/lib/connection-singleton", () => ({
  getConnection: () => fakeConnection,
  setConnection: realSetConnection,
}));

// Wired through the real `registerConnectionLifecycle` seam rather than
// `mock.module` — the module has its own suite (`connection-lifecycle.test.ts`),
// and a process-wide mock would hand that suite a stubbed
// `getConnectionLifecycle`.
import {
  ConnectionLifecycle,
  registerConnectionLifecycle,
} from "@/lib/connection-lifecycle";
const sharedLifecycle = new ConnectionLifecycle();
registerConnectionLifecycle(sharedLifecycle);
afterAll(() => registerConnectionLifecycle(null));

// Wire the tugbank stub through the real `setTugbankClient` seam rather
// than `mock.module` — a module mock on the singleton leaks across files
// in bun's single-process run and would starve other suites' hydrate.
const fakeTugbank = {
  get: (_domain: string, _key: string) => undefined,
  readDomain: (_domain: string) => undefined,
  onDomainChanged: (_cb: (domain: string) => void) => () => {},
};
setTugbankClient(fakeTugbank as unknown as TugbankClient);
afterAll(() => setTugbankClient(null));

// `cardServicesStore._construct` calls `putSessionRecentProjects`, which reaches
// `globalThis.fetch`. Stubbing fetch, rather than mocking `@/settings-api`,
// keeps the real module for `settings-api.test.ts` — a module mock is
// process-wide and would replace every one of that module's exports.
const realFetch = globalThis.fetch;
globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

// Imports must come AFTER the mock.module calls so the modules pick
// up the mocked singletons.
import { cardServicesStore, type CardServices } from "@/lib/card-services-store";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "@/lib/card-session-binding-store";
import {
  _resetDirectoryChangeForTests,
  beginDirectoryChange,
} from "@/lib/directory-change";
import { FeedId } from "@/protocol";
import {
  RELOAD_REASONS,
  _resetPendingReloadsForTests,
  type ReplayRequestReason,
} from "@/lib/reload-reasons";
import { sendSpawnSession } from "@/lib/session-lifecycle";
import { registerSessionControlActions } from "@/lib/session-control-actions";
import { _resetActionRegistryForTest, getRegistryHandler } from "@/action-registry";
import { reassertOnReconnect } from "@/lib/session-restore";
import { publishListCardBindingsOk } from "@/lib/session-ledger-events";
import { ServerIdentity } from "@/lib/server-identity";

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

function bindResume(cardId: string, tugSessionId: string): CardSessionBinding {
  TOUCHED_CARD_IDS.add(cardId);
  const binding: CardSessionBinding = {
    tugSessionId,
    lineId: tugSessionId,
    workspaceKey: "/work/r1c-test",
    projectDir: "/work/r1c-test",
    sessionMode: "resume",
  };
  cardSessionBindingStore.setBinding(cardId, binding);
  return binding;
}

function bindNew(cardId: string, tugSessionId: string): CardSessionBinding {
  TOUCHED_CARD_IDS.add(cardId);
  const binding: CardSessionBinding = {
    tugSessionId,
    lineId: tugSessionId,
    workspaceKey: "/work/r1c-test",
    projectDir: "/work/r1c-test",
    sessionMode: "new",
  };
  cardSessionBindingStore.setBinding(cardId, binding);
  return binding;
}

function findRequestReplayFrames(): Array<{
  tugSessionId: string;
  reason: ReplayRequestReason;
}> {
  const decoder = new TextDecoder();
  const found: Array<{ tugSessionId: string; reason: ReplayRequestReason }> = [];
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
      const tugSessionId = String(
        (parsed as { tug_session_id: unknown }).tug_session_id,
      );
      const reason = (parsed as { reason: ReplayRequestReason }).reason;
      found.push({ tugSessionId, reason });
    }
  }
  return found;
}

afterEach(() => {
  for (const id of TOUCHED_CARD_IDS) {
    cardSessionBindingStore.clearBinding(id);
  }
  TOUCHED_CARD_IDS.clear();
  sentFrames.length = 0;
  _resetDirectoryChangeForTests();
  _resetPendingReloadsForTests();
  _resetActionRegistryForTest();
  cardServicesStore.setHeldSwapLimitForTest(null);
});


function attachDeck(cardId: string): void {
  const fakeDeck = createFakeDeck([{ id: cardId, componentId: "session" }]);
  cardServicesStore.attachDeckManager(
    fakeDeck as unknown as Parameters<typeof cardServicesStore.attachDeckManager>[0],
  );
}

/** Land `spawn_session_ok` for `cardId` through the real ack handler. */
function ack(cardId: string, tugSessionId: string, sessionMode: "new" | "resume"): void {
  TOUCHED_CARD_IDS.add(cardId);
  registerSessionControlActions();
  getRegistryHandler("spawn_session_ok")!({
    action: "spawn_session_ok",
    card_id: cardId,
    tug_session_id: tugSessionId,
    workspace_key: "/work/r1c-test",
    project_dir: "/work/r1c-test",
    session_mode: sessionMode,
  });
}

describe("a card reloads only for a named reason", () => {
  it("the reasons are a closed set of three", () => {
    // Adding a fourth is a change to this list, made on purpose.
    expect([...RELOAD_REASONS]).toEqual(["launch", "restore-open", "server-restart"]);
  });

  it("building a card's stores asks for no transcript", () => {
    const cardId = "reload-construct";
    attachDeck(cardId);
    bindResume(cardId, "sess-reload-construct");
    expect(cardServicesStore.getServices(cardId)).not.toBeNull();
    expect(findRequestReplayFrames()).toEqual([]);

    bindNew(cardId, "sess-reload-construct-B");
    expect(cardServicesStore.getServices(cardId)?.tugSessionId).toBe("sess-reload-construct-B");
    expect(findRequestReplayFrames()).toEqual([]);
  });

  for (const reason of RELOAD_REASONS) {
    it(`a spawn sent for ${reason} reads the transcript once, saying ${reason}`, () => {
      const cardId = `reload-${reason}`;
      const tugSessionId = `sess-reload-${reason}`;
      attachDeck(cardId);
      sendSpawnSession(fakeConnection, cardId, tugSessionId, "/work/r1c-test", "resume", reason);
      ack(cardId, tugSessionId, "resume");

      expect(cardServicesStore.getServices(cardId)).not.toBeNull();
      expect(findRequestReplayFrames()).toEqual([{ tugSessionId, reason }]);
    });
  }

  it("an ack this page sent no spawn for builds stores and reads nothing", () => {
    const cardId = "reload-no-reason";
    attachDeck(cardId);
    ack(cardId, "sess-reload-no-reason", "resume");
    expect(cardServicesStore.getServices(cardId)).not.toBeNull();
    expect(findRequestReplayFrames()).toEqual([]);
  });

  it("a bag is read at most once; a second request for it is declined", () => {
    const cardId = "reload-once";
    attachDeck(cardId);
    bindResume(cardId, "sess-reload-once");
    expect(cardServicesStore.requestTranscript(cardId, "launch")).toBe(true);
    expect(cardServicesStore.requestTranscript(cardId, "server-restart")).toBe(false);
    expect(findRequestReplayFrames()).toEqual([
      { tugSessionId: "sess-reload-once", reason: "launch" },
    ]);
  });

  it("a card flipped to a new session (/clear, /resume) is read for its open", () => {
    const cardId = "reload-flip";
    attachDeck(cardId);
    sendSpawnSession(fakeConnection, cardId, "sess-flip-A", "/work/r1c-test", "new", "restore-open");
    ack(cardId, "sess-flip-A", "new");
    const first = cardServicesStore.getServices(cardId);

    sendSpawnSession(fakeConnection, cardId, "sess-flip-B", "/work/r1c-test", "new", "restore-open");
    ack(cardId, "sess-flip-B", "new");
    const second = cardServicesStore.getServices(cardId);

    expect(second?.tugSessionId).toBe("sess-flip-B");
    expect(second?.codeSessionStore).not.toBe(first?.codeSessionStore);
    expect(findRequestReplayFrames()).toEqual([
      { tugSessionId: "sess-flip-A", reason: "restore-open" },
      { tugSessionId: "sess-flip-B", reason: "restore-open" },
    ]);
  });
});

/** Every decoded JSON frame sent on `feedId`. */
function framesOn(feedId: number): Array<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const out: Array<Record<string, unknown>> = [];
  for (const f of sentFrames) {
    if (f.feedId !== feedId) continue;
    try {
      out.push(JSON.parse(decoder.decode(f.payload)) as Record<string, unknown>);
    } catch {
      // Not JSON: not a frame these tests read.
    }
  }
  return out;
}

/** Every frame of any feed whose payload names a user message. */
function userMessageFrames(): Array<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const out: Array<Record<string, unknown>> = [];
  for (const f of sentFrames) {
    const text = decoder.decode(f.payload);
    if (!text.includes('"user_message"')) continue;
    out.push(JSON.parse(text) as Record<string, unknown>);
  }
  return out;
}

/**
 * Bind `cardId` to a session, send a `/cd` from it, and land the move's ack:
 * the binding moves to the new session through the real `spawn_session_ok`
 * handler, which reads the new session's transcript. Answers the session the
 * move spawned.
 */
function move(cardId: string, from: CardSessionBinding): string {
  const before = framesOn(FeedId.CONTROL).length;
  beginDirectoryChange({
    cardId,
    binding: from,
    targetDir: "/work/r1c-moved",
    connection: fakeConnection,
  });
  const spawn = framesOn(FeedId.CONTROL)
    .slice(before)
    .find((f) => f.action === "spawn_session");
  const moved = String(spawn?.tug_session_id);
  registerSessionControlActions();
  getRegistryHandler("spawn_session_ok")!({
    action: "spawn_session_ok",
    card_id: cardId,
    tug_session_id: moved,
    workspace_key: from.workspaceKey,
    project_dir: "/work/r1c-moved",
    session_mode: from.sessionMode,
    line_id: moved,
  });
  return moved;
}

/** The new session's replay, start to finish, ingested by its store. */
function replay(services: CardServices, tugSessionId: string): void {
  const store = services.codeSessionStore;
  store._ingestFrameForTest(FeedId.CODE_OUTPUT, {
    type: "replay_started",
    tug_session_id: tugSessionId,
  });
  store._ingestFrameForTest(FeedId.CODE_OUTPUT, {
    type: "replay_complete",
    count: 0,
    tug_session_id: tugSessionId,
  });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function attach(cardId: string): void {
  const fakeDeck = createFakeDeck([{ id: cardId, componentId: "session" }]);
  cardServicesStore.attachDeckManager(
    fakeDeck as unknown as Parameters<typeof cardServicesStore.attachDeckManager>[0],
  );
}

/**
 * A connection that has opened once on server `first` and reconnected to
 * `second`, sending into `sentFrames` like the fake singleton connection.
 */
function reconnectedConnection(first: string, second: string): TugConnection {
  const serverIdentity = new ServerIdentity();
  serverIdentity.noteOpen({ server_id: first });
  serverIdentity.noteOpen({ server_id: second });
  const encoder = new TextEncoder();
  return {
    send: (feedId: number, payload: Uint8Array) => {
      sentFrames.push({ feedId, payload });
    },
    trySend: (feedId: number, payload: Uint8Array) => {
      sentFrames.push({ feedId, payload });
      return true;
    },
    sendControlFrame: (action: string, params: Record<string, unknown> = {}) => {
      sentFrames.push({
        feedId: FeedId.CONTROL,
        payload: encoder.encode(JSON.stringify({ action, ...params })),
      });
    },
    onFrame: () => () => {},
    serverIdentity,
  } as unknown as TugConnection;
}

function sentActions(): string[] {
  const decoder = new TextDecoder();
  const actions: string[] = [];
  for (const f of sentFrames) {
    if (f.feedId !== FeedId.CONTROL) continue;
    try {
      const parsed = JSON.parse(decoder.decode(f.payload)) as { action?: unknown };
      if (typeof parsed.action === "string") actions.push(parsed.action);
    } catch {
      continue;
    }
  }
  return actions;
}

function asDeck(deck: ReturnType<typeof createFakeDeck>): Parameters<typeof reassertOnReconnect>[0] {
  return deck as unknown as Parameters<typeof reassertOnReconnect>[0];
}

/** Drop the wire and bring it back, so every store's reconnect handler runs. */
function bounceTheWire(): void {
  sharedLifecycle.notifyConnectionDidOpen();
  sharedLifecycle.notifyConnectionDidClose();
  sharedLifecycle.notifyConnectionDidOpen();
}

describe("a reconnect re-binds the same server and reloads only a restarted one", () => {
  /** Deliver a whole (empty) read into `cardId`'s store. */
  function finishTheRead(cardId: string, tugSessionId: string): void {
    const store = cardServicesStore.getServices(cardId)!.codeSessionStore;
    for (const frame of [
      { type: "replay_started", ipc_version: 2 },
      { type: "replay_complete", count: 0, ipc_version: 2 },
    ]) {
      store._ingestFrameForTest(FeedId.CODE_OUTPUT, { ...frame, tug_session_id: tugSessionId });
    }
  }

  /** A card launched and read (unless `read` is false), ready for its wire to drop. */
  function launched(cardId: string, tugSessionId: string, read = true): {
    deck: ReturnType<typeof createFakeDeck>;
    services: CardServices;
  } {
    const deck = createFakeDeck([{ id: cardId, componentId: "session" }]);
    cardServicesStore.attachDeckManager(
      deck as unknown as Parameters<typeof cardServicesStore.attachDeckManager>[0],
    );
    sendSpawnSession(fakeConnection, cardId, tugSessionId, "/work/r1c-test", "resume", "launch");
    ack(cardId, tugSessionId, "resume");
    expect(findRequestReplayFrames()).toEqual([{ tugSessionId, reason: "launch" }]);
    if (read) finishTheRead(cardId, tugSessionId);
    sentFrames.length = 0;
    return { deck, services: cardServicesStore.getServices(cardId)! };
  }

  function answerTheBindingsQuery(cardId: string, tugSessionId: string): void {
    publishListCardBindingsOk({
      bindings: [
        {
          card_id: cardId,
          session_id: tugSessionId,
          project_dir: "/work/r1c-test",
          turn_count: 4,
          has_jsonl: true,
          is_alive: true,
        },
      ],
    } as unknown as Parameters<typeof publishListCardBindingsOk>[0]);
  }

  it("the same server: no binding cleared, no store disposed, nothing read, the store settles", () => {
    const cardId = "reconnect-same";
    const tugSessionId = "sess-reconnect-same";
    const { deck, services } = launched(cardId, tugSessionId);

    bounceTheWire();
    expect(services.codeSessionStore.getSnapshot().transportState).toBe("restoring");

    const kind = reassertOnReconnect(asDeck(deck), reconnectedConnection("srv-A", "srv-A"));
    expect(kind).toBe("same-server");
    expect(cardSessionBindingStore.getBinding(cardId)?.tugSessionId).toBe(tugSessionId);
    expect(cardServicesStore.getServices(cardId)).toBe(services);

    answerTheBindingsQuery(cardId, tugSessionId);
    // The card is re-asserted for the new socket: asked about, and re-spawned.
    expect(
      sentActions().filter((a) => a === "list_card_bindings" || a === "spawn_session"),
    ).toEqual(["list_card_bindings", "spawn_session"]);

    ack(cardId, tugSessionId, "resume");
    expect(cardServicesStore.getServices(cardId)).toBe(services);
    expect(findRequestReplayFrames()).toEqual([]);
    expect(services.codeSessionStore.getSnapshot().transportState).toBe("online");
    expect(sentActions(), "a settled card has no turn to ask about").not.toContain("request_inflight");
  });

  it("the same server, a card mid-turn: it asks for the turn as it now stands, and nothing older", () => {
    const cardId = "reconnect-midturn";
    const tugSessionId = "sess-reconnect-midturn";
    const { deck, services } = launched(cardId, tugSessionId);
    services.codeSessionStore.send("keep going", []);
    expect(services.codeSessionStore.getSnapshot().phase).not.toBe("idle");

    bounceTheWire();
    reassertOnReconnect(asDeck(deck), reconnectedConnection("srv-A", "srv-A"));
    answerTheBindingsQuery(cardId, tugSessionId);
    sentFrames.length = 0;
    ack(cardId, tugSessionId, "resume");

    expect(cardServicesStore.getServices(cardId)).toBe(services);
    expect(findRequestReplayFrames(), "the JSONL is not read").toEqual([]);
    expect(sentActions().filter((a) => a.startsWith("request_"))).toEqual(["request_inflight"]);
  });

  it("the same server, a sleeping card mid-turn: it asks nothing until its reveal's catch-up", () => {
    const cardId = "reconnect-asleep";
    const tugSessionId = "sess-reconnect-asleep";
    const { deck, services } = launched(cardId, tugSessionId);
    services.codeSessionStore.send("keep going", []);
    services.codeSessionStore.noteDormant();
    expect(services.codeSessionStore.isAsleep()).toBe(true);

    bounceTheWire();
    reassertOnReconnect(asDeck(deck), reconnectedConnection("srv-A", "srv-A"));
    answerTheBindingsQuery(cardId, tugSessionId);
    sentFrames.length = 0;
    ack(cardId, tugSessionId, "resume");

    expect(cardServicesStore.getServices(cardId)).toBe(services);
    expect(sentActions(), "a body scoped to nothing would hear no answer").not.toContain("request_inflight");
    expect(findRequestReplayFrames()).toEqual([]);

    // The reveal's catch-up is the one ask, and it carries the turn in flight.
    services.codeSessionStore.catchUp();
    expect(services.codeSessionStore.isAsleep()).toBe(false);
    expect(findRequestReplayFrames()).toEqual([{ tugSessionId, reason: "catch-up" }]);
    expect(sentActions()).not.toContain("request_inflight");
  });

  it("the same server, a card whose read the drop cut short: rebuilt and read again, for its first reason", () => {
    const cardId = "reconnect-cut-short";
    const tugSessionId = "sess-reconnect-cut-short";
    const { deck, services } = launched(cardId, tugSessionId, false);

    bounceTheWire();
    reassertOnReconnect(asDeck(deck), reconnectedConnection("srv-A", "srv-A"));
    answerTheBindingsQuery(cardId, tugSessionId);
    expect(cardServicesStore.getServices(cardId), "the half-read stores are let go").toBeNull();

    ack(cardId, tugSessionId, "resume");
    expect(cardServicesStore.getServices(cardId)).not.toBe(services);
    expect(findRequestReplayFrames()).toEqual([{ tugSessionId, reason: "launch" }]);
  });

  it("the same server, a new session whose first read was shadowed by its first turn: re-bound, never rebuilt", () => {
    const cardId = "reconnect-new-shadowed";
    const tugSessionId = "sess-reconnect-new-shadowed";
    const deck = createFakeDeck([{ id: cardId, componentId: "session" }]);
    cardServicesStore.attachDeckManager(
      deck as unknown as Parameters<typeof cardServicesStore.attachDeckManager>[0],
    );
    sendSpawnSession(fakeConnection, cardId, tugSessionId, "/work/r1c-test", "new", "launch");
    ack(cardId, tugSessionId, "new");
    const services = cardServicesStore.getServices(cardId)!;
    // The prompt goes in before the first read's bracket opens, so the
    // bracket is shadowed and closes without being a replay the card had.
    services.codeSessionStore.send("say it", []);
    for (const frame of [
      { type: "replay_started", ipc_version: 2 },
      { type: "replay_complete", count: 0, ipc_version: 2 },
    ]) {
      services.codeSessionStore._ingestFrameForTest(FeedId.CODE_OUTPUT, { ...frame, tug_session_id: tugSessionId });
    }
    expect(services.codeSessionStore.getSnapshot().replayEverCompleted).toBe(false);
    sentFrames.length = 0;

    bounceTheWire();
    reassertOnReconnect(asDeck(deck), reconnectedConnection("srv-A", "srv-A"));
    answerTheBindingsQuery(cardId, tugSessionId);
    expect(cardServicesStore.getServices(cardId), "a card born on this session lost nothing").toBe(services);
    sentFrames.length = 0;
    ack(cardId, tugSessionId, "resume");

    expect(cardServicesStore.getServices(cardId)).toBe(services);
    expect(findRequestReplayFrames(), "the JSONL is not read").toEqual([]);
    expect(sentActions().filter((a) => a.startsWith("request_"))).toEqual(["request_inflight"]);
  });

  it("the same server, a card the ledger no longer names: that card alone is cleared", () => {
    const cardId = "reconnect-unlisted";
    const { deck } = launched(cardId, "sess-reconnect-unlisted");

    bounceTheWire();
    reassertOnReconnect(asDeck(deck), reconnectedConnection("srv-A", "srv-A"));
    expect(cardServicesStore.getServices(cardId)).not.toBeNull();

    publishListCardBindingsOk({ bindings: [] } as unknown as Parameters<
      typeof publishListCardBindingsOk
    >[0]);
    expect(cardSessionBindingStore.getBinding(cardId)).toBeUndefined();
    expect(cardServicesStore.getServices(cardId)).toBeNull();
    expect(sentActions()).not.toContain("spawn_session");
  });

  it("a restarted server: the card is cleared, rebuilt and read for server-restart", () => {
    const cardId = "reconnect-restart";
    const tugSessionId = "sess-reconnect-restart";
    const { deck, services } = launched(cardId, tugSessionId);

    bounceTheWire();
    const kind = reassertOnReconnect(asDeck(deck), reconnectedConnection("srv-A", "srv-B"));
    expect(kind).toBe("server-restart");
    expect(cardSessionBindingStore.getBinding(cardId)).toBeUndefined();
    expect(cardServicesStore.getServices(cardId)).toBeNull();

    answerTheBindingsQuery(cardId, tugSessionId);
    ack(cardId, tugSessionId, "resume");
    const rebuilt = cardServicesStore.getServices(cardId);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt).not.toBe(services);
    expect(findRequestReplayFrames()).toEqual([{ tugSessionId, reason: "server-restart" }]);
  });
});

describe("cardServicesStore — a directory change holds the transcript until the new one is ready", () => {
  it("keeps the old bag shown through the re-bind, and swaps once on replay complete", async () => {
    const cardId = "cd-held-replay";
    attach(cardId);
    const old = bindNew(cardId, "sess-cd-old");
    const shown = cardServicesStore.getServices(cardId);
    expect(shown?.tugSessionId).toBe("sess-cd-old");

    let notified = 0;
    const unsubscribe = cardServicesStore.subscribe(() => notified++);
    const moved = move(cardId, old);

    // The binding moved, and the new session was asked for its replay, but
    // the card still renders the old bag — its transcript does not empty.
    expect(cardSessionBindingStore.getBinding(cardId)?.tugSessionId).toBe(moved);
    expect(cardServicesStore.getServices(cardId)).toBe(shown);
    expect(findRequestReplayFrames()).toEqual([{ tugSessionId: moved, reason: "restore-open" }]);
    expect(notified).toBe(0);

    // The held bag answers for its own session while it waits.
    const pending = cardServicesStore.getByTugSessionId(moved);
    expect(pending).not.toBeNull();
    expect(pending).not.toBe(shown);

    replay(pending!, moved);
    await settle();

    expect(cardServicesStore.getServices(cardId)).toBe(pending);
    expect(notified).toBe(1);
    expect(cardServicesStore.getByTugSessionId("sess-cd-old")).toBeNull();
    unsubscribe();
  });

  it("swaps when the new session errors, rather than waiting on a replay that will not come", async () => {
    const cardId = "cd-held-error";
    attach(cardId);
    const old = bindNew(cardId, "sess-cd-old-err");
    const shown = cardServicesStore.getServices(cardId);
    const moved = move(cardId, old);
    const pending = cardServicesStore.getByTugSessionId(moved)!;
    expect(cardServicesStore.getServices(cardId)).toBe(shown);

    pending.codeSessionStore._ingestFrameForTest(FeedId.SESSION_STATE, {
      tug_session_id: moved,
      state: "errored",
      detail: "spawn failed",
    });
    await settle();

    expect(cardServicesStore.getServices(cardId)).toBe(pending);
    expect(cardServicesStore.getServices(cardId)).not.toBe(shown);
  });

  it("swaps at the time limit when the new session never answers", async () => {
    const cardId = "cd-held-limit";
    attach(cardId);
    cardServicesStore.setHeldSwapLimitForTest(20);
    const old = bindNew(cardId, "sess-cd-old-limit");
    const shown = cardServicesStore.getServices(cardId);
    const moved = move(cardId, old);

    await settle();
    expect(cardServicesStore.getServices(cardId)).toBe(shown);

    await new Promise((r) => setTimeout(r, 60));
    expect(cardServicesStore.getServices(cardId)?.tugSessionId).toBe(moved);
  });

  it("queues a send made while the swap waits, and hands it to the new session", async () => {
    const cardId = "cd-held-send";
    attach(cardId);
    const old = bindNew(cardId, "sess-cd-old-send");
    const shown = cardServicesStore.getServices(cardId)!;
    const moved = move(cardId, old);

    // The old session is closed: the send goes nowhere yet.
    shown.codeSessionStore.send("said during the move", []);
    expect(userMessageFrames()).toHaveLength(0);
    expect(shown.codeSessionStore.exportQueuedSends()).toHaveLength(1);

    const pending = cardServicesStore.getByTugSessionId(moved)!;
    replay(pending, moved);
    await settle();

    // Delivered once, by the new store, to the new session.
    const sent = userMessageFrames();
    expect(sent).toHaveLength(1);
    expect(sent[0].tug_session_id).toBe(moved);
    expect(JSON.stringify(sent[0])).toContain("said during the move");
  });

  it("re-binds a /clear or /resume at once — only a move holds", () => {
    const cardId = "cd-not-a-move";
    attach(cardId);
    bindNew(cardId, "sess-cd-plain-A");
    const first = cardServicesStore.getServices(cardId);
    bindNew(cardId, "sess-cd-plain-B");
    const second = cardServicesStore.getServices(cardId);
    expect(second?.tugSessionId).toBe("sess-cd-plain-B");
    expect(second).not.toBe(first);
  });
});
