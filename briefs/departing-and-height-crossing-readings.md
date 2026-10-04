# Departing and height-crossing readings

The readings behind the work that carries a closed card and a hidden rail out on their own frames. Each entry is pasted as the instrument printed it — the `note()` lines of `at0622-deck-settle-frames.test.ts` and `at0684-settle-window-commits.test.ts` — with its date, the tree it was read on, and its verdict. Numbers here come from a tool, never from a hand. The format is `briefs/settle-window-commit-readings.md`'s.

The instruments:

- `at0622`'s **departure** leg, "a card's departure from a split column": the eight-card shared-column deck, slot 0 split, a session card shown into the column as setup (sampled, not judged), then the newcomer closed with `__tug.closePane`. The `settle-frames` row is the reading; beside it, the click task's commits (`reactCommits`, 60 ms before the last `tug:arm-end` to 200 ms after) and the settle window's largest commit (`windowCommits`, ±60 ms).
- `at0622`'s **rail show**, the second gesture of "hiding the sidebars and the settled-resize retune": the four-up deck with a two-member rail, `toggle-sidebars` after a hide. Same row and same window reading.
- `at0684`, alone, for the close leg's largest commit against reading 1 of `settle-window-commit-readings.md`.

The lead recorder (`installLeadRecorder`) was installed on the departure leg so each commit would carry `reactMs`. It reads `null` on every commit below: the recorder's flag is set and the deck reloaded, but no commit came back with a render start. So the commit sizes are the reading, not their render times.

## Reading 1

2026-10-03, on the arc's tip `575282cc4` with the departure leg and the show's window reading added to `at0622` (the tree this entry's round commits). `just app-test-build` at `575282cc4`, then `just app-test at0622-deck-settle-frames.test.ts` alone, three times, after waiting for the load average to fall below 4 (it read 5.0–7.1 across the three runs; `mds_stores` was still indexing).

Verdicts: `FAIL (8/9)`, `FAIL (8/9)`, `FAIL (7/9)`. Every red was a leg this entry does not read: "a card arriving into a split column…" (the appear lead, 22, 21, 20 ms against 16.5–17) on all three, and "go-to-slot out and home…" (18 ms against 17) on the third. Both are red at the arc's base under the same load; see "The appear lead" below.

### The departure

The rows, one per run:

```
at0622 disappear row: {"strandedPaneIds":[],"longestGapFrames":2.0588235294117645,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":2,"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":2,"offCurvePaneIds":[],"longestGapMs":35,"moveFirstPaintDelayMs":15,"longestOffCurveRunOffsetMs":-1,"commitDelayMs":0,"timestamp":3844,"seq":39,"panes":10,"loc":"","ticks":40} (1 row(s))
at0622 disappear row: {"strandedPaneIds":[],"longestGapFrames":2.235294117647059,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":4,"offCurvePaneIds":[],"longestGapMs":38,"moveFirstPaintDelayMs":16,"commitDelayMs":0,"longestOffCurveRunOffsetMs":-1,"timestamp":3857,"seq":38,"panes":10,"loc":"","ticks":40} (1 row(s))
at0622 disappear row: {"strandedPaneIds":[],"longestGapFrames":2.0588235294117645,"strandedTicks":0,"pendingTicks":1,"offCurveTicks":0,"gapsOverOneFrame":1,"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":3,"offCurvePaneIds":[],"longestGapMs":35,"moveFirstPaintDelayMs":15,"commitDelayMs":0,"longestOffCurveRunOffsetMs":-1,"timestamp":3853,"seq":38,"panes":10,"loc":"","ticks":40} (1 row(s))
```

Beats `["depart","room"]` on all three, no violations, no stranded or off-curve tick.

The click task's commits, run 1 (runs 2 and 3 carry the same sizes within 6 ms of these times), as `t`, performed, fibers, top performers:

```
t=-1  perf=27  fib=101  Presence,AlertDialog,Dialog          why=LayerPanes2@at0622-one{deck,arr}
t=22  perf=580 fib=1163 Presence,Popper,PopperProvider       why=LayerPanes2@at0622-one{deck,arr} TugPaneImpl@at0622-c8{~sizePolicy,placement} …
t=28  perf=184 fib=423  react.context,div,span
t=31  perf=192 fib=458  TugButton2,ResponderScope,TugPushButton2
t=43  perf=40  fib=196  Presence,ResponderScope,AlertDialog  why=… TugPaneImpl@at0622-c4{sizePolicy,~placement} …
t=44  perf=450 fib=845  TugTooltip,Tooltip,Popper
t=54  perf=172 fib=458  TugButton2,ResponderScope,TugPushButton2
t=71  perf=190 fib=456  TugButton2,ResponderScope,TugPushButton2
t=154 perf=4   fib=119  TugComboBox2,ChevronDown,react.forward_ref
```

The settle window's largest commit, per run:

```
at0622 disappear window: 17 commit(s); largest {"t":688,"performed":1632,"mounted":109,"fibers":2994,"reactMs":null,"origins":[["PopperAnchor",15],["Popper",7],["TugPopupMenu",5],["TugActionTooltip",2],["TugTooltip",2],["Tooltip",2],["CardPlaceBadge2",2],["ConfigureTug",1],["DeckCanvas",1],["TugConfirmPopover2",1],["TugPopover2",1],["Popover",1]]}
at0622 disappear window: 18 commit(s); largest {"t":701,"performed":1632,"mounted":109,"fibers":2994,"reactMs":null,"origins":[…same…]}
at0622 disappear window: 18 commit(s); largest {"t":700,"performed":1632,"mounted":109,"fibers":2994,"reactMs":null,"origins":[…same…]}
```

**Verdict: over its bar on 3 of 3 (2.06, 2.24, 2.06 frames against 2). Sampled and reported, not judged.**

**Cause.** The first paint is on time (2–4 ms, `commitDelayMs` 0); what is late is the deck's own work after it. Inside the first 50 ms of the window the close's deck commit (580 performed, every survivor re-rendering for a value move of `placement`) is followed by the survivors' tooltip tree (450 performed) and three popover-button commits (172–192 performed), about 1600 performed fibers in all. The departing frame contributes nothing new to those commits: it was already mounted and renders once for its `departing` prop. The largest commit in the window, 1632 performed with 109 mounted, sits at t ≈ 700, the settle's land: the store unmounting the departing session card, with its popover and menu trees. It lands after the last moving frame and does not enter the gap, but it is the cost the close now pays at the land rather than at the gesture.

### The rail show

The rows, one per run:

```
at0622 sidebars show row: {"strandedPaneIds":[],"longestGapFrames":1.7647058823529411,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":1,"offCurveTicks":25,"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":25,"firstPaintDelayMs":3,"offCurvePaneIds":["at0622-pj1","at0622-pl1"],"longestGapMs":30,"moveFirstPaintDelayMs":14,"commitDelayMs":0,"longestOffCurveRunOffsetMs":0,"timestamp":5241,"seq":16,"panes":4,"loc":"","ticks":41} (1 row(s))
at0622 sidebars show row: {"strandedPaneIds":[],"longestGapFrames":1.588235294117647,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":25,"gapsOverOneFrame":2,"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":25,"firstPaintDelayMs":2,"offCurvePaneIds":["at0622-pj1","at0622-pl1"],"longestGapMs":27,"longestOffCurveRunOffsetMs":0,"moveFirstPaintDelayMs":13,"commitDelayMs":0,"timestamp":5233,"seq":16,"panes":4,"loc":"","ticks":40} (1 row(s))
at0622 sidebars show row: {"strandedPaneIds":[],"longestGapFrames":1.8235294117647058,"strandedTicks":0,"pendingTicks":1,"offCurveTicks":25,"gapsOverOneFrame":2,"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":25,"firstPaintDelayMs":9,"offCurvePaneIds":["at0622-pj1","at0622-pl1"],"longestGapMs":31,"moveFirstPaintDelayMs":14,"commitDelayMs":0,"longestOffCurveRunOffsetMs":0,"timestamp":5229,"seq":16,"panes":4,"loc":"","ticks":40} (1 row(s))
```

```
at0622 sidebars show window: 2 commit(s); largest {"t":24,"performed":45,"mounted":0,"fibers":203,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1]]}
at0622 sidebars show window: 2 commit(s); largest {"t":21,"performed":45,"mounted":0,"fibers":203,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1]]}
at0622 sidebars show window: 2 commit(s); largest {"t":30,"performed":45,"mounted":0,"fibers":203,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1]]}
```

Beats `["room","arrive"]` on all three. The 25 off-curve ticks are the two arriving rail frames held at `opacity: 0` across `room`, the same pose the appear leg exempts.

**Verdict: under its bar on 3 of 3 (1.76, 1.59, 1.82 frames against 2). Judged in `at0622`** with `expectBeats(["room","arrive"])` and `expectB09Bar`, exempting the arriving frames on the same earned terms as the appear leg: an arriving frame must have been watched at opacity 0, and the frame the probe names must be one that arrived.

**Why it moved.** The show used to mount the rail's whole contents inside the settle window (a 4501-fiber commit, 2.9–3.1 frames). A parked rail keeps its contents mounted, so the show's window now holds two commits, the largest 45 performed fibers.

### `at0684`, the close leg

`just app-test at0684-settle-window-commits.test.ts` alone: `VERDICT: PASS (1/1 files green; 5/5 tests passed)`.

```
at0684 close: 19 commit(s) in a 693 ms window (±60 ms)
at0684 close largest: t=26 performed=580 mounted=3 fibers=1163 origins=[["CardPlaceBadge2",2],["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]] why=["LayerPanes2@at0622-one{deck,arr}","TugPaneImpl@cfde22e2-c794-4020-92eb-c62ffebdbe41{~sizePolicy,~placement,departing}","TugPaneImpl@cfde22e2-c794-4020-92eb-c62ffebdbe41{~sizePolicy,~placement,departing}","TugPaneImpl@at0622-c8{~sizePolicy,placement}",…,"TugPaneImpl@at0622-c5{~sizePolicy,placement}"]
```

**The close's largest commit moved:** 1676 performed, 2965 fibers at t=16 in reading 1 of `settle-window-commit-readings.md`, against 580 performed, 1163 fibers at t=26 here. The departing pane is in it, re-rendered for its `departing` mark. The land commit at t=702 is 27 performed. The survivors' rollup popover trees no longer re-render in the close commit: they come after it in their own commits (450 performed at t=46, 172–192 at t=34–75).

### The appear lead

Not this arc's leg, recorded because it was red on every run above. "A card arriving into a split column holds the bar across room and arrive" reads a lead of 20–22 ms against 16.5–17 ms. A back-to-back A/B at load average ~4–5, `at0622` alone three times each:

- The arc's base source (`git diff -R 776746a8c -- tugdeck/src ':!tugdeck/src/spikes'` under `tugtool file probe`, rebuilt): appear lead red on 2 of 3 (20, 21 ms).
- The arc's tip: appear lead red on 2 of 3 (20, 21 ms), one run `PASS (9/9)`.

The lead is the same with and without the arc. On the base, the hide leg's strip-identity clause also failed every run, as it must: a base deck has no strip standing at rest to keep.

## Reading 2 — the fold bench

2026-10-03, on the arc's tip `8701f77b4` (the height bench behind `labFlags.heightByTranslation`, and `at0685-height-by-translation-bench.test.ts`). `just app-test-build` at `8701f77b4`, then `just app-test at0685-height-by-translation-bench.test.ts` alone, three times back to back, at load averages 4.1, 5.7 and 6.7 (the runs' own app instances are most of it; nothing else was above 10% CPU). Verdicts: `PASS (3/3)` on all three, which says only that every guard held: on every gesture the pane's height changed, the window was served, and the bench engaged on exactly the flag-on arm.

The instrument, per run:

- **Timing, A/B.** The column fixture with slot 0 split (`at0622-p1` over `at0622-p2`), the lead recorder installed, one warm-up fold and unfold, then flag off and on alternately three times, each a fold (`sampleFold(app, true, 0)`) then an unfold. The `settle-frames` row is the reading; beside it are the window's largest commit (`windowCommits`, ±60 ms) and the window's `settle-motion-violation` rows.
- **Exposure census.** A separate launch, flag on, one fold then one unfold, sampled every animation frame while the folding frame wears `data-height-crossing`: 3 x-positions × 2 y-positions in the seam band (the edge piece's border to the lower frame's top) and in the foot-overhang band (the column foot to the lower frame's bottom). Probes resolve through `elementsFromPoint`, skipping resize handles and place seams. A probe outside the viewport is counted in `offscreenProbes` and not taken.
- **Theme census.** Every name in `SHIPPED_THEME_NAMES` via `set-theme`; the computed `background-color` of `at0622-p2`'s `.tug-pane-chrome` and of its frame, with alpha by `colorAlpha`'s rule.

### The timing, tabulated

`longestGapFrames` off each row, in run order (run 1, 2, 3 of the A/B within each file run):

| file run | off fold | off unfold | on fold | on unfold |
|---|---|---|---|---|
| 1 | 2.59, 2.06, 1.75 | 2.00, 1.47, 2.24 | 2.18, 2.18, 1.47 | 2.06, 2.00, 2.12 |
| 2 | 2.18, 2.18, 1.59 | 1.82, 1.53, 2.12 | 2.06, 1.76, 2.06 | 2.18, 1.29, 1.88 |
| 3 | 2.69, 2.42, 1.94 | 1.94, 1.65, 2.31 | 2.24, 2.18, 1.53 | 2.12, 2.00, 1.94 |

Means over nine: off fold 2.16, on fold 1.96; off unfold 1.90, on unfold 1.95. The flag-on rows carry 16–18 ticks where the flag-off rows carry 56–57: the bench runs one beat (`shrink` on the fold, `grow` on the unfold, two targets, `declares: []`) where the ordinary fold runs three (`shrink`, `move`, `grow`, two of them declaring `height`).

Every window, both arms, all three runs: 4 commits, the largest 718 performed, 0 mounted, at t = 20–45 ms, origins `ConfigureTug`, `DeckCanvas`, `LayoutContent`, `SessionProjectPicker`. `reactMs` is `null` on every one, as in reading 1: the recorder is installed and attaches no render start.

`settle-motion-violation` rows: `["at0622-p1:height","at0622-p2:height"]` on every flag-off gesture, `[]` on every flag-on gesture.

### The exposure, tabulated

| file run | fold: ticks / exposed / offscreen | unfold: ticks / exposed / offscreen | first exposing probe |
|---|---|---|---|
| 1 | 16 / 0 / 66 | 17 / 0 / 84 | — |
| 2 | 17 / 0 / 72 | 17 / 0 / 84 | — |
| 3 | 17 / 0 / 72 | 17 / 1 / 81 | unfold, t = 69 ms, foot band 1046–1064.7, probe (174, 1051), hit `at0622-p2 div.session-card-picker-backdrop` |

The seam band was never wider than 5 px, the member gap, and never exposed. The foot band reaches 291 px on the fold and 298 px on the unfold. Nearly all of it hangs past the window's bottom edge, so most of its probes are offscreen. The part still inside the viewport is about 18 px below the column foot, and there on one tick it showed the lower card's own content where the canvas belongs. The verification run of the step that built the bench caught the same exposure once, at the same place.

### Verdict against the bench's three clauses

**FAIL.**

1. **Timing — FAIL.** The flag-on unfold's `longestGapFrames` is over 1.5 on 8 of 9 readings (1.29 is the one under), so not on 3 of 3 runs. It is not better than the flag-off control (mean 1.95 against 1.90). Both arms share the same largest commit, 718 performed at 20–45 ms into the window, and the gap follows the commit rather than the arm: taking the `height` tween away did not move it.
2. **Exposure — FAIL.** One exposing tick in run 3's unfold, in the foot-overhang band: the lower member's content below the column foot. Zero in the seam band on every run.
3. **Property — PASS.** No flag-on gesture wrote a `settle-motion-violation` row; neither `at0622-p1` nor `at0622-p2` animated `height`.

### The division, not benched

Brief [B04] is not taken. The division was to be the same bench at N members, benched only if the fold's passed, because the fold answers the same question with fewer moving pieces. The fold failed on timing and on exposure, so nothing was built for the division and there is no division reading. The timing failure says the gap belongs to the window's commit rather than to the `height` tween ([F10] of `briefs/departing-and-height-crossing-brief.md`), and a division bench would hold the same commit under more pieces.

### The rows as the instrument printed them

Each file run's `row:`, `window:` and `violations:` lines for the twelve timed gestures, then the census lines. `reportFold` prefixes its row lines with `at0622 `, the fixture's own name, and that prefix is dropped here. Nothing else is changed.

#### Run 1

```
at0685 off run 1 fold row: {"strandedPaneIds":[],"longestGapFrames":2.588235294117647,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":2,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":14,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":14,"longestGapMs":44,"commitDelayMs":3,"timestamp":7604,"seq":55,"panes":9,"loc":"","ticks":56}
at0685 off run 1 fold window: 4 commit(s); largest {"t":43,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 1 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 1 unfold row: {"strandedPaneIds":[],"longestGapFrames":2,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":2,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"longestGapMs":32,"moveFirstPaintDelayMs":8,"commitDelayMs":1,"timestamp":8689,"seq":65,"panes":9,"loc":"","ticks":56}
at0685 off run 1 unfold window: 4 commit(s); largest {"t":26,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 1 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 1 fold row: {"strandedPaneIds":[],"longestGapFrames":2.176470588235294,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":15,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"longestGapMs":37,"commitDelayMs":2,"moveFirstPaintDelayMs":14,"timestamp":10054,"seq":73,"panes":9,"loc":"","ticks":18}
at0685 on run 1 fold window: 4 commit(s); largest {"t":43,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 1 fold violations: []
at0685 on run 1 unfold row: {"strandedPaneIds":[],"longestGapFrames":2.0588235294117645,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":14,"offCurvePaneIds":[],"longestGapMs":35,"moveFirstPaintDelayMs":11,"longestOffCurveRunOffsetMs":-1,"commitDelayMs":2,"timestamp":11087,"seq":79,"panes":9,"loc":"","ticks":18}
at0685 on run 1 unfold window: 4 commit(s); largest {"t":39,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 1 unfold violations: []
at0685 off run 2 fold row: {"strandedPaneIds":[],"longestGapFrames":2.0588235294117645,"strandedTicks":0,"pendingTicks":1,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":16,"offCurvePaneIds":[],"longestGapMs":35,"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":13,"commitDelayMs":2,"timestamp":13686,"seq":87,"panes":9,"loc":"","ticks":57}
at0685 off run 2 fold window: 4 commit(s); largest {"t":42,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 2 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 2 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.4705882352941178,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":0,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":["at0622-p1:height","at0622-p2:height"],"longestOffCurveRunTicks":0,"firstPaintDelayMs":2,"offCurvePaneIds":[],"longestGapMs":25,"moveFirstPaintDelayMs":8,"commitDelayMs":1,"longestOffCurveRunOffsetMs":-1,"timestamp":14753,"seq":97,"panes":9,"loc":"","ticks":56}
at0685 off run 2 unfold window: 4 commit(s); largest {"t":20,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 2 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 2 fold row: {"strandedPaneIds":[],"longestGapFrames":2.176470588235294,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":13,"offCurvePaneIds":[],"longestGapMs":37,"moveFirstPaintDelayMs":12,"commitDelayMs":1,"longestOffCurveRunOffsetMs":-1,"timestamp":16103,"seq":105,"panes":9,"loc":"","ticks":18}
at0685 on run 2 fold window: 4 commit(s); largest {"t":42,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 2 fold violations: []
at0685 on run 2 unfold row: {"strandedPaneIds":[],"longestGapFrames":2,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":17,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":13,"commitDelayMs":3,"longestGapMs":34,"timestamp":17153,"seq":111,"panes":9,"loc":"","ticks":18}
at0685 on run 2 unfold window: 4 commit(s); largest {"t":41,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 2 unfold violations: []
at0685 off run 3 fold row: {"strandedPaneIds":[],"longestGapFrames":1.75,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":17,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":10,"commitDelayMs":3,"longestGapMs":28,"timestamp":19736,"seq":119,"panes":9,"loc":"","ticks":56}
at0685 off run 3 fold window: 4 commit(s); largest {"t":35,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 3 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 3 unfold row: {"strandedPaneIds":[],"longestGapFrames":2.242424242424242,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":["at0622-p1:height","at0622-p2:height"],"longestOffCurveRunTicks":0,"firstPaintDelayMs":11,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":9,"commitDelayMs":2,"longestGapMs":37,"timestamp":20839,"seq":129,"panes":9,"loc":"","ticks":57}
at0685 off run 3 unfold window: 4 commit(s); largest {"t":38,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 3 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 3 fold row: {"strandedPaneIds":[],"longestGapFrames":1.4705882352941178,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":0,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":5,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"longestGapMs":25,"moveFirstPaintDelayMs":10,"commitDelayMs":1,"timestamp":22187,"seq":137,"panes":9,"loc":"","ticks":18}
at0685 on run 3 fold window: 4 commit(s); largest {"t":23,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 3 fold violations: []
at0685 on run 3 unfold row: {"strandedPaneIds":[],"longestGapFrames":2.1176470588235294,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":11,"offCurvePaneIds":[],"longestGapMs":36,"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":12,"commitDelayMs":3,"timestamp":23238,"seq":143,"panes":9,"loc":"","ticks":18}
at0685 on run 3 unfold window: 4 commit(s); largest {"t":37,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 3 unfold violations: []
at0685 census fold: {"offscreenProbes":66,"crossingTicks":16,"widestSeamPx":5,"seamExposures":0,"widestFootPx":291,"footExposures":0,"exposedTicks":0,"first":null}
at0685 census fold violations: []
at0685 census unfold: {"offscreenProbes":84,"crossingTicks":17,"widestSeamPx":5,"seamExposures":0,"widestFootPx":298.090576171875,"footExposures":0,"exposedTicks":0,"first":null}
at0685 census unfold violations: []
```

#### Run 2

```
at0685 off run 1 fold row: {"strandedPaneIds":[],"longestGapFrames":2.176470588235294,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":2,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":["at0622-p1:height","at0622-p2:height"],"longestOffCurveRunTicks":0,"firstPaintDelayMs":16,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":16,"commitDelayMs":3,"longestGapMs":37,"timestamp":7597,"seq":55,"panes":9,"loc":"","ticks":56}
at0685 off run 1 fold window: 4 commit(s); largest {"t":42,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 1 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 1 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.8235294117647058,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":5,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"longestGapMs":31,"commitDelayMs":2,"moveFirstPaintDelayMs":9,"timestamp":8680,"seq":65,"panes":9,"loc":"","ticks":56}
at0685 off run 1 unfold window: 4 commit(s); largest {"t":27,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 1 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 1 fold row: {"strandedPaneIds":[],"longestGapFrames":2.0588235294117645,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":6,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"longestGapMs":35,"commitDelayMs":3,"moveFirstPaintDelayMs":14,"timestamp":10014,"seq":73,"panes":9,"loc":"","ticks":17}
at0685 on run 1 fold window: 4 commit(s); largest {"t":31,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 1 fold violations: []
at0685 on run 1 unfold row: {"strandedPaneIds":[],"longestGapFrames":2.176470588235294,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":14,"offCurvePaneIds":[],"longestGapMs":37,"moveFirstPaintDelayMs":11,"longestOffCurveRunOffsetMs":-1,"commitDelayMs":3,"timestamp":11063,"seq":79,"panes":9,"loc":"","ticks":18}
at0685 on run 1 unfold window: 4 commit(s); largest {"t":41,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 1 unfold violations: []
at0685 off run 2 fold row: {"strandedPaneIds":[],"longestGapFrames":2.176470588235294,"strandedTicks":0,"pendingTicks":1,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":5,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":10,"commitDelayMs":2,"longestGapMs":37,"timestamp":13647,"seq":87,"panes":9,"loc":"","ticks":57}
at0685 off run 2 fold window: 4 commit(s); largest {"t":33,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 2 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 2 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.5294117647058822,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":3,"offCurvePaneIds":[],"longestGapMs":26,"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":8,"commitDelayMs":1,"timestamp":14713,"seq":97,"panes":9,"loc":"","ticks":56}
at0685 off run 2 unfold window: 4 commit(s); largest {"t":22,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 2 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 2 fold row: {"strandedPaneIds":[],"longestGapFrames":1.7647058823529411,"strandedTicks":0,"pendingTicks":1,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":4,"offCurvePaneIds":[],"longestGapMs":30,"moveFirstPaintDelayMs":12,"longestOffCurveRunOffsetMs":-1,"commitDelayMs":2,"timestamp":16047,"seq":105,"panes":9,"loc":"","ticks":18}
at0685 on run 2 fold window: 4 commit(s); largest {"t":25,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 2 fold violations: []
at0685 on run 2 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.2941176470588236,"strandedTicks":0,"pendingTicks":1,"offCurveTicks":0,"gapsOverOneFrame":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":10,"offCurvePaneIds":[],"longestGapMs":22,"longestOffCurveRunOffsetMs":-1,"commitDelayMs":2,"moveFirstPaintDelayMs":11,"timestamp":17097,"seq":111,"panes":9,"loc":"","ticks":18}
at0685 on run 2 unfold window: 4 commit(s); largest {"t":26,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 2 unfold violations: []
at0685 off run 3 fold row: {"strandedPaneIds":[],"longestGapFrames":1.588235294117647,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":16,"offCurvePaneIds":[],"longestGapMs":27,"moveFirstPaintDelayMs":10,"commitDelayMs":3,"longestOffCurveRunOffsetMs":-1,"timestamp":19680,"seq":119,"panes":9,"loc":"","ticks":56}
at0685 off run 3 fold window: 4 commit(s); largest {"t":33,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 3 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 3 unfold row: {"strandedPaneIds":[],"longestGapFrames":2.121212121212121,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":["at0622-p1:height","at0622-p2:height"],"longestOffCurveRunTicks":0,"firstPaintDelayMs":12,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":8,"commitDelayMs":2,"longestGapMs":35,"timestamp":20781,"seq":129,"panes":9,"loc":"","ticks":57}
at0685 off run 3 unfold window: 4 commit(s); largest {"t":38,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 3 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 3 fold row: {"strandedPaneIds":[],"longestGapFrames":2.0588235294117645,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":8,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":12,"commitDelayMs":4,"longestGapMs":35,"timestamp":22131,"seq":137,"panes":9,"loc":"","ticks":18}
at0685 on run 3 fold window: 4 commit(s); largest {"t":32,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 3 fold violations: []
at0685 on run 3 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.8823529411764706,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":7,"offCurvePaneIds":[],"longestGapMs":32,"moveFirstPaintDelayMs":11,"commitDelayMs":3,"longestOffCurveRunOffsetMs":-1,"timestamp":23181,"seq":143,"panes":9,"loc":"","ticks":18}
at0685 on run 3 unfold window: 4 commit(s); largest {"t":31,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 3 unfold violations: []
at0685 census fold: {"crossingTicks":17,"offscreenProbes":72,"widestSeamPx":5,"seamExposures":0,"widestFootPx":291,"footExposures":0,"exposedTicks":0,"first":null}
at0685 census fold violations: []
at0685 census unfold: {"offscreenProbes":84,"crossingTicks":17,"widestSeamPx":5,"seamExposures":0,"widestFootPx":298.1650085449219,"footExposures":0,"first":null,"exposedTicks":0}
at0685 census unfold violations: []
```

#### Run 3

```
at0685 off run 1 fold row: {"strandedPaneIds":[],"longestGapFrames":2.6875,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":15,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":14,"commitDelayMs":4,"longestGapMs":43,"timestamp":7586,"seq":55,"panes":9,"loc":"","ticks":56}
at0685 off run 1 fold window: 4 commit(s); largest {"t":40,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 1 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 1 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.9411764705882353,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":["at0622-p1:height","at0622-p2:height"],"longestOffCurveRunTicks":0,"firstPaintDelayMs":4,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":8,"commitDelayMs":2,"longestGapMs":33,"timestamp":8687,"seq":65,"panes":9,"loc":"","ticks":57}
at0685 off run 1 unfold window: 4 commit(s); largest {"t":28,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 1 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 1 fold row: {"strandedPaneIds":[],"longestGapFrames":2.235294117647059,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":16,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":14,"commitDelayMs":3,"longestGapMs":38,"timestamp":10036,"seq":73,"panes":9,"loc":"","ticks":17}
at0685 on run 1 fold window: 4 commit(s); largest {"t":44,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 1 fold violations: []
at0685 on run 1 unfold row: {"strandedPaneIds":[],"longestGapFrames":2.1176470588235294,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":17,"offCurvePaneIds":[],"longestGapMs":36,"moveFirstPaintDelayMs":11,"commitDelayMs":2,"longestOffCurveRunOffsetMs":-1,"timestamp":11086,"seq":79,"panes":9,"loc":"","ticks":18}
at0685 on run 1 unfold window: 4 commit(s); largest {"t":45,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 1 unfold violations: []
at0685 off run 2 fold row: {"strandedPaneIds":[],"longestGapFrames":2.4242424242424243,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":14,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":10,"commitDelayMs":3,"longestGapMs":40,"timestamp":13686,"seq":87,"panes":9,"loc":"","ticks":57}
at0685 off run 2 fold window: 4 commit(s); largest {"t":44,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 2 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 2 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.6470588235294117,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":16,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":7,"commitDelayMs":1,"longestGapMs":28,"timestamp":14769,"seq":97,"panes":9,"loc":"","ticks":56}
at0685 off run 2 unfold window: 4 commit(s); largest {"t":37,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 2 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 2 fold row: {"strandedPaneIds":[],"longestGapFrames":2.176470588235294,"strandedTicks":0,"pendingTicks":1,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":15,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":11,"longestGapMs":37,"commitDelayMs":2,"timestamp":16119,"seq":105,"panes":9,"loc":"","ticks":18}
at0685 on run 2 fold window: 4 commit(s); largest {"t":43,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 2 fold violations: []
at0685 on run 2 unfold row: {"strandedPaneIds":[],"longestGapFrames":2,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":3,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":12,"commitDelayMs":2,"longestGapMs":34,"timestamp":17153,"seq":111,"panes":9,"loc":"","ticks":18}
at0685 on run 2 unfold window: 4 commit(s); largest {"t":28,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 2 unfold violations: []
at0685 off run 3 fold row: {"strandedPaneIds":[],"longestGapFrames":1.9375,"strandedTicks":0,"pendingTicks":1,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":["at0622-p1:height","at0622-p2:height"],"longestOffCurveRunTicks":0,"firstPaintDelayMs":18,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"moveFirstPaintDelayMs":9,"commitDelayMs":3,"longestGapMs":31,"timestamp":19753,"seq":119,"panes":9,"loc":"","ticks":56}
at0685 off run 3 fold window: 4 commit(s); largest {"t":39,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 3 fold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 off run 3 unfold row: {"strandedPaneIds":[],"longestGapFrames":2.3125,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","violations":["at0622-p1:height","at0622-p2:height"],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":16,"offCurvePaneIds":[],"longestGapMs":37,"moveFirstPaintDelayMs":8,"commitDelayMs":3,"longestOffCurveRunOffsetMs":-1,"timestamp":20852,"seq":129,"panes":9,"loc":"","ticks":57}
at0685 off run 3 unfold window: 4 commit(s); largest {"t":44,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 off run 3 unfold violations: ["at0622-p1:height","at0622-p2:height"]
at0685 on run 3 fold row: {"strandedPaneIds":[],"longestGapFrames":1.5294117647058822,"pendingTicks":1,"strandedTicks":0,"gapsOverOneFrame":1,"offCurveTicks":0,"store":{"hasFocus":false,"activePaneId":"at0622-p1","activeCardId":"at0622-c1"},"kind":"settle-frames","violations":[],"cutPaneIds":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":8,"offCurvePaneIds":[],"longestOffCurveRunOffsetMs":-1,"longestGapMs":26,"commitDelayMs":1,"moveFirstPaintDelayMs":10,"timestamp":22202,"seq":137,"panes":9,"loc":"","ticks":18}
at0685 on run 3 fold window: 4 commit(s); largest {"t":27,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 3 fold violations: []
at0685 on run 3 unfold row: {"strandedPaneIds":[],"longestGapFrames":1.9411764705882353,"pendingTicks":1,"strandedTicks":0,"offCurveTicks":0,"gapsOverOneFrame":1,"store":{"activePaneId":"at0622-p1","hasFocus":false,"activeCardId":"at0622-c1"},"kind":"settle-frames","cutPaneIds":[],"violations":[],"longestOffCurveRunTicks":0,"firstPaintDelayMs":9,"offCurvePaneIds":[],"longestGapMs":33,"moveFirstPaintDelayMs":12,"commitDelayMs":3,"longestOffCurveRunOffsetMs":-1,"timestamp":23254,"seq":143,"panes":9,"loc":"","ticks":18}
at0685 on run 3 unfold window: 4 commit(s); largest {"t":33,"performed":718,"mounted":0,"reactMs":null,"origins":[["ConfigureTug",1],["DeckCanvas",1],["LayoutContent",1],["SessionProjectPicker",1]]}
at0685 on run 3 unfold violations: []
at0685 census fold: {"crossingTicks":17,"offscreenProbes":72,"widestSeamPx":5,"seamExposures":0,"widestFootPx":291,"footExposures":0,"exposedTicks":0,"first":null}
at0685 census fold violations: []
at0685 census unfold: {"offscreenProbes":81,"crossingTicks":17,"widestSeamPx":5,"seamExposures":0,"widestFootPx":297.98193359375,"footExposures":3,"first":{"x":174,"t":69,"hit":"at0622-p2 div.session-card-picker-backdrop","y":1051,"band":"foot","bandTop":1046,"bandBottom":1064.7},"exposedTicks":1}
at0685 census unfold violations: []
```

#### Theme census

Identical on all three runs:

```
at0685 theme ironclad: chrome oklch(0.31 0.01 263.333344) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme caravel: chrome oklch(0.31 0.01 175) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme barque: chrome oklch(0.31 0.01 292.5) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme galleon: chrome oklch(0.31 0.01 70) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme collier: chrome oklch(0.31 0.01 207.5) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme sloop: chrome oklch(0.985 0.002 260) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme ketch: chrome oklch(0.985 0.002 310) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme skiff: chrome oklch(0.985 0.002 200) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme kayak: chrome oklch(0.985 0.002 70) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
at0685 theme pinnace: chrome oklch(0.985 0.002 320) (alpha 1) · frame rgba(0, 0, 0, 0) (alpha 0)
```
