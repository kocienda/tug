<!-- plan authored against devise-skeleton v4 -->

## Dev-Transcript Rendering & Scroll Redux {#transcript-redux}

**Purpose:** Make the dev-card transcript render every message accurately at its real height (no holes, no estimate-driven scrollbar), give the user full control over scrolling, and save/restore scroll position pixel-perfectly across Developer ▸ Reload and HMR — fast, for any real transcript size.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via `tugutil dash`) |
| Last updated | 2026-06-14 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dev-card transcript has accumulated three tangled defects that resisted piecemeal fixing. Repeated symptom-chasing failed because rendering, scroll control, and restore were changed together; a prior windowing→inline effort was reverted wholesale and `main` was reset to the clean baseline `97bf26ce`. This plan starts fresh against that baseline with a strict separation of concerns and a discipline of vetting each concern on the **real app** before moving to the next.

The three observed defects map to one root cause and two consequences:

1. **Rendering (root cause).** Two estimate mechanisms stack here. (a) Every transcript row is wrapped in `TieredCell` (`transcript-tier.tsx`): a row renders a *cheap* muted-text preview at a reserved (estimate-like) height until a shared `IntersectionObserver` (`useInRichWindow`, `RICH_WINDOW_MARGIN = 1500px`) upgrades it to *rich*. (b) **Discovered during #step-1:** every cell also carried `content-visibility: auto` + `contain-intrinsic-size: auto 120px/56px` in `dev-card.css` — a CSS-layer paint-deferral whose intrinsic-size is itself a placeholder *estimate* and which leaves off-screen rows unpainted (a rich-but-unpainted row is a blank "hole"). Either mechanism alone produces **both** the empty "holes" when scrolling **and** the scrollbar that changes height as you scroll (total height shifts every time a cell first goes rich / first paints). The user's requirement #5 forbids exactly this. #step-1 removes **both**.

2. **Scroll control.** `card-host.tsx` installs a `MutationObserver`-driven region-scroll re-apply loop, designed for *virtualized* scrollers whose `scrollHeight` grows after mount as estimated heights refine. It re-applies the saved `scrollTop` on every cardRoot mutation until the live `scrollTop` lands within `REGION_SCROLL_TOLERANCE_PX = 8` of the saved value. For a transcript saved while following the bottom, this never settles — re-engaging SmartScroll follow-bottom (`source: "scroll-to-bottom"`) and slamming the user down whenever they try to scroll up.

3. **Reload/restore.** The list view *already* implements a correct, anchor-based, real-height restore: `tug-list-view.tsx`'s anchor-state writer serializes `{anchor:{index,offset}, cellHeights, atBottom}` onto `data-tug-scroll-state` every commit, and on restore it hydrates the live `HeightIndex` from `meta.cellHeights` (so `offsetForIndex(anchorIndex)` is exact on the first commit), installs the saved anchor as a `SmartScroll` restore target before paint, and listens for `tug-region-scroll-set` with **anchor** (disengages follow-bottom), **raw**, and **atBottom** (re-engages follow-bottom) branches. The problem is **not** that restore is a raw-`scrollTop`-with-retry mechanism — it is that `TieredCell` *corrupts the inputs* this mechanism consumes: at save time, off-screen cells measure at their **cheap** height, so the captured `cellHeights` and the anchor writer's `indexForOffset(scrollTop)` are computed against cheap heights and shift as cells go rich. The observed slam is specifically the `tug-region-scroll-set` listener's **atBottom branch** re-engaging follow-bottom (`atBottom` is saved whenever `SmartScroll.isFollowingBottom` at capture), re-triggered by CardHost's retry loop re-dispatching the event on every mutation.

The insight that unblocks all five requirements: **render every cell at its true height — no cheap tier, no estimates.** Then the scrollbar is the real cumulative height (never shifts), there are no cheap placeholders (no holes), and — crucially — the **already-correct anchor restore is fed real `cellHeights`/anchor data**, so it becomes trustworthy. Concern B is therefore about *verifying and repairing the existing anchor mechanism* (and the `atBottom` save/re-engage semantics), **not** about building a new restore path.

#### Strategy {#strategy}

- **Separate the three concerns and do them in order, vetting each on the real app before the next.** Rendering first (A), then scroll control + restore (B), then reload/HMR perf + reveal UX (C). Last time conflation caused ghost-chasing.
- **Retire `TieredCell`; render all cells rich at real heights.** The transcript already mounts `inline` (all rows, no windowing), so this is a wrapper removal, not a new architecture.
- **Never use estimates.** No cheap reserved heights, no estimated offsets for the dev transcript. The scrollbar is always the true sum of measured heights. (See [[feedback_no_height_estimates]].)
- **Measure on the user's real sessions, never assert.** Prove load time on the biggest real session before declaring requirement #1 met. Only if a genuinely huge transcript is too slow do we escalate to *measure-every-row-once → cache real heights → window on real numbers* — a follow-on, not this phase.
- **Let the all-rich pass adjudicate the reducer question empirically.** If holes/missing messages survive all-rich rendering, investigate the reducer `${msgId}:${blockIndex}` keying; if they vanish, the reducer is exonerated and we don't touch it.
- **Repair the existing anchor restore; do not build a second one.** The list view's anchor-based restore is sound — it was being fed estimate-corrupted heights by `TieredCell`. Verify it works once heights are real (concern A), then fix only the specific residual slam (the `atBottom` save/re-engage semantics and CardHost's retry re-dispatch). Never introduce a parallel raw-`scrollTop` restore that competes with the anchor resolver.
- **Make user scroll always win.** Follow-bottom re-engages only on genuine user intent or a save that legitimately recorded `atBottom` — never as a side effect of a restore or a mutation.
- **Observe the real app, don't theorize.** Instrument with `tugDevLogStore.debug(...)` on the live debug instance and read persisted card state via the `tugbank` CLI. (See [[feedback_never_fake]].)

#### Success Criteria (Measurable) {#success-criteria}

- **[req #5] No holes:** scrolling through the full transcript of real session `49fc50a1` (and the largest available real session) shows fully-rendered content for every row — no empty/muted-preview frames — verified visually on the live debug instance. (#rendering-all-rich)
- **[req #5] Stable scrollbar:** the scroll thumb's size and position do not change while scrolling a settled (fully-replayed) transcript. Verified visually and by logging `scrollHeight` on scroll — it is constant once replay completes. (#rendering-all-rich)
- **[req #1] Load performance:** the largest real session loads in a time we measure and the user accepts; recorded in the plan. No regression vs. the inline-no-hold baseline (~2.2s on the biggest real session). (#perf-measurement)
- **[req #2] Full scroll control:** after scrolling up, the user stays where they scrolled — no slam to bottom from a mutation or a restore. Verified on the live debug instance and via `followdbg` logs showing no spurious `scroll-to-bottom`/`idle-reengage` engages. (#scroll-control-model)
- **[req #4] Pixel-perfect restore:** scroll to a marked row, trigger Developer ▸ Reload, and land at the same `scrollTop` (within ≤2px) on the same row. Verified via dev-panel logging of saved vs. restored `scrollTop`. (#pixel-perfect-restore)
- **[req #3] Reload/HMR perf:** Developer ▸ Reload completes in a measured, acceptable time; HMR repaints without reloading transcript data. Verified by timing logs and the HMR-vs-Reload invariant. (#reload-hmr-perf)

#### Scope {#scope}

1. Retire `TieredCell` and render every dev-transcript cell rich at its real height (no cheap tier, no estimates).
2. Remove the now-dead cheap-preview plumbing for the dev transcript (`previewForRow`, `previewTextForMessages` usage, `transcript-tier.*`) where no longer referenced.
3. Empirically confirm whether residual holes/missing messages exist; if so, fix the reducer-level cause.
4. Make user scroll always win by repairing the existing anchor-based restore (not replacing it): correct `atBottom` save/re-engage semantics and stop the CardHost retry from re-triggering follow-bottom.
5. Achieve pixel-perfect save/restore across Developer ▸ Reload and HMR on real heights.
6. Measure and tune Developer ▸ Reload and HMR performance; preserve the HMR-never-reloads-data invariant.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Re-introducing windowing/virtualization for the dev transcript. (Only if real-session measurement proves all-rich too slow — then it's a follow-on, on real measured heights, never estimates.)
- Changing the windowing path used by other `TugListView` consumers (e.g. the gallery list).
- Reworking the streaming/live-turn rendering path beyond what removing `forceRich` requires.
- Any change to tugbank's persistence model or the card-state wire format beyond what the restore semantics require.

#### Dependencies / Prerequisites {#dependencies}

- Clean baseline: `main` at `97bf26ce`.
- A live debug instance via `just app-debug` for real-app vetting; `just logs-debug`, `just stop-debug`, `just launch-debug`.
- The `tugbank` CLI for reading persisted card state: `tugbank --instance <id> --json read <domain> <key>` (domain `dev.tugtool.deck.cardstate`, key = card UUID).
- Real session JSONLs for measurement (e.g. `49fc50a1`, plus the largest available). (See [[feedback_real_content_fixtures]].)

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings`); zero new lint/type findings, fix pre-existing ones in touched files. (See [[feedback_fix_preexisting]].)
- **No estimates anywhere** in the dev-transcript render or scrollbar math.
- **No fake/mock paths** to test or measure — drive the real product path. (See [[feedback_never_fake]], [[feedback_test_reality]].)
- **Tests:** real-app behavior via `just app-test <file>` only (never a hand-rolled `TUGAPP_*` pipeline); pure-logic via `bun:test`. No fake-DOM/RTL, no mock-store assertion tests. App-tests use a fast fixture + short timeouts and exit promptly. (See [[feedback_just_app_test]], [[feedback_no_happy_dom_tests]], [[feedback_apptest_background]].)
- **HMR is always running** for tugdeck; never hand-build the frontend. (See [[feedback_hmr]].)
- **Tuglaws** apply: cross-check `tuglaws/tuglaws.md`, `pane-model.md`, `component-authoring.md` before tugdeck/chrome edits and name the laws touched in each dash commit. (See [[feedback_tuglaws_cross_check]].)
- Work on a `tugutil dash` worktree; never commit to `main` (only the user joins).

#### Assumptions {#assumptions}

- Real transcripts are ~250 rows; the markdown-reconcile fix (`80c246c6`, in baseline) already removed the old all-rich blow-up, so all-rich is expected to be affordable — to be confirmed by measurement, not assumed.
- Removing `TieredCell` eliminates the holes and the scrollbar shift together (single mechanism). The reducer keying is a *secondary* hypothesis to be tested only if defects survive.
- With real heights, a transcript's `scrollHeight` is correct on the first commit after replay completes, so the existing anchor restore resolves exactly and the CardHost growth-chasing retry settles immediately for this region (no fighting).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite plan-local decisions `[P01]`… and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Do holes/missing messages survive all-rich rendering? {#q01-residual-holes}

**Question:** After retiring `TieredCell` and rendering every cell rich, do any holes or misrendered/missing messages remain?

**Why it matters:** If yes, the cause is below the list view (most likely the reducer's per-turn `${msgId}:${blockIndex}` keying when one assistant message is split across two JSONL entries — thinking-only then text — each restarting `block_index` at 0). If no, the reducer is exonerated and must not be touched.

**Options (if known):**
- All defects vanish → reducer untouched (close as DECIDED, exonerated).
- Some defects remain → fix reducer keying to disambiguate split-entry blocks.

**Plan to resolve:** Spike empirically in #step-2 on the real app against `49fc50a1` and the largest real session, reading the reducer output for the suspect messages.

**Resolution:** **DECIDED — reducer exonerated, with positive mechanistic evidence.** #step-2 real-app vet (sessions `49fc50a1` and `7aa35ce5` · 199 turns) showed **no lingering holes and no missing/misrendered messages** once rendering catches up, and a **stable scrollbar** (zero `scrollHeight_changed` entries). #step-3 then investigated the split-entry hypothesis directly: the pattern **is** present (`49fc50a1`'s `msg_01FnuRgQLUMsimWc11j9tdFU` spans thinking/text/tool_use records) yet renders correctly because tugcode replay (`blockCountByMsgId`) already assigns consecutive `block_index` (0,1,2) across continuation entries — so the reducer's `${msgId}:${blockIndex}` keys never collide. Already covered by `replay.test.ts`'s `same-msg_id continuation` suite (8 pass). The reducer is **not touched**. (Transient blanks *during* a fast scroll that resolve to correct content are a paint/load-perf characteristic, not holes — tracked for #step-5/#step-6, see [Q02].)

#### [Q02] Is all-rich fast enough on the largest real session? {#q02-allrich-perf}

**Question:** Does rendering every cell rich load within an acceptable time on the largest real transcript?

**Why it matters:** Requirement #1 ("any size"). If all-rich is too slow on a genuinely huge transcript, we need measure-once-cache-window on real heights — a follow-on.

**Plan to resolve:** Measure in #step-5 on real sessions; record numbers in this plan.

**Resolution:** **DECIDED — all-rich is affordable; the slow load was an O(n²) layout-thrash BUG, now fixed. Windowing is NOT needed.** Initial measure on `7aa35ce5` (212 rows) was **14.4 s** (`49fc50a1`, 30 rows, was 0.87 s). Investigation (pure-bun benches + live `render_split` instrumentation) ruled out every *architectural* cause:

- markdown **parse** = 0.5 s for all 813 blocks (0.6 ms/block); **DOM build** (`renderIncremental`) = 0.9 s — both cheap.
- **layout+paint** cheap (`paintMs` 0.3–2 s; a forced post-mount `getBoundingClientRect` = 0 ms).
- **`cellRenders` = 212** — each cell renders exactly once (no re-render cascade); **`snapshotChurned` = false** (no store churn). React memo + `transcriptCellPropsEqual` work fine.

**Root cause:** every transcript entry *and* every tool block ran a synchronous `offsetHeight`/`getBoundingClientRect` read + CSS-var write in its mount `useLayoutEffect` (the sticky-header pin measurement). With ~212 entries + ~2,100 tool blocks, the read→write→read→write interleaving forced a full reflow of the growing document **per block** → O(n²). `TieredCell` had hidden it by rendering off-screen rows as one cheap node (those measurements never ran); #step-1's all-rich render surfaced it — so the regression was removing `TieredCell`, not `content-visibility`.

**Fix (commit `40fecbde`):** drop the synchronous seeds in `tug-transcript-entry`, `tool-block-chrome`, `diff-block`; the `ResizeObserver` each already sets up provides the height rAF-batched (thrash-free), and a static CSS fallback covers the one frame before it lands. **Result: mount 14.0 s → 4.6 s** on the debug build, **zero behaviour change** (`cellRenders` unchanged). **all-rich stays; [P02] (no windowing) holds; req #5 fully intact.**

**Amended resolution — the residual ~4 s was NOT linear-and-acceptable; it was WebKit off-screen render, fixed by [P07].** Clean release instrumentation (a render-phase-stamped synchronous-mount split, free of the StrictMode/Profiler artifacts that made the debug windows lie) localized the remaining cost precisely: React reconciliation 367 ms, every layout effect in the app summed 379 ms, a forced post-mount layout flush 0 ms — yet first paint was ~6.7 s. The cost is **WebKit synchronously resolving style + layout/paint for the ~95% of the 86k nodes that are off-screen, as React inserts them.** `content-visibility: auto` seeded with cached real heights ([P07]) defers exactly that: release `replay_render` **3690 ms → 1094 ms**, synchronous mount **~4.4 s → 781 ms**, node count unchanged (all-rich intact, no windowing). So [P02]'s no-windowing holds; the "never content-visibility" half of [P01]/[P02] is narrowed to "never *blind-estimate* content-visibility" — see [P07].

#### [Q03] Send-gating semantics during restore (OPEN → resolve in #step-6-1) {#q03-send-gating}

**Brought forward from `transcript-architecture.md` [Q03].**

**Question:** The prompt-entry "drop/defer a send while `replaying`" logic is partly *semantic* (don't dispatch a prompt into a mid-replay session), not just visual. When the `TugSheet` ([P08]) replaces the prompt-entry replay-disabling, is the semantic guard fully covered by the sheet's `inert` lockout, or must a thin store-level send guard remain?

**Why it matters:** Removing the prompt-entry disabling without an equivalent guard could let a programmatic/queued send race a mid-replay session.

**Plan to resolve:** Read the submit path (`tug-prompt-entry` route-prefix + `performSubmit`) in #step-6-1; keep a store-level guard if the `inert` lockout isn't sufficient. **Redux-specific caveat:** the sheet only mounts for restores ≥ 0.5 s ([P09]), so a sub-0.5 s restore has **no** sheet and therefore no `inert` lockout — any guard must cover the whole `replaying` window, not just the sheet window.

**Resolution:** **DECIDED — keep the existing store-derived guard; no prompt-path change.** The prompt entry's `replayHoldActive` deactivation in `dev-card.tsx` (`codeSnap.phase === "replaying" || deriveColdRestoreActive(codeSnap)` → `entryStoodDown` → read-only + blurred, no caret) is already store-derived and covers the **whole** `replaying` window — independent of any sheet, so it holds for the sub-0.5 s case where no sheet mounts. That *is* the thin store-level guard this question asks for; the `TugSheet`'s `inert` is additive for the visible-modal case only. Nothing in the submit path was removed.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| All-rich too slow on huge transcript | high | low | Measure on real sessions; escalate to measure-once-cache-window on real heights | Measured load exceeds user-accepted budget |
| Holes survive all-rich (reducer cause) | med | med | Conditional reducer fix (#step-3), gated on #step-2 | Defects visible after #step-1 |
| Removing the retry loop breaks restore for *other* region scrollers | high | med | Scope the change to the transcript region only; leave the generic markdown-view path intact | Any non-transcript region scroll regresses |
| Streaming/live-turn row tears down without `forceRich` | med | low | Preserve always-rich for the in-flight row by construction (all rows rich) | Live turn flickers or loses a pending dialog |

**Risk R01: Scoping the region-scroll restore change** {#r01-region-scope}

- **Risk:** The CardHost MutationObserver retry serves *all* `data-tug-scroll-key` regions (notably virtualized `tug-markdown-view`), not just the transcript.
- **Mitigation:** Distinguish the transcript region (real heights → retry settles on the first commit) from genuinely virtualized regions (keep growth-chasing). Do not delete the loop wholesale; fix only its re-dispatch behavior so it stops re-triggering the `atBottom` re-engage once settled.
- **Residual risk:** A future region that claims real heights but lies would mis-restore; documented as a region contract.

---

### Design Decisions {#design-decisions}

#### [P01] Render every dev-transcript cell rich at its real height (DECIDED) {#p01-all-rich}

**Decision:** Retire `TieredCell` for the dev transcript. Each row renders its full (rich) cell directly; there is no cheap tier and no reserved/estimated height.

**Decision (amended in #step-1):** retiring `TieredCell` is necessary but **not sufficient** — the `content-visibility: auto` / `contain-intrinsic-size` paint-deferral in `dev-card.css` is a second estimate mechanism and is removed in the same step.

**Rationale:**
- The cheap/rich tiering and the `content-visibility: auto` deferral are *both* sources of holes + estimate-driven scrollbar shift (#context); removing one without the other leaves the defect.
- The transcript already mounts `inline` (all rows), so the rich subtrees are the only honest thing to mount.
- Estimates are banned ([[feedback_no_height_estimates]]); a real-height-only, always-painted list satisfies requirements #4 and #5 by construction.

**Implications:**
- The scrollbar height equals `Σ(measured heights)` and is stable once replay completes.
- `previewForRow` / `previewTextForMessages` / `transcript-tier.*` become dead for the transcript and are removed; `content-visibility`/`contain-intrinsic-size` rules for the transcript are removed.
- `forceRich` is moot (all rows rich); the in-flight streaming row stays rich automatically.
- Every row is always painted → the per-row paint cost is no longer deferred. **Superseded by [P07]:** measurement showed the off-screen *paint/style* cost is the dominant load cost, so the deferral was re-introduced — but as `content-visibility: auto` seeded with **real cached heights**, not the blind `intrinsic-size` estimate this step removed. The ban that holds is on *estimate-driven* deferral, not on `content-visibility` itself; React still mounts every row rich (no windowing).

#### [P02] No estimates and no windowing for the dev transcript (DECIDED) {#p02-no-estimates}

**Decision:** The dev transcript renders all cells inline at measured heights with no `estimatedHeightForKind`, no spacers, no `computeWindow`. Windowing remains available to other `TugListView` consumers.

**Rationale:**
- Real transcripts are bounded (~250 rows) and the markdown-reconcile fix removed the old blow-up.
- Estimate-free is the only way to guarantee a non-shifting scrollbar and pixel-perfect restore.

**Implications:**
- The dev transcript's `scrollHeight` is correct on the first commit after replay, so the existing anchor restore resolves exactly with no estimate-then-refine hop.
- A future huge-transcript escalation must measure real heights once and window on those, never on estimates (#roadmap).
- **Amended by [P07]:** "no windowing" still holds (React mounts every row), but off-screen *render* is now deferred via `content-visibility: auto` seeded with real cached heights. This is consistent with "no estimates" on every reload (the seed is the real persisted height); only a first-ever load of an unseen session uses a self-correcting estimate fallback. See [P07] for the measured rationale.

#### [P03] Repair the existing anchor-based restore; never build a second restore path (DECIDED) {#p03-anchor-restore}

**Decision:** Keep and rely on the list view's existing anchor-based restore (`{anchor:{index,offset}, cellHeights, atBottom}` on `data-tug-scroll-state`; HeightIndex hydration; `tug-region-scroll-set` listener). Once heights are real (concern A), verify it restores pixel-perfectly, then fix only the specific residual slam. **Do not** introduce a parallel raw-`scrollTop` one-shot restore that competes with the anchor resolver.

**Rationale:**
- The anchor mechanism is the correct pixel-perfect approach and already exists; it was failing only because `TieredCell` fed it cheap (estimate-like) `cellHeights` and a cheap-height anchor (#context).
- A second restore path would race the anchor resolver and the `tug-region-scroll-set` listener — exactly the kind of two-mechanisms-fighting bug this redo is trying to end.

**Implications:**
- After concern A, `heightIndexRef.snapshot()` yields real `cellHeights` and the anchor writer's `indexForOffset(scrollTop)` is computed on real heights — the restore should be correct without new code.
- The slam fix targets the `atBottom` **save** semantics (don't record `atBottom` when the user has scrolled up) and the CardHost retry loop **re-dispatching** `tug-region-scroll-set` (which re-triggers the atBottom re-engage). With real heights the transcript's `scrollHeight` is correct on the first commit, so the growth-chasing retry settles immediately for this region (it need not be deleted, but must stop fighting once settled — see R01).
- Restore disengages follow-bottom via the existing anchor branch / suppression affordances; no new programmatic raw write is added.

#### [P04] User scroll always wins; follow-bottom re-engages only on genuine user intent (DECIDED) {#p04-user-wins}

**Decision:** Follow-bottom is engaged only by user gestures (scroll-to-bottom, End/Cmd-Down) or by a save that recorded `atBottom`. A restore, a mutation, or a programmatic write never re-engages follow-bottom against the user.

**Rationale:**
- Requirement #2. The observed `disengage{wheel-up} → ENGAGE{scroll-to-bottom}` loop violated this.

**Implications:**
- `atBottom` in the saved meta means "the user was following the bottom; resume following," not "slam `scrollTop` to a stale pixel."
- `_setFollowingBottom` stays the single chokepoint; restore paths route through the existing `restore-target`/suppression affordances and never synthesize `scroll-to-bottom`.

#### [P05] Reducer keying is touched only if defects survive all-rich (DECIDED) {#p05-reducer-conditional}

**Decision:** Do not modify the reducer unless #step-2 confirms holes/missing messages persist after all-rich rendering.

**Rationale:**
- Avoid changing correctness-critical replay code on a hypothesis. The all-rich pass is the cheapest disambiguator.

**Implications:**
- #step-3 is conditional and may close as "exonerated, no change."

#### [P06] Test content is real-derived committed fixtures — never synthetic, never the live archive (DECIDED) {#p06-real-fixtures}

**Decision:** Behavior/correctness app-tests resume small, **sanitized, committed** slices of REAL sessions (`tests/app-test/fixtures/`), produced by `sanitize.ts` and seeded via `resolve.ts` / `runner.ts`. No synthetic/generated session content. No committed test may draw from, or depend on, the live `~/.claude/projects/` archive. The perf corpus (`corpus/`, `at0185`) is the sole exception — real whale-class workloads, gitignored, `skipIf`-absent.

**Rationale:**
- Real-world content and cases only; synthetic fixtures validate machinery, not workload ("I have no idea what that content is supposed to be doing"). See [[feedback_real_content_fixtures]].
- The live archive is private, mutating, and non-portable; committed sanitized slices run everywhere (CI, any machine).

**Implications:**
- `at0181` (picker) and `at0184` (resume-budgets) were **cut**, not migrated (#step-4-5) — see that step for the value rationale; [P06] is satisfied because no synthetic session content remains.
- "Real-derived + sanitized + clipped" still counts as real (real wire shapes / cases); truncation ≠ synthetic.

#### [P07] Off-screen render deferral via `content-visibility: auto` seeded with cached real heights (DECIDED) {#p07-content-visibility-cached}

**Decision:** The dev transcript's inline cell wrappers carry `content-visibility: auto` with `contain-intrinsic-size` seeded **per cell from the persisted real height** (`meta.cellHeights[index]`, the same value the anchor-restore already hydrates), with the kind estimate as a fallback **only** for a never-before-rendered cell. WebKit then skips style/layout/paint for off-screen cells while React still mounts every row (all-rich is unchanged). Gated to `inline` mode; the windowed path for other `TugListView` consumers is untouched. Implemented in `tug-list-view.tsx`'s cell-wrapper style (extends the existing `min-height` lock).

**Why this reverses the #step-1 removal (the distinction that matters):** #step-1 removed a `content-visibility: auto; contain-intrinsic-size: auto 120px` rule whose intrinsic-size was a **blind constant estimate** — that is what produced the estimate-driven scrollbar shift req #5 forbids. The mechanism was never the problem; the **blind estimate** was. Seeding `contain-intrinsic-size` from the **real cached height** makes the off-screen geometry honest: on every reload the scrollbar is pixel-exact from `cellHeights` (no estimate), and `content-visibility: auto`'s `auto` keyword *remembers* each cell's real rendered size once seen. Only a first-ever load of a never-seen session uses the fallback estimate for not-yet-scrolled rows, and it self-corrects as they render.

**Rationale (measured — supersedes the [Q02] "linear, all-rich is affordable" conclusion):** the [Q02] O(n²) thrash fix was necessary but not sufficient. Clean release instrumentation proved the residual multi-second cost is **WebKit synchronously resolving style + doing layout/paint for the ~95% off-screen nodes as React inserts them** — not JS, not React reconciliation (367 ms), not effects (every layout effect in the app summed to 379 ms), not browser layout of the finished tree (a forced flush measured 0 ms), and not O(n²) (every load-path measurement is rAF-batched). `content-visibility: auto` defers exactly that off-screen render work. Release `7aa35ce5`: `replay_render` **3690 ms → 1094 ms**, synchronous mount **~4.4 s → 781 ms**, with React's node count unchanged (all-rich intact).

**Implications:**
- req #1 (any size): off-screen rows are never styled until approached, so mount cost tracks viewport, not transcript length.
- req #5 (no estimate scrollbar): satisfied on every reload (real cached heights); first-ever load of an unseen session degrades to a self-correcting estimate for off-screen rows — a deliberate, bounded relaxation of the absolute rule, accepted because it is the load-speed mechanism and corrects on scroll.
- req #4 (pixel-perfect restore): the intrinsic-size seed equals the anchor resolver's `cellHeights`, so restore geometry stays exact.
- Sticky pin-stack survives (sticky stays within its own cell's box, which is what `content-visibility`'s paint containment clips to) — verified on the live release build.

**Known follow-up (not blocking):** a fast scrollbar-thumb drag over an already-seen section re-skips/re-renders rather than reusing the remembered render — the `content-visibility` re-render isn't being cached across rapid re-entry. Tracked as a later perf-polish item; does not affect correctness, the scrollbar, or restore.

#### [P08] Restore progress lives in a `TugSheet` pane-modal (DECIDED) {#p08-restore-sheet}

**Brought forward from `transcript-architecture.md` [P06], rebased onto the all-rich / no-windowing redux.** This governs the restore-progress *surface* and is independent of how rows render.

**Decision:** A `TugSheet` presents restore progress: it houses the `TugProgressIndicator` bar (reusing `DevReplayProgress`'s pure view helpers `deriveReplayProgress` / `completeReplayProgress` / `formatReplayProgressValue`), disables the card via the sheet's built-in `inert` + scrim, and carries a **Cancel** button wired to stop the load (`cancelDevRestore`) **and** close the card (`TUG_ACTIONS.CLOSE`). The bespoke `DevReplayProgress` strip and the prompt-entry replay-disabling are retired.

**Rationale:**
- `TugSheet` is the project's pane-modal primitive and already does card-disable + dismissal ([[feedback_use_tug_components]]); the strip re-implemented a worse version. `TugBulletin` / `TugPaneBulletin` are non-blocking toasts — wrong shape for a blocking load.
- In redux the `listMounted` deferred-content hold is **retained** (#step-6): the list isn't mounted during the initial resume window. The `TugSheet` is the surface shown *during that hold* for a slow restore (delay-gated, [P09]); at `replay_complete` the list mounts all-rich and reveals once.

**Implications:**
- Cancel semantics change from "drop to picker" to "stop load + close card."
- [Q03] (send-gating) must be resolved when removing the prompt-entry disabling — the guard must cover the whole `replaying` window, including sub-0.5 s restores where no sheet mounts.
- New file `dev-restore-sheet.tsx`; the `DevReplayProgress` component shell is retired but its pure view helpers are kept and reused.

#### [P09] Restore reveal is delay-gated at 0.5 s (DECIDED) {#p09-reveal-gate}

**Brought forward from `transcript-architecture.md` [P07].**

**Decision:** If a cold restore completes under 0.5 s, no modal is presented — the final state reveals once (the existing reveal-once via the deferred hold + `[DT10]` gate, #step-6). At/over 0.5 s, the `TugSheet` ([P08]) is presented. The delay timer is local-data, measured from `getRestoreStartedAt(cardId)` (persists across the card's services-null remount — read it, do not use a component-local timer), mirroring the existing `DevRestoring` pattern but at a **0.5 s** threshold (not `REPLAY_SOFT_BUDGET_MS` = 2000).

**Rationale:** Liveliness rule — fast → reveal once (no flash); slow → communicate progress *promptly*. The 0.5 s threshold (tightened from the old 1.5 s) is deliberately aggressive: light sessions complete under it and reveal once, while anything denser or large-ingest crosses it and gets immediate progress feedback rather than a longer silent wait. With content-visibility ([P07]) the render is cheap, so a restore that exceeds 0.5 s is ingest-bound — exactly the case where the sheet (and Cancel) earns its place.

**Implications:** Supersedes the committed `DevReplayProgress` delay-gate (`f93f3775`); the gate logic moves into the sheet-present decision at the 0.5 s threshold.

#### [P10] No materialize fade on restore-mount (DECIDED) {#p10-fade-gate}

**Brought forward from `transcript-architecture.md` [P08].**

**Decision:** The `.dev-card` opacity `0→1` materialize fade fires only on genuine picker→new-card creation, not on a restore-mount (Developer ▸ Reload / cold-boot rehydration). The first-mount fade effect in `dev-card.tsx` gates on the existing fresh-create-vs-restore signal (`coldRestoreActive` / `sawColdRestoreRef` / `deriveColdRestoreActive`): cold-restore active at mount ⇒ skip the fade.

**Rationale:** The fade was written to coordinate with the picker sheet's exit; on restore there is no picker to coordinate with, so it reads as a gratuitous flash on top of the reveal.

**Implications:** Pairs with [P09] — a fast restore reveals once with neither a fade nor a modal. New-card creation from the picker still fades.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Rich-vs-cheap tier (REMOVED) | — | deleted; all rows render rich | [L06] |
| Measured cell heights | structure/local-data | `ResizeObserver` → `HeightIndex`/DOM measurement; never React state | [L22], [L06] |
| Scroll thumb geometry | appearance | true `scrollHeight` from measured layout; CSS/DOM, no estimate math | [L06] |
| Off-screen render deferral ([P07]) | appearance | `content-visibility: auto` + `contain-intrinsic-size` seeded from real cached `cellHeights` on inline cell wrappers; CSS/DOM, never React state | [L06] |
| Follow-bottom intent | appearance | DOM attribute (`data-visible`) via `onFollowBottomChange`; never React state | [L06] |
| Region scroll restore (transcript) | local-data (DOM authority) | existing anchor resolver (`{index,offset}` + HeightIndex hydration from real `cellHeights`); `tug-region-scroll-set` listener; no new raw write | [L22], [L23] |
| Saved card state (scrollTop, anchor, atBottom) | external/persistent | tugbank via `/api/defaults`; enters React only via `useSyncExternalStore` if observed | [L02] |
| Stable cell wrapper identity | structure | same wrapper element across re-renders so observers/restore stay attached | [L26] |
| Restore-sheet presented ([P08]/[P09]) | structure | `useSyncExternalStore`(coldRestoreActive) + delay timer ⇒ mount `TugSheet` | [L02] |
| Reveal/sheet delay timer ([P09]) | local-data | `useState` + `setTimeout`, stamp from `getRestoreStartedAt(cardId)` | [L24], [L02] |
| Materialize-fade suppression on restore ([P10]) | appearance | WAAPI fade gated on cold-restore-at-mount signal; CSS/DOM, never React state | [L06] |
| Send-gating during replay ([Q03]) | structure/local-data | sheet `inert` + (if needed) a thin store-level guard while `replaying` | [L02] |

(Confirm exact law numbers against `tuglaws/tuglaws.md` at implement time and name them in each dash commit.)

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Real-app** (`just app-test`) | Reload/restore, scroll control, no-slam, pixel-perfect landing | Steps that change scroll/restore behavior |
| **Pure-logic** (`bun:test`) | Reducer keying for split-entry blocks (data-in/data-out) | Only if #step-3 fires |
| **Manual real-app vetting** | Holes, scrollbar stability, load feel — observed on the live debug instance | Every rendering/scroll step |

#### What stays out of tests {#test-non-goals}

- **Fake-DOM/RTL render tests** — banned; happy-dom is deleted. Express rendering correctness as real-app vetting or pure data tests. ([[feedback_no_happy_dom_tests]])
- **Mock-store assertion tests** — banned. ([[feedback_no_mock_store_tests]])
- **Gallery/fixture scroll scenarios** — do not test invented scenarios; drive the real session resume + reload path only. ([[feedback_never_fake]])

---

### Execution Steps {#execution-steps}

> Work happens on a `tugutil dash` worktree (absolute paths into the worktree). Commit each step via `tugutil dash commit`. Vet rendering on the real app before touching scroll. The user joins to `main`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Retire TieredCell — render all transcript cells rich | done | cffcc343 |
| #step-2 | Vet rendering on the real app; adjudicate residual defects | done (no holes / stable scrollbar; [Q01] exonerated) | (verification only) |
| #step-3 | (Conditional) Fix reducer split-entry block keying | done — exonerated with evidence (already fixed in tugcode replay + tested; no change) | (verification only) |
| #step-4 | Repair anchor restore + atBottom semantics; user scroll wins | done (live-vetted + at0189 green) | 9020578d |
| #step-4-5 | Retire synthetic-content tests (at0181, at0184) | done — both cut; [P06] satisfied by deletion | — |
| #step-5 | Pixel-perfect restore + load measurement on real sessions | done (pixel-perfect dc91a0d0; O(n²) thrash fixed 40fecbde; residual off-screen-render load cost fixed via content-visibility + cached heights [P07] — release `replay_render` 3690→1094 ms) | dc91a0d0, 40fecbde, 8397b2e3 |
| #step-6 | Reload/HMR perf + reveal UX; HMR-never-reloads invariant | done (reveal fast via content-visibility [P07]; HMR-never-reloads verified — fixed a Fast Refresh mixed-export full-reload regression; hold + [DT10] gate unchanged) | 33e2aaaf |
| #step-6-1 | TugSheet restore modal (delay-gated, Cancel=stop+close) | done (DevRestoreSheet; strip retired; [Q03] store guard kept; 0.5 s gate; live-vetted) | 4458f05b, 1e3332d7 |
| #step-6-2 | Suppress materialize fade on restore-mount | done (fade gated on cold-restore-at-mount; live-vetted) | e9f3a87a |
| #step-7 | Integration checkpoint — all five requirements on real sessions | done (user-vetted on the build; all five reqs + restore UX) | (verification only) |

---

#### Step 1: Retire TieredCell — render all transcript cells rich {#step-1}

**Commit:** `Render dev-transcript cells at real height; drop tiering`

**References:** [P01] All-rich render, [P02] No estimates, (#context, #rendering-all-rich), Risk R01

**Artifacts:**
- `dev-card-transcript.tsx`: cell renderers (user/assistant/ghost) render their rich cell directly, not wrapped in `TieredCell`; `forceRich`/`previewForRow` derivation removed; tier/two-tier comments updated to the inline real-height model. `stripUserBodyPrefix` and `readUserMessage` kept (used by the real cells).
- Orphaned files removed (dev transcript is the sole consumer — confirmed by grep): `transcript-tier.tsx`, `transcript-tier.css`, `src/lib/transcript-preview.ts`, and its test `src/lib/__tests__/transcript-preview.test.ts`.
- `dev-card.css`: removed the **entire `content-visibility: auto` paint-deferral block** — the base `.tug-list-view-cell { content-visibility: auto; contain-intrinsic-size: auto 120px; }`, the user-kind `contain-intrinsic-size: auto 56px`, and the dead `:has(.dev-transcript-tier[data-tier="rich"])` override. **Discovery:** this CSS was a *second, independent* estimate mechanism — `contain-intrinsic-size` is a placeholder estimate for off-screen rows, and `content-visibility: auto` leaves a rich-but-unpainted row blank (a hole). Removing only `TieredCell` would have left holes + a shifting scrollbar at the CSS layer; the all-rich goal requires removing this too.

**Tasks:**
- [x] In `dev-card-transcript.tsx`, replace each `<TieredCell …>{() => <Cell/>}</TieredCell>` with the rich `<Cell/>` directly; remove `forceRich` and `previewForRow`.
- [x] Delete `transcript-tier.{tsx,css}`, `transcript-preview.ts`, and `transcript-preview.test.ts`; remove their imports.
- [x] Remove the dead `content-visibility`/`contain-intrinsic-size` rules from `dev-card.css` (see Artifacts — the whole deferral block, not just the `[data-tier="rich"]` override).
- [x] Re-grep `TieredCell`/`previewTextForMessages`/`previewForRow`/`transcript-tier`/`dev-transcript-tier`/`content-visibility`/`contain-intrinsic` — zero remaining references in the dev-transcript path (only unrelated gallery `content-visibility` rules remain).
- [x] Keep the `inline` prop on `TugListView`. **Note:** `estimatedHeightForKind` *is* still supplied and is **intentionally retained for Step 1** — it feeds the list view's anchor-writer / restore machinery (`estimatedHeightForKindOnly` → `heightIndex.prepare`, `indexForOffset`/`offsetForIndex`) even in `inline` mode, and does **not** affect the inline scrollbar (which is the true sum of mounted heights). [P02]'s "no `estimatedHeightForKind`" is moved to **#step-4**, where the anchor restore is verified on real heights before its inputs change.
- [x] Cross-check tuglaws (L06/L22/L23/L26) — see commit-body note below.

**Tests:**
- [x] `bunx tsc --noEmit` clean; zero findings. (tugdeck's only lint gate is `tsc`; no biome/eslint config.)

**Checkpoint:**
- [x] Typecheck clean.
- [x] HMR repaints the transcript with rich rows; no `TieredCell`/cheap/`data-tier` markup in the DOM. *(User-confirmed in #step-2 on `49fc50a1` and `7aa35ce5`.)*

**Tuglaws (for the commit body):** **L06** — appearance stays in CSS/DOM: removing `content-visibility`/`contain-intrinsic-size` and the cheap-tier min-height keeps row geometry as real measured layout, not estimate-driven appearance state. **L23** — the `content-visibility: auto` comment claimed it preserved selection/find-in-page "for free"; rendering every row rich keeps the DOM fully alive and painted, so that user-visible state is *more* robustly preserved, not lost. **L26** — retiring the cheap↔rich swap *removes* the mount-identity hazard `TieredCell` existed to manage (the wrapper that had to stay stable across the swap); each cell now has one stable subtree. **L22** — measured heights still flow to `HeightIndex` via the list view's `ResizeObserver`, observed off the DOM, never through React state.

---

#### Step 2: Vet rendering on the real app; adjudicate residual defects {#step-2}

**Depends on:** #step-1

**Commit:** `N/A (verification only)`

**References:** [P01] All-rich render, [Q01] Residual holes, [P05] Reducer conditional, (#rendering-all-rich, #q01-residual-holes)

**Tasks:**
- [x] `just app-debug`; loaded real sessions `49fc50a1` and `7aa35ce5` (199 turns) on the live debug instance (`debug-main`).
- [x] Scrolled the full transcript: **no lingering holes**, every row renders its real content once caught up; **scrollbar height/position stable**. A throwaway transcript-scoped diagnostic logged `scrollHeight` on scroll (`scrollHeight_changed` only on change) — **zero** change entries; diagnostic then removed (it was non-compliant scaffolding, see note below).
- [x] Resolved [Q01]: **no holes/missing/misrendered messages** → [Q01] DECIDED, reducer exonerated, **#step-3 skipped**.

**Tests:**
- [x] Manual real-app vetting on `49fc50a1` and `7aa35ce5` — user-confirmed no holes + stable scrollbar.

**Checkpoint:**
- [x] User confirmed no holes and a stable scrollbar on both sessions. (No reducer defect → #step-3 skipped.)

**Note (vet scaffolding):** the `scrollHeight` diagnostic was a temporary `React.useEffect` reading `listMounted` (from `useSyncExternalStore`) and attaching a scroll listener — **not** tuglaws-compliant (**L22**: round-trips store state through React then escapes via `useEffect` to touch the DOM; **L03**: event-dependent registration must be `useLayoutEffect`). Correct resolution for throwaway instrumentation: **removed before commit**, not refactored. Working tree returned to `cffcc343` for code; Step 2 commits only this plan update.

**Open perf items (carried to #step-5/#step-6, not holes):** initial load is slow, and a fast scroll shows transient blanks that resolve to correct content as the rich rows paint. Neither violates req #5 (no *lingering* holes / no estimate scrollbar); both are load/reveal-perf work for concern C.

---

#### Step 3: (Conditional) Fix reducer split-entry block keying {#step-3}

**Depends on:** #step-2

**Commit:** `N/A (verification only — exonerated, no code change)`

**References:** [P05] Reducer conditional, [Q01] Residual holes, (#open-questions)

> Execute only if #step-2 confirmed residual defects. Otherwise close as "exonerated — no change" in the ledger.

**Outcome: EXONERATED with positive evidence — no code change.** Investigation found the split-entry `block_index` collision is **already fixed**, and **at the tugcode replay layer**, not the reducer the plan suspected:

1. **The pattern is real and present in a tested session.** In `49fc50a1`, the single assistant message `msg_01FnuRgQLUMsimWc11j9tdFU` spans **three** JSONL records — `content:[thinking]`, then `content:[text]`, then `content:[tool_use]`, all same `msg_id`. This is exactly the "split across entries, each `content[0]`" shape that would collide on `${msg_id}:0` if indexed per-record.
2. **The disambiguation lives in `tugcode/src/replay.ts`.** A per-`msg_id` running counter `blockCountByMsgId` makes each continuation entry start its `block_index` at the prior count (`baseBlockIndex = blockCountByMsgId.get(entryMsgId) ?? 0`; each block → `baseBlockIndex + localBlockIndex`; counter bumped after the entry). So the three records emit `block_index` **0, 1, 2** — distinct keys, no collision. The reducer's `${msg_id}:${block_index}` keying then works correctly because its inputs are already distinct. (The fix predates this plan — its regression test cites session `ecc343d8`.)
3. **Why `49fc50a1` rendered clean in #step-2:** because (1)+(2) — the suspect pattern *is* in that session and it paints correctly, which is positive proof the mechanism works, not merely "we didn't hit the case."

**Tasks:**
- [x] Looked for the defect in real JSONL — the split pattern is present (`49fc50a1` / `msg_01FnuRgQLUMsimWc11j9tdFU`), but it does **not** collide: tugcode replay assigns consecutive `block_index` across continuation entries.
- [x] No key change needed — the reducer already receives distinct `${msg_id}:${block_index}` keys; the disambiguation is correctly placed in tugcode replay, not the reducer.
- [x] Cross-checked correctness: live path (`session.ts`) uses the API's native per-message `event.index` (monotonic within a stream); replay path uses `blockCountByMsgId`. Both paths produce distinct indices.

**Tests:**
- [x] **Already covered** — `tugcode/src/__tests__/replay.test.ts` › `describe("translateJsonlSession — same-msg_id continuation")`: per-entry consecutive indices (the `ecc343d8` regression, asserts `0,1`), three-way continuation (`[0,1,2]`), per-entry-multi-block + continuation monotonic (`[0,1,2]`), and distinct-`msg_id` independent counters. Ran on current `main`: **8 pass / 0 fail (40ms)**. Adding another test would duplicate this real coverage, so none added ([[feedback_no_mock_store_tests]]).

**Checkpoint:**
- [x] No message was ever missing (the pattern renders correctly in `49fc50a1`, vetted in #step-2); the existing real-data regression suite passes on `main`. Reducer untouched.

---

#### Step 4: Repair anchor restore + atBottom semantics; user scroll wins {#step-4}

**Depends on:** #step-2

**Commit:** `Fix transcript atBottom save/re-engage; stop slam-to-bottom`

**References:** [P03] Anchor restore (no second path), [P04] User scroll wins, Risk R01, (#scroll-control-model, #r01-region-scope)

> The list view's anchor-based restore (`{anchor:{index,offset}, cellHeights, atBottom}` + HeightIndex hydration + `tug-region-scroll-set` listener) already exists and is correct. **Verify it first** on real heights (post-#step-1); do **not** add a parallel raw-`scrollTop` restore ([P03]). Fix only the residual slam.

**Root cause traced (from code) + fix landed:** the slam is the CardHost region-scroll retry loop. Its settle gate is `scrollTop ≈ saved pos.y`. An `atBottom` region restores by re-pinning to the **live** bottom (taller than at save), so `scrollTop` converges to `scrollHeight − clientHeight`, never the stale `pos.y` → the gate never trips → the `MutationObserver` re-dispatches `tug-region-scroll-set` on every cardRoot mutation, and the list view's at-bottom branch (`smartScroll.scrollToBottom`, which calls `_setFollowingBottom(true,'scroll-to-bottom')`) re-engages follow-bottom each time — slamming a user who has scrolled up (matches the observed `disengage{wheel-up} → ENGAGE{scroll-to-bottom}` trace). **Fix:** `card-host.tsx` treats an `atBottom` region as a **one-shot** — dispatch once to resume following, then mark settled immediately and hand ongoing pin/disengage to SmartScroll (its own follow-bottom + `maybePinToBottom`, which a user wheel-up disengages and a restore never fights). **No `tug-list-view.tsx` change needed:** the save side already records `atBottom` only when `isFollowingBottom`, and one-shot CardHost means the re-engage fires exactly once on cold boot — when resuming-follow *is* the user's intent. No second restore path; no new raw `scrollTop` write. Generic across all `atBottom` regions (R01), not transcript-specific.

**Artifacts:**
- `tug-list-view.tsx`: `atBottom` is saved only when the user is genuinely following the bottom (not when they have scrolled up); the `tug-region-scroll-set` atBottom branch re-engages follow-bottom only when that is the user's intent.
- `card-host.tsx`: the region-scroll retry loop stops re-dispatching `tug-region-scroll-set` for the transcript once settled (real heights → settles on the first commit), so it cannot keep re-triggering the atBottom re-engage; the generic growth-chasing path for genuinely virtualized regions is left intact (R01).

**Tasks:**
- [x] Traced the `disengage{wheel-up} → ENGAGE{scroll-to-bottom}` slam to its source **from code**: cause (b) — CardHost's retry re-dispatching `tug-region-scroll-set` on every mutation because the `atBottom` region never satisfies the `scrollTop ≈ stale pos.y` settle gate, re-firing the at-bottom branch's `scrollToBottom`. (Cause (a) ruled out: the save records `atBottom` only when `isFollowingBottom`, so a scrolled-up save is already `atBottom:false` + anchor.)
- [x] Fix landed in `card-host.tsx`: `atBottom` regions are one-shot (dispatch once, settle immediately); no `tug-list-view.tsx` change needed; no second restore path; no new raw `scrollTop` write. Cross-checked tuglaws — **L23** (restore preserves the user's scroll position instead of destroying it on every mutation), **L02/L22** (follow-bottom intent stays in SmartScroll/DOM; restore reads geometry off the DOM, not via React state). `bunx tsc --noEmit` clean.
- [x] **(live vet — user-confirmed)** Anchor restore lands pixel-perfectly across Developer ▸ Reload.
- [x] **(live vet — user-confirmed)** `atBottom` semantics end-to-end: "No slam, anchor restore lands, atBottom resumes." A transcript saved at the bottom resumes following on reload; a transcript saved scrolled-up holds when content mutates.

**Tests:**
- [x] `just app-test at0189-transcript-atbottom-no-slam` — **PASS** (10/10, 3.87s). Two-phase save→reload (modeled on `at0014`): Phase A asserts the saved bag is `atBottom`; Phase B restores, scrolls up, fires a cardRoot mutation, and asserts `scrollTop` never reaches the bottom band. Real-content sanitized fixture (`fixtures/sessions/dev-transcript-basic.jsonl`), **not** a gallery fixture — driven through the real picker→resume path; pre-seeds `recent-projects` to the temp dir so it never touches the live archive; both phases in `try/finally` (no process leak).

**Checkpoint:**
- [x] **(live vet)** Scrolling up holds; `followdbg` shows `disengage{wheel-up}` with no follow-on `ENGAGE{scroll-to-bottom}`; anchor restore pixel-perfect. **+** automated `at0189` green.

**Test-harness work folded in here (per the no-synthetic-content / no-live-archive rule, [[feedback_real_content_fixtures]]):**
- New committed real-fixture resource: `tests/app-test/fixtures/{sanitize.ts, resolve.ts, runner.ts, README.md}` + `sessions/dev-transcript-basic.jsonl` (sanitized slice of a real session — paths/identity/email/secrets scrubbed, oversized blocks clipped, screenshots → 1×1 PNG; privacy-reviewed, 0 residual leaks).
- Deleted `at0186-collapsed-history.test.ts` (obsolete — it asserted windowed unmount/remount, which #step-1's inline render removed).

---

#### Step 4.5: Retire synthetic-content tests {#step-4-5}

**Depends on:** #step-4

**Commit:** `Cut synthetic-content picker + resume-budget tests`

**References:** [P06] Real fixtures (no synthetic / no live archive), (#test-non-goals), [[feedback_real_content_fixtures]]

**Outcome: both tests CUT (not migrated).** Investigating the migration surfaced that neither earns the cost of a real-fixture rewrite, so [P06] is satisfied by **deletion** — no synthetic session content remains.

- **`at0184` (resume-budgets) — deleted.** Three compounding reasons: (1) **obsolete** — its tool-heavy test asserts *windowed* mounting, which #step-1 removed (the dev transcript is always `inline`, [P02]), and the tool-light test leaned on the deleted `content-visibility` deferral (same obsolescence that retired `at0186`); (2) **redundant** — the properties it gated (resume time, replay commit count, parse-once) are exactly what #step-5/#step-6 measure on **real** sessions, the gold standard; (3) **synthetic** content.
- **`at0181` (external-session-picker) — deleted.** It covered a real, niche feature (terminal-created sessions surfacing in the picker; held-blocked; free-resumes) with fabricated TUI JSONL. Cutting it drops that automated coverage — an accepted trade; it can be rebuilt on real fixtures later if the feature regresses.

**Tasks:**
- [x] Deleted `tests/app-test/at0181-external-session-picker.test.ts` and `at0184-resume-budgets.test.ts`; removed the unused `fixtures/sessions/dev-transcript-held.jsonl` (it existed only for the abandoned `at0181` migration).
- [x] Confirmed the fixture resource (`sanitize.ts` / `resolve.ts` / `runner.ts` / `dev-transcript-basic.jsonl`) is intact — `at0189` still depends on it.
- [x] Grep-confirmed **zero** remaining tests fabricate session JSONL, and the only committed test touching `~/.claude/projects` content is the gitignored perf corpus (`at0185`, the [P06] exception).

**Tests:**
- [x] N/A — deletion only. `at0189` (the one real-fixture app-test) is unaffected and still green from #step-4.

**Checkpoint:**
- [x] No synthetic session-content generation in any committed test; no live-archive content dependence outside `corpus/`. [P06] satisfied.

> Note: `at0182`/`at0183` were referenced lore, not extant files — no action.

---

#### Step 5: Pixel-perfect restore + load measurement on real sessions {#step-5}

**Depends on:** #step-4

**Commit:** `Pixel-perfect transcript restore across reload`

**References:** [P03] Anchor restore (no second path), [Q02] All-rich perf, (#pixel-perfect-restore, #perf-measurement, #q02-allrich-perf)

**Artifacts:**
- Verified save/restore on real heights; recorded load measurements in this plan's [Q02] resolution.

**Tasks:**
- [x] **Pixel-perfect restore — verified two ways.** Live-vetted in #step-4 ("anchor restore lands"); now automated by `at0190` (scroll to a mid anchor → reload → land within ≤2px). The atBottom case is covered by `at0189`.
- [x] **(live measured)** Load time on the real sessions (`perf.replay_render {ms, rows}`, real instrumentation): `49fc50a1` 30 rows → **871 ms**; `7aa35ce5` 212 rows → **14,424 ms**. Recorded in [Q02].
- [x] **(live measured)** The 14.4 s is the mount-all reveal (one frozen commit), super-linear — confirmed the bottleneck is all-rich layout/paint, not ingest (1.1 s) or backend (~170 ms).

**Outcome: [Q02] resolved — the slow load was an O(n²) layout-thrash bug, FIXED (commit `40fecbde`); windowing is NOT needed.** The escalation "fork" (windowing vs content-visibility vs chunked-mount) is moot — none was an architecture problem; it was forced-reflow thrash from per-block sticky-header pin seeds. all-rich stays; [P02] (no windowing) holds; req #5 intact. Mount **14.0 s → 4.6 s** (debug); the remainder is linear React-mount, to confirm on a release build (the debug instance runs React dev mode).

**Tests:**
- [x] `just app-test at0190-transcript-anchor-restore` — **PASS** (12/12, 3.66s). Two-phase save→reload on the real fixture: Phase A scrolls to a mid anchor and asserts the saved bag carries `meta.anchor` (not `atBottom`); Phase B restores and asserts `scrollTop` lands within ≤2px. Pre-seeds `recent-projects`; both phases in `try/finally`.

**Checkpoint:**
- [x] Pixel-perfect landing confirmed (`at0190` green + live vet).
- [x] Load numbers recorded; [Q02] resolved — the slowness was an O(n²) layout-thrash bug (fixed, `40fecbde`), **not** an all-rich limitation; windowing not needed. Release-build measure pending.

---

#### Step 6: Reload/HMR perf + reveal UX; HMR-never-reloads invariant {#step-6}

**Depends on:** #step-5

**Commit:** `Tune reload reveal; keep HMR from reloading transcript`

**References:** [P02] No estimates, (#reload-hmr-perf), [[project_hmr_vs_reload]]

**Artifacts:**
- The two reveal mechanisms tuned for all-rich: the `listMounted` deferred-content hold (list not mounted during the initial resume window; `DevReplayProgress` strip shown instead) and the `[DT10]` `data-replaying` → `visibility:hidden` paint gate. HMR confirmed to never reload transcript data.

**Tasks:**
- [ ] Time Developer ▸ Reload on real sessions across both reveal mechanisms; confirm the `listMounted` flip → mount-all-rich → single reveal sequence has no accumulation FOUC and no double reveal between the deferred-content hold and the `[DT10]` gate.
- [ ] Tune the hold/gate so the (now heavier) mount-all-rich commit reveals once, cleanly — adjust gate timing only, never re-introduce estimates or per-cell tiering to mask cost.
- [ ] Confirm the HMR-vs-Reload invariant: HMR repaints without re-resuming from JSONL; Developer ▸ Reload is the only true hard refresh. Verify via dev-panel logs that an HMR save does not re-run replay.

**Tests:**
- [ ] `just app-test` (or live-instance dev-panel observation) confirming HMR does not trigger a transcript data reload.

**Checkpoint:**
- [ ] Reload completes in a measured, accepted time; HMR repaints without reloading data.

---

#### Step 6.1: TugSheet restore modal (delay-gated, Cancel=stop+close) {#step-6-1}

**Depends on:** #step-6

**Commit:** `TugSheet restore modal; retire DevReplayProgress strip`

**References:** [P08] Restore sheet, [P09] Reveal gate, [Q03] Send-gating, (#reload-hmr-perf), [[feedback_use_tug_components]], [[feedback_substrate_responder]]

**Brought forward from `transcript-architecture.md` Step 7, rebased onto the all-rich / no-windowing redux: the deferred hold + `[DT10]` gate from #step-6 stay; the `TugSheet` replaces the `DevReplayProgress` strip as the slow-restore surface. Independent of the rendering approach.**

**Artifacts:**
- New `dev-restore-sheet.tsx`: a `TugSheet` (via `useTugSheet()`) housing `TugProgressIndicator`, reusing `deriveReplayProgress` / `completeReplayProgress` / `formatReplayProgressValue` from `dev-replay-progress.tsx`. Cancel = `cancelDevRestore(cardId)` + `TUG_ACTIONS.CLOSE`. Presented only when restore exceeds 0.5 s (stamp from `getRestoreStartedAt`).
- `DevReplayProgress` strip usage removed from `dev-card-transcript.tsx`; its pure view helpers kept.
- Prompt-entry replay-disabling removed, or replaced by a thin store-level send guard per [Q03].

**Tasks:**
- [ ] Build `DevRestoreSheet` via `useTugSheet()`; delay-gated present at 0.5 s from `getRestoreStartedAt(cardId)` (mirror the existing `DevRestoring` timer pattern; threshold **0.5 s**, not `REPLAY_SOFT_BUDGET_MS`).
- [ ] Wire Cancel → `cancelDevRestore` (stop load) **and** `CLOSE` (close card) through the chain action.
- [ ] Remove the `DevReplayProgress` strip from `dev-card-transcript.tsx`; keep + reuse its pure view helpers in the sheet.
- [ ] Resolve [Q03]: read `tug-prompt-entry` route-prefix + `performSubmit`; since a sub-0.5 s restore has no sheet (no `inert`), keep a thin store-level guard that drops/defers a send while the session is `replaying` if the lockout doesn't already cover the whole window.
- [ ] Cross-check tuglaws and name them in the commit: **L02** (sheet-present derives from `useSyncExternalStore`(coldRestoreActive) + the delay timer), **L06** (card-disable via the sheet's `inert`/scrim, not React appearance state), **L23** (substrate-responder coverage only if the sheet hosts text entry — it should not).

**Tests:**
- [ ] Pure-logic: present/dismiss gate (under vs over 0.5 s); Cancel handler dispatches stop + close.
- [ ] Real-app vet (`just app-test`): a slow restore (large real session) shows the sheet over a disabled card, Cancel stops + closes; a fast restore (< 0.5 s) shows no sheet and reveals once.

**Checkpoint:**
- [ ] `bun test` for the gate passes; `bunx tsc --noEmit` clean.
- [ ] Real-app: ≥ 0.5 s restore → sheet + Cancel(stop+close); < 0.5 s → no sheet, reveal-once; [Q03] resolved (guard kept or proven unnecessary).

---

#### Step 6.2: Suppress materialize fade on restore-mount {#step-6-2}

**Depends on:** #step-6-1

**Commit:** `No materialize fade on transcript restore-mount`

**References:** [P10] Fade gate, (#reload-hmr-perf), [[project_hmr_vs_reload]]

**Brought forward from `transcript-architecture.md` Step 8.**

**Artifacts:**
- The `.dev-card` first-mount fade in `dev-card.tsx` (a `useLayoutEffect` that sets `opacity:0` then animates `0→1`) fires only on fresh picker→body creation; a restore-mount skips it via the `coldRestoreActive` / `sawColdRestoreRef` signal already in that file.

**Tasks:**
- [ ] Gate the fade effect on cold-restore-at-mount (`deriveColdRestoreActive` / `sawColdRestoreRef`): skip the fade when restoring; keep it for picker→new-card creation.
- [ ] Cross-check **L06** (the fade is WAAPI on the DOM, gated by a derived signal — no React appearance state) and name it in the commit.

**Tests:**
- [ ] Real-app vet: Developer ▸ Reload shows no card-materialize fade; creating a new card from the picker still fades.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; real-app reload has no card fade; new-card creation still fades.

---

#### Step 7: Integration checkpoint — all five requirements on real sessions {#step-7}

**Depends on:** #step-1, #step-2, #step-4, #step-5, #step-6, #step-6-1, #step-6-2

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P01]–[P10]

**Tasks:**
- [ ] On the live debug instance with real session `49fc50a1` and the largest real session, verify all five requirements together: load perf (#1), full scroll control / no slam (#2), reload+HMR perf (#3), pixel-perfect restore (#4), accurate rendering — no holes / no estimate-driven scrollbar / no missing messages (#5).
- [ ] Verify the restore UX (#3): a fast restore (< 0.5 s) reveals once with **no** sheet and **no** materialize fade ([P09]/[P10]); a slow restore (≥ 0.5 s) presents the `TugSheet` with progress + Cancel(stop+close) ([P08]); a send attempted mid-replay is correctly gated ([Q03]).

**Tests:**
- [ ] Aggregate real-app pass: the `just app-test` reload/scroll tests green; manual vetting of holes + scrollbar stability confirmed by the user.

**Checkpoint:**
- [ ] User signs off that all five requirements hold on real sessions. Then (and only then) `tugutil dash join`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dev-card transcript that renders every message accurately at real height, gives the user uninterrupted scroll control, and restores scroll position pixel-perfectly across Developer ▸ Reload and HMR — measured fast on the user's real sessions.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No holes and a stable scrollbar on real sessions (req #5). (#rendering-all-rich)
- [ ] User scroll always wins; no slam-to-bottom (req #2). (#scroll-control-model)
- [ ] Pixel-perfect restore across Developer ▸ Reload (req #4). (#pixel-perfect-restore)
- [ ] Load + reload times measured and accepted (req #1, #3). (#perf-measurement, #reload-hmr-perf)
- [ ] No estimates anywhere in the dev-transcript render/scroll path (req #5).
- [ ] Restore UX (req #3): < 0.5 s reveal-once with no fade / no sheet; ≥ 0.5 s `TugSheet` + Cancel(stop+close); no restore-mount fade; mid-replay send gated ([P08]–[P10], [Q03]). (#step-6-1, #step-6-2)

**Acceptance tests:**
- [ ] `just app-test` reload + scroll-control tests green (fast, prompt exit).
- [ ] User-confirmed manual vet of holes + scrollbar stability on real sessions.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] If [Q02] measurement shows all-rich too slow on a genuinely huge transcript: measure-every-row-once → cache real heights → window on real numbers (never estimates).
