/**
 * maker-mode-bridge.ts — read-only client for the macOS host's settings
 * bridge (the `getSettings` `WKScriptMessageHandler`).
 *
 * Maker mode is not a setting: the host derives it from the build profile
 * (on in debug bundles, absent from release ones), so this side only ever
 * reads it. The menu-state layer needs the fact because a hidden Maker
 * menu's chords must fall through to the web view.
 *
 * The host answers with `settingsLoadedToPage` (`{ makerMode, sourceTree }`,
 * declared in `host/declarations/services.ts`). The reply carries no request
 * id, so pending resolvers queue FIFO; the host answers in request order.
 *
 * Graceful degradation: outside the host (browser dev) the handler is
 * absent and the call resolves `null`.
 *
 * @module lib/maker-mode-bridge
 */

import { hostAvailable, onHostMessage, postToHost } from "../host/channel";
import { getSettingsToHost, settingsLoadedToPage } from "../host/declarations/services";

/** The host's reply to a `getSettings` request. */
export interface HostSettings {
  /** The maker-mode gate (Maker menu + dev serving). */
  makerMode: boolean;
  /** Configured source-tree path, or null when unset. */
  sourceTree: string | null;
}

/** FIFO resolvers awaiting `onSettingsLoaded`. */
const pendingSettings: Array<(settings: HostSettings) => void> = [];

/**
 * The maker-mode gate as last reported by the host, or `null` before any
 * reply has arrived. Constant for a page lifetime — the host derives it
 * from the build profile — so one boot-time `getSettings` round trip
 * settles it. The menu-state layer reads it to decide whether the Maker
 * menu's chords claim their keys (a hidden menu's chords fall through).
 */
let knownMakerMode: boolean | null = null;

/** See {@link knownMakerMode}. */
export function lastKnownMakerMode(): boolean | null {
  return knownMakerMode;
}

let receiving = false;

/** Take `__tugBridge.onSettingsLoaded` in this page, once. */
function ensureBridge(): void {
  if (receiving) return;
  receiving = true;
  onHostMessage(settingsLoadedToPage, (settings) => {
    knownMakerMode = settings.makerMode;
    const resolve = pendingSettings.shift();
    if (resolve === undefined) return;
    resolve(settings);
  });
}

/**
 * Read the host's current settings. Resolves `null` when the bridge is
 * unavailable (browser dev).
 */
export function getSettings(): Promise<HostSettings | null> {
  if (!hostAvailable(getSettingsToHost)) return Promise.resolve(null);
  ensureBridge();
  return new Promise<HostSettings | null>((resolve) => {
    pendingSettings.push(resolve as (settings: HostSettings) => void);
    postToHost(getSettingsToHost, {});
  });
}
