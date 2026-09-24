# A workspace switch, recorded before it was changed

**2026-09-24.** What `tests/app-test/at0620-workspace-switch-quiet.test.ts` saw across six real
switches — three conditions, each in both directions — with an 8ms sampler installed before the
gesture and read after the crossing attribute was gone plus 900ms. Nothing in the product had
changed yet; this is the floor every later round of the arc is measured against.

The test is diagnostic in this round: it asserts only that the sampler ran and that the switch
completed, and emits everything else through `note()`. The numbers below are its
`Diagnostics:` section, read.

---

## The one finding that matters

**The first show of a parked workspace moves a pane frame, and it moves it 240px, 116ms after
the swap, under the dissolve.**

```
plain A->B  panes: at0620-pb0|rect [60,40,700,600] -> [60,40,700,360] x3 last@116ms
            crossFirstMs 58, crossLastMs 239
```

Three distinct rects, the last landing at 116ms — squarely inside the beat, which ran from 58ms
to 239ms. The frame arrives 600px tall and settles to the 360px the fixture seeded, in steps,
while the departing workspace is being dissolved over the top of it.

It happens on the **first** show of that workspace and never again. `plain B->A`, both streamed
runs and both resized runs report `panes.moved: []` — not one rect changed in any of them. So
this is a first-mount cost, which is exactly the shape [B06]'s "armed on the shown transition"
rule produces: a layer that was `display: none` has no boxes, so everything that needs a box is
owed at the moment it gets one.

## The second: the composer's line box lands at 73ms

```
streamed A->B  lineBoxes: card:at0620-sc>…>div.cm-editor:0 [14px] -> [29.625px] x1 last@73ms
                          card:at0620-sd>…>div.cm-editor:0 [14px] -> [29.625px] x1 last@73ms
```

`--tugx-editor-line-box` more than doubles on both session cards of the arriving workspace,
73ms after the switch — again inside the beat (`crossFirstMs 61`, `crossLastMs 250`). The
composer's `max-height` multiplies by this value, so this is a geometry change and not a
cosmetic one.

Like the pane rect, it fires once: on the first show after the card's session was bound, when a
real row finally exists to measure and the estimate it had been holding is replaced. The
`streamed B->A` run and both resized runs report `lineBoxes.moved: []`.

## Every re-arm site in the table, and whether it moved

Against `plan.md`'s (#rearms-on-show):

| Site | Verdict |
|---|---|
| Composer line-box remeasure (`tug-prompt-entry.tsx`) | **MOVED** — `14px → 29.625px`, 73ms after the swap, both cards, first show after binding only |
| Pane accessory height (`tug-pane.tsx`, React state → `minSize`) | **MOVED, on the balance of evidence** — `at0620-pb0`'s 600→360 height in three steps ending at 116ms, first show only. It is the one site on the table that goes through React state and therefore produces its own later commit, and the trace shows exactly that (below) |
| Pane bar controls width (`tug-pane.tsx`, `--tugx-pane-controls-width`) | **NOT SEPARATELY INSTRUMENTED.** The sampler tracked pane rects, not that custom property; its only visible consequence is a rect change, and the rect change above is already claimed by the accessory height. A later round wanting to separate the two must sample the property |
| Sheet bottom-anchor clamp (`tug-sheet.tsx`) | **DID NOT FIRE** — no sheet was open in the fixture. `clamps.keys` was 1–2 and `clamps.moved` was empty in all six runs |
| Sheet max-height clamp (`tug-sheet.tsx`) | **DID NOT FIRE** — same |
| Session card entrance fade (`session-card.tsx`) | **NOT OBSERVED.** No shown frame's computed opacity ever changed in any run (`panes.moved` carries no `\|opacity` key), and no inline opacity was ever seen. The mount-time `layerShown` read and the cold-restore guard appear to suppress it on this path |
| Transcript re-window (`tug-list-view.tsx`) | **NO EVIDENCE — a gap in this recording.** See below |

### The transcript gap, named rather than glossed

`scrollers.keys` is **0 in all six runs**, including the two where 120 complete turns had just
been appended to the arriving workspace's session cards while it was hidden (`sent: 120`,
`errors: []`, both directions). The sampler looks for an element under the shown layer matching
`.cm-scroller, [data-scroll-region], .tug-list-view, .tug-list-view-scroller,
.session-card-transcript, .tug-pane-content, [class*='scroll']` whose
`scrollHeight - clientHeight > 1`, and found none.

Either the transcript's scroller is named by none of those, or the list view's windowing keeps
its scroll box at viewport height so the overflow test never fires. Either way **this recording
says nothing about whether the transcript re-window moves anything**, and it must not be read as
saying it does not. Whichever later round cares about that site has to find the scroller by
name first.

## What the trace says: the second commit is real, and there can be four of them

Every one of the six switches produced the pair the plan's (#switch-path-today) predicted:

```
settle-arm  landing: "cut"    outcome: "declined"     <- the swap commit
settle-arm  landing: "cross"  outcome: "unchanged"    <- activateCard, outside the batch
```

On the **first show** there were four of the second kind, not one, spread over roughly 100ms
after the swap (`plain A->B`: timestamps 1473, 1519, 1541, 1577 against a cut at 1472). On every
later switch there was exactly one. So a first show is not one late commit but a short train of
them, which is the same first-mount shape the rect and the line box show.

`outcome` was `"unchanged"` every time, and no `settle-retarget` or `settle-release` was
recorded in any run — consistent with a declined arm launching nothing.

## The resize condition found nothing, and that is a finding too

Shrinking the canvas container from 1659px to 900px while the target workspace was parked, and
letting it settle for 900ms (well past `RESIZE_RETUNE_QUIET_MS`, which is 200), then switching:

```
resized A->B  panes.moved: []   containerWidth: 900 -> 900
              settle-arm cut/declined, then cross/unchanged
resized B->A  panes.moved: []   containerWidth: 1180 -> 1180
              settle-arm cut/declined, then cross/unchanged
```

**The [F04] case did not reproduce.** The post-swap arm is still `"unchanged"`, so `_revealTerms`
returned `{}` — the parked deck's stored offsets still revealed the remembered pane under a band
270px to 760px different from the one they were written against.

Two caveats before this is read as [P04] being unmotivated. The resize was an inline `width` on
the canvas container rather than a real window resize, so host chrome the real gesture also
moves was not moved. And the fixture is `one-up` with a right rail and free-positioned content
panes at x=60 — an arrangement whose reveal terms are cheap to satisfy. The re-solve [P04] asks
for rests on the argument in the plan, not on an observed hop in this fixture, and the plan
should say so.

## [Q01] — what the quiet rule must actually compose

The answer the evidence supports: **a settle in flight, a pane frame's rect under the arriving
layer, and the arrival of any further commit.** Those three are what moved.

- The **pane rects** are the thing a reader sees move, and they are what `silentFrames` must be
  silent about. Nothing else in this recording produced visible motion.
- The **commit train** matters independently of the rects: a first show produced four post-swap
  arms over ~100ms, and a gate that watched only rects could call quiet in the gap between two
  of them.
- The **composer line box** is a geometry write that precedes a rect change rather than being
  one, so watching it buys nothing a rect watch does not already catch — but it lands at 73ms,
  inside any plausible bound, so the bound must not be shorter than the writes it is meant to
  cover. `SPACE_QUIET_BOUND_MS` at 200 covers both the 73ms line box and the 116ms rect with
  room; at 100 it would not.
- The **clamps and the scrollers** contributed nothing measurable and should not be composed
  into the rule on this evidence.

`QUIET_FRAMES` of 2 is not contradicted by anything here. The gaps inside the first-show commit
train are tens of milliseconds — several frames — so two silent frames is a real bar and not a
formality, but it is a bar the train's gaps could clear. If Step 5's gate proves to release
early on a first show, the number is what to raise, and the reason to write at the constant is
this train.

## [Q02] — does focus transfer on a switch scroll a scroller

**By sampling: no evidence either way.** The sampler saw no scroller at all in any run (above),
so it can neither confirm nor deny a scroll. This question is answered here by reading only.

**By reading: the switch path does not write DOM focus at all, and the one path that can is the
one that omits `preventScroll`.**

Walking `activateSpace` (`tugdeck/src/deck-manager.ts:1291`):

- Step (7) calls `this.activateCard(focus)` **directly** — not through
  `transferFocusForActivation`. So the manager itself issues no `HTMLElement.focus()` on a
  switch. `activateCard` routes through `_flipFirstResponder` →
  `_commitStandardFirstResponderFlip`, which notifies and nothing more.
- The DOM focus write on an activation normally comes from
  `transferFocusForActivation` (`tugdeck/src/focus-transfer.ts:780`). Worth recording for any
  later round that wires the switch into it: **`TransferFocusForActivationOptions` has no
  `preventScroll` field at all.** Its `applyBagFocus` call therefore passes `undefined` through
  to `fm.place(..., preventScroll: options?.preventScroll)` (`focus-transfer.ts:603`), and the
  engine-less branch calls `el.focus(undefined)` outright (`focus-transfer.ts:617`). Routing a
  switch through that helper as it stands would introduce a scroll-capable focus write onto this
  path.
- The one focus write a switch *can* reach today is `CardHost`'s cold-boot mount restore,
  `applyBagFocus(cardId, store, { site: "cold-boot" })`
  (`tugdeck/src/components/chrome/card-host.tsx:1053`) — **also with no `preventScroll`**. It
  runs when a card's subtree first mounts, which under [B06] is the first show of a parked
  workspace, and only then.
- Every write the focus *engine* makes does pass it: `focus-manager.ts` calls
  `el.focus({ preventScroll: true })` at 1165, 1173, 2970 and 3038, and `regrantCurrentTarget`
  passes `{ preventScroll: true }` at 1194. `traceApplyDefaultFocus`
  (`tugdeck/src/default-focus.ts:203`) is the one that takes it as an **opt-in** and otherwise
  calls a bare `target.focus()`.

So the honest answer is: **on the first show of a parked workspace there is a focus write on the
path that does not pass `preventScroll`, and on every later switch there is no focus write at
all.** That matches the shape of everything else in this recording — the first show is where the
cost is.

## rAF ticks in this harness

```
at0620 rAF across six switches: 411 animation frames against 566 interval samples — TICKING
```

About 69 animation frames per switch across roughly 1.15s of sampling each — a full 60Hz. **So
`requestAnimationFrame` is not suspended in an app-test window under the conditions this run
met, and the quiet path is observable end to end.**

This changes what Spec S01's three consequences allow. Its first consequence asked this question
and this is the answer; its second — that Step 6 may only *note* `quietReason` and never assert
it — is **not binding on this evidence**, and Step 6 may assert the quiet path.

**With one condition, which must not be dropped.** The suspension the spec worried about is
real; it is caused by **occlusion**, not by the harness. A covered harness window does suspend
rAF, and nothing about this run proves the window will be uncovered next time. So Step 6 asserting
`quietReason === "quiet"` would be a test that fails whenever another window happens to cover the
harness — green today, red on a busy desktop, for a reason that has nothing to do with the
product. The safe shape is the one the spec already reaches for the other way round: **assert the
bound, and note the reason** — and now, additionally, keep the pure `spaceDissolveDue` unit test
as the proof of the quiet path, which it is regardless of what any window is doing.

## One CSS transition can match a pane frame

Asked of the stylesheets, per the step's last read:

```css
/* tugdeck/styles/chrome.css:181 */
.tug-pane {
  transition: height var(--tug-motion-duration-fast) var(--tug-motion-easing-standard);
}
.tug-pane[data-gesture="true"] { transition: none; }
[data-imposer-settling] .tug-pane { transition: none; }
```

**A pane frame's height eases, on a clock the imposer does not own**, and it stands down for
exactly two things: a pointer gesture, and an imposer settle. **A workspace switch is neither.**
So the 600→360 height change above — 240px, landing 116ms after the swap — is a transition that
[P02]'s mark would decline the settle for and then watch happen anyway, under a third clock.

Whatever Step 3 writes as the switch-epoch mark needs a CSS suppression rule of its own beside
the two that are there. That rule is not yet in the plan's Specification and should be.

The only other transition that can reach anything in this arc's neighbourhood is
`tug-sheet.css:401`, `transition: opacity …` on a resize grip's `::after` — a decoration on a
corner handle, not the clip and not the panel, and not in play on a switch.

---

## How to re-read this

`just app-test at0620-workspace-switch-quiet.test.ts` and read the `Diagnostics:` section. Each
run notes a `canvas` object (sample counts, rAF ticks, the crossing window, and every tracked
value that changed with the millisecond it last changed at) and a `trace` array (`settle-arm`,
`settle-retarget`, `settle-release`, `space-switch-timing`). The closing two notes summarize rAF
across all six runs and the count of changes that landed **after** the beat ended, per run —
which was zero everywhere in this recording, because everything that moved, moved *during* it.

---

# The intra-workspace fade, chased

**2026-09-24.** What `tests/app-test/at0621-intra-workspace-slide.test.ts` found when the
reported gesture — an activation inside one workspace that fades instead of sliding — was
staged and sampled.

## Did the reported gesture reproduce? Not as reported. Something worse did.

**The plain gesture is clean.** Four cards in a four-up flow deck, the reader walked from
slot 1 to slot 4 by three real `focus-card` activations, sampled every 8ms across the whole
run:

```
plain walk: minOpacity 1, heldResidents [], ghosts 0,
            offset 0 -> 1493px, rects moved: a-p1 a-p2 a-p3 a-p4
trace:      cross/carried, 4x retarget, cross/carried, 4x retarget,
            cross/carried, release/completion
```

Not one frame dipped below full opacity, not one was held at an inline zero, no ghost was
minted, and every frame travelled. **An activation inside a settled workspace slides.** If
the user's gesture was this one, it is not reproducible on this fixture.

**The same walk after a workspace switch is a mass fade.** Stage the precondition — open a
card so a settle with a real arrival is in flight, cross to the other workspace 70ms in,
cross back, let it settle, then walk:

```
minOpacity 0 on a-p1 @230ms
heldResidents: a-p1 a-p2 a-p3 a-p4 at0621-pl1      <- every frame that never left
ghosts: 5
trace: cross/carried, cut/declined, cross/unchanged, cut/declined, cross/carried, ...
```

Every resident frame of the arriving workspace, the Layout rail included, held at inline
`opacity: 0`, with five departure ghosts for the workspace being left. That is the blink
at0592 removed, back — under a precondition at0592 does not stage.

## The mechanism, and it is not [P05]

[P05]'s argument was that a stale `pendingArrivalsRef` entry survives the switch's `"cut"`
arm and makes a later intra-workspace arm read a resident frame as an arrival. **The sweep
was implemented and measured, and it does not move this reading.** Identical numbers before
and after, to the pane id.

What the trace says instead, read against `#switch-path-today`:

- `cut/declined` — the swap commit. Correct, and it is what at0592 pins.
- `cross/carried` — **`activateSpace` step (7)'s `activateCard`, outside the swap batch.**
  `outcome: "carried"` rather than the `"unchanged"` every plain switch records, because the
  arrangement really did move: the workspace gained a card and the reveal wants a different
  offset.

Once that arm goes past the signature guard it runs its two passes across the layer
boundary: **First reads the workspace being left, Last reads the one arriving.** Five panes
with a First rect and no survivor are five departures — the five ghosts. Six panes with no
First rect are six arrivals — the six holds. The arithmetic matches the reading exactly.

So this is a **switch-epoch** defect, not a settle-registry one, and the answer is [P02]'s
mark: an `arm` under the switch epoch declines exactly as it does for `landing === "cut"`.
[#step-3] is where it closes, and at0621 already carries the measured target —
`heldResidentFirstMs` and the resident list — for the round that turns the claim on.

## The dissolve is excluded, and by what

Task three of the step, answered by reading. The crossfade layout effect
(`tugdeck/src/components/chrome/deck-canvas.tsx`) is keyed on `spacesSnapshot.activeSpaceId`
and its second early return is `if (previousSpaceId === activeSpaceId) return;`. An
intra-workspace activation changes neither, so the effect runs its unconditional `teardown()`
and returns without opening a beat. **The workspace dissolve cannot be what an intra-workspace
activation fades under**, and the plain leg's reading agrees: zero crossing layers, zero
ghosts, full opacity throughout.

## The sweep, kept on the reading alone

[P05]'s sweep landed anyway, exactly as the step's fallback clause directs, because its
argument survives the absence of an observation: the Last pass only ever walks
`SHOWN_PANE_FRAMES`, so a pending arrival for a pane that is not on screen is one no beat
will ever come for. Today the settle's **window timer** collects it about a second later —
but that timer is a wedge guard behind the settle's own completion, not a correctness path,
and a hold whose only hand-back is a wedge guard is a hold waiting for a reason to strand.

What the sweep must not do is drop an id without running its restorers, which would leave
the frame invisible for the life of the canvas rather than faded for a beat. at0621 asserts
against exactly that, in both legs, by reading the canvas **at rest**: no frame left wearing
an inline opacity, none computing below 1, no ghost still standing. Both legs are clean.

## One pre-existing red, named

`at0566-three-beat-settle.test.ts` is in this step's checkpoint and fails on
`departure: no top inside B moves relative to its frame during the move` (expected `< 1.5`,
got `2.17`). `tugtool apptest history` reads it red for the last six recorded runs back to
`e4fa38cb0` (2026-09-23), last green `15dd915fc` (2026-09-22) — both ancestors of this arc's
base. It is not this arc's, and it is recorded in the arc's `baseline.md` so a later step
does not read it as a regression.

---

# The switch epoch, and what it closed

**2026-09-24.** `data-space-switching` on the canvas container, written by `DeckManager`
inside the swap commit and handed back by `DeckCanvas`'s crossfade layout effect. What it
changed, measured.

## The mass fade is gone

The same staged precondition that produced it — a card opened, a workspace switch landed
70ms into its arrive beat, a switch back — now reads:

```
before:  heldResidents [a-p1 a-p2 a-p3 a-p4 at0621-pl1]   minOpacity 0 @230ms   ghosts 5
after:   heldResidents []                                  minOpacity 1          ghosts 0
```

And the trace says which line did it. The arm that was minting the fade —
`activateSpace` step (7)'s `activateCard`, one commit after the swap — moved from
`settle-arm:cross/carried` to `settle-arm:cross/declined`. The commit still spells itself
`"cross"`, because that is what it is; the epoch is what refused it.

`at0621`'s second leg now holds the same bar as its first, which is the claim the previous
round had to leave noted rather than asserted.

## Why a mark rather than a word on the commit

The swap commit already said `"cut"` and `arm` already declined that. The trouble was never
the swap — it was that **a switch is not one commit**. Every run of `at0620` records the
train:

```
plain A->B  cut/declined:cut  cross/unchanged  cross/unchanged  cross/unchanged  cross/unchanged
plain B->A  cut/declined:cut  cross/unchanged
```

Four `"cross"` commits after the swap on a first show, one on every later switch. Each of
them is an ordinary arrangement change as far as its own spelling goes, and `landing` alone
cannot tell one apart from a real gesture the user made a frame later. The mark is the fact
`landing` cannot carry: *the canvas is mid-switch*, held across every commit in the train
rather than attached to any one of them.

`reason` on the `settle-arm` record is what keeps both facts legible — `landing` stays the
commit's own word, `reason` names the rule that answered it. `cut` and `switching` read
identically as `outcome: "declined"` otherwise, and only one of them is new.

## Where the mark is written, and why not in the canvas

`DeckManager.activateSpace`, inside the `_flipFirstResponder` commit closure, before its
`notify`. **React runs layout effects child-first**, so a mark set in `DeckCanvas`'s own
effect is already too late for every re-arm inside the arriving layer — the composer's line
box, the pane bar's controls width, the accessory height, the sheet clamps. Those effects
have run by the time the canvas's does.

One wrinkle worth recording: **`DeckManager.this.container` is not the canvas.** It is
`#deck-container`, the React mount root; the element carrying `CANVAS_BACKGROUND_ATTRIBUTE`
is a descendant that `DeckCanvas` renders and holds as `containerRef`. `paneCanvasOf` cannot
answer here because it walks *up* from a frame, so the manager looks down with a new
`CANVAS_BACKGROUND_ATTRIBUTE_SELECTOR`. The margin caps carry the same marker and are
children of the container, so a `querySelector` from the root returns the outer element
first, in document order — which is the one `arm` and the crossfade effect both read.

## The window, and the debt

The mark stands from the swap commit to the canvas's own layout-effect pass, and the
crossfade effect's unconditional top-of-body `teardown()` is what strips it. That is the
right window for this round and the wrong one for a held cover, which is a later step's
problem to state.

The removal rides `teardown` rather than the effect body so **every** exit pays it: the tween
completing, the deadline firing, the next switch arriving, the effect's own cleanup. And the
reduced-motion and empty-outgoing early returns get it for free, since they are below the
`teardown`. `at0620` asserts the debt on all six runs — a second after each switch,
`document.querySelectorAll("[data-space-switching]").length` is 0.

## The CSS clock the mark does not govern

Step 1's stylesheet grep found one `transition` that can fire on a switch, and the mark does
not reach it: `.tug-pane { transition: height … }` in `tugdeck/styles/chrome.css`. It stands
down for a pointer gesture and for an imposer settle, and a switch is neither. So the epoch
gets its own stand-down beside those two:

```css
[data-space-switching] .tug-pane { transition: none; }
```

This is not redundant with `arm`'s decline. `arm` governs the imposer's springs; this rule is
armed by the layout write itself, on a clock the imposer never started. The 240px height
change the recording measured at 116ms would have eased here whatever `arm` decided.

## `at0587`'s 64px is not this arc's, and the first reading of it was wrong

This is recorded at length because a wrong attribution was acted on, and the correction is
the useful part.

`at0587-workspace-switch-mounted.test.ts` scrolls a real transcript to 40% of its range,
switches away, switches back, and asserts the scroller lands within 2px of where it was. It
reads **either 1272 or 1310** — a 64px jump, one row's worth — and which one it reads varies
run to run.

The first reading of that was: the mark causes it. A `tugtool file probe` with the four
TypeScript files reverted came back green at 1272, the same batch with them back came back
red at 1310, and that looked conclusive. **It was one sample each.** Two changes were built
on it — skipping the resize episode under the epoch, and re-asserting the mark for the
dissolve's beat — and both were reverted once the real distribution was measured.

**The measurement that settles it:** the same probe, Step 3 entirely reverted — all four
TypeScript files and the stylesheet — six runs of the file alone on each side:

```
base (Step 3 reverted):   1272  1310  3180  1310  1310  1310    1 green of 6
with Step 3:              1310  1310  3180  3180  1310  1310    0 green of 6
```

**The same distribution on both sides, down to the 3180 outlier.** `at0587` is mostly red on
this machine already and was before this arc touched anything. It is recorded in the arc's
`baseline.md` beside `at0566`, which has the same character.

The lesson is the cheap one: a bimodal test needs a distribution, not a sample. A single
probe on each side of a change shows a difference only when the test is deterministic, and
nothing had established that this one was. Six a side says there is no shift; three did not.

**What this does not excuse.** The epoch genuinely does make a switch's later arms decline,
and an arm that lands after the mark has been swept — the window ends at the canvas's own
layout-effect pass — still carries. Spec S02 says so outright and assigns the wider window
to [#step-5], where the held cover makes the epoch last until the canvas is quiet rather
than until a beat happens to land. Nothing here is evidence against that; it is simply not
evidence for it either.

## [Q02], resolved without a change

The step offered to fix the focus-scroll **if Step 1 found it real**. Step 1 did not.

The sampler saw no scroller at all in any of six runs, so there is no measurement either way,
and the reading half of the audit found that `activateSpace` step (7) calls `activateCard`
directly and issues no `HTMLElement.focus()` of its own. The one focus write a switch can
reach is `CardHost`'s cold-boot mount restore, which runs on the *first* show of a parked
workspace and omits `preventScroll` — a real gap, but one with no observed consequence and
no test that would catch a regression in it.

So nothing changed here. Adding `preventScroll` to the cold-boot claim on no evidence would
be altering focus semantics on a path this arc has not measured, and the honest record is
that [Q02] is **unanswered empirically and unproblematic by reading**. Whoever wants it
closed needs a fixture whose transcript actually overflows — which is the same gap the
recording already named.

---

## Step 4: the resized-while-hidden condition was not a reproduction

[P04] is about a parked workspace whose deck was solved against a canvas that has since
changed size. The recording's third condition is named for exactly that case. **It was not
measuring it**, and the whole of Step 4's evidence had to be rebuilt on that finding.

### What the condition actually did

The condition set an inline width on the element carrying `data-deck-canvas-background`.
That element is the canvas the picture is drawn over, and shrinking it does move the
picture: CSS lays every frame out across the narrower box and the sampler duly reports the
new rects. But `DeckManager` measures `this.container` — the React mount root,
`#deck-container` — and that box never moved. So `_allocatedRailWidths` was asked the same
question before and after the "resize" and gave the same answer, `retuneSidebarAllocation`
found nothing to commit, and both workspaces went on holding the rail width they were
seeded with.

The tell was in the first reading of Step 4's new assertion: the arriving rail measured
420px in every resized run, on both sides of the change. A reverse-diff probe confirmed it —
with `_resolveShownArrangement` reverted, the assertion still passed. **It was green over a
condition that reproduced nothing.**

The fixture now sets the width on `#deck-container`. The rail then solves to 420px at a
900px canvas and **363px** at a 1180px one, which is a difference an assertion can stand on.

### The defect is worse than the plan described it

[P04]'s rationale says the parked deck "carries an arrangement solved against the old
canvas" and that the correction is "a second, carried commit … the post-landing correction
the arc is removing". The first half is right. The second half is not.

With the fix reverted and the fixture repaired, the arriving rail comes up at 420px and is
**still 420px** at the end of the window. Nothing corrects it. The settled-resize re-tune is
driven by the canvas's `ResizeObserver`, so it answers only for the workspace that happens
to be standing when a resize lands; a workspace shown *after* one gets no re-tune at all,
because no resize is happening at that moment. So the reading is not a late correction
under a dissolve — it is a **wrong arrangement that stands until the user resizes the window
again**.

That makes [P04] a correctness fix that happens to also serve this arc, rather than a
quiet-the-motion fix. The decision and the step's code are unchanged by it; what changed is
the assertion's shape. "The first frame is the same size as the last" cannot catch a width
that is wrong and stable, and that is what the assertion was first written as. It now reads
the width the allocator solves for the live canvas off the **outgoing** workspace — the
fixture stands the same deck twice, so the rail the outgoing side has come to rest at is the
width the incoming side is owed — and asserts the arriving rail comes up at that number.

Red at `420` against `363` with the change reverted; green with it. That is the proof the
first shape did not give.

### The one notify, verified by reading

`_resolveShownArrangement` reaches `_railSolvedPanes`, `_placeRunHeight` and the three
`*RetuneTerms` forms, and none of them notifies — checked mechanically over the file rather
than by eye. The trace agrees: every resized run reads `cut/declined:cut cross/unchanged`
from the swap, which is one settle-arm for the swap and one for `activateCard`'s reveal,
and at0592's leg 1 — the one that would go red on a second notify inside the closure —
stays green.

### A loose end this step did not chase

The recording's very first run, `plain A->B`, shows `at0620-pb0` moving `700x600 -> 700x360`
over five samples, ending 165ms in. That is the first-ever show of a parked workspace, and
the height it settles to is the fixture's own. It is not the resized condition and not what
[P04] is about, so Step 4's assertion is scoped to the resized runs and this is recorded
rather than chased. Whoever walks [#step-5] should know it is there: it is a real size change
on an arriving pane, on the one switch that mounts a workspace for the first time.

### The `@covers` line this step could not write

`at0620` now exercises `DeckManager.activateSpace` and nothing narrower, so the honest
declaration names `tugdeck/src/deck-manager.ts`. Adding it took that path from 21 selected
tests to 22, and `just app-test-covers-check` refused: `ACCEPTED_FANOUT` records the
manager's over-budget fan-out as debt that may be **paid down and never refinanced**, on
the ground that the edit widening a hub must not also raise its own ceiling.

The declaration was withdrawn rather than the budget raised, and the reason is written into
`at0620`'s docblock where the missing line would have been. The cost is that a change to
`deck-manager.ts` alone will not select `at0620`; it still selects `at0303` and `at0453`,
which drive the same space allocator. Anyone re-opening this should reach for the escape the
ratchet itself names — narrow the declarations across the 21, or split the module — rather
than for the digit.

---

# The cover, and what lifts it

Step 5 put a hold in front of the dissolve. The readings below are the first from a deck
that has one.

## The gate releases on quiet, not on the bound

Six switches, `space-quiet` records from the run at0620 takes:

```
plain    A->B   quietMs 110   quiet
plain    B->A   quietMs  21   quiet
streamed A->B   quietMs  41   quiet
streamed B->A   quietMs  38   quiet
resized  A->B   quietMs  30   quiet
resized  B->A   quietMs  33   quiet
```

**Every one released on the quiet path, and every one inside `SPACE_QUIET_BOUND_MS`.** The
bound's own `setTimeout` never fired.

The spread is the finding. Five of the six are 21–41ms — two or three frames, which is the
floor the rule can reach at all: `QUIET_FRAMES` is 2, so nothing can release in under two
animation frames. The sixth is **110ms, and it is the first show** — the one switch that
mounts a parked workspace's cards for the first time, and the same run whose commit train
[Q01] measured at four post-swap arms over about 100ms. The gate is visibly waiting that
train out, which is exactly what it was composed to do, and 110 is comfortably under the
200 bound with the `divide-join` window still to come.

So the bound is doing its designed job of never being reached rather than its feared job of
being the only thing that ends the wait. That is worth stating plainly because [P03] names
the opposite as the risk: between the swap commit and the gate firing nothing is animating,
so there is no `.finished` to land, and the beat's only ends are the bound and the deadline.
Both are armed; neither has had to fire.

## rAF ticking is what makes the quiet path observable here

The same run reports 443 animation frames against 599 interval samples across the six
switches — a full 60Hz, the reading Step 1 recorded. The quiet path rides that counter, so
these numbers exist only because the harness window was uncovered.

**Nothing in this section may be turned into an assertion on `quietReason`.** A covered
window suspends `requestAnimationFrame`, `silentFrames` then never advances, and every
switch releases on the bound — green today, red on a busy desktop, for a reason that is the
window manager rather than the product. The assertion the app-tests carry is the bound; the
quiet path's proof is `tugdeck/src/lib/__tests__/space-quiet.test.ts`, which involves no
window at all.

**And the bound the app-tests assert has to carry slack, or the same occlusion comes back as a
red.** `quietMs` on the bound path is a `setTimeout`'s reading, and a `setTimeout` fires no
sooner than its delay: a cover released by the bound records 200-and-a-bit, never 200. Holding
that path to `<= SPACE_QUIET_BOUND_MS` would be an assertion red exactly when the occluded case
above is taken — which is the ruled behaviour ([B06]) and not a defect. So `at0620` holds each
path to its own precision: a `"quiet"` reading is the product's own number and is held to the
bound exactly, and a `"bound"` reading gets `SPACE_QUIET_BOUND_SLOP_MS` of skew, whose job is
only to show the cover was bounded at all.

## What the hold did not disturb

`at0592`'s `crossOpaqueArrival` leg stays green with no change: the gate touches only the
outgoing wrapper's opacity, and the arriving layer is untouched from the first frame. Its
`CROSSING_BOUND_MS` of 1500 still covers the new worst case — 200 plus the `divide-join`
window plus the deadline margin — by several multiples, so that file needed no edit, which
is what [P03] predicted.

`at0620` now also asserts, on all six runs, that the crossing attribute is gone by the end
of the window. The beat starts later than it used to, so "the cover came off" stopped being
something the old timing made obvious.

## The unit test's path, and why it is not in `src/__tests__/`

The symbol inventory names `tugdeck/src/__tests__/space-quiet.test.ts`. It was written to
`tugdeck/src/lib/__tests__/space-quiet.test.ts` instead, beside
`arrival-reveal.test.ts` — the test for the module this one is modelled on, in the directory
every other `lib/` unit test lives in. The convention is the whole of the reason; nothing
about the test changed.

---

# The recording, rerun

Same six switches, same sampler, same fixture, against the finished behaviour. The four
success criteria are assertions in `at0620` from here on rather than numbers in a note.

## The headline finding is gone

The recording's own lead was this:

```
BEFORE  plain A->B  at0620-pb0|rect [60,40,700,600] -> [60,40,700,360] x3 last@116ms
```

A pane frame arriving 240px too tall and stepping down to its settled height 116ms after the
swap, in the middle of a dissolve that ran 58–239ms. After:

```
AFTER   plain A->B  at0620-pb0  first "60,40,700,360"  last "60,40,700,360"  changes 0
                    panes.moved []
```

**The frame's first sampled box is its settled box, and it never changes.** All six runs
report `panes.moved: []` — not one pane rect moved in any of them, in any condition, in
either direction.

**Which change did it, and how confident this is.** The move was still there at Step 4's
close: that step's own checkpoint run reported `at0620-pb0 first "60,40,700,600" … last
"60,40,700,360" changes 5`. It is absent in every run after Step 5. Two readings a step
apart on the same machine, so **the hold is what removed it**.

**The mechanism is NOT established, and this paper will not pretend otherwise.** The
expected account is that the accessory height's commit now lands behind the cover and, under
the re-asserted switch epoch, `arm` refuses to tween it — so a three-to-five-step travel
becomes a cut. But that account predicts the sampler would still see two VALUES, 600 then
360, and it sees one. Something is making the frame correct at the sampler's first sight of
it, and this recording does not say what. Whoever wants the answer should sample
`--tugx-pane-controls-width` and the accessory height directly rather than inferring both
from the rect, which is the same instrumentation gap the table below has always had.

## Every re-arm site, before and against

| Site | Before | After |
|---|---|---|
| Composer line-box remeasure | **MOVED** — `14px → 29.625px` at 73ms, both cards, first show after binding | **STILL MOVES** — `14px → 29.625px` at 74ms, same two cards, `streamed A->B` only. Unchanged, and now it lands behind the cover |
| Pane accessory height | **MOVED** — `at0620-pb0` 600→360 in three steps ending at 116ms | **DOES NOT MOVE** — first sample is the settled box, `changes: 0`, all six runs |
| Pane bar controls width | **NOT SEPARATELY INSTRUMENTED** | **STILL NOT** — the gap is unchanged; its only visible consequence was the rect, and the rect no longer moves |
| Sheet bottom-anchor clamp | **DID NOT FIRE** — no sheet open in the fixture | **DID NOT FIRE** — `clamps.keys` 1–2, `clamps.moved` empty, all six |
| Sheet max-height clamp | **DID NOT FIRE** | **DID NOT FIRE** — same |
| Session card entrance fade | **NOT OBSERVED** | **NOT OBSERVED, and now gated** — `minOpacity` is exactly `1` and `inlineZero` is empty in all six, asserted rather than read |
| Transcript re-window | **NO EVIDENCE — a gap** | **STILL NO EVIDENCE** — `scrollers.keys` is 0 in all six again |

## The composer line box still moves, and that is acceptable

It is the one site on the table that still writes late. `--tugx-editor-line-box` more than
doubles on both session cards of the arriving workspace at 74ms, exactly as before.

It is acceptable for the reason [B06] gives: **the cover is what the arc promised, not
stillness in the DOM.** 74ms is inside the 113ms the cover was held for on that run, so the
write lands while the departing workspace is still painted opaque over it and the reader
sees none of it. The switch's contract is that nothing is SEEN to move after the picture is
handed over, and `panes.movedAfterCross` is empty in all six runs, which is that contract
measured.

What would break it is a line box landing after the bound — and the bound is 200ms against
a measured 74. The recording's ruling on `SPACE_QUIET_BOUND_MS` was written from exactly
this number, so the two agree by construction rather than by luck.

## The cover's readings, and the scroller criterion's vacuity

```
plain    A->B   113ms quiet      streamed A->B    36ms quiet      resized A->B    33ms quiet
plain    B->A    22ms quiet      streamed B->A    41ms quiet      resized B->A    28ms quiet
```

Every one on the quiet path and inside the bound, consistent with Step 5's own run. rAF read
440 animation frames against 601 interval samples — ticking, so the quiet path was genuinely
exercised rather than defaulted past.

`quietReason` is **noted and not asserted**, and the reason has not changed: an occluded
window suspends `requestAnimationFrame`, `silentFrames` then never advances, and every
switch releases on the bound. A test asserting `"quiet"` would be red whenever another
window happens to cover the harness. The rule's proof is the unit test.

**The scroller criterion is asserted and vacuous.** `scrollers.keys` is 0 in all six runs —
the sampler never found an overflowing scroller under the shown layer, including the two runs
that had just appended 120 complete turns to the arriving workspace's session cards. So "no
scroller moved" is true over an empty set. The assertion is in the file because the criterion
is real and a future fixture may populate it; the count is noted beside it on every run so
nobody reads the green as a proof. Closing the gap needs a fixture whose transcript actually
overflows, which is the same thing [Q02] asked for and did not get.

**The epoch's imposer decline is asserted and, on this fixture, also vacuous.** `at0620` reads
every arm from the swap and requires that none CARRIED, and all six runs read
`cut/declined:cut` followed only by `cross/unchanged` — never the
`cross/unarmed:switching` the leg's own comment describes. That is not the mark failing; it is
[P04] having removed the one case in this fixture that would have produced a changed
arrangement signature after the swap. So the leg is green with the mark and would be green
without it, and `reason: "switching"` has no run in this paper that shows it.

What the mark demonstrably does do here is the CSS clock it brought with it: the 240px pane
height that used to ease in under the dissolve is gone from all six runs, and
`[data-space-switching] .tug-pane { transition: none; }` is what closed that. The imposer half
of [P02] stands on the reading in "Why a mark rather than a word on the commit" and on nothing
in the harness. Closing it needs a switch whose arriving arrangement genuinely differs from
what the swap commit can pre-solve — and whoever builds that fixture should be sure it is a
real shape rather than one staged to make the assertion non-vacuous.

## What this arc did NOT fix

Named here so the next reader infers no claim the work did not make.

- **The departing picture is still live DOM for the length of the beat** (the brief's
  [F05]). The crossing layer is the real outgoing wrapper at `display: block`, still
  receiving store updates: a streaming session appends rows under the fade, progress dots
  pulse, carets blink. The crossing attribute pauses the pointer and nothing else. **The hold
  makes this strictly longer** — the cover now stands for the quiet wait plus the dissolve
  rather than the dissolve alone, so anything moving on the departing side is visible for
  more frames than before. Measured here that is 22–113ms of extra life. It was explicitly
  out of scope and remains so.

- **A workspace hidden across a window resize is still not laid out while hidden** (the
  sketch's idea 4, deferred by the user). A parked layer is `display: none` and has no boxes,
  so everything needing a box is owed at the moment it gets one — which is the whole reason
  the re-arm table exists. What this arc changed is that the incoming deck's ARRANGEMENT is
  re-solved against the live canvas inside the swap commit, so the rails arrive at the right
  width. That is not the same thing as the layer having been laid out: the composer line box
  above is precisely a measurement that could not have been taken while hidden, and it still
  cannot be.

- **`quietReason` is not gated anywhere.** A deck that begins releasing on the bound every
  time — because the quiet sources stopped composing correctly, say — would pass every
  assertion in `at0620`. Nothing in this arc would catch that, and the note is the only
  surface on which it would be legible.
