/**
 * capture-substrate.test.ts — what an editing surface reports about itself.
 *
 * `captureSubstrate` is the seam every message field now mirrors through
 * ([B04]): the document text with a `U+FFFC` at each atom's spot, AND the
 * parallel list saying what stands there. The old mirror handed out
 * `doc.toString()` alone, which is the same text with every chip in it reduced
 * to an anonymous placeholder — a host could not have kept its atoms even if it
 * wanted to, which is why a chip pasted into a Jot, a question answer or a
 * commit message was already lost by the time the host saw the edit.
 *
 * Pure over an `EditorState`: no view, no DOM, no scroll. That is what lets an
 * `updateListener` call it on every keystroke, and what lets this file assert
 * on it without rendering anything.
 */

import { test, expect, describe } from "bun:test";
import { EditorState, Transaction } from "@codemirror/state";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import {
  atomDecorationField,
  atomInvertedEffects,
  addAtomsEffect,
} from "./atom-decoration";
import { captureSubstrate } from "./keymap";

function emptyEditor(): EditorState {
  return EditorState.create({
    doc: "",
    extensions: [atomDecorationField, atomInvertedEffects],
  });
}

/**
 * The transaction shape `insertMixedAt` dispatches: one change carrying the
 * interleaved text and placeholders, one `addAtomsEffect` naming where the
 * atoms stand.
 */
function insertMixed(
  state: EditorState,
  items: ReadonlyArray<{ text: string } | { atom: AtomSegment }>,
): EditorState {
  let insert = "";
  const positioned: Array<{ position: number; segment: AtomSegment }> = [];
  for (const item of items) {
    if ("atom" in item) {
      positioned.push({ position: insert.length, segment: item.atom });
      insert += TUG_ATOM_CHAR;
    } else {
      insert += item.text;
    }
  }
  return state.update({
    changes: { from: 0, insert },
    effects: addAtomsEffect.of(positioned),
    userEvent: "input.paste",
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

const FILE_ATOM: AtomSegment = {
  kind: "atom",
  type: "file",
  label: "atom-text.ts",
  value: "tugdeck/src/lib/atom-text.ts",
};

const IMAGE_ATOM: AtomSegment = {
  kind: "atom",
  type: "image",
  label: "shot.png",
  value: "shot.png",
  id: "1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33",
};

describe("captureSubstrate reports both halves", () => {
  test("plain prose reports its text and no atoms", () => {
    const state = insertMixed(emptyEditor(), [{ text: "just words" }]);
    expect(captureSubstrate(state)).toEqual({ text: "just words", atoms: [] });
  });

  test("an atom is reported with its identity and its position", () => {
    const state = insertMixed(emptyEditor(), [
      { text: "see " },
      { atom: FILE_ATOM },
      { text: " for the table" },
    ]);
    const substrate = captureSubstrate(state);
    // The text is what it always was — the placeholder is still in it.
    expect(substrate.text).toBe(`see ${TUG_ATOM_CHAR} for the table`);
    // And this is the half the old mirror threw away.
    expect(substrate.atoms).toEqual([
      {
        position: 4,
        type: "file",
        label: "atom-text.ts",
        value: "tugdeck/src/lib/atom-text.ts",
      },
    ]);
    expect(substrate.text.indexOf(TUG_ATOM_CHAR)).toBe(
      substrate.atoms[0]!.position,
    );
  });

  test("an image atom keeps its bytes-store id", () => {
    // Without the id the restored chip is severed from its bytes: it renders
    // as a placeholder and a re-submit ships no image.
    const state = insertMixed(emptyEditor(), [{ atom: IMAGE_ATOM }]);
    expect(captureSubstrate(state).atoms[0]!.id).toBe(IMAGE_ATOM.id);
  });

  test("an atom with no id claims none rather than an undefined key", () => {
    const state = insertMixed(emptyEditor(), [{ atom: FILE_ATOM }]);
    expect("id" in captureSubstrate(state).atoms[0]!).toBe(false);
  });

  test("several atoms come back in document order, positions aligned", () => {
    const state = insertMixed(emptyEditor(), [
      { atom: FILE_ATOM },
      { text: " and " },
      { atom: IMAGE_ATOM },
    ]);
    const { text, atoms } = captureSubstrate(state);
    expect(atoms.map((a) => a.type)).toEqual(["file", "image"]);
    for (const atom of atoms) {
      expect(text.charAt(atom.position)).toBe(TUG_ATOM_CHAR);
    }
  });

  test("an edit above an atom moves its reported position with it", () => {
    // The decoration set is mapped through the change, so the report is read
    // off the live state rather than off whatever the atom's position was when
    // it was inserted — the reason the mirror can call this per keystroke.
    const seeded = insertMixed(emptyEditor(), [{ atom: FILE_ATOM }]);
    const typed = seeded.update({
      changes: { from: 0, insert: "see " },
      userEvent: "input.type",
    }).state;
    const { text, atoms } = captureSubstrate(typed);
    expect(atoms[0]!.position).toBe(4);
    expect(text.charAt(atoms[0]!.position)).toBe(TUG_ATOM_CHAR);
  });
});
