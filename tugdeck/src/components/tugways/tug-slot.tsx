/**
 * TugSlot — one numbered position in a layout, drawn as a small card.
 *
 * A slot stands for a place a card can be put, so it is shaped like the thing
 * it places: a little taller than it is wide, with nearly-squared corners and
 * its number centered. It is never ghosted — a slot with no card in it is still
 * a card-shaped rectangle, because an invisible slot stops evoking a pane.
 *
 * Three resting looks, on the `state` axis:
 *
 *  - `"rest"` — the position is empty. A quiet tinted card.
 *  - `"outlined"` — a card is here, but it is not the one on top.
 *  - `"filled"` — a card is here and it is the one on top.
 *
 * Hover, pressed, and disabled are the interaction layer over whichever
 * resting look is in force. They come from `TugButton`'s emphasis × role
 * tokens, so a slot's states move with the theme exactly as every other
 * control does ([L20] — this file adds no color of its own, only shape and
 * numerals).
 *
 * A slot is interactive only when it is given something to do. Pass `onSelect`
 * and it renders as a focus-refusing `TugButton`; omit it and the slot renders
 * as an inert `<span>` — the exemplar form, for showing an arrangement rather
 * than operating one.
 *
 * Laws: [L06] appearance via CSS and DOM attributes, never React state;
 *       [L11] the interactive form is a control that emits through its
 *       `onSelect`; [L15] token-driven states; [L16] pairings declared;
 *       [L19] component authoring guide; [L20] token sovereignty — the
 *       composed `TugButton` keeps its own tokens.
 * Decisions: [D02] emphasis × role system; [D121] layout imposition.
 *
 * @module components/tugways/tug-slot
 */

import "./tug-slot.css";

import React from "react";

import { cn } from "@/lib/utils";
import { TugButton, tugButtonEmphasisClass } from "./internal/tug-button";
import type { TugButtonEmphasis, TugButtonRole } from "./internal/tug-button";

/* ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------*/

/** A slot's resting look — what the position currently holds. */
export type TugSlotState = "rest" | "outlined" | "filled";

/** Slot size. `sm` is the in-row control; `md` is the exemplar. */
export type TugSlotSize = "sm" | "md";

/** The `TugButton` emphasis each resting look composes. */
const STATE_EMPHASIS: Record<TugSlotState, TugButtonEmphasis> = {
  // Tinted, not ghost: an empty slot still paints a card-shaped surface.
  rest: "tinted",
  outlined: "outlined",
  filled: "filled",
};

/** The color domain every slot composes. A slot is a place, not an accent. */
const SLOT_ROLE: TugButtonRole = "action";

/** Which of the two forms a rendered slot is — they paint through different
 *  classes, so anything rewriting a look has to know which one it holds. */
export type TugSlotForm = "exemplar" | "control";

/**
 * The one class a slot of `form` paints `state` through.
 *
 * A slot's `data-state` is the fact; this is the look. It lives here because
 * which class carries a resting look is `TugSlot`'s own knowledge: the exemplar
 * span wears this file's vocabulary, and the control form wears the compound
 * emphasis × role class `TugButton` composes — taken from that component rather
 * than restated, so the grammar keeps one definition ([L20]).
 *
 * `TugSlotLayout` calls this when it projects live looks onto children it
 * rendered. Nothing outside the pair should need it.
 */
export function tugSlotLookClass(state: TugSlotState, form: TugSlotForm): string {
  return form === "exemplar"
    ? `tug-slot-exemplar-${state}`
    : tugButtonEmphasisClass(STATE_EMPHASIS[state], SLOT_ROLE);
}

/* ---------------------------------------------------------------------------
 * TugSlotProps
 * ---------------------------------------------------------------------------*/

export interface TugSlotProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "onSelect" | "children"> {
  /** The slot's number, shown centered. 1-based — slot 0 reads as "1". */
  number: number;
  /**
   * Resting look.
   * @selector [data-state="rest"] | [data-state="outlined"] | [data-state="filled"]
   * @default "rest"
   */
  state?: TugSlotState;
  /**
   * Size.
   * @selector .tug-slot-size-sm | .tug-slot-size-md
   * @default "sm"
   */
  size?: TugSlotSize;
  /**
   * Makes the slot a control. With it the slot renders as a focus-refusing
   * button; without it the slot is an inert exemplar. Receives the click so a
   * slot inside a clickable row can keep the row from activating.
   */
  onSelect?: (event?: React.MouseEvent<HTMLButtonElement>) => void;
  /**
   * Non-interactive appearance for an interactive slot.
   * @selector :disabled | [aria-disabled="true"]
   * @default false
   */
  disabled?: boolean;
  /** Accessible label. Required on the interactive form. */
  "aria-label"?: string;
  /**
   * Focus group the interactive slot is authored into ([P02]). A slot inside a
   * list row registers into the row's descend scope, so ArrowRight onto the row
   * reaches it; without a group the slot is pointer-only and the keyboard cannot
   * see it at all. Ignored on the exemplar form, which is not a control.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0. */
  focusOrder?: number;
}

/* ---------------------------------------------------------------------------
 * TugSlot
 * ---------------------------------------------------------------------------*/

export const TugSlot = React.forwardRef<HTMLElement, TugSlotProps>(
  function TugSlot(
    {
      number,
      state = "rest",
      size = "sm",
      onSelect,
      disabled = false,
      focusGroup,
      focusOrder = 0,
      className,
      ...rest
    },
    ref,
  ) {
    const classes = cn("tug-slot", `tug-slot-size-${size}`, className);

    if (onSelect === undefined) {
      return (
        <span
          ref={ref as React.Ref<HTMLSpanElement>}
          data-slot="tug-slot"
          data-state={state}
          data-exemplar="true"
          className={cn(classes, `tug-slot-exemplar-${state}`)}
          aria-hidden="true"
          {...rest}
        >
          {number}
        </span>
      );
    }

    return (
      <TugButton
        ref={ref as React.Ref<HTMLButtonElement>}
        subtype="text"
        emphasis={STATE_EMPHASIS[state]}
        role={SLOT_ROLE}
        size="2xs"
        rounded="none"
        disabled={disabled}
        focusGroup={focusGroup}
        focusOrder={focusOrder}
        onClick={(event) => onSelect(event)}
        data-slot="tug-slot"
        data-state={state}
        className={classes}
        {...(rest as Record<string, unknown>)}
      >
        {number}
      </TugButton>
    );
  },
);
