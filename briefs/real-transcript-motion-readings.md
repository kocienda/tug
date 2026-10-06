# Real-transcript motion — readings

Every reading this arc takes, harness and user's deck, in the order taken. Harness readings are taken on the arc's tree with `just app-test`; the user's deck is read at the hand-backs, with the worktree's own `./tugrust/target/debug/tugtool`, and pasted verbatim. A harness number is never written where a user's-deck reading belongs.

## Fixture census

Taken 2026-10-04, Step 4.

- **The slice.** `session-transcript-basic`, resumed through `spawn_session(mode=resume)` into a four-up flow card, renders **1,510 elements** per card. Six slice cards on the `at0686` deck: 11,111 elements and 780 stacking contexts in the whole document. That is above the 1,000-element floor ([R03]) and close to the user's 1,752-element `hazy-radio`, so no larger slice is requested.
- **The whale.** The local corpus (harvested 2026-10-04 in the worktree; 3,530 sessions, 6 whales) does not hold the pinned `763cd1d8…` session. The selected whale is `9365d6b9…`, **142,089,137 bytes**, hardlinked. It resumes and settles in seconds, and renders **1,553 elements** in a four-up or column card and **670** in the switch deck's 360 px cards — the transcript is windowed, so a card's element count follows its visible height rather than its transcript's length. A whale card is therefore not "about 5,000 elements" here; what the whale changes is the transcript's total extent (the scroller's height, the restore target, the extent floor), not the mounted DOM. [F01]'s 4,738-element card was a tall card on the user's deck.
- **Binding moves nothing.** Before binding, after it, and after the restore: active card `at0622-c1`, `flowOffset` 0 on every launch read so far. The restore in `launch` is a guard, not a repair.

## Step 4

### Found: four `at0622` legs were not running

`at0622-deck-settle-frames.test.ts` carried a stray `/**` above its first leg (since `fdc5fa57a`, 2026-09-28) that ran to the next `*/`, ~410 lines later. It commented out four legs: the fold's gesture stamp, the flash, the bounded click task, and the settle's own records. Their recorded history is silence, not green. Step 4 removed the opener, so they run again from this step on both arms.

### `at0686` (slice)

RED. `CoordinateOutOfBoundsError` at the grab: the pane's title bar was at x=1022.5 when the slide was dispatched and, read again 64.0 ms later, at x=−247.5 — outside the window. On empty cards the same read caught the pane mid-travel. 64 ms is not a stall in the test's own round trip; the pane was standing at its Last position with no inverted transform over it, which is a beat that had not started 64 ms after its gesture — the shape of [F01]'s lead. Recorded as a reading, not a fixture fault.

### `at0684` (both arms) — 3/10 green

Every launch bound its cards and restored nothing (the standing notes above). The three green legs: the departure `[whale]`, and the rail show on both arms. The seven red legs are all `COMMIT_BAR` (fibers performed by the window's largest commit) — the bound session bodies are in the commit:

| Leg | Arm | Largest commit (fibers) | Bar | Asked by |
|---|---|---|---|---|
| close (departure) | slice | 2,744 (553 mounted, t=778) | 2,000 | tooltips and popovers inside the cards |
| split (divide) | slice | 1,120 (6 mounted, t=198) | 1,075 | `ConfigureTug`, `DeckCanvas`, `LayoutContent`, `TugListView2` |
| split (divide) | whale | 1,112 (t=177) | 1,075 | `ConfigureTug`, `DeckCanvas`, `LayoutContent` |
| unfold | slice | 537 (t=54) | 212 | `ConfigureTug`, `DeckCanvas`, `SessionCardBody` |
| unfold | whale | 545 (t=60) | 212 | same |
| switch | slice | 1,434 (t=99) | 1,285 | `TugSheetContent` ×5, `CardsContent` ×2, `DeckCanvas`, `SessionCardBody` |
| switch | whale | 1,440 (t=69) | 1,285 | same |

The close's slice red against its green whale arm is one launch's newcomer timing (553 mounted fibers at t=778 is the arriving picker card's tooltips), not an arm difference; read again at Step 7.

### `at0687` (slice) — GREEN, 16 s. `at0689` (slice) — GREEN, 20 s.

### `at0622` (both arms) — 18/28 green

The ten red legs, with their readings. Every other leg — the four re-enabled ones' remaining clauses included — held its bar on both arms.

| Leg | Arm | Reading | Bar |
|---|---|---|---|
| the settle records its own frames (re-enabled) | slice | row 19 ms vs probe 18 ms on the move's clock | equal |
| the settle records its own frames (re-enabled) | whale | row 23 ms vs probe 24 ms | equal |
| a card appears | slice | 118 ms / 6.94 frames, 3 gaps over one frame, 38 ticks on 10 panes | ≤ 2 frames |
| a card appears | whale | 100 ms / 5.88 frames, 3 gaps, 39 ticks | ≤ 2 frames |
| the walk across the band (home) | slice | lead 18 ms, 0 ms before the canvas armed | ≤ 17.00 ms period |
| the walk across the band (out) | whale | lead 18 ms, 0 ms before arm | ≤ 17.00 ms |
| bullseye enter | slice | 43 ms / 2.53 frames, 2 gaps, 39 ticks on 5 panes | ≤ 2 frames |
| bullseye enter | whale | 133 ms / 7.82 frames, 4 gaps, 31 ticks | ≤ 2 frames |
| sidebars hide | slice | 90 ms / 5.29 frames, 2 gaps, 40 ticks on 6 panes | ≤ 2 frames |
| sidebars hide | whale | 91 ms / 5.35 frames, 2 gaps | ≤ 2 frames |

Two shapes. The gap legs (appear, bullseye, sidebars hide) are frames lost inside the motion once the cards carry transcripts — the whale's bullseye at 7.82 frames against the slice's 2.53 is the one place the arms part sharply. The walk's two leads are 1 ms over a 17 ms period with nothing spent before the canvas armed, which is the lead [F01] names in miniature. The re-enabled records leg disagrees by 1 ms in each direction between two whole-millisecond clocks; it has been inert since 2026-09-28, so this is its first reading in a week, and whether the equality can hold on a whole-millisecond clock is a question for the instrument, not the transcript.

None of these is moved or re-pointed here. They are the baseline Step 7 takes and Step 9 answers; any still red at the close stops the arc ([P11]).

## Step 5

Taken 2026-10-04, on the arc's tree at this step, the nine files run together (`just app-test-build …`, 14 tests, 7/9 files green). Every card bound and censused: the slice at 1,510 elements per card and the whale at 1,553 (670 in `at0643`'s 360 px cards). No card showed a picker.

### How the cards were bound

`at0555`, `at0557`, `at0563`, `at0566` and `at0605` already carried Session cards; each now resumes every one of them, not only the card it once bound. `at0582`'s three `hello` cards are now Session cards, so the card that leaves carries a transcript. `at0583` binds the Session card it opens. `at0621`'s walked workspace now holds Session cards, and its other workspace keeps its plain cards. `at0643` binds each workspace's cards while that workspace is on screen, because a parked layer has no height for a transcript to settle into.

**The synthetic turns are gone, not re-addressed.** `at0605` and `at0643` grew their cards by `driveSession` `send` + `ingestFrame`. On a resumed card a `send` is a real turn sent to `claude` (`CodeSessionStore.send`; `suppress` hides the turn but still sends it). So re-pointing the frames at the resumed `tugSessionId` would have run real model turns inside an app-test. The real transcript already overflows each scroller several times over, and that overflow is all the turns ever stood in for. `at0643`'s growth floor (more than 2,000 elements under the layers) holds at 11,128 (slice) and 9,448 (whale).

### Verdicts

| File | Slice | Whale |
|---|---|---|
| `at0557` | GREEN | (slice only) |
| `at0563` | GREEN | (slice only) |
| `at0582` | GREEN (worst drift 0.00 px; the land armed nothing) | (slice only) |
| `at0583` | GREEN (inert, `pointer-events: none`, focus outside, one frame) | (slice only) |
| `at0566` | GREEN | GREEN |
| `at0605` | GREEN (0 deliveries inside every crossing; 3 at launch on the stack's growth, 3 at release on each shrink) | GREEN (same counts) |
| `at0621` | GREEN | GREEN |
| `at0555` | RED | RED |
| `at0643` | RED | RED |

### `at0555` — the fold starts late

"The fold shrinks from the launch": the subject's frame starts moving 120 ms (slice) and 134 ms (whale) after the gesture, against a bar of 105 ms (the 80 ms prepare beat plus 25 ms). Its other claims held: one motion, a composer spread of 0.00, the draft survived, and the retarget closed nothing early. The show's wall starts at 99 ms and 90 ms. A late first beat on a bound card is [F01]'s lead.

### `at0643` — the switch's first paint is late

First switch A→B: the first painted frame arrives 149 ms (slice) and 132 ms (whale) after the gesture, against the 100 ms bar. Of that, 117 ms and 102 ms are React's render phase before the swap commit. The largest commit performs 1,834 of 4,020 fibers (whale: 1,846 of 4,044), and `SessionCardBody` on both layers is among its causes. A geometry read of 55–91 ms (`clientHeight`) sits at 21–34 ms into every switch. The other three switches read 137–174 ms to first paint, and the test stops at the first. The gap bar held on every switch: longest gap 21–33 ms, against 34 ms. The drift warnings fired: one to three gaps over the 20 ms budget on each switch.

None of these is moved or re-pointed. They join Step 4's readings as the baseline Step 7 takes.

## Step 6

Taken 2026-10-04, `at0690-real-transcript-asks.test.ts` alone on the arc's tree at this step (`just app-test-build`, 6 tests, 2 green). Every card was bound and censused: slice 1,510 elements per card, whale 1,553. Binding moved nothing: `at0622-c1` was active and `flowOffset` was 0 before binding, after it, and after the restore, on every launch.

Each test stops at its first failed assertion, so the table reads every clause off the leg's noted rows rather than off the failure alone. Bars: gap ≤ 2 frames; move start ≤ one frame; lead ≤ 2 frames on the seat; [D9] allows `height` on the seat and `height`/`width` on the rails.

| Leg | Arm | Longest gap | Lead | Move start | Pose / opacity / landing | Fixed descendants | [D9] | Verdict |
|---|---|---|---|---|---|---|---|---|
| seat into slot 1 | slice | **99 ms / 5.82 fr** | **99 ms** | 0 ms | clean | **4** | `height` only | RED |
| seat back to slot 2 | slice | **102 ms / 6.18 fr** | 10 ms | **23 ms** (period 16.5) | clean | **4** | `height` only | RED |
| seat into slot 1 | whale | **93 ms / 5.47 fr** | **93 ms** | 0 ms | clean | **4** | `height` only | RED |
| seat back to slot 2 | whale | **75 ms / 4.41 fr** | 10 ms | **44 ms** | clean | **4** | `height` only | RED |
| one sidebar hide | slice | **54 ms / 3.18 fr** | 9 ms | — | — | — | `height` | RED |
| one sidebar show | slice | **81 ms / 4.76 fr** | 10 ms | — | — | — | `height` | RED |
| fit | slice | **85 ms / 5.00 fr** | 6 ms | — | — | — | `height`, `width` | RED |
| one sidebar hide | whale | **56 ms / 3.29 fr** | 9 ms | — | — | — | `height` | RED |
| one sidebar show | whale | **82 ms / 4.82 fr** | 11 ms | — | — | — | `height` | RED |
| fit | whale | **82 ms / 4.82 fr** | 12 ms | — | — | — | `height`, `width` | RED |
| loops at rest | slice | 0 updates/s (bar 10), 0 ms/s busy, worst gap 2 ms | | | | | | GREEN |
| loops at rest | whale | 1 update/s, 5 ms/s busy, worst gap 6 ms | | | | | | GREEN |

### Every beat's start

| Leg | Slice | Whale |
|---|---|---|
| seat into slot 1 | `move` −1 (cut), then `shrink` 134 ms, `move` 134 ms | `move` −1 (cut), then `shrink` 150 ms, `move` 150 ms |
| seat back to slot 2 | `move` 94 ms, `grow` 94 ms | `move` 70 ms, `grow` 70 ms |
| one sidebar hide | `depart` 54 ms, `room` 54 ms | `depart` 55 ms, `room` 55 ms |
| one sidebar show | `room` 73 ms, `arrive` 73 ms | `room` 73 ms, `arrive` 73 ms |
| fit | `shrink` 75 ms, `move` 75 ms, `grow` 75 ms | `shrink` 72 ms, `move` 72 ms, `grow` 72 ms |

### What the readings say

- **The seat replans.** Seating into slot 1 armed a `move`-only settle, which was cut before its first frame. A `shrink` then `move` settle replaced it, and its beats first ran 134–150 ms after planning. The worst gap in the seat is that wait, read from the gesture: 93–99 ms. Seating back out plans once, but still starts 70–94 ms after planning.
- **Every beat on every gesture here starts 54–150 ms after planning.** That is the [F01] lead seen beat by beat, and Step 14 bars it.
- **Bound cards put `position: fixed` descendants inside a promoted frame.** The bench probe counted 4 on every seat leg, both arms. This is the clause `at0622`'s activation bar reads as [R01]'s runtime half, and Step 7's baseline says whether the activation legs read it too.
- **Reopening a rail member makes a new card.** After a hide and a show, the Jots member stands under a fresh card and pane id, not `at0622-pj1`. The show's arriving frame is the one off-curve pane (25 ticks while held at opacity 0), which is the exemption `at0622`'s show leg makes. This leg's bar is the gap and [D9] alone, so it does not judge pose.
- [D9] held on every leg: the seat reports `height` only, the rail legs `height` and `width` only.
- At rest, bound cards sit far inside the budget: 0–1 updates a second against 10.

## Step 6 decisions

- `at0690` does not name `tug-list-view.tsx` in `@covers`, although the plan lists it. That module already fans out to its accepted 21 tests, and a 22nd would fail `just app-test-covers-check`. Recorded fan-out is paid down, never refinanced. Step 9, which changes the list view, names `at0690` in its own checkpoint, so nothing is lost.
- The seat's [D9] clause allows `height` and nothing else. That is how `at0622`'s column leg reads the guard, because a column that divides carries the standing `height` hit the law was written knowing.
- The fit leg widens the rails to 900 px before it drives `fit`, as `at0622`'s leg does: rails that already fit give the retune nothing to commit.

## Baseline (harness)

Taken 2026-10-04, Step 7. Build `209cc5130` (`just app-test-build`), then each Table T02 file alone with `just app-test <file>`, three passes in order, every run writing `TUG_APPTEST_JSON`. Every number below is read from those reports' `note()`s and failure messages. Three runs per file; `at0684` has four (see its section).

### Fixture census

Every launch bound its cards, and on the `at0622`/`at0690` decks binding moved nothing: `at0622-c1` active and `flowOffset` 0 before binding, after it, and after the restore.

| File | Slice | Whale |
|---|---|---|
| `at0622` | 4 cards × 1,510; document 7,847 elements, 535 stacking contexts (8 cards: 14,391 / 1,031; rail deck: 8,190 / 572; 3 cards: 6,221 / 416) | c1, c2 whale × 1,553; 7,933 / 579 (8 cards: 14,477 / 1,075; rail deck: 8,276 / 616; 3 cards: 6,307 / 460) |
| `at0684` | as `at0622`'s decks; switch deck 3 × 1,510, 5,588 / 453 | as `at0622`'s; switch deck sa1, sa2 whale × 670, 3,908 / 403 |
| `at0690` | seat 7,847 / 535; rail 8,190 / 572; rest 7,847 / 535 | seat c2, c3 whale, 7,933 / 580; rail c1, c2 whale, 8,276 / 616; rest 7,933 / 579 |
| `at0555` | A, B, C × 1,510; 4,912 / 372 | B whale; 4,955 / 406 |
| `at0557` | S × 1,510; 1,665 / 137 (stacked 1,668 / 130) | (slice only) |
| `at0563` | A × 1,510; 1,668 / 131 | (slice only) |
| `at0566` | A, B × 1,510; 3,302 / 252 | B whale; 3,345 / 286 |
| `at0605` | A, B × 1,510; 3,302 / 252 | A, B whale; 3,388 / 295 |
| `at0582` | C, D, E × 1,510; 4,934 / 376 | (slice only) |
| `at0583` | the opened card × 1,510; 1,913 / 175 | (slice only) |
| `at0621` | a-c1..a-c4 × 1,510; 7,847 / 531 | a-c1, a-c4 whale; 7,933 / 575 |
| `at0643` | 6 × 1,510; 11,184 elements (11,128 under layers), 24 loop animations | sa, sd whale × 670; 9,504 (9,448 under layers) |

### Verdicts, three passes

| File | Pass 1 | Pass 2 | Pass 3 |
|---|---|---|---|
| `at0622` | RED 21/28 | RED 21/28 | RED 21/28 |
| `at0684` | RED 3/10 (2/10 armed re-run) | RED 2/10 | RED 2/10 |
| `at0690` | RED 2/6 | RED 2/6 | RED 2/6 |
| `at0555` | RED 0/2 | RED 0/2 | RED 0/2 |
| `at0643` | RED 0/2 | RED 0/2 | RED 0/2 |
| `at0557` | GREEN 1/1 | GREEN 1/1 | GREEN 1/1 |
| `at0563` | GREEN 1/1 | GREEN 1/1 | GREEN 1/1 |
| `at0566` | GREEN 2/2 | GREEN 2/2 | GREEN 2/2 |
| `at0605` | GREEN 2/2 | GREEN 2/2 | GREEN 2/2 |
| `at0582` | GREEN 1/1 | GREEN 1/1 | GREEN 1/1 |
| `at0583` | GREEN 1/1 | GREEN 1/1 | GREEN 1/1 |
| `at0621` | GREEN 2/2 | GREEN 2/2 | GREEN 2/2 |

The red set is the same on every pass. Two tests flip inside it, by launch rather than by arm: `at0622`'s "an arrival interrupted by a close" fails its own precondition (the close landed after the arrival was over: "rows []") on whale in pass 1 and slice in passes 2 and 3; and `at0684`'s close (below).

### Per ask: lead, longest gap, beat starts

Lead is the row's `firstPaintDelayMs`, gap is `longestGapFrames`, and beat starts are each `settle-beat`'s `startDelayMs`, all per pass (1 / 2 / 3). Bars, as each test holds them: gap ≤ 2 frames (resize-to-fit 2.5), lead ≤ one period (`at0622`'s `expectB09Bar`) or ≤ 2 frames (`at0690`'s seat). Each test stops at its first failed clause, so a leg after it is marked "not reached", and its numbers are still read.

| Ask | Leg | Arm | Lead ms | Gap frames | Beat starts ms | Verdict |
|---|---|---|---|---|---|---|
| Card appear | `at0622` appear | slice | 6 / 5 / 6 | **7.35 / 6.88 / 6.59** | room, arrive 104 / 101 / 94 | RED |
| | | whale | 5 / 7 / 5 | **6.12 / 6.00 / 5.76** | 84 / 84 / 82 | RED |
| Card disappear | `at0622` disappear (beats only; gap not barred) | slice | 3 / 4 / 4 | 7.18 / 7.06 / 7.29 | depart, room 109 / 108 / 112 | GREEN |
| | | whale | 4 / 4 / 3 | 5.94 / 6.12 / 6.00 | 90 / 94 / 91 | GREEN |
| | `at0582` / `at0583` | slice | worst drift 0.00 px; inert, `pointer-events: none`, focus outside | | | GREEN ×3 |
| Split layout | `at0690` seat into slot 1 | slice | **101 / 129 / 110** | **5.94 / 7.59 / 6.47** | `move` cut, then shrink, move 157 / 141 / 174 | RED |
| | | whale | **102 / 121 / 95** | **6.00 / 7.12 / 5.59** | `move` cut, then 0 / 120 / 164 | RED |
| | `at0690` seat back to slot 2 | slice | 6 / 6 / 6 (move 25 / 25 / 24) | 6.18 / 5.82 / 6.24 | move, grow 97 / 92 / 99 | not reached |
| | | whale | 6 / 8 / 9 (move 43 / 44 / 45) | 4.88 / 4.53 / 4.94 | 72 / 71 / 78 | not reached |
| | `at0622` column, four `set-column-mode` (reports `height`; gap not barred) | slice | 1 / 0 / 1 (move 147 / 150 / 165) | 14.65 / 14.12 / 14.82 | — | GREEN |
| | | whale | 1 / 1 / 5 (move 158 / 152 / 15) | 13.35 / 13.47 / 16.12 | — | GREEN |
| Fold and unfold | `at0555` show: the wall starts (bar < 105 ms) | slice | 120 / 128 / 120 | | | RED |
| | | whale | 100 / 95 / 106 | | | RED in pass 3 here |
| | `at0555` fold: the fold starts (bar < 105 ms) | whale | 121 / 121 / not reached | | | RED |
| | `at0622` spend-once fold (gap not barred) | slice | 6 / 7 / 62 | 2.47 / 2.88 / 3.88 | | GREEN |
| | | whale | 16 / 58 / 63 | 2.61 / 3.41 / 3.71 | | GREEN |
| | `at0557`, `at0563`, `at0566`, `at0605` | both | `at0605`: 0 deliveries inside every crossing, 24 of 24 | | | GREEN ×3 |
| Flow slide | `at0622` "the settle records its own frames" (row and probe agree; lead not barred) | slice | 17 / 17 / 18 | 1.45 / 1.18 / 1.18 | | GREEN |
| | | whale | 21 / 20 / 20 | 1.88 / 1.62 / 1.82 | | GREEN |
| | `at0622` retarget/slide (gap not barred) | slice | 61 / 15 / 12 | 3.59 / 2.94 / 3.00 | | GREEN |
| | | whale | 59 / 9 / 62 | 3.47 / 2.88 / 3.65 | | GREEN |
| | `at0621` | both | | | | GREEN ×3 |
| Go-to-slot | `at0622` out | slice | 8 / 16 / 16 | 1.53 / 1.27 / 1.35 | move 17 / 68 / 0 | GREEN |
| | | whale | 7 / 16 / 16 | 1.81 / 1.41 / 1.47 | move 19 / 66 / 62 | GREEN |
| | `at0622` home | slice | 13 / 12 / 16 | 1.94 / 1.18 / 1.18 | move 21 / 0 / 0 | GREEN |
| | | whale | 16 / 11 / 14 | 1.18 / 1.24 / 1.35 | move 15 / 19 / 17 | GREEN |
| | `at0622` forced (a planted stall must fail the bar) | slice | | 12.88 / 12.88 / 12.88 | | GREEN |
| | | whale | | 12.82 / 13.69 / 14.53 | | GREEN |
| Bullseye | `at0622` enter | slice | 6 / 5 / 9 | **2.12 / 2.47 / 2.53** | shrink, move 35 / 41 / 42 | RED |
| | | whale | 4 / 10 / 10 | **7.00 / 7.29 / 7.24** | 34 / 45 / 39 | RED |
| Sidebar hide and show | `at0622` sidebars hide | slice | 9 / 10 / 9 | **5.24 / 6.35 / 5.41** | depart, room 91 / 105 / 92 | RED |
| | | whale | 10 / 12 / 10 | **5.18 / 6.18 / 5.53** | 90 / 101 / 97 | RED |
| | `at0622` sidebars show | slice | 7 / 9 / 13 | 4.41 / 4.35 / 4.12 | room, arrive 65 / 64 / 60 | not reached |
| | | whale | 9 / 10 / 15 | 4.35 / 4.47 / 4.47 | 64 / 66 / 65 | not reached |
| | `at0690` one sidebar hide | slice | 10 / 9 / 9 | **3.71 / 3.82 / 3.35** | depart, room 55 / 64 / 56 | RED |
| | | whale | 10 / 12 / 12 | **3.29 / 3.82 / 4.47** | 55 / 62 / 68 | RED |
| | `at0690` one sidebar show | slice | 11 / 11 / 11 | 4.88 / 4.82 / 4.94 | room, arrive 75 / 74 / 77 | not reached |
| | | whale | 12 / 12 / 11 | 4.82 / 4.82 / 4.82 | 75 / 75 / 74 | not reached |
| Resize-to-fit | `at0622` resize to fit (bar 2.5) | slice | 4 / 3 / 11 | 4.76 / 4.94 / 5.29 | shrink, move, grow 71 / 74 / 81 | not reached |
| | | whale | 5 / 10 / 4 | 5.27 / 5.29 / 5.19 | 77 / 82 / 74 | not reached |
| | `at0690` fit | slice | 4 / 7 / 9 | 5.15 / 5.12 / 5.62 | 76 / 79 / 82 | not reached |
| | | whale | 3 / 7 / 4 | 4.94 / 4.97 / 4.82 | 75 / 74 / 74 | not reached |
| Loops | `at0690` rest (bar 10 updates/s) | slice | 0 / 0 / 0 updates/s; busy 0 / 0 / 0 ms/s; worst gap 2 / 2 / 2 ms | | | GREEN |
| | | whale | 2 / 0 / 0 updates/s; busy 27 / 0 / 0 ms/s; worst gap 22 / 3 / 2 ms | | | GREEN |
| No activation fade | no live assertion (see below) | both | | | | — |
| Workspace switch | `at0643` first switch A→B, first paint (bar 100 ms) | slice | **147 / 164 / 160** (React 116 / 134 / 130) | | | RED |
| | | whale | **141 / 149 / 134** (React 107 / 117 / 104) | | | RED |

`at0643`'s other three switches, not reached: first paint 118–157 ms (slice) and 127–152 ms (whale); longest gap 23–44 ms (slice) and 24–34 ms (whale), against a gap bar of 34 ms. Slice pass 3's A→B #2 read 44 ms, over that bar.

### `at0684`: the largest commit and React's time

Pass 1 ran before the lead recorder was armed at each leg's mark, so its `reactMs` read null on every commit. It was re-run armed, and that run is pass 1 below. The unarmed run's fiber counts are kept as pass 0. Fibers are the largest commit's `performed`; `react_ms` is the sum of every commit's render-start-to-commit in the window.

| Leg | Arm | Largest commit: performed fibers (mounted), passes 0 / 1 / 2 / 3 | Bar | Summed `react_ms`, passes 1 / 2 / 3 | Commits | Verdict |
|---|---|---|---|---|---|---|
| close (departure) | slice | 543 (0) / **2,741 (553)** / **2,741 (553)** / **2,741 (553)** | 2,000 | 116 / 119 / 120 | 12 | GREEN, RED, RED, RED |
| | whale | **2,729 (553)** / 543 (0) / **2,735 (553)** / **2,729 (553)** | 2,000 | 106 / 97 / 107 | 12 | RED, GREEN, RED, RED |
| rails (show) | slice | 45 (0) all four | | 60 / 59 / 61 | 1 | GREEN |
| | whale | 45 (0) all four | | 57 / 56 / 59 | 1 | GREEN |
| split (divide) | slice | **1,120 (6)** all four | 1,075 | 113 / 112 / 114 | 8 | RED |
| | whale | **1,112 (6)** all four | 1,075 | 108 / 104 / 105 | 10–11 | RED |
| unfold | slice | **537 (0)** all four | 212 | 43 / 42 / 41 | 3 | RED |
| | whale | **545 (0)** all four | 212 | 44 / 42 / 46 | 3 | RED |
| switch | slice | **1,434 (6)** all four | 1,285 | 90 / 86 / 90 | 8 | RED |
| | whale | **1,440 (6)** all four | 1,285 | 79 / 74 / 75 | 8 | RED |

The close's red is one commit at t = 760–790 ms, mounting 553 fibers (`PopperAnchor`, `TugTooltip`, `Tooltip` ×9, `TugProgressPulsingDot2` ×5, popovers). When the window ends before it, the largest commit is 543 fibers at t ≈ 100 ms and the leg is green. That is a launch-timing coin, not an arm difference: each arm went green once in four runs.

### The open questions, answered

**Which asks fail on real transcripts beyond Go-to-slot?** On the harness, Go-to-slot itself is green: out and home hold the bar on both arms, every pass, and its forced leg proves the bar can fail. The asks that fail every pass, on both arms, are these:
- **Card appear:** gap 5.8–7.4 frames.
- **Split layout:** the seat's 95–129 ms lead after a cut-and-replanned settle, and `at0684`'s divide commit.
- **Fold and unfold:** `at0555`'s late starts, and `at0684`'s unfold commit.
- **Bullseye:** enter gap.
- **Sidebar hide and show:** both files' hide, with the show and fit legs not reached and reading 4.1–5.6 frames.
- **Resize-to-fit:** not reached, and reading over its bar on every pass.
- **Workspace switch:** `at0643`'s first paint, and `at0684`'s switch commit.

Card disappear's gap is not barred, and it reads 5.9–7.3 frames. Its `at0684` commit is red in 6 of 8 launches. Green on every pass: flow slide, go-to-slot, loops, and the fold-shape, crossing, rect and inertness files.

**Does any leg's verdict differ between slice and whale?** No leg's verdict differs by arm. The two tests that flip (`at0684` close, `at0622` arrival/close) flip within an arm across passes. Magnitudes do differ, and the clearest case is consistent: **bullseye enter** reads 2.12–2.53 frames on the slice and 7.00–7.29 on the whale, every pass. One leg reads the other way: **seat back** gaps are 5.8–6.2 frames on the slice and 4.5–4.9 on the whale, while its move start is later on the whale (43–45 ms against 24–25 ms). `at0555`'s show wall starts 14–33 ms earlier on the whale.

### Findings

- **"No activation fade" has no live assertion.** Table T02 reads it off "`at0622` activation bar's `minOpacity` clause". That clause, with the `fixedDescendants` clause beside it, lives in `expectBar` (`settle-frames-fixture.ts`), which no test calls any more. `at0622` bars with `expectB09Bar`, which has neither. Its activation leg ("the settle records its own frames") asserts that the row and the probe agree, and does not bar the lead (17–21 ms here, over one period). The probes on the slide-shaped legs read `minOpacity` 1 (retarget/slide, go-to-slot, bullseye). Only the appear and show legs read 0, on the held arriving frame, which is the exemption those legs assert.
- **`position: fixed` descendants are counted on every leg, and asserted only in `at0690`.** Every `at0622` probe reads `fixedDescendants` 4 (8 on the appear deck), on both arms and every pass. So Step 6's 4 on the seat is not particular to the seat. No `at0622` leg fails on it, for the reason above.
- **Every beat on the barred legs starts 34–174 ms after planning, except go-to-slot (0–68 ms) and one seat replan (0 ms).** The seat is the outlier because its first settle is cut before its first frame and replanned. The whale's pass-1 seat-in replan started at 0 ms, and passes 2 and 3 at 120 and 164 ms.
- **The gap legs with no bar read as high as the barred ones:** disappear 5.9–7.3, spend-once fold 2.5–3.9, retarget 2.9–4.7 frames. They are recorded here so that Step 9's answer can be read against them too.
- **`at0684`'s React time is 41–120 ms summed per window.** Split and close each spend over 100 ms of render, the switch 74–90 ms, the rail show 56–61 ms, and the unfold about 42 ms.

### Harness change for this reading

`at0684-settle-window-commits.test.ts` now arms the lead recorder at each leg's mark, and notes each commit's `react_ms` and the window's sum. Nothing else on a harness deck arms it, so `reactMs` was null on every commit before. No bar and no assertion moved; the fiber counts read the same armed and unarmed.

## Hand-back H1

The release deck, before any change. Taken 2026-10-05 00:20–00:24 UTC.

**What this deck is.** The plan asked the user to arrange their own deck and name its ids. The user directed the run to do that work itself, so this deck was stood up by script on the arc's release build, through the release door `window.tugdeck.lab` (`dispatch`, `drive`, `createSpace`, `moveCardToSpace`). It is not the user's own content. The Session cards resume real transcripts, seeded as copies under fresh session ids with the harness's own helpers (four slice, two whale), through the production `resume-session` action. That is the same `spawn_session(mode=resume)` path a user's resume takes.

### The tree and the build

- **Tree:** `d5ddab6b6` on `tugarc/real-transcript-motion`. No source has changed since the harness baseline (`b6b9a144c`, which the arc's round-id remap renamed from `f5bc9b53a`).
- **Build:** `just app-release` in the arc worktree, which launched instance `release-tugarc-real-transcript-motion` (`Tug-release-tugarc-real-transcript-motion.app`, version `0.8.16`). The reader was the worktree's debug `tugtool`, reporting `0.8.16 (d5ddab6b6)`.
- **Window:** 2,501 × 1,384 CSS px, so a flow card stands 1,374 px tall.

### The deck

- **Main**, a four-up flow with the stock rails. The left rail holds dashes, jots and overview; the right rail is the **rail of two**, cards and layout. In the flow:
  - slot 1: the whale `2b22eb0a-8eb4-4dde-a62c-1701cc4d14f1` (A);
  - slot 2: a **split column** of two slices, `231fc4bc-0e76-43a5-8848-cb44e6e9dd1f` over `cb468543-168d-4a4c-9602-a09478b2198c`;
  - slot 3: the whale `e1130abb-c2ae-44fc-9019-85443d429d33` (C).
- **Two**, a second workspace (`dc0c8fcc-e569-4686-ac7f-3be4bdf75e02`) holding a slice and a whale.
- **Census:** the document holds 16,382 elements and 1,191 stacking contexts (6,066 render-layer candidates, upper bound; max depth 40). Each whale card renders 2,179 elements and each slice 1,626. The transcript is windowed, so a card's element count follows its height: no card on this window reaches the ~4,700 of [F01]'s tall card.

**Rest:** before the run, 9 updates/s, holding the main thread 86 ms/s (window 1,000 ms, 743 ticks, median gap 1 ms, worst 12 ms), against a budget of 10 updates/s. Each reading's own rest check is in the second table.

### What each run drove

| Run | Arguments |
|---|---|
| `appear` | none; brings a picker card in and closes it, unread |
| `close` | `--pane cfb562dc-6294-4950-acba-ed92a495c103`, a card the `appear` gesture had just brought in |
| `split` | `--slot 2 --mode stack` (the column stood split, so the first drive stacks it) |
| `slot` | `--card` A `--slot 2`: A into the split column and back |
| `fold`, `unfold` | `--card` C |
| `slide` | `--card` C, after the slot-0 card was focused (see below) |
| `go` | `--slot 3` |
| `bullseye` | `--pane 49a9b920-1c92-4a7e-847c-14d3278a5039` (A's pane) |
| `rails` | none |
| `sidebar` | `--component layout`, a member of the rail of two |
| `fit` | none |
| `flip` | `--card` A |
| `switch` | `--space` Two |
| `slot-tasks` | as `slot`, with `--tasks`; it reloads the deck to install the lead recorder |

Every `settle` ran with `--count 3 --chains --json`, except `slot-tasks`, which ran with `--tasks` in place of `--chains`. `close` and `fit` drive once.

The first `slide`, on A, was refused: "`--gesture slide --count 4` goes back to the focused card between drives, and '`2b22eb0a-…`' is already the focused one". It was re-run on C after the other readings. By then the last `slot` drive had left A in slot 2's column, so C was refused next: "the strip did not travel — `2b22eb0a-…` was already in the band". For the run that read, the slice `de4e8886-99ad-4d3b-b431-79d4d654b3d3` was moved from Two into Main (it landed in slot 0) and focused. The `slide` readings are therefore from a deck one card larger, after the reload, at 12,661 elements.

### Readings

Every number below is generated from the verb's `--json` output (`h1-table.py`). The verbatim outputs, with the commands and timestamps, are kept in the arc's documents at `.tug/arcs/real-transcript-motion/h1/`. Times are in ms from the drive.

| Run | Drive | Lead ms | Longest gap ms | Beats: start ms (landing) | Chains: n / longest / total ms | Largest commit: performed (mounted), react ms |
|---|---|---|---|---|---|---|
| `appear` | 1: appear | 16 | 114 | room 39 (finished), arrive 39 (finished) | 25 / 8 / 33 | — |
|  | 2: appear | 17 | 62 | room 38 (finished), arrive 38 (finished) | 24 / 9 / 39 | — |
|  | 3: appear | 18 | 64 | arrive 24 (finished) | 22 / 9 / 33 | — |
| `close` | 1: close | 44 | 46 | depart 46 (finished) | 12 / 9 / 16 | — |
| `split` | 1: split | 14 | 149 | room 149 (finished) | 8 / 54 / 96 | — |
|  | 2: split | 14 | 149 | room 148 (finished) | 9 / 71 / 106 | — |
|  | 3: split | 14 | 149 | room 149 (finished) | 8 / 55 / 96 | — |
| `slot` | 1: slot | 33 | 186 | move 185 (finished), grow 185 (finished) | 10 / 59 / 127 | — |
|  | 2: slot | 42 | 195 | shrink 195 (finished), move 195 (finished) | 8 / 64 / 133 | — |
|  | 3: slot | 35 | 182 | move 181 (finished), grow 181 (finished) | 10 / 60 / 125 | — |
| `fold` | 1: unfold | 13 | 62 | grow 62 (finished) | 4 / 15 / 28 | — |
|  | 2: fold | 14 | 51 | shrink 51 (finished) | 4 / 9 / 13 | — |
|  | 3: unfold | 14 | 57 | grow 57 (finished) | 4 / 19 / 20 | — |
| `unfold` | 1: fold | 15 | 51 | shrink 51 (finished) | 4 / 9 / 14 | — |
|  | 2: unfold | 14 | 56 | grow 56 (finished) | 4 / 17 / 20 | — |
|  | 3: fold | 15 | 50 | shrink 50 (finished) | 4 / 10 / 14 | — |
| `slide-c` | 1: slide | 26 | 35 | move 28 (finished) | 4 / 2 / 3 | — |
|  | 2: slide | 29 | 36 | move 32 (finished) | 4 / 2 / 2 | — |
|  | 3: slide | 25 | 33 | move 27 (finished) | 4 / 2 / 2 | — |
| `go` | 1: go | 16 | 50 | move 17 (finished) | 4 / 2 / 3 | — |
|  | 2: go | 16 | 60 | move 16 (finished) | 4 / 7 / 8 | — |
|  | 3: go | 16 | 61 | move 17 (finished) | 4 / 7 / 9 | — |
| `bullseye` | 1: bullseye | 17 | 133 | move 56 (finished) | 9 / 16 / 25 | — |
|  | 2: bullseye | 15 | 124 | move 50 (finished) | 9 / 15 / 23 | — |
|  | 3: bullseye | 17 | 122 | move 64 (finished) | 9 / 12 / 20 | — |
| `rails` | 1: rails | 16 | 86 | room 85 (finished), arrive 85 (finished) | 6 / 46 / 62 | — |
|  | 2: rails | 16 | 87 | room 87 (finished), arrive 87 (finished) | 6 / 45 / 62 | — |
|  | 3: rails | 15 | 87 | room 87 (finished), arrive 87 (finished) | 6 / 45 / 61 | — |
| `sidebar` | 1: sidebar | 22 | 94 | room 93 (finished), arrive 93 (finished) | 11 / 50 / 54 | — |
|  | 2: sidebar | 32 | 79 | depart 79 (finished), room 79 (finished) | 10 / 45 / 53 | — |
|  | 3: sidebar | 20 | 101 | room 100 (finished), arrive 100 (finished) | 11 / 49 / 51 | — |
| `fit` | 1: fit | 16 | 86 | shrink 86 (finished), move 86 (finished), grow 86 (finished) | 5 / 56 / 57 | — |
| `flip` | 1: flip | 39 | 39 | — | 3 / 0 / 0 | — |
|  | 2: flip | 27 | 41 | — | 3 / 4 / 4 | — |
|  | 3: flip | 31 | 31 | — | 2 / 0 / 0 | — |
| `switch` | 1: switch | 19 | 185 | — | 11 / 78 / 142 | — |
|  | 2: switch | 34 | 172 | — | 12 / 100 / 132 | — |
|  | 3: switch | 19 | 195 | — | 11 / 84 / 154 | — |
| `slot-tasks` | 1: slot | 87 | 142 | shrink 142 (finished), move 142 (finished) | — | 1181 (0), 10.0 |
|  | 2: slot | 23 | 128 | move 127 (finished), grow 127 (finished) | — | 2889 (2679), 28.0 |
|  | 3: slot | 22 | 159 | shrink 159 (finished), move 159 (finished) | — | 1460 (7), 149.0 |

| Run | Taken (UTC) | Rest before it: updates/s, busy ms/s, worst gap ms | Census: elements | Frames perturbed by tasks |
|---|---|---|---|---|
| `appear` | 2026-10-05T00:20:28Z | 8, 60, 13 | 16382 | False |
| `close` | 2026-10-05T00:20:46Z | 0, 0, 3 | 16634 | False |
| `split` | 2026-10-05T00:20:50Z | 3, 11, 6 | 16383 | False |
| `slot` | 2026-10-05T00:20:58Z | 3, 14, 7 | 16383 | False |
| `fold` | 2026-10-05T00:21:07Z | 3, 15, 9 | 16383 | False |
| `unfold` | 2026-10-05T00:21:15Z | 3, 10, 5 | 16383 | False |
| `slide-c` | 2026-10-05T00:23:53Z | 1, 3, 4 | 12661 | False |
| `go` | 2026-10-05T00:21:28Z | 1, 3, 4 | 16383 | False |
| `bullseye` | 2026-10-05T00:21:38Z | 3, 14, 7 | 16383 | False |
| `rails` | 2026-10-05T00:21:46Z | 3, 14, 8 | 16383 | False |
| `sidebar` | 2026-10-05T00:22:01Z | 0, 0, 3 | 16383 | False |
| `fit` | 2026-10-05T00:22:10Z | 0, 0, 3 | 16382 | False |
| `flip` | 2026-10-05T00:22:14Z | 0, 0, 3 | 16382 | False |
| `switch` | 2026-10-05T00:22:31Z | 1, 3, 4 | 16382 | False |
| `slot-tasks` | 2026-10-05T00:22:39Z | 0, 0, 2 | 13851 | True |

The `fold` run read unfold, fold, unfold, and the `unfold` run read fold, unfold, fold, so each verb alternated from the card's state at the time. A release deck walks React commits only with `--tasks`, so only `slot-tasks` names a largest commit.

### What the release deck says

- **On the gestures that wait, the longest gap is the wait before the first beat.** For split (149 ms), slot (182–195), sidebar (79–101), rails (86–87) and fit (86), each beat starts at, or just under, the longest gap the recorder saw. Frames do arrive. The motion simply has not started yet. Bullseye is the exception: its move starts at 50–64 ms, and its longest gap (122–133 ms) falls later, inside the motion.
- **Forced-layout chains run long inside that wait.** The longest chain is 54–71 ms on split, 59–64 on slot, 78–100 on switch, and 45–56 on rails, sidebar and fit, against 0–19 ms on slide, go, flip, fold and unfold.
- **The slower gestures are the ones the harness also fails:** split and slot (the column's division), switch, bullseye, the rails, the fit, and appear (62–114 ms). Slide, go and flip have longest gaps of 31–61 ms and short chains, and fold and unfold 50–62 ms.
- **Leads (drive to first frame) are 13–44 ms**, apart from the `--tasks` run's first drive (87 ms), which follows the recorder's reload.
- **The `--tasks` slot names its commits.** The largest performed 1,181, 2,889 (2,679 mounted) and 1,460 fibers, with React times of 10, 28 and 149 ms. The second drive mounted 2,679 fibers.
- **At rest, the deck stayed under its budget throughout:** 0–8 updates/s at every reading's own check.

## Step 9

Taken 2026-10-04 and 05, on the arc's tree. The code is `86bbe1677`.

### The census, before and after

The whale arm of `at0690`'s seat, with the chain probe armed with stacks around a third drive in each direction (after the sampled legs). The sites are named from the built bundle; `keepNames` keeps method names, and the anonymous frames were read at their bundle positions.

| Seat | Before: the planning commit's task | After: the planning commit's task |
|---|---|---|
| into slot 1 | `getColumnRunHeight → _placeRunHeight` (`clientHeight`) 47 ms; `getBandWidth → _flowBandEdges` (`clientWidth`) 1 ms | `_placeRunHeight` 46 ms; `_flowBandEdges` 0 ms |
| back to slot 2 | `_placeRunHeight` 12 ms; `_flowBandEdges` 35 ms | `_placeRunHeight` 2 ms; `_flowBandEdges` 31 ms |

Both sites are the canvas's own layout effect: `writeArrangementVariables(canvas, arrangement, store.getColumnRunHeight(), true)`, then `store.getBandWidth()`. Each is the first read after React's mutation phase, so it pays the committed deck's layout. **No site in the planning commit's task is in `tug-list-view.tsx`, `smart-scroll.ts` or CodeMirror's measure cycle, before or after.** The list view's reads (its render's `scrollTop`/`clientHeight`, and its displacement bracket) fall in the commit after the land and cost 0 ms. So nothing joins [P05]'s gate beyond its three named reactions.

The forced layout the planning commit pays did **not** fall when seating in (47 → 46 ms). It fell by 14 ms seating back (47 → 33 ms total), which is the growth direction. The growth's one held-interior layout in the Last pass is not separable in this reading from the deck layout the canvas's read pays: the two sites above are the whole of the task's chains.

### The checkpoint's three readings

1. **The first beat's `startDelayMs` ≤ the derived period: NOT MET.** Seating in on the whale arm, the first `move` was cut and replanned, and the replan started at 0 ms. Seating back, `move`/`grow` started at 61 ms (baseline 71–78). On the slice arm, seating in started at 110 ms (baseline 141–174) and seating back at 82 ms (baseline 92–99). The period is about 17 ms. The hold moved the start earlier and did not bring it inside a frame.
2. **The census names no list-view, SmartScroll or CodeMirror site: MET**, as above.
3. **The growth's held-interior layout, named with its ms: read as the seat-back task's 33 ms**, and not separable from the deck's own layout (above).

### `at0605`, held and reverse-patched

Green on both arms behind the window restatement (claim 1 now opens at the second frame whose height is in motion):

- join A and B shrink 1041 → 600, 40–41 marked frames, deliveries `launch=0 inside=0 release=3`;
- stack B grows 600 → 1041, 24–26 marked frames, `launch=3 inside=0 release=0`;
- split B shrinks 1041 → 600, 27 marked frames, `launch=0 inside=0 release=3`.

Behind its reverse patch of the held-height rule (the `height: var(--tugx-still-held-height)` declaration in `tug-pane.css` removed, via `tugtool file probe`), claim 1 goes red on both arms: "join: no ResizeObserver delivery inside A between the first painted frame and landing — Expected: 0, Received: 42" (slice) and "Received: 45" (whale), from the root, the scroller and the transcript.

### Every leg green before is still green

The checkpoint ran the plan's eight files and the selection's top 20 (25 distinct, with `at0604`, `at0333` and `at0671` added from below the selection's cap because they read the still anchor, the follow-bottom pin and the fold). Result: 21/25 files green. The red files are the baseline's four: `at0555` (the fold's clock; now 114 ms slice and 105 ms whale against < 105, from 120–128 and 121), `at0622`, `at0690` (2/6, as before) and `at0684` (3/10, inside its baseline 2–3).

Inside `at0622`, the legs rotate at the margin. In the full run the activation leg failed once, its two clocks reading 27 against 26 ms, and it was green when the file was run alone. Run alone, go-to-slot out on the whale read 2.06 frames against its 2-frame bar (baseline 1.18–1.81). That gesture is a flow-only slide, which takes the prelaunch path, and the hold at `arm` never runs there. Every other `at0622` red is a baseline red.

The tugdeck unit suite is green (`src/lib` plus both SmartScroll tests: 5,329 pass), `tsc` is clean and `audit:motion` passes.

## Step 9 decisions

- **The predictor reads the canvas's arrangement, handed to the settle engine, rather than moving `deriveShownArrangement` into `lib/`.** The new module takes a structural slice of the arrangement that the canvas's value already satisfies, so nothing component-side is imported by `lib/` and the settle reads exactly what the canvas renders.
- **A fold-in opens the full fold crossing at `arm`, not the still mark alone.** The still mark without the fold mark switches on the bottom-anchor rule (`.tug-pane[data-still-crossing]:not([data-fold-crossing])`) for one frame on a folding card, and breaks `at0563`'s "the still mark is on for exactly the fold's frames". Each `arm` hold remembers which door opened it, and an unconfirmed one is ended by that door.
- **An unfold is left to the Last pass.** A folded card has no open interior on screen to hold at First, and holding it at the folded box made the crossing's first frame a folded card (`at0563`, the transcript top moved 95 px).
- **A member a column flip covers is not held.** Its height changes in the store, but the settle never tweens it: it stands behind the survivor and snaps at release. Held, it carried one marked frame, which `at0605` then read as a held card.
- **`perf-marks.ts` now guards `window`.** `host-menu-state.test.ts` (16 tests) was red on `main` (`f28593b25`) and in this arc, because `marksOn()` read `window` in a test with no DOM. It sits under the step's `src/lib` checkpoint, so it was fixed rather than carried.
- **The chain probe's reading carries each chain's task, read name, site and writes**, so a census can say which task a chain paid in and what dirtied the layout before it.

## Hand-back H2

The release deck after the hold at `arm`. Taken 2026-10-05 02:04–02:07 UTC.

**What this deck is.** H1's deck, on the same release instance, reopened on the new build. As at H1 the run did the arranging itself through `window.tugdeck.lab`. The deck had been left as H1's last readings left it (A in slot 2's column, C folded, the slice `de4e8886…` in Main), so before reading A was sent back to slot 1, C was unfolded, the slice was returned to Two and A was focused. The flow then stood as at H1.

### The tree and the build

- **Tree:** `6f4bc953b` on `tugarc/real-transcript-motion`, which carries the hold at `arm` and the list view's deferral (`51da3f48a`).
- **Build:** `just app-release` in the arc worktree, which launched instance `release-tugarc-real-transcript-motion` (version `0.8.16`). Its bundle carries the still crossing's end event. The reader was the worktree's debug `tugtool`, reporting `0.8.16 (6f4bc953b)`.
- **Window:** 2,501 × 1,384 CSS px, as at H1.

### The deck

The flow and rails are H1's: whale A in slot 1, the split column of two slices in slot 2, whale C in slot 3, and the rail of two (cards, layout) on the right. **The census is smaller:** the document holds 10,125 elements, against H1's 16,382. The reopened deck no longer keeps Two's panes mounted parked: H1's census listed seven parked panes and this one lists none. The cards on screen render as they did (whales 2,179–2,180, slices 1,626 each).

**Rest:** before the run, 1 update/s, holding the main thread 6 ms/s (window 1,000 ms, 798 ticks, median gap 1 ms, worst 7 ms).

### What each run drove

H1's arguments, run for run (`h2-run.sh`). Between runs, the arrangement was put back where H1's order of runs depended on it. A was returned to slot 1 after `slot`, C unfolded after `unfold`, and Main reactivated after `switch`. `slide` ran last, on C, after the slice was moved from Two into Main and focused. That is the deck H1's `slide` readings came from, now 8,934 elements.

### Readings

Every number below is generated from the verb's `--json` output (`h2-table.py`). The verbatim outputs, with the commands and timestamps, are kept in the arc's documents at `.tug/arcs/real-transcript-motion/h2/`. Times are in ms from the drive.

| Run | Drive | Lead ms | Longest gap ms | Beats: start ms (landing) | Chains: n / longest / total ms | Largest commit: performed (mounted), react ms |
|---|---|---|---|---|---|---|
| `appear` | 1: appear | 16 | 78 | arrive 13 (finished) | 20 / 2 / 3 | — |
|  | 2: appear | 15 | 46 | arrive 14 (finished) | 20 / 2 / 5 | — |
|  | 3: appear | 16 | 44 | arrive 13 (finished) | 20 / 1 / 4 | — |
| `close` | 1: close | 36 | 36 | depart 24 (finished) | 12 / 3 / 6 | — |
| `split` | 1: split | 28 | 81 | room 81 (finished) | 8 / 49 / 61 | — |
|  | 2: split | 23 | 90 | room 88 (finished) | 9 / 46 / 64 | — |
|  | 3: split | 29 | 79 | room 79 (finished) | 8 / 51 / 62 | — |
| `slot` | 1: slot | 52 | 129 | move 129 (finished), grow 129 (finished) | 10 / 46 / 85 | — |
|  | 2: slot | 65 | 121 | shrink 120 (finished), move 120 (finished) | 8 / 50 / 100 | — |
|  | 3: slot | 52 | 127 | move 127 (finished), grow 127 (finished) | 10 / 44 / 83 | — |
| `fold` | 1: unfold | 13 | 52 | grow 52 (finished) | 3 / 3 / 3 | — |
|  | 2: fold | 29 | 42 | shrink 18 (finished) | 4 / 1 / 2 | — |
|  | 3: unfold | 15 | 52 | grow 52 (finished) | 3 / 2 / 2 | — |
| `unfold` | 1: fold | 31 | 42 | shrink 19 (finished) | 4 / 1 / 1 | — |
|  | 2: unfold | 15 | 53 | grow 53 (finished) | 3 / 3 / 3 | — |
|  | 3: fold | 28 | 42 | shrink 22 (finished) | 4 / 1 / 2 | — |
| `slide-c` | 1: slide | 24 | 33 | move 25 (finished) | 4 / 2 / 2 | — |
|  | 2: slide | 31 | 31 | move 33 (finished) | 5 / 8 / 10 | — |
|  | 3: slide | 27 | 30 | move 29 (finished) | 4 / 2 / 3 | — |
| `go` | 1: go | 16 | 45 | move 17 (finished) | 4 / 3 / 3 | — |
|  | 2: go | 13 | 32 | move 16 (finished) | 4 / 2 / 3 | — |
|  | 3: go | 16 | 32 | move 18 (finished) | 4 / 2 / 3 | — |
| `bullseye` | 1: bullseye | 17 | 130 | move 36 (finished) | 8 / 15 / 17 | — |
|  | 2: bullseye | 16 | 119 | move 48 (finished) | 8 / 21 / 22 | — |
|  | 3: bullseye | 15 | 126 | move 38 (finished) | 8 / 18 / 18 | — |
| `rails` | 1: rails | 17 | 105 | room 105 (finished), arrive 105 (finished) | 6 / 63 / 85 | — |
|  | 2: rails | 16 | 101 | room 101 (finished), arrive 101 (finished) | 6 / 62 / 80 | — |
|  | 3: rails | 15 | 96 | room 96 (finished), arrive 96 (finished) | 6 / 58 / 77 | — |
| `sidebar` | 1: sidebar | 28 | 89 | room 89 (finished), arrive 89 (finished) | 11 / 50 / 52 | — |
|  | 2: sidebar | 45 | 74 | depart 74 (finished), room 74 (finished) | 12 / 48 / 55 | — |
|  | 3: sidebar | 25 | 87 | room 88 (finished), arrive 88 (finished) | 11 / 53 / 55 | — |
| `fit` | 1: fit | 15 | 85 | — | 3 / 0 / 0 | — |
| `flip` | 1: flip | 34 | 34 | — | 3 / 0 / 0 | — |
|  | 2: flip | 35 | 35 | — | 3 / 12 / 12 | — |
|  | 3: flip | 30 | 30 | — | 2 / 0 / 0 | — |
| `switch` | 1: switch | 16 | 169 | — | 10 / 72 / 136 | — |
|  | 2: switch | 16 | 184 | — | 11 / 107 / 151 | — |
|  | 3: switch | 25 | 185 | — | 10 / 77 / 145 | — |
| `slot-tasks` | 1: slot | 118 | 118 | shrink 112 (finished), move 112 (finished) | — | 895 (5), 102.0 |
|  | 2: slot | 53 | 127 | move 127 (finished), grow 127 (finished) | — | 2889 (2679), 33.0 |
|  | 3: slot | 54 | 113 | shrink 113 (finished), move 113 (finished) | — | 1460 (7), 104.0 |

| Run | Taken (UTC) | Rest before it: updates/s, busy ms/s, worst gap ms | Census: elements | Frames perturbed by tasks |
|---|---|---|---|---|
| `appear` | 2026-10-05T02:04:32Z | 4, 18, 7 | 10125 | False |
| `close` | 2026-10-05T02:04:49Z | 0, 0, 2 | 10334 | False |
| `split` | 2026-10-05T02:04:52Z | 1, 3, 4 | 10125 | False |
| `slot` | 2026-10-05T02:05:00Z | 3, 13, 8 | 10125 | False |
| `fold` | 2026-10-05T02:05:13Z | 7, 23, 5 | 10125 | False |
| `unfold` | 2026-10-05T02:05:20Z | 3, 15, 7 | 10125 | False |
| `slide-c` | 2026-10-05T02:07:19Z | 0, 0, 2 | 8934 | False |
| `go` | 2026-10-05T02:05:34Z | 6, 25, 8 | 10125 | False |
| `bullseye` | 2026-10-05T02:05:44Z | 1, 3, 4 | 10125 | False |
| `rails` | 2026-10-05T02:05:53Z | 2, 12, 9 | 10125 | False |
| `sidebar` | 2026-10-05T02:06:08Z | 3, 11, 5 | 10125 | False |
| `fit` | 2026-10-05T02:06:16Z | 1, 4, 5 | 10124 | False |
| `flip` | 2026-10-05T02:06:23Z | 1, 5, 6 | 10124 | False |
| `switch` | 2026-10-05T02:06:40Z | 0, 0, 3 | 10124 | False |
| `slot-tasks` | 2026-10-05T02:06:53Z | 0, 0, 3 | 10124 | True |

### Beside H1

Each cell is the range over the run's drives, H1's readings first.

| Run | First beat ms, H1 → H2 | Longest gap ms, H1 → H2 | Longest chain ms, H1 → H2 |
|---|---|---|---|
| `appear` | 24–39 → 13–14 | 62–114 → 44–78 | 8–9 → 1–2 |
| `close` | 46 → 24 | 46 → 36 | 9 → 3 |
| `split` | 148–149 → 79–88 | 149 → 79–90 | 54–71 → 46–51 |
| `slot` | 181–195 → 120–129 | 182–195 → 121–129 | 59–64 → 44–50 |
| `fold` | 51–62 → 18–52 | 51–62 → 42–52 | 9–19 → 1–3 |
| `unfold` | 50–56 → 19–53 | 50–56 → 42–53 | 9–17 → 1–3 |
| `slide-c` | 27–32 → 25–33 | 33–36 → 30–33 | 2 → 2–8 |
| `go` | 16–17 → 16–18 | 50–61 → 32–45 | 2–7 → 2–3 |
| `bullseye` | 50–64 → 36–48 | 122–133 → 119–130 | 12–16 → 15–21 |
| `rails` | 85–87 → 96–105 | 86–87 → 96–105 | 45–46 → 58–63 |
| `sidebar` | 79–100 → 74–89 | 79–101 → 74–89 | 45–50 → 48–53 |
| `fit` | 86 → — | 86 → 85 | 56 → 0 |
| `flip` | — → — | 31–41 → 30–35 | 0–4 → 0–12 |
| `switch` | — → — | 172–195 → 169–185 | 78–100 → 72–107 |
| `slot-tasks` | 127–159 → 112–127 | 128–159 → 113–127 | — → — |

### What the release deck says

- **The `slot` stall is shorter, not gone.** The move starts at 120–129 ms, against 181–195 at H1, about 60 ms sooner. What remains is the wait itself: the longest gap is still the wait before the first beat, and its longest chain is still 44–50 ms. Step 9's census places that chain in the canvas's own run-height reads, not in a transcript. The same holds for `split`, whose room beat starts at 79–88 ms against 148–149.
- **The fold no longer waits on the card.** A fold-in's shrink starts at 18–22 ms (51 at H1), and the longest chain on fold and unfold is 1–3 ms (9–19 at H1). An unfold, which the hold leaves to the Last pass, starts at 52–53 ms, against 56–62.
- **`appear` and `close` start sooner.** The arrival starts at 13–14 ms (24–39) and the departure at 24 (46), with chains of 1–3 ms against 8–9.
- **`rails` is the one gesture that got slower:** its first beat moved 85–87 → 96–105 ms, and its longest chain 45–46 → 58–63. Watched directly, the toggle holds all five rail cards at `arm` (24 ms after the drive) to the land, so the commit that plans the motion now lays the rails out under a held interior. The Last pass also carries those frames, so the hold is not a misprediction. What changed is that it now opens before the commit rather than after. This cost is named here and left to the bench and the ms bars.
- **Unchanged within noise:** `slide`, `go`'s start, `bullseye`, `sidebar`, `flip` and `switch`. Bullseye's longest gap (119–130 ms) still falls inside its motion, not before it.
- **`fit` drove no beat at H2**, with chains of 0 ms. The rails already stood at their fitted widths, so there was nothing to read.
- **The `--tasks` slot's largest commits are the same commits:** 895, 2,889 (2,679 mounted) and 1,460 fibers. Their React times are 102, 33 and 104 ms, against 10, 28 and 149 at H1. On a release deck, a single drive's React time swings this much.

### [Q01]: the held transcript

The question was whether a streaming card on a height-bearing beat may land its new rows at the land rather than during the beat. A streaming transcript was not driven, because that would have resumed a real `claude` turn on a seeded session. The run measured the hold the question is about instead. A frame held at `arm` stays held from the drive to the land: on the slot gesture its beats start at 120–129 ms and run 400 ms, and on `split` 79–88 ms and 400 ms. So rows appended mid-gesture arrive at most about half a second late, in one step, at the land. That is the fold's existing behaviour, which the brief named as the first option.

**Answer: accept.** The deferral is bounded by the settle's length, which is the fold's precedent. The turn feed does not bypass the hold. The second option remains available if the user, seeing it on their own deck, finds the half-second visible.

## Step 11

The height-by-translation bench, rebuilt behind its lab flag and read on real transcripts. Taken 2026-10-05 on the arc's worktree with the test app built from it.

### What was rebuilt

- **Restored from the bench's commit:** the flag (`labFlags.heightByTranslation`), its test door (`window.__tug.setHeightByTranslation`), TugPane's standing edge piece and its CSS, and the settle engine's bench branch. The engine half was merged by hand into today's Last pass. It sits after the frame loop and before the pass sweeps the crossings it did not carry, so the bench's frames count as carried and the hold `arm` opened on them is not ended early.
- **Extended to the column dividing.** The bench now takes two shapes on a two-member column. In the first, the upper member folds or unfolds. In the second, the column goes from a stack to a split with the upper member as the flip's survivor; there the lower member is covered behind the survivor and starts below the run's foot, where the boundary stood at First. In both, the upper member's box is held at its larger height, its edge piece and the lower member translate, and every box snaps at the land. A division whose survivor is the lower member is not benched.
- **The release door:** `window.tugdeck.lab.setHeightByTranslation(on)` sets the flag and returns the prior value. `tugtool deck motion settle --translation on|off` passes it to the page's `record` op, which sets it before the drive and restores it after `finish`. The unit test `the_translation_flag_reaches_the_record_op` pins that the flag reaches the op.
- **`at0691-height-by-translation-bench.test.ts`**, from `at0685`'s bench, runs on both arms. The column's two members carry the arm's transcript and every other session card the slice. Each arm reads fold, unfold and divide, flag off and on, three timing runs each. A fourth pass with the lead recorder armed reads the commits; arming takes a stack at every queueing, so the timing runs stay unarmed. The exposure census and the theme census are kept.

### Checkpoint

- `cd tugdeck && bunx tsc --noEmit && bun run audit:motion && bun run audit:tokens lint`: green.
- `cd tugrust && cargo nextest run -p tugtool deck_motion`: 68 pass.
- `just app-test-build at0691-height-by-translation-bench.test.ts at0622-deck-settle-frames.test.ts`: `at0691` green (3/3, both arms and the theme census); `at0622` red, 18/28. Its history has it red for the last five recorded runs, before this step.
- **The flag-off path is unchanged.** With the flag off, the bench's branch is never entered: `findHeightBench` is not called and the edge piece does not mount. `at0622` was run again with this step's `tugdeck/src` changes reversed (`tugtool file probe`), and read 19/28. Eight red legs are the same on both trees: appear into a split column, the arrival closed into at 140 ms, bullseye, and the rail hide, each on both arms. The rest rotate. With the step, go-to-slot was red on both arms (2.06 frames against a bar of 2, and a 17 ms lead against 16.5 ms), which is the margin Step 9 recorded. Without it, the slice's "four session cards: one row per settle" leg was red.
- Outside the checkpoint: `tugdeck/src/__tests__/departing-invisibility.test.ts` is red on `main` at `1ced41280` (137 fail), with or without this step; recorded in the arc's baseline. `layout-imposer-solutions.test.ts` timed out in a batch and is green alone.

### The bench's readings

Generated from the run's notes by `bench-table.py` (kept with the logs in the arc's documents, under `step11/`). Each cell lists the three timing runs. "After the first frame" is the row's gaps over one frame, less the lead when the lead itself was over one frame.

| Arm | Gesture | Flag | First paint ms | Longest gap ms | Gaps over one frame (after the first frame) | Ticks | [D9] rows |
|---|---|---|---|---|---|---|---|
| slice | fold | off | 47 / 38 / 44 | 198 / 199 / 202 | 3 (2) / 3 (2) / 3 (2) | 56 / 53 / 56 | at0622-p1:height, at0622-p2:height |
| slice | fold | on | 41 / 45 / 42 | 199 / 203 / 194 | 2 (1) / 2 (1) / 2 (1) | 17 / 17 / 17 | none |
| slice | unfold | off | 16 / 18 / 17 | 204 / 200 / 197 | 2 (2) / 2 (1) / 2 (2) | 55 / 55 / 55 | at0622-p1:height, at0622-p2:height |
| slice | unfold | on | 25 / 23 / 28 | 189 / 195 / 195 | 1 (0) / 2 (1) / 2 (1) | 17 / 17 / 17 | none |
| slice | divide | off | 22 / 6 / 6 | 124 / 119 / 119 | 1 (0) / 1 (1) / 2 (2) | 25 / 25 / 25 | at0622-p1:height |
| slice | divide | on | 5 / 26 / 5 | 123 / 128 / 111 | 1 (1) / 2 (1) / 1 (1) | 26 / 26 / 25 | none |
| whale | fold | off | 28 / 20 / 27 | 174 / 177 / 175 | 4 (3) / 3 (2) / 4 (3) | 55 / 54 / 55 | at0622-p1:height, at0622-p2:height |
| whale | fold | on | 31 / 26 / 23 | 155 / 178 / 181 | 3 (2) / 3 (2) / 2 (1) | 17 / 17 / 16 | none |
| whale | unfold | off | 22 / 19 / 27 | 172 / 181 / 184 | 2 (1) / 2 (1) / 4 (3) | 56 / 55 / 55 | at0622-p1:height, at0622-p2:height |
| whale | unfold | on | 19 / 23 / 27 | 178 / 173 / 182 | 1 (0) / 2 (1) / 3 (2) | 16 / 17 / 17 | none |
| whale | divide | off | 6 / 6 / 5 | 111 / 107 / 109 | 1 (1) / 1 (1) / 1 (1) | 26 / 26 / 26 | at0622-p1:height |
| whale | divide | on | 11 / 6 / 6 | 114 / 122 / 116 | 1 (1) / 1 (1) / 1 (1) | 26 / 26 / 25 | none |

| Arm | Gesture | Flag | Largest commit in the window, armed pass: react ms |
|---|---|---|---|
| slice | fold | off | 176 |
| slice | fold | on | 173 |
| slice | unfold | off | 164 |
| slice | unfold | on | 169 |
| slice | divide | off | 98 |
| slice | divide | on | 103 |
| whale | fold | off | 16 |
| whale | fold | on | 16 |
| whale | unfold | off | 157 |
| whale | unfold | on | 156 |
| whale | divide | off | 89 |
| whale | divide | on | 99 |

The exposure census, flag on, one crossing each:

| Arm | Crossing | Crossing ticks | Exposed ticks | Seam / foot exposures | First exposure |
|---|---|---|---|---|---|
| slice | fold | 16 | 1 | 1 / 0 | seam at 334 ms, band 379.7–384.7 px, hit `at0622-p1 span.session-telemetry-status-value-wrap` |
| slice | unfold | 16 | 3 | 4 / 0 | seam at 239 ms, band 188.5–193.5 px, hit `at0622-p1 div.tug-list-view-window` |
| slice | divide | 25 | 0 | 0 / 0 | none |
| whale | fold | 16 | 0 | 0 / 0 | none |
| whale | unfold | 17 | 4 | 7 / 3 | foot at 202 ms, band 1046–1054.6 px, hit `at0622-p2 button.tug-choice-group-segment` |
| whale | divide | 25 | 0 | 0 / 0 | none |

**Theme census:** in all ten shipped themes the chrome ground is opaque (alpha 1), and the frame ground is transparent (alpha 0).

### What the bench says

- **With the flag on, the `height` term is gone from every benched gesture:** no [D9] row on fold, unfold or divide, against `height` on both members (fold, unfold) or on the survivor (divide) with it off.
- **It does not take the gaps out.** On the whale arm with the flag on, every fold, unfold and division still has gaps over one frame after the first painted frame. Fold has 1–2 (2–3 off), unfold 0–2 (1–3 off), and divide 1 each, as with it off. The longest gap stays 155–203 ms on a fold or unfold and 111–128 ms on a division, flag on or off. The gaps are not the crossing's relayout. The longest falls where it fell before the flag, and the largest commit in the window costs the same React time either way: 156–176 ms on the slice fold and unfold and on the whale unfold, 89–103 ms on a division.
- **The occlusion leaks at the edges of the motion.** The seam band (5 px) shows the upper member's interior on up to 4 ticks of an unfold, and the foot band shows the lower member's on the whale unfold (3 exposures). The division showed nothing on either arm.
- **A flag-on fold samples 16–17 ticks against 53–56 with it off.** The row counts the frames of the settle's own beats. The bench's fold is one beat on the moving pieces in place of shrink, move and grow, so its row closes sooner, and the two tick counts are not the same window.

These are the readings the bench's verdict is applied to, beside the user's deck.

## Hand-back H3

The bench on the release deck: `fold`, `unfold`, `split` and `slot`, each read with `--translation off` and then `--translation on`. Taken 2026-10-05 02:52–03:05 UTC.

### The tree, the build and the deck

- **Tree:** `351f300c4`, the bench as Step 11 left it. **Build:** `just app-release` in the arc worktree, instance `release-tugarc-real-transcript-motion` (version `0.8.16`). **Reader:** the worktree's debug `tugtool` (`0.8.16 (351f300c4)`), which carries `--translation`.
- **The deck:** H1's, restored as at H2. The slice that H2's `slide` brought into Main went back to Two, A went back to slot 1 and was focused, and the split column of two slices stood in slot 2. The census read 10,065 elements. Every reading's rest check was at 2–5 updates/s.
- **The cards:** the bench takes a two-member column, so `fold` and `unfold` ran on that column's upper member, `231fc4bc-0e76-43a5-8848-cb44e6e9dd1f`, not on whale C, which stands alone in its slot. `split --slot 2 --mode stack` alternates stack and split on that column. The upper member is its frontmost (z 6 against 5), so the division is the bench's shape. `slot` is H1's (`--card` A `--slot 2`), which makes a three-member column, which the bench does not take.
- **Between runs:** the card was unfolded and the column split again, and A was sent home, so each run started from the same deck. After the run the flag read `false`, as found.

### The verb's readings

Every `settle` ran with `--count 3 --chains --json`. Generated from the `--json` outputs (`h3-table.py`); the outputs, commands and timestamps are kept under `.tug/arcs/real-transcript-motion/h3/`. A beat's `declares` is `transform` when it animates no layout property.

| Run | Drive | Lead ms | Longest gap ms | Beats: start ms (declares, landing) | Chains: n / longest / total ms |
|---|---|---|---|---|---|
| `fold-off` | 1: unfold | 15 | 103 | shrink 103 (height, finished), move 103 (transform, finished), grow 103 (height, finished) | 6 / 56 / 60 |
|  | 2: fold | 33 | 82 | shrink 82 (height, finished), move 82 (transform, finished), grow 82 (height, finished) | 8 / 53 / 54 |
|  | 3: unfold | 15 | 104 | shrink 104 (height, finished), move 104 (transform, finished), grow 104 (height, finished) | 6 / 57 / 60 |
| `fold-on` | 1: unfold | 15 | 92 | grow 92 (transform, finished) | 6 / 55 / 58 |
|  | 2: fold | 22 | 84 | shrink 84 (transform, finished) | 8 / 56 / 58 |
|  | 3: unfold | 16 | 105 | grow 105 (transform, finished) | 6 / 61 / 64 |
| `unfold-off` | 1: fold | 24 | 83 | shrink 83 (height, finished), move 83 (transform, finished), grow 83 (height, finished) | 8 / 57 / 58 |
|  | 2: unfold | 14 | 104 | shrink 104 (height, finished), move 104 (transform, finished), grow 104 (height, finished) | 6 / 57 / 60 |
|  | 3: fold | 24 | 84 | shrink 84 (height, finished), move 84 (transform, finished), grow 84 (height, finished) | 8 / 56 / 57 |
| `unfold-on` | 1: fold | 23 | 83 | shrink 83 (transform, finished) | 8 / 55 / 57 |
|  | 2: unfold | 16 | 107 | grow 106 (transform, finished) | 6 / 64 / 68 |
|  | 3: fold | 22 | 86 | shrink 86 (transform, finished) | 8 / 58 / 60 |
| `split-off` | 1: split | 28 | 80 | room 80 (height, finished) | 8 / 50 / 61 |
|  | 2: split | 30 | 92 | room 91 (height, finished) | 9 / 49 / 67 |
|  | 3: split | 31 | 80 | room 80 (height, finished) | 8 / 51 / 63 |
| `split-on` | 1: split | 19 | 85 | room 85 (transform, finished) | 7 / 52 / 64 |
|  | 2: split | 21 | 95 | room 93 (height, finished) | 9 / 51 / 70 |
|  | 3: split | 21 | 85 | room 85 (transform, finished) | 7 / 52 / 63 |
| `slot-off` | 1: slot | 58 | 138 | move 138 (transform, finished), grow 138 (height, finished) | 10 / 47 / 88 |
|  | 2: slot | 58 | 121 | shrink 121 (height, finished), move 121 (transform, finished) | 8 / 52 / 103 |
|  | 3: slot | 52 | 130 | move 130 (transform, finished), grow 130 (height, finished) | 10 / 43 / 82 |
| `slot-on` | 1: slot | 41 | 129 | move 129 (transform, finished), grow 129 (height, finished) | 10 / 42 / 82 |
|  | 2: slot | 48 | 118 | shrink 118 (height, finished), move 118 (transform, finished) | 8 / 49 / 98 |
|  | 3: slot | 40 | 130 | move 130 (transform, finished), grow 130 (height, finished) | 10 / 43 / 83 |

| Run | Taken (UTC) | Rest before it: updates/s, busy ms/s, worst gap ms | Census: elements |
|---|---|---|---|
| `fold-off` | 2026-10-05T02:52:54Z | 5, 19, 7 | 10065 |
| `fold-on` | 2026-10-05T02:53:53Z | 3, 17, 9 | 10065 |
| `unfold-off` | 2026-10-05T02:53:08Z | 5, 19, 6 | 10065 |
| `unfold-on` | 2026-10-05T02:54:04Z | 4, 18, 7 | 10065 |
| `split-off` | 2026-10-05T02:53:24Z | 4, 16, 6 | 10065 |
| `split-on` | 2026-10-05T02:54:19Z | 4, 18, 7 | 10065 |
| `slot-off` | 2026-10-05T02:53:36Z | 3, 11, 6 | 10065 |
| `slot-on` | 2026-10-05T02:54:30Z | 2, 10, 8 | 10065 |

| Gesture | First beat ms, off → on | Longest gap ms, off → on | Longest chain ms, off → on |
|---|---|---|---|
| `fold` | 82–104 → 84–105 | 82–104 → 84–105 | 53–57 → 55–61 |
| `unfold` | 83–104 → 83–106 | 83–104 → 83–107 | 56–57 → 55–64 |
| `split` | 80–91 → 85–93 | 80–92 → 85–95 | 49–51 → 51–52 |
| `slot` | 121–138 → 118–130 | 121–138 → 118–130 | 43–52 → 42–49 |

On the division drives (`split` drive 1 and 3) the flag-on room beat declares no `height`. On the stack drive (2) it still declares `height`, because the bench does not take a stack.

### Inside the motion

The verb's longest gap is the wait before the first beat on every drive, flag on or off, so it says nothing about the frames inside the motion. The verdict compares exactly those frames, so they were recorded directly. On the same deck, each drive went through `window.tugdeck.lab.drive` with the flag set for it and put back after (`frames.sh`, `frames-run.sh`). Three fold/unfold pairs and three stack/divide pairs were read flag off, then flag on. The recording kept every `requestAnimationFrame` across the drive, the settle's `settle-beat` rows, the settle mark coming off the canvas (`data-imposer-settling`), and the bench's marks.

`frames-table.py` generated the table below. The motion runs from the first beat's start to the settle mark coming off. The land is the motion's last 100 ms, where the beats finish and every hold is handed back. A gap is over one frame when it exceeds 1.5 periods.

| Gesture | Flag | Bench marks | Period ms | Motion ms, first beat to settle off | Gaps over one frame before the land | Longest gap before the land ms | Longest gap at the land ms |
|---|---|---|---|---|---|---|---|
| fold | off | none | 17 / 17 / 17 | 965 / 979 / 980 | 0 / 1 / 0 | 23 / 27 / 23 | 47 / 45 / 45 |
| fold | on | edge/occluder | 17 / 17 / 17 | 352 / 349 / 353 | 0 / 0 / 0 | 17 / 18 / 18 | 65 / 55 / 63 |
| unfold | off | none | 17 / 17 / 17 | 954 / 957 / 961 | 1 / 1 / 0 | 26 / 31 / 24 | 48 / 49 / 48 |
| unfold | on | edge/occluder | 17 / 17 / 17 | 326 / 327 / 328 | 0 / 0 / 0 | 19 / 19 / 18 | 58 / 58 / 59 |
| divide | off | none | 17 / 17 / 17 | 460 / 455 / 455 | 0 / 0 / 0 | 18 / 19 / 18 | 38 / 35 / 35 |
| divide | on | edge/occluder | 17 / 17 / 17 | 474 / 469 / 474 | 0 / 0 / 0 | 18 / 19 / 18 | 55 / 50 / 56 |
| stack | off | none | 17 / 17 / 17 | 473 / 460 / 463 | 0 / 0 / 0 | 18 / 18 / 19 | 41 / 41 / 41 |
| stack | on | none | 17 / 17 / 17 | 462 / 463 / 472 | 0 / 0 / 0 | 18 / 19 / 18 | 41 / 41 / 41 |

### What the user's deck says

- **The bench engaged exactly where it should.** The fold, unfold and division drives wore both marks (`edge`, `occluder`) with the flag on and none with it off. The stack wore none either way. The `slot` gesture makes a three-member column and was never benched; its flag-on readings fall within its flag-off ones.
- **Before the land, the bench runs clean.** With the flag on, fold, unfold and division had no gap over one frame before the land, and the longest was 17–19 ms. With it off, folds and unfolds had 0–1, with the longest at 23–31 ms.
- **At the land it is worse.** Every drive, both flags, has its one long gap at the land. With the flag on it is 55–65 ms on a fold or unfold (45–49 off) and 50–56 ms on a division (35–38 off). The land is where the bench's held boxes snap to their committed heights, so the relayout the motion skipped is paid in one frame there, on a larger subtree than the tween's last frame re-laid. On a stack, which the bench does not take, the land reads 40–41 ms with the flag on and off.
- **The flag-on fold is a different motion, not only a different property.** Off, a fold here runs shrink, move and grow in sequence, 954–980 ms from the first beat to the settle's end. On, the bench plans a single beat on the moving pieces, 326–353 ms. The division keeps its one room beat either way (455–474 ms).
- **The wait before the motion is unchanged.** On fold, unfold and split the first beat starts at 80–107 ms with the flag either way, and the longest forced-layout chain runs 49–64 ms. The bench acts in the Last pass and does not touch the commit that comes before it.

## Bench verdict

The rule: height by translation lands for the fold and the two-member division only if, on the whale arm across three solo runs, all three clauses hold. Otherwise it is removed again. Each clause is answered from Step 11's harness readings and H3's user-deck readings.

- **Gaps: fails.** On the whale arm with the flag on, every fold, unfold and division still had gaps over one frame after its first painted frame: fold 1–2, unfold 0–2, divide 1 each, against 2–3, 1–3 and 1 with the flag off. The longest gap stayed where it stood without the flag, 155–203 ms on a fold or unfold and 111–128 ms on a division. The largest commit in the window cost the same React time either way. So the gaps are not the crossing's per-frame relayout, and the bench does not remove them.
- **Exposure: fails.** The census showed the upper member's interior in the 5 px seam band on up to 4 ticks of an unfold, and the lower member's in the foot band on the whale unfold (3 exposures). Only the division read clean.
- **User's deck: fails.** Before the land the bench ran clean: no gap over one frame, with the longest at 17–19 ms against 23–31 ms off. But the motion's longest gap moved to the land and grew. It read 55–65 ms on a fold or unfold against 45–49 ms off, and 50–56 ms on a division against 35–38 ms off, because the held boxes snap to their committed heights in one frame. Flag-on gaps after the first frame are therefore worse than flag-off, not "no worse".

**Verdict: removed.** The bench leaves the tree as `19ead8b38` removed it: the flag and its two doors (`labFlags.heightByTranslation`, the test surface's `setHeightByTranslation` with the surface back to 2.26.0, and `window.tugdeck.lab.setHeightByTranslation`), TugPane's edge piece and its CSS, the settle engine's bench branch for the fold and the division, `at0691-height-by-translation-bench.test.ts`, and the `deck motion settle --translation` flag with its unit test. `tugdeck/`, `tests/` and `tugrust/` are byte-identical to the tree before the bench was rebuilt.

**Why:** translating instead of tweening height moves the relayout from the motion's interior to its land, where it is paid on the larger held subtree in one frame. The gaps that remain inside the motion come from the commit that plans it, not from the crossing. The `height` term therefore stays, with the transcript held still for its length by the arm-time hold and the list view's owed work.

### Checkpoint

- `cd tugdeck && bunx tsc --noEmit && bun run audit:motion && bun test src/lib`: green (5,314 pass).
- `cd tugrust && cargo nextest run -p tugtool deck_motion`: 67 pass. The `--translation` test is gone.
- `just app-test-covers-check`: green. `just app-test` (the core tier, since `main.tsx` changed) on the rebuilt bundle: 19/19 green.
- `just app-test-build at0622-deck-settle-frames.test.ts at0690-real-transcript-asks.test.ts`: both red, with the reds they already had.
  - The run reads 20/34 tests across the two files. `at0622`'s red legs are the eight Step 11 found on both trees: appear into a split column, the arrival closed into at 140 ms, bullseye, and the rail hide, each on both arms. The ninth and tenth are the rotating "four session cards: one row per settle" leg (row 22 ms vs probe 23 ms on the slice, 25 vs 26 on the whale). Its history has it red for the last 7 recorded runs.
  - `at0690`'s seat-into-slot-1 leg (122 ms, 7.18 frames against a bar of 2) has been red for its last 8 recorded runs, before this step.
  - Both go to Step 16's close-out.

## Bars

Two bars, set from this arc's harness readings and marked **for the user to confirm at H4** against the same numbers read on the release deck. Taken 2026-10-05 on the arc's worktree (tree after the bench's removal), with the test app built from it. Logs are kept under `step14/` in the arc's documents.

### The window's main-thread milliseconds (`at0684`)

Each leg's window is barred on React's time in every in-window commit (`react_ms`, render start to the census stamp after layout effects), plus the longest forced-layout chain whose paying read falls outside every commit's span. A chain paid inside a commit is already in its `react_ms`, so it is noted beside the sum and not added. The chain probe is armed without stacks, beside the lead recorder, just before the drive. A commit in the window's leading margin that rendered before the recorder was armed carries no React time. It is counted in the note (3 of 12 on close, 2–4 on split and switch) and left out of the sum.

`at0684` run alone three times, both arms each run. Each cell is react_ms + outside chain = total, in ms:

| Leg | Whale, run 1 / 2 / 3 | Slice, run 1 / 2 / 3 | In-commit chains, whale | Bar |
|---|---|---|---|---|
| close | 107 + 1 = 108 / 111 + 0 = 111 / 108 + 1 = 109 | 118 / 116 / 117 | 79–80 ms over 6 | **140** |
| rails | 57 + 1 = 58 / 61 + 0 = 61 / 57 + 1 = 58 | 56 / 64 / 59 | 48–51 ms over 2 | **76** |
| split | 91 / 92 / 91, no outside chain over 0.5 ms | 90 / 91 / 93 | 69–73 ms over 2 | **115** |
| unfold | 34 / 45 / 47, no outside chain | 49 / 42 / 43 | 1–3 ms over 1 | **60** |
| switch | 72 + 3 = 75 / 77 + 3 = 80 / 72 + 2 = 74 | 85 / 80 / 87 | 45–48 ms over 5 | **100** |

Each bar is about a quarter over the largest whale reading, and every slice reading falls under it. The window's main-thread time is mostly React's: the chain outside any commit is at most 3 ms on every leg. The forced layout these gestures pay is paid inside the commits' own layout effects, where `react_ms` already counts it.

### Every beat's start (`at0622`, `at0690`)

Every beat that ran must start within one derived display period (17 ms here) of the settle's planning. The clause is `expectBeatStarts` in `settle-frames-fixture.ts`. It is asserted last in `expectB09Bar`, so it covers every `at0622` bar leg, and it is called in `at0622`'s disappear leg and in `at0690`'s seat and rail bars. Readings from the checkpoint run, slice then whale:

| Leg | Beat starts ms | Verdict |
|---|---|---|
| `at0622` appear | room, arrive 90 / 82 | over (the leg is already red on its gap) |
| `at0622` disappear | depart, room 105 / 96 | **over: new red** |
| `at0622` go-to-slot out | move 58 / 0 | **over on the slice: new red** |
| `at0622` go-to-slot home | move — / 19 | **over by 2 ms on the whale: new red** |
| `at0622` bullseye enter | shrink, move 40 / 44 | over (already red on its gap) |
| `at0622` sidebars hide / show / fit | 93, 69, 70 / 91, 52, 60 | over (already red on the hide's gap) |
| `at0690` seat into slot 1 | move cut, then 0 / 156 | over on the whale (already red on its gap) |
| `at0690` seat back to slot 2 | move, grow 81 / 54 | over (not reached past the seat-in red) |
| `at0690` one sidebar hide / show / fit | 57, 66, 62 / 53, 76, 67 | over (the hide's gap read red this run) |

The beat-start bar is red wherever a gesture waits before its first beat, which is every gesture but the walk across the band, and that sometimes too. That wait is the open stall: the time from planning to the first running frame is spent in the commit that plans the motion. Two legs that were green on every earlier clause are now red on this one, disappear and go-to-slot. The bar is one period as decided, and it is not loosened. These reds are the step's to report and the close-out's to settle.

### Checkpoint

- `bunx tsc --noEmit -p tests/app-test/tsconfig.json`: only the three known errors in files this arc never touched.
- `just app-test at0684-settle-window-commits.test.ts at0622-deck-settle-frames.test.ts at0690-real-transcript-asks.test.ts`: 23/44.
  - **`MAIN_THREAD_BAR_MS` holds on every leg, both arms.**
  - `at0684` is red on its fiber bar (`COMMIT_BAR`) in close, split, unfold and switch, as at Step 7's baseline. Its history has it red since `209cc5130`.
  - `at0622` is red on its gap legs as at Step 13, plus the new beat-start reds above.
  - `at0690` is red on the seat's gap and, this run, on the one-sidebar hide's gap (3.2–3.6 frames). Both were red before this step.
  - All go to the close-out.

## Close-out

Every Table T02 file, run alone with `just app-test <file>` on the finished tree (`dea2461fd` plus this step's comment edits), both arms in each run. Taken 2026-10-05. `just app-test-build` was run first. Logs are kept under `h4/` in the arc's documents.

| File | Verdict | Red legs, each red on both arms |
|---|---|---|
| `at0622-deck-settle-frames` | RED 14/28 | the settle records its own frames, and its own violations; an arrival interrupted by a close keeps its hold; a card appears, at the bar; a card's departure from a split column; the walk across the band; bullseye, and [F15]'s width; hiding the sidebars and the settled-resize retune, at the bar |
| `at0582-departing-frame-rect` | GREEN 1/1 | — |
| `at0583-departing-frame-inert` | GREEN 1/1 | — |
| `at0684-settle-window-commits` | RED 2/10 | a card's departure from a split column; dividing a shared column; unfolding a session card; switching workspaces |
| `at0690-real-transcript-asks` | RED 2/6 | seating a card into a column; one sidebar, and resize to fit |
| `at0555-session-fold-motion` | RED 0/2 | the fold's clock |
| `at0557-session-fold-shapes` | GREEN 1/1 | — |
| `at0563-session-fold-still-picture` | GREEN 1/1 | — |
| `at0566-three-beat-settle` | GREEN 2/2 | — |
| `at0605-still-crossing-deliveries` | GREEN 2/2 | — |
| `at0621-intra-workspace-slide` | GREEN 2/2 | — |
| `at0643-workspace-switch-cadence` | RED 0/2 | a workspace switch paints on time on a grown deck |

What each red is, with its cost:

- **The wait before the first beat.** This is `at0622`'s appear (93–105 ms, 5.5–6.2 frames), sidebars hide (91–104 ms), bullseye enter (42 ms on the slice, 121 ms on the whale) and disappear (beats start at 93–108 ms against a 17 ms period). It is also `at0690`'s seat into slot 1 (95–98 ms) and one-sidebar hide (53–57 ms, 3.1–3.4 frames), `at0555`'s fold clock (116–128 ms against 105) and `at0643`'s first switch frame (138–149 ms, of which 110–121 ms is React's render, against 100). The cause in every case is the commit that plans the motion: the time from the gesture to the first running frame is spent in React's render and the layout effects it pays, before any beat can start.
- **The go-to-slot home leg** is over its period by 2–3 ms: a 19 ms lead on the slice, and a beat start of 20 ms on the whale, against 16–17 ms.
- **`at0684`'s fiber bars (`COMMIT_BAR`):** close 2,738–2,744 against 2,000 (553 tooltip and popover fibers mounted in the window), split 1,112–1,120 against 1,075, unfold 537–545 against 212, and switch 1,434–1,440 against 1,285. Each is the size of the planning commit. The window's main-thread milliseconds (`MAIN_THREAD_BAR_MS`) hold on every leg.
- **`at0622`'s instrument legs:** "one row per settle" disagrees with the probe by 1 ms (19 vs 20 on the slice, 30 vs 29 on the whale). "An arrival interrupted by a close" never retargeted, because the arrival had landed before the close at 140 ms. That leg cannot reach the defect it is written for on this tree.

## Hand-back H4

Every Table T02 gesture on the user's release deck, at the finished tree. Taken 2026-10-05 04:03–04:06 UTC.

- **Tree:** `dea2461fd`. **Build:** `just app-release` in the arc worktree, instance `release-tugarc-real-transcript-motion` (version `0.8.16`). **Reader:** the worktree's debug `tugtool` (`0.8.16 (dea2461fd)`).
- **The deck:** H1's, restored first: the slice back to Two, whale C unfolded, slot 2 split, A back to slot 1 and focused. The census read 8,067 elements. Every reading's rest check was at 0 updates/s, and the deck at rest read `0 update(s)/s ... holding the main thread 0 ms/s`.
- **Commands:** H2's (`h4-run.sh`): every gesture with `--count 3 --chains --json`, once `slot --tasks`, then the slide deck. Generated by `h4-table.py` from the `--json` outputs.

| Run | Drive | Lead ms | Longest gap ms | Beats: start ms (landing) | Chains: n / longest / total ms | Largest commit: performed (mounted), react ms |
|---|---|---|---|---|---|---|
| `appear` | 1: appear | 16 | 52 | arrive 10 (finished) | 19 / 1 / 4 | — |
|  | 2: appear | 15 | 42 | arrive 11 (finished) | 19 / 2 / 5 | — |
|  | 3: appear | 15 | 43 | arrive 12 (finished) | 19 / 1 / 4 | — |
| `close` | 1: close | 24 | 27 | depart 22 (finished) | 12 / 2 / 7 | — |
| `split` | 1: split | 28 | 65 | room 65 (finished) | 8 / 40 / 51 | — |
|  | 2: split | 25 | 79 | room 78 (finished) | 9 / 38 / 56 | — |
|  | 3: split | 26 | 68 | room 68 (finished) | 8 / 43 / 53 | — |
| `slot` | 1: slot | 45 | 114 | move 114 (finished), grow 114 (finished) | 8 / 41 / 77 | — |
|  | 2: slot | 48 | 102 | shrink 102 (finished), move 102 (finished) | 8 / 41 / 80 | — |
|  | 3: slot | 45 | 114 | move 113 (finished), grow 113 (finished) | 8 / 41 / 77 | — |
| `fold` | 1: unfold | 14 | 66 | grow 66 (finished) | 3 / 2 / 2 | — |
|  | 2: fold | 32 | 40 | shrink 17 (finished) | 4 / 1 / 1 | — |
|  | 3: unfold | 15 | 54 | grow 54 (finished) | 3 / 2 / 2 | — |
| `unfold` | 1: fold | 37 | 43 | shrink 17 (finished) | 4 / 1 / 1 | — |
|  | 2: unfold | 15 | 66 | grow 66 (finished) | 3 / 2 / 2 | — |
|  | 3: fold | 28 | 38 | shrink 18 (finished) | 4 / 1 / 1 | — |
| `slide-c` | 1: slide | 20 | 28 | move 20 (finished) | 4 / 2 / 3 | — |
|  | 2: slide | 32 | 32 | move 34 (finished) | 5 / 8 / 10 | — |
|  | 3: slide | 24 | 29 | move 26 (finished) | 4 / 2 / 3 | — |
| `go` | 1: go | 15 | 44 | move 16 (finished) | 4 / 2 / 3 | — |
|  | 2: go | 16 | 23 | move 17 (finished) | 4 / 2 / 2 | — |
|  | 3: go | 15 | 28 | move 16 (finished) | 4 / 2 / 2 | — |
| `bullseye` | 1: bullseye | 14 | 29 | move 27 (finished) | 6 / 3 / 3 | — |
|  | 2: bullseye | 16 | 27 | move 26 (finished) | 6 / 2 / 2 | — |
|  | 3: bullseye | 16 | 33 | move 25 (finished) | 6 / 2 / 3 | — |
| `rails` | 1: rails | 15 | 81 | room 81 (finished), arrive 81 (finished) | 6 / 45 / 61 | — |
|  | 2: rails | 15 | 87 | room 87 (finished), arrive 87 (finished) | 6 / 48 / 66 | — |
|  | 3: rails | 15 | 85 | room 84 (finished), arrive 84 (finished) | 6 / 45 / 64 | — |
| `sidebar` | 1: sidebar | 15 | 79 | room 79 (finished), arrive 79 (finished) | 10 / 47 / 50 | — |
|  | 2: sidebar | 40 | 70 | depart 71 (finished), room 71 (finished) | 12 / 42 / 47 | — |
|  | 3: sidebar | 27 | 78 | room 78 (finished), arrive 78 (finished) | 11 / 44 / 47 | — |
| `fit` | 1: fit | 16 | 79 | shrink 79 (finished), move 79 (finished), grow 79 (finished) | 5 / 62 / 64 | — |
| `flip` | 1: flip | 18 | 19 | — | 2 / 0 / 0 | — |
|  | 2: flip | 15 | 33 | — | 1 / 0 / 0 | — |
|  | 3: flip | 16 | 19 | — | 1 / 0 / 0 | — |
| `switch` | 1: switch | 11 | 414 | — | 23 / 66 / 160 | — |
|  | 2: switch | 16 | 158 | — | 15 / 86 / 130 | — |
|  | 3: switch | 21 | 413 | — | 24 / 65 / 163 | — |
| `slot-tasks` | 1: slot | 92 | 98 | shrink -1 (cut), move -1 (cut), shrink 0 (finished), move 0 (finished) | — | 1532 (16), 56.0 |
|  | 2: slot | 96 | 114 | move 115 (finished), grow 115 (finished) | — | 1300 (0), 106.0 |
|  | 3: slot | 48 | 106 | shrink 105 (finished), move 105 (finished) | — | 1307 (7), 98.0 |

| Run | Taken (UTC) | Rest before it: updates/s, busy ms/s, worst gap ms | Census: elements | Frames perturbed by tasks |
|---|---|---|---|---|
| `appear` | 2026-10-05T04:03:46Z | 0, 0, 2 | 8067 | False |
| `close` | 2026-10-05T04:04:02Z | 0, 0, 2 | 8277 | False |
| `split` | 2026-10-05T04:04:05Z | 0, 0, 3 | 8067 | False |
| `slot` | 2026-10-05T04:04:12Z | 0, 0, 2 | 8067 | False |
| `fold` | 2026-10-05T04:04:25Z | 0, 0, 3 | 8067 | False |
| `unfold` | 2026-10-05T04:04:32Z | 0, 0, 2 | 8067 | False |
| `slide-c` | 2026-10-05T04:06:25Z | 0, 0, 2 | 8248 | False |
| `go` | 2026-10-05T04:04:46Z | 0, 0, 2 | 8067 | False |
| `bullseye` | 2026-10-05T04:04:56Z | 0, 0, 2 | 8067 | False |
| `rails` | 2026-10-05T04:05:03Z | 0, 0, 3 | 8067 | False |
| `sidebar` | 2026-10-05T04:05:18Z | 0, 0, 2 | 8067 | False |
| `fit` | 2026-10-05T04:05:27Z | 0, 0, 2 | 8067 | False |
| `flip` | 2026-10-05T04:05:31Z | 0, 0, 3 | 8067 | False |
| `switch` | 2026-10-05T04:05:47Z | 0, 0, 3 | 8067 | False |
| `slot-tasks` | 2026-10-05T04:06:00Z | 0, 0, 2 | 7950 | True |

| Run | First beat ms, H1 → H4 | Longest gap ms, H1 → H4 | Longest chain ms, H1 → H4 |
|---|---|---|---|
| `appear` | 24–39 → 10–12 | 62–114 → 42–52 | 8–9 → 1–2 |
| `close` | 46 → 22 | 46 → 27 | 9 → 2 |
| `split` | 148–149 → 65–78 | 149 → 65–79 | 54–71 → 38–43 |
| `slot` | 181–195 → 102–114 | 182–195 → 102–114 | 59–64 → 41 |
| `fold` | 51–62 → 17–66 | 51–62 → 40–66 | 9–19 → 1–2 |
| `unfold` | 50–56 → 17–66 | 50–56 → 38–66 | 9–17 → 1–2 |
| `slide-c` | 27–32 → 20–34 | 33–36 → 28–32 | 2 → 2–8 |
| `go` | 16–17 → 16–17 | 50–61 → 23–44 | 2–7 → 2 |
| `bullseye` | 50–64 → 25–27 | 122–133 → 27–33 | 12–16 → 2–3 |
| `rails` | 85–87 → 81–87 | 86–87 → 81–87 | 45–46 → 45–48 |
| `sidebar` | 79–100 → 71–79 | 79–101 → 70–79 | 45–50 → 42–47 |
| `fit` | 86 → 79 | 86 → 79 | 56 → 62 |
| `flip` | — → — | 31–41 → 19–33 | 0–4 → 0 |
| `switch` | — → — | 172–195 → 158–414 | 78–100 → 65–86 |
| `slot-tasks` | 127–159 → -1–115 | 128–159 → 98–114 | — → — |

### Against the bars

The bars are a lead of one period (17 ms), no gap over two periods (34 ms), and every beat starting within one period.

- **Within them:** close (beat 22 ms, gap 27), go (16–17, 23–44, gap over by up to 10 ms on one drive), bullseye (25–27, 27–33), flip (19–33), and slide (20–34, 28–32).
- **Over them:** appear's gap (42–52 ms), split (first beat 65–78 ms), slot (102–114), the unfold's grow (54–66), rails (81–87), sidebar (71–79), fit (79), and switch (longest gap 158–414 ms). The cause is the one the harness names: the planning commit, whose longest forced-layout chain is 38–48 ms on split, slot, rails and sidebar and 62 ms on fit, and 65–86 ms on a switch.
- **Since H1 the stall roughly halved** on split (148 → 65–78 ms) and slot (181–195 → 102–114), and fell on bullseye (122–133 → 27–33) and appear (62–114 → 42–52). It barely moved on rails, sidebar and fit, and not at all on switch.
- **The bars from Step 14 stand as set:** `MAIN_THREAD_BAR_MS` (close 140, rails 76, split 115, unfold 60, switch 100) and the one-period beat start. They go with the ask below, for the user to confirm or revise.

### The verdict

Not every leg is green, and not every gesture is within its bar. So, by the rule that no red is carried, the arc stops here on the user's choice: fix the planning commit's cost on this arc, or change the tests.

## The user's deck, after the join

The height-bearing gestures on the user's own release deck, read after `29b69a6cb` joined. Taken 2026-10-05 16:38–16:41 UTC. Unlike H1–H4, which read a scripted instance stood up from the arc's worktree, this is the deck the user works in.

- **Build:** instance `release-main`, `Tug.app` in `DerivedData/Tug/Build/Products/Release`, version `0.8.16 (29b69a6cb)`, built two minutes after the join.
- **The deck:** three Session cards in the flow (slots 0, 1 and 2, each one card, slim width, 1,099–1,200 px tall) and five rail cards (jots, arcs, layout, overview, workspaces). The census read 14,723–16,358 elements over the run, against H4's 8,067; the deck's live sessions kept writing to it.
- **Rest.** At rest the deck read 17–26 updates/s, holding the main thread 141 ms/s: 63 long-running loops, mostly progress dots on live sessions, this one among them. Every reading ran with the loops stilled by `tugtool deck motion demote on`, restored by `demote off` after each, and every reading's own rest check then passed (1–9 updates/s).
- **Commands:** `tugtool deck motion settle` with `--count 3 --chains --json`, on slot 1's card where a card is named. `split` ran on slot 2 with slot 1's card assigned into it first, so the column held two cards; on a one-card column it moves nothing. `sidebar` read `--component layout`. `fit` drives once. The deck was put back afterwards: every card unfolded, slot 1's card in slot 1.

| Run | Drive | Lead ms | Longest gap ms | Land frame ms (land at) | Beats: start ms (landing) | Chains: n / longest / total ms |
|---|---|---|---|---|---|---|
| `fold` | 1: unfold | 16 | 52 | 35 (351) | grow 52 (finished) | 5 / 2 / 2 |
|  | 2: fold | 31 | 31 | 27 (341) | shrink 24 (finished) | 5 / 2 / 2 |
|  | 3: unfold | 15 | 56 | 35 (367) | grow 56 (finished) | 7 / 2 / 2 |
| `unfold` | 1: fold | 33 | 38 | 38 (754) | shrink 28 (finished), move 28 (finished) | 7 / 5 / 7 |
|  | 2: unfold | 16 | 49 | 35 (351) | grow 48 (finished) | 12 / 3 / 4 |
|  | 3: fold | 28 | 28 | 27 (342) | shrink 26 (finished) | 4 / 1 / 1 |
| `split` | 1: split | 13 | 100 | 20 (529) | room 100 (finished) | 9 / 61 / 79 |
|  | 2: split | 16 | 102 | 32 (548) | room 101 (finished) | 9 / 60 / 85 |
|  | 3: split | 17 | 89 | 19 (520) | room 89 (finished) | 8 / 59 / 73 |
| `slot` | 1: slot | 28 | 104 | 18 (784) | move 103 (finished), grow 103 (finished) | 8 / 59 / 62 |
|  | 2: slot | 27 | 109 | 23 (788) | shrink 110 (finished), move 110 (finished) | 10 / 61 / 63 |
|  | 3: slot | 25 | 101 | 18 (768) | move 101 (finished), grow 101 (finished) | 10 / 57 / 59 |
| `rails` | 1: rails | 19 | 162 | 74 (890) | room 160 (finished), arrive 160 (finished) | 7 / 61 / 120 |
|  | 2: rails | 15 | 161 | 74 (873) | room 159 (finished), arrive 159 (finished) | 10 / 61 / 120 |
|  | 3: rails | 16 | 165 | 76 (892) | room 163 (finished), arrive 163 (finished) | 7 / 62 / 123 |
| `sidebar` | 1: sidebar | 23 | 93 | 24 (771) | room 93 (finished), arrive 93 (finished) | 9 / 59 / 60 |
|  | 2: sidebar | 23 | 86 | 25 (762) | depart 86 (finished), room 86 (finished) | 16 / 56 / 64 |
|  | 3: sidebar | 26 | 97 | 21 (771) | room 98 (finished), arrive 98 (finished) | 9 / 61 / 62 |
| `fit` | 1: fit | 15 | 90 | 19 (1001) | shrink 90 (finished), move 90 (finished), grow 90 (finished) | 6 / 70 / 70 |

Beside H4: fold and unfold read as they did there (first beat 24–56 ms, longest chain 1–5 ms). Split, slot, sidebar and fit start their first beat at 86–110 ms behind a forced-layout chain of 56–70 ms, and rails at 159–163 ms behind two chains totalling 120 ms, about twice H4's 81–87; this deck is nearly twice H4's census. The land frame is one period on slot, split and fit (18–23 ms, with one split at 32), 21–25 ms on sidebar, 27–38 ms on fold and unfold, and 74–76 ms on rails, so the land record reads more than one frame on every gesture but those three.

### The shrink

[F02]'s band, read frame by frame on this deck rather than by eye: the release deck has no screen-capture door, and this shell has no screen-recording permission. A `requestAnimationFrame` sampler (`.tug/arcs/set-up-and-go-fixups/step1/sampler.js`) read every still-crossing frame's box, its content box and the held card root inside it, while slot 1's card was driven into slot 2's column. Both cards in the column shrank, frame 1,176 → 600 px, content box 1,085 → 509 px, each held at its final 509 px, settled, and anchored at the bottom (`data-still-anchor="bottom"`: both transcripts were following).

| Frame | ms from arm | Content box px | Held root px | Band at top px |
|---|---|---|---|---|
| set-up | 36 | 1,085 | 1,085 | 0 |
| 1 | 165 | 1,085 | 509 | 576 |
| 2 | 191 | 928 | 509 | 419 |
| 3 | 207 | 800 | 509 | 291 |
| 4 | 214 | 755 | 509 | 246 |
| 5 | 228 | 682 | 509 | 173 |
| 6 | 245 | 620 | 509 | 111 |
| 7 | 262 | 579 | 509 | 70 |
| 8 | 279 | 553 | 509 | 44 |
| 10 | 312 | 527 | 509 | 18 |
| 13 | 362 | 513 | 509 | 4 |
| 16 | 412 | 509 | 509 | 0 |

The root's background is transparent, so the band shows the content box's own background (`oklch(0.31 0.01 263)`), with nothing in it. On the frame before the motion that strip held 576 px of transcript rows. They vanish at the first frame, leaving a blank strip between the masthead and the transcript that closes over about 250 ms. **The band is visible** (verified), and on a bottom-anchored transcript it sits at the top, under the chrome, not at the moving edge.

Which bears on [B02]'s cover. The chrome is 91 px tall (frame 1,176 against content 1,085), so a chrome that slides cannot cover 576 px. The column's neighbour rides the same edge as the frame it would cover, so it cannot cover the strip either. The band is the settled hold's alone. The hold before it held a shrink at its larger, starting height, which leaves no strip to show. On a growth the larger height and the final height are the same height, so the band exists on shrinks alone.

**The ruling.** The user chose to hold a shrink at its starting height, so it shows no band and pays its land relayout, while a growth keeps the settled hold. `settle-engine.ts` settles a frame only when its content does not shrink. This revises [B02] of `briefs/set-up-and-go-fixups-brief.md`.
