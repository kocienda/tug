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
 * One kind of exchange mints no turn: a run started from a runnable offer's
 * Play. Its result is read under the offer, so the store keeps it in
 * {@link RunOfferStore} (`offers`) and the transcript never hears of it.
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

import { Subscribable } from "./subscribable";
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
import { unendingProgram } from "./shell-line-classifier";
import { RunOfferStore, type RunOfferRun, type RunQuiet } from "./run-offer-store";

/** How a command reached {@link ShellSessionStore.exec}. */
export type ShellExecOrigin =
  /** The PATH classifier routed a prompt line here ([P09]). */
  | { origin: "auto" }
  /** A runnable offer's Play; the result belongs to the offer `offerKey` names. */
  | { origin: "offer"; offerKey: string };

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

/**
 * How alive the running exchange looks: when it started, when it last
 * printed, and whether the feed has asked about it.
 */
export interface ShellLiveness {
  readonly exchangeId: string;
  readonly startedAtMs: number;
  /** `null` until the command prints. */
  readonly lastOutputAtMs: number | null;
  /** The question standing over the exchange, or `null`. */
  readonly quiet: RunQuiet | null;
}

/**
 * The running exchange's {@link ShellLiveness}, or `null` when the shell is
 * idle. It is a store of its own, apart from the session snapshot, because
 * it moves with every piece of output: a chatty command would otherwise put
 * every reader of the snapshot through a dozen changes a second for a value
 * only the running block's footer and band read.
 */
export class ShellLivenessStore extends Subscribable {
  private _current: ShellLiveness | null = null;

  get = (): ShellLiveness | null => this._current;

  /** Set the whole reading; `null` when the exchange has settled. */
  set(next: ShellLiveness | null): void {
    if (next === this._current) return;
    this._current = next;
    this.notify();
  }

  /** Change the running exchange's reading; dropped for any other exchange. */
  update(exchangeId: string, change: Partial<Omit<ShellLiveness, "exchangeId">>): void {
    if (this._current === null || this._current.exchangeId !== exchangeId) return;
    this.set({ ...this._current, ...change });
  }
}

export class ShellSessionStore extends Subscribable {
  private _snapshot: ShellSessionSnapshot = EMPTY_SNAPSHOT;
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
  /** The runs of this card's runnable offers; their exchanges mint no turn. */
  readonly offers = new RunOfferStore();
  /** How alive the running exchange looks, an offer's or a `$` command's. */
  readonly liveness = new ShellLivenessStore();
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
    super();
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
    // A row that carries an offer's key is that offer's result, read under
    // its fence; every other row is a transcript turn, as it always was.
    const turns: Array<Record<string, unknown>> = [];
    const offered: Array<Parameters<RunOfferStore["restore"]>[0][number]> = [];
    for (const r of rows) {
      if (typeof r.offer_key !== "string" || r.offer_key.length === 0) {
        turns.push(r);
        continue;
      }
      const started = numberOr(r.started_at_ms, 0);
      offered.push({
        key: r.offer_key,
        exchangeId: `restored-${r.id}`,
        command: String(r.command ?? ""),
        output: typeof r.output === "string" ? r.output : "",
        exitCode: typeof r.exit_code === "number" ? r.exit_code : null,
        cwd: typeof r.cwd === "string" ? r.cwd : "",
        startedAtMs: started,
        settledAtMs: numberOr(r.settled_at_ms, started),
      });
    }
    applyRestoredShellExchanges(this._codeSessionStore, turns);
    this.offers.restore(offered);

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
        const startedId = String(p.exchange_id ?? "");
        this.liveness.update(startedId, { startedAtMs: numberOr(p.started_at, Date.now()) });
        if (this.offers.keyForExchange(startedId) !== undefined) {
          this.offers.started(startedId, {
            cwd: typeof p.cwd === "string" ? p.cwd : this._projectDir,
            startedAtMs: numberOr(p.started_at, Date.now()),
          });
          break;
        }
        this._codeSessionStore.ingestShellExchange({
          phase: "started",
          exchangeId: startedId,
          command: String(p.command ?? ""),
          cwd: typeof p.cwd === "string" ? p.cwd : this._projectDir,
          startedAtMs: numberOr(p.started_at, Date.now()),
          autoRouted: this._autoRoutedExchanges.has(String(p.exchange_id ?? "")),
        });
        break;
      }
      case "exchange_output": {
        // Output as it is produced. Any piece is a sign of life, and it
        // answers a question standing over the exchange. Only an offer's
        // result shows the output as it grows; a transcript row mounts its
        // body at the settle, which carries the whole output, so a piece for
        // one is not kept.
        if (typeof p.chunk === "string") {
          const at = Date.now();
          const outputId = String(p.exchange_id ?? "");
          this.liveness.update(outputId, { lastOutputAtMs: at, quiet: null });
          this.offers.append(outputId, p.chunk, at);
        }
        break;
      }
      case "exchange_quiet": {
        // The command printed nothing and used no CPU for its quiet horizon.
        // The feed has done nothing about it and will not: this is a question
        // for the user, held until the command prints, the user answers, or
        // the exchange settles.
        const quietId = String(p.exchange_id ?? "");
        const quiet: RunQuiet = {
          quietMs: numberOr(p.quiet_ms, 0),
          askedAtMs: Date.now(),
        };
        this.liveness.update(quietId, { quiet });
        this.offers.askQuiet(quietId, quiet);
        break;
      }
      case "exchange_complete": {
        const exchangeId = String(p.exchange_id ?? "");
        if (this.liveness.get()?.exchangeId === exchangeId) this.liveness.set(null);
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
        const ranIn = typeof p.cwd === "string" ? p.cwd : (cwdAfter ?? this._projectDir);
        // An offer's exchange settles under its offer and mints no turn.
        const offered = this.offers.settle(exchangeId, {
          output,
          exitCode,
          cwd: ranIn,
          startedAtMs: startedAt,
          settledAtMs: settledAt,
          stoppedBy: p.stopped_by === "kill" ? "kill" : null,
        });
        if (!offered) {
          this._codeSessionStore.ingestShellExchange({
            phase: "complete",
            exchangeId,
            command,
            output,
            exitCode,
            cwd: ranIn,
            cwdAfter,
            startedAtMs: startedAt,
            settledAtMs: settledAt,
            autoRouted,
          });
        }
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
   * {@link _steerRefusal}.
   *
   * A program on the never-ends list is answered the same way. The router keeps
   * one off the `❯` route, but this route is typed rather than inferred, and a
   * `yes` typed here wedges the app exactly as hard — so the refusal sits at
   * the one door every caller comes through.
   *
   * A runnable offer comes through the same door (`origin: "offer"`), so both
   * refusals apply to it; what differs is where the answer is read. Its
   * exchange, or the notice that stands in for one, belongs to the offer and
   * mints no transcript turn.
   */
  exec(command: string, opts?: ShellExecOrigin): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;
    if (this._snapshot.inflight !== null) return;
    const offerKey = opts?.origin === "offer" ? opts.offerKey : null;
    const unending = unendingProgram(trimmed);
    if (unending !== null) {
      this._steerRefusal(
        trimmed,
        `\`${unending}\` never ends on its own, and this route has no terminal ` +
          "to stop it from — a command's stdin is /dev/null, so there is no ⌃C " +
          "to send. It would run, and hold this card's one shell, until you " +
          "stopped it.\n\n" +
          "Run it in a form that finishes, or in a terminal outside Tug.",
        offerKey,
      );
      return;
    }
    const steer = interactiveStagingSteer(trimmed);
    if (steer !== null) {
      this._steerRefusal(trimmed, steer, offerKey);
      return;
    }
    this._seq += 1;
    const exchangeId = `sh-${this._seq}`;
    // Remember an auto-routed exchange so the transcript row (minted when the
    // `exchange_started` frame echoes back) renders the `→ shell` attribution.
    // Client-side only — the shell ledger schema is untouched ([P09]).
    if (opts?.origin === "auto") this._autoRoutedExchanges.add(exchangeId);
    const conn = getConnection();
    if (!conn) {
      // No transport — nothing was sent, so nothing is in flight.
      return;
    }
    const cwd = this._snapshot.cwd ?? this._projectDir;
    // An offer's run shows under its offer from the press, not from the echo:
    // the frame is where the user is looking.
    if (offerKey !== null) {
      this.offers.start({
        key: offerKey,
        exchangeId,
        command: trimmed,
        cwd,
        startedAtMs: Date.now(),
      });
    }
    this._set({ ...this._snapshot, inflight: { exchangeId, command: trimmed } });
    this.liveness.set({
      exchangeId,
      startedAtMs: Date.now(),
      lastOutputAtMs: null,
      quiet: null,
    });
    conn.send(
      FeedId.SHELL_INPUT,
      new TextEncoder().encode(
        JSON.stringify({
          type: "exec",
          tug_session_id: this._tugSessionId,
          exchange_id: exchangeId,
          command: trimmed,
          cwd,
          // Ledgered beside the exchange, so a reload restores the result
          // under its fence and not as a turn.
          ...(offerKey !== null ? { offer_key: offerKey } : {}),
        }),
      ),
    );
  }

  /**
   * Answer a command with a notice rather than running it — an interactive
   * staging invocation ([P13]), or a program that never ends.
   *
   * The row is minted locally — nothing is sent, nothing is spawned, and the
   * shell ledger records nothing, because nothing happened. It settles
   * immediately with a non-zero exit so the row reads as a refusal and not as
   * a command that ran and printed advice. A refused offer gets the notice as
   * its result, under the offer, in place of a row.
   */
  private _steerRefusal(command: string, notice: string, offerKey: string | null): void {
    this._seq += 1;
    const exchangeId = `sh-steer-${this._seq}`;
    const at = Date.now();
    const cwd = this._snapshot.cwd ?? this._projectDir;
    if (offerKey !== null) {
      this.offers.refuse({ key: offerKey, exchangeId, command, cwd, notice, atMs: at });
      return;
    }
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

  /** Whether this card has a pending-context queue a result could join. */
  hasContextQueue(): boolean {
    return this._pendingContextStore !== undefined;
  }

  /** Whether an offer's run is staged to ride the next submission. */
  offerRunStaged(run: RunOfferRun): boolean {
    return this._pendingContextStore?.has("shell", run.exchangeId) === true;
  }

  /**
   * Add an offer's settled run to the next submission's context, or take it
   * back out. This is the one route by which the result reaches the model:
   * nothing sends it on its own. Staged under the exchange's id, the same
   * handle VISIBILITY=Context stages a live completion under, so the two
   * can never queue one run twice.
   */
  toggleOfferRunContext(run: RunOfferRun): void {
    const queue = this._pendingContextStore;
    if (queue === undefined || run.status !== "settled" || run.refused) return;
    if (queue.has("shell", run.exchangeId)) {
      queue.unstageRef("shell", run.exchangeId);
      return;
    }
    queue.stage({
      source: "shell",
      ref: run.exchangeId,
      label: `$ ${run.command}`,
      body: composeShellShareText({
        command: run.command,
        output: run.output,
        exitCode: run.exitCode,
        settledAtMs: run.settledAtMs ?? run.startedAtMs,
      }),
    });
  }

  /** Hear when the pending-context queue moves; `null` where a card has none. */
  subscribeContext(listener: () => void): (() => void) | null {
    return this._pendingContextStore?.subscribe(listener) ?? null;
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

  /**
   * Answer the question standing over the running command with "keep
   * waiting". The feed doubles the silence it allows before asking again, and
   * the question comes down here at once, without waiting on the feed. A
   * no-op when nothing is asking.
   */
  keepWaiting(): void {
    const asking = this.liveness.get();
    if (asking === null || asking.quiet === null) return;
    const conn = getConnection();
    if (!conn) return;
    conn.send(
      FeedId.SHELL_INPUT,
      new TextEncoder().encode(
        JSON.stringify({
          type: "keep_waiting",
          tug_session_id: this._tugSessionId,
          exchange_id: asking.exchangeId,
        }),
      ),
    );
    this.liveness.update(asking.exchangeId, { quiet: null });
    this.offers.answerQuiet(asking.exchangeId);
  }

  private _set(next: ShellSessionSnapshot): void {
    this._snapshot = next;
    this.notify();
  }

  getSnapshot = (): ShellSessionSnapshot => this._snapshot;

  dispose(): void {
    this._restoreFetch.dispose();
    this._unsubscribeFeed?.();
    this._unsubscribeFeed = null;
    this._unsubscribeWindow?.();
    this._unsubscribeWindow = null;
    this.offers.clearListeners();
    this.liveness.clearListeners();
    this.clearListeners();
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
