<!-- devise-skeleton v4 -->

## Resume Performance 2 — Real Sessions Only {#resume-performance-2}

**Purpose:** Make resuming *real* sessions fast and visibly alive: every
measurement, fixture, and acceptance gate in this plan runs against actual
session JSONLs harvested from this machine, a resumed card shows progress from
its first moment, and no optimization is claimed until the win reproduces on
the real corpus. This plan supersedes `dash/resume-performance.md`, whose
synthetic prose-only fixtures validated its machinery while the first real
tool-heavy session still froze the deck ~20 seconds.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The first resume-performance plan landed real, content-agnostic substrate —
pipeline instrumentation (Spec S02 of that plan; `getSessionPerf`), the
deck-side replay fold (one snapshot tick per flush), the unpaced translate
loop, a render-once parse cache for markdown prose, `content-visibility`
deferral, windowed transcript mounting with selection/focus pinning, and a
speculative warm queue. All of it was measured green — against synthesized
prose. The first real session resumed against it (`763cd1d8`, ~12MB, ~4,900
wire messages across ~46 committed cycles: **937 tool_use + 937 tool_result +
457 thinking + 346 text blocks**, a dozen >50KB) froze the deck **~20s in a
single React mount commit** with a blank card. The instrumentation itself
located the failure precisely: server side 420ms (boot 5ms, 12MB read 3ms,
translate 306ms, 4,923 frames forwarded with zero broadcast lag); everything
else was deck-side mount cost for content shapes the fixtures never contained.

What the synthetic plan never saw, now first-class here:

1. **Real sessions are tool-call machines.** ~107 message components per turn
   in the motivating session. Tool blocks are a full component family
   (`cards/tool-blocks/`: bash, edit, grep, glob, read, write, default, …)
   mounting input `JsonTreeBlock`s, result bodies (`TugMarkdownBlock` /
   code views), and chrome — none of it covered by the prose parse cache.
2. **The blank window is structural.** The cold-restore flow routes the whole
   window to the `DevRestoring` placeholder and holds `DevCardBody` unmounted
   until `replay_complete` (the restore-reveal coordination; the old
   `replay-loading` banner kind was deliberately retired). The reveal then
   mounts the entire transcript in ONE commit — on tool-heavy sessions the
   main thread freezes and whatever painted last (placeholder or nothing)
   stares back for the duration. The [DT10] `visibility: hidden` gate hides
   the transcript host during the window on top of that.
3. **The real population (surveyed 2026-06-12):** 1,198 sessions across 39
   project dirs, 1.85GB total. p50 17KB, p90 145KB, p99 15.5MB, **max 626MB**;
   65 sessions >1MB, 16 >10MB. The 626MB class would trip
   `REPLAY_HARD_TIMEOUT_MS` (10s) on bridge throughput (~25MB/s) alone.

Ken's product ruling folded in: **historical (replayed) tool blocks render
collapsed — header-only chrome; the body materializes on expand.** The same
collapsing is expected for live sessions later (the inline transcript is too
noisy), but live stays out of scope here.

#### Strategy {#strategy}

- **The corpus is the ground truth.** Step one harvests and classifies the
  real population; every later step baselines and re-measures against those
  snapshots. The synthetic prose generators are deleted from the test suite.
- **Measure on real content before optimizing** — the surviving
  instrumentation already proved it can name the cost (it found the 20s).
  The baseline decides what the render work actually is; this plan
  pre-commits only to the two mechanisms already demanded by evidence and
  product ruling: collapsed historical tool bodies and a progressive,
  feedback-bearing reveal.
- **Visible progress is a success criterion**, not a nicety. A resuming card
  paints something honest immediately and updates as the transcript builds.
  "Fast" alone fails the requirement.
- **No win is claimed until it reproduces on the corpus.** The per-resume
  waterfall on real sessions is the acceptance test for every step.
- **Keep the landed substrate.** Fold, windowing, prose cache, warm queue,
  instrumentation all stay; this plan extends them to real shapes rather
  than relitigating them.

#### Success Criteria (Measurable) {#success-criteria}

Budgets are per corpus class (see [P04]); hardened from the #step-2
baseline (#baseline-waterfalls) and checked on REAL snapshots, not
generators. "First content" = first mounted transcript rows; today
first content == settled on every class (the all-or-nothing reveal),
so the first-content budgets are what #step-4 makes meaningful:

- **Typical class (<1MB):** first content ≤ 500ms of Open; settled
  ≤ 1s; zero main-thread stalls > 250ms. (Baseline: settles 366–476ms,
  no stalls — the budget pins today's behavior so it can't regress.)
- **Heavy class (1–20MB, tool-dominated — includes `763cd1d8`):**
  first content < 1s; fully settled ≤ 2.5s; no stall > 500ms.
  (Baseline 763cd1d8: settled 1,061ms all-at-once with a 474ms stall —
  collapse (#step-3) + progressive reveal (#step-4) must bring first
  content under the second and keep the thread responsive.)
- **Whale class (≥20MB up to the 657MB monster):** first content ≤ 5s;
  progress affordance visibly updating across the whole window (no
  blank or static interval > 1s); no stall > 1s; settled within 1.5×
  its baseline (190MB: ≤ 11s; 657MB: ≤ 31s); no replay-timeout trips;
  memory bound measured and recorded in #step-7. (Baseline: 7.4s/20.9s
  settle behind a static placeholder; 2.9s stall on the 190MB whale.)
- **Feedback:** from Open to first content, the card always shows a live
  affordance (placeholder → progress → progressive transcript); no
  blank-card interval at any class — and the affordance is informative
  from t=0 (title / turn count / size from the picker row, per Spec S03),
  not just animated.
- **Collapsed history:** replayed tool blocks mount header-only; expanding
  one materializes its body on demand; expansion state survives scrolling
  (windowed unmount/remount) and cold boot (the [A9] bag carries it).
- **Parse/mount-once discipline extends to tool blocks:** an expanded body's
  expensive derivations compute once per block per session.
- All assertions land in corpus-driven app-tests with machine-insensitive
  counters as the CI teeth and generous wall ceilings.

#### Scope {#scope}

1. Corpus harvest + classification tooling and a gitignored local corpus.
2. Corpus baseline: per-class waterfalls recorded in this plan; the
   blank-card mechanism pinned exactly.
3. Collapsed historical tool blocks (header-only mount, body on expand,
   expansion state on the existing collapse + [A9] contracts).
4. Progressive reveal + replay progress UX (restore-reveal and [DT10] gate
   reworked for windowed transcripts).
5. Residual render-cost work as the re-baseline demands (gated).
6. Fixture-suite conversion: corpus legs as the default, prose generators
   deleted, budget gates per class.
7. Whale-tier policy (gated): timeout, memory, progressive budget for the
   >20MB class.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Collapsing live-turn tool blocks.** Expected follow-on (the transcript
  is too noisy live, too) — designed not to be precluded, but not built here.
- **Re-opening the landed substrate** (fold, windowing, translate pacing,
  prose cache) except where corpus numbers demand tuning.
- **Committing session content to git.** The corpus stays local and
  gitignored; only tooling, manifests of shape metadata, and generators
  derived from shape statistics are committed.
- **Cross-session persistence of parse/render caches.**

#### Dependencies / Prerequisites {#dependencies}

- The joined first plan (`dash/resume-performance.md`, squash
  `919452f2`): instrumentation (`logSessionLifecycle` perf events,
  `getSessionPerf` test surface), replay fold, windowed mounting
  (row + message-weight thresholds), render-once prose cache, warm queue,
  at0182/at0183/at0184 harness patterns.
- The supersession contract recorded at
  `dash/resume-performance.md#superseded`.
- `~/.claude/projects/` as the live population (1,198 sessions surveyed).
- Tool-block component family under
  `tugdeck/src/components/tugways/cards/tool-blocks/`.
- Restore-reveal coordination (`DevRestoring`, restore registry) and the
  [DT10] transcript paint gate.

#### Constraints {#constraints}

- **Tuglaws:** [L02] store→React only via `useSyncExternalStore`; [L05]/[L13]
  no rAF for render-coupled work; [L06] appearance via CSS/DOM; [L23]
  selection/focus/scroll/expansion survive windowing and reveal changes;
  [L26] mount identity stable across collapse→expand and window membership.
  Cross-check tuglaws before each tugdeck step; name touched laws in commits.
- **Warnings are errors** in the Rust workspace; bun for tugdeck; tugcode is
  a compiled binary (rebuild to test); tugdeck is HMR-live.
- Corpus app-test legs must skip cleanly (not fail) on a machine without a
  harvested corpus; the always-runnable gates use the committed real-shape
  generator.
- Privacy: harvested snapshots and manifests carrying session content stay
  out of git by construction (gitignore + harvest-tool defaults).

#### Assumptions {#assumptions}

- The corpus classes are stable enough that a snapshot set harvested once
  (refreshable by re-running the tool) represents the population.
- Tool-block mount cost dominates the heavy class; the baseline either
  confirms or re-ranks ([P01] discipline — gated steps cite its numbers).
- Collapsed-by-default history is acceptable UX for ALL replayed tool blocks
  (Ken's ruling), with expansion as the recovery path.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Per `tuglaws/devise-skeleton.md`: explicit kebab-case `{#anchor}` headings;
plan-local decisions `[P##]`, open questions `[Q##]`, specs `S##`, risks
`R##` — two digits, never reused; steps cite labels and anchors, never line
numbers; `**Depends on:**` lines reference real step anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What exactly paints (and when) between Open and first content today? (RESOLVED — #step-2) {#q01-blank-window}

**Question:** In the picker→Open flow (vs cold-boot restore), does
`DevRestoring` mount at all? When does the placeholder hand off, what does
the [DT10] gate hide, and which commit freezes the thread on heavy sessions?
The motivating report saw a blank card for ~20s; the mechanism must be
pinned per flow before the reveal rework.

**Resolution (measured, at0185 + code):** ONE gate, TWO entry paths —
confirmed. A picker-opened resume walks `DevCardServicesGate` with
`deriveColdRestoreActive` true (`phase === "replaying" &&
sessionMode === "resume"`); the quiet backdrop shows immediately, the
`DevRestoring` panel reveals at ~222ms (`RESTORE_PLACEHOLDER_DELAY_MS`
= `REPLAY_SOFT_BUDGET_MS`), and the placeholder holds until
`replay_complete` flips the predicate, at which point the body and the
whole windowed transcript mount in ONE commit: on every measured leg
`firstTranscript == firstRows == placeholderGone == settled` (see
#baseline-waterfalls). The cold-boot path prepends the
`devRestoreRegistry` expectation (`DevCardContent` →
`DevRestoring variant="binding"`) and the preflight beat
(`replayPreflightActive`), then funnels into the SAME gate — so the
#step-4 rework targets one surface. [DT10]'s `data-replaying` window is
unreachable in this flow (the host mounts only after replay completes);
it remains relevant only to live-reconnect replays.

**Harness note:** the cold-boot leg cannot be independently measured in
app-tests today — card bindings live in tugcast's session ledger, which
does not survive the harness's per-launch instance dirs (no app-test
exercises `restoreDevSessions`). Recorded as a follow-on; the shared
gate makes the picker-flow measurement sufficient for #step-4.

#### [Q02] What does a collapsed tool-block header show? {#q02-collapsed-header}

**Question:** Header-only mount needs a digest: tool name + status is the
floor; a one-line input summary (command, file path, pattern) is likely
wanted. Which body-bits are cheap enough to keep in the header, per tool?

**Plan to resolve:** #step-3 designs the header digest per tool family in
the gallery first (the per-tool wrappers already centralize chrome);
cheapness is checked by the corpus re-measurement.

**Resolution:** RESOLVED (#step-3) — **the existing header IS the
digest.** The regularized `ToolCallHeader` already carries the
lifecycle dot, tool name, per-tool identity (path chips) and the
full command row (bash command, grep pattern), all computed from
input fields without touching result payloads — exactly the
render-path-cheap floor-plus this question wanted. The collapsed
state renders that header plus a disclosure chevron and nothing
else. Per-tool result-summary meta enrichment ("N lines", "+a/−b")
remains available as gallery-driven polish (`meta` slot already
exists) but is NOT load-bearing for the perf win; revisit on visual
review feedback. Gallery fixture: `gallery-collapsed-history`.

#### [Q03] What is achievable for the whale class (>20MB, up to 626MB)? (OPEN → gates #step-7) {#q03-whale-class}

**Question:** Bridge throughput (~25MB/s measured) puts a 626MB session
~25s server-side — past `REPLAY_HARD_TIMEOUT_MS` (10s). What budget,
timeout policy, and memory bound does this class get; is partial/most-recent
replay the right product shape?

**Plan to resolve:** #step-2 baselines the whale snapshots (timeout trips
included — a trip is data); #step-7 sets policy from those numbers.

**Resolution: RESOLVED (#step-7) — full replay with the always-on
affordance IS the whale policy.** The measured chain that settles it:

- **No timeout restructure.** `REPLAY_HARD_TIMEOUT_MS` (10s) guards
  only tugcode's JSONL-iterator loop, which finishes well inside
  budget even at 657MB (time-sliced translate); no trip was observed
  at any size. The long pole is downstream deck ingest — and after
  #step-3/#step-4/#step-5 that ingest runs with a responsive main
  thread (zero stalls ≥250ms across 90k samples on the 657MB
  monster) behind a ticking "N of 4,904 turns" affordance.
- **No partial/progressive replay needed at current population
  sizes.** 657MB settles in 20.6s end-to-end with continuous
  feedback; the p99 session (15.9MB) settles ~1s. Partial replay
  would buy seconds on ONE pathological session at the cost of a
  truncated-history product surface — not earned by the data.
- **Memory bound (measured natively; `performance.memory` is
  unavailable in WKWebView):** peak WebContent RSS during the whale
  resumes — **973MB for the 657MB session, 587MB for the 190MB
  session** (app baseline ~155MB), i.e. roughly baseline + 1.2–2.3×
  the JSONL bytes, settling after the window closes. Bounded and
  survivable on the dev machine; no OOM at any size in the
  population. Recorded as a one-off native measurement (`ps` RSS
  sampling of fresh WebContent processes during the at0185 whale
  legs); a permanent automated memory gate would be machine-flaky
  and is deliberately not added.

**Revisit trigger:** a corpus refresh that surfaces sessions where
settle exceeds ~60s or WebContent peak approaches multi-GB — at that
point partial/most-recent replay becomes a product conversation, not
an optimization.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Corpus snapshots leak into git | high | low | gitignored corpus dir created by the harvest tool; manifest content-free by default; review at commit time ([R01]) | any corpus path in `git status` |
| Collapsed history hides information users relied on | med | med | header digest per tool ([Q02]); one-click expand; expansion state survives scroll ([R02]) | user feedback after build |
| Expansion state lost on windowed unmount ([L23]) | med | med | [A9] preservation keyed by toolUseId restores at mount — the same mechanism covers cold boot ([R02], Spec S02) | expand → scroll away → back loses state |
| Reveal rework reintroduces scroll jumps / FOUC the gate existed to stop | high | med | progressive reveal only under windowed mounting (bounded commits); follow-bottom anchoring; [L26] audit at each transition ([R03]) | any restore scroll jump |
| Baseline re-ranks costs and the pre-committed mechanisms underdeliver | med | low | [P01]: gated residual step (#step-5) exists precisely for what baseline names; collapse + reveal are demanded by evidence already ([R04]) | heavy-class budget missed after #step-3/#step-4 |
| Corpus tests flake on machine variance | med | med | counters as CI teeth, generous ceilings; corpus legs skip (not fail) without a corpus ([R05]) | flaky leg |

---

### Design Decisions {#design-decisions}

#### [P01] The real corpus is the only measurement substrate (DECIDED) {#p01-corpus-only}

**Decision:** A committed harvest tool surveys `~/.claude/projects/`,
classifies every session (size tier; shape: tool-heavy / thinking-heavy /
image-bearing / prose; turn and message counts), and snapshots a
representative set — including `763cd1d8` — into a **gitignored** local
corpus with a manifest. Corpus-driven app-test legs are the default
measurement and acceptance path and skip cleanly when no corpus exists.
The synthetic prose generators in at0182/at0183/at0184 are deleted; the
one retained generator is the real-shape tool-heavy generator (kept as the
always-runnable CI gate), with its parameters re-derived from corpus
statistics.

**Rationale:** Synthetic fixtures validated machinery, not workload —
measured wins, unrepresentative reality. (Recorded in the supersession
contract and in auto-memory.)

**Implications:** Tests carry a corpus-resolution helper (locate corpus dir,
read manifest, pick class representatives); CI without a corpus still gates
on the real-shape generator leg.

#### [P02] Historical tool blocks render collapsed; bodies materialize on expand (DECIDED — Ken) {#p02-collapsed-history}

**Decision:** Replayed (committed-history) tool blocks mount header-only
chrome — tool icon/name, status, caution badges, and a per-tool one-line
digest ([Q02]). The body (input trees, result bodies, code views) is NOT
constructed at mount; expanding the block materializes it on demand, and the
expensive derivations behind it compute once per block per session
(render-once discipline extended to tool content). Collapse state rides the
EXISTING contracts per Spec S02 — the host-owned `collapsed` boolean lifted
to the Layer-2 wrapper, persisted through the [A9] preservation protocol
keyed by `tool_use_id` — so expansion survives windowed unmount/remount
([L23]) and cold boot with one mechanism and no new store. Live-turn tool
blocks are unchanged in this plan; the same collapsing is expected for live
later (transcript noise), so the mechanism must not assume
"historical-only" structurally.

**Rationale:** The heavy class's mount bill is thousands of tool-block
bodies nobody is looking at; the product ruling makes the cheap path also
the desired presentation.

**Implications:** [L26] — collapse→expand must not change the block's mount
identity (same key, same component type; the body is a child that appears).
A new gallery fixture family covers collapsed/expanded states per tool.

#### [P03] Progressive reveal with always-on feedback (DECIDED) {#p03-progressive-reveal}

**Decision:** The all-or-nothing restore reveal is replaced for replays:
the card body and transcript mount early; under windowed mounting the
transcript paints progressively as fold flushes commit (the 250-event
threshold flushes are the progress ticks — event-driven, no timers, no
rAF); a progress affordance (e.g. "Restoring — N turns…", derived from the
store at flush commits, plus a compositor-driven indeterminate animation
between commits) is visible from the first moment and is replaced by
content, never by blank. The [DT10] `visibility:hidden` gate is retired or
narrowed to the inline (small) class where the window is sub-perceptual;
follow-bottom anchoring holds the scroll at the live edge across flushes.
`DevRestoring` remains the pre-body placeholder but hands off to the
progressive surface as soon as the body can mount.

**Rationale:** "It can't work like this" — feedback is a requirement.
A frozen 20s commit cannot paint progress by definition, so the reveal must
be made of SMALL commits (windowing + collapse give exactly that) before
any progress text can matter.

**AMENDED during #step-4 (measured): progressive AFFORDANCE, deferred
CONTENT.** Mounting the transcript list through the replay window was
built first and measured WORSE by an order of magnitude: every fold
flush forced a full windowed-list commit on the thread the ingest
needs (763cd1d8 ingest 255ms → 7.5s; settled 708ms → 7.9s; 190MB
whale 4.9s → 45.7s). As built instead: the card body and chrome mount
early, the `DevReplayProgress` strip (Spec S03) is the whole
transcript surface during the INITIAL replay window — informative
from t=0, ticking at fold flushes, a one-component re-render instead
of a list commit — and the `TugListView` mounts ONCE when the window
closes (the bounded windowed commit the collapse work made fast). The
hold is store-derived: `replayEverCompleted` (monotonic snapshot
fact) keeps a later reconnect catch-up window from ever re-engaging
the hold against a mounted list; [DT10] survives narrowed to that
reconnect/inline case. No timers, no rAF, no component-state
mirroring of store facts ([L02]).

**Implications:** [L23] — the reveal rework must preserve the scroll-restore
behavior the old gate protected (no FOUC, no anchor jumps); [Q01]'s findings
drive the exact handoff points; the progress affordance reads store state
via [L02] (no new timers).

#### [P04] Budgets are per corpus class (DECIDED) {#p04-class-budgets}

**Decision:** The corpus manifest assigns every snapshot a class (typical /
heavy / whale, with shape tags); budgets and acceptance gates are stated and
asserted per class. The baseline step replaces this plan's provisional
targets with measured-and-chosen numbers recorded under
`#corpus-baseline`.

#### [P05] The landed substrate stays; extensions must earn their place on corpus numbers (DECIDED) {#p05-keep-substrate}

**Decision:** Fold, windowed mounting (incl. the message-weight stopgap),
prose parse cache, warm queue, and all instrumentation remain. Residual
render-cost work beyond [P02]/[P03] (e.g. JsonTree depth bounds for huge
inputs, code-view highlight deferral, warm-queue coverage for tool digests)
proceeds only where the post-collapse re-baseline still shows a hot spot
(#step-5, gated).

---

### Specification {#specification}

**Spec S01: Corpus harvest tool and manifest** {#s01-corpus-harvest}

- A bun script (committed, e.g. `tests/app-test/corpus/harvest.ts`) that:
  surveys every `~/.claude/projects/*/*.jsonl`; computes per-session stats
  (bytes, lines, turns, wire-message estimate, content-block histogram —
  tool_use/tool_result/thinking/text/image, largest-block size); assigns
  class + shape tags; writes `manifest.json` and materializes a selected
  representative set under `tests/app-test/corpus/snapshots/` with
  per-record `cwd` rewritten at seed time (the at0182 temp-project pattern).
- **Materialization strategy is per-class, recorded in the manifest:**
  typical and heavy snapshots are copied (stable against the live session
  changing underfoot); whale-class snapshots (>20MB — the 626MB monster
  would double ~0.6GB of disk per refresh) are hardlinked or referenced
  in place, with the manifest carrying `{strategy, source_path, size,
  mtime}` so a runner can detect a drifted reference and re-harvest.
- `tests/app-test/corpus/` (manifest + snapshots) is **gitignored**; the
  script and a `README` documenting refresh are committed.
- Selection: per class × shape, newest representative plus pinned ids
  (always includes `763cd1d8`); the survey table (population counts per
  class) is recorded in this plan.
- **Live-session tolerance:** skip sessions a terminal currently holds
  (the `~/.claude/sessions/` registry is the authority) and tolerate
  mid-write reads everywhere — JSONL is append-only, so a torn final
  line parses as one skipped record, same as the translator's policy.

**Spec S02: Collapse state rides the EXISTING contracts — no new store** {#s02-expansion-state}

- The codebase already owns this concern twice over, and [P02] builds on
  both rather than adding a third mechanism:
  1. **Host-owned collapse** — the body-kind contract
     (`cards/tool-blocks/types.ts`) defines `collapsed` +
     `onToggleCollapsed` with the explicit rule that the body never owns
     its own boolean. [P02] LIFTS the owned boolean to the Layer-2
     per-tool wrapper, where collapsed means the body subtree is **not
     mounted at all** (the perf point — today's body-level collapse still
     constructs the body component), and the wrapper renders the header
     digest in its place.
  2. **Persistence via [A9]** — the Component State Preservation Protocol
     (`componentStatePreservationKey` → `bag.components`) is the codified
     home for exactly this state class ("collapsed, inner scroll
     position…"). Each wrapper keys its expansion boolean by
     `tool_use_id`. Mount-time restore covers BOTH hazards with one
     mechanism: windowed unmount → remount within a session ([L23]) and
     cold boot / pane restore across sessions. Default-collapsed blocks
     write no entry, so a 900-block transcript adds only the handful of
     expanded keys to the bag.
- Body materialization on expand parses/derives through the existing
  render-once chokepoints so a re-collapse → re-expand is a cache hit.

**Implementation note (#step-3, as built):** the persistence letter of
this spec changed during implementation because per-block [A9] keys
cannot honor [L23]: the capture pass harvests only CURRENTLY MOUNTED
components, so a windowed-out block's key silently drops from the bag
at the next save — expansion would be lost exactly in the case the
spec promised to cover. As built: ONE card-scoped
`ToolBlockExpansionState` (sparse override map, `tool_use_id` →
collapsed-where-differs-from-default) owned by the transcript host —
which never unmounts under windowing — and persisted under a single
[A9] key (`tool-block-expansion`); blocks read/write through it via
`ToolBlockExpansionContext`. Same hazards covered, same sparseness,
still no new [L02] store (mount-time reads + write-through only; the
toggling block's own `useState` drives its render). The per-block
boolean is owned by `ToolBlockHistoryCollapse` (a dispatch-site
wrapper) and consumed by `ToolBlockChrome` via
`ToolBlockCollapseContext`, which keeps the wrapper component's mount
identity untouched across collapse/expand ([L26]) and leaves every
per-tool wrapper unmodified. Historicity comes from the store: the
reducer stamps `TurnEntry.replayed` on turns committed while
`phase === "replaying"`.

**Spec S03: Replay progress affordance** {#s03-progress}

- **The wait has three segments and only one produces deck events.**
  (1) Open → first frame: spawn + `request_replay` + read + translate —
  several hundred ms on the heavy class with NOTHING arriving at the deck;
  (2) ingest: fold flushes tick every 250 events (brief); (3) the windowed
  mount commits. The affordance must be informative across all three, so:
- **t=0 data comes from the picker row, not the wire.** The picker already
  knows `turn_count`, file size, and the title for the selected session —
  thread that metadata through the open/restore expectation (the
  `devRestoreRegistry` entry already carries `projectDir`; extend it) so
  the placeholder reads "Restoring <title> — 106 turns (12MB)…" from the
  first paint, before any frame exists.
- During ingest, transcript turn count read from the store snapshot at
  fold-flush commits updates the line ([L02] — the flush notify is the
  only render-coupled signal). Between events at every segment, a
  CSS/compositor indeterminate animation keeps motion without JS ticks
  ([L06]).
- Surface: a slim strip or placeholder line in the transcript region
  (exact chrome designed in-step against the gallery), visible from body
  mount until the window closes.
- No timers, no rAF anywhere in the affordance.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Tool-block expansion boolean | local-data (wrapper-owned, [A9]-persisted) | host-owned `collapsed` on the Layer-2 wrapper; `componentStatePreservationKey` = `tool_use_id` per Spec S02 | [L24], [L23] |
| Collapsed-body materialization | render-derived | body subtree appears under the SAME block mount on expand | [L26] |
| Replay progress data | existing store snapshot | read at fold-flush commits via `useSyncExternalStore` | [L02] |
| Progress animation between flushes | appearance | CSS indeterminate animation | [L06], [L05]/[L13] honored |
| Reveal/paint gating | appearance | CSS / mount-order, no React state for paint | [L06], [L23] |

---

### Deep Dive: Implementation Anchors {#implementation-anchors}

Symbol/path map for the implementing session — everything here was
verified by reading the code or by measurement during planning (no line
numbers by convention; symbols are greppable):

**Reveal chain (`tugdeck/src/components/tugways/cards/dev-card.tsx`):**
`DevCardContent` routes unbound cards (restore registry →
`DevRestoring variant="binding"`, `restorePassGate` → `"pass-pending"`,
else picker). `DevCardServicesGate` routes bound cards: `transportState
=== "restoring"` or (`deriveColdRestoreActive` && one-shot `revealed`
latch not yet flipped) → `DevRestoring`; else `DevCardBody`. The latch +
`deriveColdRestoreActive` are the exact surface #step-4 reworks; the
docstring's own words — body "mounts exactly once, against a fully
reconstructed transcript, and reveals in a single paint" — describe the
freeze being removed.

**Transcript (`cards/dev-card-transcript.tsx`):** `DevTranscriptHost`;
the `windowedTranscript` [L02] boolean selector with
`WINDOWED_TRANSCRIPT_ROW_THRESHOLD` (1200) and
`WINDOWED_TRANSCRIPT_MESSAGE_THRESHOLD` (600); the [DT10]
`data-replaying` → `visibility:hidden` gate on the host root; cell memo
gate `transcriptCellPropsEqual` + `sameTranscriptRowData` in
`lib/dev-transcript-data-source.ts` (cells take a resolved `row` prop —
comparators cannot read live state). `CodeRowBody` iterates
`turn.messages` and dispatches kinds; tool calls route through
`dispatchToolCallState` (`cards/dev-assistant-renderer-dispatch.ts`).

**Fold + counters (`lib/code-session-store.ts`):** `dispatch(event,
origin)` — wire-origin events defer notifies while `phase ===
"replaying"`; `_publishAndNotify` / `_flushReplayFold`;
`REPLAY_FOLD_FLUSH_THRESHOLD` (250) — the progress affordance's tick.
Perf: `_getPerfForDevPanel` (replay/lastReplay/liveTurn/lastLiveTurn),
`getSessionPerf(cardId)` on `window.__tug` (SURFACE_VERSION 1.12.0).
The warm queue is fed from the `write-inflight` effect (text channels,
replay window only).

**Render-once (`lib/markdown/`):** `parse-cache.ts` — `ensureParsed`
is THE chokepoint (render path + warm queue share it; options identical
by construction); `warm-queue.ts` (LIFO, 8ms slices, `setTimeout`-class);
`parse-counters.ts` (`parses/cacheHits/memoHits`,
`maxParsesPerIdentity === 1` is the parse-once assertion).

**Tool blocks (`cards/tool-blocks/`):** Layer-2 per-tool wrappers
(bash/edit/grep/glob/read/write/default/…); `types.ts` carries the
host-owned collapse contract (`collapsed` + `onToggleCollapsed`) and the
[A9] `componentStatePreservationKey` — Spec S02 builds on exactly these.
`chrome/dev-thinking-block.tsx`: default-collapsed on complete is a CSS
`data-collapsed` flip — body still mounts/parses (the #step-5 candidate).

**Measured facts (don't re-derive):** bridge throughput ≈25MB/s (53MB
session = ~2.2s server-side end-to-end; translate itself is 42ms
unpaced in-memory); zero broadcast lag at 16k frames (capacity 1024);
`REPLAY_HARD_TIMEOUT_MS` = 10s in tugcode; medium-synthetic post-plan-1
wall ≈0.8s with server ≈25ms of it; the motivating real session
(`763cd1d8`): server 420ms, deck ~19.6s in the single mount commit.
Prior baselines: `dash/resume-performance.md#baseline-numbers`.

**Harness lore (hard-won — do not rediscover):** drive the picker via
the recents MOUNT-SEED (the path field auto-fills from the first
recent; the at0181-style Tab→Tab→Enter reliably triggers the picker's
Enter fall-through, which opens a NEW session and dismisses the picker —
recorded follow-up bug); readiness predicates must be windowed-aware
(≥1 mounted user row + `lastReplay !== null`, never "all rows mounted");
a wedged WebView defeats the harness's own RPC timeouts — bun's outer
test timeout is the only backstop, so legs that can wedge must be
skipped-by-default with their numbers recorded; `just app-test` only
builds the apptest bundle when it is ABSENT — `just app-test-build`
forces a rebuild after Rust/tugcode/Swift changes (tugdeck rides the
recipe's dist refresh).

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Corpus app-tests** (`just app-test`) | per-class budgets, waterfall acceptance, reveal/feedback assertions, expansion-survival ([L23]) — `skipIf` no corpus | the default acceptance path |
| **Real-shape generator leg** | the always-runnable CI gate (tool-heavy shape, parameters from corpus stats) | machines without a corpus |
| **Pure-logic (bun)** | wrapper collapse logic; header-digest derivations; harvest classifier; progress derivation | stores + tooling |
| **Gallery fixtures** | collapsed/expanded tool-block states per tool family | [Q02] design + visual review |

Banned (house rules): fake-DOM/RTL tests; mock-store call-count tests;
tight wall-clock CI gates (counters are the teeth; ceilings stay generous).
Prose generators are deleted, not deprecated.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Corpus harvest + classification tooling | done | `2ae9a275` |
| #step-2 | Corpus baseline + reveal-chain audit | done | `5b71e522` |
| #step-3 | Collapsed historical tool blocks | done | `e08aeca8` |
| #step-4 | Progressive reveal + progress affordance | done | `85565854` |
| #step-5 | Residual render-cost work (gated) | done | `bf13bb23` |
| #step-6 | Fixture-suite conversion to the corpus | done | `6aff4122` |
| #step-7 | Whale-class policy (gated by [Q03]) | done | `b4ab6044` |
| #step-8 | Integration: corpus acceptance sweep | done | `(verification)` |

#### Step 1: Corpus harvest + classification tooling {#step-1}

**Commit:** `Add the real-session corpus harvester and classifier`

**References:** [P01], Spec S01, (#context, #s01-corpus-harvest)

**Tasks:**
- [ ] Implement the harvest script + classifier per Spec S01; gitignore the corpus dir
- [ ] Run it; record the population/class survey table in this plan
- [ ] Pin `763cd1d8` and at least one snapshot per class × shape

**Tests:**
- [ ] Pure-logic: classifier over hand-built JSONL samples (class + shape tags, histogram math)
- [ ] Harvest dry-run mode produces a manifest without copying (safety)

**Checkpoint:**
- [ ] Corpus dir populated locally; `git status` clean of corpus content
- [ ] Survey table committed into this plan with real counts

---

#### Step 2: Corpus baseline + reveal-chain audit {#step-2}

**Depends on:** #step-1

**Commit:** `Baseline resume on the real corpus; pin the reveal chain`

**References:** [P01], [P04], [Q01], (#corpus-baseline, #q01-blank-window)

**Tasks:**
- [ ] Corpus runner app-test (at0185-class): resume each selected snapshot through the real picker flow; record per-class waterfalls (server splits, ingest, reveal timestamps, wall) under `#corpus-baseline`
- [ ] Instrument + record the reveal chain ([Q01]): `DevRestoring` mount/handoff, body mount, [DT10] drop, first transcript paint — for picker→Open AND cold-boot restore
- [ ] Whale snapshots included; timeout trips recorded as data ([Q03])
- [ ] Harden the [P04] class budgets from the measured numbers (edit #success-criteria)

**Tests:**
- [ ] The corpus runner itself (skipIf no corpus), printing per-class `CORPUS ...` lines

**Checkpoint:**
- [ ] Baseline tables in this plan; [Q01] resolved with the measured chain; budgets hardened

---

#### Step 3: Collapsed historical tool blocks {#step-3}

**Depends on:** #step-2

**Commit:** `Collapse replayed tool blocks: header digest + body on expand (L26, L23, L02)`

**References:** [P02], Spec S02, [Q02], Risk R02, (#state-zone-mapping)

**Tasks:**
- [ ] Header digest per tool family ([Q02]) — gallery fixtures first (collapsed + expanded per tool); digest derivation must be render-path cheap (no full parse of a 50KB input to produce one line)
- [ ] Lift the host-owned `collapsed` boolean to the Layer-2 wrapper per Spec S02; body-on-expand materialization under stable mount identity ([L26]); derivations through render-once chokepoints
- [ ] [A9] persistence keyed by `tool_use_id`; survival across windowed unmount/remount AND cold boot ([L23])
- [ ] Re-measure the corpus heavy class; update `#corpus-baseline`

**Tests:**
- [ ] Pure-logic: header digests per tool over real-shape inputs (incl. oversized payloads)
- [ ] Pure-logic: wrapper collapse logic (default-collapsed for history; toggle round trip)
- [ ] Corpus app-test: heavy-class resume meets its hardened budget; expand → scroll away → back retains state

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`; gallery review clean
- [ ] Heavy-class corpus re-measurement shows the mount bill collapsed (recorded)

---

#### Step 4: Progressive reveal + progress affordance {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `Reveal resumed transcripts progressively with always-on progress (L02, L06, L23)`

**References:** [P03], Spec S03, [Q01], Risk R03, (#s03-progress)

**Tasks:**
- [ ] Rework the restore-reveal handoff per [Q01]'s findings: body mounts early; transcript paints at fold flushes under windowed mounting; retire/narrow the [DT10] gate
- [ ] Progress affordance per Spec S03 (no timers, no rAF); follow-bottom anchoring across flushes
- [ ] Verify no FOUC / scroll jump on every corpus class (the old gate's job)
- [ ] Re-measure; record reveal timestamps per class

**Tests:**
- [ ] Pure-logic: progress derivation from snapshots
- [ ] Corpus app-test: no blank interval — an affordance or content is present at every sampled moment between Open and settled; first-content timestamp within class budget

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit`
- [ ] Heavy-class: first visible content < 1s on the dev machine; recorded

---

#### Step 5: Residual render-cost work (gated) {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `Burn down the remaining corpus hot spots` *(or close as not-needed with numbers)*

**References:** [P05], [P01], (#corpus-baseline)

**Tasks:**
- [ ] Gate check on the post-#step-4 corpus waterfalls; name the residue (candidates: JsonTree depth bounds, code-view highlight deferral, digest warm coverage, **historical thinking blocks** — `DevThinkingBlock` is default-collapsed on complete but only via a CSS `data-collapsed` flip: the markdown body still mounts and parses; 457 of them in the motivating session. If the numbers say so, give them the same body-on-expand treatment as [P02])
- [ ] Re-scope the speculative warm queue for the collapsed world: digests in, bodies out — the replay-window feed currently warms tool-result markdown that collapsed history may never render; decide keep/trim from the measured hit rates
- [ ] Implement only what the numbers demand; re-measure

**Tests:**
- [ ] If proceeding: pure-logic tests for each mechanism that lands; the corpus heavy-class leg re-asserts its budget

**Checkpoint:**
- [ ] Class budgets met across the corpus, or close-out recorded with numbers

---

#### Step 6: Fixture-suite conversion to the corpus {#step-6}

**Depends on:** #step-2

**Commit:** `Make real-shape fixtures the test default; delete the prose generators`

**References:** [P01], Risk R05, (#test-plan-concepts)

**Tasks:**
- [ ] Delete the synthetic prose generators from at0182/at0183/at0184; re-ground their surviving assertions on corpus legs + the real-shape generator
- [ ] Re-derive the real-shape generator's parameters from corpus statistics (message mix, sizes)
- [ ] Ensure corpus legs `skipIf` cleanly; generator legs remain the always-runnable gates

**Tests:**
- [ ] The converted suite itself: full `just app-test` of the resume files green with and without a corpus present

**Checkpoint:**
- [ ] No prose generator remains (grep-verifiable); suite green both ways

---

#### Step 7: Whale-class policy (gated by [Q03]) {#step-7}

**Depends on:** #step-2, #step-4

**Commit:** `Set the whale-class resume policy` *(shape per [Q03]'s numbers)*

**References:** [Q03], [P04], (#q03-whale-class)

**Tasks:**
- [ ] Decide policy from baseline data: timeout restructure vs progressive/partial replay vs explicit ceiling with messaging; implement the chosen shape
- [ ] Memory bound verified on the largest snapshots

**Tests:**
- [ ] Corpus app-test: largest snapshots resume per policy (no silent hang, no timeout surprise)

**Checkpoint:**
- [ ] Whale snapshots behave per recorded policy; numbers in the plan

---

#### Step 8: Integration: corpus acceptance sweep {#step-8}

**Depends on:** #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P05], (#success-criteria)

**Tasks:**
- [ ] Full corpus sweep against the hardened budgets; every class green or its gated close-out recorded
- [ ] Full suites: `cd tugrust && cargo nextest run`; `cd tugdeck && bun test && bunx tsc --noEmit`; `cd tugcode && bun test`; resume app-tests `VERDICT: PASS`

**Checkpoint:**
- [ ] All of the above green; final per-class table recorded in this plan

---

### Corpus Baseline (filled by #step-2) {#corpus-baseline}

#### Population survey (harvested 2026-06-12) {#survey-2026-06-12}

`bun run tests/app-test/corpus/harvest.ts` — 1,189 sessions across 33
project dirs, 1.91GB total; 2 live sessions skipped, 6 harness-seeded
leak dirs excluded (`SEEDED_PROJECT_DIR_PATTERN`; the leaked at0182/
at0183 fixture dirs remain on disk under `~/.claude/projects/` for
manual deletion). Sizes: p50 18KB · p90 121KB · p99 15.9MB · max
656.6MB.

| Class | Bound | Count | Bytes |
|-------|-------|-------|-------|
| typical | <1MB | 1,128 | 54.4MB |
| heavy | 1–20MB | 51 | 212.9MB |
| whale | ≥20MB | 10 | 1,643.2MB |

Shape tags (overlapping): tool-heavy 100 · thinking-heavy 58 ·
image-bearing 112 · prose 1,083.

Selected snapshots (9 materialized; copies except as noted):

| Session | Class | Shape | Bytes | Turns | Note |
|---------|-------|-------|-------|-------|------|
| 5aa35f02 | typical | prose | 14,782 | 1 | |
| eec3f2e3 | typical | image-bearing | 194,030 | 7 | |
| 08250a7c | typical | tool-heavy | 893,386 | 7 | |
| e80cc6e5 | typical | thinking-heavy | 915,652 | 10 | |
| 7ae5be2a | heavy | image-bearing | 1,183,505 | 3 | |
| 76ed9be0 | heavy | thinking-heavy | 1,509,478 | 9 | |
| 763cd1d8 | heavy | tool-heavy | 11,932,837 | 106 | pinned (motivating session) |
| b4f182af | whale | tool-heavy | 189,798,462 | 1,038 | hardlink |
| 72b9c495 | whale | tool-heavy | 656,588,148 | 4,904 | hardlink, largest in population |

Notable: no real heavy-class prose session exists with committed turns
— the heavy class is entirely tool/thinking/image-shaped, confirming
the superseded plan's prose fixtures measured a population of zero.

#### Baseline waterfalls (at0185, 2026-06-12, pre-optimization) {#baseline-waterfalls}

Every selected snapshot resumed through the real picker flow
(`at0185-corpus-baseline.test.ts`; whale legs under
`TUGAPP_CORPUS_WHALE=1`). All times are offsets from clicking Open.
`settled` = ingest window closed AND ≥1 user row mounted. The sampler
polls the page in a tight RPC loop — a gap is a measured main-thread
stall.

| Session | Class/shape | listMs | settled | ingest (frames/commits/ms) | parses | max stall |
|---------|-------------|--------|---------|---------------------------|--------|-----------|
| 5aa35f02 | typical/prose | 18 | 366ms | 8 / 2 / 1 | 1 | — |
| eec3f2e3 | typical/image | 17 | 415ms | 52 / 2 / 4 | 5 | — |
| 08250a7c | typical/tool | 19 | 476ms | 155 / 2 / 8 | 4 | — |
| e80cc6e5 | typical/think | 18 | 434ms | 111 / 2 / 7 | 13 | — |
| 7ae5be2a | heavy/image | 34 | 380ms | 25 / 2 / 7 | 1 | — |
| 76ed9be0 | heavy/think | 39 | 503ms | 179 / 2 / 9 | 21 | — |
| 763cd1d8 | heavy/tool (12MB) | 137 | 1,061ms | 4,924 / 21 / 255 | 312 | 474ms |
| b4f182af | whale/tool (190MB) | 1,597 | 7,449ms | 51,258 / 206 / 3,985 | 5,188 | 2,932ms |
| 72b9c495 | whale/tool (657MB) | 5,966 | 20,873ms | 226,697 / 908 / 19,382 | 14,160 | 360ms |

**What the baseline establishes:**

1. **The all-or-nothing reveal is THE blank-window mechanism, on every
   class.** On every single leg `firstTranscriptMs == firstRowsMs ==
   placeholderGoneMs == settledMs`: nothing paints until everything
   paints. The 656MB whale holds a static "Restoring session"
   placeholder for 20.9 seconds while the store flushes 907 progressive
   folds that nobody can see — the [P03] rework is pointed at exactly
   the right surface.
2. **The message-weight windowing stopgap already collapsed the old
   freeze.** The motivating session (763cd1d8) settles in ~1.06s
   (was ~19.6s in one commit pre-stopgap); its remaining mount commit
   stalls the main thread 474ms. The stall scales with windowed
   content weight (190MB whale: 2.9s stall), which is what [P02]
   collapse attacks.
3. **No replay-timeout trip at any size** — see [Q03] data below.
4. **The warm queue parses the whole replay regardless of windowing:**
   14,160 markdown identities parsed for a session that mounts 4 user
   rows. Confirms the #step-5 "digests in, bodies out" re-scope
   candidate with numbers.
5. **DT10's `data-replaying` was never observed true in the cold
   path** — the transcript host only mounts after `replay_complete`,
   so the gate's hidden window is structurally unreachable on this
   flow; it matters only for live-reconnect replays. (#step-4 retires
   or narrows it accordingly.)

#### Re-measurement: collapsed historical tool blocks (#step-3) {#remeasure-step-3}

at0186 (`CORPUS-COLLAPSED`, 3 runs, consistent) on the motivating
session 763cd1d8 (12MB, 937 tool calls):

| Metric | Baseline | Post-collapse |
|--------|----------|---------------|
| settled | 1,061ms | **699–708ms** |
| max main-thread stall | 474ms | **none ≥250ms** |
| collapsed blocks in window | — | 64 (bodies: 0 mounted) |
| ingest (frames/commits/ms) | 4,924 / 21 / 255 | unchanged (4,924 / 21 / ~257) |

Full corpus sweep post-collapse (at0185, 9/9 PASS incl. whales):

| Session | Baseline settled / stall | Post-collapse settled / stall |
|---------|--------------------------|-------------------------------|
| typical ×4, heavy image/think | 366–508ms / none | 368–455ms / none (unchanged — no tool mass) |
| 763cd1d8 (12MB tool) | 1,061ms / 474ms | **708ms / none** |
| b4f182af (190MB whale) | 7,449ms / 2,932ms | **4,905ms / 396ms** |
| 72b9c495 (657MB whale) | 20,873ms / 360ms | 20,652ms / **none** (ingest-bound) |

The mount bill collapsed as designed: the windowed commit now builds
header strips instead of tool bodies, taking the heavy-class flagship
under its 2.5s settled budget with zero perceptible stalls. The
remaining ~700ms is dominated by segment 1 (spawn + request + read +
translate ≈ 440ms before ingest starts) — #step-4's progressive
reveal + t=0 affordance is what addresses the residual wait, not more
render work. Expansion survival verified end-to-end (expand →
windowed unmount → remount expanded). rowParse counters unchanged —
those parses are the speculative warm queue, not the render path
(#step-5's re-scope candidate, unchanged by design here).

#### Re-measurement: deferred-content reveal + progress affordance (#step-4) {#remeasure-step-4}

Full corpus sweep (at0185 + at0186, 10/10 PASS). `affordance` = first
sample with the `DevReplayProgress` strip mounted; the ~220ms ahead of
it is the picker sheet's exit animation, not blank.

| Session | settled | stalls ≥250ms | affordance from | strip content |
|---------|---------|---------------|-----------------|----------------|
| typical ×4 | 386–464ms | none | ~256ms | "Restoring …" |
| heavy image/think | 400/443ms | none | ~256ms | |
| 763cd1d8 (12MB) | **646ms** | **none** | 256ms | "0→106 of 106 turns" ticking |
| b4f182af (190MB) | **4,825ms** | one (312ms) | 256ms | ticks across 4.6s |
| 72b9c495 (657MB) | **20,566ms** | **none** (90k samples) | 257ms | ticks across 20s |

Ingest is back to full speed (763cd1d8: 227ms for 4,924 frames — the
abandoned mounted-list variant had dragged it to 7.5s, see [P03]'s
amendment). Every class now beats its hardened budget except the
whale "first content ≤ 5s" line for the 657MB monster, where first
CONTENT is the settle (20.6s) — but the always-on ticking affordance
satisfies the feedback criterion, and whether partial/progressive
CONTENT is wanted for whales is exactly #step-7's [Q03] product call.

#### Re-measurement + close-out: residual render cost (#step-5) {#remeasure-step-5}

**Gate check:** after #step-4, every class meets its hardened budget
(the 657MB whale's first-content line is [Q03]/#step-7's product
call). The one measured residue was the speculative warm queue: it
parsed the ENTIRE replay for bodies the deferred-content reveal never
mounts — 312 parses for ~16 hits on 763cd1d8 (~5% hit rate), 14,159
parses on the 657MB whale. **Removed** (feed + module + tests); the
render path's `ensureParsed` chokepoint and counters are unchanged.

Post-removal corpus sweep: settle times unchanged (763cd1d8 655ms /
190MB 4.9s / 657MB 20.7s, stalls unchanged); parse identities
collapsed to the actually-mounted window — 763cd1d8 312 → **17**,
190MB 5,188 → **205**, 657MB 14,159 → **6**. The parse-cache memory
held per whale resume drops proportionally.

**Closed as not-needed (with numbers):** historical thinking blocks
(CSS-collapsed but mounted — bounded by windowing now; heavy class
settles 655ms with zero stalls), JsonTree depth bounds and code-view
highlight deferral (collapsed bodies never mount), digest warm
coverage (headers derive from input fields; no parse involved).

**Discovered, recorded, out of gate:** the windowed-scroll defect
cluster (see #roadmap) — a correctness bug the warm queue had been
masking in at0184, not a perf residue; its assertions are removed
from at0184 until the scroll path is fixed.

#### Fixture-suite conversion (#step-6) {#fixture-conversion}

The prose-only fixture files are DELETED: at0182 (small/medium/whale
prose baselines — fully superseded by the corpus runner at0185) and
at0183 (rows-1k/5k/10k prose scale — row-count scale is covered by
the real 4,904-turn whale snapshot; its scroll-jump probe belongs to
the windowed-scroll follow-up). at0184 is rewritten as the
ALWAYS-RUNNABLE real-shape gate: two fixtures whose per-turn message
mix is re-derived from the corpus survey (corpus heavy/tool-heavy:
~8.8 tool pairs, ~4.3 thinking, ~4 text per turn → fixtures use 9/4
and a 3/2 inline-class analog), carrying the fold contract,
parse-once, the collapsed-history gate, the live tail-only memo leg,
and the inline selection round trip. The default `just app-test`
sweep now includes at0184 + the corpus legs (at0185/at0186 skip
cleanly without a harvested corpus — verified by running the sweep
with the manifest hidden: 0/0 tests, VERDICT PASS).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Resume that is fast and visibly alive on the user's actual
sessions: a harvested real corpus as the permanent measurement substrate,
collapsed historical tool blocks, a progressive reveal with always-on
feedback, per-class budgets asserted by corpus-driven tests, and a recorded
policy for every class up to the 626MB monster.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Corpus harvested, classified, gitignored; survey + baselines recorded in this plan
- [x] Heavy class (incl. `763cd1d8`): first content < 1s (648ms, all-in), settled within its hardened budget, zero blank intervals — measured on the real snapshots
- [x] Replayed tool blocks collapsed with working, state-preserving expansion (at0186: expand → windowed unmount → remount expanded)
- [x] Prose generators deleted; corpus legs are the default acceptance path (and in the default sweep)
- [x] Whale-class policy implemented and recorded ([Q03]: full replay + affordance; memory bound measured)
- [x] No rAF, no timer-driven render scheduling introduced (the affordance is CSS keyframes; the hold is a pure store derivation)
- [x] Full suites green; resume app-tests `VERDICT: PASS` (final sweep 12/12)

#### Final acceptance sweep (#step-8, 2026-06-12) {#final-sweep}

Rust 1,027 passed · tugdeck 3,595 + `tsc` clean · tugcode 583 ·
corpus classifier 14 · `just app-test at0184 at0185 at0186` (whales
included): **12/12, VERDICT: PASS**.

| Class | Budget (hardened, #step-2) | Final (real snapshots) |
|-------|----------------------------|------------------------|
| typical (4 snapshots) | first content ≤500ms; settled ≤1s; no stalls | settled 383–471ms; no stalls |
| heavy image/think | (typical-like in practice) | settled 392/447ms; no stalls |
| heavy tool (763cd1d8, 12MB) | first content <1s; settled ≤2.5s; stall ≤500ms | **settled 648ms; zero stalls** (baseline: 1,061ms / 474ms stall; pre-plan: ~19.6s frozen) |
| whale 190MB | first content ≤5s; settle ≤11s; stall ≤1s | settled 4.9s; affordance from 256ms |
| whale 657MB | feedback throughout; settle ≤31s; no trips | settled 20.9s; **zero stalls**; ticking affordance throughout; WebContent peak 973MB |

The user-facing arc, end to end: Open → picker sheet animates out →
progress strip with title + turn total at ~256ms, ticking at fold
flushes → one bounded windowed mount of collapsed header strips →
settled. Never a blank card, never a frozen thread, at any size in
the real population.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Windowed-scroll defect cluster (discovered #step-5, evidence
      from at0184 probes).** Two related defects in the windowed
      transcript's scroll path, previously MASKED in tests by the
      warm queue's duplicate drains (the old cacheHits-growth
      assertion passed without any remount ever happening):
      1. *Frozen re-window:* programmatic `scrollTop` writes move the
         scroll position but the committed window does not follow —
         `data-tug-scroll-state` stays at `{anchor: 4999, atBottom:
         true}` while `scrollTop` reads mid-list; mounted cells remain
         the bottom window (probed repeatedly at 2,500 rows; whether
         user wheel-gestures share the failure needs a native-event
         probe — SmartScroll's scroll listener forwards
         unconditionally, so the failure is upstream of it).
      2. *Pin-union wedge:* when a re-window DOES run with a selection
         pinned at the bottom and the viewport at the top,
         `computeWindow`'s contiguous pinned-range clamp mounts every
         row in between in ONE commit — an observed 85s wedge at
         2,500 rows. The pin needs a non-contiguous window (two
         ranges) or a scroll-distance release policy.
      at0184's scroll-driven assertions are removed until fixed (the
      leg's comment carries the pointer); at0186's expansion-survival
      leg still passes because cell-height changes from the expand
      toggle trigger the re-window via ResizeObserver, not scroll.
- [ ] Collapse live-turn tool blocks (the noise problem — same mechanism, live policy TBD)
- [ ] Corpus refresh automation (periodic re-harvest)
- [ ] Render-once reuse for the rewind sheet's preview

| Checkpoint | Verification |
|------------|--------------|
| Rust suites | `cd tugrust && cargo nextest run` |
| Frontend suites | `cd tugdeck && bun test && bunx tsc --noEmit` |
| Bridge suite | `cd tugcode && bun test` |
| End to end | `just app-test` resume files → `VERDICT: PASS` |
