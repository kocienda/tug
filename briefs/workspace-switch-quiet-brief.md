<!-- brief-skeleton v1 -->

# Workspace switch: cover until quiet

**Purpose:** Switching workspaces still reads as herky-jerky. Content pops, hops and flashes after the dissolve lands, and the user does not want the fix to be a longer pause between workspaces. This brief pins where the movement comes from and decides how a switch goes from one still screen to another.

---

## Purpose {#purpose}

The user, on the switch as it stands:

> We have a cross-fade scheme in place now, but it still seems a bit herky-jerky at times, and content pop/hops/flashes a bit too much. That said, I don't want to introduce a long delay in between every workspace transition. [...] It kind of feels like there should be some way to go from one stable screen to another stable screen without extraneous movement after the transition lands.

Two constraints, then: no extraneous movement once the transition has landed, and no perceptible delay bought to get it. The sketch that produced this brief offered five ideas; the user chose the first three and deferred the fourth (keeping the previously shown workspace laid out while hidden) as a bigger hammer than the problem yet warrants. This brief is those three.

And a second report, added after the brief was first written, about movement that is not a workspace switch at all:

> In the *current workspace*, switching between the session card in slot 1 and the session card in slot 4 *is now cross-fading*. It must not do this. Intra-workspace moves like this should *slide* the chosen card into position.

The word "now" is the user's, and it is a regression report: the slide was the settled behaviour, and something recent has replaced it with a fade on this pair of cards. The two reports share one canvas and one settle, and the arc that fixes the first must not leave the second standing.

---

## Evidence {#evidence}

**[F01] The dissolve itself cannot move a shared pixel; the movement is under it.** `tugdeck/src/components/chrome/deck-canvas.tsx` ("The switch is one dissolve") tweens only the departing wrapper's opacity 1 → 0 over the arriving workspace, which stands opaque underneath from the first frame. Where both pictures agree the composite is constant. So anything that visibly moves during or after the beat is the arriving picture changing while it is being revealed, or the departing picture changing while it is being dissolved. **(verified, read from the code)**

**[F02] The arriving workspace has no boxes until the commit that opens the dissolve, and every measurement it owns re-arms in that commit or the frames after it.** A hidden layer is `display: none` (`tugdeck/src/components/chrome/space-layer.css`), chosen so a hidden workspace costs no layout, and `briefs/workspaces-content-visibility-brief.md` [B03] made "armed on the shown transition" the rule for every measurement content takes. The shown transition is therefore where they all fire at once. Read out of the code, gated on `useSpaceLayerShown`: the composer's line-box remeasure (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`), both sheet clamps (`tugdeck/src/components/tugways/tug-sheet.tsx`), the pane bar's controls-width measurement and every frame measurement in `tugdeck/src/components/chrome/tug-pane.tsx`. Not gated on the context but downstream of the same event: the transcript list's re-windowing, which holds its last range while hidden, re-windows on a ResizeObserver tick after the layer is shown, and suspends once more to measure rows appended while hidden (`tugdeck/src/components/tugways/tug-list-view.tsx`, the hidden-scroller branch). None of these can land in the first painted frame; the earliest is the commit itself, the observer-driven ones are a frame or two later. **(verified, read from the code; which of them visibly moves on a given switch is not measured)**

**[F03] The switch commit is a cut, but the re-arms it triggers are not.** `activateSpace` in `tugdeck/src/deck-manager.ts` notifies with `"cut"`, so the imposer declines a settle for the swap itself ([P11]). The sheet clamps, the composer cap and the list re-window then write real geometry a frame or more later, and whatever they change is committed by ordinary paths that do not know a switch is in progress. Any of them that arms a spring or a CSS transition keeps travelling after the dissolve has ended. That is the movement the user sees after the transition "lands". **(inference from the code; a frame-by-frame recording of one switch would confirm which sites travel)**

**[F04] A window resize while a workspace is hidden is absorbed only by the shown one.** The settled-resize re-tune in `deck-canvas.tsx` observes the canvas container and, after a quiet period, calls `store.retuneSidebarAllocation()`, which reads `this.deckState`, the active workspace's deck. A parked workspace's deck (`spaces[i].deck`, written by `parkedDeck` at the last switch away) is not re-solved. When it is swapped back in it carries an arrangement solved against the old canvas, and the switch's `"cut"` commits it as-is. Nothing re-tunes it until the next container resize, so a workspace hidden across a resize either stays at a stale arrangement or is corrected by a later commit that animates. **(verified that the re-tune reads only the active deck; the visible consequence is inferred)**

**[F05] The departing picture is live DOM for the length of the beat.** The crossing layer is the real outgoing wrapper at `display: block`, still receiving store updates. A streaming session appends rows, progress dots pulse, carets blink under the fade. The crossing attribute already pauses the pointer for the layer; it pauses nothing else. **(verified, read from the code; not in scope for this brief beyond naming it, see Non-goals)**

**[F06] The deck already owns every mechanism the fix needs.** The cover is the crossing layer, already opaque and on top. The quiet gate is the shape of `tugdeck/src/lib/arrival-reveal.ts`: a quiet source, a report, a short bound, composed by the deck, with `ARRIVAL_REVEAL_BOUND_MS` pinned at 250 for the same "sits still for a quarter second reads as the click landing" reason. The settle's end is already one event on the container (`tugdeck/src/lib/settle-notice.ts`). `activateSpace` already carries a switch instrument ([P09]) that stamps commit and paint times, which is where a quiet time would be recorded too. **(verified)**

**[F07] The dissolve's length is the settle nominal scaled by the `divide-join` recipe's `timeScale: 0.6`** (`tugdeck/src/lib/imposer-motion.ts`), a few hundred milliseconds. Today that length is doing two jobs: it is the join between two pictures, and it is the only thing hiding the arriving picture's assembly. **(verified)**

**[F08] Activating a card in another slot of the same workspace is specified as a slide, and the code still says so.** `activateCard` in `tugdeck/src/deck-manager.ts` flips the first responder and, with `reveal` on by default, writes `_revealTerms` into the same commit: the flow offset, the column offset and the rail offset each moved by the least that shows the member ([P12]), so the settle plays the travel as its move beat on the `crossing` recipe together with the raise ([P10]). `GO_TO_SLOT` in `deck-canvas.tsx` does the same through `setFlowOffset` with the default `"cross"` landing. Nothing on either path asks for a fade. **(verified, read from the code)**

**[F09] On the user's live deck, switching between the session cards in slot 1 and slot 4 of the current workspace cross-fades instead of sliding.** Reported by the user on 2026-09-24 against the Release build; not reproduced here, and the mechanism is not established. The settle has two ways to fade a frame, and the arc's first job is to find which one is firing. First, a frame counted as an arrival or a departure: `arm` takes a First rect for every shown frame except one that is pointer-owned, still in `pendingArrivalsRef`, or wearing `data-arriving`, and the Last pass fades any shown frame with no First rect as an arrival, and any First rect with no surviving frame as a departure, on `divide-join`. A stale entry in `pendingArrivalsRef`, which is cleared only when a settle releases, is one candidate: `activateSpace` disposes every arrival watch, so a card whose arrive beat was cut short by a switch can leave its pane on the pending list. Second, the workspace dissolve itself, which is keyed on the active workspace id changing and should be inert for an intra-workspace activation; it is a candidate only if the activation is somehow routed through a workspace change. The commits most likely to have moved this are the two workspace-switch arcs, `cefbb2014` and `b5bf7e0e7`, and the column mode flip cover `954c83d0d`, which touched the settle's fade rules. `at0466-go-to-slot`, `at0454-flow-mode` and `at0547-directional-card-focus` pin parts of the slide and were green at those landings, so whatever is fading is a case they do not cover. **(reported by the user; mechanism inferred, not verified)**

---

## Decisions {#decisions}

**[B01] A switch is three moments, not one: cover, quiet, dissolve.** The commit that swaps the deck also raises the departing layer as the crossing layer, exactly as now, but at full opacity with no tween started. The arriving workspace assembles underneath it, unseen. The dissolve starts when the arriving side goes quiet or a short bound expires, whichever is first. Because the cover is the old workspace itself, fully opaque and pixel-identical to the frame before the switch, the user perceives nothing during the quiet wait but the old screen holding for a few more frames. This is the whole answer to both constraints at once: the picture revealed is already still, and the added latency is measured in frames rather than in a pause anyone would name. It also reframes the dissolve length ([F07]) as a taste knob rather than a cover for motion.

**[B02] Quiet is a fact the deck composes, not a timer it owns.** The quiet source is the arriving layer going a frame or two with no settle in flight and no re-measure landing: the container's settle-end notice, plus the layout-affecting re-arms of [F02] reporting done. The exact composition is the arc's to work out against the code, but the rule is the one `arrival-reveal.ts` already states: subscribe to the sources, re-ask on every fire, never assume a fire means quiet, and let a bound release a source that never settles. The bound is short by ruling, on the order of the existing 250ms arrival bound or shorter, and when it expires the dissolve starts over whatever the arriving side has. The wait is recorded in the switch instrument ([F06]) so a switch that regularly hits the bound is visible as a number rather than a feeling.

**[B03] Everything that lands under the cover lands as a cut.** The re-arms of [F02] and any arrangement correction of [F04] must not spring, tween or transition while the arriving layer is covered or crossing. The mechanism is a switch-epoch mark on the canvas container, the sibling of the crossing attribute on the outgoing wrapper, that the imposer's `arm` and every animating commit path read and decline to animate under, the same way reduced motion ends a settle in one commit. Without this, [B01] would wait on springs that should never have started, and a spring that outlives the bound is exactly the post-landing hop. The mark comes off when the dissolve begins, not when it ends: from that frame the arriving picture is on screen and any later change is an ordinary live change.

**[B04] A parked workspace is re-solved against the canvas before it is shown, never after.** The arrangement solve is pure math in the deck manager. Either the settled-resize re-tune runs it over every parked deck as well as the active one, or `activateSpace` re-solves the incoming deck against the current canvas inside the swap commit, before `"cut"`. The second is the smaller change and the one to try first: it makes the first shown frame already the resized solution, so there is no correction to arm at all and [B03] has one fewer case to catch. The re-tune's own debounce and initial-observation swallow are untouched.

**[B05] The recording comes first.** Before the arc changes any of the above, one switch is captured frame by frame in the app-test harness, in both directions, with a transcript that has streamed while hidden and after a window resize while hidden. The recording names which re-arm sites of [F02] actually travel, so [B03]'s mark is read where it matters and not everywhere on faith. The 2026-09-18 drop fix was "verified" green without a sampler and was not fixed; this work does not repeat that.

**[B06] The cover holds for at most a bound; it never holds for content.** A workspace whose session is mid-stream, whose transcript is measuring a thousand appended rows, or whose image has not decoded does not keep the old workspace on screen. The bound releases it and the dissolve reveals whatever is there. Stillness after the bound is the ordinary live deck's responsibility, not the switch's.

**[B07] An activation inside a workspace slides; it never fades, and it never opens the workspace dissolve.** The reveal terms of [F08] are the whole of an intra-workspace activation's motion: the strip, the column and the rail travel by the least that shows the card, as the settle's move beat, in the same commit as the raise. A frame that was on screen before the activation and is on screen after it is a traveller, and the settle must have a First rect for it. The arc establishes the mechanism of [F09] first, fixes the code so the slide comes back, and pins the slot-1-to-slot-4 case in the harness with a frame sampler that asserts no pane on the deck is ever at less than full opacity across the settle, whichever mechanism turns out to be the cause. If the cause is a stale pending arrival, the fix is that a switch away from a workspace releases the pending arrivals of the panes it takes off screen, and the pin includes an arrival cut short by a switch.

---

## Open Questions {#open-questions}

- **What exactly counts as a re-arm reporting done, for the quiet source.** The settle end is one event already. The sheet clamps, the composer cap and the list re-window have no completion signal today; the arc has to decide whether they gain one or whether "two consecutive frames with no ResizeObserver callback under the arriving layer" is quiet enough. The recording of [B05] is what settles this, which is why it comes first.

- **Whether focus transfer scrolls.** The switch resolves the incoming first responder and focuses it. If any path reaches `focus()` without `preventScroll` on an element inside a scroller, that is a hop no cover can hide, because it happens on the shown side after the dissolve. A grep during the recording step answers this; if it is real it is a one-line fix that belongs in this arc.

---

## Non-goals {#non-goals}

- **Keeping the previously shown workspace laid out while hidden** (the sketch's idea 4: `visibility: hidden` for a small LRU set, splitting the shown context into "has boxes" and "is on screen"). Deferred by the user as a bigger hammer than the problem yet warrants. It would make switching back reveal a picture that never stopped being current, at the cost of style and layout for a second deck while it streams, which is what `display: none` was chosen to avoid. It is the upgrade if [B01] through [B04] still show assembly on switching back, and nothing in this brief forecloses it.

- **Freezing the departing picture** ([F05]): pausing animations and holding list windows under the crossing attribute, or a native bitmap cover taken by Tug.app. Real, and possibly worth doing, but it is a different beat from the arriving side's assembly and it is not what the user described. Named here so it is not lost.

- **A longer or slower dissolve.** It hides more assembly and reads as a pause. [B01] removes the reason to reach for it.

- **A true crossfade of both layers.** Already tried and replaced; it showed canvas ground between two partial pictures.

---

## Exit {#exit}

An arc. Its first step is the recording of [B05]: an app-test that switches both ways under the three conditions named there and samples frames, so the work starts from a list of the sites that actually move. Beside it, and before anything under the cover is touched, the intra-workspace fade of [F09] is reproduced and its mechanism named, then fixed and pinned ([B07]): it is a regression in the settle the rest of this work leans on, and a quiet gate built over a settle that fades travellers would wait on the wrong thing. After that, in the order the dependencies run: the switch-epoch mark and the cut-under-cover rule ([B03]), because the quiet gate is meaningless while springs can start under it; the incoming-deck re-solve in `activateSpace` ([B04]), because it removes a whole class of correction before the gate has to wait on it; then the cover-quiet-dissolve choreography itself ([B01], [B02]) with its bound and its instrument reading; and last the same recording rerun against the result, with the frame-by-frame diff after the dissolve lands as the proof.
