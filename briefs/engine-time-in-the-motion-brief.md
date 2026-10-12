<!-- brief-skeleton v1 -->

# Engine time in the motion: the first frame after the commit, and the height crossing

**Purpose:** Five stages moved the stream's script off the main thread, and every gesture on the user's deck still misses the one-period bar. What fills the frame now is the engine: the first frame after the arrangement commit costs 80–90 ms of compositing and layer commit, and the fold's `shrink` and `grow` beats stall 47–76 ms on a real `height` tween. This brief names the two costs, decides how they are read, and reopens the height crossing with the new shape the doctrine requires.

Stage 6 of `briefs/main-thread-headroom-program-brief.md`.

---

## Purpose {#purpose}

The user's goal is unchanged: "full frame rates no matter what work the app is doing." The 2026-10-12 readings of the user's relaunched deck, with every stage on and nothing streaming:

| Gesture | Lead | Worst in-motion gap | Land |
|---|---|---|---|
| fold / unfold | 16 ms | 31–42 ms | 30–42 ms |
| slot move | 22–47 ms | 30–89 ms | 28–30 ms |
| split → stack | 16 ms | 53–92 ms | 30 ms |

Every row misses 16.7 ms. Script is 7 of 131 busy samples. The program did what it set out to do and the asks are not met.

---

## Evidence {#evidence}

**[F01] The first frame after the commit is the largest single gap on every gesture.** The always-on gap rows on the user's deck: `move` late frames of 79, 86, 79 and 92 ms, each at the same offset into its window as its own length (+79, +86, +79, +92), which is the first frame after the beat launched. The set-up before it (store commit, deferred React commit, Last pass, beat creation) ends in a frame the engine prices at the whole new arrangement: style for every pane the commit touched, the compositing-requirements walk over the document, and a layer commit of every pane's new backing. On a 13k-element document that frame is 80–90 ms. Under set-up-and-go this is a lead, a budget rather than a bar, and it is also what the eye sees as the pause before a card moves. **(verified, measured 2026-10-12; the phase split is from the native sample across drives, not of that frame alone)**

**[F02] The height crossing is the largest stall inside the motion.** The user's own fold windows recorded `shrink` late frames of 67, 75 and 76 ms at +67, +142 and +151 ms, and 47–48 ms at +189 and +199; unfold recorded `grow` pairs of 26–28 ms at +512 to +591. The audit's drive read fold's worst in-motion gap at 31–42 ms. The `shrink`, `grow` and fused `room` beats animate real `height` and `width` (`pane-flip.ts:230-235`, declared at `settle-engine.ts:3985-4021`); the doctrine records this as [D9]'s standing hit, main-thread for the frame's own box, with the still-crossing hold keeping the interior out of it. On this deck each of those frames pays style, the frame's layout, the compositing walk and a layer commit. **(verified, measured; attribution to the height term is by the beat label and the doctrine's own description, not yet by a per-frame phase sample)**

**[F03] The walk and the commit are priced by the document.** The compositing walk reads about 5 ms per style-changing frame at 23k elements and about 4.3–5.1 ms at 4–7k on the harness (`briefs/compositing-walk-readings.md`). The user's deck now stands at 11–15k elements after stage 4, down from 30–38k aged, and the stall sizes above are on that smaller deck. **(verified, measured)**

**[F04] Height by translation was benched twice and lost on the land.** `briefs/set-up-and-go-motion-brief.md` Non-goals: it moved the relayout to the land and made the land worse (55–65 ms against 45–49). The doctrine (`animation-doctrine.md` [D9]) records the ruling and its condition: "reopened only with a new shape for the division, not a third bench of the same one." **(verified, read)**

**[F05] The commit frame's cost has a known shape and no reading of its own.** The settle's `--tasks` census names the commit's fibers; `--chains` names forced layouts (6 chains, 7 ms total on the fold); neither prices the engine's part of the frame that follows the commit. The native sampler covers whole drives. No instrument has read one frame's style, compositing-walk and layer-commit split on the user's deck. **(verified, read from the verbs)**

**[F06] What was tried against the commit frame already.** Pane chrome memoization (stage 2) shrank the planning commit a quarter on fold and an eighth on slot; the cached container client size removed the `_placeRunHeight` chains; the dot-ink fix removed a subtree restyle per focus flip. Each shortened the commit's script; none touched what the engine does with the committed arrangement. **(verified, read from the record)**

---

## Decisions {#decisions}

**[B01] The two costs are read per frame before anything is built.** `tugtool deck motion settle` gains a `--frame-phases` arm that samples the WebContent main thread at 1 ms across one drive and files samples by frame boundary (from the gap sampler's timestamps) as well as by phase, so the first frame after the commit and each `shrink` frame carry their own style, layout, compositing and layer-commit counts. Read on the user's deck, quiet and with three turns in flight. [D5]'s discipline: three drives, medians, the instrumented reading labelled as such.

**[B02] The first frame after the commit is attacked as engine work, not as script.** Candidates, in the order they are read: the number of panes whose style the commit dirties (a frame whose arrangement did not change should not be restyled: pane frames the imposer moves by custom property versus by attribute); the compositing walk's population term on that frame (stage 4's ceiling applies here too, and the Overview's parked twin is 11k elements on the user's deck); and the layer commit's size (a pane whose backing did not change should not re-upload). Each candidate is probed on the user's deck with `--frame-phases` and the one whose removal moves the frame is the one built.

**[B03] The height crossing is reopened with a new shape.** This is the user's call and the doctrine's condition, and the readings now make the case: with script gone it is the largest judder inside the motion on the user's deck. The shape is not a third bench of translation. Two candidates are read first:

- **Clip, not height.** The frame keeps its final box from the commit; the crossing animates a `clip-path: inset()` on the frame (compositor-accelerated on this WebKit if authored as a single `inset()` with keyword easing, to be verified by a bench against engine fact 2), and the neighbor below it translates to meet the clip edge. Layout runs once at the commit, no layout runs per frame, and the land hands back nothing because the box is already final. The still-crossing hold's job, keeping the interior at one definite size, is done by the commit rather than by a hold.
- **Two frames, one box.** The frame's box crosses as today, but the main-thread term is paid on a one-element frame layer whose only child is the clipped card root with `contain: strict`, so the per-frame layout is one box and the compositing walk is bounded by the frame's overlap scope rather than the document's.

Each is benched on the whale arm and the user's deck with the gap rows and `--frame-phases`, against the land as well as the motion, since the land is where translation lost. The one that holds the one-period bar inside the motion with a one-frame land is built; if neither does, the reading says why and the ruling stands with the new numbers written beside it.

**[B04] The bar is the asks' bar.** No gap over one display period from the first frame to the land, and a one-frame land, read on the user's deck. The lead stays a budget, and its size is recorded beside it so the pause before a card moves is a number the user can rule on.

**[B05] Every change lands with the before-and-after on the user's deck.** As the program brief's [B03] and [B04] require, with the honesty rules from `briefs/motion-record-honesty-brief.md` in force: unperturbed drives for the bar, instrumented drives for attribution.

---

## Open Questions {#open-questions}

- **Is `clip-path: inset()` animation accelerated on this WebKit?** Settled by a bench under the falsification method: a bare `inset()` tween on a standing pane layer, read with `deck motion rest` and the forcing probe.
- **What is the phase split of the commit frame on the user's deck?** [B01] answers it, and the answer orders [B02]'s candidates.
- **Does the lead read as a delay to the user at 80–90 ms?** The user's reading; recorded beside the bar.

---

## Non-goals {#non-goals}

- **A third bench of height by translation.** Ruled; [F04].
- **Loosening the in-motion gap bar or the land bar.**
- **Host-side pane composition.** The program brief's [B07] escape; it opens only if this stage cannot hold the bar on the user's deck.
- **Shortening the set-up's script.** Stage 2 took what was cheap; the rest of the lead is the engine's and is [B02]'s subject.

---

## Exit {#exit}

**An arc.** The shape: the per-frame phase arm ([B01]) and its reading on the user's deck first; then the commit frame's candidates probed in the order the reading gives ([B02]); then the two height-crossing shapes benched ([B03]) and the winner built; every step read against [B04] on the user's deck ([B05]). The arc joins when fold, slot and split hold the bar on the user's deck, or when the reading says which cost cannot be held and why, written into the program brief's record.
