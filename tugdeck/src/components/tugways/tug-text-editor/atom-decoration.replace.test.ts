/**
 * atom-decoration.replace.test.ts — an atom whose U+FFFC a change takes is
 * gone, whatever the change put in its place.
 *
 * The case that broke was a paste of one atom over a selected chip: the
 * change replaces one U+FFFC with one U+FFFC, so the old decoration mapped
 * onto the new character instead of collapsing, and stood there beside the
 * pasted atom — the old chip still drawn, the paste apparently ignored.
 * Plain text over the chip worked only because its length differs.
 */

import { test, expect } from "bun:test";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { addAtomsEffect, atomDecorationField, atomInvertedEffects } from "./atom-decoration";

const FILE: AtomSegment = { kind: "atom", type: "file", label: "lone.ts", value: "/path/to/lone.ts" };
const SESSION: AtomSegment = { kind: "atom", type: "session", label: "tug/bold-sole", value: "bold-sole" };

/** The atoms' types and positions, in document order. */
function atoms(state: EditorState): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  state.field(atomDecorationField).between(0, state.doc.length, (from, _to, value) => {
    out.push([from, (value.spec as { widget: { segment: AtomSegment } }).widget.segment.type]);
  });
  return out;
}

/** A composer holding nothing but a file chip, selected. */
function loneChipSelected(): EditorState {
  const seeded = EditorState.create({
    doc: "",
    extensions: [history(), atomDecorationField, atomInvertedEffects],
  }).update({
    changes: { from: 0, insert: TUG_ATOM_CHAR },
    effects: addAtomsEffect.of([{ position: 0, segment: FILE }]),
    annotations: Transaction.addToHistory.of(false),
  }).state;
  return seeded.update({ selection: EditorSelection.range(0, 1) }).state;
}

/** What `insertSidecar` dispatches for a one-atom paste over the selection. */
function pasteAtom(state: EditorState, segment: AtomSegment): EditorState {
  const { from, to } = state.selection.main;
  return state.update({
    changes: { from, to, insert: TUG_ATOM_CHAR },
    effects: addAtomsEffect.of([{ position: from, segment }]),
    selection: { anchor: from + 1 },
    userEvent: "input.paste",
  }).state;
}

test("an atom pasted over a selected chip replaces it", () => {
  const next = pasteAtom(loneChipSelected(), SESSION);
  expect(next.doc.toString()).toBe(TUG_ATOM_CHAR);
  expect(atoms(next)).toEqual([[0, "session"]]);
});

test("undoing the paste brings the replaced chip back, alone", () => {
  let restored = pasteAtom(loneChipSelected(), SESSION);
  undo({ state: restored, dispatch: (tr) => (restored = tr.state) });
  expect(restored.doc.toString()).toBe(TUG_ATOM_CHAR);
  expect(atoms(restored)).toEqual([[0, "file"]]);
});

test("text typed beside a chip leaves it standing", () => {
  const state = loneChipSelected();
  const before = state.update({ changes: { from: 0, insert: "a" } }).state;
  const after = state.update({ changes: { from: 1, insert: "b" } }).state;
  expect(atoms(before)).toEqual([[1, "file"]]);
  expect(atoms(after)).toEqual([[0, "file"]]);
});
