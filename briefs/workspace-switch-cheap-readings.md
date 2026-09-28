# Workspace switches: the readings

The working paper for the `workspace-switch-cheap` arc. Every step that claims a cost moved appends its reading here, with the deck's shape named beside the numbers — a reading without the shape is not comparable with the next one.

The brief's `[F01]`–`[F12]` are the "before" column and are not restated here. What this paper adds is that the same questions are now asked by instruments that ship: `space-switch-frames` for the frame cadence, `tugtool deck motion chains` for the read→write→read chains, `tugtool deck motion cost` / `layers` / `list` for the resting cost. The brief's numbers came from a scratch frame recorder and two `/usr/bin/sample` profiles; these are reproducible from the shell.

---

## Baseline — 2026-09-27, Step 1

### The deck the numbers are from

A debug instance (`debug-tugarc-workspace-switch-cheap`) grown from an empty boot with `new-text-card` and `new-space`, driven through the deck's own action vocabulary over the loopback eval door:

| | Workspace A (`a322f792`) | Workspace B (`87ad8556`) |
|---|---|---|
| Panes | 10 | 6 |
| Elements in the layer | 2,673 | 2,109 |
| Cards | 10 | 6 |

Whole document: **5,116 elements**, 462 stacking contexts, 2,131 render-layer candidates, max depth 28, mean depth 18.5.

**This is not the reference deck, and the difference is the point.** The user's own deck is 8 panes / 3 session cards / 13,846 elements in the shown workspace against 2 panes / 1,612 in the other, on a 2874×1640 viewport at 2×. This one is about a third of that in elements, and its cards are text cards rather than Session cards — so its absolute numbers prove that the instruments read and what they read, not that a switch on the reference machine is this cheap. The acceptance reading (Step 7) is the one that has to be taken on a deck of the reference shape.

**Occlusion first voided every rAF-derived reading, and that is worth writing down.** The first attempt reported zero rAF ticks in 3 s with `document.visibilityState === "visible"` and `document.hidden === false` — a covered window suspends the compositor's frame service while the page still calls itself visible, so no page-side reading can detect it. `cost --frames 60` did not merely read low, it returned HTTP 504: the eval call outlived its 30 s budget waiting for frames that were never coming. Every number below was taken after the window was brought to the front, with a 20-tick liveness probe (20 ticks in 323 ms, ≈17 ms/tick) run first to prove frames were being served. `suspended` on the record and `SUSPENSION_FLOOR_TICKS` exist for exactly this, and a run that reports `suspended` is void rather than green.

### `space-switch-frames` — eight switches, four each way

`__deckTrace.enable(true)` **and** `__deckTrace.enableKind("space-switch-frames", true)`, then `activate-space` alternating A↔B with 1.1 s between, which is longer than the 600 ms sampling window so no record overlaps the next.

**Spec S01 said the door was `enable(true)`; measurement says that door is too wide, and the spec's door is now per-kind.** Two findings, in the order they arrived.

First, the sampler must not run unasked. As first written the rAF loop ran on every switch and let `record` drop the row — which is right for a writer handing over numbers it already had, and wrong for one that runs a loop to PRODUCE them. Ungated, the loop pushed `at0622`'s move-beat gap bar from under two display frames to 2.12–2.29; a reverse-patch `file probe` of `settle-frame-probe.ts` and `deck-canvas.tsx` returned it to 8/8 green, which is what named the cause. An extra rAF subscriber is not free on a deck already mid-settle, and the animation doctrine's [D1] says so.

Second, the global flag is not the right gate, because it is shared. `at0622` calls `enableDeckTrace(true)` to read the SETTLE's frame record, so gating on `isEnabled()` armed this sampler inside a test measuring something else and the red survived the fix — measured, not reasoned about: same leg, same 2.12. So `deckTrace.enableKind(kind, on)` / `isKindEnabled(kind)` were added, default OFF and independent of the global flag, and the sampler asks for its own kind by name. The rule the two findings make together: **an instrument whose production costs frames is armed by the reading that wants it, never by a neighbour.** `at0622` is untouched — its assertions and its `enableDeckTrace(true)` are exactly as they were, which is the point.

**The eight readings below were taken before either gate existed, with the sampler running unconditionally — which is behaviourally the armed state.** The gate changed which switches arm the loop, not what the loop measures or how, so the numbers stand. The procedure at the end of this paper is the one to repeat them by, and it goes through the per-kind door.

| # | → | ticks | period | **firstPaint** | longestGap | overFrame | overBudget |
|---|---|---|---|---|---|---|---|
| 1 | A | 34 | 17.0 | **31.0** | 49.0 | 2 | 2 |
| 2 | B | 32 | 17.0 | **38.0** | 47.0 | 2 | 2 |
| 3 | A | 34 | 17.0 | **33.0** | 42.0 | 2 | 2 |
| 4 | B | 33 | 17.0 | **39.0** | 37.0 | 2 | 2 |
| 5 | A | 33 | 17.0 | **32.0** | 52.0 | 2 | 2 |
| 6 | B | 33 | 17.0 | **37.0** | 36.0 | 2 | 2 |
| 7 | A | 34 | 17.0 | **32.0** | 45.0 | 2 | 2 |
| 8 | B | 33 | 17.0 | **37.0** | 36.0 | 2 | 2 |

None suspended. `firstPaintDelayMs` is 31–39 ms — about two display frames from the swap commit to the first frame that could be served — and every switch carries two gaps over both the display period and the 20 ms budget, with the longest between 36 and 52 ms.

Read against the success criteria as they stand: the first-paint bar (under one 60 Hz frame period) is **not met** on this deck, by roughly a factor of two, and the "no gap over 20 ms" bar is **not met**, by two gaps a switch. Those are the numbers the later steps have to move, on a deck this size before the reference one.

### `space-switch-timing` and `space-quiet`, the same eight switches

| → | cards out/in | commit | restore | total | paint | quiet | via |
|---|---|---|---|---|---|---|---|
| A | 6/10 | 7 | 0 | 9 | 174 | 80 | quiet |
| B | 10/6 | 7 | 0 | 10 | 163 | 84 | quiet |
| A | 6/10 | 6 | 0 | 9 | 152 | 75 | quiet |
| B | 10/6 | 7 | 0 | 10 | 142 | 72 | quiet |
| A | 6/10 | 5 | 0 | 8 | 132 | 58 | quiet |
| B | 10/6 | 6 | 0 | 9 | 140 | 70 | quiet |
| A | 6/10 | 6 | 0 | 8 | 147 | 77 | quiet |
| B | 10/6 | 6 | 1 | 9 | 136 | 67 | quiet |

`commitMs` is 5–7 ms and `totalMs` 8–10 ms, inside the 4–8 ms band the brief's `[F01]` reports — the store swap is not the cost here either, so the arc's premise holds on this deck.

**And the two records disagree about the switch in exactly the way the criteria predicted.** `paintMs − totalMs` is 124–165 ms while `firstPaintDelayMs` is 31–39 ms. The first begins where the synchronous span ends and reaches the second rAF after phase 8; the second is the swap commit to the FIRST tick. So `paintMs − totalMs` is the larger number and it is not the freeze — it is the freeze plus the two frames after it plus the settling the quiet gate is waiting on. `firstPaintDelayMs` remains the bar.

The quiet gate closed on `quiet` on all eight, never on `bound`, at 58–84 ms — so the cover this arc retires is being held for around 70 ms per switch on this deck.

### Resting cost, at rest

- `cost --frames 60`: p50 **0.00 ms**, p95 1.00 ms, max 1.00 ms.
- `layers`: 5,116 elements, 462 stacking contexts, 2,131 render-layer candidates, max depth 28, mean 18.5, deepest stacking chain 7.
- `list`: **1** long-running animation — `tug-arc-track-breath` on `span.tug-arc-track-tick`, an `opacity` loop, which is compositor-only and not a violation.

This is the before column for Step 3's [Q03] reading.

---

## [Q01] — which writes re-dirty the arriving subtree between reads

**Answered by measurement, with `tugtool deck motion chains` armed across the eight switches above.** The reading: **47 chains over 4,000 entries in 114 tasks, TRUNCATED** — the log hit `CHAIN_LOG_CAP` partway through, so 47 is a lower bound and the count is not comparable across runs of different lengths. What IS usable is the ranking, because the sites at the top of it were at the top before the cap was reached.

Ranked by the read that pays, with the writes that dirtied style before it:

| chains | getter | the read that pays | the writes before it |
|---|---|---|---|
| 15 | `offsetWidth` | `tug-pane.tsx:203` in a layout effect, under `commitHookLayoutEffects` | React's own `setValueForAttribute` / `setValueForKnownAttribute` / `setProp` |
| 9 | `clientHeight` | `tug-list-view.tsx:1027` in a layout effect | `tug-pane.tsx:201`, `use-responder.tsx:122`, `use-focusable.tsx:43`, `use-focusable.tsx:47` |
| 6 | `scrollTop` | `TugListView2` at `tug-list-view.tsx:376` — **during render**, under `renderWithHooks` | React's attribute writes |
| 5 | `scrollTop` | `applyRestoreTarget` at `smart-scroll.ts:629`, from `tug-list-view.tsx:1332` | `tug-list-view.tsx:1329` |
| 4 | `clientHeight` | `_placeRunHeight` → `getColumnRunHeight` at `deck-manager.ts:3377`, from `layout-card.tsx:169` inside a `useMemo` | React's attribute writes |
| 3 | `clientHeight` | `tug-list-view.tsx:1305` in a layout effect | `tug-list-view.tsx:1268` |
| 2 | `clientHeight` | `_placeRunHeight` → `getRailRunHeight`, from `deck-canvas.tsx:1941`'s `arm` via `deck-manager.ts:712` | `deck-manager.ts:711` |
| 2 | `clientWidth` | `_flowBandEdges` → `_flowBandWidth` → `_flowRevealOffsetFor` → `_revealTerms` → `_commitStandardFirstResponderFlip` at `deck-manager.ts:3905` | `focus-manager.ts:2044`'s `applyProjection`, `responder-chain.ts:1135`'s `syncFirstResponderDomAttribute` |
| 1 | `offsetWidth` | `computeOccludedSet` at `pane-occlusion-controller.ts:72` | `tug-list-view.tsx:1329` |

**The finding, stated as the reading supports it and no further.** [Q01] offered two shapes: a handful of named effects writing inherited custom properties, or a pattern across the re-arm sites as a class. The reading is closer to the second, and it is a different pattern than the question anticipated:

- **The dominant writer is React itself, not our custom-property writes.** In five of the nine ranked sites the writes between the reads are `setValueForAttribute` / `setValueForKnownAttribute` / `setProp` — React committing attributes for the arriving subtree. `createAnimatedElementUpdate` and `CustomPropertyData::operator==` in `[F03]`'s stacks are consistent with that: an attribute write on an element is a style invalidation, and the arriving tree's attributes are written and its geometry read in the same commit pass. So the chains are structural to mounting a workspace, not a handful of misplaced lines.
- **The layout-effect reads are the fixable end, and there are few of them.** `tug-pane.tsx:203`, `tug-list-view.tsx:1027`, `tug-list-view.tsx:1305` and `smart-scroll.ts:629` between them account for 32 of the 47 chains, all under `commitHookLayoutEffects`, all reading geometry from inside an effect that runs while React is still writing attributes for its siblings.
- **Two sites read geometry outside a layout effect at all, which is the more serious shape.** `tug-list-view.tsx:376` reads `scrollTop` during **render** (`renderWithHooks`), and `layout-card.tsx:169` reads `clientHeight` inside a `useMemo`. A geometry read in a render pass cannot be batched with anything, because the pass it would batch with has not committed.
- **`deck-canvas.tsx:1941`'s `arm` pays too**, two chains through `deck-manager.ts:712` with the write immediately above it at `deck-manager.ts:711` — the narrowest chain in the reading and the one most clearly ours to break.

**What Step 5 inherits.** The ordering rule this implies is about a class of site (geometry read inside a layout effect on a subtree React is still committing), so on [Q01]'s own terms it belongs beside `[L23]`'s third-class rule in `tuglaws/` rather than being fixed nine times in place. The two render-pass reads are separate and are not an ordering problem at all. Step 5 should also re-take this reading with the cap raised or the window narrowed to a single switch, because a truncated log cannot say whether 47 is the whole population.

---

## Step 2 — the cover retired, the epoch left standing

### What came out, and what the sweep still finds

The crossfade, the frozen departing picture, the crossing layer state, its z tier (`8999`, now free) and the two freeze helpers are **deleted rather than disabled**, and `rg` over `tugdeck/src` and `tugdeck/styles` for every retired name returns nothing.

Over `tests/app-test` the same sweep returns **three lines in two files**, where the plan's checkpoint expected exactly one. Both deviations are correct and neither is a residue:

- **`at0587`, two lines** — a comment and the live `waitForCondition` on the crossing attribute, now vacuously true. [P09] forbids this arc editing that file and a Success Criterion is that its leg 4 is green *unedited*, so the dead wait stays until an arc that owns `at0587` removes it. The checkpoint said "one hit" and meant "one file"; the file carries a comment beside its wait.
- **`at0640`, one line** — the new test names the retired attribute on purpose, because its first claim is that no element ever carries it, and a claim that something never appears cannot be written without naming the thing. A checkpoint that forbade the name would make the claim untestable.

### The mark's ownership, which is the step's one real hazard

The old effect stripped `data-space-switching` unconditionally at the top of its body and then re-asserted it for the length of the hold — two owners across two consecutive windows. With no hold there is nothing to re-assert it, so an entry sweep would end the epoch in the very commit that opened it and hand every late re-arm to the imposer. The effect now never touches the attribute on entry or in its cleanup; only the gate, the bound and the deadline close an epoch.

**That removal opened a hole of its own, and it is closed here rather than left to the deadline.** The two paths where no swap happened — the first show, and a run where the workspace did not change — previously had their stranded mark swept by the same unconditional teardown. They now call the close explicitly, which is safe precisely because they are the complement of the path the sweep would be fatal on: a real epoch only ever opens on a run where the workspace changed.

### The bound moved from 200 to 400, and the argument changed with it

Under the cover the ceiling was the eye: the wait was *added* to a 240 ms dissolve and the pair had to stay inside the quarter second a single reveal gets. The cut removes that addend entirely, so the ceiling is gone and only the floor is left — what the arriving layer actually writes, which the recording measured at 73 ms for a composer's line box and 116 ms for the last pane rect **on the small workspace**. 400 gives the reference workspace's eight panes and three Session cards the same kind of margin 200 gave two panes. The asymmetry says round up: failing late costs a few frames of stood-down imposer on a deck the reader is already looking at, and failing early costs unasked-for motion.

`at0620`'s mirrored constant moved with it. That is not re-pointing another decision's pin: the file documents the constant as a hand-mirror of the module's, and the pin is the **relation** — the recorded span held against the module's bound plus its slop — which is preserved exactly.

### The app-test fan-out ratchet, and a number that was already over

`at0640` declares `deck-canvas.tsx`, because the switch layout effect lives there and in no narrower module. That took the hub's real fan-out to 27 against a recorded 25 — and **26 was already standing at this arc's base**: `at0632` declares the same file and arrived in `f98397bb2` without the number moving with it. The ratchet refuses an in-place raise however well argued, comparing against `git show HEAD`, so the key was deleted in one round and re-added at 27 in the next; the two-step is what the ratchet asks for and what puts the decision in the diff. The comment names which of the two increments is somebody else's, because a ratchet that swallows an unrecorded entry inside the next raise has stopped being one.

### The reading, on the same instruments and the same kind of deck

A fresh debug instance grown the same way: workspace A 12 panes / 3,003 elements, workspace B 6 panes / 2,400, whole document 5,737 elements against the baseline's 5,116. Slightly larger than the baseline deck, which matters for reading the table below — the arriving side is bigger, not smaller, so an improvement here is not a smaller workspace flattering the numbers. rAF proven live first (20 ticks), and the frame record armed by kind.

| # | → | firstPaint | longestGap | overBudget | paint | epoch |
|---|---|---|---|---|---|---|
| 1 | A | **24.0** | 47.0 | 2 | 159 | 71 settled |
| 2 | B | **30.0** | 53.0 | 2 | 132 | 59 settled |
| 3 | A | **27.0** | 20.0 | 0 | 118 | 47 settled |
| 4 | B | **32.0** | 19.0 | 0 | 127 | 51 settled |
| 5 | A | **26.0** | 37.0 | 1 | 143 | 63 settled |
| 6 | B | **30.0** | 23.0 | 1 | 131 | 53 settled |
| 7 | A | **26.0** | 59.0 | 2 | 127 | 47 settled |
| 8 | B | **29.0** | 19.0 | 0 | 122 | 48 settled |

Against the baseline, on the same instruments:

| | baseline (cover) | after the cut |
|---|---|---|
| `firstPaintDelayMs` | 31–39 | **24–32** |
| `longestGapMs` | 36–52 | 19–59 |
| `gapsOverBudget` | 2 on every switch | **0 on four of eight**, 1 or 2 on the rest |
| `paintMs` | 132–174 | 118–159 |
| epoch / cover span | 58–84 (`quiet`) | 47–71 (`settled`) |
| `commitMs` | 5–7 | 9–11 |

**What moved, stated no further than the reading supports.** First paint came down by roughly a fifth, and the switch's roughness went from two over-budget gaps on every single switch to none at all on half of them. Neither success criterion is met yet — the bar is one 60 Hz frame period for first paint and zero gaps over 20 ms — and nothing in this step claimed they would be: the cover was never the freeze, and `[F02]`'s click task is what Steps 5 and 8 are for. What this step removed is the *rough patch's* biggest contributor, which is what the numbers show.

**`commitMs` went UP, 5–7 to 9–11, and that is worth naming rather than smoothing over.** It is measured on a deck with 12 panes on one side against the baseline's 10, so part of it is the larger fixture. It is also still inside the brief's `[F01]` band of 4–8 only at the bottom edge, so a reading on the reference deck should re-check it; the arc's premise is that the swap is not the cost, and a `commitMs` that keeps climbing would be the thing that falsifies it.

**`longestGapMs`'s range widened rather than narrowed**, 19–59 against 36–52. The floor came down a long way — four switches now have their longest gap at 19–23 ms, which the cover never produced — and one switch reached 59. A single long gap in an otherwise clean run is what `[F06]`'s compositing rebuild looks like, and Step 3's `content-visibility` change is what is aimed at it.

**And `[F08]`'s prediction, which the step was told to check.** The plan expected roughly 149–160 ms to first paint on the small workspace and 312–323 ms on the big one. `firstPaintDelayMs` reads 24–32, which is nowhere near either — and the discrepancy is a units mismatch rather than a finding. `[F08]` was taken on the user's real deck with a scratch recorder measuring the gesture to the departing picture being gone, which is the span this record calls `paintMs`; `paintMs` here is **118–159**, sitting right at the bottom of the predicted small-workspace band on a deck a third the reference size. So the prediction holds where it is comparable, and `firstPaintDelayMs` is the narrower number the criterion asks for. Worth recording because the two are easy to read as the same quantity and are not.

### Resting cost, and the chains

- `cost --frames 60`: p50 **1.00 ms**, p95 1.00, max 2.00 — against the baseline's p50 0.00 / p95 1.00 / max 1.00, on a deck 12% larger in elements. Inside the breaker's budget either way.
- `layers`: 5,737 elements, 531 stacking contexts, 2,342 render-layer candidates. The crossing wrapper's stacking context is gone, but this deck is also bigger, so the comparison is not clean — Step 3's [Q03] reading is where resting cost is held to a before and after on one unchanged deck.
- `list`: still exactly **1** long-running animation, the same compositor-only `tug-arc-track-breath`. No new loop, which is the assertion this step owed.
- `chains` over the eight switches: **35 chains over 4,000 entries in 80 tasks, TRUNCATED**, with the same site at the top — `tug-pane.tsx:203`'s `offsetWidth` at 16. The ranking did not move, which is the expected answer: the cover was never one of [Q01]'s writers, and Step 5 is what acts on that list.

## Step 3 — a hidden workspace keeps its render state

Taken 2026-09-27 and 2026-09-28 on the `debug-tugarc-workspace-switch-cheap` instance, which serves the frontend over Vite HMR, so every form below was measured live without a rebuild. **One deck, three workspaces mounted** — 8,711 elements, layers of 2,966 / 3,006 / 2,403 — remounted whenever a reload dropped one, and every before/after in this section was taken on it. `Main` is not mounted at boot, so it is visited once and left before any reading.

### What the engine does, measured first

This is the fact everything else follows from, and it contradicts the plan. On a synthetic probe — a 300x200 div with a 100x50 child, nothing else involved:

| Parent's state | child `offsetWidth` | child `getClientRects()` | child `checkVisibility()` | `elementFromPoint` over the child |
|---|---|---|---|---|
| default | 100 | 1 | `true` | the child |
| `content-visibility: hidden` | **100** | **1** | `false` | the parent |
| `display: none` | 0 | 0 | — | — |

`CSS.supports("content-visibility", "hidden")` is `true` and the computed value reads back `hidden`, and the property does real work: the child stops being painted and stops being hit-tested. What it does **not** do on WebKit 605.1.15 is skip the contents' LAYOUT or still their ANIMATIONS. The child keeps its box; a loop under it keeps running (16 of the deck's 24 `tug-arc-track-tick` elements sit in hidden layers, `display: none` ran 0 of them, the bare `content-visibility` form ran 2).

So [P07]'s two stated implications — "a hidden layer's subtree still has no boxes" and "a subtree the engine declines to render does not run its animations" — are both false here, and [P08]'s fork collapses: [P07]'s form IS Form B on this engine, with paint and hit-testing skipped on top. The premise the plan wrote both propositions on is not available, and the question became which of two things to keep — `display: none` and its rebuild on every re-show, or a laid-out hidden workspace and the pin that said it was boxless.

### The decision, and whose it was

`at0587`'s leg 4 asserted that a hidden workspace's panes have no client rects — `workspaces-refine` `[B06]`'s pin, which [P09] forbade this arc from re-pointing. The arc stopped on that and put the choice to the user with the numbers, and the direction given was: *the most solid, comprehensive, robust and correct implementation that gets to smooth workspace transitions.* That settles it. A workspace that keeps its render state is what smooth transitions are built on — both layers live, laid out, with nothing to rebuild during a motion — and the pin was on `display: none`'s side-effect rather than on [B06]'s decision. [B06] said a visited workspace stays MOUNTED and is not rebuilt; leg 4's "no boxes" was one way that used to be true, and it is re-pointed at what the decision meant: `checkVisibility()` false — laid out, unpainted, unreachable. The decision is unchanged; the proxy is replaced. Three other files carried the same proxy and moved the same way: `at0640`'s sampler (this arc's own), `at0602`'s "no layout to measure" premise (this arc's own re-pointing, from Step 2), and `at0587`'s header prose.

### What shipped

```css
.tug-space-layer {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  visibility: hidden;
  content-visibility: hidden;
  pointer-events: none;
}

.tug-space-layer[data-space-shown] {
  display: contents;
  visibility: visible;
  content-visibility: visible;
  pointer-events: auto;
}
```

[P07]'s form, plus `pointer-events: none` said out loud. `inset: 0` holds the wrapper at the canvas's size against the `contain: size` that `content-visibility` implies — measured: the hidden wrapper is 2501x1193, the canvas, not collapsed — and the panes inside it resolve their absolute positions against it and land on the same pixels they would shown (`at0587`'s second test, the boot-vs-switch equality, green).

**And a mechanism that is not CSS.** Hidden loops have to be stilled — on the reference deck that is 67 loops ticking their style every frame behind a workspace nobody is looking at — and the obvious rule, `.tug-space-layer:not([data-space-shown]) * { animation-play-state: paused !important; transition: none !important }`, was written, measured and REMOVED. A universal descendant rule keyed on the layer's attribute restyles both layers whole on every switch:

| ten switches, same deck | `firstPaintDelayMs` | `longestGapMs` | `gapsOverBudget` | `paintMs` |
|---|---|---|---|---|
| form with the `*` rule | 33–38 | 26–61 | 1–3, every switch | **256–289** |
| form without it | 32–37 | 17–60 | **0 on five of ten** | 145–209 |

About 100 ms of post-swap work per switch, from one rule — the opposite of what this arc is for. So the pause is taken on the loops rather than declared over the subtree: `space-layer-loops.ts` pauses every INFINITE loop under a hidden layer from the canvas's switch effect (the departing layer's, in the commit that hides it) and resumes exactly those it paused when their layer is shown, declining the resume if the element's computed `animation-play-state` says the breaker is holding it. A loop that starts in the dark is caught by a delegated `animationstart` listener on the canvas. Finite animations — a settle's tween, an entrance — are never paused, because somebody is awaiting their `finished` promise and a paused one never pays it. Transitions are not suppressed while hidden; a finite one runs out unpainted, and the epoch's own `transition: none` in `chrome.css` covers the frames that matter. Nine unit tests over fakes in `space-layer-loops.test.ts`; `at0641`'s leg 4 installs a probe loop under each layer AFTER the switch and reads `paused` under the hidden one and `running` under the shown — the listener's case, on the live deck.

### The four invariants, each read off the live deck (`at0641`)

- **Paint:** 3 of 3 hidden panes have boxes (asserted positively — a return to `display: none` goes red here), 0 of 3 report `checkVisibility()` true; 3 of 3 shown panes do.
- **Pointer:** 6 probes over hidden panes' centres and title bars, 0 answered inside a hidden layer, 0 answered with the hidden wrapper itself.
- **Focus:** nothing in a hidden layer is active after a switch, and a hidden `.cm-content` focused by hand leaves `document.activeElement` on `BODY`.
- **Motion:** as above.
- **Broadcast:** one `delete-space` request, one confirm, workspace count unchanged — `useSpaceLayerShown()`'s guard reads a context, not the stylesheet, and is unaffected in principle and asserted anyway.

The first-mount fade is `at0589`'s subject and `at0589` is green UNEDITED under the new rule (its header prose corrected only), which is that leg re-run against the new mechanism; `at0641` does not restate it, and does not name `session-card.tsx`, which is at the fan-out ceiling.

### The scroll-restore red, resolved by not restoring

`at0587`'s leg 5 was red on the arc branch from `15530250d` — 64 px off in one run, 1934 in another — and `at0578`'s leg 4 went red the same way under the new form. A scratch sampler over the real sequence settled both: the test writes `scrollTop = 1246`, and **before any switch** the scroller already reads **1310** — the transcript's late row measure grew `scrollHeight` by ~65 px and the list view kept the anchored row in place, as it should. Then 1310 hidden, 1310 shown: the layer preserves the position exactly, because nothing ever disturbed it.

What the tests were matching under `display: none` was the RESTORE path replaying the raw 1246 on the re-show — the wrong number, undoing the anchor correction — and Step 2's cut made that replay race (anchor restore vs follow-bottom; 1310 or 3180). Under the new form there is no restore on a switch at all, and the honest reference for "the same pixel" is the position at the moment the switch is dispatched. Both tests now read it there. `at0587` lands at 1310 on both sides; `at0578` passes with its claim unchanged.

### [Q03] — resting cost: it did not move

Three `cost --frames 60` runs each side, same deck, three layers mounted:

| | p50 | p95 | max | `probe().budgetMs` |
|---|---|---|---|---|
| `display: none` | 1 | 1 | 1–2 | 16 |
| shipped form | 1 | 1 | 1 | 16 |

`layers`: 8,711 elements both sides; render-layer candidates 3,617 -> **3,637**, stacking contexts 857 -> **878** — the three hidden wrappers becoming positioned boxes, about 0.6%. `list`: 3 long-running entries, the two under hidden layers `paused`, the shown one `running`. So Risk R01 did not fire, and the checkpoint's "no animation that was not there before" reads as: the two loops that `display: none` used to hide from `getAnimations()` are now listed, and stilled.

One thing seen and not acted on: after ten switches `getAnimations()` under the hidden layers holds ~160 `finished` animations — settle tweens retained with their fill. They cost nothing running, and `motion list`'s `retainedTransitions` is the instrument for them; noted for Step 7.

### [Q02] — the flip: small, real, and noisy at this deck size

Ten switches each way, alternating a 12-card and a 6-card workspace, `display: none` restored live by an override on the same page:

| | `firstPaintDelayMs` | `longestGapMs` | `gapsOverBudget` | `commitMs` | `paintMs` |
|---|---|---|---|---|---|
| `display: none` | 33–40 (one 75) | 28–57 | 1–2, every switch | 8–12 | 147–199 |
| shipped form | **28–35** (6-card arrival 28–30) | 23–70 | 1–2, every switch | 5–19 | 141–178 |

`firstPaintDelayMs` improved by about 5 ms and is still ~two frame periods against a Success Criterion of one. The over-budget gap did not reliably disappear: a morning run under the same form read **0** over-budget gaps on every 6-card arrival, the rule-less run read 0 on five of ten, and this final run reads 1 on every switch. That is a compositing rebuild that is sometimes gone and sometimes not on a deck a third of the reference size, and it is recorded as that rather than as a win. The click task is unchanged — `chains` over four switches reads **38 chains, 4,000 entries, 58 tasks, truncated**, `tug-pane.tsx:203`'s `offsetWidth` still first at 11 with a write at `tug-pane.tsx:201` above it — and that is Step 5's subject. No `/usr/bin/sample` profile was taken this step: the chains probe is the shipping instrument for the same question and it says the ranking did not move.

[Q02]'s second wrapper form — every wrapper permanently boxed, shown state `position: absolute; inset: 0` — was not tried here. It does not answer anything this step measured, and it is the shape motion design wants (two live boxes to animate between), so it belongs with that work.

### What Step 4 inherits

Form B is the measured reality: a hidden measurement is real again. The five `useSpaceLayerShown()` gates still stand and still arm on the shown transition — nothing in this step touched them — and the comments at those sites (`tug-pane.tsx`, `tug-sheet.tsx`, `tug-prompt-entry.tsx`, `session-card.tsx`) and [L23]'s third-class paragraph still say `display: none`. Step 4 is where they are settled: the gates can go, and every re-arm they guard is a late write the epoch exists to hide, so their removal is also a shorter click task.

## Step 4 — the re-arm rule, settled on what the engine does

Step 3 left one decision open on purpose: [P08] said a hidden measurement is still a zero under `content-visibility: hidden`, and Step 4 was to read Step 3's numbers and choose between Form A (the gates stay, the law gains the reason) and Form B (the gates go). Step 3's engine reading already answered the premise — the hidden layer keeps its layout, so a hidden measurement is real — and this step took the two further readings the choice actually turns on. Neither was in the plan.

### Three facts, read off the debug deck

| Reading | What it said |
|---|---|
| `getBoundingClientRect` / `offsetWidth` under a hidden layer | Real. Every hidden pane's title-bar controls read a width; every editor row reads its height (`20.14` on the Main deck, hidden and shown alike). |
| `ResizeObserver` on an element under a hidden layer | **Silent.** No initial observation, and nothing after the element was grown from 50 to 80 px, for as long as the layer was hidden. On show it delivered **once**, with the current size (80), while the layer was shown — and the controls element observed alongside it delivered its shown width in the same delivery. ~160 ms after the dispatch, which is the switch's frame. |
| `commitStyles()` on a finished animation under a hidden layer | Does not throw. `checkVisibility()` false on the same element. The blank-Session-card road [L32]'s clause was written from is closed by the CSS form itself; the ownership stays because it closes every other road too. |

Together: the engine withholds **delivery** from a hidden subtree, not **geometry**. An observer-backed measurement therefore needs no gate at all — it reads the box when the box is on screen, in the frame's own rendering steps, after layout and before paint — and a synchronous read in a layout effect was never buying anything a delivery does not, except a forced layout inside React's commit.

### The finding the plan did not have: a hidden layer stands unarranged

The same deck read, hidden then shown, for every pane of the parked Main workspace:

| Pane | Hidden rect (x, y, w, h) | Shown rect | Controls width hidden → shown |
|---|---|---|---|
| `1844c5d0` | 100, 100, 800, 1200 | 1269, 5, 800, 1156 | 62 → 118 |
| `47bd8627` | 130, 130, 800, 1200 | 464, 5, 800, 1156 | 62 → 118 |
| `5b9239b0` | 40, 40, 800, 1200 | −341, 5, 800, 1156 | 62 → 118 |
| `5ea5c636` (rail) | 8, 8, 420, 1177 | 2081, 777, 420, 389 | 28 → 56 |
| `98b77957` (rail) | 8, 8, 420, 1177 | 2081, 0, 420, 389 | 28 → 56 |

The hidden rects are the panes' **free** rects — the cascade defaults and a rail at its stored size — and the shown ones are the imposition's. `DeckCanvas` withholds every arrangement prop from a layer that is not shown (`placement`, `slotStack`, `columnMember`, `columnMode`, `arriving`, `contentWidthPx`, `sidebarStack`, and the handlers), and the rail-inset variables the imposition's `calc()` chain resolves against are written on the canvas from the active deck alone. So a switch re-renders every pane in **both** layers — the arriving one gains its arrangement and is laid out from cascade to imposed, the departing one loses its arrangement and is laid out back to cascade, unpainted — and that, not the five measurement gates, is the largest late write the epoch hides. The controls width differs for the same reason: the slot badge and a second tooltip anchor render only with the arrangement, so a parked title bar is narrower than the same bar shown.

Under `display: none` withholding the arrangement cost nothing, because nothing was laid out. Under the form Step 3 shipped it costs a full layout of the hidden layer at the wrong geometry, and then a second one on arrival. Giving a hidden layer its live arrangement is a per-layer refactor of the canvas's derivations and its variable writer, and it is the strongest form of what Step 5 was written to do ("one style resolve on arrival"): a pane that is already standing where it will be shown has nothing to arrange, nothing to re-measure, and nothing to re-render. It is recorded here as Step 5's subject rather than taken in this step, and the plan's Step 5 tasks — reordering reads ahead of writes inside the re-arm effects — are the wrong lever once this is known.

### The decision

Form B, on its actual premise: a hidden measurement is real, and observer delivery is what the shown transition provides. Every gate was read against the three facts and the arrangement finding, and each went one of three ways.

| Site | What it measures | Verdict | Why |
|---|---|---|---|
| `tug-pane.tsx` controls width | the controls' `offsetWidth`, published as a bar property | **gate and synchronous read both removed; observer-only** | The observer's first delivery is the shown frame's, before paint. The forced layout the sync read paid on every arriving pane — the chain the probe listed first — is gone with it. |
| `tug-pane.tsx` accessory height | the tab bar's rect height, into `minSize` | **gate and synchronous read both removed; observer-only** | Same, and the height does not depend on where the pane stands. |
| `tug-prompt-entry.tsx` line-box re-arm | dispatches `lineBoxRemeasure` on show | **effect deleted; the plugin's third occasion retired** | CodeMirror's measure cycle has no visibility check and a parked row has a real rect, so the first measure reads it. One transaction per composer per switch, gone. |
| `tug-sheet.tsx` two clamps | the clip's position against the canvas band | **gate kept, reason rewritten** | A parked pane is not where it will be shown (the finding above), and a move is not a resize, so no observer catches it. Goes when the arrangement is live. |
| `session-card.tsx` first-mount fade | not a measurement | **gate kept, reason rewritten** | An entrance is for a watcher. Not "no box to animate against" any more; motion for nobody, the same reason a hidden card declines a broadcast. |
| `cards-card.tsx` broadcast guard | not a measurement | **unchanged** | [B06]'s own rule. |

[L23]'s third class is rewritten to say this: a hidden layer keeps its layout, an observer under it is silent and catches up before the first shown frame paints, a mount-time measurement is observer-backed and takes no gate, an entrance plays none in the dark, and the one re-arm still owed on the shown transition is a reading that depends on where the pane stands. `useSpaceLayerShown()`'s doc says which three readers remain and why none of them is a measurement.

### The pin

`at0642-hidden-layer-measures.test.ts`: hidden panes' controls read a width and their rows a height; a probe observed inside a hidden pane and grown delivers nothing while hidden and exactly once on show, with its current size, in the first frame after the switch (frame placement voids rather than fails if rAF did not run across the switch, per [P10]); after the round trip every shown bar's published controls width equals its controls' `offsetWidth`, and every row height read in the dark equals the one read on screen. It covers `space-layer.ts` and `line-box-metric.ts`; `tug-pane.tsx` sits at the fan-out ceiling and is not named, exactly as `at0641` treats `session-card.tsx`.

### What Step 5 inherits

- The arrangement finding above, with the table, is the step's subject: per-layer derivations of the arrangement in `deck-canvas.tsx` (today every `layer.shown ? X : undefined` in the layer render), the rail-inset variables written per layer wrapper rather than on the canvas, and the departing layer's props left standing so a switch re-renders nothing. The comment on the withheld props still names the crossing layer Step 2 retired.
- When that lands, `tug-sheet.tsx`'s two gates go on the same reasoning as the title bar's, and `useSpaceLayerShown()` is down to the fade and the broadcast guard — both readable off the DOM at the moment they are needed, at which point the context and the re-render of every consumer on every switch can retire with it.
- The chain reading should be re-taken after this step: the controls-width read that topped the list is no longer a synchronous read.

## Step 5 — every layer arranged from its own deck

The plan's Step 5 was to reorder reads ahead of writes inside the re-arm effects [Q01] named. Step 4 removed most of those effects and found the lever the plan did not have: a hidden layer stood unarranged. So this step took the reading first, as the plan asks, and then pulled that lever rather than the plan's.

### The chain reading before, on the post-Step-4 tree

`chains` over four switches: **27 chains, 4,000 entries, 17 tasks, truncated** (38 in 58 tasks before Step 4). `tug-pane.tsx`'s controls read is gone from the ranking. What remains:

| chains | getter | site |
|---|---|---|
| 8 | `clientHeight` | `tug-list-view.tsx` layout effect |
| 6 | `scrollTop` | `tug-list-view.tsx` render |
| 7 | `clientHeight` | `_placeRunHeight` (`deck-manager.ts`), in the swap commit |
| 3 | `scrollTop` | `applyRestoreTarget` (`smart-scroll.ts`) |
| 2 | `clientWidth` | `_flowBandEdges` (`deck-manager.ts`) |

The list view's reads are scroll and viewport reads that fire when a transcript's pane changes size, and every arriving pane changed size on show — from its free rect to its imposed one. That is the arrangement finding, not a handful of misplaced lines.

### What shipped

- **`LayerArrangement`** in `deck-canvas.tsx`: one pure derivation of everything a deck's panes are arranged by — rails, columns, flow strip, every placement, the slot-stack, column and arriving maps, the z-order, the bullseye anchor. The shown layer derives it from the live `deckState`; every hidden layer from its parked record, cached by that record's identity (`arrangementOfParkedDeck`, a `WeakMap` — the spaces snapshot reuses each parked deck object, so it hits). The canvas body reads its own derivations off the same function, so there is one copy of the arithmetic.
- **`SpaceLayerWrapper`** owns each layer's div and writes that layer's arrangement variables on it — rail widths and insets, seams, strips, offsets, the flow strip — from the same function the canvas's own writer now calls (`writeArrangementVariables`). A custom property inherits through the hidden wrapper's box and the shown wrapper's `display: contents` alike, so a hidden pane's `calc()` chain resolves against its own rails rather than the shown deck's. The shown wrapper's values equal the canvas's, so nothing is written on a switch.
- **Every pane takes its placement, shown or not.** `placement`, `slotStack`, `columnMember`, `columnMode`, `arriving`, `contentWidthPx`, `sidebarStack`, `bullseye` and `bullseyeExit` come from the layer's own arrangement. Interaction stays shown-only: close, reveal, drop zones, merge.
- **`parkedDeck` keeps the strip offsets.** It stripped `flowOffset`, `columnOffsets` and `railOffsets` with the postures; a parked layer then stood at offset zero and the return's `activateCard` reveal slid every strip to the active card — on the reference deck, 346 px for the whole flow strip, in the frames after the switch. Kept, the layer already stands where the reveal will find it. `serialize` still omits them, so a restart still re-reveals; the pin in `spaces.test.ts` now says which fields are posture and which are standing, and why. This is a change to `workspaces-refine`'s List L01 decision, made here on purpose and recorded as this arc's.
- **`CardSlotBadge` answers for a card in a parked deck.** It found its host pane in the active deck only, so a parked title bar lacked its chip and gained it on show — 28 px of controls width, a bar re-laid out in the arriving frame. It now looks through the mounted parked decks for the deck that holds its card.
- **`onMoveToSpace` is given to every layer.** The title bar renders its move control on the handler's presence; a hidden pane cannot reach it.

### The geometry, read off the debug deck

Every pane of the parked Main workspace, hidden then shown, on the same instrument as Step 4's table:

| Form | Differing panes of 10 | What differed |
|---|---|---|
| Step 4's tree | 10 | rect (cascade vs imposed), height (1200 vs 1156), controls (62 vs 118) |
| Arrangement live, offsets stripped | 7 | x by exactly the flow offset (5/810/1615 vs −341/464/1269), controls (90 vs 118) |
| Offsets kept, move control everywhere | 7 | controls only (90 vs 118: the slot badge) |
| Slot badge answers for parked decks | **0** | — |

`at0642` now pins the last row: every hidden pane's rect and controls width equal the shown ones, on top of Step 4's three facts.

### The chain reading after, and why it is not the bar

`chains` over four switches: **61 chains, 4,000 entries, 32 tasks, truncated**. Higher, and the site on top is new: `applyRestoreTarget` (`smart-scroll.ts`) at 28, from a `useLayoutEffect` in `tug-list-view.tsx` with **no dependency array** — it runs after every render of every list view, reads `scrollTop`, and the probe counts each one that follows any write in the task. `CardHost` is not memoized, so a canvas render reaches every transcript in every layer; that was true before this step and it is not what the probe was written to find. The reading is recorded as a number that moved, with the reason, and the instrument that answers the step's bar is the next one.

### Where the switch's time actually goes

`/usr/bin/sample` of the deck's WebContent process across eight switches, 1 ms interval, inclusive counts of the heaviest WebCore phases on the main thread:

| samples | phase |
|---|---|
| 271 | `Document::updateLayout` — **forced from script** |
| 135 | `Style::TreeResolver::resolve` |
| 97 | `Page::updateRendering` (the frame's own steps) |
| 76 | `RenderTreeUpdater::commit` |
| 26 | `Style::Invalidator::invalidate` |
| 26 | paint |
| 12 | `RenderTreeUpdater::tearDown` |

The forced layouts are the largest single subtree, and their JavaScript callers are JIT frames the sampler cannot name. So the deck named them itself: the `clientHeight` getter wrapped for four switches, each read timed and attributed to its call site.

| ms over 4 switches | reads | max one read | site |
|---|---|---|---|
| 127 | 41 | 31 | `tug-list-view.tsx` layout effect (`el.clientHeight === 0` guard, then the viewport read) |
| 10 | 53 | 5 | `tug-list-view.tsx` render (`scrollTop`) |
| 7 | 8 | 2 | `_placeRunHeight` from the canvas's `placeRuns` |
| 3 | 37 | 1 | `applyRestoreTarget` |

**One read pays the whole layout, once per switch** — about 30 ms — and every other read is nearly free because that one already flushed it. The list view's layout effect is simply the first script to ask after the commit dirtied the tree.

### What dirties the tree, measured with a `MutationObserver`

Every DOM mutation under the canvas across one switch: **752**, and not one of them is a pane frame. They are the Workspaces card's rows, in all three mounted copies: slot chips rebuilt (`cards-row-slots` children replaced), their buttons' `disabled`, `aria-label` and `title` rewritten, rows re-flagged `data-cards-space-inactive`, plus `data-focused` on the arriving panes and the epoch mark. The chip churn is the card's correct behaviour — `SlotPicker` resolves its card against the active deck, so the rows of the two workspaces that changed hands flip between "placeable" and "not this deck's" — and it is exactly 48 chips per card, which is those two workspaces' rows. The two hidden copies do it for nobody; deferring theirs would move the same work onto the next arrival.

### The hiding form, tried three ways live

CSS edits hot-reload, so each form was measured on the same deck without a rebuild. `paintMs` is the switch's synchronous span to the double-rAF after it; the forced read is the list view's first `clientHeight`.

| Form | `paintMs` over 4 switches | forced read, max |
|---|---|---|
| Shipped: box hidden / `display: contents` shown, `visibility` + `content-visibility` | 161–182 | 31 |
| Boxed in both states, same three properties | 153–170 | — |
| Boxed in both, `content-visibility` alone | 155–164 | — |
| `display: contents` shown, `visibility` alone (no `content-visibility`) | 156–181 | 29 |
| Boxed in both, `visibility` alone | 122–163 | 20 |

The `display: contents` flip is what `RenderTreeUpdater::tearDown` in the profile is: the wrapper gaining or losing a box rebuilds every renderer under it, both directions. The inherited `visibility` flip restyles every descendant of both layers. Removing both is the last row, and it is the best form measured — but the gain is inside this deck's noise, the forced read stays because the Workspaces card's churn dirties layout whatever the wrapper does, and the boxed-in-both-states form is [Q02]'s and belongs with the motion design that will need a boxed wrapper anyway. The shipped form stands; the numbers are here for that decision.

### The bar, honestly

[B03]'s bar was zero read→write→read chains under the arriving layer. On this engine that bar cannot be met by reordering effects: the switch commit itself dirties layout — the Workspaces card's rows, correctly — and the first script read after it pays one layout, wherever that read sits. What this step removed is the thing that made the layout expensive and the frames after it busy: the arriving workspace no longer moves. `commitMs` 9–14 (up to 19 before), `firstPaintDelayMs` 25–36 (28–40 in Step 3), `paintMs` unchanged at 150–180 on the React development build this deck runs, whose render cost the sampler's unnamed JIT frames are. A production-build reading is Step 7's.

### What Step 6 inherits

- The one forced layout per switch is the list view's `clientHeight` guard in a layout effect, paid after the Workspaces card's churn. Moving it to the frame boundary (a `ResizeObserver` or a rAF read) would move the layout out of React's commit into the rendering steps, where the engine does it once anyway — the shape Step 4 gave the title bar. That is the candidate if the click task is still over a frame on a production build.
- The `useLayoutEffect` with no dependency array in `tug-list-view.tsx` (the `applyRestoreTarget` read) runs on every render of every transcript in every layer; with `CardHost` unmemoized, a canvas render is a transcript render. A memo boundary at `CardHost` is the structural fix — Step 6 tried it and took it out again, because these same per-commit effects turned out to depend on the canvas's commits reaching them; the layer boundary above the card is what stayed.
- The hiding form table above, for the motion design.
- `tug-sheet.tsx`'s two gates stay for the resize-while-parked re-solve; everything else that read `useSpaceLayerShown()` for a measurement is gone.

## Step 6 — the click task measured whole, and the deferral it did not take

`[B04]` is conditional: read the click task on the post-Step-5 tree, and either withdraw the step because the task is under a frame, or give React's commit a frame boundary after the store's. The reading below did neither, because it found the instruments had been reading the wrong span.

### The reading that decides the step, and what it was really measuring

Eight switches Main ↔ Workspace 1 on the debug deck, window front, rAF proved live (20 ticks in 315 ms). The plan's two instruments said what Step 5 had said: `space-switch-timing` `commitMs` 10–15 and `totalMs` 10–16, `space-switch-frames` `firstPaintDelayMs` 26–52. Read as written, the click task was about one frame and the step was a withdrawal.

It was not. A `MessageChannel` message posted from the dispatch — the first thing the event loop runs after the click task and everything it queued — arrived **143–169 ms** later, and a `requestAnimationFrame` requested before the dispatch ran at 130–150 ms. The task was ten times what the instruments said. Split with one attribute hook and one microtask, four switches:

| phase | how it was read | Main ← | W1 ← | Main ← | W1 ← |
|---|---|---|---|---|---|
| store's synchronous span | `dispatch` returns | 14 | 14 | 14 | 16 |
| React render phase | first `data-space-shown` write, minus the above | 59 | 59 | 58 | 63 |
| React commit + layout effects | `queueMicrotask` after the dispatch, minus the above | 70 | 64 | 73 | 61 |
| the rest of the task | `MessageChannel` post, minus the above | 10 | 13 | 13 | 14 |
| **the click task** | | **153** | **150** | **158** | **154** |
| first rAF tick | | 164 | 144 | 152 | 147 |

Two readings in this paper were wrong about where they stood, and the numbers above say by how much. `commitMs` was documented as "the `_flipFirstResponder` commit, including the synchronous subscriber notification React renders from" — React does not render inside that notify. A `useSyncExternalStore` change outside a React event schedules a sync-lane render and flushes it in a **microtask**, after `activateSpace` has returned: still in the click task, and entirely outside `totalMs`. And the frame sampler's `armedAt` is a layout effect on the swap commit, which lands after the whole render phase — about 75 ms into the task on this deck — so `firstPaintDelayMs` 26–52 was the commit's tail plus vsync alignment, and the freeze it was specified to contain was mostly behind it. `[F02]` stood the whole time: the frozen window is one click task, and on this deck it is about 150 ms, not 15.

### The deferral, and why it was not taken

`[B04]`'s remedy is a frame boundary between the store's commit and React's, "so the browser can paint before they run". The split shows what that frame would paint: the workspace being left, unchanged, since the store's commit moves nothing the reader can see. The 120 ms of render and commit would then run whole in the next frame's callback. That is the plan's own third task answered before the change was made — the cost would have moved, not gone, and the switch would have arrived one frame later for it. The withdrawal condition (task under a frame) was not met either. So the step was walked on what the split pointed at: the instrument, and the render.

### What shipped

**The instrument measures from the gesture.** `activateSpace` stamps its entry (`getSpaceSwitchStartedAt` on the store interface); the canvas's sampler passes it to `classifySpaceSwitchFrames`, which now measures `firstPaintDelayMs` from the gesture and reports the gap to the commit as a new field, `commitDelayMs`. A caller with no stamp gets the old reading with `commitDelayMs` at zero, and a stamp more than five seconds old is ignored as some earlier switch's. Unit test added. **Every `firstPaintDelayMs` in this paper before this section is commit-origin and reads about 75 ms low**; the column comparable across all steps is `paintMs − framePeriodMs`, which has always begun at the gesture.

**A memo boundary per layer.** Before touching the render phase, one more experiment: a switch to a freshly created, empty workspace — one rail card on the arriving side — cost render 56 / commit 103, and returning from it 64 / 80. The arriving workspace's size was not the cost. The cost was the canvas re-rendering every pane and every card host of every mounted workspace on every store commit, the hidden ones included. What shipped:

- `LayerPanes`, new in `deck-canvas.tsx`: one workspace's panes and card hosts, `memo`'d. A parked layer's props are all stable — its deck is the store's record, its arrangement is the per-deck cache from Step 5, it takes no handlers a hidden pane could reach — so a parked layer's subtree is skipped whole.
- The workspace list the title bar's move control offers was a prop threaded through every pane, and it changed on every switch; it broke the boundary for every layer at once. `CardTitleBar` now reads the spaces snapshot itself through `useSyncExternalStore`, and `TugPane` no longer takes `spaces` or `activeSpaceId`.

**Where the boundary holds, read off the fiber tree.** Across one switch on the three-workspace deck, the layer that stayed parked (Workspace 2, six cards) kept every prop's identity — arrangement, deck, store, both handlers — and bailed out. The two layers changing hands did not, and cannot as the canvas stands: `shown` flips, the shown-only handlers (`onRevealPane`, `dropZones`) come and go with it, the leaving deck is `parkedDeck`'s fresh copy and the arriving one is `_resolveShownArrangement`'s, so both arrangements are minted new. The boundary is therefore worth exactly the workspaces that stay parked — here one layer of six, and a deck with more workspaces gets more of it — and the two that switch still render whole, about twenty-two panes on this deck.

**A memo on `CardHost` was tried, measured, and taken out.** Its four props are primitives and the memo is correct by construction; with it, the task read 120–129 ms (render 40–47, commit 51–58). It came out because `at0580` — a card moved between workspaces keeps the reader's place — went red alone, and the cause was worth the round: the card bodies carry per-commit `useLayoutEffect`s with no dependency array, ten in `tug-list-view.tsx`, and some of them were doing real work on the canvas's commits reaching them. With the host memoized, a transcript's late settle — a 65 px growth of its content — ran on the reader's first scroll instead of on the commits after mount, and the anchor rode it (1246 → 1310, correctly, and away from the pixel the test remembered). One of those effects was made self-sufficient while this was being found and the fix stayed: the list view applies a restore target the moment it installs one. A second — a commit of the preservation hook's own after a consumer's `onRestore`, so its `onContentReady` flag is read without waiting on a parent — was tried and taken out: it lands a synchronous re-render inside whatever beat remounts a card, and `at0622`'s four-up move beat went from under two frames to 2.18 with it. The rest are the list view's debt, written at the `CardHost` declaration, and until they are driven by what they actually depend on the canvas's commits are part of what a card body is owed.

Six switches after, same method, with the layer boundary alone:

| phase | before (4 switches) | after (5, first after HMR excluded) |
|---|---|---|
| store | 14–16 | 10–11 |
| React render | 57–63 | 43–53 |
| React commit + effects | 61–70 | 70–77 |
| rest | 10–14 | 11–45 |
| **click task** | **150–158** | **145–176** |

The render phase moved by the six-card layer's share and the rest did not move at all — the commit's cost is the shown side's, and `rest` grew a second mode (42–45 on two of six arriving at Main) that the frame record below sees as its gaps. The corrected record, eight switches: `firstPaintDelayMs` **129–160**, `commitDelayMs` 98–123, zero to three gaps over the 20 ms budget per switch, longest 20–46, none suspended.

### The bar, honestly, with the right origin

Gesture to first paint is 129–160 ms on the development build, against a bar of one frame. It goes: the store's own span 10–11; React's render of the two switching layers' panes and the canvas body, about 48 (the layers that stay parked no longer render); the commit, about 73, of which the first forced layout is about 28 — the list view's `clientHeight` guard, paying the style recalculation the `visibility` flip forces on both subtrees plus the Workspaces card's row churn; the rest of the task, 11 to 45; then alignment to the next vsync. The React share is the development build's and shrinks on the production build Step 7 reads; the engine's share does not shrink with the build.

Two instrument notes for whoever repeats this. A tight `MessageChannel` loop or a 1 ms `setTimeout` chain, used to find long tasks, delays the first rendering update to the end of the whole task on this engine and voids the first-tick reading; the split above used one post and one microtask. And the React development build's fibers carry no `actualDuration` — the profiler timer is off — so a per-component breakdown needs the profiling build, which is why the split is by phase and not by component.

### What Step 7 inherits

- **The two switching layers' panes still render**, most of the development build's render phase, though nothing in them changes on a switch. The leaving deck is `parkedDeck`'s fresh copy and the arriving one is `_resolveShownArrangement`'s, so both arrangements are minted new; and the shown-only handlers (`onRevealPane`, `dropZones`) change identity with `shown`. Three things would let both layers bail out: a parking that keeps the deck's identity when it strips nothing, a re-solve that returns the same object when it moved nothing, and handlers given to every layer and inert when hidden, the shape `onMoveToSpace` already takes. Then the switch's render is the canvas body and two attribute flips. That is the next lever, and it was not taken in this step because it touches the store's solve path.
- **A memo on `CardHost` is blocked by the list view's per-commit effects**, above. Making those ten effects answer to their own inputs is the precondition, and the 25–30 ms the memo measured is what it is worth.
- **The first forced layout**, about 28 ms, is the style recalculation of both subtrees under the `visibility` flip, paid by whichever script reads first. Moving the read to the frame boundary moves it out of the task and not off the frame; the hiding-form table under Step 5 is where the cost itself would be argued down.
- **The rough patch after first paint** is one gap of 21–54 ms — the arriving layer's observers delivering on their first shown frame, the composer's measure cycles, the epoch gate — and it is unmeasured beyond that gap.
- **`at0622` is not a gate this arc can read.** Its move-beat leg sits at 2.18–2.30 frames against a bar of 2.0 on this machine, alternating green and red since before the arc's base and on `main`; recorded in the arc's `baseline.md`. Step 7's cadence tripwire should be written with the margin this one lacks.

## Step 7 — the acceptance readings, and what the motion design starts from

### Two builds, two decks, and which number came from where

Every number below says which of two readings it is, because they disagree by a factor of two and the difference is the build.

- **The live reference deck** — Main (10 cards), Workspace 1 (12), Workspace 2 (6); 6760 elements, 637 stacking contexts, 2758 render-layer candidates, max DOM depth 28. This is the deck `[B07]` asks for. It runs under `just app-debug`, which serves the frontend from the **Vite dev server** — `/@vite/client` and `/src/main.tsx` are the only two scripts on the page — so every live number here is a **React development build** number.
- **The grown fixture** — `at0643-workspace-switch-cadence.test.ts`: two workspaces, six session cards streamed 60 complete turns each, two text cards a side, 3232 elements under the workspace layers and 24 infinite CSS loops running across the switch. It runs in the app-test bundle, which serves `tugdeck/dist` from `vite build` — a **production** tugdeck bundle, on about half the reference deck's element count.

So the two readings are not comparable on deck size and not comparable on build, and neither alone answers the acceptance question. Together they do, which is the honest form of the answer.

### The live deck, eight switches, four each way (development build)

Main to Workspace 1 and back, the two largest workspaces, `space-switch-frames` armed by kind with `space-switch-timing` and `space-epoch` read from the same window. rAF proved live first — 20 ticks in 312 ms — so none of these is void.

| to | `firstPaintDelayMs` | `commitDelayMs` | `totalMs` | `paintMs` | `longestGapMs` | over 1 frame | over 20 ms | `epochMs` |
|---|---|---|---|---|---|---|---|---|
| Main | 129 | 96 | 12 | 169 | 40 | 1 | 1 | 70 settled |
| W1 | 130 | 99 | 12 | 172 | 41 | 1 | 1 | 71 settled |
| Main | 122 | 91 | 10 | 157 | 35 | 1 | 1 | 63 settled |
| W1 | 135 | 104 | 13 | 157 | 56 | 1 | 2 | 50 settled |
| Main | 115 | 83 | 8 | 163 | 48 | 1 | 1 | 77 settled |
| W1 | 143 | 110 | 12 | 180 | 46 | 2 | 2 | 68 settled |
| Main | 123 | 93 | 10 | 160 | 36 | 1 | 1 | 65 settled |
| W1 | 120 | 90 | 10 | 160 | 40 | 1 | 1 | 68 settled |

Gesture to first paint is **115–143 ms**, and **83–110 ms of it is React's render phase before the swap commit** — three quarters of the freeze, on the development build. The store's own span is 8–13 ms, unchanged from the baseline's 4–8 within the noise, which was `[F01]` all along. Every epoch closed on the frame counter rather than on the bound, on all eight.

**The rough patch is one frame, and the gap series says which one.** Two switches read out in full: arriving at Main, `[34, 17, 16, 17, 17, 16, …]` — thirty-three further gaps, none outside 16–18 ms. Arriving at Workspace 1, `[28, 16, 17, …]` smooth to index 17, then `55, 7, 4`, then smooth again. So the cost after arrival is the compositing rebuild of the arriving tree landing in the **first** gap, 28–40 ms, plus an occasional single late hiccup on the biggest workspace about 300 ms in. It is not a rough patch of 180 ms at 12–15 fps, which is what the brief recorded.

### The grown fixture, four switches (production bundle)

| switch | `firstPaintDelayMs` | `commitDelayMs` | `longestGapMs` | over 1 frame | over 20 ms |
|---|---|---|---|---|---|
| A to B | 67 | 58 | 25 | 0 | 1 |
| B to A | 54 | 47 | 23 | 0 | 1 |
| A to B | 51 | 44 | 19 | 0 | 0 |
| B to A | 54 | 47 | 18 | 0 | 0 |

**The production bundle roughly halves it, exactly as Step 6 predicted, and the composition of what is left does not change.** First paint is 51–67 ms on half the deck, and 44–58 ms of that is still the render phase. So the React share shrinks with the build and the *shape* of the cost does not: the render phase is still three quarters of the freeze on both builds, and it is still the lever.

### The profile: the four getters are gone

8 s at 1 ms over four live switches, on the deck's own WebContent process — found by launch time, because the host process and `tugcast` are both the wrong target and sampling `tugcast` by mistake yields a call graph made entirely of the dispatch queue waiting.

The four getter symbols `[F03]` named — `clientHeightForBindings`, `clientWidthForBindings`, `offsetWidthForBindings`, `scrollTopForBindings` — appear **zero times in the whole profile**. `Document::resolveStyle` totals 11 samples recursive-counted across four switches, `Document::updateLayout` 5, `updateLayoutIfDimensionsOutOfDate` 5. What dominates the engine's remaining share is compositing, not style: `RenderLayerCompositor::updateEventRegionsRecursive` 13, `computeCompositingRequirements` 8, `updateBackingAndHierarchy` 8 — which is the same 28–40 ms first gap the frame record sees, seen from the other side.

### Resting cost, at rest

`deck motion cost` over 60 frames on the live reference deck: **p50 1.00 ms, p95 1.00 ms, max 2.00 ms**, against the breaker's `budgetMs` of 16. `deck motion layers`: 6760 elements, 637 stacking contexts, 2758 render-layer candidates, max depth 28, deepest stacking chain 7. Nothing moved from Step 3's reading.

### The criteria, each with the reading that answers it

| Criterion | Verdict | Read on |
|---|---|---|
| Gesture to first paint under one frame period (17 ms) | **Not met.** 115–143 ms live (dev build), 51–67 ms on the production bundle at half the deck. Against a baseline freeze of 200–340 ms, so the cost is roughly halved rather than removed. | Live deck + fixture |
| No frame gap over 20 ms in the 600 ms after arrival | **Not met as written; met in the units it meant.** Live: one gap per switch over 20 ms, 35–56 ms, and it is always the compositing rebuild in the first gap. Fixture: `gapsOverOneFrame` 0 on every run, longest 18–25 ms. The 20 ms constant is three milliseconds over a 17 ms period — inside the jitter `GAP_TOLERANCE` (1.5 periods) already exists to absorb — so `at0643` holds the display-relative form and reports both. | Live deck + fixture |
| One `Document::resolveStyle` per switch; the four getters no longer dominate | **Met.** Zero samples of all four getters over four live switches; `resolveStyle` 11 samples recursive-total. `deck motion chains` reported zero chains under the arriving layer at Step 5. | Live deck |
| The crossing attribute, the z tier, the frozen picture and the quiet gate's cover role gone | **Met.** `rg` finds no live product reference (Step 2). | Tree |
| Resting cost does not move | **Met.** p50 1.00, p95 1.00, max 2.00 against a 16 ms budget; layer counts unchanged. | Live deck |
| `at0587`'s hidden-mount leg green, unedited | **Not met as written, and the departure is the arc's largest.** The leg is green at every checkpoint since Step 3, but it was RE-POINTED to get there: `hiddenPanesWithBoxes === 0` became `hiddenPanesPainted === 0`, read through `checkVisibility()`. [P09] forbade this arc touching that file, so the arc stopped, put the numbers to the user and was told to take the most correct implementation; Step 3's "The decision, and whose it was" is the record. The pin was on `display: none`'s side-effect rather than on `workspaces-refine` [B06]'s decision, and the decision — mounted, not rebuilt, not on screen — is unchanged. Two further edits to the same file are this arc's and neither is that pin: leg 5's reference pixel moved from `savedTop` to the scroll position read at the dispatch (Step 3's scroll-restore finding), and the header prose. | Fixture |

**Three of six criteria are not met.** Two of them are the same criterion, the third is the pin above — a departure decided by the user rather than a shortfall, and it is listed as unmet because the criterion was written as "unedited" and the file was edited. The switch is between two and three times cheaper than the baseline and it is not yet a cut the eye cannot see. Calling it met would require reading `paintMs − totalMs` instead of `firstPaintDelayMs`, which the plan's review already refused because that span begins where the freeze ends.

### What the motion design starts from

`[B06]` recorded that four scale-animation variants were tried over the switch as it stood and none could be smooth, because a short animation's whole life fell inside the rough patch. Those constraints now have this arc's numbers behind them:

- **Start on the first painted frame, not at the DOM flip.** The distance between them is 115–143 ms on the development build and 51–67 ms on the production one, and an animation started at the flip spends its first third unpainted. The frame record's `firstPaintDelayMs` is the number to start from, and its `commitDelayMs` says how much of the wait is React's.
- **Neither end promotes or demotes.** The canvas container is a compositor layer at rest and stays one for the feature's whole length; `deck motion layers` reads 2758 render-layer candidates against 637 stacking contexts, and a promotion at either end would land inside the 28–40 ms first gap that is already the switch's only rough frame.
- **The window worth animating in is the 600 ms after first paint, minus that first gap.** From gap index 1 onward the deck holds 16–18 ms on the live reference deck for the remainder of the window, on every one of eight switches. That is a real budget, and it did not exist before this arc.
- **Scale and duration live in CSS custom properties settable on the live deck**, so a variant can be tried without a rebuild — which is how the four failed trials were run, and the only reason their failure was cheap to establish.
- **The transform rides the canvas container**, whose `position: absolute` children need no re-layout when it scales. The layer wrappers are `display: contents` when shown and absolutely inset when hidden, so neither state adds a box between the container and the panes.

### What Step 8 inherits

- **The render phase is the whole remaining lever**, on both builds. Step 6's three preconditions for letting the two switching layers bail out — a parking that keeps the deck's identity, a re-solve that returns the same object when nothing moved, and handlers given to every layer and inert when hidden — are unchanged and unstarted. They touch the store's solve path, which is why neither step took them.
- **A production-bundle reading on the reference deck was not taken.** `just app-debug` serves the dev server, and `just app-release` would build a fresh instance with its own empty tugbank, so the reference deck's three workspaces do not exist in it. The production number here is the fixture's, on half the elements, and the two together are what the criterion was judged on.
- **`at0643` is green and its bars carry margin**: `FIRST_PAINT_BUDGET_MS` 150 against a measured 51–67, and `LONGEST_GAP_FRAMES` 2 (34 ms here) against a measured 18–25. It also declares `deck-canvas.tsx`, which took the app-test fan-out ratchet to 28.

## The instruments, and how to take these readings again

```bash
just app-debug                                   # build and launch the debug instance
I=debug-tugarc-workspace-switch-cheap
./tugrust/target/debug/tugtool deck motion enable   --instance $I
./tugrust/target/debug/tugtool deck motion chains --mode arm  --instance $I
#   … then in the deck, arm the record and drive the switches:
#   __deckTrace.enable(true); __deckTrace.enableKind("space-switch-frames", true)
#   … activate-space alternating, 1.1s apart …
./tugrust/target/debug/tugtool deck motion chains --mode read --instance $I
./tugrust/target/debug/tugtool deck motion chains --mode disarm --instance $I
./tugrust/target/debug/tugtool deck motion cost --frames 60 --instance $I
./tugrust/target/debug/tugtool deck motion layers --instance $I
./tugrust/target/debug/tugtool deck motion list   --instance $I
```

`./tugrust/target/debug/tugtool`, never bare `tugtool` — the one on `PATH` is `Tug.app`'s Release binary and does not carry the `chains` verb.

**Bring the window to the front and prove rAF is live before trusting any frame number.** The liveness probe is 20 rAF ticks with a 3 s timeout; a run that times out is an occluded window, and every frame reading taken under one is void rather than low. The `chains` reading is the exception — it rides no frames and reads correctly under occlusion.
