/**
 * prompt-history-store unit tests.
 *
 * These drive the real store against a fake ledger installed at the `fetch`
 * seam and nowhere else — the fake answers the three real routes with the real
 * wire shapes, so every assertion below is about the store's own behavior.
 *
 * Tests cover:
 * - push() adds an entry, notifies subscribers, and appends to the ledger.
 * - No cap: a session far past the retired 200-entry limit keeps every entry.
 * - createProvider()/createRouteProvider() navigation, including cross-session
 *   isolation.
 * - loadSession() pages the newest entries in and records `hasMore`.
 * - Window edges: a `back()` that can't advance pages older entries in, and the
 *   press after arrival lands — including when the route has zero entries in
 *   the loaded window.
 * - patchAtomPath() completes a stored atom in the window and on the wire.
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { PromptHistoryStore } from "../lib/prompt-history-store";
import type { HistoryEntry, SerializedAtom } from "../lib/prompt-history-store";
import { __resetPromptHistoryOutbox } from "../lib/prompt-history-api";
import type { TugTextEditingState } from "../lib/tug-text-types";

// ---------------------------------------------------------------------------
// A fake ledger at the fetch seam
// ---------------------------------------------------------------------------

interface LedgerRow {
  id: number;
  session_id: string;
  route: string;
  text: string;
  atoms: SerializedAtom[];
  project_path: string;
  submitted_at_ms: number;
  client_entry_id: string;
}

interface FakeLedger {
  rows: LedgerRow[];
  /** Requests seen, in order, as `${method} ${path}`. */
  calls: string[];
  /** Page size the fake serves, so a test can force a window edge. */
  pageLimit: number;
  seed(sessionId: string, texts: string[], route?: string): void;
}

const realFetch = globalThis.fetch;

function installFakeLedger(): FakeLedger {
  let nextId = 1;
  const ledger: FakeLedger = {
    rows: [],
    calls: [],
    pageLimit: 200,
    seed(sessionId, texts, route = ">") {
      for (const text of texts) {
        ledger.rows.push({
          id: nextId,
          session_id: sessionId,
          route,
          text,
          atoms: [],
          project_path: "/project/test",
          submitted_at_ms: 1_000 + nextId,
          client_entry_id: `seeded-${String(nextId)}`,
        });
        nextId += 1;
      }
    },
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const url = new URL(raw, "http://localhost");
    const method = init?.method ?? "GET";
    ledger.calls.push(`${method} ${url.pathname}`);

    if (url.pathname === "/api/prompt-history" && method === "POST") {
      const body = JSON.parse(init?.body as string) as Omit<LedgerRow, "id">;
      const existing = ledger.rows.find(
        (r) => r.client_entry_id === body.client_entry_id,
      );
      if (existing !== undefined) return jsonResponse(200, { id: existing.id });
      const row: LedgerRow = { id: nextId, ...body };
      nextId += 1;
      ledger.rows.push(row);
      return jsonResponse(200, { id: row.id });
    }

    if (url.pathname === "/api/prompt-history" && method === "GET") {
      const session = url.searchParams.get("session") ?? "";
      const beforeParam = url.searchParams.get("before");
      const before = beforeParam === null ? null : Number(beforeParam);
      const matching = ledger.rows
        .filter((r) => r.session_id === session)
        .filter((r) => before === null || r.id < before)
        .sort((a, b) => b.id - a.id);
      const page = matching.slice(0, ledger.pageLimit);
      return jsonResponse(200, {
        entries: page.slice().reverse(),
        has_more: matching.length > page.length,
        before,
      });
    }

    if (url.pathname === "/api/prompt-history/atom-path" && method === "POST") {
      const body = JSON.parse(init?.body as string) as {
        client_entry_id: string;
        atom_id: string;
        path: string;
      };
      const row = ledger.rows.find(
        (r) => r.client_entry_id === body.client_entry_id,
      );
      const atom = row?.atoms.find((a) => a.id === body.atom_id);
      if (atom === undefined) return jsonResponse(200, { ok: false });
      atom.path = body.path;
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(404, { error: "not found" });
  }) as unknown as typeof fetch;

  return ledger;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

/** Let the queued append(s) and any page fetch settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let _entryCounter = 0;

function makeEntry(
  sessionId: string,
  text: string,
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry {
  _entryCounter++;
  return {
    id: `entry-${_entryCounter}`,
    sessionId,
    projectPath: "/project/test",
    route: ">",
    text,
    atoms: [],
    timestamp: 1_700_000_000_000 + _entryCounter,
    ...overrides,
  };
}

const EMPTY_STATE: TugTextEditingState = { text: "", atoms: [], selection: null };

function makeState(text: string): TugTextEditingState {
  return { text, atoms: [], selection: null };
}

let ledger: FakeLedger;

beforeEach(() => {
  ledger = installFakeLedger();
  _entryCounter = 0;
});

afterEach(() => {
  __resetPromptHistoryOutbox();
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// push()
// ---------------------------------------------------------------------------

describe("PromptHistoryStore.push", () => {
  test("adds the entry and notifies subscribers", () => {
    const store = new PromptHistoryStore();
    let notifications = 0;
    const unsub = store.subscribe(() => {
      notifications++;
    });

    store.push(makeEntry("sess-1", "hello world"));

    expect(notifications).toBe(1);
    expect(store.getSnapshot().totalEntries).toBe(1);
    unsub();
  });

  test("appends to the ledger and records the row id on the entry", async () => {
    const store = new PromptHistoryStore();
    const entry = makeEntry("sess-persist", "hello ledger");
    store.push(entry);
    await settle();

    expect(ledger.rows.length).toBe(1);
    expect(ledger.rows[0].text).toBe("hello ledger");
    expect(ledger.rows[0].session_id).toBe("sess-persist");
    expect(ledger.rows[0].client_entry_id).toBe(entry.id);
    expect(entry.ledgerId).toBe(ledger.rows[0].id);
  });

  test("updates totalEntries across sessions", () => {
    const store = new PromptHistoryStore();
    store.push(makeEntry("sess-1", "first"));
    store.push(makeEntry("sess-2", "second"));
    store.push(makeEntry("sess-1", "third"));

    expect(store.getSnapshot().totalEntries).toBe(3);
  });

  test("getSnapshot returns a reference-stable value until state changes", () => {
    const store = new PromptHistoryStore();
    store.push(makeEntry("sess-1", "a"));
    const snap1 = store.getSnapshot();
    expect(store.getSnapshot()).toBe(snap1);

    store.push(makeEntry("sess-1", "b"));
    const snap3 = store.getSnapshot();
    expect(snap3).not.toBe(snap1);
    expect(snap3.totalEntries).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// No cap
// ---------------------------------------------------------------------------

describe("PromptHistoryStore capacity", () => {
  test("keeps every entry far past the retired 200-entry cap", async () => {
    const store = new PromptHistoryStore();
    const SID = "sess-uncapped";
    for (let i = 0; i < 250; i++) {
      store.push(makeEntry(SID, `entry-${String(i)}`));
    }
    await settle();

    expect(store.getSnapshot().totalEntries).toBe(250);
    expect(ledger.rows.length).toBe(250);

    // The oldest is still recallable — walking all the way back reaches it.
    const provider = store.createProvider(SID);
    let last: TugTextEditingState | null = null;
    for (let i = 0; i < 250; i++) {
      const step = provider.back(EMPTY_STATE);
      if (step === null) break;
      last = step;
    }
    expect(last?.text).toBe("entry-0");
  });
});

// ---------------------------------------------------------------------------
// Provider navigation
// ---------------------------------------------------------------------------

describe("PromptHistoryStore.createProvider", () => {
  test("back() returns the newest entry first, then older ones", () => {
    const store = new PromptHistoryStore();
    const SID = "sess-nav";
    store.push(makeEntry(SID, "first"));
    store.push(makeEntry(SID, "second"));
    store.push(makeEntry(SID, "third"));

    const provider = store.createProvider(SID);
    const current = makeState("draft");

    expect(provider.back(current)?.text).toBe("third");
    expect(provider.back(current)?.text).toBe("second");
    expect(provider.back(current)?.text).toBe("first");
    // Oldest reached and nothing older exists — null.
    expect(provider.back(current)).toBeNull();
  });

  test("forward() returns newer entries and then the draft", () => {
    const store = new PromptHistoryStore();
    const SID = "sess-fwd";
    store.push(makeEntry(SID, "first"));
    store.push(makeEntry(SID, "second"));

    const provider = store.createProvider(SID);
    const draft = makeState("current draft");
    provider.back(draft);
    provider.back(draft);

    expect(provider.forward()?.text).toBe("second");
    expect(provider.forward()?.text).toBe("current draft");
  });

  test("forward() returns null when already at the draft position", () => {
    const store = new PromptHistoryStore();
    store.push(makeEntry("sess-x", "something"));
    expect(store.createProvider("sess-x").forward()).toBeNull();
  });

  test("resetToDraft() returns the cursor to the end of the list", () => {
    const store = new PromptHistoryStore();
    const SID = "sess-reset";
    store.push(makeEntry(SID, "first"));
    store.push(makeEntry(SID, "second"));
    store.push(makeEntry(SID, "third"));

    const provider = store.createProvider(SID);
    provider.back(makeState("draft"));
    provider.back(makeState("draft"));
    provider.resetToDraft(EMPTY_STATE);

    expect(provider.back(makeState("draft"))?.text).toBe("third");
  });

  test("does not return entries from other sessions", () => {
    const store = new PromptHistoryStore();
    store.push(makeEntry("sess-A", "from session A"));
    store.push(makeEntry("sess-B", "from session B"));

    const providerA = store.createProvider("sess-A");
    expect(providerA.back(EMPTY_STATE)?.text).toBe("from session A");
    expect(providerA.back(EMPTY_STATE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadSession()
// ---------------------------------------------------------------------------

describe("PromptHistoryStore.loadSession", () => {
  test("pages the session's entries in, oldest-first", async () => {
    ledger.seed("sess-load", ["persisted A", "persisted B"]);

    const store = new PromptHistoryStore();
    await store.loadSession("sess-load");

    expect(store.getSnapshot().totalEntries).toBe(2);
    expect(store.getSessionEntries("sess-load").map((e) => e.text)).toEqual([
      "persisted A",
      "persisted B",
    ]);
    expect(store.hasMore("sess-load")).toBe(false);
  });

  test("is a no-op when called a second time for the same session", async () => {
    ledger.seed("sess-noop", ["entry"]);
    const store = new PromptHistoryStore();
    await store.loadSession("sess-noop");
    await store.loadSession("sess-noop");

    const gets = ledger.calls.filter((c) => c === "GET /api/prompt-history");
    expect(gets.length).toBe(1);
  });

  test("an empty session loads to zero entries", async () => {
    const store = new PromptHistoryStore();
    await store.loadSession("sess-empty");
    expect(store.getSnapshot().totalEntries).toBe(0);
  });

  test("reports hasMore when the corpus is longer than one page", async () => {
    ledger.pageLimit = 2;
    ledger.seed("sess-deep", ["a", "b", "c", "d"]);

    const store = new PromptHistoryStore();
    await store.loadSession("sess-deep");

    // The window is the newest suffix.
    expect(store.getSessionEntries("sess-deep").map((e) => e.text)).toEqual(["c", "d"]);
    expect(store.hasMore("sess-deep")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Window edges
// ---------------------------------------------------------------------------

describe("PromptHistoryStore window paging", () => {
  test("a back() off the top edge pages older entries in, and the next press lands", async () => {
    ledger.pageLimit = 2;
    ledger.seed("sess-page", ["a", "b", "c", "d"]);

    const store = new PromptHistoryStore();
    await store.loadSession("sess-page");
    const provider = store.createProvider("sess-page");

    expect(provider.back(EMPTY_STATE)?.text).toBe("d");
    expect(provider.back(EMPTY_STATE)?.text).toBe("c");
    // Top of the window: the press does not move, it fetches.
    expect(provider.back(EMPTY_STATE)).toBeNull();
    await settle();

    expect(store.getSessionEntries("sess-page").map((e) => e.text)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    // The cursor stayed put, so the press after arrival walks into what landed.
    expect(provider.back(EMPTY_STATE)?.text).toBe("b");
  });

  test("a route with zero entries in the window still pages backward", async () => {
    ledger.pageLimit = 2;
    ledger.seed("sess-routes", ["shell one", "shell two"], "$");
    ledger.seed("sess-routes", ["prompt one", "prompt two"], ">");

    const store = new PromptHistoryStore();
    await store.loadSession("sess-routes");
    // The window holds only the two `>` entries; `$` has none in it.
    const shell = store.createRouteProvider("sess-routes", "$");

    expect(shell.back(EMPTY_STATE)).toBeNull();
    await settle();

    // Paging brought the `$` entries in, so the route is no longer starved.
    expect(shell.back(EMPTY_STATE)?.text).toBe("shell two");
  });

  test("extendOlder is a no-op once the window reaches the start of the corpus", async () => {
    ledger.seed("sess-short", ["only"]);
    const store = new PromptHistoryStore();
    await store.loadSession("sess-short");
    const before = ledger.calls.length;

    await store.extendOlder("sess-short");

    expect(ledger.calls.length).toBe(before);
  });

  test("concurrent extendOlder calls share one fetch", async () => {
    ledger.pageLimit = 1;
    ledger.seed("sess-single-flight", ["a", "b", "c"]);
    const store = new PromptHistoryStore();
    await store.loadSession("sess-single-flight");
    const before = ledger.calls.filter((c) => c === "GET /api/prompt-history").length;

    await Promise.all([
      store.extendOlder("sess-single-flight"),
      store.extendOlder("sess-single-flight"),
      store.extendOlder("sess-single-flight"),
    ]);

    const after = ledger.calls.filter((c) => c === "GET /api/prompt-history").length;
    expect(after - before).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// patchAtomPath()
// ---------------------------------------------------------------------------

describe("PromptHistoryStore.patchAtomPath", () => {
  test("completes the atom in the window and on the wire", async () => {
    const store = new PromptHistoryStore();
    const entry = makeEntry("sess-atom", "look at this", {
      atoms: [{ position: 0, type: "image", label: "image-1", value: "image-1", id: "atom-1" }],
    });
    store.push(entry);
    await settle();

    store.patchAtomPath(entry.id, "atom-1", "/stored/original.png");
    await settle();

    expect(store.getSessionEntries("sess-atom")[0].atoms[0].path).toBe(
      "/stored/original.png",
    );
    expect(ledger.rows[0].atoms[0].path).toBe("/stored/original.png");
  });

  test("an already-pathed atom is left alone", async () => {
    const store = new PromptHistoryStore();
    const entry = makeEntry("sess-atom-2", "already stored", {
      atoms: [
        {
          position: 0,
          type: "image",
          label: "image-1",
          value: "image-1",
          id: "atom-1",
          path: "/first.png",
        },
      ],
    });
    store.push(entry);
    await settle();

    store.patchAtomPath(entry.id, "atom-1", "/second.png");

    expect(store.getSessionEntries("sess-atom-2")[0].atoms[0].path).toBe("/first.png");
  });

  test("an entry the window no longer holds is a no-op", async () => {
    const store = new PromptHistoryStore();
    store.patchAtomPath("never-pushed", "atom-9", "/x.png");
    await settle();

    expect(store.getSnapshot().totalEntries).toBe(0);
  });
});
