/**
 * TugIconButton — icon button for in-list trailing actions.
 *
 * Encapsulates the compose pattern that any trailing-action icon button on a
 * `TugListView` cell (or any in-cell control) needs. Its focus behavior has
 * two independent axes (TugButton's split):
 *
 *  - **Click refusal** — always on: `data-tug-focus="refuse"`, so clicking
 *    the button does NOT promote the chain or move browser focus off the
 *    active editor.
 *  - **Keyboard authoring** — opt-in: `focusGroup` / `focusOrder` /
 *    `focusPolicy` register the button as an engine focusable
 *    (`data-tug-focusable`). Inside a `TugListView` cell the registration
 *    lands in the row's own focus scope (the per-row `FocusModeContext`),
 *    so the button is reachable by descend (ArrowRight / Enter onto the
 *    row) but never appears in the surface's Tab cycle.
 *  - Targeted dispatch via `useControlDispatch()` — payload-carrying
 *    `ActionEvent` reaches the parent responder, not the first responder.
 *  - Standard hover / focus / active styling via the underlying
 *    `TugButton`'s emphasis-role tokens.
 *
 * Why this primitive exists. Per `tuglaws/responder-chain.md` §Focus
 * acceptance, a button that takes browser focus but not chain promotion (or
 * vice versa) is incoherent. Raw `<button>` elements in cells inevitably
 * end up that way — they accept browser focus on click in Chrome, promote
 * the chain via the document-level pointerdown walk, AND fire any wrapping
 * Radix Trigger handlers. TugIconButton bakes in the four-attribute compose
 * pattern (focus refusal + targeted dispatch + ghost styling + size variants)
 * so consumers cannot accidentally produce a non-conformant control.
 *
 * ## Two dispatch modes
 *
 * `TugIconButton` supports two mutually-exclusive ways of responding to a
 * click:
 *
 *  - **Chain-action mode** (`action` prop, with an optional `value`
 *    payload): on click the button sends a discrete `ActionEvent` to the
 *    parent responder via `useControlDispatch().dispatch`. This
 *    is the canonical mode for in-list row actions where the responder
 *    (typically the form above the list) handles the resulting state
 *    change. The action vocabulary lives in `action-vocabulary.ts`.
 *  - **Direct-action mode** (`onClick` prop): the button calls a callback
 *    directly. This exists for one-off cases where the side effect doesn't
 *    fit the chain vocabulary; new code should prefer chain-action mode.
 *
 * The two modes are mutually exclusive: passing both is a programming
 * error and produces a dev-mode console warning. The plumbed click runs
 * the action if `action` is set, falls back to `onClick` otherwise.
 *
 * ## Sender id convention
 *
 * The event's `sender` is the caller's `senderId`, or a stable `useId()`
 * value when none is given, so handlers that disambiguate by sender always
 * have something to look at.
 *
 * ## Visual model
 *
 * Wraps `TugButton` with `subtype="icon"` and `emphasis="ghost"`, and
 * forwards `role` unchanged:
 *
 *  - `role="action"` (default) — neutral icon affordance.
 *  - `role="danger"` — destructive trash / remove
 *    icon, painted with the danger token family on hover/active.
 *
 * Sizing maps directly to `TugButton`'s `size`:
 *
 *  - `size="xs"`           → `tug-button-icon-xs` — the most compact,
 *    for trailing actions tucked into dense rows.
 *  - `size="sm"`           → `tug-button-icon-sm` — list-row trailing
 *    actions (~14×14 icon, 24×24 hit target).
 *  - `size="md"` (default) → `tug-button-icon-md` — denser toolbars.
 *
 * Hover / focus / active treatment comes from the existing
 * `tug-button-ghost-{action,danger}` selectors in `tug-button.css` — no
 * new tokens, no new styles ([L20]).
 *
 * Laws:
 *  - [L06] visual state via DOM attributes + CSS; the click handler does
 *    not setState for visual purposes.
 *  - [L11] controls emit actions; the chain-action mode is the canonical
 *    L11 shape.
 *  - [L19] component authoring guide.
 *  - [L20] no new tokens; styling delegates to `tug-button.css`.
 *
 * @module components/tugways/tug-icon-button
 */

import "./tug-icon-button.css";

import React from "react";
import { cn } from "@/lib/utils";
import { TugButton } from "./internal/tug-button";
import type { TugButtonEmphasis, TugButtonRole, TugButtonRounded } from "./internal/tug-button";
import type { TugSize } from "./tug-vocabulary";
import type { FocusPolicy } from "./focus-manager";
import type { ActionEvent, TugAction } from "./responder-chain";
import { useControlDispatch } from "./use-control-dispatch";

/* ---------------------------------------------------------------------------
 * TugIconButtonProps
 * ---------------------------------------------------------------------------*/

/**
 * TugIconButton props.
 *
 * Extends `ButtonHTMLAttributes` for the same reason `TugButton` does: a
 * Radix `asChild` primitive composes by *injecting* props — pointer
 * handlers, `data-state`, `aria-describedby` — onto whatever element it is
 * given. A component that names a fixed prop list and drops the rest
 * silently refuses that composition: the wrapper renders, the handlers
 * never land, and the tooltip (or popover, or context menu) simply never
 * opens, with nothing anywhere to say why.
 */
export interface TugIconButtonProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "onClick" | "title" | "disabled" | "aria-label" | "role" | "value"
  > {
  /** Icon node. Typically a `lucide-react` icon. Required. */
  icon: React.ReactNode;
  /** Accessible label. Required for icon-only buttons. */
  "aria-label": string;
  /** Optional native tooltip (mirrors `aria-label` in many cases). */
  title?: string;
  /**
   * Chain-action mode: the action dispatched on click, as a discrete
   * `ActionEvent`, via `useControlDispatch()`. Mutually exclusive with
   * `onClick`.
   */
  action?: TugAction;
  /** Payload for {@link action}, shipped as the event's `value`. */
  value?: unknown;
  /**
   * Direct-action mode: callback fired on click. Mutually exclusive
   * with `action`. Prefer `action` for chain-routable actions.
   */
  onClick?: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  /**
   * Disable interaction. The button stays in the tab order with
   * reduced opacity (`aria-disabled`-style); follows TugButton's
   * disabled semantics.
   */
  disabled?: boolean;
  /**
   * Size variant.
   *
   *  - `"2xs"`          — the most compact chip (20×20), e.g. a per-row
   *    un-send affordance.
   *  - `"xs"`           — dense affordance.
   *  - `"sm"`           — list-row trailing icon (24×24 hit target).
   *  - `"md"` (default) — denser toolbar action.
   */
  size?: Extract<TugSize, "2xs" | "xs" | "sm" | "md">;
  /**
   * Semantic role, forwarded to the underlying `TugButton`:
   *
   *  - `"action"` (default) — neutral icon affordance.
   *  - `"danger"` — destructive trash icon.
   */
  role?: Extract<TugButtonRole, "action" | "danger">;
  /**
   * Visual weight — forwarded to the underlying `TugButton`.
   *
   *  - `"ghost"` (default) — borderless, the canonical in-list trailing
   *    affordance.
   *  - `"outlined"` — a bordered box so the control's edge aligns with the
   *    surrounding margins.
   *  - `"filled"` — a solid fill, for a destructive affordance that should
   *    read as a deliberate button (e.g. a queued-row un-send ✕).
   */
  emphasis?: Extract<TugButtonEmphasis, "ghost" | "outlined" | "filled">;
  /**
   * Corner radius — forwarded to the underlying `TugButton`. Omit for the
   * size-proportional default (a rounded square); pass `"none"` for a
   * square icon button (e.g. a corner-flush overlay badge) or `"full"`
   * for a circle.
   */
  rounded?: TugButtonRounded;
  /**
   * Stable sender id carried on the dispatched event. Auto-derived via
   * `useId()` if omitted. Override in tests for deterministic chain
   * logging.
   */
  senderId?: string;
  /**
   * Focus group this button is authored into (forwarded to TugButton).
   * When set, the button registers as an engine focusable and becomes
   * keyboard-reachable — inside a list cell, via the row's descend
   * scope. Click refusal is unaffected. Omitted (the default) leaves
   * the button keyboard-invisible, as before.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Forwarded to TugButton. */
  focusOrder?: number;
  /** Walk policy when registered. Forwarded to TugButton. */
  focusPolicy?: FocusPolicy;
  /** Additional CSS class names. */
  className?: string;
  /**
   * `data-slot` for the rendered button. Defaults to `"tug-icon-button"`; a
   * caller that scopes its own CSS or tests to the control (a masthead
   * widget, say) names its own slot here.
   */
  "data-slot"?: string;
}

/* ---------------------------------------------------------------------------
 * TugIconButton
 * ---------------------------------------------------------------------------*/

/**
 * Icon button for in-list trailing actions — click-focus-refusing,
 * optionally keyboard-authored via `focusGroup`.
 *
 * See module docstring for the dispatch-mode contract, sender-id
 * convention, focus axes, and visual model.
 */
export const TugIconButton = React.forwardRef<HTMLButtonElement, TugIconButtonProps>(
  function TugIconButton(
    {
      icon,
      "aria-label": ariaLabel,
      title,
      action,
      value,
      onClick,
      disabled = false,
      size = "md",
      role = "action",
      emphasis = "ghost",
      rounded,
      senderId: senderIdProp,
      focusGroup,
      focusOrder,
      focusPolicy,
      className,
      "data-slot": dataSlot,
      ...rest
    },
    ref,
  ) {
    const fallbackSenderId = React.useId();
    const senderId = senderIdProp ?? fallbackSenderId;

    const { dispatch: controlDispatch } = useControlDispatch();

    // Dev-mode warning when both modes are set. Mutually exclusive per the
    // module-level contract: the chain-action mode is canonical, the
    // direct-action mode is a fallback for non-chain side effects. Mixing
    // them silently picks `action` and ignores `onClick`, which is
    // surprising; the warn surfaces the bug.
    React.useEffect(() => {
      if (
        action !== undefined &&
        onClick !== undefined &&
        process.env.NODE_ENV !== "production"
      ) {
        console.warn(
          "TugIconButton: `action` and `onClick` are mutually exclusive. " +
            "When `action` is set, the chain dispatches on click; `onClick` is ignored.",
        );
      }
    }, [action, onClick]);

    // Click handler: chain-action mode wins when `action` is set.
    // Direct-action mode falls through to `onClick`. A button with
    // neither an `action`
    // nor `onClick` is inert — useful for purely decorative-icon-but-must-
    // be-button cases (rare, but the alternative would be a crash).
    function handleClick(e?: React.MouseEvent<HTMLButtonElement>) {
      if (action !== undefined) {
        const event: ActionEvent = { action, value, sender: senderId, phase: "discrete" };
        controlDispatch(event);
        return;
      }
      onClick?.(e);
    }

    // Emphasis defaults to `ghost` — TugIconButton is intentionally narrow;
    // `outlined` is the one earned addition for callsites that need a
    // bordered, margin-aligned edge.

    return (
      <TugButton
        ref={ref}
        data-slot={dataSlot ?? "tug-icon-button"}
        className={cn("tug-icon-button", className)}
        {...rest}
        subtype="icon"
        emphasis={emphasis}
        rounded={rounded}
        role={role}
        size={size}
        icon={icon}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={handleClick}
        focusGroup={focusGroup}
        focusOrder={focusOrder}
        focusPolicy={focusPolicy}
      />
    );
  },
);
