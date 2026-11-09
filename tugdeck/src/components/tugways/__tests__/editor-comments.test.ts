/**
 * Tests for editor-comments — Un/Comment Lines and Un/Comment Block over the
 * real CM6 languages the editors load.
 *
 * Covers:
 * - Rust — a line comment on every touched line and off again; a block
 *   comment wrapped around the selection
 * - Markdown — no line comment (the spec is null and the gate is false), a
 *   block comment of `<!-- -->`
 * - no language — neither command has tokens
 * - read-only — both specs are null
 */
import { describe, it, expect } from "bun:test";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import {
  hasBlockComment,
  hasLineComment,
  toggleBlockCommentSpec,
  toggleLineCommentSpec,
} from "../editor-comments";

function stateWith(
  doc: string,
  selection: EditorSelection,
  language: Extension,
  readOnly = false,
): EditorState {
  return EditorState.create({
    doc,
    selection,
    extensions: [language, EditorState.readOnly.of(readOnly)],
  });
}

function apply(state: EditorState, spec: ReturnType<typeof toggleLineCommentSpec>): EditorState {
  if (spec === null) throw new Error("expected a transaction");
  return state.update(spec).state;
}

describe("Rust", () => {
  const doc = "let a = 1;\nlet b = 2;\nlet c = 3;";

  it("comments every touched line, and a second press uncomments them", () => {
    const state = stateWith(doc, EditorSelection.single(0, 15), rust());
    expect(hasLineComment(state)).toBe(true);
    const commented = apply(state, toggleLineCommentSpec(state));
    expect(commented.doc.toString()).toBe("// let a = 1;\n// let b = 2;\nlet c = 3;");
    const back = apply(commented, toggleLineCommentSpec(commented));
    expect(back.doc.toString()).toBe(doc);
  });

  it("wraps the selection in a block comment", () => {
    const state = stateWith(doc, EditorSelection.single(4, 9), rust());
    expect(hasBlockComment(state)).toBe(true);
    const next = apply(state, toggleBlockCommentSpec(state));
    expect(next.doc.toString()).toBe("let /* a = 1 */;\nlet b = 2;\nlet c = 3;");
  });
});

describe("Markdown", () => {
  const doc = "# Title\n\nSome text.";

  it("has no line comment, so Un/Comment Lines has nothing to do", () => {
    const state = stateWith(doc, EditorSelection.single(9, 19), markdown());
    expect(hasLineComment(state)).toBe(false);
    expect(toggleLineCommentSpec(state)).toBeNull();
  });

  it("wraps the selection in an HTML comment", () => {
    const state = stateWith(doc, EditorSelection.single(9, 19), markdown());
    expect(hasBlockComment(state)).toBe(true);
    const next = apply(state, toggleBlockCommentSpec(state));
    expect(next.doc.toString()).toBe("# Title\n\n<!-- Some text. -->");
  });
});

describe("no language and read-only", () => {
  it("offers neither command with no language loaded", () => {
    const state = stateWith("plain", EditorSelection.single(0, 5), []);
    expect(hasLineComment(state)).toBe(false);
    expect(hasBlockComment(state)).toBe(false);
    expect(toggleLineCommentSpec(state)).toBeNull();
    expect(toggleBlockCommentSpec(state)).toBeNull();
  });

  it("returns null on a read-only document", () => {
    const state = stateWith("let a = 1;", EditorSelection.single(0, 10), rust(), true);
    expect(toggleLineCommentSpec(state)).toBeNull();
    expect(toggleBlockCommentSpec(state)).toBeNull();
  });
});
