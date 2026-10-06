/**
 * TugChoiceGroup — Mutually exclusive segment picker with sliding indicator.
 *
 * Original component — no Radix wrapper. ARIA, keyboard navigation, and focus
 * management are hand-implemented. Role="radiogroup" on root; each segment is
 * role="radio" with aria-checked. A sliding background indicator pill moves
 * imperatively via DOM refs + useLayoutEffect on value change. Supports size
 * variants (sm/md/lg), individual and group-level disable, and role-based color
 * injection for the indicator pill (same pattern as checkbox/switch/radio).
 *
 * Control semantics (L11): user activation dispatches a `selectValue` action
 * through the responder chain with the newly selected segment value and a stable
 * `sender` id. Keyboard follows the Tug model ([P01]): the group is one stop, a
 * movement cursor traverses the segments under the arrows *without* committing,
 * and Space/Enter dispatch `selectValue` for the cursor segment (deferred
 * commit). A pointer click dispatches directly. Parent responders register a
 * `selectValue` handler via `useResponder` and switch on `event.sender`. There
 * is no `onValueChange` callback prop.
 *
 * NOT a tab bar — this is a value picker, not a view switcher. See roadmap doc.
 *
 * Laws: [L06] appearance via CSS/DOM refs, [L11] controls emit actions,
 *       [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide
 * Decisions: [D03] appearance via stylesheet injection, [D05] component token naming
 */

import "./tug-choice-group.css";

import React, { useCallback, useId } from "react";
import { cn } from "@/lib/utils";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import {
  TugGroupRole,
  buildRoleStyle,
  renderGroupItemContent,
} from "./internal/tug-group-utils";
import { TugTooltip } from "./tug-tooltip";
import { useControlDispatch } from "./use-control-dispatch";
import { TUG_ACTIONS } from "./action-vocabulary";
import { useComponentStatePreservation } from "./use-component-state-preservation";
import { useItemGroupKeyboard } from "./use-item-group-keyboard";
import type { FocusPolicy } from "./focus-manager";
import type { CommitMode } from "./focus-act";

// ---- Types ----

/** Choice group size names. */
export type TugChoiceGroupSize = "2xs" | "xs" | "sm" | "md" | "lg";

/**
 * Visual emphasis. Selects the *paint* of the group; the *scale* is
 * controlled separately by `size`. The two compose.
 *
 *  - `"default"` — fielded look: framing pill with a saturated indicator
 *    matching the (role-aware) `--tugx-segment-on-color`. Use when the
 *    choice group is the prominent control in its region.
 *  - `"ghost"` — quiet look: no framing pill, neutral sliding indicator,
 *    uppercase/letter-spaced labels matching `TugPushButton`'s CTA
 *    typography. Pipe dividers and role-driven indicator coloring are
 *    suppressed. Use when the choice group sits next to ghost-style
 *    push buttons (e.g. action-row affordances inside a sticky header)
 *    and should read at the same visual weight as its neighbors.
 *
 * @selector [data-emphasis="<emphasis>"]
 * @default "default"
 */
export type TugChoiceGroupEmphasis = "default" | "ghost";

/**
 * Semantic role for the selected indicator color.
 *
 * Omit the role prop (or leave undefined) for the theme's accent color.
 * Explicit roles override with a semantic signal color.
 *
 * Re-exported from TugGroupRole for API consistency.
 *
 * **Interaction with `emphasis="ghost"`:** the ghost variant uses a
 * single neutral indicator color regardless of `role` — ghost emphasis
 * is for "this control is quiet" and saturated semantic coloring would
 * defeat that. The `role` prop is still accepted (the data attribute
 * is set for downstream CSS hooks) but has no visible effect on the
 * indicator pill in ghost mode.
 *
 * @selector [data-role="<role>"]
 */
export type TugChoiceGroupRole = TugGroupRole;

/** A single segment item definition. */
export interface TugChoiceItem {
  /** Unique value for this segment. */
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
  /** Disables this segment individually. */
  disabled?: boolean;
  /**
   * Hover/focus tooltip content for this segment. Omit for no tooltip.
   * Rendered by the shared `TugTooltip`, so a group's segments read the
   * same as the icon buttons they sit beside.
   */
  tooltip?: React.ReactNode;
  /**
   * Keyboard shortcut badge shown in this segment's tooltip. Ignored
   * without `tooltip`.
   */
  tooltipShortcut?: string;
}

/** TugChoiceGroup props. */
export interface TugChoiceGroupProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "role" | "defaultValue" | "onChange"> {
  /** The items to display as segments. */
  items: TugChoiceItem[];
  /**
   * Current selected value.
   * @selector [data-state="active"] on segments
   */
  value: string;
  /**
   * Stable identifier passed as `event.sender` on every `selectValue`
   * action dispatched by this group. Parent responders use this to
   * disambiguate multi-group forms in their `selectValue` handler.
   * Defaults to a `useId()`-derived unique string — set explicitly
   * when the parent needs a predictable id (e.g. for form routing
   * by semantic name).
   */
  senderId?: string;
  /**
   * Visual size.
   * @selector .tug-choice-group-2xs | .tug-choice-group-xs | .tug-choice-group-sm | .tug-choice-group-md | .tug-choice-group-lg
   * @default "md"
   */
  size?: TugChoiceGroupSize;
  /**
   * Visual emphasis. See {@link TugChoiceGroupEmphasis}.
   * @selector [data-emphasis="<emphasis>"]
   * @default "default"
   */
  emphasis?: TugChoiceGroupEmphasis;
  /**
   * Semantic role color for the selected indicator.
   * @selector [data-role="<role>"]
   */
  role?: TugChoiceGroupRole;
  /**
   * Disables all segments.
   * @selector [data-disabled]
   */
  disabled?: boolean;
  /**
   * Animate the sliding indicator between selections.
   * @default false
   */
  animated?: boolean;
  /**
   * The segment's horizontal padding, as a space-scale token. OVERRIDES the
   * `size`'s default padding when set — so a caller can make the segments
   * TIGHTER than the default (to keep a multi-item control narrow, e.g. a
   * route group that must fit a fixed toolbar width) or looser (more
   * prominence). Unset → the size default. The selection indicator covers
   * whatever padding results automatically.
   * @selector [data-side-padding="2xs" | "xs" | "sm" | "md" | "lg"]
   */
  sidePadding?: "2xs" | "xs" | "sm" | "md" | "lg";
  /**
   * How the segments divide the group's width.
   *
   * - `"equal"` (default) — every segment is exactly as wide as the widest
   *   one's text. Rock-steady, and right when the labels are close in length.
   * - `"proportional"` — every segment gets its own text's width plus an
   *   EQUAL share of the leftover. One long label no longer sets the measure
   *   for all of them, so it stops crowding its own dividers while the short
   *   ones give up only a few pixels each. The segments stay close enough in
   *   width to still read as a stabilized row. The leftover is the whole
   *   mechanism, so this variant fills its row rather than hugging its labels.
   *
   * @selector [data-columns="proportional"]
   * @default "equal"
   */
  columns?: "equal" | "proportional";
  /** Accessible label for the group. */
  "aria-label"?: string;
  /**
   * Opt the choice group into the Component State Preservation
   * Protocol ([D13], [A9]). When provided (and rendered inside a
   * card), the selected value is captured into
   * `bag.components[componentStatePreservationKey]` at every save
   * trigger. On restore the component re-dispatches a `selectValue`
   * action through the responder chain so the parent (which owns the
   * `value` prop) updates its own state. The parent must register a
   * `selectValue` handler that recognizes
   * `event.sender === senderId` to honor the restore.
   *
   * `tug-choice-group` is controlled-only (`value` is required) so
   * there is no internal mirror — the parent IS the source of truth.
   */
  componentStatePreservationKey?: string;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this choice group is authored into ([P02]). When set, the group
   * registers as a **single item-container stop** in the engine's Tab walk: Tab
   * lands the ring on the group with the movement cursor on the selected segment,
   * arrows move the cursor and Space/Enter select; when omitted, the segments
   * stay plain native stops outside the engine. Supplied by the surface that owns
   * the Tab order.
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
   * Dispatch `selectValue` when the ALREADY-ACTIVE segment is chosen again.
   * Off by default: re-choosing the current value is normally a no-op, and
   * most parents would only re-run a write that changes nothing. Opt in when
   * re-choosing is itself a gesture — a responder that answers the same value
   * by re-running its settle (the Layouts picker re-tunes the standing
   * arrangement). Applies to pointer clicks and to the keyboard commit alike.
   * @default false
   */
  reselect?: boolean;
  /**
   * Keyboard commit timing ([P24]). `deferred` (default) keeps the law's
   * standard form-selector behavior — arrows rove a cursor, `Space` commits, so
   * navigating past options never mutates the value. `live` makes every arrow
   * move commit the cursor segment immediately (the {@link TugTabBar} model);
   * opt in only where changing the choice is cheap and side-effect-free (e.g. a
   * live-preview surface like the color picker).
   */
  commit?: CommitMode;
}

/** Serialized shape of `TugChoiceGroup`'s preserved state. */
interface TugChoiceGroupState {
  value: string;
}

// ---- TugChoiceGroup ----

export const TugChoiceGroup = React.forwardRef<HTMLDivElement, TugChoiceGroupProps>(
  function TugChoiceGroup(
    {
      items,
      value,
      senderId,
      size = "md",
      emphasis = "default",
      role,
      disabled = false,
      animated = false,
      sidePadding,
      columns = "equal",
      className,
      style,
      "aria-label": ariaLabel,
      componentStatePreservationKey,
      focusGroup,
      focusOrder = 0,
      focusPolicy,
      reselect = false,
      commit = "deferred",
      ...rest
    },
    ref,
  ) {
    const boxDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || boxDisabled;

    // Role injection — indicator pill uses toggle-primary tokens. [L06]
    const roleStyle = buildRoleStyle("segment", role);

    // Refs for each segment button — indexed to match items array.
    const segmentRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
    // Ref for the sliding indicator pill element.
    const indicatorRef = React.useRef<HTMLDivElement>(null);
    // Latest active value, read from the ResizeObserver callback so a
    // resize that fires after a `value` change picks up the right
    // segment without re-creating the observer.
    const activeValueRef = React.useRef(value);
    activeValueRef.current = value;
    // Stable items reference for the observer callback. Items typically
    // come from a module-level constant, but a caller passing a fresh
    // array each render must still see the correct active index in
    // resize callbacks fired between renders.
    const itemsRef = React.useRef(items);
    itemsRef.current = items;

    // Imperative measure: read the active segment's offsetLeft/Width
    // and write the indicator's transform + width. Pulled out so both
    // the value-change `useLayoutEffect` and the size-change
    // `ResizeObserver` can call it [L06].
    const measureIndicator = React.useCallback(() => {
      const liveItems = itemsRef.current;
      const liveValue = activeValueRef.current;
      const activeIndex = liveItems.findIndex((item) => item.value === liveValue);
      if (activeIndex === -1) return;
      const segEl = segmentRefs.current[activeIndex];
      const indEl = indicatorRef.current;
      if (!segEl || !indEl) return;
      // `offsetWidth` is the segment's live border box — whatever padding
      // `sidePadding` resolves to (tighter or wider than the size default),
      // the indicator is measured off the box, so it covers it for free.
      indEl.style.transform = `translateX(${segEl.offsetLeft}px)`;
      indEl.style.width = `${segEl.offsetWidth}px`;
    }, []);

    // Re-measure on every value or items change. useLayoutEffect runs
    // synchronously before paint so the indicator never flickers
    // through a stale position.
    React.useLayoutEffect(() => {
      measureIndicator();
    }, [value, items, measureIndicator]);

    // Observe size changes on every segment so the indicator stays
    // glued to the active one across font load, container resize, and
    // any layout settling that runs after first paint. Without this,
    // a choice group whose first paint happens before the surrounding
    // layout has settled (a common case when the parent component
    // mounts a substrate that imperatively inserts DOM in its own
    // layout effect — CodeMirror, Monaco, Lexical) measures its
    // segments at a tentative width and the indicator stays at width
    // 0 until the next `value`/`items` change forces a re-measure.
    // The observer fires once on attach with the current size and
    // again on every change; both paths route through
    // `measureIndicator` so the rendered indicator always reflects
    // the segment's current geometry [L06].
    //
    // Keyed on the items' VALUES, not the array: a caller that builds its
    // items afresh each render (the Layout card's rows) handed every render a
    // new observer, and a new observer delivers once on attach — a forced
    // read of every segment's `offsetLeft` on the next rendering update, which
    // on a settle's retarget is inside the running motion. The same values
    // are the same buttons, already observed.
    const itemsKey = items.map((item) => item.value).join("\u0000");
    React.useLayoutEffect(() => {
      const segs = segmentRefs.current.filter(
        (el): el is HTMLButtonElement => el !== null,
      );
      if (segs.length === 0) return;
      const observer = new ResizeObserver(measureIndicator);
      for (const seg of segs) observer.observe(seg);
      return () => observer.disconnect();
    }, [itemsKey, measureIndicator]);

    // Chain dispatch [L11]: targeted dispatch of `selectValue` to
    // the parent responder. Arrow keys move selection (not just
    // focus), so they also dispatch via the same handler.
    const { dispatch: controlDispatch } = useControlDispatch();
    const fallbackId = useId();
    const effectiveSenderId = senderId ?? fallbackId;
    const dispatchSelectValue = useCallback(
      (nextValue: string) => {
        controlDispatch({
          action: TUG_ACTIONS.SELECT_VALUE,
          value: nextValue,
          sender: effectiveSenderId,
          phase: "discrete",
        });
      },
      [controlDispatch, effectiveSenderId],
    );

    // Opt-in Component State Preservation Protocol. Hook no-ops when
    // `componentStatePreservationKey` is undefined. Controlled-only —
    // the parent responder owns `value` and carries its own saved state
    // via [A9]; it mounts in the saved selection on cold boot, which
    // flows back down here through the `value` prop. [D13] / [A9].
    useComponentStatePreservation<TugChoiceGroupState>({
      componentStatePreservationKey,
      captureState: () => ({ value }),
    });

    // ---- Item-container keyboard ([P01], [P03]) ----
    //
    // One stop in the engine Tab walk; arrows move a movement cursor over the
    // enabled segments (the ring stays on the group), Space/Enter dispatch
    // `selectValue` for the cursor segment. Tab-into lands the cursor on the
    // selected segment.
    const autoFocusId = useId();
    // The enabled segments, in cursor order, paired with their values.
    const enabledSegments = useCallback((): { el: HTMLButtonElement; value: string }[] => {
      const out: { el: HTMLButtonElement; value: string }[] = [];
      itemsRef.current.forEach((item, index) => {
        if (effectiveDisabled || item.disabled) return;
        const el = segmentRefs.current[index];
        if (el) out.push({ el, value: item.value });
      });
      return out;
    }, [effectiveDisabled]);

    const { attachRoot, onKeyDown, syncItems, setCursor } = useItemGroupKeyboard({
      id: autoFocusId,
      group: focusGroup ?? "",
      order: focusOrder,
      policy: focusPolicy,
      register: focusGroup !== undefined,
      commit,
      collectItems: () => enabledSegments().map((s) => s.el),
      initialIndex: () => {
        const idx = enabledSegments().findIndex((s) => s.value === value);
        return idx >= 0 ? idx : 0;
      },
      // Commit timing is [P24] by default (`deferred`): arrows move the cursor
      // only, Space commits the ringed segment, Enter bubbles to the scope
      // default. With `commit: "live"` (opt-in) every arrow move commits the
      // cursor segment via onMove — the TugTabBar model, for cheap/side-effect-
      // free choices. A cycle stop relinquishes on the Space commit via the
      // mode's commit disposition ([P15]), not via a `deferCommit` flag.
      onSelect: (element) => {
        const next = element?.getAttribute("data-choice-value");
        if (next != null && (next !== value || reselect)) {
          dispatchSelectValue(next);
        }
      },
      ...(commit === "live"
        ? {
            onMove: (element: Element | null) => {
              const next = element?.getAttribute("data-choice-value");
              if (next != null && next !== value) dispatchSelectValue(next);
            },
          }
        : {}),
    });

    // Re-sync the cursor's range when the item set changes.
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
        data-slot="tug-choice-group"
        role="radiogroup"
        aria-label={ariaLabel}
        aria-disabled={effectiveDisabled || undefined}
        data-role={role}
        data-emphasis={emphasis}
        data-side-padding={sidePadding}
        data-columns={columns === "equal" ? undefined : columns}
        data-disabled={effectiveDisabled || undefined}
        className={cn(
          "tug-choice-group",
          `tug-choice-group-${size}`,
          animated && "tug-choice-group-animated",
          className,
        )}
        style={{ ...roleStyle, ...style }}
        tabIndex={focusGroup !== undefined ? 0 : undefined}
        onKeyDown={onKeyDown}
        {...rest}
      >
        {/* Sliding indicator pill — only the *animated* variant needs the
            imperatively-positioned overlay (it slides between segments). The
            non-animated variant paints the pill as the active segment's own
            CSS background instead, so it reads no `offsetLeft`/`offsetWidth`
            and forces no layout — `measureIndicator` returns early when this
            element is absent. Eliminates the per-instance reflow that made a
            transcript of diff-block toggles a top load hot spot [L06]. */}
        {animated ? (
          <div
            ref={indicatorRef}
            className="tug-choice-group-indicator"
            aria-hidden="true"
          />
        ) : null}

        {items.map((item, index) => {
          const isActive = item.value === value;
          const isDisabled = effectiveDisabled || item.disabled;
          const isIconOnly = item.icon && !item.label;

          const segment = (
            <button
              ref={(el) => { segmentRefs.current[index] = el; }}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-disabled={isDisabled || undefined}
              aria-label={isIconOnly ? item["aria-label"] : undefined}
              disabled={isDisabled}
              data-choice-value={item.value}
              data-state={isActive ? "active" : "inactive"}
              className={cn(
                "tug-choice-group-segment",
                isIconOnly && "tug-choice-group-segment-icon-only",
              )}
              tabIndex={-1}
              data-tug-focus="refuse"
              onClick={() => {
                if (!isDisabled) {
                  const idx = enabledSegments().findIndex((s) => s.value === item.value);
                  if (idx >= 0) setCursor(idx);
                  if (!isActive || reselect) dispatchSelectValue(item.value);
                }
              }}
            >
              {renderGroupItemContent({ label: item.label, icon: item.icon, iconPosition: item.iconPosition })}
            </button>
          );

          return item.tooltip !== undefined ? (
            <TugTooltip
              key={item.value}
              content={item.tooltip}
              shortcut={item.tooltipShortcut}
            >
              {segment}
            </TugTooltip>
          ) : (
            <React.Fragment key={item.value}>{segment}</React.Fragment>
          );
        })}
      </div>
    );
  },
);
