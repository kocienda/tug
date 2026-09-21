/**
 * `tug-prompt-entry-submit-button` — the pure projection from a
 * `SessionSubmitButtonMode` onto the prompt-entry submit / stop button's
 * view.
 *
 * The submit button is a single `<button>` DOM node whose appearance
 * and behaviour are entirely a function of the lifecycle-derived
 * `submitButtonMode` ([L26] — one node across every mode; only the
 * label / icon / `disabled` / `data-mode` change, never the element).
 * `resolveSubmitButtonView` is that function: it maps the seven
 * `submitButtonMode` kinds onto the `data-mode` attribute CSS keys
 * off ([L06]), the per-mode `aria-label`, the `disabled` flag, the
 * icon glyph, and the danger-role flag.
 *
 * The enumeration is seven kinds. `force_stop` is the newest, and it is the
 * only *enabled* member of the stop family besides `stop` itself — a card
 * whose stop went unanswered has something left to do, and the inert
 * `stopping` glyph that used to sit there forever is the defect it replaces.
 *
 * Pure module — no DOM, no React. The button component in
 * `tug-prompt-entry.tsx` consumes this; the derivation is unit-tested
 * in isolation.
 *
 * @module components/tugways/tug-prompt-entry-submit-button
 */

import type { SessionSubmitButtonMode } from "@/lib/code-session-store/lifecycle-state";

/** The submit button's view for one `submitButtonMode` kind. */
export interface SubmitButtonView {
  /**
   * `data-mode` attribute value — CSS keys the per-mode visual
   * treatment off this. Kebab-cased (the `submitButtonMode` kinds are
   * snake-cased).
   */
  dataMode:
    | "submit"
    | "stop"
    | "force-stop"
    | "awaiting-user"
    | "stopping"
    | "reconnecting"
    | "restoring";
  /** `aria-label` for the icon-only button — the mode's accessible name. */
  ariaLabel: string;
  /**
   * Native `disabled`. True for the four inert modes; a native-disabled
   * `<button>` rejects click AND keyboard activation AND the chain
   * action-dispatch, and leaves the tab order — so this single flag is
   * the whole "keyboard activation respects disabled modes" contract
   * for the button. (The `submit` kind is never disabled here; its
   * "disabled when the prompt is empty" is editor-draft emptiness,
   * carried separately by the `data-empty` attribute + CSS.)
   */
  disabled: boolean;
  /** Which glyph the icon-only button shows. */
  icon: "submit" | "stop";
  /** `role="danger"` (the stop family) vs `role="action"` (everything else). */
  danger: boolean;
}

/**
 * Project a `submitButtonMode` onto the submit button's view. A turn
 * in flight is always `stop` — a mid-turn submit queues through the
 * separate `+` button rather than changing this primary button.
 */
export function resolveSubmitButtonView(
  mode: SessionSubmitButtonMode,
): SubmitButtonView {
  switch (mode.kind) {
    case "submit":
      return {
        dataMode: "submit",
        ariaLabel: "Send prompt",
        disabled: false,
        icon: "submit",
        danger: false,
      };
    case "stop":
      return {
        dataMode: "stop",
        ariaLabel: "Stop turn",
        disabled: false,
        icon: "stop",
        danger: true,
      };
    case "force_stop":
      // Reachable only from the `stop_stalled` overlay ([P02]), which is
      // raised only by a stop that went unanswered for its whole deadline.
      return {
        dataMode: "force-stop",
        ariaLabel: "Force stop",
        disabled: false,
        icon: "stop",
        danger: true,
      };
    case "awaiting_user":
      return {
        dataMode: "awaiting-user",
        ariaLabel: "Awaiting your input",
        disabled: true,
        icon: "submit",
        danger: false,
      };
    case "stopping":
      return {
        dataMode: "stopping",
        ariaLabel: "Stopping turn",
        disabled: true,
        icon: "stop",
        danger: true,
      };
    case "reconnecting":
      return {
        dataMode: "reconnecting",
        ariaLabel: "Reconnecting",
        disabled: true,
        icon: "submit",
        danger: false,
      };
    case "restoring":
      return {
        dataMode: "restoring",
        ariaLabel: "Restoring session",
        disabled: true,
        icon: "submit",
        danger: false,
      };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
