<!-- devise-skeleton v4 -->

## Canonical Turns Redux — origin-first turns, one count engine {#canonical-turns-redux}

**Purpose:** Make a session's turn count honest, attribution-faithful, and identical at every touch point, by reworking the turn model so each turn carries an intrinsic origin (never inferred, never faked) and by making one segmentation engine the single producer of the count that both the picker and the resume authority consume.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (implemented on a `tugutil dash` worktree) |
| Last updated | 2026-06-16 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The original canonical-turns project (Phase 1 + 2, merged to main) aimed to make one turn count agree everywhere. It failed on real sessions: session `49e9aec6` showed **59** in the picker, **81** once opened, then **81** in the picker only after a resume reconciled the ledger. Root-cause audit (read-only) found two faults and one meta-cause:

- **Two counting models.** tugcode opens a turn from two sources — a real `type:user` submission (`handleUserEntry`) *and* a synthesized empty `add_user_message` (`content: []`) minted by `handleAssistantEntry` whenever assistant output arrives with no open turn (`--continue`, `/compact`, a skipped slash/`isMeta` user side, or a leading orphan). That synthesized opener counts as a turn and **renders as a phantom user row** (the unexplained `#u0020`). The disk scanner mirrors only the user-entry path and never models assistant-originated openers, so it cannot reproduce the count.
- **Cache below its own rule.** A faithful full application of the scanner's documented rule yields 66, but the cache held 59 — the incremental resume path drops openers a full scan would catch.
- **Meta-cause.** The "four-way equality" was proven only on a small, hand-built, privacy-sanitized golden corpus that omitted every hard real shape (assistant-originated turns, `/compact`, slash commands, leading orphans, incremental tails). The contract test stayed green while real sessions diverged, and the scanner's Rust rule was a hand-mirror of one of tugcode's two opener paths.

The deeper defect is a data-model lie: attribution is *inferred* from `messages[0].kind === "user_message"`, and the only way to mint a turn container was a user (or wake) opener — so orphan assistant content was forced into a fake user message. We will not patch this; we will redesign so the lie is unrepresentable and the count has a single producer.

#### Strategy {#strategy}

- **Origin-first, not turn-first.** A turn is a container with an *intrinsic, stated* origin. The user-message slot exists only when the user actually submitted — fabricating one becomes impossible by construction ([P01]).
- **Assistant-originated turns are first-class.** Wakes, `/compact` continuations, `--continue` leading orphans, and any orphan assistant output open an *assistant-originated* turn: no user row, no fake user message, addressed `#a{turn}` ([P02], [P03]). The existing wake path already proves this shape works end to end.
- **One engine produces the count.** A single Rust segmentation engine in tugcast parses a session into ordered, origin-tagged turns and is the sole producer of the count for *both* the picker (pre-open scan) and the resume authority. tugcode's rendering segmentation is held byte-for-byte equal to the engine by a contract over real sessions ([P05]).
- **The count never shifts.** Because the picker count and the authority count come from the same producer, a session shows the same number before and after it is opened ([P06]).
- **All containers count, honestly attributed.** "N turns" is the count of turn containers; each is `#u` (user) or `#a` (assistant); no `#x` ([P03], [P04]).
- **Verify against reality.** Drive verification from the real local session corpus, not curated fixtures; delete the sanitized golden corpus; accept local-only tests; freely alter or delete tests that no longer hold the bar ([P07]).

#### Success Criteria (Measurable) {#success-criteria}

- For every session JSONL under the active project's real corpus, the engine's turn count equals tugcode/tugdeck's rendered turn count (highest `#a`/`#u` address) — 100%, including sessions with `--continue`, `/compact`, slash commands, wakes, and leading orphans. (Contract test over the real corpus, #step-7.)
- Session `49e9aec6` shows the **same** turn number in the picker before it is opened and after it is opened and closed; that number equals the highest rendered address. (Real-app check, #step-9.)
- No turn the user did not initiate renders a user row, and tugcode emits **zero** `add_user_message` frames with empty content. (Code grep + render inspection, #step-5, #step-9.)
- The picker's turn count is produced by the engine, not a separate estimator that is later reconciled — verified by removing the seed-then-reconcile path and confirming no count mutation occurs on resume for an unchanged file. (#step-4, #step-9.)

#### Scope {#scope}

1. A single Rust turn-segmentation engine in tugcast that yields ordered, origin-tagged turns and the canonical count.
2. The disk scan / picker count sourced from the engine; cache keyed and epoch-bumped; incremental scan made correct.
3. The resume authority sourced from the engine so picker == authority (no shift).
4. tugcode opener vocabulary: an honest assistant-originated opener replaces the synthesized empty `add_user_message` (replay and live).
5. tugdeck turn model: origin-explicit `TurnEntry`; assistant-originated turns render assistant-only; `#u`/`#a` per row, no `#x`.
6. A real-session contract gating tugcode/tugdeck segmentation against the engine, plus deletion of the sanitized golden corpus.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Shell (`#s`) turns — the origin model reserves the prefix but no shell rendering ships here.
- Redesigning transcript rendering beyond turn origin and per-row addressing.
- Changing the live streaming wire beyond the opener-vocabulary change.
- Re-deciding the `#u`/`#a` marker placement (already settled: one address per attribution row, right-aligned).

#### Dependencies / Prerequisites {#dependencies}

- The merged canonical-turns Phase 1+2 work on main (the wire window metadata, the `#u`/`#a` rendering, the picker subtitle) — this plan reworks the count production beneath them.
- Read access to the real local session corpus (`~/.claude/projects/<project>/*.jsonl`) for verification.

#### Constraints {#constraints}

- Rust workspace is warnings-as-errors (`-D warnings`).
- tugcode is bun-compiled — rebuild after edits; no HMR. tugdeck is HMR-live.
- Real-app behavior verified via `just app-test` (greppable `VERDICT: PASS|FAIL`); pure logic via `bun:test` / `cargo nextest`. Banned: fake-DOM/RTL, mock-store assertion tests.
- The disk scan must stay fast on multi-hundred-MB sessions (the incremental-resume design exists for this reason and must be preserved, but made correct).

#### Assumptions {#assumptions}

- The count value for existing sessions does not need to change (all containers still count); only attribution honesty and picker correctness change. The synthesized openers that were counted (e.g. the 15 in `49e9aec6`) remain counted — now as honest `#a` turns, not phantom `#u` rows.
- A faithful Rust engine can reproduce tugcode's segmentation decisions; where it cannot, that is a bug in one of them surfaced by the contract.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Standard devise-skeleton conventions apply: explicit kebab-case anchors, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`, two-digit IDs, `**Depends on:**` by anchor, rich `**References:**` lines, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How is the count sourced so there is exactly one authority? (DECIDED) {#q01-wire-count-source}

**Question:** The ledger count is written today by three paths — `record_spawn` (scan-cache seed), `set_turn_count` from `parse_replay_complete_total_turns` (tugcode's wire `totalTurns`), and `record_turn` (+1 per live `turn_complete`). The client also needs `totalTurns`/`firstLoadedTurnIndex` on the wire for windowing. With three writers and a wire-authored number, "one authority" is a contradiction.

**Resolution:** DECIDED (see [P08]). The engine is the single count authority and the count is `engine(session file)`:
- **Resume:** `set_turn_count` is fed by the engine — the fingerprint-validated cached `engine(file)`, or, when there is no cache entry (a resume that bypassed a picker scan), the engine run on the resolved file path (`project_dir` + `claude_session_id` + `.jsonl`). `parse_replay_complete_total_turns` as a count source is removed.
- **Live:** `record_turn`'s `turn_count + 1` increment is removed as a count authority; its `last_used_at` touch is preserved separately. A live session's ledger count is refreshed by the **existing scan-on-`list_sessions`** path (picker open), not a new per-append trigger; between scans the live card's badge (tugcode rendering) is the live truth, and live-row *visibility* rides the file-bytes / live-state signal (`file_size > 0 || state === "live"`, dev-picker-data-source), not `turn_count`, so a stale-between-scans count hides nothing.
- **Wire (validate-and-stamp, not blind stamp):** `resolveWindow` derives **both** `totalTurns` and `firstLoadedTurnIndex` from tugcode's `computeTurns`; the headline equality (*highest rendered address == count*) is `firstLoadedTurnIndex + loadedTurns`, so the window base must agree with the engine, not just `totalTurns`. At the `replay_complete` rewrite point (where `agent_bridge` already rewrites outbound frames via `inject_replay_telemetry`), tugcast **asserts tugcode's wire `totalTurns` equals `engine(file)` and stamps the engine value**. When they agree (the healthy case) the window indices are coherent by construction; a mismatch is logged loudly as a contract breach, the engine value wins, and the divergent session is surfaced — a runtime signal, never a silent split.
- The only place tugcode segments independently is the **in-flight live turn's rendering** (not yet on disk) — rendering, not a count authority, and the lone transient ([P08]).

#### [Q02] Counting policy and addressing for non-user turns (DECIDED) {#q02-counting-policy}

**Question:** Do wakes and continuation/orphan turns count, and how are they addressed?

**Resolution:** DECIDED (see [P03], [P04]). Yes — every turn container counts. There is **no `#x`**: wakes and continuations are the assistant speaking, rendered assistant-only and addressed `#a{turn}`. `#u` appears only for genuine user submissions.

#### [Q03] Engine cost at scan time on large/incremental files (OPEN) {#q03-engine-incremental-cost}

**Question:** The engine must run at scan time for the picker, including incremental appends to live multi-hundred-MB sessions, without the undercount that the old incremental path exhibited.

**Why it matters:** Correctness regressed precisely in the incremental path (cache 59 vs full 66). A naive "full re-segment every scan" is correct but may be too slow.

**Plan to resolve:** #step-2/#step-3 — design the engine so incremental resume carries forward *engine state* (open-turn state at the frontier), not just a count, and test the incremental append path explicitly on a real growing session.

**Resolution:** OPEN — resolve in #step-2/#step-3.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Engine (Rust) and tugcode (TS) segmentation drift | high | med | Real-corpus contract on count + per-turn origin; runtime highest-badge == engine assertion | any contract failure |
| Incremental scan undercount recurs | high | med | Carry engine state across the frontier; test real incremental appends | count != full re-scan |
| Migration of stale ledger/cache counts | med | high | Epoch bump invalidates caches AND re-`set_turn_count`s every ledger row from the engine on re-scan (#step-4) | wrong count after upgrade |
| Realistic corpus is local-only (not CI-portable) | med | high | Accept local-only verification; document; keep a small portable smoke set drawn from real shapes | CI needs a gate |
| Live badge leads `engine(file)` by the in-flight turn | low | high | It is rendering, not a count authority; picker at-rest and resumed counts are always `engine(file)` (R05) | live badge != at-rest count after idle |

**Risk R01: Two-language segmentation drift** {#r01-segmentation-drift}

- **Risk:** The engine and tugcode's rendering segmentation disagree on some real session shape not in the corpus.
- **Mitigation:** Contract over the *full* real local corpus (not a sample); a runtime invariant that the highest rendered address equals the engine count; the contract is the gate for every step that touches segmentation.
- **Residual risk:** Live-only event orderings never written to any JSONL cannot be in a file-based corpus; covered only by `just app-test` live drives.

**Risk R02: Incremental correctness** {#r02-incremental-correctness}

- **Risk:** The fast incremental scan path diverges from a full segmentation (the original Gap #2).
- **Mitigation:** The resume seed persists open-turn engine state, not just an offset+count; an explicit test appends to a real session and asserts incremental == full.
- **Residual risk:** A prefix rewrite mid-session forces a full re-parse (already handled by the tail-fingerprint check).

**Risk R03: Headline count change for some sessions** {#r03-count-change}

- **Risk:** If the engine's honest segmentation differs from tugcode's current total for some session, the displayed count changes on upgrade — and existing ledger rows hold stale values the cache epoch alone won't fix.
- **Mitigation:** The engine reproduces tugcode's *current* total (all containers count), so values are stable; the #step-4 migration re-`set_turn_count`s existing rows from the engine on re-scan; any change is a surfaced correction, not silent.
- **Residual risk:** A genuinely mis-counted historical session will show a corrected number — acceptable and desirable.

**Risk R05: Live count leads the at-rest count by one in-flight turn** {#r05-live-transient}

- **Risk:** During a live session the open card's badge (tugcode rendering) can show one more turn than `engine(file)` until the JSONL flushes and the next engine pass runs.
- **Mitigation:** This is rendering of an in-flight (uncommitted-to-disk) turn, not a second count authority; the picker's at-rest count and the resumed count are always `engine(file)`; the in-flight turn commits to disk and is then counted by the engine like any other.
- **Residual risk:** A momentary +1 on the live card vs a freshly-scanned picker row while a turn is mid-flight — bounded to one turn, self-resolving at idle.

---

### Design Decisions {#design-decisions}

#### [P01] Origin is intrinsic and unforgeable; no fabricated user messages (DECIDED) {#p01-origin-intrinsic}

**Decision:** Every turn carries an explicit origin set by its producer; a user message exists in a turn only when the user actually submitted one. The model makes "a non-user turn presented as a user action" structurally impossible.

**Rationale:**
- The original lie (`add_user_message{content:[]}`) came from inferring attribution from `messages[0].kind` and welding container-creation to a user opener.
- Honesty to user actions is a non-negotiable invariant: code-constructed entities must never masquerade as something the user did.

**Implications:**
- The synthesized empty `add_user_message` is deleted from tugcode (replay synth and the live empty-opener follow-up).
- `TurnEntry` no longer infers user-ness from `messages[0]`; origin is a first-class property of the turn produced by the wire opener.

#### [P02] A turn is an origin-explicit container; assistant-originated turns are first-class (DECIDED) {#p02-container}

**Decision:** Opening a container to hold assistant output is distinct from asserting a user action. Wakes, `/compact` continuations, `--continue` leading orphans, and orphan assistant output open an *assistant-originated* turn — no user row, no user message — exactly as a wake turn already does.

**Rationale:**
- The reducer genuinely needs a container (`pendingTurn`) for assistant content; the wake path already creates one honestly without a user message.
- Unifying all non-user openers onto one honest mechanism removes the special-case fabrication.

**Implications:**
- A single non-user opener mechanism replaces both `wake_started`'s ad-hoc handling and the synthesized user opener; the open primitive is origin-parameterized and seeds an empty message scratch for `origin: "assistant"` (Spec S02).
- `PendingTurn`/`TurnEntry` gain `origin`; the `isWake` boolean and the `messages[0]` user-ness inference are removed; `wakeTrigger` remains an optional annotation on an assistant-origin turn.
- Row layout: an assistant-originated turn is one assistant row (no user row), like a wake today.

#### [P03] Per-row addressing by speaker: `#u`, `#a`, `#s`; no `#x` (DECIDED) {#p03-addressing}

**Decision:** Each attribution row is addressed `#{speaker}{turn}`: `#u` user, `#a` assistant, `#s` shell (reserved). Wakes and continuations are the assistant speaking → `#a`. There is no "other" prefix.

**Rationale:**
- The visible content of a wake/continuation turn is assistant output; attributing it to the assistant is honest and keeps the scheme to the actual speakers.

**Implications:**
- A user turn renders `#u{turn}` (user row) + `#a{turn}` (assistant row), sharing the turn number.
- An assistant-originated turn renders only `#a{turn}`.

#### [P04] All turn containers count toward the canonical total (DECIDED) {#p04-count-all}

**Decision:** "N turns" is the count of turn containers — user-originated and assistant-originated alike — each honestly attributed.

**Rationale:**
- Each container is a real unit of conversational activity; the user chose total-activity semantics.
- Keeps the value stable vs today's tugcode total (which already counts the synthesized openers), so the change is attribution + correctness, not a renumber.

**Implications:**
- The engine counts every container; the picker headline equals the highest rendered address.

#### [P05] One segmentation engine is the single count producer (DECIDED) {#p05-one-engine}

**Decision:** A single Rust engine in tugcast segments a session into ordered, origin-tagged turns and produces the canonical count for *both* the picker scan and the resume authority. tugcode/tugdeck rendering segmentation is held equal to the engine by a contract over real sessions ([P07]).

**Rationale:**
- The divergence came from two implementations (tugcode TS authority + scanner Rust mirror) that were destined to drift.
- One producer for the *number* eliminates the class of bug; rendering equality is then a verified property, not a second source of truth.

**Implications:**
- The scanner's `user_submission_opens_turn` counting is replaced by the full engine.
- The resume reconcile reads the engine, not a tugcode-authored total — and the live and scan writers also resolve to the engine ([P08], [Q01]). There is exactly one count writer.

#### [P06] The picker count never shifts (DECIDED) {#p06-no-shift}

**Decision:** The picker's turn count is the engine's count — identical before and after a session is opened. There is no seed-from-estimate-then-reconcile-to-a-different-number path.

**Rationale:**
- A number that changes when you open a session is the precise symptom the user rejected.

**Implications:**
- Remove the path where a divergent scan estimate seeds the ledger and a resume later overwrites it with a different value — both now resolve to `engine(file)` ([P08]).
- For an unchanged file, opening a session causes no count mutation (scan and resume produce the identical engine value).

#### [P07] Verify against the real local corpus; no sanitized fixtures (DECIDED) {#p07-real-corpus}

**Decision:** Drive verification from the real local session corpus where it sits; delete the sanitized golden corpus; permit local-only (non-checked-in) verification; freely alter or delete tests that no longer hold the bar.

**Rationale:**
- The narrow, privacy-sanitized golden corpus is exactly why the gaps survived. Correctness against real data outranks a checkable, portable fixture.

**Implications:**
- The contract (#step-7) runs over `~/.claude/projects/<project>/*.jsonl`.
- `scanner_turn_counts_match_golden_corpus` and its fixtures are removed or repurposed.
- A small portable smoke set may be kept, but only if drawn from real shapes (continue/compact/slash/wake/orphan), never invented-tidy.

#### [P08] The engine is the single count authority; the ledger is a cache of `engine(file)` (DECIDED) {#p08-single-authority}

**Decision:** A session's canonical turn count is defined as `engine(session file)` and nothing else. The ledger's `turn_count` is a cache of that value, refreshed only via the engine; there is exactly one writer of the count. All competing count writers are removed.

**Rationale:**
- "One authority" is meaningless while three paths write the count (`record_spawn` seed, wire-`totalTurns` reconcile, live `record_turn`+1) and the authority's number is parsed off tugcode's wire. The divergence we hit (59/66/81) is the direct result.
- Defining the count as a pure function of the file gives one number, recomputable anywhere, that cannot drift from itself.

**Implications:**
- `parse_replay_complete_total_turns` is removed as a count source; resume `set_turn_count` reads the engine — cached `engine(file)` (fingerprint-validated), or the engine run on the resolved file path when no cache entry exists ([Q01]).
- `record_turn`'s `turn_count + 1` is removed as a count authority; it keeps only its `last_used_at` touch. The live ledger count is refreshed by the existing scan-on-`list_sessions` path, not a per-append trigger; live-row visibility rides `file_size > 0 || state === "live"` (dev-picker-data-source), not `turn_count`, so a stale-between-scans count hides nothing.
- **Validate-and-stamp (not blind stamp):** because `firstLoadedTurnIndex` (the window base, from tugcode `computeTurns`) co-determines the highest rendered address, tugcast asserts tugcode's wire `totalTurns` equals `engine(file)` at the `replay_complete` rewrite point and stamps the engine value; a mismatch is logged as a contract breach (engine wins) so window indices can never silently diverge from the count ([Q01]).
- The migration (#step-4): the epoch bump invalidates the scan cache **and** the next scan re-`set_turn_count`s every existing ledger row from the engine (not only sparse/absent rows), **live rows included** — `engine(file)` is the correct on-disk count (the scanner's frontier ignores the in-progress final line), so a live row is corrected too, not skipped; the bounded badge-vs-`engine(file)` difference is the in-flight transient (Risk R05), not a clobber.
- **Known, bounded transient:** during a live session the open card's badge (tugcode rendering) may lead `engine(file)` by the single in-flight turn until the file flushes and the next engine pass runs. This is rendering, not a second count authority; the picker's at-rest count and the resumed count are always `engine(file)`. Captured as Risk R05.

---

### Specification {#specification}

**Spec S01: Turn origin model** {#s01-origin-model}

A session is an ordered list of **turns**. Each turn has:
- an `origin`: `user` | `assistant` (shell reserved, not emitted this phase);
- a `messages` sequence (the [D07] content substrate);
- a user message present **iff** `origin === user`.

A turn opens when:
- a genuine user submission arrives (`origin: user`) — excludes `isMeta`, interrupt marker, tool-result-only, `/compact` summary, slash-command scaffolding; or
- assistant content arrives with no open turn — a wake/`<task-notification>`, a `/compact` continuation, a `--continue` leading orphan, or any orphan assistant output (`origin: assistant`).

The canonical count = number of turns (all origins). The highest rendered address equals the count.

**Spec S02: Honest opener vocabulary and turn construction** {#s02-opener-vocabulary}

*Wire openers:*
- `add_user_message` is emitted **only** for a genuine user submission, and never with empty/synthetic content.
- A **neutral assistant-originated opener** (no wake baggage) opens an `origin: assistant` turn with no user message. A **wake** is this same opener carrying an optional `wakeTrigger` annotation — the wake is an *annotation on* an assistant-originated turn, not a distinct attribution path. (`wake_started` is either generalized into this opener or retained as the annotated variant.)
- The synthesized `add_user_message{content:[]}` in `handleAssistantEntry` (replay) and the live empty-opener follow-up in `session.ts` are removed.

*Reducer construction (how a no-user-content turn is built):* The reducer already builds a no-user-content turn for wakes — `handleWakeStarted` opens a `pendingTurn` and seeds the turn's message scratch **empty** (no `user_message`), whereas `handleAddUserMessage` seeds it with a `user_message`. This plan makes that primitive explicit and origin-parameterized:
- `PendingTurn` and `TurnEntry` carry a first-class `origin: "user" | "assistant"` (shell reserved). This **replaces** the `isWake: boolean` discriminator and the `messages[0]?.kind === "user_message"` inference. The boolean and the inference are removed; `wakeTrigger` survives only as an optional annotation on an `origin: "assistant"` turn.
- A single open primitive opens a turn with a given `origin` and seeds the scratch with `[userMessage]` **iff** `origin === "user"`, else `[]`. The no-user-content turn is the natural product of opening with `origin: "assistant"` — there is no `user_message` to fabricate.
- Layout / addressing reads `origin` (not `messages[0]`): `origin: "user"` → user row (`#u`) + assistant row (`#a`); `origin: "assistant"` → assistant row only (`#a`).

**Spec S03: Count production and consumption (one authority)** {#s03-count-production}

The canonical count is `engine(session file)`. The Rust engine is the **only** writer of the count; every consumer reads it ([P08], [Q01]):

- **Picker / scan:** the disk scan runs the engine; the cache stores its output (count + origins + frontier state), keyed by `(file_size, file_mtime, rule_epoch)`; `rule_epoch` is bumped.
- **Resume:** `set_turn_count` reads the engine — cached `engine(file)` (fingerprint-validated), or the engine run on the resolved file path (`project_dir` + `claude_session_id` + `.jsonl`) when no cache entry exists — **not** `parse_replay_complete_total_turns`. The picker and resume counts are equal by construction.
- **Live:** `record_turn`'s `turn_count + 1` is removed; only its `last_used_at` touch remains. A live session's ledger count is refreshed by the existing scan-on-`list_sessions` path (picker open), not a per-append trigger; the live card badge is the live truth between scans, and live-row visibility is gated by `file_size > 0 || state === "live"` (dev-picker-data-source), not `turn_count`.
- **Wire (validate-and-stamp):** `resolveWindow` derives both `totalTurns` and `firstLoadedTurnIndex` from tugcode `computeTurns`, and the highest rendered address is `firstLoadedTurnIndex + loadedTurns` — so stamping only `totalTurns` would split sources. At the `replay_complete` rewrite point, tugcast asserts tugcode's wire `totalTurns` equals `engine(file)` and stamps the engine value; agreement makes the window indices coherent, a mismatch is logged as a contract breach (engine wins) and surfaces the session. Never a silent split.
- **Migration:** the `rule_epoch` bump invalidates the scan cache **and** the next scan re-`set_turn_count`s every existing ledger row from the engine (not only sparse rows), **live rows included** — `engine(file)` is the correct on-disk count (the frontier skips the in-progress final line), so a live row is corrected too; the badge-vs-`engine(file)` difference is the R05 transient, not a clobber.
- **The engine segments the JSONL file directly** — it is the single file→turns authority. The Step 5/6 wire opener vocabulary is only how tugcode *represents* that segmentation to the reducer for rendering; the #step-7 contract ties the two. tugcode's sole independent segmentation is the in-flight live turn (rendering, the lone transient; Risk R05).

#### State Zone Mapping (tugdeck) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `TurnEntry.origin` (per-turn attribution) | local-data | store/reducer → snapshot, read via `useSyncExternalStore` | [L02] |
| Has-user-row / assistant-only layout decision | structure (derived) | pure derivation from `origin` in the row layout | [L02] |
| `#u`/`#a` per-row address | appearance (derived from data) | rendered from `origin` + turn number; no React state | [L06] |
| Turn number base (`firstLoadedTurnIndex`) | local-data | existing `useSyncExternalStore` selector | [L02] |

---

### Deep Dive: Implementation landmarks & orientation (post-compact) {#landmarks}

> Everything below was verified against the real code during the audit/vet that produced this plan. A fresh session should not need to re-derive it. Symbol names (not line numbers) are the stable handles; grep for them.

#### Real-data anchor (the canonical fixture) {#landmark-real-data}

- The reference session is `49e9aec6` — file `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/49e9aec6-7c3a-4c0c-9f74-5a9a0551812e.jsonl` (~37.4 MB, ~8042 lines). **The engine must count 81** for it (the opened-session authority). The old scanner cached **59**; a faithful full application of the old documented rule gives **66**; the 81−66 = 15 gap is synthesized assistant-originated openers (the phantom `#u` rows). This file is the first real unit/integration fixture.
- The running app's ledger DB for this project is `~/Library/Application Support/Tug/instances/debug-main/sessions.db` (the `debug-main` instance; there are sibling per-instance DBs and a top-level `~/Library/Application Support/Tug/sessions.db`). Tables: `sessions` (`session_id`, `turn_count`, `state`, `last_used_at`, …) and `external_scan_cache` (`session_id`, `file_size`, `file_mtime`, `excluded`, `turn_count`, `rule_epoch`, `parse_offset`, `tail_hash`). Inspect with `sqlite3`.

#### tugcode (the TS bridge) {#landmark-tugcode}

- `tugcode/src/replay.ts` — the replay segmentation: `handleUserEntry` (real user openers), **`handleAssistantEntry`'s synth opener** (the empty `add_user_message` to DELETE — fires when `openTurnMsgId === null`), `computeTurns` (the `totalTurns`/window dry-run; counts an opener per `orphanCounter` bump), `mintOpenerId`, `emitOrphanIfOpen`, `TERMINAL_STOP_REASONS` (`end_turn`/`stop_sequence`/`max_tokens`/`refusal`; a terminal assistant entry sets `openTurnMsgId = null`), `isNonSubmissionUserString` + `COMMAND_SCAFFOLDING_PREFIXES`, `extractTaskNotificationWake`/`TASK_NOTIFICATION_OPEN_RE`, and `resolveWindow` (derives BOTH `totalTurns` and `firstLoadedTurnIndex` — the [Q01] seam). The `ReplayWindow` wire union is already `{lastTurns}|{turnRange}` and `firstLoadedMessageIndex` was already retired by the prior project.
- `tugcode/src/session.ts` — the LIVE path: `handleTaskNotification`/`buildWakeStartedMessage` (wake bracket), `openTurnFromPending`, and the acknowledged **"known empty `add_user_message`" follow-up** comment (the live analogue of the synth opener to delete).

#### Rust scanner & ledger (tugcast) {#landmark-tugcast}

- `tugrust/crates/tugcast/src/external_sessions.rs` — the disk scanner the engine replaces/absorbs: `user_submission_opens_turn` (the user-record-only rule — the engine supersedes it), `is_user_submission_content`, `is_non_submission_user_string`, `is_task_notification_wake`, `is_interrupt_marker`, the scan loop that **only inspects `rec.kind == "user"` (+ `"ai-title"`)** — this is exactly why it can't see assistant-originated openers. Incremental resume: `try_resume` + `parse_offset` + `tail_hash` + `TAIL_FINGERPRINT_BYTES` (only newline-terminated lines advance the frontier; the in-progress final line is left for the next scan — this is why migrating a live row is safe). `RawRecord` fields: `isCompactSummary`/`isMeta`/`permissionMode`/`message`. The contract test to DELETE: `scanner_turn_counts_match_golden_corpus`. **Non-count outputs to preserve:** `last_user_prompt`, `aiTitle` name, `created_at`, cwd/sessionId exclusions.
- `tugrust/crates/tugcast/src/session_ledger.rs` — the count writers: `record_spawn` (MAX-seed from scan cache), **`record_turn`** (the live `turn_count + 1` to REMOVE; keep its `last_used_at` touch), **`set_turn_count`** (the SET the resume reconcile calls), `external_scan_cache` schema + `CURRENT_RULE_EPOCH` (bump it), `scan_external_sessions_cached`.
- `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` — the reconcile + outbound rewrite: the `replay_complete` handler calls **`parse_replay_complete_total_turns` → `set_turn_count`** (the wire-sourced count to replace with the engine), the live `turn_complete` → `record_turn` call, and the **`line_to_emit` / `inject_replay_telemetry` outbound-frame rewrite** — the proven mechanism to stamp `totalTurns` from the engine ([Q01] validate-and-stamp).

#### tugdeck (reducer, data source, picker, addressing) {#landmark-tugdeck}

- `tugdeck/src/lib/code-session-store/reducer.ts` — `handleAddUserMessage` (seeds scratch with a `user_message`), **`handleWakeStarted`** (seeds scratch EMPTY — the existing no-user-content construction to generalize), `handleTurnComplete`, `isWakePulldown` (a behavioral `isWake` consumer to re-express on `origin`+`wakeTrigger`). `tugdeck/src/lib/code-session-store/types.ts` — `PendingTurn.isWake` (remove), `TurnEntry` (no `origin` today; user-ness inferred from `messages[0]`). Wire decode: `frameToEvent`/`events.ts` (must learn the new opener — G5).
- `tugdeck/src/lib/dev-transcript-data-source.ts` — `turnHasUserMessage` (the `messages[0]` inference to replace with `origin`), `buildRowLayout`, `localTurnIndexForRow`, `userRowIndexForTurn`/`assistantRowIndexForTurn`.
- `tugdeck/src/lib/dev-picker-data-source.ts` — the visibility gate (hide when `file_size <= 0 && turn_count === 0 && state !== "live"`). `tugdeck/src/components/tugways/cards/dev-picker-format.ts` — `formatSessionRowSubtitle` (the `N turns` subtitle).
- `tugdeck/src/components/tugways/tug-transcript-entry.tsx` — `formatTurnAddress({speaker, turn})`, `TurnSpeaker` (`#u`/`#a`/reserved `#s`), `formatSequenceNumber` (retained for non-turn stamps). `dev-card-transcript.tsx` — `useTurnNumberBase`, `CodeRowBody`, one address per attribution row (already shipped by the prior project; this plan only changes what feeds origin).

#### Build, test, and run commands {#landmark-commands}

- Rust: `cd tugrust && cargo nextest run` (warnings are errors).
- tugcode (bun-compiled — NO HMR): test `bun test`; **rebuild after edits** `bun build --compile tugcode/src/main.ts --outfile tugrust/target/debug/tugcode`.
- tugdeck (HMR-live): `bunx tsc --noEmit`; `bun test`.
- Real-app: `just app-test <file>` (ends `VERDICT: PASS|FAIL`; check `tail -n 1`). Build+launch a debug instance: `just app-debug`; `just instances`/`just logs-debug`/`just stop-debug`.

#### Orientation {#landmark-orientation}

- This plan was authored after a read-only root-cause audit and was **triple-vetted** (the load-bearing seams — single count authority, validate-and-stamp, resume no-cache fallback, the no-user-content construction, the live-row migration — are all grounded above). The fuller audit narrative lives in memory `project_canonical_turns.md`.
- The prior canonical-turns Phase 1+2 is **already merged to main** — the `#u`/`#a` per-row addressing, the wire window metadata, the picker `N turns` subtitle, and the `{lastTurns}|{turnRange}` `ReplayWindow` all exist. This plan reworks the count *production* beneath them; it does not re-author the rendering.
- Implement via `/tugplug:implement dash/canonical-turns-redux.md` on a `tugutil dash` worktree (never directly on main); the open spike is [Q03] (engine incremental performance) and the one accepted runtime transient is R05.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/turn_engine.rs` (or module) | The single segmentation engine: JSONL → ordered origin-tagged turns + count + frontier state |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TurnOrigin` | enum | `tugcast/src/turn_engine.rs` | `User` \| `Assistant` (`Shell` reserved) |
| `segment_turns` | fn | `tugcast/src/turn_engine.rs` | The engine; pure over a parsed JSONL stream + carry-in frontier state |
| `user_submission_opens_turn` | fn (remove/fold) | `tugcast/src/external_sessions.rs` | Replaced by the engine; the user-record-only counting is deleted |
| neutral assistant-originated opener | wire type / emit | `tugcode/src/types.ts`, `replay.ts`, `session.ts` | No wake baggage; wake = this opener + optional `wakeTrigger` annotation; delete synth `add_user_message` |
| `origin` on `PendingTurn` + `TurnEntry` | field | `tugdeck/src/lib/code-session-store/types.ts` | `"user" \| "assistant"`; first-class; replaces `isWake` boolean + `messages[0]` inference |
| `isWake` boolean | field (remove) | `tugdeck/src/lib/code-session-store/types.ts`, `reducer.ts` | Removed; `wakeTrigger` survives as an annotation on `origin: "assistant"` |
| origin-parameterized turn-open | fn | `tugdeck/src/lib/code-session-store/reducer.ts` | Seeds scratch `[userMessage]` iff `origin==="user"`, else `[]` (generalizes `handleWakeStarted`) |
| `turnHasUserMessage` inference | logic (replace) | `tugdeck/src/lib/dev-transcript-data-source.ts` | Keyed on `origin`, not `messages[0]` |
| `parse_replay_complete_total_turns` | fn (remove as count source) | `tugcast/src/feeds/agent_bridge.rs` | Deleted as a count input; resume `set_turn_count` reads the engine ([P08]) |
| `record_turn` count increment | fn (modify) | `tugcast/src/session_ledger.rs` | `turn_count + 1` removed; keeps only the `last_used_at` touch; live count refreshed via the engine ([P08]) |
| wire `totalTurns` stamp | emit | `tugcast/src/feeds/agent_bridge.rs` | tugcast stamps `replay_complete.totalTurns` from the engine; tugcode no longer authors it ([Q01]) |
| ledger migration on epoch bump | fn | `tugcast/src/session_ledger.rs` / scan path | Re-`set_turn_count` every existing row from `engine(file)`, live rows included (#step-4) |
| `tugcode segment <file>` | batch entrypoint (new) | `tugcode/src/` | Emits tugcode's ordered turn list for a file (reuses `computeTurns`) — the contract's tugcode side (#step-7) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Engine segmentation/origin on individual real session files | `cargo nextest`, the engine's core |
| **Contract (real corpus)** | Engine count+origins == tugcode/tugdeck rendering, over the real local corpus | The anti-drift gate ([P07]) |
| **Real-app** | Picker count == opened count (no shift); no phantom `#u` rows | `just app-test`, end-to-end |
| **Pure-logic (bun)** | Reducer origin handling, address formatting | tugdeck store/format |

#### What stays out of tests {#test-non-goals}

- Sanitized/invented golden fixtures — deleted ([P07]); they masked the gaps.
- Fake-DOM/RTL render tests and mock-store assertion tests — banned project-wide.
- CI portability of the real-corpus contract — accepted as local-only; not a coverage gap but a deliberate choice.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Spec: origin model, opener vocabulary, counting policy | done | e50587ef |
| #step-2 | Rust turn-segmentation engine (pure, real-file unit tests) | done | 1d5a0e93 |
| #step-3 | Picker/scan count sourced from the engine; epoch bump; incremental correctness | done | f22e588b |
| #step-4 | Single count authority: remove wire + live count writers; migrate ledger | done | 27cea21e |
| #step-5 | tugcode: honest assistant-originated opener; delete synth `add_user_message` | done | 8c950c36 |
| #step-6 | tugdeck: origin-explicit `TurnEntry`; assistant-only render; `#u`/`#a` | done | e1185099 |
| #step-7 | Real-corpus contract: engine == rendering; delete sanitized corpus | done | 0115dddf |
| #step-8 | Real-app integration: no shift, no phantom user rows, equality on the spread | done | b6fce908 (vetted in-app) |

#### Step 1: Spec — origin model, opener vocabulary, counting policy {#step-1}

**Commit:** `spec(turns): origin-first turn model and one-engine count`

**References:** [P01] origin intrinsic, [P02] container, [P03] addressing, [P04] count-all, [P05] one engine, Spec S01, Spec S02, Spec S03, (#context, #strategy)

**Artifacts:**
- Rewrite `tuglaws/turn-metric.md` to define the origin model (S01), the honest opener vocabulary (S02), count production/consumption (S03), and the unforgeable-attribution invariant.

**Tasks:**
- [ ] Define `TurnOrigin` and the turn-open rules for both origins; state that a user message exists iff `origin === user`.
- [ ] State the single-producer rule and the picker-never-shifts invariant.
- [ ] State the addressing scheme (`#u`/`#a`/reserved `#s`, no `#x`).

**Tests:**
- [ ] None (spec doc).

**Checkpoint:**
- [ ] `tuglaws/turn-metric.md` encodes S01–S03 and is internally consistent with [P01]–[P07]; no reference to a synthesized user opener as legitimate.

---

#### Step 2: Rust turn-segmentation engine {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugcast): origin-tagged turn segmentation engine`

**References:** [P05] one engine, [Q03] incremental cost, Spec S01, (#symbol-inventory)

**Artifacts:**
- `turn_engine.rs`: `segment_turns` producing ordered `{origin, ...}` turns + count, with a carry-in/carry-out frontier state (open-turn state) for incremental resume.

**Tasks:**
- [ ] Implement the full state machine: user openers (excluding meta/interrupt/tool-result/compact/scaffolding) AND assistant-originated openers (wake / orphan assistant with no open turn), mirroring tugcode's decisions per S01. Output ordered turns with `{origin, byte/entry boundary, count}`.
- [ ] Express incremental resume as carry-over of frontier open-turn state, not just an offset+count.
- [ ] Delete/retire `user_submission_opens_turn` user-record-only counting.
- [ ] **Preserve the scanner's non-count outputs** that `external_sessions.rs` produces today — `last_user_prompt`, `ai-title` name, `created_at`, and the cwd-/sessionId-mismatch exclusions — they feed the picker subtitle/title/visibility and must survive the engine swap.

**Tests:**
- [ ] `cargo nextest` unit tests over **real** session files copied locally (continue/compact/slash/wake/leading-orphan), asserting per-turn origin and total.
- [ ] An incremental test: segment a prefix, append the rest, assert incremental total+origins == full re-segment.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; engine reproduces the opened-session count for `49e9aec6` (expected 81) from the real file.

---

#### Step 3: Picker/scan count from the engine {#step-3}

**Depends on:** #step-2

**Commit:** `refactor(tugcast): picker turn count from the segmentation engine`

**References:** [P05] one engine, [P06] no shift, [Q03], Spec S03, Risk R02, (#r02-incremental-correctness)

**Artifacts:**
- The disk scan runs the engine; `external_scan_cache` stores engine output (count + frontier state); `rule_epoch` bumped so stale caches invalidate.

**Tasks:**
- [ ] Wire the scan to the engine; persist frontier state for incremental resume.
- [ ] Bump `CURRENT_RULE_EPOCH`; confirm the epoch gate invalidates old rows at both read sites.

**Tests:**
- [ ] `cargo nextest` cache tests: a stale (old-epoch) row is ignored; an incremental append updates the count correctly.

**Checkpoint:**
- [ ] `cargo nextest run` green; a fresh scan of `49e9aec6` caches **81** (not 59), validated by `(file_size, file_mtime, rule_epoch)`.

---

#### Step 4: Single count authority — remove the wire and live count writers; migrate the ledger {#step-4}

**Depends on:** #step-3

**Commit:** `refactor(tugcast): engine is the only count writer`

**References:** [P05] one engine, [P06] no shift, [P08] single authority, [Q01] (DECIDED), Spec S03, Risk R03, Risk R05, (#p08-single-authority, #s03-count-production)

**Artifacts:**
- Resume `set_turn_count` fed by the engine (cached `engine(file)`), not `parse_replay_complete_total_turns` (removed as a count source); `record_turn`'s `turn_count + 1` removed (its `last_used_at` touch kept); tugcast stamps `replay_complete.totalTurns` from the engine; a migration pass that re-`set_turn_count`s existing ledger rows from the engine on re-scan.

**Tasks:**
- [ ] Resume: source `set_turn_count` from the engine — cache lookup by `claude_session_id`, with a **fallback that runs the engine on the resolved file path when no cache entry exists**; delete `parse_replay_complete_total_turns` as a count input.
- [ ] Live: remove the `record_turn` count increment (keep `last_used_at`); the live ledger count rides the existing scan-on-`list_sessions` refresh — no per-append trigger.
- [ ] Wire (validate-and-stamp): at the `replay_complete` rewrite point (reuse the `line_to_emit`/`inject_replay_telemetry` mechanism), assert tugcode's wire `totalTurns == engine(file)` and stamp the engine value; on mismatch, log a contract breach (engine wins) and surface the session. tugcode no longer authors the count.
- [ ] Migration: on the `rule_epoch` re-scan, re-`set_turn_count` every existing ledger row from `engine(file)` (not only sparse rows), **live rows included** — the scanner frontier already skips the in-progress final line, so a live row gets its correct on-disk count.

**Tests:**
- [ ] `cargo nextest` reconcile test: for an unchanged file, the post-resume ledger count equals the pre-resume scan count (no mutation, no second writer).
- [ ] `cargo nextest` no-cache test: a resume with no scan-cache entry runs the engine on the file and reconciles to `engine(file)`.
- [ ] `cargo nextest` validate-and-stamp test: a wire `totalTurns` that disagrees with the engine logs a breach and the engine value wins.
- [ ] `cargo nextest` migration test: an existing row with a stale count (e.g. 59) is corrected to `engine(file)` on the next scan — including a live row, whose stale count is also corrected to its on-disk `engine(file)`.

**Checkpoint:**
- [ ] `cargo nextest run` green; opening `49e9aec6` does not change its ledger turn count; a pre-seeded stale `49e9aec6` row migrates to **81** on re-scan; grep confirms no `parse_replay_complete_total_turns` count path and no `record_turn` increment remain.

---

#### Step 5: tugcode honest opener; delete synth `add_user_message` {#step-5}

**Depends on:** #step-1

**Commit:** `refactor(tugcode): assistant-originated opener, no fabricated user message`

**References:** [P01] origin intrinsic, [P02] container, Spec S02, (#s02-opener-vocabulary)

**Artifacts:**
- An assistant-originated opener (generalized `wake_started`) emitted for orphan assistant content; the synthesized `add_user_message{content:[]}` removed from `handleAssistantEntry` (replay) and the live empty-opener follow-up in `session.ts`.

**Tasks:**
- [ ] Replace the synth opener with the assistant-originated opener carrying `origin: assistant` (add the wire type in `tugcode/src/types.ts`; remove the synth in `replay.ts` `handleAssistantEntry` and the live empty-opener follow-up in `session.ts`).
- [ ] Ensure `add_user_message` is emitted only for genuine user submissions.
- [ ] **Wire-decode the new opener on the tugdeck side** — `frameToEvent`/`events.ts` must recognize the assistant-originated opener and produce the reducer event (not only the Step 6 reducer handler); otherwise the frame is received but never decoded.
- [ ] Keep the engine ([P05]) and this emit aligned per S01 (the contract in #step-7 enforces it).

**Tests:**
- [ ] `bun test` (tugcode) replay tests over real files: orphan assistant entries open an `origin: assistant` turn; no empty `add_user_message` is emitted.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `bun test` green; grep shows no `add_user_message` emit path with empty/synthetic content; tugcode rebuilt.

---

#### Step 6: tugdeck origin-explicit TurnEntry + rendering {#step-6}

**Depends on:** #step-5

**Commit:** `refactor(transcript): origin-explicit turns, assistant-only orphans`

**References:** [P01] origin intrinsic, [P02] container, [P03] addressing, (#state-zone-mapping)

**Artifacts:**
- `origin` on `PendingTurn` and `TurnEntry`; one origin-parameterized turn-open that seeds the scratch with `[userMessage]` iff `origin === "user"` else `[]`; `isWake` boolean and `messages[0]` inference removed; `wakeTrigger` demoted to an optional annotation; row layout + addressing key on `origin`.

**Tasks:**
- [ ] Add `origin: "user" | "assistant"` to `PendingTurn` and `TurnEntry`; the reducer's turn-open handler sets it from the opener and seeds the scratch empty for `origin: "assistant"` (mirrors today's `handleWakeStarted` empty-scratch construction).
- [ ] Remove the `isWake` boolean discriminator and the `turnHasUserMessage`/`messages[0]` inference; keep `wakeTrigger` only as an annotation on an `origin: "assistant"` turn.
- [ ] **Re-express every `isWake` behavioral consumer in terms of `origin` + `wakeTrigger`/phase, not a field rename.** Concretely: `handleWakeStarted`'s `phase: "waking"` bracket; `isWakePulldown` (which suppresses the inflight user message and gates `wakeTrigger`); the jobs-ledger fold keyed on the wake trigger; and `handleTurnComplete`'s `waking → idle` branch. Wake *behavior* (the bracket, the jobs fold, the phase) rides `wakeTrigger`/phase; `origin` carries attribution only. Enumerate and convert each consumer.
- [ ] Key row layout + `#u`/`#a` addressing on `origin`; confirm no path can render a user row for an `origin: "assistant"` turn (no `user_message` exists to render).

**Tests:**
- [ ] `bun test` reducer tests (real-frame driven): an assistant-originated opener yields a turn with `origin: assistant`, no user message, assistant-only rows.
- [ ] `bun test` address formatter unchanged (`#u`/`#a`).

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `bun test` green; HMR shows orphan turns as `#a`-only with no phantom `#u` row.

---

#### Step 7: Real-corpus contract; delete sanitized corpus {#step-7}

**Depends on:** #step-2, #step-5, #step-6

**Commit:** `test(turns): real-corpus contract engine == rendering`

**References:** [P05] one engine, [P07] real corpus, Risk R01, (#r01-segmentation-drift)

**Artifacts:**
- A concrete contract harness with three named parts: (1) a tugcode batch entrypoint — `tugcode segment <file>` (or a bun test that calls the existing `computeTurns`) — that emits tugcode's ordered turn list for a session file as `[{origin}]`; (2) a Rust path that runs the engine over the same file to the same shape; (3) a diff harness that, for every file under `~/.claude/projects/<project>/`, asserts the two lists are equal **per-turn (origin + ordinal), not just total count**, and prints the exact diverging sessions. Plus deletion of `scanner_turn_counts_match_golden_corpus` and its sanitized fixtures.

**Tasks:**
- [ ] Add the tugcode batch turn-list entrypoint (reusing `computeTurns`/`translateJsonlEntry`) so tugcode's segmentation is observable per file without a live session. **`computeTurns` today returns a row-count proxy (`messages: hasUserRow ? 2 : 1`), not origin — extend it to emit per-turn `origin`** (depends on Step 5's origin-explicit openers) so the contract can compare attribution, not just totals.
- [ ] Build the diff harness over the real local corpus comparing per-turn origin + ordinal; emit the diverging-session list on failure.
- [ ] Delete the sanitized golden corpus and any test it props up; keep at most a real-shape smoke subset ([P07]).

**Tests:**
- [ ] The contract passes over the full real corpus (or reports the exact divergent sessions to fix), per-turn, not count-only.

**Checkpoint:**
- [ ] The harness runs `tugcode segment` + the engine over every real session and reports zero per-turn divergences (or a named fix list); `cargo nextest` / `bun test` no longer reference the deleted sanitized fixtures.

---

#### Step 8: Real-app integration — no shift, no phantom rows {#step-8}

**Depends on:** #step-3, #step-4, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P04] count-all, [P06] no shift, [P08] single authority, Spec S03, (#success-criteria)

**Tasks:**
- [ ] Verify on real sessions across the spread that picker count == opened count == highest rendered address, and that a pre-upgrade stale ledger count migrates to `engine(file)` without opening the session.

**Tests:**
- [ ] `just app-test` aggregate: open `49e9aec6` (and a wake/`--continue`/`/compact` session); assert the picker shows the same number before and after; assert no turn renders a `#u` row without a real user submission; assert highest `#a`/`#u` == engine count.

**Checkpoint:**
- [ ] `just app-test <turns-redux-test>` ends `VERDICT: PASS`; the `49e9aec6` picker number is identical pre- and post-open.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A turn model where attribution is intrinsic and unforgeable, a single Rust engine produces the count consumed identically by the picker and the resume authority, and the picker count never shifts — verified against the real local session corpus.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No fabricated user messages anywhere; assistant-originated turns render `#a`-only. (#step-5, #step-6)
- [ ] Exactly one count writer: `parse_replay_complete_total_turns` (count source) and `record_turn`'s increment are gone; resume, scan, and live all resolve to `engine(file)`; tugcast stamps the wire count. (#step-4, [P08])
- [ ] One engine produces the count for both picker and authority; picker count == opened count for every real session. (#step-3, #step-4, #step-8)
- [ ] Existing stale ledger counts migrate to `engine(file)` on re-scan without opening the session. (#step-4)
- [ ] Engine == tugcode rendering **per-turn (origin + ordinal)** over the full real corpus. (#step-7)
- [ ] `49e9aec6` shows the same number before and after opening, equal to the highest rendered address. (#step-8)
- [ ] The sanitized golden corpus is gone; verification is real-data-driven. (#step-7)

**Acceptance tests:**
- [ ] `cargo nextest run` (engine + cache + reconcile) green.
- [ ] Real-corpus contract green (or a named, tracked list of corrected sessions).
- [ ] `just app-test <turns-redux-test>` → `VERDICT: PASS`.

| Checkpoint | Verification |
|------------|--------------|
| Honest attribution | grep: no empty `add_user_message`; render: no `#u` without a user submission |
| One producer, no shift | `49e9aec6` picker count identical pre/post open; no ledger mutation on unchanged file |
| Engine == rendering | real-corpus contract green |
