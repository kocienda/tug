# The session fold's frames — recorded readings

Every claim this arc makes about the fold is a reading taken here, with the commit it was taken at and the instrument that took it. A verdict with no reading under it is the failure this file exists to prevent: three folds were called healthy by an instrument that could not see the defect.

---

## The procedure

Every reading below the line is taken this way, on a release build of this branch running as an instance the reader is actually looking at, with their own content. `tugtool` here is `./tugrust/target/debug/tugtool` — a bare `tugtool` on `PATH` is `Tug.app`'s Release binary and does not carry this arc's changes.

```bash
# 1. Open the eval door on that instance. Loopback-only, per-instance, and
#    revoked by `disable` when the reading is over.
./tugrust/target/debug/tugtool deck motion enable

# 2. Arm the recorder BEFORE the gesture. This is the whole point: the rAF
#    chain has to be ticking steadily when the fold lands, so the dead time
#    shows up as a gap INSIDE the series rather than in front of it. The chain
#    stops itself after the window, so a forgotten `read` leaves nothing running.
./tugrust/target/debug/tugtool deck motion gesture --mode arm

# 3. Fold the card. Any door reaches the same stamp — the Z2 control, Session ▸
#    Fold Session, ⌃⌘Y — and this one is scriptable, which is what makes the
#    reading repeatable rather than a description of a hand movement.
./tugrust/target/debug/tugtool host tell set-card-folded -p cardId=<cardId> -p folded=true

# 4. Wait past the land (the motion is ~270 ms; a second is ample), then read.
./tugrust/target/debug/tugtool deck motion gesture --mode read

# 5. And put it away.
./tugrust/target/debug/tugtool deck motion gesture --mode disarm
./tugrust/target/debug/tugtool deck motion disable
```

`read` opens on the display mode the page reports for itself — `display 3200x1800 @2x` — and then prints the gap series in full with the gesture's own gap bracketed: `11 12 [120] 59 11 12 14 17 …`. The shape is the evidence and a worst-number summary cannot tell one long freeze from a run of small ones. `gestureGapMs` is that bracketed number and it is the arc's headline reading; `-1` there means no stamp landed inside the series, which is a fact about the procedure (the fold happened outside the window, or never) rather than about the deck.

**The mode rides the reading because the reading is half of a comparison.** The same fold is read at the default mode and at the scaled one, by somebody running these five commands twice with a trip through System Settings in between, and the one error that pairing admits is writing the wrong mode beside a series. `screen.width`, `screen.height` and `devicePixelRatio` come from the page, so the label cannot disagree with the numbers it sits on.

**`ticks[0] - armedAt` is not the number.** The chain is armed by a shell command and the gesture arrives afterwards, so by the time the fold lands the chain has been ticking for seconds and the first gap carries no information about the gesture at all.

### The procedure runs end to end — confirmed live

`just app-release` from the arc worktree builds and launches `release-tugarc-session-fold-frames` — a release build of this branch whose bundle id, data dir and derived-data path are all derived from the worktree's own path, so it stands beside the `release-main` the user is in rather than replacing it. Against that instance, on port 55321:

```
$ tugtool deck motion enable  --instance release-tugarc-session-fold-frames
eval enabled on port 55321
$ tugtool deck motion gesture --mode arm  --instance release-tugarc-session-fold-frames
gesture armed: window 8000ms
$ tugtool deck motion gesture --mode read --instance release-tugarc-session-fold-frames
display 3200x1800 @2x
gesture NOT RECORDED: no gesture stamp landed inside the series — 61 ticks at 17.0ms. Arm, then gesture, then read
  worst 26ms, 1 gap(s) over one frame (chain still running — the series is not final)
  26 17 15 18 17 15 18 17 16 17 17 17 16 17 16 17 17 17 16 15 19 16 17 16 16 18 17 16 17 17 16 17 15 17 18 15 18 17 17 15 16 19 16 17 15 17 18 17 17 17 14 17 18 17 16 17 17 16 17 17
```

Both halves of the verb are now proven against a real deck rather than only against unit tests: the shell composes the call, the page answers it, the chain ticks at the display's own rate for a full second, the mode is stamped by the page, and `NOT RECORDED` is the honest answer to a `read` with no gesture in front of it rather than a zero that would read as health. An earlier attempt answered `gesture is not a function` because the instance it was aimed at is `Tug.app` built from `main`; that question is closed.

---

## The baseline — the user's deck at `6ad15cb91`, both display modes

Taken 2026-09-28 on `release-main` (port 55348, `Tug.app` built from `main` at `6ad15cb91`, `BuildProfile release`), the instance the user was working in, with their own workspace: 19,586 elements at the scaled mode, ten panes, six of them session cards. Nothing in this arc's code was on that deck — its bundle has no `window.__tugMotion.gesture` — so the instrument is the fallback the procedure names: a `requestAnimationFrame` chain installed through the eval door, armed 600 ms before the gesture, read back after it, and bracketed by hand. The recorder, in full, since the reading is only as good as it:

```js
(function(){var W=2500;var ticks=[];var t0=performance.now();
window.__tugFoldRec={t0:t0,ticks:ticks,done:false,mode:{w:screen.width,h:screen.height,dpr:devicePixelRatio}};
function tick(){var n=performance.now();ticks.push(n);if(n-t0<W)requestAnimationFrame(tick);else window.__tugFoldRec.done=true;}
requestAnimationFrame(tick);return t0;})()
```

The bracket is `performance.now()` read through the eval door immediately before `tugtool host tell set-card-folded` is sent: the gap in the series that contains that stamp is the gesture's gap, and the **lead** is that gap plus every consecutive gap after it over 1.5 frames — [F02]'s "dead time before the first steady tick", computed rather than read by eye. The display stamp is the page's own `screen.width`, `screen.height` and `devicePixelRatio`, read inside the same recorder, so a series cannot carry the wrong mode. (Which it proved on the first pass: see *How the modes were switched* below.)

One independent witness rides every reading: the eval that reads `performance.now()` *after* the tell cannot return until the page's main thread is free, and on every session-card reading that round trip took within one frame of the lead — 137 ms of tell for a 138 ms lead, 251 for 246, 283 for 308. The frames in the lead are not produced and then dropped somewhere downstream; the main thread is held for the whole of it.

### The cards, at each mode

The same four cards at both modes. Pane heights follow the viewport (the deck lays out to the window), element counts are a snapshot — `d2d780b1` is a live session and its count moved between the two censuses.

| card | at 3200×1800 @2x (scaled) | at 2560×1440 @2x (default) | role |
|---|---|---|---|
| `3dd62fc2` | 1630 px, 4,614 elements | 1368 px, 4,471 elements | session, [F02]'s first card |
| `d2d780b1` | 1630 px, 3,468 elements | 1368 px, 1,527 elements | session, [F02]'s second card |
| `1f13d2ab` | 813 px, 2,305 elements | 682 px, 2,305 elements | session, [F02]'s third card |
| `25512a40` | 439 px, 235 elements | 369 px, 235 elements | sidebar (jots), the control |

One of the three session cards is half the height it was in [F02] (`1f13d2ab` was 1630 px there) and one carries half again as many elements (`3dd62fc2`, ~3.0k there). The deck is the same deck a day on, not the same bytes.

### The series, scaled mode — `display 3200x1800 @2x`

Two full passes were taken at this mode (the second by accident — below). Every session-card series, gesture gap bracketed, the land in bold where it dropped frames:

| card | direction | series from the gesture | lead | land |
|---|---|---|---|---|
| `25512a40` | fold | `[21] 11 18 17 15 18 16 17 17 17 …` | **0** | none |
| `25512a40` | unfold | `[16] 17 17 16 17 17 16 18 16 16 …` | **0** | none |
| `25512a40` | unfold (pass 2) | `[23] 11 17 17 17 16 16 17 …` | **0** | none |
| `3dd62fc2` | fold | `[17] 146 11 10 16 17 16 17 17 17 16 17 17 16 17 17 16 **40 55** 3 2 17 …` | **146** | 40+55 |
| `3dd62fc2` | unfold | `[13] 133 19 15 16 17 17 16 17 17 17 16 17 16 17 17 **55 59** 2 17 …` | **133** | 55+59 |
| `3dd62fc2` | fold (pass 2) | `[138] 20 13 12 17 17 16 16 18 17 16 16 17 17 16 **43 69** 3 2 17 …` | **138** | 43+69 |
| `3dd62fc2` | unfold (pass 2) | `[138] 55 20 10 11 16 16 17 17 **62 81** 3 4 17 …` | **193** (138+55) | 62+81 |
| `d2d780b1` | fold | `[17] 223 33 11 16 16 18 16 17 17 16 17 17 16 17 21 19 13 14 17 …` | **256** (223+33) | 21+19 |
| `d2d780b1` | unfold | `[16] 119 19 17 12 17 17 17 16 17 17 16 17 17 16 17 **43 56** 2 16 …` | **119** | 43+56 |
| `d2d780b1` | fold (pass 2) | `[11] 231 54 13 11 8 16 17 16 17 17 16 17 17 16 25 28 18 13 15 …` | **285** (231+54) | 25+28 |
| `d2d780b1` | unfold (pass 2) | `[138] 46 24 11 14 17 17 16 17 16 **92 35** 7 16 17 …` | **184** (138+46) | 92+35 |
| `1f13d2ab` | fold | `[17] 226 22 10 8 17 16 17 16 17 17 17 16 17 17 16 22 12 16 17 …` | **226** | 22 |
| `1f13d2ab` | unfold | `[235] 44 15 13 16 13 15 17 17 16 17 16 17 16 18 16 16 17 17 17 16 17 17 17 16 17 16 17 25 14 14 …` | **279** (235+44) | 25 |
| `1f13d2ab` | fold (pass 2) | `[274] 34 11 20 11 16 17 17 16 17 17 16 17 17 17 16 17 16 17 17 16 17 17 17 16 16 17 24 13 13 …` | **308** (274+34) | 24 |
| `1f13d2ab` | unfold (pass 2) | `[17] 277 26 17 15 17 15 17 17 16 16 17 17 17 15 26 15 10 …` | **303** (277+26) | 26 |

Under the 1 ms `sample` (which is its own load on the process; these run longer than the unsampled ones and are kept apart for that reason):

| card | direction | series from the gesture | lead | land |
|---|---|---|---|---|
| `3dd62fc2` | fold, sampled | `[212] 32 16 11 12 17 17 17 16 17 16 17 17 17 16 **45 80** 4 4 17 …` | 244 | 45+80 |
| `3dd62fc2` | fold, sampled (pass 2) | `[17] 235 44 19 22 19 13 15 18 16 15 18 17 16 16 17 17 **62 112** 6 3 21 12 …` | 279 | 62+112 |
| `1f13d2ab` | fold, sampled (pair) | `[17] 309 33 18 12 11 16 17 17 16 17 17 15 18 17 24 19 7 …` | 342 | 24+19 |
| `1f13d2ab` | unfold, sampled (pair) | `[308] 65 23 **208** 47 14 7 11 17 17 16 16 …` | 373 | — |
| `1f13d2ab` | fold, sampled (pair, pass 2) | `[480] 50 24 18 19 14 15 15 17 13 18 16 16 29 14 12 …` | 530 | 29 |
| `1f13d2ab` | unfold, sampled (pair, pass 2) | `[425] 57 31 26 16 20 29 19 19 36 21 18 17 …` | 539 | 36 |

The one series that is not the others' shape is the sampled unfold of `1f13d2ab` in the first pair: a second freeze of 208 ms three ticks into the motion, on top of the 308 ms lead. It happened once in twenty-two session-card readings and is on the record as that.

### The series, default mode — `display 2560x1440 @2x`

| card | direction | series from the gesture | lead | land |
|---|---|---|---|---|
| `25512a40` | fold | `[16] 17 17 15 18 17 15 18 16 17 …` | **0** | none |
| `25512a40` | unfold | `[16] 17 17 16 17 17 16 16 17 17 …` | **0** | none |
| `3dd62fc2` | fold | `[17] 213 33 11 10 16 17 16 16 18 16 16 18 17 16 17 17 17 15 18 16 17 …` | **246** (213+33) | none |
| `3dd62fc2` | unfold | `[16] 147 25 10 8 11 17 16 17 17 16 17 16 17 17 17 16 **56 57** 2 2 17 …` | **147** | 56+57 |
| `d2d780b1` | fold | `[214] 27 11 14 17 17 16 17 17 16 17 16 17 17 17 22 15 13 16 …` | **241** (214+27) | 22 |
| `d2d780b1` | unfold | `[130] 31 20 9 10 17 16 17 16 17 17 16 17 17 16 **43 59** 2 13 17 …` | **161** (130+31) | 43+59 |
| `1f13d2ab` | fold | `[17] 238 45 29 15 9 14 17 17 16 17 17 16 17 17 16 17 24 34 9 16 …` | **312** (238+45+29) | 24+34 |
| `1f13d2ab` | unfold | `[17] 232 33 16 12 9 15 16 17 17 16 17 17 16 17 17 22 12 16 …` | **265** (232+33) | 22 |
| `3dd62fc2` | fold, sampled | `[188] 36 20 12 12 16 17 17 16 17 17 16 17 **48 77** 5 4 16 …` | 224 | 48+77 |
| `1f13d2ab` | fold, sampled (pair) | `[17] 297 63 23 18 16 16 17 16 17 17 17 16 17 16 17 24 19 7 …` | 360 | 24+19 |
| `1f13d2ab` | unfold, sampled (pair) | `[16] 296 51 31 18 14 13 12 16 16 17 16 17 26 15 9 …` | 378 | 26 |

### Where the time goes, at each mode

A 1 ms `/usr/bin/sample` of `com.apple.WebKit.WebContent` pid 26494 (Tug's page: it is the one that fills with `JSC::` frames when the page is given a busy loop through the eval door), main thread only, symbols counted on every path they appear on, [F03]'s reading:

| | scaled, one fold | default, one fold | scaled, fold+unfold | default, fold+unfold |
|---|---|---|---|---|
| main-thread samples / idle / busy | 2078 / 1564 / 514 | 2085 / 1658 / 427 | 4066 / 2338 / 1728 | 4070 / 2661 / 1409 |
| `Page::updateRendering` | 288 | 263 | 1163 | 1108 |
| `Document::resolveStyle` | 226 | 192 | 1040 | 837 |
| `Document::updateLayout` | 89 | 71 | 434 | 329 |
| `RenderLayerCompositor::updateCompositingLayers` | 120 | 101 | 435 | 372 |
| `computeCompositingRequirements` (recursive, over-counts) | 414 | 393 | 1821 | 1434 |
| `updateBackingAndHierarchy` (recursive, over-counts) | 388 | 330 | 1297 | 1283 |
| rAF callbacks | 67 | 64 | 308 | 332 |
| microtask checkpoints | 151 | 121 | 586 | 486 |
| event listeners | 0 | 0 | 0 | 0 |

The second scaled pass read the same table larger — 407 / 298 / 109 / 165 on one fold, 1430 / 1059 / 431 / 456 on the pair — with the same proportions. Style resolution is the largest term under `updateRendering` at both modes, the compositing walk second, layout third; the pair is the fold's shape at roughly four times the size, because a fold-and-unfold under `sample` carried two 300–500 ms leads.

### Population and floor, at each mode

| | scaled | default |
|---|---|---|
| `deck motion layers` | 18,032 elements, 1,278 stacking contexts, 6,052 render-layer candidates | 17,563 elements, 1,042 stacking contexts, 5,828 candidates |
| `deck motion rest` | 8 updates/s over a 2 ms floor, 30 ms/s held (worst 7 ms) | 13 updates/s, 63 ms/s held (worst 13 ms) |

Second scaled pass: 18,016 / 1,270 / 6,059 and 10 updates/s, 56 ms/s. The at-rest figures are the user's live deck with a session mid-turn on it — the same as [F01] — and move with the turn, not with the mode.

### How the modes were switched

The earlier claim in this paper that nothing on the machine can change a display mode from a shell was wrong. CoreGraphics does it in a dozen lines of Swift run through `xcrun swift`: `CGDisplayCopyAllDisplayModes` with `kCGDisplayShowDuplicateLowResolutionModes` lists the HiDPI modes (the Studio Display's id 12 is 2560×1440 over 5120×2880, the default; id 16 is 3200×1800 over 6400×3600, the scaled one), and `CGConfigureDisplayWithDisplayMode` inside a `CGBeginDisplayConfiguration` / `CGCompleteDisplayConfiguration(.forSession)` pair sets one. The deck re-lays out to the new window size within a few seconds; the census above was re-taken after it.

The first default-mode pass came back with only its first series stamped `2560x1440` and every later one stamped `3200x1800`: the display had gone back to the scaled mode some fifteen seconds after the switch, by something outside this procedure — a re-run held the default mode for well over a minute of polling and for the whole retake, so it was not the API. The page-side stamp is what caught it, which is exactly the mislabelling it was added to prevent; the seven mis-stamped series are not thrown away, they are the scaled mode's second pass above. The display was put back to the scaled mode, its mode as found, when the readings were done.

### The verdict on [F07]: closed as a non-factor

Delivery is the same at both modes. Unsampled session-card leads run 119–308 ms at the scaled mode and 147–312 ms at the default; the land drops a 40–112 ms pair at the scaled mode and a 43–77 ms pair at the default, on the same cards in the same places; the sidebar control loses nothing at either; and the `sample` tables carry the same terms in the same proportions. The default mode has a smaller page (fewer stacking contexts, a shorter pane) and reads, if anything, marginally faster for it — which is the population, not the compositor. Nothing in the readings distinguishes the two modes beyond what the page's own size explains.

So the lead and the land are the page's, not WindowServer's: the main thread is held for the whole of the lead (the tell round trip says so independently), and the frames that are missing were never produced. **[F07] is closed as a non-factor in this arc's readings**, and [Q02] stays deferred rather than reopened — a presented-frame instrument would be measuring frames the page did not deliver.

Against [F02], taken a day earlier on the same deck by the same kind of recorder, the leads are longer — 86–130 ms then, 119–312 ms now — on a deck that has since grown (`3dd62fc2` from ~3.0k to 4.6k elements, 19.6k on the page against 14.6k) and with a session streaming in one of the folded cards. The shape is unchanged: the lead, a catch-up tick or two, a steady run, and two dropped frames at the land. That is the number the rest of this arc is measured against.

## The settle sampler's own cost, before and after — the user's deck at `6ad15cb91`

The product records every settle with its own `requestAnimationFrame` pump, and each tick of it asked every shown pane for three things: its `getBoundingClientRect()`, its own effects (`getAnimations({ subtree: true })` plus `getKeyframes()` per effect) and its `getComputedStyle()`. The module's comments named two different calls as "the expensive one" and neither was measured, so before anything was cut the three were timed where they run: on `release-main` (ten panes, 19.6k elements, `display 3200x1800 @2x`), in a second rAF loop installed through the eval door beside the product's own, timing each read across all ten panes per tick, during folds and unfolds of `3dd62fc2`. Twenty-one ticks from the gesture, `performance.now()` at its 1 ms grain:

| loop body, per tick | fold: median / max / sum over 21 ticks | unfold: median / max / sum | the gesture's series |
|---|---|---|---|
| rect only | 5 / 28 / 103 ms | 4 / 48 / 117 ms | `162 19 10 9 17 … 39 65 4 8` / `158 24 11 8 16 … 60 73 2` |
| effects only | 5 / 27 / 98 ms | 5 / 45 / 119 ms | `140 23 9 10 17 … 40 65 3 9` / `145 22 13 8 12 … 59 72 3` |
| computed style only | 5 / 27 / 102 ms | 4 / 45 / 111 ms | `156 17 12 16 17 … 38 64 3 11` / `132 27 11 13 18 … 59 70 2 2` |
| effects + computed, no rect | 5 / 28 / 104 ms · 5 / 24 / 103 ms | 5 / 46 / 115 ms · 4 / 44 / 112 ms | `159 17 9 16 … 38 66 3 9` / `155 19 12 14 … 58 71 4` |
| all three, order rotated per tick | 5 / 28 / 100 ms | 5 / 35 / 108 ms | `139 25 10 11 … 39 65 3 11` / `146 19 11 8 … 54 60 3 1` |
| **nothing** (the loop alone) | 0 / 0 / 0 ms | 0 / 0 / 0 ms | `155 18 11 16 … 39 66 2 10` / `148 21 14 16 … 58 71 3 3` |

Two things the table says that the comments did not:

- **No read is the expensive one. The first read is.** In the rotated body each of the three costs 4–5 ms when it goes first and 0 ms when it goes second or third, on every tick. The price is the pending style flush the first DOM read of the tick forces — the fold's `height` tween dirties style every frame — and it is the same price whichever read pays it. The subtree walk the plan's decision suspected ("effects only") is indistinguishable from the other two; `getKeyframes()` is not visible at all.
- **On this fold the sampler costs the frame nothing.** The gesture's series is the same with the loop reading everything and with it reading nothing — the same lead, the same two dropped frames at the land. The style and layout the reads force are work the rendering update was about to do anyway, so the flush moves inside the callback rather than adding to the frame.

That second fact is a property of a fold that lays the page out every frame, not of the sampler, and it is exactly what changes once the fold's motion is compositor-only ([B03]): a settle that dirties no style and no layout per frame would still be laid out per tick by `getBoundingClientRect()`, the one read of the three that forces layout as well as style — and the box it reads feeds only `rectsChangedAfterLanding`, a field the product's `settle-frames` row does not carry. So that is the read the product path stops making: `sampleSettleFrame` now reads rects only when asked (`readRects`), the bench probe asks, and the canvas's own record does not. Its samples hand the classifier `rect: null` and the row it writes is unchanged field for field.

**After.** The in-product body is now "effects + computed, no rect", which the table already has, taken twice: 103–115 ms over the window against 100–108 ms for the full body, the same lead and the same land. The change is worth nothing on this fold, on this deck, today, and the reading says so rather than crediting it; its value is a forced layout per tick that will not be there to blunt the compositor-only fold when it lands. A `sample` of the after state on the user's deck waits on a release build of this branch replacing `release-main`, which is the user's act; the before profile is the Step 4 samples above, where `getBoundingClientRect` under rAF callbacks carried 249 of the pair's 308 rAF samples with style resolution under it — the flush, attributed to the read that happened to go first.

## The fold's shape: three candidates read on the user's deck — at `6ad15cb91`

The arc's design question was which transform-family shape the fold should take so that its per-frame motion leaves the main thread ([B03]), with three candidates worked in the plan and every one of them a shape [D135] refuses by name. So before any doctrine was amended the candidates were built and read where the defect lives: on `release-main`, on the same three cards as the baseline, at `display 3200x1800 @2x`, by the same rAF recorder.

**How they were built.** Through the eval door, `Element.prototype.animate` was wrapped so that a call on a `.tug-pane` whose keyframes carry `height` and no `transform` — the fold's shrink or grow beat, exactly as `springSettleKeyframes` writes it — is rewritten into the candidate's keyframes under a switch (`window.__tugFoldShape`), and everything else about the settle is left as shipped: the React commit, the `settle-arm`, the fold and still crossing marks, the held content height, the beats, the completion. So the reading isolates the per-frame motion, which is the only thing a shape changes.

- **C3 (the clip):** the frame's box is pinned inline at the open height for the motion and `clip-path: inset(0 0 <n>px 0)` sweeps the bottom edge over the same spring offsets; at the finish the inline height comes off under a final clip and the clip follows a frame later.
- **C1 (scale and counter-scale):** the frame is pinned inline at its committed (folded or open) height, its content box is laid out at the open height so the chrome's `overflow: clip` is the window, `transform: scaleY(h/h1)` runs on the frame about its top, and each of the chrome's three children counter-scales by `h1/h` about the frame's top (`transform-origin: 0 -<offsetTop>px`), so the title bar and the body draw at their own size and position while the chrome's border, corners and shadow smear with the frame. The first build of C1 laid the content box out without pinning the frame and, the pane's height being `auto`, propped the whole frame open — the scale then ran on the open box and read 3224 px visual at its first sample. Recorded so the next builder pins the box.
- **C2** was not built: it exists to fix C1's chrome smear, and C1 turned out to buy nothing for the smear to be forgiven against.

**One thing the switch found before it read anything:** a session fold's settle carries a real `height` term on **two** panes. On the fold of `1f13d2ab` the wrapper was called for `9bf239b2` (the folding pane, 812 → 145) and for `777fd7d7` (its column sibling, 812 → 1480), in two beats — the shrink, then the sibling's grow into the room. Any shape has to carry both, and "no `height` on a session fold" means neither.

### The series, per card, per shape

Gesture gap bracketed, the land in bold, the sibling's grow beat included in every series. `off` is the shipped shape read by the same procedure seconds before and after each candidate.

| card | direction | shape | series from the gesture | lead | land |
|---|---|---|---|---|---|
| `1f13d2ab` (813 px) | fold | off | `[16] 257 23 10 12 17 16 17 17 16 16 17 17 17 16 17 20 13 17 …` | **257** | 20 |
| | fold | C3 | `[274] 26 7 11 15 17 18 17 16 15 17 17 17 17 17 21 13 17 …` | **300** | 21 |
| | fold | C1 | `[17] 266 29 5 16 17 17 17 17 17 17 15 16 17 18 17 20 13 18 …` | **295** | 20 |
| | unfold | off | `[262] 24 19 14 16 17 17 15 18 17 16 17 16 17 23 12 15 17 …` | **262** | 23 |
| | unfold | C3 | `[18] 398 54 8 6 17 16 16 21 14 16 17 17 17 17 17 …` | **452** | — |
| | unfold | C1 | `[265] 24 10 15 16 19 15 18 15 17 16 18 18 16 17 20 13 17 …` | **265** | 20 |
| `3dd62fc2` (1630 px) | fold | off | `[227] 24 15 11 13 9 15 19 16 17 15 16 17 **212 115** 6 2 17 …` | **227** | 212+115 |
| | fold | C3 | `[203] 24 8 17 18 17 13 19 17 17 17 17 15 17 18 **50 95** 8 12 17 …` | **203** | 50+95 |
| | fold | C1 | `[200] 34 8 5 15 18 16 17 17 17 16 15 17 16 17 **52 98** 5 12 17 …` | **234** | 52+98 |
| | unfold | off | `[19] 135 27 12 9 15 18 15 18 15 18 17 17 17 16 16 **55 73** 4 2 17 …` | **162** | 55+73 |
| | unfold | C3 | `[167] 22 11 17 19 17 16 17 16 18 17 17 17 15 17 **66 78** 3 4 15 …` | **167** | 66+78 |
| | unfold | C1 | `[17] 160 23 10 7 16 16 18 15 17 17 18 15 18 17 15 17 **65 79** 3 4 16 …` | **160** | 65+79 |
| `d2d780b1` (1630 px) | fold | off | `[17] 163 25 14 16 8 15 15 10 17 17 14 19 17 17 16 16 **39 57** 3 1 16 …` | **163** | 39+57 |
| | fold | C3 | `[187] 14 5 10 19 17 17 17 16 17 17 17 **43 73** 3 13 17 16 17 17 17 27 9 …` | **187** | 43+73 |
| | fold | C1 | `[15] 179 35 8 13 17 17 17 16 17 17 16 15 18 15 **56 74** 3 2 17 …` | **214** | 56+74 |
| | unfold | off | `[184] 38 15 15 17 16 17 16 17 **55 72** 3 3 17 14 19 17 …` | **222** | 55+72 |
| | unfold | C3 | `[15] 185 32 8 10 17 16 17 17 16 17 17 18 15 17 17 **66 76** 3 4 17 …` | **217** | 66+76 |
| | unfold | C1 | `[17] 181 33 **143 107 68** 3 13 18 17 16 38 2 12 15 17 …` | **532** | 38 |

Three readings, one per row of the argument:

- **The lead does not move.** 160–274 ms shipped, 167–300 ms under C3, 160–295 ms under C1, on the same cards minutes apart. The shape begins at the first frame and the lead is everything before it.
- **The land does not move.** A tall card's fold drops the same two frames at its end under every shape — 50–115 ms pairs, shipped and candidate alike. The land is the completion's commit.
- **The middle was never dropping frames.** Between the lead and the land every series here runs at 15–19 ms per tick, under `height` as much as under a transform or a clip. On this deck the per-frame walk fits inside the frame.

The one series that stands out is C1's unfold of `d2d780b1`: a 532 ms lead made of five freezes. The chrome's three children were not standing layers, so the counter-scale promoted them on the gesture's first frames and rastered a 1630 px session card three times over — [D9]'s second half, measured. A shipped C1 would need the interior to be a standing layer per session card, which is a cost of its own that this reading did not go on to price.

### What the shapes do remove, per frame

A 1 ms `sample` of WebContent across one fold of `3dd62fc2` under each shape, main-thread samples on every path:

| | shipped (`height`) | C3 (`clip-path`) | C1 (scale + counter-scale) |
|---|---|---|---|
| main-thread samples / idle / busy | 1847 / 1288 / 559 | 1880 / 1443 / 437 | 1872 / 1460 / 412 |
| `Page::updateRendering` | 310 | 274 | 253 |
| `Document::resolveStyle` | 307 | 203 | 185 |
| `Document::updateLayout` | 137 | 53 | 41 |
| `RenderLayerCompositor::updateCompositingLayers` | 95 | 82 | 71 |
| `computeCompositingRequirements` (recursive) | 326 | 401 | 313 |
| `updateBackingAndHierarchy` (recursive) | 306 | 112 | 100 |
| rAF callbacks | 101 | 75 | 69 |

So [F03]'s walk is real and the candidates do take most of the per-frame layout and the backing update out of the loop — about 120 ms of main thread across a fold. What they do not do is deliver a frame, because the frames being lost are not in the loop.

### The still interior (Risk R02)

Sampled every third tick through each motion: under every shape the fold and still marks are on the frame from the first sampled tick after the gesture to the land, `--tugx-still-held-height` reads the open content height throughout (721.5 px on `1f13d2ab`, 1539 px on the tall cards), and the card root's layout height holds at that value while the frame's edge moves — 722 → 722 → 722 as the frame goes 813 → 459 → 233 → 167. Nothing inside re-flowed mid-sweep under any candidate; the hold is the crossing's, not the shape's.

### The eye, and the verdict

No eye verdict was taken, and none is owed: the eye was to decide whether a shape that delivers the fold's frames looks well enough to overturn [D135]'s refusals, and no shape delivers a frame the shipped one drops. The refusals stand with nothing weighed against them. **The fold keeps its real `height` term** — [P09] in the plan — and the arc's remaining defect is the lead and the land, both commits, which is where the next reading goes. The per-frame walk's cost is on the record above as the population's ([F03], [F04], `briefs/workspace-switch-cheap-brief.md`); it is a price, not a dropped frame.

The switch was taken back out of the deck when the readings were done — `Element.prototype.animate` restored, no pane left with a transform, a clip or an inline height — and nothing of the spike is in the tree.

**Nothing below this line is that verdict.** The readings that follow were taken by the app-test bench and by the deck's own trace row, and neither is the user's deck.

---

## The commit frame and the land frame, with numbers — the user's deck at `6ad15cb91`

Taken 2026-09-28 on `release-main` (port 55348, `Tug.app` from `main` at `6ad15cb91`), the same instance and the same three session cards as the baseline, at the scaled mode (`display 3200x1800 @2x`), with the deck at 18,901 elements, 1,160 stacking contexts and 6,337 render-layer candidates. [P07] said both frames would be read after the motion was fixed; [P09] kept the motion, so they are read on the shipped fold, and what the two-shape readings above already showed — lead and land unchanged under a motion that stops dirtying the tree — is the answer to [B04]'s "the walk's share may fall on its own": it does not, and the numbers below say why it never could.

### How the two frames were told apart

The instrument is the baseline's recorder and bracket, driven the same way, with one addition: a 1 ms `/usr/bin/sample` of WebContent pid 26494 that holds **one frame and not the other**. `sample` takes whole seconds only, and a fold is ~0.55 s from gesture to land, so a sample launched at the gesture holds both. So:

- **The lead alone.** The sample is launched ~315 ms *before* the tell, so it is back ~930 ms after the gesture; and the moment the tell returns — which is the moment the main thread frees, i.e. the end of the lead — the pane's `height` tween is paused through the eval door at `currentTime` 0. Nothing moves after the first frame, and the sample holds the lead, one or two frames of nothing, and rest. (The settle lands on its own clock about a second later — the animator's `finished` resolves when the planned duration runs out, paused or not — which is why the sample has to be back before then.)
- **The land alone.** Tell, pause at once as above, launch the sample at +400 ms, and at +500 ms call `finish()` on the paused tween. The completion runs inside the sample with no motion frames around it. On the two single-column cards the land followed `finish()` within ~55 ms; on the shared-column card the second beat (the column sibling's grow) ran on after the finish, and its land arrived ~430 ms later, as it does unforced.
- **Whole.** A sample launched ~75 ms before the tell, for the same window as the baseline's.

Two things about the record. The `set-card-folded` tell matches the **full** card id; a prefix is silently a no-op (the store finds no pane and returns), and the first six readings of this step were of nothing before that was caught. And the Step 6 shape switch had been installed twice, so its uninstall had restored the first wrapper rather than the native `animate`; the leftover threw inside a React commit when the pane's own Fold control was pressed to find out why nothing folded, which unmounted the deck root, and the instance was reloaded once (`tugtool host tell reload`) to bring it back. Every reading below was taken after that reload, on a native `animate`, with the deck at the population above.

### The series

Every reading is the gesture's gap in brackets, then the motion, with the land in bold. `whole` rows ran under the 1 ms sample.

| card | direction | series from the gesture | lead | land | lands at |
|---|---|---|---|---|---|
| `3dd62fc2` 1630 px | fold | `[14] 151 18 9 9 16 17 17 15 15 19 17 16 15 18 17 16 **34 38** 12 15 …` | **151** | 34+38 | +464 ms |
| `3dd62fc2` | unfold | `[16] 137 24 9 14 17 16 15 19 17 16 17 16 17 15 16 **55 53** 10 16 …` | **137** | 55+53 | +477 ms |
| `3dd62fc2` | fold, whole | `[13] 160 22 10 12 14 17 17 16 17 17 14 19 17 16 17 **38 50** 12 17 …` | **160** | 38+50 | +474 ms |
| `3dd62fc2` | unfold, whole | `[16] 155 37 14 11 16 16 18 16 17 17 16 16 18 16 **69 81** 2 15 …` | **192** (155+37) | 69+81 | +538 ms |
| `d2d780b1` 1630 px | fold | `[17] 139 11 8 10 17 16 17 16 17 17 16 17 17 17 16 17 **31 42** 8 23 …` | **139** | 31+42 | +453 ms |
| `d2d780b1` | unfold | `[147] 20 9 9 17 17 17 16 14 19 17 14 17 **45 53** 4 17 …` | **147** | 45+53 | +430 ms |
| `d2d780b1` | fold, whole | `[19] 161 16 12 9 18 17 17 17 16 15 18 17 16 17 16 18 **36 55** 9 16 …` | **161** | 36+55 | +492 ms |
| `d2d780b1` | unfold, whole | `[156] 26 17 10 9 14 18 **54** 16 16 9 9 13 16 **58 73** 1 18 …` | **182** (156+26) | 58+73 (and a 54 mid-motion) | +513 ms |
| `1f13d2ab` 813 px, shared column | fold | `[18] 246 20 7 10 17 16 17 … (16 ticks) … 23 17 12 13 17 17 17 17 16 16 18 17 16 **48 63** 5 17 …` | **246** | 48+63 | +1238 ms |
| `1f13d2ab` | unfold | `[16] 235 29 17 11 9 17 16 14 … 21 14 14 18 16 16 17 17 17 17 14 18 17 **62 79** 9 17 …` | **264** (235+29) | 62+79 | +1244 ms |
| `1f13d2ab` | fold, whole | `[274] 23 10 11 14 17 18 15 18 … 21 16 15 15 16 17 17 17 15 18 16 17 17 14 **50 60** 8 18 …` | **274** | 50+60 | +1255 ms |
| `1f13d2ab` | unfold, whole | `[287] 33 20 17 12 14 16 17 15 16 … 20 13 17 16 17 17 16 17 17 17 17 17 16 16 **60 81** 8 18 …` | **320** (287+33) | 60+81 | +1299 ms |

The shared-column card's land is at +1.2 s rather than +0.5 s because its fold is two beats — its own shrink, then the sibling's grow into the room — and the land is the second beat's completion. Its lead is the longest of the three, on the shortest pane.

The lead-scoped and land-scoped runs read the same leads (173 / 219, 178 / 214, 296 / 335 ms; a 1 ms `sample` is its own load) and, with the tween paused, **no gap over one frame anywhere between the lead and the settle's own landing** — the page is idle for the whole of a fold that never moves. That is the walk's-share answer stated as a series: take the motion away entirely and the lead does not move.

### What the lead is made of

Inside each lead-scoped sample, the gesture is one task: the WebSocket message's event listener, and inside it the microtask checkpoint that React's commit runs in. The task's samples, and the DOM entry points inside it that forced style or layout (a sample is ~1.55 ms at the rate `sample` achieved, ~630–650 per second):

| card, direction | lead (series) | samples in the gesture's task | `clientHeight` → forced **style** | `getBoundingClientRect` → forced **style** | `offsetLeft` → forced **layout** | other script |
|---|---|---|---|---|---|---|
| `3dd62fc2` fold | 173 ms | 105 (~162 ms) | 53 (~82 ms) | 20 (~31 ms) | 0 | ~32 |
| `3dd62fc2` unfold | 219 ms | 105 (~163 ms) | 53 (~82 ms) | 22 (~34 ms) | 0 | ~30 |
| `d2d780b1` fold | 178 ms | 106 (~162 ms) | 50 (~76 ms) | 17 (~26 ms) | 0 | ~39 |
| `d2d780b1` unfold | 214 ms | 107 (~180 ms) | 51 (~86 ms) | 17 (~29 ms) | 0 | ~39 |
| `1f13d2ab` fold | 296 ms | 179 (~284 ms) | 48 (~76 ms) | 27 (~43 ms) | **75 (~119 ms)** | ~29 |
| `1f13d2ab` unfold | 335 ms | 182 (~288 ms) | 42 (~66 ms) | 32 (~51 ms) | **78 (~123 ms)** | ~30 |

`Document::updateLayout` under the two 1630 px cards' leads: **3–5 samples**. `RenderLayerCompositor::updateCompositingLayers` across the whole lead-scoped window: **10–11 samples**, ~16 ms, and that includes the rest updates in the window. So the lead is **not** [B04]'s "one commit plus one layout plus one compositing walk". It is one commit plus **two whole-page style resolutions forced by script reads inside it**, and on a shared-column card a third, a whole-page layout forced the same way. Layout and the walk together are under a frame.

`tugtool deck motion chains` — armed across a fold on `3dd62fc2`: 44 read→write→read chains over 361 entries in 34 tasks — names the reads, and the bundle at the offsets it names says what they are:

- **`discoverScrollers`, under `beginResizeEpisode`, under the store's synchronous `notify` inside `_commitImposition`** — 9 chains, one per pane frame. The canvas's subscriber writes the rail-inset custom properties on the container (`--tug-imposer-inset-*`, the `L7e` writes in the chain), begins a resize episode on every frame, and `discoverScrollers` reads `.tug-pane-content`'s `scrollHeight > clientHeight` on each. The first of those reads, on a tree the custom-property writes just invalidated top-down, pays the whole page's style resolution. **This is the ~80 ms `clientHeight` bar, and it runs before React has committed anything.**
- **The transcript list view's `useLayoutEffect`s** — 15 + 13 chains. React's commit writes `data-evict-active` / `data-evict-fallbacks` / `data-tug-scroll-state` on the list container and then the next effects read `clientHeight` and `scrollTop` (`applyRestoreTarget`, `pinToBottom`, the scroll-state effect). Each read after a write is a forced style pass over what the write dirtied. **This is the ~30–50 ms `getBoundingClientRect`/second-`clientHeight` bar.**
- **`paneFrames` sweep (`Zue`)** — reads `offsetLeft`, `offsetTop`, `offsetWidth`, `offsetHeight` on **every** pane frame, under a React layout effect, after the imposition's writes: a forced whole-page layout. It costs ~120 ms on the shared-column card, where the fold changes the column's arrangement, and does not appear in the two single-column leads.
- `markKind` / `markStillCrossing` (the still hold's `--tugx-still-held-height` writes) and a `scrollTop` chain in the vendor bundle are the rest, small.

The tell's round trip is the independent witness again: 137–319 ms of tell for 137–335 ms of lead, on every reading.

### What the land is made of

The land-scoped samples hold the completion and ~1.2 s of rest around it, so their busy count carries 40–70 ms of at-rest updates ([F01]: 8–13 updates/s) that are not the land's. Read with that subtracted:

| card, direction | land (series) | busy samples in window | style | layout | compositing walk | paint | script (completion) | what it is |
|---|---|---|---|---|---|---|---|---|
| `3dd62fc2` fold | 34+38 → 65 ms (finish) | 45 (~81 ms) | 3 | 3 | 10 | 10 | ~9 | the view slot leaving layout (`display: none` at `data-fold="settled"`): render-tree teardown, one repaint, intersection observers (7) |
| `3dd62fc2` unfold | 55+53 → 108 ms (finish) | 76 (~120 ms) | 36 | 37 | 3 | 17 | ~8 | **the view slot re-entering layout**: `resolveStyle` 25 + `RenderTreeUpdater::commit` 6 under one `updateLayout` — the transcript's list view built and laid out in the completion's frame |
| `d2d780b1` fold | 31+42 → 66 ms | 44 (~70 ms) | 3 | 3 | 6 | 9 | ~5 | as above |
| `d2d780b1` unfold | 45+53 → 99 ms | 73 (~116 ms) | 27 | 28 | 3 | 12 | ~10 | as above |
| `1f13d2ab` fold | 48+63 | 127 (~197 ms) | 71 | 52 | 13 | 21 | ~5 | two beats' completions plus the column's relayout |
| `1f13d2ab` unfold | 62+79 | 287 (~449 ms; window also holds a 195+48 second completion the `finish()` path produced) | 189 | 75 | 20 | 62 | ~3 | as above, larger; the plain series is the number to trust |

So the two frames at the land are two different things. The **fold's** land is cheap in style and layout and is spent tearing down and repainting — ~65 ms across four small terms. The **unfold's** land is a real relayout: the transcript view slot was taken out of layout at the settled fold (the `session-card.css` rule that makes the at-rest fold cost nothing) and comes back in the completion's commit, so the completion pays the list view's style, render tree and layout in one frame — 100–110 ms on a 1630 px card.

### The verdicts, against one frame each ([B04])

- **The commit frame does not clear its bar.** 137–335 ms against 17 ms: eight to twenty frames, on every card, both directions. It is made of two (three on a shared column) script-forced whole-page style/layout passes inside one task, and no shape of the motion can touch it because it is over before the motion begins. It is opened as a follow-on, below, with these numbers.
- **The land frame does not clear its bar.** 65–110 ms across two ticks against 17 ms: four to seven frames. It is two different costs by direction — teardown and repaint on the fold, the view slot's return on the unfold — and is opened with the same follow-on, because the unfold's half is the same kind of thing as the lead (a whole subtree's style and layout paid in one commit's frame) and the fold's half is under two frames by itself.
- **The walk's share did not fall, and could not have.** [B04] budgeted for the compositing walk being part of the lead; it is ~16 ms of a 150–300 ms lead. Step 6 read the lead unchanged under two shapes that cut the walk by two thirds, and these readings say the same thing from the other side: pause the motion at frame 0 and the lead is unchanged.

### Follow-on: the fold's commit, with numbers

What a follow-on arc would take on, and what it would have to read green:

1. **The store's synchronous `notify` under `_commitImposition` must not read geometry on a tree it just dirtied.** `discoverScrollers` under `beginResizeEpisode`, on every pane frame, after the rail-inset custom-property writes: ~80 ms on this deck. Either the reads move after the commit's style pass (a `requestAnimationFrame`, or the canvas's own settle arm which already runs after layout), or the resize episode's scrollers are discovered from the deck state rather than from `scrollHeight`. Bar: no `resolveStyle` under `discoverScrollers` in a lead-scoped sample.
2. **The transcript list view's layout effects read after they write.** The evict-attribute and scroll-state writes, then `clientHeight`/`scrollTop` reads, in consecutive effects on the same commit: ~30–50 ms. Bar: the `chains` verb reports no `clientHeight` chain rooted in the list view on a fold.
3. **The `paneFrames` offset sweep forces a whole-page layout on a column change.** ~120 ms on the shared-column card. Bar: no `Document::updateLayout` under `offsetLeft` in the lead.
4. **The unfold's land pays the view slot's return in one frame.** ~100 ms. The at-rest `display: none` is right ([F01] and the animation doctrine both want it); the question is whether the return can be staged — the slot shown before the motion's last frame so its layout lands under the tween rather than after it — or `content-visibility` can hold the box without the render tree. Bar: the unfold's land under two frames on a 1630 px card.

Success for all four is the same bar this arc set and could not meet: a session fold recorded on the user's release deck with leading dead time under one frame and no gap over one frame across the motion, both directions, three cards. The instrument to read it with — the `settle-frames` row with `commitDelayMs` and `gestureGapMs`, and `at0622`'s fold leg — is this arc's, and is red today for exactly the numbers above.

## At `b375ec05f` — the fold leg's first red

`tugarc/session-fold-frames`, worktree `.tug/worktrees/session-fold-frames`, working tree carrying the step-2 test changes. Instrument: `at0622-deck-settle-frames.test.ts`, the canvas's own `settle-frames` trace row and the bench probe, over `just app-test`. Display: derived period 17.00 ms.

The gesture is `set-card-folded` on `at0622-c1`, on the four-up **flow** fixture — one session card per slot, so the folding pane's own `height` is the only height term anywhere in the window.

### The fold, plain

| Field | Reading |
|---|---|
| `firstPaintDelayMs` | **31 ms** — the gesture to the first frame the deck rendered |
| `commitDelayMs` | **9 ms** — of that lead, spent before the canvas armed at all |
| `moveFirstPaintDelayMs` | **-1** — there is no transform-bearing effect in a fold |
| `longestGapMs` / `longestGapFrames` | 31 ms / **1.82 frames** — the lead *is* the worst gap |
| `gapsOverOneFrame` | 1 |
| `ticks` | 14 over 5 panes |
| `violations` | **`at0622-p1:height`** — one pane, the folding one |
| `offCurveTicks` / `pendingTicks` | 0 / 0 |

Bench probe over the wider window: 63 ticks, `longestGapMs` 32 ms / 1.88 frames, `firstPaintDelayMs` 9 ms from its own arm, `suspended: false`, `minOpacity` 1, `fixedDescendants` 0, same single `height` violation.

**The leg fails on the first clause:** a fold's first rendered frame must land within one display frame of the gesture, and 31 ms is nearly two. That is the arc's subject, stated as a number for the first time — before this the same row read `firstPaintDelayMs: -1`, because the field measured a move animation's clock and a fold runs no move.

The single `violations` entry is the second thing worth keeping. On the flow fixture the fold's `height` term is the *only* one in the window, which is what makes "no `height` on a session fold" a readable criterion later; on the eight-card shared-column fixture every member of a dividing column carries one and the fold's row and the division's standing row are the same row.

### What else the same run said

The file's four-up activation leg is red too, and it was red before this arc: `apptest_results` records 7 of 8 tests passing at `8e2acd79c` and in every run since, and 7 of 9 now — the same seven, plus the new fold leg. Its row reads `firstPaintDelayMs: 81`, `commitDelayMs: 0`, `longestGapMs: 81` over 23 ticks: the activation's own lead is its worst gap, on a gesture that leaves no stamp, so the 81 ms is arm-to-first-tick. Under [P01] that lead entered the gap series, which is why the number is the shape it is; the clause's bar was left at two frames rather than raised to admit it.

---

## Fix 1 — the resize episode stops reading geometry it just dirtied

`tugarc/session-fold-commit-frame`, at `686ffdab6`. The brief's first open question — *which write dirties the tree ahead of `discoverScrollers`'s first read* — settled by re-arming `tugtool deck motion chains` across one fold before anything was touched, exactly as [B06] asks.

### Before — the user's deck, `release-main`, folding `3dd62fc2` (1630 px)

```
$ tugtool deck motion chains --mode arm  --instance release-main
$ tugtool host tell set-card-folded -p cardId=3dd62fc2-… -p folded=true --instance release-main
$ tugtool deck motion chains --mode read --instance release-main
25 chains over 240 entries in 32 tasks
      9 chains  [clientHeight]
      read  eDe@…index-AO9eviac.js:2:93200            ← discoverScrollers
      read  QP@…index-AO9eviac.js:2:94785             ← beginResizeEpisode
      read  @…index-AO9eviac.js:324:46731             ← the canvas's store subscriber
      read  forEach / notify / _commitImposition
      write QP@…index-AO9eviac.js:2:95062             ← beginResizeEpisode, 277 bytes on
```

Nine chains, one per pane frame, and the top group of the whole fold — which is [F03] reproduced at this branch point, on the same card.

**The write is `beginResizeEpisode`'s own stamp, not the arm's.** [F03] attributed it to "the arm's own container property writes" and said so as an attribution rather than a reading; the reading says otherwise. The read and the write are in the *same function*, 277 bytes apart in the minified bundle, and the only write in `beginResizeEpisode` is its last line — `frame.setAttribute(RESIZE_EPISODE_ATTR, String(id))`. The geometry-chain probe counts `setAttribute` as a style-dirtying write on purpose (`geometry-chain-probe.ts`: "`setAttribute` covers the attribute-keyed rules the deck uses"), so the chain is: frame *n* reads → frame *n* stamps → frame *n+1* reads, nine deep, inside `_commitImposition`'s notify.

That matters for the shape of the fix. [B02] offered two roads — begin from the Last-pass layout effect, or discover without asking `scrollHeight` — and both were aimed at a write outside the episode. Neither would have helped: the write is inside, and moving the read anywhere leaves it interleaved with its own stamp.

### The fix

Two halves, and the second is the one the reading names.

- **The begins leave the write pass.** `deck-canvas.tsx`'s arm already splits measuring from writing, and says why in its own comment: a restored width "is a relayout, and a relayout between two frames' measurements is a First rect nobody saw". `beginResizeEpisode` had been sitting in the *write* pass, one frame at a time, interleaved with those restores. It now has a pass of its own between the two, with the measurements.
- **The stamp leaves the read.** `beginResizeEpisode` takes `{ deferStamp: true }` and returns a handle carrying `stamp()`; the canvas holds all nine stamps back and applies them together in the write pass. `tug-pane.tsx`'s two single-frame callers do not defer and are unchanged — one episode has nothing to interleave with.

The anchor contract is kept and slightly better kept: every episode now anchors against the same outgoing geometry — the pose the eye has, held by the cancel above — rather than against however many frames beside it had already been handed back, which the interleaved order could only get right for the first frame.

### After — `release-tugarc-session-fold-commit-frame`, nine pane frames, `set-imposition two-up`

```
38 chains over 821 entries in 122 tasks
     16 chains  [scrollTop]  applyRestoreTarget@…          ← the list view ([B03], fix 2)
     15 chains  [scrollTop]  applyRestoreTarget@…          ← the same
      3 chains  [scrollTop]  React commit
      1 chains  [clientHeight]
      1 chains  [offsetWidth]
```

**No chain rooted in `beginResizeEpisode`.** The group that was the fold's largest is absent from the report entirely — [B02]'s chain bar, met.

And met non-vacuously: watched through a `MutationObserver` on `data-resize-episode` across the same nine frames, the next arrangement change stamped **9 of 9**. The episodes are still raised, still bracket the gesture, and still wear the mark every test reads them by; only the moment the mark is written moved.

### What is still owed on this fix

Two things, and neither is a number this arc can take for itself.

- **The sampled half of [B02]'s bar** — "no `resolveStyle` under `discoverScrollers` in a lead-scoped sample" — is not recorded here. `/usr/bin/sample` against the arc build's WebContent process never returned a file; the previous arc's profiles were all of `release-main`, and whatever lets it attach there does not hold for a freshly signed per-worktree bundle. The chains reading is the instrument [B02] names first and it is decisive on the same claim; the sample is not reported as taken.
- **A series on the user's own deck.** The fix is a source reordering, so unlike the previous arc's shapes it cannot be switched on in a running `release-main` through the eval door — the user's deck reads it only after it is joined and relaunched. The before series above *is* from their deck; the after is theirs to confirm, which is what [B07] says acceptance is anyway. The card was unfolded and the probe disarmed when the before reading was over, so their deck was left as it was found.

---

## Fix 3 — the occlusion sweep stops forcing layout inside the commit

`tugarc/session-fold-commit-frame`, fix 1 already landed. [B04], at `pane-occlusion-controller.ts`.

### What the sweep was doing in the commit

The controller's synchronous `apply` pass runs in a `useLayoutEffect` keyed on the store snapshot, so it runs in **every** commit — including the one that arms a settle. It called `computeOccludedSet`, which reads `offsetLeft` / `offsetTop` / `offsetWidth` / `offsetHeight` on every shown pane frame, behind the writes React had just made. That is a forced whole-page layout, and [F05] measured it at ~120 ms on the shared-column card.

The pass exists for one guarantee: **a reveal is synchronous**, so the compositor never presents a frame with an exposed-but-hidden pane. That guarantee is what made the pass look unmovable.

### The fix

It is movable, because a reveal does not need to know *which* pane was exposed. Mid-motion — a gesture, or a settle — `apply` now reveals every stamped frame outright and arms the lazy pass, reading no geometry at all. Revealing a pane that is in fact still covered paints nothing: the coverer is opaque and above it. So the blanket answer sits on the conservative side of the one asymmetry the module guarantees — *a missed hide, never a hidden exposed pane* — and costs nothing to compute. The deck at rest still computes exactly as before.

What makes the branch reachable at the moment it is worth taking is that `data-imposer-settling` goes on in the canvas's **arm**, a store subscriber that runs ahead of React's render. It is already on the container when this effect runs in the very commit that launched the motion.

### The reading — `release-tugarc-session-fold-commit-frame`, nine pane frames, `set-imposition two-up`

The same instance, the same population and the same gesture as fix 1's after-reading, so the two are comparable line for line.

| | chains | entries | tasks | the occlusion group |
|---|---|---|---|---|
| fix 1 only | 38 | 821 | 122 | `1 chains [offsetWidth] read ide@…248:12285` |
| fix 1 + fix 3 | **12** | **217** | **5** | **absent** |

`ide` is `computeOccludedSet`: the bundle is built with `keepNames`, and it carries `a(ide,"computeOccludedSet")` verbatim, so the identity is read out of the shipped file rather than inferred from the stack's shape. [B04]'s bar in the form the chains verb can state it — no `offsetLeft`/`offsetWidth` chain rooted in the sweep — is met.

The sampled half of the bar is unrecorded for fix 1's reason: `/usr/bin/sample` does not attach to the per-worktree release build's WebContent process.

### What the reading cost to take, which is worth writing down

The first checkpoint run of this fix reported 0 of 4 files green and read as a disaster. It was not: `just app-release` **launches** its instance, and a Tug window standing in front of the app-test harness windows suspends their `requestAnimationFrame`. Re-run with the instance quit, `at0622`'s fold leg came back to 32 ms — its exact pre-arc baseline — and the four-up gap from 82 ms to 81. Live readings and app-tests do not share a machine.

`at0454-flow-mode.test.ts` survived that correction as the one red whose recorded history did not exonerate it, because it had not been run since 2026-09-26 and so pointed at this arc's own first commit. `tugtool file probe` answered it twice: with fix 3 reverted, and again with fix 1 and fix 3 both reverted, it failed identically — same three assertions, same numbers, same `flow: strip 2120px over a 2120px band`. The root failure is that the fixture's strip no longer overflows its band, which is a width fact, and neither fix touches a width.

---

## Fix 2 — the list view's attribute writes stop interleaving with its reads

[B03], at `tug-list-view.tsx`. Fixes 1 and 3 already landed.

### The write [F04] named is not the write the instrument names

[F04] attributed the interleave to the `data-evict-active` / `data-evict-fallbacks` pair, 15 + 13 chains. The chains verb disagrees, and the bundle settles it: in the reading taken after fixes 1 and 3, the single write site under every `applyRestoreTarget` chain is `235:45442`, and reading that offset out of the served bundle gives

```
…K.setAttribute("data-tug-scroll-state",JSON.stringify(ct))}),w.useLayoutEffect(()=>{se.current?.applyRestoreTarget()}),…
```

— the **anchor-state** writer, with the `applyRestoreTarget` effect declared immediately after it. The attribute lands between the anchor effect's own `scrollTop` / `scrollHeight` reads and the next effect's, which is the chain, and it is the largest group the list view contributes. The evict pair is real but smaller: it sits ahead of the pin effect, whose `clientHeight` read appeared as one chain at `235:40880`.

This is the same correction fix 1 made to [F03]: the brief named the write it believed was there, and the instrument names a different one. [B03]'s *decision* — the list view's attribute writes and its geometry reads do not interleave within a commit — is what was carried out, against the writes the probe actually reports: the anchor state, the evict pair, and the displacement counter.

### Two shapes, and why the second one is the fix

**First attempt: one flush effect per component, declared after the last geometry-reading effect.** It works within an instance — the `applyRestoreTarget` group disappeared entirely. But the pin-effect chains went from 1 to 6, and resolving the new write site gave the flush's own `setAttribute`. React runs every mounted component's layout effects in one pass, so on a deck showing seven lists, instance A's flush lands ahead of instance B's first read. A per-instance flush moves the chain rather than removing it.

**The fix is a module-level queue drained in a microtask.** One queue for the module; a microtask still runs inside the commit's own task, before the browser can paint, so the attributes land in the commit that computed them — and every list's writes land after every list's reads. Each queued closure captures its value where the effect that owed it ran, so what lands is that effect's answer.

### The readings — `release-tugarc-session-fold-commit-frame`, `set-imposition`

Population is stated with each, because it is what the entry counts scale with.

| build | population | gesture | chains | entries | tasks | the list view's own writes |
|---|---|---|---|---|---|---|
| fixes 1 + 3 | 9 frames | two-up | 12 | 217 | 5 | `applyRestoreTarget` ×5, from `data-tug-scroll-state` |
| + per-instance flush | 14 frames, 7 lists | two-up | 8 | 240 | 5 | pin ×6, from the flush itself |
| + module-level queue | 14 frames, 7 lists | two-up | **0** | **4** | **1** | **none** |
| + module-level queue | 14 frames, 7 lists | three-up | 15 | 1864 | 5 | **none** |

The last row is the honest one to read, because the two-up gesture arrived on a deck already in two-up and moved little. On the three-up commit — 1864 entries, the largest reading this arc has taken — chains are still rooted in the list view (the pin effect, and a render-phase `scrollTop` read), but **no chain's dirtying write comes from the list view any more.** Those writes are now React's own DOM mutations and, at `78:631076`, the focus system's `data-tug-focusable` / `data-tug-focus-key`. [B03]'s decision is met; what remains at that read site belongs to other writers.

### The bench

`at0622`'s session-fold leg moved for the first time in this arc: `firstPaintDelayMs` **32 ms → 22 ms** with the per-instance flush and **25 ms** with the module-level queue, against the 32 ms the same leg read at the branch point and on both earlier steps. `commitDelayMs` went 11–12 ms → 8 ms. The leg is still over its one-frame bar, and the two figures bracket the noise on this sub-case rather than distinguishing the two shapes.

Nine of ten files green in the checkpoint, and the nine include every test that reads a deferred attribute — `at0061` (the save bag's capture), `at0330` and `at0335` and `at0387` and `at0494` (the eviction and displacement probes), `at0189`, `at0333`, `at0632`, `at0083`. Holding the writes to a microtask changes nothing any reader sees.

`at0626-sash-drag-sampler.test.ts` came up red and is not this arc's: its render-cost gauge takes 3 samples inside the hold where the test asks for more than 8, because `cost()` now ends with `await sampleRest()` and that window is a fixed 1000 ms. At the file's last green, `cost()` was a bare two-frame burst; `sampleRest` was added to it afterwards, and `git diff` over `tugdeck/src/lib/motion-guard/` from this arc's base is empty.

---

## Fix 4 — the unfold's view slot, read three ways, and the code left where it stands

[B05], at `session-card.tsx` and `session-card.css`. Fixes 1, 3 and 2 already landed. Every reading here is on the user's own deck — `release-main`, `display 3200x1800 @2x` — folding and unfolding `3dd62fc2` at 1630 px, the same card [F06] was taken on. The at-rest shape was switched by injecting one stylesheet through the eval door rather than by rebuilding, so all three readings are the same build, the same deck and the same card, minutes apart.

### The state [B05] asks for is the state the code is already in

[F06] reads `session-card.tsx:2577` as removing `data-fold` on the unfold's land, and puts the list view's style, render tree and layout in the completion's frame on the strength of it. The effect does remove the attribute at the land — but the unfold's **first** frame has already written `data-fold="moving"` over the `"settled"` that was there, and the slot's `display: none` is keyed on `"settled"` alone. A `MutationObserver` on the card root and the frame, with a rAF chain reading the slot's computed `display` and box on every tick, says it directly:

| rAF | t | `data-fold` | slot `display` | slot height | pane height |
|---|---|---|---|---|---|
| 2 | 5 ms | `settled` | `none` | 0 | 145 |
| — | 95 ms | `moving`, with `data-folded` and `data-fold-crossing` in the same commit | — | — | — |
| 3 | 105 ms | `moving` | `flex` | 1271 | 173 |
| 16 | 324 ms | `moving` | `flex` | 1271 | 1625 |
| 17 | 367 ms | absent — the crossing ends | `flex` | 1271 | 1630 |

The slot is back in layout at its full open height in the first frame the reader sees the card move. That is what [B05] asks for, and it is the third time in this arc that a brief named a write the instrument disagrees with ([F03], [F04], now [F06]).

### The three shapes, measured

`gesture gap` is the bracketed number the procedure's `read` prints: the gap the fold's own stamp landed in. The land's gap is the later one in the same series, at the tick where `data-fold-crossing` comes off.

| at-rest shape | the slot re-enters layout | unfold lead (gesture gap) | the land's own gap |
|---|---|---|---|
| `display: none` — shipped | the motion's first frame | 111, 122, 222 ms | 66 ms |
| `content-visibility: hidden` at rest — [B05]'s fallback | the motion's first frame | 121, 131, 132, 137 ms | 66 ms, and a second gap of 86 ms |
| `display: none` held through `data-fold="moving"` | the land | 98, 100, 104 ms | 76, 77, 78 ms |

The fallback's at-rest geometry is byte-for-byte the shipped one — folded pane 145 px, card 54 px, slot 0 px, Z2's top at 95 px, measured under both shapes while folded — so `contain-intrinsic-size: auto 0px` under a `flex: 0 0 auto` column really does collapse the way `display: none` does. What it does not do is read better: four samples from 121 to 137 ms against a shipped 111/122, with the shipped shape's one 222 ms sample the only reading on either side that looks like an outlier.

The third row is the isolating probe, and it is what settles [B05]'s open question. Holding the slot out of layout for the whole crossing moves its return to the land: the lead drops to ~100 ms and the land's gap rises from 66 to ~77 ms. So the slot's return is worth **15–20 ms of a frame**, wherever it is paid — not the ~100 ms [F06] put on it, which was the whole land frame — and the two placements are a wash within the lead's own spread.

### The verdict: no change at `session-card.tsx` or `session-card.css`

[B05]'s primary change is the code's existing behavior, confirmed live rather than inferred. Its fallback is not taken, because the reading it was conditioned on says the fallback costs 10–20 ms of lead and buys nothing at rest. And the alternative the probe measured — the late return — trades 15–20 ms of lead for 10 ms of land and is not worth a change either.

What the same readings say about where the unfold's frames actually are, which is worth more than the fix that was not needed: **90 ms passes between the last quiet rAF and the commit that writes `data-folded`, `data-fold="moving"` and `data-fold-crossing` together** — the commit frame fixes 1, 2 and 3 attack, still 90 ms on this card with all three landed — and 40 to 66 ms goes at the land, in the frame where the crossing ends and the still crossing's held height is released. Neither of those is the view slot, and the second belongs to the imposer rather than to the card.

---

## What the four fixes cost, and what the bench still says

The four fixes cost four source files, one `@covers` line and no new machinery: a deferred `data-resize-episode` stamp with the episode arm split into a reads pass and a writes pass (`resize-episode.ts`, `deck-canvas.tsx`), a mid-settle short circuit ahead of the occlusion sweep's first geometry read (`pane-occlusion-controller.ts`), one module-level queue draining the list view's instrumentation attributes in a microtask (`tug-list-view.tsx`), and for fix 4 nothing at all, because the state [B05] asked for turned out to be the state the code was already in. Each fix's own bar is met, and the `chains` verb is what says so: no group rooted in `beginResizeEpisode` on a fold, no `offsetWidth` group after the occlusion branch, and on the largest reading this arc took — 1864 entries over a three-up commit with fourteen frames and seven lists — no chain whose dirtying write the list view authored. What the same readings do not show is the frames coming back. `at0622`'s fold leg read 31–34 ms of lead at the branch point, 22–25 ms in the checkpoint after fix 2, and **34 ms again on a lone re-run of the finished tree** — 13 ms of it spent before the canvas arms at all — against a bar of one display frame; so the leg is still red, the four-up leg with it, and the 22–25 ms pair has to be read as this sub-case's spread rather than as movement. The live deck agrees and locates what is left: on the user's own 1630 px card the unfold shows 90 ms between the last quiet frame and the commit that marks the crossing, and 40–66 ms at the land, neither of which is script-forced style work of the kind the three fixes removed. The thing worth carrying past this arc is not a fix at all: the brief named the *write* that dirties the tree three times ([F03], [F04], [F06]) and was wrong all three times, and every correction came from resolving the probe's own `line:col` out of the served bundle rather than from reading the source the brief cited. What remains for the user is the acceptance [B07] names and nothing this paper can stand in for — ⌃⌘Y on a session card, watching for a cut — and what remains on the bench is a lead nobody has yet opened up frame by frame, starting with the 13 ms that passes before the settle arms.
