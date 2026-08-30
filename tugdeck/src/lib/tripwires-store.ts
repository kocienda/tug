/**
 * `tripwiresStore` — the [L02] store behind the **Tripwires** Lens section.
 *
 * The tripwires ledger is machine-global and written by processes this deck does
 * not talk to: another instance's engine claims a trip, a `tugtool tripwire`
 * invocation lays one from a terminal. There is no feed that carries those, so
 * the section asks — `GET /api/tripwires` — and asks again while it is open.
 *
 * Two things bring it back sooner than the poll would. A knob write adopts the
 * tripwire the server answers with, so a settled control shows what the ledger
 * holds rather than what the click hoped. And an OVERVIEW frame authored by
 * the Tripwire means a trip just settled, which is exactly when the list is
 * stale — so the store refreshes on it instead of waiting out the interval.
 *
 * Polling is retained rather than unconditional: `retain()` while the section is
 * mounted, `release()` when it goes. A deck with the Tripwires section out of
 * sight makes no requests at all.
 *
 * @module lib/tripwires-store
 */

import { FeedId } from "../protocol";
import type { TugConnection } from "../connection";
import { getConnection } from "./connection-singleton";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/** How often the section re-asks while it is open. */
const POLL_INTERVAL_MS = 5_000;

/** One tripwire, as `GET /api/tripwires` projects it. */
export interface TripwireRow {
  readonly name: string;
  readonly trigger: string;
  readonly scope: string | null;
  readonly probe: string | null;
  readonly brief: string;
  readonly model: string | null;
  /** The base branch a landing has to be onto for this wire to fire. */
  readonly branch: string;
  readonly permission_mode: string;
  readonly paused: boolean;
  /** A trip is running for this tripwire right now. */
  readonly running: boolean;
  /** The running trip's session, when it has one. A trip still inside its
   *  probe is running with no session yet, and the two dots differ. */
  readonly running_session: string | null;
  /** A run finished with something the user should see and is holding until
   *  they see it ([P07]) — the state the row's yellow dot reads. */
  readonly awaiting: boolean;
  /** The dash that awaiting trip is holding, when it authored one. */
  readonly awaiting_dash: string | null;
  readonly last_trip: TripwireLastTrip | null;
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
  readonly probe_exit: number | null;
  readonly probe_tail: string | null;
  readonly session_id: string | null;
  readonly dash: string | null;
  readonly headline: string | null;
  readonly refs: string | null;
  readonly settled_at_ms: number | null;
}

export interface TripwiresSnapshot {
  readonly tripwires: readonly TripwireRow[];
  /** Trip logs, keyed by tripwire name, for tripwires the section has opened. */
  readonly trips: Readonly<Record<string, readonly TripRow[]>>;
  /** Non-null when the last read failed. The rows stay as they were. */
  readonly error: string | null;
  /** False until the first answer lands, so the section can tell empty from
   *  unasked — an empty list and a list nobody has fetched look identical. */
  readonly loaded: boolean;
}

const EMPTY: TripwiresSnapshot = Object.freeze({
  tripwires: [],
  trips: {},
  error: null,
  loaded: false,
});

export class TripwiresStore {
  private snapshot: TripwiresSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private unsubFeed: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retainCount = 0;

  constructor(conn: TugConnection | null) {
    if (conn === null) {
      tugDevLogStore.warn("tripwires-store", "no connection at construction; live refresh inactive");
      return;
    }
    this.unsubFeed = conn.onFrame(FeedId.OVERVIEW, (payload) => this.onOverview(payload));
  }

  dispose(): void {
    this.unsubFeed?.();
    this.unsubFeed = null;
    this.stopPolling();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TripwiresSnapshot => this.snapshot;

  /**
   * Start polling, or join a poll already running. Balanced by `release`;
   * the section calls both from one effect, so a remount cannot leak an
   * interval.
   */
  retain(): void {
    this.retainCount += 1;
    if (this.retainCount === 1) {
      void this.refresh();
      this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    }
  }

  release(): void {
    this.retainCount = Math.max(0, this.retainCount - 1);
    if (this.retainCount === 0) this.stopPolling();
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Re-read the list. Errors keep the rows they could not replace. */
  async refresh(): Promise<void> {
    try {
      const resp = await fetch("/api/tripwires");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { tripwires?: TripwireRow[] };
      this.commit({ tripwires: body.tripwires ?? [], error: null, loaded: true });
    } catch (err) {
      this.commit({ error: String(err), loaded: true });
    }
  }

  /** Read one tripwire's trip log — the section's second level. */
  async loadTrips(name: string): Promise<void> {
    try {
      const resp = await fetch(`/api/tripwires/${encodeURIComponent(name)}/trips`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { trips?: TripRow[] };
      this.commit({
        trips: { ...this.snapshot.trips, [name]: body.trips ?? [] },
        error: null,
      });
    } catch (err) {
      this.commit({ error: String(err) });
    }
  }

  /**
   * Write one of the section's knobs and adopt the tripwire the server answers with.
   *
   * The answer is the ledger's row, not the request's echo, so a write the
   * ledger refused leaves the control showing what is actually stored rather
   * than a state nothing is in.
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
      if (body.tripwire === undefined) {
        await this.refresh();
        return;
      }
      const tripwire = body.tripwire;
      this.commit({
        tripwires: this.snapshot.tripwires.map((w) => (w.name === tripwire.name ? tripwire : w)),
        error: null,
      });
    } catch (err) {
      // The ledger is the authority on what happened, and after a failed write
      // this store no longer knows. Ask.
      await this.refresh();
      // Then say what went wrong — after the refresh, not before it. A
      // successful re-read clears `error`, so setting the reason first meant
      // the control settled back to the ledger's value with no word about why,
      // which is a refused gesture that produced neither the act nor a reason
      // [L31].
      this.commit({ error: String(err) });
    }
  }

  /**
   * A Tripwire-authored post means a trip settled. Only that author refreshes:
   * every other post on the feed says nothing about a tripwire, and refreshing on
   * all of them would make the section's request rate the deck's post rate.
   */
  private onOverview(payload: Uint8Array): void {
    let author: unknown;
    try {
      author = (JSON.parse(new TextDecoder().decode(payload)) as { author?: unknown }).author;
    } catch {
      return;
    }
    if (author !== "tripwire") return;
    void this.refresh();
    // A settled trip changes the log of exactly the tripwires already open, and
    // those are the only ones worth re-reading.
    for (const name of Object.keys(this.snapshot.trips)) void this.loadTrips(name);
  }

  private commit(next: Partial<TripwiresSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...next });
    for (const listener of this.listeners) listener();
  }
}

let singleton: TripwiresStore | null = null;

export function getTripwiresStore(): TripwiresStore {
  if (singleton === null) singleton = new TripwiresStore(getConnection());
  return singleton;
}

/** Test seam — drop the singleton so the next `get` builds a fresh one. */
export function resetTripwiresStoreForTests(): void {
  singleton?.dispose();
  singleton = null;
}
