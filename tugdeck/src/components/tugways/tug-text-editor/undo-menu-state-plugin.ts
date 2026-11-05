/**
 * undo-menu-state-plugin.ts — mirror undo/redo *state* outward to the
 * native Edit menu, for any CM6 editing substrate.
 *
 * Two outputs per document change:
 *
 *   - **Availability.** The menu's undo/redo enablement reads the
 *     editor's history depth through the responder node's
 *     `validateAction`, but the chain only recomputes on
 *     validation-version changes (focus / register / unregister) —
 *     typing changes the depth without any of those. The plugin asks the
 *     menu-caps publisher to recompute when availability (depth > 0) or
 *     the menu labels change — not on every keystroke: a continued
 *     typing run alters neither, so it publishes nothing. The publisher
 *     additionally diffs the serialized payload, so even a redundant
 *     request posts nothing.
 *   - **Labels.** Parallel label stacks (undo-labels.ts) name the next
 *     undo/redo steps ("Typing", "Paste", …); the tops are registered in
 *     host-menu-state's per-editor label registry keyed by `view.dom`,
 *     where the publisher resolves them for the focused editor only.
 *   - **Writability.** A gate that reads the view's `EditorState.readOnly`
 *     (Find and Replace…, the editing commands) moves when the view goes
 *     read-only or writable again, which is neither a focus change nor a
 *     document change, so the plugin asks for a recompute then too.
 *
 * A ViewPlugin (not a bare updateListener) so per-instance state lives
 * on the plugin and `destroy()` clears the registry entry on unmount.
 *
 * Shared by `tug-text-editor` (the prompt composer) and
 * `tug-text-card-editor` (the Text card's editing surface) — the plugin has
 * no substrate-specific state.
 *
 * @module components/tugways/tug-text-editor/undo-menu-state-plugin
 */

import { Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { redoDepth, undoDepth } from "@codemirror/commands";

import {
  requestMenuStateRefresh,
  setEditUndoLabels,
} from "@/lib/host-menu-state";

import {
  EMPTY_UNDO_LABEL_STACKS,
  applyHistoryStep,
  undoLabelForUserEvent,
  type UndoLabelStacks,
} from "./undo-labels";

export const undoMenuStatePlugin: Extension = ViewPlugin.fromClass(
  class {
    private stacks: UndoLabelStacks = EMPTY_UNDO_LABEL_STACKS;
    /** Availability + label fingerprint of the last refresh request. */
    private lastPublished = "";

    constructor(private readonly view: EditorView) {
      setEditUndoLabels(view.dom, { undo: "", redo: "" });
    }

    update(update: ViewUpdate): void {
      if (update.state.readOnly !== update.startState.readOnly) {
        requestMenuStateRefresh();
      }
      if (!update.docChanged) return;

      const isUndo = update.transactions.some((t) => t.isUserEvent("undo"));
      const isRedo = update.transactions.some((t) => t.isUserEvent("redo"));
      let label = "";
      if (!isUndo && !isRedo) {
        for (const t of update.transactions) {
          const userEvent = t.annotation(Transaction.userEvent) ?? null;
          const mapped = undoLabelForUserEvent(userEvent);
          if (mapped !== "") label = mapped;
        }
      }
      this.stacks = applyHistoryStep(this.stacks, {
        kind: isUndo ? "undo" : isRedo ? "redo" : "edit",
        label,
        undoDepthAfter: undoDepth(update.state),
        redoDepthAfter: redoDepth(update.state),
      });

      const undoLabel = this.stacks.done[this.stacks.done.length - 1] ?? "";
      const redoLabel = this.stacks.undone[this.stacks.undone.length - 1] ?? "";
      setEditUndoLabels(this.view.dom, { undo: undoLabel, redo: redoLabel });

      // Refresh only when something menu-visible changed: availability
      // (depth > 0) or the labels. A continued typing run changes
      // neither, so it requests nothing.
      const published = `${this.stacks.done.length > 0}|${undoLabel}|${this.stacks.undone.length > 0}|${redoLabel}`;
      if (published !== this.lastPublished) {
        this.lastPublished = published;
        requestMenuStateRefresh();
      }
    }

    destroy(): void {
      setEditUndoLabels(this.view.dom, null);
    }
  },
);
