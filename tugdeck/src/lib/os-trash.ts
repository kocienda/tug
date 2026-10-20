/**
 * os-trash — the deck half of Tug.app's Trash bridge.
 *
 * ## Why the host owns both halves
 *
 * Removing an attachment moves its file to the **macOS Trash** rather than
 * unlinking it, so the gesture is recoverable two ways: Cmd-Z inside Tug, and
 * Finder's Put Back for the user who never presses it. `NSWorkspace.recycle`
 * reports the destination URL it minted, and that URL is the entire restore
 * mechanism — {@link restoreTrashedPathInOS} moves the file back from it, so
 * undo never has to drive Put Back programmatically.
 *
 * The restore lives in the host too, and has to: tugcast's `fs` route family
 * has no move or copy verb, and `POST /api/fs/write` is a text-document writer
 * (`content: String`) that would corrupt any binary asset routed through it.
 * The host is already holding the URL, and the move is one `FileManager` call.
 *
 * ## Protocol
 *
 * Both verbs follow the request/response shape `clipboardRead` established:
 * post a `requestId`, receive `window.__tugBridge.onTrashResult({requestId, ok, …})`.
 * Handlers are `trashPath` and `restorePath` in `tugapp/Sources/MainWindow.swift`.
 *
 * Outside Tug.app (browser development) the bridge is absent and both verbs
 * resolve `null`. That is deliberate: the caller reports the failure rather
 * than editing the document and orphaning the file, because a Cmd-Z that
 * cannot bring the file back is worse than a removal that refused.
 */

import type { ToHost } from "../host/declare";
import { hostAvailable, onHostMessage, postToHost } from "../host/channel";
import { restorePathToHost, trashPathToHost, trashResultToPage } from "../host/declarations/services";

/** What the host reports back for either verb. */
interface TrashCallbackData {
  requestId: string;
  ok: boolean;
  trashedPath?: string;
  restoredPath?: string;
  error?: string;
}

/** Map of pending requestId → settler. Shared by both verbs; ids are unique. */
const pendingCallbacks = new Map<string, (data: TrashCallbackData) => void>();

let callbackInstalled = false;

function installCallback(): void {
  if (callbackInstalled) return;
  callbackInstalled = true;
  onHostMessage(trashResultToPage, (payload) => {
    const data = payload as TrashCallbackData;
    if (typeof data.requestId !== "string") return;
    const settle = pendingCallbacks.get(data.requestId);
    if (settle) settle(data);
  });
}

/**
 * True when the page is running inside Tug.app and the host has registered the
 * trash handlers. Callers branch on this to decide whether the ✕ affordance can
 * honor its undo contract at all.
 */
export function hasTrashBridge(): boolean {
  return hostAvailable(trashPathToHost);
}

/**
 * A file operation can take real time — a large asset on a slow volume, a
 * Trash on a different filesystem. Generous compared to the clipboard's 1s,
 * because the cost of giving up early is an orphaned file rather than an empty
 * paste.
 */
const TRASH_TIMEOUT_MS = 10_000;

let requestSeq = 0;

/** Post `payload` as `decl` and settle on the host's reply. */
function request(
  decl: ToHost<object>,
  payload: Record<string, unknown>,
): Promise<TrashCallbackData | null> {
  installCallback();
  const requestId = `tug-trash-${Date.now()}-${requestSeq++}`;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (data: TrashCallbackData | null) => {
      if (settled) return;
      settled = true;
      pendingCallbacks.delete(requestId);
      clearTimeout(timeoutHandle);
      resolve(data);
    };
    pendingCallbacks.set(requestId, settle);
    const timeoutHandle = setTimeout(() => {
      console.warn(`os-trash: host callback timed out after ${TRASH_TIMEOUT_MS}ms`);
      settle(null);
    }, TRASH_TIMEOUT_MS);
    postToHost(decl, { requestId, ...payload });
  });
}

/**
 * Move `path` to the macOS Trash.
 *
 * Resolves with the trashed file's URL — the handle a later
 * {@link restoreTrashedPathInOS} needs — or `null` when the bridge is absent or
 * the host reported failure (a read-only volume, a file already gone). A `null`
 * means *nothing was moved*, so the caller must not proceed as if it had been.
 */
export async function trashPathInOS(path: string): Promise<string | null> {
  if (!hostAvailable(trashPathToHost)) return null;
  if (path.length === 0) return null;
  const data = await request(trashPathToHost, { path });
  if (!data || !data.ok || typeof data.trashedPath !== "string") {
    if (data?.error) console.warn(`os-trash: trash failed — ${data.error}`);
    return null;
  }
  return data.trashedPath;
}

/**
 * Move a trashed file back to `destination`.
 *
 * Resolves with the path it actually landed at, which differs from
 * `destination` when something took that name while the file sat in the Trash —
 * the caller rewrites the re-inserted link to match. Resolves `null` when the
 * bridge is absent or the restore failed, the ordinary cause being a Trash the
 * user emptied between the removal and the undo.
 */
export async function restoreTrashedPathInOS(
  trashedPath: string,
  destination: string,
): Promise<string | null> {
  if (!hostAvailable(restorePathToHost)) return null;
  if (trashedPath.length === 0 || destination.length === 0) return null;
  const data = await request(restorePathToHost, { trashedPath, destination });
  if (!data || !data.ok || typeof data.restoredPath !== "string") {
    if (data?.error) console.warn(`os-trash: restore failed — ${data.error}`);
    return null;
  }
  return data.restoredPath;
}
