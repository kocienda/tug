/**
 * GitLogStore unit tests.
 *
 * Covers:
 * - `parseGitLogPayload` guard (valid / missing request_id / non-array commits
 *   / no_repo default).
 * - `formatGitLog` (ordering, sha shortening, column layout, empty, unicode).
 * - Store: `_ingestForTest` matching id → ready; a non-matching feed-path
 *   response ignored; the requested-key guard (same root no-op WHATEVER the
 *   phase — including a synchronous send error — different root re-requests,
 *   `refresh()` always re-requests) and the query shape.
 * - Paging: `loadMore` skips what is held and APPENDS, dedups a commit the
 *   window shifted onto twice, declines when there is nothing more or a page
 *   is in flight, keeps the walk visible while a page loads, and `refresh()`
 *   re-reads the whole loaded span rather than resetting to page one.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

import { FeedStore } from "../lib/feed-store";
import { FeedId } from "../protocol";
import type { TugConnection } from "../connection";

// The connection singleton is mocked here (not driven via `setConnection`)
// because bun's `mock.module` leaks globally across test files: another test
// mocks `connection-singleton` with a no-op `setConnection`, so a real
// `setConnection` call would silently do nothing in the full suite. Pinning
// `getConnection` to the current mock through `mock.module` — the same
// mechanism `card-services-store-request-replay.test.ts` uses — makes the
// store's send path deterministic regardless of file order.
let activeConnection: MockConnection | null = null;
mock.module("../lib/connection-singleton", () => ({
  getConnection: () => activeConnection,
  setConnection: () => {},
}));

// Imported after the mock so the store binds to the mocked singleton.
const { GitLogStore, parseGitLogPayload, formatGitLog } = await import(
  "../lib/git-log-store"
);
type GitLogPayload = import("../lib/git-log-store").GitLogPayload;
type GitLogCommit = import("../lib/git-log-store").GitLogCommit;
type GitLogStoreInstance = import("../lib/git-log-store").GitLogStore;

// ---------------------------------------------------------------------------
// Minimal TugConnection mock: onFrame (for FeedStore) + send (record queries).
// ---------------------------------------------------------------------------

class MockConnection {
  private callbacks = new Map<number, Array<(p: Uint8Array) => void>>();
  sent: Array<{ feedId: number; obj: Record<string, unknown> }> = [];

  onFrame(feedId: number, callback: (payload: Uint8Array) => void): () => void {
    if (!this.callbacks.has(feedId)) this.callbacks.set(feedId, []);
    const list = this.callbacks.get(feedId)!;
    list.push(callback);
    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  emit(feedId: number, payload: Uint8Array): void {
    for (const cb of this.callbacks.get(feedId) ?? []) cb(payload);
  }

  send(feedId: number, bytes: Uint8Array): void {
    this.sent.push({
      feedId,
      obj: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
    });
  }
}

function encodeJson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function payload(over: Partial<GitLogPayload> = {}): GitLogPayload {
  return {
    request_id: "gl-1",
    workspace_key: "ws",
    branch: "main",
    no_repo: false,
    offset: 0,
    has_more: false,
    commits: [],
    ...over,
  };
}

/** A commit whose only distinguishing mark is its sha. */
function commit(sha: string): GitLogCommit {
  return { sha, subject: `subject ${sha}`, author: "a", date: "2026-07-24" };
}

// ---------------------------------------------------------------------------

describe("parseGitLogPayload", () => {
  test("valid payload passes", () => {
    const parsed = parseGitLogPayload({
      request_id: "gl-9",
      workspace_key: "/w",
      branch: "trunk",
      no_repo: false,
      commits: [{ sha: "abc", subject: "s", author: "a", date: "2026-07-15" }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.request_id).toBe("gl-9");
    expect(parsed!.branch).toBe("trunk");
    expect(parsed!.commits).toHaveLength(1);
  });

  test("missing request_id → null", () => {
    expect(parseGitLogPayload({ commits: [] })).toBeNull();
  });

  test("non-array commits → null", () => {
    expect(parseGitLogPayload({ request_id: "x", commits: "nope" })).toBeNull();
  });

  test("no_repo defaults to false", () => {
    const parsed = parseGitLogPayload({ request_id: "x", commits: [] });
    expect(parsed!.no_repo).toBe(false);
  });
});

describe("formatGitLog", () => {
  const p = payload({
    commits: [
      {
        sha: "0123456789abcdef0123456789abcdef01234567",
        subject: "add feature",
        author: "Ada Lovelace",
        date: "2026-07-15",
      },
      {
        sha: "89abcdef0123456789abcdef0123456789abcdef",
        subject: "initial",
        author: "Grace Hopper",
        date: "2026-07-14",
      },
    ],
  });

  test("one line per commit in wire order, sha shortened to 9, em-arc subject", () => {
    const lines = formatGitLog(p).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("012345678  2026-07-15  Ada Lovelace — add feature");
    expect(lines[1]).toBe("89abcdef0  2026-07-14  Grace Hopper — initial");
  });

  test("no trailing newline", () => {
    expect(formatGitLog(p).endsWith("\n")).toBe(false);
  });

  test("empty payload → empty string", () => {
    expect(formatGitLog(payload({ commits: [] }))).toBe("");
  });

  test("unicode author passes through", () => {
    const out = formatGitLog(
      payload({
        commits: [
          { sha: "deadbeefdeadbeef", subject: "s", author: "Ünïcode Nàme", date: "2026-07-15" },
        ],
      }),
    );
    expect(out).toContain("Ünïcode Nàme");
  });
});

describe("GitLogStore", () => {
  let mock: MockConnection;
  let feedStore: FeedStore;
  let store: GitLogStoreInstance;

  beforeEach(() => {
    mock = new MockConnection();
    // `getConnection()` (mocked above) returns whatever `activeConnection`
    // points at, so the store's send path targets this same mock.
    activeConnection = mock;
    feedStore = new FeedStore(mock as unknown as TugConnection, [
      FeedId.GIT_LOG,
      FeedId.GIT_HEAD,
    ]);
    store = new GitLogStore(feedStore);
  });

  test("_ingestForTest with a payload → ready", () => {
    store._ingestForTest(payload({ request_id: "gl-x", commits: [] }));
    expect(store.getSnapshot().phase).toBe("ready");
    expect(store.getSnapshot().payload!.request_id).toBe("gl-x");
  });

  test("a non-matching request_id from the feed path is ignored", () => {
    store.requestLog("/proj");
    expect(store.getSnapshot().phase).toBe("loading");
    const inFlight = store.getSnapshot().requestId!;

    // A response for a different request must not resolve this store.
    mock.emit(FeedId.GIT_LOG, encodeJson(payload({ request_id: "other" })));
    expect(store.getSnapshot().phase).toBe("loading");

    // The correlated response resolves it.
    mock.emit(FeedId.GIT_LOG, encodeJson(payload({ request_id: inFlight })));
    expect(store.getSnapshot().phase).toBe("ready");
    expect(store.getSnapshot().payload!.request_id).toBe(inFlight);
  });

  test("the query carries root, requestId, offset, and limit", () => {
    store.requestLog("/proj", 5);
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].feedId).toBe(FeedId.GIT_LOG_QUERY);
    expect(mock.sent[0].obj.root).toBe("/proj");
    expect(mock.sent[0].obj.limit).toBe(5);
    expect(mock.sent[0].obj.offset).toBe(0);
    expect(typeof mock.sent[0].obj.requestId).toBe("string");
  });

  test("requested-key guard: same root is a no-op, a different root re-requests", () => {
    store.requestLog("/a");
    expect(mock.sent).toHaveLength(1);

    // Same root while loading → no-op.
    store.requestLog("/a");
    expect(mock.sent).toHaveLength(1);

    // Resolve, then same root while ready → still a no-op.
    const rid = store.getSnapshot().requestId!;
    mock.emit(FeedId.GIT_LOG, encodeJson(payload({ request_id: rid })));
    expect(store.getSnapshot().phase).toBe("ready");
    store.requestLog("/a");
    expect(mock.sent).toHaveLength(1);

    // A different root fires a fresh query.
    store.requestLog("/b");
    expect(mock.sent).toHaveLength(2);

    // refresh() always re-requests the current root.
    store.refresh();
    expect(mock.sent).toHaveLength(3);
    expect(mock.sent[2].obj.root).toBe("/b");
  });

  test("an errored root does not re-request — retry is refresh(), not requestLog", () => {
    // No connection: the send fails and publishes `error` SYNCHRONOUSLY. A
    // caller that treated `error` as "request again" would re-enter here with
    // no await in between; a React effect keyed on `phase` spins to the render
    // depth limit ([L28] — the source owns its retry policy).
    activeConnection = null;
    store.requestLog("/proj");
    expect(store.getSnapshot().phase).toBe("error");
    expect(store.getSnapshot().requestedRoot).toBe("/proj");

    // Every later call for the same root is a no-op, error or not.
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    for (let i = 0; i < 5; i++) store.requestLog("/proj");
    expect(notifications).toBe(0);

    // Recovery is explicit: the connection returns, an activation refreshes.
    activeConnection = mock;
    store.refresh();
    expect(store.getSnapshot().phase).toBe("loading");
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].obj.root).toBe("/proj");
  });

  test("a GIT_HEAD signal for the shown workspace with a new head re-requests", () => {
    // Show a ready log for workspace W with HEAD 'aaa'.
    store.requestLog("/proj");
    const rid = store.getSnapshot().requestId!;
    mock.emit(
      FeedId.GIT_LOG,
      encodeJson(
        payload({
          request_id: rid,
          workspace_key: "W",
          commits: [{ sha: "aaa000", subject: "s", author: "a", date: "2026-07-15" }],
        }),
      ),
    );
    expect(store.getSnapshot().phase).toBe("ready");
    const before = mock.sent.length;

    // HEAD moved past 'aaa' for W → a fresh query fires.
    mock.emit(FeedId.GIT_HEAD, encodeJson({ workspace_key: "W", head: "bbb111" }));
    expect(mock.sent.length).toBe(before + 1);
  });

  test("a GIT_HEAD signal for a different workspace is ignored", () => {
    store.requestLog("/proj");
    const rid = store.getSnapshot().requestId!;
    mock.emit(
      FeedId.GIT_LOG,
      encodeJson(
        payload({
          request_id: rid,
          workspace_key: "W",
          commits: [{ sha: "aaa000", subject: "s", author: "a", date: "2026-07-15" }],
        }),
      ),
    );
    const before = mock.sent.length;
    mock.emit(FeedId.GIT_HEAD, encodeJson({ workspace_key: "OTHER", head: "bbb111" }));
    expect(mock.sent.length).toBe(before);
  });

  test("a GIT_HEAD signal at the already-shown head is a no-op", () => {
    store.requestLog("/proj");
    const rid = store.getSnapshot().requestId!;
    mock.emit(
      FeedId.GIT_LOG,
      encodeJson(
        payload({
          request_id: rid,
          workspace_key: "W",
          commits: [{ sha: "aaa000", subject: "s", author: "a", date: "2026-07-15" }],
        }),
      ),
    );
    const before = mock.sent.length;
    // Same head we already display → dedup, no re-request.
    mock.emit(FeedId.GIT_HEAD, encodeJson({ workspace_key: "W", head: "aaa000" }));
    expect(mock.sent.length).toBe(before);
  });
});

describe("GitLogStore paging", () => {
  let mock: MockConnection;
  let store: GitLogStoreInstance;

  /** Resolve the in-flight request with `over` merged onto a base payload. */
  function land(over: Partial<GitLogPayload>): void {
    const rid = store.getSnapshot().requestId!;
    mock.emit(FeedId.GIT_LOG, encodeJson(payload({ request_id: rid, ...over })));
  }

  /** The shas the store currently holds, in order. */
  function heldShas(): string[] {
    return (store.getSnapshot().payload?.commits ?? []).map((c) => c.sha);
  }

  beforeEach(() => {
    mock = new MockConnection();
    activeConnection = mock;
    store = new GitLogStore(
      new FeedStore(mock as unknown as TugConnection, [
        FeedId.GIT_LOG,
        FeedId.GIT_HEAD,
      ]),
    );
    // A first page of two, with history behind it.
    store.requestLog("/proj", 2);
    land({ has_more: true, commits: [commit("c1"), commit("c2")] });
  });

  test("loadMore skips what is held and appends the page it gets back", () => {
    store.loadMore(2);
    expect(mock.sent).toHaveLength(2);
    expect(mock.sent[1].obj.offset).toBe(2);
    expect(mock.sent[1].obj.limit).toBe(2);

    land({ offset: 2, has_more: true, commits: [commit("c3"), commit("c4")] });
    expect(heldShas()).toEqual(["c1", "c2", "c3", "c4"]);
    // The accumulated walk always starts at HEAD, whatever built it.
    expect(store.getSnapshot().payload!.offset).toBe(0);
    expect(store.getSnapshot().payload!.has_more).toBe(true);
  });

  test("the walk stays visible while a page is in flight", () => {
    store.loadMore(2);
    const snapshot = store.getSnapshot();
    // Not `loading`: the list is growing, not reloading. Blanking it here
    // would drop the scroll offset out from under the reader.
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.loadingMore).toBe(true);
    expect(heldShas()).toEqual(["c1", "c2"]);

    land({ offset: 2, has_more: false, commits: [commit("c3")] });
    expect(store.getSnapshot().loadingMore).toBe(false);
  });

  test("a commit that landed under the window is not appended twice", () => {
    // Someone commits between the request and its answer, so every commit
    // shifts one deeper and offset 2 now names `c2` — already held.
    store.loadMore(2);
    land({ offset: 2, has_more: true, commits: [commit("c2"), commit("c3")] });
    expect(heldShas()).toEqual(["c1", "c2", "c3"]);
  });

  test("loadMore declines with nothing more to fetch, or a page in flight", () => {
    store.refresh();
    land({ has_more: false, commits: [commit("c1"), commit("c2")] });
    const settled = mock.sent.length;
    store.loadMore(2);
    expect(mock.sent).toHaveLength(settled);

    // And with a page already in flight, a second ask is a no-op — a scroller
    // may fire this on every intersection without debouncing.
    store.refresh();
    land({ has_more: true, commits: [commit("c1"), commit("c2")] });
    const before = mock.sent.length;
    store.loadMore(2);
    store.loadMore(2);
    expect(mock.sent.length).toBe(before + 1);
  });

  test("refresh re-reads the whole loaded span, from the top", () => {
    store.loadMore(2);
    land({ offset: 2, has_more: true, commits: [commit("c3"), commit("c4")] });

    // A GIT_HEAD move must not yank a reader who has paged deep back to the
    // first page: the re-read covers everything already on screen.
    mock.emit(FeedId.GIT_HEAD, encodeJson({ workspace_key: "ws", head: "new" }));
    const query = mock.sent[mock.sent.length - 1].obj;
    expect(query.offset).toBe(0);
    expect(query.limit).toBeGreaterThanOrEqual(4);
    // ...and the list holds still until the answer lands.
    expect(store.getSnapshot().payload).not.toBeNull();
    expect(heldShas()).toEqual(["c1", "c2", "c3", "c4"]);

    // The re-read REPLACES rather than appends — a rebase that dropped a
    // commit must not leave its ghost in the walk.
    land({ has_more: false, commits: [commit("c0"), commit("c1")] });
    expect(heldShas()).toEqual(["c0", "c1"]);
  });

  test("a different root drops the walk; the same root keeps it", () => {
    store.requestLog("/other");
    expect(store.getSnapshot().payload).toBeNull();
    expect(store.getSnapshot().phase).toBe("loading");
  });
});
