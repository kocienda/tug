/**
 * `LedgerRestoreFetch` — a CONTROL restore read that keeps asking until it is
 * answered ([P07]).
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
 * backoff. {@link settle} stops the retries; exhausting them logs a `warn`
 * naming the action and the session, so a transcript that came back short is
 * a fact in the Log tab rather than something to notice by eye days later.
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

/** Attempts before giving up and logging. ~13s of asking. */
const MAX_ATTEMPTS = 6;

export interface LedgerRestoreFetchOptions {
  /** CONTROL action to send, e.g. `"list_shell_exchanges"`. */
  action: string;
  /** The session whose rows are being restored; rides the request. */
  tugSessionId: string;
  /** Dev-log source for this fetch's warnings, e.g. `"shell-restore"`. */
  logSource: string;
  /**
   * Timing policy. Defaults are {@link ANSWER_TIMEOUT_MS} /
   * {@link RETRY_BACKOFF_MS} / {@link MAX_ATTEMPTS}; tests pass their own so
   * they pin the retry behaviour without spending its wall-clock.
   */
  answerTimeoutMs?: number;
  backoffMs?: ReadonlyArray<number>;
  maxAttempts?: number;
}

export class LedgerRestoreFetch {
  private readonly _action: string;
  private readonly _tugSessionId: string;
  private readonly _logSource: string;
  private readonly _answerTimeoutMs: number;
  private readonly _backoffMs: ReadonlyArray<number>;
  private readonly _maxAttempts: number;
  private _attempts = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _settled = false;
  private _disposed = false;

  constructor(opts: LedgerRestoreFetchOptions) {
    this._action = opts.action;
    this._tugSessionId = opts.tugSessionId;
    this._logSource = opts.logSource;
    this._answerTimeoutMs = opts.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
    this._backoffMs = opts.backoffMs ?? RETRY_BACKOFF_MS;
    this._maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  }

  /** Send the first request and arm the retry that follows an unanswered one. */
  start(): void {
    if (this._disposed || this._settled) return;
    this._attempt();
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
  }

  dispose(): void {
    this._disposed = true;
    this._clearTimer();
  }

  private _attempt(): void {
    if (this._disposed || this._settled) return;
    this._attempts += 1;
    const sent =
      getConnection()?.trySend(
        FeedId.CONTROL,
        new TextEncoder().encode(
          JSON.stringify({ action: this._action, tug_session_id: this._tugSessionId }),
        ),
      ) ?? false;
    if (this._attempts >= this._maxAttempts) {
      tugDevLogStore.warn(this._logSource, "ledger restore never answered", {
        action: this._action,
        tugSessionId: this._tugSessionId,
        attempts: this._attempts,
        lastSendReachedSocket: sent,
      });
      return;
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
