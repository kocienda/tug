/**
 * App-level host-tools state — whether this machine carries a git Tug can use,
 * and what happened to the offer to install Apple's Command Line Tools when it
 * does not. Read by ConfigureTug's git row and by the no-git notice the Changes
 * and History shades carry.
 *
 * Tug shells out to `git` everywhere — the changeset, every commit surface,
 * every arc worktree — and ships none of it: git is GPLv2-only and Tug takes on
 * no GPL obligations, so the offer points at Apple's Command Line Tools and the
 * user installs them from Apple. Until this store has an answer, nothing in the
 * product knows whether that whole surface can work at all.
 *
 * Fed exclusively by `host_tools_result` CONTROL frames (the deck sends
 * `check_host_tools` alongside its auth probe, and tugcast re-broadcasts after
 * an offer and again when the tools actually land on disk), plus
 * `host_tools_offer_result` for the outcome of an `offer_host_tools`.
 *
 * The version floor rides the frame rather than being decided here: tugcast's
 * `host_tools::meets_floor` is the one place that knows how old a git is too
 * old, and `usable` is its answer. `gitFloor` is carried only so the copy can
 * name the number.
 *
 * Kept separate from {@link claudeVersionStore}: a git probe and a Claude
 * version lookup answer different questions, arrive on different frames, and
 * are read by different surfaces.
 *
 * **Laws:** [L02] external state enters React through `useSyncExternalStore`
 * only — this store exposes `subscribe + getSnapshot` and is read via that hook
 * (see {@link useHostTools}). The snapshot is replaced, never mutated.
 *
 * @module lib/host-tools-store
 */

import { useSyncExternalStore } from "react";

export interface HostToolsSnapshot {
  /** The version `git --version` reported, or `null` when no git was reached. */
  gitVersion: string | null;
  /** Where that git resolved. `null` when nothing usable resolved. */
  gitPath: string | null;
  /**
   * `xcode-select -p`'s answer, when the probe had cause to ask. `null` both
   * when no developer directory is active and when a real git on `PATH` made
   * the question moot — `gitVersion` is what distinguishes those.
   */
  developerDir: string | null;
  /** The oldest git Tug can work with, as tugcast reports it. */
  gitFloor: string | null;
  /** Whether this machine has a git at or above the floor. */
  usable: boolean;
  /** True once a `host_tools_result` has ever landed. */
  probed: boolean;
  /** True between sending `offer_host_tools` and its result. */
  offering: boolean;
  /** Last offer error, or `null`. Cleared when a new offer starts. */
  offerError: string | null;
}

const INITIAL: HostToolsSnapshot = {
  gitVersion: null,
  gitPath: null,
  developerDir: null,
  gitFloor: null,
  usable: false,
  probed: false,
  offering: false,
  offerError: null,
};

class HostToolsStore {
  private _snapshot: HostToolsSnapshot = INITIAL;
  private _listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): HostToolsSnapshot => this._snapshot;

  /** Mark an offer in flight (clears any prior offer error). */
  setOffering(offering: boolean): void {
    this._snapshot = { ...this._snapshot, offering, offerError: null };
    this.notify();
  }

  /**
   * Apply a `host_tools_result`: what the probe found. This is what ends an
   * in-flight offer, not the offer's own result frame — `xcode-select
   * --install` returns as soon as Apple's panel is up, so only a probe that
   * now sees a usable git proves anything landed. An offer that succeeded
   * over a machine still lacking git therefore stays `offering` until the
   * watch fires, which is the whole point of watching.
   */
  applyProbe(next: Omit<HostToolsSnapshot, "probed" | "offering" | "offerError">): void {
    this._snapshot = {
      ...this._snapshot,
      ...next,
      probed: true,
      offering: this._snapshot.offering && !next.usable,
    };
    this.notify();
  }

  /**
   * Apply a `host_tools_offer_result`. A success is deliberately left
   * `offering` — Apple's installer is still running and the probe that
   * follows is what settles the row. A failure ends the in-flight state and
   * surfaces the error so the row can offer a retry.
   */
  applyOfferResult(ok: boolean, error: string | null): void {
    if (ok) return;
    this._snapshot = {
      ...this._snapshot,
      offering: false,
      offerError: error ?? "install failed",
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this._listeners) listener();
  }
}

export const hostToolsStore = new HostToolsStore();

/** React read of the app host-tools state ([L02]). */
export function useHostTools(): HostToolsSnapshot {
  return useSyncExternalStore(
    hostToolsStore.subscribe,
    hostToolsStore.getSnapshot,
  );
}

/**
 * Apply a `host_tools_result` CONTROL payload
 * (`{gitVersion, gitPath, developerDir, gitFloor, usable}`).
 */
export function applyHostToolsResultPayload(payload: Record<string, unknown>): void {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  hostToolsStore.applyProbe({
    gitVersion: str(payload.gitVersion),
    gitPath: str(payload.gitPath),
    developerDir: str(payload.developerDir),
    gitFloor: str(payload.gitFloor),
    usable: payload.usable === true,
  });
}

/** Apply a `host_tools_offer_result` CONTROL payload (`{ok, error}`). */
export function applyHostToolsOfferResultPayload(payload: Record<string, unknown>): void {
  hostToolsStore.applyOfferResult(
    payload.ok === true,
    typeof payload.error === "string" ? payload.error : null,
  );
}
