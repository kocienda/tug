<!-- brief-skeleton v1 -->

# Workspace switches: lock in what was won

**Purpose:** The `workspace-switch-cheap` arc (joined as `8a4fd3687`) made a workspace switch fast and smooth, and the user has judged it acceptable by eye. Three of the properties that make it so were established by measurement in one session and are guarded by nothing — they would regress silently. This brief names the tripwires that turn those readings into laws before the next piece of work moves on.

---

## Purpose {#purpose}

The user, after joining the arc and rebuilding (2026-09-28):

> The workspace switches now seem acceptably fast and smooth, which is great. I just want to *lock in* this behavior before we move on.

The audit of that arc read its app-tests against the properties the switch now depends on and found the coverage uneven: the hidden layer's contract, the cut, and the engine facts the design rests on are all pinned; the render-phase win, the stillness of the arriving workspace, and the acceptance numbers are not. "Lock in" means closing that gap, not chasing a lower number.

---

## Evidence {#evidence}

**[F01] The memo boundary that keeps a parked workspace out of the render is verified by a reading, not a test.** `LayerPanes` in `tugdeck/src/components/chrome/deck-canvas.tsx` is `memo`'d, and a workspace that stays parked across a switch bails out only because every prop reaching it — `deck`, `arr`, `store`, `onRevealPane`, `dropZones`, `shown` — keeps its identity. The readings paper (`briefs/workspace-switch-cheap-readings.md`, Step 6) says this was "read off the fiber tree" on a three-workspace deck. No app-test asserts it. The workspace list threaded through `TugPane` was exactly the prop that broke it before, and it was found by profiling, not by a red test. **(verified, read from the code and the paper)**

**[F02] The arriving workspace does not move, and nothing pins that.** A `MutationObserver` over one switch recorded 752 DOM mutations under the canvas, none of them on a `.tug-pane` frame — all of them the Workspaces card's slot chips and row flags, in all three mounted copies (readings paper, Step 5). That zero is the cleanest statement of "a parked pane already stands where it will be shown," and it is a number that cannot flap. It lives in a paragraph. **(verified, measured in the arc; not re-measured here)**

**[F03] `at0643`'s bars would pass a switch twice as slow as the one that was measured.** `tests/app-test/at0643-workspace-switch-cadence.test.ts` holds `FIRST_PAINT_BUDGET_MS = 150` against a measured 51–67 ms on its grown fixture (production bundle), and `LONGEST_GAP_FRAMES = 2` (~34 ms) against a measured 18–25 ms. The margin was chosen on purpose — `at0622`'s move-beat leg sits at 2.18–2.30 frames against a bar of 2.0 and alternates red and green on `main` (`.tug/arcs/workspace-switch-cheap/baseline.md`) — so a tighter single bar is the wrong fix. The record already carries `gapsOverBudget`, which the test reports through `note()` and does not assert. **(verified, read from the file)**

**[F04] The properties that ARE locked in, so this arc does not re-pin them.** `at0640` pins the cut (no crossing attribute, no inline residue, the epoch always closes). `at0641` asserts the hidden layer's boxes positively, paint skipped, pointer inert, focus never landing, loops paused, broadcast declined — and its `@covers` now names `space-layer-loops.ts`. `at0642` pins that a hidden measurement is real and that observers stay silent then deliver once on show. `spaces.test.ts` pins the parked strip offsets. The motion breaker guards resting cost. Because `at0641`/`at0642` assert the measured `content-visibility` behaviour rather than assume it, an engine change surfaces as a red. **(verified, read from the tests)**

**[F05] There is a test-mode diagnostic surface to hang a counter on.** `window.tugdeck.diag` in `tugdeck/src/main.tsx` is read-only inspection (`listCardIds`, `getDeckState`, `getSpaces`), and `window.__tug` is installed only when `window.__tugTestMode` is true (`main.tsx:619`). The deck's trace ring (`deck-trace.ts`) already carries opt-in per-kind records armed by the reading that wants them (`enableKind`), which is the discipline the arc's own `space-switch-frames` record follows. **(verified, read from the code)**

---

## Decisions {#decisions}

**[B01] A parked layer's render count becomes an assertion: zero across a switch.** `LayerPanes` (or the layer wrapper) records a commit per layer, keyed by `spaceId`, into a counter reachable through the diag surface — test-mode or opt-in only, so the product pays nothing at rest. A test switches between two workspaces on a deck with a third mounted and parked, and asserts the third's count did not move. Zero is a bar that cannot flap, and it is the one number that says the memo boundary held. This is the highest-value tripwire in the brief because [F01] is the regression most likely to happen and least likely to be noticed: one new prop that changes on a switch undoes it. What would revisit this: a deliberate decision that parked layers should render on a switch — at which point the test is retired with the reason, not tuned.

**[B02] Pane-frame stillness becomes an assertion: no `.tug-pane` frame under either layer takes an attribute or style mutation across a switch.** A `MutationObserver` installed before the dispatch and read after the epoch closes, filtered to pane frames (`[data-pane-id]`) under `.tug-space-layer`, with the epoch mark on the canvas container and the `data-space-shown` flip on the wrappers excluded because those are the switch. Every other mutation on a frame is the arriving workspace moving, which is what the whole arc removed. The Workspaces card's chip churn [F02] is deliberately out of the filter: it is correct behaviour and it is not a pane. This leg belongs in `at0640`, whose subject is already what a switch does and does not do to the frames.

**[B03] `at0643` keeps its hard bars and gains a loud second tier.** The 150 ms and 2-frame assertions stay exactly where they are — [F03] says why a tighter single bar is a flap waiting to happen. Above them, a **warning tier** at ~100 ms first paint and any `gapsOverBudget > 0` writes a `note()` that names itself as a drift warning, so a slow slide shows in the `Diagnostics:` section of every run before it becomes a red. The two tiers answer different questions: the hard bar is "did it break," the note is "is it drifting," and a reader of the report can tell them apart. The warning threshold is set from the fixture's measured 51–67 ms with room, and it is a constant with the reading written beside it, the way `FIRST_PAINT_BUDGET_MS` already is.

**[B04] Nothing in this arc changes what the user sees.** Every deliverable is a test, a test-mode counter, or a note. If a tripwire lands red on the tree as joined, that is a finding to write down and raise, not a licence to fix product code under a brief that did not ask for it.

**[B05] The counter's cost is zero at rest.** The render counter is armed by the test through the same kind of door the frame sampler uses — `enableKind`, or a test-mode-only install — never a global. The arc's own history has the lesson: `at0622` went red because a global trace flag armed a sampler inside a test measuring something else.

---

## Non-goals {#non-goals}

- **Chasing the "under one frame" criterion.** First paint is 115–143 ms on the reference deck and three quarters of it is React's render phase; the readings paper's Step 8 names the three preconditions for the next lever (a parking that keeps the deck's identity, a re-solve that returns the same object when nothing moved, handlers given to every layer and inert when hidden). That is a separate arc if it is ever wanted. The user has judged the current speed acceptable.
- **Tightening `at0643`'s hard bars.** Rejected for the reason in [F03]: a bar with no margin flaps, and a flapping test is one people learn to ignore.
- **A production-bundle reading on the reference deck.** Still not taken (`just app-debug` serves the dev server); still a reading rather than a test, and not what "lock in" means.
- **Re-pinning what `at0640`/`at0641`/`at0642` already pin** [F04].
- **The scale animation.** `[B06]` of `workspace-switch-cheap-brief.md`. After this, not inside it.

---

## Exit {#exit}

**An arc.** Small and plain. The shape of the first steps:

1. The per-layer render counter, behind a test-mode or opt-in door [B05], and a new app-test asserting a parked layer renders zero times across a switch [B01]. `@covers` `deck-canvas.tsx` — which will take the fan-out ratchet in `tests/app-test/scripts/select-tests.ts` from 28 to 29, re-keyed with the argument, as every raise before it was.
2. The pane-frame stillness leg in `at0640` [B02].
3. The warning tier in `at0643` [B03].

No order between them matters. Each is verified by `just app-test-build` and the file it touches, run alone and then together with `at0640`, `at0641`, `at0642`, `at0643`, `at0587`, `at0620`.
