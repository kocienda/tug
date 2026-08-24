/**
 * session-restore — re-assert per-card session bindings after a
 * page reload, and track in-flight restore expectations so the dev
 * card body can render a `SessionRestoring` placeholder instead of the
 * project picker.
 *
 * Why it matters. `cardSessionBindingStore` is in-memory. On
 * WKWebView reload the deck layout is restored from tugbank but every
 * session card comes up unbound. Without this module the picker sheet
 * would mount on the active session card (via the `cardDidActivate`
 * initial-sync) and only dismiss once the `spawn_session_ok` ack
 * arrives — a brief but ugly "half-dismissed sheet" flash.
 *
 * Server-side prerequisites:
 *   - Tugcast's sqlite-backed `SessionLedger` records each session's
 *     `(card_id, project_dir, session_id)` on `session_init` (via
 *     `LedgerSessionsRecorder::record_spawn`). The row's `card_id`
 *     column is preserved across the session's lifecycle (close/fail),
 *     so the binding persists across tugcast restarts.
 *   - `AgentSupervisor::rebind_from_ledger` re-materializes the
 *     in-memory ledger map from sqlite at startup.
 *   - `on_client_disconnect` explicitly does not touch the ledger, so
 *     sessions survive a WS drop.
 *
 * Client-side flow:
 *   1. `restoreSessions` sends a `list_card_bindings` CONTROL
 *      request and waits for the `list_card_bindings_ok` response.
 *      Each binding is matched against the deck's dev cards by
 *      `card_id`. The match's `has_jsonl`, `turn_count`, and `is_alive`
 *      decide the mode:
 *      - `has_jsonl` OR `turn_count > 0` OR `is_alive` →
 *        `spawn_session(mode=resume)` with the persisted `session_id`.
 *        Routes into resume: an on-disk JSONL transcript (`has_jsonl` —
 *        the reliable signal; claude reopens the JSONL and replays
 *        history), the ledger's live turn counter, or a live tugcode
 *        subprocess holding mid-turn state — the in-flight-first-turn
 *        case where a permission / question is pending and no JSONL has
 *        been written yet.
 *      - none of the above → `spawn_session(mode=new)` with a fresh-in-
 *        place session under the same `session_id` and `project_dir`. The
 *        card opens to its bound project with a fresh claude session.
 *   2. The expectation is recorded in `sessionRestoreRegistry` with a
 *      20-second timeout. `SessionCardContent` subscribes to the
 *      registry and renders `SessionRestoring` whenever a card has a
 *      pending restore.
 *   3. Happy path — the server acks with `spawn_session_ok`, the
 *      existing action-dispatch handler writes the binding into
 *      `cardSessionBindingStore`, and the registry subscribes to that
 *      store, clears the entry, and `SessionCardContent` flips to
 *      `SessionCardBody`.
 *   4. Server-error path — tugcast broadcasts `SESSION_STATE: errored`
 *      for the session. The module's `SESSION_STATE` subscriber picks
 *      it up, clears the registry entry, and either retries (see
 *      below) or sets a `resume_failed` picker notice carrying the
 *      `(tug_session_id, project_dir)` so the picker's Retry button
 *      can re-fire.
 *   5. Timeout path — no ack, no error within the timeout. Retries;
 *      the `restore_timed_out` notice is what the exhausted budget
 *      leaves behind.
 *   6. User-cancel path — `cancelSessionRestore(cardId)` clears the
 *      registry entry and sets a `restore_canceled` notice. Per
 *      design choice: server state is preserved (no `close_session`
 *      fires), so next reload will retry the restore.
 *
 * Retry policy. A restore that fails is retried automatically up to
 * three times, at roughly 2 s / 6 s / 15 s, before the card falls
 * through to the picker. The picker remains the honest terminal
 * state — it is simply no longer the *first* thing a slow restore
 * produces, which it was when the recovery plan amounted to "the user
 * restarts the app".
 *
 *   - **Re-query before re-spawn.** Each retry issues
 *     `list_card_bindings` and re-fires `spawn_session` only for a
 *     card the fresh listing shows as genuinely unbound. A timeout is
 *     not proof of failure — a resume-mode spawn faces a 5–10 s
 *     tugcode boot — so the common case is that the original spawn
 *     landed late, and a blind re-send would race a spawn about to
 *     succeed.
 *   - **Classified rejections.** A `SESSION_STATE errored` carrying a
 *     known gate token (`session_live_in_terminal`,
 *     `session_live_elsewhere`) is an answer, not a transient: it goes
 *     straight to the picker with no retry. Everything else, including
 *     an unrecognized detail, is retried.
 *   - **Every armed timer has a release** ([L27]): a binding landing,
 *     a user cancel, an outright `spawn_session_error`, and a card
 *     close all disarm any pending retry.
 *   - Attempts are logged as `restore.retry_scheduled`,
 *     `restore.retry_skipped_already_bound`, and
 *     `restore.retry_exhausted`, so the log distinguishes "retried"
 *     from "turned out to be fine".
 *
 * Resumability: every non-failed binding surfaces in
 * `list_card_bindings_ok` regardless of `turn_count`. Sessions with
 * a JSONL (`has_jsonl`) or a live subprocess (`is_alive`) take
 * the `mode=resume` path; everything else falls back to
 * `mode=new`-with-same-project_dir so the card still opens to its
 * bound project without dropping the user back to the picker.
 *
 * @module lib/session-restore
 */

import type { DeckManager } from "../deck-manager";
import type { TugConnection } from "../connection";
import { provisionSpawnTag, sendSpawnSession } from "./session-lifecycle";
import { logSessionLifecycle } from "./session-lifecycle-log";
import { cardSessionBindingStore } from "./card-session-binding-store";
import { cardServicesStore } from "./card-services-store";
import { pickerNoticeStore } from "./picker-notice-store";
import { subscribeToListCardBindingsOk } from "./session-ledger-events";
import { CONTROL_ACTION_LIST_CARD_BINDINGS, FeedId } from "../protocol";
import type { CardBinding } from "../protocol";
import type { CodeSessionState } from "./code-session-store/reducer";

/** Component id for dev cards. Matches `registerSessionCard`'s registration. */
const SESSION_COMPONENT_ID = "session";

/**
 * Per-card restore timeout.
 *
 * A resume-mode spawn faces a documented 5–10 s tugcode boot, so the
 * previous 10 s left no margin at all above the cost it was meant to
 * tolerate — the timeout fired while the first spawn was legitimately
 * still in flight more often than not. 20 s removes most of that race
 * outright.
 *
 * Crossing it is no longer terminal: the timeout routes into
 * {@link scheduleRestoreRetry}, which re-queries before it re-spawns.
 * The picker notice is what happens after the retry budget is spent,
 * not what happens at the first timeout.
 */
const RESTORE_TIMEOUT_MS = 20_000;

/**
 * Backoff before each automatic retry of a failed restore. Three
 * entries = three retries after the initial attempt, then the card
 * falls to the picker, which stays the honest terminal state.
 *
 * Spread wide on purpose: the failures worth retrying are transient by
 * nature (tugcast still rebinding its ledger, the tugcode subprocess
 * still booting, a timeout that simply lost a race), and each of those
 * wants more time rather than a faster poll.
 */
const RESTORE_RETRY_BACKOFF_MS = [2_000, 6_000, 15_000] as const;

/**
 * Rejection details that are answers, not failures. A session held
 * open in a terminal will still be held open on the third attempt, so
 * retrying only turns a fast, legible message into three slow ones.
 * Everything else — including an unrecognized detail — is treated as
 * possibly transient and retried.
 */
const TERMINAL_REJECTION_DETAILS: ReadonlySet<string> = new Set([
  "session_live_in_terminal",
  "session_live_elsewhere",
]);

/**
 * Backstop for the startup restore pass: if `list_card_bindings_ok`
 * never lands, settle the pass gate anyway after this long so an
 * unbound session card is not stranded on the restore placeholder. The
 * `list_card_bindings` query reads the supervisor's in-memory ledger
 * and answers in tens of ms in the healthy case; a response past this
 * window means the server is effectively dead, at which point the
 * card should fall through to the picker.
 */
const RESTORE_PASS_SETTLE_TIMEOUT_MS = 5_000;

/** Per-card restore context — enough to drive Retry and Cancel copy. */
export interface RestoreExpectation {
  readonly tugSessionId: string;
  readonly projectDir: string;
}

/**
 * Tracks in-flight restore expectations. Subscribable via
 * `useSyncExternalStore` so `SessionCardContent` can render
 * `SessionRestoring` reactively.
 */
class SessionRestoreRegistry {
  private entries: Map<string, RestoreExpectation> = new Map();
  private timeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): Map<string, RestoreExpectation> => this.entries;

  has = (cardId: string): boolean => this.entries.has(cardId);

  get = (cardId: string): RestoreExpectation | undefined =>
    this.entries.get(cardId);

  /**
   * Record an in-flight restore and arm the timeout. `onTimeout` runs
   * on the `setTimeout` macrotask unless `clear(cardId)` is called
   * first — binding arrival, SESSION_STATE errored, and user cancel
   * all clear the entry before the timer fires.
   */
  _register(
    cardId: string,
    expectation: RestoreExpectation,
    onTimeout: () => void,
  ): void {
    const next = new Map(this.entries);
    next.set(cardId, expectation);
    this.entries = next;
    const handle = setTimeout(onTimeout, RESTORE_TIMEOUT_MS);
    this.timeouts.set(cardId, handle);
    this._emit();
  }

  _clear(cardId: string): void {
    if (!this.entries.has(cardId)) return;
    const next = new Map(this.entries);
    next.delete(cardId);
    this.entries = next;
    const handle = this.timeouts.get(cardId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timeouts.delete(cardId);
    }
    this._emit();
  }

  private _emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const sessionRestoreRegistry = new SessionRestoreRegistry();

// ---------------------------------------------------------------------------
// Restore-start clock
// ---------------------------------------------------------------------------

/**
 * Per-card `Date.now()` of when the current restore began — stamped by
 * `fireRestore` the moment `spawn_session(mode=resume)` is sent.
 *
 * The `SessionRestoring` placeholder delay-gates its centered panel on
 * this: the panel appears only once the restore has run longer than
 * the budget, so a fast restore shows nothing and a slow one explains
 * itself. The stamp must outlive the `sessionRestoreRegistry` entry —
 * that entry clears the instant the binding lands, well before the
 * post-services replay window finishes — and it must survive the
 * `SessionRestoring` remount at the `services`-null boundary, so a
 * component-local timer cannot hold it. A module-level map keyed by
 * `cardId` is the one reference both the pre-services and the
 * cold-restore-in-body renders of `SessionRestoring` can read.
 *
 * Lifecycle: stamped (and re-stamped) by every `fireRestore`; cleared
 * by `clearRestoreStartedAt` when the card body reveals. Every path
 * that shows `SessionRestoring` is preceded by a `fireRestore`, so a
 * missing stamp (`getRestoreStartedAt` → `undefined`) means "treat as
 * just started" — the safe fallback that arms the full budget.
 */
const restoreStartedAt = new Map<string, number>();

/** `Date.now()` of the in-flight restore for `cardId`, if any. */
export function getRestoreStartedAt(cardId: string): number | undefined {
  return restoreStartedAt.get(cardId);
}

/** Drop the restore-start stamp once the card body has revealed. */
export function clearRestoreStartedAt(cardId: string): void {
  restoreStartedAt.delete(cardId);
  resumeDisplayMetadata.delete(cardId);
}

// ---------------------------------------------------------------------------
// Stranded queued sends — the one thing that must outlive the dispose
// ---------------------------------------------------------------------------

/**
 * Sends the user queued at a card, held across the destruction of that
 * card's services bag.
 *
 * A reconnect calls `cardSessionBindingStore.clearAll()` *before* any
 * restore is attempted, which disposes every card's `CodeSessionStore`
 * — and with it any messages the user typed and asked to deliver while
 * a turn was running. Preserving the queue inside the store is
 * therefore not enough on its own: the store dies milliseconds later.
 * The queue has to live somewhere the dispose cannot reach, which is
 * what this map is. Losing those messages is [L23] — an internal
 * implementation operation destroying user-visible state — and unlike
 * the transcript there is nothing on screen to mark that it happened.
 *
 * Keyed by `cardId`, not `tugSessionId`: the user queued the message
 * *at a card*, and a card that comes back on a different session
 * should still carry it.
 *
 * Lifecycle: written by `CardServicesStore._dispose` when it tears
 * down a store with a non-empty queue; drained (and cleared) by
 * `_construct` when the replacement store is wired up; cleared
 * outright when the user closes the card, so a queued message cannot
 * resurface on an unrelated later session. Module scope means it is
 * bounded by the app session — nothing here is persisted, and a
 * message cannot survive a reload.
 */
type StrandedSends = CodeSessionState["queuedSends"];

const strandedQueuedSends = new Map<string, StrandedSends>();

/** Hold a disposing card's queued sends for its replacement store. */
export function stashQueuedSends(cardId: string, sends: StrandedSends): void {
  if (sends.length === 0) return;
  strandedQueuedSends.set(cardId, sends);
  logSessionLifecycle("queued_sends.stashed", {
    card_id: cardId,
    count: sends.length,
  });
}

/**
 * Take back this card's stranded sends, if any, clearing the entry.
 * Draining is destructive by design — a stash that could be read twice
 * would double-send.
 */
export function drainQueuedSends(cardId: string): StrandedSends | undefined {
  const sends = strandedQueuedSends.get(cardId);
  if (sends === undefined) return undefined;
  strandedQueuedSends.delete(cardId);
  logSessionLifecycle("queued_sends.drained", {
    card_id: cardId,
    count: sends.length,
  });
  return sends;
}

/** Discard a card's stranded sends without delivering them. */
export function clearQueuedSends(cardId: string): void {
  strandedQueuedSends.delete(cardId);
}

// ---------------------------------------------------------------------------
// Resume display metadata — the t=0 progress facts
// ---------------------------------------------------------------------------

/**
 * What the replay progress affordance can say about the session BEFORE
 * any frame arrives ("Restoring <title> — … of 106 turns"). Both
 * resume entry paths know it at fire time: the picker has the selected
 * ledger row (name, prompt snippet, turn count); the cold-boot restore
 * pass has the `list_card_bindings` row (turn count). Same
 * module-level lifecycle as the restore-start stamp above — stamped by
 * `fireRestore`, read by the in-body progress strip across the whole
 * replay window (which outlives the `sessionRestoreRegistry` entry),
 * cleared with the stamp when the restore settles.
 */
export interface ResumeDisplayMetadata {
  /** Session display title (name or prompt snippet); null when unknown. */
  readonly title: string | null;
  /** Expected committed-turn total from the ledger; null when unknown. */
  readonly turnCount: number | null;
}

const resumeDisplayMetadata = new Map<string, ResumeDisplayMetadata>();

/** The in-flight resume's display metadata for `cardId`, if any. */
export function getResumeDisplayMetadata(
  cardId: string,
): ResumeDisplayMetadata | undefined {
  return resumeDisplayMetadata.get(cardId);
}

// ---------------------------------------------------------------------------
// Restore-pass gate
// ---------------------------------------------------------------------------

/**
 * Per-app gate: has the startup restore pass settled?
 *
 * `restoreSessions` sends `list_card_bindings` and only learns
 * which cards have a session to restore when the response lands. In
 * the window before that, a session card that mounts unbound has no
 * `sessionRestoreRegistry` entry yet — and `SessionCardContent` would fall
 * through to the project picker, dropping its `TugSheet` for the
 * round-trip until `fireRestore` flips the card to `SessionRestoring`.
 * That is the picker-sheet flash.
 *
 * This gate closes the window. `SessionCardContent` holds an unbound
 * card on the restore placeholder until the gate is settled; only
 * then does an unbound card with no restore expectation fall through
 * to the picker — by which point it is genuinely a fresh card, not
 * one mid-restore.
 *
 * One-shot: `false` at boot, `true` once the first `restoreSessions`
 * pass resolves, never back. Settled on every exit path of
 * `restoreSessions` — the no-session-cards early-out, the
 * `list_card_bindings_ok` handler, and a timeout backstop for a
 * response that never lands.
 *
 * Exported as a class (not just the `restorePassGate` singleton) so
 * the idempotency invariant — a reconnect re-fire or a timeout racing
 * the response must not re-notify — is unit-testable on a fresh
 * instance.
 */
export class RestorePassGate {
  private settled = false;
  private listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): boolean => this.settled;

  /**
   * Mark the startup restore pass resolved. Idempotent — the first
   * settle wins; later calls (a reconnect pass, a timeout racing the
   * response) are no-ops.
   */
  _settle(): void {
    if (this.settled) return;
    this.settled = true;
    for (const listener of this.listeners) listener();
  }
}

export const restorePassGate = new RestorePassGate();

// ---------------------------------------------------------------------------
// Automatic restore retry
// ---------------------------------------------------------------------------

/**
 * Retries already spent on the current restore of each card.
 *
 * Cleared when the card's binding lands (the same place the registry
 * hold clears on success), when the user cancels, and when the budget
 * is exhausted. Module scope for the same reason as `restoreStartedAt`
 * above — it must outlive the component tree that comes and goes
 * across the restore — and in memory only: never React state, never
 * browser storage.
 */
const restoreAttempts = new Map<string, number>();

/** Armed retry timers, so every one of them has a release ([L27]). */
const restoreRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** What a retry needs to know to re-fire the right kind of spawn. */
interface RestoreRetryContext {
  readonly cardId: string;
  readonly tugSessionId: string;
  readonly projectDir: string;
  readonly connection: TugConnection;
  readonly mode: "resume" | "new";
  readonly display?: ResumeDisplayMetadata;
  /** Run when the budget is spent — the card's honest terminal state. */
  readonly onExhausted: () => void;
}

/**
 * Cancel any pending retry for a card and forget its attempt count.
 *
 * Called when the binding lands (the restore succeeded, possibly on an
 * attempt we had already given up waiting for), when the user cancels,
 * when the server rejects terminally, and when the card closes.
 */
export function cancelRestoreRetry(cardId: string): void {
  const timer = restoreRetryTimers.get(cardId);
  if (timer !== undefined) {
    clearTimeout(timer);
    restoreRetryTimers.delete(cardId);
  }
  restoreAttempts.delete(cardId);
}

/**
 * Schedule the next automatic retry of a failed restore, or give up.
 *
 * This is the change that answers the actual complaint. Before it, a
 * restore that timed out or was rejected just dropped the card to the
 * picker, on the stated assumption that "the next reload retries" —
 * i.e. the recovery plan was *the user restarts the app*, which is
 * precisely what makes walking away from a long turn unsafe.
 *
 * The retry does NOT blindly re-send `spawn_session`. See
 * {@link fireRestoreRetry} — a timeout is not proof of failure, and a
 * second concurrent spawn for a session that is about to bind has no
 * established contract making it safe.
 */
function scheduleRestoreRetry(ctx: RestoreRetryContext): void {
  const attempts = restoreAttempts.get(ctx.cardId) ?? 0;
  if (attempts >= RESTORE_RETRY_BACKOFF_MS.length) {
    logSessionLifecycle("restore.retry_exhausted", {
      card_id: ctx.cardId,
      tug_session_id: ctx.tugSessionId,
      attempts,
    });
    cancelRestoreRetry(ctx.cardId);
    ctx.onExhausted();
    return;
  }

  const delayMs = RESTORE_RETRY_BACKOFF_MS[attempts];
  restoreAttempts.set(ctx.cardId, attempts + 1);
  logSessionLifecycle("restore.retry_scheduled", {
    card_id: ctx.cardId,
    tug_session_id: ctx.tugSessionId,
    attempt: attempts + 1,
    delay_ms: delayMs,
  });

  const timer = setTimeout(() => {
    restoreRetryTimers.delete(ctx.cardId);
    fireRestoreRetry(ctx);
  }, delayMs);
  restoreRetryTimers.set(ctx.cardId, timer);
}

/**
 * Run one retry: re-query first, and re-spawn only if the listing says
 * the card is genuinely still unbound.
 *
 * Asking before acting is the whole point. A resume-mode spawn faces a
 * 5–10 s tugcode boot, so the common failure is not failure at all —
 * it is impatience, and the original spawn lands a moment later.
 * Re-sending `spawn_session` on top of that would race a spawn that is
 * about to succeed. `list_card_bindings` is authoritative about what
 * actually landed server-side, so asking it turns the guess into a
 * fact and makes the common case cost one CONTROL round-trip instead
 * of a duplicate spawn.
 *
 * Subscribing to the authoritative listing and responding to what it
 * publishes is also the direction [L28] requires — reaching into the
 * live spawn to re-drive it would be the source→delegate inversion the
 * law forbids.
 */
function fireRestoreRetry(ctx: RestoreRetryContext): void {
  const { cardId, connection } = ctx;

  // Cheapest authority first: if this client already holds the
  // binding, the spawn landed while we were waiting.
  if (cardSessionBindingStore.getBinding(cardId) !== undefined) {
    logSessionLifecycle("restore.retry_skipped_already_bound", {
      card_id: cardId,
      tug_session_id: ctx.tugSessionId,
      source: "binding_store",
    });
    cancelRestoreRetry(cardId);
    return;
  }

  // Backstop the query itself: no answer means the server is
  // effectively dead, which is a reason to back off and try again
  // rather than to re-spawn into the dark.
  let settled = false;
  const queryTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    unsubscribe();
    logSessionLifecycle("restore.retry_query_timed_out", {
      card_id: cardId,
      tug_session_id: ctx.tugSessionId,
    });
    scheduleRestoreRetry(ctx);
  }, RESTORE_PASS_SETTLE_TIMEOUT_MS);

  const unsubscribe = subscribeToListCardBindingsOk(({ bindings }) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    clearTimeout(queryTimeout);

    const row = bindings
      .filter(isCardBinding)
      .find((b) => b.card_id === cardId);

    // A live subprocess for this card means the original spawn landed
    // late. Clear the retry rather than duplicating it.
    if (row?.is_alive === true) {
      logSessionLifecycle("restore.retry_skipped_already_bound", {
        card_id: cardId,
        tug_session_id: ctx.tugSessionId,
        source: "list_card_bindings",
      });
      cancelRestoreRetry(cardId);
      return;
    }

    // Genuinely unbound. Re-fire, preferring the fresh listing's view
    // of the row over the stale one this retry was scheduled with.
    if (row !== undefined) {
      // `is_alive` is not consulted here — a live row returned above.
      const resumable = row.has_jsonl === true || row.turn_count > 0;
      if (resumable) {
        fireRestore(cardId, row.session_id, row.project_dir, connection, {
          title: null,
          turnCount: row.turn_count,
        });
      } else {
        fireFreshSpawn(cardId, row.session_id, row.project_dir, connection);
      }
      return;
    }

    // No row at all — fall back to what the original attempt knew.
    if (ctx.mode === "resume") {
      fireRestore(
        cardId,
        ctx.tugSessionId,
        ctx.projectDir,
        connection,
        ctx.display,
      );
    } else {
      fireFreshSpawn(cardId, ctx.tugSessionId, ctx.projectDir, connection);
    }
  });

  connection.sendControlFrame(CONTROL_ACTION_LIST_CARD_BINDINGS, {});
}

// ---------------------------------------------------------------------------
// Subscription wiring — installed once at startup by `restoreSessions`.
// ---------------------------------------------------------------------------

let _subscriptionsInstalled = false;

function installRegistrySubscriptions(connection: TugConnection): void {
  if (_subscriptionsInstalled) return;
  _subscriptionsInstalled = true;

  // When a binding arrives for a restoring card, the restore succeeded.
  // Also notify the card's CodeSessionStore that the wire is settled,
  // so its `transportState` can flip from `restoring` back to `online`
  // (per [D04] / [D07]). The lookup runs here rather than inside
  // `cardServicesStore` because `cardServicesStore` is responsible only
  // for owning the per-card services bag — the "the supervisor has
  // re-acked, transport is settled" semantic belongs to this restore
  // module, which already owns the corresponding restore-registry
  // bookkeeping.
  cardSessionBindingStore.subscribe(() => {
    const bindings = cardSessionBindingStore.getSnapshot();
    for (const cardId of Array.from(sessionRestoreRegistry.getSnapshot().keys())) {
      if (bindings.has(cardId)) {
        sessionRestoreRegistry._clear(cardId);
        // The restore landed — possibly on an attempt we had already
        // stopped waiting for. Disarm any pending retry so it cannot
        // spawn a duplicate ([L27]).
        cancelRestoreRetry(cardId);
        const services = cardServicesStore.getServices(cardId);
        services?.codeSessionStore.notifyTransportSettled();
      }
    }
  });

  // When tugcast reports an errored SESSION_STATE for a restoring
  // session, the restore failed.
  connection.onFrame(FeedId.SESSION_STATE, (payload) => {
    const msg = parseSessionStateFrame(payload);
    if (msg === null || msg.state !== "errored") return;
    for (const [cardId, expectation] of Array.from(
      sessionRestoreRegistry.getSnapshot(),
    )) {
      if (expectation.tugSessionId !== msg.tugSessionId) continue;
      sessionRestoreRegistry._clear(cardId);
      logSessionLifecycle("restore.server_rejected", {
        card_id: cardId,
        tug_session_id: expectation.tugSessionId,
        detail: msg.detail ?? null,
      });

      const toPicker = (): void => {
        pickerNoticeStore.set(cardId, {
          category: "resume_failed",
          message: resumeRejectionMessage(msg.detail, expectation.projectDir),
          staleTugSessionId: expectation.tugSessionId,
          staleProjectDir: expectation.projectDir,
        });
      };

      // A rejection with a known gate token is an answer, not a
      // failure: the session is held open somewhere else and will
      // still be held on the third attempt. Surface it immediately
      // rather than spending the budget to say the same thing slowly.
      if (msg.detail !== null && TERMINAL_REJECTION_DETAILS.has(msg.detail)) {
        cancelRestoreRetry(cardId);
        toPicker();
        break;
      }

      // Anything else — including an unrecognized detail — may be
      // transient (tugcast still rebinding, tugcode still booting).
      scheduleRestoreRetry({
        cardId,
        tugSessionId: expectation.tugSessionId,
        projectDir: expectation.projectDir,
        connection,
        mode: "resume",
        onExhausted: toPicker,
      });
      break;
    }
  });
}

/**
 * Map a resume-rejection `detail` token to picker-notice copy. Known
 * gate rejections get friendly lines (the terminal-live race — the
 * session was free at list time, then a terminal grabbed it before
 * Open); unknown tokens surface verbatim, matching the previous
 * behavior so new backend reasons stay legible.
 */
function resumeRejectionMessage(detail: string | null, projectDir: string): string {
  switch (detail) {
    case "session_live_in_terminal":
      return "This session is open in a terminal. Close it there, then resume.";
    case "session_live_elsewhere":
      return "This session is live on another card.";
    default:
      return detail ?? `Could not resume session for "${projectDir}".`;
  }
}

// SESSION_STATE payload shape lives in tugcast's `build_session_state_frame`:
// `{ tug_session_id: string, state: "pending"|"spawning"|"live"|"errored"|"closed", detail?: string }`.
interface SessionStateMessage {
  tugSessionId: string;
  state: string;
  detail: string | null;
}

function parseSessionStateFrame(payload: Uint8Array): SessionStateMessage | null {
  try {
    const json = new TextDecoder().decode(payload);
    const raw = JSON.parse(json) as Record<string, unknown>;
    const tugSessionId = raw.tug_session_id;
    const state = raw.state;
    const detail = raw.detail;
    if (typeof tugSessionId !== "string" || typeof state !== "string") {
      return null;
    }
    return {
      tugSessionId,
      state,
      detail: typeof detail === "string" ? detail : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reason a `restoreSessions` call is happening. Surfaced on the
 * `restore.fired_resume_spawns` lifecycle log so traces distinguish the
 * one-time startup pass from reconnect-driven re-asserts.
 */
export type RestoreReason = "startup" | "reconnect";

export interface RestoreOptions {
  readonly reason?: RestoreReason;
}

/**
 * Re-assert session bindings for every session card in the deck that the
 * server's ledger has a binding for. Sends a `list_card_bindings`
 * CONTROL request and dispatches `spawn_session(mode=resume)` per
 * matching deck card on the response. Callers should invoke after
 * `DeckManager` has loaded the layout — typically right after
 * `initActionDispatch` in `main.tsx`.
 *
 * Idempotent across calls. The module-level
 * `installRegistrySubscriptions` guard ensures the binding-arrival and
 * SESSION_STATE subscribers are wired exactly once even when this
 * function runs again on reconnect; `fireRestore` itself clears any
 * stale per-card timer before arming a new one, so a re-fire after a
 * previous restore is well-defined.
 */
export function restoreSessions(
  deck: DeckManager,
  connection: TugConnection,
  opts?: RestoreOptions,
): void {
  installRegistrySubscriptions(connection);

  const sessionCardIds = new Set(
    deck
      .getSnapshot()
      .cards.filter((c) => c.componentId === SESSION_COMPONENT_ID)
      .map((c) => c.id),
  );
  if (sessionCardIds.size === 0) {
    // No dev cards to restore — the pass is trivially settled.
    restorePassGate._settle();
    return;
  }

  // Backstop: settle the pass gate even if `list_card_bindings_ok`
  // never lands, so an unbound session card is not stranded on the
  // restore placeholder. Cleared in the response handler below; a
  // late fire is a harmless no-op (`_settle` is idempotent).
  const passSettleTimeout = setTimeout(() => {
    restorePassGate._settle();
  }, RESTORE_PASS_SETTLE_TIMEOUT_MS);

  // Subscribe once for the matching response, then drop the
  // subscription. The bus is process-global, so we filter by the
  // deck's dev cards here.
  const reason = opts?.reason ?? "startup";
  const unsubscribe = subscribeToListCardBindingsOk(({ bindings }) => {
    unsubscribe();
    clearTimeout(passSettleTimeout);
    let resumedCount = 0;
    let freshCount = 0;
    // Track which cards we've already fired for. Multiple ledger rows
    // can map to the same card_id (sequential sessions on that card);
    // the wire orders rows newest-first by `last_used_at`, so the
    // first match per card_id wins.
    const fired = new Set<string>();
    for (const binding of bindings) {
      if (!isCardBinding(binding)) continue;
      if (!sessionCardIds.has(binding.card_id)) continue;
      if (fired.has(binding.card_id)) continue;
      fired.add(binding.card_id);
      // Resume when ANY of: (a) an on-disk JSONL transcript exists
      // (`has_jsonl` — the exact file a `mode=resume` spawn targets),
      // (b) the ledger recorded live turns (`turn_count > 0`), or (c) the
      // live supervisor still holds a subprocess entry (`is_alive`). Case
      // (c) covers the **in-flight first turn**: the user submitted, claude
      // is mid-response or blocked on a permission/question control_request,
      // but no turn has committed to JSONL yet — resuming hands the card back
      // to the same tugcode subprocess so the in-flight snapshot path
      // delivers the partial assistant text and any pending
      // `control_request_forward`. Without `is_alive` we'd take the
      // fresh-spawn branch below and orphan the live session.
      //
      // `has_jsonl` is the primary, reliable content signal. `turn_count` was
      // the original proxy but is unsound: claude writes the JSONL itself, so
      // a session can carry a full transcript while the ledger's live
      // `record_turn` counter stays 0 (the turns never flowed through a live
      // `turn_complete`). Such a session has `turn_count === 0` yet is fully
      // resumable — gating on `turn_count` alone mis-routed it to `mode=new`,
      // whose `--session-id` collided with the existing JSONL and crash-looped
      // the card to `errored`. Keying on `has_jsonl` closes that hole; the
      // `turn_count`/`is_alive` clauses remain as conservative fallbacks for
      // an older server that emits neither the file-presence signal.
      const isAlive = binding.is_alive === true;
      const hasJsonl = binding.has_jsonl === true;
      if (hasJsonl || binding.turn_count > 0 || isAlive) {
        fireRestore(
          binding.card_id,
          binding.session_id,
          binding.project_dir,
          connection,
          { title: null, turnCount: binding.turn_count },
        );
        resumedCount += 1;
      } else {
        // Card was bound to a project but no turn ever happened and
        // no live subprocess is holding mid-turn state (Start Fresh
        // + quit, or a shell-only / `/btw`-only session). claude has no
        // JSONL, so a `resume`-mode spawn would fail — but we still
        // PRESERVE the original `session_id`. A `new`-mode spawn under
        // the same id re-keys the session's durable non-JSONL content
        // (the shell ledger + the `/btw` history + the staged-context
        // queue, all keyed by `tug_session_id`) so a shell-only session's
        // rows survive relaunch instead of being orphaned under a fresh
        // UUID. Server-side `record_spawn` upserts on `session_id`, so the
        // existing row (name, created_at, tag) is updated in place.
        fireFreshSpawn(
          binding.card_id,
          binding.session_id,
          binding.project_dir,
          connection,
        );
        freshCount += 1;
      }
    }
    if (resumedCount > 0 || freshCount > 0) {
      logSessionLifecycle("restore.fired_resume_spawns", {
        card_count: sessionCardIds.size,
        restore_count: resumedCount,
        fresh_spawn_count: freshCount,
        reason,
      });
    }
    // The startup restore pass has resolved: every card with a ledger
    // binding now has a `sessionRestoreRegistry` entry (or a fresh-spawn
    // in flight). An unbound card with neither is genuinely a fresh
    // card and may fall through to the picker.
    restorePassGate._settle();
  });

  // Fire the request. `action-dispatch` decodes the response and
  // publishes onto `listCardBindingsOkBus`, which the subscription
  // above consumes.
  connection.sendControlFrame(CONTROL_ACTION_LIST_CARD_BINDINGS, {});
}

function isCardBinding(value: unknown): value is CardBinding {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.card_id === "string" &&
    obj.card_id.length > 0 &&
    typeof obj.session_id === "string" &&
    obj.session_id.length > 0 &&
    typeof obj.project_dir === "string" &&
    obj.project_dir.length > 0 &&
    typeof obj.turn_count === "number"
  );
}

/**
 * Spawn a fresh (JSONL-less) claude session on a card. Used by
 * `restoreSessions` for zero-turn rows: the previous session never had
 * any Claude turns (so there's no JSONL to resume), but the card was
 * bound to a session whose id keys durable non-JSONL content — the
 * shell ledger, the `/btw` history, the staged-context queue. Also used
 * by ConfigureTug's "Start" gesture, which hands the wizard's
 * projects folder straight to a freshly-added card (a minted session id)
 * rather than dropping the user into the picker to say it again.
 *
 * PRESERVES the original `session_id` (passed in, not minted): a
 * `new`-mode spawn re-uses the id so that content re-keys to the same
 * session on relaunch instead of being orphaned under a fresh UUID
 * (the shell-only-session data-loss bug). Server-side `record_spawn`
 * upserts on `session_id` (`ON CONFLICT(session_id) DO UPDATE`), so the
 * existing ledger row — name, created_at, tag — survives untouched.
 *
 * Registers a `sessionRestoreRegistry` hold for the pre-binding window.
 * Without it, `restorePassGate` settles the instant this pass
 * resolves and the still-unbound card falls straight through to the
 * project picker — its `TugSheet` flashing for the `spawn_session`
 * round-trip. The hold keeps the card on the quiet `SessionRestoring`
 * backdrop instead. It clears on binding arrival (success), on a
 * `spawn_session_error` via `notifySpawnRejected` (rejection), or on
 * the timeout backstop. A `new`-mode spawn has no JSONL to replay, so
 * the hold spans only the bind round-trip — typically single-digit
 * milliseconds, below the placeholder's panel-reveal budget, so a
 * healthy fresh spawn shows only the quiet backdrop.
 */
export function fireFreshSpawn(
  cardId: string,
  tugSessionId: string,
  projectDir: string,
  connection: TugConnection,
): void {
  // Drop any prior in-flight restore timer before arming a new hold.
  sessionRestoreRegistry._clear(cardId);
  // Stamp the restore-start clock — the `SessionRestoring` placeholder
  // delay-gates its centered panel on this, so a fast fresh spawn
  // shows only the backdrop and a slow one explains itself.
  restoreStartedAt.set(cardId, Date.now());
  const tag = provisionSpawnTag(tugSessionId);
  sendSpawnSession(connection, cardId, tugSessionId, projectDir, "new", tag);
  sessionRestoreRegistry._register(
    cardId,
    { tugSessionId, projectDir },
    () => {
      // Timeout backstop: no `spawn_session_ok`, no rejection. Drop
      // the hold and retry — the ledger row is preserved server-side,
      // and a card that has to wait for the user to relaunch the app
      // is a card that was lost.
      if (!sessionRestoreRegistry.has(cardId)) return;
      sessionRestoreRegistry._clear(cardId);
      logSessionLifecycle("restore.fresh_spawn_timed_out", {
        card_id: cardId,
        tug_session_id: tugSessionId,
        project_dir: projectDir,
        timeout_ms: RESTORE_TIMEOUT_MS,
      });
      scheduleRestoreRetry({
        cardId,
        tugSessionId,
        projectDir,
        connection,
        mode: "new",
        onExhausted: () => {},
      });
    },
  );
}

/**
 * Send the `spawn_session(mode=resume)` frame and register the
 * restore expectation. Shared between startup restore and the
 * picker's Retry button.
 */
export function fireRestore(
  cardId: string,
  tugSessionId: string,
  projectDir: string,
  connection: TugConnection,
  display?: ResumeDisplayMetadata,
): void {
  // If a previous restore was in flight (Retry after cancel/timeout),
  // drop the old timer before arming a new one.
  sessionRestoreRegistry._clear(cardId);
  // Stamp the restore-start clock — the `SessionRestoring` placeholder
  // delay-gates its panel on this. Re-stamped on a Retry / reconnect
  // re-fire so the budget always runs from the live attempt.
  restoreStartedAt.set(cardId, Date.now());
  // Stamp the progress facts so the in-body affordance is informative
  // from its first paint, before any frame exists (Spec S03 of the
  // resume-performance plan).
  if (display !== undefined) {
    resumeDisplayMetadata.set(cardId, display);
  } else {
    resumeDisplayMetadata.delete(cardId);
  }
  // Resume: reuse the row's tag (from the store, seeded on listing/binding), or
  // mint one to backfill a legacy tagless row.
  const tag = provisionSpawnTag(tugSessionId);
  sendSpawnSession(connection, cardId, tugSessionId, projectDir, "resume", tag);
  sessionRestoreRegistry._register(
    cardId,
    { tugSessionId, projectDir },
    () => {
      // Timeout: no ack, no error. Retry rather than dropping the card
      // — the picker is where this ends only once the budget is spent.
      if (!sessionRestoreRegistry.has(cardId)) return;
      sessionRestoreRegistry._clear(cardId);
      logSessionLifecycle("restore.timed_out", {
        card_id: cardId,
        tug_session_id: tugSessionId,
        project_dir: projectDir,
        timeout_ms: RESTORE_TIMEOUT_MS,
      });
      scheduleRestoreRetry({
        cardId,
        tugSessionId,
        projectDir,
        connection,
        mode: "resume",
        ...(display !== undefined ? { display } : {}),
        onExhausted: () => {
          pickerNoticeStore.set(cardId, {
            category: "restore_timed_out",
            message: `Could not restore "${projectDir}" after several attempts.`,
            staleTugSessionId: tugSessionId,
            staleProjectDir: projectDir,
          });
        },
      });
    },
  );
}

/**
 * User clicked Cancel in `SessionRestoring`. Clear the in-flight
 * expectation and drop to the picker with a `restore_canceled`
 * notice. Per design: server state is preserved — no `close_session`
 * frame fires, so next reload will retry the restore from the ledger.
 */
export function cancelSessionRestore(cardId: string): void {
  const expectation = sessionRestoreRegistry.get(cardId);
  if (expectation === undefined) return;
  sessionRestoreRegistry._clear(cardId);
  // The user asked to stop. An automatic retry firing after that
  // would be the card overruling them.
  cancelRestoreRetry(cardId);
  pickerNoticeStore.set(cardId, {
    category: "restore_canceled",
    message: `Canceled restore of "${expectation.projectDir}".`,
    staleTugSessionId: expectation.tugSessionId,
    staleProjectDir: expectation.projectDir,
  });
  logSessionLifecycle("restore.user_canceled", {
    card_id: cardId,
    tug_session_id: expectation.tugSessionId,
  });
}

/**
 * Drop a card's in-flight restore / fresh-spawn hold because tugcast
 * rejected its `spawn_session` outright — a `spawn_session_error`
 * CONTROL frame, e.g. the project directory no longer exists.
 *
 * Clears the `sessionRestoreRegistry` entry so `SessionCardContent` falls
 * through from the `SessionRestoring` placeholder to the project picker,
 * which surfaces the rejection (read live from `sessionSpawnErrorStore`) as
 * its own inline alert inside the sheet — one surface, not a banner layered
 * behind the picker.
 *
 * A no-op when the card has no registry entry: a rejection that races
 * a card the user never had on a restore hold simply does nothing.
 */
export function notifySpawnRejected(cardId: string): void {
  sessionRestoreRegistry._clear(cardId);
  // An outright `spawn_session_error` (e.g. the project directory is
  // gone) is a fact about the world, not a race — retrying it would
  // just re-ask a question already answered.
  cancelRestoreRetry(cardId);
}
