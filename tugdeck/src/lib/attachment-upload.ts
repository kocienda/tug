/**
 * `attachment-upload` — the deck's side of tugcast's two attachment routes.
 *
 * An attachment is a file somewhere on disk and a short string the surface
 * holds. This module is where the deck turns dropped bytes into that string:
 *
 *  - {@link uploadDraftAttachment} sends a composer image's **original** bytes
 *    to `POST /api/attachments` and comes back with the absolute path tugcast
 *    rested them at. What the bytes-store holds is the *downsampled* copy —
 *    the caps exist for API-payload reasons and baking them into storage would
 *    destroy data — so a draft that survives a relaunch resubmits at exactly
 *    the quality one that didn't would.
 *  - {@link rehydrateDraftAttachments} is the return trip: a restored entry
 *    that carries a path and no bytes is read back through `/api/fs/blob`,
 *    run through the downsample pipeline, and put whole. This is the same
 *    fetch-decode-put shape the Overview's attachment strip has shipped, down
 *    to the in-flight interlock and the chunked base64 conversion, which both
 *    callers now share from here.
 *  - {@link uploadDocAttachment} is the document tier: a file dropped on a
 *    Text card is copied into an `assets/` folder beside the document it is
 *    being dropped on, and the response carries the relative name the markdown
 *    link should use. Those bytes are the user's, in the user's own directory,
 *    reachable by any tool that reads the file — which is the whole point of
 *    not putting them in a database.
 *
 * The media type sent up is always the dropped `File`'s own, never the
 * downsample pipeline's output type: a PNG that hits the JPEG quality ladder
 * comes back from the pipeline as `image/jpeg`, and deriving the stored
 * extension from that would write PNG bytes into a `.jpg` that `/api/fs/blob`
 * then serves as `Content-Type: image/jpeg`.
 *
 * Every failure here is survivable. A refused type, an unreachable server, a
 * body over the limit — all of them leave the entry without a `path`, which
 * degrades to the behavior that shipped before any of this existed: the chip
 * works for this session and does not come back after a relaunch.
 *
 * @module lib/attachment-upload
 */

import type { AtomBytesEntry, AtomBytesStore } from "./atom-bytes-store";
import { downsampleImage } from "./image-downsample";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/**
 * Base64 for a byte buffer, chunked.
 *
 * `String.fromCharCode(...bytes)` on a whole image blows the argument limit
 * somewhere north of a hundred kilobytes — which every screenshot is — so the
 * conversion walks the buffer in slices. `FileReader`'s data-URL path would
 * also work and is asynchronous for no reason here; this is called once per
 * image, off the render path.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Store `file`'s original bytes in the per-instance draft-attachments folder
 * and return the absolute path they landed at, or `null` when they did not.
 *
 * `null` is not exceptional — an unmapped media type (SVG is the live case:
 * the drop gate admits it, `/api/fs/blob` deliberately does not serve it) is
 * answered with a 415, and declining bytes we could never read back is the
 * intended outcome rather than a fault.
 */
export async function uploadDraftAttachment(file: File): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/attachments?mediaType=${encodeURIComponent(file.type)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    if (!res.ok) {
      tugDevLogStore.warn("attachments", "draft upload refused", {
        status: res.status,
        mediaType: file.type,
        name: file.name,
      });
      return null;
    }
    const body = (await res.json()) as { path?: unknown };
    if (typeof body.path !== "string" || body.path.length === 0) {
      tugDevLogStore.warn("attachments", "draft upload returned no path", body);
      return null;
    }
    return body.path;
  } catch (err) {
    tugDevLogStore.warn("attachments", "draft upload failed", {
      error: err instanceof Error ? err.message : String(err),
      name: file.name,
    });
    return null;
  }
}

/** Where a document-tier attachment landed. */
export interface DocAttachment {
  /** Absolute path on disk. */
  path: string;
  /** The document-relative form that goes into the markdown link — always
   *  `assets/<name>`, where the name may carry a `-2` collision suffix. */
  relativePath: string;
}

/**
 * Which document's assets a write belongs to: a saved one by path, or a
 * not-yet-saved one by draft id. Every document has one or the other from its
 * first keystroke, which is what removes the untitled precondition ([P02]).
 */
export type AssetBaseDescriptor = { doc: string } | { draft: string };

/**
 * Copy `file` into the document's `assets/` folder and report the name it ended
 * up with, or `null` when the write did not happen.
 *
 * The server picks the final name so the choice and the write are one step: a
 * second `photo.png` becomes `photo-2.png` with no window in which two callers
 * could agree on the same free name. Passing `name: null` hands the naming to
 * the server too — which is what a paste does, since pasted image data arrives
 * with no filename and the timestamped name is minted where the write happens.
 */
export async function uploadDocAttachment(
  base: AssetBaseDescriptor,
  file: File,
  name: string | null = file.name,
): Promise<DocAttachment | null> {
  const docPath = "doc" in base ? base.doc : base.draft;
  const where =
    "doc" in base
      ? `doc=${encodeURIComponent(base.doc)}`
      : `draft=${encodeURIComponent(base.draft)}`;
  const query =
    name === null ? where : `${where}&name=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(`/api/fs/attach?${query}`, {
      method: "POST",
      headers: {
        "Content-Type":
          file.type.length > 0 ? file.type : "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) {
      tugDevLogStore.warn("attachments", "asset write refused", {
        status: res.status,
        doc: docPath,
        name: file.name,
      });
      return null;
    }
    const body = (await res.json()) as { path?: unknown; relativePath?: unknown };
    if (typeof body.path !== "string" || typeof body.relativePath !== "string") {
      tugDevLogStore.warn("attachments", "asset write returned no path", body);
      return null;
    }
    return { path: body.path, relativePath: body.relativePath };
  } catch (err) {
    tugDevLogStore.warn("attachments", "asset write failed", {
      error: err instanceof Error ? err.message : String(err),
      name: file.name,
    });
    return null;
  }
}

/**
 * The absolute directory a draft document's relative links resolve against.
 *
 * The deck cannot compute it: the home lives under `data_dir()`, which is
 * per-instance and host-side. Created on demand by the route, so the answer is
 * always a directory that exists. `null` when the server could not answer, in
 * which case the caller has no base and declines the write rather than
 * inventing a location.
 */
export async function fetchAttachBase(draftId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/fs/attach-base?draft=${encodeURIComponent(draftId)}`,
    );
    if (!res.ok) {
      tugDevLogStore.warn("attachments", "attach-base refused", {
        status: res.status,
        draftId,
      });
      return null;
    }
    const body = (await res.json()) as { base?: unknown };
    if (typeof body.base !== "string" || body.base.length === 0) return null;
    return body.base;
  } catch (err) {
    tugDevLogStore.warn("attachments", "attach-base failed", {
      error: err instanceof Error ? err.message : String(err),
      draftId,
    });
    return null;
  }
}

/** One asset that had to change name to fit beside the saved document. */
export interface AssetRename {
  /** The relative destination the document currently holds. */
  from: string;
  /** What it must say instead. */
  to: string;
}

/**
 * Rewrite `text`'s asset links to match the names the migration actually used.
 *
 * Only the destination half of a link moves. The label is the name the user
 * gave the file and stays put — a document that suddenly says `photo-2` about
 * a picture the user knows as `photo` is this feature's collision bookkeeping
 * leaking into their prose.
 *
 * Both spellings of a destination are rewritten, because either may be in the
 * document: the bare form and the angle-bracketed one ([P08]).
 */
export function applyAssetRenames(
  text: string,
  renames: readonly AssetRename[],
): string {
  let out = text;
  for (const { from, to } of renames) {
    out = out.split(`(${from})`).join(`(${to})`);
    out = out.split(`(<${from}>)`).join(`(<${to}>)`);
  }
  return out;
}

/**
 * Move a draft document's assets into the directory it was just saved into.
 *
 * The renames are what the buffer must be rewritten with, and are empty in the
 * overwhelmingly common case — the relative link is stable across the move by
 * construction, which is what makes the untitled story seamless rather than a
 * rewrite-everything migration. `null` means the migration failed outright and
 * the draft home still holds the bytes.
 */
export async function migrateDraftAssets(
  draftId: string,
  docPath: string,
): Promise<AssetRename[] | null> {
  const query =
    `draft=${encodeURIComponent(draftId)}&doc=${encodeURIComponent(docPath)}`;
  try {
    const res = await fetch(`/api/fs/attach/migrate?${query}`, { method: "POST" });
    const body = (await res.json()) as { renames?: unknown };
    const renames = Array.isArray(body.renames)
      ? body.renames.filter(
          (r): r is AssetRename =>
            typeof r === "object" &&
            r !== null &&
            typeof (r as AssetRename).from === "string" &&
            typeof (r as AssetRename).to === "string",
        )
      : [];
    if (!res.ok) {
      tugDevLogStore.warn("attachments", "asset migration failed", {
        status: res.status,
        draftId,
        doc: docPath,
        // Anything already moved still has to be applied to the document, so
        // a partial failure is reported with its renames rather than dropped.
        moved: renames.length,
      });
      return renames.length > 0 ? renames : null;
    }
    return renames;
  } catch (err) {
    tugDevLogStore.warn("attachments", "asset migration failed", {
      error: err instanceof Error ? err.message : String(err),
      draftId,
    });
    return null;
  }
}

/** Paths currently being read, so a re-render never starts a second read. */
const rehydrating = new Set<string>();

/**
 * Read the stored original behind every entry that has a path but no bytes,
 * and put the entry back whole — downsampled content, media type, and a
 * freshly baked thumbnail.
 *
 * Fire-and-forget: the caller does not await. A chip whose bytes have not
 * landed yet paints a reserved slot, and `buildWirePayload` already treats an
 * empty `content` as preview-only, so an in-flight rehydration submits as a
 * mention marker exactly as a recalled thumbnail always has.
 *
 * The downsample runs here rather than at storage time on purpose: what is on
 * disk is the verbatim original, and the 2576 px / 5 MB caps are an
 * API-payload concern that applies when bytes are about to be shown to a
 * model. A restored draft therefore submits at identical quality to one that
 * never left memory.
 *
 * A read that fails leaves the entry as it was — pathless bytes, pruned from
 * the wire — which is the pre-existing degradation and not a new failure mode.
 */
export function rehydrateDraftAttachments(
  entries: Record<string, { content?: string; mediaType?: string; path?: string }>,
  store: AtomBytesStore,
): void {
  for (const [id, entry] of Object.entries(entries)) {
    const path = entry.path;
    if (typeof path !== "string" || path.length === 0) continue;
    if (typeof entry.content === "string" && entry.content.length > 0) continue;
    if (rehydrating.has(path)) continue;
    rehydrating.add(path);
    void (async () => {
      try {
        const res = await fetch(`/api/fs/blob?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
          tugDevLogStore.warn("attachments", "rehydrate read failed", {
            status: res.status,
            path,
          });
          return;
        }
        const blob = await res.blob();
        const outcome = await downsampleImage(blob);
        if (!outcome.ok) {
          tugDevLogStore.warn("attachments", "rehydrate downsample failed", {
            path,
            error: outcome.error,
          });
          return;
        }
        // Re-read rather than reconstruct: the user may have removed the chip
        // while the read was in flight, and putting an entry back would
        // resurrect a store row for an atom that no longer exists.
        if (store.get(id) === null) return;
        const next: AtomBytesEntry = {
          content: outcome.result.content,
          mediaType: outcome.result.mediaType,
          thumbnailDataUrl: outcome.result.thumbnailDataUrl,
          path,
        };
        store.put(id, next);
      } catch (err) {
        // A file moved or deleted out from under the draft. The chip keeps
        // today's behavior and the next restore tries again.
        tugDevLogStore.warn("attachments", "rehydrate failed", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        rehydrating.delete(path);
      }
    })();
  }
}
