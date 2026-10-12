<!-- brief-skeleton v1 -->

# The population ceiling: the document is bounded by the viewport, not by history

**Purpose:** WebKit's compositing walk, every style resolution and every layout are priced by what is mounted, and what is mounted grows with history: the Overview tripled in half an hour of use, transcripts hold up to 500 turns, and each session adds a card. Moving script off the main thread leaves this engine time where it is. This stage puts a number on how much may be mounted and holds the deck to it.

Stage 4 of `briefs/main-thread-headroom-program-brief.md`; read against stages 1 through 3, which take script time off the frame and leave engine time as the floor.

---

## Purpose {#purpose}

The user wants full frame rates no matter what work the app is doing. After stages 1 through 3 the work the app is doing no longer runs on the main thread, and what remains on it is the engine's own cost of the document. That cost scales with the document and resets only on relaunch (`briefs/compositing-walk-and-overview-brief.md` [F04], [F05]). A deck that is clean at launch and judders by afternoon is this stage's subject.

---

## Evidence {#evidence}

**[F01] A style-changing frame costs about 5–7 ms of compositing walk on a full deck.** 6–7 ms at 23,116 elements and 7,226 render-layer candidates; 5.13 ms by mean at 22,858 (`briefs/compositing-walk-readings.md` [F01]). A tween frame reads 10–12 ms to the end of style and layout against a 16.7 ms period (`briefs/flow-slide-remaining-costs-brief.md` [F10]). **(verified, measured on the user's deck)**

**[F02] The Overview carries about half the walk and grows without bound in use.** 10,922 elements, 150 cells, 150 sticky pins and 1,034 stacking contexts on the 2026-10-06 deck; skipping its cells saved 4 ms of a 7 ms walk at p50 (`real-transcript-motion-readings.md`, The streaming floor). It held 3,745 elements after a relaunch and 12,349 after half an hour (`flow-slide-remaining-costs-brief.md` [F11]). Four stacking contexts per post plus one sticky attribution header per post account for most of its contexts (`compositing-walk-readings.md` [F06]). **(verified, measured)**

**[F03] A skipped row leaves the walk, but only after a scroll sweep.** `content-visibility: auto` rows that WebKit has skipped are not walked (forcing 6,009 skipped elements to render added 1.30 ms). A row given `auto` while already off-screen stays rendered until a scroll carries it through the viewport's proximity, and `checkVisibility({contentVisibilityAuto: true})` is ignored on this engine (`compositing-walk-readings.md` [F03], [F04]). So the skip is real and it is not deterministic. **(verified, measured)**

**[F04] The transcript list is inline, not windowed.** `TugListView` runs the transcript in `inline` mode with `offscreenSkip` (`session-card-transcript.tsx` near `:3290`); every row stays mounted up to `TRANSCRIPT_TURN_CAP = 500` (`reducer.ts:4703`), and relief is the `content-visibility` skip of [F03]. A row's height is already indexed (`tugdeck/src/lib/block-height-index.ts`). **(verified, read from the code)**

**[F05] A parked workspace does not measurably pay into the walk.** A 2,068-element parked layer moved the walk by 0.02–0.08 ms (`compositing-walk-readings.md` [F07]). Larger parked layers were not read. **(verified for one size)**

**[F06] No single census term prices the walk.** Elements, stacking contexts and render-layer candidates each disagree 2–3× between the Overview arm and the transcript arm (`compositing-walk-readings.md` [F08]). A ceiling therefore cannot be one number on one term; what it can be is a reading the deck must pass. **(verified, measured)**

**[F07] The zoom stall was an over-mount.** `briefs/view-zoom-performance-and-feedback-brief.md`: 260 transcript entries over-mounted turned a 348 ms relayout into a 6–10 s stall. The same population that prices the walk prices every relayout the deck pays, zoom included. **(verified, measured)**

**[F08] The aging reading has never been taken.** `compositing-walk-and-overview-brief.md` [B03] asked for the deck's census and walk to be read fresh and after hours of use. It was not. **(verified, from the readings' empty Aging table)**

---

## Decisions {#decisions}

**[B01] The transcript list is windowed: rows outside the viewport plus a margin are not mounted.** This replaces the `content-visibility` skip as the transcript's relief, because [F03] shows the skip is not deterministic and [F04] shows the height index the window needs already exists. A row's slot keeps its measured height from the index so the scroller's extent, the follow-bottom pin and the restore anchor are unchanged; a row entering the margin mounts, a row leaving it unmounts. The 500-turn cap stays as the loaded window; what changes is how many of the loaded turns are in the DOM. Find, selection and copy are read against the window before it lands ([L23]): find over unmounted rows searches the index (stage 1 [B05] built it on open) and mounts the match.

**[B02] The Overview is windowed the same way, and its per-post sticky header becomes one list-owned pinned header.** 150 sticky elements and four stacking contexts per post ([F02]) become one pinned header that the list writes imperatively as the top visible post changes, and one stacking context per post. The card's row cap and what it shows do not change; what changes is how many of its rows are in the DOM at once.

**[B03] The ceiling is a reading, not a number on one term.** [F06] rules out a single census threshold. The ceiling is: `tugtool deck motion walk`'s baseline on the user's deck, aged, stays within the fresh deck's reading by a stated margin, and the census is recorded beside it. The arc states the margin from the first paired fresh-and-aged reading it takes.

**[B04] The aging reading is taken first and last.** [F08]. Before anything is built: census and walk on the user's deck at launch and after a working day, with three sessions having streamed through it. After the stage lands: the same pair. This is the stage's reading of record, alongside stage 1's streaming arm on the gestures.

**[B05] `tugtool deck motion layers` carries the census into every settle report, and the aged reading is a habit, not a step.** The settle verb already prints a census; the walk verb already reads the price. The stage adds nothing new to the instruments and asks the user's deck to be read aged once per stage from here on.

**[B06] Parked workspaces stay mounted.** [F05] says they do not pay. If a larger parked layer is later read to pay, the lever is `content-visibility: hidden` to unmounted, and the workspace switch's cost is the trade; not this stage.

**[B07] Nothing visible changes.** Every row the user can scroll to is still there, every post the Overview showed it still shows, every pin and anchor behaves as before. A screenshot before and after at the same scroll position is the same picture. The row count the Overview holds is unchanged; whether it should hold fewer remains the user's product call and is not taken here.

---

## Open Questions {#open-questions}

- **What margin does the window need so that fast scrolling never shows an unmounted slot?** Settled by looking on the user's deck at the largest transcript; the index gives the heights, so a mount is one row's render, not a parse.
- **Does the engine re-decide compositing when a row mounts into the margin during a settle?** [D9] forbids creating a layer inside a settle. A row mounting mid-fold is a layer transaction. The window must hold its mounted set from `arm` to land, which the motion gate's observer hold already shapes (`gesture-scope.ts:420`).
- **What does an aged deck look like after stages 1 through 3?** Unknown until read; [B04].

---

## Non-goals {#non-goals}

- **Changing what the Overview shows or how many posts it holds.** The user's product call, stated in `compositing-walk-and-overview-brief.md` and still open.
- **Cutting stacking contexts card by card.** [F06]: no term is the price. The window removes whole subtrees and that is the only cut that reads.
- **`will-change` or layer hints.** Measured to buy nothing against the walk.
- **Unmounting parked workspaces.** [B06].
- **Canvas-rendered transcripts.** The program brief's non-goal.

---

## Exit {#exit}

**An arc.** The shape: the paired fresh-and-aged reading on the user's deck; the transcript window on `TugListView` over the height index with find, selection, pin and restore read against it; the Overview's window and single pinned header; the mounted-set hold through a settle; the ceiling stated from the readings and the paired reading taken again at the join, written into the program brief's record.
