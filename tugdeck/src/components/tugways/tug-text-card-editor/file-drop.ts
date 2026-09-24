/**
 * file-drop — drop a file on a Text card and get a markdown link to it.
 *
 * The bytes are copied into an `assets/` folder beside the document being
 * edited and a standard CommonMark link is inserted at the drop caret:
 * `![stem](assets/photo.png)` for an image, `[name](assets/notes.zip)` for
 * anything else. Nothing about the result is Tug-specific — GitHub, pandoc,
 * Obsidian, and `cat` all agree on what the document means afterwards, which
 * is exactly what a database-backed link or an app-scheme URL would cost.
 *
 * The link's visible half is always the name the user dropped. Where the file
 * had to land under a different one — a collision suffix — that stays in the
 * destination, which is the half that has to name a real file. How this
 * feature keeps two files with one name apart is its own business, and a
 * document that suddenly says `photo-2` about a picture the user knows as
 * `photo` is that bookkeeping leaking into their prose.
 *
 * The insertion is an ordinary edit. Dirty state, autosave, aside
 * crash-safety, and undo all apply unchanged; one undo removes the links.
 * The asset files stay — the same as any other file the user put in their own
 * directory, visible in `git status` and theirs to delete.
 *
 * ## What this deliberately does not do
 *
 * No widget, no inline rendering, no preview. The Text card is a raw-source
 * editor and the link stays visible as source, styled by the editor's own
 * markdown tokens. This extension takes the drop caret from the composer's
 * substrate ({@link tugDropCaretExtension}) and nothing else from it: no
 * atoms, no bytes-store, no downsample. A document attachment is a file, not
 * a payload.
 *
 * ## Every document has somewhere to put a file
 *
 * There is no untitled guard. A buffer that has never been saved carries a
 * draft id, and a draft id names a real writable home under the Tug data root
 * — so the drop writes `assets/<name>` there and the document says exactly
 * what it will say after it is saved. Save As migrates the home into the
 * destination directory, and because the relative link is stable across that
 * move, the document text usually does not change at all.
 *
 * Saving a *titled* document elsewhere by any other means breaks its links the
 * way any `mv` would; that is the standard cost of relative links and is not
 * guarded here.
 *
 * Laws:
 *  - [L06] the drop ring and caret are DOM/CSS — a `data-drop-active`
 *    attribute on the host and the caret layer, never React state.
 *  - [L07] the document path and error sink are read through getters at
 *    dispatch time, never captured at extension-construction time.
 *
 * @module components/tugways/tug-text-card-editor/file-drop
 */

import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

import {
  clearDropCaret,
  dropOffsetAtCoords,
  paintDropCaret,
  tugDropCaretExtension,
} from "../tug-text-editor/drop-extension";
import { padInsert } from "../tug-text-editor/smart-insert";
import {
  uploadDocAttachment,
  type AssetBaseDescriptor,
  type DocAttachment,
} from "@/lib/attachment-upload";
import { encodeLinkDestination } from "@/lib/asset-links";

/** True when the drag carries at least one file. */
function acceptsDrag(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false;
  return Array.from(transfer.types).includes("Files");
}

/** Set or clear the host's drop ring. */
function setDropActive(host: HTMLElement | null, active: boolean): void {
  if (host === null) return;
  if (active) {
    host.setAttribute("data-drop-active", "accept");
  } else {
    host.removeAttribute("data-drop-active");
  }
}

/**
 * The markdown for one stored asset: an image embed for an image media type,
 * a plain link otherwise.
 *
 * **The label is the name the user dropped, not the name on disk.** These are
 * usually the same, and diverge exactly when a collision suffix was needed:
 * dropping a second `photo.png` writes `assets/photo-2.png`, and the link
 * reads `![photo](assets/photo-2.png)`. Suffixing is bookkeeping this feature
 * does to avoid clobbering a file — it is not something the user did, and the
 * visible half of the link is the half they read. Only the destination, which
 * has to name a real file, carries the suffix.
 *
 * The image's alt text is the dropped filename's stem — what a person would
 * call the picture — while a non-image link shows the whole dropped name,
 * extension included, because the extension is what tells the reader what they
 * are about to open.
 */
export function linkForAsset(
  attachment: DocAttachment,
  droppedName: string,
  mediaType: string,
): string {
  const destination = encodeLinkDestination(attachment.relativePath);
  if (mediaType.startsWith("image/")) {
    const stem = droppedName.replace(/\.[^.]+$/, "");
    return `![${stem}](${destination})`;
  }
  return `[${droppedName}](${destination})`;
}

/** What the extension needs from its host, read fresh on every drop. */
export interface FileDropOptions {
  /** The editor's host element, for the drop ring. */
  host: HTMLElement | null;
  /**
   * Which document's assets this drop belongs to — a saved one by path, or a
   * not-yet-saved one by draft id ([P02]). `null` only when the card has no
   * binding at all, which is not a state a mounted editor rests in.
   *
   * A path here is already canonical: it came back from the store's own
   * `openPath` resolution, and the route re-guards it regardless.
   */
  getAssetBase: () => AssetBaseDescriptor | null;
  /** Report a failure for one named file, in place ([P06]). */
  onError: (name: string, message: string) => void;
}

/**
 * Upload `files` into the document's asset base and return the markdown links
 * for the ones that landed.
 *
 * Shared by the drop path and the paste path, which differ only in where the
 * files came from and whether they have names.
 */
export async function linksForFiles(
  base: AssetBaseDescriptor,
  files: readonly File[],
  onError: (name: string, message: string) => void,
  // A paste has no filename; the server mints one, so the timestamp and the
  // write are a single step ([P11]).
  named: boolean,
): Promise<string[]> {
  const uploaded = await Promise.all(
    files.map(async (file) => ({
      file,
      attachment: await uploadDocAttachment(base, file, named ? file.name : null),
    })),
  );
  const links: string[] = [];
  for (const { file, attachment } of uploaded) {
    if (attachment === null) {
      onError(file.name, `Could not attach ${file.name}.`);
      continue;
    }
    const droppedName = named
      ? file.name
      : // The server named it; the document should say the same thing.
        attachment.relativePath.replace(/^assets\//, "");
    links.push(linkForAsset(attachment, droppedName, file.type));
  }
  return links;
}

/**
 * File-drop handling for the Text card editor.
 *
 * The drop is claimed in the capture phase so CM6's own text-drop handler
 * never sees it: CM6 would insert at its unbiased `posAtCoords`, which is the
 * position hidden under the drag image rather than the one the drop caret
 * promised.
 */
export function fileDropExtension(options: FileDropOptions): Extension {
  return [
    tugDropCaretExtension,
    ViewPlugin.define((view) => {
      const { host } = options;

      const onDragEnter = (event: DragEvent): void => {
        if (!acceptsDrag(event.dataTransfer)) return;
        event.preventDefault();
        setDropActive(host, true);
      };

      const onDragOver = (event: DragEvent): void => {
        const transfer = event.dataTransfer;
        if (!acceptsDrag(transfer) || transfer === null) return;
        event.preventDefault();
        setDropActive(host, true);
        try {
          transfer.dropEffect = "copy";
        } catch {
          // `dropEffect` is read-only in some environments.
        }
        paintDropCaret(view, event.clientX, event.clientY);
      };

      const onDragLeave = (event: DragEvent): void => {
        // A dragleave also fires for every internal element-to-element
        // crossing; `relatedTarget` names the element being entered, so a
        // target still inside the host means the drag has not left.
        const related = event.relatedTarget as Node | null;
        if (related !== null && host !== null && host.contains(related)) return;
        setDropActive(host, false);
        clearDropCaret(view);
      };

      const onDragEnd = (): void => {
        setDropActive(host, false);
        clearDropCaret(view);
      };

      const onDrop = (event: DragEvent): void => {
        const transfer = event.dataTransfer;
        if (!acceptsDrag(transfer) || transfer === null) return;
        const files = Array.from(transfer.files);
        if (files.length === 0) return;

        event.preventDefault();
        event.stopPropagation();
        setDropActive(host, false);

        const base = options.getAssetBase();
        if (base === null) {
          clearDropCaret(view);
          return;
        }

        // Resolve the insertion point from the pointer BEFORE any await: the
        // caret the user was shown is the one the links must land at, and the
        // coordinates stop meaning anything once the drag is over.
        const dropPos =
          dropOffsetAtCoords(view, event.clientX, event.clientY) ??
          view.state.doc.length;
        clearDropCaret(view);

        void (async () => {
          const links = await linksForFiles(base, files, options.onError, true);
          // The editor may have unmounted while the bytes were in flight.
          if (!view.dom.isConnected) return;
          if (links.length === 0) return;

          // One transaction, so one undo removes the whole drop — including
          // the smart-insert padding, which rides it rather than following it.
          const pos = Math.min(dropPos, view.state.doc.length);
          const padded = padInsert(view.state, pos, pos, links.join(" "));
          view.dispatch({
            changes: { from: pos, insert: padded.insert },
            selection: { anchor: padded.caret },
            userEvent: "input.tug-file-drop",
          });
          view.focus();
        })();
      };

      const dom = view.dom;
      dom.addEventListener("dragenter", onDragEnter);
      dom.addEventListener("dragover", onDragOver);
      dom.addEventListener("dragleave", onDragLeave);
      dom.addEventListener("dragend", onDragEnd);
      dom.addEventListener("drop", onDrop, true);

      return {
        destroy(): void {
          dom.removeEventListener("dragenter", onDragEnter);
          dom.removeEventListener("dragover", onDragOver);
          dom.removeEventListener("dragleave", onDragLeave);
          dom.removeEventListener("dragend", onDragEnd);
          dom.removeEventListener("drop", onDrop, true);
          setDropActive(options.host, false);
        },
      };
    }),
  ];
}
