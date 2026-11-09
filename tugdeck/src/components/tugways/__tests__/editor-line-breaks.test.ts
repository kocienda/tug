/**
 * Tests for editor-line-breaks — the pure halves of Add and Remove Line
 * Breaks. Where the view wraps is layout, so `softWrapBreaks` is exercised
 * by the real-app test; here Add is given its break points as data.
 *
 * Covers:
 * - removeLineBreaksSpec — each selected paragraph joined with one space,
 *   blank lines kept, the whitespace at a join folded, a caret widened to its
 *   paragraph, a one-line paragraph a no-op
 * - addLineBreaksSpec — a newline at each break, the hanging whitespace
 *   dropped, breaks at a line's edge ignored
 * - both — null on a read-only document
 */
import { describe, it, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { addLineBreaksSpec, removeLineBreaksSpec } from "../editor-line-breaks";

function stateWith(doc: string, selection: EditorSelection, readOnly = false): EditorState {
  return EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)],
  });
}

function apply(state: EditorState, spec: ReturnType<typeof removeLineBreaksSpec>): EditorState {
  if (spec === null) throw new Error("expected a transaction");
  return state.update(spec).state;
}

describe("removeLineBreaksSpec", () => {
  it("joins each selected paragraph and keeps the blank line between them", () => {
    const doc = "one\ntwo\n\nthree\nfour";
    const state = stateWith(doc, EditorSelection.single(0, doc.length));
    expect(apply(state, removeLineBreaksSpec(state)).doc.toString()).toBe("one two\n\nthree four");
  });

  it("folds the whitespace on either side of a join into one space", () => {
    const doc = "one  \n   two";
    const state = stateWith(doc, EditorSelection.single(0, doc.length));
    expect(apply(state, removeLineBreaksSpec(state)).doc.toString()).toBe("one two");
  });

  it("joins only the touched lines of a ranged selection", () => {
    const doc = "a\nb\nc\nd";
    // From inside `b` to inside `c`: b and c join, a and d stay.
    const state = stateWith(doc, EditorSelection.single(2, 5));
    expect(apply(state, removeLineBreaksSpec(state)).doc.toString()).toBe("a\nb c\nd");
  });

  it("widens a bare caret to its whole paragraph", () => {
    const doc = "x\n\none\ntwo\nthree\n\ny";
    const state = stateWith(doc, EditorSelection.single(doc.indexOf("two") + 1));
    expect(apply(state, removeLineBreaksSpec(state)).doc.toString()).toBe("x\n\none two three\n\ny");
  });

  it("is a no-op on a one-line paragraph, and on a read-only document", () => {
    expect(removeLineBreaksSpec(stateWith("solo\n\nother", EditorSelection.single(1)))).toBeNull();
    expect(removeLineBreaksSpec(stateWith("a\nb", EditorSelection.single(0, 3), true))).toBeNull();
  });
});

describe("addLineBreaksSpec", () => {
  it("puts a newline at each break and drops the whitespace the wrap hung", () => {
    // Wrapped as "the quick " | "brown fox " | "jumps": breaks at the starts
    // of the continuation lines.
    const doc = "the quick brown fox jumps";
    const state = stateWith(doc, EditorSelection.single(0));
    const breaks = [doc.indexOf("brown"), doc.indexOf("jumps")];
    expect(apply(state, addLineBreaksSpec(state, breaks)).doc.toString()).toBe(
      "the quick\nbrown fox\njumps",
    );
  });

  it("ignores a break at a line's edge, and is null with nothing to add", () => {
    const state = stateWith("abc\ndef", EditorSelection.single(0));
    expect(addLineBreaksSpec(state, [0, 3, 4])).toBeNull();
    expect(addLineBreaksSpec(state, [])).toBeNull();
  });

  it("is null on a read-only document", () => {
    const doc = "the quick brown";
    const state = stateWith(doc, EditorSelection.single(0), true);
    expect(addLineBreaksSpec(state, [doc.indexOf("brown")])).toBeNull();
  });
});
