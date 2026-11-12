/**
 * TugOptionGroup — Multi-toggle group where each item toggles independently.
 *
 * Each item is an independent toggle button (aria-pressed). Zero or more items
 * can be active simultaneously. Keyboard follows the Tug model ([P01]): the
 * group is one stop, a movement cursor traverses the items under the arrows, and
 * Space/Enter toggles the cursor item.
 *
 * Role="toolbar" on root per WAI-ARIA spec for a collection of interactive
 * widgets. Each button uses aria-pressed to communicate on/off state.
 *
 * Control semantics (L11): user activation (click, or Space/Enter on the cursor
 * item) dispatches `setValue` through the responder chain with the new `string[]`
 * of active values as `value` and a stable `sender` id. Parent responders
 * register a `setValue` handler via `useResponder` and switch on `event.sender`.
 * There is no `onValueChange` callback prop.
 *
 * Note on the `setValue` payload: `TugOptionGroup`'s value is
 * a multi-select set (`string[]`), so the appropriate vocabulary
 * action is `setValue` (the catch-all for domain-specific values),
 * not `selectValue` (which carries `value: string` for single-select
 * controls). Handlers receive the full new set and can just call
 * the setter: `setState(narrowed)`.
 *
 * Laws: [L06] appearance via CSS/DOM, [L11] controls emit actions,
 *       [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide
 * Decisions: [D03] appearance via stylesheet injection, [D05] component token naming
 */

import "./tug-option-group.css";
import type { TugSize } from "./tug-vocabulary";

import React, { useCallback, useId } from "react";
import { cn } from "@/lib/utils";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import {
  TugGroupRole,
  buildRoleStyle,
  renderGroupItemContent,
} from "./internal/tug-group-utils";
import { useControlDispatch } from "./use-control-dispatch";
import { TUG_ACTIONS } from "./action-vocabulary";
import { useComponentStatePreservation } from "./use-component-state-preservation";
import { useItemGroupKeyboard } from "./use-item-group-keyboard";
import type { FocusPolicy } from "./focus-manager";

// ---- Types ----

/** Option group size names. */
export type TugOptionGroupSize = Extract<TugSize, "2xs" | "xs" | "sm" | "md" | "lg">;

/**
 * Visual emphasis. Selects the *paint* of the group; the *scale* is
 * controlled separately by `size`. The two compose.
 *
 *  - `"default"` — fielded look: framing pill with a saturated on-state
 *    fill matching the (role-aware) `--tugx-option-on-color`. Use when
 *    the option group is the prominent control in its region.
 *  - `"ghost"` — quiet look: no framing pill, neutral on-state fill,
 *    uppercase/letter-spaced labels matching `TugPushButton`'s CTA
 *    typography. Pipe dividers and role-driven on-state coloring are
 *    suppressed. Use when the option group sits next to ghost-style
 *    push buttons (e.g. action-row affordances inside a sticky header)
 *    and should read at the same visual weight as its neighbors.
 *
 * Mirrors `TugChoiceGroupEmphasis` for cross-component consistency.
 *
 * @selector [data-emphasis="<emphasis>"]
 * @default "default"
 */
export type TugOptionGroupEmphasis = "default" | "ghost";

/**
 * Semantic role for the on-state indicator color.
 *
 * Omit the role prop (or leave undefined) for the theme's accent color.
 * Explicit roles override with a semantic signal color.
 *
 * Re-exported from TugGroupRole for API consistency.
 *
 * **Interaction with `emphasis="ghost"`:** the ghost variant uses a
 * single neutral on-state fill regardless of `role` — ghost emphasis
 * is for "this control is quiet" and saturated semantic coloring would
 * defeat that. The `role` prop is still accepted (the data attribute
 * is set for downstream CSS hooks) but has no visible effect on the
 * on-state background in ghost mode.
 *
 * @selector [data-role="<role>"]
 */
export type { TugGroupRole as TugOptionGroupRole };

/** A single toggleable item definition. */
export interface TugOptionItem {
  /** Unique value for this item. */
  value: string;
  /** Display label. Optional — omit for icon-only items. */
  label?: string;
  /** Icon node (typically a Lucide icon). */
  icon?: React.ReactNode;
  /** Where to place the icon relative to the label.
   *  @default "left" */
  iconPosition?: "left" | "right" | "both";
  /** Accessible label — required when label is omitted (icon-only). */
  "aria-label"?: string;
  /** Native hover tooltip. Useful for icon-only items whose glyph needs a
   *  plain-language gloss (e.g. the Find route's Case/Word/Grep toggles). */
  title?: string;
  /** Disables this item individually. */
  disabled?: boolean;
}

/** TugOptionGroup props. */
export interface TugOptionGroupProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "role" | "defaultValue" | "onChange"> {
  /** The items to display as toggle buttons. */
  items: TugOptionItem[];
  /**
   * Currently active values (the items that are "on").
   * @selector [data-state="on"] on items
   */
  value: string[];
  /**
   * Stable identifier passed as `event.sender` on every `setValue` action
   * dispatched by this group. Parent responders use this to disambiguate
   * multi-group forms in their handlers. Defaults to a `useId()`-derived unique
   * string.
   */
  senderId?: string;
  /**
   * Visual size.
   * @selector .tug-option-group-2xs | .tug-option-group-xs | .tug-option-group-sm | .tug-option-group-md | .tug-option-group-lg
   * @default "md"
   */
  size?: TugOptionGroupSize;
  /**
   * Visual emphasis. See {@link TugOptionGroupEmphasis}.
   * @selector [data-emphasis="<emphasis>"]
   * @default "default"
   */
  emphasis?: TugOptionGroupEmphasis;
  /**
   * Semantic role color for the on-state background.
   * @selector [data-role="<role>"]
   */
  role?: TugGroupRole;
  /**
   * Disables all items.
   * @selector [data-disabled]
   */
  disabled?: boolean;
  /**
   * The item's horizontal padding, as a space-scale token. OVERRIDES the
   * `size`'s default padding when set — so a caller can make the items
   * TIGHTER than the default (to keep a multi-item control narrow) or looser
   * (more prominence). Unset → the size default.
   * @selector [data-side-padding="2xs" | "xs" | "sm" | "md" | "lg"]
   */
  sidePadding?: "2xs" | "xs" | "sm" | "md" | "lg";
  /** Accessible label for the toolbar. */
  "aria-label"?: string;
  /**
   * Opt the option group into the Component State Preservation
   * Protocol ([D13], [A9]). When provided (and rendered inside a
   * card), the active set is captured into
   * `bag.components[componentStatePreservationKey]` at every save
   * trigger. On restore the component re-dispatches a `setValue`
   * action so the parent (which owns `value`) updates its own state.
   * Controlled-only — no internal mirror.
   */
  componentStatePreservationKey?: string;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this option group is authored into ([P02]). When set, the group
   * registers as a **single item-container stop** in the engine's Tab walk: Tab
   * lands the ring on the group with the movement cursor on the first item,
   * arrows move the cursor and Space/Enter toggles the cursor item; when omitted,
   * the items stay plain native stops outside the engine. Supplied by the surface
   * that owns the Tab order.
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

/** Serialized shape of `TugOptionGroup`'s preserved state. */
interface TugOptionGroupState {
  value: string[];
}

// ---- TugOptionGroup ----

export const TugOptionGroup = React.forwardRef<HTMLDivElement, TugOptionGroupProps>(
  function TugOptionGroup(
    {
      items,
      value,
      senderId,
      size = "md",
      emphasis = "default",
      role,
      disabled = false,
      sidePadding,
      className,
      style,
      "aria-label": ariaLabel,
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

    // Role injection — on-state uses toggle-primary tokens. [L06]
    const roleStyle = buildRoleStyle("option", role);

    // Refs for each item button — indexed to match items array.
    const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

    // Chain dispatch [L11]: targeted dispatch of `setValue` to the parent responder.
    const { dispatch: controlDispatch } = useControlDispatch();
    const fallbackId = useId();
    const effectiveSenderId = senderId ?? fallbackId;

    const dispatchSetValue = useCallback(
      (next: string[]) => {
        controlDispatch({
          action: TUG_ACTIONS.SET_VALUE,
          value: next,
          sender: effectiveSenderId,
          phase: "discrete",
        });
      },
      [controlDispatch, effectiveSenderId],
    );

    // Opt-in Component State Preservation Protocol. Hook no-ops when
    // `componentStatePreservationKey` is undefined. Controlled-only —
    // capture lands the current `value` in `bag.components`; the
    // parent responder that owns `value` carries its own saved state
    // via [A9] and mounts in the saved selection on cold boot, which
    // flows back down here as a fresh `value` prop. [D13] / [A9].
    useComponentStatePreservation<TugOptionGroupState>({
      componentStatePreservationKey,
      captureState: () => ({ value: [...value] }),
    });

    // ---- Toggle logic ----

    const toggleItem = React.useCallback(
      (itemValue: string) => {
        const next = value.includes(itemValue)
          ? value.filter((v) => v !== itemValue)
          : [...value, itemValue];
        dispatchSetValue(next);
      },
      [value, dispatchSetValue],
    );

    // ---- Item-container keyboard ([P01], [P03]) ----
    //
    // One stop in the engine Tab walk; arrows move a movement cursor over the
    // enabled items (the ring stays on the group), Space/Enter toggles the cursor
    // item (focus is separate from selection here — multi-select).
    const autoFocusId = useId();
    const enabledItemEls = useCallback((): { el: HTMLButtonElement; value: string }[] => {
      const out: { el: HTMLButtonElement; value: string }[] = [];
      items.forEach((item, index) => {
        if (effectiveDisabled || item.disabled) return;
        const el = itemRefs.current[index];
        if (el) out.push({ el, value: item.value });
      });
      return out;
    }, [items, effectiveDisabled]);

    const { attachRoot, onKeyDown, syncItems, setCursor } = useItemGroupKeyboard({
      id: autoFocusId,
      group: focusGroup ?? "",
      order: focusOrder,
      policy: focusPolicy,
      register: focusGroup !== undefined,
      collectItems: () => enabledItemEls().map((s) => s.el),
      // No single selection to land on; start at the first enabled item.
      initialIndex: () => 0,
      // Two-stage highlight-then-select: arrows move the cursor, **Space**
      // toggles the cursor item. Enter is NOT a selection key here — a multi-select
      // group never consumes Return; it bubbles to the scope default ([P24]).
      onSelect: (element) => {
        const v = element?.getAttribute("data-option-value");
        if (v != null) toggleItem(v);
      },
    });

    React.useLayoutEffect(() => {
      syncItems();
    }, [items, syncItems]);

    const setRootRef = useCallback(
      (node: HTMLDivElement | null) => {
        attachRoot(node);
        if (typeof ref === "function") ref(node);
        else if (ref !== null && ref !== undefined) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [ref, attachRoot],
    );

    return (
      <div
        ref={setRootRef}
        data-slot="tug-option-group"
        role="toolbar"
        aria-label={ariaLabel}
        aria-disabled={effectiveDisabled || undefined}
        data-role={role}
        data-emphasis={emphasis}
        data-side-padding={sidePadding}
        data-disabled={effectiveDisabled || undefined}
        className={cn(
          "tug-option-group",
          `tug-option-group-${size}`,
          className,
        )}
        style={{ ...roleStyle, ...style }}
        tabIndex={focusGroup !== undefined ? 0 : undefined}
        onKeyDown={onKeyDown}
        {...rest}
      >
        {items.map((item, index) => {
          const isOn = value.includes(item.value);
          const isDisabled = effectiveDisabled || item.disabled;
          const isIconOnly = item.icon && !item.label;

          return (
            <button
              key={item.value}
              ref={(el) => { itemRefs.current[index] = el; }}
              type="button"
              aria-pressed={isOn}
              aria-label={item["aria-label"]}
              title={item.title}
              disabled={isDisabled}
              data-option-value={item.value}
              data-state={isOn ? "on" : "off"}
              className={cn(
                "tug-option-group-item",
                isIconOnly && "tug-option-group-item-icon-only",
              )}
              tabIndex={-1}
              data-tug-focus="refuse"
              onClick={() => {
                if (!isDisabled) {
                  const idx = enabledItemEls().findIndex((s) => s.value === item.value);
                  if (idx >= 0) setCursor(idx);
                  toggleItem(item.value);
                }
              }}
            >
              {renderGroupItemContent({
                label: item.label,
                icon: item.icon,
                iconPosition: item.iconPosition,
              })}
            </button>
          );
        })}
      </div>
    );
  },
);
