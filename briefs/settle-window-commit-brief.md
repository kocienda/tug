<!-- brief-skeleton v1 -->

# The large React commit inside the settle window

**Purpose:** Every settle leg that was red on a real reading had the same thing in it: one React commit of two to four thousand fibers landing inside the settle window, under the tween. The commit is there by design, since [D204] moves it past the first painted frame on purpose; its size is not. This brief is about rooting out what makes it large and cutting it, gesture by gesture, with the instrument that already names each commit's cause.

---

## Purpose {#purpose}

The user, 2026-10-03, after the third audit and three more arcs:

> There's also the *frustratingly lingering* issue of a big React commit during an animation. We need to root that out and fix it.

Two days of readings agree on the shape. `tests/app-test/at0654-deck-settle-standing-reds.test.ts` carried five red legs with their readings beside them and was deleted on 2026-10-03 (`a6232e3ac`, on the user's word); `tests/app-test/settle-frames-fixture.ts`'s header now says of those five: "each one large React commit landing inside the settle window". Three other bars were re-budgeted the same day, and the cause written beside each is a commit.

---

## Evidence {#evidence}

**[F01] The deck's React commit lands inside the settle window by design.** `DeckManager.notify` (`deck-manager.ts:2752-2766`) tells its sync subscribers inline and schedules its React subscribers through `scheduleAfterPaint`, so the commit lands one task after the first painted frame of whatever `arm` launched ([D204]). The gesture scope (`lib/gesture-scope.ts`) holds every other store's tell to the same release. That is correct: the first frame is the commit's to miss. Every later frame of the settle is where the commit now lands, and a 400 ms settle (`IMPOSITION_SETTLE_MS`) has twenty-three of them. **(verified, read)**

**[F02] The five standing reds were each one large commit under the tween.** From `briefs/zero-red-app-tests-brief.md`, the readings `at0654` carried when it was deleted:

| Leg | Reading | Bar | The commit |
|---|---|---|---|
| Warm flip | lead 18 ms | 17 ms period | largest 257 fibers; lead not attributed |
| Unfold | 2.24 frames | 1.5 | interior re-render from `data-folded` |
| Card departure | 2.24 frames | 2 | 2,965 fibers: closing a pane renumbers every survivor's position label, each survivor's rollup popover tree re-renders |
| Showing a two-member rail | 3.00 frames | 2 | 4,501 fibers: the rail's contents mount inside the window |
| Column split | 3.35 frames | 2 | 2,621–3,289 fibers, with real `height` tweens |

**(verified from the brief and the deleted test's header; not re-read at HEAD)**

**[F03] The re-budgeted bars name the same cause.** `at0643`'s first paint moved from one period to 100 ms; it read 45–75 ms on "one 3,899-fiber commit re-rendering both layers" of a workspace switch. `at0622`'s resize-to-fit moved from 2 to 2.5 frames at 2.06–2.18. In the flow slide (`briefs/gesture-task-without-react-brief.md` [F11]) the deferred React tells fill 17–23 ms of the first long frame, about 22 ms per click. **(verified from the briefs and the test headers)**

**[F04] `DeckCanvas` subscribes to the whole deck snapshot, and so does every pane under it.** `deck-canvas.tsx`, `pane-focus-controller.ts` and `pane-occlusion-controller.ts` each read `useSyncExternalStore(store.subscribe, store.getSnapshot)`; seven cards and bridges do the same. `DeckState` is one object, so any commit, whatever it changed, re-renders the canvas and the whole `TugPane` tree beneath it, and every pane's props are rebuilt. `layout-card.tsx:436` already shows the other shape, `useDeckDerived`, a selector with its own equality. **(verified, grep at HEAD)**

**[F05] The instrument that names a commit's cause exists.** The lead recorder in `tugdeck/index.html` walks each commit's fibers and records, per commit, the count, the top components, the origins, and `why`: for each origin the props keys that changed, or `[state/ctx]`. `tugtool deck motion slide --tasks` reports each commit's `react_ms` (`deck_motion_slide.rs:472-561`) alongside. It drives one gesture, the flow slide between two session rows. **(verified, read)**

**[F06] Three of the five commits are not about geometry at all.** The departure's survivors re-render for a label; the rail's contents are created in the window, which the asks brief's third concept forbids outright; the switch re-renders the departing layer as well as the arriving one. Only the split and the unfold carry a commit whose content the gesture needs. **(inference from [F02]'s attributions; confirmed by [B01]'s reading)**

**[F07] The warm flip's lead is unattributed, and it is the one leg with a small commit.** 257 fibers and 18 ms against 17. That lead is the flow slide's: compositing over the deck's layer candidates and GPU drawing ([F11] of the gesture-task brief). It is not this brief's subject. **(verified from the readings)**

---

## Decisions {#decisions}

**[B01] Every gesture in the settle-frames fixture is read with the lead recorder before anything is cut, and each commit in its window is named by cause and cost.** `tugtool deck motion` grows a way to drive a fold, a pane close, a rail show, a column split and a workspace switch, with `--tasks` reporting each commit's `react_ms`, fibers, origins and `why`, as `slide` does. The rule of every graphics brief holds: nothing is designed against an unattributed cost, and no reading is written by hand. A reading on a live deck checks rest first.

**[B02] The commit is not moved out of the window; it is made small.** [D204] and the gesture scope are correct and stay. The settle window is the commit's to land in; what it may not do is take a frame. The goal is a commit under one display period on the user's deck, read as `react_ms` per commit, for each gesture.

**[B03] The canvas and the panes subscribe to what they render, not to the snapshot.** The whole-snapshot `useSyncExternalStore` in `deck-canvas.tsx` becomes selector reads with equality, in the shape `layout-card.tsx`'s `useDeckDerived` already has, and `TugPane` renders from its own pane's slice so a commit that changed one pane re-renders one pane. The focus and occlusion controllers read `activePaneId` alone. This is the one change that applies to every gesture at once, and [L02] is kept: the door's `useSyncExternalStore` with a selector is still the only entry.

**[B04] A closing pane does not re-render its survivors.** The position label is derived in the pane from a selector over the pane's own slot, so a close changes the labels that changed and nothing else; the rollup popover tree is not part of the label. Read against the departure leg.

**[B05] A rail's contents stand before the rail shows.** Showing a rail mounts 4,501 fibers in the window. The third concept of the asks brief says nothing is created inside a gesture, and a hidden rail's cards are parked, not closed; their content mounts in the hidden layer ahead of the show beat, as a parked workspace's panes do ([L23]'s third class), and the show beat moves a layer that already stands. Read against the rail leg.

**[B06] A workspace switch commits the arriving layer only.** The 3,899-fiber commit re-renders both layers. The departing layer's panes did not change; with [B03] they do not re-render. If a switch's own state reaches both, it is split so the departing layer's slice is unchanged by the switch. Read against `at0643`, whose 100 ms bar is then re-read; a bar moved on the user's word is not moved back without the user's word.

**[B07] The fixture gains a commit clause, with a bar the user sets.** `settle-frames-fixture.ts` records the largest commit in each leg's window, in fibers and in `react_ms` where the recorder is installed, and asserts it under a bar. The number is the user's call once [B01]'s readings are in; the clause exists so a commit that grows again is a red, not a reading somebody has to remember to take.

---

## Open Questions {#open-questions}

- **What is the bar for a commit in the window?** One display period per commit is the natural one; whether the user's deck can meet it for the split and the unfold, which carry real content, is [B01]'s reading to show.
- **Does [B03] alone take the departure and the switch under their bars?** If the survivors and the departing layer stop re-rendering on a selector, [B04] and [B06] may be no further work. The reading after [B03] decides.
- **How does the recorder drive a split, a close and a switch?** The settle-frames fixture already seeds and drives each; whether the verb reuses the fixture's drivers or the fixture arms the recorder is the arc's first design choice.
- **Can a parked rail's cards mount in the hidden layer without the rail's layout?** A hidden rail has no box. [B05] needs either a hidden box or a mount that is content-only until the show.

---

## Non-goals {#non-goals}

- **Moving the deck's commit back into the gesture's task, or weakening the hold.** [B02]. The asks brief's first concept stands.
- **The warm flip's lead.** Compositing and GPU drawing, not a commit ([F07]); the compositing brief's subject.
- **The `height` tween's own cost in the split and the fold.** `briefs/departing-and-height-crossing-brief.md`. [B01]'s reading separates the commit's cost from the tween's so that bench reads one thing.
- **Loosening any bar.** The three re-budgets of 2026-10-03 were the user's; this work earns them back or leaves them.
- **Readings written by hand.** If the verb cannot take the reading, the verb is extended.

---

## Exit {#exit}

**An arc.** It starts by extending the verb to drive each fixture gesture with the recorder armed, and takes the reading on a fresh release deck ([B01]). Then [B03], the selector reads, as the one cut that touches every gesture, with the reading taken again. Then whichever of [B04], [B05] and [B06] the second reading still calls for, each landed against its own leg. The fixture's commit clause ([B07]) lands last with the user's number. It is written to run after `briefs/settle-engine-and-beat-brief.md`, which gives the settle its own file, and before the height bench, which needs the commit's cost out of its reading.
