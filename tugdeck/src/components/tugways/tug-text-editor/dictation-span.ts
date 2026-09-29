/**
 * tug-text-editor/dictation-span.ts — the region of the document a live
 * dictation session owns, and the dimmed tail inside it that is not settled
 * yet.
 *
 * **A span rather than a view.** Dictation writes into a document the user is
 * also editing: they can click away mid-sentence, delete a word above, paste.
 * So the three offsets the session needs live in a `StateField` that maps
 * through `tr.changes`, the shape `atom-decoration.ts` uses — not the
 * `ViewPlugin` shape of `argument-hint-extension.ts`, which recomputes from
 * the view each update and has no positions to keep. An unrelated insertion
 * above the span moves the span; it does not confuse it.
 *
 * **Two regions, one field.** `[from, committedTo)` is text the recogniser
 * called settled — ordinary draft content, which the user may edit and a
 * submit carries. `[committedTo, to)` is the provisional tail, replaced
 * wholesale on every reading. How it ends is the caller's to say: an end that
 * **drops** deletes it, and an end that **promotes** leaves it in the
 * document as ordinary text. Only the tail is decorated, because only the
 * tail is unsettled — and either way the decoration goes with the span.
 *
 * **Nothing here goes through React** ([L22], [L06], [P05]). A recogniser
 * revises several times a second; a render per revision would repaint the
 * composer under the user's hands. Each reading is one CM6 transaction, and
 * the dimming is a decoration class over a `baseTheme` token.
 *
 * **Every transaction this module builds is stamped** ([P10]) with
 * `userEvent: "input.tug-dictation"` and `suppressCompletionDetection`.
 * Without the annotation `completion-extension.ts`'s Rejoin rule reopens the
 * typeahead on any `docChanged` transaction that leaves the caret inside a
 * literal trigger run, and the reopened popup's `Prec.highest` keymap then
 * swallows the next Enter as an accept — so dictating "slash the tyres" or an
 * email address would silently break submit for the rest of the draft. The
 * `userEvent` is how every other programmatic door into this editor names
 * itself (`input.tug-atom`, `input.paste`).
 *
 * References: [B04], [B06], [P05], [P08], [P10], Spec S05, [L03], [L06],
 * [L22].
 *
 * @module components/tugways/tug-text-editor/dictation-span
 */

import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

import type { DictationHandle } from "@/lib/prompt-insert-target";

import { suppressCompletionDetection } from "./completion-extension";

// ---------------------------------------------------------------------------
// The field's value
// ---------------------------------------------------------------------------

/**
 * Where a live dictation session sits in the document.
 *
 * `padPending` records that the session opened at the end of a non-empty
 * draft, so the first non-empty write owes a leading newline ([P08]). It is
 * carried here rather than decided at write time because by then the caret
 * may have moved and the document may have grown — the rule is about where
 * the session *began*.
 */
export interface DictationSpanValue {
  /** Start of the session's text. Settled text runs from here. */
  readonly from: number;
  /** End of the settled text, and start of the provisional tail. */
  readonly committedTo: number;
  /** End of the provisional tail. Equal to `committedTo` when there is none. */
  readonly to: number;
  /** The first non-empty write owes a leading newline ([P08]). */
  readonly padPending: boolean;
}

/** What the store asks of the span, before positions are worked out. */
export type DictationSpanAction =
  | { readonly kind: "begin" }
  | { readonly kind: "volatile"; readonly text: string }
  | { readonly kind: "final"; readonly text: string }
  /**
   * Close the span. `promote` decides what becomes of a tail the recogniser
   * never settled: `false` deletes it, `true` leaves it in the document as
   * ordinary text.
   */
  | { readonly kind: "end"; readonly promote: boolean };

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * The four effects carry the **resolved** span rather than the text, in the
 * transaction's final coordinates.
 *
 * That is not an arbitrary split. A padded first write inserts `"\n" + text`
 * at the caret, and the span's `from` must land *after* that newline so the
 * padding is not part of the session's text and survives `end()` ([P08]) —
 * and no choice of `mapPos` assoc yields that, because both assocs of an
 * insertion point are the newline's own two sides. The builder computes the
 * change, so the builder is the one place that knows where the span ended up.
 */
export const beginDictationEffect = StateEffect.define<DictationSpanValue>();

/** Replace the provisional tail. Value is the span after the replacement. */
export const setVolatileEffect = StateEffect.define<DictationSpanValue>();

/** Settle the tail into the draft. Value is the span after settling. */
export const commitFinalEffect = StateEffect.define<DictationSpanValue>();

/** Close the session. A dropped tail's deletion rides the same transaction. */
export const endDictationEffect = StateEffect.define<null>();

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

/**
 * `null` outside a session. Maps through document changes first, so an edit
 * somewhere else in the document moves the span rather than stranding it;
 * an effect then overrides the whole value, because a transaction this module
 * built already knows the answer.
 *
 * Mapped with assoc `1` throughout: text inserted at the span's own start is
 * text the user typed ahead of the dictation, so the span moves forward past
 * it rather than swallowing it.
 */
export const dictationSpanField = StateField.define<DictationSpanValue | null>({
  create(): DictationSpanValue | null {
    return null;
  },

  update(value, tr): DictationSpanValue | null {
    let next = value;

    if (next !== null && tr.docChanged) {
      next = {
        from: tr.changes.mapPos(next.from, 1),
        committedTo: tr.changes.mapPos(next.committedTo, 1),
        to: tr.changes.mapPos(next.to, 1),
        padPending: next.padPending,
      };
    }

    for (const effect of tr.effects) {
      if (effect.is(beginDictationEffect)) next = effect.value;
      else if (effect.is(setVolatileEffect)) next = effect.value;
      else if (effect.is(commitFinalEffect)) next = effect.value;
      else if (effect.is(endDictationEffect)) next = null;
    }

    return next;
  },

  provide: (f) => EditorView.decorations.from(f, volatileDecorations),
});

/** One mark over the provisional tail, or nothing when there is no tail. */
function volatileDecorations(value: DictationSpanValue | null): DecorationSet {
  if (value === null || value.to <= value.committedTo) return Decoration.none;
  return Decoration.set([
    Decoration.mark({ class: "tug-dictation-volatile" }).range(
      value.committedTo,
      value.to,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------

/**
 * The dimmed tail ([L06] — appearance is CSS, never React state).
 *
 * The token is defined on the editor root and consumed by the mark, so a host
 * that wants a different reading sets one variable instead of overriding a
 * selector. It defaults to the placeholder's own colour: provisional text and
 * placeholder text are the same claim — this is here, and it is not yours yet.
 *
 * No animation. A tail that pulsed would be motion under the user's cursor
 * for the whole length of a sentence.
 */
export const dictationSpanTheme: Extension = EditorView.baseTheme({
  "&": {
    "--tugx-dictation-volatile-color":
      "var(--tug7-element-field-text-normal-placeholder-rest)",
  },
  ".tug-dictation-volatile": {
    color: "var(--tugx-dictation-volatile-color)",
  },
});

// ---------------------------------------------------------------------------
// The transaction builder — pure, and the whole of the logic
// ---------------------------------------------------------------------------

/**
 * The [P10] stamp, on every transaction this module builds.
 *
 * Spread into each spec rather than applied at dispatch, so the two tests that
 * read it off the spec read the same object the view would have received.
 */
const DICTATION_STAMP = {
  userEvent: "input.tug-dictation",
  annotations: suppressCompletionDetection.of(true),
} as const;

/**
 * The {@link TransactionSpec} one dictation action becomes, or `null` when
 * there is nothing to do (an action on a state with no open session).
 *
 * Pure over the state, which is what lets the whole of Spec S05 be tested
 * against an `EditorState` with no view, no DOM and no host.
 */
export function dictationSpanTransaction(
  state: EditorState,
  action: DictationSpanAction,
): TransactionSpec | null {
  const span = state.field(dictationSpanField, false) ?? null;

  if (action.kind === "begin") {
    const head = state.selection.main.head;
    // [P08], restated rather than imported. The rule's home is
    // `applyAppendInsertion` in `tug-prompt-entry.tsx`, pinned by
    // `__tests__/append-insertion.test.ts`; importing it from here would
    // close the cycle `tug-text-editor.tsx` → `dictation-span.ts` →
    // `tug-prompt-entry.tsx` → `tug-text-editor.tsx`, with a large React
    // component module inside it, for one conditional.
    const padPending = state.doc.length > 0 && head === state.doc.length;
    return {
      effects: [
        beginDictationEffect.of({
          from: head,
          committedTo: head,
          to: head,
          padPending,
        }),
      ],
      ...DICTATION_STAMP,
    };
  }

  if (span === null) return null;

  if (action.kind === "end") {
    // A promoted tail is already the right bytes in the right place — the
    // whole of promoting it is closing the span and letting the decoration
    // go with it, so the transaction carries no change at all. A dropped one
    // is deleted here, in the transaction that closes the span, because the
    // recogniser never called it settled.
    const drop = !action.promote && span.to > span.committedTo;
    return {
      ...(drop
        ? { changes: { from: span.committedTo, to: span.to, insert: "" } }
        : {}),
      effects: [endDictationEffect.of(null)],
      ...DICTATION_STAMP,
    };
  }

  const { text } = action;
  const pad = span.padPending && text.length > 0;
  const insert = pad ? `\n${text}` : text;
  const shift = pad ? 1 : 0;
  const from = span.from + shift;
  const tailStart = span.committedTo + shift;
  const to = tailStart + text.length;

  // The caret follows the tail only when it was in the span to begin with. A
  // user who clicked somewhere else while dictating keeps their caret there —
  // dragging it back would fight them for the insertion point.
  const head = state.selection.main.head;
  const follow = head >= span.from && head <= span.to;

  const value: DictationSpanValue =
    action.kind === "volatile"
      ? { from, committedTo: tailStart, to, padPending: span.padPending && !pad }
      : { from, committedTo: to, to, padPending: span.padPending && !pad };

  return {
    changes: { from: span.committedTo, to: span.to, insert },
    ...(follow ? { selection: EditorSelection.cursor(to) } : {}),
    effects: [
      action.kind === "volatile"
        ? setVolatileEffect.of(value)
        : commitFinalEffect.of(value),
    ],
    ...DICTATION_STAMP,
  };
}

// ---------------------------------------------------------------------------
// Installation and the handle
// ---------------------------------------------------------------------------

/**
 * Installed unconditionally in `buildExtensions`, beside the atom decoration.
 * An editor that never receives a `begin` pays one null field and one theme
 * block, which is cheaper than deciding per editor whether it can be dictated
 * into.
 */
export const dictationSpanExtension: Extension = [
  dictationSpanField,
  dictationSpanTheme,
];

/**
 * The store's end of a dictation session, over whichever view is bound now.
 *
 * `getView` is read per call rather than captured, because the composer's view
 * is replaced on remount and `null` between passes — a handle that held one
 * would write into a detached editor. A call with no view returns without
 * effect: the composer went away mid-session, and the release that follows
 * will find nothing to close, which is correct.
 */
export function dictationHandleFor(getView: () => EditorView | null): DictationHandle {
  const run = (action: DictationSpanAction): void => {
    const view = getView();
    if (view === null) return;
    const spec = dictationSpanTransaction(view.state, action);
    if (spec === null) return;
    view.dispatch({ ...spec, scrollIntoView: true });
  };

  return {
    begin: () => run({ kind: "begin" }),
    volatile: (text: string) => run({ kind: "volatile", text }),
    final: (text: string) => run({ kind: "final", text }),
    end: (promote: boolean) => run({ kind: "end", promote }),
  };
}
