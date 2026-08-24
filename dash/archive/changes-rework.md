## Changes Rework — Batch Claim, Disclaim, Row Polish, and Hunk-Level Changes {#changes-rework}

**Purpose:** Expand the Changes system in three parts: (1) tighten the claim verb into a true atomic batch, add its inverse (*disclaim*), and polish the row affordances (icons, metadata divider); (2) teach the changes engine to stage and land *portions* of files (hunk-level selection over `git apply --cached`); (3) capture sub-file edit evidence (spans) and make SHARED contention hunk-aware, so disjoint edits to one file by two sessions no longer contend.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (four separate dash passes; see #strategy) |
| Last updated | 2026-08-04 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Changes system (tuglaws/tracking-changes.md, [D112]) tracks per-session file attribution in the machine-global `changes.db` and lands work through `tugutil`/tugcast verbs. Three pressures motivate this plan. First, the claim verb's interface is asymmetric and slightly dishonest: `CLAIM ALL` already sends one batched wire request, but the server loops N independent journaled inserts, so a partial failure leaves a half-claimed batch surfaced only as a "shortfall" error; and there is no way to *remove* a file from a session's claims at all — the only ownership-removal primitive (`sever_file_ownership_except`) fires solely as a side effect of someone else claiming. Second, small row-rendering inconsistencies: the vertical divider before the attribution text is a CSS `border-left` that only the provenance span carries, so `shared`-badge-only and hint-only rows render without it; and the claim icon is `CornerUpLeft` where the desired vocabulary is `corner-down-left` (claim) / `corner-up-right` (disclaim). Third — the big one — the engine is strictly whole-file: staging is `git add -- <files>` by written contract (`tugchanges-core/src/commit.rs`), SHARED is a pure path-string match over proof rows, and the ledger records no sub-file granularity anywhere. Most cross-session overlaps are file-level coincidences (two sessions touching disjoint parts of one file), so file-level SHARED over-warns and over-excludes. Hunk-level staging plus hunk-aware contention cuts SHARED down to true overlaps while keeping file-level support for the overlaps that are real.

No interactivity is needed for any of this: `git add -p` is a prompting UI over patch surgery, and the non-interactive equivalent — filter the diff to selected hunks, feed it to `git apply --cached` — is fully scriptable. The shell supplement this plan ships is therefore *steering and verbs*, not a PTY ([P13], upholding [D111] "No TTY emulator").

#### Strategy {#strategy}

- Four parts, four dash passes, one plan. Each part ends at an integration-checkpoint step and is independently landable: **M01** (steps 1–5) claim/disclaim/polish; **M02** (steps 6–11) hunk-level selection and landing; **M02A** (steps 11a–11g) closing the loop on M02's audit findings; **M03** (steps 12–16) span capture and hunk-aware SHARED.
- **M02A is a correction pass, not new capability.** A post-landing audit of M01+M02 (see #m02-audit) found the hunk-election UI inert end-to-end — the election is written to the ledger but stripped on the way back out — plus a missing guard on the invariant the whole feature rests on (wire hunk ids equal engine hunk ids), an [L26] mount-identity violation, and a set of smaller coherence defects. M02A lands before M03 because M03's contention verdict consumes the same hunk ids and adds two more readers of "this file's current hunks"; shipping M03 on an unguarded id contract multiplies the drift surface rather than fixing it.
- Mechanics before attribution: M02 ships the hunk model, partial staging, and the hunk-picker UI with *manual* election (which alone softens SHARED pain — a shared file stops being all-or-nothing); M03 then makes the engine *know* whose hunks are whose.
- Respect the existing doctrine at every step: proof decides, correlation suggests; degradation is always toward `unattributed` (visible, never falsely claimed); a dirty file is never invisible; spans **annotate**, `git diff` **decides** — the same two-layer split one level down.
- Avoid the `changes.db` schema gate until it is truly needed: M01 and M02 are schema-free (new journal records, the free-form `changeset_drafts.selection` TEXT, additive wire fields). Only M03 bumps `CHANGES_SCHEMA_VERSION` to 2, with a purely additive new table.
- One implementation per rule: hunk identity is computed in Rust only and served to the deck ([P06]); the hunk-overlap decision lives in tugchanges-core and is consumed by both readers ([P14]) so the two SHARED implementations cannot fork.

#### Success Criteria (Measurable) {#success-criteria}

- A `CLAIM ALL` of N files writes one `fe_batch` journal record and either claims the whole batch or none of it; `changeset_claim_ok.claimed` is the batch size *after* `repo_relative_key` mapping (outside-repo paths are skipped-and-warned before the batch, today's behavior) or `0` (Rust unit test on the ledger + supervisor test).
- A per-row Disclaim on an attributed file removes it from the session's changeset on the next aggregate recompute; the file reappears as `unattributed` (or the other claimant becomes sole owner if it was shared). Verified by a `tugutil changes disclaim` CLI round trip and an app-test.
- Every changes-list row with any trailing metadata (badge, provenance, or hint) renders exactly one leading divider; rows with none render none (visual check + app-test DOM assertion on the wrapper class).
- Claim renders `corner-down-left`, Disclaim renders `corner-up-right` (DOM assertion on the lucide class names).
- Landing a two-hunk file with one hunk elected commits exactly that hunk's lines (`git show HEAD` contains it, working tree still carries the other) and the receipt's `left_behind` machinery still accounts for every dirty path (Rust integration test in `commit.rs`).
- With spans captured, two sessions editing disjoint regions of one file show **no** SHARED badge and each session's default landing takes its own hunks; two sessions editing the same region still show SHARED (Rust test seeding two sessions' span rows).
- `cargo nextest run` green, `bunx vite build` green, `just app-test-changed` green at each part's integration checkpoint.

M02A adds:

- A hunk election written from the Changes shade survives the server round trip: after clicking a hunk's checkbox, the box **stays** in the state the user left it and the row shows `N of M hunks` (hand-verified in the running app, since no app-test can reach a session-entry row — see #session-entry-wall; plus a Rust unit test asserting `hunks` survives the draft projection, which is the mechanism that was broken).
- Landing a partial file from the shade produces a commit containing only the elected hunks (hand-verified end-to-end in the running app).
- A Rust test crossing the wire/engine boundary asserts the hunk ids the deck receives are byte-identical to the ids the landing engine accepts, for the same repo state (`feeds/git.rs`).
- The expanded diff of a file that crosses the one-hunk/two-hunk boundary while its row is open keeps its collapsed-hunk state and scroll position — no unmount ([L26]). Verified by hand (HV7) rather than by app-test: the component swap only happens on a session-entry row, which the harness cannot reach (#session-entry-wall).
- A collapsed hunk band stays attached to *its own hunk* when the file gains a hunk above it, not to the slot index ([P21]) — this one **is** app-testable on an unattributed row.
- An election whose ids have all drifted out of the file renders as `stale election`, never as a silent whole-file landing that the engine then refuses ([P18]).
- `cargo nextest run` green, `bun test` green, `bunx vite build` green, `just app-test-changed` green.

#### Scope {#scope}

1. Atomic batch claim (one journal record, all-or-nothing).
2. Disclaim verb end-to-end: journal record, ledger delete, supervisor CONTROL verb, HTTP bridge, `tugutil changes disclaim`, deck store/controller/row affordance.
3. Icon swap (claim → `CornerDownLeft`, disclaim → `CornerUpRight`) and the single-divider metadata wrapper.
4. Hunk model in tugchanges-core: parse, stable identity, filtered-patch builder.
5. Hunk-level election in the draft selection, per-hunk checkboxes in the inline diff, partial staging in `commit`, wire plumbing (`changeset_commit.hunks`), `tugutil commit --hunks`.
6. `tugutil file stage` (non-interactive index staging verb) and shell-route steering for interactive `-p` git invocations.
7. `changes.file_event_spans` table (schema v2), span capture for exact tools and `tugutil file edit` receipts, hunk-aware SHARED in both readers, contested-hunk UI.
8. **(M02A)** Opaque pass-through for the draft selection so `hunks` survives the wire projection; one canonical diff spelling for hunk identity plus the cross-boundary id test; the [L26] diff-body unification and the hunk-id rekey of collapse state; election display reconciliation, including an honest rendering of a fully-stale election; diff-block CSS de-duplication; a disclaim storage-form spike.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No PTY, terminal emulator, or interactive shell tunnel — [D111] stands; the shell supplement is steering + verbs only ([P13]).
- No carry-forward re-minting of ledger rows for the un-landed remainder of a partial commit — deferred with rationale ([Q02], [P08]).
- No span capture for `bash`/`turn` bracket rows or parsed `cmd` rows — correlation evidence stays whole-file ([Q03]).
- No change to the dash-lane `tugutil dash join` path (`tugdash-core/src/ops.rs` `commit_worktree_dirt` stays `git add -A`); hunk election is a main-lane landing feature.
- ~~No "Disclaim all" bulk button~~ — **superseded**: M01 shipped one at the user's request (`tug-changes-list.tsx`, `data-testid="tug-changes-list-disclaim-all"`). Recorded here rather than deleted so the change of mind is visible.
- No line-level (sub-hunk) staging; hunks (with git's own splitting granularity) are the unit.

#### Dependencies / Prerequisites {#dependencies}

- M02 steps depend on M01 only for repo state (no functional coupling); M02A depends on M02 having landed (it corrects it); M03 depends on M02's hunk model (`tugchanges-core::hunks`), the hunk-id spec (Spec S02), **and M02A's canonical diff spelling ([P16])** — M03's verdict fn needs "this file's current hunks" in two more readers, and it must use the same spelling or the ids it emits as `own_hunks`/`contested_hunks` will not match the ids the deck's checkboxes are keyed by.
- The implementing session must rebuild all `tug*` binaries after M03's schema bump — an older binary on the machine loses shared-table write access by design (see #rollout).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (`-D warnings` workspace-wide).
- `changes.db` is machine-global with concurrent writers at potentially different binary versions; the `changes.*` tables are exempt from drift-rebuild and governed by the `user_version` gate (`session_ledger.rs::bootstrap_changes_schema`). Schema changes go through `CHANGES_SCHEMA_VERSION` + `CHANGES_MIGRATIONS` only.
- Never open live ledger DBs with a foreign sqlite3; use `just db-inspect`.
- Frontend laws: [L02] external state via `useSyncExternalStore` only; [L06] appearance via CSS/DOM; verify tugdeck changes with `bunx vite build`; app-tests via `just app-test-changed`.
- All git operations shell out (`tugchanges-core/src/git.rs::git_output/git_stdout`); no git2/gix anywhere — keep it that way.

#### Assumptions {#assumptions}

- Single-machine deployment: the schema-v2 lockout of older binaries is a rebuild, not a rollout problem.
- The index is clean under normal Tug operation (only Tug lands; raw git is read-only spelunking by policy), so the partial-staging index-clean precondition ([P07]) refuses rarely and loudly.
- The Session card commit button's existing `--paths`-style bypass continues to define the card lane; hunk election rides the same `changeset_commit` verb additively.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Hunk identity normalization (DECIDED — see [P06]) {#q01-hunk-identity}

**Question:** What makes a hunk's id stable across re-diffs and between server and deck?

**Why it matters:** Draft selections and span anchors reference hunks by id; an unstable id silently orphans elections, and a deck-side re-derivation could disagree with Rust.

**Resolution:** DECIDED (see [P06]): the id is a content hash over the hunk's body lines only (the `-`/`+`/context lines, byte-exact, excluding the `@@` header), computed in Rust and served to the deck. Line-number drift from *other* hunks changing does not move the id; any change to the hunk's own content does — which is exactly when a stale election must be refused.

#### [Q02] Carry-forward rows for a partial commit's remainder (DEFERRED) {#q02-carry-forward}

**Question:** A partial commit spends every ledger row on the path (liveness is per-path `git log -1`), so the un-landed remainder's evidence dies — should the engine re-mint rows for the remainder's owner at land time?

**Why it matters:** After session A lands its hunks of a shared file, session B's surviving hunks degrade to `unattributed`.

**Resolution:** DEFERRED ([P08]): degradation toward `unattributed` is the doctrine's blessed failure direction (visible, never falsely claimed), and B's hunks remain electable by hand. Revisit after M03 ships if the degradation annoys in practice; the mechanism would be a server-side re-mint at land time (same trust class as `sever_file_ownership_except`, which already crosses sessions server-side).

#### [Q03] Spans for correlation-class evidence (DEFERRED) {#q03-correlation-spans}

**Question:** Should `bash`/`turn` bracket rows or parsed `cmd` rows carry spans?

**Resolution:** DEFERRED: a bracket delta is a whole-tree fingerprint with no sub-file information, and a parsed command names files, not regions. Span-less evidence widens to a whole-file claim by rule ([P12]) — conservative, matching today's behavior exactly.

#### [Q04] Disclaim semantics on a shared file (DECIDED — see [P02]) {#q04-disclaim-shared}

**Question:** What does disclaiming a file another session also holds do?

**Resolution:** DECIDED (see [P02]): disclaim deletes only the *requesting* session's rows. If another session holds live proof rows it becomes the sole owner (the file leaves both sessions' SHARED state); otherwise the file degrades to `unattributed`. This makes disclaim the graceful one-click resolution of a SHARED file in the other party's favor.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Journal record variants unknown to older builds (R01) | med | low | single-machine rebuild; deletes stay shape-safe | multi-instance mixed-version use |
| Schema-v2 lockout of stale binaries (R02) | med | med | rebuild all binaries in the M03 pass; sidecar + gate already refuse safely | a stale dash-worktree build writing |
| Anchor false positives mis-assigning a hunk (R03) | high | low | exact-content matching first, widen-to-file on any ambiguity ([P12]) | any observed wrong per-hunk ownership |
| Dual-reader SHARED drift (R04) | med | med | extract the overlap decision into tugchanges-core, consumed by both ([P14]) | any new third reader |
| Index-clean precondition trips on hand-staged work (R05) | low | low | typed refusal naming the staged paths; raw git is read-only by policy anyway | recurring refusals in practice |
| Typed wire projections silently drop free-form fields (R06) | high | med | make the selection opaque ([P15]); a unit test asserts an unknown key survives the projection | any new field added to a "free-form" column |
| Wire ids and engine ids diverge (R07) | high | med | one canonical diff spelling ([P16]) + a cross-boundary id test; drift refusal is the safety net, not the fix | any new reader of a file's current hunks (M03 adds two) |
| Stale elections accumulate invisibly (R08) | med | high (today) | display reconciliation ([P18]); the engine's typed drift refusal stays the authority at land time | a user reports a landing refused for hunks they never elected |
| M03's contention pass adds a `git diff` per contended path to every recompute (R09) | med | med | bound it to paths with ≥2 proof owners, reuse the diff the card already fetched where one exists, and measure before shipping #step-14 | any recompute regression on a busy repo; a project whose dirty set routinely contends |
| Span rows orphaned by the record variants that move or purge their parent (R10) | med | med | #step-12 joins span deletion into **every** applier that touches `file_events`, not only the three the first draft named | any new `file_events` mutation path |

**Risk R01: Journal-format forward compatibility** {#r01-journal-compat}

- **Risk:** `changes_journal.rs` deserializes records with `serde_json::from_str::<Record>` — a build without the new `fe_batch`/`fe_disclaim` variants fails to parse those lines during replay/forwarding.
- **Mitigation:** the journal replay already counts and warns on failed lines rather than aborting; this is a single-machine deployment where all binaries rebuild together; `Record::shapes_rows` classifies Disclaim as a delete, which stays allowed even when the version gate locks a build out of shaping rows.
- **Residual risk:** a mixed-version window mid-pass can drop batch/disclaim records on the older side; acceptable for the duration of a dash pass.

**Risk R03: Anchor mis-match** {#r03-anchor-mismatch}

- **Risk:** content-anchor matching assigns a hunk to the wrong session (e.g. two sessions inserted identical text).
- **Mitigation:** identical insertions genuinely are contested — matching both sessions marks the hunk shared, which is the *correct* reading; any anchor that matches zero hunks or matches ambiguously widens that session's claim to the whole file ([P12]), reproducing today's file-level behavior. The failure direction is over-report of SHARED, never a false sole claim.
- **Residual risk:** more SHARED badges than theoretically minimal; never fewer than correct.

**Risk R06: A typed projection over a "free-form" column** {#r06-typed-projection}

- **Risk:** `changeset_drafts.selection` is a free-form TEXT column, but the *outbound* wire projection deserializes it into a two-field Rust struct, so any key that struct does not name is dropped on the way to the deck. This already happened: M02's `hunks` field was written correctly and stripped on read, leaving the whole election UI inert (#m02-audit).
- **Mitigation:** [P15] makes the projection opaque, so the column's freedom is real end to end. A unit test asserts an unknown key survives, which fails loudly if anyone re-types the field later.
- **Residual risk:** the deck's `isOptionalDraftSelection` validator is now the only shape guard on the selection. That is the correct place for it (the deck is the only consumer that interprets the shape), but it means a malformed selection is caught at render, not at write.

**Risk R07: Wire ids and engine ids diverge** {#r07-id-divergence}

- **Risk:** hunk identity is a hash of the diff *body text*, so any difference in how the two sides invoke `git diff` — an external diff driver, a different context width, a different base — yields different ids for the same file. Every election then drifts and every partial landing refuses. M02 shipped with `--no-ext-diff` on the engine (`tugchanges-core/src/commit.rs`) and **not** on the wire (`tugcast/src/feeds/git.rs`), which is exactly this hazard half-mitigated, and with no test crossing the boundary.
- **Mitigation:** [P16] gives both sides one shared flag list and one engine-side function; a Rust test in `feeds/git.rs` builds a real repo and asserts the two id lists are equal.
- **Residual risk:** the two sides still differ in base (`HEAD` vs the index) and rename detection (`-M` vs none). Those agree only because partial staging requires a clean index and because created/renamed files are excluded from election ([P07]) — a real coupling, now written down in [P17] rather than left implicit.

**Risk R08: Stale elections accumulate invisibly** {#r08-stale-elections}

- **Risk:** an election names ids that no longer exist in the file (the user edited the hunk). Today the row renders every checkbox unchecked *and* a `N of M hunks` badge — an incoherent state the user cannot read. Because M02's writes persisted while the reads were stripped, live ledgers may already hold elections nobody has ever seen.
- **Mitigation:** [P18] reconciles the persisted election against the current ids for display; the engine's `CommitError::HunkDrift` stays the authority at land time.
- **Residual risk:** the deck still sends unreconciled ids on the commit (the controller has no access to the diff), so a stale election surfaces as a typed refusal rather than being silently corrected. That is the intended failure direction — refuse loudly, never land something the user did not elect.

**Risk R09: the contention pass makes recompose pay for git** {#r09-recompute-cost}

- **Risk:** the hunk-aware verdict needs the file's *current* hunks, which means a `git diff` per contended path — inside `compose_snapshot`, which runs on every changeset bump and, through `changeset_all`, once per project. That composition is already the place this system fought per-path git cost: the code carries an explicit note that "one `rev-parse` replaces up to one `git log` per dirty path on every recompute". Adding a subprocess back per contended path re-opens the wound M02A is otherwise closing.
- **Mitigation:** the diff is fetched only for paths with ≥2 live proof owners — normally zero, and bounded by the dirty set even when not. Where a diff for the path has already been fetched for the card, reuse it rather than re-shelling. #step-14 measures a recompose on a repo with a contended dirty set before the step closes; a regression is a blocker for that step, not a note.
- **Residual risk:** a workspace where many dirty paths genuinely contend pays real cost. If that shows up, the answer is caching hunks by (path, status, mtime), not weakening the verdict.

**Risk R10: span rows orphaned by their parent's mutation** {#r10-orphaned-spans}

- **Risk:** spans are keyed `(tug_session_id, tool_use_id, file_path, seq)` — the `file_events` PK plus a sequence — so any applier that *moves* or *removes* a parent row without touching spans strands them. #rollout's first draft named `DeleteSession`, `Sever`, and `Disclaim`, but two more variants mutate that key: `Record::Rewrite` (`apply_file_event_rewrite` UPDATEs `file_path`, or merges into an existing survivor and DELETEs the legacy row) and `Record::PurgeOutOfRepo` (`purge_file_events_sql`). The repo-relative backfill runs `Rewrite` in bulk, opportunistically, over exactly the legacy rows most likely to exist.
- **Mitigation:** #step-12 extends every one of those appliers, and a test carries a span through a rewrite.
- **Residual risk:** if one is still missed, the owner loses its spans and widens to a whole-file claim ([P12]) — SHARED over-reports rather than under-reports, which is the blessed direction, but the feature quietly stops working for the affected rows. That silence is why the guard is a test and not a code read.

---

### Design Decisions {#design-decisions}

#### [P01] Batch claim is one journal record, all-or-nothing (DECIDED) {#p01-batch-claim-atomic}

**Decision:** `do_changeset_claim` writes one `Record::FileEventBatch { rows }` journal record applied in a single SQLite transaction, replacing the per-row `record_file_event` loop.

**Rationale:**
- One user gesture should be one durable record — atomic on disk, atomic in replay, one forwarder unit.
- The current loop's partial-failure mode is only surfaced as a deck-side "shortfall" heuristic (`claimShortfallDetail` in `changeset-verb-store.ts`); all-or-nothing makes the receipt honest by construction.

**Implications:**
- New `Record` variant (serde tag `"fe_batch"`, `shapes_rows() == true`); `SessionLedger::record_file_events(&[FileEventRow])`; `apply_journal_record` loops `insert_file_event` inside the one record's application (the applier already runs each record on one connection — wrap in an explicit transaction).
- `changeset_claim_ok.claimed` becomes `N` or `0`; the deck's shortfall path remains as a guard but should no longer fire for partial writes.

#### [P02] Disclaim deletes the requesting session's rows; degradation is toward unattributed (DECIDED) {#p02-disclaim-semantics}

**Decision:** `changeset_disclaim { project_dir, session_id, files }` deletes **all** of the named session's `file_events` rows (proof and bracket alike) for the given repo-relative paths in the given project, via a journaled `Record::Disclaim`.

**Rationale:**
- Deleting only proof rows would leave the session's own bracket rows hinting `likely` on the file it just renounced — a resting lie.
- Follows invariant 7's degradation direction and [Q04]'s shared-file resolution.

**Implications:**
- Serde tag `"fe_disclaim"`, `shapes_rows() == false` (a delete — permitted even under the version-gate lockout, like `Sever`).
- SQL mirrors `sever_file_ownership_sql` with `tug_session_id = ?` instead of `!=`.
- Reply `changeset_disclaim_ok { project_dir, disclaimed }` / `changeset_disclaim_err { project_dir, detail }`; guards identical to claim (open project, ledger present, `repo_relative_key` mapping with skip-and-warn).

#### [P03] Disclaim is a first-class verb at every layer claim exists (DECIDED) {#p03-disclaim-parity}

**Decision:** Disclaim ships with wire verb, HTTP bridge (free via the `changeset_` prefix in `server.rs`), `tugutil changes disclaim`, verb-store round-trip state, controller method, and a per-row card affordance — full parity with claim.

**Rationale:** "One verb owner; the CLI is the API" (tracking-changes.md) — a UI-only disclaim would be a dead end for skills and scripts.

**Implications:** New `run_disclaim` in `tugutil/src/changes.rs` mirroring `run_claim`; new CLI subcommand; deck store keys disclaim state by initiating card entry exactly as claim does.

#### [P04] Icon vocabulary: claim = CornerDownLeft, disclaim = CornerUpRight (DECIDED) {#p04-icons}

**Decision:** Both the per-row claim button and the `Claim all` button render `<CornerDownLeft size={12} />`; disclaim renders `<CornerUpRight size={12} />`.

**Rationale:** User-specified vocabulary; both icons exist in the installed `lucide-react` set as direct imports (no registration step).

**Implications:** Replace the `CornerUpLeft` import/uses in `tug-changes-list.tsx`.

#### [P05] One metadata divider, carried by a wrapper (DECIDED) {#p05-metadata-divider}

**Decision:** `FileIdentity` wraps the `shared` badge, provenance, and hint spans in a single `.tug-changes-list-file-meta` span; the `border-left: 1px solid var(--tug7-element-global-border-normal-muted-rest)` + `padding-left: var(--tug-space-md)` move from `.tug-changes-list-file-provenance` to the wrapper, rendered only when at least one child exists.

**Rationale:** The divider is a separator between the file name and its metadata cluster, not a property of one metadata kind; a wrapper guarantees exactly one divider regardless of which children render.

**Implications:** The wrapper carries `display: inline-flex; gap: 8px; align-items: baseline;` so intra-cluster spacing survives; the provenance rule keeps its typography only.

#### [P06] Hunk identity is a Rust-computed content hash, served to the deck (DECIDED) {#p06-hunk-identity}

**Decision:** A hunk's id is a hex-truncated SHA-256 over its body lines (every `-`/`+`/space line of the hunk, byte-exact, newline-joined; the `@@` header excluded), computed only in `tugchanges-core::hunks`; the deck receives ids alongside diff text and never re-derives them.

**Rationale:** [Q01]; one implementation means the deck's checkbox, the draft's election, and the commit's filter can never disagree; excluding the header makes the id immune to unrelated hunks shifting line numbers, while any content change invalidates the election — precisely the drift-refusal we want.

**Implications:** Duplicate ids within one file (two identical hunks) are disambiguated by an ordinal suffix (`<hash>#2`); the filtered-patch builder and the selection both use the suffixed form.

#### [P07] Partial staging = `git apply --cached` on a filtered patch; commit from the index; index-clean precondition (DECIDED) {#p07-partial-staging}

**Decision:** When any file in the landing carries a hunk election, `stage_and_commit` switches modes: refuse unless `git diff --cached --quiet` reports a clean index (typed error naming the staged paths); stage whole-file selections with `git add --`; stage partial files by rebuilding a unified diff of only the elected hunks (new-side `@@` start offsets recomputed by cumulative delta over included hunks) and piping it to `git apply --cached`; then `git commit -m <msg>` **without a pathspec**. The per-file diff runs with `--no-ext-diff` (an external diff driver would break both the patch and id agreement with the wire's ids, which assume default `-U3` context on both sides).

**Rationale:**
- `git commit -- <paths>` commits *working-tree* content for those paths, which would drag unselected hunks in — the pathspec form is structurally incompatible with partial staging.
- The index-clean precondition keeps "the commit is exactly what was staged" true by construction, the same receipt-honesty contract the current pathspec form provides.
- Recomputing offsets ourselves (rather than `git apply --recount`) keeps the patch well-formed and the failure mode a loud refusal, not a fuzzy match.

**Implications:**
- `CommitOptions` gains `hunks: Option<BTreeMap<String, Vec<String>>>` (path → elected hunk ids); empty/absent map preserves today's pathspec path byte-for-byte.
- A selected hunk id absent from the file's current diff is a typed refusal (`CommitError::HunkDrift { path, ids }`) — nothing staged, nothing committed.
- **Created/untracked files are whole-file only.** The deck's diff wire *synthesizes* a new-file unified diff for untracked paths (`feeds/git.rs`), but the engine's partial branch parses `git diff --no-color -- <path>`, which emits nothing for an untracked file — any election on one is a guaranteed drift refusal. The engine rejects `hunks` keys naming untracked/created paths with a typed error, and the UI (Step 9) renders no hunk controls on them.
- On any failure after staging began, the engine runs `git reset -- <all staged paths>` (the whole-file subset ∪ the partial paths) before returning, so a refusal never leaves a half-staged index — resetting only the partial paths would leave the `git add`-staged whole files tripping the *next* attempt's index-clean precondition on our own residue.
- The `with_rename_sources` staged-rename handling applies to the whole-file subset only.

#### [P08] A partial commit spends the whole path's rows; the remainder degrades (DECIDED) {#p08-partial-spends-path}

**Decision:** No change to row liveness (`min_live_at_ms` stays per-path); the un-landed remainder of a partially-committed file surfaces as `unattributed` afterward.

**Rationale:** [Q02]; matches invariant 7's degradation direction; a carry-forward mechanism is recorded as a follow-on, not built speculatively.

#### [P09] Hunk elections ride the draft selection TEXT (DECIDED) {#p09-selection-hunks}

**Decision:** `ChangesetDraftSelection` (deck `changeset-types.ts`; server-side an opaque free-form TEXT column `changeset_drafts.selection`) gains `hunks?: { [path: string]: string[] }` — per-path elected hunk ids, meaningful only when the path is in the landing set.

**Rationale:** The selection column is already free-form and machine-global; no schema change, no version bump, and the "no resting lies" rule is satisfied by writing the selection on every checkbox settle exactly as file dispositions do today.

#### [P10] Spans are a new additive table under schema v2; spans annotate, git diff decides (DECIDED) {#p10-spans-table}

**Decision:** M03 adds `changes.file_event_spans` keyed `(tug_session_id, tool_use_id, file_path, seq)` with `kind` and `anchor` columns; `CHANGES_SCHEMA_VERSION` goes to 2 with a registered `CHANGES_MIGRATIONS` entry; `file_events` itself is untouched.

**Rationale:** SHARED is computed from the machine-global ledger by two readers — hunk evidence must live where they read or the readers fork; a new table keeps the migration a single additive `CREATE TABLE` and leaves every existing row and reader working unmodified during the transition.

**Implications:** All the bump's satellite edits (see #rollout); span writes ride the existing `Record::FileEvent` journal record extended with a `#[serde(default)] spans: Vec<FileEventSpan>` field, so old journal lines still parse.

#### [P11] Anchors are content, never line numbers (DECIDED) {#p11-content-anchors}

**Decision:** A span anchor records what was written, not where: for `Edit`/`MultiEdit`, the SHA-256 and a size-capped head excerpt of each `new_string` (and `old_string` hash for replacements); for `Write`/`NotebookEdit`, the single anchor kind `whole`; for `tugutil file edit --patch`, the applied hunks' content hashes (the same identity as [P06]).

**Rationale:** Line numbers are dead the moment any other edit lands above them; content matches against the current diff's hunk bodies at read time regardless of drift.

#### [P12] SHARED is hunk-overlap only when every owner has spans; any span-less owner widens to file-level (DECIDED) {#p12-shared-widening}

**Decision:** For a path with ≥2 live proof owners: map each owner's anchors onto the file's current hunks; an owner with no spans, a `whole` anchor, or any unmatched/ambiguous anchor claims the whole file. `shared` is true iff two owners' claimed hunk sets intersect (a whole-file claim intersects everything). Per-owner hunk sets are surfaced so the UI can mark contested hunks and default-elect a session's own hunks.

**Rationale:** Conservative by construction — every widening reproduces today's exact behavior; the failure direction is over-report ([R03]), matching invariant 6's spirit.

#### [P13] The shell supplement is steering plus verbs, never a PTY (DECIDED) {#p13-shell-steering}

**Decision:** Interactive-only staging invocations (`git add|commit|stash|checkout|restore|reset` with `-p`/`--patch`/`--interactive`, and bare `git commit` with no `-m`) are detected at the deck's shell-routing layer and answered with a steering notice into the Changes shade instead of executing; agents get `tugutil file stage --patch` as the first-class non-interactive path.

**Rationale:** In the `$` route these commands read EOF from `</dev/null` and silently stage nothing (the worst outcome: a no-op that looks like success); [D111]'s block model is deliberate doctrine and the tmux probe was rejected on the record. The Session-card thesis is that the graphical surface replaces terminal interactivity — the hunk picker *is* our `git add -p`.

#### [P14] The overlap decision has one implementation (DECIDED) {#p14-one-overlap-impl}

**Decision:** The span→hunk matching and shared/sole verdict live in `tugchanges-core` (new `contention.rs` or within `hunks.rs`) as pure functions over `(hunks, per-session anchors)`; both `tugchanges-core::changes::compute_changes` and tugcast `feeds/changeset.rs` call it.

**Rationale:** The file-level SHARED rule already exists twice ("they must stay in sync" is a standing hazard); the hunk-level rule is too intricate to hand-mirror. tugcast already depends on tugchanges-core (`shell_ops`, diff parsing), so the dependency direction exists.

**Implications:**
- The verdict fn is pure over `(hunks, anchors)` precisely so each reader supplies the hunks its own way, and **the plan names both ways** rather than leaving the implementer to invent one. The engine reader (`changes.rs::compute_changes`) is synchronous and calls `file_hunks` ([P16]). The tugcast reader (`feeds/changeset.rs`) is async and MUST obtain hunks through the async `feeds/git.rs` spelling — which after [P16] carries `HUNK_DIFF_FLAGS` and parses with `parse_hunks`, so the ids agree by the same contract. It must **not** call `file_hunks`: that is `std::process::Command` on a tokio runtime thread, and wrapping it in `spawn_blocking` per contended path is worse than reusing the async spelling that is already there.
- Agreement between the two hunk sources is exactly what Spec S06's cross-boundary test pins, which is why [P16] is a hard prerequisite of this decision and not merely of M02A (#dependencies).

#### [P15] The draft selection is opaque on the wire (DECIDED) {#p15-opaque-selection}

**Decision:** `ChangesetDraft.selection` (`tugrust/crates/tugcast-core/src/types.rs`) becomes `Option<serde_json::Value>`, and the `ChangesetDraftSelection` struct beside it is deleted. The deck's `changeset-types.ts` keeps the typed `ChangesetDraftSelection` interface and its `isOptionalDraftSelection` validator — the deck is the only consumer that interprets the shape.

**Rationale:**
- [P09] states the selection column is free-form and machine-global, and the *column* is: `parse_changeset_draft_set_payload` stores `value.get("selection")` as a verbatim `v.to_string()`, and `ChangesetDraftRow.selection` is an `Option<String>`. Only the outbound projection (`feeds/changeset.rs::draft_from_row`) narrows it, by deserializing into a struct naming exactly `include` and `exclude`. Serde ignores unknown fields, so `hunks` was written and then silently dropped.
- **No Rust code reads `include` or `exclude`.** A grep across `tugrust/crates/` finds `ChangesetDraftSelection` only at its own definition and at the `ChangesetDraft.selection` field. The type buys nothing and costs the plan its extensibility premise.
- An opaque `Value` makes the freedom real: M03 can add fields to the selection without another Rust edit, which is what [P09] promised.

**Implications:**
- `draft_from_row` becomes `serde_json::from_str::<serde_json::Value>(s).ok()`, preserving today's "a hand-mangled row reads as no overrides rather than poisoning the snapshot" guard.
- Struct literals constructing `ChangesetDraft` in `tugcast-core/src/types.rs` tests need updating; `serde_json` is already a real (non-dev) dependency of `tugcast-core`, so no manifest change.
- Nothing changes on the write path, on `changeset_drafts`, or on the deck's types. This is a wire-projection fix only.

#### [P16] One canonical diff spelling for hunk identity (DECIDED) {#p16-canonical-diff-spelling}

**Decision:** `tugchanges-core::hunks` owns both halves of the contract:
- `pub const HUNK_DIFF_FLAGS: &[&str] = &["--no-color", "--no-ext-diff"];` — the flags every `git diff` whose output feeds hunk identity must carry, spliced in by both the async tugcast feed and the sync engine.
- `pub fn file_hunks(repo_root: &Path, path: &str) -> Result<Vec<Hunk>, String>` — the engine-side spelling, one function, called by `commit.rs`'s partial branch and by the cross-boundary test.

**Rationale:**
- The two sides cannot share a function: `tugcast/src/feeds/git.rs` runs git through `tokio::process::Command` and `tugchanges-core` through `std::process::Command`. What they *can* share is the argument list and the parse, which is exactly where divergence bites.
- An external diff driver (`diff.external`, or a `*.diff=driver` gitattribute) makes git emit text that is not a unified diff at all. [P07] identified this and put `--no-ext-diff` on the engine; the wire side never got it, so the id contract has been unguarded since M02 landed.
- One shared const is auditable by grep; a test that crosses the boundary is auditable by running it. Both are cheaper than the drift refusal they prevent.

**Implications:**
- The three `git diff` invocations in `feeds/git.rs` — `run_git_diff_against`, `synthesize_untracked_diff`, and `fetch_git_diff` — all gain the shared flags.
- `commit.rs`'s partial branch stops spelling its own `git diff` and calls `file_hunks`.
- The cross-boundary test lives in `feeds/git.rs` (tugcast depends on tugchanges-core, not the reverse).

#### [P17] Context width is machine-relative; base and rename detection are not part of the id contract (DECIDED) {#p17-id-contract-boundaries}

**Decision:** hunk ids are **not** pinned to `-U3`. Both sides inherit the machine's `diff.context`, and the id contract is "same machine, same config, same moment" — not "same everywhere". The wire's `-M` and `HEAD` base and the engine's rename-free index base are likewise left as they are, and the reason they agree is documented rather than enforced.

**Rationale:**
- Both readers run on one machine and read one git config, so they always agree with each other, which is the only agreement the contract needs. Forcing `-U3` would also silently change what the diff card renders for anyone who has set `diff.context`.
- `git diff HEAD` (wire) and `git diff` (engine) are identical exactly when the index is clean, which partial staging already requires ([P07]).
- `-M` only changes how a *rename* is presented, and renames never carry an election: an unstaged rename surfaces as Deleted-plus-Added, and a created file gets no ids at all ([P07]); a staged rename means a dirty index, which the landing refuses.

**Implications:**
- If `diff.context` changes between the deck rendering ids and the user landing, the elections drift and the landing refuses — the designed failure, not a bug.
- `-c core.quotepath=false` (wire only) affects header path spelling, never body lines, so it cannot move an id. `filtered_patch` emits the engine's own header, so the patch stays self-consistent.
- These three facts belong in the `hunks.rs` module doc, where the next reader of the id rule will look.

#### [P18] The deck reconciles elections for display; the engine decides at land time (DECIDED) {#p18-display-reconciliation}

**Decision:** the row intersects the persisted election with the file's current ids before rendering. A partial intersection renders as that subset. An election whose intersection is **empty** renders every box checked *and* says so: the row's badge reads `stale election` rather than `N of M hunks`, with a title naming the condition. The persisted election is never rewritten by the display, the controller's `commit()` keeps sending it unreconciled, and `CommitError::HunkDrift` remains the authority.

**Rationale:**
- The two-layer split this plan already uses one level down: the view suggests, the engine decides. The controller has no access to the diff (it lives in the per-entry `GitDiffStore`), so reconciliation is only possible where the ids are — in the row.
- Without it a stale election renders every checkbox unchecked *beside* a `2 of 3 hunks` badge, and the "can't uncheck the last hunk" guard never engages because nothing is checked.
- Reconciling for display but not for the wire is deliberate: silently dropping stale ids from a landing would land something the user did not elect. A loud typed refusal naming the path and ids is the better failure.
- **Total drift must not render as plain whole-file.** Every box checked with no other signal tells the user this file lands whole, and then the landing refuses with `hunk drift:` — the display would be asserting something the store does not hold, which is the resting lie this plan's own doctrine forbids. Checked boxes are the only coherent rendering of "nothing addressable is elected", so the badge carries the truth instead. The alternative — rewriting an empty intersection to `null` on read — was rejected: it discards the user's stated intent behind their back, and a row is not a settle gesture.

**Implications:**
- The reconciled count feeds the `N of M hunks` badge, so the badge and the checkboxes can no longer disagree.
- The reconciliation is **one exported pure function** (`reconcileHunkElection(ids, persisted)` in `tugdeck/src/lib/hunk-election.ts`) over `(ids, persistedElection) → { elected, partial, stale }`, called by **both** `EntryFiles` (which renders the badge on collapsed rows, where no diff body is mounted) and `FileDiffBody` (which renders the boxes). One function is what makes them unable to disagree; moving the computation from one to the other would only delete the badge from collapsed rows.
- The function lives in `lib/`, not in `tug-changes-list.tsx`: that module does `import "./tug-changes-list.css"` and pulls the whole component graph, which a pure-logic `bun:test` should not have to load.

#### [P19] One diff-body component (DECIDED) {#p19-one-diff-body}

**Decision:** `fileBlockBody` returns a single `FileDiffBody` component for every non-notice case. It calls `useResponderForm` unconditionally and passes `renderHunkAffordance` only when there is something to elect. `HunkElectionDiff` is deleted.

**Rationale:**
- M02 shipped two component types swapped on `election !== undefined && (file.hunks?.length ?? 0) > 1`. That predicate moves at runtime — edit a one-hunk file into two while its row is open and the aggregate recomposes — and swapping which component the parent renders is precisely the [L26] failure: the open diff unmounts, taking its collapsed-hunk set, view mode, and scroll with it.
- [L26] prescribes the fix in its own words: "write one component that branches internally on phase."

**Implications:**
- The notice branches (`error` / `loading` / `no diff` / `binary`) keep returning `<p>` elements. Those are genuinely different entities and predate this plan.
- Hooks must be unconditional, which is why the branch moves inside the component rather than staying at the call site.

#### [P20] Session-entry affordances are hand-verified, not app-tested (SUPERSEDED) {#p20-hand-verification}

> **Superseded at M02A's close — the wall was not permanent.** The premise below is that a session entry is unreachable from the harness. It was reachable all along: `SessionLedger::default_path()` resolves through `TUG_SESSIONS_DB` / the per-instance data dir, so a `tugcast --seed-ledger` run against a launch's own instance writes a live session and its proof rows through the same ledger the server uses. `App.seedLedger()` is that hook, at0334 is the test, and HV1–HV8 are automated: the affordance half in at0334, the landing half (partial, drift refusal, whole-file) against a temp repo in `feeds/changeset.rs`'s `m02a_verification`. Seeding must run **after** launch — tugcast demotes every `live` row to `closed` once at startup, so a pre-launch seed lands its files in `orphaned`.
>
> The decision cost something real while it stood: it was the reason nobody clicked one of these checkboxes, and the reason two blocking defects — the dropped wire projection (F1) and the responder-chain break in `DiffBlock` — sat behind it undetected. "This surface is untestable" deserves a spike before it becomes a decision.

**Decision (as it stood):** the hunk-election checkbox, the partial landing, and the `N of M hunks` badge are verified by a scripted manual pass in the running debug app, recorded as an explicit checklist in #step-11g. No app-test is written for them.

**Rationale:**
- A session-entry row requires the ledger to hold live proof rows for a session id the harness owns, and `app.bindSession` is a synthetic client-side binding the ledger knows nothing about. at0332 and at0253 already record this wall; at0333 works only because it drives an *unattributed* row.
- Writing an app-test that cannot reach the affordance, or faking a ledger session to make it reachable, would both be worse than an honest manual checklist — the first is theatre, the second tests a fixture instead of the product.

**Implications:**
- The mechanism that broke (the wire projection) gets a Rust unit test, so the *class* of failure is guarded even though the surface is not.
- If the harness later grows a way to seed real ledger sessions, this decision should be revisited and the checklist promoted to an app-test.
- **The [L26] fix itself ([P19]) is likewise unguardable by app-test**, for the same reason one level down: `election` is `undefined` on every entry kind but `session` (`tug-changes-list.tsx` passes `onElectHunks`/`hunkElection` only when `entry.kind === "session"`), so on an unattributed row `fileBlockBody` returns `DiffBlock` both before and after the change. An app-test on an unattributed row cannot fail on today's code. It is still worth writing — as a `DiffBlock` mount-identity test, which is a real thing to pin — but it is not the F4 regression guard, and #step-11c must not read as though it were. F4's guard is the [L26] triple stated in the commit body plus HV1–HV4.

#### [P21] Hunk collapse state keys by hunk id, not by index (DECIDED) {#p21-collapse-by-id}

**Decision:** `DiffBlock`'s `collapsedHunks` moves from `Set<number>` (the hunk's position in the render list) to a set keyed by the hunk's [P06] id, falling back to the index only for the diffs that carry no ids (created and binary files, which have none by design).

**Rationale:**
- The state is per-hunk user state, and the index is not the hunk's identity — it is the identity of a *slot*. Edit a file so a hunk appears above a collapsed one and the collapse migrates to a hunk the user never touched. Stable mount identity ([P19]) does not fix this: the component survives, and its surviving state now points at the wrong band. That is [L23] — an internal operation ceasing to apply user-visible state — arriving by a different door than a remount.
- The ids that fix it are already on the wire and already threaded into `DiffBlock` as `hunkIds` (M02, #step-7). This is a rekey, not new machinery.
- It is also what makes #step-11c's mount-identity test mean something: "the band is still collapsed after the hunk count changed" is only a real assertion once *which* band is collapsed is defined by content rather than position.

**Implications:**
- The fallback matters: `hunkIds` is optional and absent for created/binary diffs, so the keying rule is "id when there is one, index otherwise", and a diff cannot mix the two (the wire emits ids for all of a file's hunks or none).
- Duplicate hunks within one file already disambiguate by ordinal suffix ([P06]), so ids stay unique per file — the set cannot collapse two bands into one entry.

---

### Deep Dives {#deep-dives}

#### Current claim flow (verified) {#claim-flow}

Frontend: `tugdeck/src/components/tugways/tug-changes-list.tsx` renders per-row claim buttons (`data-testid="tug-changes-list-claim"`, icon `CornerUpLeft`) and section-header `Claim all` buttons (`tug-changes-list-claim-all-<kind>`) for the `unattributed` and `orphaned` entries; `cards/session-changes/session-changes-view.tsx` wires them to `ChangesRouteController.claim(paths)` (`lib/changes-route-controller.ts`), which calls `ChangesetVerbStore.claim(entryKey, projectDir, sessionId, files)` (`lib/changeset-verb-store.ts`) — one `changeset_claim` CONTROL frame with the whole `files[]`. Replies `changeset_claim_ok {project_dir, claimed}` / `changeset_claim_err {project_dir, detail}` correlate through a project→entry in-flight map; a `claimed < requested` reply is treated as an error (`claimShortfallDetail`). Errors surface via `cards/claim-error-notice-controller.tsx` (sticky danger bulletin).

Server: dispatch `"changeset_claim"` in `tugcast/src/feeds/agent_supervisor.rs` (`parse_changeset_claim_payload` → `do_changeset_claim`). Guards: project in `WorkspaceRegistry`, ledger present. One synthetic `tool_use_id = format!("claim:{at}")` groups the batch; per path, `repo_relative_key` maps (skip-and-warn outside the repo) and a `FileEventRow { tool_name: "Claim", op: "claimed", origin: "claim", ambiguous: false }` is written via `ledger.record_file_event` — **N separate journal records today**. Then `sever_file_ownership_except(canonical, &request.files, &request.session_id)` (one set-based DELETE, journaled as `Record::Sever`) and `changeset_all_bump().notify_one()`. The HTTP bridge in `tugcast/src/server.rs` routes any `changeset_*`-prefixed action POSTed to `/api/tell` into the same handler; `tugutil changes claim` (`tugutil/src/changes.rs::run_claim`) uses it.

Ledger: `tugcast/src/session_ledger.rs` — `record_file_event` wraps `Record::FileEvent` through `write_change` (journal append + `apply_journal_record`); `insert_file_event` is `INSERT … ON CONFLICT (tug_session_id, tool_use_id, file_path) DO NOTHING`. `apply_journal_record` is the single applier shared by live writes, forwarded writes, and journal replay — every new record variant is added there once. The `Record` enum lives in `tugcast/src/changes_journal.rs` with serde-renamed tags (`"fe"`, `"fe_sever"`, …) and a `shapes_rows()` classifier (deletes stay allowed under the version-gate lockout).

#### Current row rendering (verified) {#row-rendering}

`FileIdentity` in `tug-changes-list.tsx` renders, after `FilePathLink`: the `shared` badge (`.tug-changes-list-badge.tug-changes-list-badge-shared`, lowercase text uppercased by CSS), the provenance span (`.tug-changes-list-file-provenance`, text `` `${op} · ${origin}` `` — a middle dot, with `origin` suppressed for `dash`/`claim` rows), and the hint span (`.tug-changes-list-file-hint`, `likely` / `seen by N` / `from <owner>`). In `tug-changes-list.css`, only the provenance rule carries `padding-left` + `border-left` — the visible "pipe". The row container `.tug-changes-list-file-identity` is `inline-flex; gap: 8px`.

#### Current commit engine (verified) {#commit-engine}

`tugchanges-core/src/commit.rs`: `commit(opts)` → `derive_file_set` (the Table-T01 disposition matrix via pure `select_from_buckets`; `paths` bypasses bucketing — the Session card's `run_changeset_commit` in `tugcast/src/feeds/changeset.rs` always passes explicit `files`) → `stage_and_commit` (`git add -- <stageable>` then `git commit -m <msg> -- <files ∪ rename-sources>`; `stageable_paths` drops already-staged deletions, `with_rename_sources` adds staged-rename sources) → `build_receipt` (+ `left_behind` re-bucketing). `CommitError::UnattributedPresent` is the typed exit-3 refusal. All git runs through `tugchanges-core/src/git.rs::git_output/git_stdout` (`git -C <root> …`). The diff parser `git.rs::parse_unified_diff`/`parse_diff_chunk` already walks `@@` boundaries but discards headers (counts only); `DiffFile.unified` retains the verbatim per-file chunk text.

Existing patch machinery to reuse: `tugutil/src/commands/file_probe.rs` — `git_apply(patch, check_only)` (`git apply [--check] -` over stdin), `git_apply_stdout(patch, ["--numstat","-z"])`, and `patch_targets` (the union-of-numstat-and-headers protected-set rule); `tugutil/src/commands/file.rs::edit_by_patch` (validate `--check`, apply, receipt only files whose bytes moved).

#### Hunk-aware read side (M03 sketch) {#hunk-read-side}

`tugchanges-core/src/changes.rs::compute_changes` classifies each dirty path from live rows (`ledger.rs`: `PROOF_ORIGINS = ["exact","replay","claim","cmd"]`; `foreign_proof_sessions_for_path` = canonical-root match + `max_proof_at >= min_live_at_ms`); `shared = !foreign_proof.is_empty()`. tugcast `feeds/changeset.rs` composes the aggregate with its own `proof_owners: HashMap<path, HashSet<session>>` and marks `file.shared = true` when `len() > 1`. M03 inserts one step in both: when a path has ≥2 proof owners, load spans for the live rows, parse the path's current hunks (M02's module), call the shared tugchanges-core verdict fn ([P14]), and emit per-owner hunk sets alongside the boolean. The wire `ChangesetFile` (deck `lib/changeset-types.ts`) gains optional `own_hunks?: string[]` / `contested_hunks?: string[]` — additive, absent means file-level.

#### M02 post-landing audit — findings and evidence {#m02-audit}

M01 (`818968a18`) and M02 (`2d61f429f`) were audited against the tuglaws and the real code after landing. M01 came back sound. M02's engine, CLI, and wire are sound; its deck path is not. The findings below are what M02A fixes, each with the evidence that established it, so a cold reader can confirm rather than trust.

**F1 — the election never reaches the deck (blocking).** `changeset_draft_set` stores the selection verbatim (`parse_changeset_draft_set_payload` does `Some(v.to_string())`; `ChangesetDraftRow.selection` is `Option<String>`), so the write is correct and `hunks` is in the ledger. The read-back is not: `feeds/changeset.rs::draft_from_row` deserializes into `tugcast_core::ChangesetDraftSelection`, a struct with exactly `include` and `exclude`, and serde drops unknown fields. Proven with a throwaway test on the real type: `{"include":["a.rs"],"exclude":[],"hunks":{"f.txt":["abc…"]}}` deserializes and re-serializes as `{"include":["a.rs"],"exclude":[]}`. Consequences: `ChangesRouteController.hunkElection()` always returns `{}`; every checkbox renders checked and snaps back after a click (a resting lie); the `N of M hunks` badge never appears; `commit()` never sends `hunks`. **The `HunkElectionDiff` render path has never executed — not in any test, not in the app.** Fixed by [P15] / #step-11a.

**F2 — nothing pins wire ids to engine ids.** The feed test asserts the feed's ids equal `parse_hunks` of the same text (near-tautological); `commit.rs`'s tests compute ids from their own `git diff`. No test crosses the boundary, and the boundary is the entire contract. Fixed by [P16] / #step-11b.

**F3 — `--no-ext-diff` is half-applied.** [P07] reasoned that an external diff driver "would break both the patch and id agreement with the wire's ids", then the flag landed only on `commit.rs`. `feeds/git.rs` runs `-c core.quotepath=false diff --no-color -M HEAD` with no `--no-ext-diff`, at all three call sites. Fixed by [P16] / #step-11b.

**F4 — [L26] mount-identity violation.** `fileBlockBody` returns `<HunkElectionDiff>` or `<DiffBlock>` on a predicate that moves at runtime. Fixed by [P19] / #step-11c. Note the guard, because it is not the obvious one: the predicate can only move where `election` is defined, which is only an `entry.kind === "session"` row, so no app-test can fail on this. HV7 (#step-11g) is F4's verification.

**F4b — collapse state is keyed by slot, not by hunk.** `DiffBlock` holds `collapsedHunks` as a `Set<number>` of render indices. A hunk appearing above a collapsed band moves the collapse onto a hunk the user never folded — [L23] by a different door than a remount, and untouched by [P19]'s fix. The ids that resolve it have been on the wire since #step-7. Fixed by [P21] / #step-11c, and this one *is* app-testable on an unattributed row.

**F5 — no display reconciliation for stale elections.** Fixed by [P18] / #step-11d.

**F6 — dead code asserting a hazard that does not exist.** `diff-block.tsx` wraps the affordance in a span carrying `onClick={(event) => event.stopPropagation()}` with a comment claiming a click "must never also fold the hunk behind it". The hunk cue's handler is on a *sibling* element, not an ancestor, and `TugCheckbox` dispatches through the responder chain rather than DOM bubbling — so the handler is unreachable and the comment describes nothing. Delete both. #step-11d.

**F7 — a `useMemo` that never memoizes.** `HunkElectionDiff`'s toggle-bindings memo lists `[ids, elected, election, senderId]`, and both `elected` (a fresh `Set`) and `election` (a fresh object literal from `EntryFiles`) change every render. It is free — `useResponderForm` reads bindings through a ref (`bindingsRef.current = bindings` on every render), so churn costs nothing and no closure goes stale. But the code is correct *because* the memo fails: stabilizing those deps would freeze the closures over an old `elected` and break toggling. Drop the memo. #step-11d.

**F8 — the disabled last checkbox is unexplained.** Note `TugCheckboxProps` declares no `title`; hyphenated JSX attributes such as `data-testid` bypass TypeScript's excess-property check, but `title` would not. Put the tooltip on the wrapping `.tugx-diff-hunk-affordance` span rather than widening the shared component. #step-11d.

**F9 — the sticky pin chain is duplicated.** `diff-block.css` now carries the same three-term `calc(var(--tugx-pin-stack-top,0px) + var(--tugx-block-header-height,0px) + var(--tugx-diff-header-height,0px))` twice, on `.tugx-diff-hunk-header` and on `.tugx-diff-hunk-lead`. #step-11e.

**F10 — the band hardcodes TugCue's surface.** `.tugx-diff-hunk-lead` sets `background: var(--tug7-surface-global-primary-normal-sunken-rest)`, which is the value `TugCue`'s `muted` role resolves to. Not a literal [L20] breach (it names no `--tugx-cue-*` token) but the same coupling by another route: retint the cue and the band splits down the middle. #step-11e.

**F11 — disclaim matches one storage form (unconfirmed).** `disclaim_file_ownership_sql` deletes on `file_path IN (…)` using `repo_relative_key`-mapped paths, while `file_events.file_path` has historically held several spellings — `feeds/changeset.rs` carries an opportunistic lazy backfill (`backfill_file_events_repo_relative`, guarded by `backfill_marker`) precisely because of that. The backfill probably makes disclaim correct in practice, and M01's tests seed via claim, which writes the new form — so no test would notice if it were not. This is a spike, not a known defect: #step-11f.

Two things the audit checked and found clean, recorded so M02A does not re-litigate them: M01's batch claim is genuinely atomic (one `fe_batch` record, one explicit `unchecked_transaction` around N `insert_file_event` calls, per-row `ON CONFLICT DO NOTHING` preserved, and `record_file_events_replays_from_the_journal_after_destruction` proves replay does not nest transactions); and `bun run audit:tokens lint` reports zero violations, so M02 introduced no [L16] or [L17] debt.

#### Why the session-entry affordance is not app-testable {#session-entry-wall}

The hunk-election controls render only on `entry.kind === "session"` rows. A session entry exists only when the ledger holds live proof rows for that session id, and the app-test harness's `app.bindSession` is a synthetic client-side binding the ledger knows nothing about — so the shade shows the project's *unattributed* bucket and never a session entry. at0332 records this wall for claim/disclaim and at0253 for the commit round trip; at0333 passes only because it drives an unattributed row, where ids are served but no affordance renders.

The wall is wider than the affordance: `election` is passed only for session entries, so *any* behavior gated on `election !== undefined` sits behind it — including the [P19] component swap that F4 identifies. An app-test on an unattributed row exercises the `election === undefined` branch on both sides of that fix and cannot fail on it. Reaching for one anyway would produce a green test that guards nothing, which is worse than the honest gap.

This is why [P20] accepts a manual checklist for the affordance itself while insisting the *mechanism* that broke (the wire projection) gets a unit test. The lesson from F1 is not "write more app-tests" — it is that "this path is untestable" must trigger a hand-verification, not a note in a docblock.

#### The landing gesture's path to `hunks` {#landing-path}

Recorded because it is easy to re-derive wrongly. The Session card's `/commit` resolves through `commit-mode-controller.ts`, which calls `changesController.commit(text)` — the `ChangesRouteController` method that assembles `hunks` from the election and forwards it to `ChangesetVerbStore.commit`. There is no second path that reaches the verb store directly, so fixing F1 is sufficient to make partial landing reachable from the UI; no additional plumbing is needed.

---

### Specification {#specification}

**Spec S01: Disclaim wire contract** {#s01-disclaim-wire}

Request (CONTROL frame or `POST /api/tell`): `{ "action": "changeset_disclaim", "project_dir": "<abs>", "session_id": "<tug session id>", "files": ["<repo-relative>", …] }` — all fields required, `files` non-empty. Replies: `{ "action": "changeset_disclaim_ok", "project_dir", "disclaimed": <n rows deleted> }` or `{ "action": "changeset_disclaim_err", "project_dir", "detail" }`. Guards and path mapping identical to claim (#claim-flow). Success fires the aggregate bump; the rows vanish from the session's entry on the next recompute (no client-side flip).

**Spec S02: Hunk model** {#s02-hunk-model}

`tugchanges-core/src/hunks.rs`: `pub struct Hunk { pub id: String, pub old_start: u32, pub old_lines: u32, pub new_start: u32, pub new_lines: u32, pub body: String }`; `pub fn parse_hunks(unified_diff_for_one_file: &str) -> Vec<Hunk>`; `pub fn hunk_id(body: &str) -> String` per [P06] (SHA-256 of body, hex, first 16 chars; ordinal suffix `#N` on within-file duplicates); `pub fn filtered_patch(file_header: &str, hunks: &[Hunk], selected: &BTreeSet<String>) -> Result<String, HunkDrift>` — emits the original `---`/`+++` header plus the selected hunks with new-side starts recomputed by cumulative delta over *included* hunks only; errors if any selected id is absent.

**Spec S03: `changeset_commit` hunks field** {#s03-commit-hunks}

The existing `changeset_commit { project_dir, files, message, session_name?, session_id? }` payload gains optional `"hunks": { "<repo-relative path>": ["<hunk id>", …], … }`. Every key must also appear in `files`. Absent/empty → today's behavior byte-for-byte. `run_changeset_commit` forwards it into `CommitOptions.hunks`; `tugutil commit` gains `--hunks <path-to-json|->` accepting the same map. Error replies reuse `changeset_commit_err.detail`; hunk drift produces `detail` beginning `hunk drift:` and naming path + ids.

**Spec S04: Spans schema and matching** {#s04-spans-schema}

```sql
CREATE TABLE IF NOT EXISTS changes.file_event_spans (
    tug_session_id TEXT NOT NULL,
    tool_use_id    TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    kind           TEXT NOT NULL,   -- 'whole' | 'insert' | 'replace' | 'hunk'
    anchor         TEXT NOT NULL,   -- JSON: {"new_hash","new_head","new_len","old_hash"?} or {"hunk_id"}
    PRIMARY KEY (tug_session_id, tool_use_id, file_path, seq)
);
```

Rows are children of a `file_events` row (same first three key columns); deletion follows the parent (Disclaim/Sever/DeleteSession delete from both tables). Matching at read time, per owner per anchor: `hunk` anchors match a current hunk by id equality; `insert`/`replace` anchors match a hunk whose added-line text contains the anchor's `new_head` and whose added-byte length is plausible for `new_len`, else by `new_hash` equality against the hunk's full added text; zero or >1 distinct-hunk matches → the owner widens to whole-file ([P12]). `new_head` is capped at 200 bytes, anchors per event at 32 (`whole` recorded beyond the cap).

**Spec S05: Receipt hunks extension** {#s05-receipt-hunks}

`TUG-FILE-RECEIPT` ops gain an optional additive field: `{"op":"modified","path":"/abs/x.ts","hunks":["<hunk id>", …]}` — the [P06] ids of the hunks `tugutil file edit --patch` actually applied. The relay's `parse_receipt_line` (`tugcast/src/feeds/attribution.rs`, which already ignores unknown fields) learns to read it and mint `kind='hunk'` span rows alongside the `cmd` file event. `tugutil file edit --replace` computes the resulting hunk post-substitution the same way.

**Spec S06: The hunk-identity agreement contract** {#s06-id-agreement}

Two independent readers must produce byte-identical hunk ids for the same repo state, or every election drifts:

1. **The wire** — `tugcast/src/feeds/git.rs`, async, `-c core.quotepath=false diff --no-color -M HEAD` (plus `--no-index` for the untracked synthesis), parsed by `parse_git_diff` → `tugchanges_core::parse_hunks`.
2. **The engine** — `tugchanges-core/src/commit.rs`, sync, `diff --no-color --no-ext-diff -- <path>`, parsed by `parse_hunks`.

The contract, after [P16] and [P17]:

- Both MUST carry every flag in `tugchanges_core::hunks::HUNK_DIFF_FLAGS` (`--no-color`, `--no-ext-diff`). An external diff driver emits text that is not a unified diff, so this is not a nicety.
- Neither may pass `-U<n>`. Context width is inherited from the machine's `diff.context` and is therefore equal on both sides ([P17]).
- Differences that provably cannot move an id, and are therefore allowed: `-c core.quotepath=false` (header path spelling only), `-M` (rename *presentation*; renames never carry elections), and `HEAD` vs the index as base (equal whenever the index is clean, which partial staging requires).
- The agreement is verified by a test that builds a real repo, dirties a file into ≥2 hunks, and asserts the two id lists are equal element-for-element.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Disclaim round-trip (pending/error per entry) | external | `ChangesetVerbStore` + `useSyncExternalStore` (mirror of claim) | [L02] |
| Hunk checkbox elections | external (durable) | written to the draft selection via the existing draft write path on every toggle settle; read back through the changeset feed's draft snapshot | [L02] |
| Metadata divider, icon swap | appearance | CSS + JSX structure only | [L06] |
| Contested-hunk marking in the diff | appearance | CSS classes on hunk rows driven by server-supplied ids | [L06] |
| Reconciled election (persisted ∩ current ids) | local data, derived | computed in `FileDiffBody` from props each render — no store, no `useState`; the persisted election stays the single source and the diff store supplies the ids ([P18]) | [L24], [L02] |
| Diff-body mount identity across the 1↔2-hunk boundary | structure | one component type branching internally; never two swapped at the call site ([P19]) | [L26] |
| Which hunk bands are collapsed | local data | `DiffBlock`-internal state keyed by the hunk's [P06] id, not its slot index ([P21]) — surviving the mount is not enough if the surviving key points at a different hunk | [L23], [L24] |

---

### Compatibility / Migration / Rollout {#rollout}

- **M01/M02:** no schema changes. New journal record variants are forward-incompatible with older binaries' journal *replay* (Risk R01) — rebuild all `tug*` binaries when landing each pass (they land from one dash join, so this is the normal flow).
- **M03 schema bump, the complete satellite list** (all in `tugcast/src/session_ledger.rs` unless noted): `CHANGES_SCHEMA_VERSION` 1→2; add `(1, "CREATE TABLE IF NOT EXISTS file_event_spans …")` to `CHANGES_MIGRATIONS`; add the table to `bootstrap_changes_schema`'s idempotent DDL block; add `file_event_spans` to the quarantine `salvage_into` table list (currently `["file_events", "changeset_drafts"]`) so a post-quarantine rebuild recovers span rows rather than leaning entirely on journal replay; extend the version-gate tests; extend **every applier that mutates a `file_events` row's identity** to carry its spans with it (Risk R10) — eviction (`DeleteSession`), `Sever`, and the new `Disclaim` delete matching span rows; `Rewrite` (`apply_file_event_rewrite`) must UPDATE the spans' `file_path` on the rename branch and delete the legacy row's spans on the merge-into-survivor branch, matching whatever it does to the parent; `PurgeOutOfRepo` deletes span rows for the purged keys; read side adds a spans query in `tugchanges-core/src/ledger.rs` (which hand-mirrors the writer's schema per its module doc) and updates the seeded test DDL in `ledger.rs` and `changes.rs` tests. After the pass lands: rebuild everything; any stale binary (e.g. an old dash-worktree build) refuses shared-table row-shaping writes by the existing gate — expected and safe.
- **Wire:** every new field is additive and optional (`hunks` on commit, `own_hunks`/`contested_hunks` on files, `hunks` on receipt ops); an old deck against a new server, or vice versa, degrades to file-level behavior.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugchanges-core/src/hunks.rs` | Hunk parse/identity/filtered-patch (Spec S02) + the [P14] overlap verdict |
| `tugrust/crates/tugutil/src/commands/file_stage.rs` (or a `stage` fn in `file.rs`) | `tugutil file stage --patch` |
| `tugdeck/src/lib/hunk-election.ts` | `reconcileHunkElection` — the one reconciliation rule both the badge and the checkboxes read ([P18]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `Record::FileEventBatch` | enum variant | `tugcast/src/changes_journal.rs` | tag `"fe_batch"`, shapes_rows=true |
| `Record::Disclaim` | enum variant | `tugcast/src/changes_journal.rs` | tag `"fe_disclaim"`, shapes_rows=false |
| `SessionLedger::record_file_events` | fn | `tugcast/src/session_ledger.rs` | transactional batch insert |
| `SessionLedger::disclaim_file_ownership` | fn | `tugcast/src/session_ledger.rs` | + `disclaim_file_ownership_sql` |
| `ChangesetDisclaimPayload`, `parse_changeset_disclaim_payload`, `do_changeset_disclaim`, `send_changeset_disclaim_err` | struct/fns | `tugcast/src/feeds/agent_supervisor.rs` | mirrors claim |
| `run_disclaim` | fn | `tugutil/src/changes.rs` | + CLI subcommand in `tugutil/src/cli.rs` |
| `DisclaimState`, `ChangesetVerbStore.disclaim/disclaimState/clearDisclaim`, `useChangesetDisclaim` | TS | `tugdeck/src/lib/changeset-verb-store.ts` | mirrors claim state |
| `ChangesRouteController.disclaim` | TS method | `tugdeck/src/lib/changes-route-controller.ts` | |
| `onDisclaimFile`, `disclaimPending` props; `.tug-changes-list-file-meta` | TS/CSS | `tugdeck/src/components/tugways/tug-changes-list.tsx` / `.css` | + icon swap |
| `Hunk`, `parse_hunks`, `hunk_id`, `filtered_patch`, `HunkDrift` | Rust | `tugchanges-core/src/hunks.rs` | Spec S02 |
| `CommitOptions.hunks`, `CommitError::HunkDrift` | fields/variant | `tugchanges-core/src/commit.rs` | [P07] |
| `ChangesetDraftSelection.hunks` | TS field | `tugdeck/src/lib/changeset-types.ts` | [P09] |
| `FileEventSpan`, spans on `Record::FileEvent` | struct/field | `tugcast/src/changes_journal.rs` + `session_ledger.rs` | `#[serde(default)]` |
| span capture in `PendingCall`/`into_row` path | Rust | `tugcast/src/feeds/attribution.rs` | [P11] anchors from tool input |
| overlap verdict fn (`classify_contention` or similar) | Rust | `tugchanges-core` | [P14], consumed by `changes.rs` + tugcast `feeds/changeset.rs` |
| interactive-staging detection | TS | deck shell-routing layer (beside `lib/shell-line-classifier.ts` / the prompt-entry submit routing) | [P13] |
| `HUNK_DIFF_FLAGS`, `file_hunks` | const/fn | `tugchanges-core/src/hunks.rs` | [P16], Spec S06 |
| `ChangesetDraft.selection` → `Option<serde_json::Value>`; delete `ChangesetDraftSelection` | field/struct | `tugcast-core/src/types.rs` | [P15] |
| `FileDiffBody` (replaces `HunkElectionDiff`) | TSX | `tugdeck/src/components/tugways/tug-changes-list.tsx` | [P18], [P19] |
| `reconcileHunkElection` | TS fn | `tugdeck/src/lib/hunk-election.ts` | [P18]; called by `EntryFiles` **and** `FileDiffBody` |
| `collapsedHunks` rekeyed `Set<number>` → hunk id | TSX state | `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` | [P21], [L23] |
| `--tugx-diff-hunk-pin-top` | CSS custom property | `tugdeck/src/components/tugways/body-kinds/diff-block.css` | F9 (#m02-audit) |

---

### Documentation Plan {#documentation-plan}

- [x] `tuglaws/tracking-changes.md`: add Disclaim to the origins/consumers tables; document span capture, [P12] widening, and the hunk-level SHARED rule; note the partial-commit liveness consequence ([P08]). *(Disclaim rides the read side + the consumers table rather than the origins table — it writes no row, it deletes them.)*
- [ ] `tuglaws/design-decisions.md`: candidate global promotions after the plan lands (disclaim semantics; hunk-identity rule) — user's call at landing time.
- [x] **(M02A)** `tugchanges-core/src/hunks.rs` module doc: state Spec S06's agreement contract where the next reader of the id rule will look — the shared flags, the no-`-U<n>` rule, and the three differences that provably cannot move an id.
- [x] **(M02A)** `tuglaws/tracking-changes.md` §"Below the file: hunk election": add a sentence that the elections ride the draft selection as opaque JSON and that the wire projection must not narrow it ([P15]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | hunk parse/id/filtered-patch determinism; disclaim SQL; batch atomicity; anchor matching table | every engine step |
| **Integration (Rust)** | real-git commit tests in `commit.rs` (the existing `init_repo` pattern); CLI round trips in the `changes_cli` suite | partial staging, drift refusal, disclaim CLI |
| **Journal replay** | new record variants replay idempotently (the `session_ledger.rs` replay test pattern) | steps 1, 2, 13 |
| **App-test** | Changes card affordances end-to-end (`@covers` on touched sources; run via `just app-test-changed`) | disclaim button, divider/icons, hunk checkboxes |

#### What stays out of tests {#test-non-goals}

- No jsdom/mock-store render tests — banned pattern; deck behavior is covered by app-tests driving the real app.
- **(M02A)** No app-test for the hunk-election checkbox, the partial landing, the `N of M hunks` badge, or the [P19] diff-body unification — a session-entry row is not reachable from the harness, and `election` is `undefined` everywhere else, so an unattributed-row test cannot even fail on the component swap (#session-entry-wall). Covered by the hand-verification checklist in #step-11g per [P20] (HV7 for the swap, HV8 for the stale badge), with the mechanism that failed (the wire projection) covered by a Rust unit test in #step-11a. What *is* app-testable on an unattributed row, and is therefore written: `DiffBlock` mount identity and [P21]'s id-keyed collapse state.
- **(M02A)** No test that asserts a `git diff` invocation "contains the right flags" by inspecting an argument vector — it would pass while the ids still diverged. The cross-boundary id test (Spec S06) proves the thing that matters instead.
- No full app-test corpus runs — selection is derived (`just app-test-changed`); core tier only if an unscopeable surface is touched.
- No tests of git's own `apply` semantics — we test our filtered-patch construction and refusal paths, trusting git on application.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Steps 1–5 are dash pass 1 (Milestone M01), 6–11 dash pass 2 (M02), 11a–11g dash pass 3 (M02A), 12–16 dash pass 4 (M03).

**Milestone M01: Claim/Disclaim/Polish** {#m01-claim-disclaim-polish} · **Milestone M02: Hunk-level landing** {#m02-hunk-landing} · **Milestone M02A: Close the loop on M02** {#m02a-close-the-loop} · **Milestone M03: Spans + hunk-aware SHARED** {#m03-spans-shared}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Atomic batch claim record | done | adfdd559c |
| #step-2 | Disclaim backend + CLI | done | 2b5d72032 |
| #step-3 | Disclaim frontend | done | fa27a9a0a |
| #step-4 | Icons + metadata divider | done | fa27a9a0a |
| #step-5 | M01 integration checkpoint | done | N/A (verification only) |
| #step-6 | Hunk model in tugchanges-core | done | d6bc72b48 |
| #step-7 | Hunk ids on the diff wire | done | b288714d2 |
| #step-8 | Partial staging in commit | done | 7c81af548 |
| #step-9 | Hunk election UI + draft selection | done | 65eaadd23 |
| #step-10 | file stage verb + shell steering | done | eca819ad5 |
| #step-11 | M02 integration checkpoint | done | 92d3cd2e3 |
| #step-11a | Carry the election through the draft projection | done | 1bb9a3e19 |
| #step-11b | One diff spelling for hunk identity | done | eff9287fd |
| #step-11c | One diff-body component | done | 41c80f2be |
| #step-11d | Election reconciliation + control affordances | done | 7ad7acd3d |
| #step-11e | Diff-block CSS de-duplication | done | f5ccee427 |
| #step-11f | Disclaim storage-form spike | done | e67da36f4 |
| #step-11g | M02A integration checkpoint | done — HV1–HV8 automated | 36f89022a |
| #step-12 | Schema v2: spans table | done | a889ff720 (squashed) |
| #step-13 | Span capture | done | a889ff720 (squashed) |
| #step-14 | Hunk-aware contention verdict | done | a889ff720 (squashed) |
| #step-15 | Contention UI + default election | done | a889ff720 (squashed) |
| #step-16 | M03 integration checkpoint | done — live-db migration pending the user's build | a889ff720 (squashed) |

#### Step 1: Atomic batch claim record {#step-1}

**Commit:** `tugcast(changes-rework): atomic batch claim via one fe_batch journal record`

**References:** [P01] Batch claim atomic, Risk R01, (#claim-flow)

**Artifacts:** `Record::FileEventBatch`, `SessionLedger::record_file_events`, `do_changeset_claim` using it.

**Tasks:**
- [ ] Add `Record::FileEventBatch { rows: Vec<FileEventRow> }` (serde tag `"fe_batch"`) to `tugcast/src/changes_journal.rs`; classify `shapes_rows() == true`.
- [ ] Add `SessionLedger::record_file_events(&self, rows: &[FileEventRow])` in `session_ledger.rs`; in `apply_journal_record`, apply the batch inside an explicit SQLite transaction over `insert_file_event` (all rows or none; the per-row `ON CONFLICT DO NOTHING` semantics are preserved within the batch).
- [ ] In `do_changeset_claim` (`feeds/agent_supervisor.rs`), collect the `FileEventRow`s (unchanged construction, shared `claim:{at}` tool_use_id), issue one `record_file_events` call, and set `claimed` to the full count on success / `0` on error (warn as today).

**Tests:**
- [ ] Ledger unit test: a batch of 3 rows lands atomically; replaying the same journal record is idempotent (PK collapse) — follow the existing replay-test pattern in `session_ledger.rs`.
- [ ] Ledger unit test: a batch containing a duplicate-PK row still succeeds (conflict-ignored), count reflects rows applied.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: Disclaim backend + CLI {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(changes-rework): changeset_disclaim verb — journaled ownership renunciation`

**References:** [P02] Disclaim semantics, [P03] Disclaim parity, [Q04], Spec S01, (#claim-flow)

**Artifacts:** `Record::Disclaim`, `SessionLedger::disclaim_file_ownership`, supervisor verb + dispatch, `tugutil changes disclaim`.

**Tasks:**
- [ ] Add `Record::Disclaim { project_dir, session_id, paths }` (tag `"fe_disclaim"`, `shapes_rows() == false`) and its applier: `DELETE FROM changes.file_events WHERE project_dir = ?1 AND tug_session_id = ?2 AND file_path IN (…)` — model on `sever_file_ownership_sql`.
- [ ] Add `SessionLedger::disclaim_file_ownership(project_dir, paths, session_id) -> Result<usize, LedgerError>` (no-op on empty paths, like sever).
- [ ] In `feeds/agent_supervisor.rs`: `ChangesetDisclaimPayload` + parser (same shape/validation as claim), `"changeset_disclaim"` dispatch arm, `do_changeset_disclaim` (guards: open project, ledger; map each file through `repo_relative_key` with skip-and-warn; delete; `changeset_all_bump().notify_one()`; reply per Spec S01), `send_changeset_disclaim_err`.
- [ ] `tugutil/src/changes.rs::run_disclaim` mirroring `run_claim` (POST `{"action":"changeset_disclaim", …}` to `/api/tell`); register `changes disclaim <paths…>` in `tugutil/src/cli.rs` beside claim.

**Tests:**
- [ ] Ledger unit test: disclaim deletes exactly the named session's rows for the named paths (other sessions' and other paths' rows survive); journal-replay idempotent.
- [ ] Supervisor/CLI integration test in the existing `changes_cli` suite: claim then disclaim round trip; disclaimed file re-buckets as `unattributed`; disclaiming one owner of a two-owner path leaves the other as sole (non-shared) owner.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugutil -p tugchanges-core`

---

#### Step 3: Disclaim frontend {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(changes-rework): per-row Disclaim affordance on session files`

**References:** [P02], [P03], Spec S01, State Zone Mapping (#state-zone-mapping), (#claim-flow)

**Artifacts:** verb-store disclaim state + hook, controller method, per-row button on session-entry files.

**Tasks:**
- [ ] `changeset-verb-store.ts`: `DisclaimState` (mirror `ClaimState` including the shortfall-as-error rule against `requested`), `_disclaims`/`_disclaimInflight` maps, `disclaim(entryKey, projectDir, sessionId, files)`, `_onControl` arms for `changeset_disclaim_ok`/`_err`, `disclaimState`/`clearDisclaim`, `useChangesetDisclaim`.
- [ ] `changes-route-controller.ts`: `disclaim(paths: string[])` beside `claim`.
- [ ] `tug-changes-list.tsx`: new props `onDisclaimFile?: (path: string) => void` and `disclaimPending?: boolean`; render a per-row icon button (subtype `icon`, size `2xs`, emphasis `outlined`, role `accent`, `data-testid="tug-changes-list-disclaim"`, title `Disclaim this file from this session`) in the row-trailing span for `entry.kind === "session"` files only — structurally the mirror of the existing claim button.
- [ ] `session-changes-view.tsx`: wire `onDisclaimFile={(path) => changesController.disclaim([path])}` and `disclaimPending`; extend `claim-error-notice-controller.tsx` to surface disclaim errors with the same sticky-bulletin mechanics.

**Tests:**
- [ ] New app-test (with `@covers` for `tug-changes-list.tsx`, `changeset-verb-store.ts`, `changes-route-controller.ts`): an attributed file's Disclaim click moves it to the unattributed section on the next recompute.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 4: Icons + metadata divider {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(changes-rework): claim/disclaim corner icons; one metadata divider per row`

**References:** [P04] Icons, [P05] Metadata divider, (#row-rendering)

**Tasks:**
- [ ] In `tug-changes-list.tsx`: import `CornerDownLeft, CornerUpRight` from `lucide-react`; use `CornerDownLeft` for the per-row claim and `Claim all` buttons, `CornerUpRight` for the Step-3 disclaim button; drop the `CornerUpLeft` import.
- [ ] Wrap the badge/provenance/hint spans in `FileIdentity` in `<span className="tug-changes-list-file-meta">`, rendered only when at least one child is non-null.
- [ ] In `tug-changes-list.css`: new `.tug-changes-list-file-meta { display: inline-flex; align-items: baseline; gap: 8px; flex-shrink: 0; padding-left: var(--tug-space-md); border-left: 1px solid var(--tug7-element-global-border-normal-muted-rest); }`; remove `padding-left`/`border-left` from `.tug-changes-list-file-provenance` (keep its typography).

**Tests:**
- [ ] Extend the Step-3 app-test (or the existing changes-card app-test this file's `@covers` resolves to): assert a hint-only row and a provenance row each render exactly one `.tug-changes-list-file-meta` wrapper, and a metadata-free row renders none.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 5: M01 integration checkpoint {#step-5}

**Depends on:** #step-1, #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** Milestone M01, (#success-criteria)

**Tasks:**
- [ ] Verify claim/disclaim round trips in the running app (claim all → one atomic batch; disclaim → unattributed; disclaim on a shared file → other side sole owner).

**Tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] Both green; visual pass on the Changes shade (icons, dividers).

---

#### Step 6: Hunk model in tugchanges-core {#step-6}

**Commit:** `tugchanges-core(changes-rework): hunk parse, content identity, filtered-patch builder`

**References:** [P06] Hunk identity, [Q01], Spec S02, (#commit-engine)

**Artifacts:** `tugchanges-core/src/hunks.rs` per Spec S02.

**Tasks:**
- [ ] Implement `parse_hunks` over one file's unified diff text (input shape: what `git diff --no-color -- <path>` emits; reuse/extend the `@@`-walking in `git.rs::parse_diff_chunk` rather than duplicating its line handling — `DiffFile.unified` already retains the verbatim chunk).
- [ ] Implement `hunk_id` ([P06]: SHA-256 over body lines excluding the `@@` header, hex, 16 chars, `#N` ordinal on duplicates) and `filtered_patch` (original `---`/`+++` header + selected hunks, new-side starts recomputed by cumulative delta over included hunks; `HunkDrift` on unknown ids).

**Tests:**
- [ ] Unit: id stability under other-hunk drift (same body, shifted `@@` numbers → same id); id change on body change; duplicate-hunk ordinals; a `\ No newline at end of file` marker rides its hunk's body (through parse, id, and `filtered_patch`) without counting as a body line for offset math.
- [ ] Unit: `filtered_patch` of hunks {1 of 3}, {2,3 of 3}, {all}, {none→error}, and a real-git application test: build a repo, make a 3-hunk change, filter to hunk 2, `git apply --cached`, assert `git diff --cached` contains exactly hunk 2's lines.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core`

---

#### Step 7: Hunk ids on the diff wire {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast(changes-rework): serve hunk ids with per-file diffs`

**References:** [P06], Spec S02, (#hunk-read-side)

**Tasks:**
- [ ] Locate the server side of the per-file diff the Changes card's inline diff consumes (the deck's `lib/changeset-diff-store.ts` / `lib/git-diff-store.ts` descriptors resolve to tugcast's git feed, `tugcast/src/feeds/git.rs`, which delegates parsing to tugchanges-core). Attach each served file-diff's hunk id list (Spec S02 ids, in hunk order) as an additive field on the diff response payload.
- [ ] Deck: thread the ids through the diff store snapshot types so the diff body can key hunks; no rendering change yet.

**Tests:**
- [ ] Rust unit on the feed serializer: ids present, ordered, matching `hunks::hunk_id` of the same text.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 8: Partial staging in commit {#step-8}

**Depends on:** #step-6

**Commit:** `tugchanges-core(changes-rework): hunk-elected landing via git apply --cached`

**References:** [P07] Partial staging, [P08] Liveness consequence, Spec S02, Spec S03, (#commit-engine)

**Artifacts:** `CommitOptions.hunks`, `CommitError::HunkDrift`, the partial branch of `stage_and_commit`, wire + CLI plumbing.

**Tasks:**
- [ ] Extend `CommitOptions` with `hunks: Option<BTreeMap<String, Vec<String>>>`; absent/empty → existing code path untouched.
- [ ] Partial branch per [P07]: index-clean guard (`git diff --cached --quiet`; on failure, typed `Other` error naming the staged paths from `git diff --cached --name-only`); `git add --` the whole-file subset (existing `stageable_paths` rules); per partial file, `git diff --no-color --no-ext-diff -- <path>` → `parse_hunks` → `filtered_patch` → `git apply --cached` via stdin (reuse the child-process shape of `file_probe.rs::git_apply`); `git commit -m <msg>` with **no** pathspec; on any post-staging failure, `git reset -- <all staged paths>` (whole-file ∪ partial) before returning.
- [ ] Map `HunkDrift` to `CommitError::HunkDrift { path, ids }` (a refusal-class error: nothing committed; CLI exit 1 with a `hunk drift:` prefix — Spec S03).
- [ ] `feeds/changeset.rs::run_changeset_commit` + the `changeset_commit` payload parser in `agent_supervisor.rs`: accept optional `hunks`, validate keys ⊆ `files`, pass through.
- [ ] `tugutil commit --hunks <file|->` parsing the Spec-S03 JSON map.

**Tests:**
- [ ] `commit.rs` integration (real git, `init_repo` pattern): 3-hunk file, elect hunk 2 → `git show HEAD` contains hunk 2 only, worktree still dirty with hunks 1+3, `left_behind` re-bucketing runs; mixed landing (one whole file + one partial file) commits both correctly; drift election refuses with nothing staged (assert `git diff --cached` empty after refusal — including the mixed case where a whole file was already `git add`-staged before the partial file's drift surfaced); dirty-index precondition refuses; a `hunks` key naming an untracked/created path refuses.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core -p tugcast -p tugutil`

---

#### Step 9: Hunk election UI + draft selection {#step-9}

**Depends on:** #step-7, #step-8

**Commit:** `tugdeck(changes-rework): per-hunk election checkboxes riding the draft selection`

**References:** [P09] Selection hunks, Spec S03, State Zone Mapping (#state-zone-mapping)

**Tasks:**
- [ ] `changeset-types.ts`: add `hunks?: { [path: string]: string[] }` to `ChangesetDraftSelection`, and extend the runtime validator `isOptionalDraftSelection` to accept it (a present `hunks` must be a record of string arrays; absent stays valid).
- [ ] Render a per-hunk election control in the inline diff body for session-entry files (the diff body renders through `DiffBlock` from `body-kinds/diff-block` inside `tug-changes-list.tsx`'s expanded-file branch; key controls by the Step-7 server ids). Compose existing Tug components for the control — never hand-roll. **No hunk controls on created/untracked files** — their wire diff is synthesized and the engine refuses elections on them ([P07]); they stage whole or not at all.
- [ ] Toggle writes go through the draft write path on settle (the same `changeset-draft-store.ts` route file dispositions use — `selection` rides `tugutil draft set` / the `/api/draft` POST); a file with a hunk subset elected renders its row as partially-included.
- [ ] The commit gesture assembles `hunks` from the draft selection and sends it on `changeset_commit` (`changeset-verb-store.ts::commit` gains the optional field; `commit-mode-controller.ts` / `session-changes-view.tsx` thread it).

**Tests:**
- [ ] App-test (`@covers` the touched deck files): expand a 2-hunk file, deselect one hunk, land, assert the commit's numstat reflects the partial change and the tree stays dirty with the remainder.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 10: file stage verb + shell steering {#step-10}

**Depends on:** #step-6

**Commit:** `tugutil(changes-rework): file stage verb; steer interactive -p invocations to the Changes shade`

**References:** [P13] Shell steering, Spec S05 (receipt precedent), (#context)

**Tasks:**
- [ ] `tugutil file stage --patch <file|->`: validate with `git apply --check --cached`, then `git apply --cached`; reuse `file_probe.rs`'s `git_apply`/`patch_targets` helpers; print a staged-paths summary (no `TUG-FILE-RECEIPT` — staging moves no working-tree bytes, and a receipt would mint a false `modified` row). Register in `tugutil/src/cli.rs`.
- [ ] Deck: at the shell-routing layer (the routing that dispatches `$`/auto-routed lines — beside `lib/shell-line-classifier.ts` and the prompt-entry submit routing; there is no `lib/bang-commands.ts`, the bang/route dispatch lives in the prompt-entry path), detect `git (add|commit|stash|checkout|restore|reset)` invocations carrying `-p`/`--patch`/`--interactive` and bare `git commit` without `-m`/`-F`; instead of executing, render a notice block: interactive staging doesn't work in the block shell (stdin is `/dev/null`) and hunk staging lives in the Changes shade. Detection is a literal-token scan of the parsed words — no execution, no grammar changes.

**Tests:**
- [ ] Rust: `file stage` stages a valid patch (assert `git diff --cached`), refuses a non-applying one with git's stderr, leaves the worktree bytes untouched either way.
- [ ] Deck unit-level coverage via the routing layer's existing test seam if present; otherwise the app-test in #step-11 covers the steering row.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 11: M02 integration checkpoint {#step-11}

**Depends on:** #step-8, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** Milestone M02, (#success-criteria)

**Tasks:**
- [ ] End-to-end in the running app: edit a file in two places, elect one hunk, land, confirm the remainder stays dirty and re-buckets ([P08] — it will read `unattributed` after the partial commit; expected, documented).
- [ ] Type `git add -p` in the `$` route → steering notice, nothing executed.

**Tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] Both green.

---

#### Step 11a: Carry the election through the draft projection {#step-11a}

**Depends on:** #step-11

**Commit:** `tugcast(changes-rework): the draft selection is opaque on the wire`

**References:** [P15] Opaque selection, [P09] Selection hunks, Risk R06, (#m02-audit) F1, (#landing-path)

**Artifacts:** `ChangesetDraft.selection` as `Option<serde_json::Value>`; `ChangesetDraftSelection` deleted; a projection round-trip test.

**Tasks:**
- [ ] In `tugrust/crates/tugcast-core/src/types.rs`: change `ChangesetDraft.selection` to `Option<serde_json::Value>` (keep `#[serde(default, skip_serializing_if = "Option::is_none")]`) and delete the `ChangesetDraftSelection` struct. `serde_json` is already a real dependency of `tugcast-core` — no manifest change.
- [ ] In `tugrust/crates/tugcast/src/feeds/changeset.rs::draft_from_row`: deserialize into `serde_json::Value`. Keep the existing `.ok()` so a hand-mangled row still reads as no overrides rather than poisoning the snapshot; keep the comment saying so.
- [ ] Fix the `ChangesetDraft` struct literals in `tugcast-core/src/types.rs`'s tests that the field-type change breaks.
- [ ] Confirm no other Rust reader is affected: a grep for `ChangesetDraftSelection` across `tugrust/crates/` should come back empty afterwards, and nothing reads `.include` / `.exclude` in Rust today.
- [ ] Leave the deck untouched — `changeset-types.ts` keeps the typed interface and `isOptionalDraftSelection`, which is the correct home for the shape guard.

**Tests:**
- [ ] Rust unit (in `tugcast-core/src/types.rs`, beside the existing `ChangesetDraft` serde tests): a selection JSON carrying `include`, `exclude`, **and** an unknown key survives the projection with the unknown key intact. Name it for the invariant, not the field — this test exists to catch anyone re-narrowing the projection, which is how F1 happened.
- [ ] Rust unit: a malformed selection string still projects to `None`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcast-core`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 11b: One diff spelling for hunk identity {#step-11b}

**Depends on:** #step-11

**Commit:** `tugchanges-core(changes-rework): one diff spelling for hunk identity, pinned by a cross-boundary test`

**References:** [P16] Canonical diff spelling, [P17] Id contract boundaries, [P06] Hunk identity, Spec S06, Risk R07, (#m02-audit) F2 F3

**Artifacts:** `HUNK_DIFF_FLAGS`, `file_hunks` in `tugchanges-core/src/hunks.rs`; `feeds/git.rs` carrying the shared flags; the cross-boundary id test.

**Tasks:**
- [ ] Add to `tugrust/crates/tugchanges-core/src/hunks.rs`: `pub const HUNK_DIFF_FLAGS: &[&str] = &["--no-color", "--no-ext-diff"];` and `pub fn file_hunks(repo_root: &Path, path: &str) -> Result<Vec<Hunk>, String>` running `git diff <HUNK_DIFF_FLAGS> -- <path>` through the existing `git::git_stdout` and parsing with `parse_hunks`. Re-export both from `lib.rs` beside the existing `hunks` exports.
- [ ] Record Spec S06's contract in the `hunks.rs` module doc: the shared flags, the no-`-U<n>` rule ([P17]), and the three differences that provably cannot move an id.
- [ ] In `tugrust/crates/tugcast/src/feeds/git.rs`, splice `HUNK_DIFF_FLAGS` into all three `git diff` invocations — `run_git_diff_against`, `synthesize_untracked_diff`, and `fetch_git_diff`. They currently pass `--no-color` by hand and no `--no-ext-diff`.
- [ ] In `tugrust/crates/tugchanges-core/src/commit.rs`, replace the partial branch's hand-spelled `git diff --no-color --no-ext-diff -- <path>` + `parse_hunks` pair with a call to `file_hunks`.

**Tests:**
- [ ] Rust integration in `feeds/git.rs` (Spec S06): build a real repo, commit a file, dirty it in two well-separated regions so git emits ≥2 hunks, then compare the wire's ids (`fetch_git_diff_with_untracked` → `parse_git_diff` → `.hunks`) against the engine's (`tugchanges_core::file_hunks` → ids) and assert element-for-element equality. Note for the author: edits ~60 lines apart are needed — git merges hunks whose gap is within twice the context width, and 30-line separation was empirically not enough during M02.
- [ ] Rust unit: `file_hunks` on a path with no changes returns an empty vec rather than erroring.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core -p tugcast`

---

#### Step 11c: One diff-body component {#step-11c}

**Depends on:** #step-11a

**Commit:** `tugdeck(changes-rework): one diff-body component — stable mount identity across the hunk-count boundary`

**References:** [P19] One diff body, [P21] Collapse by id, [L26] Mount identity, [L23], State Zone Mapping (#state-zone-mapping), (#m02-audit) F4

**Artifacts:** `FileDiffBody` replacing `HunkElectionDiff` in `tug-changes-list.tsx`; `collapsedHunks` rekeyed by hunk id in `diff-block.tsx`.

**Tasks:**
- [ ] In `tugdeck/src/components/tugways/tug-changes-list.tsx`, replace `HunkElectionDiff` with `FileDiffBody`, taking the same `{ file, election? }` props. It calls `useResponderForm` unconditionally (hooks may not be conditional) and passes `renderHunkAffordance` to `DiffBlock` only when `election !== undefined && ids.length > 1`.
- [ ] Collapse `fileBlockBody`'s two returns into one `<FileDiffBody file={file} election={election} />` so the diff case renders a single component type regardless of hunk count. Leave the `error` / `loading` / `no diff` / `binary` branches returning `<p>` — those are genuinely different entities and predate this plan.
- [ ] Verify the [L26] triple by inspection and say so in the commit body: **key** (the row keys by `file.path`, unchanged), **component type** (now one), **renderer reference** (`fileBlockBody` is a plain function inlined at the call site, not a renderer map — no lambda-identity hazard).
- [ ] Keep the `ResponderScope` + `responderRef` wrapper `<div>` unstyled, rendered **unconditionally** (a wrapper that appears only when there is an election is the same [L26] breach one level down), and confirm it does not disturb the diff's sticky pin chain (the pin's containing block is `.tugx-diff-hunk`, which is unaffected by an ancestor static div).
- [ ] Rekey `DiffBlock`'s `collapsedHunks` from `Set<number>` to the hunk's [P06] id ([P21]), falling back to the index when the diff carries no `hunkIds` (created and binary files). `toggleHunk` and the `collapsedHunks.has(...)` read both move to the same key.

**Tests:**
- [ ] Extend `tests/app-test/at0333-changes-hunk-ids.test.ts`: with the file's row expanded, collapse one hunk band, then rewrite the file so a **new hunk appears above** the collapsed one, wait for the re-composed diff, and assert the *same* band (matched by `data-hunk-id`, not by index) is still collapsed and the diff's `data-slot="diff-body"` element is the same node (capture it via a marker attribute set before the transition).
- [ ] **What this test does and does not cover — state it in the test's docblock.** It pins `DiffBlock` mount identity and [P21]'s keying, and it fails on today's code because of the rekey. It is **not** the F4 regression guard: `election` is `undefined` on every entry kind but `session`, so on the unattributed row the harness can reach, `fileBlockBody` returns `DiffBlock` both before and after this step's change. F4's guard is the [L26] triple stated in the commit body plus HV1–HV4 (#step-11g) — the same #session-entry-wall that [P20] already accepts, one level down. Do not let the test's presence read as coverage of the component swap.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 11d: Election reconciliation + control affordances {#step-11d}

**Depends on:** #step-11c

**Commit:** `tugdeck(changes-rework): reconcile stale hunk elections for display; drop dead affordance code`

**References:** [P18] Display reconciliation, Risk R08, (#m02-audit) F5 F6 F7 F8

**Artifacts:** `tugdeck/src/lib/hunk-election.ts` (`reconcileHunkElection`); both the badge and the checkboxes reading it; three deletions.

**Tasks:**
- [ ] New `tugdeck/src/lib/hunk-election.ts` exporting one pure function `reconcileHunkElection(ids: readonly string[], persisted: readonly string[] | null): { elected: readonly string[]; partial: { elected: number; total: number } | null; stale: boolean }`. `persisted === null` → whole file. Otherwise intersect with `ids`; an empty intersection is `stale: true` with `elected = ids` (every box checked) and no `partial` count. It lives in `lib/`, **not** in `tug-changes-list.tsx` — that module does `import "./tug-changes-list.css"` at its head and would drag the component graph into a pure-logic test ([P18]).
- [ ] Call it in **both** places, which is what makes them unable to disagree ([P18]): `FileDiffBody` uses `elected` for the checkboxes, and `EntryFiles` uses `partial`/`stale` for the badge. `EntryFiles` keeps computing the badge — it renders on **collapsed** rows too, where no diff body is mounted, so the computation cannot simply move into the body. It already has the ids in hand (`diffFile.hunks`); today it reads the raw `hunkElection` map against `diffFile.hunks.length` inline just above the `<ChangesFileRow>` return, and that inline rule is what gets replaced by the call.
- [ ] Render the stale case honestly ([P18]): when `stale` is true the row's badge reads `stale election` instead of `N of M hunks`, with a title saying the elected hunks are no longer in the file and the landing will refuse until they are re-elected. `ChangesFileRow`/`FileIdentity` take the badge state rather than a bare `{elected,total}` pair.
- [ ] Leave `ChangesRouteController.commit()` sending the **unreconciled** persisted election — [P18]'s deliberate split. Add a one-line comment there saying the engine's `CommitError::HunkDrift` is the authority, so a future reader does not "fix" it into silently dropping ids.
- [ ] Delete the `onClick={(event) => event.stopPropagation()}` and its comment from the `.tugx-diff-hunk-affordance` span in `diff-block.tsx` (F6 — the cue's handler is a sibling and `TugCheckbox` dispatches through the responder chain).
- [ ] Delete the toggle-bindings `useMemo` (F7); build the bindings object plainly. `useResponderForm` reads them through a ref, so there is nothing to memoize and the memo's failure was load-bearing.
- [ ] Put a `title` explaining why the sole remaining hunk cannot be unchecked on the wrapping `.tugx-diff-hunk-affordance` span, not on `TugCheckbox` — `TugCheckboxProps` declares no `title`, and widening a shared component for one caller is the wrong trade (F8).

**Tests:**
- [ ] Pure-logic `bun:test` in `tugdeck/src/lib/__tests__/hunk-election.test.ts` over `reconcileHunkElection`: no drift, partial drift, total drift (asserting `stale` and every id elected), the `null` whole-file case, and an empty-`ids` file. No DOM, no component import.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/hunk-election.test.ts && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 11e: Diff-block CSS de-duplication {#step-11e}

**Depends on:** #step-11c

**Commit:** `tugdeck(changes-rework): one pin chain, one band surface in the diff hunk header`

**References:** [L20] Token scoping, (#m02-audit) F9 F10

**Tasks:**
- [ ] In `tugdeck/src/components/tugways/body-kinds/diff-block.css`, hoist the duplicated three-term sticky `calc()` into a single custom property (e.g. `--tugx-diff-hunk-pin-top`) declared once on `.tugx-diff-hunk`, and have both `.tugx-diff-hunk-header` and `.tugx-diff-hunk-lead` reference it. Keep the existing explanatory comment on the definition, not on both uses.
- [ ] Stop `.tugx-diff-hunk-lead` hardcoding `var(--tug7-surface-global-primary-normal-sunken-rest)`. The band exists to be visually continuous with the `TugCue` inside it, so make that relationship explicit: either give the band `background: transparent` and let the cue paint the whole row (preferred if the cue can be made to fill the band), or declare a `--tugx-diff-hunk-band-bg` alias on the diff-block side with a comment naming the cue's muted role as the value it must track. Do not reference `--tugx-cue-*` — that would be a real [L20] breach.
- [ ] Re-run the token lint; it was zero-violation before this step and must stay so.

**Tests:**
- [ ] None beyond the checkpoint — this is appearance-only, and the app-test corpus already renders diffs on every changes-card suite.

**Checkpoint:**
- [ ] `cd tugdeck && bun run audit:tokens lint` (zero violations)
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 11f: Disclaim storage-form spike {#step-11f}

**Depends on:** #step-11

**Commit:** `tugcast(changes-rework): pin disclaim against legacy file_path storage forms`

**References:** [P02] Disclaim semantics, (#m02-audit) F11, (#claim-flow)

**Tasks:**
- [ ] **Spike first, fix only if it fails.** Add a ledger test that seeds a `file_events` row whose `file_path` is in the legacy *absolute* form for a session, then calls `SessionLedger::disclaim_file_ownership` with the repo-relative key, and asserts the row is gone. M01's existing tests seed via claim, which writes the repo-relative form, so none of them would catch an under-delete.
- [ ] If the test passes, keep it as a drift guard and stop — the opportunistic lazy backfill (`backfill_file_events_repo_relative`, guarded by `backfill_marker` in `feeds/changeset.rs`) is doing the work and the test now says so.
- [ ] If it fails, extend `disclaim_file_ownership_sql` to match the same set of spellings the read side reconciles, and mirror the change into `sever_file_ownership_sql` if it has the same gap — [L27]'s "fix the class, not the instance" applies to SQL predicates too.
- [ ] While in the file: the disclaim SQL mixes numbered (`?1`, `?2`) and anonymous (`?`) placeholders. It is correct — SQLite numbers an anonymous parameter one past the highest assigned — but it is correct by a rule nobody reading it will recall. Renumber the `IN` placeholders explicitly (`?3`, `?4`, …) or convert the whole statement to anonymous.

**Tests:**
- [ ] The seeded legacy-form disclaim test above (kept either way).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 11g: M02A integration checkpoint {#step-11g}

**Depends on:** #step-11a, #step-11b, #step-11c, #step-11d, #step-11e, #step-11f

**Commit:** `N/A (verification only)`

**References:** Milestone M02A, [P20] Hand verification, (#success-criteria), (#session-entry-wall)

**Tasks:**
- [ ] Build and launch a debug instance from the dash worktree (`just app-debug`) and walk the hand-verification checklist below. This is the only coverage the session-entry affordance gets ([P20]) — run it deliberately, not as a glance.
- [ ] **HV1 — the election settles.** In a real session with attributed files, open the Changes shade, expand a file with ≥2 hunks, uncheck one. The box **stays** unchecked. Reload the card (Maker ▸ Reload) and it is still unchecked.
- [ ] **HV2 — the row tells the truth.** That row shows `N of M hunks` with N matching the boxes.
- [ ] **HV3 — the last hunk is protected.** Uncheck down to one; the remaining box is disabled and its tooltip says why.
- [ ] **HV4 — the partial landing works.** Land from the shade. `git show HEAD` contains only the elected hunk; `git status` still shows the file dirty with the remainder; the receipt row appears in the transcript.
- [ ] **HV5 — drift refuses honestly.** Elect a hunk, edit that hunk's content in the editor, then land. The refusal names the path and reads `hunk drift:` — it does not land a partial commit and does not leave anything staged (`git diff --cached` empty).
- [ ] **HV6 — whole-file is still whole.** A file with every hunk checked lands whole and writes no `hunks` on the wire (confirm via the dev log or by the commit's content).
- [ ] **HV7 — the diff body survives the hunk-count boundary ([P19]/[L26]).** With a *session-entry* file's row expanded and ≥2 hunks, collapse one band and scroll the diff; then edit the file down to one hunk and back to two. The body does not remount: the collapsed band is still collapsed, the scroll holds. This is F4's only real guard — the app-test in #step-11c cannot reach the component swap (#session-entry-wall).
- [ ] **HV8 — a fully-stale election says so ([P18]).** Elect one hunk of two, then rewrite the file so neither elected id survives. The row reads `stale election`, every box is checked, and the tooltip explains it. It does **not** read as a plain whole-file landing.
- [ ] Record the checklist outcome in the dash round's summary so the verification is durable, not just remembered.
- [ ] Land the #documentation-plan items marked (M02A).

**Tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] All four green, and HV1–HV8 all pass. A failure in any HV item is a blocker for M03, not a note — M03 consumes the same ids and the same selection column.

---

#### Step 12: Schema v2 — spans table {#step-12}

**Commit:** `tugcast(changes-rework): changes.db v2 — file_event_spans (additive)`

**References:** [P10] Spans table, Spec S04, Risk R02, Risk R10, (#rollout)

**Tasks:**
- [ ] Execute the complete satellite list in #rollout: version constant 1→2, `CHANGES_MIGRATIONS` entry, idempotent DDL in `bootstrap_changes_schema`, `file_event_spans` added to the quarantine `salvage_into` table list, version-gate test updates, read-side spans query + seeded test DDL updates in `tugchanges-core` (`ledger.rs`, `changes.rs` tests).
- [ ] **Walk every applier arm in `apply_journal_record` that touches `file_events` and give each one its spans clause** (Risk R10) — not only the three the audit named. As of today that is `DeleteSession`, `Sever`, `Disclaim`, `Rewrite` (both branches: UPDATE the spans' `file_path` when the parent is renamed, delete the legacy row's spans when it merges into a survivor), and `PurgeOutOfRepo`. The bulk repo-relative backfill runs `Rewrite`, so the rename branch is not a rare path.
- [ ] Add `FileEventSpan { seq, kind, anchor }` and the `#[serde(default)] spans` field on `Record::FileEvent` (and on `FileEventBatch` rows) with insertion in `apply_journal_record`.

**Tests:**
- [ ] Version-gate tests: on-disk v1 migrates to v2; on-disk v3 refuses writes; sidecar stamps.
- [ ] Journal-compat test: a v1-era `"fe"` line without `spans` parses and applies (serde default).
- [ ] Parent-mutation test (Risk R10): a row with spans survives a `Rewrite` with its spans attached to the new `file_path`; the merge-into-survivor branch leaves no orphan; `PurgeOutOfRepo` and `DeleteSession` leave no span rows behind. Assert on the spans table directly — an orphan is invisible from the read side, which is the whole hazard.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugchanges-core`

---

#### Step 13: Span capture {#step-13}

**Depends on:** #step-12

**Commit:** `tugcast(changes-rework): content-anchor span capture for exact tools and edit receipts`

**References:** [P11] Content anchors, Spec S04, Spec S05, [Q03], (#claim-flow)

**Tasks:**
- [ ] `feeds/attribution.rs`: retain size-capped anchor material from exact-tool inputs in `PendingCall` (Edit/MultiEdit: per-edit `old_string`/`new_string` hashes + capped `new_head`; Write/NotebookEdit: `whole`), and emit spans on the successful `tool_result`'s `FileEventRow` (riding the extended `Record::FileEvent`). Replay backfill (`origin='replay'`) carries the same anchors — the tool input replays.
- [ ] `tugutil file edit`: compute applied-hunk ids (Spec S02 identity over the post-apply `git diff` scoped to the receipt files) and add `hunks` to receipt ops (Spec S05); relay parses them into `kind='hunk'` spans on the minted `cmd` rows.
- [ ] `claim` rows record a single `whole` span (a claim is a whole-file assertion).

**Tests:**
- [ ] Relay-level test (existing attribution test patterns): an Edit frame mints a file event with matching insert/replace spans; a Write mints `whole`; a receipt with `hunks` mints hunk spans; anchor caps enforced (33rd anchor → `whole`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugutil`

---

#### Step 14: Hunk-aware contention verdict {#step-14}

**Depends on:** #step-12, #step-13

**Commit:** `tugchanges-core(changes-rework): hunk-aware SHARED — one overlap verdict, two readers`

**References:** [P12] Widening, [P14] One implementation, [P16] Canonical diff spelling, Spec S04, Spec S06, Risk R03, Risk R04, Risk R09, (#hunk-read-side)

**Tasks:**
- [ ] Implement the pure verdict fn in tugchanges-core per Spec S04 matching + [P12] widening: input `(hunks: &[Hunk], per_session_anchors)`, output per-session claimed-hunk sets + the shared boolean + the contested id set.
- [ ] Consume it in `changes.rs::compute_changes` (replacing the bare `!foreign_proof.is_empty()` for multi-owner paths; single-owner and span-less cases short-circuit to today's answers) and in tugcast `feeds/changeset.rs`'s `proof_owners` pass; both load spans only for paths with ≥2 proof owners (cost stays bounded by the dirty set).
- [ ] **Each reader gets its hunks from its own side's spelling** ([P14]): `changes.rs` calls `file_hunks` (sync); `feeds/changeset.rs` goes through the async `feeds/git.rs` diff — which carries `HUNK_DIFF_FLAGS` after #step-11b, so the ids agree by Spec S06's contract. Do not call `file_hunks` from the feed: it is `std::process::Command` on a runtime thread.
- [ ] Bound the added git cost (Risk R09): fetch a diff only for paths with ≥2 proof owners, and reuse a diff the card has already fetched for that path where one is available. `compose_snapshot` is the function that already traded a per-path `git log` for one `rev-parse` — do not hand the cost back.
- [ ] Extend the wire `ChangesetFile` with optional `own_hunks`/`contested_hunks` (additive; deck types in `changeset-types.ts`).

**Tests:**
- [ ] Verdict-fn unit table: disjoint anchors → not shared; overlapping → shared; one span-less owner → shared (file-level); ambiguous anchor → that owner widens; identical insertions by two sessions → contested.
- [ ] `changes.rs` integration: seed two sessions' rows + spans against a real repo with a two-region edit; assert the buckets and shared bits both ways.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core -p tugcast`
- [ ] Recompose timing on a repo with a contended dirty set is not visibly worse than before the step (Risk R09). A regression here is a blocker for the step, not a note.

---

#### Step 15: Contention UI + default election {#step-15}

**Depends on:** #step-9, #step-14

**Commit:** `tugdeck(changes-rework): SHARED only on true overlap; own-hunk default election; contested marks`

**References:** [P12], Spec S03, State Zone Mapping (#state-zone-mapping), (#row-rendering)

**Tasks:**
- [ ] The `shared` badge renders from the server's hunk-aware bit (no deck logic change — the server now sends fewer `shared: true`s); rows with `own_hunks` present and no contest render as normal attributed files.
- [ ] In the hunk-election view (Step 9), mark contested hunks (CSS class + title naming the other claimant sessions) and default-elect the session's `own_hunks` on files that have them (the default-selection rule for such files becomes "own hunks" instead of the all-or-nothing `!shared` exclusion; unelected contested hunks simply stay unstaged).
- [ ] Update the commit-mode/default-selection derivation (`commit-mode-controller.ts`, `session-changes-view.tsx` selection defaults) accordingly.

**Tests:**
- [ ] App-test: two sessions edit disjoint regions of one file (drive the second session's rows via `tugutil changes claim` + a seeded edit, or two relay sessions if the harness supports it); assert no SHARED badge, own-hunk default election, and a clean partial landing.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 16: M03 integration checkpoint {#step-16}

**Depends on:** #step-14, #step-15

**Commit:** `N/A (verification only)`

**References:** Milestone M03, (#success-criteria), (#rollout)

**Tasks:**
- [ ] Rebuild all binaries; confirm the live `changes.db` migrated to v2 (sidecar + `PRAGMA user_version` via `just db-inspect changes "PRAGMA user_version"`).
- [ ] Full doctrine pass on `tuglaws/tracking-changes.md` updates (#documentation-plan).

**Tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] Both green; the two-session disjoint-edit scenario shows no SHARED end-to-end.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Changes system with an atomic batch claim, a first-class disclaim verb at every layer, consistent row metadata rendering, hunk-level election and landing over `git apply --cached` that actually round-trips end to end, and span-based hunk-aware SHARED that contends only on true overlaps — landed in four dash passes (M01/M02/M02A/M03) from this plan.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria item verified by its named test or check.
- [ ] `cargo nextest run` green workspace-wide; `bunx vite build` green; `just app-test-changed` green after each pass.
- [ ] `tuglaws/tracking-changes.md` updated (disclaim, spans, hunk-aware SHARED, partial-commit liveness note).
- [ ] The M02A hand-verification checklist HV1–HV8 (#step-11g) passes on a real build — the Changes shade's hunk election settles, lands partially, and refuses drift honestly.

**Acceptance tests:**
- [ ] Step-8 partial-landing integration tests.
- [ ] Step-11a selection-projection round-trip test (an unknown key survives).
- [ ] Step-11b cross-boundary hunk-id agreement test (Spec S06).
- [ ] Step-11c `DiffBlock` mount-identity + id-keyed collapse test ([P21]).
- [ ] Step-11d `reconcileHunkElection` unit table ([P18]).
- [ ] Step-12 parent-mutation span test (Risk R10).
- [ ] Step-14 verdict-fn unit table.
- [ ] Step-15 two-session disjoint-edit app-test.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Carry-forward re-mint for a partial commit's remainder ([Q02]/[P08]).
- [ ] ~~"Disclaim all" bulk affordance~~ — shipped in M01.
- [ ] Reconcile the election on the *wire* as well as the display, so a stale id never reaches the engine ([P18] deliberately stops short; needs the controller to see the diff, which today lives in the per-entry `GitDiffStore`).
- [ ] Promote the session-entry hand-verification (#step-11g HV1–HV8) to an app-test if the harness ever grows a way to seed real ledger sessions ([P20]).
- [ ] Spans from `shell_ops`-parsed in-place editor commands (would require the grammar to model substitution effects — likely never worth it; [Q03]).
- [ ] Promoting disclaim semantics and hunk identity into `tuglaws/design-decisions.md` as global `[D##]` entries.

| Checkpoint | Verification |
|------------|--------------|
| M01 lands | #step-5 |
| M02 lands | #step-11 |
| M02A lands | #step-11g |
| M03 lands | #step-16 |
