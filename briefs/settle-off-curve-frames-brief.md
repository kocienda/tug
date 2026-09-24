<!-- brief-skeleton v1 -->

# No frame may paint off its own curve

**Purpose:** A card activation across slots sometimes shows its whole slide and sometimes shows none of it, landing as a pop. The frames are not being dropped — they are being painted, on time, at the wrong pose: the settle's move tween holds a frame at its origin with the animation's own first keyframe, and under `fill: "none"` an animation that has not started yet applies nothing at all.

---

## Purpose {#purpose}

The user, on the gesture after the `deck-animation-pipeline` arc landed:

> Now, on the deck I have now, I *sometimes* see a smooth slide when I click on the numbered slots in the Workspaces sidebar card to switch between slot 1 being active and slot 4 being active, but other times, I see basically no frames at all for the move, and I just *pop* to slot 1 or 4 from the other. WHY IS THIS? Why is it not *absolutely predictable* as I think it should be.

And a second report in the same shape, on a different gesture:

> when I clicked on the `briefs/switch-frozen-picture-brief.md` link in this card on this deck right now, the file opened in slot 4, and *did not animate to it*.

The word that matters in the first report is **predictable**. The prior arc treated this as a cost to be narrowed — a raster hole, measured in milliseconds of frame gap. It is not a cost. It is a discrete condition that is either true or false on a given gesture, and when it is true the reader sees none of the travel. The question this brief answers is what that condition is, and the standard it sets is that the condition must be unreachable rather than rare.

---

## Evidence {#evidence}

**[F01] The move beat's first keyframe *is* the origin, and it is the only thing holding the frame there.** `springSettleKeyframes` emits `translate(dx * remaining, dy * remaining)` at each sample, and `dx = first.left - last.left` (`tugdeck/src/lib/pane-flip.ts:140`). At offset 0, `remaining` is 1, so keyframe 0 is the full FLIP invert: CSS `left` has already placed the frame at its destination and the transform walks it back to where it started. Nothing else in the settle writes that pose. **(verified, read from the code)**

**[F02] The move tween is launched with `fill: "none"`, and nothing anywhere waits for it to start.** `settleOpts` in `tugdeck/src/components/chrome/deck-canvas.tsx:4442`, with the stated reason "No retained effect after the tween ends ([D6])". A Web Animations effect whose local time is unresolved produces no output, and `el.animate()` returns an animation that is **play-pending**: its start time stays unresolved until the next update after the animation is *ready*, which for a composited animation means after the compositor has been handed it. A grep for `.ready`, `.pending` and `startTime` across `tugdeck/src/components/tugways/tug-animator.ts` and `deck-canvas.tsx` returns nothing — no code in the deck knows or cares when a tween actually begins. **(verified: `fill: "none"`, the absent `.ready` await, and keyframe 0 are read from the code; the pending-start semantics are the Web Animations model rather than a measurement of this app)**

**[F03] Measured: four consecutive ticks in which every pane carried a move that had not started.** Two fields were added to `tugdeck/src/lib/settle-frame-probe.ts` — `pendingTicks`, counting ticks where a transform-bearing effect exists with `startTime === null`, and a per-pane `offCurve` — and `at0622-deck-settle-frames.test.ts` was run against the shipped behaviour. The loaded leg read **`pendingTicks: 4`, `offCurveTicks: 4`, `offCurvePaneIds: ["at0622-p4","at0622-p6","at0622-p8","at0622-p2"]`, `firstPaintDelayMs: 79`**; a second leg read `pendingTicks: 1`. The idle legs read `0`. Four frames were painted, on time, with the deck standing at its destination and none of the travel shown. **(verified, measured)**

**[F04] The condition tracks main-thread load, which is the whole of the intermittency.** `pendingTicks` is `0` on every leg driving an idle deck of empty seeded cards, and non-zero only on legs where the thread is under load. A real deck — loaded transcripts, a real click task, a card mounting — is the loaded case; the harness fixture is not. So the same gesture slides on a quiet machine and pops on a busy one, which is exactly the report. **(verified by the readings above; that the user's machine is in the loaded case is inference from the same readings)**

**[F05] The probe could not see this, and its blind spot explains the prior arc's five-way negative.** `moveCurrentTimeOf` (`settle-frame-probe.ts`) guards on `if (typeof currentTime === "number")`, and a play-pending animation's `currentTime` is `null` — so a pending move was indistinguishable from *no move at all*. `firstPaintDelayMs`, defined as the distance from the first tick at which the move "existed" to the first tick its clock advanced, therefore started its clock at the first tick the animation had already started, and read `0` on every activation ever recorded. `briefs/deck-animation-pipeline-findings.md` records that reading and calls the field "close to vacuous", attributing it to a long click task. The narrower truth is that the instrument deleted the pending window from its own record. The same paper reports that none of its five suspects, removed individually, narrowed the gap — a result that is **correct rather than failed**, because none of them was the mechanism. **(verified, read from the code and the paper)**

**[F06] The standing promotion did not cause this, but it is what made it fire.** `[B01]` of `briefs/deck-animation-pipeline-brief.md` put a standing `will-change: transform` on every `.tug-pane` (`tugdeck/src/components/tugways/tug-pane.css:317`), so every move tween is now composited by construction and every one of them must be handed to the compositor before its start time resolves. An uncomposited transform animation is applied by the main thread in the rendering update that created it, where the pending window is effectively zero. The user's description of the symptom changed between the two reports in exactly the way that predicts — from "sometimes I get a slide and sometimes I don't" to "basically no frames at all for the move". **(the promotion and its date are verified from the code and the paper; the causal reading of the symptom change is inference)**

**[F07] The codebase already solves this for arrivals, and the move beat is the one place that does not.** An arriving frame is held at an **inline** `opacity: 0` written by the settle and handed back by a restorer, so the hold lives in the element's own style rather than in the animation's first keyframe. A pending arrival is therefore invisible and then fades — correct at every instant. The move beat is the only motion on the deck whose start pose depends on the animation having started. **(verified, read from the code)**

**[F08] The file-link gesture is the same defect on a second path, and is worse by construction.** `openFileInCard` (`tugdeck/src/lib/open-file-in-card.ts`) finds no card holding the path and calls `store.addCard(...)`. Two motions follow: the card's **arrival** into slot 4, protected by [F07]'s inline hold, which is why the file was seen to appear; and the deck's **travel** to bring slot 4 into the band, which is a separate commit one beat later — `_revealAfterArrival` → `onceCardDidArrive` → `revealCard` → its own notify → its own settle → the move beat of [F01]. That reveal commit fires the instant the arrive beat completes, which is immediately after a brand-new card has mounted, parsed and laid out a file. **(the path is verified from the code; that its timing coincides with peak main-thread load, and therefore pops more reliably than the slot gesture, is inference — and it matches the user's two reports, one intermittent and one flat)**

**[F09] A beat boundary is a second, independent source of off-curve frames, and no `fill` can close it.** The chain is `BEAT_ORDER.reduce((chain, kind) => chain.then(() => runBeat(kind)), Promise.resolve())` (`deck-canvas.tsx:5323`), with each beat awaiting `Promise.allSettled(anims.map(a => a.finished))`. Every boundary is at least one rendering opportunity in which the previous beat has ended — `fill: "none"`, no output — and the next beat's animation **does not yet exist**, so there is nothing for any fill to apply. The frame paints its base style, which is its final pose. `briefs/deck-animation-pipeline-findings.md` records an unexplained "one-frame, two-device-pixel seam at a beat boundary" in `at0566` and leaves it open. **(the promise chain and the absent animation are verified from the code; that the `at0566` seam is this and not sub-pixel rounding on a promoted layer is a candidate explanation, not established — [F03]'s fields measured at boundaries would settle it)**

**[F10] The workspace dissolve's `fill: "none"` is correct and must not be changed with the others.** `deck-canvas.tsx:6362` fades the outgoing layer 1 → 0, and `[P08]`'s comment there states the reasoning: an animation that never launches leaves the departing layer *visible*, and the teardown takes it off in the same turn, so a failed launch degrades to a cut. The base style is the safe pose on that tween, which is the opposite of the move beat's situation. **(verified, read from the code)**

---

## Decisions {#decisions}

**[B01] A frame's start pose is held by the frame, never by the animation's clock.** This is the whole fix and the rule behind it: at the instant a settle is planned, every frame it carries must already be painting its start pose, whether or not any animation has begun. The implementation is `fill: "backwards"` on the move and resize beats — one property, identical compositing, and it satisfies `[D6]` exactly, because `[D6]` forbids a retained effect *after* the tween and `backwards` fills only *before* it. What it rules out is the current shape, in which the pose that holds a frame at its origin is reachable only through an animation that may not have started. What would revisit it: a measurement showing `commitStyles()` on a pending backwards-filled animation writing a pose the `hold-at-current` retarget then mis-reads.

**[B02] The inverse failure is closed in the same change, not left to the sweep by assumption.** Under `fill: "none"` an animation that never starts degrades to a cut, which is benign; under `backwards` it would strand the frame at its **origin**, which is worse than the defect being fixed. So [B01] is admissible only together with a demonstrated cancel on every exit — the settle's window sweep, the retarget, the generation bump, and the effect's own teardown — with `cancel()` dropping the fill on each. This is a guard to be proven by a test that never starts a tween, not a comment asserting that the sweep exists.

**[B03] Every beat of a settle is created in one frame, and sequencing is by the animation timeline rather than by a promise hop.** [F09] is not reachable by any fill, because during the hop the next beat's animation has not been created. Two shapes are admissible and either closes it: one animation per frame whose keyframes compose the whole choreography as offset ranges, or one animation per beat with all of them created together and ordered by `delay`. The promise chain is ruled out as a sequencing mechanism for motion, and stays only as the completion signal it also is. What would revisit it: nothing about the mechanism — a boundary at which no effect is applied is off-curve by construction — though its *priority* moves if the boundary measurement of [B05] reads zero.

**[B04] The invariant, stated so a guard can enforce it: no frame on the deck may ever paint a pose that is not on its own settle's curve.** The prior arc's bar was frame gaps, and a gap counter cannot see a frame that arrived carrying the wrong pose — which is why a defect this total measured as nothing at all for five consecutive suspects. The new bar is `offCurveTicks === 0`, asserted rather than noted, and it is the bar this work is held to. It sits beside the gap bar rather than replacing it; they answer different questions.

**[B05] The probe's pending blind spot is a defect of the instrument and is fixed first.** The read is `startTime === null`, not `typeof currentTime === "number"`, and `pendingTicks` / `offCurve` / `offCurveTicks` / `offCurvePaneIds` are the fields ([F03] wrote them; they are in the working tree uncommitted and the arc adopts them rather than re-deriving them). `firstPaintDelayMs` is re-derived against the same read or retired — as it stands it cannot report anything but zero, and a field that can only be green is worse than no field. The boundary case of [F09] is measured with the same instrument by recording the longest off-curve run's offset from the move's start.

**[B06] The bar runs on a loaded deck, because an idle one cannot show this class of defect.** [F04] is the measurement and this is its consequence: `pendingTicks` is `0` on every idle leg, so an assertion that runs only there is green over a condition that never arose. The off-curve assertion of [B04] runs on the forcing leg — the one that plants a long task inside the settle window — which is the reproduction, and on the eight-card leg. This also makes the bar falsifiable: with the fix reverted the forcing leg must go red.

**[B07] The file-link gesture gets its own pin, though it needs no fix of its own.** [F08] is [B01]'s defect reached through `_revealAfterArrival` rather than through an activation, so the repair covers it. What it does not cover is the risk that the reveal commit is special — it fires from an arrival's completion callback, at the moment a card has just mounted — so it is pinned separately: open a file into a deck where the target slot is outside the band, and assert the travel is on-curve at every tick. A fix proven only on the activation path would leave the user's second report unverified.

**[B08] No step of this work may claim a measured improvement without a measured before and after on the loaded leg.** Carried directly from `briefs/deck-animation-pipeline-findings.md`, which had to write "no later step or join message may say it was" four separate times. Here the claim is available and should be made precisely: `offCurveTicks` before, `offCurveTicks` after, on the same leg, on the same machine.

**[B09] The prior arc's rules are not revisited.** The standing promotion, the compositor-only recede and flash, the bounded click task, the held cell relevance and the paint-property law all stand. [F06] says the promotion is what made this fire, and that is not an argument against it: the promotion removed a real class of defect and made a latent one deterministic, which is how a latent defect ought to be found. Reverting it would hide this bug rather than fix it.

---

## Open Questions {#open-questions}

- **How long the pending window is on a real deck rather than on the harness fixture.** `at0622` seeds session cards with empty transcripts; the user's deck has loaded ones, and [F04] says the window tracks load. Four ticks is the harness's forced number, not the product's worst. Answering it needs either a fixture with real transcript content or a reading taken from the in-product `settle-frames` record on the user's own deck — the latter is cheaper and already has a channel.

- **Whether `at0566`'s two-device-pixel seam is [F09]'s boundary.** The instrument of [B05] answers it in the same run that measures everything else. It matters because that pin was left red-ish and unexplained by the prior arc, and an explanation retires a standing puzzle rather than adding one.

- **Whether the reveal-after-arrival commit should exist at all.** [F08] describes a second settle fired from the completion of the first, at the worst moment for main-thread load. `_revealAfterArrival`'s own docblock argues the two beats must be separate so the reader sees the card land before the deck travels. That argument is about *perception* and is probably right; whether the second commit must be a second **settle**, rather than a second beat of the first one under [B03]'s single timeline, is a real design question this brief does not settle.

---

## Non-goals {#non-goals}

- **Holding the start pose with an inline transform instead of a fill** — the arrival pattern of [F07], applied to the move beat. It works and has the same failure mode and the same backstop as [B01], so it is not rejected on correctness; it is rejected on cost. It is a per-frame inline write at plan time plus a hand-back that must run exactly once, against one property on the animation. If [B02]'s cancel guarantee turns out not to be demonstrable, this is the shape to fall back to rather than a reason to keep the defect.

- **Reverting the standing promotion of `[B01]` in `deck-animation-pipeline-brief.md`.** See [B09]. It would make the pop rarer by making the animation uncomposited, which is hiding the defect behind the cost the promotion removed.

- **Changing the workspace dissolve's `fill: "none"`.** [F10] — the base style is the safe pose there, and a sweep of every `fill: "none"` in the file would break it. Recorded so the fix is not applied by pattern-match.

- **Re-litigating the prior arc's five suspects.** [F05] — their negative was correct. Nothing here asks for them to be measured again.

- **Longer tweens, a delayed start, or a minimum-duration floor to "cover" the window.** They trade a pop for a pause and leave the off-curve frames in place; [B04] is a claim about every frame, not about the average.

---

## Exit {#exit}

An arc. Its first step is the instrument, because everything after it is verified with it: adopt the `pendingTicks` / `offCurve` fields already sitting uncommitted in `tugdeck/src/lib/settle-frame-probe.ts` and its unit test, fix `moveCurrentTimeOf`'s blind read, settle what becomes of `firstPaintDelayMs`, and record the off-curve run's offset from the move's start so [F09]'s boundary is separable from [F03]'s pending window ([B05]). Then the bar, red before the fix: `offCurveTicks === 0` asserted on the forcing leg and the eight-card leg ([B04], [B06]), which is the falsification the prior arc never had. Then the fix itself — the held start pose and, in the same change, the cancel guarantee that keeps its inverse failure closed ([B01], [B02]) — with the before and after readings taken on the same leg ([B08]). Then the beat boundary, on whichever of [B03]'s two shapes the boundary measurement argues for. Then the file-link pin ([B07]), which is the user's second report and the one path the activation tests do not walk. A findings paper carries the before and after numbers side by side, and says plainly which of [F09] and the open questions it left unanswered.
