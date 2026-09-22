/**
 * update-store.ts — the macOS host's update state, and the deck's one way to
 * answer it.
 *
 * # State in, action out
 *
 * Sparkle's engine runs in the host and Tug's own `SPUUserDriver` turns every
 * one of its callbacks into a snapshot. The host pushes that snapshot through
 * `window.__tugBridge.onUpdateState` (emit site:
 * `MainWindow.bridgeUpdateState` — keep the callback name in lockstep) on
 * every transition, and replays the current one on `bridgeFrontendReady`.
 *
 * What crosses is **state, never an event**, and that is the whole reason
 * there is no queue anywhere on either side: a deck that reloads mid-download
 * is caught up by the next push, and a deck that has just mounted is caught up
 * by the replay. A snapshot delivered twice costs nothing, because applying it
 * twice is applying it once.
 *
 * The deck answers with a single `updateAction` message carrying one of the
 * seven action names. The host maps it onto whichever Sparkle reply closure
 * the current state is holding and **ignores one the state has no closure
 * for** — so a click from a deck that reloaded mid-flow does nothing rather
 * than replying twice. Nothing here needs to guard against that; the host
 * already does, and duplicating the guard would mean two places that have to
 * agree about which actions a state allows.
 *
 * ## Progress is not in React, and the store is what makes that true
 *
 * `percent` rides the snapshot because the pill has to draw it, but drawing it
 * is a CSS custom property's job, never React state ([L06]). The host already
 * publishes progress only on a whole-percent change, so this store sees about
 * a hundred snapshots per download rather than a hundred thousand — but a
 * hundred re-renders is still ninety-nine too many for something that moves a
 * line's width.
 *
 * So there are **two read surfaces over one snapshot**. {@link
 * UpdateStore.getSnapshot} is the whole truth, read imperatively by whoever
 * paints progress. {@link UpdateStore.getRenderSnapshot} is the same object
 * with `percent` elided, and its **reference is held stable across a
 * percent-only change** — which is precisely what makes
 * `useSyncExternalStore` bail out of the re-render. A download therefore
 * costs React nothing between the transition that starts it and the one that
 * ends it.
 *
 * That is structure rather than discipline: a consumer cannot accidentally
 * put progress in React state, because the hook it reads does not carry it.
 *
 * ## Laws
 *
 * [L02] — external state enters React through `useSyncExternalStore` only.
 * This store exposes `subscribe` + `getSnapshot` and is read through that
 * hook. The snapshot is replaced rather than mutated, and an identical
 * snapshot replaces nothing at all.
 *
 * [P11] — no polling. The store is fed by the host's push, and asks nothing
 * at an interval. Nothing here asks at all.
 *
 * @module lib/update-store
 */

import { useSyncExternalStore } from "react";

/**
 * The states the host's driver reports, one for one with `UpdateStage` in
 * `tugapp/Sources/UpdateState.swift`.
 */
export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "extracting"
  | "readyToInstall"
  | "installing"
  | "upToDate"
  | "error";

/**
 * What the deck can ask for, one for one with `UpdateAction` in
 * `tugapp/Sources/UpdateState.swift`. Whether an action does anything is the
 * host's call, not this module's.
 */
export type UpdateAction =
  | "install"
  | "later"
  | "skip"
  | "cancel"
  | "retry"
  | "dismiss"
  | "check";

export interface UpdateSnapshot {
  /** Where the flow is. `idle` means there is nothing to show at all. */
  stage: UpdateStage;
  /** The update's display version, or `""` when there is no update in hand. */
  version: string;
  /** The update's build, or `""` when there is none. */
  build: string;
  /**
   * Release notes as HTML or Markdown, or `null` when the appcast carried
   * none, they have not arrived yet, or they failed to download. **An absent
   * notes file never blocks an update** — the popover shows the version and
   * its controls without them.
   */
  releaseNotes: string | null;
  /**
   * True when notes were expected and failed to arrive, which is how "not
   * offered" is told apart from "offered and lost". Nothing is drawn from it
   * today; it exists so the distinction survives the bridge.
   */
  releaseNotesFailed: boolean;
  /**
   * True when the user started this check. The only flow permitted to open
   * the popover on its own — every other transition may light the pill and
   * nothing more.
   */
  userInitiated: boolean;
  /**
   * Download or extraction progress, 0–100, or `null` when the stage has no
   * progress or the total is not yet known. `null` is not zero: a bar sitting
   * at 0% because nobody has said how long the file is says something false.
   */
  percent: number | null;
  /** The failure text in `error`, `""` in every other stage. */
  message: string;
  /** Whether the current stage holds something the user can call off. */
  cancellable: boolean;
}

/**
 * The state every deck starts in, and the state a browser tab stays in
 * forever. `idle` is correct rather than degraded — a tab outside Tug.app
 * genuinely has no updater, and there is nothing to show.
 */
export const IDLE_UPDATE: UpdateSnapshot = {
  stage: "idle",
  version: "",
  build: "",
  releaseNotes: null,
  releaseNotesFailed: false,
  userInitiated: false,
  percent: null,
  message: "",
  cancellable: false,
};

const STAGES: readonly UpdateStage[] = [
  "idle",
  "checking",
  "available",
  "downloading",
  "extracting",
  "readyToInstall",
  "installing",
  "upToDate",
  "error",
];

function snapshotsEqual(a: UpdateSnapshot, b: UpdateSnapshot): boolean {
  return (
    a.stage === b.stage &&
    a.version === b.version &&
    a.build === b.build &&
    a.releaseNotes === b.releaseNotes &&
    a.releaseNotesFailed === b.releaseNotesFailed &&
    a.userInitiated === b.userInitiated &&
    a.percent === b.percent &&
    a.message === b.message &&
    a.cancellable === b.cancellable
  );
}

/**
 * The snapshot minus the one field that moves a hundred times a download.
 *
 * What React renders from. Progress is deliberately absent rather than
 * optional: a consumer cannot put it in state it was never handed.
 */
export type UpdateRenderSnapshot = Omit<UpdateSnapshot, "percent">;

function renderFieldsEqual(a: UpdateSnapshot, b: UpdateSnapshot): boolean {
  return (
    a.stage === b.stage &&
    a.version === b.version &&
    a.build === b.build &&
    a.releaseNotes === b.releaseNotes &&
    a.releaseNotesFailed === b.releaseNotesFailed &&
    a.userInitiated === b.userInitiated &&
    a.message === b.message &&
    a.cancellable === b.cancellable
  );
}

function toRenderSnapshot(snapshot: UpdateSnapshot): UpdateRenderSnapshot {
  const { percent: _percent, ...rest } = snapshot;
  return rest;
}

class UpdateStore {
  private _snapshot: UpdateSnapshot = IDLE_UPDATE;
  private _renderSnapshot: UpdateRenderSnapshot = toRenderSnapshot(IDLE_UPDATE);
  private _listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): UpdateSnapshot => this._snapshot;

  /**
   * The render surface [L06]. Its reference survives a percent-only change,
   * so `useSyncExternalStore` bails out of the re-render and a download costs
   * React nothing between its first transition and its last.
   */
  getRenderSnapshot = (): UpdateRenderSnapshot => this._renderSnapshot;

  /**
   * Record a host snapshot. One identical to the standing snapshot replaces
   * nothing and notifies nobody — which is what makes the replay on
   * frontend-ready free, and what keeps a re-delivered snapshot from
   * re-rendering anything.
   *
   * Listeners are notified on every accepted snapshot, progress included —
   * the painter needs those. What a percent-only change does *not* do is
   * move {@link getRenderSnapshot}'s reference.
   */
  apply(next: UpdateSnapshot): void {
    if (snapshotsEqual(this._snapshot, next)) return;
    const rendersDiffer = !renderFieldsEqual(this._snapshot, next);
    this._snapshot = next;
    if (rendersDiffer) this._renderSnapshot = toRenderSnapshot(next);
    for (const listener of this._listeners) listener();
  }
}

export const updateStore = new UpdateStore();

/**
 * React read of the host's update state ([L02]).
 *
 * Carries no `percent` by construction — progress is drawn from
 * {@link updateStore}`.getSnapshot()` onto a CSS custom property, never
 * rendered ([L06]).
 */
export function useUpdateState(): UpdateRenderSnapshot {
  return useSyncExternalStore(
    updateStore.subscribe,
    updateStore.getRenderSnapshot,
  );
}

/**
 * Normalize a raw bridge payload onto the snapshot shape.
 *
 * Tolerant of the wire in one direction only: a payload whose `stage` this
 * build does not recognize reads as `idle` — "the host said something I
 * cannot draw", which is the same answer as nothing to draw. Every other
 * field falls back to its idle value rather than to a guess, so a partial
 * payload cannot produce a pill that claims a version it was not given.
 */
export function updateFromPayload(
  payload: Record<string, unknown>,
): UpdateSnapshot {
  const rawStage = payload.stage;
  const stage: UpdateStage = STAGES.includes(rawStage as UpdateStage)
    ? (rawStage as UpdateStage)
    : "idle";
  if (stage === "idle") return IDLE_UPDATE;

  const percent = payload.percent;
  return {
    stage,
    version: typeof payload.version === "string" ? payload.version : "",
    build: typeof payload.build === "string" ? payload.build : "",
    releaseNotes:
      typeof payload.releaseNotes === "string" ? payload.releaseNotes : null,
    releaseNotesFailed: payload.releaseNotesFailed === true,
    userInitiated: payload.userInitiated === true,
    percent:
      typeof percent === "number" && Number.isFinite(percent)
        ? Math.min(100, Math.max(0, Math.round(percent)))
        : null,
    message: typeof payload.message === "string" ? payload.message : "",
    cancellable: payload.cancellable === true,
  };
}

/** The host→web bridge object; only the update callback concerns us here. */
interface TugBridge {
  onUpdateState?: (snapshot: Record<string, unknown>) => void;
}

interface BridgeHost {
  webkit?: {
    messageHandlers?: Record<
      string,
      { postMessage: (value: unknown) => void } | undefined
    >;
  };
  __tugBridge?: TugBridge;
}

/**
 * Ask the host for something. A no-op outside Tug.app, and a no-op inside it
 * when the current state holds no reply for the action — the host decides
 * that, and its refusal is silent by design [B03].
 */
export function postUpdateAction(action: UpdateAction): void {
  const w = globalThis as unknown as BridgeHost;
  w.webkit?.messageHandlers?.updateAction?.postMessage(action);
}

/**
 * Install `__tugBridge.onUpdateState`. Called once from deck boot; safe to
 * call again (the receiver is installed only when absent).
 *
 * The `__tugBridge` object is shared with other host callbacks, so the
 * receiver is merged in with `??=` — never replace the object wholesale.
 */
export function installUpdateBridge(): void {
  const w = globalThis as unknown as BridgeHost;
  const bridge = (w.__tugBridge ??= {});
  if (bridge.onUpdateState !== undefined) return;
  bridge.onUpdateState = (snapshot) => {
    updateStore.apply(updateFromPayload(snapshot ?? {}));
  };
}
