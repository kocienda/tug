<!-- brief-skeleton v1 -->

# Every gesture read against real-world session cards

**Purpose:** Three days of graphics work were measured on harness fixtures whose session cards carry empty transcripts. On the user's deck the first gesture tried, Go-to-slot into a split column, stalled 130 ms before its first frame and dropped frames after it, and the cause is the session card's own reaction to a height change, which an empty transcript never pays. Every ask in `briefs/graphics-animations-asks.md` is to be read again, and held, against session cards with real transcripts, because that is what users have.

---

## Purpose {#purpose}

The user, 2026-10-04, on a relaunched release after the fourth audit's fixups joined:

> The *first thing* I did was select the hazy-radio session card in slot #3 and did the ⌘2 shortcut to move it to the bottom of the slot #2 split. The result was: ***JUDDER CITY***. How can it be that, after all this work, we are basically ***NO CLOSER*** to getting smooth animations.

And, on hearing that every reading had been taken on empty transcripts:

> Colossally bad premise for basing days of work. Session cards ***have non-empty transcripts in real usage***. … Brief this and all the other cases in `briefs/graphics-animations-asks.md` against ***real-world session cards***, since that's what users will have.

The asks are unchanged: card appear and disappear, split layout, fold and unfold, the flow slide, Go-to-slot, bullseye, sidebar hide and show, resize-to-fit, loops, no activation fade, workspace switch, with the bar the asks brief set: lead at most one frame from the gesture, no gap over one frame, nothing created or destroyed in a gesture. What changes is the deck they are read on.

---

## Evidence {#evidence}

**[F01] The gesture on the user's deck: a 130 ms stall between planning and the first frame, then two dropped frames.** Read twice on the user's release deck (`tugtool deck motion gesture` armed from outside, the deck trace on, `tugtool deck motion chains` armed on the second run). Census 13,986–18,813 elements, 8 panes, the largest cards `tug/syrupy-winch` 4,738 elements, Overview 3,671, `tug/hazy-radio` 1,752. At-rest render cost p50 1 ms, p95 5 ms, 5–6 updates/s.

| Event | Run 1 | Run 2 |
|---|---|---|
| `_commitImposition` store commit, settle armed, 8 panes | 0 ms | 0 ms |
| React `commit-tick`, Last pass plans the beats | +18 ms | +15 ms |
| Transcript `extent-rebase` row | — | +153 ms |
| Beats' first painted frame (`settle-beat.startDelayMs` 127 / 117 from planning) | +145 ms | +132 ms |
| Longest gap, outside recorder | 135 ms | 139 ms |
| Gaps after the stall | 45, 48 ms | 36 ms |
| Beats | `shrink` declaring `height` on 2 frames, `move` on 1 | `grow` declaring `height` on 2 frames, `move` on 1 |

**(verified, measured on the user's deck, 2026-10-04)**

**[F02] The stall is the session cards' reaction to their height change, inside the gesture's React commit.** The chain probe over the second run (a lower bound; it truncated at 4,000 entries) ranked, inside React's layout-effect pass: nine `clientHeight` read→write→read chains from transcript code (`index:235:68528` under the React commit frames), six and four `scrollTop` chains from `applyRestoreTarget` and the transcript's scroll handling, two `clientHeight` chains from `pinToBottom`/`maybePinToBottom`, two from `_placeRunHeight`/`getColumnRunHeight`, two `clientWidth` from `_flowBandEdges`, and one `scrollTop` from `applyProjection`. The writes between the reads are CodeMirror's measure cycle and the transcript's own style writes. Each read after a write is a full relayout of a transcript at its new height. The two session cards whose column divided (1,679 px into 1,074 + 600) were the frames carrying the `height` term. **(verified for the chain census and the attribution to the transcript; per-chain cost in ms not separated, the probe records chains and stacks, not durations)**

**[F03] The frames after the stall are the height tween relaying out the transcripts every frame.** The `shrink` and `grow` beats declare `height` on the two session frames, the standing [D9] hit. A transcript whose box height changes each frame lays out each frame; the 36–48 ms gaps follow the stall and end with the beat. **(inference from [F01] and the declared term; the per-frame layout cost is not sampled; `tugtool deck motion slide --sample` samples only the slide)**

**[F04] No reading of any settle gesture was ever taken on a session card with a transcript.** `at0622`'s fixture is "a four-up FLOW deck … `componentId: "session"` because a session card is the heaviest thing the deck holds", and its session cards are unbound: no session, no turns, an empty transcript. `at0684`, `at0566`, `at0605`, `at0555`, `at0582`, `at0583` and the height bench `at0685` read the same cards. Every `*-readings.md` from the last three days is harness-only; the release-deck readings were deferred in `briefs/settle-window-commit-readings.md` ("not taken, for reading 1's reason") and in `briefs/graphics-audit-four-fixups-brief.md` [F10]. The only release-deck readings taken were the flow slide's, which moves frames by transform and touches no height. **(verified, read from the fixtures and the readings)**

**[F05] The height bench was rejected on a fixture where the height tween cost nothing.** `briefs/departing-and-height-crossing-brief.md` [F10]: "Taking the `height` tween out of the fold does not move its gap … the fold's remaining hole is the commit's." True on an empty transcript. [F01]–[F03] say that on a real transcript the height tween's per-frame relayout and the commit's forced layouts are both the cost. The bench answered the wrong deck; its design was not disproved. **(verified from the brief and [F01])**

**[F06] `COMMIT_BAR` bars fibers, and fibers do not see a forced layout.** `at0684` bars each leg's largest in-window commit in fibers performed; a commit of 45 fibers whose layout effects force nine relayouts of a transcript reads as small. `react_ms` is not barred and is not readable on a release deck without a reload. **(verified, read)**

**[F07] The harness can carry real transcripts.** `tests/app-test/fixtures/sessions/` holds committed, sanitized, real-derived session slices resumed through the production picker, spawn and reveal path (`session-transcript-basic.jsonl`, `session-transcript-margins.jsonl`, …), made with `fixtures/sanitize.ts --turns N`; the README says perf legs use a gitignored local `corpus/` of whale-class sessions and `skipIf` when it is absent. `driveSession(cardId, { op: "ingestFrame" })` on the test surface feeds a bound session card frames directly. Nothing stops a settle fixture from seeding session cards with real transcripts; nobody did. **(verified, read)**

**[F08] The user's deck is the reading of record, and the verb cannot drive the gesture that failed.** `tugtool deck motion settle` drives flip, fold, unfold, close, rails, split and switch; `window.tugdeck.lab.drive` has no Go-to-slot, bullseye, resize-to-fit or sidebar hide. `flip` on the user's deck armed no settle. The `--tasks` reading reloads the deck to install the lead recorder, which is why it was never run on the working deck. **(verified, run)**

---

## Decisions {#decisions}

**[B01] The settle fixture's session cards carry real transcripts, and every settle test reads them.** The four-up and eight-card fixtures in `settle-frames-fixture.ts` bind their session cards to the committed real-derived sessions at two sizes: a committed slice of the order of the user's smaller cards (about 1,500 elements) that runs everywhere, and a whale-class session from the local corpus (about 5,000 elements, `skipIf` absent) for the legs that bar frames. `at0622`, `at0684`, `at0566`, `at0605`, `at0555`, `at0557`, `at0563`, `at0582`, `at0583`, `at0621` and `at0643` read the bound fixtures. Every bar stands as it is; a leg that goes red on a real transcript is a reading, not a regression to wave off, and it is the subject of this arc.

**[B02] The gesture door drives every ask.** `lab.drive` and `tugtool deck motion settle` gain Go-to-slot (card to a slot, into a split column's top and bottom), bullseye in and out, sidebar hide and show, resize-to-fit, card appear (a picker card arriving) and the flow slide, so that each of the eleven asks is one `--gesture` the user can run on their own deck without a test. The driver opens the pointer hold a click opens (fourth-audit brief [B09]).

**[B03] The user's release deck is the reading of record for every leg, before and after each change.** The harness proves a change; it does not prove the ask. Each change in this arc lands with `tugtool deck motion settle --gesture <g>` on the user's deck at rest, census recorded, with the `startDelayMs` of each beat, the outside recorder's longest gap, and the chain census. The `--tasks` reading, which reloads the deck, is taken once per change at a moment the user names, not silently. If the user's deck is not at rest the reading waits; it is never substituted with a harness number.

**[B04] The transcript's reaction to a height change leaves the gesture's commit.** The forced-layout chains in [F02] (pin-to-bottom, restore target, extent rebase, the measure cycle) run from layout effects on the commit that plans the beats. They move behind the settle: a session card whose frame is on a height-bearing beat holds its interior still (the still-crossing hold the fold already uses) and takes its pin, restore and rebase once, after the land, in the commit nobody sees. The commit that plans the beats measures the frames and nothing inside them.

**[B05] Height by translation is re-benched on the real transcript, with the fold and the column division both read.** The bench of `departing-and-height-crossing-brief.md` [B03] is rebuilt behind the same lab flag and read on [B01]'s whale fixture and on the user's deck: the folding or dividing frame's box held, its interior still, the edge and the neighbour translating, the box snapped at the land. [F05] says the design was never disproved. If it takes the per-frame relayout out ([F03]) it lands for the fold and the division; if it does not, the reading on a real transcript says why, and the height term stays with a transcript that is held still for its length ([B04]).

**[B06] Bars are milliseconds, and the fixture reads them on a release build.** `at0684` keeps its fiber bar and gains a bar on the window's main-thread time: the sum of commit `react_ms` and the longest forced-layout chain, read by the lead recorder. The `settle-beat.startDelayMs` row gets a bar of one display period in `at0622`, since [F01]'s stall is exactly that number. The numbers are set from the first real-transcript readings and are the user's to confirm, as the fourth-audit brief [B07] already asks.

**[B07] The readings premise is written into the doctrine.** `tuglaws/animation-doctrine.md` gains the rule: a settle reading is taken on session cards with real transcripts, at two sizes, and on the user's deck; a reading on an empty card is a reading of the chrome, and a brief that cites only such a reading says so. The three days' readings files are annotated with that line at the top.

---

## Open Questions {#open-questions}

- **What does the stall cost by call site?** [F02] names the chains and not their milliseconds. Settled by the `--tasks` reading on the user's deck ([B03]), which carries `react_ms` and the chain durations once the chain probe records them; extending the probe with a per-chain duration is the arc's first act if it does not.
- **Can the transcript hold still for 400 ms without the user noticing?** A pinned-to-bottom transcript that is mid-stream will land its new rows at the land rather than during the beat. That is the fold's existing behaviour; whether it holds for a Go-to-slot on a streaming card is the user's call once seen.
- **Is the committed slice enough, or does every bar need the whale?** The first [B01] readings at both sizes decide which legs need `corpus/`.
- **Which asks fail on real transcripts beyond Go-to-slot?** Unknown until [B01] reads them; the split, the fold, resize-to-fit and card appear carry height terms or mount content and are the likely ones.

---

## Non-goals {#non-goals}

- **Loosening any bar.** A red on a real transcript is the finding.
- **Shrinking the transcript to make the gesture cheap.** Content-visibility on unseen rows is the compositing brief's question; this arc takes the transcript as users have it.
- **Harness-only landing.** No change in this arc lands on a harness reading alone ([B03]).
- **The compositing walk and the Overview.** `briefs/compositing-walk-and-overview-brief.md`; at 1 ms at rest on this deck it is not the stall.
- **One hold, one quiet, and the commit residue of the close and switch.** Later; both are harness findings until read on a real transcript.

---

## Exit {#exit}

**An arc.** First the fixtures and the drivers ([B01], [B02]), and a reading of all eleven asks on the real-transcript fixtures and on the user's deck, written down as the baseline this work is measured against. Then the transcript's reaction leaves the commit ([B04]), read against the Go-to-slot stall. Then the height bench on the real transcript ([B05]), read against the frames after the stall. Then the millisecond bars ([B06]) and the doctrine line ([B07]). Each change lands with the user's deck read before and after; the arc is done when the eleven asks hold their bars on the whale fixture and the user's deck, or when each red is named with its cost and its cause in a readings file beside this brief.
