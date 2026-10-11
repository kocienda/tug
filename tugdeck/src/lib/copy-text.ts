/**
 * copy-text — write text to the clipboard with the project it came from.
 *
 * The plain `navigator.clipboard.writeText(text)` scattered across the copy
 * affordances is correct about the text and silent about everything else. For
 * a short identifier — a commit hash, a session id, a timestamp — silent is
 * right: there is no relative path in a sha, and nothing a root would help
 * resolve later. For PROSE it is a small loss every time. A copied paragraph
 * cites `tugdeck/src/x.css:12`, and the root that makes that a file rather
 * than a string is knowable at the moment of the copy and unknowable after.
 *
 * So the surfaces that copy prose call this instead, handing it a node — the
 * button, the block, the view — and {@link clipboardOriginFor} walks up to
 * whichever surface stamped its project. Nothing above the node stamps one and
 * this degrades exactly into the `writeText` it replaced.
 *
 * The provenance can only ride the native bridge: WebKit's pasteboard
 * normalization swallows custom MIME types, which is why the bridge exists at
 * all (see `tug-native-clipboard.ts`). Outside Tug.app there is no bridge and
 * no sidecar — browser-mode development copies text and nothing else.
 *
 * @module lib/copy-text
 */

import { clipboardOriginFor } from "./clipboard-origin";
import {
  hasNativeClipboardBridge,
  writeClipboardViaNative,
} from "./tug-native-clipboard";
import { withClipboardOrigins } from "@/lib/clipboard-origin";

/**
 * Copy `text` to the clipboard, stamped with the project root in scope at
 * `node`. `html`, when given, rides along as the rich-text flavor.
 *
 * Resolves `true` once the text is on the clipboard. A caller that flashes a
 * "copied" affordance waits for that rather than flashing on the call, so a
 * failed write never shows a false positive — the native write settles
 * synchronously, so the common path resolves in the same turn.
 */
export function copyTextFrom(
  node: Node | null | undefined,
  text: string,
  html?: string,
): Promise<boolean> {
  return writeWithOrigins(text, clipboardOriginFor(node), html);
}

/**
 * Copy `text` stamped with roots the caller already knows, rather than with
 * one read off the DOM. For a surface whose provenance is data it holds — a
 * jot, which carries the roots of every passage pasted into it — and which
 * therefore has more than one root to pass on.
 */
export function copyTextWithOrigins(
  text: string,
  origins: readonly string[],
): Promise<boolean> {
  return writeWithOrigins(text, origins);
}

function writeWithOrigins(
  text: string,
  origins: readonly string[] | string | null,
  html?: string,
): Promise<boolean> {
  if (hasNativeClipboardBridge()) {
    const sidecar = withClipboardOrigins(null, text, origins);
    const wrote =
      sidecar === null
        ? // Nothing to carry: still prefer the bridge, which is the
          // popup-free write inside Tug.app.
          writeClipboardViaNative(text, "", html)
        : writeClipboardViaNative(text, JSON.stringify(sidecar), html);
    if (wrote) return Promise.resolve(true);
  }
  const writeText = navigator.clipboard?.writeText;
  if (writeText === undefined) return Promise.resolve(false);
  return writeText
    .call(navigator.clipboard, text)
    .then(() => true)
    .catch(() => false);
}
