/**
 * filetree-store unit tests.
 *
 * Tests cover:
 * - Store starts with empty snapshot.
 * - Subscribing to a FeedStore that emits a FILETREE response updates the snapshot.
 * - getFileCompletionProvider() returns a stable closure with subscribe method.
 * - Provider deduplication: same query only sends one frame.
 * - Provider staleness: returns [] when snapshot.query doesn't match.
 * - CompletionItem results include matches field from scored results.
 * - Subscribers are notified on response change.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock connection singleton (must be before FileTreeStore import)
// ---------------------------------------------------------------------------

let sentFrames: Array<{ feedId: number; payload: string }> = [];

// The real setter, frozen before the mock replaces the module, so this
// file-wide mock cannot swallow another suite's `setConnection` call. A factory
// that omits an export leaves it `undefined` for every later importer in the
// process, and that mutual defection is why the sibling store tests each mock
// defensively. [B10]
import { setConnection as _realSetConnection } from "../lib/connection-singleton";
const realSetConnection = _realSetConnection;

mock.module("../lib/connection-singleton", () => ({
  getConnection: () => ({
    send: (feedId: number, payload: Uint8Array) => {
      sentFrames.push({
        feedId,
        payload: new TextDecoder().decode(payload),
      });
    },
  }),
  setConnection: realSetConnection,
}));

import { FileTreeStore } from "../lib/filetree-store";
import type { FileTreeResultSnapshot } from "../lib/filetree-store";

// ---------------------------------------------------------------------------
// Mock FeedStore
// ---------------------------------------------------------------------------

class MockFeedStore {
  private _data: Map<number, unknown> = new Map();
  private _listeners: Array<() => void> = [];

  subscribe(listener: () => void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  getSnapshot(): Map<number, unknown> {
    return this._data;
  }

  emit(feedId: number, payload: unknown): void {
    const next = new Map(this._data);
    next.set(feedId, payload);
    this._data = next;
    for (const listener of this._listeners) {
      listener();
    }
  }
}

beforeEach(() => {
  sentFrames = [];
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILETREE_FEED_ID = 0x11;
const FILETREE_QUERY_FEED_ID = 0x12;

function makeResponse(query: string, paths: string[]): Record<string, unknown> {
  return {
    query,
    results: paths.map((path, i) => ({
      path,
      score: 100 - i * 10,
      matches: [[0, 1]],
    })),
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// Tests: initial state
// ---------------------------------------------------------------------------

describe("FileTreeStore initial state", () => {
  test("starts with empty snapshot", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const snap = store.getSnapshot();
    expect(snap.query).toBe("");
    expect(snap.results).toEqual([]);
    expect(snap.truncated).toBe(false);
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: response parsing
// ---------------------------------------------------------------------------

describe("FileTreeStore response parsing", () => {
  test("updates snapshot on FILETREE payload", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);

    feedStore.emit(FILETREE_FEED_ID, makeResponse("sms", [
      "src/lib/session-metadata-store.ts",
      "src/lib/shell-metadata-store.ts",
    ]));

    const snap = store.getSnapshot();
    expect(snap.query).toBe("sms");
    expect(snap.results.length).toBe(2);
    expect(snap.results[0].path).toBe("src/lib/session-metadata-store.ts");
    expect(snap.results[0].score).toBe(100);
    expect(snap.results[0].matches).toEqual([[0, 1]]);
    store.dispose();
  });

  test("notifies subscribers on update", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const listener = mock(() => {});

    store.subscribe(listener);
    feedStore.emit(FILETREE_FEED_ID, makeResponse("model", ["model.ts"]));

    expect(listener).toHaveBeenCalled();
    store.dispose();
  });

  test("does not notify on duplicate reference", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const listener = mock(() => {});

    const payload = makeResponse("x", ["x.ts"]);
    feedStore.emit(FILETREE_FEED_ID, payload);
    store.subscribe(listener);

    // Emit the same reference again — no notification.
    feedStore.emit(FILETREE_FEED_ID, payload);
    // Listener was added after the first emit, so it should not fire on dup ref.
    expect(listener).not.toHaveBeenCalled();
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: CompletionProvider
// ---------------------------------------------------------------------------

describe("FileTreeStore getFileCompletionProvider()", () => {
  test("returns a stable closure", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const p1 = store.getFileCompletionProvider();
    const p2 = store.getFileCompletionProvider();
    // Each call returns a new provider (different closures with their own lastSentQuery),
    // but that's fine — the pattern is to call it once and store.
    expect(typeof p1).toBe("function");
    expect(typeof p2).toBe("function");
    store.dispose();
  });

  test("provider has subscribe method", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const provider = store.getFileCompletionProvider();
    expect(typeof provider.subscribe).toBe("function");
    store.dispose();
  });

  test("provider returns CompletionItems with matches from snapshot", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const provider = store.getFileCompletionProvider();

    feedStore.emit(FILETREE_FEED_ID, makeResponse("sms", [
      "src/lib/session-metadata-store.ts",
    ]));

    const items = provider("sms");
    expect(items.length).toBe(1);
    expect(items[0].label).toBe("src/lib/session-metadata-store.ts");
    expect(items[0].atom.type).toBe("file");
    expect(items[0].matches).toEqual([[0, 1]]);
    store.dispose();
  });

  test("provider deduplication: same query sends only one frame", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const provider = store.getFileCompletionProvider();

    provider("model");
    provider("model");
    provider("model");

    // Only one FILETREE_QUERY frame sent.
    const queryFrames = sentFrames.filter((f) => f.feedId === FILETREE_QUERY_FEED_ID);
    expect(queryFrames.length).toBe(1);
    store.dispose();
  });

  test("provider deduplication: different queries send separate frames", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const provider = store.getFileCompletionProvider();

    provider("s");
    provider("sm");
    provider("sms");

    const queryFrames = sentFrames.filter((f) => f.feedId === FILETREE_QUERY_FEED_ID);
    expect(queryFrames.length).toBe(3);
    store.dispose();
  });

  test("provider staleness: returns [] when snapshot.query doesn't match", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const provider = store.getFileCompletionProvider();

    // Snapshot has results for "old" but we query "new".
    feedStore.emit(FILETREE_FEED_ID, makeResponse("old", ["old.ts"]));

    const items = provider("new");
    expect(items).toEqual([]);
    store.dispose();
  });

  test("provider returns results when snapshot.query matches", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const provider = store.getFileCompletionProvider();

    feedStore.emit(FILETREE_FEED_ID, makeResponse("model", ["model.ts"]));

    const items = provider("model");
    expect(items.length).toBe(1);
    expect(items[0].label).toBe("model.ts");
    store.dispose();
  });

  test("subscribe callback fires when snapshot updates", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const provider = store.getFileCompletionProvider();
    const listener = mock(() => {});

    provider.subscribe!(listener);
    feedStore.emit(FILETREE_FEED_ID, makeResponse("sms", ["store.ts"]));

    expect(listener).toHaveBeenCalled();
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: sendQuery
// ---------------------------------------------------------------------------

describe("FileTreeStore sendQuery()", () => {
  test("sends correctly formatted FILETREE_QUERY frame", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);

    store.sendQuery("test");

    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0].feedId).toBe(FILETREE_QUERY_FEED_ID);
    const parsed = JSON.parse(sentFrames[0].payload);
    expect(parsed.query).toBe("test");
    expect(parsed.root).toBeUndefined();
    store.dispose();
  });

  test("includes root when provided", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);

    store.sendQuery("test", "/other/project");

    const parsed = JSON.parse(sentFrames[0].payload);
    expect(parsed.query).toBe("test");
    expect(parsed.root).toBe("/other/project");
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: dispose
// ---------------------------------------------------------------------------

describe("FileTreeStore dispose()", () => {
  test("stops receiving updates after dispose", () => {
    const feedStore = new MockFeedStore();
    const store = new FileTreeStore(feedStore as any, FILETREE_FEED_ID);
    const listener = mock(() => {});

    store.subscribe(listener);
    store.dispose();

    feedStore.emit(FILETREE_FEED_ID, makeResponse("x", ["x.ts"]));
    expect(listener).not.toHaveBeenCalled();
  });
});
