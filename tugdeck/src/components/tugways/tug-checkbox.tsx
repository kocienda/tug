/**
 * TugCheckbox — Accessible checkbox with checked, unchecked, and indeterminate states.
 *
 * Wraps @radix-ui/react-checkbox. Supports three checked states (checked, unchecked,
 * indeterminate), inline label, size variants, disabled state, and role-based color
 * injection via CSS custom properties.
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

import "./tug-checkbox.css";
import type { TugRole, TugSize } from "./tug-vocabulary";

import React, { useCallback, useId, useState } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
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

/** Checkbox size names — matches TugInput/TugButton sizes */
export type TugCheckboxSize = Extract<TugSize, "sm" | "md" | "lg">;

/** Re-export Radix checked state for convenience */
export type TugCheckedState = boolean | "indeterminate";

/**
 * Semantic role for the checkbox on-state color.
 *
 * Omit the role prop (or leave undefined) for the selection axis (blue) — the
 * checked color, independent of the accent/action roles.
 * Explicit roles override with a semantic signal color.
 *
 * @selector [data-role="<role>"]
 */
export type TugCheckboxRole = Extract<TugRole, "option" | "action" | "agent" | "data" | "success" | "caution" | "danger">;

/**
 * Maps role prop values to toggle-primary token suffixes.
 * The prop API uses "action" but the token system uses "active"
 * (e.g., --tug7-surface-toggle-primary-normal-active-rest).
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
 * TugCheckbox props. They extend the Radix root's, less the ones the checkbox
 * redefines: its checked state, its `role` (a colour role, not an ARIA one),
 * and the change callback, which it replaces with a `toggle` dispatch [L11].
 */
export interface TugCheckboxProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
    "checked" | "defaultChecked" | "onCheckedChange" | "role" | "asChild" | "children"
  > {
  /**
   * Controlled checked state. Supports true, false, or "indeterminate".
   * @selector [data-state="checked"] | [data-state="unchecked"] | [data-state="indeterminate"]
   */
  checked?: TugCheckedState;
  /** Default checked state (uncontrolled). */
  defaultChecked?: TugCheckedState;
  /**
   * Stable identifier passed as `event.sender` on every `toggle`
   * action dispatched by this checkbox. Parent responders use this
   * to disambiguate multi-checkbox forms in their `toggle` handler.
   * Defaults to a `useId()`-derived unique string — set explicitly
   * when the parent needs a predictable id (e.g. for form routing
   * by semantic name).
   */
  senderId?: string;
  /** Inline label text. Renders a wrapping label element. */
  label?: string;
  /**
   * Visual size variant.
   * @selector .tug-checkbox-size-sm | .tug-checkbox-size-md | .tug-checkbox-size-lg
   * @default "md"
   */
  size?: TugCheckboxSize;
  /**
   * Disables the checkbox.
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
   * Additional CSS class names on the checkbox root (`data-slot="tug-checkbox"`),
   * with or without a label.
   */
  className?: string;
  /** Accessibility label when no visible label is provided. */
  "aria-label"?: string;
  /**
   * Semantic role for the on-state color. Omit for the selection axis (blue).
   * Injects --tugx-toggle-on-color, --tugx-toggle-on-hover-color, and
   * --tugx-toggle-disabled-color as inline CSS custom properties.
   *
   * Single path, zero branches. [L06]
   *
   * @selector [data-role="<role>"]
   */
  role?: TugCheckboxRole;
  /**
   * Opt the checkbox into the Component State Preservation Protocol
   * ([D13], [A9]). When provided (and rendered inside a card), the
   * checkbox's checked state is captured into
   * `bag.components[componentStatePreservationKey]` at save time and
   * reapplied on the next card mount.
   *
   * Controlled (`checked` prop provided): restore dispatches a `toggle`
   * action through the responder chain so the parent state owner
   * updates — best-effort, since the parent is the source of truth. In
   * uncontrolled mode, the checkbox tracks its own state internally so
   * restore can programmatically update it.
   *
   * Keys are unique within a card scope (the registry enforces this in
   * dev via a throw); use `<ComponentStatePreservationScope prefix="…">`
   * to namespace embedded checkboxes.
   *
   * Absence of `componentStatePreservationKey` means "not preserved" —
   * gallery demos and tests that render the checkbox standalone stay
   * unaffected.
   */
  componentStatePreservationKey?: string;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this checkbox is authored into ([P02]). When set, the checkbox
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

/** Serialized shape of `TugCheckbox`'s preserved state. */
interface TugCheckboxState {
  checked: boolean;
}

// ---- TugCheckbox ----

export const TugCheckbox = React.forwardRef<HTMLButtonElement, TugCheckboxProps>(
  function TugCheckbox(
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

    // Focus-engine registration ([P01]): the checkbox joins the Tab walk only
    // when a surface authors it into a focus group ([P02]); otherwise it stays a
    // native focus stop. The engine lands the key view on the Radix Root and the
    // global ring paints on keyboard focus ([P05]). Space toggles natively
    // (Radix); Return delegates to the scope default — the checkbox never claims
    // it ([P12]). The checkbox keeps `data-tug-focus="refuse"`: clicking it
    // dispatches `toggle` without moving the key view.
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

    // When the parent supplies `checked`, it owns the source of truth
    // (classic controlled mode). When it doesn't, Radix normally owns
    // internal state via `defaultChecked` — but that state is opaque
    // to us, so we can't programmatically restore it. To keep opt-in
    // state preservation working cleanly in the uncontrolled case,
    // mirror Radix's state in our own `useState` when
    // `componentStatePreservationKey` is set and pass it to Radix as
    // `checked`. The user still clicks the same element;
    // `handleCheckedChange` keeps the mirror in sync.
    const isExternallyControlled = checked !== undefined;
    const savedCheckboxState = useSavedComponentState<TugCheckboxState>(
      componentStatePreservationKey,
    );
    const [internalChecked, setInternalChecked] = useState<TugCheckedState>(
      () =>
        typeof savedCheckboxState?.checked === "boolean"
          ? savedCheckboxState.checked
          : (defaultChecked ?? false),
    );
    const effectiveChecked = isExternallyControlled
      ? checked
      : internalChecked;

    const handleCheckedChange = useCallback(
      (next: TugCheckedState) => {
        // Radix only emits `boolean` on user activation; the
        // "indeterminate" state is programmatic-only. Coerce
        // defensively so the `toggle` payload contract (boolean) is
        // never violated even if Radix emits it unexpectedly.
        const nextBool = next === true;
        if (!isExternallyControlled) {
          setInternalChecked(nextBool);
        }
        controlDispatch({
          action: TUG_ACTIONS.TOGGLE,
          value: nextBool,
          sender: effectiveSenderId,
          phase: "discrete",
        });
      },
      [controlDispatch, effectiveSenderId, isExternallyControlled],
    );

    // Opt-in Component State Preservation Protocol. The hook no-ops
    // when `componentStatePreservationKey` is undefined, so standalone
    // / gallery uses remain unaffected. Capture reads the
    // `effectiveChecked` source of truth. The mount-in-saved-state
    // half lives above in `useState`'s initializer; the controlled
    // (`isExternallyControlled`) path doesn't need to re-dispatch on
    // restore because the parent responder owns the value and has its
    // own saved state via [A9]. [D13] / [A9].
    useComponentStatePreservation<TugCheckboxState>({
      componentStatePreservationKey,
      captureState: () => ({ checked: effectiveChecked === true }),
    });

    // Role injection — every path injects surface-toggle-primary tokens. [L06]
    // No role prop = the `on` role (the selection axis, blue) — decoupled from
    // the accent role so a role recolor never moves the checked color.
    const tokenSuffix = role ? (ROLE_TOKEN_MAP[role] ?? role) : "on";
    const roleStyle = {
      "--tugx-toggle-on-color": `var(--tug7-surface-toggle-primary-normal-${tokenSuffix}-rest)`,
      "--tugx-toggle-on-hover-color": `var(--tug7-surface-toggle-primary-normal-${tokenSuffix}-hover)`,
      "--tugx-toggle-disabled-color": `var(--tug7-surface-toggle-primary-normal-${tokenSuffix}-disabled)`,
    } as React.CSSProperties;

    const checkboxNode = (
      <CheckboxPrimitive.Root
        ref={setRefs}
        data-slot="tug-checkbox"
        checked={effectiveChecked}
        disabled={effectiveDisabled}
        name={name}
        value={value}
        required={required}
        aria-label={!label ? ariaLabel : undefined}
        className={cn("tug-checkbox", `tug-checkbox-size-${size}`, className)}
        style={{ ...roleStyle, ...style }}
        {...rest}
        data-role={role}
        data-tug-focus="refuse"
        onCheckedChange={handleCheckedChange}
      >
        <CheckboxPrimitive.Indicator className="tug-checkbox-indicator">
          <span className="tug-checkbox-icon-check" aria-hidden="true">
            <Check />
          </span>
          <span className="tug-checkbox-icon-mixed" aria-hidden="true">
            <Minus />
          </span>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    );

    if (!label) {
      return checkboxNode;
    }

    return (
      <label
        className={cn("tug-checkbox-wrapper", effectiveDisabled && "tug-checkbox-wrapper-disabled")}
      >
        {checkboxNode}
        <span className={cn("tug-checkbox-label", `tug-checkbox-label-${size}`)}>
          {label}
        </span>
      </label>
    );
  },
);
