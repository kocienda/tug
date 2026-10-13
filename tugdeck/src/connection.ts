/**
 * `TugConnection` — the page's connection to tugcast, as a facade over the
 * ingest host.
 *
 * The socket is not here. tugcast's WebSocket, its handshake, heartbeat,
 * watchdog, reconnect backoff and the framing live in `IngestHost`, which in
 * production runs in the dedicated ingest Worker and in unit tests runs on
 * the calling thread behind a channel that clones every message. What the
 * wire produced arrives here as batches of patches, each applied in one
 * task, and this class turns them back into the calls every store has always
 * received: `onFrame` callbacks, `onDisconnectState` callbacks, and the
 * `ConnectionLifecycle`'s events, in the order the page used to fire them.
 *
 * What stays here is what needs the page: the callbacks themselves, the
 * replay-on-subscribe caches, the accumulated feed subscription (computed
 * here and posted to the host whenever it grows), and the visibility
 * listener that drives the wire's wake pulse.
 *
 * Every session's engine runs in the same host ([P06]). A `CodeSessionStore`
 * opens its session here and becomes a mirror: the host reduces the
 * session's frames where they land and posts the result as session patches
 * inside the same batches, and this class hands each to the mirror its
 * handle names. A batch is applied whole and then each mirror it touched
 * publishes once, so with the host paced to the display period the page
 * does one task of ingest work per frame however many sessions stream.
 *
 * And it outlives a Worker that fails. A Worker that will not load, or whose
 * host throws, is reported by its channel; the connection closes the wire in
 * words ("ingest worker failed"), rebuilds the host on this thread, tells it
 * everything the old one was told — the subscription, the display period,
 * every open session — and reconnects. The fall-back is for the rest of the
 * page's life: a Worker that failed once is not trusted with the wire again.
 */

import type { ControlAction } from "@tugproto/control";
import { FeedId, FeedIdValue, FrameFlags, controlFrame } from "./protocol";
import type { ConnectionLifecycle } from "./lib/connection-lifecycle";
import { hostInfoStore, parseHandshakeHost } from "./lib/host-info-store";
import { tugDevLogStore } from "./lib/tug-dev-log-store/tug-dev-log-store";
import { logSessionLifecycle } from "./lib/session-lifecycle-log";
import { installDevLogSink } from "./lib/dev-log-port";
import { InProcessIngestChannel, WorkerIngestChannel, type IngestChannel } from "./lib/ingest/ingest-channel";
import { UNHELD_KINDS } from "./lib/ingest/ingest-host";
import { Pacer } from "./lib/ingest/pacer";
import {
  applySessionBatch,
  type PatchTarget,
  type SessionBatch,
  type SessionControl,
  type SessionPatchOf,
  type SessionPatchTarget,
} from "./lib/ingest/session-patch";
import {
  makeLink,
  mintSessionHandle,
  type SessionLink,
  type SessionLocalOptions,
  type SessionOpenOptions,
} from "./lib/ingest/session-link";
import { FALLBACK_FRAME_PERIOD_MS } from "./lib/frame-period";
import { gestureScope, type MotionGateChange } from "./lib/gesture-scope";
import { deckTrace } from "./deck-trace";

/** Callback for receiving frames from a specific feed */
export type FrameCallback = (payload: Uint8Array) => void;

/** State emitted to TugBannerProvider when connection status changes. */
export interface DisconnectState {
  /** true = disconnected/reconnecting, false = connected */
  disconnected: boolean;
  /** Seconds remaining until next reconnect attempt (0 when reconnecting) */
  countdown: number;
  /** Human-readable reason (close reason from server, if any) */
  reason: string | null;
  /** true = actively attempting reconnect, false = waiting for countdown */
  reconnecting: boolean;
}

/** Callback for disconnect state changes */
export type DisconnectStateCallback = (state: DisconnectState) => void;

/**
 * The always-on count of main-thread tasks that carry wire data: one per
 * batch message the host posts. It is the reading the
 * ingest Worker is measured against, so it is counted with no instrument
 * armed and read through `window.__tugIngest` by eval. `host` names the
 * thread that holds the socket; `since(mark)` is the count of tasks after an
 * earlier read of `tasks`.
 */
export interface IngestTaskCounter {
  host: "main" | "worker";
  tasks: number;
  since(mark: number): number;
}

declare global {
  interface Window {
    __tugIngest?: IngestTaskCounter;
  }
}

export const ingestTaskCounter: IngestTaskCounter = {
  host: "main",
  tasks: 0,
  since(mark: number): number {
    return this.tasks - mark;
  },
};

if (typeof window !== "undefined") window.__tugIngest = ingestTaskCounter;

/** The banner's reason when the ingest Worker failed and the host moved to the page. */
export const INGEST_WORKER_FAILED_REASON = "ingest worker failed";

/**
 * How long a disposed connection waits for its host to report the wire
 * closed before it terminates the host anyway. A terminated Worker's socket
 * is not reliably closed with it, so the close is let land first, bounded.
 */
export const DISPOSE_CLOSE_BUDGET_MS = 1000;

// Code that may run in the ingest host logs through the dev-log port. On the
// page, its entries go to the dev-log store, looked up at call time so a test
// that reassigns a level still sees the call.
installDevLogSink({
  log: (level, source, message, data) => tugDevLogStore[level](source, message, data),
});

/** Shared decoder for the multiplexed-feed `type` peek (UTF-8 JSON). */
const SIDEBAND_TYPE_DECODER = new TextDecoder();

/**
 * Build the replay-cache key for a multiplexed feed payload
 * (SESSION_SIDEBAND) without fully trusting it: the `type` discriminator
 * plus the `tug_session_id` the frame is tagged with. Keying by (session,
 * type) — not type alone — keeps concurrent sessions from evicting each
 * other's cached frames, so a late-binding card's replay-on-subscribe still
 * finds its OWN session's latest frame of each kind (the per-card FeedStore
 * filter drops the foreign ones it also receives). An untagged payload keys
 * by bare type. Returns `null` for a non-JSON / typeless payload (which
 * then falls back to the single-slot cache). Cheap enough for the
 * low-traffic sideband; never call it on a hot feed.
 */
function peekPayloadCacheKey(payload: Uint8Array): string | null {
  try {
    const value = JSON.parse(SIDEBAND_TYPE_DECODER.decode(payload)) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      const sessionId = (value as { tug_session_id?: unknown }).tug_session_id;
      const sessionKey = typeof sessionId === "string" ? sessionId : "";
      return `${sessionKey}\u0000${(value as { type: string }).type}`;
    }
  } catch {
    // Not JSON / not decodable — fall through to the single-slot cache.
  }
  return null;
}

/** Which thread holds the socket. */
export type IngestHostKind = "worker" | "in-process";

export interface TugConnectionOptions {
  /**
   * `"worker"` holds the socket in the dedicated ingest Worker (production);
   * `"in-process"` hosts the same `IngestHost` on this thread behind a
   * channel that clones every message, delivering synchronously (tests).
   */
  readonly host?: IngestHostKind;
  /** A channel to use instead of the one `host` names. */
  readonly channel?: IngestChannel;
  /** The motion gate the wire is held behind; the deck's gesture scope by default. */
  readonly motionGate?: MotionGateSource;
}

/** What the connection reads of a settle's motion gate ([P08]). */
export interface MotionGateSource {
  isMotionHeld(): boolean;
  observeMotionGate(listener: (change: MotionGateChange) => void): () => void;
}

/**
 * The page's connection to tugcast.
 *
 * Dispatches frames to registered callbacks by feed ID, keeps the
 * replay-on-subscribe caches and the feed subscription, and fires the
 * lifecycle's events as the ingest host reports the wire's.
 */
export class TugConnection {
  private channel: IngestChannel | null = null;
  private hostKind: IngestHostKind;
  private readonly injectedChannel: IngestChannel | null;
  /**
   * Set once a channel has failed: every channel from then on is an
   * in-process host, paced as the Worker's was.
   */
  private fellBack = false;
  /** Whether the wire is wanted: from `connect` until `close`. */
  private connectWanted = false;
  /** The display period last posted, which a rebuilt host starts at. */
  private periodMs: number = FALLBACK_FRAME_PERIOD_MS;
  /** What each open session's engine was opened with, so a rebuilt host can open it again. */
  private readonly sessionOpens = new Map<string, SessionOpenOptions>();
  /** Set by `dispose`: no channel is built after it, and nothing more is posted. */
  private disposed = false;
  /** A disposed connection's host, kept until it reports the wire closed or the budget passes. */
  private draining: { channel: IngestChannel; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly motionGate: MotionGateSource;
  /**
   * Batches that arrived while the motion gate was closed — posted before the
   * host heard of the hold — applied in arrival order when it opens.
   */
  private parked: SessionBatch[] = [];
  /**
   * Releases the motion gate observation, armed with the channel and on
   * every later `connect`, released by `close` ([L27]).
   */
  private releaseMotionGate: (() => void) | null = null;
  /** The cap of the gate's latest hold, for a test-surface re-hold of the host. */
  private heldCapMs = 0;

  private callbacks: Map<number, FrameCallback[]> = new Map();
  /**
   * The feed set this connection has told the server it wants, via
   * `subscribe_feeds`. Accumulated and **monotonic**: it never shrinks, for
   * the life of the tab.
   *
   * Monotonicity is what keeps `lastPayload`'s late-subscriber replay
   * working. `dispatch` caches a feed's most recent frame whether or not a
   * handler is registered, which is exactly how a store that mounts late
   * gets its first value; a union that shrank when the last handler
   * unregistered would stop those frames arriving and the cache would go
   * cold. Opting a feed out is a deliberate, named act for a later phase,
   * never an emergent effect of a component unmounting.
   *
   * Deliberately **not** cleared on close, for the same reason it never
   * shrinks on unregister. The server keeps no memory of a closed
   * connection, so the next socket is told the whole set again after its own
   * handshake — but the set it is told has to be the one this tab
   * accumulated rather than a fresh recompute. `callbacks` survives a close
   * with the unmounted cards' entries already spliced out, so recomputing
   * from scratch would quietly narrow the subscription across every
   * reconnect: a feed whose card was open before the close and has closed
   * since would fall out of it, `lastPayload` having been cleared by the
   * same handler. A stream feed dropped that way has nothing to re-deliver
   * it — the server's latest-value pass covers snapshot feeds only — so the
   * card would mount blank on its next open and stay blank until the
   * producer spoke again.
   *
   * The ingest host holds the copy it sends: this class posts the set
   * whenever it grows, and the host sends it on every handshake and on
   * growth while the wire is live.
   */
  private subscribedFeeds: Set<number> = new Set();
  /**
   * Every feed id this deck has ever written on, minus the exempt planes.
   *
   * These belong in the subscription because the router addresses input
   * rejections — `input_claimed`, `session_not_owned`,
   * `missing_tug_session_id` — to the *input feed's own id* rather than to
   * CONTROL, so they follow that feed's subscription. `filetree-store.ts`
   * writes FILETREE_QUERY but reads only FILETREE, so without this it
   * would never hear its own rejection.
   *
   * Deliberately **not** cleared on close. This is a per-tab fact about
   * which feeds this deck writes on, not per-socket state, and dropping it
   * would take those feeds out of the post-handshake union and re-open that
   * window on every reconnect.
   */
  private sentFeeds: Set<number> = new Set();
  /** Whether a coalescing microtask is already queued. */
  private subscriptionSyncPending: boolean = false;
  private lastPayload: Map<number, Uint8Array> = new Map();
  // Replay-on-subscribe cache for feeds that MULTIPLEX several payload kinds
  // onto one feed id. `lastPayload` keeps a single frame per feed, so a later
  // frame of one kind evicts the cached frame of another — fine for the
  // single-kind feeds, but SESSION_SIDEBAND carries three independent kinds
  // (`system_metadata`, `session_capabilities`, `rate_limit`) that each own a
  // separate region of client state. With a single slot, a late subscriber
  // replays only whichever kind arrived last and silently loses the others
  // (e.g. the synth's active-model `system_metadata` shadowed by a later
  // `session_capabilities`, leaving the model — and the CONTEXT denominator —
  // unresolved). This second cache retains the last frame per (feed, session,
  // payload `type`) — session-qualified so concurrent sessions on the shared
  // broadcast cannot evict each other's frames before a late-binding card's
  // FeedStore subscribes (see `peekPayloadCacheKey`). Keyed feed id →
  // cache key → bytes.
  private lastPayloadByType: Map<number, Map<string, Uint8Array>> = new Map();
  private disconnectStateCallbacks: Array<DisconnectStateCallback> = [];

  /**
   * Whether the socket is OPEN, mirrored from the host's `wire-state`
   * patches: from `will-open` (the transport opened) to `closed`. `trySend`
   * answers from it, since a synchronous boolean cannot wait on a thread
   * hop. A frame the host then finds it cannot send — the socket closed in
   * the interval — is dropped and logged there, exactly as a closed-socket
   * drop always was, and every caller that retries on `false` also re-runs
   * on the reconnect the same close triggers.
   */
  private socketOpen: boolean = false;

  /**
   * The banner state the host last reported, so the connected state raised
   * at the handshake carries the same countdown and reason it always did.
   */
  private lastDisconnect: DisconnectState = { disconnected: true, countdown: 0, reason: null, reconnecting: false };

  /**
   * Registered `visibilitychange` listener, armed while the wire is live
   * and released with its close ([L27] — every armed listener has a
   * release). It posts the page's visibility to the host, whose wake pulse
   * sends one heartbeat when the page comes back.
   */
  private visibilityListener: (() => void) | null = null;

  /**
   * Connection-lifecycle event pipe. Attached at construction by
   * `main.tsx` (production) or by tests that need to observe
   * lifecycle events. `TugConnection` only fires `notify*` calls; it
   * does not subscribe — consumers do that via `lifecycle.observe*`.
   * See `lib/connection-lifecycle.ts` for the event semantics.
   */
  private lifecycle: ConnectionLifecycle | null = null;

  /** Every open session's mirror, by the handle its open minted ([P06]). */
  private readonly sessions = new Map<string, SessionPatchTarget>();

  /** Where a batch's patches go: this facade, and the mirrors it holds. */
  private readonly patchTarget: PatchTarget = {
    page: {
      frame: (patch) => this.dispatch(patch.payload.feedId, new Uint8Array(patch.payload.bytes)),
      wireState: (patch) => this.applyWireState(patch),
      disconnectState: (patch) => {
        this.lastDisconnect = patch.payload;
        this.notifyDisconnectState(patch.payload);
      },
      log: (patch) => {
        const entry = patch.payload;
        if ("level" in entry) tugDevLogStore[entry.level](entry.source, entry.message, entry.data);
        else logSessionLifecycle(entry.lifecycle.tag, entry.lifecycle.fields);
      },
    },
    session: (handle) => this.sessions.get(handle) ?? null,
  };

  constructor(
    private readonly url: string,
    options: TugConnectionOptions = {},
  ) {
    this.hostKind = options.host ?? "in-process";
    this.injectedChannel = options.channel ?? null;
    this.motionGate = options.motionGate ?? gestureScope;
  }

  /**
   * Attach a `ConnectionLifecycle` so this connection's WebSocket
   * transitions are observable through named lifecycle events. Idempotent
   * if called more than once with the same instance; the most recent
   * call wins. Pass `null` to detach (used by tests for clean teardown).
   *
   * Production wiring: `main.tsx` constructs `ConnectionLifecycle`,
   * attaches it here, and registers it as the module singleton via
   * `registerConnectionLifecycle` so non-React subscribers can find it.
   */
  setLifecycle(lifecycle: ConnectionLifecycle | null): void {
    this.lifecycle = lifecycle;
  }

  /**
   * The channel to the ingest host, built on first use. Its first message
   * is `init`, so every later control finds the host ready.
   */
  private ensureChannel(): IngestChannel {
    if (this.channel !== null) return this.channel;
    const channel = this.buildChannel();
    this.channel = channel;
    ingestTaskCounter.host = channel instanceof WorkerIngestChannel ? "worker" : "main";
    channel.setBatchListener((batch) => this.applyBatch(batch));
    channel.post({
      kind: "init",
      wsUrl: this.url,
      periodMs: this.periodMs,
    });
    // Last, and read back: a channel that had already failed reports it here,
    // and its replacement is the channel to use.
    channel.setFailureListener((detail) => this.hostFailed(channel, detail));
    return this.channel ?? channel;
  }

  /**
   * The channel to post on, built on first use — or `null` once the
   * connection is disposed, when there is nothing left to post to.
   */
  private liveChannel(): IngestChannel | null {
    return this.disposed ? null : this.ensureChannel();
  }

  /**
   * The channel `host` names, or the injected one — and, once a channel has
   * failed, a host on this thread. A Worker that cannot even be constructed
   * is a failure too, met the same way before anything was posted to it.
   */
  private buildChannel(): IngestChannel {
    if (this.fellBack) {
      return new InProcessIngestChannel({ makePolicy: (flush, periodMs) => new Pacer(flush, periodMs) });
    }
    if (this.injectedChannel !== null) return this.injectedChannel;
    if (this.hostKind !== "worker") return new InProcessIngestChannel();
    try {
      return new WorkerIngestChannel();
    } catch (err) {
      this.fallBack(`the ingest Worker could not be constructed: ${err instanceof Error ? err.message : String(err)}`);
      return this.buildChannel();
    }
  }

  /** From now on, the host runs on this thread; the dev log and the session lifecycle log say why. */
  private fallBack(detail: string): void {
    this.fellBack = true;
    this.hostKind = "in-process";
    tugDevLogStore.error(
      "connection",
      `${detail}; the ingest host now runs on the page for the rest of this page's life`,
      { detail },
    );
    logSessionLifecycle("connection.ingest_fallback", { detail, permanent: true });
  }

  /**
   * The channel's host failed. Replace it with one on this thread, told what
   * the old one was told; close the wire it held in words, so the banner names
   * the failure; and reconnect if the wire was wanted. Only the live channel's
   * failure counts: one already replaced has nothing left to report.
   */
  private hostFailed(failed: IngestChannel, detail: string): void {
    if (this.channel !== failed) return;
    failed.dispose();
    this.channel = null;
    this.fallBack(detail);
    const channel = this.ensureChannel();
    if (this.subscribedFeeds.size > 0) {
      channel.post({ kind: "subscribe", feeds: [...this.subscribedFeeds].sort((a, b) => a - b) });
    }
    // Open first, so what the stores do about the close below reaches engines
    // that exist. A reconnect rebuilds every card's store; until then each
    // mirror is answered by an engine of its own again.
    for (const [handle, open] of this.sessionOpens) {
      channel.post({ kind: "session-open", handle, ...open });
    }
    if (this.socketOpen) {
      this.applyWireState({
        kind: "wire-state",
        session: null,
        payload: { state: "closed", closeReason: INGEST_WORKER_FAILED_REASON },
      });
    }
    const failedState: DisconnectState = {
      disconnected: true,
      countdown: 0,
      reason: INGEST_WORKER_FAILED_REASON,
      reconnecting: this.connectWanted,
    };
    this.lastDisconnect = failedState;
    this.notifyDisconnectState(failedState);
    if (this.connectWanted) channel.post({ kind: "connect" });
  }

  /**
   * The wire is held where it is produced: every hold the gate takes, and
   * its release, go to the host, which posts nothing in between ([P08]).
   * Observed while the connection is wanted, from `connect` to `close`, and
   * posted to whichever host holds the wire.
   */
  private observeMotionGate(): void {
    if (this.releaseMotionGate !== null) return;
    this.releaseMotionGate = this.motionGate.observeMotionGate((change) => {
      if (change.held) this.heldCapMs = change.capMs;
      this.channel?.post(
        change.held ? { kind: "motion", held: true, capMs: change.capMs } : { kind: "motion", held: false },
      );
      if (!change.held) this.applyParked();
    });
  }

  /**
   * Connect to the WebSocket server
   *
   * The host opens the socket and reports its lifecycle back as patches.
   */
  connect(): void {
    const channel = this.liveChannel();
    if (channel === null) return;
    this.connectWanted = true;
    this.observeMotionGate();
    channel.post({ kind: "connect" });
  }

  /**
   * Apply one batch from the host, in order, in this task; then each mirror
   * it touched publishes once. A session patch whose handle has no live
   * mirror is dropped. A batch that arrives inside a closed motion gate was
   * posted before the host heard of the hold; it waits for the gate's open.
   * A batch of the wire's state alone is the host posting through the hold,
   * and applies at once: the open-socket mirror and the banner never wait on
   * motion, whatever order that puts them in against the parked frames.
   */
  private applyBatch(batch: SessionBatch): void {
    ingestTaskCounter.tasks += 1;
    if (this.disposed) {
      // Nothing reaches the page after a dispose; the host is only watched
      // for the close that lets it go.
      if (batch.entries.some((p) => p.kind === "wire-state" && p.payload.state === "closed")) this.releaseDrained();
      return;
    }
    if (
      this.releaseMotionGate !== null &&
      this.motionGate.isMotionHeld() &&
      !batch.entries.every((p) => UNHELD_KINDS.has(p.kind))
    ) {
      this.parked.push(batch);
      return;
    }
    this.applyNow(batch);
  }

  /**
   * Let the wire through a closed motion gate once, with the page's gate left
   * closed; returns how many parked batches applied. Test-surface only: the
   * host holds what it produces for the gate's length and the page parks
   * what was already in flight, so no session data reaches a store
   * mid-motion. This asks the host to post what it holds and to hold again,
   * and applies what the page has parked so far — the host's batch arrives
   * on a later task, parked, for the next call — so a test of what a surface
   * does with data that changed mid-motion can fail.
   */
  deliverHeldWire(): number {
    if (this.motionGate.isMotionHeld() && this.channel !== null) {
      this.channel.post({ kind: "motion", held: false });
      this.channel.post({ kind: "motion", held: true, capMs: this.heldCapMs });
    }
    const count = this.parked.length;
    this.applyParked();
    return count;
  }

  /** The gate opened: apply what it parked, in arrival order. */
  private applyParked(): void {
    const parked = this.parked;
    this.parked = [];
    for (const batch of parked) this.applyNow(batch, true);
  }

  private applyNow(batch: SessionBatch, parked = false): void {
    deckTrace.record({ kind: "ingest-batch", patches: batch.entries.length, parked });
    applySessionBatch(batch.entries, this.patchTarget);
  }

  /** The socket's lifecycle, in the order the page always fired it. */
  private applyWireState(patch: SessionPatchOf<"wire-state">): void {
    const { state } = patch.payload;
    switch (state) {
      case "will-open":
        this.socketOpen = true;
        this.lifecycle?.notifyConnectionWillOpen();
        return;
      case "open": {
        this.socketOpen = true;
        // Publish the host OS identity from the drop, before any card, so
        // the minimum-macOS version gate can derive from it ([P06], [L02]).
        // Re-runs on reconnect; an absent host leaves any prior value.
        if (patch.payload.handshake !== undefined) {
          hostInfoStore.publish(parseHandshakeHost(patch.payload.handshake));
        }
        const connected: DisconnectState = { ...this.lastDisconnect, disconnected: false, reconnecting: false };
        this.lastDisconnect = connected;
        this.notifyDisconnectState(connected);
        this.startVisibilityPulse();
        // The host re-sent the accumulated set after its handshake; fold in
        // anything registered since the last post, which goes out now.
        this.flushSubscription();
        // The lifecycle is the sole event surface for open/close
        // transitions; it internally fires `connectionDidReconnect`
        // after `connectionDidOpen` if a prior close was observed.
        this.lifecycle?.notifyConnectionDidOpen();
        return;
      }
      case "closed":
        this.socketOpen = false;
        this.stopVisibilityPulse();
        // Drop the snapshot-replay cache before anything else reacts to
        // the close. `lastPayload` exists to replay the most recent frame
        // on each feed to a late `onFrame` subscriber; once the wire is
        // down, every cached entry is stale relative to the post-reconnect
        // server view. A subscriber that registers in response to
        // `connectionDidClose` (or to the disconnect-state notification
        // raised by the reconnect schedule) must not observe pre-close
        // frames, since the post-reconnect handshake will replay
        // whatever is current. See [D05].
        this.lastPayload.clear();
        this.lastPayloadByType.clear();
        // `subscribedFeeds` and `sentFeeds` both survive the close on purpose —
        // see their docstrings. Only the coalescing flag is per-socket: a
        // microtask queued against the dead socket must not be taken for one
        // queued against the next.
        this.subscriptionSyncPending = false;
        if (patch.payload.closeReason !== undefined) {
          this.lastDisconnect = { ...this.lastDisconnect, reason: patch.payload.closeReason };
        }
        // The lifecycle is the sole event surface for close
        // notifications. Subscribers that gate on `getState()` see
        // "closed" by the time their close handler runs.
        this.lifecycle?.notifyConnectionDidClose();
        return;
      case "reconnecting":
        this.lifecycle?.notifyConnectionDidEnterReconnecting();
        return;
    }
  }

  /** Call every disconnect-state callback with `state`. */
  private notifyDisconnectState(state: DisconnectState): void {
    for (const cb of this.disconnectStateCallbacks) {
      try { cb(state); } catch (e) { console.error("disconnectStateCallback error:", e); }
    }
  }

  /**
   * Send a frame to the server, reporting whether it went out.
   *
   * A socket that is not OPEN drops the frame — there is no outbound queue,
   * so a caller that needs its frame to arrive must learn that it did not.
   * {@link send} is the fire-and-forget wrapper for callers that genuinely
   * do not care (best-effort telemetry); anything whose answer the UI
   * depends on — a ledger restore fetch, say — calls this and retries.
   *
   * The answer comes from this page's mirror of the socket state (see
   * `socketOpen`), and a refusal is logged at `warn` for every feed but
   * HEARTBEAT, whose refusals during a reconnect are the expected case and
   * would bury everything else. A frame the mirror let through after the
   * wire closed is refused by the host, which says so the same way.
   */
  trySend(
    feedId: FeedIdValue,
    payload: Uint8Array,
    flags: number = FrameFlags.DATA,
  ): boolean {
    // CONTROL and HEARTBEAT are exempt from the server's filter, so
    // recording them would buy nothing — and CONTROL in particular would
    // recurse, since the `subscribe_feeds` frame is itself a CONTROL write.
    if (
      feedId !== FeedId.CONTROL &&
      feedId !== FeedId.HEARTBEAT &&
      !this.sentFeeds.has(feedId)
    ) {
      this.sentFeeds.add(feedId);
      // Synchronously, and before the payload goes out. The router answers
      // an input frame's rejection on that frame's own feed id inside the
      // same receive turn that read it, so a subscription deferred to the
      // coalescing microtask arrives after the rejection has already been
      // dropped at the gate. Only the first write on a feed pays this; the
      // rest are covered by the set membership above. The host handles
      // controls in order, so the subscription reaches the socket first.
      this.flushSubscription();
    }
    if (this.socketOpen) {
      const bytes = payload.slice().buffer;
      this.liveChannel()?.post({ kind: "send", feedId, flags, bytes }, [bytes]);
      return true;
    }
    if (feedId !== FeedId.HEARTBEAT) {
      tugDevLogStore.warn("connection", "a frame was refused: the socket is not open", {
        feedId,
        bytes: payload.byteLength,
      });
    }
    return false;
  }

  /**
   * The feeds this connection should be subscribed to right now: every feed
   * with at least one live callback, plus every feed it has written on.
   *
   * Non-empty arrays rather than map keys: `onFrame`'s unsubscribe splices
   * the callback out of its array but never deletes the key, so a key set
   * alone over-reports.
   */
  private computeFeedUnion(): Set<number> {
    const union = new Set<number>(this.sentFeeds);
    for (const [feedId, list] of this.callbacks) {
      if (list.length > 0) union.add(feedId);
    }
    return union;
  }

  /**
   * Coalesce a subscription recompute onto a microtask, so a burst of stores
   * registering in one tick sends one frame rather than one frame each.
   *
   * Coalescing is for registrations, which have no deadline. Writes do have
   * one and take the synchronous path in {@link trySend} instead.
   */
  private scheduleSubscriptionSync(): void {
    if (this.subscriptionSyncPending) return;
    this.subscriptionSyncPending = true;
    queueMicrotask(() => {
      this.subscriptionSyncPending = false;
      this.flushSubscription();
    });
  }

  /**
   * Fold the current union into the accumulated set and, if that changed
   * anything, post it to the host — which sends it now if the wire is live,
   * and on the next handshake otherwise.
   */
  private flushSubscription(): void {
    const union = this.computeFeedUnion();
    let grew = false;
    for (const feedId of union) {
      if (!this.subscribedFeeds.has(feedId)) {
        this.subscribedFeeds.add(feedId);
        grew = true;
      }
    }
    if (!grew) return;
    // Sorted so the wire is deterministic and a packet capture reads in
    // feed order.
    const feeds = [...this.subscribedFeeds].sort((a, b) => a - b);
    this.liveChannel()?.post({ kind: "subscribe", feeds });
  }

  /**
   * Send a frame to the server, ignoring whether it went out. See
   * {@link trySend} when the answer matters.
   */
  send(feedId: FeedIdValue, payload: Uint8Array, flags: number = FrameFlags.DATA): void {
    this.trySend(feedId, payload, flags);
  }

  /**
   * Send a control frame with the given action
   */
  sendControlFrame(action: ControlAction, params?: Record<string, unknown>): void {
    const frame = controlFrame(action, params);
    this.send(frame.feedId, frame.payload);
  }

  /**
   * Send a control frame, reporting whether it reached an OPEN socket. The
   * {@link trySend} of {@link sendControlFrame} — for writes whose caller
   * retries rather than shrugs.
   */
  trySendControlFrame(action: ControlAction, params?: Record<string, unknown>): boolean {
    const frame = controlFrame(action, params);
    return this.trySend(frame.feedId, frame.payload);
  }

  /**
   * Register a callback for disconnect state changes.
   * Called when the connection disconnects, the countdown ticks, or reconnection is attempted.
   * A callback registered while the connection stands disconnected — before
   * its first open, or with a host that never answered — is told so at once,
   * so a wire that never comes up is a visible disconnect rather than a quiet one.
   * Returns a cleanup function to unregister.
   */
  onDisconnectState(callback: DisconnectStateCallback): () => void {
    this.disconnectStateCallbacks.push(callback);
    if (this.lastDisconnect.disconnected) {
      try { callback(this.lastDisconnect); } catch (e) { console.error("disconnectStateCallback error:", e); }
    }
    return () => {
      const idx = this.disconnectStateCallbacks.indexOf(callback);
      if (idx >= 0) this.disconnectStateCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a callback for frames from a specific feed. Returns a
   * cleanup function that unregisters the callback — callers whose
   * lifetime is shorter than the connection's (per-card stores, etc.)
   * MUST call it on teardown or they leak: the callback closure pins the
   * subscriber for the life of the connection.
   *
   * Multiple callbacks can be registered for the same feed ID.
   */
  onFrame(feedId: number, callback: FrameCallback): () => void {
    if (!this.callbacks.has(feedId)) {
      this.callbacks.set(feedId, []);
    }
    const list = this.callbacks.get(feedId)!;
    list.push(callback);
    // The feed is now live for this connection. Coalesced, so a tick that
    // mounts a dozen stores sends one frame.
    this.scheduleSubscriptionSync();
    const unsubscribe = (): void => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
      // The set is monotonic, so this can only ever be a no-op on the wire.
      // It runs anyway so the recompute has one entry point rather than two
      // rules about when it is worth doing.
      this.scheduleSubscriptionSync();
    };
    // Replay cached payload for late subscribers (e.g. cards mounted after
    // the initial snapshot was sent). This ensures snapshot feeds deliver
    // their current value to newly registered callbacks.
    //
    // For a multiplexed feed (SESSION_SIDEBAND), replay the last frame of
    // EVERY (session, kind) so a late subscriber reconstructs the active
    // model (`system_metadata`), the model list (`session_capabilities`),
    // and the quota (`rate_limit`) independently — never just whichever
    // arrived last. Foreign-session frames in the replay are dropped by the
    // subscriber's own per-card filter ([D06]/[D11]); the account-global
    // rate-limit store wants every session's frames and takes them all.
    // Single-kind feeds keep the single-slot replay.
    const byType = this.lastPayloadByType.get(feedId);
    if (byType !== undefined) {
      for (const cached of byType.values()) {
        callback(cached);
      }
      return unsubscribe;
    }
    const cached = this.lastPayload.get(feedId);
    if (cached) {
      callback(cached);
    }
    return unsubscribe;
  }

  /**
   * Open a session's engine for a `CodeSessionStore`, in this connection's
   * host — the ingest Worker in production — which routes the session's
   * frames to it, writes its frames on the wire, and posts its patches in
   * the batches this class applies. Its patches reach `target` until the
   * link closes; closing the link closes the engine ([L27]).
   *
   * Local options are test seams — functions, which cannot cross to the
   * host — and a connection refuses them rather than quietly hosting the
   * session on this thread: a test that needs them opens on a test frame
   * source. The page hosts sessions itself only after a Worker failure, and
   * then through the same host this method addresses.
   */
  openSession(open: SessionOpenOptions, target: SessionPatchTarget, local?: SessionLocalOptions): SessionLink {
    if (local?.timerSource !== undefined || local?.makePolicy !== undefined) {
      throw new Error("TugConnection.openSession: local options are test seams; open on a test frame source");
    }
    const handle = mintSessionHandle(open.tugSessionId);
    this.sessions.set(handle, target);
    this.sessionOpens.set(handle, open);
    this.liveChannel()?.post({ kind: "session-open", handle, ...open });
    // Every control goes to the host that holds the wire now, which after a
    // Worker failure is not the one the session opened in. The close posts
    // while the mirror is still registered, so what the engine posts as it
    // closes — a fold it flushes — reaches the mirror when the host is on
    // this thread; from the Worker it arrives after the handle is gone and is
    // dropped, as anything after a close is.
    return makeLink(
      handle,
      (control) => this.channel?.post(control),
      () => {
        this.sessions.delete(handle);
        this.sessionOpens.delete(handle);
      },
    );
  }

  /**
   * Tell the host the display's period, which it paces its batches to. The
   * host starts at the 60 Hz fallback; the settle engine posts the period its
   * frame sampler learned when it differs from the last one posted ([P07]).
   * Nothing to tell before the channel exists.
   */
  setDisplayPeriod(periodMs: number): void {
    this.periodMs = periodMs;
    this.channel?.post({ kind: "display-period", periodMs });
  }

  /**
   * Cancel any pending reconnection timer and attempt to connect immediately.
   * Called after silent re-authentication when tugcast restarts, so the
   * WebSocket reconnects without waiting for the backoff timer. The host
   * ignores it while the wire is live.
   */
  forceReconnect(): void {
    this.liveChannel()?.post({ kind: "force-reconnect" });
  }

  /**
   * Drop the wire the way the network would, for app-tests.
   *
   * Deliberately does NOT set the intentional-close latch, so the
   * full lifecycle runs: close → `connectionDidClose` → backoff →
   * reconnect → `connectionDidReconnect` → `clearAll` → restore.
   *
   * Nothing else reaches that path from a test.
   * `_simulateTransportForTest` dispatches straight into a single
   * store's reducer and touches neither `ConnectionLifecycle` nor the
   * restore pass, so it can show a green result for a broken recovery;
   * and `forceReconnect()` is ignored while the wire is live.
   *
   * @internal
   */
  _forceCloseForTest(): void {
    this.liveChannel()?.post({ kind: "force-close-for-test" });
  }

  /**
   * Make the host throw on a control: a subscription with no feed list,
   * which no page code can post. In the Worker that is the uncaught throw
   * the failure story answers — reported, fallen back from, reconnected.
   *
   * @internal
   */
  _failIngestHostForTest(): void {
    this.channel?.post({ kind: "subscribe", feeds: null } as unknown as SessionControl);
  }

  /**
   * Close the WebSocket connection. No reconnect follows. A connection that
   * never built a channel has no wire to close, and does not build one to
   * close it.
   */
  close(): void {
    this.connectWanted = false;
    this.stopVisibilityPulse();
    this.releaseGate();
    this.channel?.post({ kind: "close" });
  }

  /**
   * Release everything this connection holds ([L27]): the motion gate's
   * observation and the visibility listener, the wire, and the ingest host
   * itself — the Worker is terminated, once it has closed the wire or
   * {@link DISPOSE_CLOSE_BUDGET_MS} has passed. Nothing reaches the page,
   * and nothing is posted or built, after it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.connectWanted = false;
    this.stopVisibilityPulse();
    this.releaseGate();
    const channel = this.channel;
    const wasOpen = this.socketOpen;
    this.channel = null;
    this.disposed = true;
    this.socketOpen = false;
    if (channel === null) return;
    channel.post({ kind: "close" });
    if (!wasOpen) {
      channel.dispose();
      return;
    }
    this.draining = { channel, timer: setTimeout(() => this.releaseDrained(), DISPOSE_CLOSE_BUDGET_MS) };
  }

  /** Terminate a disposed connection's host. */
  private releaseDrained(): void {
    const draining = this.draining;
    if (draining === null) return;
    this.draining = null;
    clearTimeout(draining.timer);
    draining.channel.dispose();
  }

  /** Stop observing the motion gate, letting the wire go and applying what it parked. */
  private releaseGate(): void {
    if (this.releaseMotionGate !== null) {
      // Unobserved, the gate's release would never reach the host or the
      // parked batches, so the wire is let go here instead.
      this.releaseMotionGate();
      this.releaseMotionGate = null;
      this.channel?.post({ kind: "motion", held: false });
      this.applyParked();
    }
  }

  /**
   * Dispatch a frame to registered callbacks
   */
  private dispatch(feedId: number, payload: Uint8Array): void {
    // Cache latest payload so late subscribers get the current value.
    this.lastPayload.set(feedId, payload);
    // SESSION_SIDEBAND multiplexes three payload kinds onto one feed; retain
    // the last frame of EACH kind so the replay-on-subscribe path delivers all
    // of them to a late-binding card (see `lastPayloadByType`). Cheap: the
    // sideband is low-traffic, so the per-frame JSON peek runs only here.
    if (feedId === FeedId.SESSION_SIDEBAND) {
      const key = peekPayloadCacheKey(payload);
      if (key !== null) {
        let byType = this.lastPayloadByType.get(feedId);
        if (byType === undefined) {
          byType = new Map();
          this.lastPayloadByType.set(feedId, byType);
        }
        byType.set(key, payload);
      }
    }
    const cbs = this.callbacks.get(feedId);
    if (cbs) {
      for (const cb of cbs) {
        cb(payload);
      }
    }
  }

  /**
   * Report the page's visibility to the host while the wire is live. On
   * wake from sleep the heartbeat interval was frozen while the server's
   * clock kept running, so the host sends one heartbeat the moment the
   * page becomes visible again.
   */
  private startVisibilityPulse(): void {
    if (typeof document === "undefined" || this.visibilityListener !== null) {
      return;
    }
    const listener = (): void => {
      this.channel?.post({ kind: "visibility", visible: document.visibilityState === "visible" });
    };
    this.visibilityListener = listener;
    document.addEventListener("visibilitychange", listener);
  }

  /** Release the visibility listener ([L27]). */
  private stopVisibilityPulse(): void {
    if (this.visibilityListener === null) return;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityListener);
    }
    this.visibilityListener = null;
  }
}
