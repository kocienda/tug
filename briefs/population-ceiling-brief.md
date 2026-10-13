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

**[F09] (Added at the arc door.) The transcript is already windowed, which [F04] misses.** `TugListView` has an `evictOffscreen` mode (`tug-list-view.tsx` near `:1183`, landed in `650da0c23` and hardened through `d945bca09`) that unmounts rows outside the scrollport ± a margin and stands exact-height spacers from the `HeightIndex` in their place, with a wider exit margin than entry margin and selection/focus rows pinned. The transcript passes `evictOffscreen={!transcriptEvictionDisabled}` (`session-card-transcript.tsx` near `:3425`), on by default; only a lab flag withholds it. Eviction **suspends** — mounts every row — whenever any row outside the window lacks a measured height (`coversRange`): mid-batch-load and after a width change. So [B01] is not new work as written: the transcript's open question is how often, and for how long, the suspension leaves the full population mounted on the user's deck, and whether the walk reading [B04] shows the transcript arm paying at all. The Overview (`overview-card.tsx`) is not a `TugListView` and has no windowing. **(verified, read from the code)**

**[F10] (Added at the arc's first reading.) Tripling the mounted population did not move the harness walk past its noise, and the deck's reflowing settles never reach an evicting transcript.** `at0727` read a four-up deck fresh (5,422 elements, 533 stacking contexts, 30 Overview posts) and aged (15,913 elements, 1,424 stacking contexts, 150 posts all mounted, three streamed transcripts of 16 rows evicting to 6): the mean baseline walk went 4.97 → 5.60 ms against a fresh spread of 1.33 ms, which is the ceiling margin, and neither the `overview-absent` nor the `transcript-absent` arm read as moved. The user's deck as found (30,097 elements, 90 posts, up 1 h 18 min) read 5.58 ms with a spread of 4.82 and no arm moved. A fold and a column split on the resumed card left the evicting transcripts at 6 mounted rows with no eviction fallback, so the full mount [F09] names is reached by a width change on an evicting transcript (a pane drag, a direct width write), not by those gestures on this deck; `at0330`'s reflow case is the transcript's verdict, and the census beside the walk is what the after-reading compares. The readings are in `compositing-walk-readings.md` (#aging-reading). **(verified, measured)**

---

## Decisions {#decisions}

**[B01] The transcript list is windowed: rows outside the viewport plus a margin are not mounted.** This replaces the `content-visibility` skip as the transcript's relief, because [F03] shows the skip is not deterministic and [F04] shows the height index the window needs already exists. A row's slot keeps its measured height from the index so the scroller's extent, the follow-bottom pin and the restore anchor are unchanged; a row entering the margin mounts, a row leaving it unmounts. The 500-turn cap stays as the loaded window; what changes is how many of the loaded turns are in the DOM. Find, selection and copy are read against the window before it lands ([L23]): find over unmounted rows searches the index (stage 1 [B05] built it on open) and mounts the match.

**[B02] The Overview is windowed the same way, and its per-post sticky header becomes one list-owned pinned header.** 150 sticky elements and four stacking contexts per post ([F02]) become one pinned header that the list writes imperatively as the top visible post changes, and one stacking context per post. The card's row cap and what it shows do not change; what changes is how many of its rows are in the DOM at once.

*As built:* a post on a dark theme carried four stacking contexts of its own, read off the harness before the change: the entry root's containment, the sticky pin, the COPY button's baseline `transform`, and one `contain: content` per markdown block. Three are cut with constructions that draw the same pixels (screenshots at rest, mid-post and push-up are byte-identical before and after), and the entry root's containment is the one that stays. One exception is kept, because cutting it would change what a reader sees: on the light themes the speaker icon wears a drop-shadow halo (`filter`, from `--tug7-element-global-shadow-normal-iconHalo-rest`), which is a stacking context per post, so a light-theme post carries two. A code block's sticky header, or a table's, keeps its context too, because it pins while its block is in view. So does a live session dot in a post's provenance strip: the user's deck as found had 74 of 147 posts carrying one, four stacking contexts each, from the pulse it draws on screen, and the pulse is what tells a reader the session is live.

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

*Answered as built.* The margin is a viewport each way to mount and two to keep (`EVICT_MOUNT_MARGIN_VIEWPORTS`, `EVICT_RETAIN_MARGIN_VIEWPORTS` in `internal/list-view-window.ts`), plus at most one measure segment of eight rows a commit for heights not yet measured. The mounted set is held from the gate's close to its release: a commit under the gate renders the window, segment and row count the last unheld commit rendered, and the observers are `heldResizeObserver`s. So no row mounts into a settle. Both answers hold for the transcript and the Overview, which share one implementation. The aged deck's readings are in the program record.

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

**Outcome.** The ceiling is that the aged deck's mean baseline walk stays within the fresh deck's plus 1.33 ms, the fresh reading's own spread. It was proved on the harness, where `at0727` asserts it with three companion checks: the Overview mounts fewer posts than it holds, no reflowing settle mounts a whole transcript, and every moving settle is sealed. Aging that deck from 30 to 150 posts, three streamed transcripts and a full sweep now takes it from 4,209 to 6,960 elements and 367 to 538 stacking contexts, where it used to go from 5,422 to 15,913 and 533 to 1,424. The mean walk went from 4.27 to 5.10 ms, inside the margin. The Overview mounts the posts near its scrollport, 11 of 150, and each carries one stacking context of its own, with one column-owned header in place of 150 sticky pins. The transcript keeps a stale height through a reflow and re-measures in capped segments, so a width change mounts the window plus at most one segment rather than every row. Owed: the user's-deck reading of this code after the join, as found with its uptime, and the fresh arm at the next relaunch. Until then the user's deck runs `main` and reads 38,056 elements at 2 h 22 min, with all 147 posts mounted (`compositing-walk-readings.md` #aging-reading).

**Fixup (2026-10-12).** The cold paths this outcome left are taken up by `briefs/population-ceiling-cold-paths-brief.md`: the full mounts at open, on reveal, under a held settle, and through a reflow or a zoom. The owed user's-deck reading of this code was taken after the join, as found at 6 h 07 min. It reads 29,496 elements with 21 Overview posts mounted and a 4.17 ms mean walk, though a parked Overview pane still holds 10,998 elements. The fresh arm and the cold paths' own pair are slotted in the aging table's "cold paths" rows.
