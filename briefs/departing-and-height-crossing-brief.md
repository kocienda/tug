<!-- brief-skeleton v1 -->

# The `departing` mark and height by translation

**Purpose:** Two of the asks brief's concepts are still read as numbers rather than built: a departing pane is still a ghost planted inside the settle, and a fold or a column division still tweens real `height` on the main thread. Both are "what does the settle do with a box that is leaving or shrinking", both are standing D9 hits, and each is decided by one bench reading rather than by argument. This brief states the findings and the two readings.

---

## Purpose {#purpose}

From `briefs/graphics-animations-asks.md`, concepts three and five:

> **Nothing is created or destroyed inside a gesture.** Already law for pane layers. Extend it to the departure ghost, which is a new fixed layer planted at frame one, and to the rail shadow strips. The doctrine already names the right end state: a `departing` mark on the real frame, excluded from the solver, symmetric with `arriving`.

> **Height crosses by translation and occlusion, never by a height keyframe.** … A folding card's content is held at the old height, its bottom chrome edge and the opaque neighbor below translate up over it, and the card's box snaps to its final height in the commit nobody sees. … This is a candidate to bench, not a decision.

Three audits (2026-10-01 to 2026-10-02) found neither begun. The third audit's verdict moved past the asks brief's scope and named these as design work; the user asked for the sketches and then for the briefs. This is the second of two. It is written to follow `briefs/settle-engine-and-beat-brief.md`, because both changes edit the settle, and that brief gives the settle a file of its own.

---

## Evidence {#evidence}

**[F01] The departure ghosts are created and destroyed inside the settle window.** `deck-canvas.tsx:6045` creates a `.tug-pane-exit-ghost` sized from a closing pane's First rect and appends it to the canvas; `:6116` creates a fixed `.tug-rail-shadow` strip per side when a rail leaves. Both are registered in `departureGhostsRef`, animated by the depart beat, and removed at the land or by the teardown sweep at `:4375`. `tuglaws/animation-doctrine.md` names them the third standing D9 hit, the one D9's second clause (every layer an effect runs on already exists at rest) does not allow. **(verified, read)**

**[F02] The store already carries the symmetric mark.** `state.arriving?.[pane.id]` is read by the solver's filter at `deck-canvas.tsx:745`, and `arrivingSeatByPaneId` is a canvas-level map; an arriving pane is in the arrangement with a seat and excluded from the solver's terms. There is no `departing` counterpart: a closed pane leaves the store's `panes` in the same commit that closes it, so by the time `arm` runs the frame is on its way out of React and only the ghost can be animated. **(verified, read)**

**[F03] The two height-bearing gestures are red on real readings, and each pays a `height` term and a large commit.** `at0654` was deleted on 2026-10-03 (`a6232e3ac`, on the user's word) and its last readings are in `briefs/zero-red-app-tests-brief.md`: the unfold 2.24 frames against 1.5; the column split 3.35 against 2, "real height tweens on a 2621–3289-fiber commit"; a card's departure 2.24 against 2 on a 2,965-fiber commit; showing a two-member rail 3.00 against 2 on a 4,501-fiber mount. The doctrine's first standing hit is the division's `height`. Each red has two costs in it, the tween's and the commit's, and the readings do not separate them. **(verified from the brief; not re-read at HEAD)**

**[F03a] The commit's share belongs to another brief.** `briefs/settle-window-commit-brief.md` reads each gesture's commits by cause and cost and cuts them. Until it has, a fold or a split read here cannot say how much of its gap the height tween paid. **(verified, read)**

**[F04] A fold's heights are computable from the store at `arm`, and its far side's interior is not.** `briefs/gesture-task-without-react-brief.md` [F12]: a folded member is height-pinned at its card type's folded tier, an open member's height is `columnAllocationOf(state, slot, run)`; but `data-folded` is rendered by React on the frame and the session card's interior keys its own `data-fold` off it, and the Last pass detects a fold crossing by that attribute changing. `FOLD_PREPARE_MS` (25 ms, `lib/fold-crossing.ts:121`) exists to keep that interior flip out from under the moving edge. **(verified, read from the brief and the code)**

**[F05] The fold's interior is still mid-fold, and only the ends move.** From the 2026-10-02 census recorded in memory and the fold-crossing module: only the Z2 occupant moves mid-fold; the terminal-state re-layout lands under the unfold's first frames; the sequence is prepare → move → land. That is the shape translation-and-occlusion needs: an interior that does not change while the edge travels. **(verified for the census; that the interior can be held at the old height without a visible seam is the bench's question)**

**[F06] Occlusion needs an opaque occluder.** The pane occlusion controller already counts a coverer only when its chrome's computed background alpha is 1 and both frame and chrome have `opacity: 1` (`pane-occlusion-controller.ts`, header). A translucent card chrome, a theme with a tinted frame, or a card mid-fade cannot occlude. Whether every theme's pane chrome is alpha 1 at its top edge has not been read. **(verified for the controller's rule; the theme census is not taken)**

**[F07] Width already crosses without a width keyframe.** `tuglaws/animation-doctrine.md:337`: width crosses on the same tween as a `scaleX` term anchored at the frame's left edge, with the raster cap as the standing hit. The translation-and-occlusion design is the height analogue, and the doctrine's width section is its nearest precedent. **(verified, read)**

**[F08] The held interior clips without showing, and without a `height` tween.** Under the bench (`labFlags.heightByTranslation`), the folding frame's box is held at its larger height by a static inline `height`, its interior stays held by the still crossing it already had, and the chrome's own `overflow: clip` clips it. Across three solo runs, folding and unfolding, the seam band between the travelling edge piece and the lower member was at most 5 px (the member gap) and never resolved into either frame's content, and no flag-on gesture wrote a `settle-motion-violation` row. The session card's scroller did not fight the held box. A layout cost of the hold was not separated from the commit's, and the timing in [F10] does not show one. **(verified, `at0685` reading 2 in `briefs/departing-and-height-crossing-readings.md`)**

**[F09] Every shipped theme's pane chrome is opaque, and the frame paints nothing.** The theme census over `SHIPPED_THEME_NAMES`: the lower member's `.tug-pane-chrome` background is alpha 1 in all ten themes (`oklch(0.31 0.01 h)` in the five dark ships, `oklch(0.985 0.002 h)` in the five light boats). The `.tug-pane` frame's own background is `rgba(0, 0, 0, 0)` in all ten. Occlusion by the chrome needs no backing layer in any shipped theme, and the bench's forced alpha-1 rule changes nothing in them. **(verified, `at0685` theme census)**

**[F10] Taking the `height` tween out of the fold does not move its gap.** With the bench on, the unfold's `longestGapFrames` read 2.06, 2.00, 2.12 / 2.18, 1.29, 1.88 / 2.12, 2.00, 1.94 over three solo runs (mean 1.95). The flag-off control read 2.00, 1.47, 2.24 / 1.82, 1.53, 2.12 / 1.94, 1.65, 2.31 (mean 1.90). The fold in was 1.96 on, 2.16 off. Both arms carry the same largest commit in every window, 718 performed at 20–45 ms in, and the bench's one transform-only beat has the same gap as the three-beat fold with two `height` terms. The fold's remaining hole is the commit's, not the tween's. `reactMs` was not readable (the lead recorder attached no render start), so the commit's share is read from its timing, not measured. **(verified, `at0685` reading 2)**

**[F11] The exposure is at the column's foot, not at the seam.** The lower member, held at its larger box and translated, hangs below the column foot by up to 291 px on the fold and 298 px on the unfold. Most of that is past the window's bottom edge and clipped by it. In the strip still inside the viewport, about 18 px, one tick of one unfold in three runs showed the lower card's own content (`session-card-picker-backdrop`) where the canvas belongs. The seam, the place the brief expected an edge piece to fail, never exposed. A column whose foot stands higher in the window than the bench fixture's would show more of the overhang. **(verified, `at0685` reading 2)**

**[F12] Verdict: the fold bench fails.** Against its three clauses: timing fails ([F10], over 1.5 on 8 of 9 flag-on unfolds and no better than the control); exposure fails ([F11], one foot-band tick); the property holds ([F08], no `height` animated). So the fold keeps its height tween and its prepare beat, the division is not benched ([B04] is not taken), and the bench is removed. What this leaves for whoever takes the fold's gap next is [F10]: the hole is the commit's. **(verified, `at0685` reading 2)**

---

## Decisions {#decisions}

**[B01] A departing pane stays in the arrangement for one settle, marked `departing`, and the real frame runs the depart beat.** The store keeps the closed pane in `panes` with `departing[pane.id] = true` for the length of the settle; the solver excludes it as it excludes `arriving`; the depart beat runs on its real frame; the land removes it from the store in the commit after the settle. React unmounts it then, outside any gesture. The pane exit ghost goes. This is a store change first and a settle change second, which is why it waits for the settle engine.

**[B02] The rail shadow becomes a standing strip per side, present at rest.** The rail itself is what leaves, so there is no real frame to mark; a strip that exists at rest, is invisible, and is shown and translated by the beat is what "layers that already stand" means for it. Two elements at rest, per deck, is the cost. The alternative, keeping the rail's frames in the arrangement as departing members, is rejected: a hidden rail is parked, not closed, and its frames have other duties.

**[B03] Height by translation is a bench, and the bench is one fold.** A two-card column, a fold of the upper card, the lower card's chrome forced to alpha 1 for the reading: the upper card's interior held at its old height and clipped by the frame, the frame's bottom edge and the lower card translating up on the Beat, the box snapping to its final height at the land. Read with the settle frame record and the settle-frames fixture's fold leg driven alone, after the commit brief's cuts, with the lead recorder armed so the commit's `react_ms` is read beside the gap and the tween's share is what is compared. If the unfold gap comes under the 1.5 bar and no frame shows the interior's old content past the new edge, the design is worth its corners and goes to an arc; if not, the reading says why, and the fold keeps its height tween and its prepare beat.

**[B04] The division is the same bench at N, taken only if the fold's passes.** Dividing a column is the fold's move for every member at once, with the interiors held and the chrome edges translating. It is not benched first because it has more moving pieces and the fold's reading answers the same question with fewer.

**[B05] Corners and bottom edges are the design's price, and the bench pays it only once.** A frame whose box lags its visible edge needs standing pieces for the corner radii and the bottom chrome, and they have to render identically to the box in every theme. The bench builds them for one theme (ironclad, the exemplar) and the arc, if there is one, generalises. The theme census `[F06]` asks for is taken as part of the bench.

**[B06] Nothing here loosens a bar, and every change lands with a reading.** The departing mark's reading is the settle-frames fixture's departure and showing-a-rail legs, driven alone; the height bench's reading is the fold leg. `at0654` and its three-solo-runs rule are gone; a leg that comes under its bar is added to `at0622` as an ordinary leg, since the corpus no longer keeps a test built to stay red (zero-red brief [B03]). The three bars re-budgeted on 2026-10-03 are not moved back without the user's word.

**[B07] This work runs after the commit brief.** The departure and rail legs are a 2,965-fiber and a 4,501-fiber commit as much as a ghost ([F03]); the departing mark removes the ghost and the commit brief's [B04] and [B05] remove the commits, and a reading of either leg before both have landed cannot say which one paid. The bench ([B03]) likewise reads only once the split's and the fold's commits are cut.

---

## Open Questions {#open-questions}

- **Can the held interior be clipped without a layout?** **Answered, [F08]:** it clips without showing and without a `height` tween; the scroller does not fight it. A layout cost of the hold was not separated from the commit's.
- **Is every theme's pane chrome alpha 1 at its top edge?** **Answered, [F09]:** yes, in all ten shipped themes, so occlusion needs no backing layer.
- **What does a departing pane's card content do for the settle's length?** It is closed from the user's point of view; its content should stop, not re-render. Whether the card lifecycle's `will`-phase runs at the mark or at the unmount is a `lifecycle-delegates.md` question.
- **Does the Beat's start-pose writer carry the held interior height?** Depends on how `briefs/settle-engine-and-beat-brief.md` answers its first open question.

---

## Non-goals {#non-goals}

- **Building the height crossing before the bench reads.** `[B03]` is a reading, not a commitment.
- **Changing the fold's recipe, duration or the prepare beat** except as the bench's outcome.
- **One hold, one quiet.** A later brief, after the Beat exists.
- **Unmounting a departing pane's content early to save work.** It leaves with the pane, in the commit nobody sees.
- **Loosening any frame bar.**

---

## Exit {#exit}

**A design spike, then an arc.** The departing mark (`[B01]`, `[B02]`) is decided and is walked once the settle engine exists and the commit brief's cuts have landed (`[B07]`); its reading is the fixture's departure and rail legs. The height crossing is the spike: the one fold on the one theme, read against the fold leg (`[B03]`). What the spike shows is written back here as findings, and the arc that follows is briefed from them, for the fold alone or for the fold and the division (`[B04]`).
