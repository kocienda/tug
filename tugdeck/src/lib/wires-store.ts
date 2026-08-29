/**
 * `wiresStore` — the [L02] store behind the **Wires** card.
 *
 * The wires ledger is machine-global and written by processes this deck does
 * not talk to: another instance's engine claims a trip, a `tugutil wire`
 * invocation lays one from a terminal. There is no feed that carries those, so
 * the card asks — `GET /api/wires` — and asks again while it is on screen.
 *
 * Two things bring it back sooner than the poll would. A knob write adopts the
 * wire the server answers with, so a settled control shows what the ledger
 * holds rather than what the click hoped. And an OVERVIEW frame authored by
 * the Tripwire means a trip just settled, which is exactly when the list is
 * stale — so the store refreshes on it instead of waiting out the interval.
 *
 * Polling is retained rather than unconditional: `retain()` while the card is
 * mounted, `release()` when it goes. A deck with no Wires card open makes no
 * requests at all.
 *
 * @module lib/wires-store
 */

import { FeedId } from "../protocol";
import type { TugConnection } from "../connection";
import { getConnection } from "./connection-singleton";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/** How often the card re-asks while it is on screen. */
const POLL_INTERVAL_MS = 5_000;

/** One wire, as `GET /api/wires` projects it. */
export interface WireRow {
  readonly name: string;
  readonly trigger: string;
  readonly scope: string | null;
  readonly probe: string | null;
  readonly brief: string;
  readonly model: string | null;
  readonly tier: string;
  readonly permission_mode: string;
  readonly post: string;
  readonly paused: boolean;
  readonly cooldown_secs: number;
  /** A trip is running for this wire right now. */
  readonly running: boolean;
  /** The dash a settled trip staged and nobody has joined or discarded. */
  readonly staged_dash: string | null;
  readonly last_trip: WireLastTrip | null;
}

export interface WireLastTrip {
  readonly at_ms: number;
  readonly status: string;
  readonly interest: string | null;
  readonly outcome: string | null;
  readonly headline: string | null;
}

/** One firing, as `GET /api/wires/<name>/trips` serializes the row. */
export interface TripRow {
  readonly id: number;
  readonly wire_id: number;
  readonly event_key: string;
  readonly at_ms: number;
  readonly instance: string;
  readonly status: string;
  readonly swallow_reason: string | null;
  readonly probe_exit: number | null;
  readonly probe_tail: string | null;
  readonly session_id: string | null;
  readonly dash: string | null;
  readonly interest: string | null;
  readonly outcome: string | null;
  readonly headline: string | null;
  readonly refs: string | null;
  readonly settled_at_ms: number | null;
}

export interface WiresSnapshot {
  readonly wires: readonly WireRow[];
  /** Trip logs, keyed by wire name, for wires the card has opened. */
  readonly trips: Readonly<Record<string, readonly TripRow[]>>;
  /** Non-null when the last read failed. The rows stay as they were. */
  readonly error: string | null;
  /** False until the first answer lands, so the card can tell empty from
   *  unasked — an empty list and a list nobody has fetched look identical. */
  readonly loaded: boolean;
}

const EMPTY: WiresSnapshot = Object.freeze({
  wires: [],
  trips: {},
  error: null,
  loaded: false,
});

export class WiresStore {
  private snapshot: WiresSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private unsubFeed: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retainCount = 0;

  constructor(conn: TugConnection | null) {
    if (conn === null) {
      tugDevLogStore.warn("wires-store", "no connection at construction; live refresh inactive");
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

  getSnapshot = (): WiresSnapshot => this.snapshot;

  /**
   * Start polling, or join a poll already running. Balanced by `release`;
   * the card calls both from one effect, so a remount cannot leak an
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
      const resp = await fetch("/api/wires");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { wires?: WireRow[] };
      this.commit({ wires: body.wires ?? [], error: null, loaded: true });
    } catch (err) {
      this.commit({ error: String(err), loaded: true });
    }
  }

  /** Read one wire's trip log — the card's second level. */
  async loadTrips(name: string): Promise<void> {
    try {
      const resp = await fetch(`/api/wires/${encodeURIComponent(name)}/trips`);
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
   * Write one of the card's knobs and adopt the wire the server answers with.
   *
   * The answer is the ledger's row, not the request's echo, so a write the
   * ledger refused leaves the control showing what is actually stored rather
   * than a state nothing is in.
   */
  async setKnobs(
    name: string,
    knobs: { paused?: boolean; model?: string | null; post?: string },
  ): Promise<void> {
    try {
      const resp = await fetch(`/api/wires/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(knobs),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { wire?: WireRow };
      if (body.wire === undefined) {
        await this.refresh();
        return;
      }
      const wire = body.wire;
      this.commit({
        wires: this.snapshot.wires.map((w) => (w.name === wire.name ? wire : w)),
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
   * every other post on the feed says nothing about a wire, and refreshing on
   * all of them would make the card's request rate the deck's post rate.
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
    // A settled trip changes the log of exactly the wires already open, and
    // those are the only ones worth re-reading.
    for (const name of Object.keys(this.snapshot.trips)) void this.loadTrips(name);
  }

  private commit(next: Partial<WiresSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...next });
    for (const listener of this.listeners) listener();
  }
}

let singleton: WiresStore | null = null;

export function getWiresStore(): WiresStore {
  if (singleton === null) singleton = new WiresStore(getConnection());
  return singleton;
}

/** Test seam — drop the singleton so the next `get` builds a fresh one. */
export function resetWiresStoreForTests(): void {
  singleton?.dispose();
  singleton = null;
}
