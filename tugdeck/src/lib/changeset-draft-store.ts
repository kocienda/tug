/**
 * Changeset draft overlay store — the live presentation layer over the
 * maintained-draft engine's CONTROL frames (Spec S10, [P24]).
 *
 * The persisted draft rides the aggregate snapshot (`entry.draft`), which is
 * the source of truth. While the engine is regenerating, it broadcasts
 * `changeset_draft_state` (drafting → ready/error) and `changeset_draft_delta`
 * (accumulated text) frames so a visible card fills in live. This store keys
 * those by `(workspace_key, owner_kind, owner_id)` and exposes them to the
 * card via `useSyncExternalStore` ([L02]); the streaming text is a nicety over
 * the persisted message, never a replacement.
 *
 * The key is `workspace_key` and never a `project_dir`, and that is [L29]
 * doing real work: a directory has many spellings, this store compares keys as
 * plain strings, and there is no canonicalization gateway in the deck to
 * reconcile two of them. `workspace_key` is the one spelling the registry
 * minted through the gateway; the deck receives it, echoes it back on every
 * verb, and never constructs a path key of its own. Key an overlay on anything
 * else and a reply lands on a key nothing reads — which is exactly how a
 * `drafting` overlay latches read-only forever.
 *
 * Attached once at boot with {@link attachChangesetDraftStore}; consumed via
 * {@link useChangesetDraft}.
 *
 * @module lib/changeset-draft-store
 */

import { useSyncExternalStore } from "react";

import type { TugConnection } from "../connection";
import type { ChangesetDraftSelection } from "./changeset-types";
import { FeedId } from "../protocol";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

export type DraftOverlayPhase = "idle" | "drafting" | "ready" | "error";

/** The live overlay for one entry's draft regeneration. */
export interface DraftOverlay {
  phase: DraftOverlayPhase;
  /** Accumulated streamed text of the in-flight generation; "" until deltas. */
  text: string;
  /** Error detail when `phase === "error"`. */
  detail: string | null;
}

const IDLE: DraftOverlay = Object.freeze({ phase: "idle", text: "", detail: null });

/**
 * How long a `drafting` overlay may sit with no frame for its key before the
 * store folds it to a recoverable error. The engine streams deltas
 * continuously while generating, so a silent stretch this long means the
 * terminal `ready`/`error`/`cancelled` frame was lost (a crashed generation,
 * an instance handoff) — and without a terminal frame the composer would hold
 * its message editor read-only forever.
 */
const DRAFT_STALL_MS = 90_000;

/** The overlay a stalled generation folds to — `error` is recoverable: the
 *  composer re-opens for typing and Auto-Message can be requested again. */
const STALLED_DETAIL = "Auto-Message stalled — try again";

/**
 * Backoff between retries of a draft write that never reached an OPEN
 * socket, capped at the last entry. A write is the user's typed message —
 * the one thing this store must never drop — so retries continue at the cap
 * (and flush immediately on reconnect) rather than giving up.
 */
const WRITE_RETRY_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/** Attempts before the store warns that a write is still unsent. */
const WRITE_WARN_ATTEMPTS = 6;

/** One key's not-yet-sent `changeset_draft_set` body; latest write wins. */
interface PendingDraftWrite {
  body: Record<string, unknown>;
  attempts: number;
}

function overlayKey(workspaceKey: string, ownerKind: string, ownerId: string): string {
  return `${workspaceKey}|${ownerKind}|${ownerId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ChangesetDraftStore {
  private readonly _connection: TugConnection;
  private readonly _unsubscribe: () => void;
  private readonly _unsubscribeDisconnect: () => void;
  private readonly _listeners = new Set<() => void>();
  private _overlays = new Map<string, DraftOverlay>();
  private readonly _stallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _pendingWrites = new Map<string, PendingDraftWrite>();
  private readonly _writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _decoder = new TextDecoder();

  constructor(connection: TugConnection) {
    this._connection = connection;
    this._unsubscribe = connection.onFrame(FeedId.CONTROL, (payload) =>
      this._onControl(payload),
    );
    // A dropped wire loses any in-flight terminal frame outright (CONTROL
    // broadcasts are not replayed on reconnect), so a `drafting` overlay is
    // stale the moment the connection goes down — fold it to idle rather
    // than latch the composer read-only. If the generation is in fact still
    // running server-side, its next delta on the new socket re-establishes
    // the overlay, text and all. Guarded: fixtures attach with a minimal
    // fake connection that has no disconnect surface.
    this._unsubscribeDisconnect =
      typeof connection.onDisconnectState === "function"
        ? connection.onDisconnectState((state) => {
            if (state.disconnected) {
              this._foldStaleDrafting();
            } else {
              // The wire is back: flush every write the closed socket
              // refused, ahead of its backoff timer.
              for (const key of [...this._pendingWrites.keys()]) {
                this._flushDraftWrite(key);
              }
            }
          })
        : () => {};
  }

  /** Fold every `drafting` overlay to idle — see the constructor's disconnect
   *  subscription. One notify for the batch, and only when something moved. */
  private _foldStaleDrafting(): void {
    let changed = false;
    for (const [key, overlay] of this._overlays) {
      if (overlay.phase !== "drafting") continue;
      this._overlays.set(key, IDLE);
      this._clearStall(key);
      changed = true;
    }
    if (changed) for (const listener of [...this._listeners]) listener();
  }

  /**
   * Request an on-demand draft for one entry ([P05], Spec S01). Fires the
   * `changeset_draft_request` CONTROL verb; the reply rides the existing
   * `changeset_draft_state`/`changeset_draft_delta` stream this store already
   * consumes. `force` is the confirmed Regenerate — the only path that
   * overwrites an edited draft ([P03]); a non-forced request on an edited
   * draft replies `ready` without a scribe call.
   */
  requestDraft(
    workspaceKey: string,
    ownerKind: string,
    ownerId: string,
    force = false,
  ): void {
    this._connection.sendControlFrame("changeset_draft_request", {
      workspace_key: workspaceKey,
      owner_kind: ownerKind,
      owner_id: ownerId,
      force,
    });
  }

  /**
   * Cancel an in-flight Auto-Message generation for one entry ([P06]). Fires
   * the `changeset_draft_cancel` CONTROL verb; the backend aborts only that
   * draft's headless scribe child (never the session's turn) and replies a
   * terminal `cancelled` `changeset_draft_state`, which this store folds back
   * to the idle overlay.
   */
  cancelDraft(workspaceKey: string, ownerKind: string, ownerId: string): void {
    this._connection.sendControlFrame("changeset_draft_cancel", {
      workspace_key: workspaceKey,
      owner_kind: ownerKind,
      owner_id: ownerId,
    });
  }

  /**
   * Partially upsert one entry's persisted draft ([P02], Spec S01): the
   * composer's debounced message edits (`edited: true` — the [P03] pin
   * rides the write), immediate selection-disposition writes, and the
   * post-landing `clear`. Absent fields leave the stored value untouched;
   * `selection: null` clears the overrides.
   */
  setDraft(
    workspaceKey: string,
    ownerKind: string,
    ownerId: string,
    fields: {
      message?: string;
      selection?: ChangesetDraftSelection | null;
      edited?: boolean;
      clear?: boolean;
    },
  ): void {
    const body: Record<string, unknown> = {
      workspace_key: workspaceKey,
      owner_kind: ownerKind,
      owner_id: ownerId,
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      ...(fields.selection !== undefined ? { selection: fields.selection } : {}),
      edited: fields.edited === true,
      ...(fields.clear === true ? { clear: true } : {}),
    };
    // Latest write wins per key: a retry must never resend a superseded
    // message over a newer one. Attempts carry across supersession so the
    // unsent-write warning still fires on a wire that stays down.
    const key = overlayKey(workspaceKey, ownerKind, ownerId);
    const prior = this._pendingWrites.get(key);
    this._pendingWrites.set(key, { body, attempts: prior?.attempts ?? 0 });
    this._flushDraftWrite(key);
  }

  /**
   * Send one key's pending `changeset_draft_set`, or arm the retry that
   * follows a socket that was not OPEN. A durable write, not a shrug: the
   * body is the user's message, so an unsent frame is kept and retried (and
   * flushed on reconnect) until it goes out, warning past
   * {@link WRITE_WARN_ATTEMPTS} so a wire that stays down is a fact in the
   * Log tab rather than a silently thinner ledger.
   */
  private _flushDraftWrite(key: string): void {
    const pending = this._pendingWrites.get(key);
    if (pending === undefined) return;
    this._clearWriteTimer(key);
    const sent =
      typeof this._connection.trySendControlFrame === "function"
        ? this._connection.trySendControlFrame("changeset_draft_set", pending.body)
        : (this._connection.sendControlFrame("changeset_draft_set", pending.body), true);
    if (sent) {
      this._pendingWrites.delete(key);
      return;
    }
    pending.attempts += 1;
    if (pending.attempts === WRITE_WARN_ATTEMPTS) {
      tugDevLogStore.warn("changeset-draft", "draft write still unsent; retrying", {
        key,
        attempts: pending.attempts,
      });
    }
    const delay =
      WRITE_RETRY_BACKOFF_MS[
        Math.min(pending.attempts - 1, WRITE_RETRY_BACKOFF_MS.length - 1)
      ]!;
    this._writeTimers.set(
      key,
      setTimeout(() => {
        this._writeTimers.delete(key);
        this._flushDraftWrite(key);
      }, delay),
    );
  }

  private _clearWriteTimer(key: string): void {
    const timer = this._writeTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._writeTimers.delete(key);
  }

  private _onControl(payload: Uint8Array): void {
    let body: unknown;
    try {
      body = JSON.parse(this._decoder.decode(payload));
    } catch {
      return;
    }
    if (!isRecord(body) || typeof body.action !== "string") return;
    const action = body.action;
    if (action !== "changeset_draft_state" && action !== "changeset_draft_delta") return;
    const workspaceKey = typeof body.workspace_key === "string" ? body.workspace_key : null;
    const ownerKind = typeof body.owner_kind === "string" ? body.owner_kind : null;
    const ownerId = typeof body.owner_id === "string" ? body.owner_id : "";
    if (workspaceKey === null || ownerKind === null) return;
    const key = overlayKey(workspaceKey, ownerKind, ownerId);

    if (action === "changeset_draft_delta") {
      const text = typeof body.text === "string" ? body.text : "";
      const prev = this._overlays.get(key);
      this._set(key, { phase: "drafting", text, detail: prev?.detail ?? null });
      return;
    }
    // changeset_draft_state
    const state = typeof body.state === "string" ? body.state : "";
    const prev = this._overlays.get(key);
    if (state === "drafting") {
      // A fresh generation — reset the streamed text.
      this._set(key, { phase: "drafting", text: "", detail: null });
    } else if (state === "ready") {
      this._set(key, { phase: "ready", text: prev?.text ?? "", detail: null });
    } else if (state === "error") {
      const detail = typeof body.detail === "string" ? body.detail : "draft failed";
      this._set(key, { phase: "error", text: prev?.text ?? "", detail });
    } else if (state === "cancelled") {
      // A user cancel ([P06]): the generation was aborted mid-stream. Fold
      // straight back to idle — the composer reverts to its persisted message
      // (no partial draft is kept).
      this._set(key, IDLE);
    }
  }

  private _set(key: string, overlay: DraftOverlay): void {
    this._overlays.set(key, overlay);
    // The stall watchdog: every frame for a drafting key re-arms it, any
    // terminal phase clears it. If it ever fires, the terminal frame is lost
    // and no further frame is coming — fold to a recoverable error so the
    // composer re-opens instead of holding the editor read-only forever.
    if (overlay.phase === "drafting") {
      this._armStall(key);
    } else {
      this._clearStall(key);
    }
    for (const listener of [...this._listeners]) listener();
  }

  private _armStall(key: string): void {
    this._clearStall(key);
    this._stallTimers.set(
      key,
      setTimeout(() => this._fireStall(key), DRAFT_STALL_MS),
    );
  }

  private _clearStall(key: string): void {
    const timer = this._stallTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._stallTimers.delete(key);
  }

  private _fireStall(key: string): void {
    this._stallTimers.delete(key);
    const prev = this._overlays.get(key);
    if (prev?.phase !== "drafting") return;
    this._overlays.set(key, { phase: "error", text: prev.text, detail: STALLED_DETAIL });
    for (const listener of [...this._listeners]) listener();
  }

  overlay(workspaceKey: string, ownerKind: string, ownerId: string): DraftOverlay {
    return this._overlays.get(overlayKey(workspaceKey, ownerKind, ownerId)) ?? IDLE;
  }

  dispose(): void {
    this._unsubscribe();
    this._unsubscribeDisconnect();
    for (const timer of this._stallTimers.values()) clearTimeout(timer);
    this._stallTimers.clear();
    for (const timer of this._writeTimers.values()) clearTimeout(timer);
    this._writeTimers.clear();
    this._pendingWrites.clear();
    this._listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };
}

let _activeStore: ChangesetDraftStore | null = null;

export function attachChangesetDraftStore(conn: TugConnection): ChangesetDraftStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new ChangesetDraftStore(conn);
  return _activeStore;
}

/**
 * The attached draft store singleton, or null before boot / in fixtures.
 * Mirrors `getChangesetVerbStore` — the imperative peer of the
 * `useChangesetDraft` hook, for non-React callers (the
 * `ChangesRouteController`).
 */
export function getChangesetDraftStore(): ChangesetDraftStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetChangesetDraftStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/** Test-only: fire one entry's stall watchdog as if `DRAFT_STALL_MS` elapsed. */
export function _fireDraftStallForTest(
  workspaceKey: string,
  ownerKind: string,
  ownerId: string,
): void {
  if (_activeStore === null) return;
  (_activeStore as unknown as { _fireStall(k: string): void })._fireStall(
    overlayKey(workspaceKey, ownerKind, ownerId),
  );
}

/** Test-only: feed a CONTROL frame body as if it arrived over the wire. */
export function _ingestDraftFrameForTest(body: unknown): void {
  if (_activeStore === null) return;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  // Reach the private handler through the same path onFrame would.
  (_activeStore as unknown as { _onControl(p: Uint8Array): void })._onControl(bytes);
}

/**
 * React hook: the live draft overlay for one entry plus its bound on-demand
 * trigger ([P05]). Returns the idle overlay + a no-op `requestDraft` when no
 * store is attached (gallery / fixtures).
 */
export function useChangesetDraft(
  workspaceKey: string,
  ownerKind: string,
  ownerId: string,
): DraftOverlay & { requestDraft: () => void } {
  const overlay = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.overlay(workspaceKey, ownerKind, ownerId) ?? IDLE,
    () => IDLE,
  );
  const requestDraft = (): void => {
    _activeStore?.requestDraft(workspaceKey, ownerKind, ownerId);
  };
  return { ...overlay, requestDraft };
}
