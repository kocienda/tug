/**
 * `PulseStore` — app-scoped snapshot cache for PULSE commentary lines.
 *
 * Hydrates from tugcast's pulse ledger on first observation (one
 * `list_pulse_lines` CONTROL round-trip — the
 * `session-state-changes-reader` pattern), then folds live `PULSE`
 * feed frames as the commentator speaks. The response carries both
 * halves the strip shows: a per-scope window of beats, and every
 * scope's standing overview — so a card comes back from a relaunch
 * wearing its headline instead of blank. The snapshot also carries
 * the `pulse/enabled` tugbank default so the strip's
 * hidden-when-disabled state flows from the store, not an ad-hoc
 * fetch.
 *
 * **Laws.** [L02] — external state (wire frames, CONTROL responses,
 * the tugbank toggle) enters React only through `useSyncExternalStore`
 * via {@link usePulse}; snapshots are referentially stable between
 * folds. No persistence here beyond the server's ledger — the deck
 * never caches pulse lines locally.
 */

import { useSyncExternalStore } from "react";

import type { TugConnection } from "@/connection";
import {
  FeedId,
  encodeListPulseLines,
  parsePulseFrame,
  type ListPulseLinesOk,
} from "@/protocol";
import { getTugbankClient } from "@/lib/tugbank-singleton";

/**
 * Mirror of tugcast's tail length — the rolling display cap, applied PER
 * SCOPE. A global cap would undo the per-scope restore the ledger read
 * performs: every selector here filters by session after the fact, so
 * trimming the log app-wide throws away exactly the quiet card's lines the
 * ledger went to the trouble of finding.
 */
export const PULSE_LINES_CAP = 20;

/** Tugbank default holding the kill switch (bool; absent = enabled). */
export const PULSE_ENABLED_DOMAIN = "dev.tugtool.pulse";
export const PULSE_ENABLED_KEY = "enabled";

/** One displayable pulse line. `key` is stable line identity (the
 * strip's fade-in animation keys on it). */
export interface PulseLineEntry {
  key: string;
  text: string;
  /** Retained high-level thought behind a low-level `text` beat —
   *  the strip renders "intent • text" when present. */
  intent?: string;
  scopes: readonly string[];
  beat: number;
  atMs: number;
}

/**
 * One session's standing overview — the agent's answer to "what is this
 * session working on", as opposed to a beat's "what just happened".
 *
 * Deliberately NOT a {@link PulseLineEntry}: overviews never enter the rolling
 * log, the history popover, or the cleared-watermark machinery. They are a
 * latest-per-scope fact that the strip pins above the beat, and they replace
 * each other rather than accumulating.
 */
export interface PulseOverviewEntry {
  text: string;
  scopes: readonly string[];
  beat: number;
  atMs: number;
}

export interface PulseSnapshot {
  /** The `pulse/enabled` toggle; the strip hides entirely when false. */
  enabled: boolean;
  /** Ledger-tail load state; live folds work in any state. */
  status: "idle" | "pending" | "ready";
  /** Rolling log, oldest-first, capped at {@link PULSE_LINES_CAP}. */
  lines: readonly PulseLineEntry[];
  /** Convenience: newest line app-wide, or null before the first. */
  latest: PulseLineEntry | null;
  /**
   * Per-scope cleared watermarks: submitting a new message clears
   * that card's strip, so `cleared.get(scope)` holds the line keys
   * that existed at submit time — the selector skips them; lines
   * arriving afterwards show normally.
   */
  cleared: ReadonlyMap<string, ReadonlySet<string>>;
  /** Latest overview per scope. Empty until the agent produces one. */
  pulseOverviews: ReadonlyMap<string, PulseOverviewEntry>;
}

/**
 * The newest overview about `scope`, or null.
 *
 * Same scope rule as {@link latestLineForScope}: a card shows its own session's
 * overview, and an `"app"`-scoped one (which is also where an unscoped frame
 * files) shows everywhere. The session's own always wins.
 */
export function latestPulseOverviewForScope(
  pulseOverviews: ReadonlyMap<string, PulseOverviewEntry>,
  scope: string,
): PulseOverviewEntry | null {
  if (scope.length === 0) return null;
  return pulseOverviews.get(scope) ?? pulseOverviews.get(OVERVIEW_APP_SCOPE) ?? null;
}

/** Where an unscoped or explicitly app-wide overview files. */
const OVERVIEW_APP_SCOPE = "app";

/**
 * Trim `lines` (oldest-first) so no scope keeps more than `cap` of them,
 * preserving order. A line covering several scopes counts against each but
 * is kept once; unscoped app-wide ambience gets a window of its own.
 *
 * The mirror of tugcast's `list_pulse_lines_per_scope`, and needed for the
 * same reason on this side of the wire.
 */
export function capLinesPerScope(
  lines: readonly PulseLineEntry[],
  cap: number,
): PulseLineEntry[] {
  const taken = new Map<string, number>();
  const kept: PulseLineEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const keys = line.scopes.length > 0 ? line.scopes : [""];
    if (!keys.some((key) => (taken.get(key) ?? 0) < cap)) continue;
    for (const key of keys) taken.set(key, (taken.get(key) ?? 0) + 1);
    kept.push(line);
  }
  kept.reverse();
  return kept;
}

/**
 * The newest line about `scope` — a card's strip shows commentary
 * about ITS session, never another card's. A line whose `scopes`
 * include the literal `"app"` (or carry no scopes at all) is
 * app-wide ambience and shows everywhere; a multi-scope line shows
 * on every card it covers — that's the cross-session weave working,
 * not a leak.
 */
export function latestLineForScope(
  lines: readonly PulseLineEntry[],
  scope: string,
  clearedKeys?: ReadonlySet<string>,
): PulseLineEntry | null {
  if (scope.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (clearedKeys?.has(line.key) === true) continue;
    if (
      line.scopes.length === 0 ||
      line.scopes.includes(scope) ||
      line.scopes.includes("app")
    ) {
      return line;
    }
  }
  return null;
}

/**
 * The newest `limit` lines about `scope`, newest-first — the strip's history
 * popover. Same scope rule as {@link latestLineForScope} (the session's own
 * lines plus `app`-wide / unscoped ambience); cleared watermarks are NOT
 * applied, since the history shows what actually happened.
 */
export function linesForScope(
  lines: readonly PulseLineEntry[],
  scope: string,
  limit: number,
): PulseLineEntry[] {
  const out: PulseLineEntry[] = [];
  if (scope.length === 0) return out;
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (
      line.scopes.length === 0 ||
      line.scopes.includes(scope) ||
      line.scopes.includes("app")
    ) {
      out.push(line);
    }
  }
  return out;
}

/** One intent-group of the history: the retained goal (absent for a
 *  standalone-monologue run) over the beats that ran beneath it. */
export interface PulseHistoryGroup {
  intent?: string;
  beats: PulseLineEntry[];
}

/**
 * Fold a line list into intent groups: a run of consecutive lines
 * sharing one `intent` collapses under that goal, so a retained goal
 * shows ONCE as a group heading in the history popover instead of
 * repeating on every beat row. Lines carry a contiguous intent while a
 * tool chain runs, so consecutive grouping tracks the timeline exactly.
 * Input order is preserved (the caller passes newest-first).
 */
export function groupPulseHistory(
  lines: readonly PulseLineEntry[],
): PulseHistoryGroup[] {
  const groups: PulseHistoryGroup[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.intent === line.intent) {
      last.beats.push(line);
    } else {
      groups.push({ intent: line.intent, beats: [line] });
    }
  }
  return groups;
}

const EMPTY_LINES: readonly PulseLineEntry[] = Object.freeze([]);
const EMPTY_CLEARED: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const EMPTY_PULSE_OVERVIEWS: ReadonlyMap<string, PulseOverviewEntry> = new Map();
const IDLE_SNAPSHOT: PulseSnapshot = Object.freeze({
  enabled: true,
  status: "idle",
  lines: EMPTY_LINES,
  latest: null,
  cleared: EMPTY_CLEARED,
  pulseOverviews: EMPTY_PULSE_OVERVIEWS,
});

// ---------------------------------------------------------------------------
// CONTROL response bus — action-dispatch publishes, the store consumes.
// ---------------------------------------------------------------------------

type OkListener = (payload: ListPulseLinesOk) => void;
const okListeners = new Set<OkListener>();

/** Called by `action-dispatch.ts` when `list_pulse_lines_ok` lands. */
export function publishListPulseLinesOk(payload: ListPulseLinesOk): void {
  for (const listener of [...okListeners]) listener(payload);
}

function subscribeToListPulseLinesOk(listener: OkListener): () => void {
  okListeners.add(listener);
  return () => okListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

function lineKey(atMs: number, beat: number): string {
  return `${atMs}:${beat}`;
}

export class PulseStore {
  private readonly conn: TugConnection;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private snapshot: PulseSnapshot = IDLE_SNAPSHOT;
  private tailRequested = false;

  constructor(conn: TugConnection) {
    this.conn = conn;
    // Live lines fold as the commentator speaks — including while the
    // tail load is still pending (the merge dedupes by line identity).
    this.disposers.push(
      this.conn.onFrame(FeedId.PULSE, (payload) => this._onPulse(payload)),
    );
    this.disposers.push(
      subscribeToListPulseLinesOk((payload) => this.onTail(payload)),
    );
    // The enabled toggle rides the tugbank cache; a DEFAULTS push for
    // the pulse domain re-derives the snapshot.
    const client = getTugbankClient();
    if (client) {
      this.disposers.push(
        client.onDomainChanged((domain) => {
          if (domain !== PULSE_ENABLED_DOMAIN) return;
          this.snapshot = Object.freeze({
            ...this.snapshot,
            enabled: readEnabled(),
          });
          this.tick();
        }),
      );
    }
  }

  dispose(): void {
    for (const fn of this.disposers) fn();
    this.disposers.length = 0;
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * A new message was submitted for `scope`: everything currently on
   * the log is "before" for that card — its strip clears until the
   * next line arrives. Called by `CodeSessionStore.send`.
   */
  clearScope(scope: string): void {
    if (scope.length === 0) return;
    const keys = new Set(this.snapshot.lines.map((l) => l.key));
    const cleared = new Map(this.snapshot.cleared);
    cleared.set(scope, keys);
    this.snapshot = Object.freeze({ ...this.snapshot, cleared });
    this.tick();
  }

  /**
   * Current snapshot. The first call kicks the one-shot ledger-tail
   * CONTROL request; live folds keep working regardless of its fate.
   */
  getSnapshot = (): PulseSnapshot => {
    if (!this.tailRequested) {
      this.tailRequested = true;
      this.snapshot = Object.freeze({
        ...this.snapshot,
        status: "pending" as const,
        enabled: readEnabled(),
      });
      const frame = encodeListPulseLines();
      this.conn.send(frame.feedId, frame.payload);
    }
    return this.snapshot;
  };

  /**
   * One PULSE frame off the wire. Overviews fold into the per-scope standing
   * line; everything else joins the rolling beat log.
   *
   * Named rather than inlined at the subscription so the app-test surface can
   * reach it with bytes the wire would otherwise have supplied
   * ({@link _ingestPulseFrameForTest}) — the parse and both folds are then
   * exactly the production ones.
   */
  private _onPulse(payload: Uint8Array): void {
    const line = parsePulseFrame(payload);
    if (line === null) return;
    if (line.kind === "overview") {
      this.foldPulseOverview(line);
      return;
    }
    this.fold([
      {
        key: lineKey(line.at, line.beat),
        text: line.text,
        ...(line.intent !== undefined ? { intent: line.intent } : {}),
        scopes: Object.freeze([...line.scopes]),
        beat: line.beat,
        atMs: line.at,
      },
    ]);
  }

  private onTail(payload: ListPulseLinesOk): void {
    const tail: PulseLineEntry[] = payload.lines.map((row) =>
      Object.freeze({
        key: lineKey(row.at_ms, row.beat),
        text: row.text,
        ...(typeof row.intent === "string" && row.intent.length > 0
          ? { intent: row.intent }
          : {}),
        scopes: Object.freeze([...row.scopes]) as readonly string[],
        beat: row.beat,
        atMs: row.at_ms,
      }),
    );
    // Restored overviews seed the per-scope standing line. A live frame
    // that landed while the load was in flight is NEWER than what the
    // ledger holds, so it wins — the tail seeds a scope, never overwrites
    // a fresher statement about it.
    const pulseOverviews = new Map(this.snapshot.pulseOverviews);
    for (const row of payload.overviews) {
      if (typeof row.scope !== "string" || row.scope.length === 0) continue;
      const held = pulseOverviews.get(row.scope);
      if (held !== undefined && held.atMs >= row.at_ms) continue;
      pulseOverviews.set(
        row.scope,
        Object.freeze({
          text: row.text,
          scopes: Object.freeze([row.scope]) as readonly string[],
          beat: row.beat,
          atMs: row.at_ms,
        }),
      );
    }
    this.snapshot = Object.freeze({ ...this.snapshot, pulseOverviews });
    // Tail (history) first, then any live lines that landed while the
    // load was in flight; dedupe on line identity.
    const live = this.snapshot.lines;
    const seen = new Set(tail.map((l) => l.key));
    const merged = [...tail];
    for (const line of live) {
      if (seen.has(line.key)) continue;
      seen.add(line.key);
      merged.push(line);
    }
    this.commit(merged, "ready");
  }

  /**
   * Replace the overview for every scope the frame names. An overview is a
   * standing statement, so the newest one wins outright — there is no log to
   * append to and nothing to dedupe against.
   */
  private foldPulseOverview(line: {
    text: string;
    scopes: string[];
    beat: number;
    at: number;
  }): void {
    const entry: PulseOverviewEntry = Object.freeze({
      text: line.text,
      scopes: Object.freeze([...line.scopes]) as readonly string[],
      beat: line.beat,
      atMs: line.at,
    });
    const scopes = line.scopes.length > 0 ? line.scopes : [OVERVIEW_APP_SCOPE];
    const pulseOverviews = new Map(this.snapshot.pulseOverviews);
    for (const scope of scopes) pulseOverviews.set(scope, entry);
    this.snapshot = Object.freeze({ ...this.snapshot, pulseOverviews });
    this.tick();
  }

  private fold(incoming: PulseLineEntry[]): void {
    const seen = new Set(this.snapshot.lines.map((l) => l.key));
    const fresh = incoming.filter((l) => !seen.has(l.key));
    if (fresh.length === 0) return;
    this.commit([...this.snapshot.lines, ...fresh], this.snapshot.status);
  }

  private commit(
    lines: PulseLineEntry[],
    status: PulseSnapshot["status"],
  ): void {
    const capped = capLinesPerScope(lines, PULSE_LINES_CAP);
    this.snapshot = Object.freeze({
      enabled: this.snapshot.enabled,
      status,
      lines: Object.freeze(capped) as readonly PulseLineEntry[],
      latest: capped.length > 0 ? capped[capped.length - 1] : null,
      cleared: this.snapshot.cleared,
      pulseOverviews: this.snapshot.pulseOverviews,
    });
    this.tick();
  }

  private tick(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The `pulse/enabled` tugbank default; absent reads as enabled. */
function readEnabled(): boolean {
  const client = getTugbankClient();
  if (!client) return true;
  const entry = client.get(PULSE_ENABLED_DOMAIN, PULSE_ENABLED_KEY);
  if (entry === undefined) return true;
  return entry.value !== false;
}

// ---------------------------------------------------------------------------
// Singleton + hook
// ---------------------------------------------------------------------------

let _activeStore: PulseStore | null = null;

export function attachPulseStore(conn: TugConnection): PulseStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new PulseStore(conn);
  return _activeStore;
}

export function getPulseStore(): PulseStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetPulseStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/**
 * Test-only: feed a PULSE frame body as if it arrived over the wire.
 *
 * Not a mock — the bytes go through the production `parsePulseFrame` and the
 * production folds, so what the components see is what the wire would have
 * produced. `parsePulseFrame` rejects a malformed body silently, so a caller
 * must assert on rendered output rather than on having called this.
 */
export function _ingestPulseFrameForTest(body: unknown): void {
  if (_activeStore === null) return;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  // Reach the private handler through the same path onFrame would.
  (_activeStore as unknown as { _onPulse(p: Uint8Array): void })._onPulse(bytes);
}

/**
 * React hook: the app-wide pulse snapshot. Returns the idle snapshot
 * when no store is attached (gallery / fixtures).
 */
export function usePulse(): PulseSnapshot {
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

/**
 * React hook: just the `pulse/enabled` toggle. A narrow selector (boolean,
 * no identity churn) so a subscriber re-renders only when the kill switch
 * flips, not on every new line — the session card reads this to decide whether
 * the PULSE strip occupies a row in its keyboard-focus cycle.
 */
/**
 * React hook: the standing overview for one scope, or null.
 *
 * A narrow selector — a card re-renders on its own overview changing, not on
 * every beat that crosses the strip.
 */
export function usePulseOverview(scope: string): PulseOverviewEntry | null {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () =>
      latestPulseOverviewForScope(
        _activeStore?.getSnapshot().pulseOverviews ?? EMPTY_PULSE_OVERVIEWS,
        scope,
      ),
    () => null,
  );
}

export function usePulseEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.getSnapshot().enabled ?? IDLE_SNAPSHOT.enabled,
    () => IDLE_SNAPSHOT.enabled,
  );
}
