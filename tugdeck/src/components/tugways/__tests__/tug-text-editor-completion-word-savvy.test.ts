/**
 * tug-text-editor-completion-word-savvy.test.ts —
 * Word-savvy typeahead behaviors: the query spans the whole trigger
 * token (trigger through the end of the word the caret sits in), the
 * caret's position inside the token never truncates the query, and
 * rejoin engages on user caret entry as well as edits.
 *
 * Exercises the real completion extension headlessly (the typeahead
 * transaction-extender runs inside `EditorState.update`, no DOM
 * needed), plus the pure token-scanning helpers.
 */

import { describe, expect, test } from "bun:test";

import { EditorSelection, EditorState, Text } from "@codemirror/state";

import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import {
  beginsTokenAt,
  completionField,
  completionQueryMatchesSelection,
  queryStopChar,
  scanForwardForTokenEnd,
  trimTrailingPunctuation,
  tugCompletionExt,
} from "../tug-text-editor/completion-extension";

/** Trivial synchronous providers that always offer one item each. */
const item = (label: string, type: string): CompletionItem => ({
  label,
  atom: { kind: "atom", type, label, value: label },
});
const slashProvider: CompletionProvider = () => [item("permissions", "command")];
const fileProvider: CompletionProvider = () => [item("src/index.ts", "file")];

function makeState(doc = "", cursor?: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor ?? doc.length),
    extensions: [
      tugCompletionExt(() => ({ "/": slashProvider, "@": fileProvider })),
    ],
  });
}

describe("scanForwardForTokenEnd", () => {
  const doc = (s: string) => Text.of(s.split("\n"));

  test("walks to the first whitespace", () => {
    expect(scanForwardForTokenEnd(doc("index.ts please"), 0)).toBe(8);
    expect(scanForwardForTokenEnd(doc("index.ts please"), 3)).toBe(8);
  });

  test("returns pos at a token boundary", () => {
    expect(scanForwardForTokenEnd(doc("foo bar"), 3)).toBe(3);
    expect(scanForwardForTokenEnd(doc("foo"), 3)).toBe(3);
  });

  test("stops at doc end, newline, and the atom char", () => {
    expect(scanForwardForTokenEnd(doc("foo"), 0)).toBe(3);
    expect(scanForwardForTokenEnd(doc("foo\nbar"), 0)).toBe(3);
    expect(scanForwardForTokenEnd(doc(`fo${TUG_ATOM_CHAR}o`), 0)).toBe(2);
  });
});

describe("beginsTokenAt", () => {
  const doc = (s: string) => Text.of(s.split("\n"));

  test("doc start begins a token", () => {
    expect(beginsTokenAt(doc("/cmd"), 0)).toBe(true);
  });

  test("after whitespace or an atom begins a token", () => {
    expect(beginsTokenAt(doc("a /cmd"), 2)).toBe(true);
    expect(beginsTokenAt(doc(`${TUG_ATOM_CHAR}/cmd`), 1)).toBe(true);
  });

  test("glued to preceding text does not", () => {
    expect(beginsTokenAt(doc("x/cmd"), 1)).toBe(false);
  });
});

describe("word-savvy query derivation", () => {
  test("typing a trigger immediately before a word adopts the word as the query", () => {
    // "index.ts" with the caret at 0; typing `@` gives "@index.ts" and
    // must open filtering on the whole word, not "".
    const typed = makeState("index.ts", 0).update({
      changes: { from: 0, insert: "@" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    }).state;
    const field = typed.field(completionField);
    expect(field.active).toBe(true);
    expect(field.trigger).toBe("@");
    expect(field.query).toBe("index.ts");
  });

  test("editing mid-token filters on the whole token", () => {
    // "@sfile" with an edit inserting "rc" after "@s" — the query must be
    // the full resulting token "srcfile", not the caret-bounded "src".
    const edited = makeState("@sfile", 2).update({
      changes: { from: 2, insert: "rc" },
      selection: EditorSelection.cursor(4),
      userEvent: "input.type",
    }).state;
    const field = edited.field(completionField);
    expect(field.active).toBe(true);
    expect(field.query).toBe("srcfile");
  });

  test("backspacing into a trigger token reopens with the whole token", () => {
    // "@foo " caret at end; backspace over the space lands the caret at
    // the token's end — a doc change, so rejoin fires.
    const backspaced = makeState("@foo ", 5).update({
      changes: { from: 4, to: 5 },
      selection: EditorSelection.cursor(4),
      userEvent: "delete.backward",
    }).state;
    const field = backspaced.field(completionField);
    expect(field.active).toBe(true);
    expect(field.query).toBe("foo");
  });

  test("backspacing into a pasted @path is not shadowed by an inner slash", () => {
    // A pasted "@tuglaws/tuglaws.m" — the inner "/" is also a registered
    // trigger, but it is part of the word, not the token head. Backspacing
    // over a trailing space must reopen FILE completion on the leading "@",
    // never slash-command completion anchored at the inner "/".
    const backspaced = makeState("@tuglaws/tuglaws.m ", 19).update({
      changes: { from: 18, to: 19 },
      selection: EditorSelection.cursor(18),
      userEvent: "delete.backward",
    }).state;
    const field = backspaced.field(completionField);
    expect(field.active).toBe(true);
    expect(field.trigger).toBe("@");
    expect(field.anchorOffset).toBe(0);
    expect(field.query).toBe("tuglaws/tuglaws.m");
  });

  test("a user click into the middle of a token opens with the whole token", () => {
    const clicked = makeState("@srcfile", 8).update({
      selection: EditorSelection.cursor(3),
      userEvent: "select.pointer",
    }).state;
    // makeState's initial cursor placement is not a user event, so the
    // session starts inactive; the click is what engages it.
    const field = clicked.field(completionField);
    expect(field.active).toBe(true);
    expect(field.anchorOffset).toBe(0);
    expect(field.query).toBe("srcfile");
  });

  test("an abandoned run cancels once the caret crosses whitespace", () => {
    // An unmatched "/foo" shows no popup, so nothing accepts and clears
    // the field. Typing a space moves the caret out of the trigger token
    // and must cancel the session rather than swallow the space into the
    // query — otherwise the still-active run shadows every later trigger.
    const opened = makeState("", 0).update({
      changes: { from: 0, insert: "/foo" },
      selection: EditorSelection.cursor(4),
      userEvent: "input.type",
    }).state;
    expect(opened.field(completionField).active).toBe(true);

    const spaced = opened.update({
      changes: { from: 4, insert: " " },
      selection: EditorSelection.cursor(5),
      userEvent: "input.type",
    }).state;
    expect(spaced.field(completionField).active).toBe(false);
  });

  test("a trigger typed after an abandoned run opens fresh", () => {
    // The end-to-end reported bug: "/foo " then "@" must open FILE
    // completion, not append "@" to the dead slash run's query.
    const afterAbandoned = makeState("", 0)
      .update({
        changes: { from: 0, insert: "/foo " },
        selection: EditorSelection.cursor(5),
        userEvent: "input.type",
      })
      .state.update({
        changes: { from: 5, insert: "@" },
        selection: EditorSelection.cursor(6),
        userEvent: "input.type",
      }).state;
    const field = afterAbandoned.field(completionField);
    expect(field.active).toBe(true);
    expect(field.trigger).toBe("@");
    expect(field.anchorOffset).toBe(5);
  });

  test("deleting the trigger character cancels the session", () => {
    const opened = makeState("", 0).update({
      changes: { from: 0, insert: "@" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    }).state;
    expect(opened.field(completionField).active).toBe(true);

    const deleted = opened.update({
      changes: { from: 0, to: 1 },
      selection: EditorSelection.cursor(0),
      userEvent: "delete.backward",
    }).state;
    expect(deleted.field(completionField).active).toBe(false);
  });
});

describe("trailing punctuation is trimmed from the query", () => {
  test("only a trailing run is shed", () => {
    expect(trimTrailingPunctuation("roadmap/plan.md;")).toBe("roadmap/plan.md");
    expect(trimTrailingPunctuation("plan.md).")).toBe("plan.md");
    expect(trimTrailingPunctuation('plan.md,"')).toBe("plan.md");
    expect(trimTrailingPunctuation("")).toBe("");
    expect(trimTrailingPunctuation(";;;")).toBe("");
  });

  test("interior punctuation and path structure survive", () => {
    expect(trimTrailingPunctuation("my,file.md")).toBe("my,file.md");
    expect(trimTrailingPunctuation("src/")).toBe("src/");
    expect(trimTrailingPunctuation("some-file_v2")).toBe("some-file_v2");
  });

  test("a mention written mid-sentence queries the path, not the clause", () => {
    // The reported flow: "@roadmap/overview-plan.md; Phase F …". The token
    // ends at whitespace, so without the trim the query carries the
    // semicolon and matches no file.
    const typed = makeState("roadmap/overview-plan.md; Phase F", 0).update({
      changes: { from: 0, insert: "@" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    }).state;
    const field = typed.field(completionField);
    expect(field.active).toBe(true);
    expect(field.query).toBe("roadmap/overview-plan.md");
  });

  test("the session stays open with the caret parked after the punctuation", () => {
    // Liveness is judged against the raw token end, so a caret resting on
    // the far side of the semicolon is still inside its token.
    const typed = makeState("@roadmap/plan.md; rest", 22).update({
      selection: EditorSelection.cursor(17),
      userEvent: "select.pointer",
    }).state;
    const field = typed.field(completionField);
    expect(field.active).toBe(true);
    expect(field.query).toBe("roadmap/plan.md");
  });

  test("typing past the punctuation makes it interior again", () => {
    // Nothing is removed from the document, so the trim reverses itself
    // the moment the character stops being the token's last.
    const opened = makeState("", 0).update({
      changes: { from: 0, insert: "@" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    }).state;
    const commaed = opened.update({
      changes: { from: 1, insert: "a," },
      selection: EditorSelection.cursor(3),
      userEvent: "input.type",
    }).state;
    expect(commaed.field(completionField).query).toBe("a");

    const continued = commaed.update({
      changes: { from: 3, insert: "b" },
      selection: EditorSelection.cursor(4),
      userEvent: "input.type",
    }).state;
    expect(continued.field(completionField).query).toBe("a,b");
  });

  test("a directory's trailing slash is kept", () => {
    const typed = makeState("src/", 0).update({
      changes: { from: 0, insert: "@" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    }).state;
    expect(typed.field(completionField).query).toBe("src/");
  });
});

describe("leading punctuation does not break the trigger's claim", () => {
  const doc = (s: string) => Text.of(s.split("\n"));

  test("beginsTokenAt sees through an opener run", () => {
    expect(beginsTokenAt(doc("(@file.md)"), 1)).toBe(true);
    expect(beginsTokenAt(doc('a ("@file.md'), 4)).toBe(true);
    expect(beginsTokenAt(doc("x(@file.md"), 2)).toBe(false);
  });

  test("clicking into a bracketed mention finds the trigger, not the bracket", () => {
    const clicked = makeState("see (@notes) now", 16).update({
      selection: EditorSelection.cursor(8),
      userEvent: "select.pointer",
    }).state;
    const field = clicked.field(completionField);
    expect(field.active).toBe(true);
    expect(field.trigger).toBe("@");
    expect(field.anchorOffset).toBe(5);
    expect(field.query).toBe("notes");
  });
});

describe("queryStopChar — a slash-command query ends at the next slash", () => {
  const doc = (s: string) => Text.of(s.split("\n"));

  test("only the slash trigger has a stop char", () => {
    expect(queryStopChar("/")).toBe("/");
    expect(queryStopChar("@")).toBe(null);
    expect(queryStopChar("!")).toBe(null);
  });

  test("the scan stops at the stop char", () => {
    expect(scanForwardForTokenEnd(doc("compact/tugplug:implement"), 0, "/")).toBe(7);
    expect(scanForwardForTokenEnd(doc("compact/tugplug:implement"), 0)).toBe(25);
  });

  test("a file path keeps its slashes and its inner @", () => {
    expect(scanForwardForTokenEnd(doc("tuglaws/tuglaws.md"), 0, null)).toBe(18);
    expect(scanForwardForTokenEnd(doc("node_modules/@types/bun"), 0, null)).toBe(23);
  });
});

describe("prepending a slash command in front of another one", () => {
  // The reported flow: the composer holds "/tugplug:implement <path>" and the
  // user types "/compact" at offset 0. The two commands are one unbroken
  // token, so without the slash stop char the query would be the whole
  // unmatchable "compact/tugplug:implement" — no popup, and the separating
  // space the user types next would go in as plain text.
  const compactProvider: CompletionProvider = (query) =>
    "compact".startsWith(query) ? [item("compact", "command")] : [];

  function prependState(): EditorState {
    return EditorState.create({
      doc: "/tugplug:implement roadmap/restore-remediation.md",
      selection: EditorSelection.cursor(0),
      extensions: [tugCompletionExt(() => ({ "/": compactProvider }))],
    });
  }

  test("the query is the command being typed, not the whole glued run", () => {
    const slashed = prependState().update({
      changes: { from: 0, insert: "/" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    }).state;
    expect(slashed.field(completionField).active).toBe(true);
    expect(slashed.field(completionField).query).toBe("");

    const typed = slashed.update({
      changes: { from: 1, insert: "compact" },
      selection: EditorSelection.cursor(8),
      userEvent: "input.type",
    }).state;
    const field = typed.field(completionField);
    expect(field.query).toBe("compact");
    expect(field.filtered.map((f) => f.label)).toEqual(["compact"]);
    // The gate the space key reads: an exact match, so the next space
    // atomizes "/compact" instead of inserting literally.
    expect(
      completionQueryMatchesSelection({
        query: field.query,
        filtered: field.filtered,
        selectedIndex: field.selectedIndex,
      }),
    ).toBe(true);
  });

  test("a click inside the second command opens nothing rather than flashing", () => {
    const clicked = EditorState.create({
      doc: "/compact/tugplug:implement",
      selection: EditorSelection.cursor(26),
      extensions: [tugCompletionExt(() => ({ "/": compactProvider }))],
    }).update({
      selection: EditorSelection.cursor(14),
      userEvent: "select.pointer",
    }).state;
    expect(clicked.field(completionField).active).toBe(false);
  });
});

describe("promotion — a trigger arriving at a token start engages completion", () => {
  test("deleting leading text so `/cmd` heads the doc opens the popup", () => {
    // "x/permissions": glued to "x", the slash is not a token start, so
    // no session. Backspacing the "x" away parks the caret at 0 ON the
    // now-leading slash — promotion must engage slash completion.
    const start = makeState("x/permissions", 1);
    expect(start.field(completionField).active).toBe(false);

    const promoted = start.update({
      changes: { from: 0, to: 1 },
      selection: EditorSelection.cursor(0),
      userEvent: "delete.backward",
    }).state;
    const field = promoted.field(completionField);
    expect(field.active).toBe(true);
    expect(field.trigger).toBe("/");
    expect(field.anchorOffset).toBe(0);
    expect(field.query).toBe("permissions");
  });

  test("typing text immediately before the trigger cancels the session", () => {
    // The inverse: with the caret parked on a leading trigger, typing a
    // plain character glues the trigger to text — it no longer begins a
    // token, so the session must close rather than keep completing a
    // run the user is writing prose in front of.
    const promoted = makeState("x/permissions", 1).update({
      changes: { from: 0, to: 1 },
      selection: EditorSelection.cursor(0),
      userEvent: "delete.backward",
    }).state;
    expect(promoted.field(completionField).active).toBe(true);

    const demoted = promoted.update({
      changes: { from: 0, insert: "y" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    }).state;
    expect(demoted.field(completionField).active).toBe(false);
  });

  test("a user click just before a mid-text trigger token engages completion", () => {
    const clicked = makeState("see @notes now", 14).update({
      selection: EditorSelection.cursor(4),
      userEvent: "select.pointer",
    }).state;
    const field = clicked.field(completionField);
    expect(field.active).toBe(true);
    expect(field.trigger).toBe("@");
    expect(field.anchorOffset).toBe(4);
    expect(field.query).toBe("notes");
  });
});
