/**
 * cm6-focus-keeps-place — focusing a CodeMirror view never moves its scroller.
 *
 * Every focus write in the deck asks for `preventScroll`, CM6's own `focus()`
 * included, and WebKit honours it for the element but not for the caret it
 * restores. Focusing a contenteditable that the document's selection is not
 * inside puts a caret at its start and reveals it, inside the `focus()` call,
 * with no script write anyone could intercept. Two readers met it:
 *
 *  - a Text card that was restored or scrolled but never clicked, handed focus
 *    back when a title-bar menu closed, jumped to the top of its document;
 *  - the landing composer, handed focus as the scribe's last word landed,
 *    dropped the tail the eye was on before its beat had passed.
 *
 * WebKit dispatches `focus` before it restores and reveals the caret, so the
 * scroller still reads the reader's place inside the listener; a microtask
 * runs once the `focus()` call has returned and puts that place back before
 * the frame paints. A reveal the editor asks for itself — a find match, an
 * open-at-line, a pin — scrolls in CM6's measure pass, after this, and is
 * untouched.
 *
 * The scroll position is written straight to the DOM and never through React
 * state ([L06]); the listener is released in `destroy()` ([L27]).
 */

import { ViewPlugin, type EditorView, type PluginValue } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

class FocusKeepsPlace implements PluginValue {
  private readonly onFocus = (): void => {
    const scroller = this.view.scrollDOM;
    const top = scroller.scrollTop;
    queueMicrotask(() => {
      if (scroller.scrollTop !== top) scroller.scrollTop = top;
    });
  };

  constructor(private readonly view: EditorView) {
    view.contentDOM.addEventListener("focus", this.onFocus);
  }

  destroy(): void {
    this.view.contentDOM.removeEventListener("focus", this.onFocus);
  }
}

/** Hold the scroller where it stood across every focus grant to the view. */
export function cm6FocusKeepsPlace(): Extension {
  return ViewPlugin.define((view) => new FocusKeepsPlace(view));
}
