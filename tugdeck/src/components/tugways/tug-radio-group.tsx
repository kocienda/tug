/**
 * TugRadioGroup — Mutually exclusive selection from a set of options.
 *
 * Hand-rolled single-select group (no Radix): the same shape as TugChoiceGroup /
 * TugOptionGroup, rendering each item as a TugButton (ghost emphasis, icon-text
 * subtype) hosting a radio circle indicator in the icon slot. Keyboard focus is
 * **app-owned** ([P01]): the group is a single item-container stop in the engine
 * Tab walk (`useItemGroupKeyboard`) — Tab lands the ring on the group (never on a
 * member), arrows move a **movement cursor** over the items without committing,
 * and Space/Enter check the current item (deferred commit). Tab-into lands the
 * cursor on the checked item. Radix's `RadioGroupPrimitive` was removed —
 * its built-in `RovingFocusGroup` cannot be disabled and would fight the engine
 * for focus/`tabIndex` ownership; the native-form `BubbleInput` it provided is
 * unused here (selection flows through the responder chain, [L11], not HTML
 * forms), so nothing of substance is lost.
 *
 * Control semantics (L11): user activation (click, Space/Enter on the focused
 * item, or arrow navigation) dispatches a `selectValue` action through the
 * responder chain with the newly selected item id as `value` and a stable
 * `sender` id. Parent responders register a `selectValue` handler via
 * `useResponder` and switch on `event.sender`. There is no `onValueChange`
 * callback prop — the chain is the sole mechanism for communicating selection
 * changes outward.
 *
 * Composed children: TugButton (each item's click target and visual rendering) [L20].
 * Radio indicator appearance is owned by this component via radio-scoped tokens.
 * TugButton keeps its own tokens, tunable independently per theme.
 *
 * Laws: [L03] registrations in useLayoutEffect, [L06] appearance via CSS/DOM,
 *       [L11] controls emit actions, [L16] pairings declared,
 *       [L19] component authoring guide, [L20] token sovereignty
 * Decisions: [D05] component token naming
 */

import "./tug-radio-group.css";
import type { TugSize } from "./tug-vocabulary";

import React, { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TugButton } from "./internal/tug-button";
import type { TugButtonSize } from "./internal/tug-button";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import { TugGroupRole, buildRoleStyle } from "./internal/tug-group-utils";
import { useControlDispatch } from "./use-control-dispatch";
import { useItemGroupKeyboard } from "./use-item-group-keyboard";
import { composeEventHandlers } from "./internal/compose-event-handlers";
import type { FocusPolicy } from "./focus-manager";
import { TUG_ACTIONS } from "./action-vocabulary";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "./use-component-state-preservation";

// ---- Types ----

/** Radio group size names — matches TugButton sizes */
export type TugRadioGroupSize = Extract<TugSize, "sm" | "md" | "lg">;

/**
 * Semantic role for the radio on-state color.
 *
 * Omit the role prop (or leave undefined) for the theme's accent color.
 * Explicit roles override with a semantic signal color.
 *
 * @selector [data-role="<role>"]
 */
export type TugRadioRole = TugGroupRole;

/**
 * Visual emphasis. Selects the *paint* of the items; the *scale* stays with
 * `size`, and the two compose.
 *
 *  - `"default"` — a dot beside a label, the ordinary radio row.
 *  - `"tile"` — a framed button holding whatever the item renders, with no
 *    dot: at rest a transparent outline, when checked the accent outline over
 *    a tinted fill. For items whose content *is* the answer — a picture of the
 *    thing being chosen — where a dot would be a second, redundant mark.
 *
 * @selector [data-emphasis="<emphasis>"]
 * @default "default"
 */
export type TugRadioGroupEmphasis = "default" | "tile";

// ---- Context ----

interface TugRadioGroupContextValue {
  size: TugRadioGroupSize;
  emphasis: TugRadioGroupEmphasis;
  disabled: boolean;
  /** The currently selected value (drives each item's checked indicator). */
  selectedValue: string;
  /** Select an item (click on the item, or the cursor item on Space/Enter). */
  onSelect: (value: string) => void;
}

const TugRadioGroupContext = React.createContext<TugRadioGroupContextValue>({
  size: "md",
  emphasis: "default",
  disabled: false,
  selectedValue: "",
  onSelect: () => {},
});

// ---- TugRadioGroupProps ----

/** TugRadioGroup props. */
export interface TugRadioGroupProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "role" | "defaultValue"> {
  /**
   * Current selected value.
   * @selector [data-state="checked"] on items
   */
  value?: string;
  /** Uncontrolled default value. */
  defaultValue?: string;
  /**
   * Stable identifier passed as `event.sender` on every `selectValue`
   * action dispatched by this group. Parent responders use this to
   * disambiguate multi-group forms in their `selectValue` handler.
   * Defaults to a `useId()`-derived unique string — set explicitly
   * when the parent needs a predictable id (e.g. for form routing
   * by semantic name).
   */
  senderId?: string;
  /** Visible group label rendered above the items. Falls back to aria-label for a11y. */
  label?: string;
  /**
   * Layout direction.
   * @selector .tug-radio-group-horizontal | .tug-radio-group-vertical
   * @default "vertical"
   */
  orientation?: "horizontal" | "vertical";
  /**
   * Visual size for all items.
   * @selector .tug-radio-group-sm | .tug-radio-group-md | .tug-radio-group-lg
   * @default "md"
   */
  size?: TugRadioGroupSize;
  /**
   * Visual emphasis — dotted rows (`default`) or framed, dot-less tiles
   * (`tile`).
   * @selector [data-emphasis="<emphasis>"]
   * @default "default"
   */
  emphasis?: TugRadioGroupEmphasis;
  /**
   * Semantic role color for the selected indicator.
   * @selector [data-role="<role>"]
   */
  role?: TugRadioRole;
  /** Identifier used to derive the group's `aria-labelledby` target id. */
  name?: string;
  /**
   * Disables all items.
   * @selector [data-disabled]
   */
  disabled?: boolean;
  /** Accessible label when no visible label is provided. */
  "aria-label"?: string;
  /**
   * Opt the radio group into the Component State Preservation Protocol
   * ([D13], [A9]). When provided (and rendered inside a card), the
   * selected value is captured into
   * `bag.components[componentStatePreservationKey]` at every save
   * trigger and reapplied on the next mount. Controlled mode dispatches
   * `selectValue` on restore (best-effort, parent owns truth);
   * uncontrolled mode mirrors the value in `useState` so restore
   * can update it directly.
   */
  componentStatePreservationKey?: string;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this radio group is authored into ([P02]). When set, the group
   * registers as a **single item-container stop** in the engine's Tab walk: Tab
   * lands the ring on the group with the movement cursor on the checked (or
   * first enabled) item, and arrows move the cursor within; when omitted, the
   * items stay plain native focus stops. Supplied by the surface that owns the
   * Tab order.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /**
   * Walk policy when registered: `accept` (default) is an ordinary Tab stop;
   * `skip` is reachable only in accessibility mode.
   */
  focusPolicy?: FocusPolicy;
  /**
   * How many options the group's layout puts on a row. The default `1` is a
   * single run — every arrow steps one option, on either axis. Set it to match a
   * multi-column layout (a CSS grid of tiles) and the arrows follow what the
   * user sees: Down / Up step a whole row, Left / Right step one option and stop
   * at the row's ends. The component cannot read this off the layout, so the
   * surface that authored the columns declares them.
   * @default 1
   */
  columns?: number;
  /**
   * Commit the ringed option on **Enter** as well as Space ([P24] opt-out). Use
   * only for a commit-advances primary group with no separate scope default to
   * bubble Enter to — the question wizard's single-select options, where Return
   * picks the current option and advances. Off by default: a radio group in a
   * dialog (e.g. the permission scope group) keeps Enter bubbling to the dialog's
   * default button.
   */
  commitOnEnter?: boolean;
}

/** Serialized shape of `TugRadioGroup`'s preserved state. */
interface TugRadioGroupState {
  value: string;
}

// ---- TugRadioGroup ----

export const TugRadioGroup = React.forwardRef<HTMLDivElement, TugRadioGroupProps>(
  function TugRadioGroup(
    {
      value,
      defaultValue,
      senderId,
      label,
      orientation = "vertical",
      size = "md",
      emphasis = "default",
      role,
      name,
      disabled = false,
      className,
      style,
      "aria-label": ariaLabel,
      children,
      dir,
      componentStatePreservationKey,
      focusGroup,
      focusOrder = 0,
      focusPolicy,
      columns = 1,
      commitOnEnter = false,
      onKeyDown: callerOnKeyDown,
      ...rest
    },
    ref,
  ) {
    const boxDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || boxDisabled;

    // Role injection — on-state color uses toggle-primary tokens (shared with checkbox/switch). [L06]
    const roleStyle = buildRoleStyle("radio", role);

    // Chain dispatch [L11]: targeted dispatch of `selectValue` to the parent
    // responder with the newly selected item id as `value`. No-op outside a provider.
    const { dispatch: controlDispatch } = useControlDispatch();
    const fallbackId = useId();
    const effectiveSenderId = senderId ?? fallbackId;

    // Controlled/uncontrolled value, mirrored in `useState` for the uncontrolled
    // path so state preservation can read/write it.
    const isExternallyControlled = value !== undefined;
    const savedRadioGroupState = useSavedComponentState<TugRadioGroupState>(
      componentStatePreservationKey,
    );
    const [internalValue, setInternalValue] = useState<string>(
      () =>
        typeof savedRadioGroupState?.value === "string"
          ? savedRadioGroupState.value
          : (defaultValue ?? ""),
    );
    const effectiveValue = isExternallyControlled ? value : internalValue;

    const handleValueChange = useCallback(
      (nextValue: string) => {
        if (!isExternallyControlled) {
          setInternalValue(nextValue);
        }
        controlDispatch({
          action: TUG_ACTIONS.SELECT_VALUE,
          value: nextValue,
          sender: effectiveSenderId,
          phase: "discrete",
        });
      },
      [controlDispatch, effectiveSenderId, isExternallyControlled],
    );

    useComponentStatePreservation<TugRadioGroupState>({
      componentStatePreservationKey,
      captureState: () => ({ value: effectiveValue ?? "" }),
    });

    // ---- Item-container keyboard ([P01], [P03]) ----
    //
    // One stop in the engine Tab walk; arrows move a movement cursor over the
    // enabled items (the ring stays on the group), Space/Enter check the cursor
    // item. Tab-into lands the cursor on the checked item.
    const autoFocusId = useId();
    const rootRef = useRef<HTMLDivElement | null>(null);

    // Ordered radio-item buttons in DOM order (all / enabled only).
    const allItems = useCallback((): HTMLElement[] => {
      const root = rootRef.current;
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>('[data-slot="tug-radio-item"]'));
    }, []);
    const enabledItems = useCallback(
      (): HTMLElement[] => allItems().filter((el) => !el.hasAttribute("disabled")),
      [allItems],
    );
    const valueOf = (el: Element | null): string =>
      el?.getAttribute("data-radio-value") ?? "";

    const childCount = React.Children.count(children);
    const { attachRoot, onKeyDown, syncItems, setCursor } =
      useItemGroupKeyboard({
        id: autoFocusId,
        group: focusGroup ?? "",
        order: focusOrder,
        policy: focusPolicy,
        register: focusGroup !== undefined,
        commitOnEnter,
        collectItems: enabledItems,
        // The layout's column count, so a vertical arrow steps a row of tiles
        // rather than the next tile along.
        columns: () => columns,
        // Land on the checked item when Tab enters; else the first enabled item.
        initialIndex: () => {
          const enabled = enabledItems();
          const idx = enabled.findIndex((el) => valueOf(el) === effectiveValue);
          return idx >= 0 ? idx : 0;
        },
        // Explicit commit ([P24]): arrows move the cursor only (no live commit),
        // Space commits the ringed item, and Enter is never consumed — it bubbles
        // to the scope default (a dialog's ringed Allow). The default `deferred`
        // commit timing carries that: no `onMove`, so the selection never follows
        // the cursor.
        onSelect: (element) => handleValueChange(valueOf(element)),
      });

    // Re-sync the cursor's item range whenever the rendered items change.
    useLayoutEffect(() => {
      syncItems();
    }, [childCount, syncItems]);

    const setRootRef = useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node;
        attachRoot(node);
        if (typeof ref === "function") ref(node);
        else if (ref !== null && ref !== undefined) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [ref, attachRoot],
    );

    // Click selects the item and parks the cursor on it (so a following arrow
    // continues from the clicked item).
    const onSelect = useCallback(
      (next: string) => {
        const idx = enabledItems().findIndex((el) => valueOf(el) === next);
        if (idx >= 0) setCursor(idx);
        handleValueChange(next);
      },
      [enabledItems, setCursor, handleValueChange],
    );

    const ctx: TugRadioGroupContextValue = {
      size,
      emphasis,
      disabled: effectiveDisabled,
      selectedValue: effectiveValue ?? "",
      onSelect,
    };

    const labelId = `tug-radio-label-${name ?? "group"}`;

    return (
      <TugRadioGroupContext.Provider value={ctx}>
        <div
          ref={setRootRef}
          data-slot="tug-radio-group"
          role="radiogroup"
          aria-label={!label ? ariaLabel : undefined}
          aria-labelledby={label ? labelId : undefined}
          aria-disabled={effectiveDisabled || undefined}
          data-role={role}
          data-emphasis={emphasis}
          className={cn(
            "tug-radio-group",
            `tug-radio-group-${size}`,
            orientation === "horizontal"
              ? "tug-radio-group-horizontal"
              : "tug-radio-group-vertical",
            className,
          )}
          dir={dir as "ltr" | "rtl" | undefined}
          style={{ ...roleStyle, ...style }}
          tabIndex={focusGroup !== undefined ? 0 : undefined}
          {...rest}
          onKeyDown={composeEventHandlers(callerOnKeyDown, onKeyDown)}
        >
          {label && (
            <span id={labelId} className="tug-radio-group-label">
              {label}
            </span>
          )}
          <div className="tug-radio-group-items">{children}</div>
        </div>
      </TugRadioGroupContext.Provider>
    );
  },
);

/* ---------------------------------------------------------------------------
 * TugRadioItem
 * ---------------------------------------------------------------------------*/

/** TugRadioItem props. */
export interface TugRadioItemProps {
  /** The value this item represents. Required. */
  value: string;
  /** Label text. */
  children: React.ReactNode;
  /**
   * Optional secondary line rendered muted below the label — the radio
   * equivalent of a list row's subtitle. When present the item is a two-line
   * stack and the dot top-aligns with the label.
   */
  description?: React.ReactNode;
  /**
   * Disables this item individually.
   * @selector :disabled | [data-disabled]
   */
  disabled?: boolean;
}

export const TugRadioItem = React.forwardRef<HTMLButtonElement, TugRadioItemProps>(
  function TugRadioItem({ value, children, description, disabled }, ref) {
    const { size, emphasis, disabled: groupDisabled, selectedValue, onSelect } =
      React.useContext(TugRadioGroupContext);

    const isDisabled = disabled ?? groupDisabled;
    const isChecked = value === selectedValue;

    // Map TugRadioGroupSize → TugButtonSize (same union values)
    const buttonSize = size as TugButtonSize;

    // Hand-rolled radio item: the button carries the ARIA radio semantics
    // (`role="radio"` flows through TugButton's ARIA-role pass-through, since
    // "radio" is not one of TugButton's semantic theming roles) and the checked
    // `data-state` the CSS keys on. The group itself is the single Tab stop
    // ([P01]); items are never in the Tab order (`tabIndex={-1}`) — the movement
    // cursor (`data-key-cursor`) marks the current item, the ring stays on the
    // group. TugButton already emits `data-tug-focus="refuse"`, so clicking an
    // item selects without stealing the key view. Click funnels through
    // `onSelect`; keyboard Space/Enter is carried by the engine's act dispatch.
    return (
      <TugButton
        ref={ref}
        role="radio"
        aria-checked={isChecked}
        value={value}
        data-slot="tug-radio-item"
        data-radio-value={value}
        data-state={isChecked ? "checked" : "unchecked"}
        data-has-description={description !== undefined ? "" : undefined}
        tabIndex={-1}
        emphasis="ghost"
        size={buttonSize}
        subtype="icon-text"
        disabled={isDisabled}
        onClick={() => {
          if (!isDisabled) onSelect(value);
        }}
        // A tile carries no dot: the checked state is the tile's own frame and
        // fill, and the item's content is the picture being chosen.
        icon={
          emphasis === "tile" ? undefined : (
            <span className="tug-radio-indicator" aria-hidden="true">
              <span className="tug-radio-dot" />
            </span>
          )
        }
      >
        {description !== undefined ? (
          <span className="tug-radio-item-text">
            <span className="tug-radio-item-label">{children}</span>
            <span className="tug-radio-item-description">{description}</span>
          </span>
        ) : (
          children
        )}
      </TugButton>
    );
  },
);
