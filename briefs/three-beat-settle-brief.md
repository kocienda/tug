# The settle is three beats: shrink, move, grow

**Purpose:** A card moving between slots in split mode resizes and translates at once, and the interior re-lays-out under both while a session keeps streaming into it. Three motions on one window read as a card out of control, and the deck judders trying to draw them. The crossing should be divided into beats, so that at any instant exactly one kind of thing is moving.

---

## Purpose {#purpose}

The user's words, after the fold's still-interior work landed and the compaction handoff was built on it:

> When we simply *move cards* from slot to slot when those slots are showing in stack mode, the animations are great. However, in split mode *still is mixing internal card movement* along with the outer card frame resizing and movement. Doing both at the same time, especially in a card with an active session with content continuing to stream in — which adds a *third potential kind of motion* — makes for a distracting and jarring display. It's not pleasant, and what's more, it tends to judder, since we're trying to do too much at once. Even if we aren't actually dropping frames or performance (and I think we are), all this movement gives the impression of not being under control.
>
> I think that somehow, we must divide up this movement into stop loading (if needed), resize, move, restart loading and relayout (if needed).

And, on the first sketch's proposal to carry the fold's clip-and-cut reading over to every resize:

> "the composer disappearing under the edge and returning at the end" — It sucks. It is jarring, and looks wrong.

So the target is a crossing in which one kind of motion happens at a time, the stack move keeps exactly the look it has, and a resize never hides the composer.

---

## Evidence {#evidence}

**[F01] A stack move is transform-only, and that is why it looks right.** Members of a stack draw the same rect, so a move between stacked slots has a FLIP delta of `dx, dy` and no size term. The settle's Last pass in `tugdeck/src/components/chrome/deck-canvas.tsx` gives such a frame a transform-only keyframe list, which stays on the compositor, and nothing inside the card is dirtied. The picture rides. **(verified by reading)**

**[F02] A split arrival, departure, or cross-column move carries a real height term, and a real height term re-lays-out the card's interior on every frame.** Shares travel with their cards, so a reorder inside one split column changes positions only; but a card arriving in a split column shrinks the sitting member, a card leaving one grows the member left behind, and a card crossing from a wide column into a split one changes height as it travels. Under [D135] every height delta is a real `height` tween, main-thread by construction, and the frame gets one effect carrying the translate and the size together. Inside the frame, `.session-card` is `height: 100%` of the tweening box and `container-type: size`, so the whole subtree lays out on every frame and the composer's `50cqh` cap re-resolves on every frame. This is the fold's [F05] in `briefs/session-fold-still-interior-brief.md`, which that arc fixed for frames whose `data-folded` flips and left open for every other height crossing. **(verified by reading; the per-frame layout was measured there on the fold and is inferred here for the split case, which has the same structure)**

**[F03] The transcript's own observer turns each of those frames into a React commit inside a running animation.** `TugListView` observes its scroll container; each per-frame resize delivers, runs `maybePinToBottom`, and pokes `scrollTick`, which is a React render of the list. The store's own documentation of `holdNotifications` records what a commit inside a compositor animation costs: settle alone 343 walk samples, a commit stream alone 654, the two together 1809 — 81% over their sum, median frame delivery 17ms to 20ms. That commit stream is the list's own state, so the store hold cannot reach it. **(verified by reading `tugdeck/src/components/tugways/tug-list-view.tsx` and `tugdeck/src/lib/code-session-store.ts`; the cost figures are the store's recorded measurement from the imposer perf work, not re-measured here)**

**[F04] Streaming is already held for the window, and released on the wrong clock.** `deck-canvas.tsx` calls `holdNotifications` on every session store at arm and `releaseNotifications` when the settle ends, so wire events reduce but do not notify React for the window's length. The release fires from a `setTimeout(windowMs)` at `deck-canvas.tsx:2926`, while each frame's tweens end on the animator's clock in the `finished` handler that runs the restorers and ends the fold crossing. Two clocks wearing one duration, which is the shape the still-interior brief's [F02] convicted for the fold: under load the timer fires first and the release's publish lands in the tail of the sweep. **(verified by reading)**

**[F05] A height-only change never re-wraps text.** Width is untouched by every split-mode motion, so the per-frame layout in [F02] is a flex column re-resolving its heights, not a transcript re-measuring its lines. The resize episode's scroll anchoring in `tugdeck/src/lib/resize-episode.ts` exists for the width case and is not what a height beat needs. **(verified by reading)**

**[F06] The deck already has a hand-driven height resize with a reading nobody has objected to: the sash drag.** Dragging a split column's seam resizes both members live, per frame, on the main thread; the composer keeps its place at the bottom and rides the edge, Z2 rides above it, and the transcript scrolls under the list view's own policy — following the bottom if it was, staying parked if the reader was in history. The interior lays out truthfully on every frame of the drag. **(verified by reading `tuglaws/pane-model.md` and the seam's live path; the reading is the one the deck ships today)**

**[F07] [D135]'s one-effect rule is a constraint on a frame that carries two terms at once, and only on that.** Its argument is that a pinned edge is the *sum* of a translate and a size, and a sum is only honest on one clock. A frame that carries a size in one beat and a translate in another has no sum to keep honest, so the rule is satisfied trivially rather than contradicted. The first sketch discounted sequencing on this rule; the rule does not reach a sequenced settle. **(verified by reading [D135])**

---

## Decisions {#decisions}

**[B01] Every settle is choreographed as up to three beats in a fixed order — shrink, move, grow — and a beat with nothing in it is skipped.** Beat one: every frame that gets smaller shrinks in place. Beat two: every frame that changes position translates, transform-only. Beat three: every frame that gets larger grows in place. No frame carries a size term and a translate in the same beat, so the move beat is always accelerated and a resize beat never runs under a compositor animation. The order is "make room, move, close up": a card arriving in a split column sees the sitting member shrink, then slides into the room that opened; a card leaving sees itself slide away, then the member left behind grows into the run; a card crossing from a wide column into a split one shrinks where it stands, then travels. Air opening between members during beat one is the make-room beat being legible, not a seam failing — the seam concern the first sketch raised was [D135]'s, and [F07] says it does not apply.

**[B02] A settle with no size term is unchanged.** It has one beat, the move, and it is today's stack move to the curve. This is the bar the whole design is measured against ([F01]), and nothing about it moves.

**[B03] A resize beat reads as a sash drag of that edge.** The composer keeps its place at the bottom and rides the edge; Z2 rides above it; the transcript's viewport shrinks or grows between the masthead and Z2, and the transcript scrolls under the policy the list already has under a hand on the sash ([F06]): following the bottom, the last line stays at the bottom and older lines slide under the masthead or emerge from it, one uniform motion in the edge's own direction; parked in history, the reader's line stays put. Nothing is clipped, nothing disappears, nothing cuts at the beat's end, because the interior lays out truthfully on every frame. The layout is height-only ([F05]), the deck already does it for every seam drag, and if a long transcript makes it heavy it is heavy under the hand too and gets fixed in one place. Confirmed by the user this session as the reading that replaces the clip.

**[B04] The stream is held for the whole choreography and released on the last beat's clock, in order.** The store hold that already exists ([F04]) spans all three beats rather than one window, and it is released from the settle's completion — after the final tween's `finished` — rather than from the `windowMs` timer, which stays as the wedge guard it already is for the sweeps. Release order is: beat end, then episode end, then hold release, so the one publish and the one pin land on settled geometry. With no transform running during a resize beat and no resize running during the move beat, the list's own per-frame tick ([F03]) lands in a phase where it costs a layout rather than a composite.

**[B05] The fold keeps its own reading.** A fold is a resize beat that already has a design — the still interior with Z2 riding the edge — and this brief does not disturb it. The crossing mark, the held height and the crossing-end event stay as they are; the fold simply runs in beat one or beat three. The compaction cover's handoff, which waits on that event, is unchanged.

**[B06] Timing is the crossing's one nominal, applied per beat.** Resize beats at 0.6× nominal, the move beat at 1.0×, so a full three-beat crossing is 2.2× nominal — about 880ms at the default — and a pure move is still 400ms. These are starting values to tune by eye, and every beat scales with `--tugx-imposer-settle-duration` and `--tug-timing` as every imposer motion does. A settle interrupted mid-beat is re-planned from where the frames are, as an interrupted settle is today, with velocity inherited only into a beat of the same kind.

**[B07] The work is judged by eye, not by a census.** The user's call: the machinery to measure what a split move costs is time spent confirming what is already known, and the three-beat structure is right or wrong on sight. Verification is watching a split arrival, a split departure, and a cross-column move with a turn streaming into one member, plus one position test ([Exit](#exit)).

---

## Open Questions {#open-questions}

- **Whether the transcript's slide during a resize beat reads as content motion.** [B03] takes the sash drag's reading, in which a bottom-following transcript's lines slide with the edge. That is the reading the user already lives with under the hand, but a programmatic resize is not under the hand. The alternative — a top-anchored transcript that stays perfectly still and pins once at the beat's end — is a jump on a shrink and a blank band on a grow, which this brief judges worse. Settled by watching it; the user has said this is a crack that may need a second.

---

## Non-goals {#non-goals}

- **Carrying the fold's still interior to every resize.** The clip-and-cut reading — composer under the edge, returning at the end — was the first sketch's [S1] and is rejected outright by the user: "It sucks. It is jarring, and looks wrong." The still interior stays the fold's ([B05]).
- **Resize and move on one clock, pinned by the sum of terms.** [D135] stays true for a frame that carries both terms; [B01] arranges that no frame does. Do not re-propose collapsing the beats to keep a seam pinned — the open seam is the make-room beat.
- **Fading or rasterizing the interior across a beat.** Hides churn rather than avoiding it; the beats avoid it. Rasterizing was also already rejected by [D135] as a screenshot smear.
- **A width hold by clip.** A width beat by clip would cut words off at the edge, which is why the fold's trick is a height trick. Width keeps the resize episode's anchoring and the list's debounced re-measure; no split-mode motion changes width.
- **Measuring first.** [B07].
- **Holding the list view's own tick.** The tick is what keeps a following transcript at its bottom during a resize beat ([B03]); silencing it would be the top-anchored alternative by another door.

---

## Exit {#exit}

An arc. The order that matters: the beat planner lands before the release moves onto its clock, because the release's ordering in [B04] is stated against beats that exist.

First steps, in shape: in `deck-canvas.tsx`'s Last pass, partition each frame's FLIP delta into a shrink, a move, and a grow, and launch the non-empty beats in sequence, each on its own recipe from `tugdeck/src/lib/imposer-motion.ts` and each with one term ([B01], [B06]); route the store release, the episode end and the fold-crossing end through the last beat's completion in the order [B04] states, leaving the `windowMs` timer as the sweep; confirm a no-size settle still produces today's single transform-only tween ([B02]) and a fold still marks and holds as it does ([B05]). Then the pin: an app-test in the shape of `at0563` for a split arrival and a split departure — during the move beat no frame's height changes and no top inside either card moves; during a resize beat no frame translates; the composer's bottom edge and Z2 track the frame's edge throughout; the stack move's frame count and terms are unchanged. Then look at it, with a turn streaming, and come back to the open question with eyes rather than numbers.
