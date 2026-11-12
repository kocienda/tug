/**
 * `TugDialogButton` — rich-label dialog button (peer of `TugPushButton`).
 *
 * Where `TugPushButton` is sized for terse imperatives ("Allow", "OK",
 * "Discard") in ALL CAPS letterspacing, `TugDialogButton` is sized for
 * sentence-case prose: a primary label plus an optional rich
 * description (Apple HIG settings-row pattern). It is the right
 * primitive for any dialog-context secondary action whose label needs
 * room to breathe — `PermissionDialog`'s suggestion buttons today,
 * `QuestionDialog`'s option list tomorrow, and any future inline-CTA
 * confirm whose copy is more than a verb.
 *
 * Two modes, discriminated by the `selected` prop:
 *
 *   - **Action mode** (`selected === undefined`) — a plain clickable
 *     button. The `trailing` slot is honored (chevron, shortcut hint).
 *   - **Choice mode** (`selected: boolean`) — a selectable row in a
 *     list. The selection affordance is rendered to the trailing edge
 *     per `selectionStyle` (`"check"` for multi-select / standalone
 *     toggles; `"radio"` for single-select groups). The `trailing` slot
 *     is ignored in choice mode (the selection affordance owns it).
 *
 * Layout (Apple HIG settings row):
 *
 *     +----------------------------------------+
 *     |  Allow for this session    [trailing]  |
 *     |  Permits this command for the          |
 *     |  duration of the current Dev session. |
 *     +----------------------------------------+
 *
 * Visual continuity with `TugPushButton`'s outlined-action variant —
 * the role-{action,danger} cascade composes the same `--tug7-*`
 * surface and border tokens so the two button primitives read as a
 * family even when stacked together.
 *
 * Laws:
 *  - [L06] appearance via DOM attributes (`data-role`, `data-selected`,
 *    `data-mode`, `data-selection-style`) + CSS, not React state. The
 *    primitive owns no React state — props drive attributes drive
 *    paint.
 *  - [L17] every `--tugx-dialog-button-*` slot resolves to a
 *    `--tug7-*` / `--tug-*` base token in one hop.
 *  - [L19] component authoring guide — file pair, module docstring,
 *    exported props interface, `data-slot="tug-dialog-button"` on the
 *    root.
 *  - [L20] component-token sovereignty — owns the
 *    `--tugx-dialog-button-*` slot family ([Table T07]); composes no
 *    other component's tokens.
 *  - [L24] state zoning — no React state inside the primitive.
 *  - [L11] a press dispatches `action` (with `value` and `senderId`) to the
 *    parent responder through the chain; there is no click callback.
 *
 * Decisions:
 *  - [D13] inline (not modal) prompts; this primitive composes inside
 *    `TugInlineDialog` (or any other dialog frame) as a secondary
 *    action.
 *
 * @module components/tugways/tug-dialog-button
 */

import "./tug-dialog-button.css";
import type { TugRole } from "./tug-vocabulary";

import React from "react";
import { CircleCheckBig } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TugAction } from "./action-vocabulary";
import { useControlDispatch } from "./use-control-dispatch";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Color domain. `action` paints the standard outline; `danger` paints the destructive variant. */
export type TugDialogButtonRole = Extract<TugRole, "action" | "danger">;

/**
 * Selection-affordance shape for choice mode. Ignored when `selected`
 * is `undefined` (action mode).
 *
 *  - `"check"` — `<Check/>` icon visible when selected, blank
 *    placeholder reserving the same width when not. Multi-select /
 *    standalone-toggle pattern.
 *  - `"radio"` — filled disc when selected, hollow ring when not.
 *    Single-select group pattern.
 */
export type TugDialogButtonSelectionStyle = "check" | "radio";

export interface TugDialogButtonProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "onClick" | "children" | "role" | "value" | "type" | "disabled"
  > {
  /** Primary action label — sentence-case, semibold. NOT uppercased. */
  label: string;
  /**
   * Optional secondary explanation. ReactNode so consumers can embed
   * inline `<code>`, links, small icons.
   */
  description?: React.ReactNode;
  /**
   * Selected state for choice mode. `undefined` → action mode (plain
   * clickable button, no selection affordance). `boolean` → choice
   * mode (renders the selection affordance per `selectionStyle`).
   */
  selected?: boolean;
  /**
   * Selection-affordance style for choice mode. Ignored when
   * `selected` is `undefined`.
   *
   * @default "check"
   */
  selectionStyle?: TugDialogButtonSelectionStyle;
  /**
   * Optional trailing-edge content for the title row (chevron leading
   * to another surface, keyboard-shortcut hint). Ignored in choice
   * mode (the selection affordance owns the trailing edge then).
   */
  trailing?: React.ReactNode;
  /**
   * Color domain. `action` (default) paints the standard outline;
   * `danger` paints the destructive variant.
   *
   * @default "action"
   */
  role?: TugDialogButtonRole;
  /** Disable the button. Renders the disabled visual treatment and ignores clicks. */
  disabled?: boolean;
  /**
   * The action a press dispatches to the parent responder ([L11]). Not
   * dispatched when {@link disabled} is true; with no action, a press does
   * nothing.
   */
  action?: TugAction;
  /** The press's `event.value` — the choice or item the button stands for. */
  value?: unknown;
  /**
   * The press's `event.sender`, so a responder that hosts several dialog
   * buttons or groups can tell them apart.
   */
  senderId?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite.
// ---------------------------------------------------------------------------

/**
 * Mode discriminator. `undefined` → `"action"`; `boolean` → `"choice"`.
 * Pure; exported for tests.
 */
export type TugDialogButtonMode = "action" | "choice";

export function resolveDialogButtonMode(
  selected: boolean | undefined,
): TugDialogButtonMode {
  return selected === undefined ? "action" : "choice";
}

/** Default selection-affordance style when the consumer omits `selectionStyle`. */
export const DEFAULT_SELECTION_STYLE: TugDialogButtonSelectionStyle = "check";

/**
 * Resolve the effective selection style. Action-mode buttons return
 * `null` (no selection affordance is rendered). Choice-mode buttons
 * resolve `undefined` to {@link DEFAULT_SELECTION_STYLE}. Pure;
 * exported for tests.
 */
export function resolveSelectionStyle(
  mode: TugDialogButtonMode,
  selectionStyle: TugDialogButtonSelectionStyle | undefined,
): TugDialogButtonSelectionStyle | null {
  if (mode !== "choice") return null;
  return selectionStyle ?? DEFAULT_SELECTION_STYLE;
}

/** Default color-domain role when the consumer omits `role`. */
export const DEFAULT_DIALOG_BUTTON_ROLE: TugDialogButtonRole = "action";

/** Resolve the effective role, defaulting to {@link DEFAULT_DIALOG_BUTTON_ROLE}. */
export function resolveDialogButtonRole(
  role: TugDialogButtonRole | undefined,
): TugDialogButtonRole {
  return role ?? DEFAULT_DIALOG_BUTTON_ROLE;
}

/**
 * Resolve the accessible name. Falls back to `label` when `aria-label`
 * is omitted. Pure; exported for tests.
 *
 * Returning a string (never `undefined`) lets the JSX consumer pass
 * the result straight through to `aria-label` without conditional
 * logic; the underlying `<button>` always has a meaningful accessible
 * name even when the visible label drifts from the screen-reader
 * label intentionally.
 */
export function resolveDialogButtonAriaLabel(
  label: string,
  ariaLabel: string | undefined,
): string {
  return ariaLabel ?? label;
}

/**
 * Whether the trailing slot should render. False when `trailing` is
 * absent, *or* when the button is in choice mode (the selection
 * affordance owns the trailing edge). Pure; exported for tests.
 */
export function shouldRenderTrailing(
  mode: TugDialogButtonMode,
  trailing: React.ReactNode,
): boolean {
  if (mode === "choice") return false;
  return trailing !== undefined && trailing !== null && trailing !== false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Rich-label dialog button. See module docstring for layout, prop
 * contract, and law cross-check.
 */
export const TugDialogButton = React.forwardRef<
  HTMLButtonElement,
  TugDialogButtonProps
>(function TugDialogButton(
  {
    label,
    description,
    selected,
    selectionStyle,
    trailing,
    role,
    disabled = false,
    action,
    value,
    senderId,
    "aria-label": ariaLabel,
    className,
    ...rest
  },
  ref,
) {
  const mode = resolveDialogButtonMode(selected);
  const resolvedSelectionStyle = resolveSelectionStyle(mode, selectionStyle);
  const resolvedRole = resolveDialogButtonRole(role);
  const resolvedAriaLabel = resolveDialogButtonAriaLabel(label, ariaLabel);
  const renderTrailing = shouldRenderTrailing(mode, trailing);
  const hasDescription =
    description !== undefined && description !== null && description !== false;

  const { dispatch } = useControlDispatch();
  const handleClick = (): void => {
    if (disabled || action === undefined) return;
    dispatch({ action, value, sender: senderId, phase: "discrete" });
  };

  // ARIA semantics differ by mode:
  //   - Action mode → plain button (native semantics).
  //   - Choice mode "check" → role="checkbox" + aria-checked (independent toggle).
  //   - Choice mode "radio" → role="radio" + aria-checked (single-select group).
  // The consumer is responsible for wrapping radio-style buttons in a
  // role="radiogroup" container so screen readers announce them as a
  // single-select group; the primitive does not impose a wrapper.
  const ariaRole: React.AriaRole | undefined =
    mode === "choice"
      ? resolvedSelectionStyle === "radio"
        ? "radio"
        : "checkbox"
      : undefined;
  const ariaChecked: boolean | undefined =
    mode === "choice" ? Boolean(selected) : undefined;

  return (
    <button
      ref={ref}
      data-slot="tug-dialog-button"
      className={cn("tug-dialog-button", className)}
      {...rest}
      type="button"
      data-mode={mode}
      data-role={resolvedRole}
      data-selected={mode === "choice" ? (selected ? "true" : "false") : undefined}
      data-selection-style={resolvedSelectionStyle ?? undefined}
      role={ariaRole}
      aria-checked={ariaChecked}
      aria-label={resolvedAriaLabel}
      aria-disabled={disabled ? "true" : undefined}
      disabled={disabled}
      onClick={handleClick}
    >
      <span className="tug-dialog-button-stack">
        <span className="tug-dialog-button-title-row">
          <span className="tug-dialog-button-label">{label}</span>
          {renderTrailing ? (
            <span
              className="tug-dialog-button-trailing"
              aria-hidden="true"
              data-slot="tug-dialog-button-trailing"
            >
              {trailing}
            </span>
          ) : null}
          {resolvedSelectionStyle !== null ? (
            <span
              className="tug-dialog-button-selection"
              data-slot="tug-dialog-button-selection"
              aria-hidden="true"
            >
              {resolvedSelectionStyle === "check" ? (
                <SelectionCheck selected={Boolean(selected)} />
              ) : (
                <SelectionRadio />
              )}
            </span>
          ) : null}
        </span>
        {hasDescription ? (
          <span
            className="tug-dialog-button-description"
            data-slot="tug-dialog-button-description"
          >
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// Selection-affordance sub-components
// ---------------------------------------------------------------------------

/**
 * Check-style selection affordance. The `<CircleCheckBig/>` glyph
 * paints when selected; an empty `aria-hidden` placeholder of the
 * same intrinsic size paints otherwise. Reserving the placeholder
 * keeps the row width invariant between selected and unselected
 * siblings in a list.
 *
 * `CircleCheckBig` (filled-circle outline with check) is chosen over
 * the bare `Check` glyph for visual weight — a check standing alone
 * inside a wide title row reads as faint marginalia next to the
 * sentence-case label; the encircled mark holds its own.
 *
 * The glyph color is driven by `--tugx-dialog-button-selection-fill`
 * via the `.tug-dialog-button-selection-check` CSS rule — Lucide
 * inherits `color` through `currentColor`, so the rich accent fill
 * paints automatically without any inline style on the icon.
 */
function SelectionCheck({ selected }: { selected: boolean }): React.ReactElement {
  return selected ? (
    <CircleCheckBig className="tug-dialog-button-selection-check" />
  ) : (
    <span className="tug-dialog-button-selection-check-placeholder" />
  );
}

/**
 * Radio-style selection affordance. Always rendered; the outer ring is
 * the rest treatment, the inner dot the selected one. The selected /
 * unselected swap is owned entirely by CSS via the parent's
 * `[data-selected]` attribute — see `.tug-dialog-button[data-selected="true"]
 * .tug-dialog-button-selection-radio*` rules in the stylesheet.
 */
function SelectionRadio(): React.ReactElement {
  return (
    <span className="tug-dialog-button-selection-radio">
      <span className="tug-dialog-button-selection-radio-dot" />
    </span>
  );
}
