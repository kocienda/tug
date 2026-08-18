<!-- devise-skeleton v5 -->

## The Dash Draft Contract, and a Clean Base at Creation {#draft-contract}

**Purpose:** Make the join land exactly the message that was authored for it — the draft written with `tugutil draft set` reaches the squash commit byte-for-byte, under one subject prefix, from any directory the write happened in. Then remove the cheapest source of landing failure at its origin: `dash create` ends with a report of (and an optional transplant of) whatever uncommitted work the base checkout holds.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-15 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-15, opus.** Reviewed `plan:330376766145508b`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document (first round), read against `tugutil/src/draft.rs`, `tugdash-core/src/ops.rs`, `tugcast/src/server.rs`, and `tugcast/src/feeds/draft_engine.rs`.
Verified before judging: the plan's central convergence claim holds — a `ChangesetEntry::Dash` inherits its enclosing project's `workspace_key` in `eligible_entries`, so the server, engine, and deck really do key dash drafts by the base root and the CLI is the lone dissenter, which makes [P01]/[P07] a finished migration rather than another tolerance layer.
Applied: **correctness** — Step 3 would have broken the exact usage this plan exists to fix, because `resolve_owner`'s derivation calls `dash_branch_name`, which reads `rev-parse --abbrev-ref HEAD` and needs a `tugdash/` result; substituting the base root before owner resolution would resolve `main` and send an ownerless `draft set` from a worktree to the session owner. Pinned the ordering and added the regression test that fails if it is done early. **Wire shape** — the plan hedged ("if the request shape needs a field"); it does: `DraftApiRequest` carries exactly two spelling slots (`project_dir`, `raw_project_dir`), both needed by the base root, so the worktree spelling has nowhere to ride. Named `superseded_project_dirs` and the handler change. **Edge case** — Step 6 said "copy every censused file's content", but the census is `git diff --name-only HEAD`, which lists *deletions*; carrying one means deleting the worktree copy, not reading a missing file. Added the deletion case and a `deleted` flag on `BaseDirtPath`. **Hole** — carried work is uncommitted by [P06] and lives only in the worktree that `remove_dash_worktree` deletes, recreating the very hazard `restore_plan_to_base` exists to prevent; asked, and the user chose the symmetric inverse, now [P08] and a new Step 7 with the no-overwrite refusal. **Accuracy** — Step 5 asked for a `.tug/worktrees/` exclusion that would be dead code (`.tug/` is gitignored, so `--exclude-standard` already covers it); Step 2's probe now takes the worktree spelling through the same canonical/raw cross-product the repo root gets, with `worktree_path`'s filesystem-probing behavior documented so it is not later read as a bug.
Deferred: nothing. The plan's two prior open questions were already resolved during authoring, and the one judgment call this round found was put to the user rather than parked.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The first real dash landing (`5964a0a19`, the dash-ui work) committed a message nobody wrote. `roadmap/join-assessment.md` recorded it as "the draft regeneration bug" — `tugutil draft set --owner dash:dash-ui` wrote one message, the landed commit carried a different auto-generated summary — and called it the most urgent unknown in the brief. The diagnosis is now done, and the name was wrong: **nothing regenerated the draft. The join never read it.** The full reconstruction is in [The forensic reconstruction](#forensic-reconstruction); the one-sentence mechanism: `tugutil draft set`, run from inside the dash worktree (which is where `dash-implement` runs it), keys the draft row by its **cwd** — the worktree path — while the join's reader `dash_draft_message` probes only the **base repository root** spellings. The row never matched, the join fell through `integrate_message`'s fallback chain, and the authored draft survives in the live ledger to this day as the proof. Every dash draft row in the machine ledger is worktree-keyed, so this is the standing behavior of every planned dash run, not a one-off.

The same incident landed a doubled subject — `tugdash(dash-ui): tugdash(dash-ui): …` — because `integrate_message` prepends `tugdash(<name>): ` unconditionally, including onto a body that already opens with it.

The second milestone is the join-assessment brief's "clean base at creation" item: `dash create` already cuts the worktree from the base branch *tip*, so the dash starts clean — but it says nothing about the uncommitted work it leaves sitting on the base, which later becomes either invisible divergence or the join's `base-dirt` refusal. The brief locked the shape: a **decision, not a veto** — create proceeds, reports what it left behind, and offers a transplant as an explicit act, defaulting to taking nothing.

#### Strategy {#strategy}

- Fix the read side first (prefix idempotence, then the reader's legacy probe plus the byte-for-byte invariant), because those changes are self-contained in `tugdash-core` and the tests they add are the safety net for the write-side change.
- Then move the write side: `tugutil draft set` resolves a dash owner's project key to the base repository root, with the old worktree spelling riding along as a superseded sibling — the same migration pattern the owner-key axis ([P03] in `tugutil/src/draft.rs`) already uses.
- No data migration: pre-fix rows belong overwhelmingly to dead dashes; the reader's bounded legacy probe covers any live one, and the write-side sibling sweep retires a row the moment its dash is touched again.
- Milestone 2 reuses a shipped engine: `adopt_plan_in` / `clean_base_plan_copy` / `BasePlanState` already transplant one file off the base with the rollback ordering worked out. Generalizing to the working set is an extension, not a new mechanism.
- Report before act: the base-dirt census lands first as pure reporting (no behavior change), the `--carry` transplant lands second on top of it.
- Nothing in this plan touches tugdeck. All coverage is at the Rust layer, where every path this plan changes is exercisable in scratch repos.

#### Success Criteria (Measurable) {#success-criteria}

- A draft written with `tugutil draft set --owner dash:<name>` from *inside the dash worktree* is the message `tugutil dash join <name>` lands, verbatim in the body, with exactly one `tugdash(<name>): ` subject prefix. (Rust integration test, Step 4.)
- `integrate_message` never produces a doubled prefix, whatever source the body came from — draft, description, or override. (Unit tests, Step 1.)
- A pre-fix draft row keyed by the worktree path is still found by the join. (Unit test on the reader's probe order, Step 2.)
- `dash create` on a dirty base reports the dirt (paths, classified tracked/untracked) in both human and `--json` output, and leaves it untouched by default. (Unit tests, Step 5.)
- `dash create <name> --carry` ends with the base checkout clean and the dash worktree holding the transplanted work uncommitted; a failed create leaves the base copies intact. (Unit tests, Step 6.)
- `cd tugrust && cargo nextest run` green — warnings are errors.

#### Scope {#scope}

1. `integrate_message` prefix idempotence (`tugrust/crates/tugdash-core/src/ops.rs`).
2. `dash_draft_message` probe order: add the dash-worktree spelling as a bounded legacy axis (`ops.rs`).
3. `tugutil draft set|show|clear` project-key resolution for dash owners (`tugrust/crates/tugutil/src/draft.rs`), plus the sibling sweep that supersedes worktree-keyed rows.
4. The byte-for-byte landing invariant, pinned by tests at the `integrate_message` and `join_in` layers.
5. Base-dirt census at `dash create`: report in `CreateOutcome` and CLI output; off-base warning.
6. `dash create --carry`: transplant the base's uncommitted working set into the dash worktree and restore the base.
7. `dash release`: hand the worktree's uncommitted work back to the base before teardown ([P08]).
8. Doctrine prose: the create-time report, the carry gesture, and the release hand-back in `tuglaws/dash-work-doctrine.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No tugdeck/UI changes. The Changes shade's draft surfaces already key by `workspace_key` through the server and are not part of the broken path.
- No migration pass over existing worktree-keyed rows in the live `changes.db` — the legacy probe and sibling sweep make one unnecessary ([P02]).
- No standalone `dash carry` verb for an existing dash. The brief's gesture is at creation; a later verb can reuse Step 6's engine if wanted.
- No interactive prompting at `create` (a `tugutil host ask` flow). Create is driven by skills and agents; it reports and honors flags.
- No change to the join preflight's `off-base` / `base-dirt` blockers themselves — create warns earlier; the blockers stay as the last line.
- Not the base-motion replay program or the dash lane's tactical layer — both remain with `roadmap/join-assessment.md`.

#### Dependencies / Prerequisites {#dependencies}

- `main` at or after `a36ec60f6` (the resolution-ladder review gate), which this plan's territory in `resolve.rs`/`ops.rs` assumes.
- The `tugid` owner-key machinery from `a4477d50b` (`dash_owner_key`, `legacy_owner_key`, the draft CLI's owner axis) — Step 3 extends its sibling pattern to the project axis.

#### Constraints {#constraints}

- **Warnings are errors** — `tugrust/.cargo/config.toml` enforces `-D warnings`.
- The CLI never canonicalizes paths; spelling canonicalization is the server's, through the [L29] gateway (`resolve_to_claude_form`). Step 3 changes *which directory* the CLI names, not how spellings are reconciled — see [P02].
- `tugutil draft` writes normally travel through `POST /api/draft`; tests use the `TUG_CHANGES_DB` direct-SQL fallback for isolation. Both write paths must key identically.
- Only the user commits on `main`. All work here rides a dash worktree via `dash-implement`.
- **Never probe `tugutil dash join <name> --resolve` or a real `dash join` against this repository** — joins land. Every test in this plan builds its own scratch repo in a tempdir.

#### Assumptions {#assumptions}

- `git rev-parse --git-common-dir` from inside a linked worktree names `<base>/.git`, so its parent is the base repository root. (Standard git behavior; Step 3's checkpoint exercises it.)
- The dash worktree's conventional location is `worktree_path(repo, name)` = `<repo>/.tug/worktrees/<name>` (`ops.rs`), which is the spelling pre-fix rows were keyed under after the server's [L29] canonicalization.
- Existing worktree-keyed rows in the live machine ledger belong to released dashes and are inert garbage; nothing in this plan needs to delete them.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`, `Milestone M##` labels, `**References:**` lines citing those labels and anchors (never line numbers), and `**Depends on:**` lines with `#step-N` anchors, per `tuglaws/devise-skeleton.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. Two questions raised during diagnosis were resolved in-thread:

- *What supplied the body the incident actually landed?* Unrecoverable and immaterial: the row the join read was deleted by the post-landing cleanup (`clear_dash_draft` sweeps under the landing's base-root key — the one place the authored row wasn't), and `changes.db` keeps no journal of deleted drafts. Whichever fallback supplied it (a scribe-written base-root row or the branch description), the fix is identical: key the authored draft where the reader looks. See [The forensic reconstruction](#forensic-reconstruction).
- *Does the draft engine ever regenerate over an authored draft?* No. `spawn_on_demand_draft` ([P03] in `tugcast/src/feeds/draft_engine.rs`) refuses non-`force` requests over `edited=1` rows; `do_changeset_draft_set` keeps `edited` monotonic (`request.edited || prior_edited`); and every `force` originates from an explicit user gesture in `tug-prompt-entry.tsx` (the Auto-Message button on an empty field, or the confirmed Replace popover). The "regeneration" framing in the join-assessment brief was a misdiagnosis.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Base-root resolution misfires outside a dash worktree | med | low | Resolve only when the owner is a dash *and* the project dir is inside that dash's worktree; otherwise keep today's behavior | A session-owner draft lands under an unexpected key |
| `--carry` loses staged base edits | high | low | `git checkout HEAD -- <path>` restores index and worktree together, same as `clean_base_plan_copy`; copy-all-before-clean-any ordering | Any test showing base content unreachable after a failed create |
| Legacy probe masks a future keying bug | low | med | The probe is bounded (one extra spelling, dash reads only) and documented as a migration fallback, not a reconciliation layer | A new draft surface reaching for probe-order fixes instead of writing the right key |
| Carried work destroyed by a later release | high | med | [P08]: release hands the worktree's uncommitted work back to the base before teardown, and refuses to overwrite a conflicting base edit | Any path that removes a dash worktree without going through the hand-back |

**Risk R01: The transplant meets an unmergeable working set** {#r01-carry-conflicts}

- **Risk:** `--carry` copies base-dirty file contents onto a worktree cut from the base tip; since the worktree is at the same commit the dirt was made against, contents copy cleanly — but exotic states (unmerged paths, type changes) could surprise.
- **Mitigation:** Refuse `--carry` when the base has unmerged paths (`git ls-files -u` non-empty) with a message naming them; copy by file content (tracked-dirty and untracked), never by patch application.
- **Residual risk:** Intent-to-add and other index-only exotica degrade to "content carried, index state not" — acceptable, and stated in the flag's help text.

---

### Design Decisions {#design-decisions}

#### [P01] A dash draft's project key is the base repository root (DECIDED) {#p01-dash-draft-key}

**Decision:** Every dash-owned draft row is keyed by the dash's *base repository root*, never by the worktree the write happened in.

**Rationale:**
- The draft describes a landing **on the base**; the reader (`dash_draft_message`) runs with the base root in hand and always will.
- The proven incident, and the machine ledger's uniform worktree-keyed rows, show that cwd-derived keys split the row space every time a planned run writes its draft (which `dash-implement` does from the worktree).
- The post-landing cleanup (`clear_dash_draft`) already sweeps under the landing's base-root key — fixing the write key makes the existing cleanup correct with no change.

**Implications:**
- `tugutil draft set|show|clear`: when the owner resolves to a dash and the project dir sits inside that dash's worktree, the project key becomes the base root (derived via `git rev-parse --git-common-dir`); the worktree spelling rides the request as a superseded sibling.
- The server's `/api/draft` sibling sweep and `dash_draft_message`'s probes both gain the worktree spelling as a legacy axis.

#### [P02] Legacy worktree-keyed rows are read through a bounded probe, not a shim (DECIDED) {#p02-legacy-probe}

**Decision:** `dash_draft_message` appends the dash-worktree spelling to its existing probe list; no canonicalize-both-sides reconciliation is introduced anywhere.

**Rationale:**
- The reader already runs a declared probe order across the owner-key axis (id key then legacy branch ref) and the spelling axis (canonical then raw) — this is the established Spec S05 pattern for a key migration, and the worktree axis is one more rung of it.
- A tolerance shim that canonicalizes both sides at compare time is the pattern this repo explicitly bans; the fix is the key ([L29]), the probe is the bridge for rows written before the fix.

**Implications:** The probe grows from four to at most six attempts, dash reads only; the write-side sibling sweep (Step 3) retires legacy rows on the next touch, so the probe's hit rate decays to zero.

#### [P03] `integrate_message` wraps idempotently (DECIDED) {#p03-prefix-idempotent}

**Decision:** Before wrapping the body as `tugdash(<name>): <body>`, `integrate_message` strips a leading `tugdash(<name>): ` (exact name match, once) from the body.

**Rationale:**
- The doubled subject on `5964a0a19` is read directly off the landed commit; any body source — draft, description, override — may legitimately open with the conventional subject.
- Strip-then-wrap (rather than skip-wrap-if-present) keeps one code path producing the subject, so the trailer logic in `with_dash_trailers` sees a uniform shape.

**Implications:** Only the exact `tugdash(<name>): ` prefix for *this* dash's name is stripped — a body deliberately opening with another dash's scope, or any other conventional prefix, passes through untouched.

#### [P04] The landing message invariant: authored draft, byte-for-byte (DECIDED) {#p04-byte-for-byte}

**Decision:** When a maintained draft exists and no override is given, the joined squash commit's message is exactly `tugdash(<name>): ` + the draft (after [P03] stripping) + the dash trailers `with_dash_trailers` appends — nothing else added, reordered, or regenerated.

**Rationale:** This is the contract the whole draft feature exists to honor, and the incident is what it looks like broken. Pinning it as a test at the `join_in` layer means any future writer or reader drift fails loudly instead of landing someone else's words.

**Implications:** Step 4's integration test builds a scratch repo, writes the draft row under the [P01] key via `TUG_CHANGES_DB`, joins, and string-compares the landed message.

#### [P05] Create reports base dirt; taking it is an explicit act (DECIDED) {#p05-report-not-veto}

**Decision:** `dash create` always succeeds over a dirty base (as today), but its outcome now carries the census: which tracked paths are modified and which files are untracked on the base checkout, plus a warning when the checkout is not on the base branch. Nothing is transplanted, committed, or stashed unless `--carry` says so.

**Rationale:**
- Locked in `roadmap/join-assessment.md`: most creates happen over *some* unrelated dirt, so a refusing create would be intolerable — the shape that survives is a decision, not a veto, defaulting to taking nothing.
- The off-base warning fixes the brief's named asymmetry: creation is commit-based (cuts from the base *ref*) but the join's preflight has an `off-base` blocker demanding the checkout *be on* the base branch — nothing warns at the start about what the end will demand.

**Implications:** `CreateOutcome` gains `base_dirt` (classified paths) and `off_base` fields; the CLI renders them; JSON carries them for skills to read.

#### [P06] `--carry` generalizes the plan transplant to the working set (DECIDED) {#p06-carry-transplant}

**Decision:** `dash create <name> --carry` copies every base-dirty file (tracked-modified and untracked, per the same classification `BasePlanState` draws) into the fresh worktree **uncommitted**, then restores the base copies — tracked paths via `git checkout HEAD -- <path>` (naming `HEAD` explicitly so staged edits are cleaned too), untracked files removed.

**Rationale:**
- This is the "I was editing `main` and half-way through realised this should be a dash" gesture, which today has no support.
- `adopt_plan_in` / `clean_base_plan_copy` already implement exactly this for one file, with the two hard lessons encoded: `HEAD` must be named, and no ordering may exist in which the user's edits are unreachable.
- Uncommitted in the worktree (not auto-committed) because the carried work is in-progress by definition; the dash's first round commits it with intent.

**Implications:**
- Copy-all-before-clean-any: every file lands in the worktree before any base copy is touched; a failure during the copy phase tears the dash down with the base fully intact (the same rollback `run_post_create` failure takes).
- The transplant runs after `run_post_create` and alongside `adopt_plan_in` in create's ordering, for the same rollback reason the plan transplant runs last.
- Refuses over unmerged base paths (Risk R01).

#### [P08] Release hands carried work back to the base (DECIDED) {#p08-release-hands-back}

**Decision:** `release_in` restores the dash worktree's uncommitted tracked-and-untracked work to the base checkout before teardown, the exact inverse of the [P06] carry — and it does so for *any* uncommitted worktree work, not only work that arrived by `--carry`.

**Rationale:**
- Carried work is uncommitted by [P06] and therefore lives in exactly one place: the worktree that `remove_dash_worktree` deletes. Without this, `--carry` would move a developer's work somewhere a routine `dash release` destroys it — the tool creating the hazard.
- The precedent is immediately adjacent and explicit: `release_in` already calls `restore_plan_to_base` before teardown, for exactly this reason ("Adoption *removed* the base copy, and release deletes the branch holding the only one — so without this, discarding a dash would permanently destroy the user's plan document"). Carry creates the same shape of hazard for the working set, so it gets the same shape of guard.
- Handing back rather than committing keeps [P06]'s premise intact: in-progress work never acquires a machine-written commit message, and nothing invented lands in a squash.
- Scoping it to all uncommitted worktree work rather than tracking carry provenance means no new state to persist, and it is the more useful behavior anyway — work typed in the worktree and never committed is destroyed by release today.

**Implications:**
- `release_in` gains a working-set hand-back beside `restore_plan_to_base`, running *before* `remove_dash_worktree`; the restored paths ride the `ReleaseOutcome` (beside `plan_restored`) so the CLI and card can say what came back.
- A conflict on hand-back — the base has since acquired its own edit to the same path — must not silently overwrite: leave the base copy alone, warn naming the path, and let the worktree removal be refused rather than destroy the work ([P06]'s ordering discipline, applied in reverse).

#### [P07] One canonical dash-draft key, resolved in one place (DECIDED) {#p07-canonical-key}

**Decision:** The only shape any surface may *write* a dash draft row under is the id-qualified owner key (`tugdash/<name>#<tugid>`, as `dash_owner_key` mints it) crossed with the dash's **base repository root** as the project key — and every reader and writer obtains that pair from one resolver in `tugdash-core`, `dash_draft_key`, never by assembling the parts by hand.

**Rationale:**
- Every probe axis this territory carries — id key vs legacy branch ref, canonical vs raw spelling, and now base root vs worktree — exists because some surface assembled a key by hand and drifted from the others. Each is an unfinished migration. A single resolver makes the next divergence impossible instead of tolerated: a seventh probe cannot accrete when nobody builds keys inline.
- The server, the draft engine, and the deck already key dash drafts by the base-root `workspace_key`; the CLI was the one dissenting writer. This decision turns that convention from an accident of who wrote which handler into stated law.

**Implications:**
- `dash_draft_key(repo_root, name) -> DashDraftKey { owner_id, legacy_owner_id, project }` in `tugdash-core/src/ops.rs`. `dash_draft_message` (Step 2), the `tugutil` draft CLI (Step 3), and `clear_dash_draft`'s caller consume it. Spelling canonicalization remains the server's, through the [L29] gateway — the resolver answers *which directory and which owner*, never which spelling.
- Every legacy probe is migration debt with a named deletion path: once `just db-inspect changes` shows no pre-fix dash rows in the machine ledger, the legacy axes come out (recorded as a follow-on in #roadmap). The probes are a bridge with a demolition date, not a tolerance layer.

---

### Deep Dives {#deep-dives}

#### The forensic reconstruction {#forensic-reconstruction}

The incident, re-derived from the live machine ledger on 2026-08-15 (`just db-inspect changes` — never raw `sqlite3` on live Tug databases):

- The authored draft **still exists**, untouched: owner `dash|tugdash/dash-ui#1786805713912-ff2bc8`, `edited=1`, written 08:42:19 local — nineteen minutes before the landing commit `5964a0a19` (09:00:59). Its message opens `tugdash(dash-ui): the dash joins the session identity grammar…`. Nothing regenerated it; the landed body is a different text.
- Its `project_dir` is `/Users/kocienda/Mounts/u/src/tugtool/.tug/worktrees/dash-ui` — the **dash worktree**, because `dash-implement` runs `tugutil draft set` from the worktree and `resolve_project` (`tugutil/src/draft.rs`) defaults `--project` to cwd.
- The reader, `dash_draft_message` (`tugdash-core/src/ops.rs`), probes owner keys (id key, then legacy branch ref) crossed with **the base repo root's** canonical and raw spellings — four probes, none of which is the worktree. The row can never match.
- `integrate_message` therefore fell through to its next fallback, landed a body that itself opened with `tugdash(dash-ui): `, and the unconditional wrap doubled the prefix.
- The post-landing cleanup (`clear_dash_draft`, `tugcast/src/feeds/agent_supervisor.rs`) swept the dash's rows under the base-root spellings only — deleting whatever row the join *did* read while missing the authored one, which is why the evidence survived.
- **Blast radius:** every dash row in `changeset_drafts` is worktree-keyed (`gazette-boost`, `plan-adoption`, `polish-lane`, `join-lane`, …). Every planned dash run's authored join draft has been invisible to its join. This is the standing behavior, not a race or a one-off.

What was ruled out, so nobody re-suspects it: the draft engine's `edited` gate predates the incident (`c12e84fe4`, 2026-07-20) and holds on every path; `do_changeset_draft_set` keeps `edited` monotonic; both `force` regeneration paths are explicit user gestures; the `workspace_key` migration (`89ee41768`) and the owner-id migration (`a4477d50b`) are internally consistent — the split is purely the **project axis between the CLI's cwd and the join's repo root**.

#### The write path after Step 3 {#write-path-after}

`tugutil draft set --owner dash:<name>` (or owner derived from a `tugdash/<name>` checkout), run anywhere inside the dash worktree:

1. `resolve_project` yields cwd as before — the CLI still never canonicalizes ([L29] is the server's).
2. New: when the resolved owner is a dash, the CLI asks `git rev-parse --git-common-dir` in the project dir to locate the base root, hands it to `tugdash_core::ops::dash_draft_key`, and uses the resolver's pair verbatim as the request's owner and `project` ([P07]) — the original worktree spelling joins the request's superseded siblings, exactly as `raw_project_dir` carries the spelling axis and `legacy_id` carries the owner axis today.
3. The server (`POST /api/draft`) canonicalizes the base-root spelling through the [L29] gateway, upserts under it, and its existing sibling sweep deletes the worktree-keyed row — so one authored `set` heals a dash's legacy rows.
4. The `TUG_CHANGES_DB` direct-SQL fallback applies the identical resolution before writing, keeping test-harness writes and production writes on one key.

`dash_draft_message` then finds the row on its first probe. Pre-fix rows for a still-live dash are found by the new worktree-spelling probe ([P02]) until the next `set` retires them.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

None. Every change lands in existing files.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `integrate_message` | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | Strip a leading `tugdash(<name>): ` before wrapping ([P03]) |
| `DashDraftKey` | struct (new) | `tugdash-core/src/ops.rs` | `{ owner_id, legacy_owner_id: Option, project }` — the one writable key shape ([P07]) |
| `dash_draft_key` | fn (new, pub) | `tugdash-core/src/ops.rs` | The single resolver every draft reader/writer consumes ([P07]); wraps `dash_owner_key` + the base root |
| `dash_draft_message` | fn (modify) | `tugdash-core/src/ops.rs` | Rebuilt over `dash_draft_key`; legacy probes (branch-ref owner, raw spelling, worktree spelling via `worktree_path`) appended as the decaying bridge ([P02]) |
| `resolve_project` / owner plumbing | fn (modify) | `tugrust/crates/tugutil/src/draft.rs` | Dash owners resolve through `tugdash_core::ops::dash_draft_key` ([P01], [P07]); worktree spelling into `sibling_rows` |
| `dash_base_root` | fn (new, private) | `tugutil/src/draft.rs` | Locates the base root from cwd (`git rev-parse --git-common-dir` → parent; `None` when not in a linked worktree), then hands it to the resolver |
| `CreateOutcome` | struct (modify) | `tugdash-core/src/ops.rs` | Add `base_dirt: Vec<BaseDirtPath>`, `off_base: Option<String>` ([P05]) |
| `BaseDirtPath` | struct (new) | `tugdash-core/src/ops.rs` | `{ path, state: "tracked-dirty" \| "untracked", deleted: bool }` — serializable census entry; `deleted` drives carry's deletion case |
| `DraftApiRequest` | struct (modify) | `tugrust/crates/tugcast/src/server.rs` | Add `superseded_project_dirs: Vec<String>` — the third spelling slot the sibling sweep needs ([P07]) |
| `release_in` | fn (modify) | `tugdash-core/src/ops.rs` | Hand the worktree's uncommitted work back to base before teardown ([P08]) |
| `ReleaseOutcome` | struct (modify) | `tugdash-core/src/ops.rs` | Report handed-back paths beside `plan_restored` ([P08]) |
| `base_working_set_dirt` | fn (new) | `tugdash-core/src/ops.rs` | The whole-tree census: `dirty_tracked_paths` ∪ `ls-files --others --exclude-standard` |
| `carry_working_set_in` | fn (new) | `tugdash-core/src/ops.rs` | The [P06] transplant: copy-all, then `clean_base_plan_copy`-style restore per path |
| `create` | fn (modify) | `tugdash-core/src/ops.rs` | Census always; `carry: bool` parameter; transplant in the last-position slot beside `adopt_plan_in` |
| `Dash::Create` | CLI variant (modify) | `tugrust/crates/tugutil/src/cli.rs` | `--carry` flag; render census + off-base warning |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `integrate_message` prefix cases; `dash_draft_message` probe order; census classification | Steps 1, 2, 5 |
| **Integration** | Scratch-repo `join_in` landing the authored draft; CLI `draft set` round-trip under `TUG_CHANGES_DB`; `--carry` end state and rollback | Steps 3, 4, 6 |
| **Drift Prevention** | The [P04] byte-for-byte string compare is itself the drift pin | Step 4 |

All Rust tests build their own repos in tempdirs (the `resolve.rs` `init()` pattern) and isolate the ledger with `TUG_CHANGES_DB`. Nothing touches the live repository or the live `changes.db`.

#### What stays out of tests {#test-non-goals}

- No app-tests. Nothing in this plan changes tugdeck, and the CLI/join surfaces are fully exercisable at the Rust layer in scratch repos; an app-test here would drive the same Rust through a slower, contended harness for no added truth (and changeset entries are transient in app-test workspaces).
- No scribe-path tests. The draft engine is untouched; its `edited` gate is already pinned by `tugcast`'s own tests.
- No test against the live machine ledger's legacy rows — they belong to dead dashes and the probe test covers the shape.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Prefix idempotence in `integrate_message` | done | `0b3e230e6` |
| #step-2 | The canonical key resolver, and the reader over it | done | `cfb5e344e` |
| #step-3 | The CLI writes the base-root key | done | `ec57a34d7` |
| #step-4 | The byte-for-byte landing invariant | done | `674512653` |
| #step-5 | The base-dirt census at create | done | `abb4c5697` |
| #step-6 | The `--carry` transplant | done | `52caa9b59` |
| #step-7 | Release hands the working set back | done | `fc2c6f426` |
| #step-8 | Doctrine prose | done | `d835ea3f2` |
| #step-9 | Integration checkpoint | done | `6f8bf9419` |

#### Step 1: Prefix idempotence in `integrate_message` {#step-1}

**Commit:** `tugdash-core(join-message): wrap the subject prefix idempotently`

**References:** [P03] `integrate_message` wraps idempotently, (#forensic-reconstruction, #context)

**Artifacts:**
- `integrate_message` strips one leading `tugdash(<name>): ` (exact current dash name) from the body before wrapping.

**Tasks:**
- [ ] In `tugrust/crates/tugdash-core/src/ops.rs`, strip the exact prefix `tugdash(<name>): ` from the resolved body (draft, description, or override) once, before the `format!("tugdash({}): {}", …)` wrap.
- [ ] Leave `with_dash_trailers` untouched — it operates on the wrapped result as today.

**Tests:**
- [ ] Body already prefixed for this dash → single prefix in the result.
- [ ] Body prefixed for a *different* dash name → passes through, double-scoped result is intentional.
- [ ] Unprefixed body, and the empty-fallback (`"Dash work"`) → unchanged behavior.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 2: The canonical key resolver, and the reader over it {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash-core(draft-key): one resolver for the dash draft key; the reader probes legacy shapes last`

**References:** [P01] base-root key, [P02] bounded legacy probe, [P07] canonical key, (#forensic-reconstruction, #write-path-after)

**Artifacts:**
- `DashDraftKey` and `pub fn dash_draft_key(repo_root, name)` in `ops.rs` — the one place the key pair (id-qualified owner × base-root project) is assembled.
- `dash_draft_message` rebuilt over the resolver: the canonical key probes first, then the legacy axes (branch-ref owner, raw spelling, and the dash worktree spelling from `worktree_path(repo, name)`), last — current-key rows must win over legacy rows.

**Tasks:**
- [ ] Implement `DashDraftKey` / `dash_draft_key`, wrapping `dash_owner_key` (never minting — read paths stay non-writing) and the repo root; document it as the only sanctioned assembly point ([P07]).
- [ ] Rewire `dash_draft_message` to take its primary probe from the resolver and append the legacy axes, each documented in the doc comment as a migration fallback with a decaying hit rate and a deletion trigger (no pre-fix rows left in the ledger), citing [P02]/[P07].
- [ ] Give the worktree spelling the same canonical/raw treatment the repo root already gets — add it as a third *project* spelling inside the existing cross-product rather than as a single extra probe, since the row was written under whatever spelling the server's [L29] gateway resolved. Note that `worktree_path` probes the filesystem (new `.tug/worktrees/` location, then the legacy `.tugtree/` one, else the new form), so for a released dash it answers the default spelling — acceptable for a best-effort legacy probe, and worth saying in the comment so the behavior is not read as a bug later.

**Tests:**
- [ ] `dash_draft_key` yields the id-qualified owner and the base root; the legacy owner id appears only when a `tugid` exists and differs from the branch ref.
- [ ] A row keyed by the worktree path (the pre-fix shape, seeded directly into a `TUG_CHANGES_DB` tempfile) is found.
- [ ] When both a base-root row and a worktree row exist, the base-root row wins.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 3: The CLI writes the base-root key {#step-3}

**Depends on:** #step-2

**Commit:** `tugutil(draft): key a dash draft by its base repository root, wherever the write runs`

**References:** [P01] base-root key, [P02] sibling supersede, [P07] canonical key, (#write-path-after, #constraints)

**Artifacts:**
- `dash_base_root` in `tugutil/src/draft.rs`; dash-owner writes and reads resolve their key through `tugdash_core::ops::dash_draft_key`; the worktree spelling rides as a superseded sibling on `set`/`clear` and a read-union member on `show`.

**Tasks:**
- [ ] Add `dash_base_root(project_dir)`: `git -C <project_dir> rev-parse --git-common-dir`, parent of the result; `None` when it equals `.git` resolved against the project dir itself (not a linked worktree) or the command fails.
- [ ] **Resolve the owner first, substitute the project second — this ordering is load-bearing.** `resolve_owner`'s derivation path calls `dash_branch_name(project_dir)`, which runs `git -C <project_dir> rev-parse --abbrev-ref HEAD` and requires a `tugdash/<name>` result. Substituting the base root *before* owner resolution would read `main` there, the derivation would fail, and an ownerless `tugutil draft set` from inside a worktree — precisely what `dash-implement` runs — would fall through to the session owner or error out. Keep `resolve_owner(owner, &cwd_project_dir)` on the cwd spelling; substitute only afterwards.
- [ ] With the owner resolved as a dash, feed the located base root to `dash_draft_key` and use its pair verbatim — the CLI assembles no key parts of its own ([P07]) — recording the original cwd spelling for the sibling axis, mirroring how `legacy_id` travels today.
- [ ] **Add the third spelling slot to the wire.** `DraftApiRequest` (`tugrust/crates/tugcast/src/server.rs`) carries exactly two project spellings today — `project_dir` and `raw_project_dir` — and the handler folds them into `alternates` for its sibling sweep. The base root needs both of those, so the worktree spelling has nowhere to ride: add `#[serde(default)] superseded_project_dirs: Vec<String>`, have the handler extend `alternates` with it (still filtering out the canonical spelling), and send the cwd/worktree spelling there from `run_set` and `run_clear`.
- [ ] Extend `sibling_rows` on the `TUG_CHANGES_DB` direct-SQL path so a `set` deletes the worktree-keyed row there too, and add the worktree spelling to `read_row`'s union so `show` finds pre-fix rows.

**Tests:**
- [ ] (In `tugrust/crates/tugutil/tests/changes_cli.rs`, `TUG_CHANGES_DB`-isolated, scratch repo with a real dash worktree) `draft set` run with cwd inside the worktree lands the row with `project_dir` = base root.
- [ ] **The ordering regression:** `draft set` with *no* `--owner`, cwd inside the worktree, still resolves the dash owner (not the session owner) — the test that fails if the substitution is done too early.
- [ ] The same `set` deletes a pre-seeded worktree-keyed row for the same dash.
- [ ] `draft show` from the base checkout and from inside the worktree both print the message.
- [ ] A session-owner `set` from an ordinary directory is unaffected (project stays cwd-derived).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil -p tugcast`

---

#### Step 4: The byte-for-byte landing invariant {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash-core(join): pin the landing message to the authored draft, byte for byte`

**References:** [P04] byte-for-byte invariant, [P01], [P03], (#success-criteria)

**Artifacts:**
- An integration test at the `join_in` layer proving the whole contract end to end.

**Tasks:**
- [ ] In `ops.rs`'s test module: scratch repo, real `create`, a committed round on the dash, a draft row written under the base-root key into a `TUG_CHANGES_DB` tempfile (through the Step 3 write path where practical, direct insert where not), then `join_in` with no override.
- [ ] Assert the squash commit's full message equals `tugdash(<name>): ` + the authored draft (post-[P03]) + the exact trailers `with_dash_trailers` appends — a string equality, not a `contains`.

**Tests:**
- [ ] The invariant test above.
- [ ] A variant where the draft already opens with `tugdash(<name>): ` — the landed subject carries the prefix exactly once.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 5: The base-dirt census at create {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash-core(create): report what the base checkout holds uncommitted, and where its HEAD sits`

**References:** [P05] report-not-veto, (#context, #symbols)

**Artifacts:**
- `base_working_set_dirt`, `BaseDirtPath`; `CreateOutcome.base_dirt` and `CreateOutcome.off_base`; CLI rendering in `tugutil dash create` (human lines + `--json` fields).

**Tasks:**
- [ ] Implement the census: `dirty_tracked_paths(repo_root)` (which is `git diff --name-only HEAD`, so it covers staged *and* unstaged, including deletions) plus `git ls-files --others --exclude-standard`, classified per `BasePlanState`'s dirt line. `.tug/` is gitignored at the repo root, so `--exclude-standard` already keeps dash worktrees out of the untracked half — no special-casing needed, and a hand-rolled path exclusion would be dead code.
- [ ] Populate it on every `create` return path, including the idempotent revisit.
- [ ] Set `off_base` to the checked-out branch name when it differs from the base branch, with the CLI rendering the brief's warning: the join's preflight will demand the base checkout at landing time.
- [ ] Default behavior unchanged: report only, touch nothing.

**Tests:**
- [ ] Clean base → empty census, no warning.
- [ ] A modified tracked file and an untracked file → both reported, correctly classified; create still succeeds and the base is untouched.
- [ ] Checkout on a non-base branch → `off_base` populated.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 6: The `--carry` transplant {#step-6}

**Depends on:** #step-5

**Commit:** `tugdash-core(create): carry the base's uncommitted work into the dash it belongs to`

**References:** [P06] carry transplant, Risk R01, (#p05-report-not-veto, #symbols)

**Artifacts:**
- `carry_working_set_in`; `create(…, carry: bool)`; the `--carry` flag on `tugutil dash create`.

**Tasks:**
- [ ] Implement `carry_working_set_in(repo_root, worktree)`: take the Step 5 census; refuse when `git ls-files -u` reports unmerged paths (Risk R01); apply every censused path into the worktree; only after every application succeeds, restore each base path — tracked via `git checkout HEAD -- <path>`, untracked via removal — reusing/generalizing `clean_base_plan_copy`'s per-state logic.
- [ ] **Handle the deletion case.** `dirty_tracked_paths` is `git diff --name-only HEAD`, which lists a tracked file *deleted* on base as dirty — and there is no content to copy for it. Carrying a deletion means deleting the worktree's copy (the worktree was cut from the base tip, so it has one); reading the file and failing is the wrong behavior. Classify each censused path as content-carrying or deletion before applying, and let `BaseDirtPath` carry that distinction so the outcome reports it.
- [ ] Slot the call into `create` after `run_post_create`, in the same last-position/rollback regime as `adopt_plan_in`: a transplant failure tears down the worktree and branch, and by the apply-all-first ordering the base is still intact when it does.
- [ ] Wire `--carry` through `cli.rs`; the outcome reports what was carried (the census entries, now marked carried) so the JSON tells the skill what moved.
- [ ] `--carry` composes with `--plan`: the plan transplant runs as today; a plan file appearing in both censuses is handled once (plan adoption wins, carry skips it).
- [ ] **Define `--carry` on the idempotent revisit.** `create` returns early when branch and worktree both exist; `--plan` treats that path as a repair and re-runs its transplant. `--carry` follows the same rule — a revisit with `--carry` transplants whatever base dirt is there now — so the two flags behave alike on the path a re-run takes.

**Tests:**
- [ ] Dirty base + `--carry` → worktree holds the modifications uncommitted (`git status` in the worktree shows them), base checkout is clean, untracked file moved not copied.
- [ ] A tracked file *deleted* on base → the deletion is carried (gone in the worktree) and the base copy restored, with nothing attempting to read the missing file.
- [ ] Staged base edit → carried, and the base path clean against HEAD afterward (the named-`HEAD` restore).
- [ ] An apply failure (e.g. an unwritable worktree target seeded by the test) → create errors, dash torn down, base dirt fully intact.
- [ ] Unmerged base path → refused with the paths named, nothing touched.
- [ ] `--carry` on a clean base → no-op success.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 7: Release hands the working set back {#step-7}

**Depends on:** #step-6

**Commit:** `tugdash-core(release): return uncommitted worktree work to the base before teardown`

**References:** [P08] release hands carried work back, [P06] carry transplant, (#r01-carry-conflicts)

**Artifacts:**
- A working-set hand-back in `release_in` (`tugdash-core/src/ops.rs`), running before `remove_dash_worktree`, beside the existing `restore_plan_to_base`; restored paths reported on `ReleaseOutcome`.

**Tasks:**
- [ ] Census the dash worktree's uncommitted work (the same classification Step 5 built, run against the worktree) and copy it back to the base checkout before teardown.
- [ ] Refuse to overwrite: when the base already holds its own uncommitted edit to a path being handed back, leave the base copy, warn naming the path, and do not remove the worktree — the work stays reachable rather than being destroyed to complete a release.
- [ ] Report the restored paths on `ReleaseOutcome` beside `plan_restored`, and render them in the CLI's release output.

**Tests:**
- [ ] `create --carry` then `release` → the carried work is back in the base checkout, worktree gone.
- [ ] Work typed in the worktree and never committed → also handed back (the guard is not carry-specific).
- [ ] Base holds a conflicting uncommitted edit to the same path → release warns, base copy untouched, worktree retained.
- [ ] A clean worktree → release behaves exactly as today.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 8: Doctrine prose {#step-8}

**Depends on:** #step-7

**Commit:** `tuglaws(dash-work-doctrine): the create-time census and the carry gesture`

**References:** [P05], [P06], [P08], (#non-goals)

**Artifacts:**
- A short subsection in `tuglaws/dash-work-doctrine.md` on starting a dash from a dirty base: read the census in create's output, when `--carry` is the right gesture, that taking nothing is the default, and that release returns uncommitted worktree work to the base rather than discarding it ([P08]).

**Tasks:**
- [ ] Write the subsection; keep it to the doctrine's voice and length conventions; no plan-step numbers or plan references in the durable doc.
- [ ] Update `roadmap/join-assessment.md`'s "clean base at creation" and "two message defects" sections to point here as **addressed**, the same way the rerere hazard section was closed out.

**Tests:**
- [ ] None (prose).

**Checkpoint:**
- [ ] `just app-test-covers-check` (unchanged test declarations still resolve)

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-4, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P04], [P05], [P06], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify the milestones hold together end to end: a scratch-repo walk of create-with-carry → round → `draft set` from the worktree → `join_in` lands the authored message once-prefixed, base clean throughout.

**Tests:**
- [ ] The full workspace suite as the aggregate gate.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dash whose landing commits the message its author wrote — from creation on a reported-clean (or explicitly carried) base, through a draft that survives being written anywhere in the dash, to a join whose squash message is that draft, once-prefixed, byte for byte.

**Milestone M01: The draft contract** {#m01-draft-contract} — Steps 1–4. The authored draft is the landed message; the doubled prefix is impossible; pre-fix rows still resolve.

**Milestone M02: A clean base at creation** {#m02-clean-base} — Steps 5–8. Create tells the truth about the base and offers the carry gesture, and release returns what carry moved; the join-assessment brief's cheapest divergence source is closed without opening a way to lose work.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The Step 4 invariant test exists and passes (string-equal landed message).
- [ ] `tugutil draft set` from a dash worktree and `dash_draft_message` from the base agree on one row (Step 3 round-trip tests).
- [ ] `dash create` census and `--carry` behave per [P05]/[P06] (Step 5–6 tests).
- [ ] `dash release` returns uncommitted worktree work to the base and refuses to overwrite a conflicting base edit ([P08], Step 7 tests).
- [ ] `cd tugrust && cargo nextest run` green; `just app-test-changed` green.
- [ ] `roadmap/join-assessment.md` updated to mark the draft defect and clean-base items addressed.

**Acceptance tests:**
- [ ] Steps 3, 4, and 6's integration tests, running in CI via the workspace suite.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Delete the legacy probe axes ([P02]) once `just db-inspect changes` shows no pre-fix dash rows in the machine ledger — the bridge's demolition date ([P07]).
- [ ] A standalone `dash carry` verb for an existing dash, reusing `carry_working_set_in`.
- [ ] Surfacing the create census in the Session card's dash creation flow (tugdeck).
- [ ] The base-motion replay design brief (`roadmap/join-assessment.md`, its own program).
- [ ] Garbage-collecting the dead worktree-keyed rows in the live machine ledger (inert; cosmetic only).

| Checkpoint | Verification |
|------------|--------------|
| Draft contract holds | Step 4 invariant test, string equality |
| Write/read key agreement | Step 3 round-trip tests under `TUG_CHANGES_DB` |
| Base clean after carry | Step 6 end-state tests |
| Carried work survives release | Step 7 hand-back tests |
| Nothing else moved | `cargo nextest run` + `just app-test-changed` |
