<!-- devise-skeleton v4 -->

## Resume Performance — Snappy Transcript Replay and Render {#resume-performance}

**Purpose:** Make session transcripts fast everywhere they are slow: resume replay
(batch) renders a medium session within a few hundred milliseconds, live turns
(incremental) stay cheap no matter how long the transcript grows, and whales
degrade gracefully — built on one invariant (finalized rows never change, so
their expensive work happens exactly once) and verified by measured budgets.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented — superseded by the real-corpus restart (see #superseded) |
| Target branch | main |
| Last updated | 2026-06-12 |

---

### SUPERSEDED — real-corpus restart required {#superseded}

This plan was built, measured, and verified against **synthesized
prose-only fixtures**, and its wins are real but unrepresentative:
the first real working session resumed against it (~12MB, ~4,900
wire messages, 937 tool_use + 937 tool_result + 457 thinking blocks
across ~46 turns) still froze the deck **~20 seconds** in a single
inline mount commit, with a blank card and no feedback. Server side
measured 420ms on that same resume — the entire bill is deck-side
mount cost for tool-dominated content this plan's fixtures never
contained. Ken's ruling: restart from real content. A follow-on plan
replaces this one; its non-negotiables, recorded here so they survive
the handoff:

**Problems this plan demonstrably did not solve:**

1. **Tool-block render cost is uncached.** The render-once cache
   covers markdown prose only; tool blocks redo their work on every
   mount, and the bottom rows windowing still mounts can each carry
   ~a hundred of them. Windowing is a stopgap that cuts 20s to
   seconds, not to sub-second.
2. **No feedback during the replay window.** The paint gate hides
   everything and a long mount commit cannot paint progress by
   definition. A resuming card must show visible progress/skeleton
   state from the first moment — a success criterion, not a
   footnote. "Fast" alone does not satisfy it.
3. **The fixture suite itself.** Real-shape fixtures must be the
   default; the synthetic prose generators get deleted. (at0184's
   tool-heavy leg is the seed, not the answer.)

**Shape of the restart:**

1. **The corpus comes from disk, not generators.** Step zero
   harvests `~/.claude/projects/`: survey every session JSONL on the
   machine, classify by shape (tool-heavy, thinking-heavy,
   image-bearing, prose; by size and turn count), snapshot a
   representative set — including session `763cd1d8` itself — as the
   fixture corpus.
2. **Baseline on real sessions before touching anything.** The
   instrumentation from this plan (Spec S02, `getSessionPerf`, the
   waterfall) is the proven survivor — it located the 20s precisely.
   Baseline the whole corpus and let the real waterfall name the
   costs: tool-block render weight, per-message mount weight, the
   blank-window UX.
3. **The UX requirement is a success criterion.** Visible progress
   from the first moment of a resume.
4. **No win is claimed until it reproduces on real sessions.** The
   waterfall check on a real resume is the acceptance test for every
   step.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Resuming even a medium-length session (a couple dozen messages) takes several
seconds to paint the transcript. Investigation of the pipeline (2026-06-11)
located the costs structurally — **not** in JSON parsing (Bun parses hundreds of
KB in milliseconds):

1. **Per-entry pacing in tugcode.** `translateJsonlSession` yields the event loop
   every 16 entries via `setTimeout(0)` (`yieldToEventLoop` in
   `tugcode/src/replay.ts`; tests bypass it with `disableYield`), and `runReplay`
   writes one IPC line per wire message. The replay window was designed as a
   stream with a 10s hard budget (`REPLAY_HARD_TIMEOUT_MS`), not a bulk load.
2. **One React commit per frame.** Each replayed line becomes its own CODE_OUTPUT
   frame, and tugdeck's `CodeSessionStore.dispatch` calls `notifyListeners()`
   after every state-changing frame — a 50-turn replay is hundreds of reducer
   passes and React commits.
3. **The render bill itself.** Every commit re-runs markdown parsing and
   highlight work for the rows it touches, and the transcript pays render cost
   for rows nowhere near the viewport. Batching delivery amortizes the *commit
   count*; it does not shrink this bill — and the same bill is what makes long
   transcripts progressively heavier during **live** turns too.

The structural insight that drives the cure: **finalized transcript rows are
immutable.** Once a turn commits, its rows never change — so parse, structure
derivation, and rendered output can be computed exactly once per row, cached by
stable row identity, and reused across replay, live appends, scrolls, and tab
switches. The deck store already models the replay window (`replaying` phase off
`replay_started`/`replay_complete`), giving batch ingest a **semantic** boundary
to fold on — no timers, no `requestAnimationFrame` (banned for this purpose by
[L05]/[L13]).

Two constraints discovered up front, preserved from the earlier draft: tugcast
rewrites replayed frames in flight (telemetry inlining, metadata merge), so any
*wire-level* batching must sit downstream of those intercepts; and the deck and
tugcast already share first-class replay-window markers at every layer ([Q01],
resolved).

#### Strategy {#strategy}

- **Measure before optimizing.** The first step instruments the pipeline end to
  end — including live-turn commit rates and per-row parse counts; every gated
  stage cites its numbers ([P01]).
- **Deck first, wire later.** The store folds replay bursts itself using the
  semantic window it already models — one reducer fold, one notify, zero wire
  changes ([P03]). Wire-level `replay_batch` coalescing is gated whale-scale
  armor, not the first move ([P07]).
- **Render once, ever.** Codify the finalized-row immutability invariant: a
  parse/derivation cache keyed by stable row identity, memoized row components
  with [L26]-stable identity, and a cooperative background queue that
  speculatively warms the cache for off-screen rows ([P08]). This is what makes
  *both* batch and incremental updates fast — the live path's only hot row
  becomes the streaming tail.
- **Pay paint cost only for what's visible.** `content-visibility` +
  `BlockHeightIndex` intrinsic sizes as the law-friendly first move (CSS-only,
  preserves selection/find per [L23]); true windowing as the gated whale
  escalation with selection/focus-pinned rows never unmounting ([P09]).
- **No rAF anywhere in this plan.** Folding is event-driven off semantic
  boundaries; speculative work runs on a plain cooperative queue; paint
  deferral is CSS. [L05] and [L13] are honored by construction.
- **Rust owns cache + orchestration; tugcode stays the only translator** —
  `replay_cache` + pre-warm gated on measured translate cost ([P05], [P06]).

#### Success Criteria (Measurable) {#success-criteria}

- Stage timings (tugcode boot, read, translate, frames sent, deck ingest,
  commits, per-row parse counts) recorded per resume in the session-lifecycle
  log and visible as a TugDevPanel waterfall — read off a real resume.
- Medium fixture (50 turns, ~500KB): transcript fully committed within **750ms**
  of Open on the dev machine (2s hard app-test ceiling for CI variance), with
  **≤5 React commits** for the whole replay (counter-asserted).
- **Parse-once invariant holds:** a finalized row's markdown parses exactly once
  across replay → live appends → scroll → tab switch and back — asserted by the
  parse-cache counters in pure-logic tests and read back in the app-test.
- **Incremental path:** during a live streaming turn on a 200-row transcript,
  only the streaming tail row re-renders (memo hits on all finalized rows,
  counter-asserted); commit cost does not grow with transcript length.
- Whale (≥50MB JSONL / thousands of rows): first rows paint before translation
  finishes; scrolling does not hit parse cliffs (speculative warm); no
  `REPLAY_HARD_TIMEOUT_MS` trips.
- No behavioral regression: replay suites green; telemetry inlining + metadata
  merge intact; selection/focus/scroll survive everything per [L23].

#### Scope {#scope}

1. Pipeline instrumentation (tugcode, tugcast, tugdeck) with stage timings,
   commit counters, and parse counters — replay *and* live-turn.
2. Deck-side replay fold: buffer during the `replaying` phase, one reducer fold
   + one notify per chunk/completion. No wire changes.
3. Unpaced translate loop (time-slice yield), with the broadcast-channel
   capacity interaction named and guarded.
4. Finalized-row render-once architecture: parse/derivation cache keyed by
   stable identity + memoized rows with stable mount identity.
5. Off-screen paint deferral: `content-visibility` + intrinsic heights, plus
   speculative cache warm via a cooperative background queue.
6. (Gated) True transcript windowing for whales.
7. (Gated) Wire-level `replay_batch` coalescer in tugcast.
8. (Gated) `replay_cache` sqlite table + pre-warm of recently-listed sessions.
9. (Gated) Startup-path trims.
10. App-test budgets (medium latency, parse-once, whale first-paint).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Porting `translateJsonlSession` to Rust** ([P05] names the reopen trigger).
- **Notify throttling / time-based coalescing on the live path.** The live path
  gets fast by making renders cheap (render-once + visibility deferral), not by
  delaying notifies behind timers — there is no rAF or timer-driven render
  scheduling anywhere in this plan.
- **Changing replay semantics** — what gets replayed (pending rows, compaction,
  orphan synthesis) is untouched.
- **Client-side transcript persistence** (no IndexedDB/localStorage; the parse
  cache is in-memory derived data, rebuilt on reload).

#### Dependencies / Prerequisites {#dependencies}

- Session unification (landed `f5fc76c2`): `external_scan_cache` pattern and
  at0181's fixture builder.
- Path resolution authority (landed `7a80fabf`): `resolve_to_claude_form` in
  crate-root `path_resolver.rs` — the APFS-firmlink-aware resolver
  `claude_project_dir` now routes through. Any cache stage deriving JSONL
  paths uses the chokepoint, never ad-hoc canonicalization.
- Request-driven replay (`request_replay`, background claude spawn) and the
  replay-window markers (`replay_started`/`replay_complete`) at every layer.
- `BlockHeightIndex` (existing height estimation for markdown blocks).
- Instrumentation rails: `logSessionLifecycle`, `tugDevLogStore` / TugDevPanel.

**Recent adjacent work this plan builds beside (skimmed 2026-06-12):**
`7a80fabf` already made the *picker/listing* side fast — two-phase
`list_sessions` (instant ledger preview, detached scan settling the union via
a `scanning` flag), a startup warm scan pre-populating the scan cache, and
rayon-parallel scan parsing. None of it touches the replay/render pipeline
this plan targets (verified: tugcode `replay.ts`/`session.ts`/`main.ts` and
`code-session-store.ts` dispatch are unchanged since `f5fc76c2`), but two of
its patterns are directly reusable here: the **detached-work-then-settle
orchestration** is the template for #step-8's pre-warm, and **rayon is now a
tugcast dependency** if any gated stage wants parallelism. Separately,
`56217182` (monitors-in-jobs) grew the reducer's event inventory — the
#step-1 immutability audit covers the new monitor/job events like every other
event.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings`) in the Rust workspace.
- New sqlite tables via `CREATE TABLE IF NOT EXISTS` only (no-migration policy).
- **Tuglaws compliance is load-bearing, not aspirational:** [L02] for all store
  → React flow; [L05]/[L13] — no rAF for anything render-coupled; [L23] —
  selection, focus, and scroll survive every visibility/windowing change;
  [L26] — row mount identity (key, component type, renderer reference) stable
  across streaming→finalized transitions and window membership changes.
  Cross-check tuglaws before each deck step; name touched laws in commits.
- Replayed-frame intercepts must keep working (telemetry inline, metadata
  merge, journal pending-row deletion).
- tugcode is a compiled binary (rebuild to test); tugdeck is HMR-live.
- If the gated wire step lands: capability-gated with bit-exact per-frame
  fallback ([P07]).

#### Assumptions {#assumptions}

- Deck-side per-frame commits and the per-row render bill dominate; translate
  pacing is second; raw parse/IO is a distant third. Step 1 confirms or
  reorders.
- Finalized rows are genuinely immutable on the wire: no event mutates a
  committed turn's content. (Edits arrive as *new* events — e.g. rewind
  truncates and re-binds rather than editing rows in place. Step 1's audit
  verifies and documents the full event inventory against this claim.)
- `(file_size, file_mtime)` remains an exact validity key for session JSONLs.
- A single websocket frame can carry a few hundred KB (verified if/when the
  gated wire step proceeds).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses **explicit, named anchors** and **rich `References:` lines** in
execution steps, per `tuglaws/devise-skeleton.md`:

- Every heading cited elsewhere carries an explicit `{#anchor}` (kebab-case, no
  phase numbers).
- Plan-local design decisions are `[P##]` (`[D##]` is reserved for the global
  `tuglaws/design-decisions.md`; `[L##]` cites tuglaws); open questions
  `[Q##]`; specs `S##`; risks `R##`. Two digits, never reused.
- Execution steps cite plan artifacts by label and anchor — never line numbers —
  and declare ordering with `**Depends on:** #step-N` lines referencing real
  step anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where exactly does the replay window begin and end? (DECIDED) {#q01-replay-window-markers}

**Resolution:** DECIDED — resolved by code survey (2026-06-11). The window is
first-class at every layer: tugcode emits `replay_started` before its first
replayed message; the bridge flips its replay-window flag on it; the merger
keeps a saturating open-window counter; the deck store models a `replaying`
phase off the same pair. Both the deck-side fold (#step-2) and the gated wire
coalescer (#step-7) consume existing markers — no wire changes needed for
window detection.

#### [Q02] What is the transcript's current mounting/render shape? (OPEN → resolve in #step-1) {#q02-transcript-render-shape}

**Question:** Do all transcript rows mount eagerly with full markdown parse?
Are row components memoized today? Are mount identities ([L26] key / type /
renderer reference) already stable across the streaming→finalized transition?
Where exactly is markdown parsed relative to render?

**Why it matters:** #step-4 and #step-5 build directly on the answers; a
pre-existing identity instability would silently defeat memoization.

**Plan to resolve:** #step-1's audit task — answers recorded in this plan under
the baseline-numbers anchor.

**Resolution:** DECIDED — resolved by the #step-1 audit; full answers
in `#render-shape-audit`. Headlines: all rows mount eagerly
(`TugListView` `inline` mode), no cell-level memoization (every
commit re-renders every cell — the dominant replay cost), [L26]
identity already stable (cache key substrate exists), markdown
parses once per mount + once per streaming emission through
`renderIncremental` (block-level content hashes already available).

#### [Q03] Is cold translate cost ever the long pole? (OPEN → gates #step-8) {#q03-translate-cost}

**Question:** With pacing removed and folding in place, does translate time as
a function of file size justify the replay cache + pre-warm machinery?

**Plan to resolve:** #step-1 instrumentation across small/medium/whale
fixtures; revisit after #step-2/#step-3 land.

**Resolution:** OPEN (gates #step-8) — but #step-1's measurement all
but closes it: cold translate of a 53MB session is **42ms** unpaced
(`#baseline-numbers`), two orders of magnitude under the ~500ms
trigger. Formal close-out happens at #step-8's gate check after
#step-2/#step-3 re-measurement.

#### [Q04] Does `content-visibility` + intrinsic sizing carry the whale case, or is true windowing required? (OPEN → gates #step-6) {#q04-visibility-vs-windowing}

**Question:** CSS visibility deferral keeps the DOM (selection/find intact,
[L23] free) but pays DOM-node count and reconciliation walk on huge
transcripts. At what row count does that break down on real hardware?

**Why it matters:** True windowing (#step-6) is the most invasive deck change
in the plan — it must earn its way in with numbers, and carries the hardest
[L23]/[L26] obligations.

**Plan to resolve:** #step-5's whale re-measurement (scroll smoothness, memory,
commit cost at 1k/5k/10k rows).

**Resolution:** DECIDED — measured by #step-5 (at0183, with the fold,
render-once cache, warm queue, and `content-visibility` all in
place): **1k rows** complete in 2.4s with 4ms full-range layout
jumps (visibility-only carries it); **5k rows** complete but degrade
hard (40.5s wall, 823ms full-range jumps — the mount still builds
DOM for every row; the deferral skips paint, not our JS); **10k
rows** wedge the page past every timeout. Visibility-only deferral
runs out between 1k and 5k rows — **#step-6 true windowing
proceeds**, with the content-heavy at0182 whale (WebContent OOM at
2k eagerly-mounted 26KB rows) as the second prong of the same
evidence. Numbers in `#baseline-numbers`.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Immutability assumption has an exception (some event edits a finalized row) | high | low | Step-1 audit inventories every reducer event against the invariant; cache entries are invalidated by identity, and any mutating event drops the row's cache entry ([R01]) | Audit finds a mutating event |
| Mount-identity instability defeats memoization silently | med | med | [L26] three-input audit (key, type, renderer ref) is an explicit #step-4 task with a remount-detection test ([R02]) | Memo-hit counters lower than expected |
| Visibility/windowing destroys selection, focus, or scroll | high | med | content-visibility first (DOM survives, [L23] free); windowing pins selection/focus rows mounted; scroll anchored via height index ([R03]) | Any L23 regression in app-test |
| Unpaced replay overruns tugcast broadcast channels (frame drops) | high | med | Keep a generous time-slice yield until the gated wire coalescer lands; verify channel capacity vs measured peak frame rate in #step-3 ([R04]) | Dropped-frame telemetry nonzero |
| Parse-cache memory growth on whales | med | low | Cache keyed per session, bounded by transcript size; entries are plain parse results; evict with the session store ([R05]) | Memory telemetry on whale fixture |
| Latency app-test flakes on CI variance | med | med | Generous hard ceiling + machine-insensitive internal splits (commit/parse counters) as the CI gate ([R06]) | Flaky at-test |

**Risk R01: The immutability invariant has an exception** {#r01-immutability-exception}

- **Risk:** A reducer event mutates an already-finalized row (an edit, a
  late telemetry attach, a redaction), and the render-once cache serves stale
  content.
- **Mitigation:** #step-1 audits the full event inventory against the
  invariant and documents the result; the cache API requires explicit
  invalidation-by-identity so any future mutating event has a one-line correct
  path; turn-telemetry attaches to turn chrome, not row content (verified in
  the audit).
- **Residual risk:** A future event type added without reading the invariant
  doc — the cache module docs and the audit table make that hard to miss.

**Risk R02: Silent memoization defeat** {#r02-memo-defeat}

- **Risk:** Unstable keys, split components, or per-render lambda renderer
  references ([L26]'s three inputs) cause finalized rows to remount or
  re-render despite the cache, and nothing *looks* broken.
- **Mitigation:** The #step-4 audit covers all three identity inputs together;
  a pure-logic test asserts memo-hit/parse counters across a
  streaming→finalized transition and a window-membership change.
- **Residual risk:** Future row-component refactors; the counters stay wired
  into TugDevPanel so regressions are visible, not silent.

**Risk R03: User-visible state loss under visibility/windowing ([L23])** {#r03-l23-loss}

- **Risk:** Deferring or unmounting rows destroys selection, focus, find
  highlights, or scroll position.
- **Mitigation:** Phase order is deliberate: `content-visibility` keeps all
  DOM alive (selection/find work natively). If windowing proceeds (#step-6),
  rows intersecting selection or focus are pinned mounted; scroll anchoring
  rides `BlockHeightIndex`; the app-test asserts selection survival.
- **Residual risk:** Browser quirks in find-in-page interaction with
  `content-visibility` — checked during #step-5 on the real app.

**Risk R04: Broadcast-channel overrun after unpacing** {#r04-channel-overrun}

- **Risk:** Removing translate pacing floods tugcast's bounded CODE_OUTPUT
  broadcast channel faster than a lagging ws writer drains it; frames drop and
  the transcript silently corrupts.
- **Mitigation:** #step-3 measures peak frame rate against channel capacity
  before shipping; the time-slice yield stays generous (≥8ms work slices, not
  zero) until the gated wire coalescer (#step-7) reduces frame count at the
  source; dropped-frame telemetry added in #step-1.
- **Residual risk:** Pathological consumers; the wire coalescer closes this
  fully if it lands.

**Risk R05: Parse-cache memory growth** {#r05-cache-memory}

- **Risk:** Caching parse results for every finalized row of a whale grows
  resident memory.
- **Mitigation:** Cache is per-session, holds derived structures comparable in
  size to the source text, and is dropped with the session store on card
  close; whale fixture memory is measured in #step-5.
- **Residual risk:** Many simultaneously-open whale cards — acceptable for a
  single-developer tool; revisit if telemetry says otherwise.

**Risk R06: Flaky latency assertions** {#r06-flaky-latency}

- **Risk:** Wall-clock budgets on shared machines flake.
- **Mitigation:** CI gates on the machine-insensitive internals (commit count,
  parse-once counters, ordering) plus a generous 2s ceiling; the tight 750ms
  number is a dev-machine checkpoint recorded in the ledger, not a CI gate.

---

### Design Decisions {#design-decisions}

#### [P01] Measurement gates every optimization stage (DECIDED) {#p01-measure-first}

**Decision:** #step-1 lands instrumentation before any optimization; gated
steps (#step-6 through #step-9) cite its numbers to proceed or close as
"not needed" with rationale recorded in the ledger.

**Rationale:** The cost ranking is structural inference until measured;
instrumentation is permanently useful (TugDevPanel waterfall) and cheap.

**Implications:** A ledger ending with gated steps closed-by-numbers is
success, not abandonment.

#### [P02] Translate runs unpaced; cooperative yield by time slice (DECIDED) {#p02-unpaced-translate}

**Decision:** `runReplay`'s translate loop drops the every-16-entries
`setTimeout(0)` pacing for a coarse time-slice yield (after ≥8ms of continuous
work), keeping the IPC pipe responsive on whales without taxing the common
case. The slice stays at 8ms (not zero) deliberately while per-frame delivery
remains, as the flood guard for [R04].

**Rationale:** Hundreds of forced ≥1ms macrotask idles for no responsiveness
benefit at medium sizes; the slice preserves the original intent at ~zero cost.

**Implications:** `disableYield` test semantics survive (bypasses the slice
check).

#### [P03] Replay batching is a deck-side fold on the semantic window — no wire changes, no timers (DECIDED) {#p03-deck-side-fold}

**Decision:** `CodeSessionStore` buffers decoded replay events while its
existing `replaying` phase is active and folds them through the reducer with
notifies deferred — one fold + one notify per flush. Flushes are event-driven
off semantic boundaries only: `replay_complete`, a buffered-count threshold
(e.g. every 250 events, bounding single-fold latency on whales), and
transport close / store teardown (nothing is ever stranded). **No
`requestAnimationFrame`, no timers** — [L05]/[L13] honored by construction;
state still enters React through one `useSyncExternalStore` tick per flush
([L02]).

**Rationale:**
- The deck already knows the window; a fold here achieves the ≤5-commit goal
  with zero wire/protocol/capability machinery and lands in a fraction of the
  effort of a wire format.
- Folding N events into one state is also the cure for immutable-append
  copying costs (one array build instead of N incremental copies).
- The wire-level coalescer remains available as gated whale armor (#step-7)
  for frame-count pressure — a different problem than commit count.

**Implications:**
- The fold must be semantically transparent: folding a buffered event sequence
  yields a state deep-equal to dispatching the same events singly (golden
  contract test).
- Mid-replay live frames (the live-buffer bracket) arrive after
  `replay_complete` and are untouched.

#### [P04] Finalized rows are immutable — render-once is the data-model contract (DECIDED) {#p04-render-once}

**Decision:** Codify the invariant: once a transcript row is finalized (its
turn committed), its content never changes. Expensive per-row work — markdown
parse, block structure, anything derivable from content — is computed at most
once per row, stored in a per-session derived-data cache keyed by **stable row
identity** (the same identity that satisfies [L26]), and reused for every
subsequent render: replay, live appends, scroll, tab switches, window
membership changes.

**Rationale:**
- This is the only fix that shrinks the render *bill* rather than amortizing
  delivery — and it serves incremental and batch updates with one mechanism.
- The live path's hot set collapses to the streaming tail; finalized rows are
  memo hits backed by cached parses, so commit cost stops growing with
  transcript length.

**Implications:**
- The cache is derived data in the structure zone — a plain per-session store
  read during render (pure lookup), never React state, never DOM-resident
  ([L24]); dropped with the session store.
- Streaming (unfinalized) rows bypass the cache and parse live, exactly as
  today; finalization populates the cache once.
- The cache API carries explicit invalidation-by-identity so any future
  mutating event has a correct one-line path ([R01]).

#### [P05] tugcode remains the single translator; the Rust-port trigger is named (DECIDED) {#p05-single-translator}

**Decision:** `translateJsonlSession` stays the only JSONL→wire translator;
Rust owns caching/orchestration only. Reopen trigger: after the cache stages,
cold translation of a p95 session still exceeds ~500ms in instrumentation on a
user-visible path. Any future port requires a shared golden-fixture suite both
translators pass first.

#### [P06] Replay cache stores the translated stream, keyed (size, mtime) (DECIDED, gated by [Q03]) {#p06-replay-cache}

**Decision:** If [Q03] fires: a `replay_cache` table in tugcast's sqlite (same
no-migration bootstrap as `external_scan_cache`) stores tugcode's translated
pre-intercept stream per session, keyed by `(file_size, file_mtime)`; tugcode
writes after cold translate and reads on hit via its existing bun:sqlite
handle. Pre-warm: a headless `--translate-only` tugcode mode, orchestrated and
concurrency-capped by the supervisor after `list_sessions`. Caching
pre-intercept keeps telemetry/metadata inlining live on every serve.

#### [P07] Wire-level `replay_batch` is gated whale armor, capability-gated with bit-exact fallback (DECIDED, gated) {#p07-wire-batch-gated}

**Decision:** The tugcast coalescer (Spec S01) proceeds only if measurements
show frame-count pressure the deck-side fold can't address — broadcast-channel
overrun risk at whale frame rates ([R04]) or material per-frame dispatch
overhead. If it lands: coalescing sits strictly downstream of the
telemetry/metadata intercepts, flush triggers guarantee no frame is held
hostage (chunk cap, `replay_complete`, window abort, ~50ms max-hold), and the
frame ships behind a client-advertised capability with the legacy per-frame
stream preserved bit-for-bit as fallback and rollback lever.

**Rationale:** Demoted from the primary move (earlier draft) because the
deck-side fold achieves the commit-count goal without wire machinery; what
remains unique to the wire layer is frame *count*, which only whales stress.

#### [P08] Speculative warm runs on a cooperative background queue — plain scheduling, no rAF, no React coupling (DECIDED) {#p08-speculative-warm}

**Decision:** After a fold commits (and during idle moments thereafter), a
cooperative queue parses not-yet-cached finalized rows outside the viewport —
nearest-to-viewport first (overscan order) — in small time-sliced chunks via
plain deferred tasks (`setTimeout`-class scheduling). It writes only to the
[P04] cache (pure data; no DOM, no React state, no notifies — a row that
renders later simply finds its parse ready). The queue yields immediately to
real work (any user-triggered parse takes priority synchronously) and is
cancelled with the session store.

**Rationale:** This is the "massively parallel supercomputer" dividend with
zero law exposure: scrolling never hits a parse cliff because the cache is
warm ahead of the viewport, and because the queue touches only derived data,
it cannot interact with React scheduling, paint, or [L05]/[L13] at all.

**Implications:** The queue's only observable effects are cache-hit counters
(TugDevPanel) and the absence of scroll jank.

#### [P09] Paint deferral phases: content-visibility first; true windowing gated, with [L23] pinning (DECIDED) {#p09-visibility-phases}

**Decision:** Off-screen paint cost is attacked in two phases. **Phase one
(#step-5):** `content-visibility: auto` + `contain-intrinsic-size` from
`BlockHeightIndex` estimates on transcript rows — CSS-only (appearance zone,
[L06]), DOM stays alive so selection, find, and scroll anchoring work natively
([L23] satisfied for free). **Phase two (#step-6, gated by [Q04]):** true
windowing — rows far outside the overscan range unmount to placeholders —
only if whale measurements demand it, under hard constraints: rows
intersecting the current selection or focus are pinned mounted; mount identity
stays [L26]-stable across membership changes; scroll position is anchored
through the height index; the [P04] cache makes re-mounting cheap (parse
already done).

**Rationale:** Phase one buys most of the paint win at near-zero risk; phase
two's costs (selection pinning, identity discipline, placeholder correctness)
should only be paid where phase one measurably runs out.

---

### Specification {#specification}

**Spec S01: `replay_batch` wire frame (gated — ships only with #step-7)** {#s01-replay-batch}

A CODE_OUTPUT frame whose payload is:

```json
{ "type": "replay_batch", "tug_session_id": "...", "seq": 1, "final": false,
  "messages": [ { ...wire message... }, ... ] }
```

- `messages` preserves exact per-frame payloads (post-intercept) in emission
  order — folding them one-by-one must produce a state identical to the legacy
  stream.
- Chunk caps ≤256 messages / ≤512KB serialized (verified against tugcast frame
  limits); first chunk flushes at 32 messages for early first paint.
- **Flush triggers — no frame held hostage:** chunk cap; `replay_complete`;
  window abort (merger's saturating window counter detects tugcode death
  mid-replay); ~50ms max-hold timer since the batch's first message.
- `replay_complete` still travels as its own frame.

**Spec S02: Stage-timing and counter instrumentation** {#s02-timings}

| Signal | Where | Emitted as |
|--------|-------|-----------|
| tugcode boot → ready | tugcode main | `logSessionLifecycle("perf.boot", {ms})` |
| `request_replay` received | tugcode | `perf.replay_requested` |
| JSONL read | tugcode runReplay | `perf.replay_read` `{ms, bytes, lines}` |
| translate + emit | tugcode runReplay | `perf.replay_translate` `{ms, messages}` |
| forward (+ drops if any) | tugcast replay path | tracing + frame/drop counters |
| replay folds + commits | tugdeck store | `perf.replay_ingest` `{ms, frames, folds, commits}` |
| last React commit | tugdeck transcript | `perf.replay_render` `{ms, rows}` |
| live-turn commit rate | tugdeck store | `perf.live_commits` `{turnKey, commits, ms}` |
| per-row parse + memo counters | parse cache / row components | `perf.row_parse` `{parses, cacheHits, memoHits}` |

Deck-side numbers land in `tugDevLogStore`; TugDevPanel shows a per-resume
waterfall. The store counts its own `notifyListeners` calls inside the replay
window — that counter is the "≤5 commits" assertion surface; the parse/memo
counters are the "parse-once" and "tail-only live renders" surfaces.

**Spec S03: Render-once cache contract** {#s03-render-cache}

- **Key:** the row's stable identity — the same value that serves as the
  [L26] React key (message/turn-stable, minted before finalization, unchanged
  through it).
- **Value:** parse output and derived structures for the row's content
  (markdown AST/blocks, highlight results — exact set per the #step-4 audit).
- **Population:** on first render of a finalized row (lazy), or by the
  speculative queue ([P08]) ahead of need. Streaming rows never populate.
- **Invalidation:** explicit by identity only; session-scoped lifetime
  (dropped with the session store). No TTL, no LRU within a session — the
  invariant says entries cannot go stale.
- **Zone:** derived data, structure zone — plain per-session store, read as a
  pure lookup during render; never React state, never serialized.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Replay fold buffer | store-internal (pre-React) | array inside `CodeSessionStore`; folds → one `useSyncExternalStore` tick per flush | [L02] |
| Render-once parse cache | structure (derived data) | per-session store, pure lookup at render; explicit invalidation API | [L24], [L02] |
| Speculative warm queue | background derived-data work | cooperative `setTimeout`-class slices; writes cache only; no DOM, no React, **no rAF** | [L05], [L13] honored |
| Off-screen paint deferral (phase one) | appearance | `content-visibility` + `contain-intrinsic-size` via CSS | [L06] |
| Window membership (phase two, gated) | structure | visible-range data → row mount/unmount via normal render; selection/focus rows pinned | [L24], [L26], [L23] |
| Perf counters | external diagnostics | `tugDevLogStore` (existing) | [L02] |

---

### Step-1 Findings (audits + baseline) {#step-1-findings}

Recorded by the #step-1 audit pass (2026-06-12) against the dash
worktree's code. These tables are the evidence base [P04], #step-4,
and #step-5 build on.

#### Immutability audit — every reducer event vs "finalized rows never change" {#immutability-audit}

**Verdict: the invariant holds, structurally.** Committed `TurnEntry`
rows live in the store wrapper's `_transcript` array — *not* in
reducer state — and the only two effects that can touch it are
`append-transcript` (copy-on-write append of a new entry) and
`truncate-transcript` (rewind: drops the anchor turn and everything
after it **whole**; survivors keep their object references). No
reducer path edits a committed entry in place. Per-event:

| Event group | Events | Committed-row impact |
|---|---|---|
| Live-turn scratch (pre-commit) | `send`, `content_block_start`, `assistant_text`, `thinking_text`, `tool_use`, `tool_result`, `tool_use_structured`, `streaming_usage`, `wake_started`, `prompt_anchor` | None — `pendingTurn` / `scratch` only; rows don't exist yet |
| Commit | `turn_complete` | **Append-only** — mints a frozen `TurnEntry` (replay inlines persisted telemetry upstream in the bridge, so it arrives *at* commit, never after) |
| Replay bracket | `replay_started`, `replay_complete`, `add_user_message` | None — phase + `pendingTurn` only |
| Rewind | `rewind_preview_result`, `request_rewind_preview`, `session_rewind_request` | None (preview cache / wire) |
| Rewind apply | `rewind_result` | **Whole-row removal** via `truncate-transcript`; surviving rows reference-identical (L26-safe by construction) |
| Compaction | `compact_boundary`, `mark_compaction_seed` | None — system_note appends to the *active* turn's scratch; seed is session-level |
| Jobs ledger (incl. monitors-in-jobs `56217182`) | `task_started`, `task_updated`, `clear_jobs_action` | None — Z2 `jobs` state only, confirmed never touches transcript |
| Session / Z2 | `session_init`, `system_metadata`, `cost_update`, `context_breakdown`, `api_retry`, `unknown_event`, `error`, `resume_failed`, `attachment_rejected` | None |
| Dialogs / queue | `control_request_forward`, `respond_approval`, `respond_question`, `interrupt_action`, `consume_draft_restore`, `cancel_queued_send` | None (queue + dialog state; CASE A suppression drops a turn *before* commit) |
| Settings | `set_permission_mode`, `set_model`, `set_effort` | None (wire-only) |
| Transport | `transport_close`, `transport_open`, `transport_settled`, `session_state_errored`, `session_unknown`, `session_not_owned`, `bind_resume_acknowledged` | `transport_close` may **append** the in-flight turn as `interrupted` — append-only, same path |
| Replay-clock ticks | `tick_soft_budget`, `tick_timeout_dwell_done`, `tick_preflight_done` | None |

**Cache implication ([R01]):** the only "mutation" is wholesale
removal at rewind. Truncated rows' cache entries become unreachable
(turnKeys are UUIDs, never reused) — the render-once cache should
drop them via its explicit invalidation API at the
`truncate-transcript` effect, but a missed drop is dead weight, not
stale serve.

#### Render-shape audit — [Q02] answers {#render-shape-audit}

1. **Mounting: eager, all rows.** The dev transcript mounts
   `TugListView` with `inline` — windowing is explicitly skipped
   (every cell rendered from mount, no spacers/overscan; chosen for
   height-estimate stability per the prop's docs). DOM weight and
   per-commit reconciliation scale with transcript length.
2. **Memoization: none at the cell level.** No `React.memo` on
   `UserMessageCell` / `AssistantTurnCell` / `GhostRowCell`. Every
   store notify re-renders the host (snapshot identity via
   `useSyncExternalStore`) and therefore re-renders **all N cells'
   element trees** — O(N) VDOM + hook work per commit, O(N²) across
   an N-frame replay. Two per-render amplifiers found:
   `useTranscriptCellMenu`'s dep-less `useLayoutEffect` constructs a
   fresh `HighlightSelectionAdapter` per cell per commit, and each
   `AssistantTurnCell` runs `dataSource.rowAt` + dialog-slot
   subscriptions per commit.
   **Constraint for #step-4:** cells read row data *imperatively*
   (`dataSource.rowAt(index)` during render), not via props — naive
   `React.memo` would freeze them. Memoization needs row-scoped
   equality (committed rows are immutable, so `(id, committed,
   selected)`-style keys suffice) or per-cell row-selector
   subscriptions; the in-flight cell must stay live.
3. **[L26] identity: already stable — no instabilities found.** Key
   `${turnKey}-{user|assistant|ghost}` is byte-identical across
   streaming→finalized; single `"assistant"` kind; renderer lambdas
   `useCallback`'d over card-lifetime-stable deps. The identity
   substrate for the parse cache (Spec S03) exists today; the
   per-message streaming path `turn.${turnKey}.message.${messageKey}.
   ${channel}` is the natural per-message cache key.
4. **Markdown parse location.** All transcript prose (assistant text
   *and* thinking via `DevThinkingBlock`) renders through
   `TugMarkdownBlock` → `renderIncremental` →
   `parseMarkdownToSanitizedBlocks` (WASM lex + pulldown-cmark +
   DOMPurify), with per-block FNV-1a content hashes already on
   `SanitizedMarkdownBlock.contentHash`. Parses fire: (a) once at
   mount (pre-paint G1 read), (b) once per streaming emission
   (rAF-coalesced — a **pre-existing** rAF in the streaming
   reconciler, outside this plan's no-new-rAF rule), (c) fully on
   remount (diff state is a `WeakMap` keyed by container element).
   React re-renders do *not* re-parse ([L22] imperative DOM). So the
   replay-window parse bill is ≈ one parse per message — the
   dominant replay cost is the O(N²) commit/VDOM work in (2), which
   reorders the [#assumptions] ranking: **commit count × cell count
   first, parse second, translate pacing third.**
5. **[DT10] paint gate:** `visibility: hidden` during the window
   hides the accumulation visually but pays full commit/layout cost
   underneath — exactly what the fold (#step-2) removes.

#### Baseline numbers {#baseline-numbers}

Recorded 2026-06-12 on the dev machine via the at0182 measurement
app-test (real picker → spawn → tugcode → JSONL replay → render) and
a tugcode-level translate benchmark. "wall" is Open-click →
transcript fully committed; "ingest" is the store's replay window
(first `replay_started` dispatch → `replay_complete` notify).

**Per-resume waterfall (at0182, `getSessionPerf` + session-lifecycle log):**

| Fixture | JSONL | boot (resume) | read | translate+emit | tugcast forward | deck ingest | frames → commits | wall | parses (max/identity) |
|---|---|---|---|---|---|---|---|---|---|
| small (10 turns) | 14KB | 4–5ms | 0ms | 4ms / 43 msgs | 3ms / 42 frames | 150ms | 43 → 42 | **~410–740ms** | 10 (1) |
| medium (50 turns) | 517KB | 4–5ms | 0ms | 19ms / 203 msgs | 16ms / 202 frames | see note | 204 → 203 | **~1.9–2.6s** | 50 (1) |
| whale (2000 turns) | 53MB | 5ms | **7ms** | 2189ms / 8003 msgs (paced) | 2151ms / 8002 frames, **0 lagged** | page saturated | 8003 → ∅ | **> 7 min (never settled)** | — |

**Reading:** the server side of a medium resume totals **~25ms**
(read + translate + forward); the deck pays **~2s** for the same
work. Where the deck cost lands depends on mount order, both
measured: when the transcript host is already mounted (rebind / HMR
case), ingest spreads to ~2.1s across 203 synchronous one-per-frame
React commits; on a fresh bind the store ingests all 203 frames in
~5ms *before* the transcript mounts, and the cost concentrates in
the single post-replay mount render — wall stays ~2s either way.
**The render bill is the constant; delivery shape only moves it.**
This confirms (and sharpens) the #render-shape-audit ranking:
commit-count × cell-count (or one mount of all cells) dominates;
per-row parse already runs once per identity at baseline; translate
and IO are noise at medium scale.

**Whale reading:** the 53MB session *lists* in ~1s (cold scan is
sub-second — typed streaming parse) and the server pipeline
delivers all 8002 frames in ~2.2s end-to-end with zero broadcast
lag (capacity 1024, [R04] sensor clean at current pacing). The deck
then saturates the WebView main thread for **7+ minutes** without
settling — unresponsive enough that harness RPCs can't complete.
The at0182 whale leg is committed `test.skip` with this rationale
and re-enables once the deck-side fold lands.

**Post-fold re-measurement (#step-2, same at0182 path):**

| Fixture | ingest commits (was) | folds | wall (was) |
|---|---|---|---|
| small | **2** (42) | 1 | 420ms (~410–740ms) |
| medium | **2** (203) | 1 | 1976ms (~1.9–2.6s) |

The ≤5-commit goal is met with margin (2 commits: window open +
window close). Wall time in the fresh-bind flow barely moves because
there the cost was already concentrated in the single post-replay
mount render — which is precisely the render bill #step-4 (render
once) and #step-5 (paint only what's visible) shrink. The
rebind/HMR flow — where baseline ingest spread to ~2.1s of
per-frame commits — now collapses to the same 2 commits.

**Post-fold whale ([Q04] evidence):** ingest now folds cleanly, but
the single mount render of 2000 eagerly-mounted turns × 26KB
markdown **crashes the WebContent process** (~3.5min in, RPC
transport closed — OOM-class). Visibility-deferral keeps all DOM
alive, so [Q04] should weigh that a content-heavy 50MB whale may
exceed what `content-visibility` alone can carry — #step-5's
1k/5k/10k-row measurements decide, with #step-6 windowing as the
escalation. The at0182 whale leg stays skipped until a deferral
phase lands.

**Post-unpace re-measurement (#step-3, time-slice yield in place):**

| Fixture | translate+emit (was) | tugcast forward (was) | frames lagged |
|---|---|---|---|
| small | 3ms (4ms) | 0ms (3ms) | 0 |
| medium | **7ms** (19ms) | **5ms** (16ms) | 0 |
| whale | 2197ms (2189ms) | 2162ms (2151ms) | **0** |

[R04] reading: zero lagged frames at every scale — the unpaced burst
never overruns the CODE_OUTPUT broadcast (capacity 1024) because the
pipeline's natural backpressure (the IPC pipe plus the bridge's
awaited mpsc send to the merger) throttles delivery well below
overrun. The whale's translate+emit wall is UNCHANGED by unpacing:
at 53MB the bound is IPC/bridge throughput (~25MB/s of per-line
scanning, session-id splicing, and per-frame forwarding), not the
old pacing — the in-memory bench (42ms) shows what the translate
itself costs. That 2.2s bridge leg is the genuine server-side whale
long pole and is exactly the frame-count pressure #step-7's gated
coalescer would address if whales need it; medium-scale resumes get
the full win (translate+forward now ~12ms total).

**Post-render-once re-measurement (#step-4, parse cache + memoized
rows):** medium replay — parses 50 (one per row, `maxParsesPerIdentity
= 1`), **memoHits 100** (every committed cell skips the window-close
re-render), cacheHits 0 on a cold first replay by design (population
happens at first render; hits arrive on remounts, tab switches, and
every finalized row's re-render during live turns). Live-path
consequence: a snapshot tick now re-renders only the in-flight row —
commit cost no longer grows with transcript length.

**Post-deferral re-measurement (#step-5, `content-visibility` +
intrinsic sizes + warm queue on top of fold + render-once):**

| Fixture | wall (step-4 was) | baseline was |
|---|---|---|
| small | **392ms** (414ms) | ~410–740ms |
| medium | **774ms** (~1.9s) | ~1.9–2.6s |

The deferral collapsed the medium mount render: off-screen rows skip
layout and paint, so the window-close commit only pays for the
viewport. Medium now sits at the plan's 750ms dev-machine target
(±run variance — the remaining wall is dominated by the spawn →
`request_replay` round trip, #step-9's territory). The small leg
also showed the warm queue beating the mounts outright (10/10 rows
were cache hits on one run).

**Post-windowing re-measurement (#step-6 — transcript flips from
inline to windowed mounting above 1200 rows; selection/focus rows
pinned via the window clamp):**

| Fixture | windowed wall | pre-windowing |
|---|---|---|
| at0182 whale (53MB, 4k rows × 26KB) | **2.66s end-to-end** (lists 339ms; 34 commits / 33 folds) | WebContent OOM / 7+ min wedge |
| rows-5k | **626ms** | 40.5s |
| rows-10k | **832ms** | wedged (>420s) |
| rows-1k / medium / small | unchanged (stay inline below the threshold) | — |

All six at0182/at0183 legs are now ACTIVE assertion gates (nothing
skipped). The trade documented in code: above the threshold,
never-mounted rows use height estimates (scrollbar approximation)
and cross-document selection is bounded by the pin — below it, the
inline mode's full fidelity is untouched.

**Row-count scaling ([Q04], at0183 — fold + render-once + warm queue
+ `content-visibility` all in place):**

| Scale | rows | JSONL | wall | full-range scroll jumps | ingest (frames → commits / folds) | parses (max/id) | warm-queue pre-parses |
|---|---|---|---|---|---|---|---|
| rows-1k | 1,000 | 769KB | **2.4s** | **4ms** | 2003 → 10 / 8 | 500 (1) | — |
| rows-5k | 5,000 | 3.9MB | 40.5s | 823ms | 10003 → 42 / 40 | 2500 (1) | **1264 cacheHits** |
| rows-10k | 10,000 | 7.7MB | wedged (>420s) | — | — | — | — |

[Q04] reading: visibility-only deferral carries ~1k rows comfortably
and runs out between 1k and 5k — the 5k mount still builds DOM for
every row (the deferral skips paint, not our JS), and 10k never
settles. **#step-6 windowing proceeds.** Side validation: the warm
queue pre-parsed 1264 of the 5k run's rows during the fold window
([P08] working as designed — those mounts were pure cache hits).

**Cold translate cost ([Q03]) — tugcode-level bench, in-memory JSONL:**

| Corpus | bytes | messages | unpaced (`disableYield`) | paced (production, 16/`setTimeout(0)`) |
|---|---|---|---|---|
| medium | 474KB | 203 | 2ms | 15ms |
| whale rows | 4.7MB | 8003 | 8ms | 644ms |
| whale bytes | 53.5MB | 8003 | **42ms** | 621ms |

[Q03] reading: cold translate of a 53MB session is **42ms** — two
orders of magnitude under the ~500ms replay-cache trigger
([P05]/[P06]). #step-8 is expected to close "not needed" at its gate
check after #step-2/#step-3 re-measurement. The pacing tax (~600ms
of forced macrotask idles at 8k messages) is #step-3's measured win.

**Picker fall-through finding (out of this plan's replay scope,
recorded for follow-up):** the picker's Enter handling can fall
through to a no-selection submit — which opens a NEW session at the
typed path and dismisses the picker. The at0181-style
Tab→Tab→Enter recents commit reproduced this reliably against the
whale fixture (three runs) while small/medium escaped it; the
fixed at0182 flow relies on the recents list's mount-time selection
seed (which fills the path field with no keyboard dance) and the
fall-through no longer triggers. A user typing a path and pressing
Enter at the wrong moment can plausibly hit the same fall-through —
worth a dedicated look outside this plan.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun, pure logic)** | Fold = N single dispatches (state equivalence); parse/memo/commit counters; cache key/invalidation; warm-queue ordering and cancellation | tugcode + tugdeck stores, no DOM |
| **Unit (Rust)** | (Gated steps) coalescer chunking/flush triggers, intercept preservation, replay_cache validity/sweep | tugcast |
| **Golden / Contract** | Folded ingest deep-equals per-frame ingest on a shared fixture | both store paths |
| **App-test** | Latency budget, parse-once across real interactions (resume → live turn → tab switch), whale first-paint + scroll, [L23] selection survival | `just app-test` |

#### What stays out of tests {#test-non-goals}

- Mock-store call-count tests — all counters are real store/cache
  instrumentation asserted through the real reducer and real cache.
- Fake-DOM render tests — render behavior (visibility deferral, selection
  survival, scroll) is asserted in the app-test against the real app.
- Tight wall-clock CI gates — CI asserts machine-insensitive counters and a
  generous ceiling ([R06]); the 750ms target is a dev-machine checkpoint.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Instrumentation + baseline + invariant/render audits | done | `0a6f15f5` |
| #step-2 | Deck-side replay fold (one commit per flush) | done | `0c533b3e` |
| #step-3 | Unpaced translate loop + channel-capacity guard | done | `333c9204` |
| #step-4 | Render-once cache + memoized finalized rows | done | `085db40c` |
| #step-5 | content-visibility deferral + speculative warm | done | `13b024af` |
| #step-6 | True transcript windowing (gated by [Q04]) | done | `68d017ef` |
| #step-7 | Wire-level replay_batch coalescer (gated) | closed — not needed | see step close-out |
| #step-8 | replay_cache + pre-warm (gated by [Q03]) | closed — not needed | see step close-out |
| #step-9 | Startup-path trims (gated) | closed — not needed | see step close-out |
| #step-10 | App-test budgets | done | `6efaa667` |
| #step-11 | Integration checkpoint | done | verification only — workspace 1027, tugdeck 3588 + tsc, tugcode 583, budget app-test PASS |

#### Step 1: Instrumentation + baseline + invariant/render audits {#step-1}

**Commit:** `Instrument the transcript pipeline; audit row immutability and render shape`

**References:** [P01] Measure first, Spec S02, [Q02], [Q03], Risk R01, (#context, #s02-timings)

**Artifacts:**
- Spec S02 emissions at every point (replay stages, live-turn commit rate,
  parse/memo counters wired even before the cache exists — counting raw parses)
- Dropped-frame telemetry on the tugcast forward path ([R04] sensor)
- **Immutability audit:** every reducer event inventoried against "finalized
  rows never change," result table recorded in this plan ([R01]) — including
  the monitor/job-ledger events recently added by monitors-in-jobs
  (`56217182`), which mutate Z2 JOBS state and must be confirmed to never
  touch transcript row content
- **Render-shape audit ([Q02]):** mounting, memoization, [L26] identity-input
  status, where markdown parses — recorded alongside
- Baseline waterfall (small ~10 turns / medium ~50 turns ~500KB / whale ≥50MB)
  recorded under `#baseline-numbers`

**Tasks:**
- [ ] Emit Spec S02 signals via `logSessionLifecycle` / tracing / `tugDevLogStore`
- [ ] Count store notifies inside the replay window; count live-turn commits per turn
- [ ] Count markdown parses per row identity (pre-cache: every parse increments)
- [ ] Run both audits; record tables + baseline numbers in the plan
- [ ] Resume the three fixtures and record the waterfall

**Tests:**
- [ ] Pure-logic: counters increment/reset correctly per replay window and per turn
- [ ] tugcode unit: perf lines emitted with plausible (>0) values during a fixture replay

**Checkpoint:**
- [ ] `cd tugcode && bun test` and `cd tugdeck && bun test && bunx tsc --noEmit`
- [ ] Baseline + audit tables committed into the plan with real numbers

---

#### Step 2: Deck-side replay fold (one commit per flush) {#step-2}

**Depends on:** #step-1

**Commit:** `Fold replay-window events into single store commits (L02)`

**References:** [P03] Deck-side fold, Spec S02, [Q01], (#state-zone-mapping, #success-criteria)

**Artifacts:**
- `CodeSessionStore` buffers decoded events while `replaying`; folds + notifies
  once per flush (semantic triggers only: `replay_complete`, 250-event
  threshold, transport close/teardown — no timers, no rAF)
- Medium-fixture commit count ≤5 in the counters

**Tasks:**
- [ ] Implement the fold with deferred notifies; flush triggers exactly as [P03]
- [ ] Cross-check tuglaws; name [L02] (and the deliberate absence of rAF per [L05]/[L13]) in the commit body
- [ ] Re-measure fixtures; update the baseline table

**Tests:**
- [ ] Golden: folded ingest of a fixture stream deep-equals per-frame ingest (same final state)
- [ ] Pure-logic: one notify per flush; teardown mid-replay flushes (nothing stranded); commit counter ≤5 on the medium fixture
- [ ] Pure-logic: live frames after `replay_complete` dispatch singly, untouched

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`
- [ ] Recorded medium-fixture commits ≤5 and ingest time materially down

---

#### Step 3: Unpaced translate loop + channel-capacity guard {#step-3}

**Depends on:** #step-1

**Commit:** `Replace per-16-entries replay pacing with a time-slice yield`

**References:** [P02] Unpaced translate, Risk R04, (#q03-translate-cost, #s02-timings)

**Artifacts:**
- `translateJsonlSession` yields only after ≥8ms of continuous work
- Measured peak frame rate vs tugcast broadcast capacity recorded ([R04]);
  dropped-frame telemetry confirmed zero on all three fixtures

**Tasks:**
- [ ] Swap the batch-count yield for the time-slice check; keep `disableYield` semantics
- [ ] Verify channel capacity headroom against the measured whale frame rate; record the margin
- [ ] Re-measure fixtures

**Tests:**
- [ ] Existing replay suites green unchanged
- [ ] Pure-logic: yield fires under a forced-slow clock, not on fast medium runs

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] Whale replay shows zero dropped frames; medium translate time drops in the numbers

---

#### Step 4: Render-once cache + memoized finalized rows {#step-4}

**Depends on:** #step-1, #step-2

**Commit:** `Render finalized transcript rows once: identity-keyed parse cache + stable memoization (L26, L02)`

**References:** [P04] Render-once, Spec S03, [Q02], Risk R01, Risk R02, (#s03-render-cache, #state-zone-mapping)

**Artifacts:**
- Per-session parse/derivation cache per Spec S03, with parse/cache-hit/memo-hit counters
- Row components memoized with all three [L26] identity inputs audited and
  stabilized (key, component type, renderer reference) across the
  streaming→finalized transition
- Live path: streaming tail parses live; finalization populates the cache once

**Tasks:**
- [ ] Implement the cache (structure-zone store, pure render-time lookup, explicit invalidation API)
- [ ] Fix any identity instabilities the #step-1 audit found; memoize rows
- [ ] Wire the counters into TugDevPanel; re-measure fixtures + a live-turn run

**Tests:**
- [ ] Pure-logic: parse-once across finalize → re-render → identity-stable remount; invalidation drops exactly the named entry
- [ ] Pure-logic: memo/parse counters — a live append to a 200-row transcript parses only the tail ([R02] pin)
- [ ] Golden: cached and uncached renders produce identical row output for a fixture corpus

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`
- [ ] Counters: zero re-parses of finalized rows across the medium fixture's full replay + one live turn

---

#### Step 5: content-visibility deferral + speculative warm {#step-5}

**Depends on:** #step-4

**Commit:** `Defer off-screen transcript paint via content-visibility; warm the parse cache speculatively`

**References:** [P08] Speculative warm, [P09] Visibility phases, [Q04], Risk R03, Risk R05, (#state-zone-mapping)

**Artifacts:**
- `content-visibility: auto` + `contain-intrinsic-size` (from `BlockHeightIndex`
  estimates) on transcript rows — CSS only
- Cooperative warm queue per [P08]: nearest-to-viewport-first, time-sliced,
  cache-writes only, cancelled with the session; **no rAF**
- Whale measurements for [Q04]: scroll smoothness, memory, commit cost at
  1k/5k/10k rows — recorded in the plan

**Tasks:**
- [ ] Apply visibility CSS; verify selection/find/scroll on the real app ([R03])
- [ ] Implement the warm queue; verify it yields to user-triggered work
- [ ] Record [Q04] numbers; decide #step-6's gate

**Tests:**
- [ ] Pure-logic: warm-queue ordering (overscan-first), time-slicing, cancellation, and synchronous-priority handoff
- [ ] App-test additions deferred to #step-10 (scroll/selection legs)

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`
- [ ] Whale scroll hits warm cache (cache-hit counter ≈ 100% during scroll); [Q04] numbers recorded

---

#### Step 6: True transcript windowing (gated by [Q04]) {#step-6}

**Depends on:** #step-5

**Commit:** `Window the transcript for whale-scale transcripts` *(or close as not-needed with numbers)*

**References:** [P09] Visibility phases, [Q04], Risk R03, (#state-zone-mapping)

**Artifacts:**
- Either: windowed mounting with selection/focus-pinned rows, [L26]-stable
  identity across membership changes, height-index scroll anchoring — or a
  ledger close-out citing [Q04]'s numbers

**Tasks:**
- [ ] Gate check on [Q04]
- [ ] If proceeding: implement under the [P09] constraints; name [L23]/[L26]/[L24] in the commit; re-measure whales

**Tests:**
- [ ] If proceeding: pure-logic window-range/pinning math; selection survival to the app-test

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`; numbers recorded either way

---

#### Step 7: Wire-level replay_batch coalescer (gated) {#step-7}

**Depends on:** #step-2, #step-3

**Commit:** `Coalesce replayed frames into replay_batch in tugcast` *(or close as not-needed with numbers)*

**References:** [P07] Wire batch gated, Spec S01, [Q01], Risk R04, (#s01-replay-batch)

**Artifacts:**
- Either: the Spec S01 coalescer in the merger (downstream of intercepts, full
  flush-trigger set, capability gate, bit-exact fallback) — or a ledger
  close-out citing #step-3's channel-headroom numbers

**Tasks:**
- [ ] Gate check: proceed only if frame-rate vs channel-capacity margins ([R04]) or measured per-frame dispatch overhead demand it
- [ ] If proceeding: implement per Spec S01; document the "intercepts upstream, coalescing downstream" rule in module docs

**Close-out (not needed, with numbers):** zero `frames_lagged`
events at every measured scale, including 16,037 frames on the
10k-row replay (CODE_OUTPUT capacity 1024 never overran — the
pipeline's natural backpressure throttles the unpaced burst). Deck
per-frame dispatch is also a non-cost post-fold: 16k frames ingest
in 437ms across 66 commits. The one remaining frame-count cost is
the bridge's per-line processing on 50MB-class whales (~2.2s) — but
that sits UPSTREAM of where Spec S01 would coalesce (the merger),
so the coalescer wouldn't buy it back. Revisit only if a future
transport shows real lag (the [R04] sensor stays wired).

**Tests:**
- [ ] If proceeding — Rust: intercept preservation verbatim; chunk caps; flush on `replay_complete` / window abort / max-hold; capability-absent client gets the legacy stream bit-for-bit. Deck: batch fold reuses #step-2's path (golden equivalence)

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`; numbers recorded either way

---

#### Step 8: replay_cache + pre-warm (gated by [Q03]) {#step-8}

**Depends on:** #step-3

**Commit:** `Cache translated replay streams keyed (size, mtime); pre-warm recently listed sessions` *(or close as not-needed)*

**References:** [P05] Single translator, [P06] Replay cache, [Q03], (#p06-replay-cache)

**Artifacts:**
- Either: `replay_cache` table (size caps, sweep) + tugcode read/write +
  headless `--translate-only` pre-warm orchestrated post-`list_sessions` — or
  a ledger close-out citing [Q03]'s numbers

**Tasks:**
- [ ] Gate check on [Q03] after #step-2/#step-3 re-measurement
- [ ] If proceeding: table + methods mirroring the scan-cache shape; tugcode cache path; pre-warm with concurrency caps, orchestrated on the detached-work-then-settle pattern the two-phase `list_sessions` established (`7a80fabf`); JSONL paths via the `resolve_to_claude_form` chokepoint

**Close-out (not needed, with numbers):** [Q03] resolved against the
cache. Cold translate is 42ms at 53MB (two orders of magnitude under
the ~500ms trigger); read is 7ms. On the user-visible path the
medium resume's translate+forward totals ~12ms, and the whale's
2.2s server leg is IPC/bridge THROUGHPUT-bound — a cached translated
stream would still cross the same pipe and bridge, saving only the
~42ms parse. The cache cannot buy back anything measurable; the
[P05] Rust-port trigger is equally unfired.

**Tests:**
- [ ] If proceeding — Rust: validity key, size cap, sweep, pre-warm caps. tugcode: hit skips translate; stale key re-translates

**Checkpoint:**
- [ ] Suites green; a listed-then-resumed fixture shows translate ms ≈ 0 — or close-out recorded

---

#### Step 9: Startup-path trims (gated) {#step-9}

**Depends on:** #step-1

**Commit:** `Trim resume startup latency ahead of the first replay frame` *(or close as not-needed)*

**References:** [P01], Spec S02, (#context)

**Artifacts:**
- Whatever the boot/round-trip splits justify (candidates: supervisor
  auto-queues replay for resume spawns collapsing the `request_replay`
  round-trip; tugcode boot trims) — or a close-out with numbers

**Tasks:**
- [ ] Gate check on Step-1's splits; implement the winning trim(s); re-measure

**Close-out (not needed, with numbers):** the candidate trim — the
supervisor auto-queueing replay to collapse the `request_replay`
round trip — turns out to ALREADY exist: the lifecycle timeline
shows `request_replay.queued reason=spawning_window` 10ms after
`spawn.supervisor_recv`, drained at the Spawning→Live promotion.
tugcode boot is 34ms wall from child-invoke to ready (`perf.boot`
5ms internal). Server-side total for a medium resume is ~55ms of a
~780ms harness-measured wall; the remainder is deck plumbing, the
final render, and harness poll quantization — nothing startup-path
work could trim. Medium sits at the 750ms dev-machine target with
the 2s ceiling held at 2.5×+ margin.

**Tests:**
- [ ] Suites green; HMR remount re-replay semantics preserved

**Checkpoint:**
- [ ] Recorded first-frame latency drop, or close-out with numbers

---

#### Step 10: App-test budgets {#step-10}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `app-test: transcript latency, parse-once, and whale budgets`

**References:** Spec S02, Spec S03, Risk R03, Risk R06, (#success-criteria, #test-non-goals)

**Artifacts:**
- App-test(s) seeding fixtures via at0181's builder, asserting: medium resume
  under the 2s ceiling with internal splits in budget (commits ≤5, parse-once
  counters clean); parse-once across resume → live turn → tab-switch round
  trip; whale first rows before `replay_complete` + smooth-scroll cache-hit
  leg; selection placed in the transcript survives the visibility machinery
  ([L23] leg)
- The 750ms dev-machine number recorded in the ledger

**Tasks:**
- [ ] Fixture generators (medium + whale); resume flow per at0181's proven path
- [ ] Read counters back out of the page (TugDevPanel store) for split assertions

**Tests:**
- [ ] The app-test itself, ending with the greppable `VERDICT: PASS|FAIL` line

**Checkpoint:**
- [ ] `just app-test <file>` → `VERDICT: PASS`, dev-machine wall time noted in the ledger

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-10

**Commit:** `N/A (verification only)`

**References:** [P01]–[P09], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify the full surface together, including every gated step's close-out rationale; confirm replay suites green and intercepts intact

**Tests:**
- [ ] Full suites green

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`
- [ ] `cd tugcode && bun test`
- [ ] `just app-test <budget test>` → `VERDICT: PASS`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A transcript pipeline that is fast by architecture: replay
folds to a handful of commits, finalized rows render exactly once ever,
off-screen rows cost nothing to keep and are pre-warmed before the user reaches
them — with every piece of heavier machinery (windowing, wire batching, replay
cache) either landed on measured evidence or closed out with the numbers that
made it unnecessary.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Per-resume waterfall + live-turn counters visible in TugDevPanel (Spec S02)
- [ ] Medium fixture: ≤5 commits, parse-once counters clean, app-test budget green
- [ ] Incremental path: live appends on a long transcript re-render only the tail (counter-asserted)
- [ ] Whale: first rows before translation completes; warm-cache scrolling; no timeout trips
- [ ] [L23] leg green: selection/focus/scroll survive visibility machinery
- [ ] Immutability and render-shape audit tables recorded in the plan; every gated step landed or closed with numbers
- [ ] No rAF introduced anywhere by this plan (grep-verifiable)

**Acceptance tests:**
- [ ] `cargo nextest run` green with `-D warnings`
- [ ] `bun test` (tugdeck, tugcode) green
- [ ] Budget app-test `VERDICT: PASS`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Rust port of the translator — only if the [P05] trigger fires
- [ ] Render-once cache reuse for the rewind sheet's transcript preview
- [ ] Cross-session parse-cache persistence (would require revisiting the no-client-persistence constraint)

| Checkpoint | Verification |
|------------|--------------|
| Rust suites | `cd tugrust && cargo nextest run` |
| Frontend suites | `cd tugdeck && bun test && bunx tsc --noEmit` |
| Bridge suite | `cd tugcode && bun test` |
| End to end | `just app-test` budget test → `VERDICT: PASS` |
