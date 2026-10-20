/**
 * The host's frame reading, asked for from the page.
 *
 * Every other frame instrument on `window.__tugMotion` lives in the deck's
 * own page, on the deck's main thread, so it cannot say what the window showed
 * while that thread was busy — and that is exactly the reading a page placed
 * in its own web view has to be judged by. The host keeps a display-link
 * meter in the UI process (`tugapp/Sources/HostFrameMeter.swift`); this asks
 * it for a window of ticks through the `hostFrames` message and resolves with
 * what it read, delivered to `window.__tugBridge.onHostFrames`.
 *
 * Bounded ([L33]): a reply that has not arrived `windowMs + 2000` after the
 * ask rejects, and a page with no host (a browser on the Vite port) rejects at
 * once rather than waiting on nobody.
 *
 * @module lib/motion-guard/host-frames
 */

import { hostAvailable, onHostMessage, postToHost } from "../../host/channel";
import { hostFramesToHost, hostFramesToPage } from "../../host/declarations/services";

/** A window of host display-link ticks (Spec S06's `HostFrameReading`). */
export interface HostFrameReading {
  periodMs: number;
  ticks: number;
  expectedTicks: number;
  missed: number;
  worstGapMs: number;
  gapsOverPeriod: Array<{ atMs: number; gapMs: number }>;
  samples?: Array<{ t: number; x: number; y: number; opacity: number }>;
  /** The wall clock (ms since 1970) at the meter's arming; its `t` are from there. */
  armedWallMs?: number;
  /** Every tick inside the window, ms from arming. */
  tickMs?: number[];
  /**
   * Each layer the meter sampled by name — a carried body's container under
   * its card id — with the spans its beats move it over, and across those
   * the share of ticks its presentation advanced on and its longest still run.
   */
  layers?: Record<
    string,
    {
      samples: Array<{ t: number; x: number; y: number; opacity: number }>;
      active: Array<{ fromMs: number; toMs: number }>;
      activeTicks: number;
      advancedRatio: number | null;
      worstStillMs: number;
    }
  >;
}

/** The window `tugtool deck motion frames` reads when it names none. */
export const HOST_FRAMES_WINDOW_DEFAULT_MS = 2000;

/** How long past its window a reply may take before the ask gives up. */
const HOST_FRAMES_REPLY_SLACK_MS = 2000;

const pending = new Map<string, (reading: HostFrameReading) => void>();
let requestSeq = 0;

let callbackInstalled = false;

function installCallback(): void {
  if (callbackInstalled) return;
  callbackInstalled = true;
  onHostMessage(hostFramesToPage, (payload) => {
    const data = payload as { requestId?: unknown; reading?: unknown };
    if (typeof data.requestId !== "string") return;
    const settle = pending.get(data.requestId);
    if (!settle) return;
    pending.delete(data.requestId);
    settle(data.reading as HostFrameReading);
  });
}

/** Ask the host to meter the window's frames over the next `windowMs`. */
export function requestHostFrames(
  windowMs: number = HOST_FRAMES_WINDOW_DEFAULT_MS,
): Promise<HostFrameReading> {
  if (!hostAvailable(hostFramesToHost)) return Promise.reject(new Error("hostFrames: no host to ask"));
  installCallback();
  const requestId = `tug-host-frames-${Date.now()}-${requestSeq++}`;
  return new Promise((resolve, reject) => {
    const deadline = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`hostFrames: no reply within ${windowMs + HOST_FRAMES_REPLY_SLACK_MS} ms`));
    }, windowMs + HOST_FRAMES_REPLY_SLACK_MS);
    pending.set(requestId, (reading) => {
      window.clearTimeout(deadline);
      resolve(reading);
    });
    postToHost(hostFramesToHost, { requestId, windowMs });
  });
}
