# A column mode flip is a cover, not a fade

**Purpose:** Stack Column on a two-card column plays a visible mistake: the retiring card fades out, comes back at full strength, and is then painted over by the survivor. The flip should read as one card covering or uncovering another, with one edge moving and nothing blinking.

---

## Purpose {#purpose}

The user has two stacked cards in a column, with the bottom one activated, and selects *Stack Column*. In the user's words: "the bottom card fades out, but then comes back in at full strength, and the top card animates over it. At full speed, this is *very distracting*. Looks like a mistake, especially since if I was looking closely, I saw that card fade out."

Read against the frames of the recording: the activated card (the survivor) travels up and then grows to the full run; the other card fades, reappears at full opacity across the whole column run behind the survivor, and is covered as the survivor grows.

---

## Evidence {#evidence}

**[F01] The survivor and the retiring member run on different clocks, and the retiring one is shorter.** A column mode flip fades every member but the z-frontmost one (`settleFadePlanRef`, `tugdeck/src/components/chrome/deck-canvas.tsx` ~3120 and ~3746). The survivor's rect changes in both position and height, so `planSettleBeats` (`tugdeck/src/lib/pane-flip.ts:344`) gives it a `move` beat then a `grow` beat, run in sequence: 1.0× + 0.6× of the settle nominal, 640ms at the 400ms default. The fade rides `divide-join` at 0.6×, 240ms, and is launched on its own completion path rather than in the beat chain. **(verified)**

**[F02] When the fade completes, its residue is released immediately.** The fade branch (`deck-canvas.tsx` ~4231–4300) holds the retiring frame at its old tile with a static transform for exactly the fade's duration and pushes an opacity restorer. Its completion (`deck-canvas.tsx:4474`) runs the restorers and `clearFlip` as soon as the fade's animations finish. The inline opacity comes off, so the frame is at full strength; the held transform comes off, so the frame snaps to its committed rect, which is the full column run. At that instant the survivor is 60% through its move and has not begun to grow. **(verified)**

**[F03] The retiring card is therefore fully visible for about 400ms behind a survivor that has not yet covered it.** The fade plan's comment says a retired member leaves "for somewhere it will not be seen (stack)". That is only true once the survivor's grow beat ends. Inferred from F01 and F02; matched frame by frame against the recording, where the retiring card's Changes list and composer show below the survivor until the grow beat reaches them. **(verified by the recording, not by an app-test)**

**[F04] In a column flip the survivor's translate is an artifact of measuring its top-left corner.** On Stack Column from the bottom tile, dy equals minus the tile height plus the gap, and the height grows by the same amount: the bottom edge does not move, the top edge rises to the column top. On Split Column the reverse edge retreats. Playing move then grow in sequence is what opens the gap the fade falls into. **(verified by geometry; the general multi-member case is an open question below)**

**[F05] A fused single-beat plan already exists.** `planSettleBeats` takes `{ fused: true }` and returns one `room` beat carrying every term with nothing held; `BEAT_RECIPE` maps `room` to `crossing`, the 1.0× recipe. Height is a real geometry term either way, so a fused beat forfeits no compositor acceleration the survivor had. **(verified)**

**[F06] Z-order already puts the survivor in front.** Card z-indices are packed from `state.panes` order, which is what `activateCard` moves, and the survivor is chosen as the last column member in that order. A retiring member drawn at its old tile at full opacity is covered by the survivor wherever the two overlap, with no opacity needed. **(verified)**

---

## Decisions {#decisions}

**[B01] The survivor of a column mode flip plans a fused beat.** Its whole crossing is one `room` beat on the `crossing` recipe: one motion, one moving edge on the two-member case, no interval in which the survivor has left one tile and not yet claimed the other. The three-beat choreography exists so that only one kind of thing moves at a time; here the move and the grow are the same edge, and sequencing them is the defect (F04). This applies to the mode-flip survivor only; every other settle keeps its beat plan.

**[B02] No member fades, in either direction.** The user's call. A stack is the frontmost card covering its neighbours, and a split is it uncovering them (F06). A retiring member holds its old tile at full opacity and is covered; a revealed member is simply there at its committed tile as the survivor retreats off it. The `divide-join` fade on column flips goes away. The recipe itself stays, since arrivals and departures elsewhere still ride it.

**[B03] A retiring member's hold is released at the settle's one completion, never on its own.** The held pose on a non-survivor lasts as long as the beat chain, and its restorers and `clearFlip` run in the chain's final `.then` alongside the choreographed frames, not on a completion path of their own. This is the fix for F02 and it stands on its own: however a member is hidden or held, a hold that ends before the survivor covers it reappears. A settle whose survivor has no beats at all (nothing moved) must still release the holds, so the fallback is the fade branch's existing self-completion.

**[B04] Reduced motion is unchanged.** The layout snaps and that is the settle; no hold, no fade, nothing to release.

---

## Open Questions {#open-questions}

- **Does the fused beat read correctly for a survivor whose tile is not adjacent to the moving edge?** In a two-member column one edge moves. In a three-member split where the frontmost card is the middle tile, both edges move on a stack, and on a split both retreat. Geometrically both are growth or shrink of the same frame, so a fused beat is still the honest description, but this has not been watched. The arc checks it by eye on a three-member column with the middle member frontmost, in both directions, before it lands. The user asked for this to be checked in the arc rather than settled here.

---

## Non-goals {#non-goals}

- **Matching the fade's duration to the survivor's chain.** Stretching `divide-join` to 1.6× so the two clocks end together would hide the reappearance by coincidence rather than by construction, and any retune of either recipe would reopen it. B03 makes the lifetime structural instead.
- **Keeping the fade and only fixing the release.** B03 alone would fix the reappearance, but the fade would then show the top tile going dark before the survivor slides onto it: a different hole. The user chose to drop the fade.
- **Changing `planSettleBeats` for settles that are not mode flips.** A rail split, a seam drag, a width preset step keep their shrink, move, grow order. Only the flip survivor is fused.
- **Any change to the settle duration or the recipes' time scales.** The one knob stays where it is.

---

## Exit {#exit}

An arc. The first steps, roughly in the order they must land:

1. In the settle's Last pass, give the fade-plan survivor a fused plan (`planSettleBeats(terms, { fused: true })`) and route non-survivor members to a hold-only path: static transform and height at the old tile, no opacity keyframes.
2. Move the non-survivors' restorers and `clearFlip` into the beat chain's completion, with the self-completion fallback for a chain that never launches.
3. Retire the `"in"` side of the fade plan entirely, since a revealed member needs nothing; the plan can shrink to a set of held members plus one survivor.
4. Watch it: two-member column both directions, then the three-member middle-frontmost case from Open Questions. Adjust only if that case reads wrong.
5. Update the tests that pin the fade (`grep imposer-fade tests/app-test tugdeck/src`) to pin the hold and its release at chain completion instead, and add one that asserts a retiring member is never at full opacity at its committed rect while the survivor is mid-flight.
