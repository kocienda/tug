/**
 * `ShellSessionStore` — the per-card `$`-route shell session ([P12]).
 *
 * Owns the shell **session** state (`live`, `cwd`, and the in-flight exchange
 * that drives the route-aware submit button, [P13]) and is the SOLE consumer
 * of the card's `SHELL_OUTPUT` feed. It does NOT own the exchange rows: each
 * exchange's transcript presence lives in `CodeSessionStore`, which this store
 * feeds through `ingestShellExchange` on `exchange_started` (mint an in-flight
 * shell turn) and `exchange_complete` (settle it) — one consumer chain, no
 * dual-ingest race ([P12]). `SHELL_OUTPUT` is deliberately absent from the
 * code-session feed filter, so shell frames reach only this store.
 *
 * The [L02] store surface (`subscribe` / `getSnapshot`) drives the cwd chip
 * and the route-aware Z5. Session-scoped: the feed is filtered to this card's
 * `tug_session_id`, and `exec` / `kill` stamp it on the outbound frame.
 *
 * `/clear` reset is implicit: a `/clear` fresh-spawns a new `tug_session_id`,
 * so `cardServicesStore` disposes this store and constructs a fresh one — the
 * in-memory session state resets with the swap (the ledger, keyed by session,
 * is untouched).
 */

import { FeedId, type FeedIdValue } from "../protocol";
import type { FeedStore } from "./feed-store";
import { getConnection } from "./connection-singleton";
import { LedgerRestoreFetch } from "./ledger-restore-fetch";
import type { CodeSessionStore } from "./code-session-store";
import { isInkOrigin } from "./code-session-store/types";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import type { PendingContextStore } from "./pending-context-store";
import { composeShellShareText } from "./shell-share";
import { interactiveStagingSteer } from "./shell-interactive-staging";

/** A running exchange — drives the `stop` pose on the `$` route ([P13]). */
export interface ShellInflight {
  exchangeId: string;
  command: string;
}

/**
 * What the restore knows about its own completeness ([P07]).
 *
 * The whole point of carrying this on the snapshot is that "the transcript is
 * short" and "the transcript is complete" stop being the same picture. A card
 * can only refuse to lie about a gap if something tells it a gap exists.
 */
export interface ShellRestoreCensus {
  /** Rows the ledger reports for this session in the requested window. */
  ledgerTotal: number;
  /** Rows this store has applied to the transcript. */
  applied: number;
  /** Whether the last answer accounted for every row the ledger reported. */
  complete: boolean;
  /** Whether any answer has landed at all — false while still asking. */
  answered: boolean;
}

const EMPTY_CENSUS: ShellRestoreCensus = {
  ledgerTotal: 0,
  applied: 0,
  complete: false,
  answered: false,
};

export interface ShellSessionSnapshot {
  /** Whether a shell child is live for this session. */
  live: boolean;
  /** The shell's working directory; `null` before the first spawn. */
  cwd: string | null;
  /** The in-flight exchange, or `null` when idle. */
  inflight: ShellInflight | null;
  /** The ledger-restore census ([P07]) — see {@link ShellRestoreCensus}. */
  restore: ShellRestoreCensus;
}

const EMPTY_SNAPSHOT: ShellSessionSnapshot = {
  live: false,
  cwd: null,
  inflight: null,
  restore: EMPTY_CENSUS,
};

export class ShellSessionStore {
  private _snapshot: ShellSessionSnapshot = EMPTY_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private _seq = 0;
  private readonly _feedStore: FeedStore;
  private readonly _feedId: FeedIdValue;
  private readonly _tugSessionId: string;
  private readonly _projectDir: string;
  private readonly _codeSessionStore: CodeSessionStore;
  private readonly _pendingContextStore: PendingContextStore | undefined;
  /** Exchange ids the PATH classifier auto-routed here ([P09]); client-side. */
  private readonly _autoRoutedExchanges = new Set<string>();
  /** The retrying `list_shell_exchanges` read ([P07]). */
  private readonly _restoreFetch: LedgerRestoreFetch;
  /** Unsubscribe from the code store's window watch; cleared on dispose. */
  private _unsubscribeWindow: (() => void) | null = null;
  /** The window floor the last fetch was sent under. */
  private _lastWindowFloorMs: number | null = null;

  constructor(
    feedStore: FeedStore,
    feedId: FeedIdValue,
    tugSessionId: string,
    projectDir: string,
    codeSessionStore: CodeSessionStore,
    pendingContextStore?: PendingContextStore,
  ) {
    this._feedStore = feedStore;
    this._feedId = feedId;
    this._tugSessionId = tugSessionId;
    this._projectDir = projectDir;
    this._codeSessionStore = codeSessionStore;
    this._pendingContextStore = pendingContextStore;
    // Seed cwd optimistically to the project dir so the chip reads something
    // before the first `shell_state` frame lands.
    this._snapshot = { ...EMPTY_SNAPSHOT, cwd: projectDir };
    this._unsubscribeFeed = feedStore.subscribe(() => this._onFeedUpdate());
    // Restore ([P07]): fetch this session's ledgered exchanges and interleave
    // them into the transcript. Started at construction — HMR preserves the
    // store, so it never re-fires; a Maker ▸ Reload / relaunch builds a fresh
    // store and re-fetches, which is idempotent (upsert by turnKey). The
    // `list_shell_exchanges_ok` response routes back through action-dispatch
    // to {@link applyRestore}, which settles the fetch. The ledger is the ONLY
    // source for these rows — a `/commit` receipt is the user's act, never
    // session context ([D111]), so it is absent from the JSONL and no replay
    // can substitute — which is why the fetch retries instead of hoping.
    //
    // `since_ms` is the replay window's floor, read at send time ([P07]):
    // the Claude turns replay bounded to `lastTurns`, so an unbounded ink
    // read would seat rows older than the window above the oldest turn —
    // two paging models over one transcript, agreeing about nothing. Before
    // the first `replay_complete` there is no floor, and the read goes
    // unbounded on purpose: over-fetching a capped ledger is free, and
    // losing a `/commit` receipt is not.
    this._restoreFetch = new LedgerRestoreFetch({
      action: "list_shell_exchanges",
      tugSessionId,
      logSource: "shell-restore",
      params: () => {
        const floor = this._windowFloorMs();
        return floor === null ? {} : { since_ms: floor };
      },
    });
    this._restoreFetch.start();
    // When the window grows older — the first replay landing, or a "load
    // previous" page — the ink rows for the newly-loaded span have never
    // been asked for. Re-ask; the apply is an upsert, so re-delivery of rows
    // already held costs nothing.
    this._lastWindowFloorMs = this._windowFloorMs();
    this._unsubscribeWindow = codeSessionStore.subscribe(() => {
      const floor = this._windowFloorMs();
      const prior = this._lastWindowFloorMs;
      if (floor === prior) return;
      this._lastWindowFloorMs = floor;
      // Only a floor that moved *older* (or appeared) widens the span.
      if (prior !== null && floor !== null && floor >= prior) return;
      this._restoreFetch.refresh();
    });
  }

  /**
   * The oldest loaded Claude turn's timestamp — the replay window's floor —
   * or `null` when no Claude turn is loaded yet.
   *
   * Ink turns are excluded deliberately: they are what this floor is used to
   * fetch, so counting them would let the window define itself and ratchet
   * the floor forward until older rows became unreachable.
   */
  private _windowFloorMs(): number | null {
    let floor: number | null = null;
    for (const turn of this._codeSessionStore.getSnapshot().transcript) {
      if (isInkOrigin(turn.origin)) continue;
      const ts = turn.messages[0]?.createdAt ?? turn.endedAt;
      if (typeof ts !== "number") continue;
      if (floor === null || ts < floor) floor = ts;
    }
    return floor;
  }

  /**
   * Apply a `list_shell_exchanges_ok` answer, and settle the restore retry
   * **only if the answer was complete** ([P07]).
   *
   * Routed here (rather than straight to `CodeSessionStore`) so the store
   * that asked is the one that learns it was answered — and so the
   * completeness check has somewhere to live.
   *
   * `total` is the ledger's own count for the same window, taken separately
   * from the rows. When it exceeds what arrived, the answer was short: a
   * truncated send, or a request that raced the ledger. Settling on that is
   * how a `/commit` receipt stays in sqlite and out of the transcript, so a
   * short answer applies what it has and keeps asking. A payload with no
   * `total` at all is an older tugcast; trust the rows, as before.
   *
   * `answered: false` means there was no ledger to read — never the same
   * thing as "this session has no rows", so it does not settle either.
   */
  applyRestore(
    rows: ReadonlyArray<Record<string, unknown>>,
    census?: { total?: unknown; answered?: unknown },
  ): void {
    applyRestoredShellExchanges(this._codeSessionStore, rows);

    const total = typeof census?.total === "number" ? census.total : rows.length;
    const hadLedger = census?.answered !== false;
    const complete = hadLedger && rows.length >= total;
    this._set({
      ...this._snapshot,
      restore: {
        ledgerTotal: total,
        applied: rows.length,
        complete,
        answered: true,
      },
    });
    if (complete) {
      this._restoreFetch.settle();
      return;
    }
    tugDevLogStore.warn("shell-restore", "short restore answer; still asking", {
      tugSessionId: this._tugSessionId,
      applied: rows.length,
      ledgerTotal: total,
      hadLedger,
    });
  }

  /**
   * Re-ask the restore now — the replay window moved, so the request's
   * `since_ms` has changed and the previous answer described a different span.
   */
  refreshRestore(): void {
    this._restoreFetch.refresh();
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(this._feedId);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;
    this._fold(payload);
  }

  /** Fold one `SHELL_OUTPUT` frame: update session state and mirror the
   *  exchange lifecycle into `CodeSessionStore`. */
  private _fold(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    switch (p.type) {
      case "shell_state": {
        const live = p.live === true;
        const cwd = typeof p.cwd === "string" ? p.cwd : this._snapshot.cwd;
        this._set({ ...this._snapshot, live, cwd });
        break;
      }
      case "exchange_started": {
        const cwd = typeof p.cwd === "string" ? p.cwd : this._snapshot.cwd;
        this._set({ ...this._snapshot, live: true, cwd });
        this._codeSessionStore.ingestShellExchange({
          phase: "started",
          exchangeId: String(p.exchange_id ?? ""),
          command: String(p.command ?? ""),
          cwd: typeof p.cwd === "string" ? p.cwd : this._projectDir,
          startedAtMs: numberOr(p.started_at, Date.now()),
          autoRouted: this._autoRoutedExchanges.has(String(p.exchange_id ?? "")),
        });
        break;
      }
      case "exchange_complete": {
        const exchangeId = String(p.exchange_id ?? "");
        const cwdAfter = typeof p.cwd_after === "string" ? p.cwd_after : null;
        // Clear the in-flight slot if this settles the running exchange.
        const inflight =
          this._snapshot.inflight?.exchangeId === exchangeId
            ? null
            : this._snapshot.inflight;
        this._set({
          ...this._snapshot,
          cwd: cwdAfter ?? this._snapshot.cwd,
          inflight,
        });
        const startedAt = numberOr(p.started_at, Date.now());
        const command = String(p.command ?? "");
        const output = typeof p.output === "string" ? p.output : "";
        const exitCode = typeof p.exit_code === "number" ? p.exit_code : null;
        const settledAt = numberOr(p.settled_at, startedAt);
        const autoRouted = this._autoRoutedExchanges.has(exchangeId);
        this._codeSessionStore.ingestShellExchange({
          phase: "complete",
          exchangeId,
          command,
          output,
          exitCode,
          cwd: typeof p.cwd === "string" ? p.cwd : (cwdAfter ?? this._projectDir),
          cwdAfter,
          startedAtMs: startedAt,
          settledAtMs: settledAt,
          autoRouted,
        });
        // The exchange has settled; forget its auto-route marker.
        this._autoRoutedExchanges.delete(exchangeId);
        // VISIBILITY=Context ([P08], the submission-time variant): a newly
        // settled exchange auto-stages onto the pending-context queue to ride
        // the next `❯` submission. This fires only for LIVE completions —
        // restore replays through `applyRestoredShellExchanges`, never here —
        // so the backlog is never dumped, and `stage`'s source+exchangeId
        // dedup makes a manual Add-to-context on the same row a no-op.
        if (this._pendingContextStore?.isContext("shell")) {
          this._pendingContextStore.stage({
            source: "shell",
            ref: exchangeId,
            label: `$ ${command}`,
            body: composeShellShareText({ command, output, exitCode, settledAtMs: settledAt }),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Run a command on the `$` route. Mints an `exchange_id`, marks the session
   * in-flight (drives the `stop` pose, [P13]), and sends the `exec` verb on
   * `SHELL_INPUT`. The transcript row is minted when the `exchange_started`
   * frame echoes back — not optimistically — so a failed send never leaves a
   * ghost row. Serial: refused while an exchange is in flight.
   *
   * An interactive-staging invocation (`git add -p` and friends) is answered
   * with a steering notice instead of being run ([P13]) — see
   * {@link _steerInteractiveStaging}.
   */
  exec(command: string, opts?: { origin?: "auto" }): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;
    if (this._snapshot.inflight !== null) return;
    const steer = interactiveStagingSteer(trimmed);
    if (steer !== null) {
      this._steerInteractiveStaging(trimmed, steer);
      return;
    }
    this._seq += 1;
    const exchangeId = `sh-${this._seq}`;
    // Remember an auto-routed exchange so the transcript row (minted when the
    // `exchange_started` frame echoes back) renders the `→ shell` attribution.
    // Client-side only — the shell ledger schema is untouched ([P09]).
    if (opts?.origin === "auto") this._autoRoutedExchanges.add(exchangeId);
    this._set({ ...this._snapshot, inflight: { exchangeId, command: trimmed } });
    const conn = getConnection();
    if (!conn) {
      // No transport — drop the in-flight marker; nothing was sent.
      this._set({ ...this._snapshot, inflight: null });
      return;
    }
    conn.send(
      FeedId.SHELL_INPUT,
      new TextEncoder().encode(
        JSON.stringify({
          type: "exec",
          tug_session_id: this._tugSessionId,
          exchange_id: exchangeId,
          command: trimmed,
          cwd: this._snapshot.cwd ?? this._projectDir,
        }),
      ),
    );
  }

  /**
   * Answer an interactive-staging command with a notice rather than running it
   * ([P13]).
   *
   * The row is minted locally — nothing is sent, nothing is spawned, and the
   * shell ledger records nothing, because nothing happened. It settles
   * immediately with a non-zero exit so the row reads as a refusal and not as
   * a command that ran and printed advice.
   */
  private _steerInteractiveStaging(command: string, notice: string): void {
    this._seq += 1;
    const exchangeId = `sh-steer-${this._seq}`;
    const at = Date.now();
    const cwd = this._snapshot.cwd ?? this._projectDir;
    this._codeSessionStore.ingestShellExchange({
      phase: "started",
      exchangeId,
      command,
      cwd,
      startedAtMs: at,
      autoRouted: false,
    });
    this._codeSessionStore.ingestShellExchange({
      phase: "complete",
      exchangeId,
      command,
      output: notice,
      exitCode: 1,
      cwd,
      cwdAfter: null,
      startedAtMs: at,
      settledAtMs: at,
      autoRouted: false,
    });
  }

  /** Kill the running command — reaps the shell's process group ([Q03]). */
  kill(): void {
    const conn = getConnection();
    if (!conn) return;
    conn.send(
      FeedId.SHELL_INPUT,
      new TextEncoder().encode(
        JSON.stringify({ type: "kill", tug_session_id: this._tugSessionId }),
      ),
    );
  }

  private _set(next: ShellSessionSnapshot): void {
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): ShellSessionSnapshot => this._snapshot;

  dispose(): void {
    this._restoreFetch.dispose();
    this._unsubscribeFeed?.();
    this._unsubscribeFeed = null;
    this._unsubscribeWindow?.();
    this._unsubscribeWindow = null;
    this._listeners.clear();
  }

  /** Test seam: fold a raw `SHELL_OUTPUT` payload as if it arrived on the feed. */
  _ingestForTest(payload: unknown): void {
    this._fold(payload);
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Apply a `list_shell_exchanges_ok` response ([P07]): mint each ledgered
 * exchange into the transcript through the `ingestShellExchange` bare-complete
 * path, which upserts by `turnKey` at its timestamp position — so restored
 * shell rows interleave among the JSONL-replayed Claude turns, and a re-fetch
 * (reload) is idempotent. The ledger row carries no live `exchange_id` (it was
 * never persisted), so the sqlite row `id` keys a stable `restored-<id>`
 * turn. Pure over the store; exported for the action-dispatch handler + tests.
 */
export function applyRestoredShellExchanges(
  codeSessionStore: CodeSessionStore,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  for (const r of rows) {
    const started = numberOr(r.started_at_ms, 0);
    codeSessionStore.ingestShellExchange({
      phase: "complete",
      exchangeId: `restored-${r.id}`,
      command: String(r.command ?? ""),
      output: typeof r.output === "string" ? r.output : "",
      exitCode: typeof r.exit_code === "number" ? r.exit_code : null,
      cwd: typeof r.cwd === "string" ? r.cwd : "",
      cwdAfter: typeof r.cwd_after === "string" ? r.cwd_after : null,
      startedAtMs: started,
      settledAtMs: numberOr(r.settled_at_ms, started),
      // The written position. A row from before the anchor column, or from a
      // session with no assistant turn behind it, carries null and seats by
      // timestamp exactly as every row once did.
      anchorMsgId: typeof r.anchor_msg_id === "string" ? r.anchor_msg_id : undefined,
    });
  }
}
