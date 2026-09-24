/**
 * drop-extension.test.ts — what the two drop doors write at the drop point.
 *
 * `mixedInsertSpec` and `substrateInsertSpec` are the pure halves of
 * `insertMixedAt` and `insertSubstrateAt`: state + position + run → the one
 * transaction the dispatcher sends. Splitting them out is what lets the
 * padding decision be asserted on the real transaction rather than on a
 * mirror of its shape — no view, no DOM, no DragEvent.
 */

import { test, expect, describe } from "bun:test";
import { EditorState } from "@codemirror/state";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import { atomDecorationField, atomInvertedEffects } from "./atom-decoration";
import {
  mixedInsertSpec,
  substrateInsertSpec,
  type DropMixedItem,
} from "./drop-extension";

const A = TUG_ATOM_CHAR;

const FILE_ATOM: AtomSegment = {
  kind: "atom",
  type: "file",
  label: "atom-text.ts",
  value: "tugdeck/src/lib/atom-text.ts",
};

const OTHER_ATOM: AtomSegment = {
  kind: "atom",
  type: "file",
  label: "smart-insert.ts",
  value: "tugdeck/src/components/tugways/tug-text-editor/smart-insert.ts",
};

function editor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [atomDecorationField, atomInvertedEffects],
  });
}

/** Apply a spec and report the document, the caret, and the atom spots. */
function applied(
  state: EditorState,
  spec: ReturnType<typeof mixedInsertSpec>,
): { doc: string; caret: number; atoms: number[] } {
  if (spec === null) throw new Error("applied(): the spec was null");
  const next = state.update(spec).state;
  const atoms: number[] = [];
  const cursor = next.field(atomDecorationField).iter();
  while (cursor.value !== null) {
    atoms.push(cursor.from);
    cursor.next();
  }
  return {
    doc: next.doc.toString(),
    caret: next.selection.main.head,
    atoms,
  };
}

const ATOM_ITEM: DropMixedItem = { kind: "atom", segment: FILE_ATOM };

describe("mixedInsertSpec pads its outer edges", () => {
  test("a drop into the middle of a word gets air on both sides", () => {
    const state = editor("foobar");
    expect(applied(state, mixedInsertSpec(state, 3, [ATOM_ITEM]))).toEqual({
      doc: `foo ${A} bar`,
      caret: 6,
      atoms: [4],
    });
  });

  test("a drop at a line's end pads only the side with text on it", () => {
    const state = editor("foo\nbar");
    expect(applied(state, mixedInsertSpec(state, 3, [ATOM_ITEM]))).toEqual({
      doc: `foo ${A}\nbar`,
      caret: 5,
      atoms: [4],
    });
  });

  test("a drop after a space pads only its trailing side", () => {
    const state = editor("foo bar");
    expect(applied(state, mixedInsertSpec(state, 4, [ATOM_ITEM]))).toEqual({
      doc: `foo ${A} bar`,
      caret: 6,
      atoms: [4],
    });
  });

  test("the interior single-space join is left alone", () => {
    const state = editor("foobar");
    const items: DropMixedItem[] = [
      ATOM_ITEM,
      { kind: "text", text: "notes.md" },
      { kind: "atom", segment: OTHER_ATOM },
    ];
    expect(applied(state, mixedInsertSpec(state, 3, items))).toEqual({
      doc: `foo ${A} notes.md ${A} bar`,
      caret: 17,
      atoms: [4, 15],
    });
  });

  test("an empty item list writes nothing", () => {
    expect(mixedInsertSpec(editor("foobar"), 3, [])).toBeNull();
  });
});

describe("substrateInsertSpec pads only its outer edges", () => {
  test("a carried substrate lands welded to nothing", () => {
    const state = editor("foobar");
    const spec = substrateInsertSpec(state, 3, `see ${A} here`, [FILE_ATOM]);
    expect(applied(state, spec)).toEqual({
      doc: `foo see ${A} here bar`,
      caret: 15,
      atoms: [8],
    });
  });

  test("the substrate's own interior spacing is untouched", () => {
    const state = editor("");
    const spec = substrateInsertSpec(state, 0, `a\n\nb  c`, []);
    expect(applied(state, spec)).toEqual({
      doc: "a\n\nb  c",
      caret: 7,
      atoms: [],
    });
  });

  test("a substrate leading with a newline keeps its own leading air", () => {
    const state = editor("prior");
    const spec = substrateInsertSpec(state, 5, `\n${A}`, [FILE_ATOM]);
    expect(applied(state, spec)).toEqual({
      doc: `prior\n${A}`,
      caret: 7,
      atoms: [6],
    });
  });

  test("an empty substrate writes nothing", () => {
    expect(substrateInsertSpec(editor("foobar"), 3, "", [])).toBeNull();
  });
});
