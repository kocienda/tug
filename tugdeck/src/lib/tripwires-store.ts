/**
 * `tripwiresStore` — the [L02] store behind the **Tripwires** rail section.
 *
 * The roster arrives on its own feed. `TRIPWIRES` carries every laid tripwire
 * with its live state, republished whenever the machine-global ledger moves —
 * by this instance's engine, by an HTTP write, by a `tugtool tripwire` in a
 * terminal, or by another instance entirely. So the store never asks for the
 * roster; it holds what the last frame said.
 *
 * The per-tripwire **trip log** is still a request, because it is per-tripwire
 * and up to five hundred rows — pushing every log to every client would be the
 * old poll's cost without the poll's bound. What retires the poll for the log
 * too is `trip_log_revision`: each roster row carries an opaque token over that
 * tripwire's log, and an open log is re-asked exactly when its token moves.
 *
 * **Nothing asks for the roster on mount, and that is not merely redundant —
 * there is no window in which it would have helped.** Three mechanisms line
 * up. The server's `snapshot_watches` delivers the latest frame to every
 * client on connect, and re-delivers when a subscription later adds the feed.
 * `TugConnection.onFrame` replays that feed's last payload to a late
 * subscriber, so a store constructed after the frame arrived still sees it.
 * And `lastPayload` is cleared on socket close, so a subscriber registering in
 * response to a close cannot observe pre-close frames — the post-reconnect
 * handshake replays whatever is current ([D05]).
 *
 * @module lib/tripwires-store
 */

import { FeedId } from "../protocol";
import type { TugConnection } from "../connection";
import { getConnection } from "./connection-singleton";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/**
 * How many trips a log read asks for.
 *
 * The whole of what the ledger keeps, and named rather than left to the
 * server's default: `tripwire_ledger` prunes each tripwire's settled trips
 * back to five hundred at claim time, the HTTP surface clamps a named limit to
 * the same five hundred, and the fold's older-trips cue pages through what
 * arrived. Asking for the default — fifty — made that cue bottom out four
 * hundred and fifty rows short of the log, with nothing on the card saying a
 * log went on. One number, so what the ledger remembers and what the card can
 * page to are the same fact.
 */
const LOG_WINDOW_ROWS = 500;

/** One tripwire, as the roster projects it. */
export interface TripwireRow {
  readonly name: string;
  readonly trigger: string;
  readonly scope: string | null;
  readonly probe: string | null;
  readonly brief: string;
  readonly model: string | null;
  /** The base branch a landing has to be onto for this tripwire to fire. */
  readonly branch: string;
  readonly permission_mode: string;
  readonly paused: boolean;
  /** A trip is running for this tripwire right now. */
  readonly running: boolean;
  /** A trip's session has been taken over by a Session card, and the user is
   *  working in it. Not a hold on the tripwire — it may fire again while they
   *  work — but the session is alive and the row's live dot reaches it. */
  readonly adopted: boolean;
  /** The running trip's session, when it has one. A trip still inside its
   *  probe is running with no session yet, and the two dots differ. Carries
   *  the **adopted** trip's session when nothing is running, so a row does not
   *  go dark at the moment somebody takes its session over. */
  readonly running_session: string | null;
  /** A run finished with something the user should see and is holding until
   *  they see it ([P07]) — the state the row's yellow dot reads. */
  readonly awaiting: boolean;
  /** The arc that awaiting trip is holding, when it authored one. */
  readonly awaiting_arc: string | null;
  readonly last_trip: TripwireLastTrip | null;
  /** An opaque equality token over this tripwire's trip log. Nothing may order
   *  or subtract two of them — the only question it answers is whether an open
   *  log is stale, which is what lets the log be a request with no timer. */
  readonly trip_log_revision: number;
}

export interface TripwireLastTrip {
  readonly at_ms: number;
  readonly status: string;
  readonly headline: string | null;
}

/** One firing, as `GET /api/tripwires/<name>/trips` serializes the row. */
export interface TripRow {
  readonly id: number;
  readonly tripwire_id: number;
  readonly event_key: string;
  readonly at_ms: number;
  readonly instance: string;
  readonly status: string;
  readonly swallow_reason: string | null;
  readonly event_payload: string | null;
  readonly probe_exit: number | null;
  readonly probe_tail: string | null;
  readonly session_id: string | null;
  readonly arc: string | null;
  readonly headline: string | null;
  readonly refs: string | null;
  readonly settled_at_ms: number | null;
  /** What a resolution asked to have authored, when it asked for anything.
   *  `null` on a resolution that settled the firing outright. */
  readonly author_ask: string | null;
}

export interface TripwiresSnapshot {
  readonly tripwires: readonly TripwireRow[];
  /** Trip logs, keyed by tripwire name, for tripwires the section has opened. */
  readonly trips: Readonly<Record<string, readonly TripRow[]>>;
  /** Why one tripwire's trip log could not be read, keyed by tripwire name,
   *  for the tripwires whose last log read failed. A log belongs to the row it
   *  is under, so its failure is reported there and not as a strip over the
   *  whole card ([B10]); the entry is cleared the next time that log reads. */
  readonly logErrors: Readonly<Record<string, string>>;
  /** Non-null when the roster itself could not be read, or a write against it
   *  failed. The rows stay as they were. A log fetch's failure is scoped to
   *  its own row in `logErrors` rather than landing here. */
  readonly error: string | null;
  /** False until the first frame lands, so the section can tell empty from
   *  unasked — an empty list and a list nobody has heard about look identical. */
  readonly loaded: boolean;
}

const EMPTY: TripwiresSnapshot = Object.freeze({
  tripwires: [],
  trips: {},
  logErrors: {},
  error: null,
  loaded: false,
});

export class TripwiresStore {
  private snapshot: TripwiresSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private unsubFeed: (() => void) | null = null;
  /**
   * Which revision each open log was last loaded against. Store-private on
   * purpose ([#state-zone-mapping]): it is bookkeeping about a fetch rather
   * than a fact any component renders, and putting it in the frozen snapshot
   * would make every log load publish a notification that changes nothing on
   * screen.
   */
  private readonly loadedRevisions = new Map<string, number>();

  constructor(conn: TugConnection | null) {
    if (conn === null) {
      tugDevLogStore.warn("tripwires-store", "no connection at construction; no roster feed");
      // The frame is the store's only roster input, so a card built over no
      // connection would otherwise sit at `loaded: false` with nothing to say
      // — a surface that refuses in silence, which is what [L31] forbids.
      this.commit({
        error: "no connection to the server, so the tripwire roster cannot be read",
        loaded: true,
      });
      return;
    }
    this.unsubFeed = conn.onFrame(FeedId.TRIPWIRES, (payload) => this.onFrame(payload));
  }

  dispose(): void {
    this.unsubFeed?.();
    this.unsubFeed = null;
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TripwiresSnapshot => this.snapshot;

  /**
   * A `TRIPWIRES` frame: the whole roster, plus the reason the server could
   * not read it, when it could not.
   *
   * A payload that will not parse keeps the rows it could not replace and says
   * why — the same retain-last-good rule the frame's own error field follows.
   */
  private onFrame(payload: Uint8Array): void {
    let body: { tripwires?: TripwireRow[]; error?: string | null };
    try {
      body = JSON.parse(new TextDecoder().decode(payload)) as typeof body;
    } catch (err) {
      this.commit({ error: `tripwires frame: ${String(err)}`, loaded: true });
      return;
    }
    const tripwires = body.tripwires ?? [];
    this.commit({ tripwires, error: body.error ?? null, loaded: true });

    // A log is re-asked exactly when the roster says its tripwire's log moved,
    // and at no other time. A tripwire gone from the roster takes its cached
    // log with it, because there is nothing left to show it against.
    const live = new Set(tripwires.map((w) => w.name));
    for (const name of Object.keys(this.snapshot.trips)) {
      if (!live.has(name)) this.dropTrips(name);
    }
    for (const tripwire of tripwires) {
      if (!(tripwire.name in this.snapshot.trips)) continue;
      if (this.loadedRevisions.get(tripwire.name) === tripwire.trip_log_revision) continue;
      void this.loadTrips(tripwire.name);
    }
  }

  private dropTrips(name: string): void {
    this.loadedRevisions.delete(name);
    const trips = { ...this.snapshot.trips };
    delete trips[name];
    this.commit({ trips, logErrors: withoutLogError(this.snapshot.logErrors, name) });
  }

  /** Read one tripwire's trip log — what the card's fold opens over. */
  async loadTrips(name: string): Promise<void> {
    try {
      const resp = await fetch(
        `/api/tripwires/${encodeURIComponent(name)}/trips?limit=${LOG_WINDOW_ROWS}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { trips?: TripRow[] };
      // The revision read *here*, as the answer commits — never the one that
      // was current when the request went out. A frame landing mid-flight
      // would otherwise mark a log fresh against a revision its rows predate.
      const current = this.snapshot.tripwires.find((w) => w.name === name);
      if (current !== undefined) this.loadedRevisions.set(name, current.trip_log_revision);
      this.commit({
        trips: { ...this.snapshot.trips, [name]: body.trips ?? [] },
        logErrors: withoutLogError(this.snapshot.logErrors, name),
      });
    } catch (err) {
      // Under the row whose log it is, never over the card: the roster is
      // still whatever the last frame said, and one unreadable log is no
      // reason to put a failure banner across four healthy tripwires [B10].
      this.commit({ logErrors: { ...this.snapshot.logErrors, [name]: String(err) } });
    }
  }

  /**
   * Write one of the section's knobs and adopt the tripwire the server answers with.
   *
   * The answer is the ledger's row, not the request's echo, so a write the
   * ledger refused leaves the control showing what is actually stored rather
   * than a state nothing is in. The frame that follows the same ledger write
   * is authoritative and lands after; the two cannot disagree.
   */
  async setKnobs(
    name: string,
    knobs: { paused?: boolean; model?: string | null },
  ): Promise<void> {
    try {
      const resp = await fetch(`/api/tripwires/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(knobs),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { tripwire?: TripwireRow };
      // An answer with no row in it is the one case where the optimistic adopt
      // has nothing to adopt. Commit nothing: the write happened, and the
      // frame behind it is the authority on what it did.
      if (body.tripwire === undefined) return;
      const tripwire = body.tripwire;
      this.commit({
        tripwires: this.snapshot.tripwires.map((w) => (w.name === tripwire.name ? tripwire : w)),
        error: null,
      });
    } catch (err) {
      // Nothing was committed on a failed write, so nothing follows it and the
      // rows the store holds are still the ledger's. What is owed is the
      // reason: a refused gesture that produced neither the act nor a word
      // about why is what [L31] forbids.
      this.commit({ error: String(err) });
    }
  }

  /**
   * Fire a tripwire by hand — the same queued row `tugtool tripwire trip`
   * writes.
   *
   * Nothing is committed on success, and deliberately: the ledger write nudges
   * the roster feed, and the frame behind it is what moves the rows.
   */
  async trip(name: string): Promise<void> {
    await this.post(`/api/tripwires/${encodeURIComponent(name)}/trip`);
  }

  /**
   * Settle what a tripwire is holding and discard the arc it was holding it
   * with.
   *
   * Two doors on the card press this, and they are one verb under two names:
   * the fold's Seen act on an awaiting trip that authored no arc, and the row
   * menu's Release ([B03]). A trip that authored one is released by that arc's
   * fate instead, which the engine already sweeps.
   */
  async dismiss(name: string): Promise<void> {
    await this.post(`/api/tripwires/${encodeURIComponent(name)}/dismiss`);
  }

  private async post(path: string): Promise<void> {
    try {
      const resp = await fetch(path, { method: "POST" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      this.commit({ error: String(err) });
    }
  }

  private commit(next: Partial<TripwiresSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...next });
    for (const listener of this.listeners) listener();
  }
}

let singleton: TripwiresStore | null = null;

/** The log errors without `name`'s, or the same object when it had none — so a
 *  read that was already fine leaves the map's identity alone, and a surface
 *  keyed on it is not rebuilt for an error that neither arrived nor left. */
function withoutLogError(
  errors: Readonly<Record<string, string>>,
  name: string,
): Readonly<Record<string, string>> {
  if (!(name in errors)) return errors;
  const next = { ...errors };
  delete next[name];
  return next;
}

export function getTripwiresStore(): TripwiresStore {
  if (singleton === null) singleton = new TripwiresStore(getConnection());
  return singleton;
}

/** Test seam — drop the singleton so the next `get` builds a fresh one. */
export function resetTripwiresStoreForTests(): void {
  singleton?.dispose();
  singleton = null;
}
