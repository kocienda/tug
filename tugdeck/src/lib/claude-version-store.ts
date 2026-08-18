/**
 * App-level Claude Code version state — what is installed on this machine and
 * what the stable release channel is offering. Read by ConfigureTug's install
 * row, which reports the pair and offers an update when they differ.
 *
 * Fed exclusively by `claude_version_result` CONTROL frames (the deck sends
 * `check_claude_version` alongside its auth probe, and tugcast re-broadcasts
 * after any install or update), plus `claude_update_result` for the outcome of
 * a Tug-managed `update_claude`.
 *
 * Kept separate from {@link authStore}: login state and installed version
 * answer different questions and arrive on different frames, and the auth store
 * is read by surfaces (the picker gate, the per-card banner) that have no
 * business re-rendering on a version lookup.
 *
 * **Laws:** [L02] external state enters React through `useSyncExternalStore`
 * only — this store exposes `subscribe + getSnapshot` and is read via that hook
 * (see {@link useClaudeVersion}). The snapshot is replaced, never mutated.
 *
 * @module lib/claude-version-store
 */

import { useSyncExternalStore } from "react";

export interface ClaudeVersionSnapshot {
  /** The locally installed version, or `null` when unknown / not installed. */
  installed: string | null;
  /** The newest stable release, or `null` when the lookup failed (offline). */
  latest: string | null;
  /** True once a `claude_version_result` has ever landed. */
  probed: boolean;
  /** True between sending `update_claude` and its `claude_update_result`. */
  updating: boolean;
  /** Last update error, or `null`. Cleared when a new update starts. */
  updateError: string | null;
}

const INITIAL: ClaudeVersionSnapshot = {
  installed: null,
  latest: null,
  probed: false,
  updating: false,
  updateError: null,
};

class ClaudeVersionStore {
  private _snapshot: ClaudeVersionSnapshot = INITIAL;
  private _listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): ClaudeVersionSnapshot => this._snapshot;

  /** Mark a Tug-managed update in flight (clears any prior update error). */
  setUpdating(updating: boolean): void {
    this._snapshot = { ...this._snapshot, updating, updateError: null };
    this.notify();
  }

  /**
   * Apply a `claude_version_result`: the probed pair. An update that just
   * succeeded ends here rather than on its own result frame — the version
   * re-probe is what proves the new build is actually on disk.
   */
  applyVersions(installed: string | null, latest: string | null): void {
    this._snapshot = {
      ...this._snapshot,
      installed,
      latest,
      probed: true,
      updating: false,
    };
    this.notify();
  }

  /**
   * Apply a `claude_update_result`. A success is deliberately left `updating`
   * — the re-probe that follows settles the row, so it never flashes the old
   * version back as if the update hadn't taken. A failure ends the in-flight
   * state and surfaces the error so the row can offer a retry.
   */
  applyUpdateResult(ok: boolean, error: string | null): void {
    if (ok) return;
    this._snapshot = {
      ...this._snapshot,
      updating: false,
      updateError: error ?? "update failed",
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this._listeners) listener();
  }
}

export const claudeVersionStore = new ClaudeVersionStore();

/** React read of the app Claude-version state ([L02]). */
export function useClaudeVersion(): ClaudeVersionSnapshot {
  return useSyncExternalStore(
    claudeVersionStore.subscribe,
    claudeVersionStore.getSnapshot,
  );
}

/** Apply a `claude_version_result` CONTROL payload (`{installed, latest}`). */
export function applyVersionResultPayload(payload: Record<string, unknown>): void {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  claudeVersionStore.applyVersions(str(payload.installed), str(payload.latest));
}

/** Apply a `claude_update_result` CONTROL payload (`{ok, error}`). */
export function applyUpdateResultPayload(payload: Record<string, unknown>): void {
  claudeVersionStore.applyUpdateResult(
    payload.ok === true,
    typeof payload.error === "string" ? payload.error : null,
  );
}
