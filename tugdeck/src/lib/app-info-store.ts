/**
 * AppInfoStore — app identity delivered by the native host.
 *
 * The Swift app menu's About item sends a `show-card` control frame
 * whose payload carries the app's build identity (version, build,
 * commit, branch, profile, copyright) read from `BuildInfo` /
 * Info.plist on the native side. The `show-card` action handler parks
 * that payload here; the About card reads it via
 * `useSyncExternalStore` [L02].
 *
 * In-memory only — identity is constant for a process lifetime and is
 * re-delivered on every About invocation, so nothing persists. When no
 * payload has arrived yet (browser-only dev with no Swift host), the
 * snapshot is `null` and the About card renders placeholders.
 *
 * @module lib/app-info-store
 */

import { createSubscribable } from "./subscribable";

/** App identity fields from the native `show-card` payload. */
export interface AppInfo {
  /** The running variant's display name (`CFBundleName`), e.g.
   *  "Tug", "Tug-debug". The wordmark and About card title read this. */
  name?: string;
  /** Marketing version (`CFBundleShortVersionString`), e.g. "0.8.0". */
  version?: string;
  /** Build number (`CFBundleVersion`), e.g. "800". */
  build?: string;
  /** Full SHA-1 of HEAD at build time. Diagnostic only. */
  commit?: string;
  /** Branch the bundle was built from. */
  branch?: string;
  /** Build profile: "debug" or "release". */
  profile?: string;
  /** Human-readable copyright line. */
  copyright?: string;
  /** The running bundle's app icon as a PNG data URL. */
  icon?: string;
}

const APP_INFO_KEYS = [
  "name",
  "version",
  "build",
  "commit",
  "branch",
  "profile",
  "copyright",
  "icon",
] as const;

let snapshot: AppInfo | null = null;
const listeners = createSubscribable();

function notify(): void {
  listeners.notify();
}

export const appInfoStore = {
  /**
   * Replace the stored identity. The snapshot reference changes only
   * on `set`, so `useSyncExternalStore` consumers re-render exactly
   * when new identity arrives.
   */
  set(info: AppInfo): void {
    snapshot = info;
    notify();
  },

  /**
   * Pick the known string-valued identity fields out of a raw control
   * payload and store them. Non-string values are dropped per-field,
   * so a partially well-formed payload still surfaces what it can.
   */
  setFromPayload(payload: Record<string, unknown>): void {
    const info: AppInfo = {};
    for (const key of APP_INFO_KEYS) {
      const value = payload[key];
      if (typeof value === "string") info[key] = value;
    }
    snapshot = info;
    notify();
  },

  getSnapshot(): AppInfo | null {
    return snapshot;
  },

  subscribe(listener: () => void): () => void {
    return listeners.subscribe(listener);
  },

  /** Test-only reset for isolation between cases. */
  _resetForTest(): void {
    snapshot = null;
    listeners.clearListeners();
  },
};
