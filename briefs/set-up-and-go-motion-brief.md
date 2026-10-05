<!-- brief-skeleton v1 -->

# Set-up-and-go: every gesture pays its cost before the first frame

**Purpose:** The real-transcript readings left five settle tests red and six gestures over their bars on the user's deck, all for one reason: the work that plans a motion runs before the motion can start, and the bars counted that wait as the defect. The user has ruled the other way. Time spent before the first frame is the price of a clean motion; a judder or pause inside the motion is the defect. This brief restates the bars to that rule and names what still leaks past the set-up.

---

## Purpose {#purpose}

The `real-transcript-motion` arc (joined as `89dbd830c3`) bound every settle test's session cards to real transcripts, held every resized frame from `arm`, moved the transcript's pin, restore and rebase behind the settle, and read every gesture on the user's release deck. It ended with `at0622`, `at0684`, `at0690`, `at0555` and `at0643` red on both arms and split, slot, rails, sidebar, fit and switch over their bars on the user's deck, every one of them because the first frame waits 60–150 ms for the React commit that plans the motion.

The user, 2026-10-05, on how to proceed:

> It is *much much better* to implement the code along the lines of a *set-up-and-go* design, where the time we need to spend is placed up-front before motion starts. It is *much much worse* to have judders and pauses in the *midst of motion* because we need to do work we possibly could have planned for up front. … It's a *key part of the design I want to use from this point forward*.

And, on the finding that the set-up is too long:

> We probably need to loosen, or perhaps even remove, the *set-up is too long* constraint. Again, it is far worse to judder an animation because we weren't willing to wait another 75–100 ms for the setup to complete.

The shape is decided: **store commit → React commit → plan → beats → land.** The asks in `briefs/graphics-animations-asks.md` are unchanged and are read against real-world session cards, as `briefs/real-transcript-motion-brief.md` [B01] and [B03] require.

---

## Evidence {#evidence}

All numbers are from `briefs/real-transcript-motion-readings.md` (`## Close-out`, `## Hand-back H4`, `## Bars`) unless named otherwise. The user's deck there is the release build of `dea2461fd`, 8,067 elements, 0 updates/s at rest; the user's working deck at the arc's start was 14,000–19,000 elements ([F01] of the real-transcript brief), so every cost below scales up on it.

**[F01] Inside the motion, the gestures are already clean.** On the user's deck, every gesture's longest gap *before the land* was 17–31 ms, with 0–1 gaps over one display period (17 ms), on fold, unfold, division, stack, slot, split, rails, sidebar and fit. The frames recorded directly across three fold/unfold and three stack/divide pairs (H3's `frames-table.py`) show the same. The height tween's per-frame relayout, the real-transcript brief's [F03], is gone: the hold at `arm` and the deferred list reactions removed it. **(verified, measured on the user's deck 2026-10-05)**

**[F02] The land is the one judder left inside the motion.** The longest gap of every drive falls in the motion's last 100 ms: 45–49 ms on a fold or unfold, 35–38 ms on a division, 40–41 ms on a stack, with the flag-off (shipped) path. That frame is where the held boxes are handed back, the still-crossing mark comes off, and the list view pays its owed pin, restore and extent rebase, so the relayout the motion skipped is paid at once on a subtree the size of the card. Under the set-up-and-go rule this is a mid-motion judder, the last frame's; no bar counted it. **(verified for the gap and its position; the attribution to the hand-back and the owed work is inference from the code paths that run at `STILL_CROSSING_END` and is not yet sampled per site)**

**[F03] The set-up is 60–150 ms, and it is one React commit and one layout.** The `slot --tasks` reading on the user's deck: the planning commit performs 742–1,300 fibers in 56–106 ms of React time; the forced-layout census shows one chain of 38–47 ms on split, slot, rails and sidebar, 62 ms on fit, 65–86 ms on switch, paid at `_placeRunHeight`/`getColumnRunHeight` and `_flowBandEdges` in the canvas's layout effect, which is the first read after React's mutation phase and so pays the committed deck's layout. No transcript site is among the chains any more. **(verified, measured)**

**[F04] Most of the commit's React time is pane chrome re-rendering.** The planning commit's `top` list on the user's deck is `Presence` 40–55, `Popper`/`PopperProvider`/`PopperAnchor` 23–51, `TugButton2` 39–47, `TugEditorContextMenu` 21–30, `TugSlot2` 26–30, `ResponderScope` 25–35. Its `why` entries are `TugPaneImpl@<card>{placement, columnMember, stackState, ~sizePolicy}` for every pane the arrangement touches. Each pane frame's re-render carries its title bar, buttons and poppers with it. **(verified from the census; how much of the 56–106 ms the chrome accounts for is not separated and is the first thing to read)**

**[F05] The set-up has not been counted as a cost the user accepts, so every lead and beat-start bar is red on it.** `at0622`'s appear (93–105 ms), disappear (beats start at 93–108 ms), bullseye enter (42–121 ms) and sidebars hide (91–104 ms); `at0690`'s seat into a column (95–98 ms) and one-sidebar hide (53–57 ms); `at0555`'s fold clock (116–128 ms against 105); `at0643`'s first switch frame (138–149 ms against 100, 110–121 ms of it React's render). On the user's deck: split's first beat at 65–78 ms, slot 102–114, rails 81–87, sidebar 71–79, fit 79, against a one-period bar. Every one is the set-up's length. **(verified)**

**[F06] The flow slide is the one gesture built the other way, and it is the one that still drops frames mid-motion.** The deck store's React-facing notify is deferred past the next painted frame (`deferredNotify` and `scheduleAfterPaint` in `tugdeck/src/deck-manager.ts`), so the slide's tween launches at `arm` and the React commit lands while the strip is moving. `briefs/gesture-task-without-react-brief.md` [F02] and [F07] record the design; the readings since it landed attribute the slide's remaining dropped frames to that commit landing mid-settle, and the asks brief's "often drops many frames" is this gesture. On the user's deck at H4 the slide read within its bars (first beat 20–34 ms, longest gap 28–32 ms) on a quiet deck with no streaming card. **(verified for the design and the H4 reading; the mid-motion commit as the cause of the dropped frames the user sees is the earlier readings' finding, not re-measured here)**

**[F07] The workspace switch has a different and unread cause.** Its longest gap is 158–414 ms on the user's deck, its forced-layout census is 23 chains totalling 130–160 ms with a longest of 65–86 ms, and its React render is 110–121 ms. It is the only gesture whose numbers did not move between H1 and H4. Nothing in the last arc touched what a switch does. **(verified for the numbers; the cause is not decomposed)**

**[F08] Four reds are test defects, not motion.** `at0622`'s "one row per settle" disagrees with the probe by 1 ms (19 vs 20, 30 vs 29) on a clock that is rounded to whole milliseconds. Its "arrival interrupted by a close" issues the close at a fixed 140 ms, and on this tree the arrival has landed by then, so the leg records no retarget and cannot reach the defect it tests. Go-to-slot home reads 19–20 ms against 16–17, a margin inside the measurement's noise. `at0684`'s `COMMIT_BAR` bars fibers performed, which the real-transcript brief's [F06] already found blind to forced layout; its millisecond bars (`MAIN_THREAD_BAR_MS`) hold on every leg. **(verified)**

**[F09] The land's cost is not instrumented.** `settle-frames` records the longest gap and where it fell; the beat rows record each beat's start and landing; nothing records what runs in the land frame or how long it takes. The land gap in [F02] was read from a hand-rolled `requestAnimationFrame` recorder in H3 (`frames.sh`), not from a shipped instrument. **(verified, read)**

---

## Decisions {#decisions}

**[B01] The shape of every gesture is store commit → React commit → plan → beats → land, and the set-up pays every cost before the first frame.** The set-up is the store commit, the React commit, its layout, the transcript's reaction to its new geometry, and the planning of the beats. The beats touch compositor properties and nothing else; no React commit, forced layout or `ResizeObserver` delivery lands between the first frame and the land. The land is a hand-back and nothing more. This is the user's rule, stated 2026-10-05, and it inverts the "motion before React" concept the asks brief put first: launching a tween and letting React commit under it moves the cost into the motion, which is the one place it may not go.

**[B02] The set-up's length is not a bar.** Lead and beat-start are recorded on every leg, as readings, and are not asserted. The user has said plainly that another 75–100 ms of set-up is preferred to a judder. If a set-up grows past what a user reads as a response, that is a product reading on the user's deck, not a harness red, and it is the user's to raise. The one-period lead bar and the one-period beat-start bar in `at0622`, `at0690`, `at0555` and `at0643` are removed; what they measured is kept as a `note()`. `COMMIT_BAR` goes with them, superseded by `MAIN_THREAD_BAR_MS`, which stays as a regression guard on the set-up's cost rather than as a bar on its length.

**[B03] The hard bars are inside the motion and at the land: no gap over one display period from the first frame to the land, and a land of one frame.** Both are read on real transcripts, both arms, and on the user's deck. The land gets its own instrument: the settle's record carries the land frame's duration and what ran in it (commits, chains, deliveries), and the bar on it is one period. [F02]'s 35–49 ms land is the red this brief exists to close, and it is red today on every height-bearing gesture.

**[B04] The land is pre-paid.** Whatever the land does today that costs 35–49 ms either moves into the set-up or is proven to be one frame. The candidate is to lay the held transcripts out at their *final* height inside the set-up, under the hold, before the first frame, so the hand-back at the land changes no geometry and the owed pin, restore and rebase find nothing to do. Where some work cannot be pre-paid (a streaming card's rows arriving mid-motion), it is deferred past the land by a frame rather than paid in the land frame.

**[B05] The motion is sealed by a gate, not a convention.** While a settle is in motion, every store's React-facing notify is held and released after the land, and the instrument asserts zero React commits, zero forced-layout chains and zero `ResizeObserver` deliveries inside the window. The gate generalizes the deferred-notify hold the deck store already has into the motion's whole span, and it is what makes [B01] a property of the engine rather than of each gesture's author. A gesture that arrives mid-motion is a retarget and runs its own set-up at once, as today.

**[B06] The flow slide moves to the same shape.** Its commit leaves the motion and joins its set-up: the strip launches after the commit has landed, like every other gesture. This retires the deferred-notify design for the slide and reverses `briefs/gesture-task-without-react-brief.md` [B01]'s direction for it, which that brief's own [F07] showed met the one-frame lead only sometimes. The slide's lead grows by its commit; its frames stop dropping. The swipe-from-hand path (`briefs/flow-swipe-one-move-brief.md`) is read against the new shape before it is touched, since a hand that is still on the glass is a different case from a click.

**[B07] The set-up is shrunk where shrinking is cheap, and never at the motion's expense.** [F04]'s pane-chrome churn is the obvious cut: an arrangement change re-renders the frames and not their buttons and poppers. One layout, not several. This is pursued as ordinary performance work inside the arc, after the hard bars hold, and nothing in it is allowed to move work from the set-up into the motion.

**[B08] The workspace switch is its own body of work.** [F07] is a different cause at a different scale, and it has the asks brief's own line ("never pauses, delays, or drops frames"). It is decomposed with the same instruments (`--tasks`, chains, the land record) before anything is decided, and it is not folded into the settle work.

**[B09] The four test defects in [F08] are fixed before the arc joins.** The row-against-probe clause takes a one-millisecond tolerance. The interrupted-arrival leg issues its close relative to the arrival's `room` beat rather than at a constant. Go-to-slot's lead clause goes with [B02]. `COMMIT_BAR` is removed. None of these is a design decision. They were meant to land on `main` before the arc opened and did not. On 2026-10-05 the user ruled that the arc carries the two still open (the tolerance and the close timing), and the arc joins with `at0622` green.

**[B10] The user's deck remains the reading of record, and the readings follow set-up-and-go.** Each change lands with `tugtool deck motion settle` on the user's deck, with the land frame and the in-motion gaps as the numbers that decide, and the set-up's length recorded beside them. The real-transcript brief's [B03] and the doctrine line it added stand.

---

## Open Questions {#open-questions}

- **What runs in the land frame, by site and millisecond?** [F02] names the gap and [F09] says nothing instruments it. The arc's first act is the land instrument; [B04]'s design depends on what it shows.
- **Can a transcript be laid out at its final height under the hold without the user seeing it?** The hold keeps the interior still at its First height today; laying it out at Last behind the same mark means the clipped picture is of the new height from the first frame. On a growth this is likely invisible (the extra rows are under the clip); on a shrink the picture's bottom edge is the question. Settled by looking, on the user's deck.
- **How much of the set-up is chrome?** [F04] gives the fiber mix, not the milliseconds. One `tugtool file probe` with the pane chrome memoized, read with `slot --tasks`, answers it and decides how much [B07] is worth.
- **Does the slide's longer lead read as a delay on a trackpad swipe?** [B06] moves the commit ahead of the strip's motion; a swipe that already tracks the hand is a different gesture from a click, and the brief defers it. The user's reading decides.

---

## Non-goals {#non-goals}

- **Motion before React, for any gesture.** Launching a tween and committing under it is the shape this brief retires. The asks brief's first concept is superseded by [B01].
- **Shortening the set-up as the main line of work.** [B02] removes it as a bar; [B07] keeps it as ordinary performance work behind the hard bars.
- **Height by translation.** Benched twice, the second time on real transcripts and the user's deck: it moved the relayout to the land and made the land worse (55–65 ms against 45–49). [B04] pre-pays the land instead.
- **Loosening the in-motion gap bar or the land bar.** They are the asks' bars under the user's rule.
- **The compositing walk and the Overview's size.** `briefs/compositing-walk-and-overview-brief.md`; a floor every frame pays, not a leak into the motion.
- **A content-visibility or row-skipping lever on the transcript.** Only if [B04]'s pre-paid layout does not fit; not before.

---

## Exit {#exit}

**An arc, carrying [B09].** Its shape, in the order the work must land:

1. The land instrument: the settle's record gains the land frame's duration and what ran in it, with the one-period bar on it in `at0622` and `at0690`; the set-up's lead and beat starts become notes. Read on both arms and the user's deck to establish the land's baseline by site.
2. The motion gate ([B05]): every store's React-facing notify held from the first frame to the land, with the instrument's zero-commit, zero-chain, zero-delivery clauses. Read first on the gestures that are already clean inside ([F01]), where it should change nothing.
3. The land pre-paid ([B04]) for the height-bearing gestures: fold, unfold, division, slot, rails, sidebar, fit. Read against step 1's baseline; the arc's central reading.
4. The flow slide onto the same shape ([B06]), with the swipe path read before it is touched.
5. The set-up shrunk where cheap ([B07]), read with `MAIN_THREAD_BAR_MS` and the user's deck.

Each lands with the user's deck read before and after. The arc is done when every gesture reads zero gaps over one period inside the motion and a one-frame land on the whale arm and the user's deck, or when a gesture that cannot is named with its cost and its cause. The workspace switch ([B08]) is worked on `main` from 2026-10-05, outside this arc, to close `at0643`'s in-motion gap.
