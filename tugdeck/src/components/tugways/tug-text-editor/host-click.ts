/**
 * tug-text-editor/host-click.ts — the host is the text surface: a click
 * anywhere inside the `.tug-text-editor` wrapper lands the caret.
 *
 * CM6 owns pointer selection only within `view.contentDOM`, which is
 * content-sized. A host taller than its content (the Session card's prompt
 * opens at `--tug-text-editor-min-height`) leaves a blank band below the
 * last line — inside the scroller, outside the content. A mousedown there
 * reaches no CM6 handler, and WebKit's mousedown focus default then walks
 * up from the non-focusable scroller and clears focus to body: the caret
 * vanishes because the user clicked *inside their own editor*.
 *
 * This extension closes the dead band. A primary-button mousedown inside
 * the host but outside `contentDOM` claims the gesture: suppress the
 * focus-clearing default, focus the editor, and land the caret at the
 * document position nearest the click (`posAtCoords(…, false)` — below
 * the last line that is the end of the nearest column on the last row).
 * Clicks that belong to other in-host surfaces pass through untouched:
 *
 *  - inside `contentDOM` — CM6's own pointer selection;
 *  - inside `.cm-gutters` — CM6's gutter semantics (line select);
 *  - on the scrollbar band (outside the scroller's client box) — native
 *    scrollbar dragging;
 *  - non-primary buttons — context menus must not move the caret;
 *  - a read-only editor (the Dev prompt stood down behind a card-modal
 *    dialog) — a deactivated surface claims nothing.
 *
 * Laws: [L03] listeners installed by the ViewPlugin lifecycle; [L06] no
 *        React state — the gesture goes straight to a CM6 transaction;
 *        [L19] file pair with `__tests__/host-click.test.ts`.
 */

import { ViewPlugin } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Whether a host mousedown should claim the caret — the pure gate,
 * exported for the test suite. `target` is the event target; the
 * coordinate pair is the client point of the click.
 */
export function hostClickClaimsCaret(
  view: EditorView,
  target: Node | null,
  clientX: number,
  clientY: number,
): boolean {
  if (target === null) return false;
  if (view.state.readOnly) return false;
  // The document surface is CM6's; gutters keep their own semantics.
  if (view.contentDOM.contains(target)) return false;
  if (target instanceof Element && target.closest(".cm-gutters") !== null) {
    return false;
  }
  // The scrollbar band is not text surface: the scroller's client box
  // excludes scrollbars, so a point past it is on the bar itself.
  // The client box is layout px and the point is viewport px, so the box is
  // multiplied up by CM6's own scale under a zoom.
  const scroller = view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  if (clientX > rect.left + scroller.clientWidth * view.scaleX) return false;
  if (clientY > rect.top + scroller.clientHeight * view.scaleY) return false;
  return true;
}

/**
 * Build the host click-to-caret extension. `host` is the
 * `.tug-text-editor` wrapper `TugTextEditor` renders; the listener
 * rides the host so it hears clicks on every in-host surface the
 * content box doesn't cover.
 */
export function hostClickToCaret(host: HTMLElement): Extension {
  return ViewPlugin.define((view) => {
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      if (event.defaultPrevented) return;
      if (
        !hostClickClaimsCaret(
          view,
          event.target as Node | null,
          event.clientX,
          event.clientY,
        )
      ) {
        return;
      }
      // Claim: the browser's mousedown default would clear focus to body
      // (nothing under the click is focusable). Suppress it, focus the
      // editor, and land the caret at the nearest document position.
      event.preventDefault();
      const pos = view.posAtCoords(
        { x: event.clientX, y: event.clientY },
        false,
      );
      view.focus();
      view.dispatch({
        selection: { anchor: pos },
        userEvent: "select.pointer",
      });
    };
    host.addEventListener("mousedown", onMouseDown);
    return {
      destroy(): void {
        host.removeEventListener("mousedown", onMouseDown);
      },
    };
  });
}
