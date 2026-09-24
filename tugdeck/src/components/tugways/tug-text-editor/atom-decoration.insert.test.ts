/**
 * atom-decoration.insert.test.ts — what the atom picker writes at the caret.
 *
 * `atomInsertSpec` is the pure half of `insertAtomAt` and
 * `insertAtomAtSelection`: state + range → the one transaction both
 * dispatch. Asserting on it exercises the real padding decision headlessly,
 * with the selection case measured against the characters outside the
 * replaced range ([B08]).
 */

import { test, expect, describe } from "bun:test";
import { EditorState } from "@codemirror/state";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import {
  atomDecorationField,
  atomInvertedEffects,
  atomInsertSpec,
} from "./atom-decoration";

const A = TUG_ATOM_CHAR;

const FILE_ATOM: AtomSegment = {
  kind: "atom",
  type: "file",
  label: "atom-text.ts",
  value: "tugdeck/src/lib/atom-text.ts",
};

function editor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [atomDecorationField, atomInvertedEffects],
  });
}

function inserted(
  doc: string,
  from: number,
  to: number = from,
): { doc: string; caret: number; atoms: number[] } {
  const state = editor(doc);
  const next = state.update(atomInsertSpec(state, from, to, FILE_ATOM)).state;
  const atoms: number[] = [];
  const cursor = next.field(atomDecorationField).iter();
  while (cursor.value !== null) {
    atoms.push(cursor.from);
    cursor.next();
  }
  return { doc: next.doc.toString(), caret: next.selection.main.head, atoms };
}

describe("atomInsertSpec at a caret", () => {
  test("an empty document takes the chip bare", () => {
    expect(inserted("", 0)).toEqual({ doc: A, caret: 1, atoms: [0] });
  });

  test("a chip picked mid-word gets air on both sides", () => {
    expect(inserted("foobar", 3)).toEqual({
      doc: `foo ${A} bar`,
      caret: 6,
      atoms: [4],
    });
  });

  test("a chip picked after an opener stays tight", () => {
    expect(inserted("--paths=", 8)).toEqual({
      doc: `--paths=${A}`,
      caret: 9,
      atoms: [8],
    });
  });

  test("a chip picked before a period keeps the sentence intact", () => {
    expect(inserted("see .", 4)).toEqual({
      doc: `see ${A}.`,
      caret: 5,
      atoms: [4],
    });
  });

  test("a chip picked against another chip gets air between them", () => {
    // The seed U+FFFC carries no decoration of its own — this doc is built
    // as text, so only the picked chip reports a spot.
    expect(inserted(A, 1)).toEqual({
      doc: `${A} ${A}`,
      caret: 3,
      atoms: [2],
    });
  });
});

describe("atomInsertSpec over a selection", () => {
  test("the padding reads outside the replaced range", () => {
    expect(inserted("fooXXXbar", 3, 6)).toEqual({
      doc: `foo ${A} bar`,
      caret: 6,
      atoms: [4],
    });
  });

  test("a selection already surrounded by air takes the chip bare", () => {
    expect(inserted("foo XXX bar", 4, 7)).toEqual({
      doc: `foo ${A} bar`,
      caret: 5,
      atoms: [4],
    });
  });

  test("a selection running to the document's end pads only its front", () => {
    expect(inserted("fooXXX", 3, 6)).toEqual({
      doc: `foo ${A}`,
      caret: 5,
      atoms: [4],
    });
  });
});
