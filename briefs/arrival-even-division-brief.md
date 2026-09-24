# A newcomer divides with what nobody weighed

**Purpose:** A second card arriving into a split column lands at its own floor while the sitter keeps everything else, because [D195] defined a sitter's claim as what it happens to be drawing at — and an undivided sitter is drawing at the whole run. The claim becomes the hand's division rather than the default one, so an arrival into a column nobody has sashed divides it evenly.

---

## Purpose {#purpose}

The report, in the user's words: *"When I split cards, the top one is getting too much space. It should split them evenly, yes? Why doesn't it work this way?"* — with two screenshots of a 1-up deck holding two Session cards, the top one at roughly five-eighths of the run and the bottom one at a band that does not change when the window does, beside a 2-up deck whose two columns are even.

The behaviour was then explained as the settled call it is ([D195], `briefs/member-height-one-rule-brief.md` [B05], pinned by `tugdeck/src/__tests__/arrival-shares.test.ts` and `tests/app-test/at0571-picker-card-arrival.test.ts`). The user's answer: *"OK, but I don't like the settled call. Redo it."*

So this brief is a re-decision, not a defect report. The rule it reverses is real, it was proven on the app, and the case it was written for still has to come out the way it does today.

---

## Evidence {#evidence}

**[F01] The mode flip is already even; the arrival is not.** `DeckManager.setColumnMode` (`tugdeck/src/deck-manager.ts:3332`) writes the slot's `mode` and `order` and no `shares`, so every weight reads `undefined` and `sharedHeightsOf` divides equally. A card *arriving* into an already-split column goes through `_arrivalShares` (`tugdeck/src/deck-manager.ts:5877`) into `arrivalSharesOf` (`tugdeck/src/lib/layout-imposer.ts:3878`), which is where the division stops being equal. The two gestures the user would call "splitting" therefore disagree with each other. **(verified, read out of the code)**

**[F02] A lone sitter's claim is the whole run, so the surplus is zero.** `arrivalSharesOf` computes the sitters' claims by allocating *their* place alone: `allocatePlaceHeights(sitters, run, gap)`. For a single sitter that function takes its own documented short circuit — *"The undivided member IS the run"* — and answers `[run]`. So `surplus = run - gap - run = -gap`, clamped to 0, and the newcomer is weighted 0. **(verified, read out of `allocatePlaceHeights` and `arrivalSharesOf`)**

**[F03] What the user sees is the floor pass, not a division.** With weight 0 the newcomer would draw at nothing; the allocator's floor pass in `sharedHeightsOf` lifts it to its floor and hands the remainder back to the sitter. A Session card's floor is 600 (`tugdeck/src/components/tugways/cards/session-card-registration.tsx:143`), which is why the bottom card in the screenshot is a fixed band rather than a share, and why it does not grow when the column does. **(verified by reading the ladder in `placeMembers`; the 600 matches the screenshot's lower card by eye, not by measurement)**

**[F04] The lopsided answer is stored, so it outlives the arrival.** `arrivalSharesOf` returns through `placeSharesFromHeights`, and `_arrivalShares` commits the result with `withColumnShares`. From that commit the column *has* been divided — 1250:600, or whatever the run made — and `setColumnMode`'s "re-stacking keeps order and shares" gives the same division back on every later re-split. The user cannot get the even division back except by dragging the seam or by Equalize Heights. **(verified, read out of the code)**

**[F05] The rule exists for the folded sitter, and that case does not depend on the defect.** [D195]'s screenshot was a folded Session card above a fresh one: the folded member carries `floor = ceiling = 144` and weight 0 (`placeMembers`'s folded branch), so what it claims is its tier however tall the column is, and the newcomer taking everything beneath it is correct. That outcome comes from the *ceiling*, which the allocator applies in `sharedHeightsOf` whatever weight the member carries. It does not need the sitter's claim to be read off the run. **(verified against `arrival-shares.test.ts`'s first two cases and the ceiling pass in `sharedHeightsOf`)**

**[F06] The record cannot currently distinguish "weighed 1" from "never weighed."** `railWeightOf` (`tugdeck/src/lib/layout-imposer.ts:543`) answers `undefined` only when the whole `shares` record is absent; a member the record does not name reads as 1. The distinction this brief's decision turns on is therefore not readable today. Every consumer of that value does `member.weight ?? 1` (`sharedHeightsOf`) or ignores it entirely (`placeStandingOf`), and the one other caller is `tugdeck/src/lib/drop-zones.ts:640`. **(verified for `sharedHeightsOf` and `placeStandingOf` by reading them; the drop-zones caller was located but not analysed)**

---

## Decisions {#decisions}

**[B01] A sitter claims what the hand gave it; a member nobody weighed claims nothing.** This is the reversal. [D195] said a sitter claims *what it stands at*, which reads a default as though it were a choice: a card alone in a column is drawing at the whole run because there was nobody to divide with, not because anyone decided it should have the whole run. An arrival is exactly the moment that stops being true. So the claim is narrowed to members the column's `shares` record actually names — a division somebody made, with a sash or with Equalize — and an unweighed member brings no claim to the arrival at all. Revisit this if the deck ever gains a way for a member to assert a size that is neither a hand's weight nor a floor.

**[B02] The unweighed sitters and the newcomer divide the unclaimed run equally.** Having decided an unweighed sitter claims nothing, the question is what it gets instead. It is weighted 1, alongside the newcomer, over the run the weighed sitters did not claim. Two consequences the user asked for follow directly: a column of one sitter plus a newcomer comes out 50/50, and the mode flip and the arrival now agree ([F01]) instead of one being even and the other not. A column of three unweighed sitters taking a fourth card comes out in quarters, which is the same sentence read at a larger count: nobody has divided this column, so an arrival divides it.

**[B03] A weighed sitter is untouched, and that is what keeps [D195] alive.** Everything the current rule does for a division the hand actually made stays: sitters keep the heights they stand at, they keep their ratio to each other, and only a newcomer whose floor the remainder cannot cover makes anybody yield — by the allocator's own floor pass, which hands back the difference and no more. `arrival-shares.test.ts`'s "sashed to 3:1" case must come out unchanged, and it is the regression test for this decision rather than a casualty of it.

**[B04] The folded sitter keeps its tier through its ceiling, not through its claim.** A folded member is typically unweighed, so [B01] stops it claiming its tier as a *claim* — and it must still end up at its tier with the newcomer taking everything beneath. It does: floor and ceiling are both 144 and the allocator's ceiling pass pins it there, handing the surplus to the members that can use it ([F05]). So [D195]'s own screenshot case is preserved by the arithmetic that was already there, and no special case is written for it. The two folded cases in `arrival-shares.test.ts` are the test of this claim, and if either moves, this decision is wrong rather than the tests being stale.

**[B05] `railWeightOf` widens `undefined` to mean "nobody has weighed this member."** The fact [B01] turns on is not readable today ([F06]), and this is the smallest way to make it readable: a member the present record does not name answers `undefined`, exactly as a member of an absent record already does. The function's own doc already glosses `undefined` as "a place nobody has divided yet" — this reads that one member at a time instead of one record at a time. It is behaviour-neutral in the allocator, where the value is consumed as `member.weight ?? 1`.

**[B06] The answer is still stored through the division's inverse.** Unchanged from [D195], and restated because it is load-bearing: `arrivalSharesOf` returns `placeSharesFromHeights` over the heights it computed, so the record reproduces the picture the eye just saw, floors and ceilings already reconciled, and the next re-division agrees with it. The even division is written as an all-ones record rather than left absent, for the reason `equalizeColumn` writes one: an equal division a user arrived at is a division, and it should outlive the next membership change.

**[B07] The reversal is recorded where the old rule is stated, not only in the code.** [D195]'s final clause and `tuglaws/pane-model.md`'s "A newcomer to a split COLUMN arrives weighted rather than unnamed" both state the rule this brief narrows, and `arrival-shares.test.ts`'s third case pins it with a comment citing at0571. An arc that changes the behaviour without amending those leaves three statements of a rule that no longer holds. The test that pins the old behaviour is *re-pointed deliberately, as this brief's own decision*, which is the only way a pinned decision may be moved.

---

## Open Questions {#open-questions}

- **What the run threshold feels like on a short column.** Two Session cards at a 600 floor each need 1205px before an even division is even representable; below that the floors bind and the division is whatever the floor pass makes of it, which is close to today's picture. Whether that reads as "the rule doesn't work on a short window" or as "obviously there isn't room" is a feel question, and it wants the real app at a few window heights rather than arithmetic.
- **Whether `drop-zones.ts`'s use of `railWeightOf` ([F06]) is sensitive to [B05].** It was located but not read. If it treats the value as a number without a fallback, the widening needs a `?? 1` there; if it feeds the allocator, nothing changes. One file to read.

---

## Non-goals {#non-goals}

- **Making every arrival equalize the column.** Rejected outright: it would discard a division the hand made, which is the exact failure [D195] was written against — an unnamed newcomer taking a fraction of the run nobody chose, at the cost of neighbours the user had deliberately sashed. [B03] is the boundary, and this brief narrows [D195] rather than reversing it.
- **Special-casing "one sitter."** The obvious small fix — detect a column of one and divide evenly — was considered and rejected. It fixes the screenshot and leaves the same wrong reading in place for two and three unweighed sitters, and it puts the interesting condition in a guard rather than in the rule. [B01] is the general statement the special case is an instance of.
- **Changing the floor ladder, the opening bid, or the sheet reservation.** All three are [D195]'s other half and none of them is implicated: the newcomer's 600 is a symptom of a weight of 0 ([F03]), not a cause. The floors are correct and stay where they are.
- **Touching a rail's arrival.** A rail's division is the hand's alone and nothing derives a weight there ([D183], restated in `tuglaws/pane-model.md`). This brief is about columns.

---

## Exit {#exit}

**An arc.** The change is small and the order it lands in matters, because the middle step is where it could silently pass:

1. Read `tugdeck/src/lib/drop-zones.ts:640` and settle the second open question, then widen `railWeightOf` ([B05]) with whatever `?? 1` that reading calls for. Nothing should move: the existing suites are the proof that this step is behaviour-neutral.
2. Partition the sitters in `arrivalSharesOf` by whether the record names them, and divide the unclaimed run among the unnamed ones and the newcomer at weight 1 ([B01], [B02]). The four existing cases in `arrival-shares.test.ts` are the guard: the two folded ones ([B04]) and the 3:1 one ([B03]) must not move, and the third — the ordinary-sitter case — is re-pointed to the even division as this brief's own decision ([B07]).
3. Add the case the suite has no analogue for: three unweighed sitters taking a fourth member, coming out in quarters ([B02]).
4. Amend [D195]'s last clause and `tuglaws/pane-model.md`'s newcomer paragraph to state the narrowed rule ([B07]), and check `at0571-picker-card-arrival.test.ts` — it exercises the folded case, so it should be green untouched, and if it is not, [B04] is wrong.
5. Stand it up in the app at a couple of window heights and answer the first open question.
