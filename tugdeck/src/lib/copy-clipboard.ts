/**
 * copy-clipboard — the one dual-flavor clipboard write every copy path uses.
 *
 * A Tug copy can carry up to four things: the markdown a plain-paste target
 * gets, the HTML a rich one gets, the atom sidecar that makes a paste back
 * into Tug produce chips rather than the words they were flattened into, and
 * the project root the text was read against. Assembling those is one body of
 * code, and it lives here rather than beside any one of its callers, because
 * the callers are in different layers: a transcript cell's selection copy, an
 * annotation menu's Copy-the-whole-value, and whatever comes next.
 *
 * @module lib/copy-clipboard
 */

import {
  withClipboardOrigins,
  type TugAtomsClipboardPayload,
} from "@/components/tugways/tug-text-editor/clipboard-filters";
import {
  hasNativeClipboardBridge,
  writeClipboardViaNative,
} from "./tug-native-clipboard";

/**
 * Write a copied selection to the clipboard in both flavors ([P05]):
 * `text/plain` (markdown for plain paste targets) and, when an HTML
 * rendering is available, `text/html` (rich paste targets). Built and
 * issued synchronously inside the copy gesture so transient activation
 * still holds. Degrades to `writeText` when `ClipboardItem` / async
 * `clipboard.write` is unavailable or the dual-format write rejects, so
 * copy never silently produces nothing ([P07]).
 */
export function writeCopyClipboard(
  plain: string,
  html: string | null,
  origin: string | null,
  atoms: TugAtomsClipboardPayload | null,
): void {
  // Inside Tug.app the native bridge is the only write that can carry the
  // sidecar — WebKit's pasteboard normalization swallows custom types, which
  // is the whole reason the bridge exists — so a copy with atoms or provenance
  // goes that way, carrying its html flavor along rather than losing it.
  if (hasNativeClipboardBridge()) {
    const sidecar = withClipboardOrigins(atoms, plain, origin);
    if (
      sidecar !== null &&
      writeClipboardViaNative(plain, JSON.stringify(sidecar), html ?? undefined)
    ) {
      return;
    }
  }
  const clip = navigator.clipboard;
  if (clip === undefined || clip === null) return;
  if (
    html !== null &&
    typeof ClipboardItem !== "undefined" &&
    typeof clip.write === "function"
  ) {
    try {
      const item = new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      });
      void clip.write([item]).catch(() => {
        void clip.writeText?.(plain);
      });
      return;
    } catch {
      // ClipboardItem construction or write threw synchronously —
      // fall through to the plain-text path below.
    }
  }
  void clip.writeText?.(plain);
}

/**
 * Escape the five HTML metacharacters so a command string can be embedded
 * in the `text/html` clipboard flavor as `<code>…</code>` without a stray
 * `<` or `&` in the command corrupting the markup.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
