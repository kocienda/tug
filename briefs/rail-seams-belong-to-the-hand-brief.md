<!-- brief-skeleton v1 -->

# A rail's seams belong to the hand, and its layout is a row

**Purpose:** The rail-appetite-truth arc made a rail's heights a function of its members' content, and the result is a rail that moves under the pointer: collapsing a group in Cards shrank the card and carried the control that was just clicked off its edge. The Fit|Flow choice that arc added is hidden behind an unlabeled glyph the user had rejected before the arc ran. Both are the same mistake — a decision the user should own was given to the machine — and both come back to the hand.

---

## Purpose {#purpose}

> "If I click on the collapse control for Files, I get this: the thing I clicked on just went away!!! Bad. I can't even get it back by clicking where I just clicked. That's a horrid user experience. We need a way better solution."

> "I didn't see this second glyph, and I have no idea what those glyphs mean. They suck and we shouldn't have added them… much less make them the exclusive control to change these algos."

> "If I just mash ⌥⌘N repeatedly and add many new untitled text files, the Cards card scrolls before Jots and Layout, which seems odd, because the Cards card is where the action is happening."

The three screenshots: a right rail of Cards, Jots and Layout in fit. Cards shows five sessions and a FILES group with one file, its header carrying a collapse chevron at the foot of the card. The chevron is pressed. In the next frame Cards is shorter, a SESSIONS header has scrolled into view at its top, the FILES header is gone below its edge, and Jots and Layout have moved up. Nothing the user did asked for a seam to move.

This brief is the successor to `briefs/rail-appetite-truth-brief.md`. That brief's `[B04]`–`[B12]` and the arc `ae425666d` built on it are its subject, and where this brief reverses one of its decisions it says so.

---

## Evidence {#evidence}

**[F01] The collapse moved the control because the allocation follows content, by design.** Collapsing FILES removed one file row from Cards' census, so its declared natural fell (`censusByRowKind` in `cards-data-source.ts:897`, the appetite in `cards-card.tsx`). `_settleAppetites` (`deck-manager.ts:2559`) saw the snapshot change and re-committed the imposition; `allocatePlaceHeights` in fit re-ran the ladder with a smaller natural for Cards and gave the difference to the members below it. Cards' pane shrank from its foot, which is where the FILES header stood. There is no defect in the code path; each step does what its comment says. **(verified — read out of the tree at `268737f0a`, matched to the screenshots)**

**[F02] Every content change is a settle, and content changes constantly.** The appetite store is written from `useCardAppetite` on every render whose numbers differ: a session's row count, a file added by ⌥⌘N, a jot typed, a group collapsed, and now the Layout mixer folded (`[F07]`). Each one re-allocates the rail after `RESIZE_RETUNE_QUIET_MS`. A rail whose seams are a function of its content moves its seams as often as its content moves, and a seam moving is the thing beneath it moving. **(verified)**

**[F03] The squeeze lands on the card that is growing, by construction.** Fit's third stage (`sharedHeightsOf`, `layout-imposer.ts:3550`) is a water-fill: the discretionary pool is divided evenly among members still below natural, each stopping at its natural. Small naturals are satisfied first, so the member with the largest natural — the one whose content is growing — is always the last one short. Mashing ⌥⌘N grows Cards' natural and Cards is the one card guaranteed to scroll. The doctrine in `tuglaws/pane-model.md:133` says squeeze holds members "in reverse greed order", which is true of the comfort stage only; above comfort there is no order at all. **(verified — read; and the ranks would not help, since Jots (2) outranks Cards (3))**

**[F04] The Fit|Flow choice landed as the second glyph on the place mark, which the user had rejected.** `layout-places.tsx:45` — "a split place wears TWO marks, and the second one is its layout." The mark is the exclusive door on the Layout card; the badge menu carries a checked Fit / Flow pair (`tug-pane.tsx:1460–1465`). In the rows region the choice does not appear. The prior brief's `[B09]`(a) specified exactly this; the row version settled in conversation before the arc ran was never written into the brief, so the arc built the older text. The user did not recognise the glyph as a control and does not know what either glyph means. **(verified)**

**[F05] The Layout card's rows region already carries one row per thing, and is the established pattern for a per-thing setting.** Below CARDS / LAYOUT / CARD WIDTH stand JOTS, OVERVIEW, TRIPWIRES, ARCS, CARDS, LAYOUT, each an `Off | Left | Right` choice group (`sidebarEntries()` in `layout-card.tsx`). A per-rail row is that pattern, not an exception to it. **(verified — the screenshot and the code)**

**[F06] Greed ranks after the arc.** Overview 1, Jots 2, Cards 3, Arcs 4, Tripwires 5, Layout 6 (the six `*-card-registration.tsx`). They order the comfort stage and receive fit's slack. Under `[F03]` they do not decide who scrolls. **(verified)**

**[F07] The Layout card's mixer now folds, and the fold is an appetite change.** `82cc40f88` put the control rows behind a `BlockFoldCue`, persisted deck-wide through tugbank (`LAYOUT_MIXER_OPEN_DOMAIN` / `KEY`, an optimistic local write plus `putLayoutMixerOpen` in `settings-api.ts`); `268737f0a` modelled the fold's header on a tool-call block header — an "Options" eyebrow at the leading edge, a hairline running out to a bare-icon fold control at the trailing edge, inset from the card's padding, with the cue's focus stop moved past every row. When folded, `layoutNaturalHeightPx(sidebars.length, mixerOpen)` returns comfort (`layout-card.tsx:295–299`) "so the card hands its rail's run back". Under `[F02]` that hand-back is a seam move triggered by pressing a control inside the card. **(verified — the two commits)**

**[F08] The stored shares already exist, are per place, and survive membership churn.** `RailArrangement.shares` / `ColumnArrangement.shares`, read by `railWeightOf` (`deck-store-selectors.ts:556`), written by a seam drag's commit, never deleted by a member joining or leaving ([L23]). Fit reads them as weights in the water-fill and, when any weight differs from 1, as the division of slack. The machinery for a hand-owned division is in place; what is missing is the rule that nothing else may write it. **(verified)**

**[F09] Flow is unaffected by the collapse complaint.** In flow every member stands at `max(floor, natural · weight)` down a strip (`flowHeightsOf`, `layout-imposer.ts`). Collapsing FILES shortens Cards from below the header, so the header stays where it was and only the members beneath move up. Content growth in flow goes one way, downward, which is the way a reader expects a list to grow. **(verified — read; not exercised in the app)**

---

## Decisions {#decisions}

### The rule

**[B01] In fit, a seam moves only when the hand moves it. Content never moves a seam.** A fitting place divides its run by its stored shares, and the shares change on exactly three occasions: a seam drag, a membership change (`[B03]`), and an explicit re-seed (`[B04]`). A card whose content outgrows its share scrolls inside itself, as a split pane does in every editor. This reverses the prior brief's `[B04]` and `[B06]`, which made fit's heights a function of the naturals: `[F01]` and `[F02]` are what that costs, and no ordering of the ladder repairs it, because any content-following allocation moves seams when content moves. The ladder's floors stay: a share may not take a member below its floor, and floors that do not fit the run still stand the place as a strip (the prior `[B07]`, unchanged).

**[B02] Appetites are consulted at the hand's moments, and only then.** A member's natural is read when the division is seeded (`[B03]`, `[B04]`), its floor bounds a drag, and in flow its natural is its height (`[B06]`). The appetite store, `useCardAppetite`, the settle and `DeckState.appetites` all stay as built; what changes is that a settled appetite change in a fitting place commits nothing — it updates the numbers the next seed or drag will read. The line-box metric-loop reasoning (the earlier brief's `[B03]`) is untouched, since nothing here measures the DOM.

**[B03] A membership change seeds the division from the naturals, once.** When a card joins or leaves a fitting place, its shares are re-derived: every member at its natural, comfort by greed rank if the naturals do not fit, and the slack whole to the greediest member — the prior brief's ladder, run one time and written to `shares`. That is the one moment content may set the seams, because the user just changed what the place holds and has no division yet for the new membership. A stored `shares` record from before the change is replaced, not merged: a division for two members says nothing about three.

**[B04] "Fit to Content" is a verb, and it is the only other thing that re-seeds.** The stack badge menu gains **Fit to Content** beside **Equalize Heights**, and the seam's double-click means Fit to Content rather than equalize; Equalize stays in the menu. Pressing it runs `[B03]`'s seed against the naturals as they stand now. This is the user's original ask — "make the best use of the space it has as content comes and goes" — delivered on request rather than behind their back. In flow the verb clears the stored weights so every member stands at natural, which is what "fit to content" means there.

**[B05] Greed rank is re-tuned so Cards is greediest, and it matters only at seed time.** Cards 1 among the finite cards, Jots 2, Arcs 3, Tripwires 4, Layout 5; Overview stays the sole stream and takes the discretionary pool when present. Cards holds the sessions and files the user is working in, so a seed puts the slack under Cards and it has room to grow before it scrolls. Because the rank now decides a seed rather than a live policy, it is a default with no hand-visible motion of its own.

**[B06] Flow keeps content-driven heights.** In flow the content is the constraint by definition and growth is downward only (`[F09]`); a card at its natural in a scrolling strip is what flow promises. The prior brief's `[B08]` stands. The seam drag in flow stays non-zero-sum, as the arc settled it.

**[B07] The Layout mixer's fold does not move a seam in fit.** `[F07]`'s "hands its rail's run back" becomes true only in flow, where a folded Layout stands at comfort and the strip shortens. In fit the plate stands over empty space below it until the user drags, re-seeds or chooses flow. The declared natural still falls when folded, so a subsequent Fit to Content or membership seed reads the folded card correctly; only the live commit is gone. The fold's own chrome — cue, header, eyebrow, hairline, focus order, tugbank persistence — stays exactly as `82cc40f88` and `268737f0a` left it.

### The door

**[B08] The rail's layout is a row in the mixer, like every other setting.** In the folded rows region, directly under the band's CARDS / LAYOUT / CARD WIDTH rows and above the per-card rows, one row per rail side:

```
LEFT RAIL     Stack | Fit | Flow
RIGHT RAIL    Stack | Fit | Flow
```

Three states in one choice group, because Fit and Flow are the two kinds of split. Storage stays `mode` plus `layout`: Stack writes `mode: "stack"` and leaves `layout` untouched, Fit and Flow write `mode: "split"` and the layout, so a stacked rail remembers which split it was. The row is disabled when the side holds fewer than two cards. A split column gets the same row per slot (`COLUMN 2  Stack | Fit | Flow`). The distinction from the band's LAYOUT row is the caption naming the rail and the plan caption's tail naming which thing scrolls, both of which the arc already built; that is how a per-thing row is told from a deck row everywhere else on the card.

**[B09] The place marks lose the layout glyph.** `layout-places.tsx` returns to one mark per place, the Stack|Split mark it had before the arc, and `PlaceFitGlyph` / `PlaceFlowGlyph` are deleted with their CSS and tests. An unlabeled glyph that its own author could not read is not a door. The badge menu's checked Fit / Flow pair stays, since a menu carries words.

### The check

**[B10] A real-app test pins the collapsed control in place, and it lands first, red.** In `at0542`: open Cards, Jots and Layout on one rail in fit with a FILES group present; record the collapse chevron's bounding rect; press it; wait past the settle; assert the rect is unchanged and the header is still on screen. Against `268737f0a` this fails. A second case does the same for the Layout mixer's fold cue. A third asserts that adding files by ⌥⌘N until Cards' natural exceeds its share moves no seam and leaves Cards with an internal scroll — the honest fit answer — and that Fit to Content then re-seeds so Cards has no internal scroll while Jots and Layout stand below natural.

**[B11] The census keeps its round trip.** `layout-imposer-heights-census.test.ts` asserts, for fit, that heights are the stored shares over the run bounded by floors, and that `placeSharesFromHeights ∘ allocate` is the identity; the seed is tested separately as a pure function of appetites. The flow rows are unchanged.

---

## Open Questions {#open-questions}

- **What a fresh place with no shares and no seed shows.** A deck restored from a blob written before this change has `shares` absent and a membership that has not changed. The recommendation is to treat absence as "seed on first allocation and write the result", which is `[B03]` run once at load; the alternative, equal thirds until something changes, would clip Layout on the rail the user is looking at. Settle at the door.
- **Whether the Layout mixer's fold should count as a hand's gesture on the seam.** It is the user's act, inside the card, and one could argue it is closer to a drag than to a session updating. `[B07]` says no, on the one-rule argument, and because the same gesture then behaves the same in a rail of any shape. Revisit if the folded plate over empty space reads as broken in use.

---

## Non-goals {#non-goals}

- **A recency or activity order for the squeeze.** Considered — the card whose natural most recently rose takes the room — and rejected: it moves seams more often, not less, and `[F01]` is a seam moving.
- **Any live content-following allocation in fit,** including the prior brief's greedy slack rule as a live policy. It survives only inside the seed.
- **Removing the Stack|Split mark from the drawing.** Out of scope; it predates the arc. If the user wants it gone it is a one-line decision on top of `[B09]`.
- **A deck-wide vertical layout row.** Still rejected: the choice is per rail, and its caption is what distinguishes it.
- **Measuring content height from the DOM.** Still the metric loop; `[B10]` measures the DOM in a test, once.
- **Changing the mixer fold's chrome or persistence.** `[F07]`'s work is taken as landed.

---

## Exit {#exit}

**An arc.** The shape, in the order it must land:

1. **The pinned-control check, red** (`[B10]`) — the collapse chevron and the fold cue must not move; fails against today's code.
2. **The rule** (`[B01]`, `[B02]`, `[B07]`) — fit allocates from stored shares bounded by floors; a settled appetite change in a fitting place commits no imposition; the census follows (`[B11]`). The check goes green.
3. **The seed and the verb** (`[B03]`, `[B04]`, `[B05]`) — the one-time seed on membership change and on load-without-shares, Fit to Content in the badge menu and on the seam's double-click, the re-tuned ranks, and the third `[B10]` case.
4. **The row and the mark** (`[B08]`, `[B09]`) — the per-rail and per-column `Stack | Fit | Flow` rows in the mixer, the layout glyph removed from the place marks, `at0469` updated to the rows. The doctrine paragraph in `tuglaws/pane-model.md` that names squeeze and slack becomes "a seam belongs to the hand", with the seed and Fit to Content as the two moments content is read.

Step 1 before step 2 or the rule is unproven. Step 4 is separable and could land first, since it touches no allocation, but the choice it offers is not honest until the rule under it stops moving the seams.
