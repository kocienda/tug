# Take the departure ghost's clone out and see whether the blank tile was always enough

**Purpose:** A closing card's contents jump the instant it closes, because the copy that fades is a picture of a card that was never on screen. The copy is one day old, nobody asked for it, and the treatment it replaced ran for a month without a complaint — so the first move is to take it out and look, not to build the structural replacement.

---

## Purpose {#purpose}

The user, on the day after the ghost's outer geometry was pinned:

> OK. The outside dimensions are fine now, but the internal content jumps around. This remains unacceptable. How is it that this code to do a snapshot/ghost has been in the codebase for some time, but only now do I see these horrid glitches? This cannot be allowed to stand. We *must* get to the bottom of what is happening here.

*What is jumping* is the clone's interior, and it is measured below. *Why only now* is the sharper question: nothing about the ghost is a month old except the ghost. The copy it carries is one day old, and until yesterday the copy was drawn 1136px off the card, where a reader could not see that its contents were also wrong.

The first draft of this brief answered that by proposing the structural replacement — a `departing` mark keeping the real frame mounted. The user stopped it on a plainer reading of the same evidence:

> So, wait a minute here. You're telling me that the ghost we used to have showed *an empty pane*, and that I never noticed? Seriously? If that's true, why don't we try that first. The *what excludes a departing pane from the placement solver* question seems like a complicated thing to resolve, and if it turns out that we don't need to actually solve that, since an empty ghost looks OK, then fine.

That is the right order and this brief is rewritten to it. The expensive question is only worth answering if the cheap answer fails, and the cheap answer is a revert of something one day old that nobody requested.

---

## Evidence {#evidence}

The measurements come from `tests/app-test/at0584-departure-face-fidelity.test.ts`, written for this audit and left in the working tree, uncommitted and red. It walks the live frame's whole subtree immediately before the close, walks the face's subtree on the first animation frame the ghost stands on, and compares them node for node by structural path. Both readings and the diff happen in the page; only the summary crosses the wire.

**[F01] The ghost is a month old and blank; everything that glitches is one day old.** — `520f094eb` (2026-08-19) introduced `.tug-pane-exit-ghost` as a **blank tile**: a `position: fixed` div carrying nothing but a class, a rect, and the pane's ground, border and radius from CSS. Its whole implementation is eleven lines and there is no content in it. `ebcb64175` (2026-09-15) added the **face** — a `cloneNode(true)` of the whole `.tug-pane` planted inside the ghost. `git log -S` on the two class names gives disjoint histories that meet only at yesterday's arc. Every defect in this brief dates from the second commit. **(verified)**

**[F02] Nobody asked for the face. It arrived as a side effect of an arc about something else.** — `ebcb64175` is *"Measure a card's opening form before the commit that appends its pane"* — an arc about a Session card's opening height, its picker's measured bid, and a fused `room` beat. The face appears in one subordinate clause of its message: the picker "departs inside the card rather than vanishing a beat ahead of it, **so the exit ghost carries the pane's own face instead of a blank tile**." There is no request behind it, no brief, and no decision record. It was a nice-to-have that came along with a measurement change, and it has cost two user-visible defects in two days. **(verified — read from the commit's own message)**

**[F03] The previous defect was hiding this one.** — Until `963206078` (2026-09-16) the clone kept the live frame's inline `position: absolute` and the imposer's `left`, so the face was laid out inside the ghost at the pane's own canvas coordinates — measured at **1136px** off on a slot-2 pane. A copy standing a full card's width from the card consumes all of a reader's attention; the interior of that copy is not something anyone was in a position to judge. Fixing the placement is what made the interior visible, and that is the whole of "why only now". **(verified — the 1136px figure is `at0582`'s reading against the unfixed tree, recorded in `aee67b392`)**

**[F04] A clone's scrollers are all at the top, and that displaces most of the card.** — `cloneNode` does not copy `scrollTop`/`scrollLeft`; they are element state, not DOM. On a `fixture-markdown-50kb` card scrolled to 1200px the census reads:

> `tugx-md-scroll-container gallery-md-view — live scrollTop 1200 / scrollLeft 0  face 0 / 0  (scrollHeight live 28228, face 28228)`
>
> `interior nodes that moved: 598 of 728, worst 1200.0px`

Every one of the 598 is displaced by exactly the scroll offset — `tugx-md-block-container` live at `1,-1095`, face at `1,105`. **82% of the card's nodes are in the wrong place, and the reader watches the document snap to its top for the length of the fade.** The scroll offset is also the one quantity guaranteed non-zero on the card the user watches most: a transcript is pinned to its bottom. **(verified by measurement)**

**[F05] The identity strip reverts real box metrics, and the docstring saying otherwise is wrong.** — `takeDepartureFace` strips `data-slot` so no live selector resolves inside the still. `departure-face.ts` records the price as "the `data-slot` handful tune details a 240ms fade does not show". There are **67** CSS rules keyed on `[data-slot]` and they are not all colour. On a Session card:

> `layout-bearing style changes: 2 node(s):`
> `tug-button … tug-pu — padding 0px 0px to 0px 16px`
> `tug-list-row — padding 8px 21.200001px to 8px 17.200001px`
>
> `interior nodes that moved: 47 of 134, worst 22.0px`

The mechanism is `.tug-file-chooser [data-slot="tug-file-chooser-browse"]`, which sets `width: 1.75rem; height: 1.75rem; padding: 0`. Without the attribute the button falls back to `.tug-button`'s defaults and goes from **28px wide to 50px**, shoving the adjacent input from x=119 to x=139 and shrinking it 570→550. `arcs-card.css` is the second, and its own comment says outright that "the `[data-slot]` is carried for the specificity, not for the match" — which makes stripping it a padding change by construction. **(verified by measurement and by reading both rules)**

**[F06] The contract's reopening condition has fired, on its own terms.** — `tuglaws/animation-doctrine.md#ghost-contract`, written yesterday, says: "**What reopens the question is a third leak of this class** — a property or an attribute the clone carried that the ghost did not expect, found in the running app rather than by the censuses. Two have been found and closed; a third would say enumeration is not converging." [F04] and [F05] are the third and fourth, found in the running app, one day later. **(verified)**

**[F07] The list of things a clone cannot carry has no end, and three more are already in the tree.** — Beyond scroll: `<canvas>` bitmaps do not survive `cloneNode`, and `tug-sparkline.tsx` and `pdf-view.tsx` each render one, so a departing card's sparkline goes blank. `input.value` is a property rather than an attribute, so a composer with typed text clones empty. CSS animations restart from zero in a clone. None were exercised by the two cards measured — the census reads `form values lost: none` and `running animations: live 0, face 0` — so these are **read from the platform's semantics and from the tree, not observed**, and each needs a card that has one to reproduce. The point is not any single one: the clone's divergence from the card is everything about the card that is not DOM, and that set is not enumerable in advance. **(inference from the platform and from reading; not measured)**

**[F08] Two plausible causes were ruled out.** — The face is re-parented from the frame's chain to the canvas container, which would matter if anything between them contributed style. It does not: the census prints the live frame's ancestors as `div.tug-space-layer < div < div < div < body` against the face's `div.tug-pane-exit-ghost < div < div < div < body`, and `space-layer.css` gives `.tug-space-layer` `display: contents` when shown, so the two share an effective layout parent. Structural divergence was also ruled out — the walks match exactly, 728/728 and 134/134 nodes. Recorded so the next reader does not spend an afternoon on them. **(verified by measurement)**

**[F09] The blank tile will be more exposed than it was during the month nobody noticed, and this is the one reason to check rather than assume.** — At `520f094eb` the ghost's fade was launched in the Last pass as a standalone effect (`void fading.finished.then(() => ghost.remove())`), running *concurrently* with the survivors' shrink/move/grow. A blank tile fading while three neighbours are travelling is a tile nobody looks at. Since `ebcb64175`, `depart` is the **first** entry in `BEAT_ORDER` (`["depart","room","shrink","move","grow","arrive"]`) and runs **alone**, ahead of `room` — by design, so "the room a closing pane gives up is given up before anything moves into it". For its whole window the tile is the only thing on screen in motion. Its window is the `divide-join` recipe's `timeScale: 0.6` of the crossing's nominal. So the month of silence was under materially quieter staging, and it is evidence rather than proof. **(verified by reading `pane-flip.ts`, `imposer-motion.ts`, and the diff at `520f094eb`)**

**[F10] `PANE_EXIT_GHOST_MS` does not exist and has not for some time.** — Removed by `67db70119`; the fade's window comes from the `divide-join` recipe now. The constant survives only in prose — `tuglaws/animation-doctrine.md` line 122 and `briefs/departure-ghost-brief.md` both still name it. A small staleness, recorded because the law paragraph is being rewritten anyway. **(verified)**

**[F11] The deck already owns the symmetric half, if the fallback is ever needed.** — `DeckState.arriving` is a store mark with an `arrivingWith` reducer twin (`deck-manager.ts`), resolved by `DeckCanvas` and projected by `TugPane` onto the frame as `data-arriving` plus `visibility: hidden`. Its lifetime problem — a beat not guaranteed to run — is already solved by an unconditional drain (`drainArrivalsRef`, "the whole of [R01]'s answer"). A `departing` mark would be that machinery pointed the other way. **(verified by reading)**

---

## Decisions {#decisions}

**[B01] Delete the face and restore the blank tile. This is the first-choice path and the whole of the first attempt.** The face is one day old ([F01]), nobody asked for it ([F02]), and it has produced two user-visible defects plus an open-ended class of further ones ([F04], [F05], [F07]). The treatment it displaced ran for a month without a complaint. Reverting it is a deletion rather than a design: `departure-face.ts`, both strip lists, `departureFacesRef`, the face-planting in the Last pass and the `.tug-pane-exit-face` rules all go, and what is left is the eleven lines that were there before. It cannot glitch, because a tile with no contents has no contents to be wrong.

**[B02] The acceptance test is the user's eye on a running build, and the arc stops there.** Whether a card fading as a coloured rectangle is good enough is a question about what a person sees, and no census can answer it — `at0584` will go green on a blank tile trivially, by having nothing to compare. So the arc's job is to land the revert, bring up a debug build, and stop for the look. It does not decide that the tile is acceptable and it does not proceed to anything else on its own judgement. [F09] is why this is a real check rather than a formality: the tile now gets a solo beat at the head of the chain, which is not the staging it was judged under.

**[B03] The `departing` mark is the fallback, and it is not built until the blank tile is rejected.** If the tile does not read well, the structural answer is a mark on the real component — the frame stays mounted, inert, and excluded from the imposer's arithmetic through the fade, symmetric with `arriving` ([F11]). That remains the right end state and is the only option that makes [F04], [F05] and all of [F07] impossible rather than individually fixed. It is deferred rather than rejected because its one hard part — excluding a departing pane from the placement solver — is a substantial piece of work, and paying for it before knowing it is needed is the wrong order.

**[B04] The snapshot approach is held in reserve in history, not in the tree.** If the blank tile is rejected *and* the `departing` mark proves harder than [F11] suggests, the clone comes back as a considered choice with its costs known — and the two defects this brief measured would then have to be fixed rather than tolerated, scroll offsets copied onto the clone after cloning and a non-stripping answer found for `[data-slot]`. Recording the route does not endorse it: it is third of three, and `963206078` is where the code is if it is ever wanted.

**[B05] The three rules survive whichever mechanism wins.** The ghost's contract in `tuglaws/animation-doctrine.md#ghost-contract` and the `pane-model.md` paragraph are written in terms of a face and two strip lists that are about to stop existing, but the rules underneath do not change: the departure stands where the card stood, it answers nothing while it fades, and one record owns its lifetime with every exit taking it away. The laws are rewritten to state them against whatever carries the departure, and the clone is recorded as tried, measured and retired — with [F02]'s provenance, so nobody re-adds it as an obvious improvement.

**[B06] `at0584` is kept, and what it gates is restated rather than deleted.** Against a blank tile its interior comparison is vacuous, so it is re-pointed at what still has a claim — that a departure stands where the card stood and that nothing live answers inside it — or explicitly retired with its measurements quoted in the law, so the evidence outlives the file. Its two current failures are the record of [F04] and [F05] and are worth preserving in one of those two places. `at0582` and `at0583` get the same disposition: re-pointed or retired with a reason, never left aimed at a mechanism that no longer exists.

**[B07] The fade's timing and curve do not change.** `depart` stays the chain's first beat at the `divide-join` window. If [F09]'s solo staging turns out to be what makes the blank tile unacceptable, that is a finding for the next round rather than a knob to turn pre-emptively — changing two things at once would make the check unreadable.

---

## Open Questions {#open-questions}

- **Does a blank tile read acceptably now that `depart` is a solo first beat?** This is the question the whole brief now turns on, it is the user's to answer, and it needs a running build rather than prose ([B02], [F09]). The month of silence at `520f094eb` is real evidence but was collected under concurrent staging, so it does not settle the current arrangement.

- **If the fallback is taken: what excludes a departing pane from the placement solver, and where?** The candidates are a filter at `placeMembers`/`layout-imposer`, a filter where `DeckCanvas` derives the arrangement, or keeping the pane out of the store's member list while a separate mark holds the frame. They differ in what else reads the same list — the resize floors, the seam allocation, the arrangement signature that arms the settle — and the wrong choice gives either a survivor that moves late or a settle that never arms. **Deliberately not investigated**, because [B03] makes it conditional: answering it now would be work done in case it is needed.

---

## Non-goals {#non-goals}

- **Patching the clone a third time, now.** Copying scroll offsets onto the clone and finding a non-stripping answer for `[data-slot]` would fix [F04] and [F05] and nothing else. Rejected as the *first* move on [F06]: the contract's own reopening condition has fired, and each pass over this enumeration has cost more than the next defect it failed to prevent. It survives only as [B04]'s third option, behind two others.

- **Building the `departing` mark in this pass.** It is the right end state and it is still on the table ([B03]) — but building it before the cheap revert has been looked at is exactly the ordering the user rejected, and it front-loads the one genuinely hard question in the whole area.

- **A rasterised still.** The clone-versus-raster question from the previous brief is closed rather than answered. A raster fixes the identity half and photographs a scroller faithfully, but it costs a paint on every close and it is still a snapshot — the thing the user asked to stop doing. Neither [B01] nor [B03] needs it.

- **Reopening the ghost's outer geometry or its lifetime record.** `963206078` pinned both and `at0582`/`at0450` hold them. Those rules are inherited by [B05], not re-litigated. The blank tile keeps the ghost's rect, its `departureGhostsRef` owner and all four exits exactly as they are — [B01] deletes the face, not the ghost.

- **The pre-existing reds around this work.** `at0571` has been red since `ebcb64175` and `at0294` for 27 recorded runs on the imposer's FLIP arithmetic. Neither is this work's and neither blocks it. `at0571` asserts "a ghost wearing a face" and will need re-pointing under [B06].

---

## Exit {#exit}

**An arc**, and a short one — the first attempt is a deletion.

1. Take the face out: `departure-face.ts`, `FACE_IDENTITY_ATTRS`, `FACE_GEOMETRY_PROPS`, `takeDepartureFace`, `departureFacesRef`, the `cardWillBeginDestruction` subscriber that fills it, the face-planting in the Last pass, and the `.tug-pane-exit-face` and `:has(> .tug-pane-exit-face)` rules in `tug-pane.css`. The ghost, its rect, `departureGhostsRef` and all four lifetime exits stay ([B01]).
2. Settle the test dispositions in the same step, since they are what turns red on the deletion — `at0571`'s "ghost wearing a face" assertion, `at0583`'s selector census, and `at0584`'s interior comparison ([B06]).
3. Build and stop for the look ([B02]). This is the whole point of the arc, and it is the one thing it must not skip or decide for itself.

What happens next depends on that look, and the brief records both roads so neither has to be re-argued: the tile is fine and the laws get rewritten to say so with the clone recorded as retired ([B05]), or the tile is not fine and `departing` opens as its own arc with the placement-solver question as its first step ([B03]).

`at0584` is already in the working tree and already red on exactly the two defects the deletion removes, so it can be run before anything changes — the same discipline the previous arc used, and the reason its step 1 is known to have gated what it gated.
