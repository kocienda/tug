/**
 * `WireSocket` — tugcast's WebSocket, wherever the ingest host runs.
 *
 * It owns everything about the socket that the page used to own: the text
 * handshake, the outbound heartbeat, the inbound watchdog, the wake pulse,
 * the reconnect backoff with its per-second banner countdown, and the
 * per-close intentional latch. Its behaviour is the page's behaviour moved
 * here unchanged; what changed is where its answers go. Instead of calling
 * the lifecycle and the banner callbacks itself, it reports to its host —
 * `wire-state`, `disconnect-state`, and the raw bytes of each message — and
 * the host posts those to the page, which runs the same calls in the same
 * order.
 *
 * Timers come from an injectable table that defaults to whatever
 * `globalThis` holds at call time, so a test that swaps the globals still
 * drives this class. Logging goes through `dev-log-port`.
 */

import { FeedId, FrameFlags, controlFrame, encodeFrame } from "@/protocol";
import { devLog } from "@/lib/dev-log-port";
import type { IngestDisconnectState, IngestHandshake, IngestWireStatePatch } from "@tugproto/ingest";

/**
 * The page identity a hello carries, in tugcast's spelling. Absent, the hello
 * names no role and tugcast serves the connection as a tool.
 */
export interface WireHello {
  role: "shell" | "body" | "tool";
  page_id: string;
  card_id?: string;
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

/** Initial retry delay (2 seconds) */
const INITIAL_RETRY_DELAY_MS = 2000;

/** Maximum retry delay (30 seconds) */
const MAX_RETRY_DELAY_MS = 30000;

/** `WebSocket.OPEN`, without reading the class a test may have swapped. */
const READY_OPEN = 1;

/** Connection state */
const ConnectionState = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  RECONNECTING: "reconnecting",
} as const;

type ConnectionStateValue = (typeof ConnectionState)[keyof typeof ConnectionState];

/** The timer functions the socket arms. */
export interface WireTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

type AnyTimerFn = (...args: unknown[]) => unknown;

/** `globalThis`'s timers, looked up at call time. */
export const GLOBAL_TIMERS: WireTimers = {
  setTimeout: (cb, ms) => (globalThis.setTimeout as unknown as AnyTimerFn)(cb, ms),
  clearTimeout: (handle) => (globalThis.clearTimeout as unknown as AnyTimerFn)(handle),
  setInterval: (cb, ms) => (globalThis.setInterval as unknown as AnyTimerFn)(cb, ms),
  clearInterval: (handle) => (globalThis.clearInterval as unknown as AnyTimerFn)(handle),
};

/** What the socket reports to its host. */
export interface WireSocketOutput {
  wireState(payload: IngestWireStatePatch["payload"]): void;
  disconnectState(state: IngestDisconnectState): void;
  /** The bytes of one post-handshake binary message. */
  bytes(chunk: Uint8Array): void;
  /** The handshake completed; the host re-establishes the subscription now. */
  handshakeComplete(): void;
  /** One socket event or timer callback finished. */
  endOfEvent(): void;
}

/** The subset of a browser `WebSocket` this class touches. */
interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string | ArrayBufferLike): void;
  close(): void;
}

export class WireSocket {
  private ws: SocketLike | null = null;
  private handshakePending = false;
  private lastFrameAt = 0;
  private heartbeatTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private graceOpenedAt: number | null = null;
  private graceOpenedAtFrame = 0;
  private heartbeatArmed = false;
  private state: ConnectionStateValue = ConnectionState.DISCONNECTED;
  private retryDelay = INITIAL_RETRY_DELAY_MS;
  private retryTimer: unknown = null;
  private countdownTimer: unknown = null;
  private countdownSeconds = 0;
  private intentionalClose = false;
  private lastCloseReason: string | null = null;
  private watchdogForcedClose = false;
  /** The page's last reported visibility, for the close-cause record. */
  private visibility: string | null = null;

  constructor(
    private readonly url: string,
    private readonly out: WireSocketOutput,
    private readonly timers: WireTimers = GLOBAL_TIMERS,
    private readonly hello: WireHello | null = null,
  ) {}

  /** Whether the handshake has completed and the wire is live. */
  get connected(): boolean {
    return this.state === ConnectionState.CONNECTED;
  }

  /** Whether the socket can carry a frame right now. */
  get open(): boolean {
    return this.ws !== null && this.ws.readyState === READY_OPEN;
  }

  /** Wrap a socket handler or timer callback so the host hears where each event ends. */
  private event<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      try {
        fn(...args);
      } finally {
        this.out.endOfEvent();
      }
    };
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
    const Ctor = (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket;
    const ws = new Ctor(this.url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = this.event(() => {
      devLog.info("connection", "WebSocket transport open, sending handshake");
      // Send protocol handshake as a text frame
      this.handshakePending = true;
      this.out.wireState({ state: "will-open" });
      ws.send(JSON.stringify({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, ...this.hello }));
    });

    ws.onmessage = this.event((event: MessageEvent) => {
      // During handshake: expect a text frame response from the server
      if (this.handshakePending) {
        this.completeHandshake(event.data);
        return;
      }

      // Any post-handshake message — including the binary HEARTBEAT
      // echo — is evidence the wire is alive. Bump the watchdog clock
      // unconditionally before the decode so a malformed frame still
      // resets the stall timer (the server reached us; the bytes
      // arriving garbled is a separate problem).
      this.lastFrameAt = Date.now();

      if (event.data instanceof ArrayBuffer) {
        this.out.bytes(new Uint8Array(event.data));
      }
    });

    ws.onclose = this.event((event: CloseEvent) => {
      this.recordCloseCause(event);
      this.stopHeartbeat();
      this.lastCloseReason = event.reason || null;
      this.out.wireState({ state: "closed", closeCode: event.code, closeReason: event.reason || null });

      // Don't reconnect if close was intentional
      if (this.intentionalClose) {
        return;
      }

      // Transition to disconnected and schedule reconnection
      this.state = ConnectionState.DISCONNECTED;
      this.scheduleReconnect();

      // Double the retry delay for next attempt (capped at max)
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
    });

    ws.onerror = this.event(() => {
      devLog.error("connection", "WebSocket error");
      // The close event always follows an error, so reconnection is handled there
    });
  }

  private completeHandshake(data: unknown): void {
    const ws = this.ws;
    if (typeof data !== "string") {
      devLog.error("connection", "handshake failed: expected text frame, got binary");
      ws?.close();
      return;
    }
    let response: IngestHandshake;
    try {
      response = JSON.parse(data) as IngestHandshake;
    } catch {
      devLog.error("connection", "handshake failed: invalid JSON");
      ws?.close();
      return;
    }
    if (response.protocol !== PROTOCOL_NAME) {
      devLog.error("connection", "handshake failed: unknown protocol", { protocol: response.protocol });
      ws?.close();
      return;
    }
    if (response.version !== PROTOCOL_VERSION) {
      devLog.error("connection", "handshake failed: version mismatch", { version: response.version });
      ws?.close();
      return;
    }
    devLog.info("connection", `handshake complete (v${response.version})`);
    this.handshakePending = false;
    // Now transition to connected
    this.state = ConnectionState.CONNECTED;
    this.retryDelay = INITIAL_RETRY_DELAY_MS;
    this.clearCountdownTimer();
    // Seed the watchdog clock with the moment the wire became
    // live. Without this, the very first watchdog tick after a
    // long handshake-pending period would see `lastFrameAt = 0`
    // and force-close immediately.
    this.lastFrameAt = Date.now();
    this.startHeartbeat();
    // Re-establish this socket's subscription before the page hears the
    // wire is open, as the page did when it held the socket.
    this.out.handshakeComplete();
    // The page publishes the host info, raises the connected banner state
    // and fires the lifecycle's open, in that order, from this one patch.
    this.out.wireState({ state: "open", handshake: response });
  }

  /** The banner's state as the page last derived it. */
  private disconnectState(reconnecting: boolean): IngestDisconnectState {
    return {
      disconnected: this.state !== ConnectionState.CONNECTED,
      countdown: this.countdownSeconds,
      reason: this.lastCloseReason && this.lastCloseReason.trim() !== "" ? this.lastCloseReason : null,
      reconnecting,
    };
  }

  /** The countdown the connected banner state carries. */
  get countdown(): number {
    return this.countdownSeconds;
  }

  /**
   * Emit a structured record of why the wire ended, into the dev log.
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
    devLog.warn("connection", "WebSocket closed", {
      code: event.code,
      reason: event.reason || null,
      watchdogForced: this.watchdogForcedClose,
      intentional: this.intentionalClose,
      staleMs,
      visibility: this.visibility,
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
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // Calculate countdown seconds
    this.countdownSeconds = Math.ceil(this.retryDelay / 1000);

    // The banner's state, then the lifecycle's reconnecting — the order the
    // page heard them in when it held the socket.
    this.out.disconnectState(this.disconnectState(false));
    this.out.wireState({ state: "reconnecting" });

    // Start countdown timer (updates every second)
    this.countdownTimer = this.timers.setInterval(
      this.event(() => {
        this.tickCountdown();
      }),
      1000,
    );

    // Schedule reconnection attempt
    this.retryTimer = this.timers.setTimeout(
      this.event(() => {
        this.reconnect();
      }),
      this.retryDelay,
    );
  }

  /**
   * Attempt to reconnect
   */
  private reconnect(): void {
    this.clearCountdownTimer();

    this.state = ConnectionState.RECONNECTING;
    this.out.disconnectState(this.disconnectState(true));

    devLog.info("connection", "attempting reconnection");
    this.connect();
  }

  /**
   * Tick the countdown by 1 second and notify listeners.
   */
  private tickCountdown(): void {
    this.countdownSeconds = Math.max(0, this.countdownSeconds - 1);
    this.out.disconnectState(this.disconnectState(false));

    if (this.countdownSeconds === 0 && this.countdownTimer !== null) {
      this.timers.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /**
   * Clear the countdown interval timer.
   */
  private clearCountdownTimer(): void {
    if (this.countdownTimer !== null) {
      this.timers.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /**
   * Put one frame on the wire, reporting whether it went out. A socket that
   * is not OPEN refuses it — there is no outbound queue — and reports
   * `false`; the caller decides what a refusal means and says so.
   */
  send(feedId: number, flags: number, payload: Uint8Array): boolean {
    const ws = this.ws;
    if (ws !== null && ws.readyState === READY_OPEN) {
      ws.send(encodeFrame({ feedId: feedId as FeedIdLike, flags, payload }));
      return true;
    }
    return false;
  }

  /**
   * Send a `subscribe_feeds` CONTROL frame carrying `feeds`, and `sessions`
   * when it names some. The message replaces the whole filter, so leaving
   * `sessions` out is every session.
   */
  sendSubscription(feeds: readonly number[], sessions: "all" | readonly string[] = "all"): void {
    const frame = controlFrame("subscribe_feeds", {
      feeds: [...feeds],
      ...(sessions === "all" ? {} : { sessions: [...sessions] }),
    });
    this.send(frame.feedId, frame.flags, frame.payload);
  }

  /**
   * Send one heartbeat the moment the page becomes visible again.
   *
   * On wake from sleep the interval timer was frozen while the
   * server's clock kept running, so the next scheduled beat may not
   * arrive until after the server has already given up. This pulse
   * proves liveness at exactly the moment the server is closest to
   * hanging up, for the cost of one empty frame per wake. It is armed
   * with the heartbeat and released with it.
   */
  visibilityChanged(visible: boolean): void {
    this.visibility = visible ? "visible" : "hidden";
    if (!visible || !this.heartbeatArmed) return;
    if (this.ws?.readyState !== READY_OPEN) return;
    this.sendHeartbeat();
  }

  private sendHeartbeat(): void {
    this.send(FeedId.HEARTBEAT, FrameFlags.DATA, new Uint8Array(0));
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
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearCountdownTimer();

    // Reset backoff so the next failure doesn't start from a high delay
    this.retryDelay = INITIAL_RETRY_DELAY_MS;

    // Connect now
    this.reconnect();
  }

  /**
   * Drop the wire the way the network would, for app-tests. Deliberately
   * does NOT set the intentional latch, so the full lifecycle runs:
   * `onclose` → close → backoff → reconnect → reconnect's restore.
   */
  forceCloseForTest(): void {
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
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearCountdownTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Start sending heartbeat frames periodically and arm the inbound
   * heartbeat watchdog. Both timers share a lifecycle: they start
   * together when the handshake completes and stop together on close.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = this.timers.setInterval(
      this.event(() => {
        this.sendHeartbeat();
      }),
      HEARTBEAT_INTERVAL_MS,
    );
    this.startWatchdog();
    this.heartbeatArmed = true;
  }

  /**
   * Stop the heartbeat and watchdog timers.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.stopWatchdog();
    this.heartbeatArmed = false;
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
    this.watchdogTimer = this.timers.setInterval(
      this.event(() => {
        const now = Date.now();

        if (this.graceOpenedAt === null) {
          if (now - this.lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
            this.graceOpenedAt = now;
            this.graceOpenedAtFrame = this.lastFrameAt;
            devLog.warn("connection", "heartbeat watchdog probing a silent wire", {
              staleMs: now - this.lastFrameAt,
              graceMs: WATCHDOG_GRACE_MS,
            });
            this.sendHeartbeat();
          }
          return;
        }

        // A frame arrived since the probe went out — the wire answered.
        if (this.lastFrameAt > this.graceOpenedAtFrame) {
          devLog.info("connection", "heartbeat watchdog probe answered — wire is healthy", {
            answeredAfterMs: this.lastFrameAt - this.graceOpenedAt,
          });
          this.graceOpenedAt = null;
          return;
        }

        if (now - this.graceOpenedAt >= WATCHDOG_GRACE_MS) {
          this.graceOpenedAt = null;
          this.watchdogForcedClose = true;
          devLog.warn("connection", "heartbeat watchdog probe unanswered — force-closing dead wire", {
            staleMs: now - this.lastFrameAt,
            graceMs: WATCHDOG_GRACE_MS,
          });
          this.ws?.close();
        }
      }),
      WATCHDOG_TICK_MS,
    );
  }

  /**
   * Disarm the watchdog. Called from `stopHeartbeat` on close so the
   * timer cannot fire against a connection that's already been torn
   * down.
   */
  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.timers.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.graceOpenedAt = null;
  }
}

type FeedIdLike = Parameters<typeof encodeFrame>[0]["feedId"];
