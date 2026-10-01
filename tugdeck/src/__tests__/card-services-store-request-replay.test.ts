/**
 * `cardServicesStore._construct` — request_replay dispatch on resume
 * binding (Phase A-R1 / Step R1c, [D12]).
 *
 * Pins the contract: when fresh services are constructed for a binding
 * whose `sessionMode === "resume"`, the store dispatches a
 * `request_replay` CONTROL frame on the connection. Fresh-spawn
 * bindings do not.
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
 * no new React state, no new useEffect. [L01]/[L02]/[L10]/[L22]/[L24]
 * already covered in plan; this test pins the wire-side contribution.
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
}> {
  const decoder = new TextDecoder();
  const found: Array<{ tugSessionId: string }> = [];
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
      found.push({ tugSessionId });
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
  cardServicesStore.setHeldSwapLimitForTest(null);
});

describe("cardServicesStore._construct — request_replay dispatch ([D12])", () => {
  it("dispatches request_replay for a resume binding when services are constructed", () => {
    const cardId = "r1c-card-resume";
    const tugSessionId = "sess-r1c-resume";

    const fakeDeck = createFakeDeck([{ id: cardId, componentId: "session" }]);
    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<
        typeof cardServicesStore.attachDeckManager
      >[0],
    );

    bindResume(cardId, tugSessionId);

    // Services must be constructed (this drives _construct under the
    // mocked singletons).
    const services = cardServicesStore.getServices(cardId);
    expect(services).not.toBeNull();

    // Exactly one request_replay frame went out, addressed to this
    // session.
    const found = findRequestReplayFrames();
    expect(found).toHaveLength(1);
    expect(found[0].tugSessionId).toBe(tugSessionId);
  });

  it("dispatches request_replay for a fresh-spawn (sessionMode=new) binding too — post-Step-5 smoke fix", () => {
    // Pre-Step-5 the gate was `if (binding.sessionMode === "resume")`,
    // which skipped fresh-spawn bindings. That assumption holds at
    // the moment of spawn but rots once the session has had wire
    // activity. After the first turn lands, any rebind of the same
    // session needs request_replay so the freshly-mounted
    // CodeSessionStore rehydrates its transcript. The fix drops the
    // gate; an empty JSONL during a truly-fresh spawn is a harmless
    // `replay_complete{jsonl_missing}` flash.
    const cardId = "r1c-card-new";
    const tugSessionId = "sess-r1c-new";

    const fakeDeck = createFakeDeck([{ id: cardId, componentId: "session" }]);
    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<
        typeof cardServicesStore.attachDeckManager
      >[0],
    );

    bindNew(cardId, tugSessionId);

    const services = cardServicesStore.getServices(cardId);
    expect(services).not.toBeNull();

    // Fires unconditionally now: idempotent at three layers ([D04]
    // msg_id dedupe + tugcode re-entrancy guard + supervisor's
    // Live-only forward).
    const found = findRequestReplayFrames();
    expect(found).toHaveLength(1);
    expect(found[0].tugSessionId).toBe(tugSessionId);
  });

  it("dispatches once per construct — re-binding the same card after dispose runs another dispatch", () => {
    // Mirrors the HMR-shaped sequence: the deck transitions card out,
    // then back in (or services get reconstructed for any other
    // reason). Each fresh `_construct` should issue its own
    // request_replay because the new CodeSessionStore has no replay
    // history of its own. The reducer's [D04] msg_id dedupe makes
    // this idempotent at the transcript layer.
    const cardId = "r1c-card-rebind";
    const tugSessionId = "sess-r1c-rebind";

    const fakeDeck = createFakeDeck([{ id: cardId, componentId: "session" }]);
    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<
        typeof cardServicesStore.attachDeckManager
      >[0],
    );

    // First bind → first dispatch.
    bindResume(cardId, tugSessionId);
    expect(cardServicesStore.getServices(cardId)).not.toBeNull();
    expect(findRequestReplayFrames()).toHaveLength(1);

    // Tear the card out — services are disposed.
    fakeDeck.setCards([]);
    expect(cardServicesStore.getServices(cardId)).toBeNull();

    // Re-add and re-bind. The store reconstructs services and runs a
    // second dispatch.
    fakeDeck.setCards([{ id: cardId, componentId: "session" }]);
    bindResume(cardId, tugSessionId);
    expect(cardServicesStore.getServices(cardId)).not.toBeNull();

    const found = findRequestReplayFrames();
    expect(found).toHaveLength(2);
    expect(found[0].tugSessionId).toBe(tugSessionId);
    expect(found[1].tugSessionId).toBe(tugSessionId);
  });

  it("rebuilds the bag when the same card flips to a new session (/resume, /clear)", () => {
    // The session-change path ([#step-13b3]): a `/clear` fresh-spawn or a
    // `/resume` to another session overwrites the card's binding with a new
    // `tugSessionId` (no unbind). `_reconcile` must dispose the old bag and
    // construct a fresh one — a new CodeSessionStore (empty transcript) plus a
    // request_replay addressed to the NEW session. Before this fix `_reconcile`
    // keyed on cardId alone and the old store survived (stale transcript).
    const cardId = "r1c-card-session-flip";
    const sessionA = "sess-r1c-A";
    const sessionB = "sess-r1c-B";

    const fakeDeck = createFakeDeck([{ id: cardId, componentId: "session" }]);
    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<
        typeof cardServicesStore.attachDeckManager
      >[0],
    );

    bindNew(cardId, sessionA);
    const first = cardServicesStore.getServices(cardId);
    expect(first).not.toBeNull();
    expect(first?.tugSessionId).toBe(sessionA);
    expect(findRequestReplayFrames()).toHaveLength(1);

    // Flip the SAME card to a new session — the binding changes, the cardId
    // does not.
    bindNew(cardId, sessionB);
    const second = cardServicesStore.getServices(cardId);
    expect(second).not.toBeNull();
    // Fresh bag: new session id and a brand-new (empty) store instance.
    expect(second?.tugSessionId).toBe(sessionB);
    expect(second?.codeSessionStore).not.toBe(first?.codeSessionStore);

    // A second request_replay went out, addressed to the new session.
    const found = findRequestReplayFrames();
    expect(found).toHaveLength(2);
    expect(found[1].tugSessionId).toBe(sessionB);
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
 * the binding moves to the new session, the way `spawn_session_ok` moves it.
 * Answers the session the move spawned.
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
  cardSessionBindingStore.setBinding(cardId, {
    ...from,
    tugSessionId: moved,
    lineId: moved,
    projectDir: "/work/r1c-moved",
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
    expect(findRequestReplayFrames().map((f) => f.tugSessionId)).toContain(moved);
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
