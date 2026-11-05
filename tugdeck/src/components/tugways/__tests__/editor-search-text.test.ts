/**
 * editor-search-text.test — a literal-mode query means exactly what the user
 * typed, while the replacement keeps its escapes.
 *
 * CodeMirror unquotes `\n`, `\r`, `\t` and `\\` in both the search text and
 * the replacement under one flag, so the editor engine escapes the query
 * itself rather than turning `literal` on. These run CodeMirror's own
 * `SearchQuery` over a real `EditorState`, which needs no DOM.
 */

import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

import { editorSearchText } from "../editor-find-engine";

/** Every `[from, to]` the query matches in `doc`. */
function matches(doc: string, query: SearchQuery): Array<[number, number]> {
  const state = EditorState.create({ doc });
  const out: Array<[number, number]> = [];
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    out.push([next.value.from, next.value.to]);
  }
  return out;
}

// Line 1 holds a literal backslash-n; the newline after it is a real one.
const DOC = "C:\\new\\dir\nnext line";

describe("editorSearchText", () => {
  test("a literal query's backslashes are doubled", () => {
    expect(editorSearchText("a\\nb", false)).toBe("a\\\\nb");
    expect(editorSearchText("plain", false)).toBe("plain");
  });

  test("a grep pattern passes through untouched", () => {
    expect(editorSearchText("a\\nb", true)).toBe("a\\nb");
    expect(editorSearchText("\\d+", true)).toBe("\\d+");
  });

  test("CodeMirror finds exactly the typed text, backslashes and all", () => {
    for (const typed of ["\\n", "\\t", "\\\\", "a\\rb", "\\x"]) {
      const query = new SearchQuery({ search: editorSearchText(typed, false) });
      // The typed text sits once in the document, between two plain letters
      // and beside a real tab and newline it must not match.
      const doc = `\t\nx${typed}y\n`;
      expect(matches(doc, query)).toEqual([[3, 3 + typed.length]]);
    }
  });

  test("a typed \\n matches the two characters, never the newline", () => {
    const query = new SearchQuery({ search: editorSearchText("\\n", false) });
    // `\n` sits at offset 2 in `C:\new` and nowhere else.
    expect(matches(DOC, query)).toEqual([[2, 4]]);
    // Unescaped, the same text would have found the real newline instead.
    expect(matches(DOC, new SearchQuery({ search: "\\n" }))).toEqual([[10, 11]]);
  });

  test("the replacement still expands its escapes beside an escaped query", () => {
    const query = new SearchQuery({
      search: editorSearchText("\\new", false),
      replace: "\\tX\\n\\\\",
    });
    expect(matches(DOC, query)).toEqual([[2, 6]]);
    // A replacement is `getReplacement`, which is CodeMirror's internal
    // `unquote` of the replace text; the replace commands themselves need a
    // mounted view, so the unquote is read directly.
    const internal = query as unknown as { unquote(text: string): string };
    expect(internal.unquote(query.replace)).toBe("\tX\n\\");
  });
});
