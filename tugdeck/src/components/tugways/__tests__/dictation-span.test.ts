/**
 * dictation-span.test.ts — Spec S05, against a real `EditorState` and no view.
 *
 * The whole of the span's logic is `dictationSpanTransaction`, which is pure
 * over the state, so every claim here is made the way CodeMirror itself would
 * apply it: build a state carrying the field, apply the spec, read back the
 * document, the field and the decoration set. No DOM, no host, no React.
 *
 * What the claims are about:
 *
 *  - **The two regions.** Settled text and the provisional tail are one field
 *    with two boundaries, and only the tail is decorated. A `final` moves the
 *    boundary rather than inserting anywhere new.
 *  - **Where the first write lands** ([P08]). At the end of a non-empty draft
 *    it goes on its own line, and `from` records the position *after* that
 *    newline so the padding is not the session's text. Anywhere else it is a
 *    plain insert at the caret. This restates a rule whose home is
 *    `applyAppendInsertion`, so it is pinned against the same two cases
 *    `append-insertion.test.ts` covers.
 *  - **The tail is dropped at `end`, never promoted.** The recogniser never
 *    called it settled.
 *  - **The span survives edits it did not make.** It is a `StateField` mapping
 *    through `tr.changes` precisely so a user typing above it does not strand
 *    the next reading in the wrong place.
 *  - **[P10], twice.** Once as a table over all four transactions, and once
 *    against the live completion extension — the second is the defect in test
 *    form: a dictated `/` must not reopen the typeahead, whose `Prec.highest`
 *    keymap would then eat the next Enter and break submit.
 */

import { describe, expect, test } from "bun:test";

import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import {
  completionField,
  suppressCompletionDetection,
  tugCompletionExt,
} from "../tug-text-editor/completion-extension";
import {
  dictationHandleFor,
  dictationSpanExtension,
  dictationSpanField,
  dictationSpanTransaction,
  type DictationSpanAction,
  type DictationSpanValue,
} from "../tug-text-editor/dictation-span";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A state carrying the span field, with the caret where `head` says. */
function makeState(doc: string, head = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(head),
    extensions: [dictationSpanExtension],
  });
}

/** Apply one dictation action, or fail loudly if the builder declined it. */
function apply(state: EditorState, action: DictationSpanAction): EditorState {
  const spec = dictationSpanTransaction(state, action);
  if (spec === null) throw new Error(`no transaction for ${action.kind}`);
  return state.update(spec).state;
}

/** The span, or `null`. */
function span(state: EditorState): DictationSpanValue | null {
  return state.field(dictationSpanField);
}

/**
 * Every `[from, to)` the volatile decoration covers, in document order.
 *
 * Read off `EditorView.decorations` — the facet the field's own `provide`
 * writes into — rather than by calling the decoration builder directly, so what
 * is checked is the real wiring and not a re-derivation of it. A facet input
 * that is a function is a view plugin's, which a stateless read cannot resolve
 * and this field never contributes.
 */
function volatileRanges(state: EditorState): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    const iter = source.iter();
    while (iter.value !== null) {
      ranges.push([iter.from, iter.to]);
      iter.next();
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// The two regions, over an empty document
// ---------------------------------------------------------------------------

describe("a session over an empty document", () => {
  test("volatile writes the tail and decorates exactly it", () => {
    let state = apply(makeState(""), { kind: "begin" });
    expect(span(state)).toEqual({ from: 0, committedTo: 0, to: 0, padPending: false });

    state = apply(state, { kind: "volatile", text: "hel" });
    expect(state.doc.toString()).toBe("hel");
    expect(span(state)).toEqual({ from: 0, committedTo: 0, to: 3, padPending: false });
    expect(volatileRanges(state)).toEqual([[0, 3]]);
  });

  test("a second volatile replaces the tail rather than appending to it", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "hel" });
    state = apply(state, { kind: "volatile", text: "hello" });
    expect(state.doc.toString()).toBe("hello");
    expect(span(state)).toEqual({ from: 0, committedTo: 0, to: 5, padPending: false });
    expect(volatileRanges(state)).toEqual([[0, 5]]);
  });

  test("final settles the tail and leaves nothing decorated", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "hello" });
    state = apply(state, { kind: "final", text: "hello world" });
    expect(state.doc.toString()).toBe("hello world");
    const value = span(state);
    expect(value?.committedTo).toBe(11);
    expect(value?.to).toBe(11);
    expect(volatileRanges(state)).toEqual([]);
  });

  test("end closes the session and leaves settled text where it is", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "hello" });
    state = apply(state, { kind: "final", text: "hello world" });
    state = apply(state, { kind: "end", promote: false });
    expect(state.doc.toString()).toBe("hello world");
    expect(span(state)).toBeNull();
  });

  test("the caret rides the tail", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "hel" });
    expect(state.selection.main.head).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// [P08] — where the first write lands
// ---------------------------------------------------------------------------

describe("the first write onto a non-empty draft ([P08])", () => {
  test("a caret at the end of the draft pads onto its own line", () => {
    let state = apply(makeState("draft", 5), { kind: "begin" });
    expect(span(state)?.padPending).toBe(true);

    state = apply(state, { kind: "volatile", text: "more" });
    expect(state.doc.toString()).toBe("draft\nmore");
    // `from` is past the newline: the padding is not the session's text, which
    // is what lets it survive `end()`.
    expect(span(state)).toEqual({ from: 6, committedTo: 6, to: 10, padPending: false });
    expect(volatileRanges(state)).toEqual([[6, 10]]);
  });

  test("a caret mid-draft inserts plainly, with no newline", () => {
    let state = apply(makeState("draft", 2), { kind: "begin" });
    expect(span(state)?.padPending).toBe(false);

    state = apply(state, { kind: "volatile", text: "more" });
    expect(state.doc.toString()).toBe("drmoreaft");
    expect(span(state)).toEqual({ from: 2, committedTo: 2, to: 6, padPending: false });
    expect(volatileRanges(state)).toEqual([[2, 6]]);
  });

  test("the padding is paid once — a second volatile does not re-pad", () => {
    let state = apply(makeState("draft", 5), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "more" });
    state = apply(state, { kind: "volatile", text: "more text" });
    expect(state.doc.toString()).toBe("draft\nmore text");
    expect(span(state)).toEqual({ from: 6, committedTo: 6, to: 15, padPending: false });
  });

  test("the padding survives end, and only the tail goes", () => {
    let state = apply(makeState("draft", 5), { kind: "begin" });
    state = apply(state, { kind: "final", text: "more" });
    state = apply(state, { kind: "end", promote: false });
    expect(state.doc.toString()).toBe("draft\nmore");
  });
});

// ---------------------------------------------------------------------------
// The tail is dropped or promoted, as the end says
// ---------------------------------------------------------------------------

describe("an end that drops the provisional tail", () => {
  test("a pending volatile goes and the settled text stays", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "final", text: "a" });
    state = apply(state, { kind: "volatile", text: "b" });
    expect(state.doc.toString()).toBe("ab");

    state = apply(state, { kind: "end", promote: false });
    expect(state.doc.toString()).toBe("a");
    expect(span(state)).toBeNull();
  });

  test("end with no tail writes no change at all", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "final", text: "a" });
    const spec = dictationSpanTransaction(state, { kind: "end", promote: false });
    expect(spec).not.toBeNull();
    expect((spec as TransactionSpec).changes).toBeUndefined();
  });
});

describe("an end that promotes the provisional tail", () => {
  test("the tail stays in the document as ordinary text", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "final", text: "a" });
    state = apply(state, { kind: "volatile", text: "b" });
    expect(state.doc.toString()).toBe("ab");

    state = apply(state, { kind: "end", promote: true });
    expect(state.doc.toString()).toBe("ab");
    expect(span(state)).toBeNull();
  });

  test("promoting writes no change at all — the bytes are already right", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "final", text: "a" });
    state = apply(state, { kind: "volatile", text: "b" });
    const spec = dictationSpanTransaction(state, { kind: "end", promote: true });
    expect(spec).not.toBeNull();
    expect((spec as TransactionSpec).changes).toBeUndefined();
  });

  test("the promoted tail loses its dimming with the span", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "hello" });
    expect(span(state)).not.toBeNull();

    state = apply(state, { kind: "end", promote: true });
    // The dimming is provided from the field, so a null field is a document
    // with no `tug-dictation-volatile` mark left anywhere in it.
    expect(span(state)).toBeNull();
    expect(state.doc.toString()).toBe("hello");
  });

  test("promoting with no tail is the same no-change close as dropping", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "final", text: "a" });
    const spec = dictationSpanTransaction(state, { kind: "end", promote: true });
    expect(spec).not.toBeNull();
    expect((spec as TransactionSpec).changes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The span survives edits it did not make
// ---------------------------------------------------------------------------

describe("an unrelated edit", () => {
  test("maps the span forward, and the next volatile writes at the new place", () => {
    let state = apply(makeState(""), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "hel" });

    // Somebody types ahead of the span. Nothing dictation dispatched.
    state = state.update({ changes: { from: 0, insert: "xx" } }).state;
    expect(state.doc.toString()).toBe("xxhel");
    expect(span(state)).toEqual({ from: 2, committedTo: 2, to: 5, padPending: false });

    state = apply(state, { kind: "volatile", text: "hello" });
    expect(state.doc.toString()).toBe("xxhello");
    expect(span(state)).toEqual({ from: 2, committedTo: 2, to: 7, padPending: false });
  });

  test("a caret the user moved out of the span stays where they put it", () => {
    let state = apply(makeState("draft", 2), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "more" });
    // The user clicks at the very end of the document, outside [2, 6].
    state = state.update({ selection: EditorSelection.cursor(9) }).state;

    state = apply(state, { kind: "volatile", text: "more text" });
    // Still after "aft", which is now at 14 because the tail grew ahead of it —
    // that is the caret keeping its place, not losing it. What must not happen
    // is the caret being dragged to the tail's end.
    expect(state.doc.toString()).toBe("drmore textaft");
    expect(state.selection.main.head).toBe(state.doc.length);
    expect(state.selection.main.head).not.toBe(span(state)?.to);
  });
});

// ---------------------------------------------------------------------------
// An action with no session
// ---------------------------------------------------------------------------

describe("an action outside a session", () => {
  test("volatile, final and end all decline", () => {
    const state = makeState("draft");
    expect(dictationSpanTransaction(state, { kind: "volatile", text: "x" })).toBeNull();
    expect(dictationSpanTransaction(state, { kind: "final", text: "x" })).toBeNull();
    expect(dictationSpanTransaction(state, { kind: "end", promote: false })).toBeNull();
  });

  test("a handle with no view is a no-op rather than a throw", () => {
    const handle = dictationHandleFor(() => null);
    expect(() => {
      handle.begin();
      handle.volatile("x");
      handle.final("x");
      handle.end(false);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [P10] — the stamp, as a table
// ---------------------------------------------------------------------------

describe("every transaction carries the [P10] stamp", () => {
  test("all four actions, read off the spec", () => {
    // A state with a session already open, so each of the four builders runs.
    let state = apply(makeState("draft", 2), { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "more" });

    const cases: Array<[string, TransactionSpec]> = [
      ["begin", dictationSpanTransaction(makeState("draft", 2), { kind: "begin" })!],
      ["volatile", dictationSpanTransaction(state, { kind: "volatile", text: "m" })!],
      ["final", dictationSpanTransaction(state, { kind: "final", text: "m" })!],
      ["end drop", dictationSpanTransaction(state, { kind: "end", promote: false })!],
      ["end promote", dictationSpanTransaction(state, { kind: "end", promote: true })!],
    ];

    for (const [name, spec] of cases) {
      expect(spec, name).not.toBeNull();
      expect(spec.userEvent, name).toBe("input.tug-dictation");
      const annotations = spec.annotations;
      const one = Array.isArray(annotations) ? annotations[0] : annotations;
      expect(one?.type, name).toBe(suppressCompletionDetection);
      expect(one?.value, name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// [P10] — the defect itself
// ---------------------------------------------------------------------------

/** A trivial synchronous `/` provider that always offers one item. */
const slashProvider: CompletionProvider = (_query: string): CompletionItem[] => [
  {
    label: "permissions",
    atom: { kind: "atom", type: "command", label: "permissions", value: "permissions" },
  },
];

describe("a dictated trigger character does not open the typeahead ([P10])", () => {
  test("volatile('/hel') leaves the completion session inactive", () => {
    const base = EditorState.create({
      doc: "draft",
      selection: EditorSelection.cursor(5),
      extensions: [
        dictationSpanExtension,
        tugCompletionExt(() => ({ "/": slashProvider })),
      ],
    });

    let state = apply(base, { kind: "begin" });
    state = apply(state, { kind: "volatile", text: "/hel" });

    expect(state.doc.toString()).toBe("draft\n/hel");
    expect(state.field(completionField).active).toBe(false);
  });

  test("the same insert WITHOUT the stamp is what would have opened it", () => {
    // The baseline that makes the claim above mean something: a plain insert of
    // the same text at the same place does reopen the popup, which is the
    // Rejoin rule doing exactly what it is for.
    const base = EditorState.create({
      doc: "draft",
      selection: EditorSelection.cursor(5),
      extensions: [
        dictationSpanExtension,
        tugCompletionExt(() => ({ "/": slashProvider })),
      ],
    });

    const state = base.update({
      changes: { from: 5, insert: "\n/hel" },
      selection: EditorSelection.cursor(10),
      userEvent: "input.type",
    }).state;

    expect(state.field(completionField).active).toBe(true);
  });
});
