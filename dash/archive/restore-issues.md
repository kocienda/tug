<!-- devise-skeleton v4 -->

## Session Restore Hardening — verify and finish the compaction re-append fix {#phase-session-restore-hardening}

**Purpose:** Turn the two committed session-restore fixes (no-content `msg_id` collision, compaction re-append dead-branch rescue) from "believed sound" into verified, contract-consistent behavior — closing all six open questions from `dash/restore-issues-brief.md` so restored sessions are provably complete, duplicate-free, and consistent with the canonical turn count.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-28 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Two session-restore defects were investigated in `dash/restore-issues-brief.md`. Both fixes are now **committed**: Bug 1 (no-content turns colliding on `msg_id: ""`) landed as `31b775d1d`; Bug 2 (compaction re-appends teleporting the dead-branch walk forward, silently dropping 10,446 entries across 5 sessions) landed inside `984be56b6` (the ~59-line `occurrencesByUuid`/`resolveParent` change to `computeDeadEntryIndices` in `tugcode/src/replay.ts`), with the projected fixture `tugcode/src/__tests__/fixtures/compact-reappend/chain-topology.jsonl` committed in `083ae9c52`.

What has **not** happened is the verification and consequence work the brief demanded before trusting the fix: no test consumes the fixture; `dead = 0` on the five affected sessions is an unfalsified result; the translator now replays re-appended turns twice (63 `turn_complete` frames, 59 distinct `msg_id`s) and only the deck's `committedMsgIds` dedupe hides it; the Rust turn engine has no dead-branch or duplicate-uuid awareness at all, so the canonical turn count (`tuglaws/turn-metric.md`) diverges from what replay renders on any session with a dead branch; and the destructive rewind-truncation path's duplicate-uuid behavior is unproven. This plan closes those gaps.

#### Strategy {#strategy}

- Pin what already works first: regression tests over the committed fixture and a property-based validator over the real local corpus, before touching any behavior.
- Prove the destructive path safe (rewind truncation with duplicate uuids) with tests, since it is the highest-risk unexamined area.
- Define one **effective record sequence** — live (dead-branch-excluded) entries with re-appended duplicate occurrences suppressed — and make all three segmentation consumers (the replay translator, `segmentJsonlOrigins`, the Rust turn engine) operate on it, so replay fidelity and the turn-metric contract agree by construction rather than by accident.
- Land the TS and Rust halves of that change **atomically** in one step, because the real-corpus contract test compares them per-turn and would fail between separate commits.
- Close the adversarial gap the corpus lacks (a session with both a genuine rewind branch and heavy compaction) with a real Claude-Code-generated session, not a hand-authored JSONL.
- Finish with app-level verification: an app-test through the real cold-replay chain and a manual check of an affected session in the running app.

#### Success Criteria (Measurable) {#success-criteria}

- A committed test consumes `chain-topology.jsonl` and fails if `computeDeadEntryIndices` regresses to forward parent resolution (revert the `984be56b6` replay.ts hunk locally → test fails).
- The dead-set property validator passes over every session in the local corpus (~894 files): every dead entry roots at a live-parented off-chain user submission, and no dead entry is an ancestor of the newest leaf via the bridged walk.
- The 7 corpus sessions with genuine rewind/REPL-escape dead branches still report non-empty dead sets after all changes (dead-branch detection not lobotomized).
- After duplicate suppression, the translator emits exactly one `turn_complete` per distinct turn — emitted count == distinct `msg_id` count on session `8b8d7bf1` (was 63 vs 59).
- The Rust real-corpus contract test (`engine_matches_tugcode_segmentation_over_real_corpus`) passes with 0 divergent sessions, and `agent_bridge.rs` logs no `contract_breach.replay_total_turns` when replaying the five affected sessions.
- `computeConversationTruncation` provably refuses (`compaction_blocked`) any anchor whose uuid is duplicated by a compaction re-append (test-enforced).
- An app-test drives `spawnSessionResume` over a compaction-re-append fixture and asserts post-compaction turns render; session `8b8d7bf1` restores its `gallery-pulse-display` work in the running app.

#### Scope {#scope}

1. Regression tests for the committed Bug 2 fix (fixture-based and corpus-property-based).
2. Duplicate-uuid safety proofs for the rewind/retract truncation path and an audit of every uuid-keyed consumer in tugcode.
3. Re-append duplicate suppression in the replay translator, mirrored in `segmentJsonlOrigins` and the Rust turn engine, with incremental-segmentation invalidation triggers.
4. `tuglaws/turn-metric.md` update defining the canonical count over the effective record sequence.
5. Adversarial rewind+compaction session generation and verification.
6. App-test and running-app verification of restore completeness.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any change to Bug 1's shipped fix (opener-id minting in `tugcode/src/session.ts`, reducer `""`-identity handling) — it is verified and landed; this plan only adds coverage around its neighbors where steps touch the same files.
- Deck-side rendering changes. The `committedMsgIds` dedupe in `tugdeck/src/lib/code-session-store/reducer.ts` stays exactly as is (defense-in-depth, per [P02]).
- Re-architecting windowed replay, `ReplayWindow` resolution, or the subagent splice.
- Fixing Claude Code's own re-append behavior — the duplicate records are upstream fact; we adapt to them.
- Shell-route restore interleave (covered by its own doctrine, [D111]).

#### Dependencies / Prerequisites {#dependencies}

- `984be56b6` and `31b775d1d` on `main` (both present at plan authoring).
- The committed fixture `tugcode/src/__tests__/fixtures/compact-reappend/chain-topology.jsonl` (1,211 records, 222 KB).
- Local-only steps additionally need the real corpus at `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/` (the pattern established by `turn_engine.rs`'s local-only tests: skip gracefully when absent).
- The bun-compiled `tugcode` binary at `tugrust/target/debug/tugcode` for the Rust contract test (`TUGCODE_BIN` overrides).

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace (`-D warnings`).
- The turn-metric law (`tuglaws/turn-metric.md`) requires `engine(session file) == replay totalTurns == highest rendered address`; tugcast enforces it at the `replay_complete` rewrite point (`agent_bridge.rs`, `parse_replay_complete_total_turns` / `stamp_replay_complete_total_turns`, engine wins on breach). Any turn-count change must land on both sides of that contract in one commit.
- Real code paths on real content: fixtures derive from real session JSONL; no hand-authored synthetic topologies as primary evidence.
- App-tests run selectively (`just app-test-changed`), never the full corpus; new tests carry `@covers` headers.
- Large real sessions (the smallest affected is 7.8 MB) cannot be vendored whole; committed fixtures use the established projection approach (see [P05]).

#### Assumptions {#assumptions}

- Claude Code's re-append blocks are verbatim copies (same `uuid`, same `parentUuid`, same content) of preserved messages — observed on session `8b8d7bf1` (669 duplicated uuids; lines 4706–5065 duplicate 3873–4382 exactly). If a future Claude Code version mutates re-appended records, the first-occurrence rule ([P02]) still emits the original.
- Re-appends occur only as part of a compaction, so an appended slice containing no compaction marker contains no new duplicates (grounds the incremental invalidation rule, [P03]).
- The five affected sessions remain in the local corpus for verification (they live outside the repo; local-only tests skip when absent).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

> These are the brief's six open questions, carried over with their resolutions.

#### [Q01] Should the translator skip compaction re-appends outright? (DECIDED) {#q01-skip-reappends}

**Question:** Post-fix the translator emits 63 `turn_complete` frames with 59 distinct `msg_id`s on session `8b8d7bf1` — the re-appended block replays 4 turns twice, and only the deck's `committedMsgIds` dedupe hides it. Should the translator suppress re-appended duplicates itself?

**Why it matters:** The accidental dedupe is fragile: user-origin replay turns carry uuid-shaped opener ids (one duplicated id, `32524404-…`, is a user record's uuid, not an `msg_*`), the dedupe was designed for live-stream duplicates rather than replay fidelity, and the phantom emissions skew turn addressing and telemetry.

**Resolution:** DECIDED (see [P01], [P02]) — yes, suppress at the translator, mirrored in `segmentJsonlOrigins` and the Rust engine so the turn-metric contract stays intact. Implemented in #step-5.

#### [Q02] Is `dead = 0` actually correct for the five affected sessions? (DECIDED) {#q02-dead-zero-correct}

**Question:** The fix collapsed the affected sessions' dead sets to 0–1 entries. Is that rescue, or over-correction that now replays genuinely abandoned branches as phantom turns?

**Why it matters:** The failure mode is symmetric ([L23] both ways): under-suppression resurrects rewound-away exchanges. Because `resolveParent` returns `undefined` for a forward-only parent, an over-correction presents exactly as dead sets quietly collapsing to zero — the observed result cannot distinguish "fixed" from "over-corrected" by count alone.

**Resolution:** DECIDED (see [P04]) — replace the numeric smell test with property assertions (every dead entry is a live-parented off-chain user-submission descendant; no dead entry is bridge-reachable from the newest leaf), run them corpus-wide, diff the pre/post dead sets on the five sessions, and construct the adversarial rewind+compaction case the corpus lacks. Implemented in #step-2 and #step-6.

#### [Q03] Rust parity contract — do the two segmentation halves still agree? (DECIDED) {#q03-rust-parity}

**Question:** The brief feared the TS turn-count change (43 → 63) would break the real-corpus contract against `turn_engine.rs`.

**Why it matters:** The contract (`engine_matches_tugcode_segmentation_over_real_corpus`) is the anti-drift gate for the canonical turn count.

**Resolution:** DECIDED — investigation (this plan, #contract-topology) established the contract is **currently intact but measures the wrong thing**: `segmentJsonlOrigins` never applied dead-branch filtering, so both halves segment the raw file while the actual replay segments the dead-filtered file. On any session with a dead branch, `engine(file)` exceeds rendered turns and `agent_bridge.rs` stamps the (wrong) engine value over the translator's honest `totalTurns`. The fix is [P01]/[P03]: both halves move to the effective record sequence together. Implemented in #step-4 and #step-5.

#### [Q04] Does the last-wins uuid assumption exist elsewhere? (DECIDED) {#q04-uuid-elsewhere}

**Question:** Now that duplicate uuids are known to be routine, which other uuid-keyed code inherits the trap — in particular the destructive `retract: true` path that truncates the JSONL at the prompt record?

**Why it matters:** A uuid resolved to the wrong occurrence in `computeConversationTruncation` (`tugcode/src/session.ts`) would truncate at the wrong line — destructive, not merely lossy.

**Resolution:** DECIDED (see [P06], #truncation-analysis) — investigation shows `computeConversationTruncation` scans **first-occurrence-wins** by file line and refuses (`compaction_blocked`) whenever a compaction marker sits at or after the boundary. A re-appended duplicate anchor by construction has a `compact_boundary` between its first occurrence and the tip, so the guard refuses before any wrong-line truncation. The Rust side is clean: `turn_engine.rs` and `session_ledger.rs` contain no record-uuid keying (the ledger fingerprints byte prefixes; `external_sessions.rs` only checks filename stems via `is_uuid_stem`). This analysis becomes test-enforced in #step-3, which also completes the audit over every remaining uuid consumer in tugcode (List L01).

#### [Q05] Fixture provenance — is the projected fixture acceptable? (DECIDED) {#q05-fixture-provenance}

**Question:** `chain-topology.jsonl` preserves real uuids, parent links, record kinds, and file order, but projects each record down to the fields `computeDeadEntryIndices` reads and clips long content (source session is 21.6 MB). Is that acceptable, or should a genuine contiguous slice be vendored?

**Resolution:** DECIDED (see [P05]) — the projection is accepted for chain-topology tests (the function under test reads exactly the preserved fields), full-fidelity verification runs local-only against the real corpus, and the app-test fixture is a small full-fidelity real session (#step-7). No un-projected multi-MB session is vendored.

#### [Q06] App-level verification of restore completeness (DECIDED) {#q06-app-verification}

**Question:** No app-test ran for the Bug 2 change and no verification happened in the running app.

**Resolution:** DECIDED — #step-7 adds an app-test through `spawnSessionResume` (the harness verb that drives the true cold-replay chain from a seeded JSONL) plus a manual running-app check of session `8b8d7bf1`, and #step-8 runs `just app-test-changed` over the whole diff.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Duplicate suppression breaks the turn-metric contract mid-landing | high | high if split | TS + Rust land atomically in #step-5 | contract test fails between steps |
| Dead-branch port to Rust drifts from the TS walk | med | med | shared fixture assertions + corpus contract as the drift gate | 1 divergent session in the contract test |
| Incremental segmentation undercounts/overcounts across a compaction append | med | med | invalidation triggers force full re-segment ([P03]); convergence test in `session_ledger.rs` | picker count ≠ opened-session count |
| Adversarial session generation via the REPL proves impractical | med | med | property validator + pre/post diff are the primary gates; the adversarial case is confidence, not the only evidence | #step-6 blocked |
| Vendoring a real session fixture leaks private content | med | low | fixture generated in a scratch project with throwaway prompts, reviewed before commit | any real-work content in the fixture |

**Risk R01: Over-correction hides behind `dead = 0`** {#r01-overcorrection}

- **Risk:** The rescued entries include a genuine abandoned branch that should still be suppressed, and every count-based check reads it as success.
- **Mitigation:** Property assertions ([P04]) that hold for *every* corpus session; the 7 genuine-dead sessions as canaries; pre/post dead-set diffs inspected entry-by-entry on the five affected sessions.
- **Residual risk:** A dead-branch shape absent from the corpus and not covered by the adversarial fixture could still slip through; the validator would flag it the first time such a session is opened locally.

**Risk R02: A future Claude Code changes re-append shape** {#r02-upstream-shape}

- **Risk:** Non-verbatim re-appends (new uuids, mutated content) would bypass first-occurrence suppression.
- **Mitigation:** New uuids don't collide, so nothing breaks — the entries replay once, correctly. The validator and contract tests remain the drift alarms.
- **Residual risk:** Verbatim-but-reordered re-appends; accepted, no known instance.

---

### Design Decisions {#design-decisions}

#### [P01] One effective record sequence for segmentation and replay (DECIDED) {#p01-effective-sequence}

**Decision:** The canonical turn segmentation and the replay emission both operate on the **effective record sequence**: chain entries that are (a) not on a dead branch and (b) the earliest non-dead occurrence of their uuid — computed identically in `translateJsonlSession` (`tugcode/src/replay.ts`), `segmentJsonlOrigins` (same file), and the Rust engine (`tugrust/crates/tugcast/src/turn_engine.rs` + new dead-branch module).

**Rationale:**
- The turn-metric law demands `engine(file) == totalTurns == highest rendered address`; today the engine counts dead-branch and duplicated turns the replay never renders, and `agent_bridge.rs` "corrects" the honest translator count with the wrong engine value.
- Claude's own resume walks the live chain and shows each preserved message once; replay fidelity means matching that.

**Implications:**
- `tuglaws/turn-metric.md` gains the effective-sequence definition (documentation change in #step-5).
- The Rust engine needs uuid/parentUuid awareness (today `SigRecord` in `turn_engine.rs` carries neither) and a dead-branch computation — a two-pass, full-file operation.
- `segmentJsonlOrigins` stops being a raw-file segmenter; the `tugcode segment` CLI subcommand (`tugcode/src/main.ts`) inherits the change automatically.

#### [P02] Re-append suppression = earliest non-dead occurrence wins (DECIDED) {#p02-first-occurrence}

**Decision:** For every uuid with multiple occurrences, exactly one occurrence emits: the earliest one not in the dead set. The suppression domain is exactly `computeDeadEntryIndices`' index domain — **chain entries only** (uuid-bearing, non-sidechain); sidechain records and no-uuid bookkeeping records are never suppressed, so a sidechain record sharing a uuid with a main-chain record can never null it (or be nulled by it). All other occurrences are nulled in `translateJsonlSession` immediately after dead-branch nulling and before `hoistCompactCommandEnvelope`. The deck's `committedMsgIds` dedupe is retained unchanged as defense-in-depth, no longer load-bearing for replay.

**Rationale:**
- The first occurrence sits at the turn's true chronological position; re-appends are verbatim copies with later positions and stale context.
- "Earliest **non-dead**" (not simply "first") covers the corner where an original occurrence was legitimately swept as a dead branch but its re-appended copy is live preserved content.
- Suppressing before `hoistCompactCommandEnvelope` keeps the envelope hoist and every downstream pass (anchor scans, `computeTurns`, windowing, emit) uniform — the same nulling mechanism malformed lines and dead entries already use.

**Implications:**
- On session `8b8d7bf1`: emitted turns drop 63 → 59, matching distinct `msg_id`s; the 9 real `compact_summary` boundaries survive (the duplicated boundary record shares its original's uuid and is nulled; the 9 originals each emit once).
- `computeDeadEntryIndices` itself still sees **all** occurrences — suppression happens strictly after it, because occurrence-aware parent resolution needs the full occurrence lists.

#### [P03] Rust incremental segmentation invalidates on compaction or branch shapes (DECIDED) {#p03-incremental-invalidation}

**Decision:** The Rust engine's full-file path computes the effective sequence exactly — with the **`external_sessions.rs` streaming scanner as the count authority** (it feeds `sessions_recorder.engine_turn_count`, which is what `agent_bridge.rs` stamps; `segment_str` is the shared kernel, not the seat). The incremental path (a carried `Frontier` over an appended slice) stays cheap but **falls back to a full re-segment** when the appended slice contains (a) any compaction marker (`compact_boundary` system record or `isCompactSummary` user record) or (b) a **non-sidechain** chain entry whose `parentUuid` is non-null and differs from the carried previous leaf uuid (the rewind-branch shape). `Frontier` gains the carried leaf uuid to make (b) checkable.

Trigger (b) is **conservative by design**: benign mid-turn spurs the walk's doc comment already names (hook-result `attachment` records, a `tool_result` whose sibling carried the chain forward, an abandoned API-retry `assistant` branch) may trip it and force a full re-segment. That is acceptable — the fallback is always sound and costs tens of ms on a rare event; do not "optimize" the trigger by narrowing it, because every narrowing is a correctness bet. Sidechain records are excluded from the trigger (they root their own chains mid-file and would false-positive constantly).

**Ledger persistence:** the carried leaf uuid is persisted alongside the existing frontier columns (`frontier_open`, `frontier_pending_close`, `frontier_pending_close_msg_id`) in the session-ledger row (`session_ledger.rs`) as a new nullable column, added via the ledger's established **self-healing column guard** (the `CREATE … IF NOT EXISTS` + column-reconciliation doctrine documented at the top of `session_ledger.rs` — this is the tugcast-local sessions ledger, **not** the shared `changes.db`, so no `CHANGES_SCHEMA_VERSION` bump or registered migration applies). A seed row whose leaf-uuid column is absent or NULL (any row written before this change) is treated as **non-resumable**: one full re-stream repopulates it, after which incremental resumes proceed normally.

**Rationale:**
- Duplicates only arrive with compactions and dead branches only arrive with rewinds (Assumptions), so appends free of both shapes segment incrementally with unchanged semantics.
- A persistent seen-uuid set across the append boundary would bloat the ledger schema; a rare full re-segment (~tens of ms) is the precedented fallback (`rewritten_prefix_falls_back_to_full_parse` already covers the prefix-rewrite case).

**Implications:**
- `parse_significant` / `SigRecord` must expose `uuid`, `parentUuid`, sidechain, and the compaction-marker bit.
- The streaming scanner needs a two-pass-on-demand restructure (see #scanner-two-pass and #step-5) — dead-branch detection cannot run inside a single forward stream.
- The incremental-matches-full property (existing test `engine_incremental_matches_full_on_reference_session`) must hold across an artificial split placed inside a re-append block.

#### [P04] Dead-set validity is asserted as properties, not counts (DECIDED) {#p04-property-validation}

**Decision:** A test-side validator asserts, for any session: (1) every index in the dead set is a descendant of an off-chain user submission whose resolved parent is live; (2) no dead index is reachable from the newest leaf through the bridged ancestor walk; (3) every non-dead chain entry is either bridge-reachable from the newest leaf, a member of a null-parent segment, or a benign off-chain spur that is not a user submission with a live parent. It runs over the committed fixture and, local-only, over the entire real corpus.

**Rationale:**
- Entry counts moved in the desired direction for both the fix and its hypothetical over-correction; only the invariant distinguishes them (Q02).

**Implications:**
- The validator lives in test code (`tugcode/src/__tests__/`), not shipped code — replay stays fast and the invariant stays falsifiable.

#### [P05] Fixture doctrine: projected topology committed, full fidelity local-only (DECIDED) {#p05-fixture-doctrine}

**Decision:** Committed fixtures for chain-topology logic use the established projection (real uuids/parent links/kinds/order, content clipped, only fields the code under test reads). Full-fidelity checks (frame content, byte counts) run local-only against `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/`, skipping gracefully when absent — the `[P07]`-style pattern already used by `turn_engine.rs`'s corpus tests. The app-test fixture is a small **full-fidelity** real session generated in a scratch project with throwaway content (#step-6/#step-7), so nothing private or multi-MB enters git.

**Rationale:**
- The smallest affected real session is 7.8 MB; vendoring it whole buys little over the 222 KB projection plus local-only full runs.

**Implications:**
- The projection script joins the repo (it currently exists only as a /tmp throwaway) so fixtures are regenerable.

#### [P06] Truncation safety rests on first-occurrence + compaction guard, test-enforced (DECIDED) {#p06-truncation-safety}

**Decision:** `computeConversationTruncation` keeps its first-occurrence-wins scan and compaction guard unchanged; its safety against duplicate anchors is documented in its doc comment and pinned by tests: an anchor uuid duplicated by a re-append must yield `compaction_blocked`, never an `ok` boundary at either occurrence.

**Rationale:**
- The guard is already structurally sufficient (a re-appended duplicate always has a `compact_boundary` between first occurrence and tip — see #truncation-analysis); what's missing is only the proof that survives refactoring.

**Implications:**
- No behavior change on the retract path; a failing test now guards the invariant the destructive path depends on.

---

### Deep Dives {#deep-dives}

#### The dead-branch walk and where the fix sits {#walk-mechanics}

`computeDeadEntryIndices` (`tugcode/src/replay.ts`, exported) computes live = ancestor closure of the newest leaf, walking `parentUuid` upward and bridging backwards across compaction breaks (a segment rooting at a `compact_boundary` system record or `isCompactSummary` user record bridges to the newest not-yet-live chain entry before it). Dead roots are off-chain **user submissions** (string content or a non-`tool_result` block) whose resolved parent is live; the dead set is their descendant closure via `childIndices`, with the BFS descending only into children whose `resolveParent` points at *this* occurrence. The `984be56b6` fix replaced a last-wins `indexByUuid` with `occurrencesByUuid: Map<string, number[]>` plus binary-search `resolveParent(childIndex, parentUuid)` → newest occurrence strictly before the child, `undefined` for unknown/forward-only. Exemptions: no-uuid bookkeeping records and `isSidechain: true` entries are never dead. `translateJsonlSession` nulls dead indices before every downstream pass; `hoistCompactCommandEnvelope` then reorders the `/compact` envelope above its boundary record.

#### Contract topology: three segmenters, one law {#contract-topology}

The canonical turn count is `engine(session file)` (`tuglaws/turn-metric.md`). The three implementations and their current inputs:

**Table T01: Segmentation consumers** {#t01-segmenters}

| Consumer | Location | Input today | Input after [P01] |
|----------|----------|-------------|-------------------|
| replay translator (`computeTurns` inside `translateJsonlSession`) | `tugcode/src/replay.ts` | dead-filtered entries (duplicates included) | effective sequence |
| `segmentJsonlOrigins` → `tugcode segment` CLI | `tugcode/src/replay.ts`, `tugcode/src/main.ts` | raw entries (no dead filter) | effective sequence |
| Rust engine (`segment_str` / `segment_turns` + `Frontier`) | `tugrust/crates/tugcast/src/turn_engine.rs`, submission test shared via `user_submission_opens_turn` in `external_sessions.rs` | raw records (no uuid awareness) | effective sequence |

Enforcement points: the real-corpus contract test `engine_matches_tugcode_segmentation_over_real_corpus` (`turn_engine.rs` tests, local-only, spawns `tugcode segment <dir>`) diffs per-turn origins; `agent_bridge.rs` (`feeds/`) validates and stamps `replay_complete.totalTurns` against the engine, logging `contract_breach.replay_total_turns` on mismatch with engine winning. Because the contract compares the TS and Rust halves directly, **they must change in the same commit** (#step-5). The reference-count anchors in the Rust tests (e.g. `engine_counts_reference_session_81`) must be re-measured against the effective sequence and updated in the same commit.

#### Why the truncation path is safe against duplicate anchors {#truncation-analysis}

`computeConversationTruncation` (`tugcode/src/session.ts`) scans lines in order; the boundary is the **first** line whose user-submission record carries the anchor uuid (`boundary === -1` latch), and any compaction marker at/after the boundary yields `compaction_blocked`. A uuid duplicated by a compaction re-append necessarily has its first occurrence *before* the compaction that re-appended it, hence a `compact_boundary` between that occurrence and the tip → the guard refuses. The anchor source (`ActiveTurn.promptUuid`, captured live from the current turn's user record) post-dates the last compaction in normal operation, so duplicated anchors are an edge, not the norm — but the retract path (`interrupt{retract:true}`, applied at `computeConversationTruncation` call sites around `session.ts` `handleInterrupt` / the deferred retraction) truncates bytes, so the edge must be pinned by test, not by reasoning ([P06]). Rust-side audit result: `turn_engine.rs` has zero uuid references; `session_ledger.rs` fingerprints byte prefixes (FNV-1a over the resumable tail), not uuids; `external_sessions.rs` uses uuids only as filename stems.

#### The streaming scanner becomes two-pass on demand {#scanner-two-pass}

The Rust count authority is **not** `segment_str`: the value `agent_bridge.rs` stamps onto `replay_complete` comes from `sessions_recorder.engine_turn_count(...)`, fed by the `external_sessions.rs` scanner — a single forward pass over the file (`BufReader` line loop, "typed extraction… builds no tree") that accumulates `turn_count` via `step_record` as it reads, carrying `Frontier` across incremental resumes. Dead-branch detection is inherently two-pass: the live walk starts at the newest leaf, which a forward stream doesn't know until EOF. Wiring the effective sequence therefore restructures the scanner, not just `segment_str`:

- **During the stream**, additionally buffer each significant record's parsed `SigRecord` (extended per [P03] with `uuid`, `parent_uuid`, sidechain, and compaction-marker fields — it already carries what `segment_turns` consumes) and set two flags: *saw a compaction marker*, *saw a duplicate uuid*. Memory is bounded and small (the largest corpus session is ~11.5 k entries of short tuples).
- **At EOF**, if **neither** flag is set, the buffered records are discarded and the streamed `turn_count` stands — the common no-compaction, no-rewind session keeps today's single-pass cost and byte-identical behavior.
- If **either** flag is set, run the `dead_branch.rs` computation over the buffered records, derive the effective indices, and re-run `segment_turns` over the effective sequence (the buffered `SigRecord`s carry everything segmentation needs; no second disk read). The result replaces the streamed count.
- **Turn-count deltas on resume are handled by the [P03] triggers**: a rewind append can *reduce* previously-counted turns (the branch it strands was already counted), which the incremental path can never express — trigger (b) forces the full re-stream that recounts honestly.

`segment_str` (the full-file entry point used by tests and the contract) applies the same effective-sequence computation, so scanner and kernel cannot drift — both call into `dead_branch.rs`.

**List L01: uuid-keyed consumers in tugcode to audit in #step-3** {#l01-uuid-consumers}

- `computeConversationTruncation` + both apply-time call sites and the eligibility probe (`tugcode/src/session.ts`).
- `ActiveTurn.promptUuid` capture in `routeTopLevelEvent`'s submission test (`session.ts`).
- The rewind-bridge logic covered by `tugcode/src/__tests__/rewind-bridge.test.ts`.
- `computeDeadEntryIndices` (`replay.ts`) — already occurrence-aware; audit confirms only.
- Any remaining `grep -n "uuid" tugcode/src/*.ts` hit not in the above — enumerate and classify (first-wins / last-wins / occurrence-aware / not-an-index) during the step.

#### Generating the adversarial rewind+compaction session {#adversarial-generation}

No session among the 894 in the corpus has both a genuine dead branch and a compaction re-append, which is why Q02's evidence cannot distinguish "fixed" from "over-corrected". The current `claude` CLI offers no headless rewind (`--help` shows `--fork-session`, which creates a *new* session id — a different file, not an in-file branch), so the generation drives the **real Claude Code REPL under tmux** (tmux is bundled with Tug) in a scratch project: several tiny turns → `/compact` → more turns → Esc-Esc rewind to an earlier turn → a diverging submission → `/compact` again. The product is a real JSONL with a genuine abandoned branch and re-append blocks coexisting. Verification: `computeDeadEntryIndices` must mark exactly the rewound-away branch dead and nothing else, and the [P04] validator must pass. The session is then projected (per [P05]) into a second committed fixture with a pinning test, and kept full-fidelity as the app-test seed (#step-7). Fallback if REPL driving proves impractical after a genuine attempt: perform the rewind by hand in a terminal against the scripted session (one-time manual step, still a real session), and record that in the step's commit message.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugcode/src/__tests__/replay-compact-reappend.test.ts` | Fixture-based regression tests for the re-append walk fix and (after #step-5) duplicate suppression |
| `tugcode/src/__tests__/replay-dead-invariants.test.ts` | [P04] property validator + local-only corpus sweep |
| `tugcode/src/__tests__/fixtures/compact-reappend/project-session.ts` | The committed projection script (regenerates fixtures from a real JSONL path) |
| `tugcode/src/__tests__/fixtures/compact-reappend/rewind-and-compact.jsonl` | Projected adversarial fixture (#step-6) |
| `tugrust/crates/tugcast/src/dead_branch.rs` | Rust port of the effective-sequence computation (dead set + first-non-dead-occurrence) |
| `tests/app-test/at0xxx-restore-compact-reappend.test.ts` | Cold-replay restore-completeness app-test (`@covers tugcode/src/replay.ts`) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `suppressReappendDuplicates` | fn | `tugcode/src/replay.ts` | nulls later duplicate occurrences per [P02]; called by `translateJsonlSession` and `segmentJsonlOrigins` |
| `computeEffectiveEntries` (or inline) | fn | `tugcode/src/replay.ts` | dead-null + duplicate-null composition shared by both callers |
| `SigRecord` | struct | `tugrust/crates/tugcast/src/turn_engine.rs` | gains `uuid`, `parent_uuid`, compaction-marker + sidechain bits |
| `Frontier` | struct | `turn_engine.rs` | gains carried leaf uuid for the [P03] branch trigger |
| `compute_dead_entry_indices` / `effective_indices` | fn | `dead_branch.rs` | mirrors the TS walk decision-for-decision |
| `segment_str` | fn | `turn_engine.rs` | shared kernel: applies effective sequence before `segment_turns` |
| scanner EOF second pass | fn | `external_sessions.rs` | #scanner-two-pass: buffer `SigRecord`s + flags; dead+dedup recount at EOF only when flagged — this path feeds `engine_turn_count`, the count authority |
| [P03] invalidation triggers | logic | `external_sessions.rs` | appended compaction marker or mismatched non-sidechain chain parent → full re-stream |
| `frontier_leaf_uuid` (nullable column) | schema | `session_ledger.rs` | added via the self-healing column guard; absent/NULL ⇒ seed non-resumable (one full re-stream) |
| `validateDeadEntryInvariants` | fn | `replay-dead-invariants.test.ts` | [P04] property checks (test-only) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (fixture)** | Pin the walk, suppression, and truncation guard on projected real topology | #step-1, #step-3, #step-4, #step-5, #step-6 |
| **Property (corpus, local-only)** | [P04] invariants over all ~894 real sessions, skip when absent | #step-2, re-run in #step-5 and #step-6 |
| **Contract** | TS↔Rust per-turn origin equality; `totalTurns` stamp agreement | #step-5, #step-8 |
| **App-test** | Real cold-replay chain (`spawnSessionResume`) renders post-compaction work | #step-7 |

#### What stays out of tests {#test-non-goals}

- Hand-authored synthetic JSONL topologies as primary evidence — banned by the real-content doctrine; fixtures are projections of real sessions.
- Deck reducer re-tests of `committedMsgIds` dedupe — already covered by `reducer.no-content-dedupe.test.ts`; this plan does not change the reducer.
- A committed multi-MB full-fidelity session — full-fidelity assertions run local-only ([P05]).
- Driving a real `claude` inside CI/app-tests — real-claude flows are on-demand only; the app-test replays a seeded fixture with no live model.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Pin the re-append walk fix with the committed fixture | done | `da97265cc` |
| #step-2 | Dead-set property validator + corpus audit | done | `a58289b63` |
| #step-3 | Truncation duplicate-anchor safety + uuid-consumer audit | done | `f9280506d` |
| #step-4 | Rust dead-branch/effective-sequence module (unwired) | done | `5239655cd` |
| #step-5 | Effective sequence everywhere, atomically | done | `ec2903f41` |
| #step-6 | Adversarial rewind+compaction session | done | `240a8bcd7` (re-append half not reproducible on 2.1.219) |
| #step-7 | Restore-completeness app-test | done | `03120ceb3` (manual `8b8d7bf1` check pending the debug build) |
| #step-8 | Integration checkpoint | done | `N/A (verification only)` |

#### Step 1: Pin the re-append walk fix with the committed fixture {#step-1}

**Commit:** `tugcode(replay): pin compaction re-append dead-branch rescue with fixture regression tests`

**References:** [P05] Fixture doctrine, [Q05], (#walk-mechanics, #q05-fixture-provenance)

**Artifacts:**
- `tugcode/src/__tests__/replay-compact-reappend.test.ts` consuming `fixtures/compact-reappend/chain-topology.jsonl`.
- `tugcode/src/__tests__/fixtures/compact-reappend/project-session.ts` — the projection script, committed so the fixture is regenerable (currently only a /tmp throwaway exists; recreate from the brief's recipe: keep `uuid`, `parentUuid`, `type`, `subtype`, `isSidechain`, `isCompactSummary`, `isMeta`, `message.content` shape with long strings clipped, real file order).

**Tasks:**
- [ ] Measure the fixture's expected values once (dead-set size, chain-entry count, duplicated-uuid count) by running `computeDeadEntryIndices` over it; assert those exact values.
- [ ] Assert the dead set is empty (or the measured ≤1) and specifically that the fixture's analog of the rescued block (the entries downstream of the re-append) is not dead.
- [ ] Add a reverted-behavior tripwire: recompute with a deliberately last-wins parent resolution (test-local reimplementation of the old `indexByUuid` walk) and assert it produces a large dead set on the same fixture — proving the fixture actually discriminates.
- [ ] Write and commit `project-session.ts`; regenerate the fixture with it and confirm byte-identical output (or update the fixture in the same commit if the throwaway differed).

**Tests:**
- [ ] `bun test tugcode/src/__tests__/replay-compact-reappend.test.ts`

**Checkpoint:**
- [ ] New test fails when the `984be56b6` replay.ts hunk is reverted locally (`git stash` the revert afterward); passes on main.
- [ ] `cd tugcode && bun test` — full suite green.

---

#### Step 2: Dead-set property validator + corpus audit {#step-2}

**Depends on:** #step-1

**Commit:** `tugcode(replay): assert dead-branch invariants as properties over fixture and local corpus`

**References:** [P04] Property validation, [Q02], Risk R01, (#q02-dead-zero-correct, #walk-mechanics)

**Artifacts:**
- `tugcode/src/__tests__/replay-dead-invariants.test.ts` with `validateDeadEntryInvariants` and two suites: fixture-based (always runs) and corpus-based (local-only, skips with a message when `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/` is absent — mirror the skip pattern of `turn_engine.rs`'s `reference_corpus_dir`).

**Tasks:**
- [ ] Implement the three [P04] properties; run them over every corpus session.
- [ ] Diff pre-fix vs post-fix dead sets on the five affected sessions (`29e49a13`, `130fec67`, `0744463c`, `8b8d7bf1`, `31c60766`) using a test-local reimplementation of the old walk; inspect every entry that left the dead set and confirm each is either inside a re-append block or downstream of one — no rescued entry may be a live-parented off-chain user submission bypassed by its successor.
- [ ] Guard against dead-branch detection going silent: the committed assertion is "at least one corpus session has a non-empty dead set that passes all properties" (no private session ids hardcoded); the suite additionally **logs** the count of non-empty-dead sessions so the checkpoint can compare it against the brief's observed 7.

**Tests:**
- [ ] `bun test tugcode/src/__tests__/replay-dead-invariants.test.ts` (with corpus present).

**Checkpoint:**
- [ ] Corpus suite reports every session validated, 0 property violations; the asserted floor (≥1 non-empty dead set) holds, and the logged count is checked by eye against the brief's observed 7 (a drop below that is investigated, not asserted).
- [ ] `cd tugcode && bun test` green.

---

#### Step 3: Truncation duplicate-anchor safety + uuid-consumer audit {#step-3}

**Depends on:** #step-1

**Commit:** `tugcode(session): pin rewind-truncation safety against duplicate-uuid anchors`

**References:** [P06] Truncation safety, [Q04], List L01, (#truncation-analysis, #l01-uuid-consumers)

**Artifacts:**
- New tests in `tugcode/src/__tests__/retract-prompt.test.ts` (or a sibling) built from a projected slice of a real re-append region.
- Doc-comment updates on `computeConversationTruncation` stating the first-occurrence scan and why the compaction guard covers duplicates.

**Tasks:**
- [ ] Test: an anchor whose uuid occurs twice (original + re-append) yields `compaction_blocked` — never `ok` at either occurrence's line.
- [ ] Test: an anchor after the last compaction (the normal live case) still yields `ok` with the correct boundary in a file containing unrelated duplicate uuids earlier.
- [ ] Complete the List L01 audit: classify every `uuid` hit in `tugcode/src/*.ts`; fix any last-wins site found (none expected per #truncation-analysis; if found, fix in this commit with its own test).

**Tests:**
- [ ] `bun test tugcode/src/__tests__/retract-prompt.test.ts`

**Checkpoint:**
- [ ] Both new tests green; audit classification recorded in the commit message body.
- [ ] `cd tugcode && bun test` green.

---

#### Step 4: Rust dead-branch/effective-sequence module (unwired) {#step-4}

**Depends on:** #step-1

**Commit:** `tugcast(turn-engine): port occurrence-aware dead-branch detection to Rust (unwired)`

**References:** [P01] Effective sequence, [P03] Incremental invalidation, [Q03], Table T01, (#contract-topology, #walk-mechanics)

**Artifacts:**
- `tugrust/crates/tugcast/src/dead_branch.rs`: `compute_dead_entry_indices` + `effective_indices` mirroring the TS walk decision-for-decision (occurrence lists, binary-search parent resolution, compaction bridging, live-parented user-submission dead roots, occurrence-checked BFS, sidechain/no-uuid exemptions, then first-non-dead-occurrence suppression per [P02]).
- `SigRecord`/`parse_significant` extensions (`uuid`, `parent_uuid`, compaction + sidechain markers) — additive, nothing wired yet.

**Tasks:**
- [ ] Port the walk; keep the TS doc comment's invariant statement ("a parent always precedes its child; resolve to the newest occurrence strictly before the child") in the module docs.
- [ ] Unit tests over `chain-topology.jsonl` (path-relative to the workspace: `../../tugcode/src/__tests__/fixtures/compact-reappend/chain-topology.jsonl` from the crate — verify the relative path from `CARGO_MANIFEST_DIR` at implementation) asserting the same measured values as #step-1's TS test.
- [ ] Local-only corpus test: for every session, Rust dead set == TS dead set (add a `tugcode dead <file-or-dir>` sibling to `tugcode segment` in `tugcode/src/main.ts` emitting `{basename: [indices]}`, same spawn pattern as the existing contract test).

**Tests:**
- [ ] `cd tugrust && cargo nextest run -p tugcast dead_branch`

**Checkpoint:**
- [ ] Fixture values identical across TS and Rust; corpus dead-set parity 0 divergent (local).
- [ ] `cd tugrust && cargo build` warning-clean.

---

#### Step 5: Effective sequence everywhere, atomically {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `restore(effective-sequence): segment and replay live first-occurrence entries on both contract halves`

**References:** [P01], [P02], [P03], [Q01], [Q03], Table T01, Risk R01, (#contract-topology, #p02-first-occurrence, #p03-incremental-invalidation)

**Artifacts:**
- TS: `suppressReappendDuplicates` applied in `translateJsonlSession` (after dead-nulling, before `hoistCompactCommandEnvelope`) and in `segmentJsonlOrigins` (dead filter + suppression, matching the translator exactly), scoped to chain entries per [P02].
- Rust, in dependency order: (a) `segment_str` computes the effective sequence via `dead_branch.rs` before `segment_turns` (the shared kernel); (b) the **`external_sessions.rs` scanner** — the actual count authority behind `sessions_recorder.engine_turn_count` — restructured per #scanner-two-pass (buffer extended `SigRecord`s, flags for compaction-marker/duplicate-uuid, EOF second pass only when flagged); (c) the [P03] invalidation triggers on the incremental resume path (`Frontier` carries the previous leaf uuid; appended compaction marker or mismatched non-sidechain chain parent → full re-stream); (d) the leaf-uuid ledger column in `session_ledger.rs` via the self-healing column guard, with absent/NULL treated as non-resumable ([P03] ledger persistence).
- `tuglaws/turn-metric.md` updated: canonical count defined over the effective record sequence, with the re-append and dead-branch rationale.
- Re-measured reference anchors in `turn_engine.rs` tests (e.g. `engine_counts_reference_session_81`) updated to effective-sequence counts in this same commit.

**Tasks:**
- [ ] Implement TS suppression; extend `replay-compact-reappend.test.ts`: emitted `turn_complete` count == distinct `msg_id` count on the fixture; all 9 boundary analogs still emit; chronology (first-occurrence positions) preserved; sidechain/no-uuid records never suppressed.
- [ ] Implement Rust wiring per #scanner-two-pass: extend `SigRecord`/`parse_significant`, wire `dead_branch.rs` into `segment_str`, restructure the scanner's EOF second pass, add the [P03] triggers and the leaf-uuid ledger column (self-healing guard; absent/NULL ⇒ full re-stream once).
- [ ] Rust tests: a no-compaction session takes the single-pass path (assert via the flags); place an artificial incremental split inside the fixture's re-append block and assert incremental-with-fallback == full re-segment; a pre-change seed row (NULL leaf uuid) triggers exactly one full re-stream then resumes incrementally.
- [ ] Re-run the [P04] corpus validator (unchanged expectations — suppression must not alter dead sets).
- [ ] Run the real-corpus contract test and re-measure: expect 0 divergent sessions and, on `8b8d7bf1`, 59 turns from both halves.
- [ ] Verify replay of `8b8d7bf1` end-to-end via a local probe (the brief's `/tmp/probe-replay-8b8.ts` recipe): frames mentioning `gallery-pulse-display` ≥ 39, `compact_summary` frames == 9, no duplicate turn emission.

**Tests:**
- [ ] `cd tugcode && bun test`
- [ ] `cd tugrust && cargo nextest run` (includes `engine_matches_tugcode_segmentation_over_real_corpus` locally)

**Checkpoint:**
- [ ] Both suites green; contract test 0 divergent; `tsc` clean in tugcode.
- [ ] Local probe on `8b8d7bf1`: emitted turns == distinct msg_ids == engine count.

---

#### Step 6: Adversarial rewind+compaction session {#step-6}

**Depends on:** #step-5

**Commit:** `tugcode(replay): pin coexisting rewind branch and compaction re-append with a generated real session`

**References:** [P04], [P05], [Q02], Risk R01, (#adversarial-generation, #q02-dead-zero-correct)

**Artifacts:**
- The generated real session JSONL (scratch project, throwaway prompts) — kept locally full-fidelity, projected via `project-session.ts` into `fixtures/compact-reappend/rewind-and-compact.jsonl`.
- Pinning tests in `replay-compact-reappend.test.ts`: exactly the rewound-away branch is dead; the re-append block's entries are live; the [P04] validator passes.

**Tasks:**
- [ ] Drive the real Claude Code REPL under tmux per #adversarial-generation (cheapest model available; a handful of one-line turns). Attempt the scripted route first; fall back to a one-time manual rewind in a real terminal only if scripting genuinely fails, and say so in the commit message.
- [ ] Verify the generated file has ≥1 duplicated uuid (re-append present) and a dead branch whose root is a live-parented off-chain user submission; regenerate with more turns if compaction preserved everything.
- [ ] Project, commit, pin; also run the Rust `dead_branch.rs` fixture test over the new fixture for parity.

**Tests:**
- [ ] `bun test tugcode/src/__tests__/replay-compact-reappend.test.ts`
- [ ] `cd tugrust && cargo nextest run -p tugcast dead_branch`

**Checkpoint:**
- [ ] The new fixture's dead set is exactly the rewound branch (assert the specific indices), TS and Rust agreeing.

---

#### Step 7: Restore-completeness app-test {#step-7}

**Depends on:** #step-6

**Commit:** `app-test(restore): cold-replay a compaction re-append session and assert post-compaction turns render`

**References:** [P05], [Q06], (#q06-app-verification, #adversarial-generation)

**Artifacts:**
- `tests/app-test/at0xxx-restore-compact-reappend.test.ts` (next free at-number; `@covers tugcode/src/replay.ts` and `@covers tugrust/crates/tugcast/src/turn_engine.rs`), seeding the #step-6 full-fidelity session (checked into `tests/app-test/` fixture space if small enough after review, else the projected fixture with content-agnostic assertions) at `~/.claude/projects/<encode(projectDir)>/<tugSessionId>.jsonl` and driving `spawnSessionResume` (`tests/app-test/_harness/client.ts`) — the only harness verb exercising the true cold-replay delivery chain.

**Tasks:**
- [ ] Assert the transcript renders turns from *after* the last compaction (row presence by address and, if the full-fidelity seed is used, by marker text planted in the generated session's prompts).
- [ ] Assert the rendered turn count equals the engine's effective-sequence count (no duplicate rows, no missing tail) via the transcript's highest rendered address.
- [ ] Manual verification: open session `8b8d7bf1` in the running debug app; confirm the `gallery-pulse-display` work (commit `b24bac499`'s turns, 2026-07-27 19:04–20:29Z) is present and appears once. Note: restart tugcode-backed sessions first — running sessions keep their pre-fix tugcode process.

**Tests:**
- [ ] `just app-test tests/app-test/at0xxx-restore-compact-reappend.test.ts`

**Checkpoint:**
- [ ] `just app-test-covers-check` passes; the new app-test is green; the manual `8b8d7bf1` check is confirmed in-session.

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P06], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify every success criterion in #success-criteria against the landed work.
- [ ] Confirm no `contract_breach.replay_total_turns` lines in tugcast logs while replaying the five affected sessions locally.

**Tests:**
- [ ] `cd tugcode && bun test` and `bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test` and `bunx vite build`
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] All four suites green; `just app-test-changed` selection green; success criteria all check off.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Session restore that provably replays every live turn exactly once — dead branches suppressed, compaction re-appends deduplicated, the canonical turn count agreeing with the rendered transcript on both contract halves — with regression tests, corpus-wide property validation, and app-level coverage guarding it.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All six brief open questions resolved as recorded in #open-questions (verification: each [Q] block's resolution matches landed behavior).
- [ ] Every #success-criteria bullet verified in #step-8.
- [ ] `tuglaws/turn-metric.md` documents the effective record sequence.

**Acceptance tests:**
- [ ] `replay-compact-reappend.test.ts` (fixture + adversarial fixture + suppression assertions)
- [ ] `replay-dead-invariants.test.ts` corpus sweep
- [ ] `engine_matches_tugcode_segmentation_over_real_corpus` with 0 divergent
- [ ] `at0xxx-restore-compact-reappend` app-test

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Retire the brief: archive `dash/restore-issues-brief.md` once this phase closes (user's landing gesture).
- [ ] Consider surfacing a "session repaired on restore" telemetry counter when suppression/dead-filtering changes a session's turn count, for future incident forensics.
- [ ] Evaluate whether the deck's `committedMsgIds` replay-path dedupe can be demoted to an assertion once suppression has soaked.

| Checkpoint | Verification |
|------------|--------------|
| Fixture regression pinned | #step-1 tripwire test red on reverted walk |
| Dead sets proven, not counted | #step-2 corpus sweep, 0 violations |
| Destructive path safe | #step-3 duplicate-anchor tests green |
| Contract halves agree | #step-5 corpus contract 0 divergent |
| Adversarial case covered | #step-6 exact-dead-set assertion |
| App restores completely | #step-7 app-test + manual `8b8d7bf1` check |
