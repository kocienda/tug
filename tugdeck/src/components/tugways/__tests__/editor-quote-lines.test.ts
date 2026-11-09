/**
 * Tests for editor-quote-lines — the Increase / Decrease Quote Level and
 * Strip Quotes line transforms.
 *
 * Covers:
 * - increaseQuoteLevelSpec — per-line prefix, blank lines as a bare `>`, nesting,
 *   a caret acting on its own line, a column-0 end not catching the next
 *   line, the selection growing over the prefixes, multiple ranges
 * - decreaseQuoteLevelSpec — one level removed, indent and the optional space
 *   consumed, unquoted lines untouched, no-op when nothing is quoted
 * - stripQuotesSpec — every level removed, unquoted lines untouched, no-op
 *   when nothing is quoted
 * - all three — null on a read-only document
 */
import { describe, it, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  increaseQuoteLevelSpec,
  decreaseQuoteLevelSpec,
  stripQuotesSpec,
} from "../editor-quote-lines";

function stateWith(doc: string, selection: EditorSelection, readOnly = false) {
  return EditorState.create({
    doc,
    selection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(readOnly),
    ],
  });
}

function apply(
  state: EditorState,
  spec: ReturnType<typeof increaseQuoteLevelSpec>,
): EditorState {
  if (spec === null) throw new Error("expected a transaction");
  return state.update(spec).state;
}

describe("increaseQuoteLevelSpec", () => {
  it("quotes every selected line and keeps blank lines a bare '>'", () => {
    const state = stateWith("one\n\nthree", EditorSelection.single(0, 10));
    const next = apply(state, increaseQuoteLevelSpec(state));
    expect(next.doc.toString()).toBe("> one\n>\n> three");
  });

  it("nests an already quoted line", () => {
    const state = stateWith("> a", EditorSelection.single(0, 3));
    expect(apply(state, increaseQuoteLevelSpec(state)).doc.toString()).toBe("> > a");
  });

  it("quotes the caret's line and keeps the caret in its text", () => {
    const state = stateWith("one\ntwo\nthree", EditorSelection.single(5));
    const next = apply(state, increaseQuoteLevelSpec(state));
    expect(next.doc.toString()).toBe("one\n> two\nthree");
    expect(next.selection.main.head).toBe(7);
  });

  it("does not catch the line a selection ends at column 0 of", () => {
    const state = stateWith("one\ntwo\nthree", EditorSelection.single(0, 8));
    const next = apply(state, increaseQuoteLevelSpec(state));
    expect(next.doc.toString()).toBe("> one\n> two\nthree");
  });

  it("grows a line-start selection over the inserted prefixes", () => {
    const state = stateWith("one\ntwo", EditorSelection.single(0, 6));
    const next = apply(state, increaseQuoteLevelSpec(state));
    expect(next.doc.toString()).toBe("> one\n> two");
    expect(next.selection.main.from).toBe(0);
    expect(next.selection.main.to).toBe(10);
  });

  it("keeps a mid-line selection start on its text", () => {
    const state = stateWith("one\ntwo", EditorSelection.single(1, 6));
    const next = apply(state, increaseQuoteLevelSpec(state));
    expect(next.selection.main.from).toBe(3);
    expect(next.selection.main.to).toBe(10);
  });

  it("quotes each line once across multiple ranges", () => {
    const state = stateWith(
      "a\nb\nc",
      EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(1),
        EditorSelection.cursor(4),
      ]),
    );
    expect(apply(state, increaseQuoteLevelSpec(state)).doc.toString()).toBe(
      "> a\nb\n> c",
    );
  });

  it("is null on a read-only document", () => {
    const state = stateWith("a", EditorSelection.single(0), true);
    expect(increaseQuoteLevelSpec(state)).toBeNull();
  });
});

describe("decreaseQuoteLevelSpec", () => {
  it("removes one level from each quoted line", () => {
    const doc = "> > a\n>\n> b";
    const state = stateWith(doc, EditorSelection.single(0, doc.length));
    expect(apply(state, decreaseQuoteLevelSpec(state)).doc.toString()).toBe(
      "> a\n\nb",
    );
  });

  it("consumes up to three spaces of indent and a marker with no space", () => {
    const doc = "   >a\n    > code";
    const state = stateWith(doc, EditorSelection.single(0, doc.length));
    expect(apply(state, decreaseQuoteLevelSpec(state)).doc.toString()).toBe(
      "a\n    > code",
    );
  });

  it("leaves unquoted lines alone", () => {
    const doc = "> a\nb";
    const state = stateWith(doc, EditorSelection.single(0, doc.length));
    expect(apply(state, decreaseQuoteLevelSpec(state)).doc.toString()).toBe("a\nb");
  });

  it("round-trips Quote", () => {
    const doc = "one\n\nthree";
    const state = stateWith(doc, EditorSelection.single(0, doc.length));
    const quoted = apply(state, increaseQuoteLevelSpec(state));
    expect(apply(quoted, decreaseQuoteLevelSpec(quoted)).doc.toString()).toBe(doc);
  });

  it("is null when no touched line is quoted", () => {
    const state = stateWith("a\nb", EditorSelection.single(0, 3));
    expect(decreaseQuoteLevelSpec(state)).toBeNull();
  });

  it("is null on a read-only document", () => {
    const state = stateWith("> a", EditorSelection.single(0), true);
    expect(decreaseQuoteLevelSpec(state)).toBeNull();
  });
});

describe("stripQuotesSpec", () => {
  it("removes every quote level from each touched line", () => {
    const doc = "> > a\n>b\n  > > > c\nd";
    const state = stateWith(doc, EditorSelection.single(0, doc.length));
    expect(apply(state, stripQuotesSpec(state)).doc.toString()).toBe("a\nb\nc\nd");
  });

  it("acts on the caret's line only", () => {
    const doc = "> > a\n> > b";
    const state = stateWith(doc, EditorSelection.single(1));
    expect(apply(state, stripQuotesSpec(state)).doc.toString()).toBe("a\n> > b");
  });

  it("is null when no touched line is quoted, and on a read-only document", () => {
    expect(stripQuotesSpec(stateWith("a\nb", EditorSelection.single(0, 3)))).toBeNull();
    expect(stripQuotesSpec(stateWith("> a", EditorSelection.single(0), true))).toBeNull();
  });
});
