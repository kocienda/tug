/**
 * R-CHAIN integration tests — end-to-end-ish coverage of the Dev
 * session-id chain at the tugdeck layer.
 *
 * Each scenario drives the data-and-wire flow that a real picker →
 * spawn → bridge → card cycle would produce, asserts on user-visible
 * state (binding, picker notice, prompt-history persistence), AND
 * asserts on the `[dev::session-lifecycle]` log shape so future
 * regressions show up as log-shape diffs.
 *
 * The contract these tests pin: tugdeck operates on a single session
 * id (`tugSessionId`, decided by the picker, set on
 * `CodeSessionStore` at construction time, used as the prompt-history
 * key from the first render of the entry). No waiting on `session_init`.
 *
 * R-CHAIN-05 (submit-during-handshake) is no longer relevant: the
 * single-id model means the id is available immediately on bind, so
 * there is no handshake window in which a push could be lost.
 *
 * R-CHAIN-06 (close mid-stream then resume) is transitively covered
 * by R-CHAIN-01's PUT round-trip plus the existing close tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FeedId } from "@/protocol";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "@/lib/card-session-binding-store";
import { pickerNoticeStore } from "@/lib/picker-notice-store";
import { PromptHistoryStore } from "@/lib/prompt-history-store";

// ---------------------------------------------------------------------------
// Lifecycle-log capture
// ---------------------------------------------------------------------------

interface LifecycleLine {
  event: string;
  fields: Record<string, string>;
  raw: string;
}

const LIFECYCLE_PREFIX = "[dev::session-lifecycle] ";

function parseLifecycleLine(raw: string): LifecycleLine | null {
  if (!raw.startsWith(LIFECYCLE_PREFIX)) return null;
  const body = raw.slice(LIFECYCLE_PREFIX.length);
  const fields: Record<string, string> = {};
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of body) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === " " && !inQuotes) {
      if (current.length > 0) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq < 0) continue;
    const k = tok.slice(0, eq);
    let v = tok.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        // leave raw
      }
    }
    fields[k] = v;
  }
  const event = fields.event ?? "";
  return { event, fields, raw };
}

interface CapturedLogs {
  lines: LifecycleLine[];
  restore: () => void;
  expectEvent: (event: string) => LifecycleLine;
  allEvents: (event: string) => LifecycleLine[];
}

function captureLifecycleLogs(): CapturedLogs {
  const lines: LifecycleLine[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") {
      const parsed = parseLifecycleLine(first);
      if (parsed) {
        lines.push(parsed);
        return;
      }
    }
    original.apply(console, args as Parameters<typeof console.log>);
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
    expectEvent: (event: string) => {
      const found = lines.find((l) => l.event === event);
      if (!found) {
        throw new Error(
          `expected lifecycle event ${event}; got: ${lines.map((l) => l.event).join(", ")}`,
        );
      }
      return found;
    },
    allEvents: (event: string) => lines.filter((l) => l.event === event),
  };
}

// ---------------------------------------------------------------------------
// fetch mock for prompt-history HTTP
// ---------------------------------------------------------------------------

interface FetchRecord {
  url: string;
  method: string;
  body?: unknown;
}

interface FetchHarness {
  records: FetchRecord[];
  seedGet: (urlContains: string, body: unknown) => void;
  restore: () => void;
}

const _noopFetch = (async () =>
  new Response(null, { status: 404 })) as unknown as typeof fetch;

function installFetchMock(): FetchHarness {
  const records: FetchRecord[] = [];
  const seeds = new Map<string, unknown>();
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    records.push({ url, method, body });
    if (method === "PUT") {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.startsWith("/api/prompt-history")) {
      return new Response(JSON.stringify({ id: records.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    for (const [needle, payload] of seeds.entries()) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return {
    records,
    seedGet: (urlContains, body) => seeds.set(urlContains, body),
    restore: () => {
      globalThis.fetch = original ?? _noopFetch;
    },
  };
}

// ---------------------------------------------------------------------------
// Common scaffolding
// ---------------------------------------------------------------------------

const PROJECT_DIR = "/work/r-chain-test";

function makeBinding(
  _cardId: string,
  tugSessionId: string,
  overrides: Partial<CardSessionBinding> = {},
): CardSessionBinding {
  return {
    tugSessionId,
    lineId: tugSessionId,
    workspaceKey: PROJECT_DIR,
    projectDir: PROJECT_DIR,
    sessionMode: "new",
    ...overrides,
  };
}

function makeStore(
  conn: TestFrameChannel,
  tugSessionId: string,
): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId,
    sessionMode: "new",
  });
}

/**
 * Hand-rolled mirror of `useSessionCardObserver` (the React hook) so
 * scenario tests can attach the resume-failed unbind logic outside
 * the renderer. The single source of behavioral truth lives in the
 * production hook; this mirror exists because the tests exercise the
 * chain without rendering SessionCardBody. If the hook body changes,
 * update this mirror or migrate the test to RTL.
 */
function installCardObserver(
  cardId: string,
  store: CodeSessionStore,
): () => void {
  let consumedAt: number | null = null;
  return store.subscribe(() => {
    const snap = store.getSnapshot();
    const err = snap.lastError;
    if (
      err === null ||
      err.cause !== "resume_failed" ||
      consumedAt === err.at
    ) {
      return;
    }
    consumedAt = err.at;
    pickerNoticeStore.set(cardId, {
      category: "resume_failed",
      message: err.message,
    });
    cardSessionBindingStore.clearBinding(cardId);
  });
}

const TOUCHED_CARD_IDS = new Set<string>();

function bindForTest(cardId: string, tugSessionId: string): void {
  TOUCHED_CARD_IDS.add(cardId);
  cardSessionBindingStore.setBinding(cardId, makeBinding(cardId, tugSessionId));
}

afterEach(() => {
  for (const id of TOUCHED_CARD_IDS) {
    cardSessionBindingStore.clearBinding(id);
    pickerNoticeStore.consume(id);
  }
  TOUCHED_CARD_IDS.clear();
});

// ---------------------------------------------------------------------------
// R-CHAIN-01 — Fresh new
// ---------------------------------------------------------------------------

describe("R-CHAIN-01 — Fresh new", () => {
  let logs: CapturedLogs;
  let fetchH: FetchHarness;
  beforeEach(() => {
    logs = captureLifecycleLogs();
    fetchH = installFetchMock();
  });
  afterEach(() => {
    logs.restore();
    fetchH.restore();
  });

  it("history.push appends under the picker-chosen session id without waiting on session_init", async () => {
    const cardId = "card-rchain-01";
    const sessionId = "tug-rchain-01";
    const conn = new TestFrameChannel();
    const store = makeStore(conn, sessionId);
    bindForTest(cardId, sessionId);

    // No `session_init` is dispatched here. The picker chose the id;
    // the entry can push history immediately, without confirmation
    // from claude.

    const history = new PromptHistoryStore();
    history.push({
      id: `${sessionId}-1`,
      sessionId,
      projectPath: PROJECT_DIR,
      route: "❯",
      text: "hello world",
      atoms: [],
      timestamp: 1,
    });

    // The append is queued and drained on a microtask, so let it go out.
    await new Promise((r) => setTimeout(r, 0));

    const post = fetchH.records.find(
      (r) => r.method === "POST" && r.url === "/api/prompt-history",
    );
    expect(post).toBeDefined();
    expect((post!.body as { session_id: string }).session_id).toBe(sessionId);
    expect((post!.body as { text: string }).text).toBe("hello world");

    store.dispose();
  });

  it("session_init logs with divergent=false when claude's id matches the picker's", async () => {
    const cardId = "card-rchain-01b";
    const sessionId = "tug-rchain-01b";
    const conn = new TestFrameChannel();
    const store = makeStore(conn, sessionId);
    bindForTest(cardId, sessionId);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "session_init",
      session_id: sessionId,
      tug_session_id: sessionId,
    });

    const initEvt = logs.expectEvent("code_store.session_init_recv");
    expect(initEvt.fields.tug_session_id).toBe(sessionId);
    expect(initEvt.fields.claude_session_id).toBe(sessionId);
    expect(initEvt.fields.divergent).toBe("false");

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// R-CHAIN-02 — Resume success
// ---------------------------------------------------------------------------

describe("R-CHAIN-02 — Resume success", () => {
  let logs: CapturedLogs;
  let fetchH: FetchHarness;
  beforeEach(() => {
    logs = captureLifecycleLogs();
    fetchH = installFetchMock();
  });
  afterEach(() => {
    logs.restore();
    fetchH.restore();
  });

  it("loadSession returns persisted entries and the route provider restores them", async () => {
    const cardId = "card-rchain-02";
    const sessionId = "rchain-02-session";

    fetchH.seedGet(`/api/prompt-history?session=${encodeURIComponent(sessionId)}`, {
      entries: [
        {
          id: 1,
          client_entry_id: `${sessionId}-1`,
          session_id: sessionId,
          project_path: PROJECT_DIR,
          route: "❯",
          text: "remember my favorite color is green",
          atoms: [],
          submitted_at_ms: 1,
        },
      ],
      has_more: false,
      before: null,
    });

    const conn = new TestFrameChannel();
    const store = makeStore(conn, sessionId);
    bindForTest(cardId, sessionId);

    const history = new PromptHistoryStore();
    await history.loadSession(sessionId);

    const get = fetchH.records.find(
      (r) =>
        r.method === "GET" && r.url.includes(encodeURIComponent(sessionId)),
    );
    expect(get).toBeDefined();
    const loaded = logs.expectEvent("history.load_complete");
    expect(loaded.fields.session_id).toBe(sessionId);
    expect(loaded.fields.fetched_count).toBe("1");

    const provider = history.createRouteProvider(sessionId, "❯");
    const restored = provider.back({ text: "", atoms: [], selection: null });
    expect(restored?.text).toBe("remember my favorite color is green");

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// R-CHAIN-03 — Resume failure → no silent fallback
// ---------------------------------------------------------------------------

describe("R-CHAIN-03 — Resume failure", () => {
  let logs: CapturedLogs;
  let fetchH: FetchHarness;
  beforeEach(() => {
    logs = captureLifecycleLogs();
    fetchH = installFetchMock();
  });
  afterEach(() => {
    logs.restore();
    fetchH.restore();
  });

  it("resume_failed → lastError populated, binding cleared, picker notice stashed", () => {
    const cardId = "card-rchain-03";
    const staleId = "stale-session";
    const conn = new TestFrameChannel();
    const store = makeStore(conn, staleId);
    const unsubscribe = installCardObserver(cardId, store);
    bindForTest(cardId, staleId);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "resume_failed",
      reason: "missing_jsonl",
      stale_session_id: staleId,
      tug_session_id: staleId,
    });

    const recvEvt = logs.expectEvent("code_store.resume_failed_recv");
    expect(recvEvt.fields.tug_session_id).toBe(staleId);
    expect(recvEvt.fields.stale_session_id).toBe(staleId);
    expect(recvEvt.fields.reason).toBe("missing_jsonl");

    const snap = store.getSnapshot();
    expect(snap.lastError?.cause).toBe("resume_failed");

    expect(cardSessionBindingStore.getBinding(cardId)).toBeUndefined();
    const notice = pickerNoticeStore.consume(cardId);
    expect(notice?.category).toBe("resume_failed");

    expect(
      fetchH.records.some(
        (r) => r.method === "POST" && r.url === "/api/prompt-history",
      ),
    ).toBe(false);

    unsubscribe();
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// R-CHAIN-04 — Two cards same project, both Resume
// ---------------------------------------------------------------------------

describe("R-CHAIN-04 — Concurrent resume rejected", () => {
  let logs: CapturedLogs;
  let fetchH: FetchHarness;
  beforeEach(() => {
    logs = captureLifecycleLogs();
    fetchH = installFetchMock();
  });
  afterEach(() => {
    logs.restore();
    fetchH.restore();
  });

  it("Card B receives errored{session_live_elsewhere} while Card A's binding survives", () => {
    const sessionId = "rchain-04-session";
    const cardA = "card-rchain-04-a";
    const cardB = "card-rchain-04-b";

    const connA = new TestFrameChannel();
    const storeA = makeStore(connA, sessionId);
    const unsubA = installCardObserver(cardA, storeA);
    bindForTest(cardA, sessionId);

    const connB = new TestFrameChannel();
    const storeB = makeStore(connB, sessionId);
    const unsubB = installCardObserver(cardB, storeB);
    bindForTest(cardB, sessionId);

    // The supervisor would reject Card B's spawn and broadcast
    // `SESSION_STATE = errored { detail: "session_live_elsewhere" }`.
    // Simulate that wire frame here.
    connB.dispatchDecoded(FeedId.SESSION_STATE, {
      tug_session_id: sessionId,
      state: "errored",
      detail: "session_live_elsewhere",
    });

    const snapB = storeB.getSnapshot();
    expect(snapB.phase).toBe("errored");
    expect(snapB.lastError?.cause).toBe("session_state_errored");
    expect(snapB.lastError?.message).toContain("session_live_elsewhere");

    // Card A's binding survives.
    expect(
      cardSessionBindingStore.getBinding(cardA)?.tugSessionId,
    ).toBe(sessionId);

    unsubA();
    unsubB();
    storeA.dispose();
    storeB.dispose();
  });
});
