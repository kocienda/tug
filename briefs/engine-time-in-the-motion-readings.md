# Engine time in the motion — readings

Every reading this arc takes, one section per step. Each table says which deck it was read on, the build that deck ran, and whether it was **quiet** (`--quiet-instruments`: the rAF pump alone, the reading of record for frame timings) or **instrumented** (`--frame-phases --chains`: the Time Profiler at 1 ms and the chain probe with stacks, which perturb the frames they read and are read for attribution only). The brief is [engine-time-in-the-motion-brief.md](engine-time-in-the-motion-brief.md); the program's record is [main-thread-headroom-program-brief.md](main-thread-headroom-program-brief.md#record).

How to read an instrumented row: `--frame-phases` files every 1 ms main-thread sample of the deck's WebContent process under the frame of the drive it fell in. Style, layout and compositing are written `engine/forced`, where *forced* means the deck's script asked for it. A forcer is the DOM API the forced sample entered through, and, when the sample fell inside a forced-layout chain's paying read, that chain's site as `in <fn>: <bundle position>`. JavaScript frames carry no names in the trace, so a forced sample outside every chain names its API only.

## Before: the user's aged deck (2026-10-13)

**Deck.** The user's Tug.app (Release, launched 06:30 on 2026-10-13, deck bundle `index-uDG8KDlY.js`, a build that predates this arc), read at 07:17–07:30 with the machine up 12 days 22 h. The deck's WebContent process had been up 47 min at 3.9 GB resident. The element census, from counts that force no style, read 25,353–26,188 across the readings, in 15 panes; the largest was a parked Session card at 6,844–9,888 elements.

**Rest** (instrumented only by its own probe): 22 updates/s over a 2 ms floor, holding the main thread 284 ms/s (563 ticks in 1 s, median gap 1 ms, worst 35 ms). The deck is never at rest while a session works (budget 10/s), so every gesture is read under `--streaming 1`: one session mid-turn (the arc's own), none streaming text.

**Gestures.** `appear` brings a session picker card in. `fold`/`unfold` act on a session card in slot 1 (`c3888639…`). `slot` sends that card to slot 3 and back. `split`/`stack` alternate the column mode of slot 3 while that card is seated there beside the slot's own pane, the one column on the deck holding two panes. The deck was put back as found after the readings (card in slot 1, both columns stacked). The one thing not restored is the active pane, which is now the card that was moved.

### Quiet (the reading of record for frames)

`--quiet-instruments --count 2 --streaming 1`. Times in ms from the drive. *Set-up* is the settle mark going on to the motion gate's last close. *Lead* is the drive to its first frame. *Longest gap* covers the drive to the settle mark's off, lead included. *Motion* is the longest gap from the gate's close to the off. *Land* is the hand-back frame.

| Gesture | Settle window | Gate close (set-up end) | Lead | Longest gap | Motion | Land |
|---|---|---|---|---|---|---|
| appear #1 | 222 → 613 | 359 | 13 | 144 | 17 | 26 |
| appear #2 | 239 → 620 | 364 | 10 | 183 | 18 | 29 |
| fold | 0 → 348 | 88 | 15 | 73 | 18 | 38 |
| unfold | 0 → 364 | 100 | 14 | 86 | 33 | 48 |
| slot → 3 | 0 → 503 | 222 | 55 | 279 | **279** | **1,220** |
| slot → 1 | 0 → 516 | 145 | 70 | 70 | 28 | 22 |
| split (slot 3) | 0 → 613 | 214 | 11 | 205 | 43 | 42 |
| stack (slot 3) | 0 → 580 | 231 | 17 | 214 | 176 | 74 |

The `appear` settle mark goes on 222–239 ms after the drive: that span is the picker card's mount, before any settle is armed, and it is [B01]'s ⌘N lead on its own. The `slot → 3` row read a 279 ms move→move judder and a 1,220 ms land. Its second drive was then refused by the gesture door (`slot: no pane holds card`) while that land was still standing. The return leg was read alone afterwards.

`tugtool deck motion gaps` after the drives (always-on rows, every settle in the deck's recent life) reads the set-up as the larger cost everywhere. Its lead gaps run 29–375 ms (set-up→move 310, set-up→room 375), its judders 29–279 ms (room→arrive 200, move→move 279), and the worst judder per gesture is fold 200, slot 279, split 279, appear 172.

### Instrumented (attribution)

`--frame-phases --chains --count 2 --streaming 1` (slot `--count 1`: its census drive went to slot 3 and the one reading is the return to slot 1). *Set-up phases* sums every frame from the drive to the gate's close, in samples of 1 ms. *First engine frame* is the frame the gate's close opens, by phase.

| Gesture | Chains in the set-up | Set-up phases: style, layout, compos (engine/forced); script | First engine frame after the close |
|---|---|---|---|
| appear #1 (drive → close 655) | 7 | 3/32, 21/308, 2/47; script 205 | 655→656: layout 1; then 8 ms and 17 ms frames of 1–2 samples |
| appear #2 (drive → close 371) | 5 | 3/23, 13/114, 4/33; script 148 | 371→382: style 1, compos 1, update 1 |
| unfold (close 83) | 5 | 0/19, 0/23, 0/4; script 21 | 84→131 (47 ms): style 4, layout 10, compos 2, paint 1, script 11, update 5, other 11 |
| fold (close 104) | 7 | 1/8, 25/31, 2/3; script 28 | 104→119: layout 2, compos 1, commit 1, script 9 |
| slot → 1 (close 97) | 6 | 0/6, 0/45, 1/4; script 43 | 102→123: layout 3, compos 1, paint 1, script 4 |
| split #1 → stack (close 220) | 6 | 0/128, 13/45, 0/1; script 31 | 221→260 (39 ms): style 2, layout 23, compos 3, paint 4 |
| split #2 → split (close 243) | 8 | 1/134, 12/52, 0/4; script 38 | 245→292 (47 ms): layout 23, compos 1, paint 1 |

**Forcing APIs and their callers, in the set-up**, largest first (samples):

- **appear**: picker mount (drive → settle on): `clientWidth` 66 + 49, `clientHeight` 22 + 27, `scrollHeight` 21, `scrollTop` 24 + 25, `getComputedStyle` 13, `getAnimations` 5. Settled set-up: `clientHeight` 24–28 **in On: index:221:37993**; `scrollTop` 24–29.
- **fold/unfold**: `clientHeight` 23–27 **in On: index:221:37993**; `getBoundingClientRect` 19 (unfold); `scrollTop` 1–2 **in applyRestoreTarget**.
- **slot**: `clientHeight` 23–24 **in On: index:221:37993**, and 24 more `clientHeight` in the set-up row ahead of it.
- **split/stack**: **`getBoundingClientRect` 120–122 forcing style, in no chain**; `clientHeight` 26–29 **in On: index:221:37993**; `scrollTop` 18–19 **in Mc: index:221:22063**; `scrollTop`/`clientHeight` 1–2 in `map`/`forEach` at index:37:140598/140752, `applyRestoreTarget`, `reland`.

**Chains in the set-up**, every gesture: 5–8 against a bar of one. Every gesture's set-up pays the same 23–31 ms `clientHeight` chain in the anonymous effect at **index:221:37993**, named by its nearest named frame `On` (React's minified layout-effect commit in the vendor chunk). Split and stack also pay an 18–19 ms `scrollTop` chain at **index:221:22063** (named `Mc`, likewise React's). The rest are 0–2 ms chains in `reland`, `xU`, `applyRestoreTarget`, `map`/`forEach`.

### The picker-to-body handoff (harness only)

The handoff needs a hand on the picker, which the stage never supplies on the user's deck, so it is read on the harness: `at0702`'s appear leg on the slice arm (13,763 elements), then the arrived card's session bound through `window.__tug.bindSession`, with `__tugMotion.gesture` and the chain probe (stacks on) armed 60 ms before the bind and read 1.5 s after. The probe ran once behind `tugtool file probe` on a debug build of the arc's tree.

| Deck | Frames | Longest gap | Gaps over 20 ms | Chains (longest, total) | Chain sites (ms after the bind) |
|---|---|---|---|---|---|
| harness slice, instrumented | 95 | **259** | 259, 24 | 5 (4, 7 ms) | `clientHeight` in On: index:221:37993 at 27 (4 ms); `scrollTop` in `focus` at 138; `scrollTop` in Mc: index:221:22063 at 142 (3 ms); `clientHeight` in On at 151; `offsetWidth` in `vSe` at 251 |

The body's mount holds the main thread for one 259 ms frame, and the chains inside it are small (7 ms in all), so the frame is the mount's own work rather than a reader. The user's-deck row for the handoff is **owed**.

### Findings the later steps read

1. The set-up reads geometry 5–8 times per gesture, and one anonymous layout effect (index:221:37993) pays 23–31 ms of it in every gesture. It is Step 3's first reader.
2. Split and stack pay 120–134 samples of **forced style** in their set-up through `getBoundingClientRect` outside any chain: one read after a style invalidation over the whole document. That is the single largest set-up cost read here, and Step 3 must place its reader.
3. The engine's own frame after the gate's close is small on fold, slot and appear (1–17 samples). It is 39–47 ms on unfold and split, where engine layout (10–23 samples) dominates it.
4. The `appear` lead before any settle (the picker's mount, 222–430 ms) is forced layout from `clientWidth`/`clientHeight`/`scrollTop` readers, 300+ samples per drive.
5. The quiet pump twice missed a settle mark's off on its first fold and split drives (`never went on and off within 4000 ms`), and read both cleanly when re-driven. The `split` miss was a column of one pane (nothing moves, so no settle). The first `fold` miss did not reproduce.

## The set-up reads geometry once (harness, 2026-10-13)

**Deck.** The harness's column deck (`at0733`): eight session cards on the slice transcript (1,511 rows each), four columns of two, slot 0 split; 13,763 elements. A debug build of the arc's tree. The whale arm did not run: this machine has no whale snapshot, so `transcriptArms()` skips it and the whale row is owed. The user's deck does not run this code yet ([P08]), so its row is owed too.

**Instrument.** `tugtool deck motion settle --chains --frame-phases --count 2 --streaming 0` from `at0733` under `TUG_AT0733_PHASES=1`: the chain probe with stacks on every read drive, the Time Profiler at 1 ms. Instrumented, so its frame times are for attribution only. *Set-up chains* counts the probe's read→write→read chains from the settle mark's on to the gate's last close.

| Gesture | Set-up chains, before the conversion | Set-up chains, after | Lead (ms) | Longest gap (ms) |
|---|---|---|---|---|
| appear #1 | 0 | 0 | 13 | 119 |
| appear #2 | 0 | 0 | 13 | 108 |
| unfold | 2 | **1** | 14 | 114 |
| fold | 2 | **1** | 18 | 112 |

**The reading before the conversion** named two chains on fold and unfold:

- `clientHeight` 4–5 ms **in On: index:221:38649**, at 22–24 ms: the list view's commit bracket (the displacement bracket's first read). It was a chain because the list view's render had read the DOM ahead of the commit: its kept top was trusted only while `isScrollBaselineFresh`, and a write the browser answered with no `scroll` event (a write that moved nothing net) left that gate stale for good. The census drive, the first after an idle deck, showed no such chain, which is what placed it.
- `clientHeight` 0 ms **in `bottomDistancesOf`** (`map: index:37:140088`), at 115–121 ms: the Last pass's read phase. It is the commit's one layout: the read phase's first `getBoundingClientRect` pays it, and that getter is not one the probe wraps, so the chain is named at the phase's first wrapped read.

**The conversion.** SmartScroll keeps the top it last knew without a read of its own (`keptScrollTop`: a `scroll` event's, a pin's exact maximum, a programmatic write read back on the layout it flushed, a declared external write's), and the render windows against it. After it, the only set-up chain left on fold and unfold is the read phase's, and its writes are the commit's: `setAttribute` at index:417:8239, `setProperty` in `IH` (index:37:135163) and in `L4e` (index:201:22046).

**Where the set-up's time goes now** (instrumented frame phases, samples of 1 ms):

| Gesture | Set-up frame | Forced style | Forced layout | Script | First frame after |
|---|---|---|---|---|---|
| appear | 13 → 62/66 ms (49–53) | 5 | 2–3 | 32–36 | 6–8 ms |
| unfold | 14 → 128 ms (114) | 86 | 4 | 20 | 26 ms: compositing 2, layer commit 2, layout 1, paint 2 |
| fold | 18 → 130 ms (112) | 81 + 12 | 3 | 14 | 22 ms: compositing 2, layer commit 1, layout 3, paint 1 |

The set-up is now one layout, and that one layout is expensive: 81–93 samples of forced **style** on fold and unfold, all paid at the read phase's first `getBoundingClientRect`. It is a whole-document style recalculation the commit's writes left, not a reader, so no further conversion moves it; it is the engine's frame of [B04], for the probes of Step 6 (the arrangement's custom properties written on the canvas and every layer each commit) and the population of Step 4. `appear` holds no chain in its set-up at all, and its one frame is mostly script.

**Readers not converted.** `_revealArrival`'s responder sync was not named by either reading and is left as it was. A retarget that lowers a standing settled hold, and an over-predicted `arm` hold the Last pass ends, still pay the bottom keeper's read-write-read; `at0733` drives neither, and both are retarget-only costs.

**The verdict.** `at0733` green alone on the slice arm (appear 0 and 0, unfold 1, fold 1), and the step's thirty-file selection green alone file by file (`at0430`, `at0330` and `at0014` were red or wedged only in the 30-file batch). `at0702`'s land is bimodal on this tree, as it was at the base: one frame (20–21 ms) or two (36–38 ms) against the 1.5-period bar, with no commit, forced layout or delivery inside it either way. On this tree it read 36–38 ms in three alone runs, then 20–21 ms in four, on the same code. A probe that restored the render's live height read 21 ms, and so did one that kept the kept height. Step 2 read the base's 37 ms once. The land's cost sits at the bar's edge whatever the set-up does, and the land is Step 7's.

## The parked half leaves the render tree (user's deck and harness, 2026-10-13)

**Instrument.** `tugtool deck motion walk --arms parked-absent,parked-content-hidden,rail-parked-content-hidden`, the walk's new parked arms. Each one writes its subject inline and times a **forced layout** against a baseline taken just before it, 20 cycles a measure with one read per frame, by mean, because the page clock ticks in whole milliseconds. Two writes are timed. *Fixed* is a hidden fixed 1 px element's width, the floor of any forced layout. *Inherited* is `word-spacing` on `body`, which no rule sets and every text box inherits, so its read lays out every box that holds text, parked or shown, unless the engine skips it. Both are put back in the same task. The walk's own compositing reading rides beside them. Quiet loops are paused for the bursts, so these are instrumented numbers.

**The user's deck, before** (read-only, Release build, 16,610 elements; one parked layer of 9,480; no parked rail), two runs:

| Arm | Removed (elements) | Inherited forced layout saved (ms), of the baseline | Fixed saved |
|---|---|---|---|
| `parked-absent` | 6,926 | 23.5 (21.4–29.0) of 99.6; 24.6–27.7 of 101.7 | noise |
| `parked-content-hidden` | 6,536 | 20.75 (19.9–86.9) of 100.2; 19.8–23.8 of 100.4 | noise |

`content-visibility: hidden` does not keep the parked content out of a forced layout on this engine: a fifth of a whole-document layout on the user's deck is content nobody can see. By [P04]'s rule the content rule is built. The raw outputs are in the arc's `step-4-raw/`.

**The harness, before and after** (`at0734-parked-content-bench`: workspace two parks two slice session cards and an Overview with 60 posts; workspace one shows a Text card and hides its Layout rail; 5,946–5,957 elements). The plan named `at0727`'s deck, which has no parked workspace, so the bench got its own file. The before run reversed the content rule out under `tugtool file probe`.

| Arm | Before the rule: inherited saved of baseline (ms) | After the rule |
|---|---|---|
| `parked-absent` | 13.05 of 16.35 | 0.90 of 4.35 |
| `parked-content-hidden` | 12.20 of 17.00 (11.9, 12.2, 12.7) | 0.10 of 4.65 |
| `rail-parked-content-hidden` (697 elements) | 0.50 of 17.15 (0.5, 0.8, 0.5) | 0.80 of 4.35 |

- **The rule took the share.** The document-wide forced layout fell from 16–17 ms to 4.35–4.65 ms. The content arm now saves nothing it can resolve, and `parked-absent`'s remaining 0.9 ms is the parked frames' own boxes, which stay so every sweep finds a parked pane where its reveal will.
- **The rail's content is not taken out.** Its arm read 0.5 ms on 697 elements, at the walk's own moved floor, and a rail's show would rebuild the content's boxes inside a slide, plus a held list-view re-anchor, for a saving the instrument cannot tell from noise. Ruling: the rail keeps `content-visibility: hidden` alone. Reopen if a hidden rail ever carries a large population, the Overview's twin above all; the user's deck parked no rail when it was read.
- **The switch's lead**, a budget under set-up-and-go, `settle --gesture switch --count 2 --quiet-instruments`: 14.0 and 16.0 ms before the rule, 16.0 and 15.0 ms after (longest gap 48/62 ms before, 52/23 after). The reveal's rebuild of the content's boxes is inside the lead and does not move it on this deck.
- **What moved with it.** A scroller with no box keeps no offset, so `CardHost` captures each one from the layer's shown source at the hide, before the commit that hides it, and puts it back from a `ResizeObserver` when the content has a box again. List views re-land through their own reveal seam. `at0587`'s new clause scrolled to 636 px with the bag holding 3180, and came back at 636. The composer's line-box metric re-measures on the geometry change that returns a box, only while its rows have none. `at0642`'s content claims moved with the reversal: rows measure 0 in the dark, and 20.14 px before the park and after the reveal. `at0643`'s premise now counts loop targets with a box: the six card hosts inside the parked content are off the animation timeline until the switch shows them.

**The verdict.** The 28-file selection (the derived 26 plus `at0723` and `at0704`) ran in 6 min 31 s, 27 green. `at0643` was red on its loop-count premise, which counted loops that no longer run; it was moved as above and is green alone (21 s). The user's deck does not run this code ([P08]), so its after row is owed until a relaunch on a build carrying it.

## The standing taxes, read then ruled (user's deck and harness, 2026-10-13)

**Instrument.** `tugtool deck motion rest --window 3000 --frame-phases`, new in this step. It records WebContent with the Time Profiler at 1 ms over one rest window and files the samples by the rest chain's own stamps. It reports the window's phases (style, layout and compositing split engine from forced, with the forcing entry named), the GC's share of the busy samples, the stall rows the rest count reads, and WebContent's resident size. A page that predates the stamps, such as the user's Release deck, is filed as one row by the wall clock around the eval. `deck motion chains --mode read` now also ranks every read that paid at least 0.5 ms by site, chained or not, because at rest nothing chains. The harness reading is `at0735-standing-taxes-reading`: `at0725`'s deck, four session cards with three streaming a stubbed turn, launched in front of the screen, since an occluded window has the off-screen rule still every loop. The heap beside a parked workspace is `at0734`'s new note. Every priced number is instrumented. The quiet `rest` line is the count of record.

**The user's deck** (read-only, Release build, sessions working):

- Quiet: 21 updates/s, 166 ms/s held (worst gap 28 ms). The loops in the first session card were five dots (breathe, emit-expand, emit-fade each), the wave's three bars, and `tug-text-editor-caret-blink`.
- Priced, filed by the wall clock: 774 busy samples over 3,017 ms. Style 16/4, layout 29/**162**, compositing 52/12 (engine/forced); layer commit 30, paint 12, script 298, rendering update 50, other 109. **GC 0 (0.0 %).** WebContent RSS **4,238 MB**. The forced layout was entered by `scrollTop` (93), `offsetTop` (48), `getComputedStyle` (21) and `scrollHeight` (16). The chain probe found 0 chains over 3,157 entries. Its paying-read ranking is new in this build, so naming those readers on the user's deck is owed until a relaunch.

**The harness** (`at0735`, slice arm, 2,574 elements, 24 loops on the deck: 6 dots × 3 timelines and 2 waves × 3 bars):

| Reading | Busy samples / 3 s | Layout e/f | Compositing e/f | GC | RSS |
|---|---|---|---|---|---|
| quiet (of record) | 26 updates/s, 125 ms/s | — | — | — | — |
| dots running, composer blurred | 736 | 115/42 | 108/73 | 2 (0.3 %) | 436 MB |
| demoted, composer blurred | 758 | 171/38 | 96/60 | 1 (0.1 %) | 560 MB |
| dots running, composer focused | 858 | 168/38 | 121/102 | 0 | 567 MB |

The forcing entries were alike in all three: `checkVisibility` 59–90, `scrollHeight` 36–53, `scrollTop` 16–22, `clientHeight` 1–4. The paying-read ranking under the chain probe found nothing of size: three `clientHeight` reads of 3 ms in all, under 30 chains.

**The heap beside a parked workspace** (`at0734`, one rest window, before the content rule reversed under `tugtool file probe` and on the tree): WebContent RSS 480 MB before and 432 MB after. GC 0 of 104 and 0 of 84 busy samples.

**The rulings.**

- **The dots keep their three timelines.** Demoting every loop on the deck left the busy time where it was (758 samples against 736 with the dots running, and 760 against 754 in the run before). The dots' tick is not the rest cost, so by [P05] the collapse to two timelines is not built, and `breathKeyframes` and `tug-progress-pulsing-dot.css` are unchanged.
- **The native caret's animator has no supported lever, so it is recorded, not stopped ([Q02], resolved).** With the composer focused, 27 of 858 samples ran `OpacityCaretAnimator::updateAnimationProperties` → `FrameSelection::recomputeCaretRect` → `VisiblePosition::canonicalPosition` → `Document::updateLayout` (style resolve and layout) inside `Page::updateRendering`, about 9 ms/s. Blurred, it ran in none. The caret is already `caret-color: transparent`.
  - `CSS.supports("caret-animation", "manual")` is false on this WebKit.
  - Moving the native selection out of the editor would take the selection away from the editor the user is typing in.
  - On the host side, the switches this WebKit carries are `WebPageProxy::setCaretBlinkingSuspended`, which is C++ with no Objective-C selector, and the private per-app accessibility preference `_AXSPrefersNonBlinkingCursorIndicatorApp`, which is the user's setting and not the app's to write.
  - The layout the animator runs is the next layout of a frame the streams have already dirtied, read first. Removing the reader would move that layout to the next reader, not remove it.
- **The heap is a finding, not a build.** The GC's share at rest is 0–1.1 % of the busy samples on the harness and 0 % on the user's deck, far under the tenth [P05] sets, so no census of retained structures is opened. The one lever this arc holds, the document's size, moved WebContent's resident size by about a tenth beside a two-card parked workspace (480 → 432 MB). The user's deck's 4,238 MB is the before for that rule. Its after is owed until the relaunch Step 4's own after row waits on.
- **The forced layout at rest is the streaming frames' own layout, paid by its first reader.** It was not one of the plan's three taxes, and it is the largest of them: about 40–55 ms/s on both decks. On the harness the largest entry is `checkVisibility`. Its one caller at rest is the transcript pin stack's stuck pass in `tug-transcript-entry.tsx`, which runs in a `requestAnimationFrame` after each scroll a streamed row's follow-bottom makes (the responder chain's other caller runs only on a key press). The `scrollHeight` and `scrollTop` entries are the follow-bottom reads themselves. Each lays out a tree the streams already dirtied, ahead of the rendering update that would lay it out anyway. So it is that frame's layout, moved forward, and a cached read only hands it to the next reader, which is why the program's 7 ms height cache was reverted. Ruling: no build here. The user's deck's different entries (`offsetTop`, `getComputedStyle`) are named by the paying-read ranking once that deck runs this build.

## The engine's frame after the commit (harness, 2026-10-13)

**Instrument.** `at0733` with `TUG_AT0733_PHASES=1`, eight slice session cards (13,763 elements), appear and fold/unfold, two drives each, `--frame-phases` (instrumented). There is no whale snapshot on this machine, so the whale arm is owed. Each probe ran under `tugtool file probe` from a clean tree. The raw reports and the probe diffs are in the arc's `step-6-raw/`.

**The before.** The first frame after the commit was not the engine's own frame:

| Drive | Frame 1 (ms) | Its samples | Longest gap |
|---|---|---|---|
| appear | 50–55 | script 32–38; style forced 4–9; compositing 1–5; layer commit and paint 0–1 | 112–122 ms |
| fold / unfold | 107–116 | **style forced 87–96**, through `getBoundingClientRect` (84); script 15 | 107–116 ms |

**The probes of List L01, by rank.**

- **Restyle scope, as written** (skip every `writeArrangementVariables` write whose value already stands): fold 108–115 ms, forced style 86–97. No move: an unchanged `setProperty` already invalidates nothing on this engine, which `flow-offset.ts` records too.
- **Restyle scope, isolated** (the arrangement written once per element, then frozen; an attribution probe that breaks geometry): fold **51–67 ms**, forced style **31–39**; appear's frame 1 unchanged at 50–51, its longest gap 50–51 ms. The values that *change* on a fold are the cost. They are inherited custom properties written on the canvas and on every layer, so a changed seam invalidates every descendant, and the next geometry read pays a style resolve of the whole deck.
- **Population** was Step 4's; its after is the before above.
- **Layer commit size** is not probed: frame 1's layer-commit and paint share is 0–2 samples, which bounds what pre-promoting the moved frames could buy at under one display period.

**What was built.** A column's seams, offset and strip coordinates are written on the slot's readers alone: its imposed frames under each layer, and its seams under the canvas (`place-properties.ts`, the [D204] shape `flow-offset.ts` already holds for the offset). They stay unregistered, because every reader's `var()` fallback is the geometry it was rendered against. A seam's fallback is the equal division, though, so each layer's standing values are kept, and a frame that comes to stand in a slot adopts them in its own layout effect. The seam drag, the column autoscroll and the test surface's offset hook write through the same door. `at0456`'s two property reads moved from the canvas to a slot-0 frame, where the frames' `calc()`s now read them: the same guarantee in its new place.

**The after:**

| Drive | Frame 1 (ms) | Forced style | Longest gap |
|---|---|---|---|
| fold / unfold | **77–83** (was 107–116) | **50–54** (was 87–96) | 77–83 ms |
| appear | 53–54 (was 50–55) | 5–6 | 106–110 ms |

- **Fold** lost about 30 ms of its first frame, about two display periods.
- **Appear's first frame is script, and no probe moved it.**
- **Two remainders are named and not built.**
  - The freeze probe halved appear's longest gap, in a later frame than frame 1, and took fold to 51–67 ms against the build's 77–83. The difference is the arrangement properties still written on the ancestors. The likely one for appear is the flow strip's length (`FLOW_STRIP_PROPERTY`), which an appear lengthens. It is still read by its readers' clamp through inheritance, and the keep-slot drag finds it by walking ancestors in `tug-pane.tsx`.
  - Moving the strip length would rework that drag on an attribution no probe has isolated. The probe that settles it is the freeze probe restricted to `FLOW_STRIP_PROPERTY`.

**The verdict.** 47 files (the derived selection, `at0696`, `at0697`, `at0702`, `at0705`, `at0706`, `at0733`, `at0644`, `at0700`) ran in 6 min 15 s, all green.

## The height crossing, reopened (harness, 2026-10-13)

**Instrument.** `at0736-height-crossing-bench.test.ts`: eight slice session cards (13,763 elements), the window in front, column 0 holding the subject and its neighbour. `fold` drives a fold and its unfold, and `split` drives a split and its stack, two drives each. Each family is read `--quiet-instruments` (of record) and `--frame-phases` (attribution). *Motion* is the longest gap from the gate's close to the land, and *land* is the hand-back frame. Each shape ran once behind `tugtool file probe` from a clean tree, with the bench file carried in the patch. The patches and raw reports are in the arc's `step-7-raw/`. There is no whale snapshot on this machine, so the whale arm is owed. The user's deck runs a build that predates the arc, so it was not read ([P08]).

**The shapes.**

- **Height**: the crossing as built, a real `height` tween on the frame, with the card inside held at one definite size.
- **Clip**: the frame's box held at the larger of its two heights for the whole crossing, so a growth takes its final box at the commit. The visible height rides a `clip-path: inset()` on the same spring, and the box and the clip come off when the beat lands. The pane is `overflow: clip`, so a shrink's final box cannot show the content still visible below it (Risk R03): the shrink keeps its First box and hands it back at the beat's land, as the height tween does.
- **Two frames, one box**: the height tween as built, with `contain: strict` on the held card root, so the per-frame layout and the walk stop at the root.

**Is the clip composited?** A 2 s `rest --frame-phases` with a standing pane tweening (instrumented):

| Tweening | Style | Compositing | Layout | Updates/s |
|---|---|---|---|---|
| nothing | 0 | 0 | 0 | 0 |
| `transform` | 0 | 0 | 0 | 0 |
| `clip-path: inset()` | 28–31 | 156–213 | 0–3 | 36 |

It is not. The engine re-resolves the clip and recomposites every frame on the main thread, which the bench task named as losing on its own.

**Quiet** (ms; the bar is one period, 16.7, for each):

| Shape | Fold motion | Unfold motion | Fold land | Unfold land | Split motion | Stack motion | Split land | Stack land |
|---|---|---|---|---|---|---|---|---|
| height | 24 | 26 | 37 | 35 | 22 | 20 | 33 | 35 |
| clip | 27 | 27 | 40 | 38 | 19 | 20 | 38 | 41 |
| two frames, one box | 23 | 26 | 34 | 34 | 20 | 20 | 33 | 33 |

**Instrumented**, samples summed over the motion's frames (55 on a fold, 25 on a split), engine/forced:

| Shape | Fold: style, layout, compositing | Split: style, layout, compositing |
|---|---|---|
| height | 72/16–19, 29–31/1–2, 70–71/3 | 40–41/12, 14–15/1–2, 28–34/0–2 |
| clip | 32–42/12–13, 7–14/0–3, 66–71/9–11 | 8–11/11–12, 2–3/3–5, 32–41/3–4 |
| two frames, one box | 63/11–16, 25–35/2–3, 63–69/5 | 32–35/10, 19–26/1–3, 35–42/2–3 |

**The ruling.**

- **Neither shape holds the bar, so the [D9] ruling stands.**
  - The clip takes the frame's per-frame layout away: 29–31 samples on a fold become 7–14. But the motion's frames are style and compositing, which every shape pays, so the motion did not move. The land got 3–6 ms worse.
  - `contain: strict` changed nothing beyond the run-to-run spread.
- **The motion's 20–27 ms gaps are the deck's style and compositing per frame.** The height term's layout is not what makes them.
- The new numbers are written beside the standing ruling in `tuglaws/animation-doctrine.md`. `at0736` stays as the bench's instrument. Its one bar beyond the reading's own sanity is the clip's premise: a clip tween costs main-thread work a transform tween does not, so a red there reopens the clip shape.

**A defect the verdict found in the column properties.** Every settle file reads 0 ticks with its window suspended on this machine unless the window is in front, so the verdict was read with the windows in front. Read that way, `at0705`'s bullseye exit paid a forced layout (2 ms) or a list view's re-window in its land frame, red twice. It was green in front on the arc's base and with the column-property commit reversed, and green with that commit's frame adoption removed. The adoption overwrote the slot's values on a frame coming back out of bullseye, which already carried them. It now writes only the values a frame is missing, which is the whole of its purpose, the fallback to the equal division (`place-properties.ts`, pinned by `place-properties.test.ts`). After the fix, nine of the eleven files passed in one batch in front. `at0724` passed in front alone; in the batch its window was still covered. `at0456` passed alone; in the batch its seam drag landed no weights record.

## The deck of record (owed)

The user's deck runs a Release build that predates this arc, so none of its code has been read there ([P08]). The aged reading of the four gestures on arc code is owed: `appear`, `fold`/`unfold`, `slot` and `split`/`stack`, quiet and under `--streaming <n>` with turns in flight, with `rest --frame-phases` beside them. It is to be taken after the join and a relaunch onto a build carrying it, once the deck has aged through a working day. The same relaunch owes three more readings: the parked content's after row (Step 4), WebContent's resident size beside a parked workspace (Step 5), and the paying-read ranking's names for that deck's forced layout at rest (Step 5). The whale arm's rows are owed on every step's harness reading, because this machine has no whale snapshot.
