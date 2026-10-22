/**
 * When an incremental update lands in a page, said to the host.
 *
 * Every page — the shell, the overlay, each body — posts `hmrUpdate` once
 * Vite's `vite:afterUpdate` has applied an update in it, carrying Vite's own
 * stamp for the update. The host logs the page and the time since that stamp,
 * so a CSS or component edit has a number on a deck of a dozen pages, where
 * before nothing recorded when it arrived anywhere.
 *
 * Dev only: `import.meta.hot` is absent from a shipped build, and every
 * caller passes its own entry's `import.meta.hot`, so a listener belongs to
 * the page's entry and is never stacked by this module being replaced.
 *
 * @module lib/hmr-landed
 */

import { postToHost } from "../host/channel";
import { hmrUpdateToHost, type HmrUpdate } from "../host/declarations/lifecycle";

/** The part of Vite's `vite:afterUpdate` payload read here. */
export interface AfterUpdatePayload {
  readonly updates: readonly { readonly timestamp: number }[];
}

/**
 * The report for one applied update: the earliest stamp it carried, which is
 * when Vite saw the change, and how many modules it carried. Null for an
 * update that carried none.
 */
export function hmrUpdateOf(payload: AfterUpdatePayload): HmrUpdate | null {
  if (payload.updates.length === 0) return null;
  let viteAt = Infinity;
  for (const update of payload.updates) viteAt = Math.min(viteAt, update.timestamp);
  if (!Number.isFinite(viteAt)) return null;
  return { viteAt, modules: payload.updates.length };
}

/** Post `hmrUpdate` to the host for an applied update. */
export function reportHmrLanded(payload: AfterUpdatePayload): void {
  const update = hmrUpdateOf(payload);
  if (update !== null) postToHost(hmrUpdateToHost, update);
}

/** Report every update `hot` applies in this page. The shell's own `hmr-bridge` calls `reportHmrLanded` from its handler instead. */
export function installHmrLanded(hot: NonNullable<ImportMeta["hot"]>): void {
  hot.on("vite:afterUpdate", reportHmrLanded);
}
