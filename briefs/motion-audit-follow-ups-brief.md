# Motion audit follow-ups

**Purpose:** The post-fixups audit of 2026-10-06 found the motion architecture sound and three things it could not sign off: the release verb's verdict disagrees with the app-tests' bar on every show gesture, a 50 ms gap inside the motion on the user's deck has no cause named, and `at0040` case 5 has been red for four runs with no owner. This brief records what was read on the user's deck after the set-up cuts and decides what to do with each.

---

## Purpose {#purpose}

The user asked, after the `motion-audit-fixups` arc joined as `cd6930a2f`: "Do we need to make fixups? Or, can we move on from here with confidence that the codebase is in good shape?" The audit's answer was that the code is in good shape and no fixups arc is needed, with three items to ride the next arc's first step rather than wait for one of their own. The user said: "Brief this."

The three items are small, but each one blocks a claim the architecture is now supposed to make. The verb is the only instrument the user has on the release build, and it must say what the tests say. The sealed-motion clause is the whole point of set-up-and-go, and a gap nobody can name is a gap nobody can close. A red that nobody owns teaches everyone to skim past red.

---

## Evidence {#evidence}

**[F01] The after-cut readings on the user's deck.** Taken 2026-10-06 about 23:40 UTC on the user's `release-main` deck, whose `Info.plist` names `cd6930a2f` as its build commit. The deck had been relaunched and held 8,209–8,349 elements, against 23,500 for the before readings in `briefs/real-transcript-motion-readings.md`, so the shapes compare and the absolutes do not. Loops were stilled with `tugtool deck motion demote on` for the readings and restored after; recording was switched on with `tugtool deck motion record on` and off after; `--reload` was not used, so the commit census and lead recorder were not in the page and the `sealed` clause read "not counted". The rails toggle, the Layout sidebar's hide and show, and resize-to-fit were each driven by `tugtool deck motion settle --count 3 --chains --json`. **(verified)**

| Gesture | Lead ms | First beat ms | First beat before | Forced layout in set-up | Mid-motion gap | Land |
|---|---|---|---|---|---|---|
| rails ×3 | 12–16 | 100–109 | 291–295 | one, 38–41 ms | 50–52 ms, 2.94–3.06 frames against 2 | 55–66 ms, passes by the shrink ruling |
| sidebar ×3 | 22–24 | 65–73 | 118–129 | none over 2 ms | 18–23 ms, 1.06–1.35 frames | 17–23 ms, 1.00–1.24 frames |
| fit ×1 | 11 | 62 | 162 | none | 50 ms, 2.94 frames against 2.5 | 19 ms, 1.12 frames |

**[F02] The container-size chains are gone, and one chain remains.** The `_placeRunHeight` and `_flowBandEdges` reads the fixups arc cached no longer appear: sidebar and fit read 0–2 ms of chains in total. The one chain left, on rails, is a `clientHeight` read in a `useLayoutEffect` of `tugdeck/src/components/tugways/tug-list-view.tsx`, the effect beside `auditLedger` that returns when `clientHeight === 0`, called from React's commit after 23 property writes. It costs 38–41 ms and runs in the set-up task, before the first beat. The forced layout moved to the next reader, as the 2026-09-30 cache revert predicted. **(verified from the chain census's call site in the release bundle, `index-CXciOJym.js:236:70479`)**

**[F03] A 50 ms gap inside the motion on rails and fit has no named cause.** The `settle-frames` rows read `motionLongestGapMs` of 51–53 with an empty `motionForcedLayouts`, so the gap is a React commit or another main-thread task, not a layout. The harness legs in `tests/app-test/at0706-settle-sidebars.test.ts` are green on the same bars. The reading was taken while the audit's own session was streaming into the deck, and the census and lead recorder were not in the page, so what ran in the gap was not recorded. **(the gap is verified; its cause is not)**

**[F04] The verb's off-curve clause is stricter than the test's, and reads red on every show.** The rails show read 27 off-curve ticks on five panes: Workspaces, Overview, the Layout pane and two rail affordances. The sidebar show read 28 ticks on the arriving Layout pane. `at0706` exempts from the pose clause the frames that ARRIVED in a show gesture, held at inline `opacity: 0` across the `room` beat, and proves the exemption was earned by checking the probe's minimum opacity and the arrive beats. The verb's verdict in `tugrust/crates/tugtool/src/commands/deck_motion_verdict.rs` judges every pane in `offCurvePaneIds` with no exemption. So the verb prints RED on your deck for a leg the test reads green. This is the same class as the per-leg bars the arc audit corrected in `6c0028148`: the bar exists in two implementations, a TypeScript fixture and a Rust verdict, and they have now drifted twice. **(verified by reading both)**

**[F05] The height violations on the sidebar rows are the declared tween, not a defect.** Four `settle-frames` rows carried `violations: ["<Workspaces pane>:height"]`. That field lists every paint-property animation seen, and the sidebar's `room` beat declares `height` on the Workspaces rail member, which is the [D9] hit `tuglaws/animation-doctrine.md` records as decided. Nothing moved after the land. **(verified)**

**[F06] `at0040` case 5 is red with no owner.** `tests/app-test/at0040-multi-tab-close-confirm.test.ts` case 5, "an active pane half out of the band is brought whole in before the confirm opens", has been red in the last four recorded runs, from `945a75050` through `7fcfaaefc`, in batches of 20 and 105. The arc audit of `motion-audit-fixups` read the cause: a wheel pan now jumps a whole slot, so 350 px of wheel moved the deck 705 px and the setup can no longer place a pane half out of the band. The slot jump is the product; the case's setup is what broke. **(verified from the ledger and the audit's reading)**

**[F07] The rest of the audit is clean.** The motion audit's six rules, the new `oxlint` pass, `tsc`, the visibility, type-alignment and token audits, and the tugdeck unit suite at 11,403 green. The crossing ledger ends every mark on every exit, the gate is the one hold, held deliveries release on disconnect, and the laws the arc touched hold. No arcs or worktrees are open. **(verified)**

---

## Decisions {#decisions}

**[B01] The verb and the fixture read one bar, and the verb gets the arrived exemption first.** The immediate act: the verdict exempts from the off-curve clause every pane that arrived in the gesture, derived from the `settle-beat` rows with the `arrive` recipe in the same window, under the same earned-exemption rule `at0706` applies, with a Rust unit test holding a show leg with and without arrivals. Then the drift is closed at its root: the clauses are computed once, in one place both readers consult, so a third divergence cannot happen. Where that place is, see Open Questions. Two implementations of one bar is the defect; the exemption is only its latest symptom.

**[B02] The 50 ms gap is attributed before anything is cut.** One reading of rails and fit on the user's deck with `--tasks --reload --count 3`, taken when no session is streaming into that deck, so the commit census and lead recorder are in the page and every commit in the gap has a cause. Until that reading names it, nothing claims the sealed motion on the user's deck, and no fix is proposed, because a 50 ms task could be a held tell released early, a commit the gate does not hold, or the reading session's own transcript. The harness is green and the user's deck is not, which is the history of every motion bug in this project.

**[B03] `at0040` case 5 gets a new setup, not a new product.** The slot jump is the user's product change and stays. The case's premise, a pane half out of the band, is still worth pinning, so the setup finds a different door to that state, such as a band offset written through the harness rather than a wheel pan. If no door exists, the case is deleted with a line saying the premise no longer has a way in, and the other cases stay. Loosening the assertion is not an ending.

**[B04] The list-view layout read stays where it is.** [F02]'s 38–41 ms is set-up, inside the lead budget, and it is the one layout the commit has to pay somewhere. It is recorded here as the next set-up cut, with the reading that prices it, and it is not this work's to move. Moving it would hand the layout to the next reader again unless the reader that needs the measurement is found first.

**[B05] These three items ride together, in this order.** The exemption first, so the readings in [B02] are read against the true bar. The reading second. The `at0040` ending third, since it depends on nothing above. Each is small; together they are one step's worth.

---

## Open Questions {#open-questions}

- **Where the one bar lives.** The fixture's `expectB09Bar` runs in the test process and the verb runs in Rust against trace rows read through the eval door, so neither can import the other. The candidates: the page computes the clauses and writes them to the `settle-frames` row, with the fixture and the verb both reading the row's clauses; or the clause logic moves to a pure TypeScript module under `tugdeck/src/lib/motion-guard/` that the fixture imports and the verb executes in the page by eval. The per-leg bars `at0706` sets and the arrived exemption have to reach whichever place is chosen. Settled by reading what the fixture needs that the page cannot know.

---

## Non-goals {#non-goals}

- **A fixups arc of its own.** The audit found no architectural gap. These items are one step's worth, and the brief exists so they are not lost, not so they become a project.
- **Cutting the list-view layout read.** Recorded in [B04] as the next cut, with the reading, and not done here.
- **The workspace switch and the session body's first frame.** Each has its own brief, `briefs/workspace-switch-motion-brief.md` and `briefs/session-body-first-frame-brief.md`, and each is the next arc after this.
- **Reading the user's deck with a session streaming into it.** [F03] is the record of why not.

---

## Exit {#exit}

An arc, small. Its first act is the verb's arrived exemption with its unit test ([B01]), then the choice of where the one bar lives and the move that makes both readers consult it. Its second is the `--tasks --reload` reading of rails and fit on the user's deck at rest ([B02]), with the cause of the gap written into `briefs/real-transcript-motion-readings.md` beside the after-cut table from [F01]. Its third is `at0040` case 5's new setup or its deletion ([B03]). Done when the verb's verdict on a show gesture matches `at0706`'s reading of the same gesture, the gap has a named cause, and `at0040` is green or the case is gone with its reason written.
