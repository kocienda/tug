<!-- brief-skeleton v1 -->

# A card's appetite is the rows it draws, and slack goes to the card that can use it

**Purpose:** The rail-vertical arc landed an allocator that fills a rail from what its members declare they want, and the declarations are wrong. Every appetite constant was copied from a CSS value written for a different element, the Layout card declares less than a third of its content, and the allocator's last stage hands the leftover run to every member equally — so the rail the arc was opened to fix still clips Layout off the bottom while Jots holds five hundred pixels of empty list.

---

## Purpose {#purpose}

> "Joined and rebuilt. This took a ton of time, but I'm not sure what it did. It feels like this rail should be showing everything, but it still isn't. Why not? Why is Layout still clipped off the bottom when Jots has all this room?"

The screenshot after the join: a right rail carrying Cards, Jots and Layout, about 2560px of run. Cards shows three sessions and one file, then empty list. Jots shows eleven rows, then more empty list than rows. Layout shows its caption, its drawing, its preset strip and six of its nine control rows, and is cut off partway through the seventh. It is the same picture `briefs/rail-vertical-allocation-brief.md` opened on, with different proportions.

That brief's `[B05]` said "Layout takes its ~400 and stops, and its surplus is redistributed to the members that still want more," and deferred two things: the per-card numbers (its `[Q02]`) as design work wanting the built card in front of it, and the question of where run past everyone's natural should go (its first open question). The user's verdict on the second deferral: *"This seems idiotic that this was deferred. This is basically my ask."* The ask was that a rail make the best use of the space it has as content comes and goes; a card clipped beside an empty one is the ask unmet, whatever the allocator's census says.

---

## Evidence {#evidence}

**[F01] The allocator did what its inputs told it to.** Read out of `sharedHeightsOf` in `tugdeck/src/lib/layout-imposer.ts` against the declared appetites: floors 240 × 3; Layout's comfort takes it to 300; the water-fill caps Cards at its natural (about 240) and Jots at its (69 + 11 × 28 = 377) and Layout at 300; then the last stage splits the remaining ~1600px by weight, a third each. Predicted heights about 780 / 920 / 840; the screenshot reads roughly 825 / 940 / 790 with Layout clipped. The ladder is sound and the census is green. The picture is wrong because the numbers fed in are wrong. **(verified — computed from the constants in the tree and measured off the screenshot)**

**[F02] Layout declares 300px for a card whose content is about 900px.** `LAYOUT_NATURAL_HEIGHT_PX = 300` in `layout-card.tsx:193` is passed as both comfort and natural. Its comment says "the pane's 36px title bar, the drawing … and the preset row under it." The card also renders a two-line caption, and below the preset strip a control row for Cards, Layout and Card Width plus **one row per registered sidebar card** — six today (`sidebarEntries()` at `layout-card.tsx:298`) — at a measured pitch of about 54px per row. Nine rows is about 490px on their own. The declaration omits every row. **(verified — rows counted in `layout-card.tsx:1338–1440`, pitch measured off the screenshot)**

**[F03] Every other appetite is a guess copied from an empty-state CSS rule.** `CARDS_ROW_HEIGHT_PX`, `JOTS_ROW_HEIGHT_PX` and `TRIPWIRES_ROW_HEIGHT_PX` are all 28 and each comment cites the card's `.*-empty { min-block-size: 28px }` — the height of the *empty label*, which "stands in for the list's first row." In Cards, a session row is a three-line block measuring about 110px in the screenshot, a group header about 52px, a file row about 36px; the constant is right for none of them. Cards' natural comes out at about 240px for content that is about 450px, and it is not clipped only because `[F01]`'s surplus stage happened to hand it the difference. Jots' 28px looks right for a one-line jot. Arcs' 48 and Tripwires' 28 are unverified. **(verified for Cards and Layout by measurement; the others are read out of the code and flagged, not measured)**

**[F04] The one test that touches these numbers cannot see that they are wrong.** `tests/app-test/at0542-rail-vertical-allocation.test.ts` reads `LAYOUT_NATURAL_HEIGHT_PX` back from the settled `appetites` and asserts the allocation honours it as a ceiling (`layout ≤ natural + 1`). The plan's test-non-goals said so on purpose: "the app test asserts a bound rather than a constant." A test that trusts the declaration proves the allocator obeys it, and nothing more. No test anywhere asks whether a card at its declared natural actually has no internal scroll, which is what `[B02]` of the rail-vertical brief defined natural to *mean*. **(verified)**

**[F05] The surplus stage spreads by weight, so every card is asked to hold empty space.** `layout-imposer.ts:3469–3474`: once every member is at natural and pool remains, `heights[i] += pool · w_i / Σw`. Weights are 1 by default, so three cards that all fit are each handed a third of the slack, whatever their content. It is what the previous brief's `[B05]` specified, and it is why Jots in the screenshot is 940px tall for 377px of rows. Its inverse `placeSharesFromHeights` has a matching regime B (`layout-imposer.ts:3595–3600`) that reads weights off heights above natural, and `seamDragBounds` has the matching bounds (`:3651`). **(verified)**

**[F06] Greed ranks already say who should take slack, and they are nearly all the same.** `greedRank` per registration: Overview 1, Cards 2, Arcs 2, Tripwires 2, Layout 2, Jots 3, default 9. The rank exists to order the comfort stage and was reused for that by `[B02]`. As a slack order it is too flat to decide between Cards and Layout, and it puts Jots — the list that grows most and clips first — behind a fixed-size Layout. **(verified — read out of the six `*-card-registration.tsx` files)**

**[F07] Comfort and natural are declared from state, and that part is right.** Every card publishes through `useCardAppetite` from a `useEffect` keyed on the two numbers, computed from row counts and constants, with no `ResizeObserver` and no layout read. The settle, the signature term, and the store are all as the previous brief's `[B03]` and `[B10]` asked. Nothing in this brief touches that machinery; it changes only the numbers going into it and one stage of the ladder reading them. **(verified — audited on the arc, re-read on `main` at `8827ba3cc`)**

---

## Decisions {#decisions}

**[B01] An appetite constant names the element it measures, and it is never the empty label's.** Each row-height constant is derived from the row that is actually drawn — its line count, its type size and its block padding — and its comment says which CSS rule those come from. The `.*-empty { min-block-size }` rule is a placeholder for a list with nothing in it and may not be cited as a row's height. This is a rule about provenance rather than a number: the numbers are per card, below.

**[B02] Layout's appetite is computed from its rows, with the sidebar count as the variable.** `comfort` = title bar + caption + drawing + preset strip: the picture is the card's job, and the rows below it may scroll. `natural` = comfort + control row pitch × (3 + `sidebars.length`). The drawing's height is the miniature's `16 / 10` aspect at `--tugx-layouts-plan-mini-width` (300px → 187.5px); the resulting height is written beside the width in `layout-card.css` so the two knobs sit together. `sidebars.length` is already read in the same render (`sidebarEntries()`), so this remains a pure function of state, as `[F07]` requires. The constant retires.

**[B03] Cards' natural is a census by row kind, not a count times one height.** The Cards data source knows whether each row is a group header, a session row or a file row; the appetite sums the rows it will draw at each kind's own height, collapsed groups contributing their header alone as today. Three constants replace one, each named for its row per `[B01]`. Jots keeps one row height, since every jot is one line, but the number is re-derived from the jot row's own rule rather than the empty label's. Arcs and Tripwires are re-measured the same way and their constants corrected in the same pass; the user checks each against the built card, which is what the previous brief's `[Q02]` said and the arc did not do.

**[B04] Run past everyone's natural goes entirely to one member — the one that can use it — never spread.** The last stage of the ladder changes: when every member is at natural and pool remains, the whole remainder goes to the member with the lowest `greedRank`, position as tiebreak. Every other member stands at exactly its natural, so every seam sits on a content boundary and the one stretch of empty space is at the bottom of the card that will grow into it first. A member with an infinite natural (Overview) never lets the ladder reach this stage, so a stream still takes everything above the lists. Spreading is rejected on the argument in `[F05]`: it hands each card space it did not ask for, and when one card's content then grows the settle has to claw that space back across every seam rather than move one.

**[B05] Greed ranks are re-tuned so the slack order is a decision, not a tie.** `[F06]`'s ranks cannot make `[B04]`'s call between Cards and Layout, and they rank Jots below a card whose natural is a constant. Fixed-content cards (Layout) rank last among the shipped six; list cards rank by how fast their content is expected to grow, which puts Jots ahead of Cards and Tripwires, and Overview stays at 1 as the only stream. The comfort stage reads the same ranks and is affected in the same direction: a growing list reaches comfort before a fixed picture does, which is right. The exact numbers are set with the cards on screen, per `[B03]`'s discipline.

**[B06] The inverse and the drag bounds follow the ladder, and the census proves the round trip still holds.** `placeSharesFromHeights` regime B — weights read off heights above natural — is replaced: when the heights match `[B04]`'s greedy default, it returns the empty record; when a hand has dragged a seam past natural, the stored weights divide the past-natural remainder as they do today, overriding the default for that place only. `seamDragBounds` keeps its past-natural range so the drag is still possible. Census invariant (g), allocate ∘ inverse = identity on every reachable height, is the proof that the two functions still agree, and it must stay green through the change rather than be weakened.

**[B07] A real-app check pins each card's declared natural to its actual content.** For each sidebar card, once at its declared natural height on a real rail, its scroll container satisfies `scrollHeight ≤ clientHeight + 1`. That is the definition of natural from the previous brief's `[B02]`, tested as stated, and it is the check `[F04]` shows does not exist. It lives in `at0542` beside the ceiling assertion, which stays: the ceiling proves the allocator obeys the declaration, this proves the declaration is true. It fails the day a row gets taller or Layout gains a control row, which is exactly when the number has gone stale.

**[B08] The check lands first, red.** `[B07]`'s assertion is written against today's constants and fails on Layout and Cards before any number moves. The previous arc's census pattern — the fixture red, then the fix — is what makes a corrected constant a fact rather than a fresh guess.

---

## Open Questions {#open-questions}

- **Whether comfort for a list card should be a row count at all.** Three rows "read as a list" is a feel judgement that has not been tested with the ladder running. If the comfort stage never turns out to bind in practice — runs are tall, floors are 240 — the answer may be that comfort equals floor for every list and only natural matters. Settle by watching a laptop-height rail with all six cards open, which is the one case where comfort decides anything.

---

## Non-goals {#non-goals}

- **Measuring content height from the DOM.** Still the metric loop `[B03]` of the previous brief refused, still refused. Every number here is a pure function of state; `[B07]` measures the DOM in a *test*, once, to check the declaration, which is the one place measuring is right.
- **Changing what the comfort and water-fill stages do.** They are what the user asked for and they work (`[F01]`). This brief corrects their inputs and their tail.
- **Spreading surplus by weight, with corrected naturals.** Considered: with honest numbers, spread is harmless whenever everything fits with room to spare. Rejected on `[B04]`'s argument about growth, and because the user has said the empty-space-everywhere picture is not what they want.
- **A card-level collapse to the title bar.** Still its own feature, still out of scope, as before.
- **Re-serializing anything.** Appetites, offsets and heights stay session-derived.

---

## Exit {#exit}

**An arc.** The shape, in the order it must land:

1. **The natural check, red** (`[B07]`, `[B08]`) — per-card `scrollHeight ≤ clientHeight + 1` at declared natural in `at0542`, failing on Layout and Cards against today's constants.
2. **Appetites from rows** (`[B01]`, `[B02]`, `[B03]`) — Layout computed from its caption, drawing, preset strip and `3 + sidebars.length` control rows; Cards from a census by row kind; Jots, Arcs and Tripwires re-derived from their own row rules. The check goes green. This alone puts Layout on screen in the rail the user is looking at.
3. **Slack to the greediest** (`[B04]`, `[B05]`, `[B06]`) — the ladder's last stage, the inverse's regime B, the re-tuned greed ranks, and census invariant (g) held green throughout. Unit tests on the ladder's stage-by-stage fixtures in `layout-imposer-heights-census.test.ts` gain a case for the greedy tail and one for a dragged override of it.

Step 1 must precede step 2 or the corrected constants are as unproven as the ones they replace. Step 3 is separable from step 2 and lands after it, since its effect is only visible once the naturals are true.
