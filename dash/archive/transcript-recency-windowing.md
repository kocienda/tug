<!-- devise-skeleton v4 -->

## Transcript Recency Windowing — Load Recent, Page Older On Demand {#transcript-recency-windowing}

**Purpose:** Bound transcript load cost by session *recency*, not session *size*: resume only the most recent N turns by default, with on-demand "load previous M" (and "load all") paging older turns *above* the current view while holding scroll position — so the most relevant content is always loaded fast, regardless of total session length.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented on `main` — final live/perf vet pending |
| Target branch | `main` (implemented directly; no `tugutil dash` worktree was used) |
| Last updated | 2026-06-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The redux render work ([`transcript-architecture-redux.md`](transcript-architecture-redux.md) `[P07]`, landed `8397b2e3`) bounded the **render** cost via `content-visibility` — WebKit no longer styles off-screen rows, so the synchronous mount of a 212-row session fell ~4.4 s → ~1 s. But it did **nothing** for the **ingest** cost: tugcode still reads and translates the *entire* per-session JSONL, and the reducer still builds *every* turn entry in `CodeSessionStore`. `replay_ingest` is a separate, measured cost (~300 ms–1.1 s for ~200 turns) that grows **unbounded** with session length — for a 10,000-turn session it dominates, and `content-visibility` cannot touch it because the store still holds all 10k turns and tugcode replayed all of them.

Recency-windowing bounds *that*. The observation is the one every serious chat UI relies on: the most relevant content is the most recent. So load the last N turns by default (cheap ingest), render them cheap (`content-visibility`), and page older turns in on demand — above the current view, holding the user's scroll position. The two layers compose into O(viewport) at *both* ingest and render, which is what finally makes req #1 ("any size") true.

#### Strategy {#strategy}

- **Window at the replay source (tugcode), not the render.** The ingest cost lives in `translateJsonlSession` + the IPC frames + the reducer's per-turn build. Slicing to the last N turns saves all of that. Windowing only at the data-source/render layer saves nothing on ingest (already covered by `content-visibility`).
- **Extend the existing request-driven path.** Replay is already `RequestReplay` → `runReplay` → `translateJsonlSession`. Add an optional window spec to that one verb rather than inventing a protocol.
- **Default-load the last N turns; page older backward only.** Recent turns stay mounted forever; "load previous M" (M ∈ {50, 100, all}) pulls older turns in *above* the view. No forward unloading.
- **Prepend with scroll-position hold.** When older turns land above, compensate `scrollTop` by the `scrollHeight` delta so the content the user is looking at stays put — content grows upward, invisibly.
- **Reuse the redux `TugSheet`.** A "load all" (or a deep faithful-restore) that crosses the 0.5 s gate ([`transcript-architecture-redux.md` P08/P09]) shows that sheet with progress + Cancel. Small windowed loads reveal once.
- **Faithful restore.** On reload, load enough older turns to include the saved anchor so pixel-perfect restore (req #4) holds in every case — sheet-gated if it's a deep load.
- **Measure on a real long session.** No claimed win until reproduced on a genuinely long (thousands-of-turns) real JSONL.

#### Success Criteria (Measurable) {#success-criteria}

- **Bounded ingest:** opening a long session (thousands of turns) ingests + mounts only the last N turns — `replay_ingest` ms and `syncMount`/`replay_render` are bounded by N, independent of total turn count (verified via the existing `perf.replay_ingest` / `perf.replay_render` logs on a real long session). (#perf-gate)
- **Held scroll on prepend:** "load previous M" prepends M older turns with the previously-visible content holding its viewport position — the turn the user was looking at stays under the same viewport Y (verified visually + an app-test asserting `scrollTop` compensation within ≤ 2 px). (#prepend-scroll-hold)
- **Load-all feedback:** "load all" on a large session presents the `TugSheet` (when it crosses 0.5 s) with progress + Cancel; Cancel stops the load and leaves the already-loaded window intact and usable. (#load-all-sheet)
- **Faithful restore (req #4):** a reload whose saved anchor is above the default window loads to the anchor and lands pixel-perfect — extends `at0190`. (#faithful-restore)
- **No false holes (req #5):** the "load previous" affordance is present **iff** older turns exist; once loaded, every older turn renders fully — deliberate pagination is not a hole. (#pagination-not-holes)

#### Scope {#scope}

1. **tugcode** — extend `RequestReplay` with an optional window spec; `translateJsonlSession` / `runReplay` translate only the requested turn range (last N, or `[start, end)`); `replay_complete` carries window metadata (`firstLoadedTurnIndex`, `totalTurns` / `hasOlder`).
2. **tugdeck protocol + reducer** — send the window spec; the reducer handles a *windowed* default-load bracket (append, as today) and records `oldestLoadedTurn` / `hasOlder`.
3. **reducer + data source** — a *load-previous* bracket **prepends** older turns above existing rows; `DevTranscriptDataSource` exposes `hasOlder` / `oldestLoadedTurnIndex`.
4. **TugListView** — prepend with scroll-position hold (`scrollHeight`-delta compensation, [L23]).
5. **"Load previous" affordance** at the transcript top (M = 50 / 100 / all); "load all" routed through the redux `TugSheet`.
6. **Faithful restore** — load-to-anchor on reload when the saved anchor is above the default window.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the JSONL/wire protocol beyond the `RequestReplay` window field + the `replay_complete` metadata.
- Forward pagination or unloading recent turns — paging is backward-only; recent content stays mounted.
- Re-deriving the render approach — `content-visibility` + cached heights ([`transcript-architecture-redux.md` P07], landed) already bounds render; this plan is the *ingest* layer.
- A turn-boundary index file or backward-JSONL-parse optimization — v1 may still `JSON.parse` every line but only *translate* the requested tail (the parse-all optimization is a measured follow-on, [#roadmap]).
- Persisting loaded transcript content across a hard refresh — the bag holds no content; reload re-replays the window ([`transcript-architecture.md` P09]).

#### Dependencies / Prerequisites {#dependencies}

- **`transcript-architecture-redux.md` Step 6.1 (TugSheet restore modal) must land first** — "load all" ([#step-5]) and the deep-faithful-restore sheet ([#step-6]) reuse that sheet + its 0.5 s gate.
- `content-visibility` cached-height render ([`transcript-architecture-redux.md` P07]) — already landed (`8397b2e3`); the cached heights make prepend stable.
- The request-driven replay path: `RequestReplay` (`tugproto/src/inbound.ts`) → `Session.runReplay` (`tugcode/src/session.ts`) → `translateJsonlSession` (`tugcode/src/replay.ts`).
- `DevTranscriptDataSource` / `buildRowLayout` (`tugdeck/src/lib/dev-transcript-data-source.ts`); `CodeSessionStore` reducer (`tugdeck/src/lib/code-session-store/reducer.ts`); `TugListView` anchor/`HeightIndex` (`tugdeck/src/components/tugways/tug-list-view.tsx`); the persistent scroll/height bag.
- A **real long session** JSONL (thousands of turns) from the user for the perf gate ([P08]-style real-corpus rule).

#### Constraints {#constraints}

- Tuglaws: **[L02]** (window/`hasOlder` enter React via `useSyncExternalStore`), **[L06]** ("load previous" visibility + prepend are appearance/DOM, not React appearance state), **[L22]** (measured heights flow via `ResizeObserver`/`HeightIndex`), **[L23]** (prepend preserves the user's scroll position — the core obligation here), **[L26]** (stable cell identity across prepend so `content-visibility` remembered sizes + observers survive). Cross-check `tuglaws/tuglaws.md`, `pane-model.md`, `component-authoring.md`; name the laws in each dash commit.
- **tugcode is bun-compiled — no HMR.** Every tugcode change needs a rebuild (`just app-debug`); edits don't take effect until `target/debug/tugcode` is rebuilt. ([[feedback_tugcode_compile]])
- A new client→tugcode message field rides the single inbound verb list (`tugproto/src/inbound.ts` `INBOUND_VERBS` + the `InboundMessage` union); extend `RequestReplay` in place rather than adding a verb. ([[reference_tugcode_inbound_allowlist]])
- No fake-DOM/RTL tests, no mock-store assertion tests (banned). Pure-logic (`bun:test`) + real-app (`just app-test`) only. Perf claims on the user's real long session only.

#### Assumptions {#assumptions}

- Finalized turns are immutable (the reducer never mutates a committed turn), so an older turn translated once is stable for the session's life.
- "Recent is most relevant" — the user works near the bottom, so the common reload lands within the default window and pays no extra load.
- Turn boundaries are derivable from the parsed entries: `translateJsonlSession` already counts committed turns for `replay_complete.count`, so the same boundary logic locates "the last N turns."
- `RequestReplay` carries no payload today (`{ type: "request_replay" }`), so adding an optional `window` field is backward-compatible (absent ⇒ load-all, current behavior).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit, kebab-case, no phase numbers. Plan-local decisions use `[P01]`…; global decisions (`design-decisions.md`) are cited by `[D##]`. Cross-plan citations name the other plan file + its label (e.g. `transcript-architecture-redux.md P08`).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Window unit + defaults (DECIDED) {#q01-window-defaults}

**Question:** Is the window counted in turns or rows, and what are N (default) and the M options?

**Resolution:** **DECIDED — turns.** A turn is the natural unit (user + assistant; wake turns are a single row). Default **N = 50 turns**; "load previous" offers **M ∈ {50, 100, all}** (user-specified). Both live as named constants so they're tunable. Sessions with ≤ N turns load whole and show no "load previous" affordance.

#### [Q02] Where tugcode performs the slice (DEFER to #step-1 spike) {#q02-slice-mechanism}

**Question:** Slice inside `translateJsonlSession` (a `window` option that computes the start index by walking `parsedEntries` and counting turn boundaries) vs. in `runReplay` before calling the translator?

**Why it matters:** The translator already tracks turn commits; duplicating boundary logic in `runReplay` risks edge-case drift (continuation entries sharing a `message.id`, orphan synthesis).

**Plan to resolve:** Spike in #step-1 — prefer a `window` option *inside* `translateJsonlSession` so turn-boundary detection stays with the code that already owns it (`replay_complete.count`). The translator still `JSON.parse`s all lines (cheap relative to translate); it just begins *emitting* at the windowed start index.

**Resolution:** OPEN → DECIDED in #step-1 (preference: translator-internal window option).

#### [Q03] Reducer representation of prepended older turns (DEFER to #step-3) {#q03-prepend-representation}

**Question:** Prepend older turns into the same `turns` array (re-index everything) vs. hold a separate "older" segment the data source concatenates?

**Why it matters:** Prepending re-indexes rows, which interacts with the **height/anchor cache keying**. The redux render keys cached heights by **index** (`meta.cellHeights[index]`, `[P07]`); a prepend shifts every index and would misalign the cache → scroll jump.

**Plan to resolve:** #step-3 — resolve toward **stable-id-keyed** heights (`DevTranscriptDataSource.idForIndex` already mints `${turnKey}-…`), so a prepend never invalidates a cached height. This is the same lesson the superseded `transcript-architecture.md` `[Q01]` reached. Capture as [P06].

**Resolution:** OPEN → DECIDED in #step-3 (preference: stable-id height keying; prepend representation chosen to keep ids stable).

#### [Q04] "Load all" on a whale — one-shot vs chunked (DEFER to #step-5) {#q04-load-all-shape}

**Question:** If "all" is enormous (tens of thousands of turns), do we translate it one-shot behind the sheet, or chunk it (page repeatedly) so the UI stays responsive and Cancel is granular?

**Plan to resolve:** #step-5 — v1 is **one-shot behind the `TugSheet` with Cancel**; the translator's existing time-slice yield ([`replay.ts` `timeSliceMs`]) already keeps IPC responsive. If a real whale makes one-shot "all" unacceptable, chunked paging is a follow-on ([#roadmap]).

**Resolution:** OPEN → DECIDED in #step-5 (one-shot + Cancel for v1).

#### [Q05] How `TugControlBar` engages card modality (DEFER to #step-5-5 spike) {#q05-control-bar-modality}

**Question:** `TugControlBar` ([P09]/[P10]) must inert + scrim the transcript region while keeping the bar itself above the scrim and interactive — a *top-anchored* modal, unlike `TugSheet`'s centered presentation. Does it (a) reuse `useTugSheet`'s pane-inert mechanism somehow, (b) extract a lower-level `usePaneModality()` / pane-inert primitive that both `TugSheet` and `TugControlBar` consume, or (c) implement its own inert+scrim against the card content region?

**Why it matters:** `TugSheet` couples modality (pane inert + scrim) to its centered overlay presentation. `TugControlBar` needs the modality without the centered overlay (its content lives in `Z0`). Forcing it through `showSheet` would mis-position the content; hand-rolling a second inert+scrim risks drift from the sheet's behavior (focus trap, responder-chain interaction, `cascadeTargetId`).

**Plan to resolve:** Spike in #step-5-5 — inspect `tug-sheet.tsx` for where it sets the pane `inert` + scrim, and prefer **(b)**: lift that into a small `usePaneModality()` (or equivalent) primitive the sheet keeps using and the bar also consumes, so both share one tested modality path. Fall back to (c) only if extraction is disproportionate. Cross-check the responder chain / `cascadeTargetId` interaction.

**Resolution (spiked 2026-06-15 — `tug-sheet.tsx`, `use-tug-pane-scrim.ts`):** `TugSheet`'s modality is two already-separated pieces — **scrim** via `useTugPaneScrim()` (a clean standalone hook: ref-counted `{ show, hide }` → the pane's `data-scrim` attribute, [L06]/[L24]) and **inert** via a ~12-line inline `useLayoutEffect` in `tug-sheet.tsx` that toggles `inert` on `.tug-pane-body`. Both are **whole-pane** — they would scrim/inert the `Z0` bar itself, which must stay interactive. So neither is reused wholesale. Decision:
- **Inert** → extract the inline effect into a tiny generic `usePaneInert(target, active)` hook; **refactor `TugSheet` to consume it** (target `.tug-pane-body`), and `TugControlBar` consumes it targeting the **transcript region** (a sibling element *below* the bar — `TugListView`'s wrapper), so the bar is never inerted.
- **Scrim** → `TugControlBar` owns a **region-local scrim** over the transcript region (DOM attribute + CSS, [L06]; borrow the pane-scrim/`Z2` tokens), **not** the whole-pane `useTugPaneScrim` (which would cover the bar). The pane-level scrim hook is left for `TugSheet`.
This is option (b) for inert (one shared, tested toggle) + a region-scoped scrim — small extraction, no responder-chain entanglement (the bar's Cancel/Load buttons dispatch as ordinary controls; modality is pure DOM inert+scrim on the region). Captured into #step-5-5 artifacts.

**Resolution:** OPEN → **DECIDED in #step-5-5 (spiked):** extract `usePaneInert(target, active)` (shared with `TugSheet`); region-local scrim owned by the bar; modal scoped to the transcript region, not the whole pane.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Prepend causes a scroll jump (the central UX risk) | high | med | `scrollHeight`-delta `scrollTop` compensation ([P03]) + cached heights ([P06]/redux P07) for older rows | Any visible jump on "load previous" in #step-4 vet |
| Index-keyed height/anchor cache breaks on prepend | high | high (if [Q03] skipped) | Stable-id height keying ([P06]) | Cache miss / shift after a prepend |
| tugcode turn-boundary slice drops/dupes a turn at the window edge | high | med | Reuse the translator's turn tracking; pure-logic slice tests incl. continuation + orphan cases ([Q02]) | Window edge shows a partial/duplicate turn in #step-1 |
| Faithful restore loads a lot (scrolled-way-up reload) | med | low | Sheet + Cancel; bounded by the user's own prior scroll depth ([P05]) | Deep restore feels unbounded in #step-6 |
| Live/streaming turn interaction | med | low | The live turn is always the most-recent (bottom) → always in the default window; paging only touches older turns | Stream flickers when paging older |

**Risk R01: Prepend scroll-jump** {#r01-prepend-jump}
- **Risk:** Inserting M turns above the viewport shifts `scrollHeight`; the browser keeps `scrollTop`, so the content visually jumps up by the inserted height.
- **Mitigation:** Capture `scrollHeight` immediately before the prepend commit; after it lands, set `scrollTop += (newScrollHeight − oldScrollHeight)` so the viewed content holds. Cached heights ([P06]) + `content-visibility` intrinsic-size make the inserted block's height known on the first commit; a never-seen older turn uses the estimate for one frame, which the delta compensation absorbs.
- **Residual risk:** Sub-pixel rounding across many inserted rows; bounded and within the ≤ 2 px restore tolerance already used by `at0190`.

**Risk R02: Cross-plan ordering** {#r02-cross-plan-order}
- **Risk:** "Load all" / deep-restore need the redux `TugSheet` (redux Step 6.1) which may not be merged when this plan starts.
- **Mitigation:** Sequence — implement redux Steps 6 → 6.1 → 6.2 → 7 first ([#dependencies]); this plan's #step-5/#step-6 hard-depend on the sheet.

---

### Design Decisions {#design-decisions}

#### [P01] Window at the replay source (tugcode) {#p01-window-at-source}

**Decision:** Recency-windowing happens in `translateJsonlSession` / `runReplay` — tugcode translates only the requested turn range. The render layer is *not* the windowing point (it's already bounded by `content-visibility`).

**Rationale:** The ingest cost (translate + IPC frames + reducer per-turn build) is what grows with session length; only slicing at the source removes it. Windowing the data source while replaying everything saves nothing on ingest.

**Implications:** `RequestReplay` gains an optional `window`; `replay_complete` gains window metadata; the reducer learns "this bracket is a window, here's the oldest turn and whether older exists."

#### [P02] Default last N turns; backward-only paging {#p02-backward-paging}

**Decision:** Default load = the most recent N turns (N = 50). Older turns are pulled in only by an explicit "load previous M" (M ∈ {50, 100, all}). Recent turns never unload.

**Rationale:** Recent is most relevant and is what the user lands on; bounding the default load is the whole win. Forward unloading would add complexity for no benefit (recent content is cheap to keep under `content-visibility`).

**Implications:** A "load previous" affordance at the transcript top, shown iff older turns exist; the live/streaming turn is always in-window.

#### [P03] Page older turns by prepend with scroll-position hold {#p03-prepend-hold}

**Decision:** "Load previous" prepends older turns *above* the current rows; `TugListView` compensates `scrollTop` by the `scrollHeight` delta so the previously-visible content holds its viewport position. Content grows upward; the user's reading position does not move.

**Rationale:** The product idea — "the most relevant content is always right there." Prepend-with-hold is the only behavior that keeps the recent content put while older content appears above.

**Implications:** A new prepend path in `TugListView` (capture `scrollHeight` pre-commit, adjust `scrollTop` post-commit); pairs with [P06] stable heights so the delta is exact.

#### [P04] Reuse the redux TugSheet + 0.5 s gate for slow loads {#p04-reuse-sheet}

**Decision:** A "load all" or a deep faithful-restore that crosses the 0.5 s gate presents the redux `TugSheet` ([`transcript-architecture-redux.md` P08/P09]) with progress + Cancel. Small windowed loads (the default and small "load previous M") reveal once with no sheet.

**Rationale:** Don't build a second progress surface; the sheet + gate already exist for exactly "a load that takes long enough to warrant feedback + Cancel."

**Implications:** Hard dependency on redux Step 6.1; Cancel on a "load previous"/"load all" stops the in-flight translate and leaves the already-loaded window intact (distinct from restore-Cancel, which closes the card).

#### [P05] Faithful restore — load to the saved anchor {#p05-faithful-restore}

**Decision:** On Developer ▸ Reload, if the saved anchor is above the default window, load enough older turns to include it, then restore to it exactly. Restore never lands at the window edge when the user was parked deeper.

**Rationale:** req #4 (pixel-perfect restore) is a hard requirement (user decision). The common case — reloaded near the bottom — is within the default window and pays nothing; only a reload-while-parked-on-old-content loads more, bounded by the user's own prior scroll depth, sheet-gated if slow.

**Implications:** Restore computes the needed window from the saved anchor's turn index; the windowed replay request carries that depth.

#### [P06] Stable-id-keyed heights/anchors (prepend-safe) {#p06-stable-id-heights}

**Decision:** Cached cell heights and the restore anchor key off the stable row id (`idForIndex` → `${turnKey}-…`), not the flat index, so a prepend (which shifts every index) never invalidates a cached height or mis-resolves the anchor.

**Rationale:** The redux render keys `meta.cellHeights` by index; under prepend that breaks. Id-keying is the same conclusion the superseded `transcript-architecture.md` `[Q01]` reached, now load-bearing because prepend is real here.

**Implications:** Thread the stable id into the height cache + the `content-visibility` `contain-intrinsic-size` seed ([`transcript-architecture-redux.md` P07]); the bag's `cellHeights` migrate from index-keyed to id-keyed (or carry both).

**Reconciliation (implemented 2026-06-15 — diverged from the above, deliberately).** The shipped code does **not** id-key heights. Two separate concerns were split:
- **Mount identity across prepend** — handled by **[L26]** instead: the cell wrapper's React `key` is `idForIndex(i)` (a stable `turnKey`-derived id), so a prepend never remounts a row (scroll, observers, `content-visibility` remembered sizes survive). This is the load-bearing guarantee [P06] was reaching for, and it holds.
- **The height *cache*** (`HeightIndex`) stays **index-keyed** with an explicit `shift(by)` remap applied on each prepend — in-session this re-aligns measured heights exactly, so the live prepend is correct.
- **Persisted `cellHeights`** stay **index-keyed and are capped/dropped** (`capDurableCardState`, cap 400) — *intentionally*: carrying heights in the bag is what caused the boot-stall bloat (`948a2721`), so the bag deliberately holds at most a bounded slice. Consequence: a reload whose window differs from the save-time window (the deep paged-reload case) hydrates misaligned (or absent) heights, so first paint uses estimates and the anchor *converges* via `ResizeObserver` re-measure rather than landing pixel-perfect on the first frame. Accepted as a v1 limitation — the common case (default window, no paging) aligns and is first-paint-perfect; the deep case still lands correctly, just with a brief settle. Id-keyed bag heights are an explicitly-declined option (the bloat lesson outweighs first-paint perfection for the uncommon deep reload).

#### [P07] Deliberate pagination is not a missing message (req #5 clarification) {#p07-pagination-not-holes}

**Decision:** Older turns absent because they haven't been paged in are **not** "holes" / "missing messages." req #5 forbids *render bugs* (an unrendered loaded row, an estimate-driven scrollbar); it does not forbid intentional backward pagination behind a visible affordance. Once loaded, every older turn renders fully.

**Rationale:** Keeps this plan consistent with the redux req #5 decisions rather than appearing to contradict them.

**Implications:** The "load previous" control is the explicit signal that older content exists; the scrollbar reflects only loaded content (honest), and grows by real heights as older turns prepend.

#### [P09] One Z0 `TugControlBar` for every load surface; modal during load, released after {#p09-control-bar}

**Decision (user, 2026-06-15):** Replace the three load surfaces — the centered restore sheet ([`transcript-architecture-redux.md` P08/P09]), the load-previous sheet ([P08] above), and the top-of-transcript load-previous bar (#step-5) — with **one** component anchored in zone **`Z0`** ([D97]): a `TugControlBar`. It occupies the reserved `Z0` slot above the scrollable transcript and carries, over its lifetime, three pieces of content: the **load prompt** ("There are N earlier messages in this session. Load: [50] [All]"), the **load progress** indicator (determinate "N of M"), and — superseding the centered restore sheet — the **initial session-load** progress. It can put the card into a **modal** state (inert + scrim over the transcript region, the `TugControlBar` itself staying above the scrim and interactive) and **release** it.

The lifecycle is a small state machine:
- **Loading** (a cold restore *or* a load-previous in flight) → the bar shows determinate progress and the card is **modal** for the duration (so the prepend + scroll-hold land against a quiescent viewport — [P03]/[P08] rationale, now expressed as bar modality rather than a sheet).
- The instant the load lands, modality **releases**. After a *load-previous*, the bar **lingers** (non-modal) showing the prompt again iff older turns still remain, until the next **scroll-to-bottom or submit** dismisses it (lets the user page again without scrolling back to the top). A cold restore lands at the bottom, so its dismiss condition is already met → the bar hides.
- **Prompt** (idle) → outside a load/linger, the prompt shows iff `hasOlder` **and** the user has scrolled to the top (the #step-5 scroll-to-top reveal), and hides otherwise. Non-modal.

**Rationale:** The user's notes — one surface, not three; the modal lock is a property of that surface, toggled per phase; the bar's home is exactly `Z0`, the zone [D97] already named "what you see first." Folding the initial-load indicator in too removes the centered-sheet/​bar split and the flashing it caused.

**Implications:** `Z0` (`TideCard.headerContent`) becomes the single load surface; `DevRestoreSheetHost` (centered restore sheet) is **retired** ([P11]); the [P08] gated-presentation/anti-flash behavior is reframed as "bar visible per the state machine, modal only while Loading." Visual treatment borrows the `Z2` status-bar tokens (#step-5-5 spec). The `data-replaying` blank-and-reveal gate stays suppressed during a load-previous and is reconsidered for cold restore now that the bar (not a full blank) carries the progress.

#### [P10] `TugControlBar` is a generic Z0 host; the card supplies content {#p10-generic-control-bar}

**Decision (user, 2026-06-15):** `TugControlBar` is a **reusable tugways component** — the modal-capable `Z0` bar shell (layout, `Z2`-borrowed styling, the inert+scrim modality toggle, the above-scrim positioning) — and the **card supplies the content** (the dev transcript passes its prompt/progress nodes + the modal flag). It is not dev-transcript-specific; a future `Z0` control bar reuses the shell.

**Rationale:** It lives in `Z0`, generic card chrome ([D97]); naming it `TugControlBar` (tugways prefix) signals a primitive. Separating the shell (generic) from the content (card-specific) keeps the modality/positioning logic in one reusable place.

**Implications:** New `components/tugways/tug-control-bar.tsx` (+ `.css`) — the shell. The dev transcript owns a `DevLoadControlBarContent` (or similar) that computes the state-machine content from the `CodeSessionStore` snapshot and feeds it to `TugControlBar`. The modality mechanism it engages is [Q05].

#### [P11] Retire the centered restore sheet; the Z0 bar is the only load surface {#p11-retire-restore-sheet}

**Decision (user, 2026-06-15):** With [P09], the initial cold-restore progress renders in the `Z0` `TugControlBar` (modal during the restore), so `DevRestoreSheetHost` / `DevRestoreSheetContent` (the centered `TugSheet` restore modal from `transcript-architecture-redux.md` Step 6.1) is **retired**, and the load-previous `TugSheet` from #step-5 is **subsumed** into the bar. One surface for every load.

**Rationale:** Two surfaces (centered sheet for cold restore, bar for load-previous) is the split the user is removing; it also caused the load↔reveal flashing. The restore sheet's progress/Cancel semantics carry over into the bar's Loading state.

**Implications:** Remove `DevRestoreSheetHost` from the transcript; migrate its delay-gated progress + Cancel semantics into the bar's Loading state. The redux `TugSheet` primitive itself stays (other callers); only the *restore-sheet host* is retired. Cancel during a cold restore keeps its current meaning (stop + close the card — distinct from load-previous Cancel, which aborts + keeps the window); the bar routes Cancel by which load is active.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Requested window spec (last N / range) | local-data (request) | built in the resume/load-previous request path; sent over IPC | [L02] |
| `oldestLoadedTurn` / `hasOlder` | structure (external) | from `replay_complete` metadata into `CodeSessionStore`; enters React via `useSyncExternalStore` | [L02] |
| "Load previous" affordance visibility | appearance (derived) | derived from `hasOlder`; rendered at transcript top, no React appearance state | [L06] |
| Prepend scroll compensation | local-data (DOM authority) | capture `scrollHeight` pre-commit, adjust `scrollTop` post-commit in `TugListView` | [L23] |
| Id-keyed cell heights | local-data (derived) | `HeightIndex` / bag keyed by `idForIndex`; written from `ResizeObserver`, read for `contain-intrinsic-size` | [L22], [L06] |
| Load sheet presented (load-all / deep restore) | structure | reuse redux `TugSheet` mapping ([`transcript-architecture-redux.md` P08/P09]) | [L02] |
| Stable cell identity across prepend | structure | same wrapper id across re-index so observers / remembered sizes survive | [L26] |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|----------|---------|------|
| **Pure-logic** (`bun:test`) | tugcode turn-boundary slice (last N; range; continuation + orphan edges); reducer prepend/re-index; id-keyed height resolution across a prepend; "load previous" affordance derivation from `hasOlder` | #step-1, #step-2, #step-3, #step-5 |
| **Real-app** (`just app-test`) | prepend scroll-hold (no jump); faithful restore to an above-window anchor; load-all sheet + Cancel | #step-4, #step-5, #step-6 |
| **Perf measurement** | `replay_ingest` / `replay_render` bounded by N on a real long session, independent of total turns | #step-1, #step-7 |

**Out of tests:** no fake-DOM/RTL (banned, happy-dom deleted); no mock-store assertion tests (exercise the real reducer/replay on real JSONL); no synthetic long-session fixtures for the perf gate — use the user's real long session ([[feedback_real_content_fixtures]]).

---

### Execution Steps {#execution-steps}

> Work on a `tugutil dash` worktree (absolute paths into the worktree); commit each step via `tugutil dash commit`; the user joins to `main`. **tugcode is compiled — rebuild (`just app-debug`) after every tugcode change; no HMR.** Redux Steps 6 → 6.1 → 6.2 must be merged before #step-5/#step-6.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | tugcode: window the replay (RequestReplay window + sliced translate + metadata) | done | 84c139ea |
| #step-2 | tugdeck: send window spec; reducer records oldestLoadedTurn/hasOlder | done | 88dc2365 |
| #step-3 | Reducer + data source: prepend older turns; stable-id height keying | done | da32e558 (height-cache id-keying folded into #step-4) |
| #step-4 | TugListView: prepend with scroll-position hold | done | (committed below; live scroll-hold verified end-to-end with #step-5 trigger) |
| #step-5 | "Load previous M" affordance + "load all" via TugSheet | done | on main (live vet pending) |
| #step-5-5 | TugControlBar in Z0 — unify load prompt + progress + initial-load indicator | done | on main (live vet pending) |
| #step-6 | Faithful restore — load-to-anchor on reload | done | on main (live vet pending) |
| #step-7 | Integration checkpoint — long-session load/paging/restore on real sessions | automated green; live perf/feel = user vet | on main |

#### Step 1: tugcode — window the replay {#step-1}

**Commit:** `tugcode: window replay to last-N / turn-range; emit window metadata`

**References:** [P01] Window at source, [Q01] Defaults, [Q02] Slice mechanism, (#perf-gate), [[feedback_tugcode_compile]], [[reference_tugcode_inbound_allowlist]]

**Artifacts:**
- `RequestReplay` (`tugproto/src/inbound.ts`) gains an optional `window?: { lastTurns: number } | { turnRange: [number, number] }` (absent ⇒ load-all, unchanged).
- `translateJsonlSession` (`tugcode/src/replay.ts`) accepts a `window` option, computes the start index by counting turn boundaries (reusing its turn-commit tracking), and emits only the windowed turns between `replay_started` / `replay_complete`.
- `replay_complete` carries `firstLoadedTurnIndex`, `totalTurns`, `hasOlder`.
- `runReplay` (`tugcode/src/session.ts`) threads the request's window into the translator.

**Tasks:**
- [ ] Add the `window` field to `RequestReplay` (in place on the existing verb — no new verb); update the `InboundMessage` union / guards consumers as needed.
- [ ] Add the `window` option + boundary-walk to `translateJsonlSession`; add window metadata to `replay_complete`. Resolve [Q02] (prefer translator-internal).
- [ ] Thread the window from `runReplay` into the translator.
- [ ] Rebuild tugcode (`just app-debug`); confirm a windowed request emits only the last N turns + correct metadata.

**Tests:**
- [ ] Pure-logic (`bun:test`, `tugcode`): last-N slice; explicit range; window larger than the session (= load-all); continuation entries sharing a `message.id` and orphan-synthesis turns land on the correct side of the window edge (no partial/duplicate turn).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` n/a; tugcode `bun test` green; `bunx tsc --noEmit` (tugcode) clean.
- [ ] A windowed `request_replay` on a real long session emits exactly the last N turns with correct `firstLoadedTurnIndex` / `hasOlder`; `replay_ingest` bounded by N (not total turns).

#### Step 2: tugdeck — send window spec; record window metadata {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck: send replay window; store oldestLoadedTurn/hasOlder`

**References:** [P01] Window at source, [P02] Backward paging, (#state-zone-mapping)

**Artifacts:**
- The resume/replay request path (`tugdeck/src/protocol.ts` + the store's replay request) sends `window: { lastTurns: N }` by default.
- `CodeSessionStore` records `oldestLoadedTurn` / `hasOlder` from `replay_complete`; both reachable via the snapshot ([L02]).

**Tasks:**
- [ ] Build + send the default window (`lastTurns: N`) on cold resume.
- [ ] Parse window metadata in the reducer's `replay_complete` path; expose `hasOlder` / `oldestLoadedTurnIndex` on the snapshot.
- [ ] Confirm a ≤ N-turn session reports `hasOlder: false` (loads whole, no affordance).

**Tests:**
- [ ] Pure-logic: reducer records window metadata; `hasOlder` derivation for `< N`, `= N`, `> N` total turns.

**Checkpoint:**
- [ ] `bun test` reducer suite green; `bunx tsc --noEmit` clean.
- [ ] A real long session resumes showing only the last N turns; the snapshot reports `hasOlder: true` with the correct oldest index.

#### Step 3: Reducer + data source — prepend older turns; stable-id heights {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck: prepend older turns on load-previous; id-keyed heights`

**References:** [P02] Backward paging, [P06] Stable-id heights, [Q03] Prepend representation, (#r01-prepend-jump)

**Artifacts:**
- A *load-previous* replay bracket (window = the older range) whose turns the reducer **prepends** ahead of existing turns; `DevTranscriptDataSource` exposes `oldestLoadedTurnIndex` / `hasOlder` and lays out prepended turns in order.
- Cell heights + the restore anchor key off `idForIndex` (stable `turnKey`-derived id), so a prepend doesn't invalidate them ([P06]); the `content-visibility` `contain-intrinsic-size` seed reads the id-keyed height.

**Tasks:**
- [ ] Add a prepend path: the reducer distinguishes a default/append bracket from a load-previous/prepend bracket (a flag on the request echoed in `replay_complete`, or inferred from `firstLoadedTurnIndex < oldestLoadedTurn`).
- [ ] Resolve [Q03]: choose the representation that keeps stable ids; migrate `cellHeights` keying from index to `idForIndex` (carry both if a migration window is needed).
- [ ] Update `buildRowLayout` / `numberOfItems` / `idForIndex` for the prepended range.

**Tests:**
- [ ] Pure-logic: prepending older turns preserves the stable ids of existing rows; an id-keyed height survives an index shift; `buildRowLayout` orders prepended-then-existing correctly.

**Checkpoint:**
- [ ] `bun test` green; `bunx tsc --noEmit` clean.
- [ ] A simulated load-previous bracket prepends turns with existing rows' ids unchanged and their cached heights intact.

#### Step 4: TugListView — prepend with scroll-position hold {#step-4}

**Depends on:** #step-3

**Commit:** `tug-list-view: hold scroll position across prepend`

**References:** [P03] Prepend-hold, [P06] Stable-id heights, (#prepend-scroll-hold, #r01-prepend-jump), `tuglaws/tuglaws.md` [L23]

**Artifacts:**
- `TugListView` detects a prepend (the item count grew at the *front*, oldest id changed) and compensates: capture `scrollHeight` before the prepend commit, set `scrollTop += (newScrollHeight − oldScrollHeight)` after, so the previously-visible content holds its viewport Y. Works under `inline` + `content-visibility`.

**Tasks:**
- [ ] Detect a front-insert (vs the normal bottom-append) from the data-source delta.
- [ ] Implement the `scrollHeight`-delta `scrollTop` compensation in the appropriate layout effect ([L03]/[L23]); ensure it composes with the `content-visibility` intrinsic-size of the inserted rows (cached heights make the delta exact on the first commit).
- [ ] Cross-check tuglaws and name them in the commit: **L23** (scroll preserved across a DOM-down/grow transition), **L06** (the `scrollTop` write is DOM, not React state), **L26** (existing rows keep identity).

**Tests:**
- [ ] Pure-logic: the compensation math (old/new `scrollHeight` → `scrollTop` delta).
- [ ] Real-app (`just app-test`): a save→load-previous sequence on the real long fixture asserts the anchored row holds its viewport Y within ≤ 2 px after the prepend (no jump).

**Checkpoint:**
- [ ] `bun test` + `bunx tsc --noEmit` clean.
- [ ] Live + app-test: "load previous" grows content upward with zero visible jump.

#### Step 5: "Load previous M" affordance + "load all" via TugSheet {#step-5}

**Depends on:** #step-4, **transcript-architecture-redux.md #step-6-1 (TugSheet)**

**Commit:** `transcript: load-previous affordance (50/100/all); load-all sheet`

**References:** [P02] Backward paging, [P04] Reuse sheet, [Q04] Load-all shape, (#load-all-sheet), [[feedback_use_tug_components]]

**Artifacts:**
- A "load previous" control at the transcript top, shown iff `hasOlder`, offering **50 / 100 / all** (reuse an existing Tug control — `TugChoiceGroup` / menu — not a hand-rolled one).
- 50/100 → a load-previous windowed request ([#step-3]/[#step-4]); **all** → a full older-range request that, if it crosses 0.5 s, presents the redux `TugSheet` with progress + Cancel. Cancel stops the in-flight translate and **leaves the already-loaded window intact** (distinct from restore-Cancel's close-card).

**[P08] Load-previous sheet is gated by the 0.5 s reveal threshold (user decisions, 2026-06-14 / refined 2026-06-15).** {#p08-sheet-on-interaction}
The load-previous modal `TugSheet` presents **only if the load is still in flight past the 0.5 s reveal gate** (the same constant the restore sheet uses). A *fast* page-in — the common 50 / "all"-when-small case — settles before the gate and pages in **silently**: older turns prepend above with held scroll ([P03], #step-4) and no modal ever shows. A *slow* load ("all" on a whale) crosses the gate and presents the sheet with **determinate** "N of M messages" progress + Cancel; the inert scrim then locks the pane for the rest of the load, so the remaining prepend lands against a quiescent viewport.

*Refinement note:* the original 2026-06-14 decision presented the sheet *immediately* (inert at once, chrome gated). Live testing showed that flashed a scrim for fast loads, so the presentation itself is now gated — fast loads have no sheet at all. The blank-and-reveal gate ([DT10]) and the restore sheet are both suppressed during a load-previous (the existing content must stay visible while older turns prepend above it). Restore-side small loads still follow [P04].

**Tasks:**
- [x] Render the affordance from `hasOlder`; wire 50/100/all to load-previous requests. (`dev-load-previous.tsx` top-of-transcript bar; `store.loadPrevious(amount)` → `olderMessages` window.)
- [x] On activation, immediately present the `TugSheet` (pane inert + scrim) for the load duration ([P08]); dismiss when the load completes (`loadingPrevious` clears). Progress + Cancel chrome gated past 0.5 s. Cancel = real tugcode abort (`cancel_replay` → `replay_complete{aborted}` → `discard-prepend`), keeping the loaded window. Resolved [Q04] (one-shot + real abort for v1).
- [x] Dispatch `store.beginLoadPreviousBracket()` immediately before sending the older-range `request_replay` (inside `store.loadPrevious`).
- [x] Cross-check tuglaws (L02 `hasOlder`/`loadingPrevious` via `useSyncExternalStore`; L06 pane disabled by sheet inert/scrim, affordance visibility derived; L23 prepend scroll-hold; L13 progress motion).

**Tests:**
- [x] Pure-logic: affordance derivation (`hasOlder`); option → request-range mapping + `all`=all-older + no-op when `!hasOlder` (`load-previous.test.ts`); abort discards staged batch (`replay-prepend.test.ts`); tugcode `olderMessages` resolution + `cancel_replay` abort (`replay-window.test.ts` / `replay-spawn.test.ts`).
- [ ] Real-app: "all" on the real long session shows the sheet + Cancel; Cancel leaves the prior window usable; 50/100 page in. *(pairs with live vet on the rebuilt instance — modal + abort timing best confirmed live; a `just app-test` fixture is the follow-on.)*

**Checkpoint:**
- [x] `bun test` (tugdeck 3682 / tugcode 585) + `bunx tsc --noEmit` clean.
- [ ] Live: 50/100 page in (held scroll); "all" on a whale shows the sheet + working Cancel. *(user vet on the rebuilt instance.)*

#### Step 5.5: TugControlBar in Z0 — unify load prompt + progress + initial-load indicator {#step-5-5}

**Depends on:** #step-5

**Commit:** `tugways: TugControlBar in Z0; unify transcript load surfaces`

**References:** [P09] One Z0 control bar, [P10] Generic Z0 host, [P11] Retire restore sheet, [Q05] Modality mechanism, [D97] zone Z0, `transcript-architecture-redux.md` Step 6.1 (restore sheet being retired), [[feedback_use_tug_components]]

**Context.** Today three surfaces carry "a load is happening / older content exists": the centered restore sheet (cold load), the load-previous sheet (#step-5), and the top-of-transcript load-previous bar (#step-5). The user wants **one** surface in `Z0` — a `TugControlBar` — that does all three and can lock/release the card. Live testing of #step-5 also showed the centered-sheet ↔ bar split is the flashing source ([P08] refinement); folding everything into one Z0 bar removes it.

**Artifacts:**
- **`components/tugways/tug-control-bar.tsx` (+ `.css`)** — a generic, modal-capable Z0 bar shell ([P10]): renders supplied content in a bar anchored above the card's scrollable region, borrows `Z2` status-bar tokens for its visual treatment (a distinct band, not transcript-colored — see image ref). Takes the content node, a `modal` flag, and a ref to the **transcript region element** it inerts+scrims when modal. The bar itself is never inerted (it is a sibling *above* that region).
- **`usePaneInert(target, active)`** — extract `TugSheet`'s inline inert effect into this shared hook ([Q05] resolution); **refactor `TugSheet` to consume it** (target `.tug-pane-body`). `TugControlBar` consumes it on the transcript region.
- **Region-local scrim** — the bar owns a scrim element over the transcript region (DOM attribute + CSS, [L06]; pane-scrim/`Z2` tokens), *not* the whole-pane `useTugPaneScrim`. A `region` wrapper around `TugListView` is the inert+scrim target (sibling below the bar).
- **Dev-transcript content + state machine** — a `DevLoadControlBarContent` that derives the bar's state from the `CodeSessionStore` snapshot and feeds `TugControlBar`:
  - **Loading** — `phase === "replaying"` (cold restore) **or** `loadingPrevious` (load-previous) → determinate "N of M" progress (restore: existing restore progress; load-previous: `loadingPreviousLoaded`/`Target` from #step-5) + Cancel; **card modal**.
  - **Lingering** (post load-previous) — on load-previous completion, release modal; keep the bar showing the prompt iff `hasOlder`, until **scroll-to-bottom or submit**.
  - **Prompt** (idle) — `hasOlder && atTop && !loading && !lingering` → "There are N earlier messages in this session. Load: [N] [All]" (the #step-5 affordance, capped to remaining, `size="sm"`); non-modal.
  - **Hidden** — otherwise.
- **Visibility** is DOM-driven ([L06]) — the host toggles the bar's state attribute off the store snapshot + the list view's `onAtTopChange` / `onFollowBottomChange` (scroll-to-bottom) + submit signals; never React appearance state.

  **L06 reconciliation (audited + fixed 2026-06-15).** An interim rework (the dwell + trim) briefly routed the bar's mode/visibility through `useState`, which an audit flagged as an [L06] transgression. Restored to the intended shape: the host holds the dwell + prompt-summon flags in **refs**, observes the store **directly** in a `useLayoutEffect` ([L22]), and writes the resolved mode onto `data-visible` + `data-mode` (DOM); both content slots are always mounted and self-subscribe for their data ([L02]); the dev CSS reveals one per `data-mode`. The only React-bound value is `loadActive` (session *data*, [L02]) driving the `modal` prop. No appearance state lives in React.
- **Retire `DevRestoreSheetHost` / `DevRestoreSheetContent`** ([P11]); migrate its delay-gated progress + Cancel (stop + close card) into the bar's Loading state for the cold-restore case. The load-previous `TugSheet` from #step-5 is removed in favor of the bar.

**Tasks:**
- [x] Spike [Q05] (resolved 2026-06-15 — extract `usePaneInert`, region-local scrim; see [Q05]).
- [x] Extract `usePaneInert(target, active)` (`use-pane-inert.ts`); refactored `TugSheet` to consume it (behavior-neutral — its restore/sheet tests still green). Built `TugControlBar` (`tug-control-bar.tsx` + `.css`) — generic shell, `usePaneInert` + region scrim (`data-tug-control-bar-modal`), Z2-borrowed band tokens, `data-visible` DOM visibility ([L06]/[L03]/[L20]/[L26]).
- [x] Built the dev state machine (`dev-load-control-bar-state.ts`, pure) + content (`dev-load-control-bar.tsx`): Loading/Prompt/Hidden, lingering tracker; wired `onAtTopChange` (prompt reveal) + `onFollowBottomChange` (at-bottom dismiss) + submit (phase) as lingering signals; visibility toggled imperatively ([L06]).
- [x] Cancel routes by active load: cold-restore = stop + close card; load-previous = `cancelLoadPrevious()` abort + keep window.
- [x] Retired `DevRestoreSheetHost` / `DevRestoreSheetContent` + the #step-5 standalone bar/sheet (`dev-load-previous.tsx`, `dev-restore-sheet*.{tsx,css,ts}` deleted); mounted `DevLoadControlBar` in `Z0`, wrapped the list in a `.tug-control-bar-region`. `data-replaying` cold-restore blank **kept** (the semi-transparent scrim alone can't hide incremental FOUC; the full reveal-once still wins for cold restore; suppressed for load-previous so content stays visible).
- [x] Laws named: L02 (content/flags via `useSyncExternalStore`), L06 (modality + visibility via DOM, not React state), L03 (inert in layout effect), L20 (band tokens), L26 (one stable bar node across content swaps).

**Tests:**
- [x] Pure-logic: the bar state-machine selector (`loadActive`/`hasOlder`/`atTop`/`lingering` → {hidden | loading | prompt}) + lingering transitions (set on load-previous complete; cleared on scroll-bottom/submit) — `dev-load-control-bar-state.test.ts` (9). Cancel routing exercised live (DOM/responder, not a pure unit). `usePaneInert` extraction verified behavior-neutral via the surviving sheet/restore tests.
- [ ] Real-app (`just app-test`): cold restore shows the Z0 bar progress (modal), releases on completion; load-previous locks then releases + lingers; scroll-to-bottom/submit dismisses the lingering bar; no centered sheet appears. *(pairs with live vet on the rebuilt instance.)*

**Checkpoint:**
- [x] `bun test` (tugdeck 3686) + `bunx tsc --noEmit` clean.
- [ ] Live: one Z0 bar handles cold restore (modal progress), load-previous (modal → lingering prompt), and the scroll-to-top prompt; no flashing; visual treatment reads as a distinct Z0 band. *(user vet on the rebuilt instance.)*

#### Step 6: Faithful restore — load-to-anchor on reload {#step-6}

**Depends on:** #step-5-5

**Commit:** `transcript: restore loads to saved anchor above the window`

**References:** [P05] Faithful restore, [P09] Z0 control bar (the load surface; supersedes [P04]'s sheet for this path), (#faithful-restore), `at0190`

> Note: post-[P11], a deep faithful-restore surfaces its progress through the `Z0` `TugControlBar`'s Loading state (modal), not the retired centered sheet.

**Artifacts:**
- On Developer ▸ Reload, restore computes the window depth needed to include the saved anchor's turn; if that's above the default window, the resume request loads to the anchor (sheet-gated if it crosses 0.5 s), then restores pixel-perfect. A reload landing within the default window is unchanged (fast, no extra load).

**Resolution note (implemented 2026-06-15).** The saved anchor is a flat
`{index, offset}`, not a turn id — and under windowing the flat index is not
stable across a reload (the loaded window can differ). The invariant that *is*
stable is the anchor's **distance from the bottom** in message-rows
(`depthFromEnd`), because the loaded window is always bottom-contiguous (last
N; load-previous prepends older). That one number does both jobs — sizes the
resume window and relocates the anchor — with no `totalMessages` needed at
request time, and it is backward-compatible with the common case
(`depthFromEnd ≤ N` ⇒ default window ⇒ same row position as today). Pure
helpers in `dev-restore-window.ts` (`anchorDepthFromEnd` /
`resolveRestoreWindow` / `anchorRowIndexInWindow`).

**Tasks:**
- [x] Map the saved anchor to a needed window depth and request it when it exceeds N. The transcript persists `meta.anchor.depthFromEnd` (`tug-list-view.tsx`); `card-services-store._construct` reads it from the card bag (`deckManager.getCardState`) and sends `lastMessages: resolveRestoreWindow(depth, N)` on cold resume (resume-mode only; a miss falls back to N).
- [x] Restore to the anchor after the windowed load lands. `makeAnchorResolver` relocates via `numberOfItems - depthFromEnd` and returns null until the window is deep enough (waits for the load-to-anchor), reusing the existing resolver + id-keyed heights [P06]; legacy bags fall back to the raw index.
- [x] Deep restore surfaces through the `Z0` `TugControlBar` Loading state (modal), per the [P11] note — *not* a separate sheet. The store carries `restoreWindowMessages` (the requested window) so the bar's determinate progress reports against the real target (default N or deeper), not a fixed 50.

**Tests:**
- [x] Pure-logic (`bun:test`): the window math — depth capture, window sizing (within-N vs deep), and anchor relocation round-trip incl. clamps (`dev-restore-window.test.ts`, 9).
- [x] Real-app (`at0190`): asserts the save records `anchor.depthFromEnd` (> 0) for a scrolled-up anchor; the common-case pixel-perfect restore still holds.
- [ ] Real-app deep round-trip (page older in → park above the window → reload → ≤ 2 px): the load-previous-driven setup is best confirmed live on the rebuilt instance (a dedicated `just app-test` leg is the follow-on, same pattern as #step-5/#step-5-5).

**Checkpoint:**
- [x] `bun test` (tugdeck 3696) + `bunx tsc --noEmit` clean.
- [ ] Live: reload-while-parked-on-old-content lands exactly where the user left off (deep restore loads to the anchor through the Z0 bar). *(user vet on the rebuilt instance.)*

#### Step 7: Integration checkpoint — long-session load/paging/restore {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P01]–[P07]

> **Landed on `main` directly.** The user ran #step-5 … #step-6 on `main`
> (not a `tugutil dash` worktree), so there is no `dash join` — the
> implementation is already on `main` (commits `e5de5df3`, `882eb82a`,
> `9bd4d51d`, `e7a3876c`, …). Step 7's "join" clause is N/A; what remains is
> the live integration sign-off.

**Automated foundation (verified 2026-06-15).** Full suites green —
tugdeck `bun test` 3696, tugcode `bun test` 615, `bunx tsc --noEmit` clean.
The pure-logic core of every layer is covered: tugcode window slice
(`replay-window.test.ts`), reducer prepend/abort (`replay-prepend.test.ts`),
load-previous mapping (`load-previous.test.ts`), the Z0 bar state machine
(`dev-load-control-bar-state.test.ts`), and faithful-restore window math
(`dev-restore-window.test.ts`). Real long-session JSONLs for the perf gate are
committed in `tests/app-test/corpus/snapshots/` (45,303- and 146,770-line
sessions).

**Tasks:**
- [~] On the live debug instance with a **real long session** (thousands of turns), verify: bounded ingest (default load = last N, `replay_ingest`/`replay_render` independent of total turns); held-scroll prepend; load-all → Z0 bar modal + Cancel ([P09], supersedes the sheet); faithful restore; affordance present iff older exists. *(User live vet — the perf measurement can only be claimed on the user's real session per the real-corpus rule [[feedback_real_content_fixtures]]; the long-session fixtures above are available to drive it.)*

**Tests:**
- [x] Aggregate automated pass: tugdeck 3696 + tugcode 615 `bun test` green, `bunx tsc --noEmit` clean (2026-06-15).
- [ ] Manual vet of the load feel + scroll-hold + no false holes on a real long session — user sign-off.

**Checkpoint:**
- [x] Automated suites green; implementation of #step-1 … #step-6 on `main`.
- [ ] User signs off that load is bounded by recency (not size) and paging/restore behave per #success-criteria on a real long session. *(No `tugutil dash join` — work landed on `main` directly.)*

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dev transcript whose default load cost is bounded by recency (last N message-rows) rather than total session size — older turns paged in on demand, prepended above the view with the user's scroll position held, every load surface unified in the modal-capable `Z0` `TugControlBar` ([P09]–[P11]: cold restore, load-previous, "load all", and the load prompt — with Cancel during a load), and pixel-perfect faithful restore that loads to the saved anchor ([P05]) — composing with `content-visibility` ([`transcript-architecture-redux.md` P07]) into O(viewport) at both ingest and render. Landed on `main` (#step-1 … #step-6); final perf + live-feel vet on a real long session is the user's sign-off (#step-7).

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

Implementation + automated tests are complete for every criterion; the live
*feel* and the perf measurement are the user's sign-off on a real long session
(the perf win is unclaimable without it — [[feedback_real_content_fixtures]]).

- [ ] Opening a thousands-of-turns session loads only the last N — `replay_ingest`/`replay_render` independent of total turns (#perf-gate, #step-7). *Implemented: tugcode windows to `lastMessages: N` at the source ([P01], #step-1). **Perf win = user's real-session measurement** (45k/147k-line corpus fixtures committed for it); not claimed here.*
- [x] "Load previous" pages older turns above the view with no scroll jump (#prepend-scroll-hold, #step-4). *Implemented + pure-tested (compensation math); live scroll-hold = user vet.*
- [x] "Load all" presents Cancel that leaves the loaded window intact (#load-all-sheet, #step-5). *Implemented; per [P09]/[P11] this is now the Z0 `TugControlBar`'s modal Loading state + Cancel (real `cancel_replay` abort, window kept), superseding the standalone sheet.*
- [x] Faithful restore lands at the saved anchor even when it is above the window (#faithful-restore, #step-6). *Implemented (`depthFromEnd` window sizing + anchor relocation) + pure-tested. The common case (within the default window) is first-paint pixel-perfect; the **deep paged-reload** case lands correctly but converges over a brief settle rather than first-paint-perfect, because persisted heights are bounded by design ([P06] reconciliation — the bag-bloat lesson). Deep round-trip feel = user vet.*
- [x] The "load previous" affordance appears iff older turns exist; loaded turns render fully (no false holes) (#pagination-not-holes). *Implemented: prompt derived from `hasOlder` ([P07]); loaded rows render inline at real heights.*

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Backward-JSONL-parse / turn-boundary index so even `JSON.parse` is bounded by N (v1 parses all lines, translates only the tail) — only if the parse cost is measured to matter on a real whale ([Q02]).
- [ ] **"Load all" + Cancel — pulled from v1 (2026-06-15).** The shipped version trims the affordance to a single fixed step (50) and removes Cancel from both the restore and load-previous states: a 50-row page (and the restore) is quick enough that there's nothing slow to abort, and live testing showed "All" → Cancel bogged down. The store/tugcode abort path (`cancelLoadPrevious`, `cancel_replay`) and the `loadPrevious("all")` API are left dormant for a future revival. Chunked "load all" with granular Cancel remains the follow-on if a real whale ever needs paging beyond 50-at-a-time ([Q04]).
- [ ] Forward unloading of very old paged-in turns under extreme memory pressure (not expected to be needed under `content-visibility`).
