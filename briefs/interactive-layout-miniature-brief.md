<!-- brief-skeleton v1 -->

# Interactive Layout Miniature

**Purpose:** The Layout sidebar card draws the deck small, and most clicks on that drawing land dead. Make the picture fully interactive: every part of it answers a press, and the deck can be rearranged by dragging inside it.

---

## Purpose {#purpose}

The user's report: "The Layout sidebar card miniature is so cool—but it would be even cooler if it were *fully interactive*. Right now, some clicks on it land dead. Let's liven them up!"

The miniature draws every column, every split member, every rail card and the flow window, but only the small stack/split marks at the foot of each slot take a press. A hand that reaches for a block, a rail member or the window bracket finds nothing.

---

## Evidence {#evidence}

**[F01] The drawing takes no pointer at all.** `.layouts-plan` in `tugdeck/src/components/layout/layout-card.css` is `pointer-events: none`, and `LayoutMiniature` (`tugdeck/src/components/layout/layout-miniature.tsx`) is `aria-hidden` and purely presentational. The flow window (`.layout-mini-window`) is separately `pointer-events: none`. **(verified)**

**[F02] The only live targets on the picture are the stack/split marks.** `LayoutPlaces` (`tugdeck/src/components/layout/layout-places.tsx`) stands over the drawing and renders one `TugIconButton` per slot. Its `.layout-places-block` spans sit at each slot's exact rect but are inert, and its `.layout-places-rail` spans are empty width-holders. **(verified)**

**[F03] "Go to slot N" already exists as one verb.** `goToSlot` in `layout-card.tsx` centres the slot under flow (`store.setFlowOffset(center)`), raises the slot's card under fit (`raiseCard`), and flashes the slot either way (`flashSlot`). The numbered pills in `FlowStrip` call it through `onGoTo`. **(verified)**

**[F04] The flow scrub's two writes exist.** `previewFlowOffset` draws a position without committing; `setFlowOffset` commits. `FlowStrip` uses them for a scrub that pages slot by slot; nothing offers a continuous drag. **(verified)**

**[F05] Member identity is available but not handed to the drawing.** `DeckColumn.members` (`tugdeck/src/deck-store-selectors.ts`) carries pane ids top to bottom; `railMembersOf` gives each side's `{ componentId, paneId }` in order; `PlaceAllocation.ids` names the members an allocation divides among. The miniature draws members by count and index only. Member spans come from `placeSpanPcts`, private to `layout-miniature.tsx` and not part of `miniatureGeometry`. **(verified)**

**[F06] The store has the rearranging verbs.** `movePaneToSlot`, `assignCardToSlot`, `moveInColumn`, `moveSidebarToRail`, `setRailOrder`, `setSidebarSide` are all on the deck manager (`tugdeck/src/deck-manager.ts`). **(verified)**

**[F07] The miniature already mirrors a canvas drag.** The committed drawing registers the `drag-frame` and `drag-zone` gauges and draws `.layout-mini-ghost` and `.layout-mini-zone` from them as fractions of the canvas. Drop-zone resolution (`tugdeck/src/lib/drop-zones.ts`: `enumerateDropZones`, `pickLiveZone`) works in canvas pixels. **(verified)**

**[F08] Whether the canvas drag machinery can be driven from a synthetic canvas point is not established.** Mapping a pointer in the miniature to a canvas point is simple arithmetic, since the drawing is the canvas at another scale; how much of the canvas drag path (zone picking, commit, gauge publishing) can be reused without a real pane drag was not read. This is inference until the drag controller is read.

**[F09] The source comments state the opposite doctrine.** `layout-miniature.css` ("The drawing is a READOUT"), `layout-card.css` ("The plan takes no pointer") and the `layout-card.tsx` header ("The drawing itself is a readout and takes no pointer") all argue the picture must not answer a hand. **(verified)**

**[F10] Existing coverage.** `at0463-miniature-live`, `at0469-layout-places`, `at0502-layout-card` in `tests/app-test/`, and `tugdeck/src/components/layout/__tests__/layout-miniature-geometry.test.ts`. **(verified)**

---

## Decisions {#decisions}

**[B01] Clicks, the window drag and rearranging by drag ship as one piece of work.** The user's call: "all together". The gesture rules below have to be designed as a set, which they cannot be if rearranging arrives later.

**[B02] Pressing a column block goes to that slot.** It is the same `goToSlot` verb the pills use ([F03]): centre under flow, raise under fit, flash either way. A block outside the flow window is no special case; the window comes to it. An empty slot flashes its vacancy and raises nothing.

**[B03] A second press in succession on a stacked slot cycles its stack.** The first press goes to the slot and highlights the card standing there; the next press cycles to the next card in the stack. "In succession" means the slot's card is still the active one when the press lands, with no timer. This keeps the second click from being dead again.

**[B04] Pressing one member of a split column raises that card.** Each member is its own target, by pane id ([F05]). Split members never cycle.

**[B05] Pressing a rail member activates that sidebar card.** If the rail overflows, the member is scrolled into view (`setRailOffset`).

**[B06] Presses move activation to the target card, away from the Layout card.** The user confirmed this; it is what the pills already do.

**[B07] A drag that starts on a block, split member or rail member moves that card.** You grab the thing under your hand, as on the canvas. A stacked block picks up the front card's pane; a split member picks up that member and can also reorder within its column; a rail member can reorder within its rail or cross to the other side.

**[B08] A drag that starts on the window bracket's frame slides the flow window continuously.** The frame gets a hit band a few pixels wide and lights on hover so it reads as grabbable. It previews per frame and commits once at release ([F04]). It is continuous, unlike the pills' slot-by-slot paging. Only present when the strip overflows the band.

**[B09] A drag lands only where the canvas would allow it.** The miniature reuses the canvas's own drop-zone logic rather than a second set of rules, and its feedback is the ghost and zone it already draws ([F07]). The picture must never offer a landing the canvas would refuse.

**[B10] Hit targets live in the places overlay, not the drawing.** `LayoutMiniature` stays presentational and `aria-hidden`; `LayoutPlaces` already replicates its box and sits over it ([F02]). The member-span arithmetic moves into `miniatureGeometry` so the overlay and the drawing place members from one calculation rather than two.

**[B11] Rest stays neutral; the part under the hand lights.** This is the rule the marks already follow: the drawing at rest is chrome, and hover turns a part into a control, with a pointer cursor. The readout doctrine in the comments ([F09]) is overturned and those comments are rewritten.

**[B12] The numbered pills keep their press and their scrub.** Redundant with [B02], and kept on purpose: the user wants both doors.

**[B13] Keyboard is unchanged.** The picture stays one Tab stop with the cursor over the marks. Going to a slot from the keyboard already has its chords.

---

## Open Questions {#open-questions}

- **Is the bracket's frame a big enough target?** The picture is about 210 px wide, so the hit band in [B08] is small. This can only be judged in the hand. The agreed fallback, if it feels fiddly, is to drop the window drag: a press on any block already brings the window to it and the pills still page.
- **How is the canvas drag path reused from the miniature?** [B09] fixes the rule; [F08] says the mechanism is unread. Reading the canvas drag controller settles whether the miniature feeds it a mapped canvas point or calls zone picking and the store verbs directly.
- **Fit laps.** Under fit, blocks overlap and only each card's leading strip shows. A press resolves to the topmost block by paint order, which matches what is visible; whether a drag should pick up from that same visible strip only is assumed, not tested.

---

## Non-goals {#non-goals}

- **Scrolling from the picture.** No wheel over the miniature and no vertical drag on an overflowing column. The user: "no scrolling now."
- **Removing the pills' press.** Considered because [B02] makes it redundant; rejected to keep maximum flexibility for the user ([B12]).
- **Direction or modifier keys to tell the two drags apart.** Moving a card and sliding the window are both horizontal, so direction cannot disambiguate; where the drag starts decides ([B07], [B08]).
- **New keyboard gestures on the picture.** See [B13].
- **Hover auditions.** A press acts; nothing on the picture previews on hover, for the reason the marks do not.

---

## Exit {#exit}

**An arc.** A shape for the first steps, in an order that keeps each one standing on the last:

- Extend `miniatureGeometry` with member rects for split columns and rails, and carry member identity (pane ids, component ids) down to `LayoutPlaces`.
- Make the overlay's blocks, split members and rail members pressable: go-to, raise, activate, and the stacked-slot cycle ([B02]–[B06]), with the hover language of [B11].
- Add the window frame's hit band and continuous drag ([B08]); judge it in the hand against the first open question.
- Read the canvas drag path, then add drag-to-rearrange for blocks, split members and rail members through the canvas's drop zones ([B07], [B09]).
- Rewrite the readout comments ([F09]) and extend the tests in [F10]; new app-tests carry `@covers`.
