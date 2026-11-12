/**
 * TugSwitch — Toggle switch with track and thumb.
 *
 * Wraps @radix-ui/react-switch. Supports size variants, inline label,
 * disabled state, and role-based color injection via CSS custom properties.
 *
 * Control semantics (L11): user activation dispatches a `toggle` action
 * through the responder chain with the new boolean state as `value`
 * and a stable `sender` id for parent disambiguation. Parent
 * responders register a `toggle` action handler via `useResponder`
 * that switches on `event.sender` to route updates to the right state.
 * There is no `onCheckedChange` callback prop — the chain is the sole
 * mechanism for communicating state changes outward.
 *
 * Laws: [L06] appearance via CSS, [L11] controls emit actions,
 *       [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide
 * Decisions: [D03] appearance via stylesheet injection, [D05] component token naming,
 *            [D06] components/tugways public API
 */

import "./tug-switch.css";
import type { TugRole, TugSize } from "./tug-vocabulary";

import React, { useCallback, useId, useState } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import { useControlDispatch } from "./use-control-dispatch";
import { TUG_ACTIONS } from "./action-vocabulary";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "./use-component-state-preservation";
import { useFocusable } from "./use-focusable";
import type { FocusPolicy } from "./focus-manager";

// ---- Types ----

/** Switch size names — matches TugCheckbox/TugInput/TugButton sizes */
export type TugSwitchSize = Extract<TugSize, "xs" | "sm" | "md" | "lg">;

/**
 * Semantic role for the switch on-state color.
 *
 * Omit the role prop (or leave undefined) for the selection axis (blue) — the
 * on-state color, independent of the accent/action roles.
 * Explicit roles override with a semantic signal color.
 *
 * @selector [data-role="<role>"]
 */
export type TugSwitchRole = Extract<TugRole, "option" | "action" | "agent" | "data" | "success" | "caution" | "danger">;

/**
 * Maps role prop values to toggle-track token suffixes.
 * The prop API uses "action" but the token system uses "active"
 * (e.g., --tug7-surface-toggle-track-normal-active-rest).
 * "on" is not in this map — it's the implicit default (the selection axis) when no role is provided.
 *
 * NOTE: the `action` key here is a role-prop value, not a chain-action
 * name from `TUG_ACTIONS`. The two `action` namespaces are unrelated;
 * audit greps for `action:\s*"…"` will surface this line as a false
 * positive — it is not a dispatch site.
 */
const ROLE_TOKEN_MAP: Record<string, string> = {
  option:  "option",
  action:  "active",
  agent:   "agent",
  data:    "data",
  success: "success",
  caution: "caution",
  danger:  "danger",
};

/**
 * TugSwitch props. They extend the Radix root's, less the ones the switch
 * redefines: its checked state, its `role` (a colour role, not an ARIA one),
 * and the change callback, which it replaces with a `toggle` dispatch [L11].
 */
export interface TugSwitchProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
    "checked" | "defaultChecked" | "onCheckedChange" | "role" | "asChild" | "children"
  > {
  /**
   * Controlled checked state.
   * @selector [data-state="checked"] | [data-state="unchecked"]
   */
  checked?: boolean;
  /** Default checked state (uncontrolled). */
  defaultChecked?: boolean;
  /**
   * Stable identifier passed as `event.sender` on every `toggle`
   * action dispatched by this switch. Parent responders use this to
   * disambiguate multi-switch forms in their `toggle` handler.
   * Defaults to a `useId()`-derived unique string — set explicitly
   * when the parent needs a predictable id (e.g. for form routing
   * by semantic name).
   */
  senderId?: string;
  /** Inline label text. Renders a wrapping label element. */
  label?: string;
  /**
   * Visual size variant.
   * @selector .tug-switch-size-xs | .tug-switch-size-sm | .tug-switch-size-md | .tug-switch-size-lg
   * @default "md"
   */
  size?: TugSwitchSize;
  /**
   * Disables the switch.
   * @selector :disabled | [data-disabled]
   * @default false
   */
  disabled?: boolean;
  /** Form field name. */
  name?: string;
  /** Form field value. */
  value?: string;
  /**
   * Marks the field as required for form validation.
   * @default false
   */
  required?: boolean;
  /**
   * Additional CSS class names on the switch root (`data-slot="tug-switch"`),
   * with or without a label.
   */
  className?: string;
  /** Accessibility label when no visible label is provided. */
  "aria-label"?: string;
  /**
   * Semantic role for the on-state track color. Omit for the selection axis (blue).
   * Injects --tugx-toggle-on-color, --tugx-toggle-on-hover-color, and
   * --tugx-toggle-disabled-color as inline CSS custom properties.
   *
   * Single path, zero branches. [L06]
   *
   * @selector [data-role="<role>"]
   */
  role?: TugSwitchRole;
  /**
   * Opt the switch into the Component State Preservation Protocol
   * ([D13], [A9]). When provided (and rendered inside a card), the
   * checked state is captured into
   * `bag.components[componentStatePreservationKey]` at every save
   * trigger and reapplied on the next mount. Controlled mode
   * dispatches a `toggle` action through the responder chain on
   * restore (best-effort — the parent state owner reconciles);
   * uncontrolled mode mirrors Radix's checked state in `useState`
   * so restore can set it directly.
   *
   * Absence means "not preserved" — gallery demos and standalone
   * tests that render the switch outside a card stay unaffected.
   */
  componentStatePreservationKey?: string;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this switch is authored into ([P02]). When set, the switch
   * registers as a focusable and becomes a stop in the engine's Tab walk; when
   * omitted, it stays a plain native focus stop (the global ring still paints on
   * keyboard focus). Supplied by the surface that owns the Tab order.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /**
   * Walk policy when registered: `accept` (default) is an ordinary Tab stop;
   * `skip` is reachable only in accessibility mode.
   */
  focusPolicy?: FocusPolicy;
}

/** Serialized shape of `TugSwitch`'s preserved state. */
interface TugSwitchState {
  checked: boolean;
}

// ---- TugSwitch ----

export const TugSwitch = React.forwardRef<HTMLButtonElement, TugSwitchProps>(
  function TugSwitch(
    {
      checked,
      defaultChecked,
      senderId,
      label,
      size = "md",
      disabled = false,
      name,
      value,
      required = false,
      className,
      style,
      "aria-label": ariaLabel,
      role,
      componentStatePreservationKey,
      focusGroup,
      focusOrder = 0,
      focusPolicy,
      ...rest
    },
    ref,
  ) {
    const boxDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || boxDisabled;

    // Chain dispatch [L11]: targeted dispatch of `toggle` to the
    // parent responder with the new boolean state as `value` and a
    // stable sender id. Outside a provider the dispatch is a no-op.
    const { dispatch: controlDispatch } = useControlDispatch();
    const fallbackId = useId();
    const effectiveSenderId = senderId ?? fallbackId;

    // Focus-engine registration ([P01]): the switch joins the Tab walk only
    // when a surface authors it into a focus group ([P02]); otherwise it stays a
    // native focus stop. The engine lands the key view on the Radix Root and the
    // global ring paints on keyboard focus ([P05]). Space/Enter toggle natively
    // (Radix). The switch keeps `data-tug-focus="refuse"`: clicking it dispatches
    // `toggle` without moving the key view.
    const autoFocusId = useId();
    const { focusableRef } = useFocusable({
      id: autoFocusId,
      group: focusGroup ?? "",
      order: focusOrder,
      policy: focusPolicy,
      register: focusGroup !== undefined,
    });
    const setRefs = useCallback(
      (node: HTMLButtonElement | null) => {
        focusableRef(node);
        if (typeof ref === "function") ref(node);
        else if (ref !== null && ref !== undefined) {
          (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
        }
      },
      [ref, focusableRef],
    );

    // Mirror Radix's checked state in `useState` for the uncontrolled
    // path so `useComponentStatePreservation` can read/write it. When
    // the parent supplies `checked`, that's classic controlled mode and
    // the parent owns truth. Same shape as `tug-checkbox`'s opt-in.
    const isExternallyControlled = checked !== undefined;
    const savedSwitchState = useSavedComponentState<TugSwitchState>(
      componentStatePreservationKey,
    );
    const [internalChecked, setInternalChecked] = useState<boolean>(
      () =>
        typeof savedSwitchState?.checked === "boolean"
          ? savedSwitchState.checked
          : (defaultChecked ?? false),
    );
    const effectiveChecked = isExternallyControlled
      ? checked
      : internalChecked;

    const handleCheckedChange = useCallback(
      (next: boolean) => {
        if (!isExternallyControlled) {
          setInternalChecked(next);
        }
        controlDispatch({
          action: TUG_ACTIONS.TOGGLE,
          value: next,
          sender: effectiveSenderId,
          phase: "discrete",
        });
      },
      [controlDispatch, effectiveSenderId, isExternallyControlled],
    );

    // Opt-in Component State Preservation Protocol. Hook no-ops when
    // `componentStatePreservationKey` is undefined. Capture reads
    // `effectiveChecked`; the mount-in-saved-state half lives above in
    // `useState`'s initializer. The controlled path doesn't re-dispatch
    // on restore because the parent responder owns the value and has
    // its own saved state via [A9]. [D13] / [A9].
    useComponentStatePreservation<TugSwitchState>({
      componentStatePreservationKey,
      captureState: () => ({ checked: effectiveChecked === true }),
    });

    // Role injection — every path injects surface-toggle-track tokens. [L06]
    // No role prop = the `on` role (the selection axis, blue) — decoupled from
    // the accent role so a role recolor never moves the on color.
    const tokenSuffix = role ? (ROLE_TOKEN_MAP[role] ?? role) : "on";
    const roleStyle = {
      "--tugx-toggle-on-color": `var(--tug7-surface-toggle-track-normal-${tokenSuffix}-rest)`,
      "--tugx-toggle-on-hover-color": `var(--tug7-surface-toggle-track-normal-${tokenSuffix}-hover)`,
      "--tugx-toggle-disabled-color": `var(--tug7-surface-toggle-track-normal-${tokenSuffix}-disabled)`,
    } as React.CSSProperties;

    const switchNode = (
      <SwitchPrimitive.Root
        ref={setRefs}
        data-slot="tug-switch"
        checked={effectiveChecked}
        disabled={effectiveDisabled}
        name={name}
        value={value}
        required={required}
        aria-label={!label ? ariaLabel : undefined}
        className={cn("tug-switch", `tug-switch-size-${size}`, className)}
        style={{ ...roleStyle, ...style }}
        {...rest}
        data-role={role}
        data-tug-focus="refuse"
        onCheckedChange={handleCheckedChange}
      >
        <SwitchPrimitive.Thumb className="tug-switch-thumb" />
      </SwitchPrimitive.Root>
    );

    if (!label) {
      return switchNode;
    }

    return (
      <label
        className={cn("tug-switch-wrapper", effectiveDisabled && "tug-switch-wrapper-disabled")}
      >
        {switchNode}
        <span className={cn("tug-switch-label", `tug-switch-label-${size}`)}>
          {label}
        </span>
      </label>
    );
  },
);
