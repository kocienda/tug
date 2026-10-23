/**
 * `paintMirrorAsActive` keeps the editor's selection across the focus
 * it claims.
 *
 * On a freshly shown editor WebKit's focus point is offset 0, and
 * CodeMirror reads that collapse back into its own state before its
 * focus-sync can write the held range out. The paint re-asserts the
 * selection after the focus — the saved one when a state is supplied,
 * and otherwise the one the engine held before the focus — so a
 * restored draft's selection survives a reload's activation whether or
 * not the saved draft is still in hand.
 *
 * The focus is stood in for here: a `focus()` that collapses the
 * selection to 0, as WebKit's does on a view just made visible.
 *
 * A collapse the user made at the start — a click or a key inside the
 * window — is theirs and is left, and a view that held focus with its
 * selection in place is dispatched nothing.
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { installJsdom, type JsdomSubstrate } from "../../../../__tests__/jsdom-deck";

let substrate: JsdomSubstrate;
let paintMirrorAsActive: typeof import("../state-preservation").paintMirrorAsActive;

beforeAll(async () => {
  substrate = installJsdom();
  ({ paintMirrorAsActive } = await import("../state-preservation"));
});

afterAll(() => {
  substrate.restore();
});

/** A view over `doc` selecting `from..to`, whose focus collapses the selection to 0 as WebKit's does. */
function viewWithCollapsingFocus(doc: string, from: number, to: number): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.range(from, to) }),
    parent: substrate.container,
  });
  Object.defineProperty(view, "focus", {
    value: () => view.dispatch({ selection: EditorSelection.cursor(0) }),
  });
  return view;
}

describe("the active paint's selection across focus", () => {
  test("with no saved state the selection the engine held is put back after the focus", () => {
    const view = viewWithCollapsingFocus("hello world", 2, 5);
    paintMirrorAsActive(view);
    expect({ from: view.state.selection.main.from, to: view.state.selection.main.to }).toEqual({ from: 2, to: 5 });
    view.destroy();
  });

  test("a saved state's selection is the one put back", () => {
    const view = viewWithCollapsingFocus("hello world", 2, 5);
    paintMirrorAsActive(view, { text: "hello world", atoms: [], selection: { start: 6, end: 11 } });
    expect({ from: view.state.selection.main.from, to: view.state.selection.main.to }).toEqual({ from: 6, to: 11 });
    view.destroy();
  });

  test("a collapse that lands after the focus, as a later selectionchange, is undone once", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world", selection: EditorSelection.range(2, 5) }),
      parent: substrate.container,
    });
    // WebKit's caret placement: a task after the focus, then the event.
    Object.defineProperty(view, "focus", {
      value: () => {
        setTimeout(() => {
          view.dispatch({ selection: EditorSelection.cursor(0) });
          view.contentDOM.ownerDocument.dispatchEvent(new (substrate.win.Event as typeof Event)("selectionchange"));
        }, 0);
      },
    });
    paintMirrorAsActive(view);
    await new Promise((r) => setTimeout(r, 20));
    expect({ from: view.state.selection.main.from, to: view.state.selection.main.to }).toEqual({ from: 2, to: 5 });
    // A later selection is the user's and is left alone.
    view.dispatch({ selection: EditorSelection.cursor(0) });
    view.contentDOM.ownerDocument.dispatchEvent(new (substrate.win.Event as typeof Event)("selectionchange"));
    await new Promise((r) => setTimeout(r, 20));
    expect(view.state.selection.main.from).toBe(0);
    view.destroy();
  });

  test("the re-assert's own selectionchange, heard first, does not spend the hold: the collapse after it is still undone", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world", selection: EditorSelection.range(2, 5) }),
      parent: substrate.container,
    });
    const selectionchange = (): void => {
      view.contentDOM.ownerDocument.dispatchEvent(new (substrate.win.Event as typeof Event)("selectionchange"));
    };
    // The paint's re-assert writes the DOM selection, which WebKit reports as
    // a task of its own; its caret placement for the focus comes a task later.
    Object.defineProperty(view, "focus", {
      value: () => {
        setTimeout(selectionchange, 0);
        setTimeout(() => {
          view.dispatch({ selection: EditorSelection.cursor(0) });
          selectionchange();
        }, 5);
      },
    });
    paintMirrorAsActive(view);
    await new Promise((r) => setTimeout(r, 30));
    expect({ from: view.state.selection.main.from, to: view.state.selection.main.to }).toEqual({ from: 2, to: 5 });
    view.destroy();
  });

  test("a collapse at the start that a key made inside the window is the user's, and is left", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world", selection: EditorSelection.range(2, 5) }),
      parent: substrate.container,
    });
    Object.defineProperty(view, "focus", { value: () => {} });
    paintMirrorAsActive(view);
    // ⌘↑ inside the window: the key, then the selection it makes.
    const doc = view.contentDOM.ownerDocument;
    view.contentDOM.dispatchEvent(new (substrate.win.KeyboardEvent as typeof KeyboardEvent)("keydown", { key: "ArrowUp", metaKey: true, bubbles: true }));
    view.dispatch({ selection: EditorSelection.cursor(0) });
    doc.dispatchEvent(new (substrate.win.Event as typeof Event)("selectionchange"));
    await new Promise((r) => setTimeout(r, 20));
    expect(view.state.selection.main.from).toBe(0);
    view.destroy();
  });

  test("a view that held focus with its selection in place is dispatched nothing", () => {
    let transactions = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello world",
        selection: EditorSelection.range(2, 5),
        extensions: EditorView.updateListener.of((u) => (transactions += u.transactions.length)),
      }),
      parent: substrate.container,
    });
    Object.defineProperty(view, "hasFocus", { get: () => true });
    paintMirrorAsActive(view);
    expect(transactions).toBe(0);
    paintMirrorAsActive(view, { text: "hello world", atoms: [], selection: { start: 6, end: 11 } });
    expect(transactions).toBe(1);
    expect({ from: view.state.selection.main.from, to: view.state.selection.main.to }).toEqual({ from: 6, to: 11 });
    view.destroy();
  });
});
