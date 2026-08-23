/**
 * slot-picker.tsx — where a Lens row's card stands, and the two ways to move it.
 *
 * A `TugSlotLayout` in its control form, drawn as a **window**: the slot the
 * row's card holds, with its neighbours either side, rather than every slot in
 * the deck's imposition. Nothing renders at all when no imposition is active —
 * the picker is the arrangement's affordance, not a permanent row fixture.
 *
 * **Why a window.** The exhaustive run encoded position geometrically — find
 * the lit chip in the ruler — which was legible and cost a chip per place on
 * every row. That made the row's width a function of the deck's slot count, so
 * the count was the thing that had to stay small: six already crowded the rail
 * and the design had no answer for eight. The window states position in the
 * NUMERAL instead, with the neighbours giving the local run, and costs the
 * same at three places as at ten.
 *
 * **The centre does not move.** The window is not slid to stay full at the
 * ends of the run — slot 1 keeps its chip in the middle and the position that
 * would sit left of it is drawn as an inert stub. A sliding window would put
 * the answer at a different offset per row, and a column of rows read at a
 * glance is exactly what the alignment is for.
 *
 * The three looks say where the row's card stands:
 *
 *  - **filled** — the card holds this slot and is the one on top of it.
 *  - **outlined** — the card holds this slot but another card is over it.
 *  - **rest** — the card is not at this position.
 *
 * A card holds at most one slot, so at most one chip in a row is ever lit, and
 * with a window that chip is always the middle one.
 *
 * **Two gestures, and the difference is the distance.** Pressing a NEIGHBOUR
 * moves the card one place that way — the common move, at the cost of one
 * press. Pressing the CENTRE opens the whole run as a popup with the card's
 * own slot filled, which is how the reader reaches a place the window does not
 * show. That popup is the same surface the card's own masthead badge opens, so
 * the gesture is learned once and works from either end.
 *
 * Assigning always assigns *and* raises, even when another pane already holds
 * that slot: a slot is a vertical stack, and the Lens list is the switching
 * surface. There is no toggle-off; a pane leaves its slot by being dragged out
 * or by the imposition being turned off.
 *
 * Laws: [L02] the imposition, the host pane's slot, the stacking order and the
 * window preference all enter React through `useSyncExternalStore`; [L11] each
 * slot is a control that emits an action.
 *
 * @module components/lens/slot-picker
 */

import "./slot-picker.css";

import React, { useSyncExternalStore } from "react";

import { dispatchCommand } from "@/command-dispatch";
import { getDeckStore } from "@/lib/deck-store-registry";
import { slotCount } from "@/lib/layout-imposer";
import { findLensPane } from "@/deck-store-selectors";
import { useSlotWindow } from "@/lib/slot-window-pref";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotLayoutHandle } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import {
  TugPopover,
  TugPopoverAnchor,
  TugPopoverContent,
} from "@/components/tugways/tug-popover";
import type { TugPopoverMeasurable } from "@/components/tugways/tug-popover";

/**
 * Focus group for a row's slots. The picker renders inside `TugListView`'s
 * per-row `FocusModeContext`, so the slots register into their own row's descend
 * scope — the mode scopes the walk, and this shared constant is only the
 * within-row ordering. They are reachable by descending (ArrowRight) onto the
 * row, never from the Lens's Tab cycle. Same authoring as the session picker's
 * row trash button.
 */
const ROW_SLOT_FOCUS_GROUP = "lens-row-slots";

/** Focus group for the jump popup's run — its own surface, its own walk. */
const JUMP_SLOT_FOCUS_GROUP = "lens-slot-jump";

/**
 * The slot layout for the row that represents `cardId`. Renders `null` when the
 * deck has no active imposition.
 */
export function SlotPicker({ cardId }: { cardId: string }): React.ReactElement | null {
  const deckStore = getDeckStore();
  const deck = useSyncExternalStore(
    deckStore?.subscribe ?? (() => () => {}),
    deckStore !== null ? deckStore.getSnapshot : () => null,
    () => null,
  );
  const windowSize = useSlotWindow();
  const [jumpOpen, setJumpOpen] = React.useState(false);
  const layout = React.useRef<TugSlotLayoutHandle | null>(null);
  const jumpLayout = React.useRef<TugSlotLayoutHandle | null>(null);

  // The popup points at the CENTRE chip rather than at the run, and it points
  // through a measurable rather than through a trigger: composing
  // `TugPopoverTrigger` onto one chip of a layout would mean the layout
  // rendering a different element for one of its slots, and composing Radix's
  // auto-toggle onto a control that already has its own `onSelect` is the
  // fight `TugPopoverAnchor` was written to avoid. The rect is re-read on
  // every Popper update, so it tracks the row through a Lens scroll.
  const anchor = React.useRef<TugPopoverMeasurable>({
    getBoundingClientRect: () => {
      const root = layout.current?.element;
      // The middle DRAWN POSITION, which is where the held slot always
      // stands. Counting chips instead would find the wrong element the
      // moment the window overhangs the run: a stub is a position and not a
      // chip, so at the head of a six-up the two chips drawn are positions 1
      // and 2, and the middle chip is not the middle position.
      const positions = root?.children;
      const centre = positions?.[Math.floor((positions.length - 1) / 2)];
      return (centre ?? root)?.getBoundingClientRect() ?? new DOMRect();
    },
  });

  const kind = deck?.imposition.kind;
  if (kind === undefined || deck === null) return null;

  const count = slotCount(kind);
  const hostIndex = deck.panes.findIndex((pane) => pane.cardIds.includes(cardId));
  const host = hostIndex >= 0 ? deck.panes[hostIndex] : undefined;
  // A card hosted in the Lens is not the chain's to place — the Lens is the
  // imposition's fixed end. Lens rows never represent the Lens itself today;
  // the guard keeps the picker honest if one ever does.
  const disabled = host === undefined || host.id === findLensPane(deck)?.id;
  const held = host?.slot;

  // Later in the panes array is higher in the stack, so the last pane holding
  // the slot is the one on top of it.
  const topIndexAtHeldSlot =
    held === undefined
      ? -1
      : deck.panes.reduce(
          (top, pane, index) => (pane.slot === held ? index : top),
          -1,
        );

  const states: TugSlotState[] = Array.from({ length: count }, (_, slot) => {
    if (slot !== held) return "rest";
    return hostIndex === topIndexAtHeldSlot ? "filled" : "outlined";
  });

  // A card with no slot of its own — a sidebar member, which the Cards list
  // does show — has no place for the window to centre on, so it centres on the
  // run's head. Every chip rests, which is the same nothing-is-lit reading the
  // exhaustive run gave that card.
  const centre = held ?? 0;
  // **The centre is always the door**, whether or not the card has a place.
  // For a card that has one, pressing where it already stands is not a move,
  // so the press spends itself on the run instead. For a card that has none —
  // a Jots or Overview row — the door is what makes the far end of the
  // arrangement reachable at all: nothing is lit, so every chip is a
  // destination, and without a door a three-wide window on a six-up deck could
  // only offer the first two places.
  const doorAt = centre;

  const assign = (slot: number): void => {
    dispatchCommand("assign-slot", { cardId, slot });
  };

  return (
    <TugPopover open={jumpOpen} onOpenChange={setJumpOpen}>
      <TugPopoverAnchor virtualRef={anchor} />
      <TugSlotLayout
        ref={layout}
        className="slot-picker"
        data-testid="lens-slot-picker"
        count={count}
        states={states}
        window={{ centre, size: windowSize }}
        disabled={disabled}
        focusGroup={ROW_SLOT_FOCUS_GROUP}
        slotLabel={(slot) => {
          if (slot === doorAt) {
            return held === undefined
              ? `In no place yet — press to put this card somewhere`
              : `In position ${slot + 1} of ${count} — press to move this card anywhere`;
          }
          // "Move to" says there is somewhere to move FROM. A card standing in
          // no place is being put somewhere for the first time.
          return held === undefined
            ? `Put at position ${slot + 1}`
            : `Move to position ${slot + 1}`;
        }}
        onSelectSlot={(slot, event) => {
          // Assigning is not a row activation — stop it reaching the cell.
          event?.stopPropagation();
          // The middle chip is the door to the whole run; every other chip in
          // the window is the one-place move it names.
          if (slot === doorAt) setJumpOpen(true);
          else assign(slot);
        }}
      />
      <TugPopoverContent
        side="bottom"
        align="center"
        /* The landing has to be stated, or the popup is pointer-only. Radix's
           FocusScope focuses the first focusable DESCENDANT, and every
           descendant here is a slot — a control the focus engine walks but the
           pointer does not focus — so the default opens the popup onto nothing
           holding the key view, and a keyboard inside it has no stop to move
           from. That matters more here than it does on the card's own badge,
           because the row's centre chip is reachable by ArrowRight and answers
           Space: the keyboard can OPEN this popup, so the keyboard has to be
           able to use it. The landing is the card's own place, which is where
           a reader's next key should start. */
        onOpenAutoFocus={(event) => {
          const root = jumpLayout.current?.element;
          if (root === null || root === undefined) return;
          const chips = root.querySelectorAll<HTMLElement>('[data-slot="tug-slot"]');
          const landing = chips[centre] ?? chips[0];
          if (landing === undefined) return;
          event.preventDefault();
          landing.focus();
        }}
      >
        {/* The handle is on the RUN rather than on the content, because
            `TugPopoverContent` styles the bubble and forwards nothing else —
            an attribute set on it is dropped, silently. */}
        <TugSlotLayout
          ref={jumpLayout}
          data-testid="lens-slot-picker-jump"
          className="tug-slot-layout-popup"
          count={count}
          states={states}
          focusGroup={JUMP_SLOT_FOCUS_GROUP}
          slotLabel={(slot) => `Put at position ${slot + 1}`}
          onSelectSlot={(slot, event) => {
            event?.stopPropagation();
            assign(slot);
            setJumpOpen(false);
          }}
        />
      </TugPopoverContent>
    </TugPopover>
  );
}
