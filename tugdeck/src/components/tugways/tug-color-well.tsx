/**
 * TugColorWell — a compact control that displays a TugColor value (swatch +
 * `tug(hue, i, t, a)` text) and, on click, activates itself as the subject of
 * the standalone TugColorPicker.
 *
 * Modeled on AppKit's NSColorWell: the well displays and activates; a single
 * shared picker edits the active one. The well owns NOTHING — its parent
 * responder owns the color. On click it dispatches ACTIVATE_COLOR_WELL to that
 * responder (which records itself in active-color-target.ts); the picker reads
 * that target and dispatches SET_COLOR back.
 *
 * `readOnly` renders a non-interactive chip (a derived/output color); a
 * `focusGroup` authors the well into the surrounding surface's Tab walk ([P02]),
 * with Enter/Space activating the picker.
 */

import React, { useContext, useId } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useControlDispatch } from "./use-control-dispatch";
import { useFocusable } from "./use-focusable";
import type { FocusPolicy } from "./focus-manager";
import { TUG_ACTIONS } from "./action-vocabulary";
import { COLOR_PICKER_COMPONENT_ID, useActiveColorTarget } from "./active-color-target";
import { formatTugColorText, swatchOklch, type TugColorSpec } from "./tugcolor";
import { CardDeckContext } from "@/card-deck-context";
import "./tug-color-well.css";

export interface TugColorWellProps {
  /** The color to display. Owned by the parent responder, not the well. */
  value: TugColorSpec;
  /** Stable sender id — identifies this well to its host responder. */
  senderId?: string;
  /** Header label the picker shows while this well is active. */
  label?: string;
  /** Show the `tug(...)` value text beside the swatch (default true). */
  showText?: boolean;
  size?: "sm" | "md";
  disabled?: boolean;
  /** Non-interactive display chip (an output / derived color). */
  readOnly?: boolean;
  /** Author this well into a focus group ([P02]); Enter/Space activates it. */
  focusGroup?: string;
  focusOrder?: number;
  focusPolicy?: FocusPolicy;
}

export function TugColorWell({
  value,
  senderId,
  label,
  showText = true,
  size = "md",
  disabled = false,
  readOnly = false,
  focusGroup,
  focusOrder = 0,
  focusPolicy,
}: TugColorWellProps): React.ReactElement {
  const autoId = useId();
  const id = senderId ?? autoId;
  const { dispatch: controlDispatch } = useControlDispatch();
  const active = useActiveColorTarget();
  const isActive = !readOnly && active?.senderId === id;
  // Tolerant of standalone/preview mounts with no deck (context null).
  const deck = useContext(CardDeckContext);
  const { focusableRef } = useFocusable({
    id: `${id}-focusable`,
    group: focusGroup ?? "",
    order: focusOrder,
    policy: focusPolicy,
    register: !readOnly && !disabled && focusGroup !== undefined,
  });

  const handleClick = (): void => {
    if (disabled || readOnly) return;
    // Reveal + activate the shared picker card, then announce this well as its
    // subject (the host records itself as the active color target).
    deck?.showSingletonCard(COLOR_PICKER_COMPONENT_ID);
    controlDispatch({
      action: TUG_ACTIONS.ACTIVATE_COLOR_WELL,
      sender: id,
      phase: "discrete",
      value: { value, label: label ?? "Color" },
    });
  };

  const ariaLabel = label ? `${label}: ${formatTugColorText(value)}` : formatTugColorText(value);
  const content = (
    <>
      <span
        className="tug-color-well-swatch"
        style={{ "--tcw-swatch": swatchOklch(value) } as React.CSSProperties}
      />
      {showText && <span className="tug-color-well-text">{formatTugColorText(value)}</span>}
    </>
  );

  if (readOnly) {
    return (
      <span
        data-slot="tug-color-well"
        aria-label={`${ariaLabel} (read-only)`}
        title="Read-only — computed value"
        className={cn("tug-color-well", "tug-color-well-readonly", `tug-color-well-size-${size}`)}
      >
        {content}
        <Lock className="tug-color-well-lock" aria-hidden size={12} />
      </span>
    );
  }

  return (
    <button
      ref={focusableRef as (el: HTMLButtonElement | null) => void}
      type="button"
      data-slot="tug-color-well"
      data-tug-focus="refuse"
      data-active={isActive ? "" : undefined}
      aria-label={ariaLabel}
      aria-pressed={isActive}
      disabled={disabled}
      onClick={handleClick}
      className={cn("tug-color-well", `tug-color-well-size-${size}`)}
    >
      {content}
    </button>
  );
}
