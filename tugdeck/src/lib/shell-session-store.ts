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
import type { PendingContextStore } from "./pending-context-store";
import { composeShellShareText } from "./shell-share";
import { interactiveStagingSteer } from "./shell-interactive-staging";

/** A running exchange — drives the `stop` pose on the `$` route ([P13]). */
export interface ShellInflight {
  exchangeId: string;
  command: string;
}

export interface ShellSessionSnapshot {
  /** Whether a shell child is live for this session. */
  live: boolean;
  /** The shell's working directory; `null` before the first spawn. */
  cwd: string | null;
  /** The in-flight exchange, or `null` when idle. */
  inflight: ShellInflight | null;
}

const EMPTY_SNAPSHOT: ShellSessionSnapshot = {
  live: false,
  cwd: null,
  inflight: null,
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
    this._restoreFetch = new LedgerRestoreFetch({
      action: "list_shell_exchanges",
      tugSessionId,
      logSource: "shell-restore",
    });
    this._restoreFetch.start();
  }

  /**
   * Apply a `list_shell_exchanges_ok` answer and stop the restore retry.
   * Routed here (rather than straight to `CodeSessionStore`) so the store
   * that asked is the one that learns it was answered.
   */
  applyRestore(rows: ReadonlyArray<Record<string, unknown>>): void {
    this._restoreFetch.settle();
    applyRestoredShellExchanges(this._codeSessionStore, rows);
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
    });
  }
}
