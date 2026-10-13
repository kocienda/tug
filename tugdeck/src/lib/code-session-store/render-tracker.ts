/**
 * `RenderTracker` — every fact the display rule for tugcast's renders reads
 * ([P06]), for one session.
 *
 * A live assistant-text or thinking Message is written `pending` when it
 * mints, so its row draws nothing new until tugcast's first render arrives;
 * each render tugcast sends for it is forwarded as a record with the
 * tracker's `streaming` fact, flipped false the moment the Message stops
 * being the pending turn's last; and a finalized record is `current` only
 * when its text length and hash match the Message's own text. Two finishers
 * bound the wait for a provable render, each writing `null` ("parse
 * yourself") once. An emission that leaves a Message incomplete — a hash
 * with no HTML, or a diff off a base not held — asks tugcast for the whole
 * Message, backing off between asks.
 *
 * The session engine owns the reduction and tells the tracker what moved:
 * a Message's text written, a dispatch ended, a batch of renders arrived.
 * The tracker answers through its host, with `rendered-blocks` entries and
 * resync asks. It is Worker-safe, as the engine is.
 */

import type { RenderedState } from "@tugproto/ingest";
import type { RenderedMessageWire } from "@tugproto/rendered";
import { expandRenderedMessage, mergeRenderedMessage } from "@/lib/ingest/rendered-merge";
import { textHash } from "@/lib/ingest/text-hash";

/**
 * How long a Message may go without a provable render before its row is
 * told to parse: a pending Message with no render this long after it minted,
 * and a finalized one with no current record this long after it stopped
 * streaming ([P06]).
 */
export const RENDER_FINISHER_MS = 250;

/**
 * The first wait before a Message whose render is still incomplete asks
 * again, doubling with each ask to {@link RENDER_RESYNC_MAX_MS}, for at most
 * {@link RENDER_RESYNC_ASKS} asks. A resync's answer is the whole message,
 * so a deck that lags must not ask faster than it can take the answers.
 */
export const RENDER_RESYNC_BACKOFF_MS = 250;
export const RENDER_RESYNC_MAX_MS = 8_000;
export const RENDER_RESYNC_ASKS = 6;

/**
 * Timer source for the engine's deadlines and the tracker's waits. Defaults
 * to the global timers; tests inject a fake source so they can advance time
 * deterministically.
 */
export interface TimerSource {
  setTimeout: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

/** What a {@link TimerSource} hands back: opaque, and only ever given back to it. */
export type TimerHandle = unknown;

/** One entry of a `rendered-blocks` patch. */
export type RenderedEntry = { turnKey: string; messageKey: string; state: RenderedState };

/** What a tracker needs from the engine it serves. */
export interface RenderTrackerHost {
  readonly timerSource: TimerSource;
  /** Post one `rendered-blocks` patch; never called with nothing. */
  post(entries: RenderedEntry[]): void;
  /** Ask tugcast for one Message's whole render. */
  askWhole(messageKey: string): void;
  /**
   * Whether tugcast has said, on the current socket, that it renders at a
   * version this deck reads. Until it has, a live Message mints no pending
   * state and its row parses its own text.
   */
  tugcastRenders(): boolean;
}

/** The facts one dispatch leaves for the tracker to read. */
export interface RenderDispatchView {
  /** The pending turn's key, or null between turns. */
  readonly pendingTurnKey: string | null;
  /**
   * The pending turn's last Message, if it has one; `text` is its text when
   * it is an assistant-text or thinking Message (one tugcast renders), and
   * null for any other kind.
   */
  readonly last: { readonly messageKey: string; readonly text: string | null } | undefined;
  /** A replay is reducing; its Messages are not live. */
  readonly replaying: boolean;
  /** The committed transcript; a new identity prunes the tracks of turns it dropped. */
  readonly transcript: ReadonlyArray<{ readonly turnKey: string }>;
}

/** A committed or in-flight Message tugcast may render, by key; null when the key names none the tracker should start. */
export type FindTextMessage = (messageKey: string) => { turnKey: string; text: string } | null;

/** What the tracker knows about one Message tugcast renders. */
export interface RenderTrack {
  readonly turnKey: string;
  /** The Message's text, as the engine last wrote it. */
  text: string;
  /** Still the pending turn's last Message. */
  streaming: boolean;
  /** The last emission's block list and text facts, without its HTML. */
  last: RenderedMessageWire | null;
  /** The block hashes the page holds HTML for. */
  seen: Set<string>;
  /** The text's hash, computed once, when the Message finalizes. */
  finalHash: string | null;
  current: boolean;
  /** The last emission left the Message incomplete: a hash with no HTML, or a diff off a base not held. */
  incomplete: boolean;
  /** Resyncs asked since the Message was last complete. */
  resyncAsks: number;
  /** The armed wait before the next ask; while it runs, no ask is posted. */
  resyncTimer: TimerHandle | null;
  /** The armed finisher. */
  finisher: TimerHandle | null;
  /** The last state written was `null`. */
  nulled: boolean;
}

function newTrack(turnKey: string, text: string, streaming: boolean): RenderTrack {
  return {
    turnKey,
    text,
    streaming,
    last: null,
    seen: new Set(),
    finalHash: null,
    current: false,
    incomplete: false,
    resyncAsks: 0,
    resyncTimer: null,
    finisher: null,
    nulled: false,
  };
}

export class RenderTracker {
  /** Messages tugcast renders, by `messageKey`. */
  private readonly tracks = new Map<string, RenderTrack>();
  /** The keys of `tracks` still streaming. */
  private readonly streaming = new Set<string>();
  /** Renders that arrived before their Message minted, until it does or the turn ends. */
  private readonly early = new Map<string, RenderedMessageWire>();
  /** Finalized Messages whose text moved since the last dispatch, so their `current` is read again. */
  private readonly moved = new Set<string>();
  /** The transcript the tracks were last pruned against. */
  private prunedAgainst: ReadonlyArray<{ readonly turnKey: string }> = [];
  private closed = false;

  constructor(private readonly host: RenderTrackerHost) {}

  /** The track for a key (tests and diagnostics). */
  track(messageKey: string): Readonly<RenderTrack> | undefined {
    return this.tracks.get(messageKey);
  }

  /** Disarm every wait; nothing is posted or asked after this. */
  close(): void {
    this.closed = true;
    for (const track of this.tracks.values()) {
      this.clearFinisher(track);
      this.clearResync(track);
    }
  }

  /**
   * The engine wrote a Message's text. A finalized Message whose text moved
   * is read again at the dispatch's end; the pending finisher starts with
   * the first text, not with an empty mint.
   */
  textWritten(messageKey: string, text: string): void {
    const track = this.tracks.get(messageKey);
    if (track === undefined) return;
    if (track.text !== text) {
      track.text = text;
      // The hash describes the text it was taken of. A finalized Message's
      // text can still move (a terminal whole frame repairing a lost delta),
      // and its record is then no longer proven current until tugcast
      // renders the new text.
      track.finalHash = null;
      if (!track.streaming) this.moved.add(messageKey);
    }
    // The pending finisher bounds how long text goes undrawn, so it starts
    // with the first text, not with an empty mint.
    if (track.last === null && track.finisher === null && !track.nulled && text !== "") {
      this.armFinisher(messageKey, track);
    }
  }

  /**
   * After each dispatch: a live assistant-text or thinking Message that just
   * minted is written `pending` (or gets the render that beat it here), and a
   * streaming one that is no longer the pending turn's last Message is
   * finalized. Renders still waiting on a Message are dropped at turn end.
   */
  afterDispatch(view: RenderDispatchView): void {
    const { pendingTurnKey, last } = view;
    const out: RenderedEntry[] = [];
    for (const key of [...this.streaming]) {
      const track = this.tracks.get(key)!;
      if (last !== undefined && last.messageKey === key && pendingTurnKey === track.turnKey) continue;
      this.finalize(key, track, out);
    }
    for (const key of this.moved) {
      const track = this.tracks.get(key);
      if (track === undefined || track.streaming || track.last === null || track.nulled) continue;
      const current = this.isCurrent(track);
      if (current === track.current) continue;
      track.current = current;
      out.push({
        turnKey: track.turnKey,
        messageKey: key,
        state: { streaming: false, current, message: { ...track.last, html: {} } },
      });
      if (current) this.clearFinisher(track);
      else if (track.finisher === null) this.armFinisher(key, track);
    }
    this.moved.clear();
    if (
      pendingTurnKey !== null &&
      last !== undefined &&
      !view.replaying &&
      last.text !== null &&
      !this.tracks.has(last.messageKey)
    ) {
      const key = last.messageKey;
      const track = newTrack(pendingTurnKey, last.text, true);
      this.tracks.set(key, track);
      this.streaming.add(key);
      const early = this.early.get(key);
      this.early.delete(key);
      if (early !== undefined) {
        this.accept(key, track, early, out);
      } else if (this.host.tugcastRenders()) {
        out.push({ turnKey: track.turnKey, messageKey: key, state: { pending: true } });
        if (track.text !== "") this.armFinisher(key, track);
      }
    }
    if (pendingTurnKey === null) this.early.clear();
    this.prune(view);
    this.post(out);
  }

  /**
   * tugcast's renders for this session. A Message the tracker holds takes
   * the render at once; a committed one it does not (a reload's resync)
   * starts a finalized track; one not minted yet waits for its mint while a
   * turn is pending.
   */
  rendered(messages: ReadonlyArray<RenderedMessageWire>, find: FindTextMessage, turnPending: boolean): void {
    if (this.closed) return;
    const out: RenderedEntry[] = [];
    for (const message of messages) {
      const key = message.messageKey;
      let track = this.tracks.get(key);
      if (track === undefined) {
        const found = find(key);
        if (found === null) {
          if (turnPending) this.early.set(key, mergeRenderedMessage(this.early.get(key) ?? null, message));
          continue;
        }
        track = newTrack(found.turnKey, found.text, false);
        this.tracks.set(key, track);
      }
      this.accept(key, track, message, out);
    }
    this.post(out);
  }

  /** Forget the tracks of turns the transcript no longer holds. */
  private prune(view: RenderDispatchView): void {
    if (view.transcript === this.prunedAgainst) return;
    this.prunedAgainst = view.transcript;
    if (this.tracks.size === 0) return;
    const live = new Set(view.transcript.map((t) => t.turnKey));
    if (view.pendingTurnKey !== null) live.add(view.pendingTurnKey);
    for (const [key, track] of this.tracks) {
      if (live.has(track.turnKey)) continue;
      this.clearFinisher(track);
      this.clearResync(track);
      this.tracks.delete(key);
      this.streaming.delete(key);
    }
  }

  /**
   * Take one emission: read its block list against the last, detect a
   * missing hash, then post the record. A diff off a base the track does
   * not hold is not posted; the Message asks for its whole render instead.
   */
  private accept(key: string, track: RenderTrack, diff: RenderedMessageWire, out: RenderedEntry[]): void {
    const message = expandRenderedMessage(track.last, diff);
    if (message === null) {
      this.wantWhole(key, track);
      return;
    }
    let missing = false;
    const seen = new Set<string>();
    for (const block of message.blocks) {
      if (block.hash in message.html || track.seen.has(block.hash)) seen.add(block.hash);
      else missing = true;
    }
    track.seen = seen;
    if (missing) {
      this.wantWhole(key, track);
    } else {
      track.incomplete = false;
      track.resyncAsks = 0;
      this.clearResync(track);
    }
    track.last = { ...message, html: {} };
    track.current = !track.streaming && this.isCurrent(track);
    track.nulled = false;
    out.push({
      turnKey: track.turnKey,
      messageKey: key,
      state: { streaming: track.streaming, current: track.current, message },
    });
    if (track.streaming || track.current) {
      this.clearFinisher(track);
    } else if (track.finisher === null) {
      this.armFinisher(key, track);
    }
  }

  /**
   * The Message stopped being the pending turn's last: re-post its last
   * render as not streaming, with whether it is current. One with no render
   * keeps the finisher its mint armed.
   */
  private finalize(key: string, track: RenderTrack, out: RenderedEntry[]): void {
    track.streaming = false;
    this.streaming.delete(key);
    if (track.last === null) return;
    track.current = this.isCurrent(track);
    out.push({
      turnKey: track.turnKey,
      messageKey: key,
      state: { streaming: false, current: track.current, message: { ...track.last, html: {} } },
    });
    if (track.current) this.clearFinisher(track);
    else if (track.finisher === null) this.armFinisher(key, track);
  }

  /** Whether the last render describes exactly the Message's text. */
  private isCurrent(track: RenderTrack): boolean {
    const last = track.last;
    if (last === null || last.textLength !== track.text.length) return false;
    track.finalHash ??= textHash(track.text);
    return last.textHash === track.finalHash;
  }

  private armFinisher(key: string, track: RenderTrack): void {
    track.finisher = this.host.timerSource.setTimeout(() => {
      track.finisher = null;
      if (this.closed || this.tracks.get(key) !== track || track.nulled) return;
      const unproven = track.last === null || (!track.streaming && !track.current);
      if (!unproven) return;
      track.nulled = true;
      // The page drops what it held with the record; nothing it saw survives.
      track.seen = new Set();
      this.post([{ turnKey: track.turnKey, messageKey: key, state: null }]);
    }, RENDER_FINISHER_MS);
  }

  private clearFinisher(track: RenderTrack): void {
    if (track.finisher === null) return;
    this.host.timerSource.clearTimeout(track.finisher);
    track.finisher = null;
  }

  /**
   * The Message's render is incomplete: ask tugcast for it whole, unless an
   * ask is already waiting out its backoff. The wait doubles with each ask;
   * when it ends with the Message still incomplete, the next ask goes.
   */
  private wantWhole(key: string, track: RenderTrack): void {
    track.incomplete = true;
    if (track.resyncTimer !== null || track.resyncAsks >= RENDER_RESYNC_ASKS) return;
    this.host.askWhole(key);
    const wait = Math.min(RENDER_RESYNC_BACKOFF_MS * 2 ** track.resyncAsks, RENDER_RESYNC_MAX_MS);
    track.resyncAsks += 1;
    track.resyncTimer = this.host.timerSource.setTimeout(() => {
      track.resyncTimer = null;
      if (this.closed || this.tracks.get(key) !== track || !track.incomplete) return;
      this.wantWhole(key, track);
    }, wait);
  }

  private clearResync(track: RenderTrack): void {
    if (track.resyncTimer === null) return;
    this.host.timerSource.clearTimeout(track.resyncTimer);
    track.resyncTimer = null;
  }

  private post(entries: RenderedEntry[]): void {
    if (entries.length === 0) return;
    this.host.post(entries);
  }
}
