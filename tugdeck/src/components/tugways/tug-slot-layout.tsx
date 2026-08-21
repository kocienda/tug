/**
 * TugSlotLayout — a set of numbered slots read as one arrangement.
 *
 * The layout is the plural of {@link TugSlot}: `count` slots side by side,
 * numbered 1..N, each carrying its own resting look. It has two lives, and
 * they are the same component because they must look like the same thing:
 *
 *  - **Exemplar** — no `onSelectSlot`. Every slot is inert, and the layout is
 *    a picture of an arrangement, for a chooser to label one of its options
 *    with. The enclosing control owns selection and hover.
 *  - **Control** — with `onSelectSlot`. Every slot is a button, and clicking
 *    one asks for that position. This is the in-row form on a Lens Sessions or
 *    Text Files row.
 *
 * `states` gives the per-slot look; anything it does not cover reads as
 * `"rest"`. A layout with no `states` at all is therefore an empty
 * arrangement — the right picture for a chooser option.
 *
 * **Two write paths reach a slot's resting look, and they are ordered.** The
 * `states` prop is the committed truth: every commit re-renders the arrangement
 * from it. `setStates`, on the handle, is the LIVE truth between commits — for a
 * consumer whose looks change per frame under a gesture, which [L06] forbids
 * putting through React state. A commit always supersedes a live write, because
 * the two derive from the same quantity and the commit is the later reading of
 * it. So a caller of `setStates` never has to clear what it wrote: the next
 * render supplies it. Call it from a gesture or a subscription, never from
 * render.
 *
 * The projection writes what each form actually paints through. A slot's
 * `data-state` is the fact, and both forms carry it. Its look is one class, and
 * which class depends on the form: the exemplar span carries
 * `tug-slot-exemplar-<state>`, `TugSlot`'s own vocabulary; the control form is a
 * `TugButton` and carries the compound emphasis × role class that button
 * composes, taken from `tugButtonEmphasisClass` rather than restated here
 * ([L20] — the grammar has one definition, in `tug-button.tsx`).
 *
 * Laws: [L06] appearance via CSS and DOM attributes, never React state;
 *       [L11] the control form emits through `onSelectSlot`; [L16] pairings
 *       declared; [L19] component authoring guide; [L20] token sovereignty —
 *       the composed slots keep their own tokens.
 * Decisions: [D121] layout imposition.
 *
 * @module components/tugways/tug-slot-layout
 */

import "./tug-slot-layout.css";

import React from "react";

import { cn } from "@/lib/utils";
import { TugSlot, tugSlotLookClass } from "./tug-slot";
import type { TugSlotSize, TugSlotState } from "./tug-slot";

/* ---------------------------------------------------------------------------
 * TugSlotLayoutProps
 * ---------------------------------------------------------------------------*/

export interface TugSlotLayoutProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "onSelect" | "children"> {
  /** How many slots the arrangement has. Rendered numbered 1..count. */
  count: number;
  /**
   * Per-slot resting look, indexed by slot. Short or absent arrays read the
   * missing slots as `"rest"`.
   */
  states?: readonly TugSlotState[];
  /**
   * Makes every slot a control. Called with the 0-based slot index and the
   * click. Omit for the exemplar form.
   */
  onSelectSlot?: (
    slot: number,
    event?: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  /**
   * Non-interactive appearance for the control form — the whole arrangement at
   * once.
   * @selector [data-disabled="true"]
   * @default false
   */
  disabled?: boolean;
  /**
   * Slot size.
   * @selector .tug-slot-layout-size-sm | .tug-slot-layout-size-md
   * @default "sm"
   */
  size?: TugSlotSize;
  /**
   * Accessible label for a slot, given its 0-based index. Only consulted on
   * the control form, where each slot is a button that needs a name.
   */
  slotLabel?: (slot: number) => string;
  /**
   * Focus group the control form's slots are authored into ([P02]). Each slot
   * registers at its own index, so the arrangement walks left to right. Omit it
   * on the exemplar form, and on any control form the keyboard is not meant to
   * reach.
   */
  focusGroup?: string;
}

/* ---------------------------------------------------------------------------
 * TugSlotLayoutHandle
 * ---------------------------------------------------------------------------*/

/**
 * What a ref to a layout holds.
 *
 * `element` is the layout's own span — the component forwarded that element
 * before it had a handle, and a handle that dropped it would narrow a shipped
 * ref contract for the consumers that come later.
 *
 * `setStates` is the live write path documented at the top of this file.
 */
export interface TugSlotLayoutHandle {
  /** The layout's root span, or `null` before mount / after unmount. */
  element: HTMLSpanElement | null;
  /**
   * Write the arrangement's resting looks straight onto the rendered slots,
   * without a render. Indexed by slot; anything the array does not cover reads
   * as `"rest"`, exactly as the `states` prop does.
   */
  setStates(states: readonly TugSlotState[]): void;
}

/* ---------------------------------------------------------------------------
 * TugSlotLayout
 * ---------------------------------------------------------------------------*/

export const TugSlotLayout = React.forwardRef<TugSlotLayoutHandle, TugSlotLayoutProps>(
  function TugSlotLayout(
    {
      count,
      states,
      onSelectSlot,
      disabled = false,
      size = "sm",
      slotLabel,
      focusGroup,
      className,
      ...rest
    },
    ref,
  ) {
    const rootRef = React.useRef<HTMLSpanElement | null>(null);

    React.useImperativeHandle<TugSlotLayoutHandle, TugSlotLayoutHandle>(
      ref,
      () => ({
        get element() {
          return rootRef.current;
        },
        setStates(next) {
          const root = rootRef.current;
          if (root === null) return;
          const slots = root.querySelectorAll<HTMLElement>('[data-slot="tug-slot"]');
          slots.forEach((slot, index) => {
            const want = next[index] ?? "rest";
            const held = slot.dataset.state as TugSlotState | undefined;
            if (held === want) return;
            const form = slot.dataset.exemplar === "true" ? "exemplar" : "control";
            if (held !== undefined) {
              slot.classList.remove(tugSlotLookClass(held, form));
            }
            slot.classList.add(tugSlotLookClass(want, form));
            slot.dataset.state = want;
          });
        },
      }),
      [],
    );

    return (
      <span
        ref={rootRef}
        data-slot="tug-slot-layout"
        data-count={count}
        data-disabled={disabled ? "true" : undefined}
        className={cn("tug-slot-layout", `tug-slot-layout-size-${size}`, className)}
        {...rest}
      >
        {Array.from({ length: count }, (_, slot) => {
          const label = slotLabel?.(slot) ?? `Position ${slot + 1}`;
          return (
            <TugSlot
              key={slot}
              number={slot + 1}
              state={states?.[slot] ?? "rest"}
              size={size}
              disabled={disabled}
              focusGroup={onSelectSlot !== undefined ? focusGroup : undefined}
              focusOrder={slot}
              aria-label={onSelectSlot !== undefined ? label : undefined}
              title={onSelectSlot !== undefined ? label : undefined}
              onSelect={
                onSelectSlot !== undefined
                  ? (event) => onSelectSlot(slot, event)
                  : undefined
              }
            />
          );
        })}
      </span>
    );
  },
);
