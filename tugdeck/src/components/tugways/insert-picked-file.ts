/**
 * insert-picked-file.ts — what the paths picked by Session ▸ Insert File…
 * become in the prompt.
 *
 * The host's open panel hands over paths, never `File`s — as many as the
 * user selected, inserted in the panel's order. What each becomes follows
 * the file, the same way a drop does:
 *
 *  - **An image** lands exactly as dropping it would — an `image-N`
 *    attachment through {@link processAttachmentFiles}, downsample, upload
 *    and all. The pipeline wants a `File`, so the bytes are read back through
 *    tugcast and typed from the extension, because the downsampler classifies
 *    by `Blob.type` and `/api/fs/bytes` serves everything as an opaque
 *    download. A read that fails degrades to the file atom below rather than
 *    vanishing.
 *  - **Anything else** is a `file` atom, read exactly like accepting an `@`
 *    mention — the atom plus a separating space, one transaction, with smart
 *    insert's leading pad when the caret is welded to a word — except the
 *    label is the basename while the value stays the absolute path the panel
 *    returned, so the chip is legible and the submitted prompt is
 *    unambiguous.
 *
 * Either way the insertion is additive: an in-progress draft survives it.
 *
 * @module components/tugways/insert-picked-file
 */

import type { EditorView } from "@codemirror/view";

import type { AtomBytesStore } from "@/lib/atom-bytes-store";
import { bytesUrl } from "@/lib/file-kinds";
import { pickPaths } from "@/lib/native-path-picker";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import type { AtomSegment } from "@/lib/tug-text-types";
import { addAtomsEffect } from "./tug-text-editor/atom-decoration";
import {
  imageMimeForPath,
  processAttachmentFiles,
} from "./tug-text-editor/drop-extension";
import { padForInsert } from "./tug-text-editor/smart-insert";

/**
 * The paths an `INSERT_FILE` action carries, or the host's file panel when it
 * carries none; `insert` runs with whichever paths arrive, and not at all on
 * a cancel.
 *
 * The action comes two ways. The Session menu item runs its own panel and
 * dispatches the paths it chose. The ⇧⌘I chord does not reach that item: the
 * web view sees a key equivalent before AppKit's menu scan does, and the
 * deck's key funnel matches the chord and dispatches the command itself,
 * with no paths. That dispatch has to ask for them rather than return — left
 * to return, the keystroke was consumed and nothing happened.
 */
export function withInsertFilePath(
  value: unknown,
  insert: (paths: string[]) => void,
): void {
  const carried = value as { path?: unknown; paths?: unknown } | undefined;
  const paths = Array.isArray(carried?.paths)
    ? carried.paths.filter(
        (p): p is string => typeof p === "string" && p !== "",
      )
    : typeof carried?.path === "string" && carried.path !== ""
      ? [carried.path]
      : [];
  if (paths.length > 0) {
    insert(paths);
    return;
  }
  void pickPaths("insert").then((picked) => {
    const chosen = picked.filter((p) => p !== "");
    if (chosen.length > 0) insert(chosen);
  });
}

/**
 * Insert each file in `paths` at `view`'s caret, in order. Returns at once;
 * the insertions land one after another, each image when its bytes have
 * been read and decoded, so a later file never lands ahead of an earlier
 * image still decoding.
 */
export function insertPickedFiles(
  view: EditorView,
  paths: readonly string[],
  bytesStore: AtomBytesStore,
  onError: (message: string) => void,
): void {
  void (async () => {
    for (const path of paths) {
      if (!view.dom.isConnected) return;
      await insertPickedFile(view, path, bytesStore, onError);
    }
  })();
}

/** Insert the file at `path` at `view`'s caret; settles once it has landed. */
async function insertPickedFile(
  view: EditorView,
  path: string,
  bytesStore: AtomBytesStore,
  onError: (message: string) => void,
): Promise<void> {
  const basename = path.split("/").pop();
  const name = basename === undefined || basename === "" ? path : basename;
  const imageMime = imageMimeForPath(path);
  if (imageMime === null) {
    insertFileAtom(view, path, name);
    return;
  }
  let file: File | null = null;
  try {
    const res = await fetch(bytesUrl(path));
    if (res.ok) {
      file = new File([await res.blob()], name, { type: imageMime });
    }
  } catch {
    // Falls through to the file atom below.
  }
  if (!view.dom.isConnected) return;
  if (file === null) {
    insertFileAtom(view, path, name);
    return;
  }
  await processAttachmentFiles(
    view,
    [file],
    view.state.selection.main.head,
    bytesStore,
    onError,
  );
}

/** A `file` atom naming `path`, plus a separating space, at the caret. */
function insertFileAtom(view: EditorView, path: string, label: string): void {
  const segment: AtomSegment = {
    kind: "atom",
    type: "file",
    label,
    value: path,
  };
  const { from, to } = view.state.selection.main;
  // Smart insert's leading half ([B02]). This door hand-rolls its own
  // dispatch, so it welded to whatever preceded the caret exactly as the
  // drop doors did — ⌘I inside `foobar` wrote `foo<chip> bar`. The trailing
  // half stays this door's own: accepting a path from the panel is a typing
  // flow, and the separating space is where the next word goes, which is
  // the explicit exception [B05] licenses a caller to make.
  const { before } = padForInsert(view.state, from, to, TUG_ATOM_CHAR);
  const lead = before ? " " : "";
  const hasTrailingSpace = view.state.doc.sliceString(to, to + 1) === " ";
  view.dispatch({
    changes: {
      from,
      to,
      insert: `${lead}${TUG_ATOM_CHAR}${hasTrailingSpace ? "" : " "}`,
    },
    effects: addAtomsEffect.of([
      { position: from + lead.length, segment },
    ]),
    selection: { anchor: from + lead.length + 2 },
    scrollIntoView: true,
    userEvent: "input.tug-atom",
  });
}
