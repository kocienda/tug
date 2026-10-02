/**
 * host-info-store — the host OS identity tugcast reports in the connection
 * handshake: `{os, version}` (e.g. `{os: "macos", version: "15.7.7"}`).
 *
 * Unlike {@link module:lib/host-facts-store} (hostname/shell, fetched from
 * `GET /api/host`), this rides the protocol handshake — it arrives once per
 * connect, before any card, with no turn required ([P06]). That "from the
 * drop" timing is what the app-wide minimum-macOS version gate needs, so the
 * connection layer publishes the parsed host into this store and the gate
 * derives from it.
 *
 * Reads enter React through `useSyncExternalStore` only — [L02].
 *
 * @module lib/host-info-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";


/** The host OS identity carried on the handshake response (Spec S03). */
export interface HostInfo {
  /** OS family; tugcast reports `"macos"`. */
  os: string;
  /** macOS product version, e.g. `"15.7.7"`. Always non-empty here. */
  version: string;
}

/**
 * Extract {@link HostInfo} from a parsed handshake-response object.
 *
 * Pure and lenient: returns `null` (→ "unknown", do not block — Spec S03,
 * [R02]) when the response is not an object, has no well-formed `host` object,
 * or carries a non-string / empty `version`. An empty version is what tugcast
 * sends from a non-macOS host, and "unknown" is the safe, fail-open reading.
 * Unknown extra fields are ignored, so older/newer servers stay compatible.
 */
export function parseHandshakeHost(raw: unknown): HostInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const host = (raw as Record<string, unknown>).host;
  if (host === null || typeof host !== "object") return null;
  const { os, version } = host as Record<string, unknown>;
  if (typeof os !== "string" || typeof version !== "string") return null;
  if (version === "") return null;
  return { os, version };
}

/**
 * Holds the host OS identity published from the handshake and notifies
 * subscribers when it changes.
 *
 * `useSyncExternalStore`-compatible: {@link subscribe} and {@link getSnapshot}
 * are stable, pre-bound references, and `getSnapshot` returns a referentially
 * stable value between renders — the snapshot object is replaced only when the
 * value actually changes ([L02]).
 */
export class HostInfoStore {
  private snapshot: HostInfo | null = null;
  private readonly listeners = new Set<() => void>();

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * The host OS identity, or `null` while unknown (pre-handshake, or a
   * handshake without a well-formed host). Referentially stable between
   * renders — safe as a `useSyncExternalStore` snapshot.
   */
  getSnapshot = (): HostInfo | null => this.snapshot;

  /**
   * Publish the host parsed from a handshake response (typically
   * `parseHandshakeHost(response)`).
   *
   * A `null` (unknown) is ignored — a later handshake without a host field
   * never clears a value learned from an earlier one. Equal values are
   * deduped so subscribers aren't notified on a no-op reconnect.
   */
  publish(info: HostInfo | null): void {
    if (info === null) return;
    if (
      this.snapshot !== null &&
      this.snapshot.os === info.os &&
      this.snapshot.version === info.version
    ) {
      return;
    }
    this.snapshot = info;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The process-wide host-info store, fed by the connection handshake. */
export const hostInfoStore = new HostInfoStore();

/**
 * Subscribe a component to the host OS identity. Returns the resolved
 * {@link HostInfo}, or `null` while still unknown.
 */
export function useHostInfo(): HostInfo | null {
  return useSyncExternalStore(
    hostInfoStore.subscribe,
    hostInfoStore.getSnapshot,
  );
}
