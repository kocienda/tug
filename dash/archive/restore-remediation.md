<!-- devise-skeleton v4 -->

## Restore Remediation {#restore-remediation}

**Purpose:** Fix the five post-landing fallout issues from the effective-record-sequence change (`dash/restore-remediation-brief.md`), and land the north-star scanner guarantee: appending to a session transcript never causes a full re-parse of the conversation.

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

The session-restore hardening (`f6f1383cf`) fixed real correctness defects (10,447 rescued entries, four-way-verified canonical counts) but shipped with a policy that made 31% of sessions (280/903 in the release-main `external_scan_cache`) re-stream their entire JSONL on every append, and it landed alongside unrelated local-model work that ballooned the host process to 4.6–6.9 GB. Five issues were observed in the running release app on 2026-07-28; `dash/restore-remediation-brief.md` is the ground-truth record of what was measured. This plan records the remediation work already completed (uncommitted, on `main`) and carries the remaining work as steps.

A sixth defect was discovered during remediation, not in the brief: the scanner's sessionId/filename gate excluded resumed-lineage session files entirely (22 rows in release-main), which is the mechanical explanation for Issue 4's "content gone after reopen".

#### Strategy {#strategy}

- Attribute before fixing: the memory headline (Issue 5) was measured to be the in-process MLX local model, not the restore change — so the restore change is repaired, not reverted.
- Make the scanner's resume seed rich enough that incremental resume is always possible, instead of giving up on resume when the file's history gets complicated.
- Treat every remaining full-re-stream trigger as a bug unless it corresponds to an explicit history-editing event (`/compact`, rewind, on-disk prefix rewrite), and certify the guarantee with a property test over the real reference sessions, not synthetic fixtures.
- Fix the deck-side compaction seating defects (Issues 1–3) as one probable root cause, with regression coverage that exercises multi-compaction sessions.
- Close with an Issue 6 premise audit (re-appends are not verbatim) and a landing/verification pass in the real app.

#### Success Criteria (Measurable) {#success-criteria}

- An ordinary append (assistant output, tool results, hooks, off-leaf spurs, re-append tails, partial writes) never re-streams the file: the split-point property test asserts `resumed == true` for every ordinary-append split over both reference sessions (#step-6).
- Host process RSS with the local model resident is ≤ ~2.6 GB (weights + bounded cache), verified by `vmmap` `IOAccelerator` totals and the `MLXLocalModelBackend` `logGpu` lines after relaunch (#step-10).
- Session `8b8d7bf1-5d25-4b2d-95de-ee1ccba71d42` renders exactly 68 turn rows (`TURNS DISPLAYED: 68 OF 68`), 9 compaction dividers, and no assistant-row compaction boundaries (#step-8).
- Session `4eb21996-9a77-4528-a854-53081ec7bc66` appears in the picker with its full 22 MB content and engine count, not the stale 12 MB ancestor snapshot (#step-10).
- `cd tugrust && cargo nextest run` passes workspace-wide (warnings are errors), including both real-corpus parity contracts.

#### Scope {#scope}

1. tugcast scanner: incremental resume, trigger taxonomy, lineage handling (`tugrust/crates/tugcast/src/external_sessions.rs`, `session_ledger.rs`, `dead_branch.rs` read-only).
2. Tug.app host: MLX local-model memory behavior (`tugapp/Sources/LocalModelBackend.swift`).
3. tugdeck/tugcode: compaction-boundary seating in the replayed transcript (Issues 1–3).
4. Analysis: Issue 6 duplicate-pair divergences; verdicts and (if needed) a follow-up rule change.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Reverting `f6f1383cf` (rejected: the memory headline is not the restore change, and a revert resurrects the original phantom-turn defects).
- The local-model product decision (whether shell-routing should keep ~2.4 GB resident at all) — recorded as [Q03], decided by the user separately.
- Reconciling the already-forked `31c60766`/`4eb21996` lineage pair — surfaced to the user ([Q02]), never auto-resolved.
- Re-verifying the dead-branch walk core (884-session Rust↔TS parity, 0 divergent) — the brief marks it verified; do not re-litigate.

#### Dependencies / Prerequisites {#dependencies}

- The two private reference sessions in `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/` (`8b8d7bf1-…42.jsonl`, 29 MB; `4eb21996-…66.jsonl`, 22 MB). Corpus-backed tests skip gracefully when absent; the certification steps require them.
- `tugcode` debug binary at `tugrust/target/debug/tugcode` (or `TUGCODE_BIN`) for the parity contracts.
- Relaunching the release app is a **user gesture** (`just app-release` quits the running app, which may host the working session).

#### Constraints {#constraints}

- **Warnings are errors** (`tugrust/.cargo/config.toml`); `cargo nextest run` from `tugrust/`.
- Never point `sqlite3` at live ledgers; use `just db-inspect <name|path> ["SQL"]`. Each instance has its own `sessions.db` under `~/Library/Application Support/Tug/instances/<id>/` — the top-level `sessions.db` is NOT the running instance's ledger.
- Never vendor the reference sessions into the repo; derive fixtures via `tugcode/src/__tests__/fixtures/compact-reappend/project-session.ts` (chain topology, content clipped) or `tests/app-test/fixtures/sanitize.ts`.
- App-tests: selective runs only (`just app-test-changed`); never the full corpus.
- Shared `changes.db` schema is untouched by this plan; `external_scan_cache` lives in the per-instance `sessions.db` and migrates via the idempotent ALTER list + `CURRENT_RULE_EPOCH` gate (no `CHANGES_SCHEMA_VERSION` bump needed).

#### Assumptions {#assumptions}

- Claude Code appends session JSONL in steady state; prefix rewrites only accompany history-editing events (the tail-fingerprint check catches them).
- A single uuid appears at most twice per file (max observed across both reference sessions: 2).
- Only user submissions root dead branches (`compute_dead_entry_indices` in `tugrust/crates/tugcast/src/dead_branch.rs` requires `is_user_submission` for a dead root) — this is what makes [P04]'s trigger narrowing sound.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Absorb `/compact` boundary events incrementally? (DEFERRED) {#q01-absorb-compaction}

**Question:** Can a resumed slice absorb a *new* compaction boundary (boundary record + summary + re-append block) without a one-time full re-stream?

**Why it matters:** It is the last per-event full pass. Analysis says it should compose (the bridge walk keeps the whole prefix live; duplicate suppression is unchanged; segmentation is a left fold), but the summary record's parent shape and the boundary's null parent interact with the trigger taxonomy.

**Plan to resolve:** After #step-6 lands, extend the property test to place splits immediately before compaction blocks and assert `resumed == true`; only then narrow the trigger.

**Resolution:** DEFERRED — the once-per-`/compact` pass (~9–22 per session lifetime) is within the north-star budget; revisit as a follow-on (#roadmap).

#### [Q02] Fork reconciliation for `31c60766` vs `4eb21996` (OPEN — user decision) {#q02-fork-reconciliation}

**Question:** The ancestor file `31c60766-9de9-4e69-b281-778a7ce6f2fb.jsonl` has forked (mtime newer than its descendant `4eb21996`) because reopening during the exclusion bug landed on the stale lineage. After #step-3 both list. Which lineage is canonical?

**Why it matters:** Hiding either loses real content; the plan must surface both and let the user pick.

**Resolution:** OPEN — #step-10 reports the state; the user decides.

#### [Q03] Standing local-model residency (OPEN — product decision) {#q03-model-residency}

**Question:** Even after the fix, shell-routing keeps ~2.4 GB of unified memory captive whenever enabled (the deck re-prewarms after every idle release — `prewarmIfWanted` in `tugapp/Sources/LocalModelService.swift`, re-prewarm in `tugdeck/src/lib/local-model-store.ts`).

**Options:** smaller pack · Apple system-model backend (`SystemLanguageModelBackend`, no in-process weights) · out-of-process inference helper · longer idle leash without auto-re-prewarm.

**Resolution:** OPEN — needs a user decision; not a step of this plan.

#### [Q04] Issue 6 rule change (RESOLVED — no rule change) {#q04-issue6-rule}

**Question:** Do the non-verbatim duplicate-pair divergences (parentUuid ×9, message ×3, toolUseResult ×299 on `4eb21996`) require changing the first-occurrence-wins rule (e.g. field-level last-occurrence-wins for `toolUseResult`)?

**Resolution:** RESOLVED — **no rule change.** First-occurrence-wins is not merely safe on these divergences; it is the load-bearing choice, and last-occurrence-wins would destroy real content. Measured over `4eb21996`'s 1,183 duplicate pairs (max 2 occurrences per uuid):

- **`toolUseResult` (299) — harmless, and the rule is why.** The divergence is entirely one-directional: the re-append blanks `stdout` to `""` while keeping the same key set. Across all 299 pairs the re-append is **poorer in 299, richer in 0** (e.g. 13,460 B → 95 B). Keeping the first occurrence in `tool_use_structured` emission preserves the real tool output; adopting the re-append would blank 299 tool results.
- **`message` (3) — harmless, same direction.** The only divergent subfield is `message.usage`, zeroed in the re-append (`input_tokens: 0`, both cache figures 0). `message.id`, `role`, and `stop_reason` are byte-identical in all three pairs, so the `SigRecord` shape and the same-`message.id` continuation rule in `turn_engine.rs` / `replay.ts` are untouched. First-occurrence-wins keeps the real per-turn telemetry.
- **`parentUuid` (9) — harmless.** Eight are non-user records (six `attachment`, two `assistant`) whose parents are permuted *within* a re-append block; `compute_dead_entry_indices` roots dead branches exclusively at user submissions, so a non-user record's re-parenting cannot change prefix membership. The ninth (`2b01382c`, lines 4422 → 6316) is a genuine user submission whose parent moves from `6baaa79f` to `43aeabaf` — both inside the same compacted block. It kills nothing: `tugcode dead` reports an **empty dead set** for this file, and the Rust↔TS dead-branch parity contract is 0-divergent over 886 sessions. No branch is mis-killed or mis-resurrected on the real topology.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Trigger narrowing misses a prefix-rewriting append shape | high | low | [P04] soundness argument + #step-6 property certification + corpus parity contracts | any parity divergence or count drift |
| Deck fix guesses wrong root cause | med | med | #step-7 instruments the running app before #step-8 changes code | probe contradicts the container-seating hypothesis |
| Epoch-4 re-scan cost on first launch | low | certain | one-time by design; warm scans thereafter resume incrementally | re-scan repeats on subsequent launches |
| Both lineages listed confuses the picker | med | certain | [Q02] surfaced to user; suppression only hides non-forked ancestors | user reports duplicate rows for non-forked sessions |

**Risk R01: Narrowing the branch trigger is a correctness bet** {#r01-trigger-narrowing}

- **Risk:** The shipped trigger comment warns "Do not narrow it; every narrowing is a correctness bet." [P04] takes that bet deliberately.
- **Mitigation:** The bet is grounded in the dead-branch rule itself (only user submissions root dead branches, so only they can change prefix membership); certified empirically by #step-6 over both reference sessions; the full-stream trigger behavior is left broad (narrowing applies to resumed slices only).
- **Residual risk:** A future Claude Code record shape that edits history without a user-submission record would be absorbed silently. The tail fingerprint still catches on-disk rewrites.

**Risk R02: Multi-compaction deck coverage is currently zero** {#r02-deck-coverage}

- **Risk:** `at0193-compact-native-reload.test.ts` and `at0106-compact-boundary-divider.test.ts` pass because their fixtures hold a single compaction; nine compactions is untested territory.
- **Mitigation:** #step-8 derives a sanitized multi-compaction fixture from `8b8d7bf1` and pins the rendered-row count and divider count.
- **Residual risk:** app-test replay-session workspaces are transient (~2 s entries); anything not reachable there is covered at the store/Rust layer instead.

---

### Design Decisions {#design-decisions}

#### [P01] The resume seed carries the effective chain uuid set (DECIDED, implemented) {#p01-effective-uuid-seed}

**Decision:** Every resumable parse persists the set of effective chain uuids (earliest non-dead occurrence per uuid) in `external_scan_cache.effective_uuids`; a resumed slice suppresses any record whose uuid is already in the set — it feeds neither the segmentation engine nor the triggers, but does become the raw chain leaf.

**Rationale:**
- The old policy (`resumable = false` after any recount) existed only because a compaction re-append block straddling a scan boundary is indistinguishable from linear appends *without prefix knowledge*. The set IS the prefix knowledge (~120 KB for a 7,600-record session).
- Deadness of the prefix was resolved at the last full pass; a duplicate of an effective uuid is never itself effective, so inline suppression is exact. A re-append whose original was dead is not in the set, parents off-leaf, and correctly escalates.
- Segmentation is a pure left fold over the effective sequence with `Frontier` as the whole state, so seed-frontier + suppressed-tail stepping equals a from-scratch recount.

**Implications:** `CURRENT_RULE_EPOCH` 3→4 (one-time corpus re-scan repopulates seeds); `ResumeSeed`/`ResumeMark`/`ScanCacheRow` all carry the set; the split-point property test is the contract.

#### [P02] Uuid set keys are FNV-1a-128 hashes of the raw uuid string (DECIDED, implemented) {#p02-fnv-keys}

**Decision:** `uuid_key()` hashes the uuid string (published FNV-128 offset/prime, `u128` math) instead of parsing canonical uuid syntax.

**Rationale:** Total over any uuid shape a file might carry (fixtures use `u1`/`a1`); the only comparison that must hold exactly — re-append vs original, byte-identical strings — always does; cross-collisions are ~2⁻¹²⁸; constants are stable across releases so persisted blobs stay valid.

**Implications:** The blob is 16 bytes × set size, sorted for deterministic bytes; no `set_ok` poisoning path exists.

#### [P03] SessionId verdict at EOF; lineage ancestors recorded; mtime-gated ancestor suppression (DECIDED, implemented) {#p03-lineage-verdict}

**Decision:** A file is foreign (excluded) only if **no** record ever claims the filename's stem. Foreign sids encountered are recorded per-file as `lineage_ancestors` (comma-joined TEXT column); scan listings suppress an ancestor file only while its mtime ≤ its descendant's — a forked ancestor stays visible.

**Rationale:** Claude Code rotates session ids on resume and writes the old lineage's records into the new file first, so first-record exclusion rejected exactly the newest, fullest file (`4eb21996`: 4,080 old-sid records before its own) while listing the stale ancestor — Issue 4's "content gone". The mtime gate is what distinguishes "superseded prefix" from "forked live conversation".

**Implications:** Resumed slices inherit the ancestor list via the seed; suppression runs at scan assembly (`suppress_superseded_lineage`) in both the cached and uncached scan paths; a forked pair lists both rows by design ([Q02]).

#### [P04] Full passes only for history-editing events; resumed-slice triggers narrowed to the shapes that can edit history (DECIDED, to implement in #step-4) {#p04-trigger-taxonomy}

**Decision:** On a resumed slice, a full re-stream is triggered only by: (a) a **user-submission** record whose parent is not the carried leaf (rewind/Escape-orphan shape), (b) a record with a **null parent** mid-file that is not suppressed (restart/compaction root), (c) a **new compaction record** (`is_compaction`, not suppressed), (d) an unsuppressed **duplicate uuid** unknown to the effective set, (e) a **tail-fingerprint mismatch** (prefix rewritten on disk). Off-leaf **non-user** records (hook attachments, `tool_result` siblings, API-retry spurs) are absorbed inline: they update the raw leaf and feed the engine, and never trigger.

**Rationale:**
- Measured on the reference sessions, off-leaf non-user records occur ~1 per 15 chain records (372/4,959 and 327/6,199) — under the broad trigger these re-stream constantly, violating the north star. Off-leaf user submissions occur 5–6 per session **lifetime**.
- Soundness: `compute_dead_entry_indices` roots dead branches exclusively at user submissions with a live resolved parent. A non-user off-leaf record can neither kill nor resurrect prefix records; it is effective and visible in the full pass too, so feeding it inline preserves incremental ≡ full.
- Full (non-resumed) streams keep the broad trigger — there the trigger only decides whether the EOF recount runs, which is cheap and never wrong.

**Implications:** The `saw_branch` computation in `parse_session_file_inner` becomes resumed-vs-full aware and needs `ChainRecord::is_user_submission` (already parsed); the trigger-site comment ("Do not narrow it") is rewritten to state this taxonomy and its grounds.

#### [P05] Unterminated tail lines are deferred, not resumability-poisoning (DECIDED, to implement in #step-5) {#p05-unterminated-tail}

**Decision:** A scan that reads a partial (unterminated) final line stops its frontier at the last terminated line and ignores the partial line entirely — it is counted by the next scan once complete. The parse stays resumable.

**Rationale:** The current behavior counts the partial line into the scan's meta but marks the parse non-resumable (`resumable = false`), so the next append re-streams the whole file. Active sessions are appended continuously; scans race writes constantly, so this is a per-append full-re-stream vector on precisely the busiest sessions. Deferring one record's meta by one scan is invisible; re-streaming 22 MB is not.

**Implications:** The existing test `unterminated_tail_line_is_counted_but_not_resumable` (in `external_sessions.rs` tests) inverts into `unterminated_tail_line_is_deferred_to_the_next_scan`; `consumed`/`window`/meta accumulation must all stop at the last terminated line so the frontier and the tallies agree.

#### [P06] MLX GPU cache bound is a fixed workload-derived constant (DECIDED, implemented) {#p06-mlx-cache-policy}

**Decision:** `MLXLocalModelBackend.init` sets `MLX.GPU.set(cacheLimit: 256 MB)`. The bound is sized to the per-token-step working set of the largest catalog pack (single-digit MB) with ~50× headroom, and is **never** scaled to machine RAM.

**Rationale:** MLX's cache limit defaults to the device memory limit; on a 128 GB machine every freed buffer — including a swapped-out pack's entire 2.3 GB of weights — was retained forever (observed: 6.4 GB `IOAccelerator` dirty for a 2.3 GB model). Cache beyond the generation working set is dead weight regardless of RAM; scaling with RAM buys nothing and reintroduces the failure.

**Implications:** `logGpu()` reports active/cache/peak on load/unload; tune the constant only against those measured steady-state numbers. `unload()` drains the in-flight generation (`inflight` task) before releasing so a swap can never hold two packs alive and `clearCache()` runs after the weights actually deallocate.

---

### Deep Dives {#deep-dives}

#### Scanner: where everything lives {#scanner-map}

All in `tugrust/crates/tugcast/src/external_sessions.rs` unless noted:

- `parse_session_file` → `parse_session_file_inner(path, project_dir, expected_stem, file_size, file_mtime, resume, buffering)`. First pass runs unbuffered; the first trigger restarts once with `buffering = true` (chain/sig buffers feed the EOF recount via `dead_branch::effective_indices` + `segment_turns`).
- Trigger flags inside the loop: `saw_compaction`, `saw_duplicate_uuid`, `saw_branch`; inline suppression consults `effective_seen: HashSet<[u8;16]>` (seeded from the cache row). The restart site is the `if !buffering && (…)` block.
- Seed plumbing: `ResumeSeed` (decoded) ↔ `ResumeMark` (encoded) ↔ `ScanCacheRow` (`session_ledger.rs`): columns `effective_uuids BLOB`, `lineage_ancestors TEXT`, epoch gate `CURRENT_RULE_EPOCH = 4`. Helpers: `uuid_key`, `encode_uuid_set`/`decode_uuid_set`, `encode_lineage`/`decode_lineage`, `resume_seed_from_cache`.
- Scan assembly: `scan_external_sessions_cached_with_progress` (cache hits + parallel misses + `suppress_superseded_lineage`), uncached `scan_external_sessions` mirrors the suppression.
- Count authority chain: `engine_turn_count` → cached row or fresh parse → `replay_complete` stamp via `feeds/agent_bridge.rs`.
- Key tests (same file's test module): `incremental_resume_matches_full_parse_over_reference_sessions` (split-point property over both real reference sessions), `an_incremental_split_inside_a_re_append_matches_a_full_segment`, `a_rotated_lineage_lists_the_newest_file_and_suppresses_the_stale_ancestor`, `a_file_that_never_claims_its_stem_is_excluded`, `seed_from` helper. Corpus parity: `dead_branch.rs::dead_sets_match_tugcode_over_real_corpus`, `turn_engine.rs::engine_matches_tugcode_segmentation_over_real_corpus`.

#### Reference-session measurements {#reference-measurements}

**Table T01: Reference sessions** {#t01-reference-sessions}

| Session | Size | Records | Dup pairs | Compaction records | Dead set | Engine turns | Off-leaf non-user | Off-leaf user-submission | Null-parent mid-file |
|---|---|---|---|---|---|---|---|---|---|
| `8b8d7bf1-5d25-4b2d-95de-ee1ccba71d42` | 29 MB | 6,239 | 669 | 20 | empty | 68 | 372 / 4,959 chain records | 6 | 9 |
| `4eb21996-9a77-4528-a854-53081ec7bc66` | 22 MB | 7,607 | 1,183 | 22 | empty | 67 | 327 / 6,199 chain records | 5 | 9 |

`4eb21996` is a resumed lineage: 4,080 records stamped `31c60766-9de9-4e69-b281-778a7ce6f2fb` (its ancestor file exists, 12 MB, and has forked — mtime newer than the descendant).

#### Deck-side facts for Issues 1–3 {#deck-facts}

tugcode emitted frames for `8b8d7bf1` (measured): `add_user_message 69`, `turn_complete 68`, `compact_boundary 9`, `compact_summary 9`, `assistant_opener 1`, `wake_started 1`, `system_metadata 3`. Rendered: 83 rows (`83 − 68 = 15`); 8 of 9 dividers; boundaries render as assistant rows (`#a73`, avatar "Opus 5") whose body is the `Session compacted` block + literal text **"No response requested."** + a `−117.5K tokens` footer. Correct design: the `/compact` envelope is a **user** row with the divider *below* it, no assistant row.

Where to look (from the brief + store layout): `tugcode/src/replay.ts` (`hoistCompactCommandEnvelope` — note suppression now runs *before* the hoist), `tugdeck/src/lib/code-session-store.ts` (`appendTurnInterleavingShell`, `flush-prepend`, `upsertShellTurn`, `truncateTranscriptAtAnchor`), `tugdeck/src/lib/code-session-store/reducer.ts`, `tugdeck/src/lib/code-session-store/compaction.ts`, and the indicator source `tugdeck/src/components/tugways/cards/session-load-control-bar.tsx` + `session-load-control-bar-state.ts` (`displayed` = `transcript.length`).

**Known dead end (do not repeat):** feeding `translateJsonlSession` frames into `reduce()` offline returned 0 `append-transcript` effects because the replay bracket / store lifecycle wasn't set up. Probe through the real store lifecycle, or instrument the running app via `tugDevLogStore` and read `window.tugDevLog.getSnapshot()` (Opt-Cmd-/ opens the dev panel).

**Arithmetic worth checking, not a conclusion:** 9 compaction-seated assistant containers + the 6 other unexplained rows ≈ the 15 extras.

#### Investigation tools {#tools}

- `tugcode dead <file-or-dir>` / `tugcode segment <file-or-dir>`; build with `bun build --compile tugcode/src/main.ts --outfile <path>`.
- `just db-inspect <name|path> ["SQL"]` — e.g. `just db-inspect "instances/release-main/sessions" "SELECT …"` (note: pass the name **without** `.db`).
- `tugutil host instance list` for instance ids/pids/ports; `vmmap --summary <pid>` for the host memory profile (the `IOAccelerator (graphics)` row is the MLX footprint).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Property (real corpus)** | Incremental ≡ full at arbitrary split points; zero re-streams on ordinary appends | The north-star contract (#step-6); skips gracefully off-corpus |
| **Unit (fixture topology)** | Pin rotation/lineage, straddle, unterminated-tail shapes | Scanner rules ([P03], [P04], [P05]) |
| **Parity / Drift** | Rust ↔ tugcode agreement over the real corpus | Any change touching `dead_branch.rs` semantics or segmentation |
| **App-test (selective)** | Real replay chain → rendered transcript | Issues 1–3 regression (#step-8), multi-compaction fixture |

#### What stays out of tests {#test-non-goals}

- Mock-store assertions and fake-DOM render tests — banned; deck coverage goes through the real replay chain (app-test) or the real store lifecycle.
- Timing/throughput benchmarks of the scan — the structural guarantee (resumed vs re-streamed) is the contract; wall-clock follows from it.
- The MLX cache bound's exact steady-state number — verified by reading `logGpu` output in the running app (#step-10), not by a unit test.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Steps 1–3 are complete but **uncommitted** — their working-tree diffs are the artifact; the user owns landing them.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Issue 5 attribution + MLX memory fix | done | uncommitted (working tree) |
| #step-2 | Incremental-resume redesign (effective-uuid seed) | done | uncommitted (working tree) |
| #step-3 | Resumed-lineage exclusion fix | done | uncommitted (working tree) |
| #step-4 | Narrow the resumed-slice trigger taxonomy | done | dash `restore-remediation` |
| #step-5 | Unterminated-tail deferral | done | dash `restore-remediation` |
| #step-6 | North-star certification (zero re-streams on ordinary appends) | done | dash `restore-remediation` |
| #step-7 | Issues 1–3: root-cause the compaction seating in the running app | done | dash `restore-remediation` |
| #step-8 | Issues 1–3: fix + multi-compaction regression coverage | done | dash `restore-remediation` |
| #step-9 | Issue 6: duplicate-pair divergence verdicts | done | dash `restore-remediation` |
| #step-10 | Landing + in-app verification | pending | — |

#### Step 1: Issue 5 attribution + MLX memory fix {#step-1}

**Status: DONE (uncommitted).** Evidence recorded here for the cold reader.

**Commit:** `tugapp(restore-remediation): bound MLX GPU cache, drain generation before unload`

**References:** [P06] MLX cache policy, [Q03] residency, (#context)

**What was done:**
- Attribution: `vmmap --summary` on the release host showed **6.4 GB dirty `IOAccelerator (graphics)`** (Metal/unified-memory) across 2,308 regions — the in-process MLX model — while tugcast sat at ~140 MB. The restore change was thereby cleared of the memory headline.
- `tugapp/Sources/LocalModelBackend.swift`: `gpuCacheLimitBytes = 256 MB` set via `MLX.GPU.set(cacheLimit:)` in `MLXLocalModelBackend.init`; `inflight: Task<String, Error>` tracks the running generation and `unload()` awaits it before dropping the container and calling `clearCache()`; `logGpu(_:)` NSLogs active/cache/peak after load and unload.
- Compile-verified via a Debug `xcodebuild` into the debug DerivedData (no app relaunch — the release app hosts the working session).

**Checkpoint (already passed):** Debug build succeeds. Runtime verification deferred to #step-10.

---

#### Step 2: Incremental-resume redesign (effective-uuid seed) {#step-2}

**Status: DONE (uncommitted).**

**Commit:** `tugcast(restore-remediation): persist the effective-uuid seed; resume compacted sessions incrementally`

**References:** [P01] effective-uuid seed, [P02] FNV keys, (#scanner-map, #t01-reference-sessions)

**What was done:**
- Removed `if needs_effective_recount { resumable = false; }` — recounted parses now hand out full seeds.
- `effective_uuids BLOB` column + `ResumeSeed.effective_uuids` + inline suppression on resumed slices; `CURRENT_RULE_EPOCH` 3→4.
- Unconditional buffering removed: unbuffered first pass, buffered restart on first trigger.
- `tuglaws/turn-metric.md` updated (the "re-streams in full on every change" paragraph replaced with the seed contract).

**Checkpoint (already passed):** 1,607 workspace tests green; both corpus parity contracts green; `incremental_resume_matches_full_parse_over_reference_sessions` green (7 split points per reference session; incremental ≡ full on count, frontier, uuid set).

---

#### Step 3: Resumed-lineage exclusion fix {#step-3}

**Status: DONE (uncommitted).**

**Commit:** `tugcast(restore-remediation): accept resumed-lineage files; suppress superseded ancestors`

**References:** [P03] lineage verdict, [Q02] fork reconciliation, (#t01-reference-sessions)

**What was done:**
- SessionId gate moved from first-record ejection to EOF verdict (`saw_expected_sid` / `lineage_ancestors` accumulation in `parse_session_file_inner`); `lineage_ancestors TEXT` column; `suppress_superseded_lineage` applied in both scan paths with the mtime gate.
- Tests: `a_rotated_lineage_lists_the_newest_file_and_suppresses_the_stale_ancestor` (uses `File::set_modified` to shape mtimes; also covers the forked-ancestor-stays-visible case), `a_file_that_never_claims_its_stem_is_excluded`; the property test now covers `4eb21996` end-to-end.

**Checkpoint (already passed):** 1,607 workspace tests green; `4eb21996` parses, resumes incrementally, and lists.

---

#### Step 4: Narrow the resumed-slice trigger taxonomy {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugcast(restore-remediation): absorb benign off-leaf records on resumed slices`

**References:** [P04] trigger taxonomy, Risk R01, Table T01, (#scanner-map)

**Artifacts:** `parse_session_file_inner`'s trigger block distinguishes resumed slices from full streams.

**Tasks:**
- [ ] In the resumed-slice path only, set `saw_branch` for an off-leaf record **only when `chain.is_user_submission`**; off-leaf non-user records are absorbed (update `frontier.leaf_uuid`, feed `parse_significant`/`step_record`, no trigger). Null-parent-mid-file stays a trigger for all record kinds; `saw_compaction` and unknown-duplicate triggers unchanged.
- [ ] Full (non-resumed) streams keep the broad trigger — it only routes to the buffered recount there.
- [ ] Rewrite the trigger-site comment: replace "Do not narrow it" with the [P04] taxonomy and its dead-branch-rule grounding.

**Tests:**
- [ ] Unit: a resumed slice containing an off-leaf `tool_result`-shaped record (non-user) resumes (`resumed == true`) and matches the full parse's count/frontier/uuid set.
- [ ] Unit: a resumed slice containing an off-leaf **user submission** re-streams (`resumed == false`) and matches the full parse (which computes the dead branch).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green, including both corpus parity contracts.

---

#### Step 5: Unterminated-tail deferral {#step-5}

**Depends on:** #step-2

**Commit:** `tugcast(restore-remediation): defer partial final lines instead of poisoning resumability`

**References:** [P05] unterminated tail, (#scanner-map)

**Artifacts:** The parse loop's unterminated-line handling; the inverted test.

**Tasks:**
- [ ] On an unterminated final line: do not consume it into `consumed`/`window`, do not parse it into meta/engine/triggers, end the loop; the parse stays `resumable` with the frontier at the last terminated line. This includes the meta arm — the partial line must not feed `last_prompt`, `name`, or `created_at` either (today the parsed record reaches the `match rec.kind` arm before the `terminated` check at loop end; the deferral must cut it off before all of that).
- [ ] Record the accepted edge: if a writer dies mid-line and the file never changes again, the cache hit hides the partial line indefinitely. Accepted — the line is truncated JSON and was never a complete record; any future append changes `(size, mtime)` and picks it up.
- [ ] Invert `unterminated_tail_line_is_counted_but_not_resumable` → `unterminated_tail_line_is_deferred_to_the_next_scan`: partial line invisible this scan; after the line completes, the next scan resumes from the frontier and counts it exactly once.

**Tests:**
- [ ] The inverted unit test above.
- [ ] Unit: seed → append(complete line + partial line) → resume; then complete the partial line → resume again; final result ≡ full parse.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green.

---

#### Step 6: North-star certification {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `tugcast(restore-remediation): certify zero re-streams on ordinary appends`

**References:** [P01], [P04], [P05], [Q01], Table T01, (#success-criteria)

**Artifacts:** The extended property test — the executable statement of the north star.

**Tasks:**
- [ ] Extend `incremental_resume_matches_full_parse_over_reference_sessions` (raise splits to ~24 per session): for each split, classify the tail's first records with `dead_branch::parse_chain_records` — a split is a **history-edit split** if the tail contains a new compaction record or an off-leaf user submission before any other trigger shape; every other split is an **ordinary-append split**.
- [ ] The classifier MUST be suppression-aware: a tail compaction record (or any tail record) whose uuid is in the head's effective-uuid set is a suppressed re-append, NOT a history edit — a split inside a re-append block that carries a copied old compact summary is an **ordinary-append split** and must assert `resumed == true`. A naive classifier misfiles exactly the straddle case this certification exists to prove. Compute the head's effective set the same way the parser does (the head parse's `ResumeMark.effective_uuids`, decoded), and check tail uuids against it before classifying.
- [ ] Assert `resumed == true` for every ordinary-append split (zero re-streams), alongside the existing incremental ≡ full equalities for all splits.
- [ ] Log the split classification tallies (`eprintln!`) so a corpus change that erodes coverage is visible in test output.

**Tests:** (the step *is* the test)

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -E 'test(incremental_resume_matches_full_parse_over_reference_sessions)' --no-capture` shows ≥1 ordinary-append split per reference session and zero unexpected re-streams.
- [ ] Full workspace `cargo nextest run` green.

---

#### Step 7: Issues 1–3 — root-cause the compaction seating {#step-7}

**Commit:** `N/A (investigation only — findings recorded in this plan or the dash log)`

**References:** Risk R02, (#deck-facts)

**Artifacts:** A written root-cause statement: which frame(s) seat the extra assistant containers, where the 9th divider is lost, and the exact composition of the 15 extra rows.

**Tasks:**
- [ ] Grep the deck for the literal string `No response requested` — its render site identifies the container type that seats a compaction as an assistant turn.
- [ ] Trace `compact_boundary`/`compact_summary`/hoisted `/compact` envelope consumption through `code-session-store.ts` → `reducer.ts` → `compaction.ts`; identify which frames produce `append-transcript` effects (rows) vs fold into existing rows.
- [ ] Account for the 15: 9 compaction containers + `assistant_opener`/`wake_started`/`system_metadata`/shell-interleave candidates (#deck-facts). Use the running app + `tugDevLogStore` if static tracing is ambiguous — NOT an offline `reduce()` probe (#deck-facts dead end).
- [ ] Determine which of the 9 boundaries loses its divider (first vs last matters: the raw file holds 10 pairs, one nulled by suppression) and whether the loss is a keying/dedup or an ordering interaction with `hoistCompactCommandEnvelope`.

**Tests:** none (investigation).

**Findings (recorded 2026-07-28):**

*Symptom 1 — boundaries seat as assistant turns.* The literal `No response requested.` is **not deck text**: it is a real assistant record in the JSONL, Claude's actual reply to the `/compact` envelope (10 occurrences in `8b8d7bf1`). The seating defect is upstream of it. `hoistCompactCommandEnvelope` (`tugcode/src/replay.ts`) moves the `/compact` envelope to sit immediately **before** the `compact_boundary` frame; the measured frame order at every one of the 9 boundaries is `add_user_message` → `compact_boundary` → `compact_summary` → (assistant blocks) → `turn_complete`. That `add_user_message` opens a `pendingTurn`, so `handleCompactBoundary` (`tugdeck/src/lib/code-session-store/reducer.ts`) takes its **mid-turn branch** (`turnKey !== undefined`) and pushes the `system_note` into the open turn's scratch, instead of emitting the `append-compact-note` effect that seats the divider on the last committed turn. The handler's own docstring — "on replay the `/compact` scaffolding records are skipped, so the boundary usually arrives with no open turn ([P04])" — is stale: the hoist is what put a turn there. The open turn then absorbs Claude's `No response requested.` reply and commits as one row carrying envelope + `Session compacted` block + reply + token footer.

*Symptom 2 — the missing 9th divider.* The file holds 10 boundary records; suppression nulls one re-appended duplicate, so replay emits 9 `compact_boundary` frames and 8 dividers render. The mid-turn branch has a silent drop: `const entry = state.scratch.get(turnKey); if (entry === undefined) return { state, effects: [] };`. A `pendingTurn` whose turn is `suppressed` (the canceled-`/compact` throwaway summarization turn the commit path drops) loses its note with the turn. This is the leading hypothesis for the single lost divider and is falsifiable at #step-8: seating the divider off the open turn entirely must restore 9 of 9.

*Symptom 3 — `83 OF 68`.* Not compaction at all. `displayed` is `transcript.length` (`session-load-control-bar.tsx`), which counts **every** row including shell-exchange rows; `total` is `replayWindow.totalTurns`, the engine's Claude-turn count. `instances/release-main/shell_exchanges` records **18** shell exchanges for `8b8d7bf1`, interleaved into `_transcript` by `upsertShellTurn` / `insertTurnByTimestamp`. Shell rows are `#s` non-context ink ([D111]) and are not Claude turns. **Prediction: `83 = 68 Claude turns + 15 shell rows`** (15 of the 18 inside the loaded window); the fix is to count only Claude-origin turns in `displayed`, not to remove rows.

*Method note.* The offline store-lifecycle probe could not be completed: driving the real `CodeSessionStore` with `translateJsonlSession`'s frames for this session crashes bun 1.3.9 with `EXC_BREAKPOINT` on a worker thread (a bun-internal panic, JS stack absent, reproducible from ~230 frames in and unaffected by JIT/stack-size knobs). The frame-level measurements above come from draining `translateJsonlSession` alone, which is stable; the row-composition claims are from static tracing plus the ledger counts, and are pinned by #step-8's regression test rather than by a probe.

**Checkpoint:**
- [x] The root-cause statement names file/symbol for each of the three symptoms and predicts the exact rendered-row arithmetic (83 = 68 + 15 shell rows) — falsifiable against #step-8's fix.

---

#### Step 8: Issues 1–3 — fix + multi-compaction regression coverage {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck(restore-remediation): seat compaction boundaries as dividers, not assistant turns` — scope follows #step-7's root cause: use `tugcode(restore-remediation): …` if the fix lands in `tugcode/src/replay.ts` rather than the deck

**References:** Risk R02, (#deck-facts, #success-criteria)

**Artifacts:** The seating fix (tugcode and/or deck side per #step-7); a sanitized multi-compaction fixture; regression tests.

**Tasks:**
- [ ] Implement the fix so a compaction renders as: user row for the `/compact` envelope, `Session compacted` divider below it, no assistant row, no "No response requested", and the transcript row count equals the engine count.
- [ ] State-zone note: the expected fix is seating logic over existing store state (no new state, so no State Zone Mapping entry). If #step-7's root cause demands new state, map its tuglaws zone in this plan before writing code and cross-check `tuglaws/tuglaws.md` ([L02], [L06]).
- [ ] Derive a multi-compaction fixture from `8b8d7bf1` via `project-session.ts` (chain topology) or `sanitize.ts` (scrubbed slice) — never vendor the raw session.
- [ ] If tugcode's frame stream changes shape, rebuild the compiled tugcode binary and re-run the Rust↔TS parity contracts.

**Tests:**
- [ ] App-test (or store-lifecycle test if the app-test workspace can't hold the fixture — see `reference_apptest_transient_workspace`): rendered row count == engine count; divider count == compaction count; boundary rows are dividers, not assistant turns.
- [ ] Existing `at0193` / `at0106` stay green (single-compaction shape unchanged).

**Checkpoint:**
- [ ] `just app-test-changed` green (with `@covers` on any new test; `just app-test-covers-check` passes).
- [ ] `bunx vite build` succeeds (production-bundle gate for any tugdeck change).

---

#### Step 9: Issue 6 — duplicate-pair divergence verdicts {#step-9}

**Commit:** `N/A (analysis — verdicts recorded against [Q04]; any code change becomes a follow-up)`

**References:** [Q04], Table T01, (#reference-measurements)

**Artifacts:** A verdict (harmless / latent bug / rule change) per divergence class, recorded in this plan under [Q04]'s resolution.

**Tasks:**
- [ ] Extract the 9 parentUuid-divergent and 3 message-divergent pairs from `4eb21996` (scratch script under `/tmp`); locate each relative to compaction boundaries.
- [ ] For the 9: determine which occurrence's parent the walk uses (`resolve_parent` takes the newest occurrence strictly before the child) and whether first-occurrence-wins can mis-kill/mis-resurrect any branch on the real topologies found.
- [ ] For the 3: identify the differing subfield (`message.id`/`stop_reason`/`role`) and check it against `SigRecord` and the same-`message.id` continuation rule in `turn_engine.rs`/`replay.ts`.
- [ ] For `toolUseResult` (299): sample pairs, characterize the divergence direction (is the re-append richer?), and judge the cost of keeping the first occurrence in `tool_use_structured` emission.

**Tests:** none (analysis); any resulting rule change ships with its own tests in a follow-up plan.

**Checkpoint:**
- [x] [Q04] resolution updated with three explicit verdicts and evidence.

---

#### Step 10: Landing + in-app verification {#step-10}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-8

**Commit:** `N/A (verification only)`

**References:** [Q02], [Q03], (#success-criteria, #tools)

**Tasks:**
- [ ] User lands the working-tree diffs and relaunches via `just app-release` (**user gesture** — it quits the running app). The first launch pays the one-time epoch-4 corpus re-scan; verify subsequent warm scans report cache hits/resumes, not full parses.
- [ ] Memory: `vmmap --summary <host pid>` shows `IOAccelerator` ≈ weights + ≤256 MB cache (~2.6 GB ceiling with the model resident); `MLXLocalModelBackend` `logGpu` lines confirm; typing/session-open lag gone.
- [ ] Issue 4 residuals: transcript no longer blanks on app activation; `4eb21996` lists with full content and correct count; report the `31c60766` fork state to the user ([Q02]).
- [ ] `just db-inspect "instances/release-main/sessions" "SELECT excluded, COUNT(*) FROM external_scan_cache GROUP BY excluded"` — the 22 exclusions drop to only genuinely-foreign files.
- [x] Cross-check tuglaws: `turn-metric.md`'s scanner paragraph now states the [P04] trigger taxonomy and the [P05] tail deferral; no other law text carries the old re-stream policy (`tracking-changes.md`'s "re-stream" mentions are about replay idempotency, unrelated).

**Checkpoint:**
- [ ] Every #success-criteria line verified in the running release app.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A restore pipeline where appends never re-parse history, the scanner lists every session's newest lineage, compaction boundaries render correctly, and the host process no longer bleeds unified memory — with the north star certified by a property test over the real corpus.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Zero re-streams on ordinary-append splits, certified by the extended property test (#step-6).
- [ ] `8b8d7bf1` renders 68/68 with 9 dividers and correct boundary seating (#step-8, verified in-app at #step-10).
- [ ] Host RSS with model resident ≤ ~2.6 GB; lag gone (#step-10).
- [ ] `4eb21996` listed with full content; exclusion count reduced to genuinely-foreign files (#step-10).
- [x] [Q04] carries three explicit verdicts (#step-9).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] absorb `/compact` boundary events incrementally (property-test-gated).
- [ ] [Q03] local-model residency product decision (user).
- [x] Issue 6 needs no rule change — #step-9's verdicts closed [Q04].
- [ ] Lineage-aware session identity in the picker (unify rotated ids under one row rather than suppressing files).

| Checkpoint | Verification |
|------------|--------------|
| North star | `cargo nextest run -p tugcast -E 'test(incremental_resume…)'` — zero unexpected re-streams |
| Rendering | `just app-test-changed` + in-app 68/68 on `8b8d7bf1` |
| Memory | `vmmap` `IOAccelerator` + `logGpu` lines post-relaunch |
