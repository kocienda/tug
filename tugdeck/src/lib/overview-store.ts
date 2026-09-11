/**
 * `OverviewStore` — app-scoped snapshot cache for the Overview narration channel.
 *
 * Hydrates from tugcast's `overview_posts` ledger on first observation (one
 * `list_overview_posts` CONTROL round-trip — the `digest-store` pattern), then
 * folds live `OVERVIEW` feed frames as the Observer, the Operator, and the user
 * speak. Both wires carry the same post shape, so one parse serves both and the
 * merge dedupes on ledger identity.
 *
 * **The write path** is one verb: {@link OverviewStore.submitQuestion} mints a
 * request id, sends it up `OVERVIEW_INPUT`, and holds a pending marker until the
 * Operator's post carrying that id lands — or until the wait times out, which
 * ends the wait with a locally-authored transient post rather than a spinner
 * nobody will ever take away.
 *
 * **Scrollback.** {@link OverviewStore.loadOlder} asks for the page immediately
 * older than the oldest post held (keyset by ledger rowid — posts keep
 * arriving while a reader pages backwards, and an offset would slide under
 * them). `card_rows` sizes the OPENING request rather than a render window,
 * and {@link OVERVIEW_MAX_ROWS} is what bounds the accumulated list.
 *
 * **Laws.** [L02] — wire frames, the CONTROL response, and the `card_rows`
 * tugbank default all enter React through {@link useOverview}'s
 * `useSyncExternalStore`; snapshots are referentially stable between folds.
 * [L26] — a post's `key` is its request id where it has one, so the pending
 * row and the answer that resolves it are the same row to React rather than a
 * teardown and a rebuild. [L27] — the three acquisitions this store makes (the
 * `OVERVIEW` frame registration, the DEFAULTS-domain watch, and the pending
 * question's timeout) each hand back a release, all of which are held and
 * invoked by {@link OverviewStore.dispose}.
 */

import { useSyncExternalStore } from "react";

import type { TugConnection } from "@/connection";
import {
  FeedId,
  encodeOverviewInput,
  encodeListOverviewPosts,
  parseOverviewFrame,
  parseOverviewPost,
  type OverviewAttachmentWire,
  type OverviewAuthor,
  type OverviewInputAttachment,
  type OverviewRef,
  type OverviewPostWire,
  type ListOverviewPostsOk,
} from "@/protocol";
import { getTugbankClient } from "@/lib/tugbank-singleton";

/**
 * Tugbank default holding how much history the card OPENS WITH, in rows.
 *
 * Read as the `limit` on the mount-time tail request, not as a render window:
 * the card used to truncate its list to this number, and it no longer does,
 * because the reader can now page backwards past it. What bounds the list is
 * {@link OVERVIEW_MAX_ROWS}. The knob's name outlives the change, so its
 * meaning is stated here rather than inferred from it.
 */
export const OVERVIEW_DOMAIN = "dev.tugapp.overview";
export const OVERVIEW_CARD_ROWS_KEY = "card_rows";

/** Mirror of tugcast's tail length — the opening request when the knob is unset. */
export const DEFAULT_OVERVIEW_CARD_ROWS = 50;

/**
 * The ceiling on the accumulated list.
 *
 * Paging with no bound would make the Overview an unbounded column of live
 * markdown blocks, each with its own annotation subscriptions and portal
 * hosts, under a memo that walks every post on every change — the shape the
 * transcript has a whole DOM-eviction project for. The Overview must not
 * acquire that problem while importing none of the remedy, so the walk stops
 * here: ten times the default opening tail.
 *
 * Reaching it ends paging. A reader 500 posts deep wants search, not another
 * page, and the card says nothing about it.
 */
export const OVERVIEW_MAX_ROWS = 500;

/** How close to the top starts loading older history, in px. */
export const LOAD_OLDER_PX = 200;

/** One displayable post. `key` is stable identity for React and for dedupe. */
export interface OverviewPostEntry {
  key: string;
  /** Ledger rowid; null on a transient post, which is never persisted. */
  id: number | null;
  atMs: number;
  author: OverviewAuthor;
  sessionId: string | null;
  wakeReason: string | null;
  body: string;
  refs: readonly OverviewRef[];
  /** How long the agent turn that wrote this post took, or null when nobody
   *  clocked it (a user question; a row older than the column). */
  elapsedMs: number | null;
  /** The root the post's refs resolve against, or null when tugcast recorded
   *  none — those refs render inert rather than against a guessed root. */
  projectDir: string | null;
  /** Images the user attached to this question, in composition order. Empty
   *  on every post nobody attached anything to. */
  attachments: readonly OverviewAttachmentWire[];
  requestId: string | null;
  transient: boolean;
}

export interface OverviewSnapshot {
  /** Ledger-tail load state; live folds work in any state. */
  status: "idle" | "pending" | "ready";
  /** The channel, oldest-first, capped at {@link OVERVIEW_MAX_ROWS}. */
  posts: readonly OverviewPostEntry[];
  /** The live `card_rows` default — how much history the card opened with. */
  cardRows: number;
  /**
   * Whether the ledger holds history older than the oldest post here. False
   * once the walk reaches the beginning, and also once the list reaches
   * {@link OVERVIEW_MAX_ROWS} — a page the store would only throw away is a
   * page it does not ask for.
   */
  hasMore: boolean;
  /** Whether a page request is in flight; the card's guard against firing
   *  another on every scroll event while the first is out. */
  loadingOlder: boolean;
  /**
   * The request id of a question awaiting its answer, or null. One at a time:
   * the composer is a single field and a second question while the first is
   * in flight would give the reader two spinners and one answer.
   */
  pendingRequestId: string | null;
}

/**
 * How long a question waits before the card stops promising an answer.
 *
 * Generous on purpose: `operator-answer`'s own ceiling is two minutes and a
 * two-round exchange can spend most of it, so a tighter wait here would call a
 * working pipeline dead. What this bounds is the case tugcast cannot report —
 * a dropped connection, a crashed server — where nothing will ever arrive to
 * clear the row.
 */
export const PENDING_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The newest **Observer** post about `sessionId` — rung (1) of the masthead's
 * ladder ([D187]), and the heading the beat history groups under ([B08]).
 *
 * The mirror of `digest-store.ts`'s `latestLineForScope`, and a selector rather
 * than a wire change: `OverviewPostEntry.sessionId` has always been there.
 *
 * The author filter is the whole of it. The channel also carries the user's
 * own questions, the Operator's answers and the tripwire's notices, and none
 * of those is an account of what the session is doing — a masthead that showed
 * the reader their own question back would be saying less than the blank it
 * replaced. An app-wide post (`sessionId` null) is never returned either: this
 * line is about ONE session, and ambience is not.
 */
export function latestPostForSession(
  posts: readonly OverviewPostEntry[],
  sessionId: string,
): OverviewPostEntry | null {
  if (sessionId.length === 0) return null;
  for (let i = posts.length - 1; i >= 0; i--) {
    const post = posts[i];
    if (post.author !== "observer") continue;
    if (post.sessionId !== sessionId) continue;
    return post;
  }
  return null;
}

const EMPTY_POSTS: readonly OverviewPostEntry[] = Object.freeze([]);
const IDLE_SNAPSHOT: OverviewSnapshot = Object.freeze({
  status: "idle" as const,
  posts: EMPTY_POSTS,
  cardRows: DEFAULT_OVERVIEW_CARD_ROWS,
  hasMore: false,
  loadingOlder: false,
  pendingRequestId: null,
});

// ---------------------------------------------------------------------------
// CONTROL response bus — action-dispatch publishes, the store consumes.
// ---------------------------------------------------------------------------

type OkListener = (payload: ListOverviewPostsOk) => void;
const okListeners = new Set<OkListener>();

/** Called by `action-dispatch.ts` when `list_overview_posts_ok` lands. */
export function publishListOverviewPostsOk(payload: ListOverviewPostsOk): void {
  for (const listener of [...okListeners]) listener(payload);
}

function subscribeToListOverviewPostsOk(listener: OkListener): () => void {
  okListeners.add(listener);
  return () => okListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class OverviewStore {
  private readonly conn: TugConnection;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private snapshot: OverviewSnapshot = IDLE_SNAPSHOT;
  private tailRequested = false;
  /** Distinguishes transient posts, which carry no ledger id to dedupe on. */
  private transientSeq = 0;
  /**
   * The pending question's timer. [L27]: an acquisition, released here on the
   * answer, on the timeout, and in {@link dispose} — the third of this store's
   * three, and the only one whose lifetime is shorter than the store's.
   */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The `before_id` of the page this store is waiting on, or null. The whole
   * of the response correlation — see {@link onTail} for why one field is
   * enough and why it is needed at all.
   */
  private pendingBefore: number | null = null;
  /** Whether the ledger reported history older than what is held. */
  private hasMore = false;

  constructor(conn: TugConnection) {
    this.conn = conn;
    // Live posts fold as they are written — including while the tail load is
    // still in flight; the merge dedupes on ledger identity.
    this.disposers.push(
      this.conn.onFrame(FeedId.OVERVIEW, (payload) => this._onOverview(payload)),
    );
    this.disposers.push(
      subscribeToListOverviewPostsOk((payload) => this.onTail(payload)),
    );
    const client = getTugbankClient();
    if (client) {
      this.disposers.push(
        client.onDomainChanged((domain) => {
          if (domain !== OVERVIEW_DOMAIN) return;
          this.commit(
            this.snapshot.posts,
            this.snapshot.status,
            this.snapshot.pendingRequestId,
          );
        }),
      );
    }
  }

  dispose(): void {
    this.clearPendingTimer();
    for (const fn of this.disposers) fn();
    this.disposers.length = 0;
    this.listeners.clear();
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer === null) return;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }

  /**
   * Ask the Operator a question.
   *
   * Returns the request id, or null when there is nothing to ask or a question
   * is already in flight. Nothing is added to the transcript here: the user's
   * post comes back off the wire, persisted, exactly as every other post does
   * ([P08]) — so what the reader sees is the channel's own record rather than
   * an optimistic echo that might not match it. That includes the pictures:
   * the bytes go up once, tugcast rests them beside the ledger, and the post
   * that comes back says where they are.
   *
   * A picture with no words is a question — "what is this?" is what the
   * screenshot is for — so an empty body is only nothing to ask when nothing
   * was attached either.
   *
   * `refs` are the files the asker pointed at with an `@` atom. They travel
   * beside the body rather than instead of it: the atom already flattened into
   * the sentence, and this is the same claim in a shape the pipeline can
   * verify against the tree before the first verb runs. A ref that does not
   * resolve is dropped server-side, which costs nothing, because the path is
   * still in the words.
   */
  submitQuestion(
    body: string,
    attachments: readonly OverviewInputAttachment[] = [],
    refs: readonly OverviewRef[] = [],
  ): string | null {
    const question = body.trim();
    if (question === "" && attachments.length === 0) return null;
    if (this.snapshot.pendingRequestId !== null) return null;

    const requestId = mintRequestId();
    const frame = encodeOverviewInput(question, requestId, attachments, refs);
    this.conn.send(frame.feedId, frame.payload);

    this.clearPendingTimer();
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      if (this.snapshot.pendingRequestId !== requestId) return;
      // Nothing is coming. Say so in the channel rather than leaving the row
      // pending forever — a transient post, so it is never history.
      this.fold([
        this.entry({
          at_ms: Date.now(),
          author: "operator",
          body: "No answer came back — the connection or the server dropped it.",
          refs: [],
          request_id: requestId,
          transient: true,
        }),
      ]);
    }, PENDING_QUESTION_TIMEOUT_MS);

    this.commit(this.snapshot.posts, this.snapshot.status, requestId);
    return requestId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Current snapshot. The first call kicks the one-shot ledger-tail CONTROL
   * request; live folds keep working regardless of its fate.
   */
  getSnapshot = (): OverviewSnapshot => {
    if (!this.tailRequested) {
      this.tailRequested = true;
      const cardRows = readCardRows();
      this.snapshot = Object.freeze({
        ...this.snapshot,
        status: "pending" as const,
        cardRows,
      });
      // `card_rows` sizes the OPENING request now — how much history the card
      // opens with, rather than how many rows it will ever show.
      const frame = encodeListOverviewPosts({ limit: cardRows });
      this.conn.send(frame.feedId, frame.payload);
    }
    return this.snapshot;
  };

  /**
   * One OVERVIEW frame off the wire.
   *
   * Named rather than inlined at the subscription so the app-test surface can
   * reach it with bytes the wire would otherwise have supplied
   * ({@link _ingestOverviewFrameForTest}) — the parse and the fold are then
   * exactly the production ones.
   */
  private _onOverview(payload: Uint8Array): void {
    const post = parseOverviewFrame(payload);
    if (post === null) return;
    this.fold([this.entry(post)]);
  }

  /**
   * A `list_overview_posts_ok` response — a tail or a page, told apart by the
   * echoed `before_id`.
   *
   * The response is a CONTROL **broadcast**, not a reply: every subscriber
   * sees every response, and nothing on the wire says whose request it
   * answers. That cost nothing while the only read was the tail, which is
   * idempotent — applied twice it replaced the list with itself. A page is
   * not: applied twice it prepends twice. So a page is honored only when its
   * echoed `before_id` is the one this store has outstanding, and any other is
   * dropped. One field, one comparison, and a stale page crossing a
   * reconnect-driven tail becomes a no-op instead of a double prepend.
   */
  private onTail(payload: ListOverviewPostsOk): void {
    const incoming: OverviewPostEntry[] = [];
    for (const raw of payload.posts) {
      const post = parseOverviewPost(raw);
      if (post === null) continue;
      incoming.push(this.entry(post));
    }
    const beforeId = payload.before_id;
    if (beforeId !== undefined) {
      // Somebody else's page, or one this store gave up on.
      if (beforeId !== this.pendingBefore) return;
      this.pendingBefore = null;
      this.hasMore = payload.has_more ?? false;
      // Older history goes in FRONT, behind the same dedupe the tail uses.
      this.commit(
        dedupe([...incoming, ...this.snapshot.posts]),
        "ready",
        this.snapshot.pendingRequestId,
        // Paging: the reader is at the top, so the ceiling drops from the
        // bottom.
        { keepOldest: true },
      );
      return;
    }

    // A tail supersedes any page in flight — it is a fresh view of the
    // channel's newest end, and a page prepended onto it would be history the
    // reader never scrolled to.
    this.pendingBefore = null;
    this.hasMore = payload.has_more ?? false;
    // Tail (history) first, then any live posts that landed while the load was
    // in flight. Dedupe on ledger id where there is one and on key otherwise:
    // the ledger does not persist a request id, so the same post arrives keyed
    // one way live and another way from the tail, and only its rowid is the
    // same on both wires.
    this.commit(
      dedupe([...incoming, ...this.snapshot.posts]),
      "ready",
      this.snapshot.pendingRequestId,
    );
  }

  private entry(post: OverviewPostWire): OverviewPostEntry {
    const id = post.id ?? null;
    // [L26]: a post answering a question is keyed by that question's request
    // id, so the pending row and the answer that replaces it are one row to
    // React. The author rides the key because the question and its answer
    // share the request id and are two rows, not one. Everything else keys by
    // ledger identity; a transient post with no correlation at all gets a
    // local identity that can never collide with a persisted one.
    const requestId = post.request_id ?? null;
    const key =
      requestId !== null
        ? `req:${post.author}:${requestId}`
        : id !== null
          ? `id:${id}`
          : `t:${++this.transientSeq}`;
    return Object.freeze({
      key,
      id,
      atMs: post.at_ms,
      author: post.author,
      sessionId: post.session_id ?? null,
      wakeReason: post.wake_reason ?? null,
      body: post.body,
      refs: Object.freeze([...post.refs]) as readonly OverviewRef[],
      elapsedMs: post.elapsed_ms ?? null,
      projectDir: post.project_dir ?? null,
      attachments: Object.freeze([
        ...(post.attachments ?? []),
      ]) as readonly OverviewAttachmentWire[],
      requestId: post.request_id ?? null,
      transient: post.transient,
    });
  }

  private fold(incoming: OverviewPostEntry[]): void {
    const seenKeys = new Set(this.snapshot.posts.map((p) => p.key));
    const seenIds = new Set(
      this.snapshot.posts.flatMap((p) => (p.id !== null ? [p.id] : [])),
    );
    const fresh = incoming.filter(
      (p) =>
        !seenKeys.has(p.key) && !(p.id !== null && seenIds.has(p.id)),
    );
    // An Operator post carrying the pending request id is the answer that was
    // being waited on — whether it is the answer, or the transient post that
    // says there won't be one. Either way the wait is over.
    const pending = this.snapshot.pendingRequestId;
    const resolved =
      pending !== null &&
      fresh.some((p) => p.author === "operator" && p.requestId === pending);
    if (resolved) this.clearPendingTimer();
    if (fresh.length === 0) return;
    this.commit(
      [...this.snapshot.posts, ...fresh],
      this.snapshot.status,
      resolved ? null : pending,
    );
  }

  private commit(
    posts: readonly OverviewPostEntry[],
    status: OverviewSnapshot["status"],
    pendingRequestId: string | null,
    opts?: { keepOldest?: boolean },
  ): void {
    // The ceiling drops from whichever end the reader is NOT at. Following the
    // bottom, the oldest rows go, exactly as they always did; paging backwards,
    // the newest go, because those are the ones the reader has scrolled away
    // from and the page just arrived is what they are reading.
    const capped =
      posts.length > OVERVIEW_MAX_ROWS
        ? opts?.keepOldest === true
          ? posts.slice(0, OVERVIEW_MAX_ROWS)
          : posts.slice(-OVERVIEW_MAX_ROWS)
        : posts;
    this.snapshot = Object.freeze({
      status,
      posts: Object.freeze([...capped]) as readonly OverviewPostEntry[],
      cardRows: readCardRows(),
      // A list at the ceiling stops asking, whatever the ledger still holds.
      hasMore: this.hasMore && capped.length < OVERVIEW_MAX_ROWS,
      loadingOlder: this.pendingBefore !== null,
      pendingRequestId,
    });
    this.tick();
  }

  /**
   * Ask for the page immediately older than the oldest post held.
   *
   * A no-op unless there is history to ask for, a post to anchor on, and no
   * request already out — the card fires this from a scroll handler, which
   * runs many times per gesture.
   */
  loadOlder(): void {
    const snap = this.snapshot;
    if (snap.status !== "ready" || !snap.hasMore) return;
    if (this.pendingBefore !== null) return;
    if (snap.posts.length >= OVERVIEW_MAX_ROWS) return;
    const oldest = snap.posts.find((p) => p.id !== null);
    if (oldest === undefined || oldest.id === null) return;
    this.pendingBefore = oldest.id;
    const frame = encodeListOverviewPosts({
      beforeId: oldest.id,
      limit: snap.cardRows,
    });
    this.conn.send(frame.feedId, frame.payload);
    this.commit(snap.posts, snap.status, snap.pendingRequestId);
  }

  private tick(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * `posts` with every duplicate after the first dropped, order preserved.
 *
 * Two identities, because a post can arrive under either: its `key`, and its
 * ledger `id`. The ledger does not persist a request id, so an Operator answer
 * arrives keyed by that id live and by its rowid from history — and only the
 * rowid is the same on both wires.
 */
function dedupe(posts: readonly OverviewPostEntry[]): OverviewPostEntry[] {
  const keys = new Set<string>();
  const ids = new Set<number>();
  const out: OverviewPostEntry[] = [];
  for (const post of posts) {
    if (keys.has(post.key)) continue;
    if (post.id !== null && ids.has(post.id)) continue;
    keys.add(post.key);
    if (post.id !== null) ids.add(post.id);
    out.push(post);
  }
  return out;
}

/**
 * A correlation id for one question. `randomUUID` where the runtime has it;
 * the fallback exists because the API is secure-context-only and the id needs
 * to be unique within one card's session, not globally unguessable.
 */
function mintRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string") return uuid;
  return `gz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The `card_rows` tugbank default; absent or nonsense reads as the mirror. */
function readCardRows(): number {
  const client = getTugbankClient();
  if (!client) return DEFAULT_OVERVIEW_CARD_ROWS;
  const entry = client.get(OVERVIEW_DOMAIN, OVERVIEW_CARD_ROWS_KEY);
  const value = entry?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_OVERVIEW_CARD_ROWS;
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Singleton + hook
// ---------------------------------------------------------------------------

let _activeStore: OverviewStore | null = null;

export function attachOverviewStore(conn: TugConnection): OverviewStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new OverviewStore(conn);
  return _activeStore;
}

export function getOverviewStore(): OverviewStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetOverviewStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/**
 * Test-only: feed a OVERVIEW frame body as if it arrived over the wire.
 *
 * Not a mock — the bytes go through the production `parseOverviewFrame` and the
 * production fold, so what the card sees is what the wire would have produced.
 * The parse rejects a malformed body silently, so a caller must assert on
 * rendered output rather than on having called this.
 */
export function _ingestOverviewFrameForTest(body: unknown): void {
  if (_activeStore === null) return;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  // Reach the private handler through the same path onFrame would.
  (
    _activeStore as unknown as { _onOverview(p: Uint8Array): void }
  )._onOverview(bytes);
}

/**
 * Test-only: deliver a `list_overview_posts_ok` body through the production
 * response bus, arming the page correlation first when the body is a page.
 *
 * Not a mock — {@link publishListOverviewPostsOk} is the same function
 * `action-dispatch` calls with a wire response, so the branch, the dedupe, the
 * prepend, and the ceiling are all production.
 *
 * The arming is the one thing a test cannot get for free. A page is honored
 * only when its echoed `before_id` matches an outstanding request, which is
 * the whole defense against a broadcast page prepending twice — so a page
 * published out of nowhere is correctly dropped. Calling the real
 * {@link OverviewStore.loadOlder} instead would put a request on the wire and
 * race tugcast's own answer for it. This arms exactly what `loadOlder` arms,
 * and leaves the correlation logic itself to the store's unit tests.
 */
export function _ingestOverviewPageForTest(payload: ListOverviewPostsOk): void {
  const store = _activeStore;
  if (store === null) return;
  if (payload.before_id !== undefined) {
    (store as unknown as { pendingBefore: number | null }).pendingBefore =
      payload.before_id;
  }
  publishListOverviewPostsOk(payload);
}

/**
 * React hook: the app-wide Overview snapshot. Returns the idle snapshot when no
 * store is attached (gallery / fixtures).
 */
export function useOverview(): OverviewSnapshot {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.getSnapshot() ?? IDLE_SNAPSHOT,
    () => IDLE_SNAPSHOT,
  );
}
