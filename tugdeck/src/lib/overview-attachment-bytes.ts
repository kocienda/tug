/**
 * `overview-attachment-bytes` — the bytes behind the pictures in the Overview's
 * transcript, read back from where tugcast rested them.
 *
 * ## Why a store at all
 *
 * The Overview's post attachments are files: a question's images went up once,
 * tugcast wrote them beside the ledger, and the post says only where they are
 * ({@link OverviewAttachmentWire}). The strip that draws them is the app's own
 * {@link TugAttachmentPreview} — the same tiles, the same captions, the same
 * click-to-enlarge sheet the Session card's transcript shows — and that
 * component's substrate is an {@link AtomBytesStore} keyed by atom id. So the
 * job here is one adapter: a path becomes an atom id, and the bytes at that
 * path become the entry under it.
 *
 * One store for the whole channel, not one per post. Two posts that cite the
 * same file share the fetch, a re-render never re-reads, and paging older
 * history back in finds what it already has.
 *
 * ## Lazily, exactly once
 *
 * {@link hydrateOverviewAttachments} is called from the row that renders the
 * strip, which means the read happens for a post somebody is looking at rather
 * than for the whole ledger tail. Each path is fetched at most once: the
 * in-flight set is the interlock, so the twenty renders a settling column
 * produces cost one request.
 *
 * A read that fails leaves the id absent, which the strip already has a
 * meaning for — a reserved slot rather than a broken box — and the next mount
 * tries again. Nothing retries in a loop.
 *
 * Laws: [L02] the store IS external state and the strip subscribes to it
 * through `useSyncExternalStore`; the fetch is a side effect the row asks for,
 * never a render.
 *
 * @module lib/overview-attachment-bytes
 */

import { createAtomBytesStore, type AtomBytesStore } from "@/lib/atom-bytes-store";
import { toBase64 } from "@/lib/attachment-upload";
import type { OverviewAttachmentWire } from "@/protocol";

/**
 * The channel's bytes, app-scoped. Lazy so a deck that never opens the
 * Overview allocates nothing.
 */
let _store: AtomBytesStore | null = null;

/** The one store every Overview attachment strip reads from. */
export function overviewAttachmentBytesStore(): AtomBytesStore {
  _store ??= createAtomBytesStore();
  return _store;
}

/** Paths currently being read, so a re-render never starts a second read. */
const inFlight = new Set<string>();

/**
 * Make sure every attachment in `attachments` has its bytes in the store,
 * reading the ones that do not through `/api/fs/blob` — the same loopback
 * route the file and PDF viewer cards stream a path with.
 *
 * Fire-and-forget: the caller does not await, because the strip is already
 * subscribed and a tile that has no pixels yet paints a reserved slot. When
 * the read lands, `put` notifies and the tile paints.
 */
export function hydrateOverviewAttachments(
  attachments: readonly OverviewAttachmentWire[],
): void {
  const store = overviewAttachmentBytesStore();
  for (const attachment of attachments) {
    const id = attachment.path;
    if (store.get(id) !== null || inFlight.has(id)) continue;
    inFlight.add(id);
    void (async () => {
      try {
        const res = await fetch(
          `/api/fs/blob?path=${encodeURIComponent(attachment.path)}`,
        );
        if (!res.ok) return;
        const buffer = await res.arrayBuffer();
        store.put(id, {
          content: toBase64(new Uint8Array(buffer)),
          // The post's own record of what the bytes are, rather than the
          // response's: tugcast serves by sniffing, and the media type the
          // deck decoded the image as is what the tile should paint it as.
          mediaType: attachment.media_type,
        });
      } catch {
        // A file that has been moved or deleted out from under the ledger.
        // The tile stays a reserved slot and the next mount tries again.
      } finally {
        inFlight.delete(id);
      }
    })();
  }
}
