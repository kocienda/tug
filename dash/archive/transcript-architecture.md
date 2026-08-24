<!-- devise-skeleton v4 -->

## Transcript Architecture — Bounded, Lively, Fast {#transcript-architecture}

**Purpose:** Re-architect dev-card transcript rendering so the DOM and per-tick work are bounded by what's on screen (O(viewport) reconcile + O(log N) windowing math, never O(rows)), finalized turns are built once and never re-touched, and only the live tail is dynamic — eliminating the large-load cost, the replay/reload flash, and the long-transcript jank, while keeping streaming lively.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | `tugutil dash` worktree (joined to `main` by the user) |
| Last updated | 2026-06-13 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dev-card transcript renders a `CodeSessionStore` snapshot through `DevTranscriptDataSource` → `TugListView` → cells → `TugMarkdownBlock`. `TugListView` has a real windowing engine (`computeWindow` / `HeightIndex` / overscan / spacers), but the transcript opts out of it via **`inline` mode** — every row is mounted, always. `inline` was chosen to dodge two windowing rough-edges (first-measure scroll-shift, and fast thumb-drags landing on blank spacers), substituting an all-rows-mounted list whose cells upgrade cheap→rich via `TieredCell`.

That single choice is the root of every symptom we've been fighting. The list is O(rows): every store tick reconciles all N cell elements (`React.memo` skips each subtree but the parent still does O(N) element creation + key diffing). During replay/streaming the transcript grows and ticks fire per fold-flush, so the work is **O(rows²)** — the measured 255 ms → 7.5 s blow-up on the 12 MB session. The "deferred-content hold" (don't mount the list during the initial replay) is a workaround that trades O(rows²) for a **blank pane**; that blank, plus the `.dev-card` materialize fade, is the reload flash. At steady state a 10k-turn transcript keeps 10k cells + 10k `IntersectionObserver`s mounted, and any live mid-turn tick re-reconciles all of them. The restore-progress UX compounds it: a bespoke `DevReplayProgress` banner + the `[DT10]` paint gate + prompt-entry disabling, three hand-rolled pieces doing what one pane-modal (`TugSheet`) should.

There is a second, quieter O(rows) trap that simply switching to windowing does **not** fix: `computeWindow`'s spacer math is a linear walk over `[0, itemCount)`, and `HeightIndex.prepare` rebuilds its Fenwick tree O(itemCount) whenever `itemCount` grows. `inline` mode skips `computeWindow` entirely, so today that cost is hidden. Naively switching to windowed mode would trade the O(rows²) *reconcile* for an O(rows²) *windowing math* during replay — the win would evaporate at the measurement gate. So the plan makes the offset/spacer math sublinear and growable **before** it deletes the deferred hold (see [P02], [P11], #why-inline-quadratic).

#### Strategy {#strategy}

- **Measure first, on real corpora.** Extend the existing `ReplayIngestPerf` / parse-counter instrumentation; record baselines on the user's actual 12 MB session and a long-turn session before changing anything. No synthetic fixtures; no claimed win until reproduced on real JSONL (the real-content-fixtures-only rule).
- **Make the windowing math sublinear and growable** so virtualization actually pays off: wire `computeWindow`'s offset/spacer math to the `HeightIndex` Fenwick (O(log N)) and give the Fenwick an amortized-O(log N) `append` so per-flush growth during replay doesn't trigger an O(N) rebuild.
- **Virtualize (retire `inline`).** Bound the mounted set to viewport + a cheap-tier overscan band, **and pin the active turn** so windowing can never unmount a live streaming turn or a pending permission/question dialog ([P11], using `computeWindow`'s existing `pinnedRange`).
- **Make the two rough-edges actually vanish** so virtualization is safe: a persistent measured-height cache that stores the *rich* height (finalized turns are immutable → their rich height is permanent) kills the scroll-shift; a bounded cheap-tier overscan band kills the blank-on-fling.
- **Delete the workarounds the keystone makes unnecessary** — the deferred-content hold and the `[DT10]` visibility gate — but only *after* measurement proves per-flush work is O(viewport) reconcile + O(log N) windowing math with the list mounted.
- **Re-house restore progress in a `TugSheet` pane-modal** (it already disables the card via `inert` + scrim), delay-gated at 1.5 s, with a Cancel that stops the load and closes the card. Retire the banner, the `[DT10]` gate, and the prompt-entry disabling.
- **Kill the materialize fade on restore-mount** (keep it only for genuine picker→new-card creation).
- **React cells first.** Use memo'd windowed mount/unmount; defer a real DOM recycling layer to a measurement-gated follow-on.

#### Success Criteria (Measurable) {#success-criteria}

- **Bounded mount:** opening any session mounts ≤ `viewport + band` cells (plus the pinned active turn), independent of turn count — a 5,000-turn session mounts < 60 cells (verified via the `perf.mounted_cells` counter from #step-1).
- **Per-flush work is sublinear:** during replay each flush is **O(viewport) reconcile + O(log N) windowing math** — reconciled-rows-per-commit bounded by window size, and `computeWindow` + `HeightIndex` growth show no O(N) walk (instrumented in #step-3, #step-4). Ingest of the 12 MB session **with the list mounted** is within +15% of the current deferred-hold baseline (so the hold can be deleted) — measured per #step-1.
- **No replay/reload flash:** cold restore under 1.5 s reveals final content once with no blank, no banner, no fade (real-app vet, #step-9). Cold restore ≥ 1.5 s presents a `TugSheet` with a progress bar + Cancel; Cancel stops the load and closes the card.
- **Long-transcript liveliness:** streaming a live turn into a 5,000-turn transcript holds 60 fps and reconciles ≤ window-size cells per delta, with the active turn pinned mounted (frame timing + `perf.live_commits`, #step-1).
- **No regressions** in scroll-anchor preservation, the inflight→committed seam (no scroll jump), per-cell copy/menu, cross-row selection-copy, or a live permission/question dialog while scrolled away (real-app vet against the existing behaviors).

#### Scope {#scope}

1. Perf instrumentation + recorded baselines on real corpora.
2. Persistent measured-height cache (rich height) keyed to survive unmount and row-position shifts.
3. Sublinear, growable windowing math: Fenwick-backed `computeWindow` offsets + `HeightIndex.append`.
4. Windowed transcript rendering (retire `inline`) with a cheap-tier overscan band and a pinned active turn.
5. Deletion of the deferred-content hold and the `[DT10]` visibility gate once #3/#4 are proven.
6. `TugSheet`-based restore-progress modal (delay-gated 1.5 s; Cancel = stop + close) replacing the `DevReplayProgress` banner + prompt-entry disabling.
7. Suppression of the `.dev-card` materialize fade on restore-mount.

#### Non-goals (Explicitly out of scope) {#non-goals}

- A real DOM recycling / cell-reuse pool — deferred to a measurement-gated follow-on ([P04]).
- Persisting rendered transcript content across a hard refresh (the bag holds no content and a hard refresh wipes memory; tugbank-caching the transcript is out of scope) ([P09]).
- Changing the wire/replay protocol, the reducer's fold cadence, or `CodeSessionStore`'s snapshot model.
- Changing the streaming-markdown imperative path (`render-incremental`), which is already correct per [L22].
- Migrating other `TugListView` consumers (picker, etc.) — though they inherit the sublinear `computeWindow` for free.

#### Dependencies / Prerequisites {#dependencies}

- Real session JSONL corpora from the user: the 12 MB motivating session and a long-turn session (the perf gate depends on them).
- The existing `TugListView` windowing engine (`computeWindow` with `pinnedRange`, `HeightIndex` with its Fenwick cache, `OVERSCAN_COUNT`), `TieredCell`, `TugSheet` / `useTugSheet`, `cancelDevRestore`, and the `CLOSE` chain action.

#### Constraints {#constraints}

- Tuglaws: [L02] (external state via `useSyncExternalStore`), [L06] (appearance via CSS/DOM), [L22] (store observers write DOM imperatively), [L23] (preserve scroll/selection/focus/live-dialog across DOM-down transitions — the `pinnedRange` obligation under windowing), [L26] (stable React identity across the inflight→committed seam). Cross-checked against `tuglaws/tuglaws.md`, `pane-model.md`, `component-authoring.md`.
- Warnings-are-errors (Rust side, if any store/reducer changes touch tugrust — none expected).
- No fake-DOM render tests, no mock-store assertion tests (banned). Pure-logic + real-app verification only.
- HMR is always running; never hand-build tugdeck. The streaming/duplication/font/HMR fixes already landed (`80c246c6`, `b136123f`, `f93f3775`) and must not regress.

#### Assumptions {#assumptions}

- Finalized `TurnEntry` rows are immutable (the reducer never mutates a committed turn), so their rendered rich height and content are permanent for the session's life.
- The snapshot reference is `Object.is`-stable between non-mutating dispatches and changes on every reducer tick (per `getSnapshot` memoization).
- `ResizeObserver` is available in the WKWebView host (it drives `HeightIndex` today).
- `computeWindow`'s `pinnedRange` clamps the window outward to a single contiguous range — pinning the active turn (one or two adjacent rows at the bottom) never splits the window.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit, kebab-case, no phase numbers. Plan-local decisions use `[P01]`. Global decisions (`design-decisions.md`) are cited by `[D##]` where relevant.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Height-cache keying (OPEN) {#q01-height-cache-keying}

**Question:** `HeightIndex` is keyed by row **index** (`Map<number, number>`). A re-entering row reuses its height only while indices are stable; a turn committing above shifts every later index and invalidates the cache. Do we re-key the cache by a stable row id (`turnKey`-derived), or keep index-keying plus an idle off-screen pre-measure pass?

**Why it matters:** Wrong choice reintroduces the scroll-shift that drove `inline` in the first place — the central risk of virtualizing.

**Options:**
- Re-key by stable id (`${turnKey}-user|assistant`), so height survives both unmount and row-position shift.
- Keep index-keying; pre-measure all rows once off-screen during idle after load (mounts O(rows) once, then windows).

**Plan to resolve:** Spike in #step-2 — re-key the cache and confirm a row scrolled out-and-back (and after a new turn commits above) keeps its measured rich height with zero shift.

**Resolution:** OPEN → expected DECIDED in [P02] via #step-2.

#### [Q02] Cheap-overscan band size (OPEN) {#q02-overscan-band}

**Question:** How large a band of cheap-tier rows to keep mounted above/below the viewport so a fast fling never shows a blank spacer, without re-bloating the mounted set? Note the current windowed `OVERSCAN_COUNT = 3` is measured in **cells**, not screens — the band must resolve to a concrete cell count (or a pixel budget converted to cells via the height index), not "screens".

**Why it matters:** Too small → blank-on-fling returns; too large → we drift back toward all-mounted.

**Options:** A fixed cell band (e.g. 8 / 16 / 24 cells) or a pixel budget (e.g. ±1500 px, matching `TieredCell`'s existing rich `rootMargin`) converted to cells per render.

**Plan to resolve:** Tune empirically in #step-4 against the long-transcript corpus; pick the smallest band (in cells/pixels) that holds no visible blank on a hard fling.

**Resolution:** OPEN → DECIDED via #step-4 measurement.

#### [Q03] Send-gating semantics during restore (OPEN) {#q03-send-gating}

**Question:** The prompt-entry "drop/defer a send while `replaying`" logic is partly *semantic* (don't dispatch a prompt into a mid-replay session), not just visual. Is that fully covered by the `TugSheet`'s `inert` lockout, or must a thin store-level guard remain?

**Why it matters:** Removing the prompt-entry disabling without an equivalent guard could let a programmatic/queued send race a mid-replay session.

**Plan to resolve:** Read the submit path (`tug-prompt-entry` route-prefix + `performSubmit`) in #step-7; keep the store-level guard if the lockout isn't sufficient.

**Resolution:** OPEN → resolved in #step-7.

#### [Q04] Windowed unmount vs cross-row copy / responder chain (OPEN) {#q04-windowed-copy}

**Question:** Windowed cells unmount when scrolled out. Does that break (a) the per-cell responder/menu wiring, (b) cross-row selection→markdown copy ([transcript-md-copy] reconstruction), or (c) the cross-block copy enumeration, when a selection spans rows that aren't all mounted?

**Why it matters:** `inline` kept every cell mounted, so cross-row selection always had live DOM. Windowing can put part of a selection in an unmounted spacer.

**Options (preferred first):**
- **Pin the selection's index span via `computeWindow.pinnedRange`** so every row the selection touches stays mounted — the idiomatic [L23] mechanism, already in the engine, the same one used for the active turn ([P11]). The window clamps outward to one contiguous range covering the selection.
- Reconstruct copy text from the store / parse-cache for unmounted rows — fallback only if a pathological selection spanning thousands of rows makes the pin too heavy.

**Plan to resolve:** Spike in #step-4: drive the existing copy/menu path across a scrolled-out boundary with the selection pinned; confirm cross-row copy is intact. Only reach for store-reconstruction if pinning a huge selection is itself a perf problem (then defer it to a follow-on).

**Resolution:** OPEN → resolved in #step-4 (prefer pin; reconstruction deferred if needed).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Windowing math stays O(N) (computeWindow walk / Fenwick rebuild) | high | high (if #step-3 skipped) | Fenwick-backed `computeWindow` + growable `append` ([P02], #step-3) | Per-flush windowing math shows an O(N) walk in #step-4 |
| Virtualization reintroduces scroll-jump | high | med | Persistent **rich**-height cache + idle pre-measure ([P02]) | Any visible jump on scroll-back or cheap→rich upgrade in #step-4 vet |
| Windowing unmounts the live turn / pending dialog | high | med | Pin the active turn via `pinnedRange` ([P11]) | Live dialog vanishes or stream flickers when scrolled away |
| Windowed unmount breaks cross-row copy / menu | med | med | Pin the selection range ([Q04]); store-sourced copy as fallback | Copy across a scrolled-out boundary loses text |
| Deleting deferred hold regresses 12 MB ingest | high | low | Measurement gate ([P10]) — delete only after per-flush work proven sublinear | Ingest > baseline +15% in #step-5 |

**Risk R01: Scroll-jump on virtualization** {#r01-scroll-jump}
- **Risk:** A row re-entering the window with an estimated (or cheap, not rich) height changes `scrollHeight` and the browser clamps `scrollTop`, jumping the transcript.
- **Mitigation:** [P02] persistent cache storing the *rich* height keyed by stable id; idle off-screen pre-measure so rich heights are final before the user scrolls.
- **Residual risk:** A never-before-rich row on a very fast initial scroll could still use an estimate for one frame; mitigated by good per-kind estimates and the cheap band keeping it mounted ahead of the viewport.

**Risk R02: Cross-row copy regression** {#r02-cross-row-copy}
- **Risk:** A selection spanning a scrolled-out row copies only the mounted portion.
- **Mitigation:** [Q04] / [P11] — pin the selection's index span so its rows stay mounted; store-reconstruct only as a heavy-selection fallback.
- **Residual risk:** A selection spanning thousands of rows pins them all (bounded by the user's own action); reconstruction is the escape hatch if that bound is too costly.

**Risk R03: Ingest regression from deleting the hold** {#r03-ingest-regression}
- **Risk:** Mounting the list during replay re-introduces per-flush O(N) work.
- **Mitigation:** [P10] measurement gate — #step-5 only deletes the hold after #step-3/#step-4 instrument that per-flush work is O(viewport) reconcile + O(log N) windowing math.
- **Residual risk:** Pathological viewports (very tall card) enlarge the window; bounded by viewport, still O(viewport).

**Risk R04: Live turn / dialog unmounted by windowing** {#r04-live-unmount}
- **Risk:** Scrolling up during a live turn windows-out the bottom (in-flight) row and unmounts it — tearing down a pending permission/question dialog and the `DevZ1C` footer, and flickering the streaming subscription.
- **Mitigation:** [P11] pin the active turn's rows via `pinnedRange` so they never unmount while the turn is in flight.
- **Residual risk:** None material — the pin is one/two rows; the cost is negligible and bounded to the in-flight window.

---

### Design Decisions {#design-decisions}

#### [P01] Retire `inline`; window the transcript (DECIDED) {#p01-window-transcript}

**Decision:** The dev transcript renders through `TugListView`'s windowing engine (`computeWindow` + `HeightIndex` + overscan + spacers), not `inline` mode. The mounted set is bounded by viewport + a cheap-tier overscan band, plus the pinned active turn.

**Rationale:**
- `inline` is O(rows) per tick and O(rows²) during growth — the documented root cause (#context).
- The windowing engine already exists and is used by other consumers; the transcript is the outlier.

**Implications:** Spacers return; `HeightIndex` becomes load-bearing; the windowing math must be made sublinear ([P02]); the active turn and any selection must be pinned ([P11]); cross-row copy must tolerate unmounted rows ([Q04]).

#### [P02] Persistent rich-height cache keyed by stable id; sublinear, growable windowing math (DECIDED) {#p02-persistent-heights}

**Decision:** (a) Measured **rich** heights persist across unmount and row-position shifts, keyed by a stable row id (`turnKey`-derived) rather than (or in addition to) the flat index, so a finalized row never reverts to an estimate or a cheap height once its rich height is known. (b) `computeWindow`'s offset/spacer math reads the `HeightIndex` Fenwick (`topSpacer = offsetForIndex(firstIndex)`, `bottomSpacer = totalHeight − offsetForIndex(lastIndex)`), making it O(log N); and `HeightIndex` gains an amortized-O(log N) `append` so growth during replay doesn't trigger an O(N) `prepare` rebuild.

**Rationale:**
- Finalized turns are immutable → measured rich height is permanent; index-keying alone breaks when a turn commits above ([Q01]); id-keying survives it.
- `computeWindow` today walks `[0, itemCount)` linearly for spacers and `HeightIndex.prepare` rebuilds O(N) on growth — both make per-flush work O(N) and would defeat virtualization (#why-inline-quadratic). The Fenwick already exists in `HeightIndex`; it is simply not wired into `computeWindow`, and `prepare` is not growable.

**Implications:** `HeightIndex` gains an id→height map and an `append`; `computeWindow` consumes the Fenwick for offsets; cheap vs rich height divergence must be handled — the cache stores the **rich** height, and a row entering the band cheap-first must use its cached/pre-measured rich height (or stay mounted-cheap ahead of the viewport) to avoid a shift on upgrade. Pure-logic testable.

#### [P03] Cheap-tier overscan band replaces all-mounted; `computeWindow` stays single-window (DECIDED) {#p03-overscan-band}

**Decision:** The mounted window is a single `computeWindow` range whose overscan **is** the cheap-tier band; within that window, `TieredCell` continues to decide rich (viewport) vs cheap (band) by its existing viewport-intersection logic. There is **no** second radius added to `computeWindow`.

**Rationale:**
- The cheap tier is what made `inline` tolerable; bounding it to the overscan band keeps the "never a blank on normal scroll" property without mounting everything.
- `computeWindow` already produces exactly one contiguous window; rich-vs-cheap is orthogonal and already lives in `TieredCell`. Adding a "rich radius" to `computeWindow` is needless complexity.

**Implications:** Set the overscan to the band size ([Q02]); `TieredCell` likely needs **no change** beyond having far fewer rows to observe (its `IntersectionObserver` now sees only the mounted window). This materially shrinks the windowing step's blast radius.

#### [P04] Memo'd windowed React cells first; recycling deferred (DECIDED) {#p04-react-cells-first}

**Decision:** Use React mount/unmount of memo'd windowed cells. A real DOM recycling pool is a measurement-gated follow-on, not in this plan.

**Rationale:** Once `inline` is gone and the windowing math is sublinear, mount/unmount is O(viewport); memo + parse-cache make remount cheap. Recycling adds complexity that measurement may show is unnecessary (user's explicit call).

**Implications:** #non-goals lists recycling; #step-10 is a deferred follow-on stub gated on #step-6 measurements.

#### [P05] Delete the deferred-content hold and the `[DT10]` gate (DECIDED) {#p05-delete-hold}

**Decision:** Once #step-3 (sublinear math) and #step-4 (windowing) are proven to keep per-flush work O(viewport) reconcile + O(log N) windowing math, remove the `listMounted` deferred-content hold and the `.dev-card-transcript[data-replaying] .tug-list-view { visibility: hidden }` gate. The list stays mounted during replay.

**Rationale:** Both exist solely to avoid the `inline` per-flush O(rows) commit. A windowed list with sublinear math removes that cost, so the workarounds — and the blank they cause — are obsolete.

**Implications:** Restore shows content as it lands (lively), governed by the reveal gate [P07] rather than a hard blank.

#### [P06] Restore progress lives in a `TugSheet` pane-modal (DECIDED) {#p06-restore-sheet}

**Decision:** A `TugSheet` presents restore progress: it houses the `TugProgressIndicator` bar, disables the card via its built-in `inert` + scrim, and carries a **Cancel** button wired to stop the load (`cancelDevRestore`) **and** close the card (`CLOSE` action). The bespoke `DevReplayProgress` banner and the prompt-entry replay-disabling are retired.

**Rationale:**
- `TugSheet` is the project's pane-modal primitive and already does card-disable + dismissal; the banner re-implemented a worse version. `TugBulletin`/`TugPaneBulletin` are non-blocking Sonner toasts — wrong shape for a blocking load.

**Implications:** Cancel semantics change from "drop to picker" to "stop + close card." `deriveReplayProgress` / `completeReplayProgress` view logic is reused inside the sheet content. Resolve [Q03] (send-gating) when removing the prompt-entry disabling.

#### [P07] Restore reveal is delay-gated at 1.5 s (DECIDED) {#p07-reveal-gate}

**Decision:** If a cold restore completes under 1.5 s, no modal is presented — the final state reveals once. At/over 1.5 s, the `TugSheet` [P06] is presented. This supersedes the committed `DevReplayProgress` delay-gate (`f93f3775`); the gate logic moves into the sheet-present decision and the threshold becomes 1.5 s.

**Rationale:** The user's liveliness rule: fast → reveal once (no flash); slow → communicate progress. Content flashing by too fast to read helps nobody, so reveal-once is gated on being quick.

**Implications:** A delay timer (local-data) measured from `getRestoreStartedAt` decides sheet presentation; reuses the persistent-stamp pattern `DevRestoring` already uses.

#### [P08] No materialize fade on restore-mount (DECIDED) {#p08-fade-gate}

**Decision:** The `.dev-card` opacity `0→1` fade fires only on genuine picker→new-card creation, not on a restore-mount (reload / cold-boot rehydration).

**Rationale:** The fade was written to coordinate with the picker sheet's exit; on restore there is no picker to coordinate with, so it reads as a gratuitous flash.

**Implications:** The first-mount fade effect gates on a "fresh-create vs restore" signal (cold-restore active at mount ⇒ skip the fade).

#### [P09] No instant-content path for hard-refresh reload (DECIDED) {#p09-no-bag-paint}

**Decision:** Reload performance is delivered by cheap re-replay+render ([P01], [P02]) plus the reveal gate ([P07]) and no-fade ([P08]) — **not** by painting persisted content. The preservation bag holds only scroll + tool-block expansion, not transcript content, and `Developer ▸ Reload` is a true hard refresh that wipes JS memory.

**Rationale:** Corrects an earlier (wrong) "bag-paint" idea after confirming the bag's contents and the hard-refresh semantics.

**Implications:** There is necessarily a brief re-replay latency before content; the reveal gate [P07] makes it either an imperceptible reveal-once (< 1.5 s) or an explained modal (≥ 1.5 s).

#### [P10] Measurement-first, real-corpus-gated (DECIDED) {#p10-measure-gate}

**Decision:** Every perf-affecting step is judged against baselines captured on the user's real session JSONL (the real-content-fixtures-only rule); no step that claims a win is "done" until reproduced on the real 12 MB + long-turn corpora.

**Rationale:** Past perf work was validated on real sessions; synthetic fixtures mislead.

**Implications:** #step-1 is a hard prerequisite; #step-5 (delete the hold) is explicitly gated on a measured comparison that #step-3/#step-4 made achievable.

#### [P11] Pin the active turn (and selections) via `pinnedRange` (DECIDED) {#p11-pin-active-turn}

**Decision:** Under windowing, the in-flight turn's rows are pinned into the rendered window via `computeWindow`'s existing `pinnedRange`, so a live streaming turn — and any pending permission/question dialog or `DevZ1C` footer it hosts — can never be unmounted by scrolling away. The same mechanism pins a cross-row selection's index span ([Q04]).

**Rationale:**
- `pinnedRange` is documented as *"the [L23] obligation under windowed mounting"* — keeping selection/focus rows mounted while the window moves. The active turn and the user's selection are exactly the rows L23 requires to survive.
- Without it, virtualization regresses live-dialog visibility/interaction and cross-row copy — both of which `inline` got for free by mounting everything.

**Implications:** The host computes a `pinnedRange` covering (a) the active turn's row(s) when `activeStartRow >= 0`, and (b) the current selection's index span when a selection exists; passes it to the list view. State is structure/derived (no React state). Pure-logic testable on `computeWindow` (already has pinned-range tests to extend).

---

### Deep Dives (Optional) {#deep-dives}

#### Why `inline` is O(rows²) — and why windowing alone isn't enough {#why-inline-quadratic}

In `inline` mode `computeWindow` is bypassed: the rendered range is `[0, itemCount)`. Every store notify re-runs the list component, which builds `itemCount` cell elements and reconciles them by key. `React.memo` (`transcriptCellPropsEqual`) skips each cell's *subtree* but not the parent's O(N) element creation + key diff. During replay the reducer folds wire events (notify every `REPLAY_FOLD_FLUSH_THRESHOLD`), so notifies ≈ turns / threshold, and N grows with turns → Σ O(N) ≈ **O(turns²)**. The deferred-content hold sidesteps this by not mounting the list until `replay_complete`, then mounting once (O(N)).

Switching to windowed mode fixes the *reconcile* (only the bottom window's cells reconcile per flush under follow-bottom), **but** introduces a second O(N): `computeWindow` (`list-view-window.ts`) computes spacers with linear walks over `[0, firstIndex)` and `[lastIndex, itemCount)`, and `HeightIndex.prepare` rebuilds its Fenwick O(itemCount) whenever `itemCount` grows (its own docstring flags the unfinished "Step 4 height-index version"). Per flush that is O(N); over replay, O(N²) again. So [P02] wires `computeWindow`'s offsets to the Fenwick (O(log N)) and makes the Fenwick growable (amortized O(log N) `append`) **before** [P05] deletes the hold. Net per flush: O(viewport) reconcile + O(log N) windowing math → O(turns·log N) total, and the hold becomes unnecessary.

#### Restore flow today vs target {#restore-flow}

**Today (hard refresh):** page reloads → card re-mounts → `.dev-card` fades `0→1` → cold-restore replay window opens → `listMounted=false` (deferred hold) blanks the pane → `DevReplayProgress` banner shows from t=0 (+700 ms dwell) → `replay_complete` → list mounts once → content. Visible as fade → blank → "Restoring…" → pop.

**Target:** page reloads → card re-mounts (no fade on restore, [P08]) → windowed list mounts and renders turns as they fold in, bottom-pinned, O(viewport) reconcile + O(log N) math per flush ([P02], [P05]) → if total < 1.5 s, that's the whole story (reveal-once) → if ≥ 1.5 s, a `TugSheet` ([P06]) is presented over the card with a progress bar + Cancel until `replay_complete`.

#### Codebase Map & Field Notes (read this first if picking up cold) {#codebase-map}

> Orientation for an implementer starting from this document alone. Paths are relative to `tugdeck/src/`. Cited by **symbol / grep target**, not line number (line numbers drift). All facts here were verified against the real code during devise + two vet passes.

**File map — what lives where:**

- `components/tugways/tug-list-view.tsx` — the windowing primitive (~3000 lines). The `inline` prop and the `inline === true ? {firstIndex:0,lastIndex:itemCount} : computeWindow({...})` branch are the switch this plan flips for the transcript. `heightForIndex` is the per-index accessor passed to `computeWindow`; `heightIndexRef.current.prepare(itemCount, …)` is the O(N)-on-growth call to make incremental; the `ResizeObserver` `heightIndex.set(index, newHeight)` is the measurement write.
- `components/tugways/internal/list-view-window.ts` — `computeWindow` (pure). **Today it does linear `[0,firstIndex)` / `[lastIndex,itemCount)` spacer walks** — its own docstring flags the unfinished "Step 4 height-index version." It already has `pinnedRange` (clamps the window outward to one contiguous range — the `[L23]` mechanism this plan uses for the active turn + selections). Has unit tests in `internal/__tests__/list-view-window.test.ts`.
- `components/tugways/internal/list-view-height-index.ts` — `HeightIndex`. **Already has the Fenwick** (`prepare`, `offsetForIndex`, `indexForOffset`, `totalHeight` — O(log N)). Keyed by **index** (`Map<number,number>`). **No `append` yet** — `prepare` rebuilds O(N) when `itemCount` grows. Step 2 adds id-keying; Step 3 adds `append` + wires the Fenwick into `computeWindow`. This means Step 3 is "use methods that exist + add one," not "build a Fenwick."
- `lib/dev-transcript-data-source.ts` — `DevTranscriptDataSource`. `idForIndex` already mints stable ids `${turnKey}-user|assistant|ghost` (use these for [P02] id-keying and [P11] pin index math). `buildRowLayout` exposes `activeStartRow` / `ghostStartRow` (use `activeStartRow` to derive the active-turn pin). `transcriptCellPropsEqual` is the cell memo gate (finalized rows memo-hit on stable `turn` reference).
- `components/tugways/cards/dev-card-transcript.tsx` — `DevTranscriptHost`. The `<TugListView … inline pageByEntry>` is the call site to de-`inline`. `listMounted = replayEverCompleted || !deriveColdRestoreActive(s)` is the **deferred hold** to delete ([P05]). `data-replaying={isReplaying || undefined}` drives the `[DT10]` gate. `<DevReplayProgress …>` is the banner to retire. `AssistantTurnCell` / `CodeRowBody` host the live turn; `forceRich` keeps the in-flight row rich (but does NOT keep it mounted under windowing — hence the [P11] pin).
- `components/tugways/cards/transcript-tier.tsx` — `TieredCell` + `useInRichWindow` (shared `IntersectionObserver`, `rootMargin: 1500px`). Likely **unchanged** by this plan — once windowed it just observes fewer rows ([P03]).
- `components/tugways/cards/dev-replay-progress.tsx` — the banner to retire, BUT keep + reuse its pure view helpers `deriveReplayProgress` / `completeReplayProgress` / `formatReplayProgressValue` inside the new `DevRestoreSheet`. The delay-gate already added here (commit `f93f3775`) is the *logic* to move into the sheet at the 1.5 s threshold.
- `components/tugways/cards/dev-card.css` — the `[DT10]` rule to remove: `.dev-card-transcript[data-replaying] .tug-list-view { visibility: hidden }`.
- `components/tugways/cards/dev-card.tsx` — the `.dev-card` **materialize fade** to gate ([P08]): a `useLayoutEffect` that sets `el.style.opacity = "0"` then `group(...).animate(el, [{opacity:0},{opacity:1}], {key:"dev-card-enter"})` on first body mount. `coldRestoreActive` / `sawColdRestoreRef` (already in this file) is the fresh-create-vs-restore signal. The **windowed picker** `<TugListView>` (recents) also lives here — proof the windowed path is production-exercised.
- `components/tugways/cards/dev-card.tsx` `DevRestoring` — the EXISTING delay-gated restore panel. Mirror its pattern: `RESTORE_PLACEHOLDER_DELAY_MS = REPLAY_SOFT_BUDGET_MS` + a `setTimeout` armed from `getRestoreStartedAt(cardId)`. The new sheet uses **1.5 s**, not `REPLAY_SOFT_BUDGET_MS` (= 2000, in `lib/code-session-store/reducer.ts`).
- `components/tugways/cards/dev-card-restore-gate.ts` — `deriveColdRestoreActive`.
- `lib/dev-session-restore.ts` — `getRestoreStartedAt(cardId)` (persists across the card's services-null remount — read it, don't use a component-local timer), `cancelDevRestore(cardId)` (Cancel's stop-the-load half), `getResumeDisplayMetadata`.
- `components/tugways/tug-sheet.tsx` — `useTugSheet() → { showSheet, renderSheet }`; pane-modal that sets the pane body `inert` + raises the pane scrim (this is what disables the card — no bespoke prompt-entry disabling needed). Cancel/Escape route through the `cancelDialog` chain action. `CLOSE` action (`TUG_ACTIONS.CLOSE`) is Cancel's close-the-card half.
- `lib/code-session-store.ts` — perf surface to extend ([P10]): `ReplayIngestPerf {startedAtMs, completedAtMs, frames, folds, commits}`, `LiveTurnPerf {commits}`, `_getPerfForDevPanel()`. The replay fold lives in `dispatch` (`REPLAY_FOLD_FLUSH_THRESHOLD`, `_publishAndNotify`) — DO NOT change the fold cadence ([#non-goals]); just instrument and let windowing absorb the per-flush ticks. `snapshotRowParseCounters()` (`lib/markdown/parse-counters.ts`) + `logSessionLifecycle("perf.replay_render" | "perf.row_parse")` are already emitted from `DevTranscriptHost` — extend, don't duplicate.

**Verified facts (so you can trust the plan's framing):**
- The windowed (`non-inline`) `TugListView` path **is production-used** by the pickers (`resume-sheet`, `dev-card` recents, `permission-rules-editor`, `rewind-sheet`) — so spacers / scroll-restore / `ResizeObserver` mechanics are sound. The genuinely novel stress is **growth-during-replay** (Step 3), which the pickers don't exercise.
- `computeWindow` is **single-window**; the cheap band IS the overscan; rich-vs-cheap is `TieredCell`'s existing job. Do not add a second radius.
- The state-preservation bag holds **only scroll + tool-block expansion, not transcript content**; `Developer ▸ Reload` is a true hard refresh that wipes JS memory → there is no instant-content path ([P09]). The reveal gate is the whole reload-UX story.

**Invariants that MUST survive (the do-not-break list):**
- **Scroll-anchor during streaming:** `lib/markdown/render-incremental.ts` preserves `.tugx-md-block` DOM identity for unchanged blocks (browser `overflow-anchor`). It was just fixed (commit `80c246c6`, DOM-authoritative reconcile via `data-content-hash`) — do not regress it; windowing must not tear down a streaming block's wrapper while it's in view.
- **Inflight→committed seam:** the assistant row keeps a byte-identical React key `${turnKey}-assistant`, one renderer, one `"assistant"` kind across `turn_complete`, so the cell wrapper survives without unmount (else `scrollHeight` collapses → scroll-jump-to-top). Windowing must keep the active turn in-window across the seam — follow-bottom usually does; the [P11] pin guarantees it.
- **Per-turn streaming paths** `turn.${turnKey}.message.${messageKey}.text` retain their final values after commit, so the same `TugMarkdownBlock` keeps showing content with no remount.
- **Three prior fixes already on the branch history must stay green:** `80c246c6` (markdown reconcile — no HMR duplication), `b136123f` (static `/public/fonts.css` `<link>` — no font flash; the `@font-face` rules live OUTSIDE the Vite HMR graph and must stay there), `f93f3775` (delay-gated `DevReplayProgress` — superseded by the `TugSheet`, but its gate logic carries forward to [P07]).

**Build / workflow reminders (project conventions):**
- HMR is always running — **never hand-build tugdeck**. Type-check: `bunx tsc --noEmit`. Unit tests: `bun test`. App-tests: `just app-test <file>` (recipe ends in a greppable `VERDICT: PASS|FAIL`; never hand-roll `bun test` with `TUGAPP_*` env vars).
- This plan runs on a `tugutil dash` worktree: commit each step with `tugutil dash commit` (NOT on `main`); the user joins to `main` via `tugutil dash join`. No `Co-Authored-By` lines. No plan-step numbers in code/comments.
- Perf claims are only valid on the user's **real** session JSONL (the 12 MB session + a long-turn session). Get those from the user at Step 1; do not invent fixtures.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Window range `[firstIndex, lastIndex)` | structure (derived) | recomputed in render from `scrollTop` + `HeightIndex` Fenwick; no React state | [L02], [L06] |
| `pinnedRange` (active turn + selection span) | structure (derived) | computed in render from `activeStartRow` + selection; passed to `computeWindow` | [L02], [L23] |
| Measured rich-height cache (id→height) | local-data (derived) | `HeightIndex` map + Fenwick, written from `ResizeObserver`, read in render | [L22] |
| Cell rich/cheap tier | appearance | `TieredCell` viewport-intersection ([P03]); DOM `data-tier` | [L06] |
| Restore-sheet presented | structure | `useSyncExternalStore`(coldRestoreActive) + delay timer ⇒ mount `TugSheet` | [L02] |
| Reveal/sheet delay timer (`revealed`) | local-data | `useState` + `setTimeout`, stamp from `getRestoreStartedAt` | [L24], [L02] |
| Materialize-fade suppression on restore | appearance | WAAPI fade gated on cold-restore-at-mount signal | [L06] |
| Perf counters (mounted cells, per-commit reconcile, windowing-walk, reveal ms) | local-data (diagnostic) | store/dev-panel counters, greppable `perf.*` log lines | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/dev-restore-sheet.tsx` | `TugSheet`-housed restore-progress modal (progress bar + Cancel = stop + close), delay-gated. |
| `tugdeck/src/components/tugways/cards/__tests__/dev-restore-sheet.test.ts` | Pure-logic tests for the present/dismiss gate + reuse of `deriveReplayProgress`. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `HeightIndex` | class | `internal/list-view-height-index.ts` | Add id-keyed rich-height resolution + amortized-O(log N) `append(height)` so growth doesn't rebuild O(N) ([P02]). |
| `computeWindow` | fn | `internal/list-view-window.ts` | Offsets/spacers via the `HeightIndex` Fenwick (O(log N)); single window unchanged; keep `pinnedRange` ([P02], [P03]). |
| `TieredCell` | component | `cards/transcript-tier.tsx` | Likely unchanged — fewer rows to observe once windowed ([P03]). |
| `DevTranscriptHost` | component | `cards/dev-card-transcript.tsx` | Drop `inline`; compute + pass `pinnedRange` (active turn + selection); remove `listMounted` hold; present `DevRestoreSheet` ([P01],[P05],[P06],[P11]). |
| `DevReplayProgress` | component | `cards/dev-replay-progress.tsx` | Retire (view logic absorbed into `DevRestoreSheet`) ([P06]). |
| `.dev-card-transcript[data-replaying] .tug-list-view` | CSS rule | `cards/dev-card.css` | Remove the `[DT10]` visibility gate ([P05]). |
| first-mount fade effect | effect | `cards/dev-card.tsx` | Gate on fresh-create vs restore ([P08]). |
| `perf.mounted_cells` / per-commit reconcile / windowing-walk counters | instrumentation | `code-session-store.ts` / list view | Extend `ReplayIngestPerf` surface ([P10]). |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic)** | Window math, Fenwick offsets/append, id-keyed rich height, pinned-range clamp, reveal-gate timing | `computeWindow` Fenwick-backed + pinned-range, `HeightIndex` append/id-key, sheet present/dismiss gate |
| **Real-app vet** | Behavior that only the live engine exercises | scroll-no-jump, replay-no-flash, cold-reload UX, cross-row copy, live-dialog-while-scrolled. Run via `just app-test <file>` (never hand-rolled `bun test`); the existing list/scroll suite is the ready-made regression harness — `at0014-cold-boot-scroll`, `at0014-scroll-persistence`, `at0059-region-scroll-anchor-save`, `at0061-region-scroll-anchor-apply`, `at0060-list-view-content-settled`, `at0069-outer-transcript-first-paint`, `at0083-list-view-submit-pin`, `at0121/at0122-list-view-*focus`. Use HMR vetting only where no AT recipe fits. |
| **Perf measurement** | Falsify the success criteria on real corpora | mounted-cell count, per-commit reconcile, windowing-walk presence, ingest ms, scroll fps, reveal ms |

#### What stays out of tests {#test-non-goals}

- No fake-DOM render tests (happy-dom is deleted; banned) — windowing/Fenwick/height/gate logic is exercised as pure functions; rendering behavior is real-app vetted.
- No mock-store assertion tests (banned) — the store is exercised through the real reducer/replay on real JSONL.
- No synthetic perf fixtures — perf claims use the user's real sessions only ([P10]).

---

### Execution Steps {#execution-steps}

> **Picking this up cold? Read [#codebase-map](#codebase-map) first** — it maps every file/symbol these steps touch, the verified facts behind the design, the do-not-break invariants, and the build/workflow conventions, all from the document alone.
>
> Commit after all checkpoints pass. Steps run on a `tugutil dash` worktree (`tugutil dash commit` per step; never `main`).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Perf instrumentation + real-corpus baselines | pending | — |
| #step-2 | Persistent id-keyed rich-height cache | pending | — |
| #step-3 | Sublinear, growable windowing math (Fenwick computeWindow + append) | pending | — |
| #step-4 | Window the transcript (retire inline) + cheap band + pin active turn | pending | — |
| #step-5 | Delete deferred hold + [DT10] gate (measurement-gated) | pending | — |
| #step-6 | Integration checkpoint — re-measure vs baseline | pending | — |
| #step-7 | TugSheet restore modal (delay-gated, Cancel=stop+close) | pending | — |
| #step-8 | Suppress materialize fade on restore-mount | pending | — |
| #step-9 | Integration checkpoint — reload/restore UX | pending | — |
| #step-10 | (Deferred) DOM recycling — only if measurement demands | pending | — |

#### Step 1: Perf instrumentation + real-corpus baselines {#step-1}

**Commit:** `perf(transcript): instrument mount/commit/windowing/reveal; record real-corpus baselines`

**References:** [P10] Measurement-first (#why-inline-quadratic, #success-criteria), extends `ReplayIngestPerf`

**Artifacts:**
- New counters: `perf.mounted_cells` (cells currently mounted), per-commit reconciled-row count, a windowing-walk probe (did `computeWindow`/`HeightIndex` do an O(N) walk this commit), cold-reveal ms; greppable `perf.*` log lines via `logSessionLifecycle` + dev-panel readout.
- A recorded baseline for the 12 MB session and a long-turn session: ingest ms, replay commits, mounted cells, scroll fps, reload-to-content ms.

**Tasks:**
- [ ] Add mounted-cell + per-commit reconcile + windowing-walk counters to the list view / store perf surface.
- [ ] Add a cold-reveal-ms measurement (restore start → first content paint).
- [ ] Capture baselines on both real corpora via the dev panel + greppable logs; record them.

**Tests:**
- [ ] Pure-logic test for any counter-derivation helper added.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `cd tugrust && cargo nextest run` (sanity, no Rust expected).
- [ ] Greppable `perf.mounted_cells` / per-commit / windowing-walk / reveal lines emit on a real reload; baseline numbers recorded for both corpora.

#### Step 2: Persistent id-keyed rich-height cache {#step-2}

**Depends on:** #step-1

**Commit:** `feat(list-view): id-keyed persistent rich heights`

**References:** [P02] Persistent heights (part a), [Q01] Height-cache keying (#r01-scroll-jump)

**Artifacts:**
- `HeightIndex` resolves effective height id-first (stable `turnKey`-derived id), index-fallback; the cached value is the **rich** height; heights survive unmount and row-position shift.

**Tasks:**
- [ ] Add id→height map alongside the index map; resolution prefers id.
- [ ] Thread a stable row id from the data source's `idForIndex` into the height-set path; ensure the measured value is the rich-rendered height.
- [ ] Handle cheap-vs-rich divergence: a row entering cheap-first uses its cached/pre-measured rich height (or document why the cheap band keeps it mounted-rich ahead of the viewport). If [Q01] picks pre-measure, add the idle off-screen pass; else document why id-keying suffices.

**Tests:**
- [ ] Pure-logic: a row id keeps its measured rich height after its index shifts (turn committed above) and after unmount/remount.

**Checkpoint:**
- [ ] `bun test` for the height-index suite passes.
- [ ] [Q01] resolved in-plan ([P02]) with the chosen approach noted.

#### Step 3: Sublinear, growable windowing math {#step-3}

**Depends on:** #step-2

**Commit:** `perf(list-view): Fenwick-backed computeWindow offsets; growable height index`

**References:** [P02] Persistent heights (part b), Risk R01 (#why-inline-quadratic, #r03-ingest-regression)

**Artifacts:**
- `computeWindow` computes `topSpacer`/`bottomSpacer`/offsets via the `HeightIndex` Fenwick (`offsetForIndex`, `totalHeight`) — O(log N), no `[0, itemCount)` walk.
- `HeightIndex.append(height)` extends the Fenwick in amortized O(log N) (doubling-backed arrays) so growth during replay does not trigger an O(N) `prepare` rebuild.

**Tasks:**
- [ ] Add `HeightIndex.append`; make `prepare`/growth incremental (or amortized-doubling) rather than full O(N) rebuild on every `itemCount` change.
- [ ] Rewrite `computeWindow` spacer/offset math to read the Fenwick; keep the single-window + `pinnedRange` semantics unchanged. Note this changes `computeWindow`'s input shape (from an `estimatedHeightForIndex` accessor to a `HeightIndex`/Fenwick handle), which flows through the **windowed picker consumers** (`resume-sheet`, the `dev-card` recents picker, `permission-rules-editor`, `rewind-sheet`) — they must keep working and are re-vetted via `list-view-window.test.ts` + the picker app-tests. Output `ComputeWindowResult` is unchanged.
- [ ] Wire `TugListView` to `append` on data-source growth instead of re-`prepare`-ing from scratch.

**Tests:**
- [ ] Pure-logic: Fenwick-backed `computeWindow` matches the linear reference for random heights/scroll offsets; `append` keeps prefix sums correct; pinned-range clamp preserved.

**Checkpoint:**
- [ ] `bun test` window + height-index suites pass; `bunx tsc --noEmit` clean.
- [ ] Sublinearity proven at the **unit** level (op-count assertion): `append` of K rows performs no O(N) iteration, and a Fenwick-backed `computeWindow` over a large N does O(log N) reads — not a `[0, itemCount)` walk. (The *live* `perf.windowing-walk` probe is exercised by the transcript only once it is windowed; that check lands in #step-5, since at Step 3 the transcript is still `inline` and does not call `computeWindow`.)

#### Step 4: Window the transcript (retire inline) + cheap band + pin active turn {#step-4}

**Depends on:** #step-3

**Commit:** `feat(transcript): window rows; retire inline; cheap band; pin active turn`

**References:** [P01] Window transcript, [P03] Overscan band, [P04] React cells first, [P11] Pin active turn, [Q02] band size, [Q04] cross-row copy (#why-inline-quadratic, #r02-cross-row-copy, #r04-live-unmount)

**Artifacts:**
- `DevTranscriptHost` drops `inline`; overscan set to the cheap-band size; host computes and passes `pinnedRange` covering the active turn's row(s) and any current selection span.
- Deferred hold + `[DT10]` gate **kept for now** (deleted in #step-5 after measurement).

**Tasks:**
- [ ] Switch `DevTranscriptHost` off `inline`; set overscan = band ([Q02], in cells/pixels).
- [ ] Compute `pinnedRange` = active-turn rows ∪ selection span; pass to `TugListView`.
- [ ] Confirm `TieredCell` needs no change (it observes only the mounted window now) — or make the minimal change if it does ([P03]).
- [ ] Tune [Q02] band size against the long-transcript corpus (smallest band with no fling-blank).
- [ ] Spike [Q04]: verify cross-row selection→copy and per-cell menu across a scrolled-out boundary with the selection pinned; reach for store-reconstruction only if a huge selection makes pinning too heavy (then defer).
- [ ] Verify [R04]: scroll away during a live turn with a pending permission/question dialog — it stays mounted (pinned) and the stream doesn't flicker.

**Tests:**
- [ ] Pure-logic: host `pinnedRange` derivation (active-turn rows; selection span; no pin when idle + no selection).
- [ ] Real-app vet: scroll a long transcript — no jump on scroll-back or cheap→rich upgrade; no blank on normal scroll; mounted-cell counter bounded; live dialog survives scroll-away.
- [ ] Regression harness — re-run the existing list/scroll app-tests and keep them green: `just app-test at0014-cold-boot-scroll`, `at0014-scroll-persistence`, `at0059-region-scroll-anchor-save`, `at0061-region-scroll-anchor-apply`, `at0060-list-view-content-settled`, `at0069-outer-transcript-first-paint`, `at0083-list-view-submit-pin`. These guard scroll-anchor / submit-pin / first-paint — the invariants windowing is most likely to disturb.

**Checkpoint:**
- [ ] `bun test` passes; `bunx tsc --noEmit` clean.
- [ ] `perf.mounted_cells` bounded by viewport+band (+pinned) on a 5,000-turn session (independent of N).
- [ ] [Q02], [Q04], [R04] resolved (or [Q04] reconstruction deferred with a documented follow-on).

#### Step 5: Delete deferred hold + [DT10] gate (measurement-gated) {#step-5}

**Depends on:** #step-4

**Commit:** `refactor(transcript): drop deferred-content hold and DT10 paint gate`

**References:** [P05] Delete hold, [P10] Measure gate (#r03-ingest-regression, #why-inline-quadratic)

**Artifacts:**
- `listMounted` deferred-content hold removed; `.dev-card-transcript[data-replaying] .tug-list-view { visibility:hidden }` removed. List mounted during replay.

**Tasks:**
- [ ] Instrument replay with the list mounted: confirm per-commit work is O(viewport) reconcile + O(log N) windowing math (the windowing-walk probe stays clear).
- [ ] Compare 12 MB ingest with list mounted vs the #step-1 deferred-hold baseline.
- [ ] Only if within +15%: remove the hold and the `[DT10]` gate.

**Tests:**
- [ ] Real-app vet: replay the 12 MB session with the list mounted — no per-flush O(rows) work; ingest within budget.

**Checkpoint:**
- [ ] Measured 12 MB ingest (list mounted) ≤ baseline +15%; per-commit reconcile bounded by window; windowing-walk probe clear.
- [ ] If the gate fails, hold is retained and #step-5 is re-scoped (documented) — the gate is the falsifiable boundary.

#### Step 6: Integration checkpoint — re-measure vs baseline {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P01], [P02], [P05], [P10] (#success-criteria)

**Tasks:**
- [ ] Re-run the full #step-1 measurement matrix on both corpora.

**Tests:**
- [ ] Large-load mount, replay per-flush work, scroll fps, live-turn-into-long-transcript fps all meet #success-criteria.

**Checkpoint:**
- [ ] Recorded post-virtualization numbers beat (or match within target) the baseline on every metric; any miss is documented with a follow-on.

#### Step 7: TugSheet restore modal (delay-gated, Cancel=stop+close) {#step-7}

**Depends on:** #step-6

**Commit:** `feat(transcript): TugSheet restore modal; retire Restoring banner`

**References:** [P06] Restore sheet, [P07] Reveal gate, [Q03] send-gating (#restore-flow, #p06-restore-sheet)

**Artifacts:**
- `dev-restore-sheet.tsx`: `TugSheet` housing `TugProgressIndicator` (reusing `deriveReplayProgress`/`completeReplayProgress`), Cancel = `cancelDevRestore` + `CLOSE`. Presented only when restore exceeds 1.5 s.
- `DevReplayProgress` banner retired; prompt-entry replay-disabling removed (or replaced by a thin store guard per [Q03]).

**Tasks:**
- [ ] Build `DevRestoreSheet` with the delay-gated present logic (stamp from `getRestoreStartedAt`, threshold 1.5 s).
- [ ] Wire Cancel → stop load + close card.
- [ ] Resolve [Q03]: read the submit path; keep a store-level send guard only if `inert` is insufficient.
- [ ] Remove `DevReplayProgress` usage; keep `deriveReplayProgress` view helpers.

**Tests:**
- [ ] Pure-logic: present/dismiss gate (under vs over 1.5 s); Cancel handler dispatches stop + close.
- [ ] Real-app vet: long restore shows the sheet (card disabled), Cancel stops + closes; short restore shows no sheet.

**Checkpoint:**
- [ ] `bun test` for the sheet gate passes; `bunx tsc --noEmit` clean.
- [ ] Real-app: ≥1.5 s restore → sheet + Cancel works; <1.5 s → no sheet, reveal-once; [Q03] resolved.

#### Step 8: Suppress materialize fade on restore-mount {#step-8}

**Depends on:** #step-7

**Commit:** `fix(dev-card): no materialize fade on restore-mount`

**References:** [P08] Fade gate (#restore-flow)

**Artifacts:**
- The `.dev-card` first-mount fade fires only on fresh picker→body creation; a restore-mount skips it.

**Tasks:**
- [ ] Gate the fade effect on a cold-restore-at-mount signal (skip when restoring).

**Tests:**
- [ ] Real-app vet: hard-refresh reload shows no fade; creating a new card from the picker still fades.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; real-app reload has no card-materialize fade.

#### Step 9: Integration checkpoint — reload/restore UX {#step-9}

**Depends on:** #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P05], [P06], [P07], [P08], [P09] (#success-criteria, #restore-flow)

**Tasks:**
- [ ] Walk the full reload matrix: small session hard-refresh, long session hard-refresh, HMR edit.

**Tests:**
- [ ] Small/fast restore: content reveals once — no blank, no banner, no fade, no flash.
- [ ] Long restore: `TugSheet` progress + Cancel (stop + close) over a disabled card.
- [ ] HMR edit: transcript content does not duplicate, blank, or flash (regression guard on `80c246c6`/`b136123f`/`f93f3775`).

**Checkpoint:**
- [ ] All reload-matrix vets pass; #success-criteria for restore are met.

#### Step 10: (Deferred) DOM recycling — only if measurement demands {#step-10}

**Depends on:** #step-6

**Commit:** `N/A (deferred follow-on)`

**References:** [P04] React cells first (#non-goals)

**Tasks:**
- [ ] If #step-6 shows memo'd windowed cells miss the scroll-fps / large-load targets, scope a recycling-pool follow-on plan. Otherwise close as not-needed.

**Tests:**
- [ ] (Only if pursued) recycling-pool pure-logic + real-app scroll fps.

**Checkpoint:**
- [ ] Decision recorded: recycling pursued (new plan linked) or closed as unnecessary, with the measured justification.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A windowed transcript whose per-flush work is O(viewport) reconcile + O(log N) windowing math, whose finalized rows are built once, whose live turn and selections stay pinned, and whose replay/reload show content without flash (reveal-once < 1.5 s, `TugSheet` modal otherwise) — with the deferred hold, `[DT10]` gate, `DevReplayProgress` banner, prompt-entry replay-disabling, and restore-mount fade all retired.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Mounted cells bounded by viewport+band (+pinned) on any session size (#success-criteria, `perf.mounted_cells`).
- [ ] Per-flush work O(viewport) reconcile + O(log N) windowing math; 12 MB ingest with list mounted within +15% of baseline; deferred hold + `[DT10]` deleted (#step-5, #step-6).
- [ ] Live turn + pending dialog survive scroll-away (pinned); cross-row copy intact (#step-4).
- [ ] Cold reload: <1.5 s reveal-once (no flash) / ≥1.5 s `TugSheet` + Cancel(stop+close); no restore-mount fade (#step-9).
- [ ] No regression in scroll-anchor, inflight→committed seam, per-cell copy/menu, or the prior HMR/streaming/font fixes (#step-9).

**Acceptance tests:**
- [ ] Pure-logic suites: Fenwick-backed `computeWindow` + `append`, id-keyed rich `HeightIndex`, pinned-range derivation, restore-sheet gate.
- [ ] Real-app vets per #step-9 on the real corpora.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] DOM recycling pool (#step-10) if measurement demands.
- [ ] Store-sourced copy reconstruction for huge cross-row selections, if pinning proves too heavy ([Q04]).
- [ ] Cross-reload persistent transcript cache (out of scope here, [P09]).

| Checkpoint | Verification |
|------------|--------------|
| Bounded mount | `perf.mounted_cells` < 60 on a 5,000-turn session |
| Sublinear per-flush | windowing-walk probe clear; 12 MB ingest ≤ baseline +15% |
| Live turn pinned | live dialog survives scroll-away; cross-row copy intact |
| No reload flash | real-app vet: reveal-once <1.5 s / modal ≥1.5 s; no fade |
| No regressions | real-app vet: scroll-anchor, seam, copy/menu, HMR all intact |
