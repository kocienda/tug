/**
 * Tests for editor-gremlins — Zap Gremlins.
 *
 * Covers:
 * - zapGremlinsSpec — control and zero-width characters deleted, tab and
 *   newline kept, no-break and other Unicode spaces made plain, the whole
 *   document when the selection is empty, only the selected text when it is
 *   not, one undoable transaction; null on a read-only document or when
 *   there is nothing to zap
 */
import { describe, it, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { undo, history } from "@codemirror/commands";
import { zapGremlinsSpec } from "../editor-gremlins";

function stateWith(doc: string, selection = EditorSelection.single(0), readOnly = false): EditorState {
  return EditorState.create({
    doc,
    selection,
    extensions: [
      history(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(readOnly),
    ],
  });
}

function zap(state: EditorState): EditorState {
  const spec = zapGremlinsSpec(state);
  if (spec === null) throw new Error("expected a transaction");
  return state.update(spec).state;
}

describe("zapGremlinsSpec", () => {
  it("deletes control and zero-width characters, keeping tab and newline", () => {
    const doc = "a\u0000b\u0007c\td\u001Be\u007Ff\u0085g\nh​i‌j‍k⁠l﻿m";
    expect(zap(stateWith(doc)).doc.toString()).toBe("abc\tdefg\nhijklm");
  });

  it("makes no-break and other Unicode spaces a plain space", () => {
    const doc = "a b c d e f　g h";
    expect(zap(stateWith(doc)).doc.toString()).toBe("a b c d e f g h");
  });

  it("acts on the selected text only when there is a selection", () => {
    const doc = "a b|c d";
    const state = stateWith(doc, EditorSelection.single(4, doc.length));
    expect(zap(state).doc.toString()).toBe("a b|c d");
  });

  it("is one transaction, so one undo restores the text", () => {
    const doc = "x​y z";
    const zapped = zap(stateWith(doc));
    let restored = zapped;
    undo({ state: zapped, dispatch: (tr) => (restored = tr.state) });
    expect(restored.doc.toString()).toBe(doc);
  });

  it("is null with nothing to zap, and on a read-only document", () => {
    expect(zapGremlinsSpec(stateWith("plain\ttext\n"))).toBeNull();
    expect(zapGremlinsSpec(stateWith("a​b", EditorSelection.single(0), true))).toBeNull();
  });
});
