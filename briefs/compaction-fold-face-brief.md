# The compaction run's folded face

**Purpose:** The folded Session card's compaction row does not look like the cover sheet it stands in for, and folding or unfolding a compacting card flashes. The run has two faces and the handoff between them is a sequence of mounts and effects rather than one thing the card knows.

---

## Purpose {#purpose}

The user's report, after the `compaction-occupant-sheet-face` change landed:

> The Compaction Session UI for folded session cards is still wrong. Colors still wrong on the one-line layout. Barber pole needs same coloration/style. Cancel button should have the double ring. The icon|label|bar should be *centered as a group* in the view, with the Cancel button on the right.
>
> There's also *horrid* flashing when switching between fold and unfold, as if the system is struggling to figure out what to do with the Compact UI, instead of *knowing solidly* that this is a UI we need to understand and account for in this transition.

Two screenshots accompanied it. The open card's cover sheet: `Archive` mark and "Compacting" title, a blue barber pole across the full width, and a filled blue Cancel wearing the double ring. The folded card's Z2 row: the same mark and title on the left, a **white** barber pole stretched across the middle, and a **dark, outlined** Cancel with no ring.

The prior brief, `briefs/compaction-fold-door-brief.md`, established that the cover and the row are two faces of one run and that a fold hands the run between them. This brief is about making the two faces actually match and making the handoff solid.

---

## Evidence {#evidence}

**[F01] The row's bar paints in text color because it asks to.** `CompactionOccupant` in `tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx` renders its `TugProgressIndicator` with `role="inherit"`, which `progressRoleFillToken` resolves to `currentColor`. The sheet in `compaction-progress-sheet.tsx` passes no role, so `defaultRoleForState("running")` gives `action`, the theme's key blue. Same component, one prop apart. **(verified)**

**[F02] The row's Cancel is refused the default ring by the one-filled-ring-per-scope rule.** Both faces set `persistentDefaultRing` on a `primary` `action` button. The focus manager's projection stamps `data-default-ring` only when `ringTop !== null && !ctx.keyViewIsButton()` (`focus-manager.ts`), and the filled look and the double ring in `tug-button.css` both key on that attribute or on `data-key-view-kbd`. The sheet earns them by seeding the key view onto its own Cancel with `useSeedKeyView`. The row seeds nothing, and a fold is performed by clicking a button, so the fold control holds the key view when the row appears and the rule declines the row's Cancel. **(verified by reading; the seeded-versus-unseeded difference is the one thing that separates the two faces' button code)**

**[F03] The row's layout cannot center a group because one member flexes.** `.session-telemetry-status-occupant[data-occupant="compaction"]` in `session-card-telemetry-renderers.css` is a flex line with `justify-content: flex-start`, and `.session-telemetry-occupant-bar` is `flex: 1 1 auto`. The bar takes everything between the title and Cancel, which is why the group hugs the left and the bar's length depends on the card's width. **(verified)**

**[F04] On unfold the instruments paint for one frame and the occupant remounts.** `useCompactionDeparture` holds `departing` in `useState` and sets it in a plain `useEffect`. The fold flag flips first, so the first committed render has `occupant === null`: `data-occupant` comes off the row, the five cells return from `display: none`, and the occupant unmounts. The effect then sets `departing`, the occupant mounts again wearing `data-leaving`, and its arrival animation (`both` fill, from opacity 0) is re-armed under the departure. That painted frame of instruments and the re-arrival are the visible stumble. **(verified by reading the render order; not yet recorded frame-by-frame)**

**[F05] The run has no face on screen for most of the crossing, in both directions.** Unfold: the row's `z2-occupant-depart` runs over the first 45% of the imposer settle; the cover waits for `afterFoldCrossing` to fire at the crossing's end and then runs its own `rise` entrance. Fold: `closeSheet()` is called on the first frame and the cover's `settle` exit begins at once; the row's `z2-occupant-arrive` is delayed 55% of the settle. In each direction there is a window in which neither face is visible, and the cover's re-raise each unfold brings a fresh scrim and entrance. **(verified in CSS and in `session-compaction-run.tsx`; the arrival-versus-exit overlap was designed as a handoff on one line, but the two windows do not overlap)**

**[F06] Both faces already read the same clock.** The row's arrival and departure and the cover's `settle` presentation all resolve `--tugx-imposer-settle-duration * --tug-timing`, and both waiters go through `afterFoldCrossing` in `lib/fold-crossing.ts`. The clock is right; only the windows drawn on it are wrong. **(verified)**

**[F07] The row's Cancel registers into the card's own focus context.** `TugButton` reads `CardIdContext` for `defaultRingCardId` and calls `registerDefaultRing` on that context, so the row's Cancel is already on the card's default-ring stack. Nothing is missing on the registration side; only the key-view condition fails. **(verified)**

**[F08] The app-test `at0562-folded-z2-occupant.test.ts` pins the row's current metrics** (the sheet's 15.2px title, "Compacting" without an ellipsis) and will pin whatever this arc settles. **(verified)**

---

## Decisions {#decisions}

**[B01] The row's bar takes the sheet's role, which is the default.** Drop `role="inherit"` from the occupant's indicator so `running` resolves to `action` as it does in the sheet. The row is the sheet on one line; a bar that paints in the row's prose color is the row speaking, and [F01] shows nobody chose that.

**[B02] The row seeds the key view onto its Cancel while it is the run's only face.** The same `useSeedKeyView` the sheet uses, gated the same way the sheet gates it: while the run is cancelable and the row is showing. This is what earns the filled fill and the double ring under the rule in [F02], and it makes the same claim the sheet makes: Return on a compacting card means Cancel. A folded compacting card that is the key card therefore cancels on Return, exactly as the open one does. If that ever proves wrong, the alternative is an appearance-only attribute that draws the ring without the registration, which the button's own comments forbid because a ring that Return does not honor lies.

**[B03] The row is a three-column grid: `1fr auto 1fr`, the mark-title-bar group centered in the middle column, Cancel right-aligned in the third.** This centers the group in the row's full width rather than in the space left of Cancel, which is what "centered as a group in the view, with the Cancel button on the right" asks for. The bar becomes a fixed-width member so the group has a width to center; it keeps the sheet's 8px height.

**[B04] The bar's fixed width is a token on the row, defaulting to 160px.** A group cannot be centered while one member flexes ([F03]). The number is a starting value to be tuned in the built app, and it lives in the Z2 TUNING block in `session-card.css` beside `--tugx-z2-occupant-gap`, so it is one knob rather than a magic number in the rule.

**[B05] The occupant stays mounted for the whole run, and which face is showing is an attribute.** While a run is in flight the compaction occupant is in the row's tree whether the card is folded or not, carrying a data attribute for its state (showing, arriving, leaving, or standing behind the cover). Departure and arrival become attribute changes on one live element rather than an unmount and a remount, so there is never a committed frame with an empty seat and the arrival animation can never re-arm under a departure ([F04]). `useCompactionDeparture`'s `useState`-in-`useEffect` goes away with it. This is the [L06] shape the rest of the row already follows: the row is unconditionally mounted and the cells are hidden, not removed.

**[B06] The two faces overlap in time; the handoff has no gap.** Unfold: the row holds full opacity through the crossing and fades over its closing portion, and the cover rises inside that same closing portion rather than after the end event. Fold: the cover's settle exit runs over the closing portion of the crossing while the row is already arriving, rather than beginning on the first frame. Both faces on screen for a beat is the handoff; neither on screen is the stumble ([F05]). The clock stays the imposer's ([F06]); what changes is the windows.

**[B07] The cover's re-raise on an unfold is a return, not an arrival.** A cover coming back up over a card that has been compacting the whole time should not read as a new dialog. The `settle` presentation's entrance is kept, since it rises from the modal rest line the row stands on, but its timing is tied to the crossing per [B06], and any scrim fade is folded into the same window rather than running on the sheet's own moderate duration.

**[B08] The appearance fixes land before the handoff work and are independent of it.** [B01] through [B04] are each a few lines and can be verified with the row alone. [B05] through [B07] change how the faces are mounted and timed and must be verified by fold and unfold in the built app. Ordering them this way means the row looks right even if the handoff work takes longer.

**[B09] `at0562` is updated to pin what this brief settles, not what it inherited.** The row's bar role, the ring's presence, the grid's centering, and the no-empty-seat invariant on unfold ([B05]) are all pinnable, and the test carries them. A fold-and-unfold app-test that asserts the occupant element identity is preserved across the crossing is the check for [B05].

---

## Open Questions {#open-questions}

- **Whether the overlapped windows in [B06] should be symmetric.** The arrival was delayed so the row would land on the card's edge; the departure was made early so the seat would be empty before the cover rose. With the cover now rising inside the crossing, the right split may differ per direction. This is settled in the built app, not here, and it is a tuning question, not a design one.
- **Whether the scrim belongs on the cover at all while the run is folded and unfolded repeatedly.** The scrim is the sheet's modal dimming; a run's face returning to an open card may want the dimming already in place rather than fading up. Decide when [B07] is being walked and the effect can be seen.

---

## Non-goals {#non-goals}

- **One element that morphs between the sheet and the row.** A FLIP from the row's line to the sheet's panel would be the most solid handoff, and it is the far version of [B05]. It was set aside because it rebuilds how the sheet host draws a cover, and [B05] plus [B06] remove the empty-seat frame and the gap without touching the host. If the overlapped handoff still reads as two objects, this is the next brief.
- **Drawing the ring by appearance alone.** An attribute that paints the fill and the double ring on the row's Cancel without the focus registration would make the button look right and lie about Return. Rejected for the reason `tug-button.tsx` already gives.
- **Changing the sheet.** The cover is the reference the row is being brought to. Nothing about the sheet's layout, colors, or button changes.
- **The arrival occupants.** A question or permission notice on a folded card is on nobody's clock and keeps its own centered mark-title-action group. The grid in [B03] is scoped to the compaction occupant.

---

## Exit {#exit}

**An arc.** The first steps land in the order [B08] gives.

1. Drop the inherit role from the row's bar; seed the key view onto its Cancel; switch the row to the centered grid with a fixed-width bar token. Update `at0562` for each.
2. Keep the compaction occupant mounted for the run's length and drive its faces by attribute; delete the state-in-effect departure. Add the identity-preserved-across-unfold assertion.
3. Retime the row's arrival and departure and the cover's settle entrance and exit onto overlapping windows of the crossing, and tune the split in the built app.
