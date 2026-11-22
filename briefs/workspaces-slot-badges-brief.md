# Workspaces card: slot badges on rows, a quiet and steady View popup

**Purpose:** The Workspaces card's rows spend most of their width on a run of slot chips, and the toolbar's `View` popup is too loud and changes width when its option changes.

---

## Purpose {#purpose}

Three notes from using the Workspaces card after the Activity view landed (`1285fc38a`):

- "Let's *tone down* the color for the popup text." This is the face of the `View:` popup in the card's toolbar.
- "Let's remove the listing of every slot in each row. It takes too much space. Let's instead move over to the way we do this in mastheads. Just two icons. Click to send a card to a different slot." The masthead shows a numbered slot glyph and a layers glyph with its stack count, and nothing more.
- "The `View` popup in the Workspaces header must be width-stabilized. Can't change the control width when changing the option."

---

## Evidence {#evidence}

**[F01] Each row draws a chip for every slot in the deck.** `SlotPicker` (`tugdeck/src/components/cards/slot-picker.tsx`) renders a window of `TugSlotLayout` chips (four on a four-slot deck), followed by `CardsSlotBadge` (`tugdeck/src/components/cards/cards-slot-badge.tsx`), the stack readout. Both are mounted at `tugdeck/src/components/cards/cards-card.tsx:456–460` and in `tugdeck/src/components/cards/cards-session-cell.tsx`. In the user's screenshot of the rail, this cluster is what cuts the row titles to `Polish Liven's app UI and carry i…`. **(verified)**

**[F02] On a placed row, the current slot's chip is lit in accent.** `SlotPicker`'s **filled** look marks the card's own slot. Every row whose card stands somewhere therefore carries an accent chip, even though nothing on that row is live. **(verified, from the module's header and the screenshot)**

**[F03] The masthead already has the two-icon form, as reusable parts.** `CardSlotBadge` (`tugdeck/src/components/tugways/card-slot-badge.tsx`) takes a `cardId` and an optional `facts`. At rest it takes the row's ink and turns accent only under the pointer. Pressing it opens the full slot popup with the card's slot filled, and it renders nothing when there is no slot to name. The stack badge on the masthead is `CardPlaceBadge`, a memoised component private to `tugdeck/src/components/chrome/card-title-bar.tsx:737` that opens the member picker. The row's `CardsSlotBadge` draws the same `TugSlotBadge` primitive as a readout. **(verified)**

**[F04] A selected row's move carries its whole selection.** `SlotPicker` moves every selected card when the pressed row is one of several selected in the Cards list, the same group the ⌘-digit chord moves. The masthead badge moves only its own card. **(verified, from `slot-picker.tsx`'s header)**

**[F05] `SlotPicker`'s callers are the two rows, two spikes and four app-tests.** Importers: `cards-card.tsx`, `cards-session-cell.tsx`, `tugdeck/src/spikes/spike-place-coordinate.tsx` and `tugdeck/src/spikes/spike-session-identity.tsx`. The app-tests are `tests/app-test/at0312-cards-two-level.test.ts`, `at0467-cards-slot-badge.test.ts`, `at0470-slot-window.test.ts` and `at0470-slot-window-moves.test.ts`, alongside the Activity view's `at0870-cards-activity-view.test.ts`. **(verified by grep)**

**[F06] The `View` popup's face is louder than its label.** `CardsViewPicker` (`cards-card.tsx:856`) sets the `View:` `TugLabel` to `emphasis="calm"`. The `TugPopupButton` beside it always renders as an outlined `TugButton`, with the face in the button's full ink (`tug-popup-button.tsx:331`). **(verified)**

**[F07] `TugPopupButton` has no way to hold its width.** The button sizes to the current label, so changing between "Workspaces" and "Activity" changes its width. Because the picker carries `margin-inline-end: auto` (`cards-card.css`, `.cards-view-picker`), the toolbar's layout shifts with it. Nothing in `tug-popup-button.tsx` or `.css` reserves a width. **(verified)**

---

## Decisions {#decisions}

**[B01] A row's slot cluster becomes the masthead's two badges: the slot badge, then the stack badge.** The slot badge is `CardSlotBadge`, given the row's `cardId`. Pressing it opens the full slot popup, and picking a slot sends the card there. The stack badge stays where it is, after the slot badge, so the pair reads the deck's place first and then the card's stack, as the masthead does. The cluster's width no longer grows with the deck's slot count, and the titles get the width back ([F01]). The accepted cost is that a move to a different slot takes two presses (open, pick) instead of one. That is the price the masthead already pays.

**[B02] The row badges follow the masthead's quiet-at-rest rule.** At rest they take the row's ink, and they turn accent only under the pointer. Inside the popup, the card's own slot is still the one filled chip. This removes the accent chip that every placed row carries today ([F02]).

**[B03] A row with no slot shows no badge, but keeps the badge's width reserved.** This keeps the masthead's rule that no badge is drawn when there is no slot to name (a one-up deck, or a card with no host pane) ([F03]). A list has a constraint a masthead does not: the trailing column must stay ruled down the rail. So the space is reserved and left empty, never filled with a dimmed badge.

**[B04] A move from a selected row still carries the whole selection.** The row wraps the badge's move with the Cards list's selection, so selecting three rows and picking slot 2 moves all three, as `SlotPicker` and the ⌘-digit chord do now ([F04]). A row outside the selection moves only its own card. The masthead badge's own behaviour is unchanged.

**[B05] The stack badge stays a readout in the row.** Pressing the row already raises the card, so the row is the door. Making the row's stack badge open the member picker, as the masthead's does, is not part of this work.

**[B06] `SlotPicker` is deleted, along with whatever depends only on it.** Its window logic exists only to lay out the chip run. Each dependent named in [F05] is either updated to assert the two-badge row or deleted where all it asserts is the chip window (the two `at0470` files). The spikes are updated or dropped, and `@covers` declarations are kept resolving. `at0467`, which already tests the row's badge, is the natural place for the new assertions.

**[B07] The `View` popup's face is set to the subtle ink.** The button's text uses `--tug7-element-global-text-normal-subtle-rest`, the ink the card already uses for secondary text, so the value sits at the level of its calm `View:` label ([F06]). Only the face changes, not the items in the menu it opens. The chevron goes quiet with it, and hover and open states keep the button's own behaviour. The colour is applied through the button's own knobs from `.cards-view-picker` in `cards-card.css` ([L20]). If `TugButton` exposes no text-colour knob for the outlined style, one is added to the primitive, not overridden from outside.

**[B08] `TugPopupButton` gains an opt-in width-stabilized mode, and the `View` popup turns it on.** In this mode the button sizes to its widest item. Every item's label is rendered into the same grid cell and all but the chosen one are hidden. The browser sizes the box to the longest label, which needs no measuring and no React state ([L06]). Hidden labels are kept out of the accessibility tree and out of Find, so only the visible label is read. The mode belongs in the primitive, not the Cards card, because every value picker with labels of different lengths has this problem ([F07]). It is opt-in so that no existing picker's width moves.

---

## Non-goals {#non-goals}

- **The masthead's badges.** `CardSlotBadge` and `CardPlaceBadge` keep their current behaviour on the masthead. The rows reuse them; they are not redesigned here.
- **A member picker on the row's stack badge.** Left out on purpose ([B05]). If wanted later, it is its own change.
- **Restyling the `View` popup's menu.** Only the face is toned down ([B07]).
- **Keeping a one-press move on the row.** Rejected. A one-press move needs a target for every slot on every row, which is the chip run this brief removes.
- **Measuring labels in script to fix the popup's width.** Rejected in favour of letting CSS size the box from the stacked labels. A measurement would need a layout read and a stored width, and would go stale when the theme or zoom changes.

---

## Exit {#exit}

An arc. Its first moves, roughly in order:

1. In `TugPopupButton`, add the width-stabilized mode, and the text-colour knob if one is missing ([B07], [B08]), with unit coverage in the primitive's own tests.
2. Turn both on for `CardsViewPicker`. The check is that switching `View` leaves the button's width and the toolbar's layout unchanged in every theme.
3. Replace `SlotPicker` in both row renderers with the slot badge and stack badge, including the reserved width and the selection-carrying move ([B01]–[B04]).
4. Delete `SlotPicker` and update or delete its dependents ([B06]). Then run the derived app-test selection for the touched files, together with `at0312`, `at0467` and `at0870`.
