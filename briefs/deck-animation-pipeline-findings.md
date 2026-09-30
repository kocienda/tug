# The deck's settle: what the sampler measured before anything was rebuilt

**2026-09-24.** Release build, one machine, `at0622-deck-settle-frames.test.ts` driving `tugdeck/src/lib/settle-frame-probe.ts`.

This paper is the recording the brief's `[B09]` asks for: the deck's settle measured as it stands, and then measured again with each of `[F03]`–`[F07]` removed in turn, so the rules of `[B01]`–`[B07]` are held to what the deck actually costs rather than to what reading the code suggested it should. The 2026-09-18 drop fix was "verified" green without a sampler and had not fixed anything; this is the step that does not repeat that.

**The headline is a negative, and it is the most useful thing here: no single one of `[F03]`–`[F07]`, removed on its own, measurably narrows the hole.** The hole is real, it is the gesture's, and it grows with the card count — but it does not have one owner that the instrument can name.

Landing the standing promotion for real, later, said the same thing a second time and added one answer: it costs nothing measurable either, on a transform-only slide or on a height-bearing gesture at eight cards. See [The standing promotion, measured](#the-standing-promotion-measured).

---

## Method

Held to `[D5]` throughout.

- **Release build only.** Every reading is taken after `just app-test-build`, including inside every probe, so the patched CSS and TypeScript actually reach the running app rather than sitting in a source tree the bundle was not rebuilt from.
- **The forcing probe runs on every single run.** `at0622`'s forced leg plants a deliberate 200ms task inside the settle window and asserts the reading notices. It did, on every run recorded below. A sampler that has silently stopped observing and a deck that has genuinely stopped dropping frames produce the same zeros; nothing below is offered as evidence without that leg having passed alongside it.
- **An idle control, in the same app instance, at the same window length, with no gesture in it.** This was added after the first probe run and is the single most important thing in this paper. Without it `longestGapMs` is a number about the *sampled window* — harness round trips, a session card still mounting, a stray compositor stall — rather than about the settle, and every attribution built on it is unfalsifiable.
- **×3 runs and medians** for the reference baseline; **an interleaved single-run sentinel baseline after every probe**, so a machine that drifted mid-session is visible rather than attributed. It did drift, and the sentinels are what showed it.
- **Every probe was verified to have reached the built bundle.** A probe that silently does nothing reads identically to one that costs nothing, so each patch was applied, rebuilt, and the emitted asset inspected for the change. See [Proof the probes were live](#proof-the-probes-were-live).
- Every probe ran under `tugtool file probe`, which restores the bytes and **advances the mtime**. That is correct and is the reason to use it: a hand-rolled revert would leave source files reading older than the artifacts built from them, which is the one staleness direction cargo and vite cannot see, and the next build would print success having compiled nothing.

---

## The baseline

Medians of three runs, at a derived frame period of **17ms** (the probe reads the display's period off the run's own quiet ticks rather than assuming 60Hz; it read 17ms on every run but two, which read 16 and 16.5).

| | idle control | activation | the gesture's own cost |
|---|---|---|---|
| four session cards | **33ms** (1.9 frames) | **84ms** (4.9 frames) | **+51ms** (~3 frames) |
| eight session cards | **27ms** (1.6 frames) | **98ms** (5.8 frames) | **+71ms** (~4.2 frames) |

Raw, in run order — four-up idle / four-up activation / eight-up idle / eight-up activation, in ms:

```
run 1   29 / 92 / 27 / 96
run 2   34 / 75 / 35 / 98
run 3   33 / 84 / 19 / 107
```

Three things follow, and they are the load-bearing ones.

**The hole is the gesture's.** An idle window of the same length on the same deck costs about two frames of worst gap; the activation costs five to six. The difference is not the harness, not the app launch, and not the session cards mounting — those are all in the control too.

**It scales with the card count.** Four cards cost +51ms over idle, eight cost +71ms. That is the signature `[F03]` and `[F04]` predict for a cost proportional to how much has to be rasterized, and it is why the eight-card leg exists.

**The run-to-run spread is wide enough to matter.** Four-up activation ranged 75–99ms across the reference and sentinel runs; eight-up ranged 92–120ms. Call it **±25ms of noise on a 51–71ms signal**. Nothing below moves by more than that, and that fact is as much a finding about the instrument's resolution as about the deck.

---

## The attribution

Each suspect was removed by patch, the app rebuilt, the sampler run, the bytes restored, and a no-probe sentinel baseline run immediately afterwards. Each probe is compared against **its own neighbouring sentinel**, not against the reference baseline, because the machine drifted upward during the session — the eight-up sentinel median rose from 98ms to 114ms over the run of probes, with nothing changed.

| suspect | what the patch did | four-up: probe / sentinel | eight-up: probe / sentinel | verdict |
|---|---|---|---|---|
| `[F03]` frames are not layers at rest | `will-change: transform` added to `.tug-pane` | 96 / 89 (**+7**) | 106 / 114 (**−8**) | **no measurable contribution** |
| `[F04]` the recede transitions two blended overlays | both `.tug-pane-chrome` pseudo transitions → `none` | 91 / 95 (**−4**) | 104 / 104 (**0**) | **no measurable contribution** |
| `[F05]` the flash is a 1750ms `box-shadow` animation | `.tug-pane-flash::before` animation → `none` | 105 / 99 (**+6**) | 119 / 120 (**−1**) | **no measurable contribution** |
| `[F07]` transcript cells opt into `content-visibility: auto` | `content-visibility: visible` on the skip rule | 82 / 93 (**−11**) | 114 / 116 (**−2**) | **no measurable contribution** |
| `[F06]` the click task does layout reads per pane | `arm`'s `beginResizeEpisode` raise made a no-op | 79 / 90 (**−11**) | 115 / 110 (**+5**) | **no measurable contribution** |

Every delta in that table is inside the ±25ms of run-to-run noise the baseline established. The two largest — `[F07]` and `[F06]`, each −11ms on the four-card leg — are under half the noise spread and neither reproduces on the eight-card leg, which is the leg where a cost proportional to card count should show *more* strongly rather than less. They are not evidence.

**Stated plainly, as the step asks:** `[F03]`, `[F04]`, `[F05]`, `[F06]` and `[F07]` each have **no measurable contribution** to the settle's frame gap at this instrument's resolution. Not one of them was ruled in. A suspect ruled out by measurement is as much of a finding as one confirmed, and none of them was confirmed.

---

## What this does and does not license

**The rules of `[B01]`–`[B07]` stand.** `[B09]` says so in advance and it is worth repeating with the numbers in hand: the brief's design is a pipeline in which none of these things *can* happen, and that goal does not depend on which of them currently *does*. A standing layer, an opacity-only recede, a compositor-only flash, a bounded click task and held cell relevance are each defensible on their own terms — as invariants that make a class of defect unreachable — and this paper does not weaken any of them.

**What it does change is what the arc may claim.** No step of this arc may say it removed a measured cost attributable to the suspect it addressed, because no such attribution exists. The honest claim for each is that it closes a door, and Step 9's bar is what says whether the pipeline as a whole arrived.

**Three readings of the negative are open**, and this paper does not choose between them:

1. **The cost is the sum of several small contributions**, each around 10–15ms and each individually under the noise floor. This fits the data: a handful of −11 and −8 deltas that do not reproduce, on a total of 51–71ms. If so, the brief's design is right and only the *attribution* was ever going to be impossible — removing one of six causes of a six-part cost is not visible.
2. **The cost is something none of the five names.** The one thing no probe here removed is the commit itself: the React re-render and the style and layout the strip's whole `calc()` geometry resolves through when `--tug-imposer-flow-offset` moves. That is the obvious remaining candidate and it is not in `[F03]`–`[F07]`.
3. **The instrument is too coarse.** ±25ms of noise on a ~60ms signal cannot separate 15ms contributions, and no number of repeats of *this* measurement fixes that — it needs a reading that says *where in the window* the gap fell, which the current probe does not record.

Reading 3 is actionable and is recorded as a defect below.

---

## Defects in the instrument, found by using it

These matter more than the table above, because Step 8 asserts over two of these fields.

**`violations` is a false negative and cannot currently see `[F04]` or `[F05]`.** It read `[]` on every run, including the runs where the flash and the recede transitions were provably running. The reason is the read: `sampleSettleFrame` calls `frame.getAnimations({ subtree: false })`, which returns animations targeting *the element itself* and not animations on its **pseudo-elements**. `[F04]`'s transitions are on `.tug-pane-chrome::before` and `::after`; `[F05]`'s flash is on `.tug-pane-flash::before`. Every paint-property animation the brief names is on a pseudo-element, and the field built to find them is blind to all of them. `{ subtree: true }` would see them and would also sweep every animation inside a card's body, which `[P08]` deliberately excludes — so the fix is a scoped read (the frame, plus its own pseudo-elements, plus the chrome's), and it is Step 8's to make. **Step 8 must not land its guard over this field as it stands: it would pass green over exactly the defect it exists to forbid.**

**`firstPaintDelayMs` cannot see a stall that lands before the move is first observed.** It read `0` on every activation and `-1` on every idle run (no move animation existed, which is the control behaving correctly). But its definition — the distance from the first tick at which the move animation exists to the first tick at which its clock has advanced — is structurally unable to catch `[F06]`'s shape: a long click task creates the animation and then holds the thread, so the first tick that *observes* the animation already sees its clock advanced, and the delay reads zero. The cost lands in `longestGapMs` instead. `firstPaintDelayMs: 0` is therefore not evidence that the tween started on time, and Spec S02's `firstPaintDelayMs <= framePeriodMs` clause is close to vacuous as the field is currently derived.

**The reading says nothing about *where* in the window the gap fell.** This is the gap that made the attribution impossible rather than merely negative. A gap at the first frame of the move and a gap 300ms after the landing are the same number today. Recording the longest gap's offset from the move animation's start would separate "the raster hole `[F08]` describes" from "something else in the sampled second", and would let a 15ms contribution be seen against a background that no longer includes the other 45ms.

---

## `fixedDescendants` — R01's runtime half

**Zero on every run**, four-up and eight-up, idle and activating. No element computing `position: fixed` lives under a shown pane frame on this fixture.

This is good news for Step 3 and it is narrow news. The fixture is session cards with nothing open — no alert, no banner, no completion menu, no popover, no sheet. It says the frames are clean at rest; it says nothing about the surfaces `[F10]` names at the moment one of them is *showing*, which is the only moment they exist. Step 3's inventory is still the work, and the runtime sweep should be re-run with one of each open before `[B02]`'s guard is trusted.

### What the static inventory then found

Read afterwards, against the code rather than the running deck: **nothing needed re-homing.** Every `position: fixed` declaration in `tugdeck/src` and `tugdeck/styles` is either outside every frame already or is a frame's sibling.

- The six `.tug-key-sink` hosts the brief asked to be confirmed are all outside. Five — `tug-alert.tsx`, `tug-modal-input-dialog.tsx`, `configure-tug.tsx`, `tug-version-gate.tsx`, `update-tug.tsx` — render their sink inside a Radix `Portal container={overlayRoot}`, so the sink is a child of the canvas overlay root. The sixth, `responder-chain-provider.tsx`, renders its sink beside `{children}`, and the provider is composed once at the React root in `deck-manager.ts`, so that sink is at app root.
- `tug-sheet.css` declares no `position: fixed` at all — every piece of the sheet is `absolute` or `relative`. The sheet stays portaled into the frame, which is its contract, and needs no change to keep it.
- `tug-popover.tsx`, `tug-tooltip.tsx` and `tug-combo-box.tsx` all portal to the overlay root and all measure their anchors with `getBoundingClientRect`. None of the four anchor-computing modules the brief named uses `offsetTop`, `offsetLeft` or `offsetParent` anywhere, so none is of the kind that reads a position against the frame.
- `.tug-pane-exit-ghost` is `position: fixed` and is correct: `deck-canvas.tsx` appends it to the frames **container**, a sibling of every frame.

So `[P03]`'s prediction holds in its strongest form — every viewport-positioned surface is already outside the frames, and the inventory names none that is not. The guard that landed alongside this is therefore a tripwire against a future addition rather than a fix for a present defect, which is what it should be.

**The open-surface runtime sweep is still outstanding** and is not closed by the above. The static read covers every surface that *declares* `position: fixed` in CSS; it cannot cover one set from JavaScript, which is R01's whole point, and the sampler has still only swept a deck with nothing open. Driving a modal or a popover open inside the fixture needs a test-surface door that does not exist, so it is recorded here rather than done.

---

## Proof the probes were live

`[D5]` again: a driver that silently does nothing and a change that genuinely costs nothing produce the same reading. Each patch was applied under `file probe`, the app rebuilt inside the probe, and the emitted bundle inspected.

| suspect | what was checked in the built bundle | unpatched | patched |
|---|---|---|---|
| `[F03]` | the `.tug-pane` rule body | `.tug-pane{--tugx-pane-chrome-height: var(--tug-chrome-height)}` | `.tug-pane{--tugx-pane-chrome-height: var(--tug-chrome-height);will-change:transform}` |
| `[F04]` | the `mix-blend-mode:saturation` rule's transition | `transition:opacity var(--tugx-imposer-settle-duration, .3s) ease-out` | `transition:none` |
| `[F05]` | occurrences of `animation:tug-pane-border-flash` | 1 | 0 |
| `[F07]` | occurrences of `content-visibility:visible` | 1 | 2 |
| `[F06]` | md5 of the emitted `index-*.js` | `a9a2201f53482d68f125210c50b4c752` | `c894619a436404995ee19d85cb38537d` |

`[F06]` has no source-level marker that survives minification — `beginResizeEpisode` has three other callers in `tug-pane.tsx` and so is never tree-shaken — so the check there is that the emitted JavaScript differs, which proves the patch was in the tree the bundler read.

A first attempt at this verification used `grep -c`, which counts matching *lines*; the bundled CSS is one line, so every check returned `1` and distinguished nothing. `will-change:transform` already occurs eleven times in the unpatched bundle and `content-visibility:visible` once, so that first pass would have "confirmed" a patch that had not applied. The table above counts occurrences and reads rule bodies.

---

## What Step 3 onward should carry from this

- The gesture costs **51ms over idle at four cards and 71ms at eight**, and that is the number the arc is trying to remove. It is not an inference; the idle control is in the same window on the same deck.
- **No single suspect owns it.** Do not write a step's commit message, or the arc's join message, as though one did.
- **Fix `violations` before Step 8 asserts over it**, or the guard is green over the defect it forbids.
- **Record the longest gap's offset from the move's start**, or Step 9's bar will be able to say whether the pipeline arrived but never why it did not.
- The runtime `fixedDescendants` sweep is clean at rest and has not yet been run with an alert, a popover, a completion menu or a sheet open, which is the only state in which `[F10]`'s surfaces exist.

---

## The standing promotion, measured

`.tug-pane` now carries a standing `will-change: transform`, so every frame is a compositor layer from mount rather than from the first frame of a tween. This section is what that bought, taken the same way as everything above — release build, an idle control in the same window, medians of three.

### It did not narrow the gap

| | idle control | activation | the gesture's own cost | Step 2's cost |
|---|---|---|---|---|
| four session cards | 32ms | 89ms | **+57ms** | +51ms |
| eight session cards | 38ms | 110ms | **+72ms** | +71ms |

Raw, in run order — four-up idle / four-up activation / eight-up idle / eight-up activation, in ms:

```
run 1   29 / 103 / 38 / 110
run 2   32 /  81 / 31 / 109
run 3   35 /  89 / 40 / 117
```

Both figures are where Step 2 left them, inside the ±25ms spread. This is the same answer Step 2's `[F03]` probe gave — that probe *was* this change, applied temporarily and measured the same way — and the confirmation is worth having: the reading did not depend on the probe being temporary.

**So the promotion is not the cure**, and no later step or join message may say it was. It stands because `[B01]` is a rule about what the pipeline permits rather than a claim about what it currently costs: a gesture that cannot create or destroy a layer cannot suffer a promotion spike, whether or not one is measurable today.

### `[Q01]`, second reading: the height-bearing gesture

The activation gesture is transform-only, so it cannot price a promotion's population cost — the doctrine's warning is that `will-change` buys nothing against the style-recalc walk while hinted layers still add to the mounted population the walk's price scales with, and a `height` term stays on the main thread. A promotion that is free on a flow slide and expensive on a fold belongs on `[P04]`'s gesture-scoped fallback, and only a height-bearing reading can say which it is.

`at0622` gained a third fixture for it: eight session cards as **four shared columns of two**, driven through `set-column-mode` to `split` — every column divides, so every frame animates `height` — and then back to `stack`.

| | promoted | promotion reverted | delta |
|---|---|---|---|
| idle control | 36ms | 43ms | −7ms |
| split (height-bearing) | **57ms** | 55ms | **+2ms** |
| stack (height-bearing) | **33ms** | 29ms | **+4ms** |

**The standing promotion costs nothing measurable on a height-bearing gesture at eight session cards.** +2ms and +4ms are a fraction of the ±25ms spread, and the split's whole cost over idle is +21ms — less than half what the transform-only activation costs on the same deck. `[P04]`'s fallback is therefore **not** taken: the promotion stays standing, unconditional, from mount.

The reading is also self-verifying in a way the earlier ones were not. `violations` names `at0622-p2:height` and its three siblings on the split, and seven frames on the stack, which is the reading proving the gesture really did carry the main-thread term it was chosen for. It is the first non-empty `violations` anywhere in this arc, and it confirms the Step 2 defect note is precisely scoped: the field sees animations on the **frame element** perfectly well, and is blind only to the **pseudo-element** animations `[F04]` and `[F05]` live on.

`firstPaintDelayMs` also reported non-zero for the first time — 78ms promoted, 80ms reverted, on the split. The height tween existed for roughly five frames before its clock advanced. That is the field working as designed on a gesture whose animation is created well before its first rendering opportunity, and it does not soften Step 2's finding that the field cannot catch a stall landing before the animation is first observed.

### `[Q01]`, first reading: NOT TAKEN

The memory half — what four and eight standing Retina-scale layers cost, and whether the engine keeps each layer stable at rest or drops and re-creates it — **was not measured**, and it is recorded as untaken rather than estimated.

Three things block it, and none is a matter of effort:

- WebKit exposes no layer tree and no per-process memory to the page. There is no JavaScript surface for either question, so the sampler cannot reach it the way it reaches everything else in this paper.
- The engine's rendering work happens in `com.apple.WebKit.GPU` and `com.apple.WebKit.WebContent` XPC services, which are not children of the app and whose `ps` arguments carry no client identifier. There is no way to tell the harness's processes from any other WebKit client's on the machine.
- Attributing by "PID that appeared during the run" was tried and is unsound here: a sample taken that way caught twenty-six new WebKit processes, and the run being sampled had not started at all — it was queued behind another session's app-tests on the machine-wide gate.

What would make it takeable is a machine with no other WebKit client running and a Safari Web Inspector layer-tree read against the harness's own view, which is a person's observation rather than something a test can drive — which is what (#test-non-goals) says about this reading in the first place.

**It does not block the decision.** `[Q01]` exists to say whether the standing promotion is affordable, and the second reading answers that directly on the gesture the doctrine named as the one that would expose the cost. The memory question stays open, and the honest form of "open" is this paragraph rather than a number nobody can check.

### What the promotion costs, which no timing reading could see

The frame-gap sampler says the standing promotion costs nothing. **One existing pin says it costs something a timing reading cannot express**, and the finding is repeated-run evidence rather than a single comparison — which matters, because the first pass at this section was written from single runs and got it wrong in both directions.

`at0566` holds that no top inside a card moves more than 1.5px relative to its frame during the move beat. Run repeatedly, one file at a time:

| tree | green | red |
|---|---|---|
| promotion reverted | **4** | 0 |
| `will-change: transform` | 1 | **3** |
| `transform: translateZ(0)` | 2 | **2** |

The failures are 1.7px, 2.1px, 2.6px, 2.7px, 3.6px, 3.7px — **one or two device pixels at 2×, on a single sampled frame**, essentially always at a beat boundary. The series is otherwise a flat constant: a typical run reads `-347.00` on every frame with one sample at `-346.62` or `-347.98`. It is a one-frame seam where the frame's box and its transcript's box disagree, not a drift and not a shear.

**No spelling of a standing layer avoids it.** `translateZ(0)` — the alternative `[Q01]` names, on the theory that some engines treat a real transform as a more stable layer than a hint they may drop and re-create — halves the failure rate and does not remove it. The conflict is with *being a compositor layer*, not with how the layer is asked for, so it is a cost of `[B01]` itself.

**This is left open rather than answered, and the pin is left alone.** `at0566`'s bar was set by another decision, and an arc does not re-point another decision's test to match its own change — which is the whole reason this is written down instead of being made to go away. The judgment it needs is whether a one-frame, two-device-pixel seam at a beat boundary is a defect or is under the noise floor a 1.5px spread bar was meant to sit above; that bar was written when no frame was ever a layer at rest, and `[B01]` changes the premise it was chosen under.

### Two corrections to this paper's own method

Both are the same mistake and both were caught by repeating a measurement that had been taken once.

**`at0605` is not this arc's.** It was reported here as a promotion regression on the strength of one green run with the promotion reverted. Repeated, it fails about two runs in three **either way** — 3 red of 4 promoted, 2 red of 3 reverted — with the same one-frame outlier signature (`-2.40`, `2.49`, `-2.16`). It is a pre-existing intermittent and is recorded as one in the arc's `baseline.md`. Nothing in this arc caused it and no later step should treat it as a signal.

**`[B07]`'s relevance freeze does not fix `at0566`, and was removed.** It was added in this step and justified here by a three-way single-run comparison — promoted red, promoted-with-`content-visibility: visible` green, unpromoted green. Repeated, the middle reading does not hold: with the freeze in place `at0566` is still 3 red of 4. The freeze was reverted, and `[B07]` is left to the step that owns it, with its own design and its own verification.

The lesson is the one this paper already states about the deck and failed to apply to itself: **a single run proves nothing**, and that is as true of a revert used to attribute a failure as it is of a probe used to attribute a cost.


## The recede, rebuilt and measured

The three recede layers — the two blended pseudo-elements on `.tug-pane-chrome` and the frame dim on `.tug-pane::after` — now exist on every frame, change only by `opacity`, and change at the settle's landing rather than during it. Taken the same way as everything above: release build, an idle control in the same window, medians of three.

### It did not narrow the gap either

| | idle control | activation | the gesture's own cost | Step 4's cost | Step 2's cost |
|---|---|---|---|---|---|
| four session cards | 23ms | 94ms | **+71ms** | +57ms | +51ms |
| eight session cards | 33ms | 113ms | **+80ms** | +72ms | +71ms |

Raw, in run order — four-up idle / four-up activation / eight-up idle / eight-up activation, in ms:

```
run 1   28 /  94 / 34 / 125
run 2   23 /  84 / 33 / 113
run 3   19 /  95 / 32 /  93
```

The four-up activation spans 84–95 across three runs and the eight-up spans 93–125, which is the ±25ms band every reading in this paper has sat in. The medians move by less than one configuration's own spread, so the honest statement is **no measurable change**, in either direction. It is the same answer `[F04]`'s Step 2 probe gave when the two overlay transitions were set to `none`, and the confirmation is again worth having: the reading did not depend on the probe being temporary.

**So the recede was never the hole**, and no later step or join message may say it was. It is rebuilt because `[B03]` is a rule about what the pipeline permits — a settle during which nothing animates a paint property, and during which no layer is created or destroyed — and the old shape broke that rule three times over whether or not a stopwatch could see it.

### `[Q02]` is answered: the blend is not the cost

`[Q02]` asked whether a `mix-blend-mode` layer's opacity can be composited without re-rasterizing the blended content, and `[B04]` rests on the answer. The instrument is the one the plan named: `tugtool file probe` with both blend layers set to `mix-blend-mode: normal`, everything else untouched, so the only thing removed is the blend.

| | idle control | activation | the gesture's own cost | blend in place |
|---|---|---|---|---|
| four session cards | 21ms | 93ms | **+72ms** | +71ms |
| eight session cards | 22ms | 104ms | **+81ms** | +80ms |

Raw, two runs: four-up `22 / 99`, `19 / 86`; eight-up `23 / 114`, `21 / 93`.

A gap that survives the opacity rewrite and **vanishes** under this probe would have said the blend cannot be composited. It does not vanish; it does not move at all. So `[P05]`'s precomposed-snapshot fallback is **not taken**, the two blended pseudo-elements stay, and `[Q02]` closes on a measurement rather than on an assumption.

The at-rest half of `[Q02]` — whether a transparent blend layer on the *focused* frame, which carried no such pseudo at all before this step, is free — has no separate reading, and the reason is `[Q01]`'s: the memory instrument that half needed was never obtainable (see *`[Q01]`, first reading: NOT TAKEN*). What can be said is what the idle control says: with the layers now on nine frames instead of eight, the four-up idle median fell from Step 4's 32ms to 23ms and the eight-up from 38ms to 33ms. That is noise rather than an improvement, but it is not the rise a costly at-rest blend would have produced.

### The patch reached the bundle

Verified by **occurrence count**, not `grep -c`, for the reason recorded above — the built stylesheet is one line, so a line count answers `1` for everything. Under the probe the bundle carries `mix-blend-mode:normal` twice and `mix-blend-mode:saturation` zero times; restored, it carries `saturation` once. The rebuilt unpatched bundle carries `data-receded` five times and `data-recede-armed` three times, which is the five value rules and the three arm selectors this step wrote.

### What the census found, and why it is evidence

`[D6]` is the reason the fade is armed rather than standing: WebKit keeps a finished `CSSTransition` in `getAnimations()` forever unless the rest state drops it, and these layers are now on *every* frame, so a standing transition would be three retained effects per pane on a settled deck — a quiet-contract break that grows with card count, which is the one thing this arc's purpose forbids. `at0622` reports the census at eight cards:

| | frames | reader's frame | frames missing a layer | armed | retained opacity transitions |
|---|---|---|---|---|---|
| at rest, before the gesture | 9 | 1 | **0** | no | **0** |
| caught 60ms after the landing | 9 | 1 | 0 | **yes** | **6** |
| at rest, after the gesture | 9 | 1 | 0 | no | **0** |

The middle row is the point, and it is `[D5]` applied to a census: a count of zero over a recede that never ran is indistinguishable from a count of zero over a recede that ran and dropped itself. Six is exactly right — three layers each on the frame the reader left and the frame it arrived in — and the computed wash opacities in that same reading are mid-flight values (`0.0247` rising, `0.0494` falling, against a rest value of `0.074`), so the fade was genuinely in progress on `opacity` when the census counted it. The zero on either side is therefore evidence.

The wash's rest value of `0.074` is the arithmetic this step's token change rests on: the two depths used to be two colours at alpha 50 and 680, and are now one colour at alpha 680 with opacity `0.074` and `1`. `0.05 = 0.68 × 0.074`, so the pixel is unchanged and only the animated property moved.

### One pin was narrowed, and what the narrowing was allowed to say

`at0294`'s "a bare raise arms nothing" went red on this step, and the reading is worth stating because it is the shape an arc most often gets wrong. Its census is `document.getAnimations()` filtered to effects whose `target` carries `.tug-pane`. A pseudo-element effect reports the ORIGINATING element as its target, so the new fade on `.tug-pane::after` arrived in that census wearing the frame's identity while animating nothing about the frame. Before this step that pseudo carried no transition at all — it was a hard cut on a paint property, which is the defect this step removed — so the census had never had to distinguish the two.

The census was narrowed to skip pseudo-element effects. What that is **not** is a relaxation of `at0294`'s claim: the claim is that a bare raise arms no settle, its other half (`settling === false`) is untouched, the transform-only assertion on the same census still runs, and the recede's own fade is asserted on its own terms in `at0622`'s census above — including the mid-fade leg that proves a zero there is evidence. A helper whose docstring said "on a pane frame" now measures the frame rather than anything that merely reports the frame's name.

`at0566` was re-measured after this step and is unchanged: 3 green of 4, worst 1.70 against its 1.5 bar, the same one-frame sub-two-pixel seam recorded under `[B01]` above. A 3.68 seen once came from a batch of thirty-four taken while another session held the machine-wide app-test gate, which is contention rather than a signal.

## The flash, rebuilt and measured

The card ring is now drawn once and faded by `opacity`, it reads no layout to restart, and it does not begin until the settle has landed. The vacancy badge's ring got the same rebuild, because the reader reads the two the same. Taken the same way as everything above: release build, an idle control in the same window, medians of three.

### It did not narrow the gap either, and that is now the third time

| | idle control | activation | the gesture's own cost | Step 5 | Step 4 | Step 2 |
|---|---|---|---|---|---|---|
| four session cards | 36ms | 103ms | **+67ms** | +71ms | +57ms | +51ms |
| eight session cards | 38ms | 113ms | **+75ms** | +80ms | +72ms | +71ms |

Raw, in run order — four-up idle / four-up activation / eight-up idle / eight-up activation, in ms:

```
run 1   36 / 103 / 38 / 110
run 2   33 /  99 / 48 / 121
run 3   38 / 106 / 37 / 113
```

Four steps have now each removed a named suspect and each left the number where it was. That is not four failures; it is the attribution from Step 2 holding under four independent confirmations. **No single suspect owns the hole**, the rebuilds stand on `[B03]` rather than on a stopwatch, and the arc's purpose — a pipeline in which the cut cannot happen — is what they are for. A later step or the join message saying any one of them was the cure would be saying something this paper has now measured four times to be false.

### What the flash leg asserts, and why each half is needed

`at0622` gained a leg that dispatches the activation and reads the deck back **in the same task**. It can do that because `raiseCard` runs its activation through `flushSync`: by the time `dispatchControlAction` returns, the settle's mark is already on the container, so the read happens inside the click's own frame rather than across a harness round trip.

| | armed a settle | rings lit | the ring's animated properties | effect clock |
|---|---|---|---|---|
| in the click's own frame | **yes** | **0** | — | — |
| after the landing | — | **1**, on the pane named | **`opacity`** | 152ms |
| re-requested on the lit pane | — | **1** | `opacity` | **17ms** |

Every row answers something a single claim could not.

The first row's `settling: yes` is what makes its `0` mean anything: "no ring started" is trivially true of a gesture with no motion to wait for, so the leg asserts there **was** a settle to defer past. The second row is the same `[D5]` shape the recede census took — a zero is only evidence if a one was reachable, and the ring does light, on the pane the gesture named.

The third row reads the **clock**, not the class, and that is the whole of `[P06]`'s most load-bearing correction. The restart used to be remove-class → forced reflow → add-class; the reflow existed because remove-then-add inside one task is not a style change the engine ever resolves. Replacing that with a `cancel()` would look right and would not work: an element that still computes the same `animation-name` leaves the engine nothing to diff at the next recalc, so the cancelled effect is never replaced and the ring silently does not play — and a test watching the class would pass. The restart is a **seek** of the live effect to zero, and the only way to see the difference from outside is that `currentTime` goes backwards. It does: 152 → 17 on this run, 159 → 21 and 147 → 28 on the two repeats.

### What the rebuild removed, in the two places it lived

`@keyframes tug-pane-border-flash` walked `box-shadow` from the accent colour to `transparent` across `--tugx-card-flash-duration`'s whole 1750ms, on a pseudo covering the full pane — a repaint of that layer on every frame of the run, beginning in the same frame as the slide (`[F05]`). The shadow is now one static declaration on the layer and the keyframes carry `opacity` alone. `@keyframes tug-slot-vacancy-flash` carried the same walk beside an `opacity` fade it already had; its shadow is now declared under the flash class, and the badge's own fade carries the ring with it, so nothing there animates a paint property either.

`will-change: opacity` rides the flash class rather than standing on every frame. A standing hint would be one more layer per card at rest, which is the population cost `[D1]` is about and `[Q01]` could not price; creating the ring's layer at the flash's start is free of `[F03]`'s objection precisely because the flash now starts when the frames have already stopped.

The vacancy's ring sits outside `[P08]`'s pane-scoped stylesheet guard — its subject is a `.tug-slot` inside a tile, not a frame — so nothing mechanical will notice if a paint property comes back to it. That is recorded here and in the stylesheet rather than papered over: it is held to the rule by reading.

## The click task, bounded and measured

The activation's own task no longer walks a scroller subtree per frame, and a frame carrying the settling mark no longer lets the engine re-decide which of its cells are rendered. Taken the same way as everything above — release build, an idle control in the same window, medians of three.

### It did not narrow the gap either, and that is now the fourth time

| | idle control | activation | the gesture's own cost | Step 6 | Step 5 | Step 4 | Step 2 |
|---|---|---|---|---|---|---|---|
| four session cards | 31ms | 99ms | **+68ms** | +67ms | +71ms | +57ms | +51ms |
| eight session cards | 36ms | 116ms | **+80ms** | +75ms | +80ms | +72ms | +71ms |

Raw, in run order — four-up idle / four-up activation / eight-up idle / eight-up activation, in ms:

```
run 1   31 /  99 / 43 / 116
run 2   29 /  95 / 36 / 100
run 3   31 / 101 / 34 / 117
```

**And `firstPaintDelayMs` is the field this step was aimed at, so it is the one to read.** It is `0` on every activation leg of all three runs, which is where Steps 5 and 6 left it. That field separates the two failures that look identical from outside: a tween that STARTED late, because a long task delayed its first rendering opportunity, and one that ran on time and painted late. `[F06]` is a claim about the first — the click task's layout reads are what a late start would be made of — so a step that removes them and moves `firstPaintDelayMs` not at all is saying that the hole was never in the start.

Five steps have now each removed a named suspect and each left the number where it is. Nothing in this paper licenses a later step or the join message to name any one of them as the cure.

### What the gate actually is, and why it cannot go stale

`arrangementSignature` now returns two strings rather than one. `full` is what it always was and what the settle still arms on. `size` is the same string with the two purely positional terms dropped — the flow offset, and each pane's slot — so two commits agreeing on `size` put every frame at the same width and in the same tier however far they have travelled. That is the exact predicate for "is this a resize?", and `arm` raises a resize episode only when it moved.

The two halves are built in one pass from one set of terms, which is the property worth having: a width-bearing term added to the signature is added to the size half by the act of adding it, so the gate cannot quietly stop covering something.

The rail and column terms are kept **whole** in the size half, offsets included. A strip that slides moves no frame's size, so those offsets are strictly conservative — but each term is one string carrying a mode and an allocation beside its offset, and both of those move every member's height. An episode raised where none was needed costs what today costs; one skipped costs the reader their place. The conservative side is the correct side of that trade, and it is recorded here rather than left to be rediscovered as a bug.

`sizeChanged` is banked **before** the cut's early return, not after. A cut says the frames are already drawn where the commit puts them and returns before any episode is raised; if the size half were only recorded on the paths that reach the episodes, the next commit would read itself against a shore two arrangements old.

### The gate is falsifiable, and the census that shows it

`at0622` reads `data-resize-episode` — the mark `beginResizeEpisode` writes on the frame it anchors — off every shown frame, mid-settle.

| | armed a settle | frames carrying an episode |
|---|---|---|
| at rest | — | **0** |
| mid-slide (the activation) | **yes** | **0** |
| mid-resize (`set-content-width`) | **yes** | **5** |

The third row is the whole point and it is the same `[D5]` shape the recede and flash censuses took: a zero on the slide means nothing unless a non-zero was reachable through the same census, on the same deck, in the same run. It is — a gesture that really does resize every frame still raises every episode, so what the slide's zero reports is the gate, not a blind reader.

### `preventScroll`, and why it is keyed to modality

`[F06]`'s last item is a bare `target.focus()` on the incoming editor, inside the click task, which scrolls the landing into view. `focus-transfer.ts` already carried the opt-in on its OTHER channel — `walkOpts` passes `preventScroll: true` for a pointer gesture on the engine-routed placement — and deliberately omits it for a keyboard one, because the walk's landing must wear the ring and be revealed. So the raw claim now takes the same opt-in on the same terms: pointer yes, keyboard unchanged. A blanket `preventScroll: true` would have traded a scroll the click never wanted for a keyboard the user cannot find, which is a worse bargain than the one being fixed.

`default-focus.ts` needed no change at all. It has offered `opts.preventScroll` since before this arc; the deck's activation path simply never took it.

### The cell freeze, and what this file can and cannot say about it

`[B07]` is built the way `[P07]` specifies: the engine's own `contentvisibilityautostatechange` writes `data-cv-skipped` as relevance flips, and while `data-imposer-settling` is on the CSS pins a skipped cell to `content-visibility: hidden` and every other ready cell to `visible`. Nothing is measured at settle time — asking each cell where it stood would be exactly the per-frame-proportional read `[B06]` removes.

**`hidden`, not `visible`, and that is the correction this step carries.** The version Step 4 tried read `visible` for every ready cell under a settling canvas, which forces every skipped cell to render at the worst possible moment — precisely backwards. `hidden` skips the contents unconditionally, never re-resolves against the viewport, and preserves rendering state for a fast re-show, which is what "held" means.

**Risk R03 is not taken.** `at0622` reads `"oncontentvisibilityautostatechange" in document.createElement("div")` on the shipping engine and gets `true`, so the fallback — one `checkVisibility({ contentVisibilityAuto: true })` pass per cell at settle-arm, a real cost at exactly the moment `[B06]` is protecting — is not in the build and costs nothing.

**What this file does not measure is the freeze itself**, and the census says so out loud: `ready` is `0` in every reading, because `at0622`'s session cards carry empty transcripts and the only consumer of offscreen-skip is the session card's transcript. The census counts the marks and the resolved values and finds none to count. That is the plan's own position rather than a gap this step opened — its "what is NOT asserted" list says which cells the engine skipped is the engine's business, and that what gets asserted is the frame-gap bar with the freeze in place, which is Step 9's. The mechanism is here, guarded by the stylesheet audit and by reading; the bar is what will price it.

### Step 4 left a comment with no rule under it

The `[B07]` block in `tug-list-view.css` survived the Step 4 revert that removed its rule, so the file carried several paragraphs arguing that the freeze fixed `at0566` — a claim the same step had measured to be false, standing over no declaration at all. It is rewritten here to say what was actually found: the blunt form was tried, repeated runs were red with it, it was withdrawn, and what stands now stands on `[B03]` rather than on a stopwatch.

## The law, and what its two guards caught

`[B03]` is now `[D9] The settle window is compositor-only` in `tuglaws/animation-doctrine.md`, registered in `tuglaws/INDEX.md`, and enforced twice. This section is what the guards found when they were pointed at the deck as it is.

### The static guard, and the one declaration it must NOT report

`audit-settle-motion.ts` gained rule 2: a `transition` or `animation` naming any property but `transform` and `opacity`, on a selector that can match `.tug-pane` or a descendant.

Pointed at the corpus it reports nothing — and the first thing to establish is that this is a fact about the stylesheets rather than about the rule. Two probes, both run and both reverted:

| probe | what the rule did |
|---|---|
| planted `.tug-pane .tug-pane-chrome::before { transition: background-color 1s }` | **reported it**, named `background-color` and the selector, exit 1 |
| renamed `[data-imposer-settling] .tug-pane` so it no longer stands the shade down | **reported `height` on `.tug-pane`**, exit 1 |

The second probe is the more interesting one. `.tug-pane` really does carry a `transition: height` — the `[D07]` window-shade ease — and it is correct: `chrome.css` stands it down under `[data-imposer-settling]` precisely so two clocks never run on one height, which is the fold bug that stand-down was written for. A rule that reported it anyway would have been loosened within a week. So the scan collects the selectors stood down under the settling mark and excuses them **by exact selector**, and the probe above is what proves that excuse is doing work rather than passing everything.

Resolving `animation` through `@keyframes` matters for the same reason in the other direction: the shorthand names a keyframes rule and the properties are inside it, so a scan that read only the shorthand would have passed `animation: tug-pane-border-flash` whatever it walked — which is the hole `[F05]` fell into before this arc rebuilt the ring.

### The runtime guard found a real violation, and it is the settle's own

The settle now writes a `settle-frames` row at its release, computed by `classifySettleFrames` — the same pure function the bench probe uses, so the product's self-report and the test's assertion cannot drift into two definitions of a dropped frame. `[D9]`'s runtime half rides the same reading: one `settle-motion-violation` row per pane per offending property.

| gesture | `settle-motion-violation` rows |
|---|---|
| the activation (four cards, a flow slide) | **none** |
| four columns dividing (eight cards) | **`at0622-p2:height`, `at0622-p4:height`, `at0622-p6:height`, `at0622-p8:height`** |

**The second row is a finding and it is recorded as one rather than tuned away.** A column that divides gives each member a share of the height, and the settle carries that as a real `height` tween — a main-thread property inside the settle window, which is exactly what `[D9]` forbids. The law is written knowing it. What the guard is for is to keep saying so, and the test asserts the rows are present and that every one of them names `height` — so a *new* property appearing there is a failure rather than a line in a log nobody reads.

It is also the `[D5]` leg for the whole record. The activation's empty `violations` means nothing unless a non-empty one is reachable through the same guard, on the same deck, in the same build. It is.

### The guard was blind exactly where this arc had been working

`sampleSettleFrame` read `frame.getAnimations({ subtree: false })`, and a bare `getAnimations()` **excludes an element's own pseudo-elements**. The frame dim is `.tug-pane::after` and the recede's wash layers are pseudos on the chrome — so `violations` could not see the layers Step 5 had just put the recede on, and would have reported a clean deck whatever arrived there.

Sweeping the subtree instead is the opposite mistake: a spinner deep in a card's body is not the settle's motion, and reporting it would leave `violations` non-empty on every healthy deck, which is how a guard gets loosened until it means nothing. The read is now `getAnimations({ subtree: true })` filtered to `effect.target === frame`, which is exact rather than approximate — a pseudo-element effect reports its **originating element** as `target` and names the pseudo separately in `pseudoElement`, so the frame's own `::before` and `::after` pass and a child's effects do not. It is the same engine fact Step 5 hit from the other side, where a pseudo effect arrived at `at0294` wearing the frame's identity.

### A fixed sleep read an unreleased settle, and it looked like a blind guard

Worth writing down because the failure mode is indistinguishable from the defect it mimics. The column leg first read the trace after a fixed 900ms and found **no `settle-frames` row at all** — which reads exactly like a guard that cannot see `height`. The trace's own kinds said otherwise: four `settle-arm`s, a run of `settle-retarget`s, and no `settle-release`. Four dispatches landing back to back each retarget the settle, so that choreography runs well past a single activation's window, and the record is written at the release by design. The leg now waits for the row rather than for a duration.

### What the product's own pump reads, beside the bench probe's

The `settle-frames` row for a four-card activation reads `ticks 24, longestGapMs 25-26, longestGapFrames ~1.5, gapsOverOneFrame 0-1, firstPaintDelayMs 0` over five frames. The bench probe's reading of the same gesture is consistently worse, and the difference is not a disagreement: the probe's window is opened by a harness round trip and held across two more, so it carries costs the settle never paid. The product's record is the one measured from inside the gesture, and Step 9's bar should be read against it knowing which is which.

---

## The proof: the bar, at four cards and at eight

Spec S02's bar replaced the recording assertions in `at0622-deck-settle-frames.test.ts`, and the file ran green three consecutive times. Same discipline as everything above: release build, an idle control in the same window, medians of three, an uncovered window, and a forcing leg that must fail.

### The bar is read over two windows, and the split is the finding

One gesture is now read by two instruments, and they do not measure the same thing.

The **bench probe's** window opens at `arm()`, takes a quiet head, and is held across the harness round trip that dispatches the activation, the click task and the React commit that run before the canvas arms, the settle, and the landing. The **canvas's own `settle-frames` row** opens when the settle arms and closes when it releases. Both come out of one classifier, so the difference between them is the difference between the two windows and nothing else.

The success criterion names "no inter-frame gap longer than two display frames **across the move beat and the focus flip**". That is the settle, and the settle is exactly what the canvas's record covers — so the two timing clauses are read off the row. Everything the row cannot carry is read off the probe: the per-tick opacity and rect census, the fixed-descendant count, and the suspension floor. The probe's wider window only makes those harder to satisfy.

### The readings, side by side

The bench probe's whole-window worst gap, medians of three, at a derived frame period of 17ms on every run:

| | idle control | activation | the gesture's own cost | Step 2 |
|---|---|---|---|---|
| four session cards | **38ms** (2.2 frames) | **100ms** (5.9 frames) | **+62ms** | +51ms |
| eight session cards | **35ms** (2.1 frames) | **112ms** (6.6 frames) | **+77ms** | +71ms |

Raw, in run order — four-up idle / four-up activation / eight-up idle / eight-up activation, in ms:

```
run 1   41 / 100 / 39 / 107
run 2   38 /  97 / 35 / 112
run 3   33 / 105 / 32 / 125
```

The canvas's own record over the same three gestures, in ms and in display frames:

| | four session cards | eight session cards | the scaling gap |
|---|---|---|---|
| run 1 | 29ms (1.71 frames) | 27ms (1.59 frames) | 0.12 frames |
| run 2 | 30ms (1.76 frames) | 28ms (1.65 frames) | 0.11 frames |
| run 3 | 26ms (1.53 frames) | 28ms (1.65 frames) | 0.12 frames |

`firstPaintDelayMs` is **0** on every plain leg of every run, on both instruments. `minOpacity` is 1, `rectsChangedAfterLanding` is empty, `fixedDescendants` is 0, and `violations` is empty on both, at four cards and at eight.

### Which of `[F03]`–`[F07]` carried the hole: none of them, and none of them closed it

The attribution section above ruled all five out by measurement, and these final readings do not overturn it. The bench probe's whole-window cost is where Step 2 found it — +62ms and +77ms now against +51ms and +71ms then, both moves comfortably inside the ±25ms of run-to-run noise the baseline established. Six steps have each removed a named suspect and each left that number where it is: +51/+71 at Step 2, +57/+72 at Step 4, +71/+80 at Step 5, +67/+75 at Step 6, +68/+80 at Step 7, +62/+77 here.

So the honest statement is the one `[B09]` asked for in advance and it has not changed: **no rule in this arc closed a measured hole, because no rule was ever shown to have opened one.** `[F03]`, `[F04]`, `[F05]`, `[F06]` and `[F07]` each contributed nothing this instrument could resolve, and the join message must not name any of them as a cure.

### What the bar does prove, and the one thing it cannot

What it proves is about the **beat**, which is the thing the user was complaining about. Across the settle's own window the deck holds 1.5–1.8 display frames at four session cards and 1.6–1.7 at eight — under the two-frame bar with room, with the first painted frame landing in the same frame as the tween's start, no opacity dip, no rect settling twice, no fixed descendant inside a promoted frame, and nothing animated off the compositor. And the scaling clause, which is the claim the arc's purpose actually makes, is met by a margin that makes it almost uninteresting: **the eight-card gap is within 0.12 of a display frame of the four-card gap**, where the baseline's signature of the defect was a cost that grew with the count.

What it cannot prove is a before-and-after on that window. The `settle-frames` record is this arc's own instrument, landed in Step 8, so there is no branch-point reading of it to compare against and no way to take one — reverting the arc to get a baseline removes the instrument that would measure it. The beat reads clean now; whether it read clean then is a question this paper cannot answer and does not pretend to.

The wider window is the other half of the honest account. Something in the activation still costs about four display frames beyond an idle window of the same length, and this arc has demonstrated by exhaustion that it is none of the five suspects the brief named. It sits in the span between the dispatch and the settle's arm — the click task, the React commit, and the harness round trip that carries the dispatch, which this fixture cannot separate from the other two. That is the next investigation, not this one's failure to finish.

### The forcing leg had to be moved, and that is a finding about the record

`[D5]`'s leg plants a 200ms task inside the settle window and requires both readings to notice. Planted at the dispatch it falsified only the bench probe: the canvas recorded 13 ticks and a worst gap of **18ms** while the probe recorded **249ms** over the same burn.

The cause is the record's own shape. A gap is the distance between two samples, and the canvas opens its record when the settle arms — so a stall that burns before that record has taken its first sample leaves no gap behind it, however long it is. The record is not wrong; it starts on the far side of the burn and reports the window it actually saw.

Planted 60ms after the dispatch, with at least one sample in front of it, the same task reads **215ms / 12.65 frames**, **215ms / 13.44 frames** and **216ms / 12.71 frames** across the three runs — six times the bar the same record had just passed at 1.7 frames. That is what makes the bar a measurement rather than a formality, and it is worth keeping beside the lesson from Step 8's column leg: twice now, this arc has read a clean number off a record that was not looking where it was assumed to be looking, and both times the number was indistinguishable from a real green.

## Step 4 readings, 2026-09-29: the two probes, and what they retired

Taken on `866e1dfd9` with the chain fan-out deferred (`window.__tugProbe.deferChain`), on the four-up flow fixture of `at0622`. Every number is the bench's; the user's deck is bigger in every dimension and is read separately.

### The flow offset is not a layout cost, and a transform would buy nothing

A census in the live page priced one write of `--tug-imposer-flow-offset` on the shown space layer against the alternatives, seven samples per variant, three rounds, style flushed first and layout on top of it:

| write | style | layout |
|---|---|---|
| the offset, on the layer (1556 descendant nodes) | 3 ms | 0 |
| an unused inherited custom property, on the layer | 2 ms | 0 |
| an unused **non-inherited** registered property, on the layer | 0 | 0 |
| `left` moved 1 px on each of the four flow frames | 0 | 0 |
| `translate` on each of the four frames | 0 | 0 |
| a non-inherited registered property on each frame | 0 | 0 |

The layout half is nil: a moved `left` on an absolutely positioned frame is a positioned-movement-only layout. The whole cost is the inherited custom property invalidating the computed style of every descendant of the layer, most of which is the rail's Layout card (1260 of the 1556 nodes) that never reads the offset. Step 2's "15 ms for the offset write" was the arm's whole dirt flushed at once, mis-attributed to the one write between two forced reads. **The transform-on-the-layer idea is retired**: the shown layer is `display: contents` and has no box, and there is no layout to remove. What stands instead is cheaper and smaller: register the property `inherits: false` and write it on the elements that read it, so a slide invalidates four frames and nothing else.

### The keyframe shape is not the lead

A 1 ms native sample of the page's WebContent process across three slides put 40 of its main-thread samples in `RenderLayerCompositor::computeExtent` → `KeyframeEffect::computeExtentOfTransformAnimation`, which evaluates every keyframe of every running transform animation on every compositing update. Two patches tested it: two keyframes with the spring carried by a `linear()` easing, and two keyframes with a cubic-bezier. Eight slides each, chain deferred:

| shape | activate lead (median) | home lead (median) | worst gap |
|---|---|---|---|
| 24 sampled keyframes (shipped) | 18 ms | 14 ms | 24–41 ms |
| 2 keyframes + `linear()` | 16 ms | 15 ms | 23–37 ms |
| 2 keyframes + cubic-bezier | 16 ms | 14 ms | 26–38 ms |

No difference the instrument can resolve. The lead with the task ending at 1–2 ms is the wait for the next rendering opportunity; the 8–15 ms first-tick readings are where a display-aligned update lands.

### Where the frames actually go now: the deferred commit, inside the window

Every slide and every fold shows the same shape in its marks. The task ends at 1–3 ms and the first tick lands at 8–15 ms. Then the deferred work arrives as one unbroken main-thread stretch of 25–40 ms in the middle of the settle: the host menu flush, the React commit (`canvas-render`, two `pane-render`s, and the Layout card's 84 place marks and 86 stack glyphs, because `useDeck()` hands it the whole snapshot on every commit), the Last pass, the chain's 23 button renders, and a second menu flush. That stretch is the `longestGapMs` on every row — 24–41 ms on slides, 18–47 ms on folds — and it is the reason the four-up leg reads 1.4–2.4 frames against a two-frame bar. With the chain NOT deferred the same work runs inside the click task and the lead reads 70 ms (`firstPaintDelayMs`), the plain leg's 4.1 frames.

### The fold: the height tween delivers, the lead is the cold arm

Six folds and unfolds on the flow fixture: the first fold led by 13 ms, all 12 of them inside the canvas arm itself (`tug:sync:canvas-arm` 0 → `tug:arm-end` 11); every later fold and unfold led by 1–3 ms with a 0–2 ms arm. `gapsOverOneFrame` was 0 on four of six; the two that read 1–2 were the deferred-commit stretch above (28 and 47 ms), not the tween. `at0622`'s fold leg measures the first fold after launch, which is the cold arm. **Height by occlusion is retired on these numbers**: there is no per-frame cost in the height tween to remove on the bench, and the readings paper already showed the user's deck delivers its fold frames between first and last. What a fold pays is the cold arm on its first run and the commit stretch inside the window, both of which the flow slide pays too.

### What step 5 carries

1. The chain fan-out leaves the click task for good (`deferChain` shipped and hardened), since it alone is the difference between a 70 ms and a 15 ms lead.
2. The commit inside the window is made small rather than deferred further: the Layout card subscribes to what it draws, not to the snapshot; a slide that changes only `flowOffset` and `data-focused` renders nothing there.
3. The flow offset becomes a non-inherited registered property written on its readers.
4. The cold arm on the first fold is read once more with the episode discovery isolated before anything is changed there.

## Step 5, 2026-09-29: what shipped, what the bench says, and the next lever

**Shipped** ([D204]): the responder chain's generic subscribers are told after the next paint through `lib/after-paint.ts`, with a scheduler seam for tests and a stand-down under reduced motion; `TugButton` re-validates at the press so the one-frame-stale enablement cannot dispatch; the deck store's own deferral stands down under reduced motion too; the Layout card's hooks are `useStoreDerived` selectors, with the strip offset and the marked slot read by two small components; `--tug-imposer-flow-offset` is registered `inherits: false` and written on its readers through `components/chrome/flow-offset.ts`; three arm-phase marks (`tug:arm-measured`, `tug:arm-episodes-end`, `tug:arm-planned`).

**The bench.** Unit suite 9772 green. Thirty-one app-tests named across the changed surfaces: 21 green. The ten reds were run again on the committed tree behind a reverse-diff probe, and nine of them read the same numbers there — `at0454` (a flow fixture whose strip no longer overflows its band, red since `7b01ac1e0`), `at0549-card`, `at0597`, `at0566`, `at0594`, `at0605`, `at0626`, `at0632`, and `at0622`'s two inherited legs — so none is this step's. `at0643` alone flipped: one 26 ms gap against a 20 ms budget on a six-card streamed switch, green at the committed tree on one run and red on two runs here; it is a cadence budget inside the jitter its own message names, and it is recorded, not explained.

**`at0622`'s four-up leg** now reads 41–57 ms lead / 2.4–3.4 frames against 70 ms / 4.1 frames before this step. Its marks say where the rest is, and it is a new fact: the leg is the FIRST activation after launch, with a first-responder flip, and the flip runs inside `transferFocusForActivation`'s `flushSync`. `raiseCard` passes `deferCommit: true`, so the deck store's notify is not flushed — but `flushSync` flushes every React update already pending, and the flip has just made several synchronously: the canvas re-renders because `cardsSelectionStore`'s "a selection stands" bit flips on the first activation (`canvas-render` at 0 ms, four `pane-render`s, `last-pass` at 6 ms), and every session card re-renders its chrome off the focus manager's and the card lifecycle's synchronous activation notices (the commits at 17 ms carrying `Move all sessions to Trash…`, `Clear filter`, `Browse for a directory`). The flush ends at 17 ms, the task at 18, the first tick lands at 40. The warm slides the earlier sampler measured had no flip in them — card 4 stayed the first responder — which is why they led by 15 ms: the flip's in-task React work is the whole difference.

**The cold arm** did not reproduce under the phase marks: six folds in a fresh launch read `canvas-arm` → `arm-end` at 1–2 ms on every one, first included, with each phase under a millisecond. `at0622`'s fold leg still reads 11 ms before the arm on its first fold after two activation legs; whatever is cold there is not the episode discovery, and the marks are in place to read it the next time it shows.

**The next lever, then, is the flip's own React work inside the click task**: the focus manager's and the card lifecycle's activation notices reach React synchronously and `flushSync` collects them. The same door the chain now takes — tell React after the next paint, keep the non-React observers synchronous — applied to those two channels would take the session cards' chrome renders out of the task; the canvas's selection bit is a once-per-launch flip and can stay. That is step 6's first item, ahead of the Beat primitive.

## Step 6, 2026-09-29: the flush was the picker, not the notices — and what the clean task now shows

**The attribution step 5 closed on was wrong, and the code said so before any probe did.** The step-5 section named "the focus manager's and the card lifecycle's activation notices reaching React synchronously" as what `transferFocusForActivation`'s `flushSync` collects. Neither channel can be it. `FocusManager.subscribe` has three React readers in the whole tree — `followed-card.ts`, the colour picker, the theme editor — and none of them is in a Session card; `useCardDelegate`, the card lifecycle's React path, already defers every delegate call through a `MessageChannel`. The commit census had said what it was all along: the commit at 29 ms inside the flush had `react.context` as its top type, which is a subtree MOUNTING, not re-rendering, and its labels were the picker form's. The collector is `session-card.tsx`'s `observeCardDidActivate(cardId, () => presentSheet())`: `showSheet` is a `setState`, the observer fires on the activation's own stack, and `flushSync` then mounts the whole picker panel — sheet, form, list — inside the click task.

**What shipped.** The present takes the after-paint door ([D204], amended): `scheduleAfterPaint(presentSheet)`, with `presentSheet` re-reading its own latch and the fold at the door, and a liveness ref for a host unmounted in between. Two cases stay on the stack: a card the deck opened HIDDEN, whose reveal waits on this very panel's first report ([B01]) and whose frame nobody can see — read fresh off the store through a new `cardArrivingOf(state, cardId)` selector in `deck-store-selectors.ts`, keyed on the pane's `arriving` mark exactly as the fold is — and reduced motion. `at0571` (the arriving picker's two-motion contract) and `at0522` (the empty card's close) are green under it.

**The bench, before and after, on `at0622`'s four-up plain leg** (a first activation of a card whose picker has never been presented; two reads each; times from the settle arm):

| | flush start → end | first tick | longest gap |
|---|---|---|---|
| committed tree (`a7ff6a5d4`), two reads | −14 → 30, −12 → 30 (44 ms) | 56, 57 ms | 57 ms / 3.56 fr, 54 / 3.18 |
| with the present at the door, five reads | −11 → 5 … −3 → 11 (8–16 ms) | 12, 18, 18, 18, 18 ms | 38 / 2.24, 44 / 2.59, 48 / 2.82, 44 / 2.59, 50 / 2.94 |

The first tick moved from 56 ms to 12–18. The longest gap moved from 54–57 to 38–50 and is still over the two-frame bar, and the census says why: the picker now mounts at 29–40 ms, in the settle window, and its mount is a CASCADE — six commits of 86–158 fibers between 39 and 70 ms (the form, the trash confirm, then four re-renders as its recents probe, session ledger and selection effects each land) and a 432-fiber commit at 84 as the session rows arrive. That is the second half of [D204] again — deferred work that lands as one stretch — but it is also a cost a real deck pays once per unbound card, at launch, and never on the flip a user makes all day.

**So the bench now takes a warm-flip reading**, a `note()` and not a claim: after the plain leg, from where it left the strip, activate card 1 — whose picker presented at launch, it being the active pane — so the slide crosses the same band the other way with a first-responder flip and both pickers standing. (From home it would move nothing: card 1 already stands in the band, no settle is armed, and no row is ever written, which is how the first attempt at this leg hung for 80 s.) Two reads:

| warm flip | flush | first tick | longest gap |
|---|---|---|---|
| read 1 | −2 → 2 (4 ms) | 9 ms | 27 ms / 1.59 fr |
| read 2 | −3 → 2 (5 ms) | 9 ms | 48 ms / 2.82 fr |

**The click task is clean.** A flip with nothing to mount costs the task 4–5 ms and the first frame lands at 9 ms, under one display period. Every remaining millisecond in the window is deferred work, and the census names it in two parts. (1) The deck store's commit after the notify — `react-notify` at 14–16, `last-pass` at 25–28, so 11–12 ms of one commit — performed 917 fibers: the strip's four *Go to slot* buttons (expected; the offset moved), and then FORTY-FOUR Radix poppers, forty-eight presences: every pane's title bar, all four, re-rendering its tooltip-bearing buttons (*Close card*, *Alone in this place*, *In position N*, *Bullseye*, *Card width*, *Move to workspace*) on a commit that changed one pane's `data-focused` and the strip's offset. On the plain leg the same commit performed 236 for one pane; on the flip it is all four. (2) Five commits of 523–546 fibers between 46 and 70 ms, each the picker form again — `TugConfirmPopover`, the trash buttons, the session rows' context menus — re-rendering on the flip's after-effects, which the fixture pays because its cards are pickers and a bound deck would not.

**The next lever is (1), and it is the [D204] rule applied to the pane chrome**: a commit that changed nothing a title bar draws must render no title bar. The pane reads the deck through `useSyncExternalStore` over facts wider than it draws; the same `useStoreDerived` grain that took the Layout card's eighty-four place marks out of the window would take four title bars' worth of poppers out of this one, and the bench has the number to check it against — the notify-to-last-pass span and the `performed` count of that commit. That comes before the Beat primitive, which is where the step program stands:

1. **Pane chrome subscribes to what it draws** (`useStoreDerived` at the pane; bench: `react-notify` → `last-pass` under 4 ms on the warm flip, and the deck commit's `performed` in the low hundreds).
2. **A bench with bound cards.** The plain leg's picker cascade is a fixture cost; a fixture that binds real sessions (as `at0175` does) reads the deck the user has. Whether `at0622` grows that fixture or a sibling test carries it is a call for the user, since `at0622` is the pinned bar.
3. The **Beat primitive + lint** (`tug-animator.ts`).
4. A **brief** superseding the fold/new-card first-frame briefs, retiring `workspace-switch-quiet` and `sidebar-height-is-measured`; law extensions if the probes hold.

**Reds this run, all inherited and all read the same on the committed tree behind a reverse-diff probe** (`tugtool file probe --patch`, with the bundle rebuilt inside the probe and again after it): `at0569` ("the two pickers are far enough apart that no constant fits both", 0 against >100, red since `489cccb30`), `at0613` (the dropped atom lands as `A ￼ B`, red since `44c610695`), `at0347` (the stack menu never appears, red since `749fdfaf1`), and `at0622`'s two legs (the four-up bar, and the fold's 18–19 ms lead against a 17 ms period — 11–12 ms of it still before the arm, the cold arm the phase marks have not yet caught). One `at0622` flake in five runs: the row-versus-probe clock read 44 against 45 once and agreed on every other run.

**Housekeeping closed.** Step 5's "lint was never run" was a phantom: this project has no ESLint; `just lint` for tugdeck is `audit:visibility`, `audit:motion` and `audit:type-alignment`, and all three are clean. Unit suite 9775 green; typecheck clean; covers check clean. `at0201` (the activation click focus contract), `at0175`, `at0140`, `at0084`, `at0088`, `at0399`, `at0421`, `at0097`, `at0455`, `at0563`, `at0571`, `at0522` green.

---

## Step 7, 2026-09-29: the settle fixup pass — every leg, before and after

**Why there is a Step 7 at all.** Between Step 6 and here, the deck's React commit moved behind the next painted frame ([D204]). Three invariants inside the settle had been written when the commit was synchronous and were not re-derived when it stopped being one, and a 360° audit of the code against the ask found six defects and, more importantly, that seven of the ask's eleven behaviours had no frame-level bar at all. This section is what the fixup pass measured: the six closures, each falsified against the code before it; the four instrument decisions; and every behaviour's bar, green and red alike. `briefs/settle-fixup-pass-brief.md` is the brief.

**One discipline runs through all of it, and it is the lesson this paper was started over.** A green is evidence only when the gesture demonstrably happened and the instrument was demonstrably live. So every new leg here carries three guards beside its claim: the band's geometry census differs before and after, so the gesture moved something; the canvas armed and wrote a `settle-frames` row, so the reading is the deck's own clock rather than the harness's; and the beat names the settle actually ran are asserted, so a gesture that skipped its choreography cannot pass on timing alone. And every defect closure was falsified by reverting its own lines under `tugtool file probe --patch`, with the bundle rebuilt inside the probe and again after it — a leg that stays green with the fix reverted is not testing the fix.

### The bar, stated once

Five clauses, read off the canvas's own `settle-frames` row for the gesture, with the display period derived from the run rather than assumed:

- the first rendered frame arrives within **one** display period of the gesture (`firstPaintDelayMs`);
- no gap between delivered frames exceeds **two** display periods (`longestGapFrames`);
- **zero** off-curve ticks on any visible frame (`offCurvePaneIds`), an exemption allowed only for a pane the probe independently watched be invisible;
- **no rect changes after landing** (`rectsChangedAfterLanding`);
- the window was **served** — the sampler was not suspended, and the row exists.

The bar is deliberately the same on every gesture. Where a gesture used to carry its own stricter or looser number, the number was the finding, not the bar.

### The six closures, and what each probe read with the fix reverted

| # | What was wrong | Leg | Reverted, it reads |
|---|---|---|---|
| [B01] | A retarget's React commit was deferred like any other, so the third pass's restores were painted before the Last pass could re-plan | `at0622` — a fold retargeted by a fold, and a content-width resize interrupted by a fold | 1 stranded tick across `p2`/`p3`/`p4`/`pl1` on the resize leg; red |
| [B02] | The prelaunch predicate called an arm "pure" while a First measurement stood unconsumed | `at0622` — `hideSidebarRail` with two members | **green** — see "[F03] narrowed" below |
| [B03] | An arriving frame left the pending set when its effect was created rather than when its beat began | `at0622` — an arrival interrupted by a close | no `arrive` beat runs at all: the newcomer is itself retargeted, so the leg fails on the beat clause rather than the opacity one. Same defect, louder |
| [B04] | A synchronous-door subscriber notified React inside the gesture's task | `at0622` — `tug:last-pass` must read after `tug:react-notify` | Last pass at **+8 ms** against a first React notify at **+19** — eleven milliseconds inside the click task |
| [B05] | `deferCommit` was passed unconditionally, so an activation whose card is not visible deferred a commit nobody was waiting to see | `at0649` — `focus-session-card` into a parked workspace | zero React notifies inside an 11 ms flush window |
| [B06] | The deferred picker present did not re-read first responder at the door | `at0650` — two cards activated inside one frame | red on its **rest guard**, `p-x 0 / p-y 1` — see "[B06] is reachable at launch" below |
| [B10] | The departing rail's ghost slid on its own plant-time clock, unconditional on the generation | `at0622` / the rail-travel census | with the `depart` beat's rail branch forced to the band's fade, every ghost read `maxPx 0` over 15 frames and the file dropped to 9/12 |

### The instruments, gated

Thirty-three surviving `performance.mark("tug:…")` call sites across nine files now go through one door (`lib/perf-marks.ts`), which writes nothing unless `window.__tugTestMode` is set or the deck trace is on. The four per-render marks and the six per-subscriber `tug:sync:*` pairs are gone outright rather than gated. `index.html`'s fiber census installs only in test mode; the in-product `settle-frames` pump is armed by trace kind exactly like `space-switch-frames`, so a release deck records only start, end and generation. `isTugMotionEnabled()` reads the cached flag the motion observer already maintains rather than computed style. `PROBE_DEFER_REACT_NOTIFY`, `PROBE_PRELAUNCH_FLOW` and every `PROBE:` tag are retired in favour of [D204]: the doors are product, and a decision is not something a flag takes back.

**One clause of that task could not be carried out, and the reason is worth keeping.** [B07] asked that both `armSettleFrameProbe` and the canvas's `arm` clear the marks so a leg's timeline is its own. Only the first can. `arm` runs in the same task as the gesture that caused the commit, and the marks written earlier in that task are precisely the ones the fold reading below depends on — `tug:set-pane-folded` lands 3 ms before `tug:arm-end`, inside the same task. A clear at the arm's entry destroys the reading one step after it was built. **The rule: a mark-clearing point must sit outside the gesture's task, and the settle's arm is inside it.**

### Every behaviour, and what its bar reads

All readings on the release build, at this tree, through one sampler. "Gap" is `longestGapFrames`; "lead" is `firstPaintDelayMs` against a derived period of 16–17 ms.

| Behaviour | Leg | Reading | Verdict |
|---|---|---|---|
| Warm flip across the band | `at0622` | gap 1.71 fr at four cards, 1.71 at eight | **red at its edge**, rotating — see below |
| Fold / unfold | `at0622` | lead 11–19 ms | red, and the cause is now named |
| A card appears | `at0622` | `room` + `arrive` both run; gap under the bar | green, with one pose exemption |
| A card departs | `at0622` | lead 24, 29, 33 ms across three runs, `commitDelayMs` 0 on every one | **red**, recorded |
| The walk across the band (`go-to-slot`) | `at0622` | lead 12 ms, every clause clear | green |
| Bullseye, in and out | `at0622` | lead 3 ms; on a **wide** deck the [D9] guard reports `:width` and nothing else | green |
| Sidebars hidden | `at0622` | gap 1.29 fr, lead 8 ms, beats `["depart","room"]` | green |
| Sidebars shown | `at0622` | gap **3.65–3.76 fr** (62–64 ms) across two runs, beats `["room","arrive"]` | **red**, recorded |
| Settled-resize retune | `at0622` | gap 1.94 fr, lead 1 ms, beats `["shrink","move","grow"]`; four [D9] violations, `:height` and `:width` on each rail | green |
| Workspace switch | `at0643` | zero gaps over one frame on twelve of sixteen switches; the exception a single 31 ms gap at a 16 ms period | green |
| The standing loops | `at0652` | three wave loops running, clocks 220 → 425 ms; cost p50 1 / p95 1 / max 3 ms over 120 frames | green |
| One live mark per session | `at0645` | run, with a ledger row | green |

**The forcing leg is permanent and it is what makes the zeros mean anything.** A 200 ms stall planted inside the walk's settle window reads 12.6 frames against the two-frame bar, on every run, through the same sampler every other leg above uses. A sampler that has stopped observing and a deck that has stopped dropping frames produce the same numbers; nothing in the table is offered without that leg having passed beside it.

### Three of the brief's premises were narrower than the brief, and are recorded rather than papered over

**[F03] is real in the predicate and unreached by any gesture.** The brief marks it `(verified by reading)`; this is the first attempt to reproduce it. With [B02]'s clause reverted, nothing carries a frame uncarried. `hideSidebarRail` with two members — the shape [F03] names first — carries every frame either way, because a rail's commits move the band's *edge*, so `flowOnly` is false and the prelaunch is unreachable on that path whatever the First rects say. `retuneSidebarAllocation` commits the flow retune **first** and the rail and column retunes after, which is prelaunch-then-measured: the safe order, not the measured-then-flow-only one the finding describes. And `movePaneToSlot`'s held-back reveal lands on `onceCardDidTravel`, a later task, so it is not a second commit inside the first's task at all. [B02] is therefore a correct guard over a reachable state that no gesture reaches today; the `cutPaneIds` reading that would catch it is proven as data in `settle-frame-probe.test.ts`, and the `at0622` leg stands as a live guard in case a future commit order reaches it.

**[F15] is true of bullseye on a *wide* deck, not of bullseye.** `MAX_FLIP_SCALE_DISTORTION` is 0.2 because it was chosen to admit the adjacent content-width step, and bullseye opens the frontmost pane at comfy (800) — from slim (675) that is a distortion of 0.185, inside the cap, and the whole change rides as a raster `scaleX` with the runtime guard reporting nothing. Set the deck to wide (1230) through the real `set-content-width` door first and the flip crosses two steps at 0.54; the guard then reports `at0622-p1:width` and nothing else, on enter (`shrink`, `move`) and on exit (`move`, `grow`). Two fixture routes to the same state did **not** work and are recorded so nobody retries them: mutating a pane's `size.width` in the layout blob, and setting `imposition.contentWidth` in the blob. The gesture is the door.

**`at0643` was holding itself to a bar no other gesture in the corpus answered.** It carried `gapsOverOneFrame === 0` beside its own two-frame clause, on the one gesture whose own docblock calls the difference jitter — and that clause, not the switch, is the flake the baseline recorded at this arc's open. Read four times at this tree over sixteen switches: red exactly once, one switch, a single 31 ms gap at a 16 ms period (1.9 periods, inside the two-frame bar); the three runs after it read zero on all twelve switches. Demoted to a `note()` that still prints every reading. The two-frame clause stands, which is the bar the fold, the walk, bullseye and every arrival answer.

### The reds that stand, and why none of them was loosened

The brief's non-goals forbid loosening a bar to go green, so a red that is still red at this pass's end is a finding here rather than a failure of the step beside it. `at0622` closes the pass at 12/16.

**A card's DEPARTURE leads by more than the bar admits.** Closing a card out of a split column reads `firstPaintDelayMs` 24, 29 and 33 ms across three runs, with `commitDelayMs` 0 on every one — so none of it is spent before the canvas arms, and all of it is the deck's own. Against a 17 ms period that is one and a half to two display frames of nothing after the user closes a card. Every other clause passes on the same reading: both beats run, zero off-curve ticks, no rect moved after landing, worst gap 1.7–1.9 frames. The same sampler and the same bar are cleared by the walk at 12 ms and by bullseye at 3, so the number is the deck's and not the instrument's.

**Showing the sidebars is red where hiding them is green, and the asymmetry is the finding.** Hiding a two-member rail reads a worst gap of 1.29 frames and an 8 ms lead — green on every clause. Showing it reads 3.65–3.76 frames (62–64 ms) across two runs, with an 8–13 ms lead and no off-curve tick on any frame that was already standing. A rail leaving costs the reader nothing; a rail arriving costs about two frames more than the bar allows.

**The fold's lead is not where the brief put it.** [B08] asked for marks over the "11–12 ms before the arm", and once `tug:set-pane-folded` and the three `tug:arm-*` marks joined `clickTaskMarks` the stretch turned out not to be there. With `tug:arm-end` as origin: `tug:set-pane-folded` at −3, `tug:sync:cards-selection` at −2, `tug:arm-measured` and `tug:arm-episodes-end` at −1, `tug:arm-planned` and `tug:arm-end` at 0, `tug:react-notify` at **+2**, `tug:canvas-render` at +3, `tug:last-pass` at **+9**. The whole of `setPaneFolded` — preamble, commit and the arm it triggers — costs 3 ms and the arm itself costs 1. The lead is on the other side: it is [D204]'s deferral plus the Last pass that plans and launches every tween, which is where the fold's 11–19 ms `firstPaintDelayMs` comes from. The task is discharged and its premise was wrong about which side of the arm the time was on.

**The count-scaling clause was reading the picker, not the settle.** Taking the warm flip at both card counts instead of only at four: the cold first activation grows with the deck (39 ms / 2.29 fr at four, 52 / 3.06 at eight) and the warm flip does not move at all (29 ms / 1.71 fr at both). So the scaling clause — the one the brief calls the claim the arc's purpose actually makes — was measuring the picker's mount cascade, which a real deck pays once per unbound card at launch and never on the flip a reader makes all day. Pinned on the warm flip it reads the settle, and the settle does not scale. The bar is still at its edge there: two runs at one commit gave 1.71 then 2.76 frames, and the failing clause rotates between the four-up gap and the eight-up `moveFirstPaintDelayMs`, so one green on one clause is not a baseline.

**And [B04]'s rule closes the routes it names without being sufficient.** On a cold first activation the Last pass still landed at +20, +20, +8, +7 and +14 across five runs against flush windows of 6–21 ms — inside the flush on two of them. The cause is not the cards-selection store, which [B04] closed; it is the picker's mount cascade rendering the canvas inside the same window, and a canvas that renders for any reason there reads the new snapshot and plans the settle with it. A component mounting inside the flush is a second route to the same defect and nothing forbids it.

### Things learned about the deck that were not the point of any step

**A card host is `display: contents`, so a box cannot answer "is it visible."** The first cut of `hiddenClaimReason` asked `root.getClientRects().length === 0`. A shown card host is `display: contents` — that is what the tab switch flips it *to* — and such an element generates no boxes at all, so the predicate called every host hidden, `mayDeferCommit` returned false on every activation, both `at0649` legs went green vacuously and `at0622`'s [B04] pin went red because the ordinary activation had stopped deferring. The rule: **on this deck, visibility is a computed-style question and never a box question**, because the shown state of a card is boxless by construction.

**There is a sixth synchronous subscriber, and it is a deliberate exception.** The brief names four to audit for [B04] and all four write only DOM or their own records. `key-card` in `responder-chain-provider.tsx` is a fifth route and it *does* notify React: `focusManager.setKeyCard` calls `touch()`. It is not deferred, because the activation's own focus claim runs later in the same task and reads the key card this call sets — deferring it would have `applyBagFocus` claim focus for the card that was active before the commit. It writes structural focus state rather than a deck view, which is the line the rule draws. The audit of all six now stands in the `subscribeSync` doc in `deck-manager-store.ts`.

**[B06]'s defect is reachable at launch, not only on a two-activation task.** The brief states it as a hazard of two activations inside one task. The reverse-diff probe put `at0650` red on its **rest guard** — before any gesture, `p-x 0 / p-y 1`: the restore raises the unbound Session card past the card that holds the deck on its way to seating first responder, so a present is already standing at the after-paint door at launch and, with nothing re-reading first responder, lands on the wrong card. The door the deferral opened is **any task that seats first responder more than once**, and a restore is one of those. The user-facing symptom is "a picker opened on a card I wasn't using," on a cold start.

**The arriving frame is off its curve for the whole `room` beat, and the reader sees none of it.** On the appear leg the arriving frame paints 24–25 consecutive ticks off its own curve, one unbroken run from 0 ms, on that pane alone — and it is held at inline `opacity: 0` for every one of them, which the probe confirms by naming the same pane at `minOpacity: 0`. The shape is a tween built up front with a delay and no `backwards` fill: for the whole of its delay the frame computes the identity while its curve says its origin. The pose clause exempts that one pane and states what earns the exemption. The general fact is now written into `animation-doctrine.md`'s worked example 2 — the first beat fills `backwards` and every delayed beat fills `none`, and each half of that has a measured reason.

**A hold's record and the release that ends it are one decision.** Moving the arriving frame's restorers into the pending map ([B10]) is right — one record at a time, and which one says which half of the arrival the frame is in — but the `settleTweensRef` entry it retired was doing a second job nobody had named: while it stood, `settleTweensRef.current.size !== 0`, and that is the condition holding back the Last pass's "nothing to carry, release now" branch. Take the entry away and a Last pass that finds no First rect at all — a switch epoch, motion turned off mid-settle — releases on the spot and empties the pending map, and the frame keeps the inline `opacity: 0` with nothing left that knows about it. So the hold comes off inside `releaseSettle`, on every path, and the sweep's and the reduced-motion pass's own loops are the ordering cases rather than the only sites. **The rule: a record that holds a restorer must hand it back wherever that record is dropped, not wherever the author was thinking about it.**

**A new trace kind costs two files, and the second one fails the typecheck rather than the test.** `focus-claim-hidden` was added to `DeckTraceEvent` alone; `src/__tests__/trace-summarize-drift.test.ts` is a compile-time mirror check against `tests/app-test/_harness/matchers.ts`, so `bunx tsc --noEmit` went red at the step that added the kind and stayed red — a checkpoint that ran app-tests and the unit suite saw nothing, because the failure is in neither. Adding a kind means the union variant, `HARNESS_KNOWN_TRACE_KINDS` and a `summarizeEvent` branch, in one change.

### One reading contradicts a prior one, and it is recorded rather than resolved

Every hand-written selector for a session's phase dot in `at0652` landed on one inside a `tug-list-view-cell` the list was skipping with `content-visibility: auto`: present, **zero** animations, marked `content-visibility:auto`, while nine dot loops ran elsewhere on the same deck at the same instant. That is the opposite of what `at0629` measured and of what `offscreen.ts`'s header records as the reason the observer exists at all — "with 287 of 300 rows skipped every one of the 900 loops was still resident and running," which is also the reading in the doctrine's own off-screen table (`tuglaws/animation-doctrine.md`, #offscreen-limit, ~249 — the `content-visibility: auto` row, 900 loops resident with 287 rows skipped). That table is in the doctrine, not in this document. Both cannot describe the same engine behaviour. Either the WebKit under this build changed, or the two fixtures differ in a way neither docblock names. Nothing was changed on the strength of either: `at0652` reads the dot off the animation census rather than off a box, so it does not wait on the answer. **Whoever settles this owns that table as well** — it is the doctrine's, at `tuglaws/animation-doctrine.md` #offscreen-limit, and nothing in this paper carries a residency table of its own.

### The user's wave report did not reproduce

Reported during step 1: the wave animation in Session cards is not animating. `at0652-loop-cost-and-life.test.ts` was built for it, and on every shape the harness can stand up the wave runs — three bars, three `tugx-progress-wave-*` loops, all `running`, clocks advancing 220 → 425 ms across a 200 ms gap, no `data-tug-offscreen`, no `data-tug-understudy`, no `content-visibility` skip on any ancestor, `--tug-loop-iterations` unset. Tried: a bare bound card with an empty transcript, and the same card with thirty shell exchanges under it so the in-flight footer sits where the report found it rather than in a one-cell list. So the report stands **open**, and the leg stands permanently with both clauses — the wave runs, *and* it costs nothing over the floor — because a cost bar alone is passed perfectly by a loop that never moves, which is exactly the shape the report describes. What would close it is the shape the user's deck was in that the fixture is not; the likeliest is a card whose indicator the viewport observer marks, which needs an imposed multi-card deck with the card off the band's visible stretch.

### What no test asks, as of this pass's end

- **Two clauses are blocked on the same missing fixture: one that can take real keyboard focus.** `focus-claim-hidden` fires inside `applyBagFocus`'s `"applied"` branch, and in an app-test fixture neither an unbound Session card nor a Text card with no file gives the resolver a framework destination — the run records no `focus-call` and no `focus-measurement` row at all, and `document.activeElement` stands on a DIV outside every card subtree even at rest. The caret blink is declared under `&.cm-focused`, and `focus-prompt` through the real door, `focusElement` on `.cm-content` and a synthetic click all leave `.cm-focused` unset for a full sixty seconds; the caret layer mounts carrying `animation-name: none`, which is correct for an unfocused editor. Both instruments are correct by reading and unexercised by a test. A bound Session card with a real project is what would close them.
- **The Z2 row's churn after a new card's body becomes visible.** `zz-probe-session-body-handoff.test.ts` was written to watch the picker → body handoff frame by frame and was **deleted** rather than promoted: both its legs reported `first body tick at index 0`, so the body is already mounted on the census's first sample and the beat the file exists to observe is over before it starts looking. Its two live assertions were that the sampler installed and that the window was served, neither of which is about a Session card. A diagnostic that cannot fail on its own subject is not coverage of it. `at0622`'s appear leg now bars a card's *arrival* at the frame level with the beats named; the churn after the handoff is unasked, and `briefs/session-body-first-frame-brief.md` is bannered as the brief that owes it.
- **`at0622`'s row-versus-probe `moveFirstPaintDelayMs` equality is a boundary, not a bar.** Three runs at one tree read pass, 35 vs 34, pass. The host's `performance.now()` resolves to 1 ms and the two samplers read the move animation's `currentTime` at different points inside the same frame. It was left alone deliberately — rewriting another decision's pin to match one's own run is the habit that buried the flow-occlusion razor — and is recorded here as a clause worth restating as "within one millisecond" by whoever owns it.

### The question this pass hands to the Beat primitive

**Whether [B01]'s flush is the right fix for a retarget in the long run, or whether a retarget should be planned from the store delta.** The flush restores the pre-[D204] behaviour for retargets and is correct today: `arm` calls `store.flushPendingNotify()` after its measurement when it cancelled anything, so the commit lands on the arm's own tick and the restores are followed by the Last pass before anything paints. The cost is that a retarget pays its commit in-task, which is the price a retarget always paid. A store-planned retarget would keep the commit out of the task, but it needs the arm to know Last without the DOM — which is the Beat's open design question, and the prelaunch is its one worked instance. The prelaunch's own predicate is the shape of the answer: a beat planned from the store delta is valid only when nothing is waiting on the DOM, which is why its last two clauses are *no First rect standing* and *no arrival pending*. The Beat primitive generalises the prelaunch rather than replacing it, and it inherits this question with it.

### Where this leaves the program, and the ask's own ledger

A reader arriving at Step 7 cold sees one mechanism and one open question, which understates both what is left to do and what was deliberately declined. This subsection is that ledger. It was added by the cleanup arc, after the pass it describes.

**The program, in the order Step 6 set and this pass did not change.**

1. **Pane chrome subscribes to what it draws** — `useStoreDerived` at the pane, so a commit that changed nothing a title bar draws renders no title bar. Bench: `react-notify` → `last-pass` under 4 ms on the warm flip, and the deck commit's `performed` in the low hundreds. Still the next lever, still unbuilt.
2. **A bench with bound cards.** The plain leg's picker cascade is a fixture cost; a fixture binding real sessions reads the deck the user has. Whether `at0622` grows that fixture or a sibling carries it is the user's call, since `at0622` is the pinned bar.
3. **The Beat primitive + lint** (`tug-animator.ts`).
4. **A brief** superseding the fold and new-card first-frame briefs, retiring `workspace-switch-quiet` and `sidebar-height-is-measured`, with law extensions if the probes hold.

**Which gestures are planned before React, and which still plan in the Last pass.** One gesture is planned before React: the **flow-only slide**, where `arm` writes the new offset on every reader and launches the move beat from the store's own delta inside the gesture's task, and the Last pass adopts the running beat rather than planning one. **Every other gesture still plans in the Last pass, after React's commit** — the arrival, the departure, the bullseye, the slot move, the fold (`markFoldCrossing`, `markStillCrossing` and the opening-pose writes alike), the sidebar rails, the resize retune. So concept 1 below is delivered for one gesture out of the set it names, and that is the honest reading of it.

**The ask's five concepts and two cross-cutting rules, each marked.** `briefs/graphics-animations-asks.md` is the ask; the marks are **delivered**, **reversed** (declined, with the citation that says why), or **owed**.

| # | The ask | Mark | Where it stands |
|---|---|---|---|
| 1 | Motion before React, as the rule for **every** gesture | **owed** | Delivered for the flow-only slide alone. [D204] took the deck's notify off the gesture's task, and the prelaunch is the one store-planned beat. `briefs/session-fold-first-frame-brief.md` `[B01]`–`[B03]` are unbuilt (`briefs/settle-fixup-pass-brief.md` `[F14]`), and that brief now carries a banner saying so. |
| 2 | The Beat as the only motion primitive, plus a lint | **owed** | Not built. Item 3 of the program above. The retarget question this pass hands it is stated in the section immediately above. |
| 3 | Nothing is created or destroyed inside a gesture | **owed** | The departure ghost and the rail shadow strips are still `document.createElement` inside the gesture (`deck-canvas.tsx` ~5878, ~5947). The `departing` mark on the real frame, symmetric with `arriving`, is still the named end state and still unbuilt. |
| 4 | One hold, one quiet | **reversed** | Consciously not taken by this pass. The five gates — arrival quiet, the body's proposed quiet, the settle's notification hold, the workspace epoch, the fold end event — stand as five. Collapsing them is a Beat-primitive change: a hold opened by a beat when it plans needs the Beat to exist first, so this waits on item 3 of the program rather than being refused on its merits. |
| 5 | Height crosses by translation and occlusion, never by a height keyframe | **owed** | `lib/pane-flip.ts` ~395 and ~410 still animate a real `height` pair for the shrink and grow beats, with `markStillCrossing` as the bandage. The ask called this a candidate to bench rather than a decision, and no bench was run. It remains the only route to a settle window that is compositor-only in fact rather than in name. |
| R1 | One instrument, one bar, every beat | **split: bar delivered, always-on reversed** | The per-beat row and its fixed bar exist and every `[B09]` behaviour is now held to them, beats asserted rather than noted. The other half — "on by default in the product" — is **declined**: every instrument is gated, and the gate is the point. An instrument that arms itself on a shipping path has stopped being a probe ([D1]); `lib/perf-marks.ts` gates every `tug:` mark on test mode or a live trace, and the settle's own record is gated on `deckTrace.isKindEnabled("settle-frames")` (`deck-canvas.tsx` ~4256). `briefs/deck-animation-pipeline-brief.md` `[B10]`, which described an always-on product pump, is bannered to match. |
| R2 | Remove, don't rebuild, the recede fade | **delivered, and the reversal is written down** | `lib/pane-recede.ts`, `data-receded` and `data-recede-armed` are deleted rather than disabled; the recede is keyed on `data-focused` and cut with no transition. It reverses the pipeline brief's decision to rebuild the fade as compositor-only motion, and that reversal is recorded at [D203], which retires `[P05]` of that brief. The flash (`lib/flash-pane-border.ts`) is untouched and is not motion of the kind this removed — it is a receipt. |

**One thing the ask asked for that nobody has contradicted and nobody has built:** a lint refusing `animate(` or an entrance `@keyframes` in product code that is not a beat or a registered loop. It rides with item 3 and is the enforcement half of it; without it, every rule above holds by review.

## Step 8, 2026-09-30: the bars the cleanup tightened, and what they found

Readings taken on the `settle-audit-cleanup` worktree as each bar landed. The arc's rule is that a red from a tightened bar is a finding recorded here, never a bar moved back.

### `at0643`'s first-paint bar, at one derived display period

The bar stood at 150 ms — a margin set from the 52–67 ms this very fixture was reading, which is a bar that cannot find its own subject wanting. [B05] took it to one derived period, which is the criterion the arc wrote and the one `at0622` holds on every leg.

**It is red on every switch, and the cause is named in the reading itself.** Four switches on six streamed session cards, at a derived 17 ms period:

| Switch | First paint | Of which React's render phase before the swap commit | Longest gap |
|---|---|---|---|
| A→B #1 | 78 ms | 60 ms | 29 ms (1 over the 20 ms budget) |
| B→A #1 | 79 ms | 63 ms | 20 ms |
| A→B #2 | 74 ms | 58 ms | 18 ms |
| B→A #2 | 76 ms | 59 ms | 17 ms |

So **three quarters of the lead is `commitDelayMs`** — React rendering the incoming space before the swap commits — and the deck's own share after the commit is 14–18 ms, which is one period. The gap clauses pass throughout; only the lead is red. This is the same class as the fold's 11–19 ms lead and the departure's 24–33 ms: a React commit standing between the gesture and the first frame. Unlike those two it is *entirely* pre-commit, so nothing after the arm can move it — the lever is rendering less of the incoming space before the swap, which is the pane-chrome grain and the Beat primitive's question rather than this pass's.

### `at0652`'s loops, priced one at a time

[F05]: the cost clause was one aggregate `rest()` with the dot and the wave both up, and an aggregate under the floor says the pair costs nothing without saying either one does. Each family is now silenced in turn with the product's own `--tug-loop-iterations: 0` knob, the census proves the switch took, and the survivor is priced alone.

**Separating them found a cost the aggregate had been hiding.** On one bound Session card with a turn in flight, against an idle floor that read **0 updates/second, 0.0 ms busy**:

| Reading | Running loops | Updates/second over the floor | Busy |
|---|---|---|---|
| Card idle (the floor) | none | 0 | 0.0 ms |
| The wave alone (14 dots stood down) | `tugx-progress-wave-0/1/2` | **2** | 6.0 ms |
| The dot alone (2 waves stood down) | `tugx-progress-pulsing-dot-breathe`/`emit-expand`/`emit-fade`, 3 each | **1** | 3.0 ms |

Both are red against a floor of zero, and the wave is the larger of the two. Two things are owed before either number is acted on. The floor read exactly zero on this run where past runs did not, so part of the margin may be the floor rather than the loops — the comparison wants a repeat. And the aggregate leg never ran on this run, the wave's red throwing above it, so there is no same-run aggregate to set the two against. What is certain is the shape: a per-loop reading is red where the aggregate was green, which is precisely what [F05] said an aggregate could hide.

### The caret is owed, and says so where it counts

`at0652`'s caret clause was a `note()` inside a passing test — read, not claimed. It is now a `test.todo` naming the fixture reason: no app-test card takes real keyboard focus, so `.cm-focused` never sets and the caret layer mounts with `animation-name: none`. What closes it is a fixture that can take real keyboard focus; building one is its own question.

### An all-suspended `at0643` run is red

It used to be a second `note()` inside a green test — a test reporting its own vacuity and passing anyway. A green nobody can tell from a green that measured something is worse than a red that says why. The cause is usually the harness window being occluded rather than the product, and the message says so; it is still not a pass.

### The two style reads on the activation path, priced

[B07] asked whether the two `getComputedStyle` calls in the activation path are worth their place, and set the bar at one millisecond. They are, and the reason is more interesting than the number.

`hiddenClaimReason` (`tugdeck/src/focus-transfer.ts` ~227) is the only style read on the path, and two call sites reach it: `mayDeferCommit` (~1276), which runs **before** the commit, and the post-claim miss check (~953), which runs **after** `applyBagFocus`. Marks were placed around each, and read at full `performance.now()` precision rather than through `clickTaskMarks`, which rounds to a tenth of a millisecond — the right resolution for the ordering claims the rest of this file makes, and the wrong one for a cost claim about a span this small.

Two legs: `at0622`'s four-up warm flip, which reaches `raiseCard` through the `focus-session-card` action; and a new temporary leg driving a **trusted CGEvent click** on an unfocused pane's title bar, which is the real pointer path. Synthetic `PointerEvent`s were written first and thrown away — the gesture interpreter reads a real press, and a leg that fakes one is measuring the fake.

| Reading | Warm flip | Pointer path |
|---|---|---|
| `mayDefer` span | 0 ms | **never called** |
| post-claim span | 0 ms | 0 ms |
| post-claim read reached | **no** | **no** |
| `applyBagFocus` result | `deferred` | `deferred` |
| enclosing span (flush open → post-claim read) | 5 ms | 9–12 ms |
| enclosing span, reads removed under `file probe` | 4 ms | 11 ms |
| `performance.now()` floor on this host | 1 ms | 1 ms |

Three findings, in order of how much they change the picture.

**The post-claim read does not run on either path.** It is gated on `applyBagFocus` returning `"applied"`, and on a Session card the resolution is `"deferred"` — so the branch is skipped and the 0 ms span is not a cheap read, it is no read. This is the finding that matters, because [B07]'s own fallback said that if the reads were too dear the answer was to drop the pre-commit one and "keep only the post-claim read" — which would have kept the one that never fires and dropped the one that does. A span of zero has two readings, and the instrument had to be taught to tell them apart before either could be trusted; the `taken` counter is what does it.

**The pointer path never calls `mayDeferCommit` at all.** `pane-focus-controller`'s `activate` calls `transferFocusForActivation` with no `deferCommit`, so the pre-commit read is reached only through `raiseCard` — the `focus-session-card` action, `test-surface`, and the Layout card. The "two style reads in the activation path" the task list names are, on the gesture a user actually makes, zero.

**The one read that does run is under the clock floor, and the probe agrees.** `performance.now()` is coarsened to a full millisecond on this host, so a 0 ms span is a bound rather than a measurement — which is why the falsifier is the `file probe` run with both reads removed, comparing the whole enclosing span. It moved 5 → 4 on the warm flip and 9–12 → 11 on the pointer path, inside the variance the readings show with the reads in. The mechanism is unsurprising once stated: the pre-commit read runs before anything in the task has touched the DOM, so style is clean and `getComputedStyle` is a cache hit rather than a forced recalc.

The reads stay, and [D204] carries the cost.

**What this does not cover, stated so a later reader does not over-read it.** The expensive case is a read that finds style dirty, and that is exactly the post-claim site — after a React commit — which never ran here. A change that makes `applyBagFocus` return `"applied"` on the activation path would put a forced recalc there, and this pass has not priced it. The task list also named the post-claim span as `tug:applyBagFocus-end` to `tug:flushSync-end`, which cannot be it: `tug:flushSync-end` is written at ~914, *before* `tug:applyBagFocus-end` at ~941. The span that brackets the read is `applyBagFocus-end` → `hidden-read-end`, and that is what was measured.

### The first readings at a landed sha, and what running alone changed

Every reading in Step 7 was taken on a dirty arc worktree ([F11]). This is the correction: seven files run **each alone**, then **once as one batch of seven**, on a clean tree at `588780c5a` — eight `dirty=0` rows in `apptest_results`, which are the first ledger rows this work has ever had at a landed commit.

| File | Alone | In the batch of 7 |
|---|---|---|
| `at0622-deck-settle-frames` | FAIL 11/16 | FAIL 12/16 |
| `at0566-three-beat-settle` | FAIL 0/1 | FAIL 0/1 |
| `at0605-still-crossing-deliveries` | FAIL 0/1 | FAIL 0/1 |
| `at0643-workspace-switch-cadence` | FAIL 0/1 | FAIL 0/1 |
| `at0652-loop-cost-and-life` | **PASS 1/1** | **FAIL 0/1** |
| `at0649-focus-claim-visible` | PASS 1/1 | PASS 1/1 |
| `at0650-picker-present-first-responder` | PASS 1/1 | PASS 1/1 |

**`at0652` is green alone and red only in a batch, and the baseline that called it "red by design" was wrong.** Step 5 priced the dot and the wave separately and the arc recorded both as deliberate reds — the wave reading 2 updates/second and the dot 1 against an idle floor of 0. Run alone at a landed tree the file passes outright. The bar is not an absolute floor but a **delta against the same card's own idle control taken in the same run**, and alone both readings are 1: `rest, card idle` reads `updatesPerSecond: 1`, `rest, wave alone` reads 1, so the difference is 0 and the clause holds. In the batch the idle control reads 0 while the wave second reads 1, and the same clause fails on a difference of 1. What moved is the control, not the wave. This is the case the project's own rule names — green alone and red only in batches is contention — and the correct reading is that **step 5's two `at0652` reds were an artifact of a dirty tree and a shared machine, not a finding.** The `at0643` red beside it is not: it fails alone too, at 80 ms against a 17 ms period.

**`at0605-still-crossing-deliveries` is red alone, and it is the doctrine's own gate.** Its join leg reads B's composer bottom 3.9 px off its frame's bottom edge against a 1.5 px bar — the `data-still-anchor="bottom"` behaviour that `tuglaws/animation-doctrine.md`'s still-crossing paragraph asserts one sentence before citing this test as the gate. Red for 18 recorded runs across batches of 1 to 46, last green 2026-09-26 at `350eaa76d`. The doctrine now says so at the citation rather than pointing at a green that is not there. Note what the failure order costs: once the join clause fails, the stack and split no-delivery clauses are not separately reported, so what that paragraph can claim as verified is narrower than the red alone suggests.

**`at0566` fails alone on the same clause it fails on in the batch** — arrival, a top inside B moving 1.93 px relative to its frame during the move against a 1.5 px bar. Last green 2026-09-30 at `09d8f0e56`, which is mid-arc, so [F11]'s "was not re-run" is now answered: it is red at a landed tree, on one clause, by 0.43 px.

**`at0643` fails alone at 80 ms and in the batch at 71 ms**, both against one derived display period of 17 ms, with 63 and 54 ms of it React's render phase before the swap commit. This is the tightened bar from step 5 doing its job, and it is a red to record rather than a bar to move.

**`at0622`'s failing legs rotate between runs at one tree, and the count is not the reading.** Alone it read 11/16 and in the batch 12/16, and the two runs do not fail the same set: the warm flip failed alone on `moveFirstPaintDelayMs` (34 ms against 17) and in the batch on the gap (2.41 frames against 2); the fold failed alone on the gap (1.06 frames against 1) and in the batch on the lead (19 ms against 17); `go-to-slot home` failed alone (19 ms against 17) and passed in the batch. Only `disappear` (2.76 and 2.71 frames against 2) and `sidebars show` (3.18 and 3.41 against 2) failed the same way in both. Those last two are the reds Step 10 attributes; the rest are edges sitting within a millisecond or a frame of their bars, and a single run's pass count says less about this file than the leg-by-leg comparison does.

**What this closes and what it does not.** [F11] is closed: the ledger now has rows at a landed sha, every red above carries a history line, and `at0566` and `at0605` have been read at a landed tree rather than assumed. What it does not close is any of the four genuine reds — `at0605`'s join, `at0566`'s arrival, `at0643`'s first paint, and `at0622`'s departure and show-rail gaps — and none of their bars was moved.

### The departure and the show rail, attributed

These two are the only legs of `at0622` that failed the same way alone and in a batch, so they are the file's standing reds rather than edges that rotate. Both are now named. The instrument is the commit census (`window.__tugCommits`) and the click-task marks, read on each leg and left on it — `reportB09` prints the bar, and the two censuses print beside it, so the next reader re-reads the same rows rather than rebuilding the probe. Every `t` below is milliseconds relative to `tug:arm-end`.

**The departure: pane chrome re-rendering, inside the settle, because closing a pane renumbers every surviving pane.** The leg read `longestGapMs` 39 over 2.29 frames with one gap over a frame; `tug:first-tick` at +1 and `tug:last-pass` at +13. Two commits dominate the window and they account for it:

| t | fibers | performed | what |
|---|---|---|---|
| +14 | 2947 | **1828** | `TugConfirmPopover2` / `TugPopover2` / `TugPopoverContent2` / `TugPopoverAnchor` / `TugTooltip`, and `TugButton2` labelled *Close card*, *Alone in this place*, *Stack of 2 cards*, *In position 4 — move this card*. Top: `Presence` 94, `PopperAnchor` 92, `Popper` 90, `PopperProvider` 90 |
| +21 | 2551 | 903 | `PlaceMark` 84, `PlaceGlyph` 84, `StackGlyph` 63, `Rail` 30, `LayoutPlaces` 27 — the Layout card's place marks |

**It is re-rendering, not mounting**, and the labels say why: closing a pane changes every surviving pane's *position* label — "In position 4 — move this card" becomes "In position 3" — and its stack label, so each remaining pane's whole rollup popover tree re-renders. 1828 of 2947 fibers performed work for a change that is two strings per pane. The +21 commit is the Layout card, and that one is **legitimate**: a close really does change the places, so `useStoreDerived` correctly finds the derivation unequal and re-renders it. Both land **inside** the settle window, in its first 25 ms, which is exactly where the gap sits; a tail of 500–1300-fibre commits runs out to +64. The chain is visible in the marks: `tug:react-notify` at [-10, 17, 43], each notify producing its deferred commit a few milliseconds later.

**The show rail: the rail's contents mount inside the gesture.** The leg read 3.35 frames with one gap over a frame, `firstPaintDelayMs` 8, and 25 off-curve ticks; `tug:first-tick` at +1 and `tug:last-pass` at +29. Three heavy commits, not one:

| t | fibers | performed | what |
|---|---|---|---|
| +33 | 4341 | **3898** | jots rows (`Delete jot` / `Copy jot`, twelve pairs) and the sessions list. Top: `span` 899, `polygon` 255, `react.context` 198, `div` 150, `svg` 123 |
| +39 | 3135 | 1126 | `PlaceMark` 84, `PlaceGlyph` 84, `StackGlyph` 84, `Rail` 32 |
| +49 | 2752 | 972 | the same place-mark tree again |

**The +33 commit is a mount**, and the ratio is the tell: 3898 of 4341 fibers performed work — ninety per cent of the tree — and the top counts are host elements (`span`, `polygon`, `svg`) rather than components, which is what a subtree entering the document produces rather than one re-rendering. Showing a rail mounts its entire contents, and it does so **four milliseconds after the Last pass**, squarely inside the settle. The Layout card's place marks then re-render **twice more**, at +39 and +49, and the tail runs to +136.

**Neither cause is one line, so the named cause is the deliverable and no fix was landed.** Each lands on work the program above already names, which is the useful part of the attribution:

- The departure is **program item 1** — *pane chrome subscribes to what it draws*. A commit that changed nothing a title bar draws must render no title bar; here a commit that changed two labels per pane re-renders every pane's popover tree. This is the same `useStoreDerived` grain that took the Layout card's eighty-four place marks out of the activation window, applied one level down, and the census now gives it a number to beat: 1828 performed fibres at +14.
- The show rail is **concept 3** — *nothing is created or destroyed inside a gesture*. The rail's contents should already stand when the rail is revealed, exactly as the doctrine's `departing`/`arriving` end state says for pane layers. A mount of 3898 fibres inside the settle window cannot be made cheap by deferring it; it has to not happen there.

What this does **not** establish: that removing either commit would bring its leg under the bar. The census names where the time goes and rules out the alternatives the gap counter cannot distinguish — a late start, a compositor stall, a fixture cost — but the bars were not re-read against a tree with either change made, because neither change was made.
