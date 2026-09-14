# A sheet states the height it needs, and its place holds a floor for it

**Purpose:** A Session card's New Session picker opens squeezed when its card is a member of a split column or rail, because what bounds the sheet is where the card sits rather than what the sheet needs. A modal surface should be able to say how tall it is, and the place's allocator should hold that much room for its host until the sheet goes away.

---

## Purpose {#purpose}

The user's words:

> When we show the New Session sheet in a slot/column that is split, we should size the card initially so that the sheet is fully visible, and only compress it down to its proper split size if the user actually opens or resumes a session. In other words, I never want to clip this sheet.

The report came with a screenshot: a Session card standing as the lower member of a split column, its Choose Session picker with the sessions list scrolling inside a few rows' worth of band and the OPEN button hard against the panel's bottom edge.

Two calls were settled in the conversation that followed, and they bound the rest: the host card takes **only as much room as the sheet needs** rather than the whole run, so the neighbour keeps the remainder; and the behaviour covers **split rails as well as split columns**, since a Session card is squeezed the same way on either.

---

## Evidence {#evidence}

**[F01] What squeezes the picker is the card's POSITION, not its height.** `tug-sheet.tsx`'s top-anchored clamp computes `available = bottomLimit - SHEET_CANVAS_GAP - clipBox.top - marginTop`, where `bottomLimit` is `min(canvas bottom, window.innerHeight)` — the visible canvas, never the pane frame. For the **lower** member of a split place the clip's top sits halfway down the canvas while the card's bottom edge is already near the canvas bottom, so the band left over is about half a canvas and the panel's `max-height` bites. That is the reported picture. **(verified by reading)**

**[F02] The same arithmetic gives the UPPER member the opposite face of the same complaint.** With its clip top near the canvas top and the canvas bottom far below, a top member's picker is not clipped at all — it hangs down past its own frame and over its neighbour, which nothing in the pane stops: `.tug-pane` carries no `overflow`, `transform` or `contain`, and `tug-pane.css` forbids adding any. **(inferred from the clamp arithmetic and the pane CSS; not reproduced on screen — opening a picker on the top member of a split column would confirm it)**

**[F03] Choose Session is the one sheet that keeps the top anchor.** `cards/modal-rest-line.ts` states the rule and its exemptions: every modal surface on a Session card rests on `.session-view-slot`'s bottom edge and grows up, and the picker is exempt because it stands where there is no transcript behind it. A bottom-anchored sheet that needs more than its band already slides its clip DOWN past the frame toward the canvas, so the squeeze reads differently for every other sheet on the card. **(verified by reading)**

**[F04] The picker's natural height is content-bounded and modest.** `session-card.css` gives the embedded list `.session-card-picker-list-view.tug-list-view { height: auto; max-height: 14.5rem; }`, so the panel's natural height is its chrome plus the path field, the label, a list capped at 14.5rem, and the action row. It does not grow when its host grows. **(verified by reading)**

**[F05] The sheet already computes that number, and already knows the measure is stable.** The bottom-anchor effect in `tug-sheet.tsx` measures `needed = content.scrollHeight + borders + margins`, with a comment recording why: `scrollHeight` is the panel's natural height whether or not the cap is currently biting, so the measure does not move under its own write and the loop quiesces on the second pass. **(verified by reading)**

**[F06] Every place's members are built in one function, for rails and columns alike.** `placeMembers` in `tugdeck/src/deck-store-selectors.ts` maps member ids to `PlaceMember` — `floor` from `getStackSizePolicy(componentIds).min.height`, `weight` from the stored shares, and for a folded column member a `ceiling` equal to its floor with a weight of zero. The rail branch and the column branch differ only in how a member is named. **(verified by reading)**

**[F07] The allocator already satisfies floors before it divides anything.** `sharedHeightsOf` in `tugdeck/src/lib/layout-imposer.ts` targets each member at its share of the run, holds any member whose target falls under its floor at the floor, hands the difference back to the rest in proportion to their shares, and repeats until nobody new is held; a ceiling is the same reading the other way, and it is what pins a wall of folded members at their tier. **(verified by reading)**

**[F08] A change in a place's allocated heights arms an ordinary settle.** `arrangementSignature` in `deck-canvas.tsx` carries each slot's mode and its allocated heights as terms of their own, for exactly this reason — a split flip changes every member's height and a seam drag changes two, and neither moves a pane between slots or changes a stored width. **(verified by reading)**

**[F09] The allocator today reads no content measurement, and says so.** `placeMembers`' own docstring: *"There is nothing above the floor to read. A rail divides its run by the hand's own weights ([B03]), and the one algorithm that reads a card's content height runs on request rather than from a settled mirror of a measurement store."* **(verified by reading)**

**[F10] Cancel closes the card, so the picker has only two endings.** `session-card.tsx`'s sheet `onClosed` dispatches CLOSE except on open and on retry, which are treated alike and leave the card mounted so its content can flip to the restoring state. **(verified by reading)**

---

## Decisions {#decisions}

**[B01] A modal surface may declare the height it needs, and the place's allocator honours that as its host member's FLOOR.** Not a weight override, not a second regime beside the division. A card hosting a sheet that needs *H* pixels genuinely cannot paint its contents below *H*, which is what `floor` already means in `PlaceMember` ([F06]) — and because `sharedHeightsOf` satisfies floors before it divides ([F07]), the neighbour keeps everything the claimant does not take. That is the "only as much as the sheet needs" reading expressed in arithmetic that already exists, rather than as a new rule about pickers.

**[B02] A reservation is DECLARED by the sheet, never inferred from one.** Only a surface whose natural height is content-bounded may take one, and it says so at its call site. A sheet whose content is flexible would grow into the room it was just given and ask for more, and the guard against that loop is a declaration rather than a heuristic. The picker qualifies on [F04]; nothing else is enrolled by this brief.

**[B03] A reservation is transient and never touches stored shares.** It lives with the sheet, not in `imposition.columns[slot].shares` or `rails[side].shares`. The division the hand set with the sash is the thing the card must fall back into when the sheet goes, and a claim that wrote itself into the record would have destroyed it to honour it.

**[B04] Split rails and split columns both.** `placeMembers` is the one site ([F06]), so the two are the same change rather than two changes, and a Session card in a split rail is squeezed by the same arithmetic as one in a split column.

**[B05] The claim goes up with the sheet and comes down when the sheet does.** Because Cancel closes the card ([F10]), open, resume and close are the whole of the drop and there is no third ending to design for. A card that closes takes its reservation with it because the member it named stops standing.

**[B06] The growth and the return are ordinary settles, and nothing new animates them.** A reservation changes the place's allocated heights, which is already a term of the arrangement signature ([F08]), so the card grows into the room and settles back out of it through the machinery every other height change uses.

**[B07] A member whose stored share already gives it more than the sheet needs keeps its share.** The reservation is a floor, not a target: a card that was already big enough does not shrink to the sheet's measurements, and nothing moves at all in that case.

**[B08] This narrowly amends the standing position in `placeMembers` that the allocator reads no content measurement ([F09]).** The exception is one sheet's stated height, declared rather than sampled, for as long as that sheet is up. It is recorded here rather than left to a code comment, because the sentence it qualifies is a deliberate one and the next reader should find the qualification where the position is stated.

---

## Open Questions {#open-questions}

- **Both members of a split place reserving at once.** Two fresh Session cards in one split column each raise a picker, and their two reserved floors may not fit the run together. That is the `overflow` standing the place model already defines, so nothing breaks — but whether an overflowing column is the right reading for two pickers, or whether the second reservation should simply not be granted, was not settled. Settled by trying it.
- **Whether the Resume sheet wants a reservation.** It has the same row shape as the picker and would be squeezed by the same run, but it rests on the view slot rather than keeping the top anchor ([F03]), so it can already grow past the frame. Whether it is squeezed in practice was not checked.
- **Whether a reservation means anything on an overflowing place.** Members there stand at their floors on a strip against the slot's own offset, which is a different regime from the shared division [B01] reaches into.
- **[F02]'s face of the complaint: the upper member's sheet growing down over its neighbour.** A reservation gives the host the room it needs, which should remove the need to overflow at all — but whether the overflow should then be suppressed for a reserving sheet, or left standing as the backstop for a run too short to honour the floor, is a judgment about which failure is better and has not been made.

---

## Non-goals {#non-goals}

- **Giving the host the whole run.** The first shape considered: the claimant weighs everything and the neighbours fall to their floors, which is the folded-wall idiom read backwards and needs no measurement at all. Rejected by the user in favour of the neighbour keeping whatever the picker does not need. Its one real advantage — that it never reads a content height, and so never touches [F09]'s position — is the cost [B02] and [B08] accept deliberately.
- **Writing the claim into the stored shares.** [B03]. A transient fact in a durable record is a division the user did not make, standing where the one they did make used to be.
- **A new height algorithm for a reserving place.** [B01] is a floor fed into `sharedHeightsOf`, whose floor pass, proportional give-back and ceiling reading all already exist and are already exercised by the folded wall.
- **Enrolling every sheet.** [B02]. A blanket reservation would couple the deck's layout to the natural height of content nobody bounded.
- **Changing what the sheet's own clamp measures against.** [F01]'s arithmetic is correct for what it does — a sheet is entitled to the visible canvas — and this brief changes the room the host has rather than the rule the sheet reads.

---

## Exit {#exit}

An arc.

The order that matters: the reservation has to be readable by `placeMembers` before anything publishes one, because a sheet that declares a height nothing consumes is a write with no reader and cannot be told from a no-op.

In shape, the first steps: a transient per-member reservation on the deck store — keyed the way `placeMembers` names members, pane id for a column and componentId for a rail — that no serialization path writes; `placeMembers` taking each member's floor as the greater of its stack policy's and its reservation, leaving the folded branch alone ([B07] falls out of this for free, since a share above the floor is already what the division hands back); then a `showSheet` option by which a sheet declares its bounded natural height ([B02]), measured off the panel the way [F05] already measures it, published on open and on the panel's own resize and cleared on close and on unmount; then the picker's call site in `session-card.tsx` declaring it. Whether the Resume sheet follows is an open question above, and the answer is one call site either way.

Worth pinning where it can be seen: that a reserving card grows and then settles back into its stored share rather than into an equal division ([B03]), that a card whose share was already large enough does not move ([B07]), and that the neighbour keeps the remainder rather than dropping to its floor — that last one being the whole of what separates this from the shape recorded under Non-goals. Then look at it: a split column, a fresh card, the picker up, and the card settling as a session opens.
