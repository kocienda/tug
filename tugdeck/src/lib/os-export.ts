/**
 * os-export.ts — request/response client for the macOS host's session-export
 * save panel ([#step-13c]).
 *
 * The Tug.app host exposes an `exportSession` `WKScriptMessageHandler`. We post
 * `{ id, baseName, markdown, jsonl }`; the host opens an `NSSavePanel` with a
 * File Format popup (Markdown / JSON Lines), writes the content for the chosen
 * format to the picked path, and calls back
 * `window.__tugBridge.onExportDone(id, result)` with `"saved"` / `"canceled"`.
 * Each call carries a unique id so concurrent exports don't cross wires.
 *
 * We send *both* formats' content so format selection can live in the native
 * save dialog (the canonical macOS "Export As…" shape) without a second
 * round-trip — transcripts are small.
 *
 * Graceful degradation: outside the host (dev browser, or before the app is
 * rebuilt with the handler) {@link isExportAvailable} is `false` and
 * {@link exportSession} resolves `"unavailable"`, so callers can surface a
 * "needs the app" notice instead of silently doing nothing.
 *
 * @module lib/os-export
 */

import { hostAvailable, onHostMessage, postToHost } from "../host/channel";
import { exportDoneToPage, exportSessionToHost } from "../host/declarations/services";

/** Outcome of an export attempt. */
export type ExportResult = "saved" | "canceled" | "unavailable";

/** Resolvers awaiting a native callback, keyed by request id. */
const pending = new Map<string, (result: ExportResult) => void>();

/** Monotonic request-id counter (no Date/random — resume-safe and unique enough). */
let nextId = 0;

let receiving = false;

/** Take `__tugBridge.onExportDone({id, result})` in this page, once. */
function ensureBridge(): void {
  if (receiving) return;
  receiving = true;
  onHostMessage(exportDoneToPage, ({ id, result }) => {
    const resolve = pending.get(id);
    if (resolve !== undefined) {
      pending.delete(id);
      resolve(result);
    }
  });
}

/** Whether the native export panel is reachable (running inside Tug.app). */
export function isExportAvailable(): boolean {
  return hostAvailable(exportSessionToHost);
}

/** Content + default filename for a session export. */
export interface ExportRequest {
  /** Default base filename (no extension), e.g. `tug-session-1a2b3c4d`. */
  baseName: string;
  /** The Markdown rendering of the transcript. */
  markdown: string;
  /** The JSON Lines rendering of the transcript. */
  jsonl: string;
}

/**
 * Open the host's save panel for `request`, resolving `"saved"` once the file
 * is written, `"canceled"` if the user dismisses the panel, or `"unavailable"`
 * when not running inside the host.
 */
export function exportSession(request: ExportRequest): Promise<ExportResult> {
  if (!hostAvailable(exportSessionToHost)) return Promise.resolve("unavailable");
  ensureBridge();
  const id = `export-${(nextId += 1)}`;
  return new Promise<ExportResult>((resolve) => {
    pending.set(id, resolve);
    postToHost(exportSessionToHost, {
      id,
      baseName: request.baseName,
      markdown: request.markdown,
      jsonl: request.jsonl,
    });
  });
}
