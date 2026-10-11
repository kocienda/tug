/**
 * asset-projection — the Text card's attachment strip, derived from the
 * document's own text.
 *
 * ## The strip is a projection, not a list
 *
 * There is no stored record anywhere of what a document has attached. The
 * document is the source of truth for what it references, and the first thing a
 * user does with a text editor is edit the text — a parallel store could only
 * ever disagree with it. So the strip is a pure function of the buffer plus
 * disk: parse the `assets/`-scoped links, resolve them against the document's
 * asset base, and publish a tile per link.
 *
 * That one decision buys three behaviors with no extra machinery. Typing a link
 * by hand lights a tile; deleting it removes the tile; undo restores both.
 * Pasted markdown that resolves simply appears in the strip, so no hidden "this
 * was an attachment" state has to survive the clipboard. And nothing about
 * attachments enters the card's persisted bag ([L23] — it stays positions-only).
 *
 * ## Cost
 *
 * The parse is fed from the editor's update listener and runs on an idle
 * timer, never synchronously with an edit transaction. Output is compared
 * structurally, so a keystroke in prose costs one regex pass and publishes
 * nothing — no store write, no React render.
 *
 * The projection performs **no byte I/O at all**. Tiles carry the resolved
 * path, and `TugAttachmentPreview` paints them through `/api/fs/blob`, which
 * streams and revalidates by `ETag`. Filling a bytes store with base64 would
 * park a whole document's assets in memory to draw thumbnails.
 *
 * Laws:
 *  - [L02] this is external state; React reads it through `useSyncExternalStore`.
 *  - [L23] nothing here is persisted.
 *
 * @module lib/asset-projection
 */

import {
  parseAssetLinks,
  resolveAssetPath,
  type AssetLinkRef,
} from "./asset-links";
import { bytesUrl, classifyFileKind } from "./file-kinds";
import { createAtomBytesStore, type AtomBytesStore } from "./atom-bytes-store";
import type { AtomSegment } from "./tug-atom-img";
import { Subscribable } from "./subscribable";

/** What the strip knows about one attached file. */
export interface AssetTile {
  /** Stable key, derived from the resolved path so it survives a re-parse. */
  id: string;
  /** The file's own name, decoded — what the user reads on the caption. */
  name: string;
  /** Absolute path on disk, resolved against the document's asset base. */
  path: string;
  /** The link's range in the document, for the ✕ gesture and reveal. */
  from: number;
  to: number;
  /**
   * `"image"` paints pixels, `"file"` a glyph, `"failed"` a glyph in the
   * caution tone. A failed tile is the one kind with no link behind it — the
   * attach never got far enough to insert one, which is exactly why it needs
   * to be visible somewhere.
   */
  kind: "image" | "file" | "failed";
  /** The resolved path does not name an existing file. */
  missing: boolean;
  /** An attach or migration failed for this name; carries a retry. */
  failed: boolean;
}

/** How long the buffer must sit still before the strip re-derives. */
const PARSE_IDLE_MS = 150;

/** The tile id for a resolved path — stable across every re-parse. */
function tileId(path: string): string {
  return `asset:${path}`;
}

/** Structural equality, so an unchanged link set publishes nothing. */
function sameTiles(a: readonly AssetTile[], b: readonly AssetTile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as AssetTile;
    const y = b[i] as AssetTile;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.path !== y.path ||
      x.from !== y.from ||
      x.to !== y.to ||
      x.kind !== y.kind ||
      x.missing !== y.missing ||
      x.failed !== y.failed
    ) {
      return false;
    }
  }
  return true;
}

/** The file's own name from a resolved path. */
function nameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * The Text card's derived attachment strip.
 *
 * One instance per card. The card feeds it the asset base and the buffer text;
 * it publishes tiles and owns the `AtomBytesStore` the preview component reads.
 */
export class AssetProjection extends Subscribable {
  private base: string | null = null;
  private readText: () => string = () => "";
  private tiles: readonly AssetTile[] = [];
  private atoms: readonly AtomSegment[] = [];
  private failures = new Map<
    string,
    { message: string; retry?: () => void }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Paths a `stat` has confirmed absent, so a missing tile stays missing. */
  private missing = new Set<string>();
  /** Paths with a check in flight, so a re-parse never starts a second one. */
  private checking = new Set<string>();

  readonly bytesStore: AtomBytesStore = createAtomBytesStore();

  /** The current tile set. Reference-stable while the link set is unchanged. */
  getSnapshot = (): readonly AssetTile[] => this.tiles;

  /**
   * The atoms `TugAttachmentPreview` renders — one synthetic segment per tile.
   * Reference-stable alongside {@link getSnapshot}, which the component's own
   * snapshot cache depends on.
   */
  getAtoms = (): readonly AtomSegment[] => this.atoms;

  /** Point the projection at a document. Re-derives immediately. */
  setBase(base: string | null): void {
    if (this.base === base) return;
    this.base = base;
    // A new document's files are a different set; nothing learned about the
    // old one's existence carries over.
    this.missing.clear();
    this.derive();
  }

  /**
   * Where the buffer's text comes from, read at derive time.
   *
   * A getter rather than a string because the editor's only caller is its
   * update listener: handing over `doc.toString()` there would materialize the
   * whole rope on every keystroke, which is precisely the kind of writer the
   * typing-lag campaign has been removing. The string is built once per idle
   * window instead, in the parse that was going to read it anyway.
   */
  setTextSource(read: () => string): void {
    this.readText = read;
    this.derive();
  }

  /**
   * Note that the buffer changed. Called from the editor's update listener, so
   * it does nothing but reset the idle timer — no string, no parse, no compare.
   */
  noteChanged(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.derive();
    }, PARSE_IDLE_MS);
  }

  /**
   * Record that an attach failed for `name`, so its tile says so ([P06]).
   *
   * `retry` re-runs the upload. It is the caller's closure because only the
   * caller still holds the bytes — a `File` from a drop or a paste — and
   * parking those in the projection would be holding a document's worth of
   * failed uploads alive for the life of the card.
   */
  noteFailure(name: string, message: string, retry?: () => void): void {
    this.failures.set(name, { message, retry });
    this.derive();
  }

  /** Clear a recorded failure — the retry succeeded, or the user moved on. */
  clearFailure(name: string): void {
    if (this.failures.delete(name)) this.derive();
  }

  /** The message behind a failed tile, if any. */
  failureFor(name: string): string | undefined {
    return this.failures.get(name)?.message;
  }

  /** Re-run the upload behind a failed tile, and clear the failure. */
  retryFailure(name: string): void {
    const failure = this.failures.get(name);
    if (failure === undefined) return;
    this.clearFailure(name);
    failure.retry?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.clearListeners();
    this.bytesStore.clear();
  }

  /**
   * Re-derive from the current text and base, publishing only on a real
   * change. Exposed for the tests and for the card's immediate re-derive after
   * an edit it made itself.
   */
  derive(): void {
    if (this.disposed) return;
    const next = this.project();
    if (sameTiles(this.tiles, next)) return;
    this.tiles = next;
    this.atoms = next.map((tile) => ({
      kind: "atom" as const,
      type: tile.kind,
      label: tile.name,
      value: tile.name,
      id: tile.id,
    }));
    // Path-only entries: the tile paints from `/api/fs/blob`, so `content` is
    // deliberately empty. That is an established shape — a restored draft
    // attachment carries exactly the same one until its bytes are read back.
    for (const tile of next) {
      // A failed tile stands for a file that never landed — there is no path
      // to carry.
      if (tile.kind === "failed") continue;
      // A missing image still gets an entry — an empty marker, carrying
      // nothing paintable. That is what makes the component read it as
      // *broken* rather than as an image whose pixels have not arrived: with
      // no entry at all it would paint the transparent reserved slot forever,
      // and a link to a file that is not there would be invisible.
      //
      // A *non-image* tile gets one for its path alone. It has no pixels to
      // paint from the path, but the path is how the tile asks macOS to draw
      // the file — a page of the text, the first page of the PDF. Without an
      // entry the tile knows only the file's name.
      this.bytesStore.put(tile.id, {
        content: "",
        mediaType: "",
        ...(tile.missing ? {} : { path: tile.path }),
      });
    }
    this.notify();
  }

  private project(): AssetTile[] {
    const base = this.base;
    if (base === null) return [];
    const out: AssetTile[] = [];
    const seen = new Set<string>();
    for (const ref of parseAssetLinks(this.readText())) {
      const path = resolveAssetPath(base, ref.destination);
      if (path === null) continue;
      const id = tileId(path);
      // One tile per file, even when the document links it twice — the strip
      // says what the document has attached, not how often it mentions it.
      if (seen.has(id)) continue;
      seen.add(id);
      const name = nameOf(path);
      out.push({
        id,
        name,
        path,
        from: ref.from,
        to: ref.to,
        kind: classifyFileKind(path) === "image" ? "image" : "file",
        missing: this.missing.has(path),
        failed: this.failures.has(name),
      });
      this.checkExists(path);
    }
    // A failure has no link behind it — the attach never got far enough to
    // insert one — so it would be invisible if the projection only ever spoke
    // for links. This is where "the failure renders on the thing that failed"
    // becomes true rather than aspirational ([P06]).
    for (const name of this.failures.keys()) {
      if (out.some((tile) => tile.name === name)) continue;
      out.push({
        id: `failed:${name}`,
        name,
        path: "",
        from: -1,
        to: -1,
        kind: "failed",
        missing: false,
        failed: true,
      });
    }
    return out;
  }

  /**
   * Confirm a resolved path names a real file, once per path.
   *
   * A link to a file that is not there renders a *missing* tile rather than
   * nothing, so a typo is visible instead of silent.
   *
   * The check is a `HEAD` on the **bytes** route, which answers for every type.
   * Asking the blob route meant asking a question it could only answer about
   * the handful of types a viewer card renders: it refused everything else, and
   * every `.txt` and `.zip` a document linked came back as missing.
   */
  private checkExists(path: string): void {
    if (this.checking.has(path) || this.missing.has(path)) return;
    this.checking.add(path);
    void (async () => {
      let absent = false;
      try {
        const res = await fetch(bytesUrl(path), { method: "HEAD" });
        absent = res.status === 404;
      } catch {
        // A transport failure says nothing about the file; leave it alone
        // rather than marking a present file missing.
        absent = false;
      } finally {
        this.checking.delete(path);
      }
      if (this.disposed || !absent) return;
      this.missing.add(path);
      this.derive();
    })();
  }

  override notify(): void {
    this.notifyCatching((err) => {
      console.error("[asset-projection] subscriber threw:", err);
    });
  }
}

/** Re-exported so a test can build a ref without importing the parser too. */
export type { AssetLinkRef };
