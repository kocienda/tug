/**
 * `RefsSessionStore` — the per-card `/match` and `/search` runs.
 *
 * Owns the run state (in flight, run id, the accumulating ref list) and is
 * the SOLE consumer of the card's `REFS_OUTPUT` feed. It does NOT own the
 * transcript row: the run's presence there lives in `CodeSessionStore`,
 * which this store feeds through `ingestRefs` on every frame — mint on
 * `refs_started`, replace as `refs_rows` batches land, settle on
 * `refs_complete`. One consumer chain, no dual-ingest race. `REFS_OUTPUT`
 * is deliberately absent from the code-session feed filter, so refs frames
 * reach only this store.
 *
 * The [L02] store surface (`subscribe` / `getSnapshot`) drives the block's
 * in-flight affordance. Session-scoped: the feed is filtered to this card's
 * `tug_session_id`, and every outbound frame stamps it.
 *
 * The accumulated list is also what `/ref N` resolves against, which is why
 * it lives here rather than being derived back out of the transcript.
 */

import { FeedId, type FeedIdValue } from "../protocol";
import type { FeedStore } from "./feed-store";
import { getConnection } from "./connection-singleton";
import { LedgerRestoreFetch } from "./ledger-restore-fetch";
import type { CodeSessionStore } from "./code-session-store";
import type { LinePreview, PreviewSegment, TextRef } from "./code-session-store/types";

/** Which operation a run performs. */
export type RefsOpKind = "match" | "search";

/** Everything a run needs beyond its needles. */
export interface RefsRunOptions {
  kind: RefsOpKind;
  needles: ReadonlyArray<string>;
  /**
   * Flags as the feed's serde struct reads them, already normalized. Mostly
   * booleans; a flag that takes a value (`/search -c 64`) rides as a number.
   */
  flags: Record<string, boolean | number>;
  /** The line the user typed — the block header, echoed back on start. */
  command: string;
}

export interface RefsSessionSnapshot {
  /** The run in flight, or `null` when idle. */
  runId: string | null;
  /** The latest run's refs — what `/ref N` resolves against. */
  refs: ReadonlyArray<TextRef>;
  /** Workspace root the refs' paths are relative to. */
  root: string;
}

export class RefsSessionStore {
  private _snapshot: RefsSessionSnapshot;
  private _listeners = new Set<() => void>();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private _seq = 0;
  private readonly _feedStore: FeedStore;
  private readonly _feedId: FeedIdValue;
  private readonly _tugSessionId: string;
  private readonly _projectDir: string;
  private readonly _codeSessionStore: CodeSessionStore;
  /** The retrying `list_refs` read. */
  private readonly _restoreFetch: LedgerRestoreFetch;
  /** The run being folded — kind/command/timing the frames don't repeat. */
  private _current: {
    runId: string;
    kind: RefsOpKind;
    command: string;
    startedAtMs: number;
    refs: TextRef[];
    notice: string | null;
  } | null = null;

  constructor(
    feedStore: FeedStore,
    feedId: FeedIdValue,
    tugSessionId: string,
    projectDir: string,
    codeSessionStore: CodeSessionStore,
  ) {
    this._feedStore = feedStore;
    this._feedId = feedId;
    this._tugSessionId = tugSessionId;
    this._projectDir = projectDir;
    this._codeSessionStore = codeSessionStore;
    this._snapshot = { runId: null, refs: [], root: projectDir };
    this._unsubscribeFeed = feedStore.subscribe(() => this._onFeedUpdate());
    // Restore: fetch this session's latest run and re-mint its block. Started
    // at construction — HMR preserves the store, so it never re-fires; a
    // Maker ▸ Reload / relaunch builds a fresh store and re-fetches, which is
    // idempotent (upsert by turnKey). The `list_refs_ok` response routes back
    // through action-dispatch to {@link applyRestore}, which settles the
    // fetch. Like the shell ledger, this is the only source for the row.
    this._restoreFetch = new LedgerRestoreFetch({
      action: "list_refs",
      tugSessionId,
      logSource: "refs-restore",
    });
    this._restoreFetch.start();
  }

  /**
   * Apply a `list_refs_ok` answer and stop the restore retry. A `null` run is
   * a real answer — a session that never searched — so it settles the fetch
   * exactly like a populated one.
   */
  applyRestore(run: Record<string, unknown> | null): void {
    this._restoreFetch.settle();
    applyRestoredRefs(this._codeSessionStore, this, run);
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(this._feedId);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;
    this._fold(payload);
  }

  /** Fold one `REFS_OUTPUT` frame into the run state and the transcript. */
  private _fold(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    const runId = typeof p.run_id === "string" ? p.run_id : "";

    if (p.type === "refs_started") {
      this._current = {
        runId,
        kind: p.kind === "match" ? "match" : "search",
        command: typeof p.command === "string" ? p.command : "",
        startedAtMs: numberOr(p.started_at, Date.now()),
        refs: [],
        notice: null,
      };
      this._set({ runId, refs: [], root: this._projectDir });
      this._publish(true, false, null);
      return;
    }

    // A frame from a run that is no longer the current one is a straggler
    // from a superseded run; it must not grow the block that replaced it.
    if (this._current === null || this._current.runId !== runId) return;

    switch (p.type) {
      case "refs_rows": {
        const rows = Array.isArray(p.rows) ? p.rows : [];
        for (const row of rows) {
          const ref = parseTextRef(row);
          if (ref !== null) this._current.refs.push(ref);
        }
        this._set({ ...this._snapshot, refs: this._current.refs.slice() });
        this._publish(true, false, null);
        break;
      }
      case "refs_notice": {
        this._current.notice = typeof p.notice === "string" ? p.notice : "notice";
        this._publish(true, false, this._current.notice);
        break;
      }
      case "refs_complete": {
        const cancelled = p.cancelled === true;
        this._set({ ...this._snapshot, runId: null, refs: this._current.refs.slice() });
        this._publish(false, cancelled, this._current.notice, numberOr(p.settled_at, Date.now()));
        this._current = null;
        break;
      }
      default:
        break;
    }
  }

  /** Mirror the run's whole current state into the transcript. */
  private _publish(
    inFlight: boolean,
    cancelled: boolean,
    notice: string | null,
    settledAtMs?: number,
  ): void {
    const run = this._current;
    if (run === null) return;
    this._codeSessionStore.ingestRefs({
      runId: run.runId,
      opKind: run.kind,
      command: run.command,
      root: this._projectDir,
      refs: run.refs.slice(),
      inFlight,
      cancelled,
      notice,
      startedAtMs: run.startedAtMs,
      settledAtMs: inFlight ? null : (settledAtMs ?? Date.now()),
    });
  }

  /**
   * Start a run. Mints a `run_id` and sends the op on `REFS_INPUT`; the
   * transcript row is minted when `refs_started` echoes back — not
   * optimistically — so a failed send never leaves a ghost block.
   *
   * A run started while another is in flight replaces it: the feed cancels
   * the old one and drops its completion frame, because the ledger keeps
   * only the latest run anyway.
   */
  run(options: RefsRunOptions): void {
    const needles = options.needles.filter((n) => n.length > 0);
    if (needles.length === 0) return;
    this._seq += 1;
    const runId = `refs-${this._seq}`;
    const conn = getConnection();
    if (conn === null) return;
    conn.send(
      FeedId.REFS_INPUT,
      new TextEncoder().encode(
        JSON.stringify({
          type: options.kind,
          tug_session_id: this._tugSessionId,
          run_id: runId,
          root: this._projectDir,
          needles,
          command: options.command,
          flags: options.flags,
        }),
      ),
    );
  }

  /** Stop the run in flight; the block settles with what it found. */
  cancel(): void {
    const runId = this._snapshot.runId;
    if (runId === null) return;
    getConnection()?.send(
      FeedId.REFS_INPUT,
      new TextEncoder().encode(
        JSON.stringify({
          type: "cancel",
          tug_session_id: this._tugSessionId,
          run_id: runId,
        }),
      ),
    );
  }

  /** The latest run's refs — the list `/ref N` indexes into. */
  currentRefs(): ReadonlyArray<TextRef> {
    return this._snapshot.refs;
  }

  /** Workspace root the refs' relative paths hang off. */
  root(): string {
    return this._snapshot.root;
  }

  private _set(next: RefsSessionSnapshot): void {
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): RefsSessionSnapshot => this._snapshot;

  dispose(): void {
    this._restoreFetch.dispose();
    this._unsubscribeFeed?.();
    this._unsubscribeFeed = null;
    this._listeners.clear();
  }

  /** Test seam: fold a raw `REFS_OUTPUT` payload as if it arrived on the feed. */
  _ingestForTest(payload: unknown): void {
    this._fold(payload);
  }

  /** Test seam / restore path: adopt a ledgered run as the current refs. */
  _adoptRefs(refs: ReadonlyArray<TextRef>): void {
    this._set({ ...this._snapshot, refs: refs.slice() });
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Read one wire `preview`; `null` for anything that isn't one.
 *
 * Two shapes are legal. The windowed one is what the feed sends today. A
 * bare string is what a `refs.db` row written before windowing holds — the
 * ledger keeps one run per session indefinitely, and reading it as a single
 * full-width window costs a branch and saves a migration.
 */
export function parseLinePreview(raw: unknown): LinePreview | null {
  if (typeof raw === "string") {
    return {
      lineLen: raw.length,
      segments: raw === "" ? [] : [{ col: 0, text: raw }],
      elidedMatches: 0,
    };
  }
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const segments: PreviewSegment[] = [];
  if (Array.isArray(p.segments)) {
    for (const entry of p.segments) {
      if (typeof entry !== "object" || entry === null) continue;
      const s = entry as Record<string, unknown>;
      if (typeof s.col !== "number" || typeof s.text !== "string") continue;
      segments.push({ col: s.col, text: s.text });
    }
  }
  return {
    lineLen: numberOr(p.line_len, 0),
    segments,
    elidedMatches: numberOr(p.elided_matches, 0),
  };
}

/** Read one wire `TextRef`; `null` for a row that isn't one. */
export function parseTextRef(raw: unknown): TextRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.index !== "number" || typeof r.path !== "string") return null;
  const columns: Array<readonly [number, number]> = [];
  if (Array.isArray(r.columns)) {
    for (const span of r.columns) {
      if (
        Array.isArray(span) &&
        typeof span[0] === "number" &&
        typeof span[1] === "number"
      ) {
        columns.push([span[0], span[1]] as const);
      }
    }
  }
  return {
    index: r.index,
    path: r.path,
    line: typeof r.line === "number" ? r.line : null,
    columns,
    preview: parseLinePreview(r.preview),
  };
}

/**
 * Apply a `list_refs_ok` response: re-mint the session's latest run as a
 * settled `refs` turn, and seat its refs as the list `/ref N` resolves
 * against. The run is upserted by `turnKey`, so a re-fetch (reload) is
 * idempotent. Pure over the stores; exported for the action-dispatch
 * handler and tests.
 */
export function applyRestoredRefs(
  codeSessionStore: CodeSessionStore,
  refsSessionStore: RefsSessionStore | null,
  run: Record<string, unknown> | null,
): void {
  if (run === null) return;
  const rawRefs = Array.isArray(run.refs) ? run.refs : [];
  const refs = rawRefs
    .map(parseTextRef)
    .filter((ref): ref is TextRef => ref !== null);
  const settledAtMs = numberOr(run.settled_at_ms, 0);
  // The ledger row carries relative paths and no root; the store holds the
  // card's project dir, which is the root they were relative to.
  const root = refsSessionStore?.root() ?? "";
  codeSessionStore.ingestRefs({
    runId: String(run.run_id ?? "restored"),
    opKind: run.op_kind === "match" ? "match" : "search",
    command: String(run.command ?? ""),
    root,
    refs,
    inFlight: false,
    cancelled: false,
    notice: null,
    startedAtMs: settledAtMs,
    settledAtMs,
  });
  refsSessionStore?._adoptRefs(refs);
}
