/**
 * editor-find-replace.test — a Replace press in an editor always replaces.
 *
 * CodeMirror's `replaceNext` replaces the selection only when it is exactly a
 * match, and otherwise just selects the next one. A click into the text, the
 * case ⌥⌘G is answered for, leaves a collapsed caret, so the engine selects
 * the next match first and the press replaces it.
 *
 * These run the real engine over a real `EditorView` in jsdom, with the
 * `search()` extension the editors install. jsdom lays nothing out and has no
 * `Range.getClientRects`, so that read is stubbed to an empty list: the
 * engine's reveal then finds no coordinates and leaves the view alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getSearchQuery, search, searchPanelOpen } from "@codemirror/search";

import { installJsdom, type JsdomSubstrate } from "../../../__tests__/jsdom-deck";

let substrate: JsdomSubstrate;
let createEditorFindEngine: typeof import("../editor-find-engine").createEditorFindEngine;
let FindSession: typeof import("@/lib/find-session").FindSession;

beforeAll(async () => {
  substrate = installJsdom();
  const rangeProto = (globalThis as unknown as { Range: { prototype: Record<string, unknown> } })
    .Range.prototype;
  rangeProto.getClientRects = () => [];
  rangeProto.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  ({ createEditorFindEngine } = await import("../editor-find-engine"));
  ({ FindSession } = await import("@/lib/find-session"));
});

afterAll(() => {
  substrate.restore();
});

const DOC = ["alpha meridian one", "beta meridian two", "gamma meridian three"].join("\n");

function setUp() {
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [search({ top: true })] }),
    parent: substrate.container,
  });
  const engine = createEditorFindEngine(() => view, "text");
  const session = new FindSession(undefined, {}, "pole");
  session.setDelegate(engine);
  session.setQuery("meridian");
  return { view, engine, session };
}

function meridians(view: EditorView): number {
  return view.state.doc.toString().split("meridian").length - 1;
}

describe("editor Replace", () => {
  test("with the match selected, Replace replaces it", () => {
    const { view, engine, session } = setUp();
    expect(session.getSnapshot().activeOrdinal).toBe(0);
    session.replaceNext();
    expect(meridians(view)).toBe(2);
    expect(view.state.doc.line(1).text).toBe("alpha pole one");
    engine.dispose();
    view.destroy();
  });

  test("with a collapsed caret, Replace replaces the next match rather than only selecting it", () => {
    const { view, engine, session } = setUp();
    // A click into the second line's start: no match is selected.
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from) });
    session.refresh();
    expect(session.getSnapshot().activeOrdinal).toBeNull();
    session.replaceNext();
    expect(meridians(view)).toBe(2);
    expect(view.state.doc.line(2).text).toBe("beta pole two");
    engine.dispose();
    view.destroy();
  });
});

describe("editor step with no live query", () => {
  test("⌘G with the bar closed leaves the selection and opens no search", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [search({ top: true })] }),
      parent: substrate.container,
    });
    const engine = createEditorFindEngine(() => view, "text");
    // The user selected a word; no find bar has ever been opened.
    view.dispatch({ selection: EditorSelection.single(6, 14) });
    engine.findNext?.();
    engine.findPrevious?.();
    expect(view.state.selection.main.from).toBe(6);
    expect(view.state.selection.main.to).toBe(14);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(getSearchQuery(view.state).search).toBe("");
    engine.dispose();
    view.destroy();
  });
});
