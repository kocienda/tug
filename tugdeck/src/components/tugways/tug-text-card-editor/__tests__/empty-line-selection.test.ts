/**
 * Which blank lines a selection covers.
 *
 * Native `::selection` paints nothing on a blank line, so the File card marks
 * the selected ones itself. The rule is pinned here: a blank line is selected
 * when the range covers its line break — so a range ending exactly at the
 * line's start selects none of it.
 */

import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";

import { selectedEmptyLineStarts } from "../empty-line-selection";

// Line starts: "one"=0, ""=4, "three"=5, ""=11, "five"=12
const DOC = "one\n\nthree\n\nfive";

function starts(anchor: number, head: number, doc = DOC): number[] {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
  });
  return selectedEmptyLineStarts(state, [{ from: 0, to: state.doc.length }]);
}

describe("selectedEmptyLineStarts", () => {
  test("a caret marks nothing", () => {
    expect(starts(4, 4)).toEqual([]);
  });

  test("a whole-document selection marks every blank line", () => {
    expect(starts(0, DOC.length)).toEqual([4, 11]);
  });

  test("a backward selection marks the same lines", () => {
    expect(starts(DOC.length, 0)).toEqual([4, 11]);
  });

  test("a range ending at a blank line's start does not mark it", () => {
    expect(starts(0, 4)).toEqual([]);
  });

  test("a range starting at a blank line marks it", () => {
    expect(starts(4, 8)).toEqual([4]);
  });

  test("lines outside the visible ranges are not marked", () => {
    const state = EditorState.create({
      doc: DOC,
      selection: EditorSelection.single(0, DOC.length),
    });
    expect(selectedEmptyLineStarts(state, [{ from: 5, to: DOC.length }])).toEqual([11]);
  });

  test("a trailing blank line the range reaches but does not cross is unmarked", () => {
    expect(starts(0, 4, "one\n")).toEqual([]);
  });
});
