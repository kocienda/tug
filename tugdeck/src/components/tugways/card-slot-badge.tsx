/**
 * CardSlotBadge — the slot a card's pane stands in, said on the card itself.
 *
 * Under a multi-slot imposition the deck has places, and until now the only
 * surface that named them was the Lens: a reader looking at a card had to look
 * somewhere else to learn where it stood. The badge is that fact, brought back
 * to the card — one numbered chip at the head of the pane's control cluster,
 * carrying the pane's `slot + 1`.
 *
 * **It stands in the CLUSTER, not in a masthead.** Its first home was the
 * masthead frame's leading column, which read well and was wrong about whose
 * fact this is: a masthead is a card's own three lines, only two kinds of card
 * wear one, and every card that titles itself in one line therefore went
 * unbadged. The place a pane stands in is the pane's to report, on the row it
 * reports everything else on. There it leads the stack badge, and the two of
 * them read outward-in — the deck's place, then this pane's own stack.
 *
 * **At rest it takes the row's own ink, and it colours only under the
 * pointer.** Where a card is standing is the resting fact of the deck — true
 * whether or not anybody is reaching for it — and accent marks a live thing,
 * so a lit chip on every masthead spent the accent on nothing. So the chip is
 * a readout in the pane title bar's icon colour until the hand arrives, and a
 * control the moment it does. Accent is left to the two places something is
 * actually live: the hovered chip, and the `filled` slot inside the popup.
 * The paint is in `card-slot-badge.css`, written through the primitive's own
 * knobs ([L20]).
 *
 * **Absent, not dimmed, when there is no slot to name.** A one-up imposition,
 * a pane with no `slot`, a sidebar, and the Lens all render nothing at all.
 * That departs from the register-not-component rule the flow strip follows,
 * and deliberately: that rule governs a fact that always exists and only
 * changes emphasis — how much of the strip the band shows is always true, so
 * the strip is always there and only grows prominent. A one-up pane does not stand in a
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
import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugSlot } from "@/components/tugways/tug-slot";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
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
  // The badge's own box, so the open handler can measure the trigger it is
  // aligning the popup against. The popup portals out of here, so it cannot
  // reach the trigger by walking up from itself.
  const badgeRef = React.useRef<HTMLSpanElement | null>(null);

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
    <span
      ref={badgeRef}
      className="card-slot-badge"
      data-testid="card-slot-badge"
    >
      <TugPopover open={open} onOpenChange={setOpen}>
      {/* The chip is a CONTROL here, not the readout it looks like, and that
          is exactly what the bubble is for: the numeral says where the card
          stands, and nothing on the chip says the number can be changed by
          pressing it. No chord chip — assigning a slot has no binding of its
          own, and naming a neighbouring one would advertise a keystroke that
          does something else.

          The tooltip is OUTSIDE the popover and anchors a span, which is the
          one order this composition takes: `TugTooltip` and
          `TugPopoverTrigger` both hand their child to a Radix `asChild` slot
          and neither forwards what the other injects, so nesting them
          directly leaves the inner one's props on the floor. A span is a DOM
          element both can address — the trigger takes the button inside it,
          the tooltip takes the span, and the inner button's focus reaches the
          span too because React's `onFocus` is `focusin`, which bubbles. */}
      <TugTooltip
        content={`In position ${held + 1} of ${count} — press to move this card`}
      >
        <span className="card-slot-badge-anchor">
          {/* **The badge is a member of the cluster, so it is one of the
              cluster's buttons.** It was the row's one exception: a bare
              `TugSlot` control standing among ghost icon buttons, which meant
              every state the row has had to be re-authored for it — and the
              one that mattered most was authored differently. Its neighbours
              answer the pointer with the row's own hover box; the chip
              answered with `TugSlot`'s outlined-action family, an accent
              rectangle nothing else in the title bar wears. One press-target
              in a row of six looking and behaving unlike the other five is not
              a detail, and it could not be fixed by matching the colours: the
              chip would still have needed its own rule for hover, for pressed,
              for the focused pane and the background one, each kept in step
              with a row that already states all four.

              So the winged chip becomes this button's ICON, and the button is
              the control. Rest, hover, pressed, menu-open, focused pane,
              background pane all arrive from the cluster's own rules with
              nothing restated, and the chip's ink rides `currentColor` — it
              simply IS the row's ink, exactly as the column badge beside it
              already was. The pair reads as one coordinate because they are
              now two icons in one row rather than a chip and an icon.

              Radix's trigger composes its own click onto this button, and
              `onClick` is the same act by the other path — whichever handler
              the composition leaves on the element, pressing it opens the
              popup. */}
          <TugPopoverTrigger>
            <TugButton
              subtype="icon"
              emphasis="ghost"
              role="action"
              size="sm"
              className="card-slot-badge-button"
              icon={
                <span className="card-slot-badge-chip">
                  <TugSlot number={held + 1} state="rest" size="sm" />
                </span>
              }
              aria-label={`In position ${held + 1} — move this card`}
              data-testid="card-slot-badge-trigger"
              onClick={() => setOpen(true)}
            />
          </TugPopoverTrigger>
        </span>
      </TugTooltip>
        <TugPopoverContent
          side="bottom"
          align="start"
          data-testid="card-slot-badge-popup"
          /* Two things happen on open, and both need the popup's own DOM.

             FIRST, the landing. Radix's FocusScope focuses the first focusable
             DESCENDANT, and every descendant here is a slot — a control the
             engine walks but the pointer does not focus. Left to the default,
             the popup opened onto nothing holding the key view, and a Tab
             inside it had no stop to advance from: the chips were reachable in
             principle and unreachable in fact. So the landing is stated — the
             card's OWN place, which is where a reader's next key should start.

             SECOND, the alignment. The popup is a row of every place in the
             arrangement, and the card is standing in ONE of them; opening it
             flush-left put slot 1 under the chip no matter which slot the card
             held, so the chip and the chip meaning the same thing sat apart by
             a distance that varied with the answer. The card's own chip is
             brought under the trigger instead, so the popup opens as that chip
             expanding into its neighbours and the eye has nothing to re-find.

             Written as `translate` on the CONTENT, not as Radix's
             `alignOffset`: Radix positions by writing `transform` on the
             wrapper above this element, so an offset of our own on this
             property composes with its positioning and survives every
             reposition it does, with no round-trip through React state ([L06]).
             The shift is always leftward — slot 1 shifts by the popup's own
             padding and every later slot by more — so a card near the screen's
             right edge moves away from it, never into it. */
          onOpenAutoFocus={(event) => {
            const root = picker.current?.element;
            if (root === null || root === undefined) return;
            const chips = root.querySelectorAll<HTMLElement>('[data-slot="tug-slot"]');
            const landing = chips[held] ?? chips[0];
            if (landing === undefined) return;

            const content = root.closest<HTMLElement>('[data-slot="tug-popover"]');
            const trigger = badgeRef.current?.querySelector<HTMLElement>(
              '[data-testid="card-slot-badge-trigger"]',
            );
            if (content !== null && trigger != null) {
              // Rect differences inside one laid-out subtree, so this is
              // correct whether or not Radix has placed the popup yet.
              const chipLeft =
                landing.getBoundingClientRect().left -
                content.getBoundingClientRect().left;
              const shift =
                trigger.offsetWidth / 2 - (chipLeft + landing.offsetWidth / 2);
              content.style.translate = `${shift}px 0`;
            }

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
            className="tug-slot-layout-popup"
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
