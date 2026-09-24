/**
 * smart-insert.test.ts — the padding decision as a table.
 *
 * `padForInsert` is pure state → answer, so every case here is a
 * document, a range, and a run; no DOM and no drag-and-drop machinery.
 * `|` marks the insert point in each `doc` below and is stripped before
 * the state is built; `[…]` marks a replaced selection.
 */

import { test, expect, describe } from "bun:test";
import { EditorState } from "@codemirror/state";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import { padForInsert, padInsert } from "./smart-insert";

/**
 * Build a state from a marked document. `|` is a caret; `[` and `]`
 * bracket a replaced range. Returns the stripped doc's state and the
 * range the insert covers.
 */
function marked(doc: string): { state: EditorState; from: number; to: number } {
  const caret = doc.indexOf("|");
  if (caret >= 0) {
    const text = doc.slice(0, caret) + doc.slice(caret + 1);
    return {
      state: EditorState.create({ doc: text }),
      from: caret,
      to: caret,
    };
  }
  const open = doc.indexOf("[");
  const close = doc.indexOf("]");
  if (open < 0 || close < 0) {
    throw new Error(`marked(): no | or [...] in ${JSON.stringify(doc)}`);
  }
  const text = doc.slice(0, open) + doc.slice(open + 1, close) + doc.slice(close + 1);
  return {
    state: EditorState.create({ doc: text }),
    from: open,
    to: close - 1,
  };
}

const A = TUG_ATOM_CHAR;

interface Case {
  name: string;
  doc: string;
  insert?: string;
  before: boolean;
  after: boolean;
}

const CASES: Case[] = [
  // The common cases: nothing on a side means nothing to pad against.
  { name: "empty doc", doc: "|", before: false, after: false },
  { name: "line start", doc: "one\n|two", before: false, after: true },
  { name: "line end", doc: "one|\ntwo", before: true, after: false },
  { name: "empty line between two", doc: "one\n|\ntwo", before: false, after: false },
  { name: "doc start", doc: "|word", before: false, after: true },
  { name: "doc end", doc: "word|", before: true, after: false },
  { name: "already spaced both sides", doc: "foo | bar", before: false, after: false },

  // The defect this arc is about.
  { name: "mid-word, both sides", doc: "foo|bar", before: true, after: true },
  { name: "after a word, before a space", doc: "foo| bar", before: true, after: false },
  { name: "after a space, before a word", doc: "foo |bar", before: false, after: true },

  // [B03] closers: the trailing side belongs to what precedes it.
  { name: "before a period", doc: "see |.", before: false, after: false },
  { name: "before a comma after a word", doc: "see foo|, and", before: true, after: false },
  { name: "before a close paren", doc: "(foo|)", before: true, after: false },
  { name: "before a colon", doc: "the file |: line", before: false, after: false },

  // [B02] openers: the insert is being seated inside something.
  { name: "after =", doc: "--paths=|", before: false, after: false },
  { name: "after = with a word following", doc: "--paths=|next", before: false, after: true },
  { name: "inside quotes", doc: '"|"', before: false, after: false },
  { name: "after @", doc: "@|", before: false, after: false },
  { name: "after an open paren", doc: "(|foo)", before: false, after: true },
  { name: "after a backtick", doc: "`|`", before: false, after: false },

  // [F03] U+FFFC is not whitespace, so chip-against-chip pads.
  { name: "chip-adjacent before", doc: `${A}|`, before: true, after: false },
  { name: "chip-adjacent after", doc: `|${A}`, before: false, after: true },
  { name: "between two chips", doc: `${A}|${A}`, before: true, after: true },

  // [B08] a drop over a selection reads outside the replaced range.
  { name: "selection mid-word", doc: "foo[XXX]bar", before: true, after: true },
  { name: "selection spanning to a space", doc: "foo [XXX] bar", before: false, after: false },
  { name: "selection to the doc's end", doc: "foo[XXX]", before: true, after: false },

  // The run's own edges: a pad is never doubled.
  {
    name: "insert leading with a newline",
    doc: "foo|bar",
    insert: `\n${A}`,
    before: false,
    after: true,
  },
  {
    name: "insert trailing with a space",
    doc: "foo|bar",
    insert: `${A} `,
    before: true,
    after: false,
  },
  {
    name: "insert whitespace on both edges",
    doc: "foo|bar",
    insert: `\n${A}\n`,
    before: false,
    after: false,
  },
  { name: "empty insert", doc: "foo|bar", insert: "", before: false, after: false },
];

describe("padForInsert", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { state, from, to } = marked(c.doc);
      const got = padForInsert(state, from, to, c.insert ?? A);
      expect({ name: c.name, ...got }).toEqual({
        name: c.name,
        before: c.before,
        after: c.after,
      });
    });
  }
});

describe("padInsert", () => {
  test("wraps the run and lands the caret past the trailing pad", () => {
    const { state, from, to } = marked("foo|bar");
    expect(padInsert(state, from, to, A)).toEqual({
      insert: ` ${A} `,
      start: 4,
      caret: 6,
    });
  });

  test("leaves an unpadded run and its caret alone", () => {
    const { state, from, to } = marked("foo | bar");
    expect(padInsert(state, from, to, A)).toEqual({
      insert: A,
      start: 4,
      caret: 5,
    });
  });

  test("reads a replaced range's far edge for the trailing pad", () => {
    const { state, from, to } = marked("foo[XXX]bar");
    expect(padInsert(state, from, to, A)).toEqual({
      insert: ` ${A} `,
      start: 4,
      caret: 6,
    });
  });
});
