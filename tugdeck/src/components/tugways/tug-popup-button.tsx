/**
 * TugPopupButton — convenience popup button composing TugPopupMenu + TugButton.
 *
 * TugPopupButton is a macOS-style popup button with a fixed visual identity:
 *   emphasis="outlined", role="option", ChevronDown trailing icon.
 *
 * These defaults are intentionally not configurable. [D04] Callers who need a
 * different trigger appearance use TugPopupMenu directly with their own trigger.
 *
 * Per [L11], TugPopupButton is a control: activating a menu item dispatches
 * the item's `action` (with its optional `value` as the payload) through
 * the responder chain. Menu items are typed against `TugAction`, so
 * misspellings are compile errors — the same precedent established by
 * `TugEditorContextMenu` in A1. Value-picker use cases share a single
 * action across all items (typically `"set-value"`) and differ by the
 * item's `value` field; semantic-action use cases can carry a different
 * action per item.
 *
 * ## Known limitation: continuation ordering
 *
 * TugPopupButton dispatches via `manager.sendToTargetForContinuation` and
 * runs any returned continuation callback immediately after the dispatch
 * returns. This differs from the `TugEditorContextMenu` precedent in one
 * detail: the precedent dispatches **before** the blink animation so the
 * continuation can fire **after** the visual feedback completes (matching
 * the "button press, then result" UX). TugPopupButton dispatches **after**
 * the blink because it delegates blink timing to `TugPopupMenu`'s internal
 * animate-then-onSelect sequence, and TugPopupMenu fires its `onSelect`
 * callback only after the blink animation finishes.
 *
 * Net effect: in TugPopupButton, the dispatch + continuation both run
 * effectively at the moment the menu is about to close, not before the
 * blink. For the current value-picker use cases (font size, theme,
 * emphasis, role, tab add, etc.) this doesn't matter — handlers are
 * void-returning and don't use continuations at all. But if a future
 * consumer wants to defer a visible side effect past the blink flash,
 * that timing window doesn't exist here — the blink has already happened
 * by the time the handler runs.
 *
 * Fixing this would require restructuring `TugPopupMenu`'s internal
 * sequence to dispatch-then-blink, or having TugPopupButton bypass
 * TugPopupMenu's blink and manage its own animation. Both are
 * invasive. Flagged here so future consumers who do need the precedent's
 * exact timing know to use `TugPopupMenu` directly (and manage the
 * dispatch themselves) rather than TugPopupButton.
 *
 * Styling delegated to TugButton (trigger appearance) and TugPopupMenu (dropdown).
 * The component owns a small CSS file only for the optional `topLabel` stack
 * (label-above-control) — when `topLabel` is unset, no wrapping or styles
 * are applied and the composition stays pure.
 *
 * ## Service-popup semantics via composition
 *
 * Per `tugplan-session-popup-bindings.md` [D08] (#popup-button-defaults),
 * TugPopupButton inherits the **service** popup role through
 * composition. Activating the trigger opens a Radix dropdown that
 * grabs DOM focus via `FocusScope`; on close, the engine focus trap
 * `TugPopupMenu` pushes (its `onCloseAutoFocus` teardown writer)
 * restores focus to the responder that owned it before the popup
 * opened — typically the editor or form control the user was working
 * in. (Escape is owned by the engine's Escape ladder via the trap's
 * `onEscapeDismiss`.)
 *
 * Consumers do NOT pick a role at the call site and do NOT pass an
 * `onCloseAutoFocus` override: the trap owns close-focus
 * restoration. A consumer who needs custom close behavior calls
 * `manager.focusResponder(targetId)` directly inside the menu-item
 * handler before the menu closes (per Risk R02 in the popup-bindings
 * plan). Stacking a second `onCloseAutoFocus` on top of the binding
 * is unsupported.
 *
 * The trigger-discipline correctness invariant is satisfied by the
 * underlying `TugButton`'s `data-tug-focus="refuse"` attribute, which
 * `pane-focus-controller` reads to skip responder-chain promotion on
 * trigger clicks. As a result, `manager.getFirstResponder()` at
 * `captureOnOpen` time returns the prior responder (e.g., the
 * editor), not the trigger button — and the close-restore lands on
 * the right place.
 *
 * Laws: [L11] controls emit actions, [L19] component authoring guide
 * Decisions: [D02] TugPopupMenu takes a single ReactNode trigger prop,
 *            [D04] TugPopupButton defaults are not configurable,
 *            [D08] TugPopupButton inherits service semantics through
 *                  TugPopupMenu (popup-bindings plan)
 */

import "./tug-popup-button.css";

import React, { useCallback, useId } from "react";
import { ChevronDown } from "lucide-react";
import { TugButton } from "./internal/tug-button";
import type { TugButtonSize } from "./internal/tug-button";
import { TugPopupMenu } from "./internal/tug-popup-menu";
import type { TugPopupMenuItem } from "./internal/tug-popup-menu";
import type { TugAction } from "./action-vocabulary";
import { useControlDispatch } from "./use-control-dispatch";
import type { FocusPolicy } from "./focus-manager";

// ---- Types ----

/**
 * Payload types supported by the `value` field of a `TugPopupButtonItem`.
 *
 * Matches the runtime-narrowable payload shapes handled by
 * `useResponderForm`'s binding slots: booleans (toggle), strings
 * (selectValue, setValueString, selectTab, closeTab, addTab,
 * toggleSectionSingle), numbers (setValueNumber), and string arrays
 * (setValueStringArray, toggleSectionMulti). If a new slot is added to
 * the form hook with a different payload shape, extend this union.
 *
 * This constraint is what gives `TugPopupButtonItem<V>` its compile-time
 * homogeneity guarantee — see the docstring on the interface itself.
 */
export type TugPopupButtonPayload = boolean | number | string | string[];

/**
 * A single item in a TugPopupButton menu. Activating the item dispatches
 * `action` through the responder chain, carrying `value` as the payload.
 *
 * - For value pickers (font size, theme, emphasis, ...), all items share a
 *   single `action` such as `"set-value"` and differ by the `value` field.
 * - For semantic-action menus (file operations, tab add, ...), each item
 *   can carry a distinct `action`.
 *
 * This mirrors the `TugEditorContextMenuItem` precedent introduced in A1,
 * with the addition of an optional `value` payload field. The precedent's
 * type-safety guarantee is preserved: `action` is `TugAction`, so
 * misspellings are compile errors and autocomplete surfaces the vocabulary.
 *
 * ## Payload homogeneity via generic parameter `V`
 *
 * `TugPopupButtonItem` is parameterized by a payload type `V` bounded to
 * `TugPopupButtonPayload`. A single items array must be homogeneous —
 * every item's `value` has the same type as every other item's `value`
 * in that array. This closes the A2.5 loophole where an array of mixed
 * string/number items could silently misroute to the wrong
 * `useResponderForm` slot.
 *
 * ### Default is `never`, not `unknown`
 *
 * The default type parameter is `never` — a deliberate choice to force
 * consumers to annotate their items at the declaration site. Writing
 * `TugPopupButtonItem[]` without a type argument resolves to
 * `TugPopupButtonItem<never>[]`, which only accepts items with
 * `value: undefined` (semantic-action items with no payload). Any
 * consumer that passes values must annotate explicitly:
 *
 * ```ts
 * // Font-size picker: numeric payload
 * const FONT_SIZE_OPTIONS: TugPopupButtonItem<number>[] = [
 *   { action: TUG_ACTIONS.SET_VALUE, value: 12, label: "12 px" },
 *   { action: TUG_ACTIONS.SET_VALUE, value: 14, label: "14 px" },
 *   // { action: TUG_ACTIONS.SET_VALUE, value: "16", label: "16 px" }  // ← compile error
 * ];
 * ```
 *
 * TypeScript will also infer `V` from an items literal passed inline to
 * `TugPopupButton`, so explicit annotation at the declaration site is
 * only required when the items array is a named `const` declared
 * separately from the component usage. Inline literals with mixed
 * payload types will fail inference (no single `V` satisfies both a
 * number and a string), resulting in a compile error.
 *
 * ## Remaining consumer discipline
 *
 * The `senderId → form hook slot` correspondence is still a runtime
 * string match — `TugPopupButtonItem<number>` doesn't force the consumer
 * to bind the senderId to `setValueNumber` rather than `setValueString`
 * at the form hook site. If the slot is wrong, the runtime narrower in
 * `use-responder-form.tsx` drops the payload and logs an `unbound
 * sender` dev warning. The compile-time guarantee is homogeneity; the
 * runtime guardrail is the dev warning.
 */
export interface TugPopupButtonItem<V extends TugPopupButtonPayload = never> {
  /**
   * The responder-chain action to dispatch when the item is activated.
   * Typed against `TugAction` so misspellings are compile errors.
   */
  action: TugAction;
  /**
   * Optional payload shipped as the dispatched event's `value` field.
   * The payload type is the generic parameter `V`, constrained to
   * `TugPopupButtonPayload`. For pure semantic-action items, `value`
   * can be omitted; for value pickers, all items in a single array
   * must share the same `V`.
   */
  value?: V;
  /** Display label for this item. */
  label: string;
  /** Optional icon node rendered before the label. */
  icon?: React.ReactNode;
  /** Whether this item is disabled. Disabled items are not interactive. */
  disabled?: boolean;
}

/**
 * Props for TugPopupButton.
 *
 * TugPopupButton always renders a TugButton with emphasis="outlined",
 * role="option", and a ChevronDown trailing icon.
 * These are fixed; pass label, items, optional senderId and size/className.
 *
 * Parameterized by payload type `V` — flows from `items: TugPopupButtonItem<V>[]`
 * via inference or explicit annotation at the usage site.
 */
export interface TugPopupButtonProps<V extends TugPopupButtonPayload = never> {
  /** Label content rendered inside the trigger button. */
  label: React.ReactNode;
  /**
   * Optional heading rendered above the trigger button. When unset, no
   * wrapping element is rendered. Mirrors `TugBox` `labelPosition="above"`
   * styling so settings popups read as labelled form fields.
   */
  topLabel?: string;
  /** List of items to display in the popup menu. */
  items: TugPopupButtonItem<V>[];
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via
   * `useId()` if omitted. Parent responders disambiguate multi-popup
   * forms by matching this id in their action handler bindings. [L11]
   */
  senderId?: string;
  /** Trigger button size. Default: "md". */
  size?: TugButtonSize;
  /** Additional CSS class names for the trigger button. */
  className?: string;
  /** aria-label for the trigger button. */
  "aria-label"?: string;
  /** data-testid forwarded to the menu content element. */
  "data-testid"?: string;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this popup's trigger is authored into ([P02]). When set, the
   * trigger registers as a focusable and becomes a single stop in the engine's
   * Tab walk; when omitted, the trigger stays a plain native focus stop. Supplied
   * by the surface that owns the Tab order. Forwarded verbatim to the underlying
   * {@link TugButton} trigger.
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

// ---- TugPopupButton ----

/**
 * TugPopupButton -- convenience composition of TugPopupMenu + TugButton.
 *
 * Renders a styled TugButton (outlined-option, ChevronDown)
 * as the trigger for a TugPopupMenu. The button trigger is passed via the
 * TugPopupMenu `trigger` ReactNode prop, implementing the architectural
 * inversion where the trigger owns the menu. [D02, D04]
 *
 * Use TugPopupButton for configuration controls that need a standard
 * macOS-style popup button appearance (muted border, neutral color, chevron).
 * Use TugPopupMenu directly when the trigger needs custom appearance
 * (e.g., tab bar buttons, icon-only triggers), in which case dispatch
 * wiring is the caller's responsibility.
 *
 * On item activation, TugPopupButton dispatches `{action, value, sender,
 * phase: "discrete"}` via targeted `dispatchToForContinuation`. If the handling
 * responder returns a continuation callback, it's invoked after the
 * dispatch returns (before the popup menu closes).
 */
export function TugPopupButton<V extends TugPopupButtonPayload = never>({
  label,
  topLabel,
  items,
  senderId,
  size = "md",
  className,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
  focusGroup,
  focusOrder,
  focusPolicy,
}: TugPopupButtonProps<V>) {
  // Chain dispatch [L11]: targeted dispatch to parent responder.
  // Outside a provider the dispatch is a no-op.
  const { dispatchForContinuation } = useControlDispatch();
  const fallbackSenderId = useId();
  const effectiveSenderId = senderId ?? fallbackSenderId;

  // The internal TugPopupMenu takes items of shape `{id, label, icon,
  // disabled}` and reports `onSelect(id)` after the blink animation.
  // We adapt by using the item's array index (stringified) as the
  // TugPopupMenu id, then look up the original item on callback so we
  // can dispatch its action+value through the chain.
  const internalItems: TugPopupMenuItem[] = items.map((item, index) => ({
    id: String(index),
    label: item.label,
    icon: item.icon,
    disabled: item.disabled,
  }));

  const handleSelect = useCallback(
    (id: string) => {
      const index = Number.parseInt(id, 10);
      if (Number.isNaN(index)) return;
      const item = items[index];
      if (!item) return;
      // Targeted dispatch to parent responder with continuation support.
      const { continuation } = dispatchForContinuation({
        action: item.action,
        value: item.value,
        sender: effectiveSenderId,
        phase: "discrete",
      });
      continuation?.();
    },
    [dispatchForContinuation, items, effectiveSenderId],
  );

  const trigger = (
    <TugButton
      emphasis="outlined"
      role="option"
      size={size}
      trailingIcon={<ChevronDown size={12} />}
      // The macOS popup-button key contract: ↓ / ↑ and any printable character
      // open the menu, alongside Space / Return.
      menuTrigger
      className={className}
      aria-label={ariaLabel}
      focusGroup={focusGroup}
      focusOrder={focusOrder}
      focusPolicy={focusPolicy}
    >
      {label}
    </TugButton>
  );

  const menu = (
    <TugPopupMenu
      trigger={trigger}
      items={internalItems}
      onSelect={handleSelect}
      data-testid={dataTestId}
    />
  );

  if (topLabel === undefined) return menu;

  return (
    <div className="tug-popup-button-stack">
      <span className="tug-popup-button-top-label">{topLabel}</span>
      {menu}
    </div>
  );
}
