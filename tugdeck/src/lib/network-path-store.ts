/**
 * network-path-store.ts — the macOS host's network-path report, as a hint the
 * deck may act on in exactly one direction.
 *
 * # `unsatisfied` is believed. `satisfied` is only a nudge to try.
 *
 * This is the whole of the module's contract, and it is asymmetric on
 * purpose. The host's `NWPathMonitor` answers a question about *this
 * machine's interfaces* — is there a route — and not the question anybody
 * actually cares about, which is whether the far end answers. The two come
 * apart in precisely the situation this arc was written for:
 *
 * - A plane's wifi, a hotel portal, a conference network behind a captive
 *   gateway: all of them hand out a route, a lease and a DNS server, and
 *   answer every request with a login page. `NWPathMonitor` calls that
 *   **satisfied**. Nothing gets through.
 * - No wifi, airplane mode, an unplugged cable: **unsatisfied**, and that
 *   one is true. There is no route, so nothing is getting anywhere.
 *
 * So the negative is evidence and the positive is not. **Nothing may gate a
 * send, a retry, a button, or an affordance on `satisfied`** — doing so would
 * take the one reading that lies and make it a precondition, which is how a
 * user behind a captive portal ends up with an app that thinks it is fine.
 * The permitted use is the mirror: when something else has *already* failed
 * or reported a negative, an `unsatisfied` path explains why, and the
 * explanation is worth showing.
 *
 * ## The API is the enforcement
 *
 * There is deliberately **no `isOnline()`**, no `isOffline()`, and no boolean
 * of any shape. A predicate is an invitation to write `if (isOnline())`, and
 * the asymmetry above cannot survive one. Callers read `status` and branch on
 * the member they mean, which makes "I am relying on satisfied" visible in
 * the diff rather than hidden behind a name that sounds trustworthy.
 *
 * ## Laws
 *
 * [L02] — external state enters React through `useSyncExternalStore` only.
 * This store exposes `subscribe` + `getSnapshot` and is read through that
 * hook. The snapshot is replaced rather than mutated, and an identical report
 * replaces nothing at all, so a consumer does not re-render on an interface
 * change that means nothing to it.
 *
 * [P11] — no polling. The store is fed by the host's push
 * (`window.__tugBridge.onNetworkPath`, emitted from
 * `MainWindow.bridgeNetworkPath` — keep the callback name in lockstep), which
 * the host emits from an `NWPathMonitor` update handler. Nothing here asks at
 * an interval, and nothing here asks at all.
 *
 * @module lib/network-path-store
 */

import { useSyncExternalStore } from "react";

/**
 * The path states the host reports, one for one with `NWPath.Status`.
 *
 * `requiresConnection` is macOS's "a route exists but something must be
 * brought up first" — an on-demand VPN, most often. It is grouped with
 * neither of the other two: it is not the believed negative (a route is
 * there), and it is certainly not an assurance.
 */
export type NetworkPathStatus =
  | "satisfied"
  | "unsatisfied"
  | "requiresConnection";

export interface NetworkPathSnapshot {
  /**
   * The host's last report, or `null` before one has arrived.
   *
   * **`null` is not offline.** It is "the host has not said", which is the
   * state every deck starts in and the state a browser tab is in forever.
   * Anything reading this must treat an absent report as no evidence — an
   * absent hint is not an offline hint.
   */
  status: NetworkPathStatus | null;
  /** The host's `path.isExpensive` — cellular, or a personal hotspot. */
  isExpensive: boolean;
  /** The host's `path.isConstrained` — Low Data Mode. */
  isConstrained: boolean;
}

const INITIAL: NetworkPathSnapshot = {
  status: null,
  isExpensive: false,
  isConstrained: false,
};

function snapshotsEqual(
  a: NetworkPathSnapshot,
  b: NetworkPathSnapshot,
): boolean {
  return (
    a.status === b.status &&
    a.isExpensive === b.isExpensive &&
    a.isConstrained === b.isConstrained
  );
}

class NetworkPathStore {
  private _snapshot: NetworkPathSnapshot = INITIAL;
  private _listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): NetworkPathSnapshot => this._snapshot;

  /**
   * Record a host report. A report identical to the standing one replaces
   * nothing and notifies nobody, so the snapshot reference is stable across
   * the interface churn `NWPathMonitor` reports and this store does not care
   * about.
   */
  apply(next: NetworkPathSnapshot): void {
    if (snapshotsEqual(this._snapshot, next)) return;
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }
}

export const networkPathStore = new NetworkPathStore();

/** React read of the host's path hint ([L02]). */
export function useNetworkPath(): NetworkPathSnapshot {
  return useSyncExternalStore(
    networkPathStore.subscribe,
    networkPathStore.getSnapshot,
  );
}

/**
 * Normalize a raw bridge payload onto the snapshot shape.
 *
 * Tolerant of the wire: an unrecognized `status` reads as `null` — "the host
 * said nothing I understand", which is the same no-evidence answer as no
 * report at all, and emphatically not a guess at either extreme.
 */
export function networkPathFromPayload(
  payload: Record<string, unknown>,
): NetworkPathSnapshot {
  const raw = payload.status;
  const status: NetworkPathStatus | null =
    raw === "satisfied"
      ? "satisfied"
      : raw === "unsatisfied"
        ? "unsatisfied"
        : raw === "requiresConnection"
          ? "requiresConnection"
          : null;
  return {
    status,
    isExpensive: payload.isExpensive === true,
    isConstrained: payload.isConstrained === true,
  };
}

/** The host→web bridge object; only the path callback concerns us here. */
interface TugBridge {
  onNetworkPath?: (report: Record<string, unknown>) => void;
}

interface BridgeHost {
  __tugBridge?: TugBridge;
}

/**
 * Install `__tugBridge.onNetworkPath`. Called once from deck boot; safe to
 * call again (the receiver is installed only when absent).
 *
 * The `__tugBridge` object is shared with other host callbacks, so the
 * receiver is merged in with `??=` — never replace the object wholesale.
 *
 * Outside Tug.app nothing ever calls it, and the store stays at `status:
 * null` for the life of the page. That is correct rather than degraded: a
 * browser tab genuinely has no host to ask, and `null` says exactly that.
 */
export function installNetworkPathBridge(): void {
  const w = globalThis as unknown as BridgeHost;
  const bridge = (w.__tugBridge ??= {});
  if (bridge.onNetworkPath !== undefined) return;
  bridge.onNetworkPath = (report) => {
    networkPathStore.apply(networkPathFromPayload(report ?? {}));
  };
}
