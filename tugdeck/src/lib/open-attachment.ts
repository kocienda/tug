/**
 * open-attachment — what ⌘-clicking a document's relative link does.
 *
 * A link in a document names a file. The gesture should always do something
 * with that file, and what it does depends on what the file *is*:
 *
 *  - An image or a PDF opens in a viewer card.
 *  - Anything textual — the `.md` next door, a `.txt` in `assets/`, a `.csv`,
 *    a source file — opens in a Text card.
 *  - Anything else is revealed in the Finder, where the user can hand it to
 *    the app that owns it. A `.zip` or a `.sketch` has no in-app answer, and
 *    opening one in a Text card would paint its bytes as mojibake.
 *  - A file that is not there is revealed too, which lands the user in the
 *    directory it should have been in.
 *
 * The gate used to be `isViewableFile`, so only the first case did anything at
 * all and every other link was inert — a `.md` attachment sat there dead
 * beside a `.png` that opened. Widening the gate needed an answer for the
 * `.zip`, and "reveal it" is that answer.
 *
 * ## Why the kind is decided at click time
 *
 * There is no reliable answer from the name alone: `classifyFileKind` returns
 * `"text"` as its *default*, so a `.zip` and a `.md` are indistinguishable to
 * it. The real answer is in the bytes, so this reads the file's first block and
 * looks. That is an async question, which is exactly why it is asked on the
 * click rather than on the hover: the link lights up for every file, and the
 * decision happens where waiting is free.
 *
 * @module lib/open-attachment
 */

import type { IDeckManagerStore } from "@/deck-manager-store";
import { bytesUrl, isViewableFile } from "./file-kinds";
import { openFileInCard } from "./open-file-in-card";
import { revealPathInFinder } from "./os-open";

/**
 * How much of a file is read to decide whether it is text. The same size git
 * uses for the same question — enough that a text file's first block is
 * representative, small enough that probing a gigabyte archive costs nothing.
 */
const PROBE_BYTES = 8000;

/**
 * True when `bytes` look like text rather than a binary blob.
 *
 * Two signals, both cheap and both boundary-safe — deliberately *not* a UTF-8
 * validation, which would report a false negative every time the probe's cut
 * landed in the middle of a multi-byte character:
 *
 *  - A NUL byte. This alone settles almost every real case; it is what git
 *    uses, and no text encoding this app will meet puts one in a document.
 *  - A high proportion of other C0 control bytes. This catches the binary
 *    formats that happen to have no NUL early on.
 *
 * An empty file is text: an empty `.txt` should open in an editor, not bounce
 * the user to the Finder.
 */
export function looksTextual(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    // C0 except the three that are ordinary in text: tab, newline, carriage
    // return. Form feed and escape are counted — they appear in text, but
    // rarely enough that a document full of them is not one.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      controls += 1;
    }
  }
  return controls / bytes.length < 0.1;
}

/**
 * Read `path`'s first block, or `null` when it cannot be read at all — which
 * for this caller means "there is nothing to open here".
 *
 * Through the bytes route, which serves every type: asking the blob route
 * would refuse the very files this exists to classify.
 */
async function firstBlock(path: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(bytesUrl(path), {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    });
    // An empty file cannot satisfy any range, and a `416` here means the file
    // is present with nothing in it — not that it is unreadable.
    if (res.status === 416) return new Uint8Array();
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Open `path` the way its own contents deserve. See the module docstring.
 *
 * Never throws and never does nothing: every path ends in a card or in the
 * Finder.
 */
export async function openAttachmentPath(
  store: IDeckManagerStore,
  path: string,
  originCardId: string | null = null,
): Promise<void> {
  // A viewable kind is settled by its extension — the viewer card is built
  // around exactly that table — so it needs no probe and no round trip.
  if (isViewableFile(path)) {
    openFileInCard(store, path, undefined, undefined, undefined, originCardId);
    return;
  }
  const head = await firstBlock(path);
  if (head !== null && looksTextual(head)) {
    openFileInCard(store, path, undefined, undefined, undefined, originCardId);
    return;
  }
  revealPathInFinder(path);
}
