<!-- devise-skeleton v4 -->

## Scroll Fixups — attribution-complete follow-bottom, supersedable corrections, churn-stable geometry {#scroll-fixups}

**Purpose:** Close the remaining scroll/follow-bottom instability that surfaced during the 2026-07/08 perf work: make SmartScroll's intent model complete over *unattributable* scrolls (native scrollbar drags), make every deferred scroll write supersedable by the user, and stop the two geometry-churn generators (per-tick ledger wipes on resize, the hidden-tab batch-freeze wedge). Ships with a regression battery and a durable doctrine doc so the supersede rules stop living only in one class's comment block.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-02 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The transcript scroller is a three-layer stack: `SmartScroll` (`tugdeck/src/lib/smart-scroll.ts`) owns scroll *intent* — a UIScrollView-style phase machine (`idle | tracking | dragging | settling | decelerating | programmatic`), the follow-bottom flag, and the cold-boot restore policy (`setRestoreTarget` / `applyRestoreTarget` / `clearRestoreTarget`); `TugListView` (`tugdeck/src/components/tugways/tug-list-view.tsx`) owns *geometry* — the measured-height ledger (`HeightIndex`, `internal/list-view-height-index.ts`), the `evictOffscreen` windowing that stands exact spacer heights in for unmounted rows, and every programmatic scroll site (scrollToIndex, the two-pass correction, `pageByEntryStep`, the auto-pin battery); `CardHost` (`tugdeck/src/components/chrome/card-host.tsx`) owns *persistence* — the `[A9]` anchor save/restore protocol via `data-tug-scroll-state` and `tug-region-scroll-set`.

The E1 DOM-eviction work (commit `650da0c23`) made geometry fallible for the first time — the ledger can lie, and every lie becomes a scroll snap — while SmartScroll still assumed every user scroll arrives as a pointer/wheel/key event. Commit `746de7137` fixed the two loudest failures (the row-gap ledger deficit and the restore-vs-scrollbar fight), but a full audit (2026-08-02, this plan's parent session) found the same two weakness classes alive in four more places. The user-felt symptoms — snap-backs while scrolling toward the bottom, judder duels between manual and auto scroll, follow-bottom that can't be escaped or re-stuck — map onto findings F1–F5 below, recorded here as decisions [P02]–[P07].

The organizing doctrine, stated once and implemented throughout: **every scroll the machine cannot attribute belongs to the user**, and **no deferred scroll write survives a user gesture**. SmartScroll already applies the first rule to restore targets (the `RESTORE_SUPERSEDE_DRIFT_PX` baseline supersede); this plan applies both rules uniformly.

#### Strategy {#strategy}

- Fix intent first (Stage 1): the unattributed-scroll disengage hole and the stale-correction yanks are the bugs the user feels every day; they are small, surgical diffs to `smart-scroll.ts` and `tug-list-view.tsx`.
- Then geometry-churn stability (Stage 2): resize-tick ledger wipes and the hidden-tab settle wedge are episodic but violent (full 1500-row remounts per splitter tick; deck-wide save suspension).
- Then lock it down (Stage 3): a new app-test file pins the two doctrine rules behaviorally, and a tuglaws doc records the supersede table so future scroll writers check against it.
- Every scroll write keeps routing through existing chokepoints — no new write paths, no redesign of the three pin channels (cell-RO sync pin, container-RO pin, post-commit pin effect; all already funnel through `SmartScroll.maybePinToBottom`).
- Verification per step: `cd tugdeck && bun test`, `bunx vite build` (mandatory before declaring any tugdeck change done — the debug app loads the production rollup bundle), and selective app-tests via the named files / `just app-test-changed`.

#### Success Criteria (Measurable) {#success-criteria}

- A simulated scrollbar drag (direct `scrollTop` assignment, no pointer/wheel events) away from the bottom during streaming growth disengages follow-bottom and is not snapped back (new at0333 test green).
- A user scroll after an estimated jump voids the pending two-pass correction — no late snap to a stale target (at0333 test green).
- at0330's "turn stepping (⌥⌘↑ / ⌥⌘↓) pages across evicted rows one entry at a time" test passes: every press lands the target entry flush (±2px) with the scrollport top, including unmounted targets (run with the test window visible — a fully-covered background window freezes rAF and fails this suite as an environment artifact).
- A continuous width-resize burst produces at most one eviction suspension (`data-evict-fallbacks` increments by ≤1 across the burst), not one per tick.
- A transcript restored while `display:none` releases its batch freeze (the `deck.suspendCardStateSaves` hold drops) without waiting for reveal, and evicts normally after reveal with at most one suspension.
- Existing guards stay green: at0059, at0061, at0189, at0190, at0331, and at0330's far-scroll / selection-pin / display-none tests.
- `cd tugdeck && bun test` fully green; `bunx vite build` clean.

#### Scope {#scope}

1. SmartScroll: idle-phase disengage of follow-bottom on unattributed upward scroll, guarded by the existing one-shot programmatic-write suppression flag.
2. TugListView: two-pass scroll-correction rework — supersede-on-drift, real-rect correction, `block` recording, rebase-aware pass-1 jumps (fixes turn stepping).
3. HeightIndex: `adjustAll` patches the Fenwick cache in place instead of nulling it.
4. TugListView: settle-debounced width invalidation.
5. TugListView: hidden-tab settle release, so a background-tab restore stops wedging the batch freeze and the deck-wide card-save gate.
6. New app-test (at0333) pinning the two doctrine rules; at0330 turn-stepping goes green via item 2.
7. `tuglaws/scroll-intent.md` (the supersede-rules doctrine) and the matching amendment to the global [D93].

#### Non-goals (Explicitly out of scope) {#non-goals}

- The at0330 expand/collapse failure (disclosure click clears `data-collapsed` but the cell height and `scrollHeight` don't change). Confirmed pre-existing at HEAD and at the E1 landing commit in a pristine worktree; it is a tool-block body-mount defect (suspect area: `blocks/block-header.*`), not scroll geometry. Tracked as a follow-on (#roadmap).
- Extracting a geometry core out of `tug-list-view.tsx` or otherwise restructuring the 4900-line file. Deliberately deferred until this plan's battery exists to protect such a refactor.
- Redesigning the three pin channels or the batch-freeze machinery beyond the hidden-tab fix.
- The windowed (non-`inline`) list path — untouched; all changes are to the inline/evict path and to SmartScroll.
- Momentum/deceleration model changes; `scrollend` feature detection changes.

#### Dependencies / Prerequisites {#dependencies}

- Commit `746de7137` (`tugdash(evict): survive display:none tabs, gap drift, and turn stepping`) — this plan builds directly on its row-gap sync, zero-box guards, hidden-window hold, and restore-baseline supersede.
- Commit `6d399153f` — CardHost's one-shot settle for `meta.anchor` / `meta.atBottom` regions; this plan assumes that protocol and does not change CardHost.
- App-test environment caveat: at0330 and any rAF-dependent scroll suite require the test window to be genuinely visible; a fully-covered background window reads `visibilityState: "hidden"` and fails deterministically (documented in `dash/aug01-perf-brief.md`).

#### Constraints {#constraints}

- WARNINGS ARE ERRORS across the repo; `bunx vite build` must pass before any tugdeck change is called done.
- The no-estimates contract: eviction spacer geometry may only ever sum *measured* heights. Nothing in this plan introduces an estimated height into live scroll geometry — the one construction that would have ([P07]'s rejected tail hold) is dropped for exactly that reason.
- Pixel-identical transcript: no visible rendering changes of any kind.
- Only the user commits; each step ends at a commit boundary for the user's (or authorized autonomous) landing.

#### Assumptions {#assumptions}

- Native scrollbar drags deliver **no** pointer or wheel events to the scroll container in WKWebView — established empirically during the 746de7137 investigation (it is the premise of the existing `RESTORE_SUPERSEDE_DRIFT_PX` mechanism).
- `pinToBottom` and the prepend compensation only ever move `scrollTop` *down* (toward larger values), and browser clamps land exactly at the bottom where `isAtBottom` is true — both verified in the audit; they are what makes an upward-only unattributed disengage safe ([P02]).
- ResizeObserver delivers an initial notification on `observe()` even for a `display:none` (0×0) element — the hook the hidden-tab settle release rides on ([P07]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `[Q##]` questions, `R##` risks, `S##` specs, `#step-N` execution anchors, `**Depends on:**` lines with anchor refs, and rich `**References:**` lines with no line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should the unattributed disengage carry a pixel threshold? (DECIDED — see [P02]) {#q01-disengage-threshold}

**Question:** The restore supersede uses an 8px drift baseline; should the new idle-phase follow-bottom disengage require a similar minimum upward movement before firing?

**Why it matters:** Too eager and layout jitter could spuriously drop follow-bottom during streaming; too lax and a scrollbar drag stays trapped.

**Resolution:** DECIDED (see [P02]) — no extra threshold. The existing `!isAtBottom` guard already provides a 60px band (`AT_BOTTOM_PX`), which is the same jitter guard the `dragging`-phase disengage relies on; sub-pixel clamp jitter at the bottom cannot cross it. Start without a threshold; the deck-trace `source` tag (`unattributed-scroll-up`) makes any false-positive attributable if one ever appears.

#### [Q02] Width-invalidation debounce interval (DECIDED — see [P06]) {#q02-debounce-interval}

**Question:** How long after the last width change before the ledger wipe + re-measure fires?

**Resolution:** DECIDED — 200ms trailing. Long enough that a live splitter drag (continuous per-frame fires) coalesces to one wipe at rest; short enough that a single discrete resize (window snap, pane preset) re-measures promptly. A plain `setTimeout` restarted per observer fire; no rAF (background app-test windows run no rAF).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Unattributed disengage fires on a non-user scroll | med | low | Upward-only + `!isAtBottom` + suppression-flag guard; deck-trace source tag | Any spurious `unattributed-scroll-up` trace entry on a quiet deck |
| Stale-but-stable geometry mid-resize reads wrong | low | med | Bounded to the drag window; one wipe at settle restores exactness | User-visible scrollbar misproportion during drags |
| Hidden-tab settle release lets an unfrozen settle storm run at reveal | low | low | Reveal delivers one coalesced RO burst; pins are idempotent | perf.transcript_settle regressions on tab switches |
| Real-rect correction lands differently than ledger correction in some path | med | low | Fall back to ledger arithmetic when the element is unmounted at correction time | at0330 turn-stepping or find-reveal regressions |

**Risk R01: Escaping follow-bottom from inside the at-bottom band via scrollbar** {#r01-band-escape}

- **Risk:** A scrollbar drag that starts at the bottom produces upward scroll events still inside the 60px `AT_BOTTOM_PX` band; those do not disengage, so growth pins can yank back until the drag crosses the band.
- **Mitigation:** Accepted. The thumb is held by the mouse, so the very next drag movement re-asserts the user's position and crosses the band within a few events; wheel and keyboard paths already disengage band-free.
- **Residual risk:** A few frames of tug-of-war at the start of a from-the-bottom scrollbar drag during heavy streaming.

**Risk R02: Correction supersede voids a legitimate correction** {#r02-correction-void}

- **Risk:** The drift check (|live scrollTop − armed top| > 8px) could void a correction whose pass-1 jump was clamped by the browser (target beyond `scrollHeight` at write time).
- **Mitigation:** Record `armedTop` as the **post-write read-back** of `scrollTop` (clamping folded in), exactly as `applyRestoreTarget` records `_restoreBaselineTop`. Then only an actor other than the write itself can produce drift.
- **Residual risk:** None identified; the same mechanism has run clean in `applyRestoreTarget` since 746de7137.

**Risk R03: at0330 environment artifacts read as regressions** {#r03-env-artifacts}

- **Risk:** A covered/hidden test window freezes rAF; far-scroll and turn-stepping fail deterministically with a ~420px hole regardless of code state.
- **Mitigation:** Run scroll app-tests with the window visible; treat a red rAF-dependent suite on a busy machine as suspect until `visibilityState` is confirmed `"visible"` (per `dash/aug01-perf-brief.md`).

---

### Design Decisions {#design-decisions}

#### [P01] Attribution doctrine: unattributed scrolls belong to the user; no deferred write survives a gesture (DECIDED) {#p01-attribution-doctrine}

**Decision:** Every scroll movement SmartScroll cannot attribute to itself (its own programmatic writes, pins, restores) is treated as user intent; and every deferred scroll write (restore heartbeat, two-pass correction) is voided the moment the user — attributably or not — moves the scroller.

**Rationale:**

- The 2026-08 regressions all reduce to violations of one of these two rules: the restore-vs-scrollbar fight (fixed in 746de7137), the follow-bottom-vs-scrollbar duel ([P02]), and the stale correction yank ([P03]).
- SmartScroll already implements the pattern once (`_restoreBaselineTop` + `RESTORE_SUPERSEDE_DRIFT_PX = 8`); extending it is consistency, not novelty.

**Implications:**

- Any future code that writes `scrollTop` outside SmartScroll's chokepoints must either route through them or be defensible under this doctrine; the tuglaws doc (#step-9) is where the rule becomes reviewable.

#### [P02] Idle-phase follow-bottom disengage on unattributed upward scroll (DECIDED) {#p02-idle-disengage}

**Decision:** In `SmartScroll._handleScroll`'s `idle` case, an upward scroll (`scrollTop < _lastScrollTop`) while `_isFollowingBottom` and `!isAtBottom` disengages follow-bottom with deck-trace source `"unattributed-scroll-up"`, unless the one-shot post-programmatic suppression flag was armed for this event.

**Rationale:**

- Today the `idle` case handles only *re-engagement*; a native scrollbar drag (no pointer/wheel events; phase stays `idle`) therefore cannot disengage, and during streaming every cell-RO sync pin and post-commit pin slams `scrollTop` back to the bottom — the felt "judder duel."
- Safety: pins and prepend compensation only move `scrollTop` down; `scrollHeight`-shrink clamps land at the bottom where `isAtBottom` guards; explicit programmatic writes route through `_writeScrollTop`, which arms `_suppressIdleReengagementOnNextScroll` — the same captured flag (`suppressIdleReengage` local) must gate this disengage too, so a non-animated programmatic up-jump (which exits `programmatic` synchronously via `_exitProgrammaticImmediate` before its deferred scroll event arrives in `idle`) never reads as a user scroll.
- No pixel threshold beyond the `AT_BOTTOM_PX` band — see [Q01].

**Implications:**

- The class doc block's supersede-rules list (`smart-scroll.ts`, "Public API — cold-boot scroll restore" comment and the constant's doc) gains the symmetric follow-bottom bullet.
- Downward unattributed scrolls keep the existing conservative idle re-engagement — a scrollbar drag *to* the bottom re-engages, unchanged.
- **This overturns a clause of the global [D93], which must be amended in the same landing** — see [P09]. Leaving it unamended would leave `tuglaws/design-decisions.md` instructing future implementers to remove this very disengage.

#### [P03] Two-pass corrections are supersedable and correct against the real rect (DECIDED) {#p03-correction-supersede}

**Decision:** `pendingScrollCorrectionRef` in `tug-list-view.tsx` grows from `{index, estimatedTop}` to `{index, estimatedTop, block, armedTop}`; the post-commit correction effect (a) voids the pending correction when `Math.abs(el.scrollTop − pending.armedTop) > 8` (someone moved the scroller since pass 1 — user gesture, attributable or not), and (b) when the target row is mounted at correction time, corrects via `SmartScroll.scrollToElement(el, {block: pending.block, animated: false})` instead of re-deriving `offsetForIndex + leadingOffsetPx()`.

**Rationale:**

- Today a correction armed by `scrollToIndex` / a find reveal / a cursor move / `pageByEntryStep` survives until the target row happens to be measured, then issues an unconditional `scrollTo` — a snap to a stale target mid-user-scroll, with no supersede of any kind.
- The ledger-arithmetic correction recomputes the *same* number as pass 1, so it can never repair what pass 1 actually gets wrong: the scroll container's `::before`/`::after` breathing-room pseudo-elements and window chrome that no cell's box (hence no ledger entry) contains — exactly the hazard `internal/list-view-page-navigation.ts`'s module doc names. The mounted row's `getBoundingClientRect` is the only faithful source; `scrollToElement` already computes flush placement from it.
- `armedTop` is the post-write read-back of `scrollTop` (clamping folded in), mirroring `applyRestoreTarget`'s `_restoreBaselineTop` — see Risk R02.

**Implications:**

- All three arming sites update to the new shape: `scrollToIndex` (imperative handle; default block `"start"`), `scrollIndexIntoView` (cursor path; block `"nearest"`), and `pageByEntryStep` (block `"start"`).
- When the row is measured but *not* mounted at correction time (re-evicted before the effect ran), fall back to today's ledger arithmetic plus the rebase term ([P04]) — strictly better than today, still supersedable.
- A `"nearest"`-armed correction no longer force-jumps the row to the viewport top (today's behavior applies start semantics to every correction).

#### [P04] Pass-1 estimated jumps carry the rect-space rebase (DECIDED) {#p04-rebase-jumps}

**Decision:** Extract the rebase computation already present in `pageByEntryStep` — `rebase = mountedCellRect.top − viewTop − ledgerTopFor(mountedIndex)`, where `ledgerTopFor(i) = heightIndex.offsetForIndex(i) + leadingOffsetPx() − scrollEl.scrollTop` — into a helper, and add the rebase to every unmounted-target pass-1 jump (`pageByEntryStep`, `scrollToIndex`, `scrollIndexIntoView`) when at least one mounted cell exists to derive it from (under eviction one always does).

**Rationale:**

- The at0330 turn-stepping failure's mechanism: `pageByEntryStep` computes the rebase for its *selection* math and then discards it for the *jump*, landing the entry `rebase` px shy of flush; [P03]'s old ledger correction then recomputes the identical rebase-less number, making the error permanent. The observed failure ("no entry landed flush with the scrollport top") is this.
- With the rebase applied, pass 1 usually lands exact and pass 2 becomes a no-op (|corrected − armed| under the 4px `SCROLL_CORRECTION_THRESHOLD_PX`), eliminating the visible double-jump.

**Implications:**

- The helper reads live DOM (`getBoundingClientRect` of one mounted cell) — acceptable: these are explicit user-gesture paths, not per-commit hot paths.

#### [P05] `HeightIndex.adjustAll` patches the Fenwick cache in place (DECIDED) {#p05-adjustall-cache}

**Decision:** Instead of `this.cache = null`, `adjustAll(delta)` updates the cache when present: apply the clamped delta to `effective[]` for every measured index in `[0, itemCount)` and rebuild `bit[]` with the existing O(n) linear-construction sweep (the same code `prepare` uses).

**Rationale:**

- Today nothing re-runs `prepare` after invalidation — the priming effect is keyed on `[itemCount, estimatedHeightForKindOnly]`, neither of which changes on a gap rebase — so the per-commit anchor-state writer (`indexForOffset` + `offsetForIndex` every commit) degrades to O(n) walks for the rest of the session after any gap change. Correctness is unaffected (the fallback path is exact); this is a pure perf repair.

**Implications:**

- Extend `tugdeck/src/components/tugways/internal/__tests__/list-view-height-index.test.ts`: after `prepare` + `adjustAll`, `offsetForIndex`/`indexForOffset`/`totalHeight` agree with a freshly-`prepare`d twin (proves the in-place rebuild), including the clamp-at-0 case.

#### [P06] Width invalidation is settle-debounced, with the ledger frozen across the window (DECIDED) {#p06-width-debounce}

**Decision:** The width-invalidation ResizeObserver in `tug-list-view.tsx` (the effect keyed on `[inline, offscreenSkip, evictModeEnabled]`) no longer wipes per fire. On a qualifying width change (width > 0, |width − lastWidth| ≥ 0.5) it restarts a 200ms trailing `setTimeout` and raises a **width-settle-pending** flag; only when the timer fires does it run today's invalidation body (update `lastWidth`, `syncRowGap()`, strip `data-cv-ready` + `contain-intrinsic-size` stamps, `heightIndexRef.clear()`, `scrollTick()`) and lower the flag. **While the flag is up, the cell ResizeObserver writes nothing into the ledger** — same early-return shape as the existing zero-box guard. The effect cleanup clears any pending timer and lowers the flag.

**Rationale:**

- Today every ≥0.5px width tick during a live splitter drag wipes the whole ledger → the coverage predicate fails → a full ~1500-row mount → full re-measure → eviction re-arms → the next tick wipes again. A mass mount/unmount cycle per drag frame is a guaranteed judder generator and defeats eviction exactly when the machine is busiest.
- The ledger freeze is what makes the pending window genuinely *stale but stable*. Without it the window is stale and **drifting**: mounted rows keep re-measuring at the new width through the cell ResizeObserver while unmounted rows retain old-width entries, so the spacer sums — and therefore `scrollHeight` — move continuously under the user for the whole drag, which is the exact snap-back class this plan exists to eliminate. Freezing makes the geometry uniformly old-width and motionless until the settle wipe re-measures everything; nothing is lost, because that wipe discards those writes anyway.
- Coverage stays true through the drag (every entry is still present and untouched), so eviction keeps running rather than suspending; the one wipe at settle restores exactness.
- 200ms trailing per [Q02]; `setTimeout`, not rAF (background app-test windows suspend rAF).

**Implications:**

- One eviction suspension per resize *gesture* instead of one per tick — assertable via `data-evict-fallbacks` (#step-6 test).
- The width-0 skip (hidden tab is not a width change) is preserved unchanged and sits before the debounce.
- `offscreenSkip` stamping pauses with the ledger during the window; the stamps are stripped at settle and re-earned on the following re-measure, which the existing stamp-before-height-gate logic already handles.

#### [P07] Hidden-tab settle release (DECIDED) {#p07-hidden-settle}

**Decision:** In the cell ResizeObserver callback's zero-box early return (`scroller.offsetWidth === 0`), run the existing settle handshake before returning when it is armed (`isScrollBatteryFrozen() && !firstSettleFiredRef.current` → set fired, clear `initialSettlePendingRef`, call `onFirstSettleRef.current?.()`, `scrollTick()`). Refactor the handshake block into one closure used by both the normal path and this one. **No change to the eviction window decision** — a first mount while hidden keeps today's full-mount behavior; see the rejected alternative below.

**Rationale:**

- A session card restored in a background tab (`display:none`) mounts its rows hidden; every RO delivery reports 0×0 and the zero-box guard (correct for ledger integrity) skips the whole callback — *including* the settle handshake. `batchLoading` therefore never falls, the scroll battery stays frozen, and the transcript card holds `deck.suspendCardStateSaves()` (the `cardSaveGateActive` effect in `session-card-transcript.tsx`) for as long as the tab stays hidden — deferring every card's state saves deck-wide. A hidden card's settle is vacuous (nothing lays out, so there is nothing for the freeze to protect): release it. The freeze's falling-edge pin is a no-op against zero geometry; at reveal, the 0→real RO burst re-pins through the normal channels (sync pin + `pinRequestedRef`).
- **Rejected alternative — synthesizing a held tail range for a first-mount-hidden card** (so it doesn't mount everything while in a background tab). It reads as free residency relief and is not: on a first mount while hidden the ledger is *empty* (the zero-box guard skipped every 0×0 delivery), so the held range's spacers would be pure `estimatedHeightForKindOnly` values — on the order of 60px × n against true heights several times that. A tab reveal is a CSS `display` change from outside React, so the browser lays out with those estimate-derived spacer heights for at least one frame before any ResizeObserver fires: `scrollHeight` is wrong by a large factor, `scrollTop` is clamped to that fake maximum, and the clamp then trips the very drift supersedes this plan depends on (`_restoreBaselineTop` in `applyRestoreTarget`, and [P03]'s `armedTop`) — the pending anchor restore is discarded and the user lands in the wrong place. That trades a real correctness hazard for temporary DOM residency in a tab nobody is looking at, in a plan whose purpose is stability. Deferred to (#roadmap) where it can be done properly (e.g. gated on the ledger already covering the non-held range).

**Implications:**

- The save gate is held only across genuinely active, visible loads.
- A background-tab card keeps full DOM residency until first shown — accepted, and bounded by the reveal.

#### [P08] The doctrine lives in tuglaws, not only in a class comment (DECIDED) {#p08-doctrine-doc}

**Decision:** Write `tuglaws/scroll-intent.md`: the two doctrine sentences ([P01]), the full supersede table (which actors' writes yield to which), the attribution inventory (which gestures produce which events in WKWebView, including the scrollbar's silence), and the rule that new `scrollTop` writers must route through SmartScroll or justify themselves against the table. Cross-link it from `tuglaws/tuglaws.md`'s index if one lists topic docs.

**Rationale:**

- Every regression in this cycle was a scroll writer added without checking the supersede rules — which currently exist only as a comment block inside `smart-scroll.ts`. Making them a reviewable law surface is the cheapest recurrence prevention in the plan.

#### [P09] Amend the global [D93] in the same landing as [P02] (DECIDED) {#p09-amend-d93}

**Decision:** `tuglaws/design-decisions.md` D93's phase-guard sentence is rewritten as part of this plan. It currently reads *"If the phase is `idle` or `programmatic` and scroll changes, we caused it — ignore."* It becomes: a scroll change while `programmatic` — or while `idle` with the post-programmatic one-shot suppression armed — is ours and is ignored; an otherwise-unattributed `idle` scroll is the **user**, chiefly the native scrollbar, whose drag emits no pointer or wheel events, and an upward one outside the at-bottom band disengages follow-bottom. D93 gains a cross-link to `tuglaws/scroll-intent.md`.

**Rationale:**

- [P02] overturns exactly the clause quoted above; the premise "idle ⇒ we caused it" is what the scrollbar falsifies, and it is the root of the judder duel. Shipping the fix while leaving D93 unamended leaves the repo's own decision record instructing a future implementer to delete the disengage — and `CLAUDE.md` directs tugdeck work to be verified against `design-decisions.md`, so the contradiction is load-bearing, not cosmetic.
- The rest of D93 (the six phases, the six listeners, the transition table) is unchanged and correct.

**Implications:**

- The amendment lands in #step-9 alongside `scroll-intent.md`, so the doctrine and the decision record land together.
- The stale local `[D04]` tag on `pinToBottom`'s doc comment in `smart-scroll.ts` (D04 is the theme-engine recipe registry, nothing to do with scroll) is normalized to `[D93]` in #step-1 — the same normalization `design-decisions.md` records having applied to a stale local `[D07]` tag in `card-host.tsx`.

---

### Deep Dives {#deep-dives}

#### The scroll-write inventory (who writes `scrollTop`, and under what attribution) {#write-inventory}

All writers found in the audit, for the implementer's orientation and for the tuglaws doc:

| Writer | Path | Phase / attribution | Direction |
|---|---|---|---|
| `SmartScroll.scrollTo` / `scrollToTop` / `scrollToBottom` / `scrollToElement` | `smart-scroll.ts` | `programmatic` (suppress flag armed); clears restore target | any |
| `applyRestoreTarget` heartbeat | `smart-scroll.ts` via `_writeScrollTop` | `programmatic`; preserves its own target; baseline-drift supersede | any |
| `pinToBottom` (three channels: cell-RO sync pin, container-RO pin, post-commit pin effect) | `smart-scroll.ts` / `tug-list-view.tsx` | deliberate raw write, stays `idle` ([D93]); idempotent | down only |
| Prepend compensation | `tug-list-view.tsx` front-insert layout effect | raw write, `idle` | down only (adds content above) |
| Two-pass correction (pass 2) | `tug-list-view.tsx` correction effect | routes through `scrollTo` | any — the [P03] target |
| Find-reveal band nudges | `session-card-transcript.tsx` `settleFindReveal` | raw `scrollTop +=` after an explicit disengage | small, gesture-scoped |
| Browser clamp on `scrollHeight` shrink | — | unattributed, lands at bottom (`isAtBottom` true) | up, guarded |
| User: wheel / keys / pointer drag | — | attributed via listeners → `dragging` | any |
| User: native scrollbar drag | — | **no events; `idle`** — the [P02]/[P01] subject | any |

#### Why the ledger can't see flush-to-top (the rebase term) {#rebase-term}

The scroll container's content stack is: container `::before` breathing spacer → `.tug-list-view-leading` (Z0 strip) → top spacer → `.tug-list-view-window` (flex column with `row-gap`; the rendered cells) → trailing → bottom spacer → `::after`. Ledger entries are outer extents (measured cell height + row gap; the gap arithmetic is exact per the `syncRowGap` doc block), and `leadingOffsetPx()` accounts for the Z0 strip — but the `::before` breathing room and any window-level chrome belong to no cell and no tracked element, so `offsetForIndex + leadingOffsetPx()` is systematically short of a row's true document offset by that constant. Anchor save/restore is immune (save and restore use the same formula, so the constant folds into `anchor.offset`); *flush placement* is not — hence [P04]. The rebase derived from any mounted cell captures the whole constant without naming its parts.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Follow-bottom disengage on unattributed scroll | local-data (SmartScroll internal) | existing `_isFollowingBottom` + `_setFollowingBottom` chokepoint; deck-trace record | [L07], [D93] |
| `pendingScrollCorrectionRef` extended shape (`block`, `armedTop`) | local-data | `useRef`, written imperatively at arm/void time | [L24], [L07] |
| Width-invalidation settle timer + pending flag | local-data | effect-local `setTimeout` handle + ref, both cleared on cleanup | [L03], [L07] |
| Hidden-tab settle release | local-data | existing refs (`firstSettleFiredRef`, `initialSettlePendingRef`) via a shared closure | [L04], [L07] |
| Fenwick cache in-place rebuild | non-React module (`HeightIndex`) | class-internal arrays | — |

**Spec S01: the unattributed-disengage predicate** {#s01-disengage-predicate}

In `_handleScroll`, `idle` case, evaluated with the already-captured `suppressIdleReengage` local (the one-shot flag is consumed before the switch, unchanged):

```
if (!suppressIdleReengage
    && this._isFollowingBottom
    && scrollTop < this._lastScrollTop
    && !this.isAtBottom) {
  this._setFollowingBottom(false, 'unattributed-scroll-up');
}
```

Placed alongside (mutually exclusive by direction with) the existing re-engagement check. The lazy `_lastScrollTop` seeding already guarantees the first-ever scroll event carries no phantom direction (`_lastScrollTop === scrollTop` on the seeding event).

**Spec S02: the correction record** {#s02-correction-record}

```
{ index: number; estimatedTop: number; block: ScrollLogicalPosition; armedTop: number }
```

`estimatedTop` keeps its current meaning (the ledger-derived target, now rebase-inclusive) for the ledger-fallback correction path; `armedTop` is `el.scrollTop` read back immediately after the pass-1 write. Void condition checked first in the correction effect: `Math.abs(el.scrollTop − pending.armedTop) > 8` → clear the ref, do nothing. Tolerance matches `RESTORE_SUPERSEDE_DRIFT_PX` and CardHost's `REGION_SCROLL_TOLERANCE_PX`.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0333-follow-bottom-unattributed.test.ts` | Behavioral pin of [P01]/[P02]/[P03]: scrollbar-simulated disengage under streaming; gesture voids a pending correction; downward unattributed re-engage unchanged |
| `tuglaws/scroll-intent.md` | The supersede-rules doctrine ([P08]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `_handleScroll` (idle case) | method | `tugdeck/src/lib/smart-scroll.ts` | add Spec S01 disengage; extend class doc block supersede list |
| `pendingScrollCorrectionRef` | ref shape | `tugdeck/src/components/tugways/tug-list-view.tsx` | Spec S02; all three arming sites + the correction effect |
| `rectSpaceRebase()` (new, name at implementer's discretion) | helper fn | `tugdeck/src/components/tugways/tug-list-view.tsx` | extracted from `pageByEntryStep`; used by all pass-1 jumps ([P04]) |
| `pageByEntryStep` | callback | `tugdeck/src/components/tugways/tug-list-view.tsx` | rebase-aware jump; new correction record |
| `scrollToIndex` / `scrollIndexIntoView` | handle / callback | `tugdeck/src/components/tugways/tug-list-view.tsx` | rebase-aware jump; record `block` |
| `HeightIndex.adjustAll` | method | `tugdeck/src/components/tugways/internal/list-view-height-index.ts` | in-place cache rebuild ([P05]) |
| width-invalidation observer effect | effect | `tugdeck/src/components/tugways/tug-list-view.tsx` | settle-debounced + ledger-freeze flag ([P06]) |
| cell-RO callback guards + settle-handshake closure | effect internals | `tugdeck/src/components/tugways/tug-list-view.tsx` | zero-box branch runs the handshake ([P07]); width-settle-pending early return ([P06]) |
| D93 phase-guard sentence | decision text | `tuglaws/design-decisions.md` | amended per [P09] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/scroll-intent.md` written and cross-linked ([P08], #step-9).
- [ ] `smart-scroll.ts` class doc block: supersede-rules list gains the unattributed-disengage bullet.
- [ ] at0330/at0333 header docblocks carry `@covers` lines resolving to the touched sources (`just app-test-covers-check` enforces).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun test`, `tugdeck/`) | Pure-module exactness: `HeightIndex.adjustAll` cache parity | #step-4 |
| **App-test (behavioral)** | Real Tug.app, real WebKit scroll physics: disengage, supersede, flush stepping, resize churn, hidden-tab release | #step-5, #step-7, #step-8 |
| **Build gate** | `bunx vite build` — production rollup must stay loadable | every step |

#### What stays out of tests {#test-non-goals}

- jsdom/fake-DOM SmartScroll simulations — banned pattern (real code paths on real content only); the phase machine's behavior is pinned in app-tests against real WebKit instead.
- The three pin channels' internal redundancy — covered indirectly by at0189 (at-bottom no-slam) and at0330 far-scroll; not worth brittle direct assertions.
- Scrollbar-drag *pixel* fidelity — the simulation is a direct `scrollTop` assignment, which is attribution-identical to a real thumb drag (both are event-silent); actual thumb-grab automation is not attempted.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every checkpoint below assumes the repo root unless a `cd` is shown. App-test steps require a visible test window (Risk R03).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | SmartScroll: unattributed-scroll disengage | done | `143c2124a` |
| #step-2 | TugListView: supersedable, real-rect corrections | done | `3244b2dbc` |
| #step-3 | TugListView: rebase-aware pass-1 jumps (turn stepping) | done | `ed3e53f34` |
| #step-4 | HeightIndex: adjustAll cache patch | done | `dc8dea609` |
| #step-5 | Stage-1 integration checkpoint | done | N/A (verification only; guard suite green, turn-stepping green, expand round-trip pre-existing red per #non-goals) |
| #step-6 | Width invalidation settle-debounce + ledger freeze | done | `13b86021c` |
| #step-7 | Hidden-tab settle release | done | `8bc8b69a1` |
| #step-8 | at0333: doctrine behavioral pins | done | `525efbe76` |
| #step-9 | tuglaws/scroll-intent.md + D93 amendment | done | `457ca4ff4` |
| #step-10 | Final integration checkpoint | done | N/A (verification only; bun test 5490 green, vite build clean; derived selection: every background-tier file green — at0122/41/42/60/62, at0189, at0190, at0202, at0245, at0256, at0287, at0330 6/7 (only the pre-existing #non-goals expand red), at0331, at0333 — while 11 foreground-tier files timed out at the harness's `document.hasFocus()` preflight with the machine unattended, failing identically at unmodified main; re-run those with the machine attended: at0127, at0218, at0248, at0249, at0250, at0267, at0277, at0278, at0282, at0283×2) |

#### Step 1: SmartScroll — disengage follow-bottom on unattributed upward scroll {#step-1}

**Commit:** `tugdeck(smart-scroll): disengage follow-bottom on unattributed upward scroll`

**References:** [P01] Attribution doctrine, [P02] Idle disengage, [P09] D93 amendment (citation normalization half), Spec S01, Risk R01, (#write-inventory, #q01-disengage-threshold)

**Artifacts:**

- `tugdeck/src/lib/smart-scroll.ts`: Spec S01 predicate in `_handleScroll`'s idle case; doc-block supersede list updated; `pinToBottom`'s stale `[D04]` tag normalized to `[D93]`.

**Tasks:**

- [ ] Add the Spec S01 disengage to the `idle` case, gated on the captured `suppressIdleReengage` local (do not re-read the instance flag — it is cleared before the switch).
- [ ] Extend the class doc block's supersede-rules commentary and the `RESTORE_SUPERSEDE_DRIFT_PX` narrative with the symmetric follow-bottom rule.
- [ ] Audit that no existing raw downward writer (`pinToBottom`, prepend compensation) can produce an upward idle event; record the audit conclusion in the code comment (one sentence, mechanism only). Prior audit finding to re-verify rather than re-derive: inside the transcript scroller the only raw *upward* writers are `focus-reveal.ts`'s `revealWithin` and the transcript's `settleFindReveal`, and both call `disengage(...)` before writing — so the new predicate never fights them.
- [ ] Normalize the stale `[D04]` tag in `pinToBottom`'s doc comment to `[D93]` (D04 is the theme-engine recipe registry; the scroll-phase decision is D93) — [P09].

**Tests:**

- [ ] Behavioral coverage lands in #step-8 (at0333); this step's gate is the existing guard suite staying green.

**Checkpoint:**

- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0189-transcript-atbottom-no-slam.test.ts tests/app-test/at0190-transcript-anchor-restore.test.ts tests/app-test/at0331-region-scroll-anchor-one-shot.test.ts`

---

#### Step 2: TugListView — supersedable, real-rect two-pass corrections {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(list-view): void stale scroll corrections on drift, correct against the real rect`

**References:** [P01] Attribution doctrine, [P03] Correction supersede, Spec S02, Risk R02, (#write-inventory, #rebase-term)

**Artifacts:**

- `tugdeck/src/components/tugways/tug-list-view.tsx`: Spec S02 record shape; correction effect rework; three arming sites updated.

**Tasks:**

- [ ] Extend `pendingScrollCorrectionRef` to Spec S02's shape; populate `armedTop` from the post-write `scrollTop` read-back at each arming site (`scrollToIndex` unmounted branch, `scrollIndexIntoView` unmounted branch, `pageByEntryStep` unmounted branch); record each site's `block` (`"start"`, `"nearest"`, `"start"` respectively).
- [ ] In the post-commit correction effect: first the drift void (|`el.scrollTop` − `armedTop`| > 8 → clear, return); then, if `cellElementMapRef.current.get(pending.index)` is mounted, correct via `ss.scrollToElement(el, {block: pending.block, animated: false})` and clear; else keep today's ledger-arithmetic fallback (threshold `SCROLL_CORRECTION_THRESHOLD_PX` unchanged) against the rebase-inclusive `estimatedTop`.
- [ ] Preserve the existing invalidation on exact-rect scrolls (`scrollToElement` paths still clear a pending correction).

**Tests:**

- [ ] Behavioral coverage in #step-8; at0330 turn-stepping completes in #step-3.

**Checkpoint:**

- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 3: TugListView — rebase-aware pass-1 jumps; turn stepping lands flush {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(list-view): fold the rect-space rebase into estimated scroll jumps`

**References:** [P04] Rebase jumps, [P03] Correction supersede, Risk R03, (#rebase-term)

**Artifacts:**

- `tugdeck/src/components/tugways/tug-list-view.tsx`: extracted rebase helper; rebase-inclusive jumps at all three unmounted-target sites.

**Tasks:**

- [ ] Extract the rebase derivation from `pageByEntryStep` (first mounted cell in `cellElementMapRef` vs `ledgerTopFor`) into a helper returning `number | null` (null when no cell is mounted).
- [ ] Apply the rebase (when non-null) to the pass-1 `scrollTo` target and to the recorded `estimatedTop` in `pageByEntryStep`, `scrollToIndex`, and `scrollIndexIntoView`.

**Tests:**

- [ ] at0330 "turn stepping (⌥⌘↑ / ⌥⌘↓) pages across evicted rows one entry at a time" — flush within ±2px per press, including unmounted targets.

**Checkpoint:**

- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0330-transcript-eviction.test.ts` — turn-stepping test green (expand round-trip remains red per #non-goals; window visible per Risk R03)

---

#### Step 4: HeightIndex — adjustAll patches the Fenwick cache in place {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck(list-view): rebase the height ledger's Fenwick cache in place on gap change`

**References:** [P05] adjustAll cache, (#symbols)

**Artifacts:**

- `tugdeck/src/components/tugways/internal/list-view-height-index.ts`: in-place `effective[]` update + O(n) `bit[]` rebuild in `adjustAll`.
- `tugdeck/src/components/tugways/internal/__tests__/list-view-height-index.test.ts`: parity tests.

**Tasks:**

- [ ] In `adjustAll`, when `this.cache !== null`: update `effective[i]` for every measured index in `[0, itemCount)` with the clamped new value, zero-fill and rebuild `bit[]` via the linear sweep `prepare` uses (factor the sweep into a private helper shared by both).
- [ ] Keep the no-cache path (map-only rebase) unchanged.

**Tests:**

- [ ] Unit: `prepare` → `adjustAll(±delta)` → `offsetForIndex` / `indexForOffset` / `totalHeight` equal a fresh instance given the adjusted heights + fresh `prepare`; include a clamp-at-0 entry and an unmeasured-index estimate mix.

**Checkpoint:**

- [ ] `cd tugdeck && bun test src/components/tugways/internal/__tests__/list-view-height-index.test.ts`
- [ ] `cd tugdeck && bun test && bunx vite build`

---

#### Step 5: Stage-1 integration checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P02] [P03] [P04] [P05], (#success-criteria)

**Tasks:**

- [ ] Full guard-suite pass over the Stage-1 diffs; confirm `data-evict-fallbacks` stays 0 on a settled visible transcript.

**Tests:**

- [ ] Aggregate app-test run below.

**Checkpoint:**

- [ ] `just app-test tests/app-test/at0330-transcript-eviction.test.ts tests/app-test/at0331-region-scroll-anchor-one-shot.test.ts tests/app-test/at0061-region-scroll-anchor-apply.test.ts tests/app-test/at0190-transcript-anchor-restore.test.ts tests/app-test/at0189-transcript-atbottom-no-slam.test.ts tests/app-test/at0059-region-scroll-anchor-save.test.ts`

---

#### Step 6: Width invalidation settle-debounce + ledger freeze {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(list-view): coalesce width invalidation to resize settle, freeze the ledger across it`

**References:** [P06] Width debounce, [Q02] interval, (#state-zone-mapping)

**Artifacts:**

- `tugdeck/src/components/tugways/tug-list-view.tsx`: debounced width-invalidation observer effect + width-settle-pending ledger freeze in the cell ResizeObserver.

**Tasks:**

- [ ] Wrap today's invalidation body in a 200ms trailing `setTimeout` restarted per qualifying fire; keep the width-0 hidden-tab skip *before* the debounce and untouched; clear the timer in effect cleanup; update `lastWidth` only when the timer body runs (so intermediate widths keep restarting it against the original baseline).
- [ ] Raise a width-settle-pending ref while the timer is armed and lower it in the timer body (and in cleanup); in the cell ResizeObserver callback, return early on that ref exactly as the zero-box guard does, so **no ledger writes and no `contain-intrinsic-size` stamps land during the window**. This is what makes the geometry frozen rather than drifting — without it, mounted rows re-measure at the new width while unmounted rows keep old-width entries and `scrollHeight` moves under the user through the whole drag.
- [ ] Comment the frozen window and its bound (one wipe at settle) — mechanism, not history.

**Tests:**

- [ ] at0330 addition (this step): a scripted width-churn burst (several programmatic pane/container width changes inside 200ms, then rest) → `data-evict-fallbacks` increments ≤1 across the burst, `data-evict-active` present throughout the burst (the freeze keeps eviction running rather than suspending per tick), and **after** the settle wipe + re-measure, `scrollHeight` matches the eviction-disabled arm within ±2px (compare via `window.__tug.setTranscriptEvictionDisabled`). Assert exactness only post-settle — mid-burst geometry is deliberately frozen at the old width per [P06].

**Checkpoint:**

- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0330-transcript-eviction.test.ts`

---

#### Step 7: Hidden-tab settle release {#step-7}

**Depends on:** #step-5

**Commit:** `tugdeck(list-view): release the batch settle while the scroller is hidden`

**References:** [P07] Hidden settle, [P01] doctrine (the freeze protects layouts; hidden has none), (#state-zone-mapping)

**Artifacts:**

- `tugdeck/src/components/tugways/tug-list-view.tsx`: shared settle-handshake closure invoked from the zero-box branch.

**Tasks:**

- [ ] Factor the settle handshake (fire-once + `initialSettlePendingRef` clear + `onFirstSettle` + `scrollTick`) into one closure; call it from the normal post-measurement path (unchanged semantics) and from the zero-box early return when armed.
- [ ] Verify (and comment) the reveal sequence: 0→real RO burst → coverage fail → one suspension → measure → re-arm; save-gate release observable through `cardSaveGateActive` falling in `session-card-transcript.tsx` (no change needed there).
- [ ] Do **not** synthesize a held window for a first-mount-hidden card — the estimate-backed spacers are a correctness hazard at reveal ([P07] rejected alternative); that case keeps today's full mount.

**Tests:**

- [ ] at0330 addition: hide the transcript's card (`display:none` on the pane, as the existing display-none test does) during a restore, assert the batch freeze releases while still hidden (observable via the list's `data-evict-*` attributes resuming / the card's save gate no longer held), then reveal and assert `data-evict-active` present, `data-evict-fallbacks` incremented ≤1, `scrollHeight` within ±2px of the eviction-disabled arm, and the anchor writer's value unchanged across the hidden span.

**Checkpoint:**

- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0330-transcript-eviction.test.ts`

---

#### Step 8: at0333 — doctrine behavioral pins {#step-8}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `tugdash(scroll-fixups): pin unattributed disengage and correction supersede in at0333`

**References:** [P01] [P02] [P03], Spec S01, Spec S02, Risk R03, (#test-plan-concepts, #test-non-goals)

**Artifacts:**

- `tests/app-test/at0333-follow-bottom-unattributed.test.ts` with `@covers` lines for `tugdeck/src/lib/smart-scroll.ts` and `tugdeck/src/components/tugways/tug-list-view.tsx`.

**Model it on `tests/app-test/at0189-transcript-atbottom-no-slam.test.ts`** — it already carries everything this file needs: `seedFixtureSession` / `openFixtureSession` / `SCROLLER` / `waitForTranscriptSettled` from `./fixtures/*`, the temp-tugbank + seeded-fixture setup, and crucially the technique of **mutating the card subtree to provoke a growth pin instead of driving a live stream**. Use that technique here too: app-test replay-session workspaces are transient (entries live only seconds), so a long live-streaming assertion is unreliable, while a card-subtree mutation exercises the same pin channels.

**Tasks:**

- [ ] Test 1 (disengage): transcript settled and pinned at bottom → assign `scroller.scrollTop` upward past the 60px band via `app.evalJS` (no synthetic pointer/wheel — attribution-identical to a scrollbar drag) → provoke growth pins by mutating the card subtree (at0189's technique) → assert `scrollTop` is NOT re-pinned to bottom and the jump-to-latest button reads `data-visible="true"`.
- [ ] Test 2 (correction supersede): arm a correction (⌥⌘↑ via the document-level `KeyboardEvent` dispatch pattern recorded in `dash/aug01-perf-brief.md` §F-D, targeting an unmounted entry) → immediately assign `scrollTop` elsewhere (>8px) → let commits settle → assert no late snap toward the stale target.
- [ ] Test 3 (re-engage unchanged): from scrolled-up, assign `scrollTop` to the bottom (downward, unattributed) → assert follow-bottom re-engages (button `data-visible="false"`) and streaming pins resume.
- [ ] `just app-test-covers-check` passes for the new file.

**Tests:**

- [ ] The file itself (three tests above).

**Checkpoint:**

- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/at0333-follow-bottom-unattributed.test.ts`

---

#### Step 9: tuglaws/scroll-intent.md + the [D93] amendment {#step-9}

**Depends on:** #step-8

**Commit:** `tuglaws(scroll-intent): record the scroll attribution doctrine, amend D93's idle clause`

**References:** [P08] Doctrine doc, [P09] D93 amendment, [P01] Attribution doctrine, [P02] Idle disengage, Table in (#write-inventory)

**Artifacts:**

- `tuglaws/scroll-intent.md`; cross-link from `tuglaws/tuglaws.md` if it indexes topic docs.
- `tuglaws/design-decisions.md`: D93's phase-guard sentence amended.

**Tasks:**

- [ ] Write the doc: the two doctrine sentences, the supersede table (adapted from #write-inventory), the WKWebView attribution inventory (scrollbar silence included), and the rule for new writers; cite [D93] and [L06]/[L07]/[L23] where they ground it.
- [ ] Amend D93 per [P09]: replace *"If the phase is `idle` or `programmatic` and scroll changes, we caused it — ignore"* with the attribution-complete form (ours = `programmatic`, or `idle` with the post-programmatic suppression armed; otherwise the user, chiefly the event-silent native scrollbar, and an upward one outside the at-bottom band disengages follow-bottom). Leave the six phases, six listeners, and transition table untouched. Add the `scroll-intent.md` cross-link.
- [ ] No hard-wrapped prose (repo convention).

**Tests:**

- [ ] N/A (documentation).

**Checkpoint:**

- [ ] Doc reads standalone; links resolve; D93 no longer contradicts the shipped `_handleScroll` idle case; `git status` shows only the intended files.

---

#### Step 10: Final integration checkpoint {#step-10}

**Depends on:** #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**

- [ ] Confirm every success criterion in (#success-criteria); run the derived selection for the full diff.

**Tests:**

- [ ] Aggregate runs below.

**Checkpoint:**

- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed` (window visible per Risk R03)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A scroll stack whose intent model is attribution-complete — scrollbar drags disengage follow-bottom, deferred corrections die on user movement, turn stepping lands flush across evicted rows, resize and hidden-tab churn are bounded — pinned by at0330/at0333 and recorded as tuglaws doctrine.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All (#success-criteria) verified on a visible test window.
- [ ] at0330: 4 of 5 tests green (all but the pre-existing expand round-trip, which is out of scope per #non-goals).
- [ ] at0333 green; `just app-test-covers-check` green.
- [ ] `tuglaws/scroll-intent.md` exists and is cross-linked, and `tuglaws/design-decisions.md` D93 no longer contradicts the shipped idle-phase behavior ([P09]).

**Acceptance tests:**

- [ ] at0333 (all three), at0330 turn-stepping + width-churn + hidden-append additions.
- [ ] Guard suite: at0059 / at0061 / at0189 / at0190 / at0331.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The at0330 expand/collapse height round-trip defect — tool-block body mount, suspect area `tugdeck/src/components/tugways/blocks/block-header.*`; fails identically at HEAD and at the E1 landing commit in a pristine worktree.
- [ ] Geometry-core extraction from `tug-list-view.tsx` (reconsider once this plan's battery is standing).
- [ ] `AT_BOTTOM_PX` band-escape polish for from-the-bottom scrollbar drags (Risk R01), only if felt in practice.
- [ ] Residency relief for a card whose FIRST mount happens in a background tab (today: full mount until first shown). The naive held-tail construction is rejected in [P07] — estimate-backed spacers produce a wrong-geometry frame at reveal that can clamp `scrollTop` and void the pending anchor restore. A correct version would have to gate on the ledger already covering the non-held range, i.e. only help a card that was measured before being hidden.

| Checkpoint | Verification |
|------------|--------------|
| Stage 1 landed | #step-5 aggregate app-test run green |
| Stage 2 landed | at0330 with width-churn + hidden-append additions green |
| Doctrine pinned | at0333 green + `tuglaws/scroll-intent.md` merged |
