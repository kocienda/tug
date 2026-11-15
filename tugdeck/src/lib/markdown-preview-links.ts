/**
 * markdown-preview-links — what a link or an image in a rendered Markdown
 * document on disk points at.
 *
 * The Text card's preview renders a file's Markdown into the card's own page,
 * so a relative destination in it means nothing to the browser: `notes.md`
 * would navigate the page, and `assets/shot.png` would be fetched from the
 * page's origin. Both name a file beside the document, and this module says
 * which one.
 *
 * Paths resolve through {@link resolveRelativePath}, the resolver the editor's
 * own ⌘-click uses, so a link in the preview reaches exactly the files the
 * same link reaches in the source: plain relative paths inside the document's
 * directory, and nothing absolute, dotted or escaping it.
 *
 * Pure: no DOM, no fetch. The card applies the answers.
 *
 * @module lib/markdown-preview-links
 */

import { decodeLinkDestination, resolveRelativePath } from "./asset-links";
import { blobUrl, bytesUrl, classifyFileKind } from "./file-kinds";

/** What a rendered link's `href` asks for. */
export type PreviewHref =
  /** A URL with a scheme, or a protocol-relative one. Not this module's. */
  | { kind: "external" }
  /** A place in the same document. `anchor` is decoded, without the `#`. */
  | { kind: "anchor"; anchor: string }
  /**
   * A file. `path` is absolute, or null when the destination is not a plain
   * relative path inside the document's directory; such a link opens nothing,
   * and must still not navigate the page.
   */
  | { kind: "path"; path: string | null };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The path half of a relative destination, decoded, or null for none. */
function relativeDestination(raw: string): string | null {
  const cut = raw.search(/[?#]/);
  const bare = cut === -1 ? raw : raw.slice(0, cut);
  if (bare === "") return null;
  return decodeLinkDestination(bare);
}

/**
 * Read a rendered link's `href` against `base`, the directory the document's
 * relative paths resolve in (null for a document with none yet).
 */
export function readPreviewHref(base: string | null, href: string): PreviewHref {
  const raw = href.trim();
  if (SCHEME.test(raw) || raw.startsWith("//")) return { kind: "external" };
  if (raw.startsWith("#")) {
    return { kind: "anchor", anchor: decodeLinkDestination(raw.slice(1)) };
  }
  const destination = relativeDestination(raw);
  return {
    kind: "path",
    path: destination === null ? null : resolveRelativePath(base, destination),
  };
}

/**
 * The URL a rendered image's `src` should load from, or null to leave it as
 * written: an absolute URL already loads, and a destination that does not
 * resolve has nothing better to offer than the broken image it already is.
 *
 * An image type goes through the blob route, which types its response; any
 * other file through the bytes route, which serves every type.
 */
export function previewImageUrl(base: string | null, src: string): string | null {
  const read = readPreviewHref(base, src);
  if (read.kind !== "path" || read.path === null) return null;
  return classifyFileKind(read.path) === "image" ? blobUrl(read.path) : bytesUrl(read.path);
}
