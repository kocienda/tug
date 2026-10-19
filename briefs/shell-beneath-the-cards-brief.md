# The shell beneath the cards

**Purpose:** Finish what `briefs/card-is-one-view-brief.md` started. Its first half has landed: the Session, rail and document kinds draw their pane chrome in their own page, and the host carries a card through a drag or a resize as one view. This brief is the second half, restated on the declared host channel, `CardDeck` and `deck.cards` that `briefs/host-channel-and-body-deck-brief.md` lands in between: every remaining kind, the shell reduced to a stand-in and then put beneath the cards, the overlay above them, settles as whole-card plans, and the hole model deleted.

---

## Purpose {#purpose}

The invariant is the one the user set for the parent brief and it still governs here: a card's chrome and content may never disagree for any frame, and a drag may leave no hole. The parent brief's decisions [B01] to [B11] are inherited whole and are not reopened. The card-is-one-view arc walked seven of nineteen planned steps and was joined to `main` at that boundary by the user's decision, so that its remaining steps could be rewritten on a typed host channel rather than add to a hand-parsed one. The user's words on the split that preceded it:

> This work *MUST* be broken down to be easier and more efficient to implement.

So this brief is a continuation, not a redesign: it carries the arc's plan decisions P07 to P15 and its resolutions forward, names what the host-channel arc changes about them, and keeps every remaining step the size of a sitting.

---

## Evidence {#evidence}

**[F01] What the join carried.** Seven rounds: `pane.chrome` and the eleven `pane.*` verbs; host-tracked drag and resize (`CardGeometry.swift`, `host-card-gesture.ts`, `card-gesture-commit.ts`); `PaneChrome` extracted from `TugPane`; the Session card, the five rail kinds and the four document kinds drawing their chrome in their page under a transitional `CHROME_IN_BODY_KINDS` set; the tab merge band; the generic folded form in the page. Every chrome-reading app-test for those kinds moved to `App.body`, with `card-dom-allow.json` holding the entries for the kinds not yet moved. **(verified, from the arc's rounds and ledger)**

**[F02] What stands between the halves.** The host-channel brief types `placeCards`, `cardGesture`, `onCardGesture`, `cardLand`, the plan messages, the lifecycle messages and `pointerClaim`; deletes `BodyDeckBridge` in favour of a `CardDeck` the body builds from its replicas and verbs; and crosses deck-wide card facts once as `deck.cards`. The parent plan's steps 10, 13, 15 and 16 wrote new host messages by hand; here they are declarations in the vocabulary. **(verified, by reading that brief's [B01] to [B05])**

**[F03] The arc's resolutions that survive.** Recorded in the arc's copy of the parent brief on 2026-10-19 and carried here as settled: each card's `pane.chrome` is the chrome that card shows in front, not one value per pane (Risk R01 by construction); `width: { preset } | null`, `placeArrangement.index` and full `slotStack` rows; a pane-wide close from a page asks its own guard in the page and the shell walks the siblings' guards (`closeGuardWalk`); the chrome's verbs carry no tab verbs, the tab bar reaching its pane through the responder chain; every gesture report carries its resize `edge` and `placeCards` carries the canvas `zoom`; a whole card's view rect rides the placement marked `whole` and `sibling`; the page's insets to its pane are the host's exact ones (`onCardInsets`); a `begin` reads the button state from the host's own record of the window's mouse events, not `NSEvent.pressedMouseButtons`; a card a settle is carrying answers the pointer where it shows and is taken out of its beats at mouse-down; a view that shows nothing passes the pointer; a press on chrome after a resume waits the restore gate out. **(verified, from the arc brief's dated notes)**

**[F04] The remaining shell paint.** `TugPane` still renders title bar, tab bar, grips, accessory and scrim for the kinds not yet moved, and the shell-DOM drag (`applyDragFrame`, `dragGuideEls`, `dragTabBarCache`, `bodyFollowFrame`) still exists for them. The layer order is still splash, floor, bodies, shell. The lid, the even-odd cuts, the host floor, `beatPlan` with its insets and cut keyframes, `near()`, the beat offset and `shell-surface.ts` all stand. **(verified, at the join)**

**[F05] Known reds carried forward.** `at0408` (an arc's auto-bind reaches neither page), the right-click files `at0307`, `at0346`, `at0560`, `at0568`, `at0599`, and the bodies-migration reds `at0527`, `at0600`. Each is red on the base for a recorded cause and none is this brief's to fix before the layer order changes. **(verified, from the arc's commit bodies and the migration brief)**

---

## Decisions {#decisions}

**[B01] The parent's decisions and the arc's resolutions are inherited, not reopened.** [B01] to [B11] of `card-is-one-view-brief.md`, the plan's P01 to P15, and every dated resolution in [F03] stand. A step that finds one wrong says so in its commit body and the brief, as the arc did, rather than quietly routing around it.

**[B02] Every host message this work adds is a declaration in the host vocabulary.** `cardPlan`, `landed`, `beatsCancelled`, the overlay's creation and focus, the layer-order reveal, and anything else a stage needs cross as declared, codec-checked, parity-tested messages. No step adds a `case` to a `switch` or a cast to a dictionary. This is the whole reason the halves were split.

**[B03] A card page reads the deck through `CardDeck` and its siblings through `deck.cards`.** Where the parent plan had a page read `BodyDeckBridge` (the place badge's band and count, slot facts, spaces, the lifecycle events for move and resize), it reads `pane.chrome` and `CardDeck`. Where it mirrored siblings' facts, it reads `deck.cards`. No new per-page mirror is written.

**[B04] The remaining kinds carry their chrome in one step, and the transitional set goes with them.** Every kind not yet moved, the last app-tests to `App.body`, `card-dom-allow.json` emptied, `chromeInBody` and `CHROME_IN_BODY_KINDS` deleted; `CARD_APRON_PX` and the stand-in attribute stay. `chrome-under-bodies` is deleted as a grounding row, since the shell will draw no chrome under a body.

**[B05] The shell's pane becomes a paintless stand-in before the layer order changes.** `TugPane` renders only its `.tug-pane` frame, with its data attributes and inline geometry, painting nothing. The shell-DOM drag, the snap guides in shell DOM and `bodyFollowFrame` are deleted. The min-size is computed from the model, not measured from chrome DOM. The settle engine keeps its clock on the stand-ins (P12); only the host's motion reaches the screen.

**[B06] Continuous shell-owned gestures move cards through the placer's measurement, never a per-frame follow.** Seam drags, flow-strip previews, autoscroll, flow-step tweens, rail-width drags, keep-slot neighbours and window resizes move stand-ins; the placer wakes on flow-strip property writes and posts `placeCards` through the vocabulary (P13). Two cards disagreeing by a frame is accepted; one card tearing cannot happen.

**[B07] The overlay lands before the layer swap, as a body page under the reserved card id `deck-overlay`.** P07 and P08 as written: a `ClickThroughWebView` above every card, hit-test nil outside its own claim, booted from `overlay/overlay-main.ts` with one `root.render()`, its stores declared `scope: { kinds }` for the overlay alone, created through its own declared host message rather than `bodyCreate`. The transient-surface census (the parent plan's List L02) decides each surface: self-hosted or relayed, recorded in `overlay-census.ts`, with the guard test that nothing in the overlay reads a per-frame card geometry and that `overlay.surfaces` withdraws a card's entry at gesture `begin` and at any plan naming it, republishing at rest. The user's rule is restated as law here: the overlay stays transparent, and no surface in it tracks a moving card frame by frame.

**[B08] Indication and escaping surfaces move to the overlay, and `shell-surface.ts` is deleted.** Drop-zone indication, snap guides, the ghost tab and the merge band go through `overlay.indication`, drawn against stationary zones and the pointer. The Z2 placard goes through `overlay.surfaces` with the card's rest rect (P15). The shell draws nothing over a card.

**[B09] The layer order flips in one step with the core tier run once.** Splash, shell web view (opaque, painting its own canvas and grid), `BodyHostView` with card containers answering hits by `CardHitShape`, overlay on top. The shell view's `passesThrough` goes; drag-and-drop forwarding moves to the overlay view; accessibility order is shell, showing cards in deck order, overlay; card containers stay hidden until the window's reveal. The activating click on a card's view is verified. This step runs before every test's first assertion, so it answers the core-tier advisory, once for the arc.

**[B10] The floor, the lids and the cuts go, pinned by a no-hole sampler.** `DeckFloorView`, `floorGrid`, `floorShown`, the lid attribute and pseudo-element, `paneClipPath` and every cut, the shell's `pointerClaim` tracker and `placeBodies` are deleted; `placeCards` is the only placement. A new app-test under 20 s drags a front card across two neighbours into a settle under a capture burst and asserts no sampled frame shows canvas or grid inside any card's pane rect, and a shell-document census (`// card-dom: shell`) asserts no stand-in has a clip, a background or a child. The body-grounding rows whose subject was the hole model (`row-16`, `row-20`, `row-15`) are deleted with that sampler named as what carries them; `floor-host` reads the shell's canvas by composite.

**[B11] Settles become whole-card plans named by id.** `lib/card-plan.ts` is the one producer of `cardPlan`; both settle-engine call sites post through it; `bodyHideUnder` goes because a whole card is always carryable. The host runner is whole-container, keyed on `planId`; a placement names its plan by id and `near()` is deleted (P14). Zone-drop landings become one-card plans with a horizon of the plan's length plus a guard, landing on the shell side if the host never reports ([L33], Risk R03). The beat offset is deleted: with chrome in the card there is nothing to line up with.

**[B12] Live resize is measured, not decided, with the bar already set.** The parent plan's [Q01]: the sash sampler and a grip-resize leg on the largest Session card, read against the sampler's recorded history. Under the bar, live reflow stands; over it, the gesture writes the crossing hold for the card in hand. Both outcomes are decided; the step only reads.

**[B13] The residue is deleted and renamed, and the `rg` is empty.** `body-placement.ts` becomes `card-placement.ts`; `body-beat-plan.ts` goes with its survivors in `card-plan.ts`; the beacon and the tests rename with them; `BodyGeometry.swift` keeps the coordinate flip and the deadlines. The parent plan's deletion ledger (List L03) is the checklist, and the search for the old names returns nothing but removal notes.

**[B14] The carried reds end, and the documents say what the code does.** Each file in [F05] ends green, fixed, changed or deleted, with its reason recorded. `tuglaws/shell-and-bodies.md`, `tuglaws/pane-model.md`, L09 and L25 are updated for chrome in the card and the shell beneath, and a design decision records the layer order.

**[B15] Steps stay the size of a sitting.** The user's call from the split holds: one piece of work and one verdict per step. The order below is the parent plan's steps 8 to 19 with their numbers dropped, so that the door numbers afresh.

---

## Open Questions {#open-questions}

- **Which overlay surfaces self-host and which relay.** List L02 in the parent plan gives a disposition per surface pending a reading of each one's imports; the overlay step records each verdict in `overlay-census.ts`. Settled by reading, at the door.
- **The overlay's cost.** One more WebContent process. The parent plan's trigger stands: launch-to-reveal regressing by more than a second is the line, read in the overlay step.

---

## Non-goals {#non-goals}

- **Reopening the parent's decisions or the arc's resolutions.** [B01].
- **A per-frame follow of any kind.** `bodyFollowFrame` is deleted and nothing replaces it; [B06] and the overlay rule in [B07].
- **A new host message outside the vocabulary.** [B02].
- **A new per-page mirror or a body implementing the deck.** [B03], and the host-channel brief's [B03].
- **Resuming the old arc.** Its documents under `.tug/arcs/card-is-one-view/` are this brief's raw material and are deleted once this arc opens.

---

## Exit {#exit}

An arc from `main`, opened after `host-channel-and-body-deck` has joined. The order the pieces must land in, each one step unless the door cuts it finer:

1. **Every other kind carries its chrome**; the transitional set and allow-list go ([B04]).
2. **The shell's pane is a stand-in only** ([B05]), with the live reading on a rail card, a folded Text card and a two-tab pane.
3. **Whole cards under flow-strip writes** ([B06]).
4. **The overlay page and its host view**, with the gates and alerts ([B07]).
5. **Indication and escaping surfaces in the overlay**; `shell-surface.ts` deleted ([B08]).
6. **The layer order**, core tier once ([B09]).
7. **The floor, the lids and the cuts go**; the no-hole sampler ([B10]).
8. **Settles as whole-card plans** ([B11]).
9. **Landings, the geometry checks and the beat offset**; the live-resize reading ([B11], [B12]).
10. **The hole model's residue** ([B13]).
11. **The carried reds and the documents** ([B14]).

The verdict at each step is the unit suite, `just test-swift` where Swift moved, lint, and the step's own named app-tests read against `tugtool apptest history`, with the live reading recorded in the round's commit body for every body or host step, as `tuglaws/arc-supplement.md` requires.
