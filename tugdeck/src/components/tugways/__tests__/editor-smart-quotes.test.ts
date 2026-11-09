/**
 * Tests for editor-smart-quotes — Educate Quotes and Straighten Quotes.
 *
 * Covers:
 * - educateQuotesSpec — opening and closing double and single quotes, an
 *   apostrophe inside a word, a quote after a bracket or another opening
 *   quote, the whole document when the selection is empty, only the selected
 *   text when it is not
 * - straightenQuotesSpec — every curly form back to its straight one
 * - markdownCodeSpans — fenced blocks (closed, unclosed, quoted, tilde),
 *   inline spans of matching backtick runs, an unmatched run left literal
 * - both — Markdown code left untouched; null on a read-only document or
 *   when there is nothing to change; a round trip back to the original
 */
import { describe, it, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  educateQuotesSpec,
  markdownCodeSpans,
  straightenQuotesSpec,
} from "../editor-smart-quotes";

function stateWith(doc: string, selection = EditorSelection.single(0), readOnly = false): EditorState {
  return EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)],
  });
}

function apply(state: EditorState, spec: ReturnType<typeof educateQuotesSpec>): string {
  if (spec === null) throw new Error("expected a transaction");
  return state.update(spec).state.doc.toString();
}

const educate = (doc: string) => {
  const state = stateWith(doc);
  return apply(state, educateQuotesSpec(state));
};

describe("educateQuotesSpec", () => {
  it("curls double and single quotes by what they follow", () => {
    expect(educate(`He said "it's 'fine'" today.`)).toBe("He said “it’s ‘fine’” today.");
  });

  it("opens after a line start, a bracket, a dash, or another opening quote", () => {
    expect(educate(`"a"\n("b")—'c'\n"'d'"`)).toBe(
      "“a”\n(“b”)—‘c’\n“‘d’”",
    );
  });

  it("acts on the selected text only when there is a selection", () => {
    const doc = `"a" "b"`;
    const state = stateWith(doc, EditorSelection.single(4, 7));
    expect(apply(state, educateQuotesSpec(state))).toBe(`"a" “b”`);
  });

  it("leaves inline code and fenced blocks alone", () => {
    const doc = 'say "hi" and `x = "y"`\n```\nlet s = "z";\n```\n"done"';
    expect(educate(doc)).toBe(
      'say “hi” and `x = "y"`\n```\nlet s = "z";\n```\n“done”',
    );
  });

  it("is null with nothing to curl, and on a read-only document", () => {
    expect(educateQuotesSpec(stateWith("plain"))).toBeNull();
    expect(educateQuotesSpec(stateWith(`"a"`, EditorSelection.single(0), true))).toBeNull();
  });
});

describe("straightenQuotesSpec", () => {
  it("straightens every curly form", () => {
    const state = stateWith("“a” ‘b’ „c‟ ‚d‛");
    expect(apply(state, straightenQuotesSpec(state))).toBe(`"a" 'b' "c" 'd'`);
  });

  it("leaves code alone and round-trips Educate", () => {
    const doc = `"it's" \`“keep”\``;
    const educated = stateWith(educate(doc));
    expect(educated.doc.toString()).toBe("“it’s” `“keep”`");
    expect(apply(educated, straightenQuotesSpec(educated))).toBe(doc);
  });

  it("is null with nothing to straighten", () => {
    expect(straightenQuotesSpec(stateWith(`"plain"`))).toBeNull();
  });
});

describe("markdownCodeSpans", () => {
  const slices = (doc: string) => markdownCodeSpans(doc).map((s) => doc.slice(s.from, s.to));

  it("finds inline spans by matching backtick runs", () => {
    expect(slices("a `b` c ``d ` e`` f")).toEqual(["`b`", "``d ` e``"]);
  });

  it("leaves an unmatched run literal, and does not cross a blank line", () => {
    expect(slices("a ` b\n\nc ` d")).toEqual([]);
  });

  it("finds fenced blocks, tilde and quoted ones, and runs an unclosed one to the end", () => {
    expect(slices("x\n~~~\n`a`\n~~~\ny")).toEqual(["~~~\n`a`\n~~~"]);
    expect(slices("> ```\n> q\n> ```")).toEqual(["> ```\n> q\n> ```"]);
    expect(slices("x\n```\nopen")).toEqual(["```\nopen"]);
  });
});
