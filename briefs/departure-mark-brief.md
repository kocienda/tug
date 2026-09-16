# Retire the departure ghost's clone for a `departing` mark on the real component

**Purpose:** A closing card's contents jump the instant it closes — the copy that fades is not a picture of the card, it is a picture of a card that was never on screen. The clone cannot be made into one by enumeration, and the deck already has the symmetric machinery to fade the real frame instead.

---

## Purpose {#purpose}

The user, on the day after the ghost's outer geometry was pinned:

> OK. The outside dimensions are fine now, but the internal content jumps around. This remains unacceptable. How is it that this code to do a snapshot/ghost has been in the codebase for some time, but only now do I see these horrid glitches? This cannot be allowed to stand. We *must* get to the bottom of what is happening here.

Two questions, and they have different answers. *What is jumping* is the clone's interior, and it is measured below. *Why only now* is the sharper one, and the answer is that nothing about the ghost is a month old except the ghost: the copy it carries is one day old, and until yesterday the copy was drawn 1136px off the card, where a reader could not see that its contents were also wrong.

This brief settles what the departure treatment should be, rather than adding a third entry to the list of things the clone is stripped of. The user's instinct, recorded in [departure-ghost-brief.md](departure-ghost-brief.md) and unchanged since, is the shape the evidence now independently arrives at:

> Making snapshots is *almost always an undesirable wart*. We should really operate on the actual components as much as possible.

---

## Evidence {#evidence}

All measurements below come from `tests/app-test/at0584-departure-face-fidelity.test.ts`, written for this audit and left in the working tree, uncommitted. It walks the live frame's whole subtree immediately before the close, walks the face's subtree on the first animation frame the ghost stands on, and compares them node for node by structural path. Both readings and the diff happen in the page; only the summary crosses the wire.

**[F01] The ghost is a month old and has never glitched; everything that glitches is one day old.** — `520f094eb` (2026-08-19) introduced `.tug-pane-exit-ghost` as a **blank tile**: the pane's ground, border and radius at the departing frame's last rect, faded and removed. A blank tile has no interior, so no interior can be wrong. `ebcb64175` (2026-09-15) added the **face** — a `cloneNode(true)` of the whole `.tug-pane`, planted inside the ghost. Every defect in this brief dates from that commit, not from the ghost's. `git log -S` on `tug-pane-exit-ghost` and on `tug-pane-exit-face` gives disjoint histories that meet only at yesterday's arc. **(verified)**

**[F02] The previous defect was hiding this one.** — Until `963206078` (2026-09-16) the clone kept the live frame's inline `position: absolute` and the imposer's `left`, so the face was laid out inside the ghost at the pane's own canvas coordinates — measured at **1136px** from the departing frame's rect on a slot-2 pane. A copy standing a full card's width away from the card is a defect that consumes all of the reader's attention; the interior of that copy is not something anyone was in a position to judge. Fixing the placement is what made the interior visible, which is the whole of "why only now". **(verified — the 1136px figure is `at0582`'s own reading against the unfixed tree, recorded in `aee67b392`)**

**[F03] A clone's scrollers are all at the top, and that displaces most of the card.** — `cloneNode` does not copy `scrollTop`/`scrollLeft`; they are element state, not DOM. On a `fixture-markdown-50kb` card scrolled to 1200px, the census reads:

> `tugx-md-scroll-container gallery-md-view — live scrollTop 1200 / scrollLeft 0  face 0 / 0  (scrollHeight live 28228, face 28228)`
>
> `interior nodes that moved: 598 of 728, worst 1200.0px`

Every one of the 598 is displaced by exactly the scroll offset — `tugx-md-block-container` live at `1,-1095`, face at `1,105`. This is not a rounding error or a layout subtlety: **82% of the card's nodes are in the wrong place, and the reader sees the document snap to its top for the length of the fade.** The scroll offset is also the one quantity guaranteed to be non-zero on the card the user watches most: a transcript is pinned to its bottom. **(verified by measurement)**

**[F04] The identity strip reverts real box metrics, and the docstring saying otherwise is wrong.** — `takeDepartureFace` strips `data-slot` so no live selector resolves inside the still. `departure-face.ts` records the price as "the `data-slot` handful tune details a 240ms fade does not show". There are **67** CSS rules keyed on `[data-slot]`, and they are not all colour. On a Session card the census reads:

> `layout-bearing style changes: 2 node(s):`
> `tug-button … tug-pu — padding 0px 0px to 0px 16px`
> `tug-list-row — padding 8px 21.200001px to 8px 17.200001px`
>
> `interior nodes that moved: 47 of 134, worst 22.0px`

The mechanism is `.tug-file-chooser [data-slot="tug-file-chooser-browse"]`, which sets `width: 1.75rem; height: 1.75rem; padding: 0`. Without the attribute the button falls back to `.tug-button`'s defaults and goes from **28px wide to 50px**, shoving the adjacent `.tug-file-chooser-input` from x=119 to x=139 and shrinking it 570→550. `arcs-card.css` is the second: its comment says outright that "the `[data-slot]` is carried for the specificity, not for the match", which makes stripping it a padding change by construction. **(verified by measurement and by reading both rules)**

**[F05] The two defects are the same defect twice, and the contract said so in advance.** — `tuglaws/animation-doctrine.md#ghost-contract`, written yesterday, records the reopening condition: "**What reopens the question is a third leak of this class** — a property or an attribute the clone carried that the ghost did not expect, found in the running app rather than by the censuses. Two have been found and closed; a third would say enumeration is not converging." [F03] and [F04] are the third and fourth, found in the running app, one day later. The condition the laws set for reopening has been met on the laws' own terms. **(verified)**

**[F06] The list of things a clone cannot carry is open-ended, and three more are already in the tree.** — Beyond scroll: `<canvas>` bitmaps do not survive `cloneNode`, and `tug-sparkline.tsx` and `pdf-view.tsx` both render one — a departing card's sparkline goes blank. `input.value` is a property, not an attribute, so a composer with typed text clones empty. CSS animations restart from zero in a clone. None of these were exercised by the two cards measured (the census reads `form values lost: none` and `running animations: live 0, face 0` on the markdown card), so they are **read from the platform's semantics and the tree, not observed**; each would need a card that has one to reproduce. The point is not any single one of them — it is that the enumeration has no end, because the clone's divergence from the card is everything about the card that is not DOM. **(inference from the platform and from reading; not measured)**

**[F07] Two plausible causes were ruled out.** — The face is re-parented from the frame's own chain to the canvas container, which would matter if anything between them contributed style. It does not: the census prints the live frame's ancestors as `div.tug-space-layer < div < div < div < body` against the face's `div.tug-pane-exit-ghost < div < div < div < body`, and `space-layer.css` gives `.tug-space-layer` `display: contents` when shown, so the two share an effective layout parent. Structural divergence was also ruled out — the walks match exactly, 728/728 nodes and 134/134. Recording these so the next reader does not spend the afternoon on them. **(verified by measurement)**

**[F08] The deck already owns the symmetric half.** — `DeckState.arriving` is a store mark with a `arrivingWith` reducer twin (`deck-manager.ts`), resolved by `DeckCanvas` and projected by `TugPane` onto the frame as `data-arriving` plus `visibility: hidden`. Its lifetime problem — a beat that is not guaranteed to run — is already solved by an unconditional drain (`drainArrivalsRef`, "the whole of [R01]'s answer"). A departing mark is that machinery pointed the other way, and it inherits the solved lifetime problem rather than re-posing it. **(verified by reading)**

---

## Decisions {#decisions}

**[B01] The departure treatment becomes a `departing` mark on the real component, and the cloned face is deleted.** A frame that stays mounted is not a picture of the card — it *is* the card, so there is no fidelity contract to write, no strip list to maintain, and no category of thing-that-does-not-clone to discover later. This is the only option of the three that makes [F03], [F04] and all of [F06] structurally impossible rather than individually fixed, and it is what the user asked for before either defect was found. `departure-face.ts`, `FACE_IDENTITY_ATTRS` and `FACE_GEOMETRY_PROPS` go with it.

**[B02] The mark is modelled on `arriving`, not invented beside it.** [F08] says the shape already exists: a store mark, a reducer twin, resolution in `DeckCanvas`, projection in `TugPane`, and an unconditional drain for the case where the beat never runs. Following it means the two halves of a card's life are one mechanism read in two directions, and the lifetime hazard that produced the stranded-ghost defect is answered by machinery that has already answered it once. A parallel design here would be a second lifetime model for the same problem.

**[B03] A departing frame is inert and out of the imposer's arithmetic, and those are two separate obligations.** Inert is what the clone's identity strip was reaching for and gets for free from the real component: `inert` plus `aria-hidden` on a frame that is still itself, with no attribute stripped and therefore no appearance lost. Out of the arithmetic is the harder half and the one that must be explicit — survivors have to move into the room the departing card gives up *at the same moment they do today*, which means the placement solver must not see it while the fade still draws it. The current code gets this by the pane being gone from the store; the mark has to get it by exclusion, and that is where this work's real risk sits.

**[B04] The three ghost rules survive the ghost, restated against the frame.** `tuglaws/animation-doctrine.md#ghost-contract` and the `pane-model.md` paragraph currently state the contract in terms of a ghost, a face and two strip lists, most of which is about to stop existing. The rules underneath them do not change and are what the replacement must also keep: the departing frame stands where the card stood, it answers nothing while it fades, and one record owns its lifetime with every exit taking it away. The laws are rewritten to say that about a marked frame; they are not deleted along with the mechanism, because a reader in six weeks needs to know why the departure path looks the way it does.

**[B05] `at0584` becomes the gate, and it is written to pass against the replacement rather than retired with the clone.** The census compares a departing frame's interior against the same frame's interior a moment earlier, which is a question worth asking of the real component too: a frame excluded from the arithmetic must not reflow, and [B03]'s second obligation is exactly the thing that could make it. Its two current failures are the evidence in [F03] and [F04], and the same file going green is what says the replacement actually fixed them. `at0582`'s rect census and `at0583`'s selector census are re-pointed at the marked frame or retired with a reason, never left pointing at a mechanism that no longer exists.

**[B06] The fade's look does not change.** Duration, curve, and the decision that a card fades as itself rather than as a blank tile are as settled in `ebcb64175` and in the animation doctrine. What changes is which element carries the fade. A reader should not be able to tell this work happened, except that the glitches stop.

---

## Open Questions {#open-questions}

- **What excludes a departing pane from the placement solver, and where.** [B03] names the obligation and not the mechanism. The candidates are a filter at `placeMembers`/`layout-imposer`, a filter where `DeckCanvas` derives the arrangement, or keeping the pane out of the store's member list while a separate mark holds the frame. They differ in what else reads the same list — the resize floors, the seam allocation, the arrangement signature that arms the settle — and the wrong choice produces either a survivor that moves late or a settle that does not arm. This needs the code read, not prose, and it is the one part of the work that cannot be sketched from here.

- **Whether a departing card may be interrupted, and what happens if it is.** Today a retarget mid-fade cuts the ghost on the `unlaunched` rule and lets a launched one finish. A real frame is a real member: a second arrangement change while one is departing has to decide whether the departing card is re-measured, left alone, or removed immediately. The ghost's answer does not transfer, because the ghost was never in the arithmetic and the frame is.

---

## Non-goals {#non-goals}

- **Patching the clone a third time.** Restoring scroll offsets onto the clone after cloning, and finding another way to keep `[data-slot]` from resolving, would fix [F03] and [F04] and nothing else. It was considered and rejected on [F05]: the contract's own reopening condition has fired, and each pass over this enumeration has been cheaper than the next defect it failed to prevent. Recorded here so it is not re-proposed as the small safe option, because it is the option that keeps this brief's investigation recurring.

- **Reverting to the blank tile.** Dropping the face restores a treatment that provably never glitched for a month, at the cost of a card fading as a coloured rectangle. Rejected because the face was added for a reason that still holds — the contents should not vanish a beat before the frame — and because the replacement gets that reason satisfied without a copy at all. Worth remembering as the fallback if [B01] turns out to be much harder than [F08] suggests.

- **A rasterised still.** The clone-versus-raster question recorded in the previous brief's Open Questions is closed rather than answered: a raster would fix the identity half and not the scroll half (it would faithfully photograph a scroller at whatever offset it had, which is right) but it costs a paint on every close and it is a snapshot, which is the thing the user asked to stop doing. [B01] makes the question moot.

- **Reopening the ghost's outer geometry, or its lifetime record.** `963206078` pinned both and `at0582`/`at0450` hold them. Those rules are inherited by [B04], not re-litigated.

- **The pre-existing reds around this work.** `at0571` has been red since `ebcb64175` and `at0294` for 27 recorded runs on the imposer's FLIP arithmetic. Neither is this work's, and neither blocks it.

---

## Exit {#exit}

**An arc.** The shape of the first steps:

1. Read the placement path end to end and settle the first Open Question — what excludes a departing pane from the arithmetic, and what else reads the list being filtered. Nothing else can be written until this is answered, and it is the step most likely to change the shape of the rest.
2. Add the `departing` mark: the store field, the reducer twin of `arrivingWith`, the resolution in `DeckCanvas`, and the projection in `TugPane` as `data-departing` + `inert` + `aria-hidden` ([B02], [B03]). Mark set at `_closePane`, which is where `cardWillBeginDestruction` already fires while the frame is still mounted.
3. Point the `depart` beat at the marked frame instead of the ghost, and give the mark an unconditional drain modelled on `drainArrivals` so a pane is removed whether or not its beat lands ([B02]).
4. Delete `departure-face.ts`, both strip lists, `departureFacesRef`, `departureGhostsRef`, the ghost planting in the Last pass, and the `.tug-pane-exit-ghost` / `.tug-pane-exit-face` rules in `tug-pane.css`.
5. Re-point `at0584`, `at0582` and `at0583` at the marked frame, or retire the ones whose subject is gone, with the reason recorded ([B05]).
6. Rewrite the ghost's-contract section in `tuglaws/animation-doctrine.md` and the exit-ghost paragraph in `tuglaws/pane-model.md` to state the three rules against a marked frame ([B04]), and record that the clone approach was tried, measured, and retired.

`at0584` is already in the working tree and already red on exactly the two defects the work has to fix, so it can be run against the tree as it stands before anything is changed — the same discipline the previous arc used, and the reason its step 1 is known to have gated what it gated.
