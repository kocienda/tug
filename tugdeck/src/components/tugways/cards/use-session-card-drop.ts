/**
 * `useSessionCardDrop` — the Session card's content area as a file-drop
 * surface, outside the composer.
 *
 * Dropping a file on a Session card is one gesture with one meaning — *put
 * this in the prompt* — and the composer already honours it over every part
 * of itself ({@link useComposerDrop}, "a composer is one continuous drop
 * surface"). Nothing about the transcript makes the gesture stop meaning
 * something, so these handlers sit on the card's content root and catch what
 * the two inner layers did not: the transcript, the header, the status bar,
 * the gaps. The title bar is deliberately outside — it is the card's drag
 * handle, where a file is ambiguous between "put this in the prompt" and a
 * gesture about the card itself ([B01]).
 *
 * **Three layers, one protocol.** `drop-extension.ts` claims drags over the
 * editor host; `useComposerDrop` catches the rest of the composer's chrome;
 * these handlers catch the card. React synthetic events bubble from the
 * target outward, so this layer runs last and sees `defaultPrevented` set by
 * either inner one — and returns. No path double-handles, and the composer's
 * own drop is byte-for-byte what it was.
 *
 * **Files only.** The payload the card claims is `Files`, routed to the
 * composer through {@link PromptInsertTarget.insertFiles} so the entry's own
 * attachment pipeline keeps deciding what a dropped file becomes. A jot
 * dragged out of the Jots card is left to the composer's surface, where its
 * append rule already lives; a block-reorder drag carries neither payload and
 * is never claimed.
 *
 * **Declining is a behaviour, not an omission.** When there is no composer to
 * accept into, the handler does not call `preventDefault` — so the drag reads
 * as refused by the OS rather than accepted and swallowed. `accepting` is the
 * caller's answer to that question, derived from state it already observes.
 *
 * **The cue points at the destination, not at the pointer.** A drag over the
 * card wears the editor's own two cues — the drop ring on the editor host and
 * the drop caret — but the caret is painted at the composer's live selection
 * rather than tracked to the cursor, because over the transcript there is no
 * document under the pointer and the honest thing to say is *this is going
 * into the composer, here* ([B05]). The composer's own surface is untouched:
 * there a coordinate resolves, and it still does. No new drop chrome. All DOM
 * writes, no React state ([L06]).
 *
 * @module components/tugways/cards/use-session-card-drop
 */

import { useCallback } from "react";
import type { EditorView } from "@codemirror/view";

import {
  clearDropCaret,
  markEditorDropActive,
  paintDropCaretAt,
} from "@/components/tugways/tug-text-editor/drop-extension";
import type { PromptInsertTarget } from "@/lib/prompt-insert-target";

export interface SessionCardDropOptions {
  /** The card's composer — where the dropped files land. */
  insertTarget: PromptInsertTarget;
  /**
   * The composer's live `EditorView`, read at event time ([L07]) — the
   * surface the two cues are painted on, and the selection the caret points
   * at. `null` when the entry has not mounted its editor yet; the drag is
   * still accepted (the insert parks until an editor exists) and simply
   * wears no cue.
   */
  view: () => EditorView | null;
  /**
   * Whether there is a composer to accept into. `false` declines the drag
   * outright: a replay holding the entry `inert`, an inline dialog holding
   * the editor read-only, a shade standing over the transcript. The unbound
   * card needs no flag — its picker renders instead of this root, so these
   * handlers are not mounted at all.
   */
  accepting: boolean;
}

/** The handlers to spread on the card's content root. */
export interface SessionCardDropHandlers {
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
}

export function useSessionCardDrop({
  insertTarget,
  view,
  accepting,
}: SessionCardDropOptions): SessionCardDropHandlers {
  // A target that cannot take files declines the payload rather than
  // accepting one it has nowhere to put — the seam `insertFiles` is optional
  // on ([B03]).
  const acceptsFiles = insertTarget.insertFiles !== undefined;

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      // The editor substrate or the composer's own surface already claimed
      // this drag; the outer layer stays out of it.
      if (event.defaultPrevented) return;
      if (!accepting || !acceptsFiles) return;
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const editorView = view();
      if (editorView === null) return;
      markEditorDropActive(editorView, true);
      // The insertion point, not the pointer — and the same position step
      // one's insert reads, so the cue cannot promise a place the drop will
      // not use.
      paintDropCaretAt(editorView, editorView.state.selection.main.from);
    },
    [accepting, acceptsFiles, view],
  );

  const clearDropState = useCallback((): void => {
    const editorView = view();
    if (editorView === null) return;
    markEditorDropActive(editorView, false);
    clearDropCaret(editorView);
  }, [view]);

  const onDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      // Ignore a leave that merely crosses into a descendant — the card is
      // full of them — and clear only when the pointer truly exits the card.
      // A native Escape-cancel over the card is covered by the window-level
      // watchdog in `drop-extension.ts`, which tears both cues down for
      // whichever surface painted them.
      const next = event.relatedTarget as Node | null;
      if (next !== null && event.currentTarget.contains(next)) return;
      clearDropState();
    },
    [clearDropState],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (event.defaultPrevented) return;
      if (!accepting) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      if (insertTarget.insertFiles === undefined) return;
      event.preventDefault();
      clearDropState();
      // Raise first: dropping on a background card means "put this in *that*
      // card's prompt", and the prompt the files land in should be the one
      // the user ends up looking at ([B04]). The mistake of an accidental
      // drop is then visible immediately, and one undo away.
      insertTarget.raise();
      insertTarget.insertFiles(files);
    },
    [accepting, clearDropState, insertTarget],
  );

  return { onDragOver, onDragLeave, onDragEnd: clearDropState, onDrop };
}
