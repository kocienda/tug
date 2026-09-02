/**
 * WebSocket connection management for tugcast
 *
 * Handles WebSocket lifecycle, binary frame dispatch, heartbeat,
 * and reconnection with exponential backoff.
 */

import {
  FeedId,
  FeedIdValue,
  Frame,
  FrameFlags,
  HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  decodeFrame,
  encodeFrame,
  controlFrame,
} from "./protocol";
import type { ConnectionLifecycle } from "./lib/connection-lifecycle";
import { hostInfoStore, parseHandshakeHost } from "./lib/host-info-store";
import { tugDevLogStore } from "./lib/tug-dev-log-store/tug-dev-log-store";

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

/** Protocol name for handshake */
const PROTOCOL_NAME = "tugcast";

/** Protocol version for handshake */
const PROTOCOL_VERSION = 1;

/** Heartbeat interval in milliseconds (15 seconds) */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long the wire may be silent *from the server's side* before this
 * client stops believing in it and starts probing.
 *
 * This threshold and the server's `HEARTBEAT_TIMEOUT` in
 * `tugcast/src/router.rs` measure opposite directions and are
 * **independent** — an earlier comment here instructed the reader to
 * move them in lockstep, which recorded a coincidence of numbers as if
 * it were a dependency. This one measures server→client silence; the
 * server's measures client→server silence. Raising this one alongside
 * the server's would only slow down detection of a genuinely dead
 * server (the tugcast-restart case) in exchange for nothing.
 *
 * The server emits a HEARTBEAT every 15 s, so 45 s is three missed
 * heartbeats. Crossing it no longer force-closes on the spot — see
 * `WATCHDOG_GRACE_MS` and `startWatchdog`.
 */
const HEARTBEAT_TIMEOUT_MS = 45_000;

/**
 * How long the watchdog waits for an answer after it probes a silent
 * wire, before concluding the wire is dead.
 *
 * A bare force-close at `HEARTBEAT_TIMEOUT_MS` is wrong now that the
 * server tolerates 180 s of quiet: a one-minute sleep would wake into
 * a client that instantly tears down a wire the server still considers
 * perfectly alive, and that self-inflicted close costs a full
 * dispose-and-restore of every card. Proving the wire before
 * condemning it keeps fast detection of a truly dead server (45 s +
 * 10 s) without manufacturing closes out of mere quiet.
 */
const WATCHDOG_GRACE_MS = 10_000;

/**
 * Cadence at which the watchdog checks `Date.now() - lastFrameAt`.
 * Small enough to detect a stalled wire within ~5 s of the threshold,
 * large enough to absorb the natural jitter between heartbeat arrivals
 * and the timer firing.
 */
const WATCHDOG_TICK_MS = 5_000;

/** Connection state */
const ConnectionState = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  RECONNECTING: "reconnecting",
} as const;

type ConnectionStateValue = (typeof ConnectionState)[keyof typeof ConnectionState];

/** Initial retry delay (2 seconds) */
const INITIAL_RETRY_DELAY_MS = 2000;

/** Maximum retry delay (30 seconds) */
const MAX_RETRY_DELAY_MS = 30000;

/**
 * WebSocket connection for tugcast protocol
 *
 * Manages the WebSocket connection, frame encoding/decoding,
 * dispatches frames to registered callbacks by feed ID,
 * and handles automatic reconnection with exponential backoff.
 */
export class TugConnection {
  private ws: WebSocket | null = null;

  /**
   * Inbound byte buffer for binary frames. The tugcast → tugdeck WS
   * path runs through Vite's `/ws` proxy (`http-proxy` under the
   * hood), which does NOT preserve WebSocket message boundaries
   * end-to-end for large messages: a single `Message::Binary` from
   * tugcast can arrive at the browser as multiple `ws.onmessage`
   * events (split), and back-to-back small frames can arrive
   * coalesced into one (merged). The browser's WS contract atomizes
   * per-frame on its end, but the proxy hands it bytes in chunks the
   * proxy itself decided on.
   *
   * The robust fix is byte-level reassembly here: accumulate every
   * inbound `ArrayBuffer` into a buffer, then peel off as many
   * complete protocol frames as the buffer currently contains
   * (header + length). One framing layer drives the reads; the WS
   * message boundary is treated as an opaque chunk boundary. This
   * is the same pattern tugcast's stdin parser uses on the Rust
   * side (`BufReader::lines`) and the same pattern any TCP-style
   * stream consumer uses.
   *
   * Defensive against:
   *  - One big frame split across N ws.onmessage events (Vite's
   *    proxy fragmenting a large payload — surfaced as "Unexpected
   *    identifier" + base64-looking JSON parse errors when the
   *    second chunk's bytes get treated as a new frame's header).
   *  - Multiple small frames coalesced into one ws.onmessage (loses
   *    every frame after the first under the old "one decode per
   *    message" handler).
   *  - The handshake phase: a binary frame arriving before the
   *    handshake text reply (race-tolerant — the handshake branch
   *    leaves this buffer untouched).
   *
   * Reset on `onclose` so a reconnect starts with an empty buffer.
   */
  private rxBuffer: Uint8Array = new Uint8Array(0);
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
   * Deliberately **not** cleared on `onclose`, for the same reason it never
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
   * Deliberately **not** cleared on `onclose`. This is a per-tab fact about
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
  private heartbeatTimer: number | null = null;
  private url: string;
  private handshakePending: boolean = false;

  /**
   * Timestamp of the most recent frame received over the WebSocket
   * (any frame, including the binary HEARTBEAT echo). Updated on every
   * post-handshake `onmessage`. The watchdog reads this to decide
   * whether the wire has gone quiet for longer than the server's own
   * `HEARTBEAT_TIMEOUT`. Initialized lazily when the handshake
   * completes; pre-handshake quiet does not feed the watchdog.
   */
  private lastFrameAt: number = 0;

  /**
   * Handle for the `setInterval` that drives the heartbeat watchdog.
   * Lives parallel to `heartbeatTimer` so the watchdog and the
   * outbound heartbeat can be reasoned about independently.
   */
  private watchdogTimer: number | null = null;

  /**
   * When the watchdog last probed a silent wire, or `null` when no
   * probe is outstanding. Paired with `graceOpenedAtFrame` so a tick
   * can tell "a frame arrived since the probe" from "the tick just
   * came round again".
   */
  private graceOpenedAt: number | null = null;

  /**
   * The `lastFrameAt` value at the moment the grace window opened.
   * The wire is declared healthy when `lastFrameAt` advances past it.
   */
  private graceOpenedAtFrame: number = 0;

  /**
   * Registered `visibilitychange` listener, held so it can be removed
   * with the heartbeat timers it lives alongside ([L27] — every armed
   * listener has a release).
   */
  private visibilityListener: (() => void) | null = null;

  // Reconnection state
  private state: ConnectionStateValue = ConnectionState.DISCONNECTED;
  private retryDelay: number = INITIAL_RETRY_DELAY_MS;
  private retryTimer: number | null = null;
  private countdownTimer: number | null = null;
  private countdownSeconds: number = 0;
  private intentionalClose: boolean = false;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;

  /**
   * True while a close initiated by the heartbeat watchdog is in
   * flight. Read by `onclose` so the close-cause record can tell a
   * wire this client condemned from one the server hung up on, and
   * cleared there. Without it the two are indistinguishable after the
   * fact, which is the ambiguity that made the last transport-close
   * investigation start from zero.
   */
  private watchdogForcedClose: boolean = false;

  /**
   * Connection-lifecycle event pipe. Attached at construction by
   * `main.tsx` (production) or by tests that need to observe
   * lifecycle events. `TugConnection` only fires `notify*` calls; it
   * does not subscribe — consumers do that via `lifecycle.observe*`.
   * See `lib/connection-lifecycle.ts` for the event semantics.
   */
  private lifecycle: ConnectionLifecycle | null = null;

  constructor(url: string) {
    this.url = url;
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
   * Connect to the WebSocket server
   *
   * Sets up event handlers and starts heartbeat.
   */
  connect(): void {
    // `close()` latches this to true and nothing else ever lowers it.
    // Left latched, the very next unexpected close returns early from
    // `onclose` and never schedules a reconnect — a permanently dead
    // transport with no banner and no retry. The intent belongs to one
    // close, not to the instance, so it is cleared on every connect.
    this.intentionalClose = false;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("tugdeck: WebSocket transport open, sending handshake");
      // Send protocol handshake as a text frame
      this.handshakePending = true;
      this.lifecycle?.notifyConnectionWillOpen();
      this.ws!.send(JSON.stringify({
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
      }));
    };

    this.ws.onmessage = (event: MessageEvent) => {
      // During handshake: expect a text frame response from the server
      if (this.handshakePending) {
        if (typeof event.data === "string") {
          try {
            const response = JSON.parse(event.data);
            if (response.protocol !== PROTOCOL_NAME) {
              console.error("tugdeck: handshake failed: unknown protocol", response.protocol);
              this.ws?.close();
              return;
            }
            if (response.version !== PROTOCOL_VERSION) {
              console.error("tugdeck: handshake failed: version mismatch", response.version);
              this.ws?.close();
              return;
            }
            console.log("tugdeck: handshake complete (v" + response.version + ")");
            // Publish the host OS identity from the drop, before any card, so
            // the minimum-macOS version gate can derive from it ([P06], [L02]).
            // Re-runs on reconnect; an absent host leaves any prior value.
            hostInfoStore.publish(parseHandshakeHost(response));
            this.handshakePending = false;
            // Now transition to connected
            this.state = ConnectionState.CONNECTED;
            this.retryDelay = INITIAL_RETRY_DELAY_MS;
            this.clearCountdownTimer();
            this.notifyDisconnectState(false);
            // Seed the watchdog clock with the moment the wire became
            // live. Without this, the very first watchdog tick after a
            // long handshake-pending period would see `lastFrameAt = 0`
            // and force-close immediately.
            this.lastFrameAt = Date.now();
            this.startHeartbeat();
            // Re-establish this socket's subscription: the accumulated set,
            // widened by whatever is live right now. Both halves matter.
            // Nothing re-registers on reconnect — `callbacks` survives the
            // close untouched, so no `onFrame` will run — which is why the
            // recompute alone cannot be the answer: it would carry only the
            // cards still mounted, and a feed whose card has closed since
            // would silently fall out of the subscription. And the
            // accumulated set alone cannot be either, since a registration
            // made while the wire was down never reached the server.
            //
            // Unconditional, because a fresh socket knows nothing regardless
            // of whether the set differs from the last one's.
            this.flushSubscription(true);
            // The lifecycle is the sole event surface for open/close
            // transitions; it internally fires `connectionDidReconnect`
            // after `connectionDidOpen` if a prior close was observed.
            this.lifecycle?.notifyConnectionDidOpen();
          } catch {
            console.error("tugdeck: handshake failed: invalid JSON");
            this.ws?.close();
          }
        } else {
          console.error("tugdeck: handshake failed: expected text frame, got binary");
          this.ws?.close();
        }
        return;
      }

      // Any post-handshake message — including the binary HEARTBEAT
      // echo — is evidence the wire is alive. Bump the watchdog clock
      // unconditionally before the decode so a malformed frame still
      // resets the stall timer (the server reached us; the bytes
      // arriving garbled is a separate problem).
      this.lastFrameAt = Date.now();

      // Normal mode: binary frames. Accumulate bytes into `rxBuffer`
      // and peel complete frames; see the `rxBuffer` docstring for
      // why a stream-style reassembler is required even though
      // WebSocket is in principle message-framed.
      if (event.data instanceof ArrayBuffer) {
        this.absorbBytes(new Uint8Array(event.data));
        this.drainFrames();
      }
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.recordCloseCause(event);
      this.stopHeartbeat();

      // Drop the snapshot-replay cache before anything else reacts to
      // the close. `lastPayload` exists to replay the most recent frame
      // on each feed to a late `onFrame` subscriber; once the wire is
      // down, every cached entry is stale relative to the post-reconnect
      // server view. A subscriber that registers in response to
      // `connectionDidClose` (or to the disconnect-state notification
      // raised by `scheduleReconnect`) must not observe pre-close
      // frames, since the post-reconnect handshake will replay
      // whatever is current. See [D05].
      this.lastPayload.clear();
      this.lastPayloadByType.clear();
      // `subscribedFeeds` and `sentFeeds` both survive the close on purpose —
      // see their docstrings. Only the coalescing flag is per-socket: a
      // microtask queued against the dead socket must not be taken for one
      // queued against the next.
      this.subscriptionSyncPending = false;
      // Reset the inbound reassembly buffer — any partial frame held
      // across the close belongs to the prior connection and must
      // not bleed into post-reconnect parsing.
      this.rxBuffer = new Uint8Array(0);

      // Store close info for banner display
      this.lastCloseCode = event.code;
      this.lastCloseReason = event.reason || null;

      // The lifecycle is the sole event surface for close
      // notifications. Subscribers that gate on `getState()` see
      // "closed" by the time their close handler runs.
      this.lifecycle?.notifyConnectionDidClose();

      // Don't reconnect if close was intentional
      if (this.intentionalClose) {
        return;
      }

      // Transition to disconnected and schedule reconnection
      this.state = ConnectionState.DISCONNECTED;
      this.scheduleReconnect();

      // Double the retry delay for next attempt (capped at max)
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
    };

    this.ws.onerror = (event: Event) => {
      console.error("tugdeck: WebSocket error", event);
      // The close event always follows an error, so reconnection is handled there
    };
  }

  /**
   * Emit a structured record of why the wire ended, into the dev log
   * (`tugDevLogStore`, readable from the in-app Log tab and from
   * `window.tugDevLog.getSnapshot()`).
   *
   * The fields are chosen to make the next incident answerable without
   * a fresh investigation:
   *
   *  - `staleMs` — how long the wire had been silent. This is the one
   *    number that separates "the page was suspended and woke into a
   *    dead socket" from "the server hung up on a live page".
   *  - `visibility` — whether the document was hidden at the moment of
   *    the close, which corroborates the suspension reading.
   *  - `watchdogForced` — whether this client condemned the wire or
   *    the other end did.
   *  - `intentional` — whether `close()` asked for it, in which case
   *    no reconnect follows and that is correct.
   *
   * Runs before `stopHeartbeat` so `lastFrameAt` still describes the
   * connection that just died.
   */
  private recordCloseCause(event: CloseEvent): void {
    const staleMs = this.lastFrameAt === 0 ? null : Date.now() - this.lastFrameAt;
    tugDevLogStore.warn("connection", "WebSocket closed", {
      code: event.code,
      reason: event.reason || null,
      watchdogForced: this.watchdogForcedClose,
      intentional: this.intentionalClose,
      staleMs,
      visibility:
        typeof document === "undefined" ? null : document.visibilityState,
      handshakePending: this.handshakePending,
    });
    this.watchdogForcedClose = false;
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    // Clear any existing retry timer
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // Calculate countdown seconds
    this.countdownSeconds = Math.ceil(this.retryDelay / 1000);

    // Notify React components of disconnected state
    this.notifyDisconnectState(false);
    this.lifecycle?.notifyConnectionDidEnterReconnecting();

    // Start countdown timer (updates every second)
    this.countdownTimer = window.setInterval(() => {
      this.tickCountdown();
    }, 1000);

    // Schedule reconnection attempt
    this.retryTimer = window.setTimeout(() => {
      this.reconnect();
    }, this.retryDelay);
  }

  /**
   * Attempt to reconnect
   */
  private reconnect(): void {
    this.clearCountdownTimer();

    this.state = ConnectionState.RECONNECTING;
    this.notifyDisconnectState(true);

    console.log("tugdeck: attempting reconnection");
    this.connect();
  }

  /**
   * Notify disconnect state callbacks with the current state.
   * @param reconnecting true when actively attempting to reconnect
   */
  private notifyDisconnectState(reconnecting: boolean): void {
    const disconnected = this.state !== ConnectionState.CONNECTED;
    const state: DisconnectState = {
      disconnected,
      countdown: this.countdownSeconds,
      reason: this.lastCloseReason && this.lastCloseReason.trim() !== "" ? this.lastCloseReason : null,
      reconnecting,
    };
    for (const cb of this.disconnectStateCallbacks) {
      try { cb(state); } catch (e) { console.error("disconnectStateCallback error:", e); }
    }
  }

  /**
   * Tick the countdown by 1 second and notify listeners.
   */
  private tickCountdown(): void {
    this.countdownSeconds = Math.max(0, this.countdownSeconds - 1);
    this.notifyDisconnectState(false);

    if (this.countdownSeconds === 0 && this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /**
   * Clear the countdown interval timer.
   */
  private clearCountdownTimer(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /**
   * Send a frame to the server, reporting whether it went out.
   *
   * A socket that is not OPEN drops the frame — there is no outbound queue,
   * so a caller that needs its frame to arrive must learn that it did not.
   * {@link send} is the fire-and-forget wrapper for callers that genuinely
   * do not care (heartbeats, best-effort telemetry); anything whose answer
   * the UI depends on — a ledger restore fetch, say — calls this and retries.
   *
   * The drop is logged at `debug` for every feed but HEARTBEAT, whose
   * per-interval drops during a reconnect are the expected case and would
   * bury everything else.
   */
  trySend(
    feedId: FeedIdValue,
    payload: Uint8Array,
    flags: number = FrameFlags.DATA,
  ): boolean {
    // CONTROL and HEARTBEAT are exempt from the server's filter, so
    // recording them would buy nothing — and CONTROL in particular would
    // recurse, since the `subscribe_feeds` frame below is itself a CONTROL
    // write.
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
      // rest are covered by the set membership above.
      this.flushSubscription(false);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const frame: Frame = { feedId, flags, payload };
      this.ws.send(encodeFrame(frame));
      return true;
    }
    if (feedId !== FeedId.HEARTBEAT) {
      tugDevLogStore.debug("connection", "frame dropped; socket not open", {
        feedId,
        readyState: this.ws?.readyState ?? null,
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
      this.flushSubscription(false);
    });
  }

  /**
   * Fold the current union into the accumulated set and, if that changed
   * anything, tell the server.
   *
   * `force` re-sends even when nothing grew, which is what the
   * post-handshake path needs: a fresh socket knows nothing, so the set has
   * to be re-established whether or not it differs from what the previous
   * socket carried.
   */
  private flushSubscription(force: boolean): void {
    const union = this.computeFeedUnion();
    let grew = false;
    for (const feedId of union) {
      if (!this.subscribedFeeds.has(feedId)) {
        this.subscribedFeeds.add(feedId);
        grew = true;
      }
    }
    if (!grew && !force) return;
    if (this.state !== ConnectionState.CONNECTED) return;
    // Sorted so the wire is deterministic and a packet capture reads in
    // feed order.
    const feeds = [...this.subscribedFeeds].sort((a, b) => a - b);
    this.trySendControlFrame("subscribe_feeds", { feeds });
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
  sendControlFrame(action: string, params?: Record<string, unknown>): void {
    const frame = controlFrame(action, params);
    this.send(frame.feedId, frame.payload);
  }

  /**
   * Send a control frame, reporting whether it reached an OPEN socket. The
   * {@link trySend} of {@link sendControlFrame} — for writes whose caller
   * retries rather than shrugs.
   */
  trySendControlFrame(action: string, params?: Record<string, unknown>): boolean {
    const frame = controlFrame(action, params);
    return this.trySend(frame.feedId, frame.payload);
  }

  /**
   * Register a callback for disconnect state changes.
   * Called when the connection disconnects, the countdown ticks, or reconnection is attempted.
   * Returns a cleanup function to unregister.
   */
  onDisconnectState(callback: DisconnectStateCallback): () => void {
    this.disconnectStateCallbacks.push(callback);
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
   * Cancel any pending reconnection timer and attempt to connect immediately.
   * Called after silent re-authentication when tugcast restarts, so the
   * WebSocket reconnects without waiting for the backoff timer.
   */
  forceReconnect(): void {
    // Only act if we're disconnected/reconnecting — don't disrupt a live connection.
    if (this.state === ConnectionState.CONNECTED) return;

    // Cancel pending timers
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearCountdownTimer();

    // Reset backoff so the next failure doesn't start from a high delay
    this.retryDelay = INITIAL_RETRY_DELAY_MS;

    // Connect now
    this.reconnect();
  }

  /**
   * Drop the wire the way the network would, for app-tests.
   *
   * Deliberately does NOT set the `intentionalClose` latch, so the
   * full lifecycle runs: `onclose` → `connectionDidClose` → backoff →
   * reconnect → `connectionDidReconnect` → `clearAll` → restore.
   *
   * Nothing else reaches that path from a test.
   * `_simulateTransportForTest` dispatches straight into a single
   * store's reducer and touches neither `ConnectionLifecycle` nor the
   * restore pass, so it can show a green result for a broken recovery;
   * and `forceReconnect()` early-returns while the state is
   * `CONNECTED`.
   *
   * @internal
   */
  _forceCloseForTest(): void {
    this.ws?.close();
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();

    // Clear reconnection timers
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearCountdownTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Append `bytes` to the inbound reassembly buffer. Allocates a
   * fresh Uint8Array (Uint8Array doesn't grow in place); the
   * `rxBuffer` reference is replaced so the next call sees the
   * concatenated view. Cheap in the typical case (small frame, no
   * carryover) — one ~few-KB copy per ws.onmessage.
   */
  private absorbBytes(bytes: Uint8Array): void {
    if (this.rxBuffer.length === 0) {
      // Fast path: empty buffer, just hold the incoming view.
      this.rxBuffer = bytes;
      return;
    }
    const next = new Uint8Array(this.rxBuffer.length + bytes.length);
    next.set(this.rxBuffer, 0);
    next.set(bytes, this.rxBuffer.length);
    this.rxBuffer = next;
  }

  /**
   * Peel complete frames from `rxBuffer` and dispatch them. Stops at
   * the first incomplete frame (header without enough payload, or
   * buffer shorter than the header). Survives partial-header arrivals
   * — `rxBuffer.length < HEADER_SIZE` exits the loop and the
   * remaining bytes wait for the next ws.onmessage to complete the
   * header.
   *
   * On a `PayloadTooLarge` (length field exceeds `MAX_PAYLOAD_SIZE`),
   * the frame is unrecoverable — the buffer is desynced from the
   * sender's frame stream. Log loudly and reset the buffer so the
   * next legitimate frame arrives clean; the lost frame counts as a
   * dropped wire event the same way a network packet drop would.
   */
  private drainFrames(): void {
    while (this.rxBuffer.length >= HEADER_SIZE) {
      // Read the length field (BE u32 at offset 2). Avoid the
      // `decodeFrame` helper because it allocates a Frame object even
      // when we just want to check if enough bytes are present.
      const view = new DataView(
        this.rxBuffer.buffer,
        this.rxBuffer.byteOffset,
        this.rxBuffer.byteLength,
      );
      const length = view.getUint32(2, false);
      if (length > MAX_PAYLOAD_SIZE) {
        console.error(
          `tugdeck: frame header reports oversized payload (${length} > ${MAX_PAYLOAD_SIZE}); resetting buffer`,
        );
        this.rxBuffer = new Uint8Array(0);
        return;
      }
      const frameSize = HEADER_SIZE + length;
      if (this.rxBuffer.length < frameSize) {
        // Wait for more bytes. The current rxBuffer holds a partial
        // frame — leave it intact for the next ws.onmessage.
        return;
      }
      // We have a complete frame. Slice it (copy) so the payload
      // outlives subsequent buffer reallocations, then advance the
      // buffer past the consumed bytes.
      const frameBytes = this.rxBuffer.slice(0, frameSize);
      this.rxBuffer = this.rxBuffer.slice(frameSize);
      // The frame's underlying ArrayBuffer is the slice's own (slice
      // copies), so decodeFrame's view is safe even after we mutate
      // rxBuffer above.
      try {
        const frame = decodeFrame(frameBytes.buffer);
        this.dispatch(frame.feedId, frame.payload);
      } catch (error) {
        console.error("tugdeck: failed to decode frame:", error);
      }
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
   * Start sending heartbeat frames periodically and arm the inbound
   * heartbeat watchdog. Both timers share a lifecycle: they start
   * together when the handshake completes and stop together on close.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      this.send(FeedId.HEARTBEAT, new Uint8Array(0));
    }, HEARTBEAT_INTERVAL_MS);
    this.startWatchdog();
    this.startVisibilityPulse();
  }

  /**
   * Stop the heartbeat and watchdog timers.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.stopWatchdog();
    this.stopVisibilityPulse();
  }

  /**
   * Send one heartbeat the moment the page becomes visible again.
   *
   * On wake from sleep the interval timer was frozen while the
   * server's clock kept running, so the next scheduled beat may not
   * arrive until after the server has already given up. This pulse
   * proves liveness at exactly the moment the server is closest to
   * hanging up, for the cost of one empty frame per wake.
   *
   * Registered alongside the heartbeat timers and released with them.
   */
  private startVisibilityPulse(): void {
    if (typeof document === "undefined" || this.visibilityListener !== null) {
      return;
    }
    const listener = (): void => {
      if (document.visibilityState !== "visible") return;
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.send(FeedId.HEARTBEAT, new Uint8Array(0));
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

  /**
   * Arm the heartbeat watchdog: prove the wire before condemning it.
   *
   * Every `WATCHDOG_TICK_MS` the watchdog is in one of two modes.
   *
   * **No probe outstanding.** If the wire has been quiet longer than
   * `HEARTBEAT_TIMEOUT_MS`, send a heartbeat and open a grace window
   * rather than closing. Quiet is not the same as dead, and the cost
   * of being wrong is a dispose-and-restore of every card.
   *
   * **Probe outstanding.** If `lastFrameAt` has advanced past the
   * value it held when the probe went out, the server answered — the
   * wire is healthy, close the grace window and re-arm. If
   * `WATCHDOG_GRACE_MS` has passed with no answer, the wire really is
   * dead: force-close, which routes into the normal reconnect path.
   */
  private startWatchdog(): void {
    this.watchdogTimer = window.setInterval(() => {
      const now = Date.now();

      if (this.graceOpenedAt === null) {
        if (now - this.lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
          this.graceOpenedAt = now;
          this.graceOpenedAtFrame = this.lastFrameAt;
          tugDevLogStore.warn(
            "connection",
            "heartbeat watchdog probing a silent wire",
            { staleMs: now - this.lastFrameAt, graceMs: WATCHDOG_GRACE_MS },
          );
          this.send(FeedId.HEARTBEAT, new Uint8Array(0));
        }
        return;
      }

      // A frame arrived since the probe went out — the wire answered.
      if (this.lastFrameAt > this.graceOpenedAtFrame) {
        tugDevLogStore.info(
          "connection",
          "heartbeat watchdog probe answered — wire is healthy",
          { answeredAfterMs: this.lastFrameAt - this.graceOpenedAt },
        );
        this.graceOpenedAt = null;
        return;
      }

      if (now - this.graceOpenedAt >= WATCHDOG_GRACE_MS) {
        this.graceOpenedAt = null;
        this.watchdogForcedClose = true;
        tugDevLogStore.warn(
          "connection",
          "heartbeat watchdog probe unanswered — force-closing dead wire",
          { staleMs: now - this.lastFrameAt, graceMs: WATCHDOG_GRACE_MS },
        );
        this.ws?.close();
      }
    }, WATCHDOG_TICK_MS);
  }

  /**
   * Disarm the watchdog. Called from `stopHeartbeat` on close so the
   * timer cannot fire against a connection that's already been torn
   * down.
   */
  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.graceOpenedAt = null;
  }
}
