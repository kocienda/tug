/**
 * os-share.ts — request/response client for the macOS host's share surfaces.
 *
 * A share's artifact — the scrubbed Markdown, or a PDF or PNG the host
 * rendered — leaves through the host: a preview sheet first, then the save
 * panel, the pasteboard or the share picker. Each request carries a unique id,
 * and the host answers `window.__tugBridge.onShareDone({ id, result })`, which
 * settles the one request it names.
 *
 * Outside the host (a dev browser, or an app built before these handlers)
 * {@link isShareAvailable} is `false` and every request resolves
 * `"unavailable"`, so a caller can say the action needs the app rather than
 * doing nothing.
 *
 * @module lib/os-share
 */

import { hostAvailable, onHostMessage, postToHost } from "../host/channel";
import {
  shareCopyToHost,
  shareDoneToPage,
  sharePickToHost,
  sharePreviewToHost,
  shareRenderedToPage,
  shareRenderToHost,
  shareSaveToHost,
} from "../host/declarations/services";
import type { ShareFormat } from "./share-turns";

/** How a share request ended, or that the host was not there to ask. */
export type ShareDoneResult = "done" | "canceled" | "shown" | "failed" | "unavailable";

/** A share artifact as the host takes it: Markdown as text, a render as a file. */
export interface ShareArtifactRef {
  format: ShareFormat;
  /** The Markdown, for `markdown`; `""` otherwise. */
  text: string;
  /** The rendered file, for `pdf` and `png`; `""` otherwise. */
  path: string;
}

/** Resolvers awaiting `onShareDone`, keyed by request id. */
const pending = new Map<string, (result: ShareDoneResult) => void>();

let nextId = 0;

let receiving = false;

/** Take `__tugBridge.onShareDone({ id, result })` in this page, once. */
function ensureBridge(): void {
  if (receiving) return;
  receiving = true;
  onHostMessage(shareDoneToPage, ({ id, result }) => {
    const resolve = pending.get(id);
    if (resolve !== undefined) {
      pending.delete(id);
      resolve(result);
    }
  });
}

/** Whether the host's share surfaces are reachable (running inside Tug.app). */
export function isShareAvailable(): boolean {
  return hostAvailable(sharePreviewToHost);
}

/** Post one request under a fresh id and await its `onShareDone`. */
function request(post: (id: string) => void): Promise<ShareDoneResult> {
  ensureBridge();
  nextId += 1;
  const id = `share-${nextId}`;
  return new Promise<ShareDoneResult>((resolve) => {
    pending.set(id, resolve);
    post(id);
  });
}

/**
 * Show `artifact` in the host's preview sheet. Resolves `"done"` when the
 * sheet is dismissed, or `"failed"` when the artifact could not be shown.
 */
export function sharePreview(artifact: ShareArtifactRef): Promise<ShareDoneResult> {
  if (!hostAvailable(sharePreviewToHost)) return Promise.resolve("unavailable");
  return request((id) => postToHost(sharePreviewToHost, { id, ...artifact }));
}

/**
 * Save `artifact` through the host's save panel, offering its one format
 * under `baseName`. Resolves `"done"` once written, `"canceled"` when the
 * panel is dismissed, or `"failed"` when the write fails.
 */
export function shareSave(
  artifact: ShareArtifactRef & { baseName: string },
): Promise<ShareDoneResult> {
  if (!hostAvailable(shareSaveToHost)) return Promise.resolve("unavailable");
  return request((id) => postToHost(shareSaveToHost, { id, ...artifact }));
}

/**
 * Copy a previewed image to the pasteboard: the PNG at `path`, with the
 * Markdown `text` as its plain-text flavour. Resolves `"done"`, or `"failed"`
 * when the host could not read the file.
 */
export function shareCopyImage(path: string, text: string): Promise<ShareDoneResult> {
  if (!hostAvailable(shareCopyToHost)) return Promise.resolve("unavailable");
  return request((id) => postToHost(shareCopyToHost, { id, path, text }));
}

/** A rect in the posting page's viewport, as `getBoundingClientRect()` gives it. */
export interface ShareAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Show the system share picker over `artifact`, anchored at `anchor`.
 * Resolves `"shown"` once the picker is up; what the user picks is AppKit's.
 */
export function sharePick(artifact: ShareArtifactRef, anchor: ShareAnchor): Promise<ShareDoneResult> {
  if (!hostAvailable(sharePickToHost)) return Promise.resolve("unavailable");
  return request((id) => postToHost(sharePickToHost, { id, ...artifact, ...anchor }));
}

/** How a render ended, as the host answers it ([P09]). */
export interface ShareRenderOutcome {
  result: "ok" | "failed" | "tooTall";
  /** The rendered file, for `ok`; `""` otherwise. */
  path: string;
  /** The document's height in CSS pixels; `0` when nothing was laid out. */
  height: number;
  /** The PDF's page count, `1` for an image, `0` when nothing was written. */
  pages: number;
  /** The inline-styled HTML of an `ok` PDF; `""` otherwise. */
  html: string;
}

/** The outcome a render that never reached the host stands for. */
const RENDER_UNAVAILABLE: ShareRenderOutcome = { result: "failed", path: "", height: 0, pages: 0, html: "" };

/** Resolvers awaiting `onShareRendered`, keyed by request id. */
const pendingRenders = new Map<string, (outcome: ShareRenderOutcome) => void>();

let receivingRenders = false;

let nextRenderId = 0;

/**
 * Render `document` (a `ShareRenderDocument`, as JSON) to a file through the
 * host's hidden share page. The host bounds every render with its own
 * deadline, so this always settles: outside the host it resolves `failed` at
 * once.
 */
export function shareRender(format: "pdf" | "png", document: string): Promise<ShareRenderOutcome> {
  if (!hostAvailable(shareRenderToHost)) return Promise.resolve(RENDER_UNAVAILABLE);
  if (!receivingRenders) {
    receivingRenders = true;
    onHostMessage(shareRenderedToPage, ({ id, ...outcome }) => {
      const resolve = pendingRenders.get(id);
      if (resolve !== undefined) {
        pendingRenders.delete(id);
        // The id is the thread through `tugapp.log`'s renderer lines.
        if (outcome.result === "failed") console.warn(`share render ${id} failed`);
        resolve(outcome);
      }
    });
  }
  nextRenderId += 1;
  const id = `share-render-${Date.now().toString(36)}-${nextRenderId}`;
  return new Promise<ShareRenderOutcome>((resolve) => {
    pendingRenders.set(id, resolve);
    postToHost(shareRenderToHost, { id, format, document });
  });
}
