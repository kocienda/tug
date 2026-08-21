/**
 * `TugDevLogStore` — module-scope owner of the in-app log buffer
 * surfaced by the `Log` section on the Lens.
 *
 * Append API:
 *   ```ts
 *   tugDevLogStore.warn("code-session-store", "duplicate turn_complete", { msgId });
 *   ```
 *
 * The store batches appends via `queueMicrotask` so a burst of
 * synchronous `log()` calls produces exactly one listener notification
 * per microtask tick. This:
 *   1. Coalesces many appends/sec into O(unique-tasks-touching-log)
 *      re-renders, NOT O(appends).
 *   2. Sidesteps React's "mutate external state during render"
 *      detector — render-time `log()` calls are safe because the
 *      actual store mutation happens after the React commit cycle
 *      settles.
 *
 * Persistence: filter selections (`levels`, `source`) and the cap
 * (`maxEntries`) round-trip through tugbank under
 * `dev.tugtool.dev-panel/{logFilterLevels,logFilterSource,logMaxEntries}`.
 * The buffer itself is transient (developers, not users, are the
 * consumers, so [L23] does not apply to entries).
 *
 * Console mirror: in development builds (`import.meta.env.DEV`),
 * `debug/info/warn/error(...)` also writes to `console.{level}(...)`
 * so dev-tools still sees the same stream while we transition consumers
 * from `console.*` calls. Production builds NEVER mirror.
 *
 * Conformance:
 *   - [L02] `useSyncExternalStore`-compatible `subscribe` +
 *     `getSnapshot`; references stay stable when state is unchanged.
 *   - [L23] persisted bits (filters + cap) survive HMR / reload.
 *   - `feedback_no_localstorage` — never used.
 *
 * @module lib/tug-dev-log-store/tug-dev-log-store
 */

import { getTugbankClient } from "../tugbank-singleton";
import { getConnection } from "../connection-singleton";
import { FeedId } from "../../protocol";
import type { TaggedValue } from "../tugbank-client";
import {
  createInitialState,
  reduce,
  toSnapshot,
  type TugDevLogEvent,
  type TugDevLogState,
} from "./reducer";
import {
  ALL_TUG_DEV_LOG_LEVELS,
  TUG_DEV_LOG_LEVELS,
  type TugDevLogEntry,
  type TugDevLogLevel,
  type TugDevLogSnapshot,
} from "./types";

/**
 * Tugbank domain owning the log store's persisted filter prefs. Re-homed
 * off the (deleted) dev-panel store, keeping the **same string** so users'
 * persisted log filters survive the panel's removal ([P09]). The log
 * store is panel-independent; the old coupling was incidental.
 */
export const LOG_STORE_DOMAIN = "dev.tugtool.dev-panel";

/** Tugbank keys for the log store's persisted state. */
export const DEV_LOG_KEYS = {
  FILTER_LEVELS: "logFilterLevels",
  FILTER_SOURCE: "logFilterSource",
  MAX_ENTRIES: "logMaxEntries",
  NEWEST_FIRST: "logNewestFirst",
} as const;

/**
 * Public input shape for `tugDevLogStore.log(...)`. The store fills
 * in `id` and `timestamp` automatically — callers that supply them
 * are ignored (we mint our own).
 */
export interface TugDevLogInput {
  level: TugDevLogLevel;
  source: string;
  message: string;
  data?: unknown;
}

class TugDevLogStore {
  private _state: TugDevLogState = createInitialState();
  private readonly _listeners = new Set<() => void>();
  private _tugbankUnsub: (() => void) | null = null;
  private _initialized = false;
  private _nextId = 1;

  // Microtask batching state.
  private _pending: TugDevLogEntry[] = [];
  private _flushScheduled = false;

  /**
   * Lazy init — runs the first time anything reads from the store.
   * Hydrates from tugbank if the client is available; subscribes to
   * domain pushes for live external updates.
   */
  private _ensureInitialized(): void {
    if (this._initialized) return;
    this._initialized = true;

    const client = getTugbankClient();
    if (!client) return;

    this._hydrateFromTugbank();

    this._tugbankUnsub = client.onDomainChanged((domain) => {
      if (domain === LOG_STORE_DOMAIN) {
        this._hydrateFromTugbank();
      }
    });
  }

  private _hydrateFromTugbank(): void {
    const client = getTugbankClient();
    if (!client) return;
    const levels = readLevels(
      client.get(LOG_STORE_DOMAIN, DEV_LOG_KEYS.FILTER_LEVELS),
    );
    const source = readNullableString(
      client.get(LOG_STORE_DOMAIN, DEV_LOG_KEYS.FILTER_SOURCE),
    );
    const maxEntries = readNumber(
      client.get(LOG_STORE_DOMAIN, DEV_LOG_KEYS.MAX_ENTRIES),
    );
    const newestFirst = readBool(
      client.get(LOG_STORE_DOMAIN, DEV_LOG_KEYS.NEWEST_FIRST),
    );
    this._dispatch(
      {
        type: "hydrate",
        ...(levels !== undefined ? { levels } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(maxEntries !== undefined ? { maxEntries } : {}),
        ...(newestFirst !== undefined ? { newestFirst } : {}),
      },
      { persist: false },
    );
  }

  private _dispatch(
    event: TugDevLogEvent,
    options: { persist: boolean } = { persist: true },
  ): void {
    const prev = this._state;
    const next = reduce(prev, event);
    if (next === prev) return;
    this._state = next;
    if (options.persist) {
      this._persistDiff(prev, next);
    }
    this._notify();
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (err) {
        // Cannot recurse into tugDevLogStore.warn() here — would
        // re-enter the store mid-notify. Fall back to console.
        console.warn("[TugDevLogStore] listener error:", err);
      }
    }
  }

  private _persistDiff(prev: TugDevLogState, next: TugDevLogState): void {
    if (prev.filters.levels !== next.filters.levels) {
      putJson(
        DEV_LOG_KEYS.FILTER_LEVELS,
        Array.from(next.filters.levels).sort(),
      );
    }
    if (prev.filters.source !== next.filters.source) {
      putNullableString(DEV_LOG_KEYS.FILTER_SOURCE, next.filters.source);
    }
    if (prev.maxEntries !== next.maxEntries) {
      putNumber(DEV_LOG_KEYS.MAX_ENTRIES, next.maxEntries);
    }
    if (prev.newestFirst !== next.newestFirst) {
      putBool(DEV_LOG_KEYS.NEWEST_FIRST, next.newestFirst);
    }
    // filters.text is in-memory only — never persisted.
  }

  // ── Public API ───────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._ensureInitialized();
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): TugDevLogSnapshot => {
    this._ensureInitialized();
    return toSnapshot(this._state);
  };

  /**
   * Core append API. Object-shape input so call sites can read at a
   * glance. Most callers will prefer the level-shortcut methods
   * below, which mirror to console in dev builds.
   *
   * Synchronous flush is intentionally avoided — see file-level
   * docstring for the microtask-batching rationale.
   */
  log = (input: TugDevLogInput): void => {
    this._ensureInitialized();
    const entry: TugDevLogEntry = {
      id: this._nextId++,
      timestamp: Date.now(),
      level: input.level,
      source: input.source,
      message: input.message,
      ...(input.data !== undefined ? { data: input.data } : {}),
    };
    this._pending.push(entry);
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => {
      this._flushScheduled = false;
      const drained = this._pending;
      this._pending = [];
      if (drained.length === 0) return;
      this._dispatch({ type: "append_batch", entries: drained });
    });
  };

  debug = (source: string, message: string, data?: unknown): void => {
    this._log("debug", source, message, data);
  };
  info = (source: string, message: string, data?: unknown): void => {
    this._log("info", source, message, data);
  };
  warn = (source: string, message: string, data?: unknown): void => {
    this._log("warn", source, message, data);
  };
  error = (source: string, message: string, data?: unknown): void => {
    this._log("error", source, message, data);
  };

  private _log(
    level: TugDevLogLevel,
    source: string,
    message: string,
    data?: unknown,
  ): void {
    this.log({ level, source, message, data });
    // Console mirror in dev builds only. The mirror runs synchronously
    // — independent of the store's microtask-batched append — so
    // dev-tools shows the call at the original call site, not after
    // the batch flush.
    if (IS_DEV_BUILD) {
      mirrorToConsole(level, source, message, data);
    }
    // Host mirror, every build: `warn`/`error` also go to tugcast's log.
    // The Log tab is only readable by someone sitting in front of the app
    // with the Lens open, and a release instance exposes no `window`
    // handle onto this store — so a warning about a restore that came back
    // short was, in practice, written nowhere a person could later read.
    // `tugcast.log` is the durable, after-the-fact surface.
    if (level === "warn" || level === "error") {
      mirrorToHost(level, source, message, data);
    }
  }

  /** Empty the buffer. Filters + cap are preserved. */
  clear = (): void => {
    this._ensureInitialized();
    this._dispatch({ type: "clear" });
  };

  /** Replace the active level set. Persists. */
  setLevels = (levels: ReadonlySet<TugDevLogLevel>): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_filters", levels });
  };

  /** Set or clear the source filter. Persists. */
  setSource = (source: string | null): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_filters", source });
  };

  /** Set the free-text filter. NOT persisted — survives tab switch
   * (store outlives inspector mount), lost on page reload. */
  setText = (text: string): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_filters", text });
  };

  /** Change the ring-buffer cap. Persists. Truncates oldest if
   * the new cap is smaller than the current buffer. */
  setMaxEntries = (n: number): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_max_entries", maxEntries: n });
  };

  /** Toggle the inspector's render direction. Persists.
   * `true` = newest-at-top (devtools convention),
   * `false` = oldest-at-top (`tail -f` convention; default). */
  setNewestFirst = (newestFirst: boolean): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_newest_first", newestFirst });
  };

  /**
   * Test seam — drop pending queue, listeners, and reset the
   * reducer state. Production never tears the store down.
   * @internal
   */
  _disposeForTest(): void {
    if (this._tugbankUnsub) {
      this._tugbankUnsub();
      this._tugbankUnsub = null;
    }
    this._listeners.clear();
    this._pending = [];
    this._flushScheduled = false;
    this._state = createInitialState();
    this._nextId = 1;
    this._initialized = false;
  }
}

export const tugDevLogStore = new TugDevLogStore();

// ---------------------------------------------------------------------------
// Internal — tugbank value helpers
// ---------------------------------------------------------------------------

function readLevels(
  entry: TaggedValue | undefined,
): ReadonlySet<TugDevLogLevel> | undefined {
  if (!entry || entry.kind !== "json") return undefined;
  const v = entry.value;
  if (!Array.isArray(v)) return undefined;
  const valid = new Set<TugDevLogLevel>();
  for (const x of v) {
    if (typeof x === "string" && isLogLevel(x)) {
      valid.add(x);
    }
  }
  // A persisted empty array is meaningful ("show nothing") — keep it.
  // Compare against the default to short-circuit a no-op hydrate.
  if (valid.size === ALL_TUG_DEV_LOG_LEVELS.size) {
    let allDefault = true;
    for (const lvl of valid) {
      if (!ALL_TUG_DEV_LOG_LEVELS.has(lvl)) {
        allDefault = false;
        break;
      }
    }
    if (allDefault) return ALL_TUG_DEV_LOG_LEVELS;
  }
  return valid;
}

function readNullableString(
  entry: TaggedValue | undefined,
): string | null | undefined {
  if (!entry) return undefined;
  if (entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  if (entry.kind === "null") return null;
  return undefined;
}

function readBool(entry: TaggedValue | undefined): boolean | undefined {
  if (!entry || entry.kind !== "bool") return undefined;
  return typeof entry.value === "boolean" ? entry.value : undefined;
}

function readNumber(entry: TaggedValue | undefined): number | undefined {
  if (!entry) return undefined;
  if (
    (entry.kind === "i64" || entry.kind === "f64") &&
    typeof entry.value === "number" &&
    Number.isFinite(entry.value)
  ) {
    return entry.value;
  }
  return undefined;
}

function isLogLevel(v: string): v is TugDevLogLevel {
  return (
    v === "debug" || v === "info" || v === "warn" || v === "error"
  );
}

function putBool(key: string, value: boolean): void {
  putRaw(key, { kind: "bool", value });
}

function putJson(key: string, value: unknown): void {
  putRaw(key, { kind: "json", value });
}

function putNullableString(key: string, value: string | null): void {
  if (value === null) {
    putRaw(key, { kind: "null", value: null });
  } else {
    putRaw(key, { kind: "string", value });
  }
}

function putNumber(key: string, value: number): void {
  putRaw(key, { kind: "i64", value: Math.round(value) });
}

interface RawTaggedBody {
  kind: string;
  value: unknown;
}

function putRaw(key: string, body: RawTaggedBody): void {
  const client = getTugbankClient();
  if (client && typeof client.setLocalValue === "function") {
    client.setLocalValue(LOG_STORE_DOMAIN, key, body as TaggedValue);
  }
  fetch(`/api/defaults/${LOG_STORE_DOMAIN}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    // Cannot recurse into tugDevLogStore.warn(); plain console.
    console.warn(`[TugDevLogStore] PUT ${key} failed:`, err);
  });
}

// ---------------------------------------------------------------------------
// Console mirror — dev builds only
// ---------------------------------------------------------------------------

const IS_DEV_BUILD = (() => {
  try {
    return Boolean(
      (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
    );
  } catch {
    return false;
  }
})();

/**
 * Mirror one `warn`/`error` to tugcast, which writes it into `tugcast.log`.
 *
 * Best-effort and deliberately un-retried: this is a diagnostic echo, not a
 * ledger write, and a dropped frame must never become a second thing to
 * diagnose. Failures fall back to the console rather than re-entering this
 * store, which would recurse.
 */
function mirrorToHost(
  level: TugDevLogLevel,
  source: string,
  message: string,
  data: unknown,
): void {
  try {
    const conn = getConnection();
    if (!conn) return;
    conn.trySend(
      FeedId.CONTROL,
      new TextEncoder().encode(
        JSON.stringify({
          action: "deck_log",
          level,
          source,
          message,
          // Serialized here rather than server-side: `data` is arbitrary and
          // may hold cycles, and a throw inside JSON.stringify of the whole
          // frame would drop the message along with it.
          data: safeDetail(data),
        }),
      ),
    );
  } catch {
    // Cannot recurse into this store; plain console.
    console.warn(`[${source}] host-log mirror failed:`, message);
  }
}

/** `data` as a short string, or undefined — never a throw, never unbounded. */
function safeDetail(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  try {
    return JSON.stringify(data)?.slice(0, 2000);
  } catch {
    return String(data).slice(0, 2000);
  }
}

function mirrorToConsole(
  level: TugDevLogLevel,
  source: string,
  message: string,
  data: unknown,
): void {
  const prefix = `[${source}]`;
  const fn = consoleFnFor(level);
  if (data === undefined) {
    fn(prefix, message);
  } else {
    fn(prefix, message, data);
  }
}

function consoleFnFor(level: TugDevLogLevel): (...args: unknown[]) => void {
  switch (level) {
    case "debug":
      return console.debug.bind(console);
    case "info":
      return console.info.bind(console);
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
  }
}

/** Exported for tests that need to enumerate valid levels without
 * reaching into the types module. */
export { TUG_DEV_LOG_LEVELS, ALL_TUG_DEV_LOG_LEVELS };
