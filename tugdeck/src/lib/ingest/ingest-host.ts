/**
 * `IngestHost` — everything the ingest Worker runs, in one class.
 *
 * It speaks only the ingest protocol: {@link SessionControl} messages in,
 * {@link SessionBatch} batches out. The same class runs in two places, and
 * only the channel that carries its messages differs: in the Worker
 * (`WorkerIngestChannel`, production) and on the calling thread behind a
 * channel that structured-clones every message (`InProcessIngestChannel`,
 * unit tests). So "the code that ships" is one thing.
 *
 * This is the wire half. It holds the socket (`WireSocket`), peels frames
 * (`FramePeeler`), keeps the feed subscription the page has accumulated and
 * re-sends it on every handshake, and posts every frame but CODE_OUTPUT's to
 * the page as a raw `frame` patch with its payload buffer transferred; the
 * page reads CODE_OUTPUT only through its sessions' mirrors ([P14]). The set
 * it sends is a union: the page's, the three session feeds once any session
 * has opened, and every feed an engine has written on — an engine's first
 * write on a feed sends the grown set before the payload, as the page's own
 * first write always did ([P02]). When to post is its flush policy's call: paced
 * to the display period in the Worker, at the end of every handled message
 * on the calling thread.
 *
 * And it is the session half. Each open session is one `SessionEngine`,
 * addressed by the handle its mirror minted ([P06]). A CODE_OUTPUT,
 * SESSION_STATE or CONTROL frame is decoded once and routed to every open
 * engine whose session id it carries, by an exact match with no exemption,
 * so an untagged frame reaches none. The last frame of each of those feeds is
 * kept, cleared at every close, and replayed into an engine as it opens, as
 * the page's own late-subscriber replay always did. The CODE_OUTPUT types a
 * narrow per-session store folds (`ROUTED_CODE_OUTPUT_TYPES`) skip the engine
 * and the cache: each goes to its session's mirror as a `routed-frame` patch.
 * A host with no socket —
 * the per-session host a test frame source opens on this thread — is fed
 * those frames by its owner and writes through its owner's `send`.
 *
 * And it holds the wire while a settle's motion gate is closed ([P08]). The
 * page posts each hold with its cap and the gate's release; while held, the
 * engines keep reducing and their patches keep accumulating, but nothing
 * posts — not the period's batch, not an immediate one, not an action's
 * acknowledgment — except the wire's own state, which is page state rather
 * than pixels and posts at once in a batch of its own, so the banner and the
 * page's open-socket mirror never lag the socket. The release posts
 * everything as one batch, and so does the host's own cap deadline if the
 * release never comes, so a gate that never opens cannot strand the deck's
 * data.
 *
 * And it carries tugcast's renders. A `RENDERED` frame bundles every
 * session's renders for one tick; the host decodes it once and hands each
 * session's entries to that session's engines, and the page never sees the
 * raw frame. The host subscribes the feed itself once an engine opens, but
 * keeps it out of {@link SESSION_FEEDS}: a render batch is neither one
 * session's frame nor one to replay into an engine that opens later. The
 * controls tugcast paces and holds those renders by go back on
 * `RENDER_INPUT`: each motion hold and release, under a holder id this host
 * mints once, the display period, and — after every handshake, beside the
 * period — a resync of every message, because a fresh socket may belong to a
 * page that holds none of the HTML tugcast believes it sent.
 *
 * tugcast answers that resync with an empty `render-batch` at its protocol
 * version. Until one at the version this deck reads has arrived on the
 * current socket, the host tells its engines tugcast is not rendering, and
 * they mint no `pending` state: an older tugcast, or a newer one, leaves
 * every row parsing its own text rather than waiting on a render that will
 * not come. A batch at another version is dropped.
 *
 * A session's find goes the same way: the host forwards the query on
 * `RENDER_INPUT` under the session's id and routes tugcast's `find-result`
 * back to the engine that asked, as a `find-result` patch. With the wire
 * down it answers at once with every unit missing, so the page projects
 * them itself rather than waiting out its finisher.
 */

import type { IngestPageIdentity, IngestPatch } from "@tugproto/ingest";
import {
  RENDERED_FEED_VERSION,
  renderInputFrame,
  type FindResultFrame,
  type RenderInput,
  type RenderedFrame,
  type RenderedMessageWire,
} from "@tugproto/rendered";
import { FeedId, FrameFlags } from "@/protocol";
import { devLog } from "@/lib/dev-log-port";
import { FALLBACK_FRAME_PERIOD_MS } from "@/lib/frame-period";
import {
  DEFAULT_TIMER_SOURCE,
  SessionEngine,
  stampedSessionId,
  type TimerSource,
} from "@/lib/code-session-store/session-engine";
import { FramePeeler } from "./frame-peeler";
import { SYSTEM_CLOCK, type FlushPolicy, type PacerClock } from "./pacer";
import type { SessionBatch, SessionControl, SessionPatch } from "./session-patch";
import { WireSocket, type WireTimers, GLOBAL_TIMERS } from "./wire-socket";

/** Where the host's batches go, with the buffers to transfer. */
export type BatchSink = (batch: SessionBatch, transfer: ArrayBuffer[]) => void;

/** Builds the host's flush policy around the host's own flush. */
export type FlushPolicyFactory = (flush: () => void, periodMs: number) => FlushPolicy;

/**
 * Patch kinds that post at once rather than waiting for the period. An `ack`
 * and a `find-result` are both replies somebody is waiting on.
 */
const IMMEDIATE_KINDS: ReadonlySet<IngestPatch["kind"]> = new Set([
  "wire-state",
  "disconnect-state",
  "ack",
  "find-result",
]);

/**
 * Patch kinds a motion hold does not hold. The wire's state is page state,
 * not pixels: the page's open-socket mirror and the banner read it, so it
 * posts through a hold in a batch of its own, ahead of what the hold keeps.
 */
export const UNHELD_KINDS: ReadonlySet<IngestPatch["kind"]> = new Set(["wire-state", "disconnect-state"]);

/** The shortest cap the host holds the wire under, whatever cap the gate posted. */
export const MIN_HOLD_CAP_MS = 1000;

/** The feeds a session engine reduces. */
export const SESSION_FEEDS: readonly number[] = [FeedId.CODE_OUTPUT, FeedId.SESSION_STATE, FeedId.CONTROL];

const SESSION_FEED_SET: ReadonlySet<number> = new Set(SESSION_FEEDS);

/** The feeds the host subscribes for its engines: the session feeds and tugcast's renders. */
export const ENGINE_FEEDS: readonly number[] = [...SESSION_FEEDS, FeedId.RENDERED];

/**
 * CODE_OUTPUT types that no reducer reads and a narrow per-session store
 * folds: `/skills` and `/hooks` responses and `/btw` answers. Each is routed
 * to its session's mirror as a `routed-frame` patch ([P14]).
 */
export const ROUTED_CODE_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "skills_inventory",
  "hooks_inventory",
  "side_question_answer",
]);

const utf8 = new TextDecoder();
const utf8Encode = new TextEncoder();

/** A holder id for tugcast's motion hold, one per host. */
function mintHolderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `holder-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** One `render-batch`'s version and sessions, or `null` for any other frame. */
function renderBatch(
  decoded: unknown,
): { v: unknown; sessions: ReadonlyArray<{ tugSessionId: string; messages: RenderedMessageWire[] }> } | null {
  const frame = decoded as Partial<RenderedFrame> | null;
  if (frame === null || typeof frame !== "object" || frame.kind !== "render-batch") return null;
  return Array.isArray(frame.sessions) ? { v: frame.v, sessions: frame.sessions } : null;
}

/** An error as a line a log can carry across the thread boundary. */
function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isRoutedType(decoded: unknown): decoded is { type: string } {
  if (typeof decoded !== "object" || decoded === null) return false;
  const type = (decoded as { type?: unknown }).type;
  return typeof type === "string" && ROUTED_CODE_OUTPUT_TYPES.has(type);
}

export interface IngestHostOptions {
  /** The wire socket's timers. */
  readonly timers?: WireTimers;
  /**
   * Where the engines' frames go when the host holds no socket: the owner's
   * own connection.
   */
  readonly send?: (feedId: number, payload: Uint8Array) => void;
  /** The timer source a session's replay clock runs on; the global timers by default. */
  readonly sessionTimers?: (handle: string) => TimerSource | undefined;
  /**
   * Whether an engine that opens gets the host's last frame of each session
   * feed. A host fed by a connection that replays on subscribe already gets
   * that replay, so it turns this off. Default true.
   */
  readonly replayOnOpen?: boolean;
  /** The clock the motion hold's cap deadline runs on; the system clock by default. */
  readonly holdClock?: PacerClock;
  /**
   * Post a batch only once the page has applied the one before it (its
   * `batch-applied`). The Worker's host waits; one on the page's own thread
   * delivers synchronously and has nothing to wait for.
   */
  readonly awaitPageAck?: boolean;
}

export class IngestHost {
  private socket: WireSocket | null = null;
  private readonly policy: FlushPolicy;
  private readonly peeler: FramePeeler;
  private pending: SessionPatch[] = [];
  private transfer: ArrayBuffer[] = [];
  /** The page's accumulated subscription, as it last posted it. */
  private subscribed: number[] = [];
  /**
   * Feeds the host wants for its own engines: the session feeds from the
   * first open on, and every feed an engine has written on. Monotonic, as
   * the page's set is, and for the same reason.
   */
  private readonly ownFeeds = new Set<number>();
  /** Open session engines, by handle. */
  private readonly engines = new Map<string, SessionEngine>();
  /** Each outstanding find, by request id, to the handle that asked. */
  private readonly pendingFinds = new Map<string, string>();
  /** tugcast answered this socket's resync at a version this deck reads. */
  private tugcastRenders = false;
  /** The last decoded frame of each session feed, until the wire closes. */
  private readonly sessionCache = new Map<number, unknown>();
  /** While the motion gate holds the wire: when the cap releases it. */
  private heldUntil: number | null = null;
  private holdCap: unknown = null;
  /** Batches posted that the page has not yet said it applied; only counted when the host waits on the page. */
  private unacked = 0;
  /** A flush the period asked for while the page was still applying; the page's acknowledgement runs it. */
  private flushOwed = false;
  /** This host's holder id in tugcast's motion hold. */
  private readonly holderId = mintHolderId();
  /** The display period last posted, re-sent to tugcast on every handshake. */
  private periodMs: number = FALLBACK_FRAME_PERIOD_MS;
  /** The sessions `init` named, sent with every subscription. */
  private sessions: "all" | string[] = "all";

  constructor(
    private readonly sink: BatchSink,
    private readonly makePolicy: FlushPolicyFactory,
    private readonly options: IngestHostOptions = {},
  ) {
    this.peeler = new FramePeeler((length) => {
      devLog.error("connection", "frame header reports oversized payload; resetting buffer", { length });
    });
    this.policy = this.makePolicy(() => this.flush(), FALLBACK_FRAME_PERIOD_MS);
  }

  /** Handle one control from the page. */
  handle(control: SessionControl): void {
    try {
      this.apply(control);
    } finally {
      this.policy.endOfMessage();
    }
  }

  /**
   * One frame on a session feed, from the owner of a host with no socket.
   * Handled as one message: whatever the engines post for it is flushed at
   * its end.
   */
  ingestFrame(feedId: number, payload: Uint8Array): void {
    try {
      if (feedId === FeedId.RENDERED) this.routeRendered(payload);
      else this.routeSessionFrame(feedId, payload);
    } finally {
      this.policy.endOfMessage();
    }
  }

  private apply(control: SessionControl): void {
    switch (control.kind) {
      case "init":
        this.init(control.wsUrl, control.periodMs, control.page, control.sessions);
        return;
      case "connect":
        this.socketFor("connect")?.connect();
        return;
      case "close":
        this.socket?.close();
        return;
      case "force-reconnect":
        this.socket?.forceReconnect();
        return;
      case "force-close-for-test":
        this.socket?.forceCloseForTest();
        return;
      case "subscribe":
        this.subscribe(control.feeds);
        return;
      case "sessions":
        this.sessions = control.sessions;
        if (this.socket?.connected) this.socket.sendSubscription(this.wireSubscription(), this.sessions);
        return;
      case "send": {
        const socket = this.socketFor("send");
        if (socket !== null && !socket.send(control.feedId, control.flags, new Uint8Array(control.bytes))) {
          // The page posted it while its mirror still read the wire open; the
          // close it had not yet heard of refuses it here, and says so.
          devLog.warn("connection", "a frame the page sent was refused: the socket closed before it went out", {
            feedId: control.feedId,
            bytes: control.bytes.byteLength,
          });
        }
        return;
      }
      case "visibility":
        this.socket?.visibilityChanged(control.visible);
        return;
      case "display-period":
        this.policy.setPeriod(control.periodMs);
        this.periodMs = control.periodMs;
        this.sendRenderControl({ kind: "display-period", periodMs: control.periodMs });
        return;
      case "motion":
        if (control.held) this.hold(control.capMs);
        else this.releaseHold();
        return;
      case "session-open":
        this.openSession(control);
        return;
      case "session-close": {
        const engine = this.engines.get(control.handle);
        this.engines.delete(control.handle);
        for (const [requestId, handle] of this.pendingFinds) {
          if (handle === control.handle) this.pendingFinds.delete(requestId);
        }
        engine?.close();
        return;
      }
      case "session-action":
        this.forEngine(control.handle, control.seq, "action", (engine) => engine.action(control.event));
        return;
      case "session-test-frame":
        this.forEngine(control.handle, control.seq, "test frame", (engine) =>
          engine.frame(control.feedId, control.decoded),
        );
        return;
      case "find":
        this.forwardFind(control);
        return;
      case "batch-applied":
        this.unacked = Math.max(0, this.unacked - 1);
        if (this.unacked === 0 && this.flushOwed) this.flush();
        return;
    }
  }

  /**
   * Run one sequenced control on its engine, then acknowledge it — always.
   * The mirror's `whenSettled()` waits on that acknowledgment, so an engine
   * that throws is reported and still answered: a reader waiting on its own
   * action (a quit's stash, a hand-over's queued sends) must never wait on
   * an acknowledgment that cannot come.
   */
  private forEngine(handle: string, seq: number, what: string, run: (engine: SessionEngine) => void): void {
    const engine = this.engines.get(handle);
    try {
      if (engine !== undefined) run(engine);
    } catch (err) {
      devLog.error("ingest", `session ${handle} threw on its ${what}`, { session: handle, error: errorText(err) });
    } finally {
      this.emit({ kind: "ack", session: handle, payload: { seq } });
    }
  }

  private init(
    wsUrl: string,
    periodMs: number,
    page: IngestPageIdentity | undefined,
    sessions: "all" | string[] | undefined,
  ): void {
    if (this.socket !== null) return;
    this.policy.setPeriod(periodMs);
    this.periodMs = periodMs;
    this.sessions = sessions ?? "all";
    this.socket = new WireSocket(
      wsUrl,
      {
        wireState: (payload) => {
          if (payload.state === "closed") {
            this.peeler.reset();
            // The next socket's tugcast says again whether it renders.
            this.tugcastRenders = false;
            // A session opened while the wire is down must not reduce a
            // frame from before the close ([D05]).
            this.sessionCache.clear();
          }
          this.emit({ kind: "wire-state", session: null, payload });
        },
        disconnectState: (state) => this.emit({ kind: "disconnect-state", session: null, payload: state }),
        bytes: (chunk) => this.absorb(chunk),
        handshakeComplete: () => {
          // Unconditional: a fresh socket knows nothing, whatever the last one carried.
          this.socket?.sendSubscription(this.wireSubscription(), this.sessions);
          // tugcast's render bridge paces to the deck's period, and re-sends
          // every block's HTML, since this page may hold none of it.
          this.sendRenderControl({ kind: "display-period", periodMs: this.periodMs });
          this.sendRenderControl({ kind: "resync" });
        },
        endOfEvent: () => this.policy.endOfMessage(),
      },
      this.options.timers ?? GLOBAL_TIMERS,
      page === undefined
        ? null
        : {
            role: page.role,
            page_id: page.pageId,
            ...(page.cardId === undefined ? {} : { card_id: page.cardId }),
          },
    );
  }

  /**
   * The socket a control needs, or `null` with the refusal said: a control
   * that arrives before `init` is a page defect the host reports and
   * survives, never a throw that would cost the page its Worker.
   */
  private socketFor(what: "connect" | "send"): WireSocket | null {
    if (this.socket === null) {
      devLog.warn("connection", `a ${what} arrived before the ingest host's init and was refused`);
    }
    return this.socket;
  }

  /**
   * Take the page's accumulated set. It only grows, so a set that adds a
   * feed while the wire is live goes out now; one that arrives while it is
   * down rides the next handshake.
   */
  private subscribe(feeds: number[]): void {
    const known = new Set(this.wireSubscription());
    const grew = feeds.some((f) => !known.has(f));
    this.subscribed = [...feeds];
    if (grew && this.socket?.connected) this.socket.sendSubscription(this.wireSubscription(), this.sessions);
  }

  /** The set the wire is told: the page's, with the host's own feeds folded in, in feed order. */
  private wireSubscription(): number[] {
    if (this.ownFeeds.size === 0) return this.subscribed;
    return [...new Set([...this.subscribed, ...this.ownFeeds])].sort((a, b) => a - b);
  }

  /** Add feeds the host's engines need; a set that grew goes out now while the wire is live. */
  private wantFeeds(feeds: readonly number[]): void {
    const before = new Set(this.wireSubscription());
    for (const f of feeds) this.ownFeeds.add(f);
    if (!feeds.some((f) => !before.has(f))) return;
    if (this.socket?.connected) this.socket.sendSubscription(this.wireSubscription(), this.sessions);
  }

  private absorb(chunk: Uint8Array): void {
    for (const frame of this.peeler.push(chunk)) {
      // tugcast's renders reach the engines only, as CODE_OUTPUT does.
      if (frame.feedId === FeedId.RENDERED) {
        this.routeRendered(new Uint8Array(frame.payload));
        continue;
      }
      // A session feed's frame is kept even with no engine open, so the
      // first engine to open gets it.
      this.routeSessionFrame(frame.feedId, new Uint8Array(frame.payload));
      // The page reads CODE_OUTPUT only through its sessions' mirrors.
      if (frame.feedId === FeedId.CODE_OUTPUT) continue;
      this.transfer.push(frame.payload);
      this.emit({ kind: "frame", session: null, payload: { feedId: frame.feedId, bytes: frame.payload } });
    }
  }

  private openSession(control: Extract<SessionControl, { kind: "session-open" }>): void {
    const engine = new SessionEngine(
      {
        handle: control.handle,
        tugSessionId: control.tugSessionId,
        displayLabel: control.displayLabel,
        sessionMode: control.sessionMode,
        restoreWindowTurns: control.restoreWindowTurns,
        transcriptTurnCap: control.transcriptTurnCap,
        timerSource: this.engineTimers(control.handle),
      },
      {
        send: (feedId, payload) => this.sendForEngine(feedId, payload),
        emit: (patch) => this.emit(patch),
        sendRenderControl: (control) => this.sendRenderControl(control),
        tugcastRenders: () => this.tugcastRenders,
      },
    );
    this.engines.set(control.handle, engine);
    // A host that holds the socket subscribes its engines' feeds itself; the
    // page no longer registers for them on the engines' behalf.
    if (this.socket !== null) this.wantFeeds(ENGINE_FEEDS);
    if (this.options.replayOnOpen === false) return;
    for (const feedId of SESSION_FEEDS) {
      const cached = this.sessionCache.get(feedId);
      if (cached !== undefined && stampedSessionId(cached) === control.tugSessionId) {
        engine.frame(feedId, cached);
      }
    }
  }

  /**
   * An engine's replay clock, on the injected source, with each timer firing
   * as one message of its own: what it posts is flushed at its end.
   */
  private engineTimers(handle: string): TimerSource {
    const base = this.options.sessionTimers?.(handle) ?? DEFAULT_TIMER_SOURCE;
    return {
      setTimeout: (cb, ms) =>
        base.setTimeout(() => {
          try {
            cb();
          } finally {
            this.policy.endOfMessage();
          }
        }, ms),
      clearTimeout: (handle) => base.clearTimeout(handle),
    };
  }

  /**
   * Write an engine's frame: through the owner when there is no socket, else
   * on the wire — after the subscription, on the first write to a feed, so
   * the router's answer on that feed's own id has a subscription to reach.
   */
  private sendForEngine(feedId: number, payload: Uint8Array): void {
    if (this.options.send !== undefined) {
      this.options.send(feedId, payload);
      return;
    }
    if (feedId !== FeedId.CONTROL && feedId !== FeedId.HEARTBEAT && feedId !== FeedId.RENDER_INPUT) {
      this.wantFeeds([feedId]);
    }
    if (this.socket?.send(feedId, FrameFlags.DATA, payload) !== true) {
      devLog.warn("connection", "a session's frame was refused: the socket is not open", {
        feedId,
        bytes: payload.byteLength,
      });
    }
  }

  /** Forward one session's find to tugcast, or answer it at once with the wire down. */
  private forwardFind(control: Extract<SessionControl, { kind: "find" }>): void {
    const engine = this.engines.get(control.handle);
    if (engine === undefined) return;
    const { requestId, query, options, limit, units, mountedUnits, knownTexts } = control;
    if (this.options.send === undefined && this.socket?.connected !== true) {
      this.emit({
        kind: "find-result",
        session: control.handle,
        payload: {
          kind: "find-result",
          requestId,
          tugSessionId: engine.tugSessionId,
          missing: [...new Set([...units, ...mountedUnits])],
        },
      });
      return;
    }
    this.pendingFinds.set(requestId, control.handle);
    this.sendRenderControl({
      kind: "find",
      requestId,
      tugSessionId: engine.tugSessionId,
      query,
      options,
      limit,
      units,
      mountedUnits,
      ...(knownTexts !== undefined ? { knownTexts } : {}),
    });
  }

  /** One control to tugcast's render bridge, on the path the engines write on. */
  private sendRenderControl(control: RenderInput): void {
    if (this.options.send === undefined && this.socket?.connected !== true) return;
    this.sendForEngine(FeedId.RENDER_INPUT, utf8Encode.encode(JSON.stringify(renderInputFrame(control))));
  }

  /**
   * Decode a `RENDERED` frame once and hand each session's renders to every
   * open engine of that session. Nothing is kept: a render an engine missed
   * is answered by its resync, not by a replay. A `find-result` goes to the
   * one engine whose query it answers.
   */
  private routeRendered(payload: Uint8Array): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(utf8.decode(payload));
    } catch (err) {
      devLog.error("ingest", "failed to decode a RENDERED payload", { error: errorText(err) });
      return;
    }
    const found = decoded as Partial<FindResultFrame> | null;
    if (found !== null && typeof found === "object" && found.kind === "find-result") {
      const handle = typeof found.requestId === "string" ? this.pendingFinds.get(found.requestId) : undefined;
      if (handle === undefined) return;
      this.pendingFinds.delete(found.requestId as string);
      if (this.engines.has(handle)) {
        this.emit({ kind: "find-result", session: handle, payload: found as FindResultFrame });
      }
      return;
    }
    const batch = renderBatch(decoded);
    if (batch === null) return;
    if (batch.v !== RENDERED_FEED_VERSION) {
      if (this.tugcastRenders || batch.sessions.length === 0) {
        devLog.warn("ingest", "tugcast renders at another protocol version; rows parse their own text", {
          theirs: String(batch.v),
          ours: String(RENDERED_FEED_VERSION),
        });
      }
      this.tugcastRenders = false;
      return;
    }
    this.tugcastRenders = true;
    for (const session of batch.sessions) {
      for (const engine of this.engines.values()) {
        if (engine.tugSessionId !== session.tugSessionId) continue;
        try {
          engine.rendered(session.messages);
        } catch (err) {
          devLog.error("ingest", `session ${engine.handle} threw for a render`, {
            session: engine.handle,
            error: errorText(err),
          });
        }
      }
    }
  }

  /**
   * Decode a session feed's frame once, keep it as the feed's last, and hand
   * it to every open engine whose session it names. One engine's failure is
   * its own: it is reported and the rest still run. A routed CODE_OUTPUT type
   * goes to the mirror of every open engine whose session it names instead,
   * and is not kept: it is no engine's to replay.
   */
  private routeSessionFrame(feedId: number, payload: Uint8Array): void {
    if (!SESSION_FEED_SET.has(feedId)) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(utf8.decode(payload));
    } catch (err) {
      devLog.error("ingest", `failed to decode payload for feed 0x${feedId.toString(16)}`, { error: errorText(err) });
      return;
    }
    if (feedId === FeedId.CODE_OUTPUT && isRoutedType(decoded)) {
      this.routeToMirrors(feedId, decoded);
      return;
    }
    this.sessionCache.set(feedId, decoded);
    const id = stampedSessionId(decoded);
    if (id === undefined) return;
    for (const engine of this.engines.values()) {
      if (engine.tugSessionId !== id) continue;
      try {
        engine.frame(feedId, decoded);
      } catch (err) {
        devLog.error("ingest", `session ${engine.handle} threw for feed 0x${feedId.toString(16)}`, {
          session: engine.handle,
          error: errorText(err),
        });
      }
    }
  }

  private routeToMirrors(feedId: number, decoded: { type: string }): void {
    const id = stampedSessionId(decoded);
    if (id === undefined) return;
    for (const engine of this.engines.values()) {
      if (engine.tugSessionId !== id) continue;
      this.emit({ kind: "routed-frame", session: engine.handle, payload: { feedId, type: decoded.type, decoded } });
    }
  }

  /** Queue a dev-log entry for the page to replay into its own log stores. */
  log(payload: Extract<SessionPatch, { kind: "log" }>["payload"]): void {
    this.emit({ kind: "log", session: null, payload });
  }

  /**
   * Append a patch. A session's stream writes merge into its own latest
   * stream patch in the pending batch, last write per path winning, so a
   * period of deltas carries each Message's text once ([P05]) — however many
   * other sessions streamed between them, since one session's patches never
   * read another's. A patch of the same session in between keeps them apart,
   * so a session's own order is never changed, and so does a change of the
   * wire's state, which the page acts on in order. An open replay fold posts
   * no structure, so its writes merge into one stream patch and the flush
   * that closes it is one structure patch.
   */
  private emit(patch: SessionPatch): void {
    if (patch.kind === "stream") {
      const prior = this.pendingStreamOf(patch.session);
      if (prior !== null) {
        mergeStream(prior.payload, patch.payload);
        this.note(false);
        return;
      }
    }
    if (this.heldUntil !== null && UNHELD_KINDS.has(patch.kind)) {
      this.post([patch], []);
      return;
    }
    this.pending.push(patch);
    this.note(IMMEDIATE_KINDS.has(patch.kind));
  }

  /**
   * The session's latest pending patch, when it is a stream patch nothing of
   * the session's own, and no change of the wire's state, has followed.
   */
  private pendingStreamOf(session: string | null): Extract<SessionPatch, { kind: "stream" }> | null {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const p = this.pending[i]!;
      if (p.session === session) return p.kind === "stream" ? p : null;
      if (p.kind === "wire-state" || p.kind === "disconnect-state") return null;
    }
    return null;
  }

  /** Tell the flush policy a patch is pending — unless the wire is held, whose release posts it. */
  private note(immediate: boolean): void {
    if (this.heldUntil === null) this.policy.note(immediate);
  }

  /**
   * The motion gate closed, or a nested hold arrived inside it: hold the wire
   * until the release, or until the latest cap any hold asked for.
   */
  private hold(capMs: number): void {
    const clock = this.options.holdClock ?? SYSTEM_CLOCK;
    const until = clock.now() + Math.max(capMs, MIN_HOLD_CAP_MS);
    if (this.heldUntil !== null && this.heldUntil >= until) return;
    this.heldUntil = until;
    // tugcast holds its renders under the same cap.
    this.sendRenderControl({ kind: "motion", holder: this.holderId, held: true, capMs: Math.max(capMs, MIN_HOLD_CAP_MS) });
    if (this.holdCap !== null) clock.clearTimeout(this.holdCap);
    this.holdCap = clock.setTimeout(() => {
      this.holdCap = null;
      this.releaseHold();
    }, until - clock.now());
  }

  /** The gate opened, or the cap passed: post what accumulated, as one batch. */
  private releaseHold(): void {
    if (this.heldUntil === null) return;
    this.heldUntil = null;
    this.sendRenderControl({ kind: "motion", holder: this.holderId, held: false });
    if (this.holdCap !== null) (this.options.holdClock ?? SYSTEM_CLOCK).clearTimeout(this.holdCap);
    this.holdCap = null;
    this.flush();
  }

  /**
   * Post everything pending as one batch; nothing while the wire is held,
   * and — for a host that waits on the page — nothing while the page is still
   * applying the last one. That flush is owed, and the page's acknowledgement
   * runs it; a page that keeps up never owes one, so the cadence is the
   * period's. What waits keeps merging, so a slow page receives fewer, fuller
   * batches, and the queue between the threads never grows past the one batch
   * it is applying.
   */
  private flush(): void {
    if (this.heldUntil !== null || this.pending.length === 0) return;
    if (this.options.awaitPageAck === true && this.unacked > 0) {
      this.flushOwed = true;
      return;
    }
    this.flushOwed = false;
    const entries = this.pending;
    const transfer = this.transfer;
    this.pending = [];
    this.transfer = [];
    this.post(entries, transfer);
  }

  private post(entries: SessionPatch[], transfer: ArrayBuffer[]): void {
    if (this.options.awaitPageAck === true) this.unacked += 1;
    this.sink({ kind: "batch", entries }, transfer);
  }

  /** Disarm everything: the socket, its timers, every engine, and the flush policy. */
  dispose(): void {
    if (this.holdCap !== null) (this.options.holdClock ?? SYSTEM_CLOCK).clearTimeout(this.holdCap);
    this.holdCap = null;
    this.socket?.close();
    for (const engine of this.engines.values()) engine.close();
    this.engines.clear();
    this.policy.dispose();
  }
}

type StreamPayload = Extract<SessionPatch, { kind: "stream" }>["payload"];

/** Fold `next`'s writes into `into`, last write per path winning in place. */
function mergeStream(into: StreamPayload, next: StreamPayload): void {
  for (const write of next.writes) {
    const at = into.writes.findIndex((w) => w.path === write.path);
    if (at >= 0) into.writes[at] = write;
    else into.writes.push(write);
  }
  into.textGrew ||= next.textGrew;
}

