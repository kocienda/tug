/**
 * Pin the `OverviewStore` external-store contract:
 *
 *   - First `getSnapshot` kicks the one-shot `list_overview_posts` tail
 *     request and returns pending.
 *   - `list_overview_posts_ok` settles to ready, oldest-first.
 *   - Live OVERVIEW frames fold (including while pending), dedupe against
 *     the tail by ledger id, and the channel caps at `OVERVIEW_MAX_ROWS` —
 *     from whichever end the reader is not at.
 *   - Scrollback: `loadOlder` asks for the page before the oldest post held;
 *     a page prepends behind the dedupe; a page whose echoed `before_id` is
 *     not the one outstanding is DROPPED (the response bus is a broadcast,
 *     and a page applied twice prepends twice); a tail supersedes a page in
 *     flight; and `hasMore` goes false both at the beginning of history and
 *     at the ceiling.
 *   - A transient post is its own occurrence — it has no rowid to dedupe on.
 *   - Snapshots are referentially stable between folds.
 *   - The write path: `submitQuestion` sends `OVERVIEW_INPUT` and holds a
 *     pending marker until the answer — or the transient failure — carrying
 *     that request id lands; one question at a time; the timeout ends the wait
 *     with a post rather than a spinner.
 *   - [L26] a post keys by its request id, so the pending row and the answer
 *     that resolves it are the same row.
 *   - [L27] `dispose()` releases the frame registration and the pending timer.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  DEFAULT_OVERVIEW_CARD_ROWS,
  OVERVIEW_MAX_ROWS,
  OverviewStore,
  publishListOverviewPostsOk,
} from "@/lib/overview-store";
import type { TugConnection } from "@/connection";
import { FeedId, type FeedIdValue, type OverviewPostWire } from "@/protocol";

type FrameCallback = (payload: Uint8Array) => void;

class FakeConnection {
  readonly frames: Array<{ feedId: FeedIdValue; payload: Uint8Array }> = [];
  readonly frameSubscribers = new Map<number, FrameCallback[]>();
  send(feedId: FeedIdValue, payload: Uint8Array): void {
    this.frames.push({ feedId, payload });
  }
  onFrame(feedId: number, callback: FrameCallback): () => void {
    const list = this.frameSubscribers.get(feedId) ?? [];
    list.push(callback);
    this.frameSubscribers.set(feedId, list);
    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }
  /** How many callbacks are live on a feed — [L27]'s observable. */
  liveCallbacks(feedId: number): number {
    return (this.frameSubscribers.get(feedId) ?? []).length;
  }
  pushOverviewFrame(post: Record<string, unknown>): void {
    const payload = new TextEncoder().encode(JSON.stringify(post));
    for (const cb of this.frameSubscribers.get(FeedId.OVERVIEW) ?? []) {
      cb(payload);
    }
  }
}

function makeStore(): { store: OverviewStore; conn: FakeConnection } {
  const conn = new FakeConnection();
  const store = new OverviewStore(conn as unknown as TugConnection);
  return { store, conn };
}

/** A persisted Observer post as tugcast serializes it. */
function post(id: number, body: string): Record<string, unknown> {
  return {
    id,
    at_ms: 1_700_000_000_000 + id,
    author: "observer",
    session_id: "sess-a",
    wake_reason: "turn-end",
    body,
  };
}

const stores: OverviewStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

describe("OverviewStore", () => {
  it("first snapshot kicks exactly one tail request and reads pending", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    const first = store.getSnapshot();
    expect(first.status).toBe("pending");
    expect(first.posts.length).toBe(0);
    expect(first.cardRows).toBe(DEFAULT_OVERVIEW_CARD_ROWS);
    store.getSnapshot();
    expect(conn.frames.length).toBe(1);
    expect(conn.frames[0].feedId).toBe(FeedId.CONTROL);
    const decoded = JSON.parse(new TextDecoder().decode(conn.frames[0].payload));
    expect(decoded.action).toBe("list_overview_posts");
  });

  it("the tail response settles to ready, oldest-first, fields decoded", () => {
    const { store } = makeStore();
    stores.push(store);
    store.getSnapshot();
    publishListOverviewPostsOk({
      posts: [post(1, "first"), post(2, "second")] as unknown as OverviewPostWire[],
    });
    const snap = store.getSnapshot();
    expect(snap.status).toBe("ready");
    expect(snap.posts.map((p) => p.body)).toEqual(["first", "second"]);
    const newest = snap.posts[1];
    expect(newest.id).toBe(2);
    expect(newest.author).toBe("observer");
    expect(newest.sessionId).toBe("sess-a");
    expect(newest.wakeReason).toBe("turn-end");
    expect(newest.transient).toBe(false);
    expect(newest.requestId).toBeNull();
  });

  it("live frames fold, dedupe against the tail by ledger id, survive pending", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // A live post lands while the tail load is still pending…
    conn.pushOverviewFrame(post(2, "second"));
    expect(store.getSnapshot().posts.map((p) => p.body)).toEqual(["second"]);
    // …then the tail arrives carrying the SAME post plus history.
    publishListOverviewPostsOk({
      posts: [post(1, "first"), post(2, "second")] as unknown as OverviewPostWire[],
    });
    expect(store.getSnapshot().posts.map((p) => p.body)).toEqual([
      "first",
      "second",
    ]);
    // A fresh live post appends; a re-delivery of the same rowid does not.
    conn.pushOverviewFrame(post(3, "third"));
    conn.pushOverviewFrame(post(3, "third"));
    expect(store.getSnapshot().posts.map((p) => p.body)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("an uncorrelated transient post is its own occurrence", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // No rowid and no request id: nothing to dedupe on, so each delivery is
    // its own occurrence rather than a repeat of the last one.
    const transient = {
      at_ms: 1_700_000_000_000,
      author: "operator",
      body: "The Operator could not answer.",
      transient: true,
    };
    conn.pushOverviewFrame(transient);
    conn.pushOverviewFrame(transient);
    const snap = store.getSnapshot();
    expect(snap.posts.length).toBe(2);
    expect(snap.posts[0].id).toBeNull();
    expect(snap.posts[0].transient).toBe(true);
    expect(snap.posts[0].key).not.toBe(snap.posts[1].key);
  });

  it("a transient post carrying a request id is that one answer, once", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    const transient = {
      at_ms: 1_700_000_000_000,
      author: "operator",
      body: "Couldn't answer that.",
      request_id: "req-1",
      transient: true,
    };
    // Redelivered by a reconnect: the request id says it is the same answer
    // to the same question, so it lands once ([L26]).
    conn.pushOverviewFrame(transient);
    conn.pushOverviewFrame(transient);
    const snap = store.getSnapshot();
    expect(snap.posts.length).toBe(1);
    expect(snap.posts[0].requestId).toBe("req-1");
    expect(snap.posts[0].key).toBe("req:operator:req-1");
  });

  it("card_rows sizes the opening request rather than the list", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // The knob is what the card ASKS for now — it no longer truncates what
    // the card holds, because the reader can page past it.
    const decoded = JSON.parse(new TextDecoder().decode(conn.frames[0].payload));
    expect(decoded.limit).toBe(DEFAULT_OVERVIEW_CARD_ROWS);
    for (let id = 1; id <= DEFAULT_OVERVIEW_CARD_ROWS + 5; id++) {
      conn.pushOverviewFrame(post(id, `post ${id}`));
    }
    expect(store.getSnapshot().posts.length).toBe(DEFAULT_OVERVIEW_CARD_ROWS + 5);
  });

  it("the accumulated list stops at the ceiling, dropping the end the reader left", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // Following the bottom: the OLDEST rows go, exactly as they always did.
    for (let id = 1; id <= OVERVIEW_MAX_ROWS + 5; id++) {
      conn.pushOverviewFrame(post(id, `post ${id}`));
    }
    const followed = store.getSnapshot();
    expect(followed.posts.length).toBe(OVERVIEW_MAX_ROWS);
    expect(followed.posts[0].body).toBe("post 6");
    expect(followed.posts[followed.posts.length - 1].body).toBe(
      `post ${OVERVIEW_MAX_ROWS + 5}`,
    );
  });

  it("refs survive parse; an unrenderable kind is dropped, the post is not", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushOverviewFrame({
      ...post(1, "with refs"),
      refs: [
        { kind: "file", target: "tugdeck/src/x.css" },
        { kind: "sonnet", target: "nope" },
        { kind: "commit", target: "" },
        { kind: "commit", target: "a597790b0" },
      ],
    });
    const snap = store.getSnapshot();
    expect(snap.posts.length).toBe(1);
    expect(snap.posts[0].refs).toEqual([
      { kind: "file", target: "tugdeck/src/x.css" },
      { kind: "commit", target: "a597790b0" },
    ]);
  });

  it("snapshots are referentially stable between folds", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    const a = store.getSnapshot();
    const b = store.getSnapshot();
    expect(a).toBe(b);
    conn.pushOverviewFrame(post(1, "one"));
    const c = store.getSnapshot();
    expect(c).not.toBe(b);
    expect(store.getSnapshot()).toBe(c);
    // Malformed bodies and unknown authors change nothing.
    conn.pushOverviewFrame({ nonsense: true });
    conn.pushOverviewFrame({ ...post(9, "who?"), author: "columnist" });
    expect(store.getSnapshot()).toBe(c);
  });

  // -------------------------------------------------------------------------
  // The write path
  // -------------------------------------------------------------------------

  /** The Operator's answer to `requestId`, as tugcast serializes it. */
  function answer(
    id: number | null,
    requestId: string,
    body: string,
  ): Record<string, unknown> {
    return {
      ...(id === null ? {} : { id }),
      at_ms: 1_700_000_100_000,
      author: "operator",
      body,
      request_id: requestId,
      transient: id === null,
    };
  }

  it("submitQuestion sends OVERVIEW_INPUT and goes pending", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    const requestId = store.submitQuestion("  what landed today?  ");
    expect(requestId).not.toBeNull();
    const sent = conn.frames.filter((f) => f.feedId === FeedId.OVERVIEW_INPUT);
    expect(sent.length).toBe(1);
    const decoded = JSON.parse(new TextDecoder().decode(sent[0].payload));
    expect(decoded.body).toBe("what landed today?");
    expect(decoded.requestId).toBe(requestId);
    expect(store.getSnapshot().pendingRequestId).toBe(requestId);
  });

  it("an empty question is not a question, and one is asked at a time", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    expect(store.submitQuestion("   ")).toBeNull();
    expect(conn.frames.filter((f) => f.feedId === FeedId.OVERVIEW_INPUT).length)
      .toBe(0);
    expect(store.submitQuestion("first")).not.toBeNull();
    expect(store.submitQuestion("second, while the first is in flight"))
      .toBeNull();
    expect(conn.frames.filter((f) => f.feedId === FeedId.OVERVIEW_INPUT).length)
      .toBe(1);
  });

  it("attached images ride the question up, and a picture alone is one", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // A picture with no words is a question — the gate is the pair.
    const requestId = store.submitQuestion("", [
      { mediaType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(requestId).not.toBeNull();
    const sent = conn.frames.filter((f) => f.feedId === FeedId.OVERVIEW_INPUT);
    const decoded = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    expect(decoded.body).toBe("");
    expect(decoded.attachments).toEqual([
      { mediaType: "image/png", data: "aGVsbG8=" },
    ]);
  });

  it("a question with no picture sends no attachments field at all", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    store.submitQuestion("what landed today?");
    const sent = conn.frames.filter((f) => f.feedId === FeedId.OVERVIEW_INPUT);
    const decoded = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    expect("attachments" in decoded).toBe(false);
  });

  it("a post's attachments come through, and a malformed one is dropped", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    conn.pushOverviewFrame({
      id: 11,
      at_ms: 1,
      author: "user",
      body: "what is this",
      refs: [],
      transient: false,
      attachments: [
        { path: "/tmp/gz/a.png", media_type: "image/png" },
        // Relative path and empty media type: a tile nobody can point at.
        { path: "relative.png", media_type: "image/png" },
        { path: "/tmp/gz/b.png", media_type: "" },
      ],
    });
    const post = store.getSnapshot().posts[0]!;
    expect(post.attachments.length).toBe(1);
    expect(post.attachments[0]!.path).toBe("/tmp/gz/a.png");
  });

  it("the answer clears the wait and keys as the pending row did ([L26])", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    const requestId = store.submitQuestion("why is the wash pale")!;
    conn.pushOverviewFrame(answer(7, requestId, "Because the tint is low."));
    const snap = store.getSnapshot();
    expect(snap.pendingRequestId).toBeNull();
    expect(snap.posts.length).toBe(1);
    // The card renders its placeholder under exactly this key, so the row
    // survives the swap instead of being torn down and rebuilt.
    expect(snap.posts[0].key).toBe(`req:operator:${requestId}`);
    expect(snap.posts[0].id).toBe(7);
    expect(store.submitQuestion("another one")).not.toBeNull();
  });

  it("a transient failure post clears the wait too — nothing hangs", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    const requestId = store.submitQuestion("something unanswerable")!;
    conn.pushOverviewFrame(answer(null, requestId, "Couldn't answer that."));
    const snap = store.getSnapshot();
    expect(snap.pendingRequestId).toBeNull();
    expect(snap.posts[0].transient).toBe(true);
    expect(snap.posts[0].id).toBeNull();
  });

  it("an answer to some OTHER question leaves this one waiting", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    const requestId = store.submitQuestion("mine")!;
    conn.pushOverviewFrame(answer(7, "req-someone-else", "not yours"));
    expect(store.getSnapshot().pendingRequestId).toBe(requestId);
  });

  it("the user's own echoed question is a different row from its answer", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    const requestId = store.submitQuestion("what landed")!;
    // tugcast persists and broadcasts the question first ([P08]) — it carries
    // the same request id as the answer that follows it.
    conn.pushOverviewFrame({
      id: 6,
      at_ms: 1_700_000_099_000,
      author: "user",
      body: "what landed",
      request_id: requestId,
    });
    conn.pushOverviewFrame(answer(7, requestId, "Two commits."));
    const snap = store.getSnapshot();
    expect(snap.posts.map((p) => p.author)).toEqual(["user", "operator"]);
    expect(snap.posts[0].key).not.toBe(snap.posts[1].key);
  });

  it("a post the tail re-delivers without its request id still dedupes", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    const requestId = store.submitQuestion("what landed")!;
    conn.pushOverviewFrame(answer(7, requestId, "Two commits."));
    // The ledger does not persist a request id, so the tail's copy of that
    // same post keys differently — only the rowid is the same on both wires.
    publishListOverviewPostsOk({
      posts: [
        {
          id: 7,
          at_ms: 1_700_000_100_000,
          author: "operator",
          body: "Two commits.",
        },
      ] as unknown as OverviewPostWire[],
    });
    expect(store.getSnapshot().posts.length).toBe(1);
  });

  it("dispose unwires the frame registration, leaving no live callback", () => {
    const { store, conn } = makeStore();
    expect(conn.liveCallbacks(FeedId.OVERVIEW)).toBe(1);
    store.getSnapshot();
    store.dispose();
    // [L27]: the acquisition is released, not merely guarded — the
    // connection is left holding nothing.
    expect(conn.liveCallbacks(FeedId.OVERVIEW)).toBe(0);
    // And the CONTROL bus no longer reaches a disposed store.
    publishListOverviewPostsOk({
      posts: [post(1, "after dispose")] as unknown as OverviewPostWire[],
    });
    expect(store.getSnapshot().posts.length).toBe(0);
  });

  /**
   * [L27]'s third acquisition. Observed through the timer functions the store
   * actually calls rather than through a private field, so the assertion is
   * about the release happening, not about how it is bookkept.
   */
  it("dispose releases the pending question's timer", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const live = new Set<unknown>();
    try {
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms);
        live.add(handle);
        return handle;
      }) as typeof globalThis.setTimeout;
      globalThis.clearTimeout = ((handle: unknown) => {
        live.delete(handle);
        return realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
      }) as typeof globalThis.clearTimeout;

      const { store } = makeStore();
      store.getSnapshot();
      store.submitQuestion("a question left hanging");
      expect(live.size).toBe(1);
      store.dispose();
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  it("the answer releases the timer too, not just the pending marker", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const live = new Set<unknown>();
    try {
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms);
        live.add(handle);
        return handle;
      }) as typeof globalThis.setTimeout;
      globalThis.clearTimeout = ((handle: unknown) => {
        live.delete(handle);
        return realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
      }) as typeof globalThis.clearTimeout;

      const { store, conn } = makeStore();
      stores.push(store);
      store.getSnapshot();
      const requestId = store.submitQuestion("answered promptly")!;
      expect(live.size).toBe(1);
      conn.pushOverviewFrame(answer(7, requestId, "Here you go."));
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  // ---- Scrollback ----------------------------------------------------

  /** A store holding posts 11..20 with older history behind them. */
  function paged(): { store: OverviewStore; conn: FakeConnection } {
    const made = makeStore();
    stores.push(made.store);
    made.store.getSnapshot();
    publishListOverviewPostsOk({
      posts: Array.from({ length: 10 }, (_, i) =>
        post(11 + i, `post ${11 + i}`),
      ) as unknown as OverviewPostWire[],
      has_more: true,
    });
    return made;
  }

  /** The `list_overview_posts` request bodies the store has sent. */
  function requests(conn: FakeConnection): Array<Record<string, unknown>> {
    return conn.frames
      .map(
        (f) =>
          JSON.parse(new TextDecoder().decode(f.payload)) as Record<
            string,
            unknown
          >,
      )
      .filter((body) => body.action === "list_overview_posts");
  }

  it("loadOlder asks for the page before the oldest post held", () => {
    const { store, conn } = paged();
    expect(store.getSnapshot().hasMore).toBe(true);
    store.loadOlder();
    const sent = requests(conn);
    expect(sent.length).toBe(2);
    expect(sent[1].before_id).toBe(11);
    expect(sent[1].limit).toBe(DEFAULT_OVERVIEW_CARD_ROWS);
    // And says so, so the card's scroll handler stops asking.
    expect(store.getSnapshot().loadingOlder).toBe(true);
  });

  it("a page prepends behind the same dedupe, oldest-first", () => {
    const { store } = paged();
    store.loadOlder();
    publishListOverviewPostsOk({
      posts: [
        // The seam row repeats what is already held — a page whose boundary
        // moved under it, which the dedupe absorbs rather than duplicating.
        post(9, "post 9"),
        post(10, "post 10"),
        post(11, "post 11"),
      ] as unknown as OverviewPostWire[],
      has_more: true,
      before_id: 11,
    });
    const snap = store.getSnapshot();
    expect(snap.posts.map((p) => p.body).slice(0, 3)).toEqual([
      "post 9",
      "post 10",
      "post 11",
    ]);
    expect(snap.posts.length).toBe(12);
    expect(snap.loadingOlder).toBe(false);
    expect(snap.hasMore).toBe(true);
  });

  it("a page whose before_id is not the one outstanding is dropped", () => {
    const { store } = paged();
    store.loadOlder();
    // Somebody else's page — the response bus is a broadcast, and applying
    // this one would prepend history the store never asked for.
    publishListOverviewPostsOk({
      posts: [post(500, "not mine")] as unknown as OverviewPostWire[],
      has_more: true,
      before_id: 999,
    });
    const snap = store.getSnapshot();
    expect(snap.posts.map((p) => p.body)).not.toContain("not mine");
    // And the real request is still outstanding, not cleared by the impostor.
    expect(snap.loadingOlder).toBe(true);
  });

  it("a tail supersedes a page in flight rather than stacking with it", () => {
    const { store } = paged();
    store.loadOlder();
    // A reconnect re-reads the tail while the page is out.
    publishListOverviewPostsOk({
      posts: [post(21, "post 21")] as unknown as OverviewPostWire[],
      has_more: true,
    });
    expect(store.getSnapshot().loadingOlder).toBe(false);
    // The page that arrives afterwards is now nobody's, and is dropped.
    publishListOverviewPostsOk({
      posts: [post(10, "post 10")] as unknown as OverviewPostWire[],
      has_more: true,
      before_id: 11,
    });
    expect(store.getSnapshot().posts.map((p) => p.body)).not.toContain(
      "post 10",
    );
  });

  it("loadOlder no-ops with nothing to ask for, and while one is in flight", () => {
    const { store, conn } = makeStore();
    stores.push(store);
    store.getSnapshot();
    // Still pending: nothing to anchor on.
    store.loadOlder();
    expect(requests(conn).length).toBe(1);

    publishListOverviewPostsOk({
      posts: [post(1, "only")] as unknown as OverviewPostWire[],
      has_more: false,
    });
    // Ready, but the ledger says this is the beginning.
    expect(store.getSnapshot().hasMore).toBe(false);
    store.loadOlder();
    expect(requests(conn).length).toBe(1);
  });

  it("a second loadOlder while one is out sends nothing", () => {
    const { store, conn } = paged();
    store.loadOlder();
    store.loadOlder();
    store.loadOlder();
    expect(requests(conn).length).toBe(2);
  });

  it("hasMore goes false at the beginning of history and stays there", () => {
    const { store } = paged();
    store.loadOlder();
    publishListOverviewPostsOk({
      posts: [post(10, "post 10")] as unknown as OverviewPostWire[],
      has_more: false,
      before_id: 11,
    });
    expect(store.getSnapshot().hasMore).toBe(false);
  });

  it("at the ceiling the store stops asking, and paging drops the newest", () => {
    const { store, conn } = paged();
    // Fill to the ceiling with one enormous page.
    store.loadOlder();
    publishListOverviewPostsOk({
      posts: Array.from({ length: OVERVIEW_MAX_ROWS }, (_, i) =>
        post(i + 1, `old ${i + 1}`),
      ) as unknown as OverviewPostWire[],
      has_more: true,
      before_id: 11,
    });
    const snap = store.getSnapshot();
    expect(snap.posts.length).toBe(OVERVIEW_MAX_ROWS);
    // Paging keeps what the reader is reading — the OLD end — and drops the
    // newest rows, the opposite of what following does.
    expect(snap.posts[0].body).toBe("old 1");
    expect(snap.posts[snap.posts.length - 1].body).toBe(
      `old ${OVERVIEW_MAX_ROWS}`,
    );
    // The ledger still holds more, but a page the store would only throw
    // away is a page it does not ask for.
    expect(snap.hasMore).toBe(false);
    const before = requests(conn).length;
    store.loadOlder();
    expect(requests(conn).length).toBe(before);
  });
});
