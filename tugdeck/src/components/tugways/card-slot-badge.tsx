/**
 * CardSlotBadge — the slot a card's pane stands in, said on the card itself.
 *
 * Under a multi-slot imposition the deck has places, and until now the only
 * surface that named them was the Lens: a reader looking at a card had to look
 * somewhere else to learn where it stood. The badge is that fact, brought back
 * to the card — one numbered chip in the masthead frame's leading column,
 * carrying the pane's `slot + 1`.
 *
 * It is a readout at rest, `outlined` rather than `filled`: a card sitting
 * where it belongs should not wear an accent. Accent is reserved for the
 * transient selection inside the popup the badge opens.
 *
 * **Absent, not dimmed, when there is no slot to name.** A one-up imposition,
 * a pane with no `slot`, a sidebar, and the Lens all render nothing at all.
 * That departs from the register-not-component rule the flow dots follow, and
 * deliberately: that rule governs a fact that always exists and only changes
 * emphasis — how much of the strip the band shows is always true, so the dots
 * are always there and only grow prominent. A one-up pane does not stand in a
 * slot, so a badge there would be a chip stating a fact that does not exist.
 * Dimming it would say "there is a position here, it is just unimportant",
 * which is false.
 *
 * **The popup is registered for the keyboard and not yet reachable by it.**
 * Its chips are authored into a focus group and each reports itself to the
 * engine, so the walk can see them — but nothing parks the key view on a chip
 * when the popup opens by pointer, and the ambient key view on a Session card
 * rests in the composer, a multi-line surface that owns Tab by construction.
 * So the first keyboard path to slot assignment outside the Lens is authored
 * rather than open. Closing it is focus-engine work, not this component's.
 *
 * Laws: [L02] the imposition, the host pane and its slot all enter through
 *       `useSyncExternalStore` on the deck store; [L11] the badge's control
 *       form emits an action; [L20] the composed `TugSlot` keeps its own
 *       tokens — the geometry here is position only.
 * Decisions: [D121] layout imposition.
 *
 * @module components/tugways/card-slot-badge
 */

import React, { useSyncExternalStore } from "react";

import "./card-slot-badge.css";

import { getDeckStore } from "@/lib/deck-store-registry";
import { slotCount } from "@/lib/layout-imposer";
import { findSidebarPanes } from "@/deck-store-selectors";
import { dispatchCommand } from "@/command-dispatch";
import { TugSlot } from "@/components/tugways/tug-slot";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotLayoutHandle } from "@/components/tugways/tug-slot-layout";
import {
  TugPopover,
  TugPopoverContent,
  TugPopoverTrigger,
} from "@/components/tugways/tug-popover";

/**
 * Focus group for the popup's chips. The popup is its own surface, so the
 * group is the whole of the walk inside it — ArrowLeft/Right steps the
 * arrangement and Enter puts the card there, which is the first keyboard path
 * to slot assignment outside the Lens.
 */
const BADGE_SLOT_FOCUS_GROUP = "card-slot-badge-slots";

export interface CardSlotBadgeProps {
  /** The card whose host pane the badge reports on. */
  cardId: string | undefined;
}

/**
 * The badge for the pane hosting `cardId`, or `null` when that pane stands in
 * no slot the reader can be told about.
 */
export function CardSlotBadge({ cardId }: CardSlotBadgeProps): React.ReactElement | null {
  const deckStore = getDeckStore();
  const deck = useSyncExternalStore(
    deckStore?.subscribe ?? (() => () => {}),
    deckStore !== null ? deckStore.getSnapshot : () => null,
    () => null,
  );
  // Controlled, so selecting a slot can close the popup in the same act that
  // moves the card. Every dismissal path Radix offers — the trigger again,
  // Escape, a click outside — routes through the same setter.
  const [open, setOpen] = React.useState(false);
  const picker = React.useRef<TugSlotLayoutHandle | null>(null);

  if (deck === null || cardId === undefined) return null;

  const kind = deck.imposition.kind;
  // No imposition, or an imposition with one place in it: there is no position
  // to report, so there is no chip.
  if (kind === undefined || slotCount(kind) <= 1) return null;

  const host = deck.panes.find((pane) => pane.cardIds.includes(cardId));
  if (host === undefined || host.slot === undefined) return null;

  // A sidebar — the Lens among them — is the imposition's fixed end rather
  // than a member of the chain it bounds. The same guard `SlotPicker` applies.
  const sidebar = findSidebarPanes(deck).some((entry) => entry.pane.id === host.id);
  if (sidebar) return null;

  const count = slotCount(kind);
  const held = host.slot;

  return (
    <span className="tug-masthead-frame-slot-badge" data-testid="card-slot-badge">
      <TugPopover open={open} onOpenChange={setOpen}>
        <TugPopoverTrigger>
          {/* The chip is a CONTROL here, not the readout it looks like: the
              popup is what a reader reaches for once they know where the card
              stands. Radix's trigger composes its own click onto the button
              `TugSlot` renders, and `onSelect` is the same act by the other
              path — whichever handler the composition leaves on the element,
              pressing the chip opens the popup. */}
          <TugSlot
            number={held + 1}
            state="outlined"
            size="sm"
            aria-label={`In position ${held + 1} — move this card`}
            data-testid="card-slot-badge-trigger"
            onSelect={() => setOpen(true)}
          />
        </TugPopoverTrigger>
        <TugPopoverContent
          side="bottom"
          align="start"
          data-testid="card-slot-badge-popup"
          /* Radix's FocusScope focuses the first focusable DESCENDANT on open,
             and every descendant here is a slot — a control the engine walks
             but the pointer does not focus. Left to the default, the popup
             opened onto nothing holding the key view, and a Tab inside it had
             no stop to advance from: the chips were reachable in principle and
             unreachable in fact. So the landing is stated — the card's OWN
             place, which is where a reader's next key should start. */
          onOpenAutoFocus={(event) => {
            const root = picker.current?.element;
            if (root === null || root === undefined) return;
            const chips = root.querySelectorAll<HTMLElement>('[data-slot="tug-slot"]');
            const landing = chips[held] ?? chips[0];
            if (landing === undefined) return;
            event.preventDefault();
            landing.focus();
          }}
        >
          {/* The current slot is the one place accent belongs: it is a live
              selection inside an open popup rather than a card's resting
              state. Everything else rests — a slot another card holds is not
              this card's business to report from here. */}
          <TugSlotLayout
            ref={picker}
            className="card-slot-badge-picker"
            data-testid="card-slot-badge-picker"
            count={count}
            states={Array.from({ length: count }, (_, slot) =>
              slot === held ? "filled" : "rest",
            )}
            focusGroup={BADGE_SLOT_FOCUS_GROUP}
            slotLabel={(slot) => `Put at position ${slot + 1}`}
            onSelectSlot={(slot) => {
              // The same action the Lens's own picker dispatches, which
              // already assigns AND raises — a slot is a vertical stack, and
              // moving a card there means being able to see it.
              dispatchCommand("assign-slot", { cardId, slot });
              setOpen(false);
            }}
          />
        </TugPopoverContent>
      </TugPopover>
    </span>
  );
}
