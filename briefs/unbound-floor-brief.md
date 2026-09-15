# An unbound Session card stands at the transcript's floor, not the picker's

**Purpose:** A new Session card arrives at 600 px in its column when its picker measures 524 px, because the unbound size policy [D195] declared is never read by the code that divides a column. The bid the hidden arrival measures is real, and the floor under it is the transcript's, so the picker carries dead air and the column overflows further than it needs to.

---

## Purpose {#purpose}

Found while reading the arrival log that settled the hidden-arrival work. The reveal wrote a bid of 524 for the newcomer and the settle's Last pass drew it at 600:

> `reveal commit … bid: 524` … `traveled: { paneId: 6d2c99fb…, lastH: 600 }`

[D195] says the unbound Session card "opens at the picker's own height rather than at the transcript's 600px floor," and `pane-model.md` repeats it: the unbound form's `unboundWidthPolicy` is "WIDTH only, because the unbound height is the sheet's own report rather than a declaration." Neither has been true on screen. Every unbound Session card has stood at 600 or taller since [D195] landed, and the 76 px of air under this picker is the visible form of that.

---

## Evidence {#evidence}

**[F01] The column's floor reads the ordinary policy for every member.** `placeMembers` in `tugdeck/src/deck-store-selectors.ts` computes a column member's floor as the largest of `getStackSizePolicy(componentIds).min.height`, the member's sheet reservation, and its opening bid. The call passes no `{ unbound: true }`, so the first term is the Session card's ordinary 600, and a bid or reservation below it changes nothing. **(verified by reading the selector)**

**[F02] Nothing in the live path ever asks for the unbound policy.** `getStackSizePolicy(ids, { unbound: true })` and `getUnboundSizePolicy` exist in `tugdeck/src/card-registry.ts`, and the latter answers `min.height: 0` for a card type declaring `unboundWidthPolicy`, which the Session card does. A grep for `unbound:` across `tugdeck/src` outside tests finds no caller. `DeckCanvas` passes only `{ folded }` to `getStackSizePolicy` when it sizes a `TugPane`, and `placeMembers` passes nothing. The policy [D195] describes was declared and never wired. **(verified)**

**[F03] The newcomer stood at 600 with a 524 bid, and the column overflowed by 123 px.** From the arrival log of a first picker after launch into a slot with one bound Session card, run 1077 px: the sitter went 1077 → 600 and the newcomer arrived at 600; two 600s in a 1077 run put the column in its overflow standing and the strip slid 128 px to show the newcomer. At 524 the overflow would have been 47 px, still a slide, but a smaller one and a picker with no air under it. **(verified, from the `arrival` dev-log rows)**

**[F04] The bid cannot serve as the unbound signal on its own.** `sheetClaimWith` in `tugdeck/src/deck-manager.ts` clears the bid when a sheet report at least as high lands, and after the hidden arrival the first live report is the same number as the bid, so the bid is cleared on the picker's first report after the reveal. A floor that read the unbound policy only while a bid stood would give the card 524 at the reveal and 600 one report later: a grow the user would see as one more motion. **(verified by reading `sheetClaimWith` and the reveal; the grow is inference from those two rules and would be confirmed by the arrival log showing a `setSheetReservation` settle after the reveal)**

**[F05] The deck does not know which of its cards are unbound.** `DeckState` carries no binding fact. Binding lives in `cardSessionBindingStore` (`tugdeck/src/lib/card-session-binding-store.ts`), a separate store keyed by card id, and `placeMembers` is a pure selector over `DeckState`. [D195] retired the binding commit as the place the declared height came down, on the grounds that the sheet's own life should end the bid; it did not give the selector any other way to know the form the card is in. **(verified)**

**[F06] The pane's own resize floor has the same gap.** `TugPane` reads `minSize` from the policy `DeckCanvas` hands it, folded or ordinary, and uses it both to clamp a hand resize and, since the hidden arrival, as the height of the seat an arriving frame is drawn at while hidden. An unbound card's resize floor is therefore 600 as well. **(verified)**

---

## Decisions {#decisions}

**[B01] An unbound Session card's height floor is its picker's own height and nothing else.** That is what [D195] decided and what `pane-model.md` states, and the reason stands: the picker's height depends on what is in it, and a number written anywhere else disagrees with it the moment the content changes. The 600 is the transcript's floor, and there is no transcript. The fix restores the decision rather than making a new one.

**[B02] The unbound form is a fact the deck holds for the life of the picker, not one inferred from the bid.** [F04] rules the bid out: it ends on the picker's first report, and the form does not. Whatever signal `placeMembers` reads must stand from the hidden commit until the card binds, so the floor is the picker's from its first frame to its last and the card never grows back to 600 while the picker is up.

**[B03] The signal reaches `placeMembers` as state, in the same commit that changes it.** `placeMembers` stays a pure selector over `DeckState`, as every other reader of a column's division is. A selector that reached into the binding store would put the division's answer in two stores that notify separately, and a column that re-divides one notify after the card bound is a motion. The form transition, whichever fact carries it, is written in the commit that makes it.

**[B04] `TugPane` reads the same policy the division reads.** [F06]: a pane whose resize floor is 600 while its member floor is 524 is two answers to one question, the shape [D195] was written against. `DeckCanvas` passes the unbound option to `getStackSizePolicy` on the same fact `placeMembers` reads, so the frame's `minSize`, the hidden seat, and the column's floor agree.

**[B05] No app-tests.** Same ruling as the hidden-arrival work: the harness cannot see this class of motion. Pure tests on `placeMembers` with the unbound fact set and cleared, and the arrival log by eye.

---

## Open Questions {#open-questions}

- **Which fact carries the unbound form into `DeckState`.** Two candidates, and the code does not settle between them. One: a session-only record keyed by pane id, shaped like `arriving` and `openingBids`, written at the hidden commit and cleared at the binding commit, which reintroduces the binding commit as a party to the card's form, the thing [D195] deliberately took it out of, though for the bid rather than for the form. Two: derive it from what the deck already holds, a single-card column member whose card type declares `openingForm` and whose sheet reservation is standing, which is bindingless but only correct if the picker is the one sheet a Session card ever reports a natural height for; `reserveSheetHeightForCard` is the thing to read to settle that. Either answers [B02] and [B03]; the door should pick one after reading `reserveSheetHeightForCard`'s callers.

---

## Non-goals {#non-goals}

- **Reading the unbound policy only while a bid stands.** Rejected by [F04]: it trades dead air for a grow.
- **Changing the Session card's ordinary 600 floor.** The transcript and composer need it; the defect is which form the floor is read for, not the number.
- **Removing the column's overflow slide.** With the correct floor this arrival still overflows a 1077 px run by 47 px. The slide now rides the reveal's fused settle and is not a motion of its own; that work is landed and is not reopened here.
- **Fixing `sheetClaimWith`'s supersede rule.** It is correct: a measurement at least as high as the bid should end the bid. The mistake is elsewhere.

---

## Exit {#exit}

An arc. The order that matters: first settle the open question by reading `reserveSheetHeightForCard`'s callers, and write the unbound fact into `DeckState` on whichever answer that gives ([B02], [B03]). Second, read it in `placeMembers` and in `DeckCanvas`'s policy for `TugPane` ([B01], [B04]), with pure tests on the division showing a 524 bid standing at 524 while the fact is set and the member returning to its ordinary floor when it clears. Then look: a first picker after launch into a slot with a bound Session card, and the `arrival` log's Last pass showing the newcomer at the bid, not 600, and no settle after the reveal.
