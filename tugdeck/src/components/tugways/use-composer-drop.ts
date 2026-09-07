/**
 * `useComposerDrop` — a composer's whole drop surface, in one hook.
 *
 * A composer is one continuous drop surface: the editor substrate claims
 * drags over its own host (`drop-extension.ts` attaches host-level
 * listeners, so the blank band below short content accepts too), and these
 * handlers catch everything else — the attachment strip, the toolbar, the
 * status row, the gaps — and route the drop through the same editor
 * pipeline. Events the substrate already claimed arrive with
 * `defaultPrevented` set and are left alone, so the two layers compose
 * without double handling.
 *
 * Two payloads land here. A **jot** dragged from the Jots card ([P05]) goes
 * into the {@link PromptInsertTarget} at the drop point, which is the half
 * both composers share and the reason this is a hook rather than a shape to
 * re-type: the Session entry wrote it against a `CodeSessionStore`, and the
 * Overview composer — a bare substrate whose own `drop-extension` handles
 * `Files` only — had nowhere for a dragged jot to land. **Files** are the
 * host's half, passed in as `onFiles`; a composer that takes no file drop
 * over its chrome omits it and the payload is declined.
 *
 * The visual cues are the editor's own and belong to neither payload: the
 * drop ring on the editor host (`markEditorDropActive`) plus the drop caret
 * at the resolved position, which clamps to the nearest document position so
 * a drop over the toolbar lands at the bottom row. A jot therefore reads
 * exactly like an image over the composer. All DOM writes, no React state
 * ([L06]).
 *
 * @module components/tugways/use-composer-drop
 */

import { useCallback } from "react";
import type { EditorView } from "@codemirror/view";

import {
  clearDropCaret,
  dropOffsetAtCoords,
  markEditorDropActive,
  paintDropCaret,
} from "./tug-text-editor/drop-extension";
import { hasJotDrag, readJotDrag } from "@/lib/jot-drag";
import type { PromptInsertTarget } from "@/lib/prompt-insert-target";

export interface ComposerDropOptions {
  /** The composer's live `EditorView`, read at event time ([L07]). */
  view: () => EditorView | null;
  /** Where a dragged jot lands. */
  insertTarget: PromptInsertTarget;
  /**
   * What a file drop does, given the view, the files, and the document
   * position the drop resolved to. Omitted by a composer that accepts no
   * files over its chrome; the drag is then not accepted at all rather than
   * accepted and dropped on the floor.
   */
  onFiles?: (view: EditorView, files: File[], pos: number) => void;
}

/** The handlers to spread on the composer's root element. */
export interface ComposerDropHandlers {
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
}

export function useComposerDrop({
  view,
  insertTarget,
  onFiles,
}: ComposerDropOptions): ComposerDropHandlers {
  const acceptsFiles = onFiles !== undefined;

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (event.defaultPrevented) return;
      const dt = event.dataTransfer;
      const wanted =
        (acceptsFiles && dt.types.includes("Files")) || hasJotDrag(dt);
      if (!wanted) return;
      const editorView = view();
      if (editorView === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      markEditorDropActive(editorView, true);
      paintDropCaret(editorView, event.clientX, event.clientY);
    },
    [acceptsFiles, view],
  );

  const clearDropState = useCallback((): void => {
    const editorView = view();
    if (editorView === null) return;
    markEditorDropActive(editorView, false);
    clearDropCaret(editorView);
  }, [view]);

  const onDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      // Ignore leave events that merely cross into a descendant — only clear
      // when the pointer truly exits. A native Escape-cancel fires dragleave
      // with a null relatedTarget, so this also tears down on cancel.
      const next = event.relatedTarget as Node | null;
      if (next !== null && event.currentTarget.contains(next)) return;
      clearDropState();
    },
    [clearDropState],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (event.defaultPrevented) return;
      const jot = readJotDrag(event.dataTransfer);
      const files = acceptsFiles ? Array.from(event.dataTransfer.files) : [];
      if (jot === null && files.length === 0) return;
      const editorView = view();
      if (editorView === null) return;
      event.preventDefault();
      if (jot !== null) {
        // The target owns the insertion — the drop offset, or the append
        // rule when the coordinate resolves to nothing — because the same
        // code has to serve a drop and a menu pick, and a composer that
        // parks its inserts parks this one too.
        clearDropState();
        insertTarget.insertText(jot.text, jot.atoms, {
          x: event.clientX,
          y: event.clientY,
        });
        return;
      }
      // Resolve the drop against the editor's measured layout, same as a drop
      // on the editor itself. The chrome sits outside the document, so the
      // coordinate clamps to the nearest position — the bottom row — letting
      // the user target it instead of dumping at a stale caret.
      const pos =
        dropOffsetAtCoords(editorView, event.clientX, event.clientY) ??
        editorView.state.doc.length;
      clearDropState();
      onFiles?.(editorView, files, pos);
    },
    [acceptsFiles, clearDropState, insertTarget, onFiles, view],
  );

  return { onDragOver, onDragLeave, onDragEnd: clearDropState, onDrop };
}
