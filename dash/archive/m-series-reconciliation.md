# M-Series Reconciliation — Findings & Plan

> **Note:** This document predates the canonical inventory and uses the legacy `M{NN}` prefix. Tags `M01`, `M03`, `M16`, etc. correspond to `AT0001`, `AT0003`, `AT0016`, etc. in current docs (see `tuglaws/app-test-inventory.md`). The doc is preserved verbatim for historical context per `dash/tugplan-app-test-cleanup.md`'s Non-goals.

**Status:** COMPLETE — M01, M03, M16 all green as of 2026-04-24. M03 rewritten against trusted `CGEvent`-backed clicks (Phase A, harness-extensions Step 3b) on 2026-04-24; rewrite surfaced a third production bug (pane-chrome mousedown blurred the just-restored focus). Fix landed in `pane-focus-controller.ts`.
**Last updated:** 2026-04-24
**Source runs:**
- Baseline (pre-fix): `/tmp/m-series-0abc.log`, log at commit `bd2e8bd8`.
- Post-gate-fix: `/tmp/m-series-gate-fix.log`.
- Post-save-fix (M01, M03 green): `/tmp/m-series-after-gate-save.log`.
- Final (all green): `/tmp/m-series-final.log`.
- Post-Phase-A M03 trusted-click rewrite (pane-chrome mousedown fix): see harness-extensions Step 3b commits.

**Prerequisites landed:** harness-extensions Phase 0 steps 0a (source-location capture), 0b (out-of-order annotation), 0c (store-state snapshot), 0f (trace-artifact file for post-mortem); Phase A Steps 1–3 (trusted `CGEvent` pipeline + `__tug` surface + `_smoke-native.test.ts`).

---

## Outcome

All three tests are green. Three real production bugs were found and fixed across two reconciliation passes; three test expectations were updated to match production reality that the plan had guessed wrong on. The third production bug was found during the Step 3b trusted-click rewrite of M03 — it was hidden for the synthesized-click version because `isTrusted: false` mouse events skip WebKit's default focus-clearing.

### Final result matrix

| Test | Status | Root cause(s) | Fix applied |
|---|---|---|---|
| **_smoke** | ✅ 2/2 | — | — |
| **M01** | ✅ 1/1 | (a) Focus-theft gate refused card-to-card transfer. (b) Plan's expected trace order was wrong. (c) Plan assumed fr-flip `trigger=activateCard`; production uses `_setActiveCardInPane` intra-pane. | Gate: new branch 6 (`focus-theft-gate.ts`); tests: ordering + trigger + drop fresh-card focus-call assertion. |
| **M03** | ✅ 1/1 | (a) Same gate bug. (b) Cross-pane activation path did not invoke save-callback for the outgoing card. (c) [Step 3b] Pane-chrome mousedown default blurred the A3-restored focus. | Gate: shared with M01. Wiring: `pane-focus-controller.ts` now invokes save before cross-pane activation. Mousedown: `pane-focus-controller.ts` now `preventDefault()`s mousedown on pane chrome to stop WebKit from clearing focus to body. Tests: same ordering fix as M01. |
| **M16** | ✅ 1/1 | Plan expected c3 (next sibling); production's `spliceCardFromStack` picks c1 (previous). Plan also expected "no save for closed card"; production's `flushSaveCallbackBeforeDestruction` DOES save so the M11 reopen path has state. | Test: c3 → c1; drop no-save assertion; drop caret assertion (c1 has no bag). |

### The decisive fixes

- **Production, gate:** `canProgrammaticallyFocus` got a new branch ("if activeElement is inside a different deck card, permit") — resolved M01's missing `focus-call` and unblocked the A3 path for both M01 and M03.
- **Production, cross-pane save:** `pane-focus-controller.ts` now calls `store.invokeSaveCallback(outgoingCardId)` before `store.activateCard(...)`, mirroring the intra-pane tab-switch path (`tug-pane.tsx performSelectCard`).
- **Production, pane-chrome mousedown (Step 3b):** `pane-focus-controller.ts` now installs a second document-level capture-phase listener, `onMouseDown`, that calls `event.preventDefault()` when the mousedown target is inside a pane's chrome (inside `[data-pane-id]` but outside any `[data-card-host]`). WebKit's default mousedown behavior walks up from the click target looking for a focusable element; when the target is a non-focusable pane title / frame / resize handle, WebKit clears focus to body. For the M03 flow — click pane title → pane-focus-controller activates destination card → A3 restores focus to the card's `sm` input — that default-clear ran AFTER A3 (in the same React commit cycle) and nuked the restored focus 1ms after it was set. `preventDefault` on mousedown keeps the focus set by A3 intact. Card-content clicks still get the browser default, so real input-click focus behavior is untouched. The existing pointerdown listener stays as the activation driver; we don't `preventDefault` on pointerdown because that would cancel the compatibility mouse events (mousedown / mouseup / click) entirely.
- **Tests:** three expected-subset updates to match the causally-correct production emission order (`destination-flip → fr-flip → (optional focus-call)`) and the real trigger values.

### Default-focus fallback for fresh cards — FIXED

The A3 activation effect was **bag-driven**: it called `.focus()` via `applyFocusSnapshot` only when a card had a saved `bag.focus`. Fresh cards had no bag, so no `focus-call` event fired on their first activation, and the caret stayed stranded on the outgoing card. Tab-switching into a fresh card did not move the caret. That was a bug — users expect the caret to follow the tab they just clicked, every time.

**Fix:** `card-host.tsx` now has a `resolveDefaultFocusTarget` / `traceApplyDefaultFocus` pair that drives a priority chain when the A3 effect finds no saved focus snapshot:

1. `[data-tug-focus-key="primary"]` — card author's declared primary focus target.
2. `[data-tug-focus-key]` with any value — any tagged focus target.
3. `[data-tug-persist-value]` — first persisted form control.
4. Generic focusable — input / textarea / select / button / contenteditable / tabindex≥0.

The A3 effect calls `traceApplyDefaultFocus("a3-default-focus", …)` when `bag?.focus` is missing or `{kind: "none"}`. A `focus-call` event fires with `site: "a3-default-focus"` so trace readers can distinguish default-driven focus from snapshot-restored focus. Existing focus inside the card root is respected (click-in-progress wins, same contract as `applyFocusSnapshot`).

Result: tab-switch-to-fresh-card now reliably moves the caret into the new card, both intra-pane (M01) and cross-pane (M03). M01, M03, M16 all assert the `focus-call` event on fresh-card activation and pass end-to-end.

### Step 3b: Trusted-click rewrite of M03 found the pane-chrome mousedown bug

With `_smoke-native.test.ts` green, M03 was rewritten to use `app.nativeClickAtElement` instead of `app.focusElement` / `app.click`. Every user-gesture click in the test now posts a trusted `CGEvent`-backed mousedown (`isTrusted: true`) — exactly what a real user's mouse produces.

The rewrite immediately failed with the user-reported real-world symptom: after clicking p1's title (the return trip from p2), A1's caret was NOT restored. The failure dumped via the catch block's `dumpTraceToFile` was unambiguous:

```
seq 29  focus-call    site=a3-dom-authority  cardId=A1  activeBefore=body  activeAfter=sm-A1   timestamp=894
seq 30  a3-fire       cardId=A1  focusedEl=sm-A1                                               timestamp=894
seq 31  a3-fire       cardId=A2  earlyReturn=not-destination                                   timestamp=894
seq 32  focusout      el=sm-A1   relatedTarget=null                                            timestamp=894
```

A3 focused sm-A1; 0-1ms later sm-A1 was blurred to body; no subsequent focus restoration. `document.elementFromPoint(titleCenter)` confirmed the click coord hit the title bar div, not sm-A2 — so the classification was correct; the issue was WebKit's handling of mousedown on a non-focusable target AFTER the React commit (including A3) had already run.

Why the synthesized-click version of this test passed: `app.click` dispatches `new MouseEvent("mousedown", ...)` which carries `isTrusted: false`. WebKit's default focus-clearing runs ONLY for trusted mouse events; synthesized mousedown skipped that path entirely and left A3's focus intact. The user's real-app experience (trusted mouse) exposed the gap the test was masking — exactly the fidelity-envelope hole [D09] documents and Step 3b exists to close.

The fix above (pane-chrome mousedown `preventDefault`) restores the user's mental model: a click on pane chrome activates the destination card AND leaves the user's caret where activation/A3 placed it. Previously it was a race the synthesized-click test couldn't catch.

---

## Detailed findings

### M01 — intra-pane A→B tab switch

Trace of 8 events captured during the A→B switch:

| # | seq | kind | key fields | `store.activeCardId` | `loc` (served-file) |
|---|-----|------|------------|----------------------|---------------------|
| 0 | 9  | `fr-flip`              | `to=A trigger=activateCard` (self-flip) | A | `deck-manager.ts:504:23` (same-bit branch) |
| 1 | 10 | `save-callback`        | `cardId=A source=manual` | A | `deck-manager.ts:755:21` |
| 2 | 11 | `destination-flip`     | `cardId=A to=false`      | **B** ← store already moved | `deck-manager.ts:304:29` (notify observer) |
| 3 | 12 | `destination-flip`     | `cardId=B to=true`       | B | `deck-manager.ts:304:29` (same observer) |
| 4 | 13 | `fr-flip`              | `from=A to=B trigger=_setActiveCardInPane` | B | `deck-manager.ts:518:21` (diff-bit branch) |
| 5 | 14 | `commit-tick`          | `count=3`                | B | `deck-commit-beacon.tsx:9:21` |
| 6 | 15 | `a3-fire`              | `cardId=A prev=true now=false earlyReturn=not-destination` | B | `card-host.tsx:381:23` |
| 7 | 16 | `a3-fire`              | `cardId=B prev=false now=true earlyReturn=gate-refused gatePassed=false target={kind:"none"}` | B | `card-host.tsx:381:23` |

**Three observations:**

1. **Production emits `destination-flip` BEFORE `fr-flip`.** Causally consistent: the store mutation happens first (in memory), subscribers are notified, the destination-flip observer in `deck-trace.ts:640` detects the per-card `isFocusDestination` change and records it, and only then does `_flipFirstResponder` call `deckTrace.record({kind: "fr-flip", ...})`. The plan's expected order (`fr-flip → destination-flip → focus-call`) was an informed guess written before the trace was populated against real runs.

2. **The `trigger` field on `fr-flip` is not `activateCard`.** For the intra-pane tab switch, production sets `trigger: "_setActiveCardInPane"` on the transition fr-flip (seq=13). The initial self-flip at seq=9 carries `trigger: "activateCard"` but that's the one-time startup-activation event, not the tab switch. Test's expected pattern assumed `activateCard` for the transition; reality is different.

3. **`focus-call` is ABSENT from the trace entirely.** The `a3-fire` for B at seq=16 has `earlyReturn: "gate-refused"` with `gatePassed: false`. The activation-effect ([A3]) body exits before calling `.focus()` because some gate inside `card-host.tsx` refused the call. This is a real production bug — card B becomes the active/destination card, the store says `activeCardId: B`, yet the DOM focus never transfers.

### M03 — cross-pane p1→p2 activation

Trace of 6 events:

| # | seq | kind | key fields | `store.activeCardId` | `loc` |
|---|-----|------|------------|----------------------|-------|
| 0 | 9  | `destination-flip` | `cardId=A1 to=false` | A2 | `deck-manager.ts:304:29` |
| 1 | 10 | `destination-flip` | `cardId=A2 to=true`  | A2 | `deck-manager.ts:304:29` |
| 2 | 11 | `fr-flip`          | `A1→A2 trigger=activateCard` | A2 | `deck-manager.ts:518:21` |
| 3 | 12 | `commit-tick`      | `count=3`            | A2 | — |
| 4 | 13 | `a3-fire`          | `cardId=A1 earlyReturn=not-destination` | A2 | `card-host.tsx:381:23` |
| 5 | 14 | `a3-fire`          | `cardId=A2 earlyReturn=gate-refused gatePassed=false` | A2 | `card-host.tsx:381:23` |

**Two observations:**

1. **NO `save-callback` fires during the cross-pane transition.** The test's expected subset opens with `{kind: "save-callback", cardId: "A1"}` and the matcher reports "entry #0 not found; trace length = 6" — the save never appears. Compare with M01's intra-pane path which DID emit a `save-callback` (seq=10). Distinct code paths: M01's intra-pane fr-flip has `trigger: "_setActiveCardInPane"`, M03's cross-pane fr-flip has `trigger: "activateCard"`. The save-callback wiring exists on the intra-pane path but not on the cross-pane path. **Production gap.**

2. **Same A3 gate-refusal pattern** at seq=14 (`a3-fire cardId=A2 earlyReturn=gate-refused`). Same root cause as M01 — the destination card's activation effect refuses its focus transfer. Fixing M01's gate refusal automatically fixes this half of M03.

### M16 — tab close handoff

Failed with a `TimeoutError` on `waitForCondition(getFocusedCardId() === "c3")` after 2000ms. No trace dumped in the catch block (only `tailLog(50)` runs, and the app log is boot-only — 27 lines, all pre-interaction).

**Known from prior probing** (see memory + earlier session work):

- Production picks `c1` (previous sibling) as the successor when closing active `c2`.
- Test expects `c3` (next sibling).
- Close button click path works (c2 is removed from the tab list correctly).

**Outstanding:** full trace of the close sequence. Two ways to get it:
- Land Step 0f (per-test trace artifact file) and re-run.
- One-off diagnostic: add `console.log(JSON.stringify(await app.getDeckTrace({since: markClose})))` right before `await app.expectFocusedCard("c3")`.

Either way, we'll then know whether the close path truly hard-codes "previous sibling" or whether the handoff fires a selection that later gets clobbered.

---

## Reconciliation plan — Order of operations

### Step 1 — Investigate the A3 focus-gate refusal (highest lever) — LANDED

Fixed the focus-theft gate to permit card-to-card focus transfer (new branch 6). Commit pending; diff in `tugdeck/src/focus-theft-gate.ts` and its tests.

**Root cause:** the gate's decision tree had no handling for the "active element is in another card" case. When focus is in card A's input and user clicks tab B, `activeElement` is a real element (A's input) outside the target card (B), which tripped the catch-all "don't steal focus" branch. Real fix: treat card-to-card navigation via deliberate user gesture as permissible, since the caret isn't being stolen from somewhere the user is actively engaged in — it's being moved alongside the user's explicit navigation intent.

**After the fix, a second issue surfaces** (`earlyReturn: "no-bag"` replacing `"gate-refused"`). The A3 effect's focus-restore logic is **bag-driven**: it only calls `.focus()` via `applyFocusSnapshot`, which requires a populated `bag.focus`. Fresh cards that have never been saved have no bag, so no `focus-call` event fires on their first activation. This is a separate design gap (tab-switch-to-fresh-card doesn't auto-focus the new card's primary input) that is **out of scope for today's reconciliation** — it deserves its own product decision / plan. The tests should be adjusted to match production reality: `focus-call` only fires on activation of cards with saved bags (e.g., the return trip to a card that was previously typed into).

**Starting point:** `tugdeck/src/components/chrome/card-host.tsx` around the `a3-fire` emission. The trace tells us exactly what to look for:

```
a3-fire {cardId: B, prev: false, now: true, earlyReturn: "gate-refused", gatePassed: false, target: {kind: "none"}}
```

`gatePassed: false` + `earlyReturn: "gate-refused"` + `target: {kind: "none"}` means the activation effect's gate call returned falsy, so nothing else ran.

**What to find:** the gate function (or gate-driving logic) that the A3 effect consults. It's refusing the destination card's activation despite the store correctly reflecting B as active and `isFocusDestination(B) === true`. Likely candidates: a stale reference, a race against mount, a `hostStackId` mismatch, or a condition that should be inverted.

**Reproduction:** `just test-in-app`; reading the trace's A3 fields on seq=16 is enough to identify the gate.

### Step 2 — Wire save-callback into the cross-pane activation path (M03 only)

Cross-pane activation goes through `pane-focus-controller.ts`'s capture-phase pointerdown handler, which calls `store.activateCard(A2)`. The save-callback hook exists on the intra-pane path (fires a `source: "manual"` event — M01 seq=10). It does NOT fire on the cross-pane path.

**Starting point:** compare the two call sequences:
- Intra-pane: `tab-bar click → pane.activateCard → _setActiveCardInPane → _flipFirstResponder + save-callback emit`
- Cross-pane: `pane-title click → store.activateCard → _flipFirstResponder (no save-callback emit)`

The emit at `deck-manager.ts:755` must be reachable from the cross-pane path too.

### Step 3 — Update M01 test expectations to match real trace shape

`tests/in-app/m01-tab-switch-fc.test.ts` — two edits:

1. Reorder the expected subset to `[destination-flip, fr-flip, focus-call]` (destination fires first per reality).
2. Optionally assert `trigger: "_setActiveCardInPane"` on the fr-flip so future regressions to the wrong activation path get caught.

The same test's return-trip assertion (p2→p1) needs mirror updates.

### Step 4 — Land Step 0f (trace artifact file) and reconcile M16

Per the plan, Step 0f writes `tests/in-app/logs/<test>-trace.json` on failure. With that in hand, M16's trace will reveal whether production really picks c1 unconditionally or whether there's a race.

If production unconditionally picks the previous sibling when closing the active tab: decide whether browser/editor convention (Chrome-style "previous" vs browser-tab-style "next") is load-bearing. The plan's expectation of `c3` was a guess; picking previous-sibling might actually be the right behavior (it keeps the eye on the tab visually adjacent to the closed one). If so, fix the test; otherwise fix the close logic.

### Step 5 — Update plan specs to match reality

Amend `[#s01-deck-trace-event]` (in the base harness plan) to document the real emission order:

> Production emits events in this order during an activation:
> 1. Store state mutates (active pane / active card updates in memory).
> 2. `destination-flip` records fire via the per-card observer in `deck-trace.ts`, one per card whose `isFocusDestination` bit changed. The observer reads post-mutation state, so `store.activeCardId` in the recorded event's snapshot is the NEW value.
> 3. `_flipFirstResponder` records `fr-flip` with the `trigger` naming the caller (`activateCard`, `_setActiveCardInPane`, etc.).
> 4. React commits; `commit-tick` records.
> 5. A3 activation effects run per-card; each records `a3-fire` with the decision outcome.
> 6. If A3 calls `.focus()`, the focus-call record follows.

Readers of the spec then know the causally-earliest event is the destination-flip, not the fr-flip.

---

## Harness streamlining work (tracked under Phase 0)

The investigation surfaced three follow-on polish items worth tracking:

1. **`loc` points at served-file (Vite-transformed) line numbers, not source-file line numbers.** Vite strips comments / JSDoc when serving TS modules, which shifts line numbers by ~100-300 lines in long files. The captured values still correctly distinguish different emission sites (seq=9 vs seq=13 are different fr-flip call sites), but the number doesn't open directly in a text editor. Workaround: `curl http://127.0.0.1:55155/src/<file>` and read the served file if the source number doesn't match. Real fix: either consult the inline sourcemap at capture time, or add a simple live mapping service that translates on demand. Low-urgency — the trigger/kind/store fields are plenty for M-series diagnosis.

2. **M16-shaped test failures (TimeoutError on `waitForCondition`) do not dump the trace.** Step 0f closes this — land it before moving to M16.

3. **App log tail is usually boot-only.** Tug.app doesn't emit macOS-level log lines during WebView interaction (those go to JSC's console, visible only in the WebView's own devtools). Step 0d's "tail first + 200 lines" is still worth doing but solves less than Step 0f does. The trace is the primary diagnostic surface.

---

## Cross-references

- Source run log: `/tmp/m-series-0abc.log` (441 lines after xcodebuild filter).
- Harness-extensions plan: `dash/tugplan-harness-extensions.md` (Phase 0 steps 0a–0f).
- Base harness plan (completed): archived at `.tugtool/archive/tugplan-in-app-test-harness.md`.
- Test files: `tests/in-app/m01-tab-switch-fc.test.ts`, `m03-pane-activation.test.ts`, `m16-tab-close-handoff.test.ts`.
