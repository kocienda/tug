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
