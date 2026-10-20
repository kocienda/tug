/**
 * os-thumbnail-store — QuickLook thumbnails for the attachments that have no
 * pixels of their own.
 *
 * An image attachment paints itself. A `.txt`, a `.pdf`, a `.key`, a `.zip`
 * cannot, and a generic document glyph says nothing about *which* file it is —
 * which is exactly what a preview strip exists to answer. macOS already knows
 * how to draw all of these, and QuickLook is the only way to ask: the thumbnail
 * is rendered by the owning app's extension, out of process. Nothing in the web
 * layer can reach that, so the request goes through the host bridge
 * (`thumbnailPath` in `tugapp/Sources/MainWindow.swift`).
 *
 * ## Why a store rather than an effect in the tile
 *
 * The answer arrives asynchronously and outlives the component that asked for
 * it — a strip re-renders on every keystroke that touches a link, and a tile
 * that re-requested its thumbnail each time would round-trip to a QuickLook
 * extension per keystroke. So the result is cached here, keyed by path, and
 * read through `useSyncExternalStore` ([L02]) like every other external state.
 * A path is requested at most once per session; the entry it settles into is
 * what every later mount reads.
 *
 * A path with no thumbnail settles to `null` and stays there. That is a real
 * answer, not a pending one — the tile falls back to its glyph and never asks
 * again.
 *
 * @module lib/os-thumbnail-store
 */

import { createSubscribable } from "./subscribable";
import { hostAvailable, onHostMessage, postToHost } from "../host/channel";
import { thumbnailPathToHost, thumbnailToPage } from "../host/declarations/services";

/** What the host reports back. `dataUrl` is null when QuickLook had nothing. */
interface ThumbnailCallbackData {
  requestId: string;
  dataUrl?: string | null;
}

/**
 * Settled results, keyed by path: a PNG data URL, or `null` for "asked, and
 * there is no thumbnail". A path absent from the map has not been asked yet.
 */
const thumbnails = new Map<string, string | null>();

/** Paths with a request in flight, so a re-render never starts a second one. */
const inFlight = new Set<string>();

const listeners = createSubscribable();

function notify(): void {
  listeners.notify();
}

/** Subscribe to thumbnail arrivals — the `useSyncExternalStore` half. */
export function subscribeToOSThumbnails(listener: () => void): () => void {
  return listeners.subscribe(listener);
}

/**
 * The thumbnail for `path`, or `null` when there is none *or* one has not
 * arrived yet. Snapshot-stable: the same string identity until a new answer
 * lands, so `useSyncExternalStore` does not loop.
 */
export function osThumbnailFor(path: string): string | null {
  return thumbnails.get(path) ?? null;
}

/** True when the page is running inside Tug.app with the handler registered. */
export function hasOSThumbnailBridge(): boolean {
  return hostAvailable(thumbnailPathToHost);
}

/**
 * A QuickLook render can spin up an out-of-process extension, so it is slower
 * than a clipboard read by a wide margin. Giving up early costs a glyph where
 * a preview would have been, which is the pre-existing appearance.
 */
const THUMBNAIL_TIMEOUT_MS = 10_000;

const pending = new Map<string, (data: ThumbnailCallbackData) => void>();

let callbackInstalled = false;
let requestSeq = 0;

function installCallback(): void {
  if (callbackInstalled) return;
  callbackInstalled = true;
  onHostMessage(thumbnailToPage, (payload) => {
    const data = payload as ThumbnailCallbackData;
    if (typeof data.requestId !== "string") return;
    const settle = pending.get(data.requestId);
    if (settle) settle(data);
  });
}

/**
 * Ask the host for `path`'s thumbnail, once.
 *
 * Returns immediately; the answer lands in the store and notifies. A repeat
 * call for a path already settled or already in flight does nothing, which is
 * what makes this safe to call from a render that runs on every keystroke.
 *
 * `size` is the tile's edge in points — the host scales it by the window's
 * backing factor, so a retina tile gets retina pixels.
 */
export function requestOSThumbnail(path: string, size: number): void {
  if (path.length === 0) return;
  if (thumbnails.has(path) || inFlight.has(path)) return;
  if (!hostAvailable(thumbnailPathToHost)) return;

  installCallback();
  inFlight.add(path);
  const requestId = `tug-thumb-${Date.now()}-${requestSeq++}`;
  let settled = false;
  const settle = (dataUrl: string | null): void => {
    if (settled) return;
    settled = true;
    pending.delete(requestId);
    inFlight.delete(path);
    clearTimeout(timeoutHandle);
    thumbnails.set(path, dataUrl);
    notify();
  };
  const timeoutHandle = setTimeout(() => {
    // Left OUT of the settled map on a timeout: a slow render is not the same
    // answer as "there is no thumbnail", and the next mount should try again.
    if (settled) return;
    settled = true;
    pending.delete(requestId);
    inFlight.delete(path);
  }, THUMBNAIL_TIMEOUT_MS);
  pending.set(requestId, (data) => {
    settle(typeof data.dataUrl === "string" ? data.dataUrl : null);
  });
  postToHost(thumbnailPathToHost, { requestId, path, size });
}
