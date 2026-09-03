/**
 * TugbankClient — in-memory cache of tugbank domain snapshots
 * populated via the DEFAULTS WebSocket feed (FeedId 0x50).
 *
 * On WebSocket connect, tugcast pushes a single aggregated DEFAULTS frame
 * containing ALL domain snapshots. This frame fully populates the cache.
 * Subsequent DEFAULTS frames arrive when any domain changes.
 *
 * Frame payload format (JSON):
 * ```json
 * {
 *   "domains": {
 *     "dev.tugapp.deck.layout": {
 *       "generation": 42,
 *       "entries": {
 *         "layout": {"kind": "json", "value": {...}}
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Each entry uses the tagged-value format: {"kind": "string"|"json"|"bool"|..., "value": ...}
 * This matches the format used by the /api/defaults/ HTTP endpoints.
 */

import { FeedId } from "../protocol";
import type { TugConnection } from "../connection";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

// ── Types ────────────────────────────────────────────────────────────────────

/** A tagged value as received from tugcast (same format as HTTP API). */
export interface TaggedValue {
  kind: string;
  value: unknown;
}

/** Cached domain snapshot. */
interface DomainSnapshot {
  generation: number;
  entries: Record<string, TaggedValue>;
}

/** Callback fired when a domain's snapshot changes. */
export type DomainChangedCallback = (
  domain: string,
  entries: Record<string, TaggedValue>
) => void;

// ── TugbankClient ────────────────────────────────────────────────────────────

/**
 * Boot never blocks on tugbank longer than this. `ready()` gates the very
 * first `await` in the app's boot (before `frontendReady` tears down the
 * splash), so if the initial DEFAULTS frame never arrives — dropped for
 * exceeding the transport's {@link MAX_PAYLOAD_SIZE} cap, or lost — the
 * splash would hang forever with no visible cause. This deadline resolves
 * `ready()` anyway, so the app boots (with whatever defaults did arrive,
 * possibly none) instead of bricking. A healthy boot resolves in well
 * under a second; this only fires on failure.
 */
const READY_TIMEOUT_MS = 10_000;

export class TugbankClient {
  private readonly cache = new Map<string, DomainSnapshot>();
  private readonly listeners: DomainChangedCallback[] = [];
  private readyResolve: (() => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private hasReceivedInitialFrame = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** True when boot proceeded on the timeout, not a real DEFAULTS frame. */
  private _bootDegraded = false;

  constructor(connection: TugConnection, readyTimeoutMs: number = READY_TIMEOUT_MS) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    connection.onFrame(FeedId.DEFAULTS, (payload: Uint8Array) => {
      this.handleDefaultsFrame(payload);
    });

    // Un-brickable boot: if no DEFAULTS frame lands in time, resolve
    // `ready()` degraded rather than hang the splash forever.
    this.readyTimer = setTimeout(() => {
      if (this.hasReceivedInitialFrame) return;
      this._bootDegraded = true;
      const msg =
        "tugbank: no DEFAULTS frame within " +
        `${readyTimeoutMs}ms — booting with empty defaults. The frame was ` +
        "likely dropped for exceeding the 16 MB transport cap (a bloated " +
        "defaults domain). App state (theme, layout, recents) may be missing.";
      tugDevLogStore.error("tugbank-client", msg);
      console.error(`[TugbankClient] ${msg}`);
      this.resolveReady();
    }, readyTimeoutMs);
  }

  /** Resolve the boot gate exactly once and cancel the deadline timer. */
  private resolveReady(): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.readyResolve?.();
    this.readyResolve = null;
  }

  /** Whether boot proceeded on the timeout rather than a real frame. */
  bootDegraded(): boolean {
    return this._bootDegraded;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Resolves when the first DEFAULTS frame has been received and the cache
   * is fully populated. After this, all reads are synchronous.
   */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Read a tagged value from the cache.
   * Returns undefined if the domain or key doesn't exist.
   */
  get(domain: string, key: string): TaggedValue | undefined {
    return this.cache.get(domain)?.entries[key];
  }

  /**
   * Read the unwrapped value from a tagged entry.
   * Convenience: returns tagged.value directly, or undefined if not found.
   */
  getValue(domain: string, key: string): unknown {
    return this.get(domain, key)?.value;
  }

  /**
   * Read all entries for a domain.
   * Returns undefined if the domain doesn't exist in cache.
   */
  readDomain(domain: string): Record<string, TaggedValue> | undefined {
    return this.cache.get(domain)?.entries;
  }

  /** List all cached domain names. */
  listDomains(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Register a callback fired when any domain snapshot changes.
   * Returns an unsubscribe function.
   */
  onDomainChanged(callback: DomainChangedCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Optimistically update the local cache for a single key.
   *
   * Used by callers that issue an HTTP PUT and want the cache (and
   * any `useSyncExternalStore` subscriber) to reflect the new value
   * before the server's DEFAULTS round-trip arrives. The next
   * server-pushed DEFAULTS frame may overwrite this entry — that's
   * the expected reconciliation behavior.
   *
   * Bumps the domain's `generation` by 1 so the next inbound DEFAULTS
   * frame for the same domain only wins if its generation is higher.
   * Fires `onDomainChanged` listeners synchronously, mirroring the
   * server-driven path.
   */
  setLocalValue(domain: string, key: string, value: TaggedValue): void {
    const existing = this.cache.get(domain);
    const entries: Record<string, TaggedValue> = {
      ...(existing?.entries ?? {}),
      [key]: value,
    };
    const generation = (existing?.generation ?? 0) + 1;
    this.cache.set(domain, { generation, entries });
    for (const cb of this.listeners) {
      try {
        cb(domain, entries);
      } catch (err) {
        console.warn("[TugbankClient] callback error:", err);
      }
    }
  }

  /**
   * The deletion half of {@link setLocalValue}: drop one key and notify.
   *
   * A domain where absence carries meaning needs this to be expressible — a
   * subscriber that only ever sees keys appear can never learn that one went
   * away. Production deletions go over HTTP via `deleteDefault` (`settings-api.ts`) and
   * arrive back through the notify stream; this local half exists for the
   * test surface (`deleteTugbankValue`), which simulates that arrival
   * without a server round-trip. A no-op when the key is not there, so it
   * never fires a notification that says nothing.
   */
  deleteLocalValue(domain: string, key: string): void {
    const existing = this.cache.get(domain);
    if (existing === undefined || !(key in existing.entries)) return;
    const entries = { ...existing.entries };
    delete entries[key];
    this.cache.set(domain, { generation: existing.generation + 1, entries });
    for (const cb of this.listeners) {
      try {
        cb(domain, entries);
      } catch (err) {
        console.warn("[TugbankClient] callback error:", err);
      }
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private handleDefaultsFrame(payload: Uint8Array): void {
    let parsed: { domains?: Record<string, { generation?: number; entries?: Record<string, TaggedValue> }> };
    try {
      const text = new TextDecoder().decode(payload);
      parsed = JSON.parse(text);
    } catch (err) {
      tugDevLogStore.warn(
        "tugbank-client",
        "failed to parse DEFAULTS frame",
        { error: String(err) },
      );
      return;
    }

    if (!parsed.domains) {
      console.warn("[TugbankClient] DEFAULTS frame missing 'domains' key");
      return;
    }

    const changedDomains: string[] = [];

    for (const [domain, snapshot] of Object.entries(parsed.domains)) {
      const generation = snapshot.generation ?? 0;
      const entries = snapshot.entries ?? {};
      const existing = this.cache.get(domain);

      if (!existing || existing.generation < generation) {
        this.cache.set(domain, { generation, entries });
        changedDomains.push(domain);
      }
    }

    // Fire callbacks for changed domains
    for (const domain of changedDomains) {
      const entries = this.cache.get(domain)!.entries;
      for (const cb of this.listeners) {
        try {
          cb(domain, entries);
        } catch (err) {
          console.warn("[TugbankClient] callback error:", err);
        }
      }
    }

    // Resolve ready promise on first frame
    if (!this.hasReceivedInitialFrame) {
      this.hasReceivedInitialFrame = true;
      this.resolveReady();
    }
  }
}
