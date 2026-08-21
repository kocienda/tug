/**
 * `LedgerRestoreFetch` — a CONTROL restore read that keeps asking until it is
 * answered **completely** ([P07]).
 *
 * The shell and refs ledgers are the only source for their transcript rows:
 * a `/commit` receipt and a `/match` run are the user's acts, never session
 * context, so they are absent from the JSONL and a replay cannot bring them
 * back. If the one restore request is lost — dropped by a socket that was not
 * yet OPEN, or answered while the card's services bag was between
 * constructions — the rows are gone from the transcript while sitting intact
 * in sqlite, and nothing says so.
 *
 * This driver closes that: it sends, and if the frame did not go out or no
 * answer lands inside {@link ANSWER_TIMEOUT_MS}, it sends again on a capped
 * backoff.
 *
 * ## Why there is no give-up
 *
 * The first version of this stopped after six attempts (~8s) and logged a
 * warning. That is a **time bound on a thing with no time bound**: on a cold
 * relaunch the socket, the services bag, and the replay all land on their own
 * schedule, and a heavy deck routinely blows past eight seconds. Once the
 * attempts were spent nothing asked again, and 49 ledgered rows across two
 * cards stayed in sqlite and out of the transcript.
 *
 * So the retry is now unbounded in attempts and bounded in *rate* — capped at
 * the last backoff entry, a quarter-hertz murmur that costs nothing and
 * cannot lose. It warns once at {@link WARN_AFTER_ATTEMPTS} so a restore that
 * is genuinely stuck is still a fact in the Log tab, and it re-asks
 * immediately on reconnect rather than waiting out a backoff that was armed
 * against a socket which has since come back.
 *
 * {@link settle} stops it — and the caller must call that only when the
 * answer was **complete**. A short answer that settles is the same silent
 * loss wearing a different hat, which is why the shell answer carries a
 * `total` to check itself against.
 *
 * @module lib/ledger-restore-fetch
 */

import { FeedId } from "../protocol";
import { getConnection } from "./connection-singleton";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/** How long to wait for the `_ok` before re-asking. */
const ANSWER_TIMEOUT_MS = 1_500;

/** Backoff between attempts, capped at the last entry. */
const RETRY_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/** Attempts before warning that the restore is stuck. ~13s of asking. */
const WARN_AFTER_ATTEMPTS = 6;

export interface LedgerRestoreFetchOptions {
  /** CONTROL action to send, e.g. `"list_shell_exchanges"`. */
  action: string;
  /** The session whose rows are being restored; rides the request. */
  tugSessionId: string;
  /** Dev-log source for this fetch's warnings, e.g. `"shell-restore"`. */
  logSource: string;
  /**
   * Extra request fields, read at send time so a retry carries the *current*
   * value rather than one captured at construction — the replay window's
   * `since_ms` is not known until `replay_complete` lands, which is usually
   * after the first attempt has already gone out.
   */
  params?: () => Record<string, unknown>;
  /**
   * Timing policy. Defaults are {@link ANSWER_TIMEOUT_MS} /
   * {@link RETRY_BACKOFF_MS} / {@link WARN_AFTER_ATTEMPTS}; tests pass their
   * own so they pin the retry behaviour without spending its wall-clock.
   */
  answerTimeoutMs?: number;
  backoffMs?: ReadonlyArray<number>;
  warnAfterAttempts?: number;
}

export class LedgerRestoreFetch {
  private readonly _action: string;
  private readonly _tugSessionId: string;
  private readonly _logSource: string;
  private readonly _params: (() => Record<string, unknown>) | null;
  private readonly _answerTimeoutMs: number;
  private readonly _backoffMs: ReadonlyArray<number>;
  private readonly _warnAfterAttempts: number;
  private _attempts = 0;
  private _warned = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _unsubscribeDisconnect: (() => void) | null = null;
  private _settled = false;
  private _disposed = false;

  constructor(opts: LedgerRestoreFetchOptions) {
    this._action = opts.action;
    this._tugSessionId = opts.tugSessionId;
    this._logSource = opts.logSource;
    this._params = opts.params ?? null;
    this._answerTimeoutMs = opts.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
    this._backoffMs = opts.backoffMs ?? RETRY_BACKOFF_MS;
    this._warnAfterAttempts = opts.warnAfterAttempts ?? WARN_AFTER_ATTEMPTS;
  }

  /**
   * Send the first request, arm the retry that follows an unanswered one, and
   * subscribe to the wire so a reconnect re-asks at once. The subscription is
   * the half that makes this a reconciliation rather than a countdown: the
   * event that unblocks a restore is the socket coming back, not time passing.
   */
  start(): void {
    if (this._disposed || this._settled) return;
    const conn = getConnection();
    if (this._unsubscribeDisconnect === null && conn?.onDisconnectState) {
      this._unsubscribeDisconnect = conn.onDisconnectState((state) => {
        if (state.disconnected || this._settled || this._disposed) return;
        this._clearTimer();
        this._attempt();
      });
    }
    this._attempt();
  }

  /**
   * Ask again now, even if a previous answer settled this fetch — the caller
   * learned something that changes the *question*, so the old answer is an
   * answer to something else. Used when the replay window grows older and the
   * ink rows for the newly-loaded span have never been asked for.
   */
  refresh(): void {
    if (this._disposed) return;
    this._settled = false;
    this._clearTimer();
    this.start();
  }

  /**
   * The answer landed — stop asking. Idempotent, and safe to call for an
   * answer to an earlier attempt: the request carries no attempt id because
   * the read is idempotent server-side and the apply is an upsert by
   * `turnKey`, so any answer is the whole answer.
   */
  settle(): void {
    this._settled = true;
    this._clearTimer();
    this._unsubscribeDisconnect?.();
    this._unsubscribeDisconnect = null;
  }

  dispose(): void {
    this._disposed = true;
    this._clearTimer();
    this._unsubscribeDisconnect?.();
    this._unsubscribeDisconnect = null;
  }

  private _attempt(): void {
    if (this._disposed || this._settled) return;
    this._attempts += 1;
    const sent =
      getConnection()?.trySend(
        FeedId.CONTROL,
        new TextEncoder().encode(
          JSON.stringify({
            action: this._action,
            tug_session_id: this._tugSessionId,
            ...(this._params?.() ?? {}),
          }),
        ),
      ) ?? false;
    // Warn once, then keep asking. Going quiet here is what lost the rows;
    // the warning is for the person reading the Log tab, not a stop signal.
    if (this._attempts >= this._warnAfterAttempts && !this._warned) {
      this._warned = true;
      tugDevLogStore.warn(this._logSource, "ledger restore not yet answered", {
        action: this._action,
        tugSessionId: this._tugSessionId,
        attempts: this._attempts,
        lastSendReachedSocket: sent,
      });
    }
    // A frame that never reached the socket is worth re-asking sooner than
    // one that did: the wire is the thing that was missing, not the server.
    const delay = sent
      ? this._answerTimeoutMs
      : this._backoffMs[Math.min(this._attempts - 1, this._backoffMs.length - 1)]!;
    this._clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      this._attempt();
    }, delay);
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
