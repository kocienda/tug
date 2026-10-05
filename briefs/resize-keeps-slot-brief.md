# Resize Keeps the Slot

**Purpose:** Resizing a card by its edge breaks it out of the layout imposition. The user wants an option under which changing a card's width or height keeps it in its slot, the way the masthead width menu and the per-card width chords already do.

---

## Purpose {#purpose}

In the user's words: "When I resize a card, it *breaks out* that card from imposition. I think I want an option where changing the width or height of a card *keeps it* in the layout imposition/slot system, much like we do when we individually set a card to be a different width using the masthead button or Swift View width menus."

Today, picking a width from a menu keeps the card in its slot. Dragging an edge to the same width evicts it. These are two ways of making the same change, and they disagree about the arrangement.

---

## Evidence {#evidence}

**[F01] A slotted card's width is already its own.** `TugPaneState.slot` (`tugdeck/src/layout-tree.ts`) documents that "the pane's width is never touched by the imposer". `imposeRect` / `imposeStyle` (`tugdeck/src/lib/layout-imposer.ts`) compute the slot from `slotWidth` and centre the card's own `PinnedFrame.width` across it. Both clamp with `max(0, …)` so a card wider than its slot pins at the near edge. **(verified, read from code)**

**[F02] The width doors keep the slot by omitting `evictSlot`.** `DeckManager.setCardWidths` (`tugdeck/src/deck-manager.ts`) writes `size.width` and `widthPreset` for the named panes in one `_commitImposition` with `retuneRails: false`. `_setPaneWidth` calls `movePane` with no `evictSlot`. Neither one touches `slot`. **(verified, read from code)**

**[F03] Eviction on resize is the gesture's choice, not the model's.** In `tugdeck/src/components/chrome/tug-pane.tsx`, the resize machine's latch calls `releaseImposedFrame` on a derived pane (`latchResizeMove`), which turns the imposed frame into free pixels. Pointer-up then commits through `onCardMoved(…, released !== null ? { evictSlot: true } : undefined)`. `movePane` deletes `slot` only when `evictSlot` is passed. Nothing else in the deck model requires a resized card to leave its slot. **(verified, read from code)**

**[F04] `movePane` already clears the preset stamp on a raw width change.** When the width changes and no `widthPreset` is passed, the stamp is deleted ("a width nobody named"). A slot-keeping resize therefore gets correct preset bookkeeping for free if it carries a raw pixel width. **(verified, read from code)**

**[F05] A slotted card's height is derived, not owned.** `imposeRect` gives a slotted frame the full `runHeight` unless a `PinnedFrame.height` is supplied. The only current sources of a pinned height are policy (About, locked at 320) and the folded form. Pinned frames take an `anchor` of `"start"`, `"center"`, or `"end"`. No pane field records a height the user chose. **(verified, read from code)**

**[F06] Split columns already have a height model: shares.** `imposition.columns[slot]` carries `mode`, `order`, and `shares` (height weights), written by `withColumnShares` (`lib/layout-imposer.ts`). A member's height in a split column comes from its share of the run. **(verified, read from code)**

**[F07] ⌥ is taken during resize.** `computeAndApplyResize(pointer, snapModifier)` reads `altKey` as the snap modifier, so it is not available to mean "keep the slot". **(verified, read from code)**

**[F08] In flow, a slot's extent is the card's width, and a slot's place is the running sum of the slots before it.** `deckFlowStrip` / `deckSlotStrip` (`tugdeck/src/deck-store-selectors.ts`) read each slot's extent as its widest member's render width, and `flowStripPositions` (`lib/layout-imposer.ts`) sets `stripLeft(k) = Σ_{j<k} (extent(j) + gap)`. So in flow a card fills its slot (the centring term is zero), its own left edge does not move when its width changes, and every slot after it moves by the change. A left edge in flow has nowhere to go: the slots before it do not move, and the viewport offset is clamped at 0 when the strip is shorter than the band. **(verified, read from code)**

**[F09] A `"start"`-anchored pinned height fixes the top edge.** `imposeRect` / `imposeStyle` place a pinned height at the run's top under `anchor: "start"`; the slack is all below the card. The top edge of such a card borders the run's end, exactly as the outer edges of a split column do. **(verified, read from code)**

---

## Decisions {#decisions}

**[B01] This is a setting, and it defaults to "keeps its slot".** It is a captioned row in the Layout card ("Resizing a card: Keeps its slot / Releases it"), stored on the deck's `imposition`. The user settled the default. A setting, rather than a modifier, because ⌥ is already snap ([F07]), and because Layout card settings are rows rather than hidden gestures. "Releases it" keeps today's behaviour for anyone who wants it.

**[B02] Moving a card by its title bar always evicts, whatever the setting.** The setting covers edge resize only. Dragging a card somewhere is the gesture that means "out of the arrangement", and the setting does not change that.

**[B03] A slot-keeping width resize commits like the width menu does.** It writes the new raw pixel width without `evictSlot`, in one commit with `retuneRails: false`, matching `setCardWidths` ([F02]). Because it carries no preset, `widthPreset` clears ([F04]). Resizing the card you are looking at is not a moment the deck may re-solve the rails. That is the reason `setCardWidths` passes `retuneRails: false`, and the same reasoning applies here.

**[B04] The live width drag stays imposed and resizes symmetrically about the slot's centre.** When the setting keeps the slot, the latch does not call `releaseImposedFrame`. The frame's width follows the pointer at twice the pointer's horizontal delta, so the dragged edge stays under the pointer and the opposite edge mirrors it. The imposer centres the card in its slot, so this is where the card will land anyway. Releasing during the drag and re-centring on pointer-up would put a jump at the end of the gesture, which breaks set-up-and-go motion: nothing lands mid-motion or after it.

**[B04a] A slot-keeping resize moves only an edge that has somewhere to go; an edge pinned to the arrangement is inert.** This is the one rule the per-case decisions below follow, and it is what keeps the dragged edge under the pointer in every case that drags at all. An inert edge offers no resize cursor and never latches, so a drag there is nothing rather than a gesture whose edge walks away from the hand. Which edges are pinned is a fact of the arrangement ([F08], [F09]):

- **Width, fit:** both edges have slack (the card is centred in its slot), so both are handles and the resize is symmetric per [B04].
- **Width, flow:** the right edge is the handle, tracking the pointer 1:1; the card's left edge and every slot before it stay, and every slot after it moves by the change. The left edge is inert ([F08]).
- **Height, stacked or single slot:** the bottom edge is the handle; the top edge is inert ([F09], [B06]).
- **Height, split column:** an inner edge moves the seam it borders ([B05]); the two outer edges are inert, because the column fills the run and its shares divide it.

On a flow deck the slots after the card move live with the drag, at the same 1:1 rate, so nothing lands after the gesture ends; the commit is the same one-commit path as [B03].

**[B04b] A height dragged back to the run's end clears the field.** When a stacked card's bottom edge is dragged to (or past) the run's bottom, `slotHeight` is deleted rather than written at the run's height, so a card that was dragged back to full height is a card with no user height, and follows the run again when the window changes. The "Fill height" menu row ([B07]) is the same clear, offered as a row.

**[B05] In a split column, a height drag moves the seam.** Dragging a member's top or bottom edge rewrites that column's `shares` through `withColumnShares` ([F06]). The change is split with the neighbour across that edge. No new height field is introduced for split columns, because shares already are their height model.

**[B06] In a stacked or single-card slot, a height drag writes a new pane field, and the card sits at the top of its run.** A new additive-optional field on `TugPaneState` (e.g. `slotHeight?: number`) feeds `PinnedFrame.height` with `anchor: "start"`. The user settled the anchor. It matches the folded card, which is read from the top as a row in a wall. A centred card would read as one that failed to lay out.

**[B07] A user-set height has a way back to full height.** Without a reset, a card's height would be stuck once set. The reset is offered next to the width choices in the masthead menu ("Fill height"). Double-clicking the bottom edge to reset is optional, but it must not replace the menu row.

**[B08] Width ships first, height after.** Width needs no model change ([F01], [F02]): one branch at the latch and one at the commit, plus the symmetric drag. Height needs a new field, the split-seam mapping, and the reset door. Width is usable on its own, so it is the first landing.

---

## Open Questions {#open-questions}

None. The two that stood here — how a width change behaves in flow, and what a split column's outer edges mean — are settled by [B04a], from [F08] and [F09].

---

## Non-goals {#non-goals}

- **A modifier key that keeps the slot.** Rejected: ⌥ is snap ([F07]), and a modifier-only behaviour has no visible door.
- **Releasing the frame during the drag and snapping it back to the slot on pointer-up.** Rejected under [B04]: it ends the gesture with a jump.
- **Re-solving the sidebar rails on a slot-keeping resize.** Rejected under [B03], for the same reason `setCardWidths` passes `retuneRails: false`.
- **Changing title-bar drag.** Out of scope ([B02]).
- **Resizing sidebar rails.** Their deck-facing edge already commits through `setRailWidth` and never evicts. That path is untouched.
- **Sliding the flow offset so a left-edge drag in flow keeps the edge under the pointer.** Considered: growing the offset by the drag's delta would move the card and every slot before it left while the right edge and every slot after it held. Rejected: the offset is clamped at 0 when the strip is shorter than the band, so the edge would follow the hand on some decks and not others, and it moves the whole deck for a gesture about one card. The inert-edge rule ([B04a]) is one rule with no modes.
- **Giving a split column a height of its own.** Considered as the meaning of a split column's outer edges. Rejected: it would be a third height model next to shares and `slotHeight`, and a split column reads as a wall of rows that fills the run.

---

## Exit {#exit}

An arc. Its first steps, in this order:

1. The setting: a field on `imposition`, a Layout card row, default "keeps its slot", with serialization and validation.
2. Width keeps the slot: in the resize machine, skip `releaseImposedFrame` at the latch and skip `evictSlot` at commit when the setting holds, and commit through the one-commit, no-rail-retune path. Drive the live drag symmetrically about the slot centre in fit, and right-edge-only with the later slots moving live in flow; make the inert edges offer no cursor and no latch ([B04a]). Add app-tests for slot retention, the cleared preset stamp, the inert left edge in flow, and no end-of-gesture jump in either layout.
3. Height in split columns: an inner edge drag maps to `withColumnShares`; the outer edges are inert.
4. Height in stacked slots: the `slotHeight` pane field feeding `PinnedFrame` with `anchor: "start"`, the bottom edge as the only handle, a drag to the run's end clearing the field ([B04b]), plus the "Fill height" reset in the masthead menu.

Step 2 can land and be used before steps 3 and 4.
