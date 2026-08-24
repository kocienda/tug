<!-- devise-skeleton v4 -->

## Robustify File Tracking {#robustify-file-tracking}

**Purpose:** Make file-claim tracking self-correcting: restore-class shell commands stop minting authorship, directory operands stop fanning proof across subtrees, every new proof row carries evidence the diff can falsify, and a dead session's claim that no longer places in the working tree retires instead of contending forever. The Changes card additionally names the co-owners behind every SHARED badge and offers a release gesture.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented (on dash `robustify-file-tracking`, awaiting join) |
| Target branch | main |
| Last updated | 2026-08-13 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

On 2026-08-13, four tugdeck files showed SHARED in the Changes card against a session that had been closed for a day and whose net effect on those files was zero. The cause chain (fully traced against the live `changes.db` journal and the session transcript): the closed session ran `git stash push … && git checkout 69ed16ce2 -- tugdeck && … && git checkout HEAD -- tugdeck && git stash pop` to probe an old bundle. `shell_ops` classifies `git checkout <rev> -- <pathspec>` as `DeclaredKind::EditInPlace` on the operand — here the *directory* `tugdeck` — and `into_delta_rows` (`tugrust/crates/tugcast/src/feeds/attribution.rs`) promotes every bracket-delta path **equal to or beneath** a declared path to `origin: "cmd"`, which is proof class (`PROOF_ORIGINS` in `tugrust/crates/tugchanges-core/src/ledger.rs`). One restore command minted proof-of-authorship over a whole subtree. Those rows then stayed live for 24 hours (the only automatic retirement is the commit cut, `min_live_at_ms` in `tugrust/crates/tugchanges-core/src/changes.rs`), carried **no spans** (so in contention they decode to `Anchor::Whole` → `Claim::Whole`, unfalsifiable — bypassing everything `dash/archive/partial-file-claim-fixup.md` built), and the owner's deadness was never consulted (`proof_owners` in `tugrust/crates/tugcast/src/feeds/changeset.rs` reads `owner_live` only for the orphan lift, never for contention; the sync engine's `foreign_proof_sessions_for_path` doesn't read liveness at all).

The conceptual gap, stated once: **a claim is a hypothesis about the bytes currently in the working tree, and nothing ever re-tests the hypothesis.** The system checks *when* a claim was made (the liveness cut) but never *whether the claimed content is still there*. The five existing retirement mechanisms — commit cut, `DeleteSession`, `Sever` ([D120]), `Disclaim`, `PurgeOutOfRepo` (all in `tugrust/crates/tugcast/src/session_ledger.rs`) — are either gestures someone must perform or fire only on commit. This plan closes the gap in four layers, each independently sufficient to kill the incident, together making the tracking self-correcting.

#### Strategy {#strategy}

- **Layer 1 — restores are not authorship.** A `git restore` / `git checkout <rev> -- <pathspec>` puts *recorded* content into the tree; the resulting bytes are the repository's, not the session's. New `DeclaredKind::Restore` stays gate-readable (the command does mutate files) but never promotes to `cmd` and never mints replay rows ([P01]).
- **Layer 2 — narrow the promotion.** Equal-or-beneath `declared_covers` matching survives only for lifecycle kinds (`Remove`/`Move` — the `rm -rf dir/` case its own comment justifies); edit-class declarations promote on exact path equality only ([P02]).
- **Layer 3 — no more evidence-free proof rows.** `cmd`-promoted rows mint `hunk`-kind spans from the path's working diff at bracket close; `Write`/`NotebookEdit` `whole` spans gain the written content's hash and line hashes ([P04], Spec S02). Every *new* proof row becomes falsifiable.
- **Layer 4 — retirement by falsification.** In contention, a **dead** owner participates only through evidence that places into the current diff; dead-and-nothing-places is a ghost and drops out of `shared`/`contested` entirely. Live owners keep today's exact semantics — the conservative widening stays where a session could be mid-work ([P03], Spec S03).
- **Decoder before writer**, as in the fixup plan: the contention reader learns the new anchor shapes and the retirement rule before any writer produces them (Risk R03).
- **Visibility, and the only remedy the ledger's existing rows have.** The SHARED badge learns to name its co-owners (wire field `shared_with`), and shared rows whose co-owners are all dead grow the existing Claim gesture as a manual release ([P06]). Layers 1–4 govern rows minted *from here on*; the four span-less `cmd` rows the incident already wrote are dead-owner-with-no-anchors, which Spec S03 reads as `Claim::Whole` forever. [P06]'s release gesture is what retires them — Step 7 is load-bearing, not cosmetic.

#### Success Criteria (Measurable) {#success-criteria}

- The incident replayed as a unit test: a Bash bracket whose command is `git checkout <sha> -- <dir>` produces `origin: "bash"` rows for changed files under `<dir>`, never `cmd`. (`agent_bridge.rs` / `attribution.rs` tests.)
- `sed -i dir` cannot happen (refused by the gate today), but a hypothetical edit-class declaration of a directory no longer promotes files beneath it; `rm -rf dir/` still promotes them. (attribution unit test.)
- A `cmd`-promoted row records `hunk`-kind spans naming the path's current diff hunks. (agent_bridge test.)
- A `Write` span's anchor carries `file_hash` and `line_hashes` of the written content. (attribution unit test.)
- `classify_contention`: a dead owner whose every anchor fails to place yields `shared == false` against a live owner; the same owner marked live yields `shared == true` (today's widening). (contention unit tests.)
- End to end, both readers: a compose over a path with one live placing owner and one dead non-placing owner yields `shared == false` (tokio test in `changeset.rs`); `tugutil changes` over the same seeded state agrees (sync test in `changes.rs`).
- A dead `Write` owner whose recorded `file_hash` still matches the working file contends (`Claim::Whole`); after the file changes and no line hash places, it retires. (contention unit test.)
- `ChangesetFile.shared_with` reaches the deck and renders co-owner names on the SHARED badge; `bunx vite build` green; `just app-test-changed` selection green.
- `cd tugrust && cargo nextest run` fully green with `-D warnings`.

#### Scope {#scope}

1. `tugrust/crates/tugchanges-core/src/shell_ops.rs`: `DeclaredKind::Restore` for `git restore` and pathspec `git checkout`.
2. `tugrust/crates/tugcast/src/feeds/attribution.rs` + `agent_bridge.rs`: promotion narrowing (exact vs subtree declared sets), Restore exclusion, span minting for promoted rows, content-bearing `whole` anchors.
3. `tugrust/crates/tugchanges-core/src/contention.rs`: `Anchor::WholeFile`, `OwnerAnchors.live`, the dead-owner retirement rule, current-file-hash input.
4. Liveness plumbing to both readers: `tugcast::feeds::changeset` (compose) and `tugchanges-core::changes` (sync engine, reading the per-instance `sessions.db`).
5. Wire + deck: `ChangesetFile.shared_with`, SHARED badge co-owner display, Claim affordance on dead-co-owner shared rows.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No TTL / time-decay retirement.** Uncommitted work legitimately lives for days; a claim that is still *true* must not expire because a clock ran. Retirement is evidence-based only.
- **No retire-on-session-close.** Rows deliberately survive close — the orphan lift ([D120]) depends on it. A dead session's *placing* claims keep contending and keep surfacing as orphans, exactly as today.
- **No delete-on-clean-observation.** A compose landing inside a `git stash push … git stash pop` window would destroy legitimate claims the pop is about to make true again. Rows persist; the read side adjudicates. (This is why Layer 4 is a read-time filter, not a delete.)
- **No retroactive falsifiability for legacy rows.** Existing span-less `cmd` rows and bare `{}` `whole` anchors keep today's unfalsifiable `Claim::Whole` behavior — the honest floor, self-draining via the commit cut (same [P05] posture as the fixup plan).
- **No spans for replay-minted `cmd` rows.** `mint_replayed_cmd_rows` (`agent_bridge.rs`) runs where no pre-command tree state survives; the current tree may not match the historical command. They stay span-less (accepted residual, drains via commits).
- **No change to the `foreign` bucket or orphan lift.** A dead session's sole-owned dirty file is the orphan story, already handled; retirement here only affects *contention* (≥2 proof owners).
- **No proof for a restore that puts a non-HEAD rev's bytes in the tree.** `git checkout <old-sha> -- <file>` leaves the file dirty against HEAD, and that dirtiness exists because the session chose those bytes — yet [P01] records it as a `bash` hint, so the file lands unattributed and needs one CLAIM. Accepted cost, resolved at [Q03].
- **No retirement for untracked files.** Both readers bail before contention when the path has no readable hunks — compose's `contention_verdict` returns `None` (file-level `shared = true`), and `paths_contend` returns `Ok(true)` when `file_hunks` is empty. A ghost claim on a session-*created* file is therefore outside Layer 4 entirely, and Layer 3 mints it no spans either: [P05] uses `fetch_git_diff` (tracked-only), not `fetch_git_diff_with_untracked`. That is deliberate — ids minted from a synthesized untracked diff would be unreproducible by either read side, both of which use the tracked spelling, so evidence written there could never place. Drains via the commit cut like every other unfalsifiable row.
- **No content fallback for drifted `hunk`-kind anchors** (still the fixup plan's out-of-scope); drift → unplaced → dead-owner retirement handles the ghost case, which is what matters here.
- **No new CONTROL verbs.** The Layer-4 release gesture reuses `changeset_claim` (already severs co-owners per [D120]); no protocol addition beyond the `shared_with` field on the existing snapshot.

#### Dependencies / Prerequisites {#dependencies}

- `dash/archive/partial-file-claim-fixup.md` shipped (`d107a8238`…`4d5b5b090`): `tugchanges-core::anchors` exists, `Claim::Hunks { placed, unplaced }` exists, `contention.rs` fixtures build via the production constructor.
- `hunk_spans(ids)` exists in `attribution.rs` (writes `hunk`-kind spans; used by `tugutil file` receipts) — Layer 3 reuses it for promoted rows.
- `record_file_event_with_spans` exists on `SessionLedger` (`session_ledger.rs:4192`).
- `ledger::resolve_sessions_db_path()` (tugchanges-core; honors `TUG_INSTANCE_ID`/`TUG_SESSIONS_DB`) — the sync engine already opens it for the "known session" test and drops the connection immediately (`changes.rs:206-209`).

#### Constraints {#constraints}

- **Warnings are errors** (`tugrust/.cargo/config.toml`).
- `classify_contention` stays a **pure function** — no filesystem, no git. New inputs (owner liveness, the current file's content hash) are supplied by the callers ([P03]).
- **The decoder ships before the writer** (Risk R03): `contention.rs` must decode `WholeFile` anchors and carry `OwnerAnchors.live` before `attribution.rs` writes the new shape — and note the `~/.local/bin/tug*` symlinks lag `main` rebuilds, reproducing the stale-reader window until rebuilt.
- The `anchor` column is free-form JSON `TEXT`; **no DDL change, no `CHANGES_SCHEMA_VERSION` bump** anywhere in this plan.
- Live-owner semantics must be **byte-for-byte today's**: every behavioral delta in contention is gated on the owner being dead. The conservative directions from the fixup ([P04] there) are unchanged for live owners.
- `DeclaredKind` is consumed in three places that must stay in step per commit (workspace builds between commits): `shell_ops.rs` itself, `attribution.rs::op_for_declared_kind`, and `agent_bridge.rs` (replay minting, rename synthesis). The gate (`tugutil/src/commands/file.rs`) matches only on `ParseOutcome` variants and is untouched by a new kind.

#### Assumptions {#assumptions}

- Session liveness truth is the per-instance `sessions.db` `sessions.state` column (`'live'` vs anything else); `changes.db` is machine-global but `file_events_for_project` already resolves `owner_live` by `LEFT JOIN sessions` with a missing row reading as not-live (`session_ledger.rs:5139`). This plan adopts the same reading in the sync engine: no `sessions` row in this instance's `sessions.db` = dead. Cross-instance liveness is Risk R02. Distinguish this from *failing to consult the source at all* (no sessions.db, an id the caller never resolved), which reads live — see [P03]'s failure-direction clause.
- A dead session cannot be "mid-edit": its evidence failing to place means the content is gone (reverted, superseded, or restored), not merely in flux. This is what licenses clearing the `unplaced` widening for dead owners ([P03]).
- `contention_verdict` runs only for paths with ≥2 live-cut-passing proof owners (bounded by contention, not the dirty set — Risk R09 of changes-rework), so the added per-path work in this plan (one `std::fs::read` for the file hash, one diff per promoted path at bracket close) stays bounded.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should cross-instance liveness get a shared presence table? (DEFERRED) {#q01-cross-instance-liveness}

**Question:** A session live in app instance B has no `sessions` row in instance A's `sessions.db`, so instance A reads it as dead. Should liveness move to a machine-global table in `changes.db`?

**Why it matters:** Layer 4 retirement could drop a genuinely-live foreign-instance co-owner's claim while its content momentarily fails to place.

**Resolution:** DEFERRED. Retirement requires dead **and** nothing-places; a live cross-instance session actively holding content in the tree has placing anchors, so the misread is harmless exactly when it matters. The residual (cross-instance owner whose evidence transiently fails to place) under-warns for one compose cycle and self-heals when the evidence places again — rows are never deleted (Risk R02). A shared presence table is a schema change (`CHANGES_SCHEMA_VERSION` bump) and belongs to its own plan if multi-instance contention becomes a real workflow. Revisit trigger: a field report of a SHARED badge flickering between two live instances.

#### [Q02] Should `claim`-origin rows become falsifiable too? (DECIDED) {#q02-claim-rows-unfalsifiable}

**Question:** CLAIM ALL mints `origin: "claim"` rows with no content evidence; should they verify?

**Resolution:** DECIDED — no. A claim row is the *user's* testimony, deliberately made without content evidence (it exists to repair attribution the machine could not prove). It stays `Anchor::Whole`/`Claim::Whole`, contends even when dead, and retires only via commit/disclaim/sever. Same reasoning shields bare `{}` legacy `whole` anchors ([P05] posture).

#### [Q03] Should a restore from a non-HEAD rev still mint proof? (DECIDED) {#q03-restore-from-old-rev}

**Question:** [P01] exiles every restore from proof on the grounds that restored bytes are the repository's. That is airtight when the command converges the tree *toward* HEAD — `git restore <p>`, `git checkout -- <p>`, `git checkout HEAD -- <p>` — where the change made is the *removal* of change, and a fully-converged file is not dirty at all. It is not airtight for `git checkout <old-sha> -- <path>`: those bytes differ from HEAD, so the file *is* dirty, and it is dirty because this session chose that content. Should the grammar split the two — proof for the arbitrary-rev form (exact-path only, per [P02]), never proof for the converge form?

**Why it matters:** Under the blanket rule, a deliberate `git checkout <sha> -- src/x.ts` used to bring old code back for real lands in `UNATTRIBUTED — NO SESSION CLAIMS THESE`.

**Resolution:** DECIDED — no split; `Restore` stays blanket. The distinction is syntactically decidable (rev absent / literal `HEAD` vs anything else) but it buys back a narrow case at the cost of a grammar branch whose *proof* arm is the exact shape that caused the incident, differing only in operand arity. And the residual is cheap and visible: the bracket hint still names the command, so the file surfaces in unattributed with `modified`/`bash` provenance saying this session touched it — one CLAIM away from correct, which is precisely the population [Q02] argues user testimony should resolve. Note the incident itself is killed twice over regardless: `tugdeck` was a directory operand, which [P02] excludes from edit-class promotion independently of [P01]. Revisit trigger: restoring from an old rev becomes a routine authoring idiom rather than a probe idiom, and unattributed rows from it show up repeatedly.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Retirement under-warns: a dead owner's real uncommitted region misread as gone | high | low | Retirement requires *zero* placing evidence; any placing anchor keeps the owner contending (R01) | A landed commit that took a dead session's work with no SHARED warning |
| Cross-instance live session read as dead | med | low | Dead ∧ nothing-places conjunction; read-time filter, self-heals ([Q01], R02) | SHARED flicker between two live instances |
| Writer outruns decoder for `WholeFile` anchors | med | med | Step ordering #step-3 → #step-4; stale reader decodes new shape as `Whole` = today's behavior, benign (R03) | Every Write-owner suddenly unfalsifiable again |
| Bracket-close span minting adds latency to Bash results | low | low | One diff per *promoted* path only (normally zero); reuses the async diff spelling (R04) | Bash result latency regression in the Session card |
| Hunk-id spans on promoted rows drift on the next edit | low | high | Drift → unplaced; live owner widens (today's floor), dead owner retires — both correct directions (R05) | — |

**Risk R01: Retirement takes a dead session's real work out of SHARED** {#r01-retirement-under-warns}

- **Risk:** The expensive direction — a dead co-owner's genuinely-present region stops warning, and this session lands it.
- **Mitigation:** The rule is a conjunction: the owner must be dead **and** every anchor must fail both the hash rule and the containment fallback **and** carry no unfalsifiable anchor (`Whole` from a claim/legacy row keeps contending, [Q02]). A dead session whose content is present has placing anchors by construction — the anchors were derived from that very content ([P01] of the fixup). The only way to be dead-and-non-placing is for the content to be gone.
- **Residual risk:** A dead session's edit fully overwritten by *this* session's later edit retires — and that is the correct answer: the surviving bytes are this session's.

**Risk R02: Per-instance liveness misreads cross-instance sessions** {#r02-cross-instance}

- **Risk:** Instance A retires instance B's live session's non-placing claim.
- **Mitigation:** See [Q01]. Additionally, the sync engine (`tugutil`) runs inside the session's environment where `TUG_INSTANCE_ID` points at the *right* instance for the session asking — the misread only affects how it sees *other* instances' sessions, the same blind spot `owner_live` already has in compose today (a `LEFT JOIN` miss reads dead and orphan-lifts). No new blindness is introduced; an existing one gains a lower-stakes consumer.
- **Residual risk:** Accepted; revisit per [Q01].

**Risk R03: The writer outruns the decoder** {#r03-writer-before-decoder}

- **Risk:** `WholeFile`-shaped anchors reaching a binary whose `Anchor::from_span` predates #step-3 decode by the legacy path.
- **Mitigation:** Spec S02 makes the new shape a *superset*: the `whole` kind gains fields, and an old decoder's `"whole"` arm ignores unknown JSON fields and returns `Anchor::Whole` — today's exact behavior, benign over-warning. Step ordering (#step-4 depends on #step-3) prevents the window in this repo; a stale `~/.local/bin/tugutil` reproduces it harmlessly until rebuilt.
- **Residual risk:** None beyond pre-plan behavior.

**Risk R04: Span minting at bracket close costs a diff per promoted path** {#r04-bracket-close-cost}

- **Risk:** A Bash command declaring many files (e.g. `tugutil file edit --patch` across a tree) pays one `git diff` per promoted path before the result frame is released.
- **Mitigation:** Promotion is normally empty (most Bash commands declare nothing); `tugutil file` receipts already carry their own hunk ids and skip this path entirely (`mint_receipt_rows`). The minting is best-effort: a diff failure records the row span-less (today's shape), never blocks the frame.
- **Residual risk:** Bounded by declared-and-changed path count; accepted.

**Risk R05: Promoted-row hunk ids drift on the next edit** {#r05-hunk-drift}

- **Risk:** A later edit to the same region changes the hunk id; the promoted row's evidence stops placing.
- **Mitigation:** For a live owner, a drifted `Anchor::Hunk` sets `unplaced` → SHARED widens, election narrows — the fixup's F3 floor, strictly better than today's span-less `Claim::Whole`. For a dead owner it retires, which is the point of this plan.
- **Residual risk:** None worth carrying.

---

### Design Decisions {#design-decisions}

#### [P01] Restore-class declarations are gate-visible but never proof (DECIDED) {#p01-restore-not-proof}

**Decision:** `shell_ops` classifies `git restore <paths>` and `git checkout … -- <paths>` as a new `DeclaredKind::Restore`. The gate still sees the command as file-mutating (parse succeeds, ops are declared, `ParseOutcome::Ops` — the gate's allow/deny logic is untouched since it keys on `Unparseable` only). But: `into_delta_rows` never promotes a Restore-declared path to `cmd` (rows stay `bash` bracket hints), and `mint_replayed_cmd_rows` skips Restore ops entirely (no replay `cmd` rows).

**Rationale:**
- A restore writes the *repository's recorded bytes*; authorship of those bytes belongs to whoever committed them, which the commit history already records. Minting session authorship over restored content is a category error — the root cause of the 2026-08-13 incident. The rule is blanket rather than split by rev; [Q03] states what that costs and why the cost is taken.
- The bracket hint is still correct and still wanted: the session *did* run a command that changed these files, and the hint surfaces on unattributed rows as `hinted_by` provenance.
- The rename-takeoff synthesis in `agent_bridge.rs` (the `DeclaredKind::Move` match at Bash close) is unaffected — Restore never renames.

**Implications:**
- `op_for_declared_kind` (`attribution.rs:695`) maps `Restore → "modified"` (the op label a bracket row would have carried anyway; it only surfaces if some other rule records the row).
- `git stash` subcommands stay unparsed (`NoFileOps` → bracket-only), which is already correct: a stash names no files.

#### [P02] Equal-or-beneath promotion is a lifecycle privilege (DECIDED) {#p02-promotion-narrowing}

**Decision:** The declared-path set passed to `into_delta_rows` splits in two: a **subtree** set (paths from `Remove`/`Move`/`Copy` ops — promotion matches equal-or-beneath) and an **exact** set (paths from `EditInPlace`/`WriteTarget`/`Touch` ops — promotion requires path equality). `Restore` ops contribute to neither ([P01]).

**Rationale:**
- The equal-or-beneath rule exists for one case, named in its own comment (`attribution.rs:503`): `rm -rf dir/` declares the directory while `--untracked-files=all` reports the files inside it. That is a lifecycle shape.
- Edit-class verbs that reach promotion (`sed -i`, `perl -i`, `tugutil file edit`, redirect targets) name *files* — their grammar requires literal file operands. A directory operand reaching an edit-class declaration is exactly the checkout-pathspec case, which [P01] already exiles; splitting the sets makes the invariant structural rather than incidental, so the next directory-taking verb cannot reopen the hole.

**Implications:**
- `into_delta_rows` signature: `declared: &HashSet<PathBuf>` becomes `declared: &DeclaredPromotions` (new struct in `attribution.rs`: `{ exact: HashSet<PathBuf>, subtree: HashSet<PathBuf> }`). `declared_covers` becomes a method on it: `exact.contains(path) || subtree.iter().any(|d| path == d || path.starts_with(d))`.
- Callers: the Bash bracket close builds it from `cmd.ops` partitioned by kind (`agent_bridge.rs:2512`); the turn bracket passes `DeclaredPromotions::default()` (empty, as today).

#### [P03] Dead owners contend only through placing evidence; death clears the widening (DECIDED) {#p03-dead-owner-retirement}

**Decision:** `OwnerAnchors` gains `live: bool`. In `claim_for`, a **dead** owner's claim is computed with two changes: (a) evidence that fails to place does **not** set `unplaced` (no widening — a dead session is not mid-work), and (b) an `Anchor::WholeFile` whose `file_hash` mismatches the current file degrades to its `line_hashes` placement instead of `Claim::Whole`. Unfalsifiable anchors (`Anchor::Whole` — claims, legacy rows, caps) still yield `Claim::Whole` regardless of liveness ([Q02]). A dead owner whose accumulated claim is `Hunks { placed: ∅, unplaced: false }` covers nothing and intersects nothing — it has retired from `shared` and `contested` without a row being touched. Live owners: byte-for-byte today's semantics.

**Rationale:**
- The conservative widening ([P04] of the fixup) exists because a *live* session's unplaceable evidence may describe work in flux. Death removes that possibility: the content is gone or superseded, and warning about it is noise that erodes trust in every real SHARED badge — the complaint that motivated this plan.
- Filtering at read time (never deleting) means a `git stash pop` that brings the content back makes the anchors place again and the claim revive — the self-healing property no deletion scheme has.
- The orphan lift is untouched: it keys on file-level ownership by dead sessions, and a dead session's *placing* claims still contend and still orphan-lift exactly as today.

**Implications:**
- `classify_contention(hunks, owners)` gains a third parameter: `current_file_hash: Option<&str>` (`content_hash` of the working file's full bytes), needed by the `WholeFile` verification; `None` (unreadable file) makes `WholeFile` unfalsifiable — widening, the blessed failure direction.
- Both callers construct `OwnerAnchors { live }`: compose from `OwnerAgg.live` (already resolved via the `sessions` join), the sync engine from a new per-session state read (#step-6).
- **An owner whose liveness cannot be resolved reads as live.** Absence must not mean death: dead is the retirement-eligible state, and every other unresolvable input in this plan widens (`current_file_hash: None` widens, an unreadable diff widens, a missing sessions.db keeps every owner live). Compose's `live_ids` is built from the same `owners` map the contended paths were derived from, so a proof id missing from it is a bug rather than a dead session — the lookup takes the live default and the invariant is asserted in #step-5. This is *not* in tension with the Assumption that a missing `sessions` row reads as dead: that is a resolved answer from the liveness source, this is the failure to reach the source at all.
- The `contention.rs` module doc's conservative-direction section gains the death clause.

#### [P04] `whole` anchors carry the written content's identity (DECIDED) {#p04-wholefile-anchor}

**Decision:** `spans_for_tool_input` for `Write`/`NotebookEdit` records, when the written text is available, `{"file_hash": content_hash(full_text), "line_hashes": [...], "added_lines": N}` under the existing `whole` kind — `line_hashes` built by the same distinctive-line rule and cap as edit anchors (`anchors::edit_anchor` internals, reused via a new `whole_anchor(content: &str)` constructor in `tugchanges-core::anchors`). Fallback shapes that have no single content string (a `MultiEdit` past `SPANS_PER_EVENT_CAP`, a malformed input) keep the bare `{}`.

**Rationale:**
- A Write knows its exact output; recording nothing about it is the reason a ghost Write is unfalsifiable today.
- `file_hash` gives the strong test (bytes still exactly ours → genuinely whole); `line_hashes` gives the graceful degradation (co-edited since → contend on the lines that are demonstrably ours), reusing the entire AddedLines matching path.

**Implications:**
- Decode (Spec S02): kind `whole` with `file_hash` present → new `Anchor::WholeFile { file_hash, line_hashes, added_head }`; bare/unknown → `Anchor::Whole` as today. Old binaries reading new anchors fall through to `Anchor::Whole` — benign (Risk R03).
- Claim semantics (Spec S03): live owner → `Claim::Whole` always (a Write really did produce the file; unchanged from today). Dead owner → `file_hash` matches → `Claim::Whole`; else place `line_hashes` like an `AddedLines` anchor.

#### [P05] Promoted `cmd` rows mint hunk spans at bracket close (DECIDED) {#p05-cmd-rows-mint-spans}

**Decision:** At Bash bracket close, for each delta row promoted to `cmd`, fetch the path's working diff (the async spelling, `super::git::fetch_git_diff` + `tugchanges_core::parse_hunks`, same as `contention_verdict`) and record the row via `record_file_event_with_spans` with `hunk_spans(ids)` — the same evidence class `tugutil file` receipts write. Diff failure or empty hunks → record span-less (today's shape), best-effort, never gates the frame.

**Rationale:**
- The bracket knows only fingerprints (`FileState { status, mtime }` — no content), so edit-precise anchors are out of reach; but the working diff at close is exactly the content state the promotion asserts authorship over, and hunk ids are the identity the whole contention system is keyed on (Spec S05/S06 of changes-rework).
- This makes every new promotion falsifiable: content later reverted → ids drift → unplaced → dead-owner retirement ([P03]) or live-owner narrow-election (fixup F3).

**Implications:**
- `into_delta_rows` stays synchronous and pure; the *caller* (`agent_bridge.rs` Bash close, line ~2521) partitions its output by `row.origin == CMD_ORIGIN` and fetches diffs only for those.
- Replay minting stays span-less (#non-goals).

#### [P06] SHARED names its co-owners; release is the existing Claim (DECIDED) {#p06-shared-with}

**Decision:** `ChangesetFile` gains `shared_with?: { id: string; name: string; live: boolean }[]`, filled by compose for contended paths from the `owners` map (`OwnerAgg.display_name` / `.live`), listing every *other* proof owner that survived retirement. The deck renders the names on the SHARED badge (title/hover, plus the co-owner line in the expanded row). A shared file whose `shared_with` entries are all dead shows the existing Claim affordance (the [D120] gesture, `changeset_claim`, which severs co-owners) as a per-file release.

**Rationale:**
- Yesterday's archaeology took a database excavation; the badge should carry its own evidence. Naming the co-owner turns "crazy bad wrong" into "oh, that probe session" at a glance.
- Claim-as-release reuses shipped, journaled semantics (`sever_file_ownership_except`) — no new verb, no new failure modes; and with [P03] shipped, the gesture is needed only for the unfalsifiable residue (claims, legacy rows), which is exactly the population where user testimony *should* be the resolution.

**Implications:**
- `shared_with` is optional on the wire; absent ⇒ old server, deck renders the badge as today. The type guard in `tugdeck/src/lib/changeset-types.ts` treats it as optional.
- Only surfaced session identities already broadcast in the snapshot are shown — no new information class crosses the wire.

---

### Deep Dives {#deep-dives}

#### The promotion pipeline, end to end {#promotion-pipeline}

Live Bash call: `tool_use` arrives → `declared_ops_for_command` parses via `shell_ops::parse_shell_ops` → `pending_cmds.insert` holds the `PendingCmd { ops, … }` → on `tool_result`, `open_bash.remove` yields the fingerprint bracket, `pending_cmds.take` yields the parse, `canonical_declared_paths` canonicalizes the operands, and `bracket.into_delta_rows(&post, …, &declared, at)` marks each delta path covered by a declared path as `origin: "cmd"` (`attribution.rs:537`, `declared_covers` at `:566`), recording via `ledger.record_file_event(&row)` (`agent_bridge.rs:2521-2545`). Replay Bash call: no fingerprint survives, so `mint_replayed_cmd_rows` (`agent_bridge.rs:1171`) mints `cmd` rows straight from the declared ops via `record_cmd_event`. `tugutil file` receipts take a third path, `mint_receipt_rows`, which already writes `hunk` spans. This plan touches the first two paths: the live path's promotion set narrows ([P02]) and gains span minting ([P05]); the replay path skips `Restore` ops ([P01]).

#### Where liveness lives, and who can see it {#liveness-topology}

`sessions.state` (`'live'` on spawn, flipped on close) is a **per-instance `sessions.db`** table; `file_events` is the **machine-global `changes.db`** ([D112]). Compose reads both through one connection — `file_events_for_project` LEFT JOINs `sessions` onto `changes.file_events` and resolves `owner_live: s.state == 'live'`, with a JOIN miss (evicted or foreign-instance session) reading as not-live (`session_ledger.rs:5110-5145`). The sync engine (`tugchanges-core::changes::resolve_changes`) opens `changes.db` for rows and *already* separately opens `sessions.db` for the known-session test (`changes.rs:203-209`); #step-6 extends that second connection into a session-state lookup for the contention call. The compose-side blind spot for foreign-instance sessions is pre-existing (it drives the orphan lift today); [Q01]/Risk R02 covers why inheriting it for retirement is acceptable.

#### Why the retired claim is `Hunks { placed: ∅, unplaced: false }` and not a new variant {#why-empty-hunks}

`Claim::covers(id)` on that value is `false` for every id and `intersects` finds nothing, so the owner drops out of `shared` and `contested` with zero changes to the verdict plumbing. `hunks_of` returns `[]`, which `defaultElection` (`tugdeck/src/lib/hunk-election.ts`) reads as whole-file — but a retired owner is dead, so no deck is electing on its behalf, and its own entry (if a card ever re-opens the session) re-runs contention fresh. A dedicated `Claim::Retired` variant would force every `match` in two crates to grow an arm for a state indistinguishable in effect; the empty-placed encoding is the state.

#### The incident, replayed under this plan {#incident-replay}

`git checkout 69ed16ce2 -- tugdeck` parses to `DeclaredKind::Restore` on `tugdeck` → contributes to neither promotion set → the four files' delta rows record as `origin: "bash"` hints → no proof, no contention; the files never show SHARED (Layer 1 alone suffices). Had the rows somehow been minted anyway: they'd carry hunk spans ([P05]) whose ids die at `git checkout HEAD -- tugdeck`; the session closes; on the next compose the owner is dead with nothing placing → retired ([P03]; Layers 3+4 suffice independently). Today's session f90e6740 shows four solo files either way.

That is the replay of the *incident*, not of the ledger. The four rows already written are span-less, so their dead owner decodes to zero anchors, which Spec S03's first row reads as `Claim::Whole` for live and dead owners alike ([P05]'s no-retroactive-falsifiability posture, stated once more where it bites): Layers 3 and 4 never touch them. Those rows retire on a commit cut, a Disclaim, a Sever — or on [P06]'s release gesture, which is the only one of the five that costs a click instead of a database excavation. #step-7 is therefore the fix for the state on disk today, and #step-1/#step-2 are the fix for tomorrow's.

---

### Specification {#specification}

**Spec S01: `DeclaredKind::Restore` grammar coverage** {#s01-restore-grammar}

| Command shape | Today | After |
|---|---|---|
| `git restore <paths>` | `EditInPlace` per operand | `Restore` per operand |
| `git restore --staged <paths>` | `EditInPlace` (flags skipped by `operands(rest, cwd, &["-"])`) | `Restore` |
| `git checkout <rev> -- <paths>` | `EditInPlace` per post-`--` operand | `Restore` |
| `git checkout -- <paths>` | `EditInPlace` | `Restore` |
| `git checkout <branch>` (no `--`) | `NoFileOps` | unchanged |
| `git stash` (any subcommand) | `NoFileOps` | unchanged |

`op_for_declared_kind(Restore) = "modified"`. `mint_replayed_cmd_rows` skips `Restore` ops. `DeclaredPromotions` construction ignores them. Existing `shell_ops` tests `git_restore_and_checkout_pathspecs_are_in_place_edits` (`shell_ops.rs:1055`) are rewritten to assert the `Restore` kind.

**Spec S02: anchor JSON, `whole` kind** {#s02-whole-anchor-json}

New shape (written from #step-4 on, when the tool input carries the full text — `Write.content`, `NotebookEdit.new_source`):

```json
{
  "file_hash": "9f2c…",
  "line_hashes": ["b41a…", "…"],
  "added_lines": 41,
  "added_head": "first distinctive lines joined…"
}
```

- `file_hash` — `content_hash` (the one rule, `hunks.rs`) of the entire written text.
- `line_hashes` / `added_lines` / `added_head` — exactly the `edit_anchor` fields computed over the full text as an insert (every line "added"), same distinctiveness rule, same `ANCHOR_LINE_HASH_CAP` (32), same `SPAN_HEAD_CAP` (200). Built by a new `anchors::whole_anchor(content: &str) -> serde_json::Value` that delegates to the same internals.
- Legacy `{}` still written for content-less fallbacks (`SPANS_PER_EVENT_CAP` overflow, malformed edit input) and decoded forever.

Decode order for kind `whole`: `file_hash` present → `Anchor::WholeFile { file_hash, line_hashes, added_head }`; else → `Anchor::Whole`. (Kinds `insert`/`replace`/`hunk` unchanged from the fixup.)

**Spec S03: claim semantics with liveness** {#s03-claim-semantics-liveness}

`classify_contention(hunks, owners, current_file_hash)`; per owner, per anchor:

| Anchor | Live owner (unchanged from today) | Dead owner |
|---|---|---|
| none at all | `Claim::Whole` | `Claim::Whole` (no evidence ≠ falsified evidence) |
| `Whole` (claim / legacy / cap) | `Claim::Whole` | `Claim::Whole` ([Q02]) |
| `WholeFile`, hash matches `current_file_hash` | `Claim::Whole` | `Claim::Whole` |
| `WholeFile`, hash mismatch (or hash uncomputable) | `Claim::Whole` | place `line_hashes` as AddedLines; matches → `placed`; none → contributes nothing |
| `Hunk` live id | placed | placed |
| `Hunk` drifted id | `unplaced = true` | contributes nothing |
| `AddedLines`/`Content`, ≥1 match | placed (all matches) | placed (all matches) |
| `AddedLines`/`Content`, no match | `unplaced = true` | contributes nothing |

`current_file_hash = None` (file unreadable) makes the `WholeFile` mismatch arm unreachable — it behaves as hash-match (widen; the blessed failure direction). A dead owner accumulating `Hunks { placed: ∅, unplaced: false }` covers/intersects nothing: retired. Note the deliberate asymmetry with the fixup's live-owner table: only the two `unplaced`-setting arms and the `WholeFile` mismatch arm read `live`.

**Spec S04: `shared_with` wire shape** {#s04-shared-with}

On `ChangesetFile` (Rust struct in `tugrust/crates/tugcast/src/feeds/changeset.rs`, TS mirror + guard in `tugdeck/src/lib/changeset-types.ts`):

```ts
shared_with?: { id: string; name: string; live: boolean }[];
```

Filled only when `shared == true`, listing each *other* proof owner whose claim survived retirement for this path, ordered by name. Absent/empty on non-shared files and from pre-plan servers; the deck guard accepts absent.

---

### Definitive Symbol Inventory {#symbol-inventory}

| Symbol | Kind | Location | Change |
|--------|------|----------|--------|
| `DeclaredKind::Restore` | enum variant | `tugchanges-core/src/shell_ops.rs` | new ([P01], Spec S01) |
| `git_ops` `"restore"` / `"checkout"` arms | fn arms | `shell_ops.rs:828-848` | emit `Restore` |
| `op_for_declared_kind` | fn | `tugcast/src/feeds/attribution.rs:695` | `Restore → "modified"` arm |
| `DeclaredPromotions { exact, subtree }` | struct | `attribution.rs` | new ([P02]); replaces the bare `HashSet` + free `declared_covers` |
| `OpenBracket::into_delta_rows` | fn | `attribution.rs:507` | takes `&DeclaredPromotions` |
| `mint_replayed_cmd_rows` | fn | `tugcast/src/feeds/agent_bridge.rs:1171` | skip `Restore` ops |
| Bash-close promotion + span mint | block | `agent_bridge.rs:~2490-2545` | build `DeclaredPromotions`; diff + `hunk_spans` for `cmd` rows ([P05]) |
| `anchors::whole_anchor(content) -> Value` | fn | `tugchanges-core/src/anchors.rs` | new ([P04], Spec S02) |
| `whole_span()` / new `whole_span_for(content)` | fn | `attribution.rs:216` | content-bearing variant; `spans_for_tool_input` routes `Write`/`NotebookEdit` through it |
| `Anchor::WholeFile { file_hash, line_hashes, added_head }` | enum variant | `tugchanges-core/src/contention.rs` | new decode target (Spec S02) |
| `OwnerAnchors.live: bool` | field | `contention.rs:144` | new ([P03]) |
| `classify_contention(…, current_file_hash: Option<&str>)` | fn | `contention.rs:249` | new param (Spec S03) |
| `claim_for` | fn | `contention.rs:311` | liveness-aware per Spec S03 |
| `contention_verdict` | fn | `tugcast/src/feeds/changeset.rs:660` | supply `live` per owner + file hash; needs a `live_ids: &HashSet<String>` param from compose |
| `compose_snapshot` contended-path loop | block | `changeset.rs:~330-425` | build live-owner set from `OwnerAgg.live`; fill `shared_with` ([P06]) |
| `ChangesetFile.shared_with` | field | `changeset.rs` + `tugdeck/src/lib/changeset-types.ts` | new (Spec S04) |
| `paths_contend` | fn | `tugchanges-core/src/changes.rs:294` | supply `live` + file hash; needs session states |
| `ledger::session_states(conn, ids) -> HashMap<String, bool>` | fn | `tugchanges-core/src/ledger.rs` | new: `SELECT session_id, state FROM sessions WHERE session_id IN (…)` against the **sessions.db** connection; missing id ⇒ dead |
| `resolve_changes` / `compute_changes` | fn | `changes.rs` | thread the sessions.db connection down to `paths_contend` |
| `sharedWithTitle` / `sharedIsReleasable` | fn | `tugdeck/src/components/tugways/tug-changes-list.tsx` | new exported pure helpers — the step's whole logic surface ([P06]) |
| SHARED badge + co-owner display | tsx | `tugdeck/src/components/tugways/tug-changes-list.tsx:694` | render `shared_with` via those helpers ([P06]) |

---

### State Zone Mapping (tugdeck) {#state-zone-mapping}

| New state | Zone | Law |
|---|---|---|
| `shared_with` on files | Server snapshot via the existing changeset store (`useSyncExternalStore` path, unchanged) | [L02] |
| Co-owner reveal on badge hover | CSS only (`title` attr / CSS hover block) | [L06] |
| Release gesture | Existing `changeset-verb-store` `changeset_claim` action; no new store | [L02] |

No new React state anywhere; no new effects.

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | Where |
|----------|---------|-------|
| **Unit** | Restore grammar (Spec S01); promotion split ([P02]); `whole_anchor` construction; Spec S03 liveness table row by row | `shell_ops.rs`, `attribution.rs`, `anchors.rs`, `contention.rs` |
| **Integration** | Bracket close over a real `git checkout <rev> -- <dir>`; span minting on promoted rows; compose retirement + `shared_with`; sync-engine retirement with seeded session states | `agent_bridge.rs`, `changeset.rs` (tokio), `changes.rs` |
| **Drift prevention** | Existing contention/compose/changes tests updated: constructors gain `live: true` (behavior-identical), then dedicated dead-owner cases assert the delta | all three |

Conventions carried from the fixup: contention fixtures build anchors via production constructors (`edit_anchor` / new `whole_anchor` / `spans_for_tool_input`), never hand-minted JSON, except where a test deliberately models the legacy shape. The seeded-`sessions.db` helpers in `changes.rs` tests already write `sessions` rows — extend the helper with a `state` column value.

Deck-side, the rule that decides the shape: `tug-changes-list.test.ts` is pure-logic `bun:test` over *exported helpers* with typed fixtures and no DOM anywhere, so anything #step-7 wants to assert has to live in a helper first (`sharedWithTitle`, `sharedIsReleasable`). No render test, no app-test for the badge — the JSX left over is a `title` attribute and an already-wired affordance, and `just app-test-changed` decides the selection.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | shell-ops: Restore kind | done | `da0b44831` |
| #step-2 | attribution: promotion split + Restore exclusion | done | `d19468018` |
| #step-3 | contention: WholeFile decode + dead-owner retirement | done | `6dc8a8b69` |
| #step-4 | writers: whole anchors with content, cmd rows with hunk spans | done | `62a986f7d` |
| #step-5 | compose: liveness into contention + shared_with | done | `44e9d0709` |
| #step-6 | sync engine: liveness into paths_contend | done | `a20b892d0` |
| #step-7 | deck: SHARED co-owners + release gesture | done | `7d701f1f4` |
| #step-8 | integration checkpoint | done | (verification only) |

#### Step 1: shell-ops — Restore kind {#step-1}

**Commit:** `tugchanges-core(shell-ops): classify git restore/checkout pathspecs as Restore, not edits`

**References:** [P01] restore not proof, Spec S01, (#promotion-pipeline, #symbol-inventory)

**Tasks:**
- [ ] Add `DeclaredKind::Restore` (`shell_ops.rs`); switch the `"restore"` and `"checkout"` arms of `git_ops` (`shell_ops.rs:828-848`) to emit it. Module doc gains a sentence: restores are declared (gate-visible) but are recorded content, not authorship.
- [ ] `op_for_declared_kind` (`tugcast/src/feeds/attribution.rs:695`): add `DeclaredKind::Restore => "modified"` — same commit, or tugcast's exhaustive match breaks the workspace build.
- [ ] `mint_replayed_cmd_rows` (`agent_bridge.rs:1171`): `continue` on `Restore` ops before minting.

**Tests:**
- [ ] Rewrite `git_restore_and_checkout_pathspecs_are_in_place_edits` (`shell_ops.rs:1055`) → asserts `Restore` kind for `git restore src/a.ts` and `git checkout -- src/a.ts src/b.ts`; `git checkout <sha> -- dir` yields `Restore` on the dir; `git checkout main` stays `NoFileOps`.
- [ ] Replay minting: a `PendingCmd` mixing a `Move` and a `Restore` mints rows for the move's two names only.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core -p tugcast`

#### Step 2: attribution — promotion split + Restore exclusion {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(attribution): promote bracket rows by exact path for edits, subtree only for lifecycle`

**References:** [P02] promotion narrowing, [P01], Risk R01 of changes-rework (unchanged bracket doctrine), (#promotion-pipeline, #incident-replay)

**Tasks:**
- [ ] Add `DeclaredPromotions { exact: HashSet<PathBuf>, subtree: HashSet<PathBuf> }` with `covers(&self, path) -> bool` per [P02]; delete the free `declared_covers`.
- [ ] `into_delta_rows` takes `&DeclaredPromotions`; turn-bracket caller passes `&DeclaredPromotions::default()`.
- [ ] Bash-close caller (`agent_bridge.rs:~2512`): partition `cmd.ops` — `Remove`/`Move`/`Copy` → subtree, `EditInPlace`/`WriteTarget`/`Touch` → exact, `Restore` → neither — canonicalizing via the existing `canonical_declared_paths`.

**Tests:**
- [ ] The incident gate: a bracket whose declared ops are `[Restore("<root>/tugdeck")]` with delta files beneath `tugdeck/` yields all-`bash` rows.
- [ ] `rm -rf dir/` shape: `Remove("dir")` + delta files beneath → `cmd` rows (equal-or-beneath survives for lifecycle).
- [ ] Edit-exact: `EditInPlace("dir")` + delta file beneath → `bash`; `EditInPlace("dir/a.ts")` + delta `dir/a.ts` → `cmd`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

#### Step 3: contention — WholeFile decode + dead-owner retirement {#step-3}

**Depends on:** #step-1

**Commit:** `tugchanges-core(contention): dead owners contend only through placing evidence`

**References:** [P03] dead-owner retirement, [P04] WholeFile anchor, [Q02], Spec S02, Spec S03, Risk R01, Risk R03, (#why-empty-hunks, #liveness-topology)

**Tasks:**
- [ ] Add `Anchor::WholeFile { file_hash: String, line_hashes: Vec<String>, added_head: String }`; extend `Anchor::from_span`'s `whole` handling per Spec S02 (`file_hash` present → `WholeFile`, else `Whole`).
- [ ] `OwnerAnchors` gains `live: bool`; update every constructor in-crate and both callers (`changes.rs:338`, `changeset.rs:705`) with `live: true` — behavior-identical in this commit; real liveness lands in #step-5/#step-6.
- [ ] `classify_contention` gains `current_file_hash: Option<&str>`; both callers pass `None` for now.
- [ ] `claim_for` implements Spec S03: thread `live` and the hash; dead + fail-to-place contributes nothing (no `unplaced`); dead `WholeFile` mismatch places `line_hashes` via the existing AddedLines hash-then-containment path.
- [ ] Rewrite the module doc's conservative-direction section: widening presumes a live owner; death removes the presumption; unfalsifiable anchors keep contending ([Q02]).

**Tests:**
- [ ] Spec S03 row by row for dead owners: drifted `Hunk` retires; non-placing `AddedLines` retires; placing `AddedLines` still contends; bare `Whole` still contends; `WholeFile` hash-match contends as `Whole`; hash-mismatch-with-placing-lines contends on those hunks; hash-mismatch-nothing-places retires; `current_file_hash: None` widens.
- [ ] The headline: dead owner all-unplaceable vs live placing owner → `shared == false`, empty `contested`; identical fixture with `live: true` → `shared == true` (the fixup's behavior, pinned as the live floor).
- [ ] Mixed: dead owner with one placing + one non-placing anchor → contends on the placed hunk only.
- [ ] Decode: `whole` + `file_hash` → `WholeFile`; `whole` bare `{}` → `Whole`; `whole` with unknown extra fields but no `file_hash` → `Whole`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core` (and `-p tugcast` compiles — caller constructors updated)

#### Step 4: writers — whole anchors with content, cmd rows with hunk spans {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugcast(attribution): record Write content identity and promoted-row hunk evidence`

**References:** [P04] WholeFile anchor, [P05] cmd span minting, Spec S02, Risk R03 (decoder landed in #step-3), Risk R04, (#promotion-pipeline)

**Tasks:**
- [ ] `anchors::whole_anchor(content: &str) -> serde_json::Value` in `tugchanges-core/src/anchors.rs`, sharing `edit_anchor`'s internals (distinctiveness, caps) plus `file_hash` over the full text.
- [ ] `attribution.rs`: `whole_span_for(content: &str)` wrapping it; `spans_for_tool_input` routes `Write` (input `content`) and `NotebookEdit` (input `new_source`) through it, falling back to bare `whole_span()` when the field is absent; cap/fallback sites keep `whole_span()`.
- [ ] Bash close (`agent_bridge.rs`): after `into_delta_rows`, split rows by `origin == CMD_ORIGIN`; for each `cmd` row, `fetch_git_diff(repo_root, &[path])` → `parse_hunks` → `hunk_spans(ids)` → `record_file_event_with_spans`; empty/failed diff → `record_file_event` (span-less). Non-`cmd` rows record exactly as today.

**Tests:**
- [ ] `spans_for_tool_input("Write", {file_path, content})` → one `whole` span whose anchor carries `file_hash == content_hash(content)` and the content's distinctive line hashes; content-less `Write` input → bare `{}`.
- [ ] `MultiEdit` past `SPANS_PER_EVENT_CAP` still collapses to bare `whole`.
- [ ] Bash-close integration (existing bracket-test harness in `agent_bridge.rs` tests, e.g. around line 3677): a promoted row lands with `hunk` spans naming the path's diff hunks; a `bash` row lands span-less.
- [ ] **Cross-spelling id agreement**, the assumption Layer 3's whole payoff rests on: ids minted through the async spelling (`fetch_git_diff` + `parse_hunks`) place against ids the sync engine reads through `hunks::file_hunks` (`std::process::Command`) over the same file. Both carry `HUNK_DIFF_FLAGS` by Spec S06's contract, but this is the first *writer* to depend on it, so pin it rather than cite it.
- [ ] A promoted row on an untracked (created) file records span-less — `fetch_git_diff` yields nothing there, by the reasoning in #non-goals.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugchanges-core`

#### Step 5: compose — liveness into contention + shared_with {#step-5}

**Depends on:** #step-3

**Commit:** `tugcast(changeset): retire dead non-placing owners from contention; name co-owners on the wire`

**References:** [P03], [P06] shared_with, Spec S03, Spec S04, [Q01], Risk R02, (#liveness-topology, #incident-replay)

**Tasks:**
- [ ] `compose_snapshot`: build `live_ids: HashSet<String>` from `owners` (`OwnerAgg.live`), plus `dead_ids` for the ids resolved as not-live; pass both into `contention_verdict`, which constructs `OwnerAnchors { live: !dead_ids.contains(id), .. }` — **an id in neither set reads as live** per [P03]'s failure direction, so the resolution gap can only over-warn. `proof_ids ⊆ owners.keys()` holds by construction (a path becomes contended through the very rows the owner aggregation was built from); assert it with a `debug_assert!` at the verdict call so a future change to either side surfaces there rather than as a silent retirement. `contention_verdict` also computes `current_file_hash` (`std::fs::read(repo_root.join(path))` → `content_hash`; unreadable → `None`).
- [ ] `ChangesetFile` gains `shared_with: Option<Vec<SharedOwner>>` (`SharedOwner { id, name, live }`, serde as Spec S04); the contended-path fill loop populates it for each owner from the verdict's surviving co-owners, using `OwnerAgg.display_name`/`live`; `None` elsewhere.
- [ ] Existing serde tests / snapshot expectations in `changeset.rs` updated for the new optional field.

**Tests:**
- [ ] Tokio compose: live session A places in hunk 1; dead session B's spans place nowhere (fixture overwrites B's content) → A's file `shared == false`, no `shared_with`.
- [ ] Same with B live → `shared == true`, A's `shared_with == [B]` with `live: false→true` respectively.
- [ ] Dead B placing (content intact) → still `shared == true` (orphan-consistent), `shared_with == [{B, live:false}]`.
- [ ] An owner id absent from both liveness sets reads as live: same fixture as the headline with B withheld from `dead_ids` → `shared == true` (the over-warning direction, never retirement).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

#### Step 6: sync engine — liveness into paths_contend {#step-6}

**Depends on:** #step-3

**Commit:** `tugchanges-core(changes): read session states for hunk-aware contention`

**References:** [P03], Spec S03, [Q01], Risk R02, (#liveness-topology)

**Tasks:**
- [ ] `ledger::session_states(sessions_conn: &Connection, ids: &[&str]) -> HashMap<String, bool>` (`state == 'live'`; absent id ⇒ dead). Runs against the **sessions.db** connection — note in the doc comment that this is the per-instance db and cite [Q01].
- [ ] `resolve_changes` keeps the sessions.db connection (today it's dropped after `session_exists`) and threads it — as `Option<&Connection>` — through `compute_changes` into `paths_contend`; `None` (no sessions.db) ⇒ every owner `live: true`, today's exact behavior.
- [ ] `paths_contend`: query states for `session` + `foreign`, build `OwnerAnchors { live }`, compute `current_file_hash` (read + `content_hash`, `None` on failure), pass both to `classify_contention`. The asking session itself is always `live: true` (it is running this command).

**Tests:**
- [ ] Extend the seeded-db test helper (`changes.rs` tests, `init` around line 1082) to write `sessions` rows with a `state`; dead co-owner with non-placing spans → `mine.shared == false`; same state `'live'` → `shared == true`.
- [ ] No sessions.db present → behavior identical to today (all-live), pinned.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core`

#### Step 7: deck — SHARED co-owners + release gesture {#step-7}

**Depends on:** #step-5

**Commit:** `tugdeck(changes-list): SHARED badge names its co-owners; dead-owner rows offer Claim`

**References:** [P06], Spec S04, (#state-zone-mapping); tuglaws [L02]/[L06]; `feedback_use_tug_components` (no hand-rolled UI)

**Tasks:**
- [ ] `changeset-types.ts`: add optional `shared_with` to `ChangesetFile` + guard (absent-tolerant).
- [ ] The two decisions this step adds are **pure functions exported from `tug-changes-list.tsx`**, alongside `diffablePathsOf` / `entryDiffDescriptor` / `fileExpandKey`: `sharedWithTitle(file): string | null` (the co-owner sentence, `null` when there is nothing to say) and `sharedIsReleasable(file): boolean` (every `shared_with` entry `live: false`). The JSX consumes them and holds no logic of its own — which is what makes the step testable in this file's established `bun:test` style (no DOM, typed fixtures, exported helpers).
- [ ] `tug-changes-list.tsx` (`:694`): the shared badge gains a `title` naming co-owners (`shared with <name>[, …]`, dead ones suffixed `(closed)`); the expanded file block renders the same line as a provenance row, styled like the existing orphan citation chip (reuse its classes/pattern at `:539`).
- [ ] When every `shared_with` entry has `live: false`, surface the existing per-file Claim affordance (the [D120] wiring already present for orphan rows at `:1040`) on the shared row, labeled for release; action dispatches the existing `changeset_claim` through `changeset-verb-store`.
- [ ] `cd tugdeck && bunx vite build` before declaring done (prod-bundle rule).

**Tests:**
- [ ] `tug-changes-list.test.ts` (pure-logic `bun:test` over exported helpers, the file's existing shape): `sharedWithTitle` over a `shared_with` fixture — one co-owner, several, a dead one suffixed `(closed)`, absent field → `null`; `sharedIsReleasable` true for all-dead, false with any live entry and false when the field is absent.
- [ ] `changeset-types.test.ts`: the guard accepts a file with no `shared_with` (pre-plan server) and one carrying it.
- [ ] No render test and no app-test for the badge: the logic is in the helpers above, and the JSX is a `title` attribute plus an already-wired affordance. `just app-test-changed` decides whether the deck edit pulls anything in.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` green; `just app-test-changed` selection green

#### Step 8: integration checkpoint {#step-8}

**Depends on:** #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #incident-replay)

**Tasks:**
- [ ] `grep -rn "declared_covers\|into_delta_rows\|OwnerAnchors\|classify_contention" tugrust/crates` — confirm no stale caller of the old signatures.
- [ ] Full workspace run; derived app-test selection for the working diff.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** File tracking that self-corrects: restores never mint authorship, promotions are scoped to what a command provably edited, new proof rows carry falsifiable evidence, ghost claims retire the moment their owner is dead and their content is gone, and the SHARED badge explains itself and offers the way out.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Spec S01/S02/S03 pinned by unit tests with production-built fixtures.
- [x] The incident replay (#incident-replay) passes at both the attribution layer and both contention readers.
- [x] `cd tugrust && cargo nextest run` fully green (2366 passed, up from a 2337 baseline); `bunx vite build` green; the derived app-test selection over the whole dash diff green (11/11 files, 12/12 tests).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Machine-global session presence for cross-instance liveness ([Q01]).
- [ ] The fixup plan's still-open wire signal for "evidence that failed to place" (live all-unplaceable owners still default-elect whole-file).
- [ ] Content fallback for drifted `hunk`-kind anchors (would sharpen [P05]-minted spans for *live* owners).
- [ ] Re-run the live-ledger placement census after this ships (baseline in the fixup plan's #live-ledger-shape).

| Checkpoint | Verification |
|------------|--------------|
| Grammar + promotion | `cargo nextest run -p tugchanges-core -p tugcast` |
| Retirement, both readers | `cargo nextest run -p tugchanges-core -p tugcast` |
| Whole workspace | `cd tugrust && cargo nextest run` |
| Deck surface | `bunx vite build` + `just app-test-changed` |
