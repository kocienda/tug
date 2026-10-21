/**
 * tug-text-editor/atom-integrity.ts — position-sensitive atom rules.
 *
 * A command atom is a command only while it leads the document: claude
 * expands `/name` into a user invocation only when the message text
 * begins with it (see `lib/command-atom.ts`). A command chip that an
 * edit pushes off position 0 — the user typed or pasted text in front
 * of it — would otherwise ride along as a U+FFFC placeholder that
 * never expands, never errors, and silently ships as a broken message.
 *
 * The rule enforced here: any doc change that leaves a command atom at
 * a position other than 0 *demotes* it in the same transaction — the
 * U+FFFC is replaced with the command's literal `/name` text, and the
 * field drops the atom whose U+FFFC the change took.
 * The demotion rides the user's own edit as one atomic transaction, so
 * undo restores both the edit and the chip together
 * (`atomInvertedEffects` records the taken atom for the undo).
 *
 * Implemented as an `EditorState.transactionFilter` — the only hook
 * that may append *changes* (not just effects) to an in-flight
 * transaction. Undo/redo transactions are exempt: history must restore
 * recorded states verbatim, and every demotion it can replay was
 * already recorded as part of the edit that caused it.
 *
 * Laws: [L02] atom state lives in the CM6 field, [L11] the demotion is
 *        a document edit dispatched through the transaction stream,
 *        [L19] file structure, [L22] no React round-trip.
 */

import { EditorState } from "@codemirror/state";
import type { Extension, TransactionSpec } from "@codemirror/state";
import type { WidgetType } from "@codemirror/view";
import { atomDecorationField, AtomWidget } from "./atom-decoration";
import { commandWireText } from "@/lib/command-atom";

/**
 * The demotion filter. Maps the pre-transaction atom set through the
 * transaction's changes and, for every surviving command atom whose
 * U+FFFC no longer sits at position 0, appends a sequential change
 * replacing the placeholder with the literal `/name` text.
 *
 * Atoms *added by this transaction's own effects* are invisible here
 * (the filter sees only the start-state set) — deliberately: accepting
 * a completion is never demoted by its own insertion, and a state
 * restore that replays atoms via effects is left untouched until the
 * next real edit.
 */
export const commandAtomDemotionFilter: Extension =
  EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr;
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return tr;
    const before = tr.startState.field(atomDecorationField, false);
    if (before === undefined || before.size === 0) return tr;

    const demotions: { from: number; to: number; insert: string }[] = [];
    before.between(0, tr.startState.doc.length, (from, to, value) => {
      const widget = (value.spec as { widget?: WidgetType }).widget;
      if (!(widget instanceof AtomWidget)) return;
      if (widget.segment.type !== "command") return;
      const mappedFrom = tr.changes.mapPos(from, 1);
      const mappedTo = tr.changes.mapPos(to, -1);
      if (mappedFrom >= mappedTo) return; // deleted by this transaction
      if (mappedFrom === 0) return; // still leading
      demotions.push({
        from: mappedFrom,
        to: mappedTo,
        insert: commandWireText(widget.segment.value),
      });
    });
    if (demotions.length === 0) return tr;
    return [tr, { changes: demotions, sequential: true }];
  });
