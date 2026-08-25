## Dash Lifecycle Fixup {#dash-lifecycle-fixup}

**Purpose:** Make the Lens Dashes section tell the truth across a plan document's whole life. Today the section lists every parseable plan in the docs directory with an Implement affordance — including plans whose Step Status Ledger is fully `done`, and including the plan a live dash is implementing right now. This plan closes three gaps: the wire carries ledger progress and drops finished plans, plan rows dedup against live dashes by adopted path, and the join sweeps the adopted plan into `<docs>/archive/` as part of landing so the docs top level means *live paperwork* by construction.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-24 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-24, opus.** Reviewed `plan:acfa7548b526e357`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document — a first pass, `rounds: 0`.
Applied: **the plan repeated the misreading it was written to fix, and that was the round's main finding.** Its Context and Assumptions took [D139] to mean adoption removes the base plan copy, so the lifecycle it described had an act 2 in which an adopted plan is absent from the docs directory. [D139]'s own text says the opposite for the ordinary case — *"A committed, clean base copy is not a second live copy — it is ordinary branch divergence the squash resolves like any other file"* — and the code agrees: `BasePlanState::is_dirt` is `TrackedDirty | Untracked` only, and `clean_base_plan_copy` returns `"untouched"` for `Clean`. `git log --diff-filter=D -- 'dash/*.md'` returns nothing, so no adoption has ever deleted a plan in this repository. That exposed a **third class of false row the plan did not address and which is worse than the one it did**: the plan a dash is implementing right now stays listed, its base ledger frozen at all-`pending`, reading `reviewed · N steps` with an Implement button, directly beneath the dash row that already represents it — an invitation to start a second dash on work in flight. Added [P06] (the scan drops any plan whose path matches a dash entry's `plan_path`, using `ChangesetEntry::Dash.plan_path` which is already on the wire and `compose_aggregate`'s in-scope `snapshot`), a Deep Dive recording the finding and its evidence, a Success Criterion, tasks in Steps 1 and 2, an app-test case, and a corrected Step 4 doctrine task. **[P04]'s rationale was wrong for the same reason** — begun-ness on a base copy never means "a dash is working it", since run progress goes to the worktree copy; rewrote it and R03 to name the real driver, a run that stopped short of its plan and joined. **[P03] left the fraction's denominator ambiguous** between `ledger_rows` and `doc.steps`; pinned both counts and the drop test to `ledger_rows`, which is what `step_in` in `ops.rs` already trusts, and stated what happens when a malformed plan makes them disagree. **Three holes on the failure side**: R01 claimed full abort cleanliness but `git reset --hard` cannot remove a just-created empty `archive/` directory; [P05] left undo unanswered, so it now records that `oplog::capture_before` captures `base_tip` and therefore unwinds both commits; and new R05 names the widened un-journalled window for the CLI-only merge/rebase strategies. Also added the exact-match/[L29] discipline for the dedup key to Assumptions and Constraints, a discard note ([D139]'s release-writes-back symmetry means no special handling), the concrete `[D159]` number and the real golden-fixture contents (`dash-cockpit.md` 5 steps, `dash-hardening.md` 3) so the implementer does not re-derive them, and a State Zone Mapping row for the dedup.
Deferred: nothing. Both design forks in this plan were settled with the user before it was written ([P01], [P02]); [P06] needed no fork — it is the same doctrine [P01] already chose, applied to a second cause of the same wrong row.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dash-cockpit phase (landed as `tugdash(dash-cockpit)` on main) put the docs directory's plan documents on the `CHANGESET_ALL` aggregate and rendered them as rows in the Lens Dashes section, each with a next-gesture affordance derived from review state alone: `reviewed` → Implement, anything else → Review. The design rested on [D139] — adoption commits the plan on the dash branch and cleans the base copy, "so a plan still in the docs directory is by construction unadopted" — and read that as "still waiting to be implemented."

**That reading of [D139] is wrong twice over, and the second error is the larger one.** [D139]'s own text draws the line the cockpit plan erased: *"A committed, clean base copy is not a second live copy — it is ordinary branch divergence the squash resolves like any other file."* The clean applies to a **dirty or untracked** base copy only. `clean_base_plan_copy` (`tugrust/crates/tugdash-core/src/ops.rs`) returns `"untouched"` for `BasePlanState::Clean`, and `BasePlanState::is_dirt` is `TrackedDirty | Untracked` — a plan the user committed to the base branch before starting the dash, which is this repository's ordinary workflow, is never removed. The history proves it: `git log --diff-filter=D -- 'dash/*.md'` returns **nothing**. No adoption has ever deleted a base plan copy in this repository.

So the real lifecycle is three acts, not four, and *both* of the surviving acts produce a false row:

1. **Devised** — the plan sits in the docs dir, ledger all `pending`. Correctly listed: Review or Implement.
2. **Adopted, dash live** — the plan is committed on the dash branch and edited there, while **the base copy stays exactly where it was**, its ledger frozen at all-`pending` because the run's progress is written to the *worktree* copy. The section therefore lists the plan a dash is implementing right now, as `reviewed · 5 steps` with an **Implement** button — inviting a second dash on work already in flight, next to the dash row that already represents it.
3. **Joined** — the squash lands the dash's copy over the base one, ledger fully `done`, and the row now offers to implement finished work. Archiving into `dash/archive/` (480 files, proving the convention) is manual and undocumented, so the file sits in this state until the user sweeps it by hand.

Two individually-correct decisions compose into the act-3 lie. The scan (`plan_doc_entries_in` in `tugrust/crates/tugcast/src/feeds/changeset.rs`) calls `tugutil_core::plan::parse`, whose returned `PlanDoc` carries `ledger_rows` with a per-step `status` cell — the exact done/pending facts — and throws them away, keeping only `doc.steps.len()`. And the review-stamp design deliberately excludes ledger progress from the content hash (correct: a plan must not go stale by being implemented), so a finished plan still reads `reviewed`, and `reviewed` maps to Implement. The act-2 lie needs no ledger at all: the base copy's ledger is honestly all-`pending`, and the missing fact is simply that a dash already owns this document — which the wire already carries as `plan_path` on every dash entry ([P06]).

Two design forks were raised and settled with the user on 2026-08-24: the join sweeps the adopted plan into a **fixed `<docs>/archive/` subdirectory** (no config key — it automates the exact convention `dash/archive/` already proves), recorded as [P02]; and a fully-done plan still at the docs top level is **dropped at the scan, hidden entirely** (the section lists actionable paperwork, not history), recorded as [P01].

#### Strategy {#strategy}

- Three filters at one place and one sweep at another. Everything that decides *what is actionable paperwork* — drop the finished, drop the adopted, carry the progress — happens in the scan, so the wire's `plans` list means exactly one thing and no reader needs a filter of its own. The sweep is the separate, construction-level fix that keeps the directory itself honest.
- The dedup ([P06]) is the act-2 fix and needs no new data: `ChangesetEntry::Dash` already carries `plan_path`, and `compose_aggregate` already holds the project's composed `ChangesetSnapshot` in scope at the line where `plans` is built.
- The scan already pays for the parse; counting `ledger_rows` statuses is free. No new feed, no new store, no new config key.
- The sweep folds into the squash commit itself where the strategy allows (stage → `git mv` → commit), so the default join still lands exactly one commit and the docs dir is never dirty between them. Merge and rebase strategies, which already land multi-commit shapes, take a small follow-up commit.
- The deck's gesture derivation stays a pure exported function with table tests; the app-test proves rendering and absence, not machinery.
- The doctrine records the lifecycle so the class of failure dies with the instance, and this repository migrates its own finished plans into `dash/archive/`.

#### Success Criteria (Measurable) {#success-criteria}

- A plan whose ledger is fully `done` never appears on the wire: `plan_doc_entries_in` drops it, pinned by a Rust unit test.
- A plan a live dash has adopted never appears as a plan row: the scan drops any document whose repo-relative path matches a dash entry's `plan_path` in the same project, pinned by a Rust unit test and by an app-test that creates a dash on a fixture plan and asserts the plan row disappears while the dash row appears.
- A plan with begun-but-unfinished steps appears with its progress on the wire (`steps_done`, `steps_begun`), renders a **Resume** affordance whose prompt is `/tugplug:dash-implement <path>`, and sorts above unstarted plans (bun table tests; app-test renders one and asserts label, prompt, and meta line).
- An unstarted plan keeps today's exact behavior: Implement when `reviewed`, Review otherwise (existing tests keep passing).
- `tugutil dash join` on a dash with an adopted plan lands the plan file at `<docs>/archive/<file>` — inside the squash commit itself for the squash strategy — and the docs top level does not contain the file after the join (Rust tests in `ops.rs` for squash, candidate-squash, merge, and rebase paths).
- A join whose archive destination already exists skips the sweep and carries a warning in `JoinOutcome.warnings`; the join itself still succeeds (Rust test).
- A dash with no adopted plan, or a project with no declared docs dir, joins exactly as today — the sweep is a no-op (Rust test).
- This repository's docs top level contains no fully-done plan documents after the migration commit.

#### Scope {#scope}

1. `PlanDocEntry` gains ledger-derived progress fields; the scan counts them, drops fully-done plans, and drops plans a live dash has adopted; the golden fixture and both of its reader sides update.
2. The deck derives the true next gesture — Resume for begun plans — with ordering and meta-line changes in the Dashes section.
3. The join's archive sweep in `tugdash-core::ops`, all four integrate paths, with collision and no-plan handling.
4. Doctrine: a new global design decision recording the docs-directory lifecycle, a review-rubric clause, and this repository's migration of its finished plans into `dash/archive/`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No archive browser, no History section, no un-archive verb — archived plans are files git remembers, reachable by `ls` and the editor like any other file.
- No config key for the archive location ([P02] settles it as the fixed name `archive/` under the declared docs dir).
- No change to review-state derivation or the content stamp — progress staying outside the stamp is correct and untouched.
- No change to the Start-a-dash sheet, the prompt target ladder, or the Z2 DASH cell.
- No brief listing (unchanged non-goal from dash-cockpit).
- No retroactive rewriting of `dash/archive/` — existing archived files stay exactly where and as they are.

#### Dependencies / Prerequisites {#dependencies}

- The dash-cockpit phase (landed): `PlanDocEntry` on the wire, plan rows in the Dashes section, `dash-prompts.ts`.
- `tugutil_core::plan::parse` exposing `ledger_rows` with per-row `status` (landed; vocabulary is `pending` / `in progress` / `done` per `LEDGER_STATUSES`).
- The join machinery in `tugdash-core::ops` (`join_in_with_progress`) and the dash's recorded plan path (`dash_plan_path`, git config key `branch.tugdash/<name>.tugplan`).
- `tugutil_core::config::Config::docs_dir` resolving the declared docs directory against the project root.

#### Constraints {#constraints}

- WARNINGS ARE ERRORS in the Rust workspace (`-D warnings`).
- Tuglaws for the tugdeck half: [L02] external state via `useSyncExternalStore` (unchanged — all reads stay projections of `ChangesetAllStore`), [L19] `data-slot` on new slots, [L20] compose `Tug*` components, [L31] refusals carried on the control, [D142] status is not a control (the gesture stays an explicit button, row activation stays navigation). [L29] governs the dedup key: one spelling, matched exactly, never a tolerance shim.
- The shared golden fixture `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json` guards the wire shape from both sides; the `PlanDocEntry` change updates it and every reader in the same step.
- The join must remain conflict-safe: every abort path (`reset --hard`, `merge --abort`, `cherry-pick --abort`) must still restore the pre-join state, sweep included.
- `dash/archive/` already exists in this repository with ~480 files; the sweep must tolerate a pre-existing archive directory (creating it only when absent).

#### Assumptions {#assumptions}

- `tugutil plan lint` enforces ledger/step parity (PL016 family), so counting over `ledger_rows` and counting over `steps` agree on any lintable plan; the scan counts over `ledger_rows` and treats an empty ledger as unstarted rather than done.
- A dash's `plan_path` and a `PlanDocEntry.path` are the **same string** for the same document: the first is worktree-relative and the second repo-root-relative, and a linked worktree is a full checkout, so both spell the same repo-relative path (the wire's own contract says to compose an absolute path as `worktree` / `plan_path` "and nothing else"). The dedup is therefore an exact string match with no normalization — a canonicalize-both-sides shim would be the [L29] anti-pattern, and if the two ever disagree the fix belongs at whichever producer is wrong.
- The sweep reads `dash_plan_path` **before** teardown releases the branch (branch deletion can drop `branch.tugdash/<name>.*` config), which the integrate-then-teardown ordering already guarantees.
- `tugutil dash discard` writes the plan back to base before teardown ([D139]'s symmetry clause, `release_in`), so a discarded dash leaves an all-`pending` base copy that correctly reads as unstarted — the dedup releases it automatically when the dash entry disappears, and no discard-specific handling is needed.
- The user's landing gesture runs the tugutil built into the shipped app bundle, so the sweep applies to joins made after the next app build; this plan's own join may itself predate that binary (see Risks, [#r04-own-join](#r04-own-join)).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None — both design forks this plan met (whether/where the join sweeps, and what a fully-done top-level plan shows) were asked and settled on 2026-08-24, recorded as [P01] and [P02].

---

### Risks and Mitigations {#risks}

#### Risk R01: The sweep breaks a join abort path {#r01-abort-safety}

- **Risk:** A `git mv` folded into the squash staging could survive a failed commit and leave the base checkout half-swept.
- **Mitigation:** The sweep runs only *after* a successful `merge --squash` staging and *before* `git commit`; every failure after it already runs `git reset --hard`, which reverts both the staged squash and the staged move (a `git mv` is index + worktree state, wholly owned by the reset). The conflict path never reaches the sweep. Tests cover a forced commit failure leaving the tree clean.
- **Residual risk:** `git reset --hard` restores the file and removes the archived copy, but does not remove a `<docs>/archive/` **directory** the sweep had just created — git does not track directories, so a first-ever sweep that then aborts leaves an empty directory behind. Cosmetic, never a correctness problem, and moot in this repository where `dash/archive/` already exists. The tests assert the file's location, not the directory's absence.

#### Risk R02: Archive destination collision {#r02-collision}

- **Risk:** `<docs>/archive/<file>` may already exist — a re-run of a same-named plan, or a hand-archived copy.
- **Mitigation:** The sweep never clobbers: on collision it skips the move and pushes a sentence into `JoinOutcome.warnings` naming both paths, and the join succeeds with the plan at top level. The display filter ([P01]) hides the fully-done leftover, so the section stays truthful; archiving the stray remains the user's act, and the warning says so.
- **Residual risk:** A skipped sweep leaves a done plan at top level indefinitely if the warning goes unread — invisible in the Lens by design, visible to `ls`. Accepted.

#### Risk R03: `in progress` semantics on the base checkout {#r03-partial-semantics}

- **Risk:** The Resume path could rot untested or misfire on odd documents if its real driver is misidentified — and the obvious guess ("a dash is working it") is wrong, since a live dash's progress never reaches the base copy and [P06] removes that document from the listing anyway.
- **Mitigation:** Begun-ness is defined precisely — any ledger row whose status is not `pending` — and carried as its own wire field rather than inferred in the deck. Its real drivers are named in [P04]: a run that stopped short of its plan and joined (the common one — `dash-implement` takes a step selector), a hand-driven implementation, a ledger edited outside a dash. Table tests enumerate all four gesture states; the app-test renders a begun fixture plan.
- **Residual risk:** A malformed ledger (unknown status spelling) counts as pending; the row reads as unstarted, which is the conservative reading.

#### Risk R05: The merge/rebase follow-up commit widens the un-journalled window {#r05-journal-window}

- **Risk:** For [P05]'s non-squash strategies the archive commit lands *after* the integrate and *before* `write_join_journal`. A crash in that gap leaves the base with the integrate commit, the plan unarchived, and no journal — so `tugutil dash join --continue` refuses with "No interrupted join to continue".
- **Mitigation:** The window already exists today between the integrate and the journal write; this adds one small commit to it, not a new failure mode. `JoinStrategy::default()` is `Squash` and every Tug surface lands with the default, so the widened window is reachable only from an explicit `--strategy merge|rebase` on the CLI. The squash paths, which fold the move in before the single commit, do not widen anything.
- **Residual risk:** A CLI merge/rebase join interrupted in that gap needs manual recovery, exactly as it does today. Not made worse in kind.

#### Risk R04: This plan's own join predates the sweep binary {#r04-own-join}

- **Risk:** The join that lands this plan runs the currently-shipped tugutil, which has no sweep — so `dash/dash-lifecycle-fixup.md` itself lands back at the docs top level, fully done, one last time.
- **Mitigation:** The display filter lands in the same join, so the row never shows. The migration step's convention (finished plans move to `dash/archive/`) catches the file on the next housekeeping pass, or the user archives it by hand once. Stated here so nobody reads the leftover file as a defect in the sweep.
- **Residual risk:** One file, one time, hidden from the Lens. Accepted.

---

### Design Decisions {#design-decisions}

#### [P01] Fully-done plans are dropped at the scan (DECIDED) {#p01-drop-done}

The scan omits any plan whose ledger is non-empty and fully `done`. The Dashes section is a cockpit of actionable paperwork; a finished plan is history, and a row nobody can act on is noise that erodes trust in the rows that matter. Dropping at the scan rather than in the deck keeps the wire's meaning crisp — `plans` *is* the waiting paperwork — and spares every reader a filter. Settled with the user 2026-08-24 over the alternative of a quiet gestureless "done" row.

#### [P02] The join sweeps the adopted plan into a fixed `<docs>/archive/` (DECIDED) {#p02-fixed-archive}

As part of landing, the join moves the dash's adopted plan file from its docs-dir location into an `archive/` subdirectory of the declared docs dir — riding the squash commit itself where the strategy is squash. The name is a fixed convention, not a config key: it automates exactly what this repository's 480-file `dash/archive/` already does by hand, and the scan's top-level-only walk already never descends into it, so archived plans are invisible to the wire for free. The docs-home doctrine's "no blessed directory name" governs where a *project* keeps its paperwork; `archive/` is a fixed shape *inside* that declared home, the same way `Step Status Ledger` is a fixed shape inside a plan. Settled with the user 2026-08-24 over a config key and over no sweep at all.

#### [P03] Begun-ness and done-ness are two wire fields, not one (DECIDED) {#p03-two-fields}

`PlanDocEntry` gains `steps_done` (count of ledger rows with status `done`) and `steps_begun` (count of rows with status other than `pending`). Two facts, two fields: the fraction a row displays is `steps_done` over the total, while the Resume gesture triggers on `steps_begun > 0` — a plan whose first step is `in progress` with nothing done yet must read as begun (0 of N done, Resume) rather than unstarted. Deriving begun-ness in the deck from a single count would conflate the two.

**The denominator is the ledger, not the step headings.** Both counts and the fully-done test are computed over `doc.ledger_rows`, which is what the machinery itself trusts — `step_in` in `tugdash-core/src/ops.rs` takes its total from `doc.ledger_rows.len()`. `step_total` keeps its existing meaning (`doc.steps.len()`) so the wire field does not change under its other readers, and PL016 pins the two equal on any lintable plan. Where a malformed document makes them disagree, the drop test and the gesture still key off the ledger — the row may then show a fraction whose denominator is a heading count, which is a cosmetic artifact of a plan the linter already rejects, not a case to design around.

#### [P04] Resume outranks review state, in gesture and in order (DECIDED) {#p04-resume-outranks}

A begun plan's affordance is **Resume** with the `/tugplug:dash-implement <path>` prompt regardless of review state — `dash-implement`'s own setup gate re-checks the review and raises its ask if the plan went stale, so the deck does not pre-empt a decision the skill already owns. In `comparePlanRows`, begun plans rank above every unstarted plan: work in flight is nearer done than work not started, the same nearest-to-done principle the dash rows already encode.

**What a begun base copy actually means.** Not "a dash is working it" — a live dash's progress is written to the *worktree* copy while the base copy's ledger stays frozen, and [P06] removes that document from the listing anyway. The real driver is a **run that stopped short and joined**: `dash-implement` takes a step selector (`Steps 3-5`), so a plan can land with steps 1–3 `done` and 4–5 `pending`, and Resume is then exactly the right next gesture — one press re-enters at the first unfinished row, which is where `dash-implement`'s own ledger read resumes. Hand-driven implementation and a ledger edited outside a dash are the same shape.

#### [P05] Merge and rebase joins archive in a follow-up commit (DECIDED) {#p05-followup-commit}

The squash strategies fold the move into the landing commit (stage, `git mv`, commit — one commit on the base, docs dir never dirty between). `merge --no-ff` commits atomically and a cherry-picked rebase lands the rounds' own commits, so neither has a pre-commit seam; both take one follow-up commit `tugdash(<name>): archive the plan` immediately after the integrate, before the journal is written. Those strategies already land multi-commit shapes, so one more small commit is congruent with what the user chose. The join receipt still names the integrate commit.

**Undo covers both commits.** `oplog::capture_before` records `base_tip` — the base branch's sha before the join — and `dash undo` restores it, so unwinding a join reverts the integrate commit and any follow-up archive commit together, with no oplog change. `JoinStrategy::default()` is `Squash` and every Tug surface lands with the default, so the two-commit shape is a CLI-only path in practice.

#### [P06] A plan a live dash has adopted is not a plan row (DECIDED) {#p06-dedup-live-dashes}

The scan drops any plan document whose repo-relative path equals the `plan_path` of a dash entry in the same project. This is the act-2 fix, and it is what the cockpit plan's false [D139] reading was standing in for: because a *committed, clean* base copy is deliberately never removed ([#adoption-does-not-clean](#adoption-does-not-clean)), the plan a dash is implementing sits in the docs directory for the dash's whole life, ledger frozen at all-`pending`, reading as unstarted and offering Implement — an invitation to start a second dash on work already in flight, rendered directly beneath the dash row that already represents it.

**At the scan, not in the deck**, for the reason [P01] gives: the wire's `plans` list means "actionable paperwork", and a reader that has to subtract dash entries from it does not have that guarantee. The data is already there — `ChangesetEntry::Dash` carries `plan_path` (`tugcast-core/src/types.rs`), and `compose_aggregate` (`tugcast/src/feeds/changeset_all.rs`) holds the project's composed `ChangesetSnapshot` in scope at the line where `plans` is built, so the adopted paths are collected from `snapshot.changesets` and handed to `plan_doc_entries` as a set.

**The dash row is the better surface anyway.** It carries the live step counter, the stage, the ring, the bound session, and a `review` field read from the *worktree* copy — the copy a run actually edits — so every fact the plan row could show, the dash row shows more truthfully.

---

### Deep Dives {#deep-dives}

#### Adoption does not clean a committed base copy {#adoption-does-not-clean}

This is the finding the whole plan turns on, and it contradicts how [D139] is usually paraphrased — so read the decision's own words rather than the paraphrase: *"A committed, clean base copy is not a second live copy — it is ordinary branch divergence the squash resolves like any other file."*

In code (`tugrust/crates/tugdash-core/src/ops.rs`): `base_plan_dirt` classifies the base copy as `Clean` / `TrackedDirty` / `Untracked` / `Absent`; `BasePlanState::is_dirt` is true only for `TrackedDirty | Untracked`; and `clean_base_plan_copy` restores a `TrackedDirty` copy with `git checkout HEAD --`, removes an `Untracked` one, and returns `"untouched"` for everything else. So the clean fires only when the base copy is a genuine second *live* copy. A plan committed to the base branch before the dash was cut — `tugdash(x): draft plan …`, this repository's ordinary gesture — is `Clean`, and stays on base untouched until the join squashes the dash's version over it.

Confirmed empirically: `git log --oneline --diff-filter=D -- 'dash/*.md'` returns no commits. In this repository's entire history, no adoption has ever deleted a plan from the docs directory.

The consequence for any surface projecting the docs directory: **presence in the docs dir says nothing about whether a dash owns the document.** Only `plan_path` on the dash entries answers that ([P06]).

#### The join's integrate paths and where the sweep sits {#join-integrate-paths}

`join_in_with_progress` (`tugrust/crates/tugdash-core/src/ops.rs`) has four integrate arms: the **candidate path** (a pre-built resolution candidate, `opts.candidate`) with squash / merge / rebase shapes, and the **branch path** (no candidate) with the same three. In both squash arms the sequence is `git merge --squash <ref>` (stages index + worktree), then `git commit -m <final_msg>`; a staging conflict runs `reset --hard` and returns the conflict outcome, a commit failure runs `reset --hard` and errors. The sweep call sits between successful staging and the commit, in both arms, via one shared helper. The merge arms run `git merge --no-ff -m … <ref>` (commits atomically); the rebase arms run `merge --ff-only` or `cherry-pick <base>..<branch>`; in all four of those the helper runs after the integrate succeeds, and when it moved the file the caller commits `tugdash(<name>): archive the plan` before `write_join_journal`.

The helper — `archive_adopted_plan(repo_root, name, warnings) -> Option<(String, String)>` returning `(source_rel, dest_rel)` when it moved the file — resolves in this order, no-oping (returning `None`) at each miss: `dash_plan_path(repo_root, name)` (the `branch.tugdash/<name>.tugplan` config key, read before teardown can release it); `Config::load_from_project(repo_root)` and `docs_dir(repo_root)` (an undeclared or invalid docs dir means no archive home); source file exists in the base working tree (post-staging for squash — the squash is what materializes it); destination `<docs>/archive/<filename>` does **not** exist (a collision pushes a warning naming both paths and returns `None` — the join proceeds unswept, [R02](#r02-collision)). On success it creates `<docs>/archive/` if absent and runs `git mv <source_rel> <dest_rel>`, which stages the move.

The preview path (`opts.preview`) mutates nothing and never reaches the helper. The `--continue` teardown-resume path re-enters after the integrate already happened; a join interrupted between integrate and teardown has already swept (squash) or already committed the follow-up (merge/rebase) because the journal is written after both, so `--continue` needs no sweep logic.

#### What the scan knows and discards today {#scan-today}

`plan_doc_entries_in` (`tugrust/crates/tugcast/src/feeds/changeset.rs`) reads each top-level `.md` in the declared docs dir, gates on a `{#execution-steps}` substring, parses with `tugutil_core::plan::parse`, and emits `PlanDocEntry { path, display_name, review, step_total }` where `step_total` is `doc.steps.len()`. The parsed `PlanDoc.ledger_rows: Vec<LedgerRow>` is dropped — and `LedgerRow.status` (lowercased, trimmed; vocabulary `pending` / `in progress` / `done` per `LEDGER_STATUSES` in `tugutil-core/src/plan.rs`) is the fact this plan surfaces. The test helpers `plan_docs_project(docs)` and `write_plan_at(root, rel, stamped)` in `changeset.rs`'s test module scaffold scratch projects; `write_plan_at` grows a way to write ledger rows with chosen statuses.

#### The wire's readers, enumerated {#wire-readers}

Changing `PlanDocEntry` touches: `tugrust/crates/tugcast-core/src/types.rs` (the struct and its serde tests, including the `assert!(!json.contains("plans"))` empty-flatten guard), the golden fixture `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json` (project 0 carries a two-entry `plans` array today), and the deck readers: `tugdeck/src/lib/changeset-types.ts` (`PlanDocEntry` interface, `isPlanDocEntry`, the `isProjectChangeset` rung), `tugdeck/src/components/lens/sections/dashes-section.tsx` (`PlanRow`, `PlanCell`, `comparePlanRows`, `planRowsFromSnapshot`), and the fixture's test readers (`changeset-types.test.ts`, `dashes-section.test.ts`, `session-changes-dash-lane.test.ts`, `changes-route-controller.test.ts`, `dash-session-index.test.ts` — the latter three read the fixture but not `plans`; they must merely keep passing).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism |
|---|---|---|
| `steps_done` / `steps_begun` on `PlanDocEntry` | Server-owned external state | Rides the existing `CHANGESET_ALL` snapshot; read via the existing `useChangesetAll` (`useSyncExternalStore`, [L02]) |
| Which plans are listed at all (the [P06] dedup) | Server-owned external state | Decided in `compose_aggregate` before the snapshot is sent; the deck holds no membership state and no filter |
| Gesture label / prompt / order | Derived, render-time | Pure functions in `dash-prompts.ts` and `dashes-section.tsx`; no state |

No new client state, no new store, no persistence.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust unit (tugcast, `changeset.rs`)**: the scan's progress counting, the fully-done drop, the adopted-path drop and its complement, empty-ledger-is-unstarted, unknown-status-counts-as-pending.
- **Rust unit (tugcast-core, `types.rs`)**: `PlanDocEntry` serde with the new fields; the empty-flatten guard stays.
- **Rust unit (tugdash-core, `ops.rs`)**: the sweep on squash (folded into the landing commit — one commit, file at `archive/`, absent at top level), on candidate-squash, on merge and rebase (follow-up commit), collision skip + warning, no-plan and no-docs-dir no-ops, abort-path cleanliness.
- **bun table tests (`dash-prompts.test.ts`, `dashes-section.test.ts`)**: the four gesture states (begun → Resume/dash-implement; unstarted reviewed → Implement; stale and never-reviewed → Review), the ordering rank, the meta-line strings, golden-fixture parsing with the new fields.
- **App-test (`at0473-dash-cockpit.test.ts`)**: one begun fixture plan renders Resume with the right `data-prompt` and a `1 of 3 done` meta line; a fully-done fixture plan is absent from the rows; a plan adopted by a live dash leaves the plan list and appears as a dash row; existing assertions keep passing.

#### What stays out of tests {#test-non-goals}

- No app-test drives a real join — the sweep is exercised at the `ops.rs` layer where every existing join behavior is already pinned.
- No test presses a prompt affordance into a live session (unchanged from dash-cockpit: an app-test session is a real `--resume`; the prompt is asserted via `data-prompt`).
- No banned shapes: no jsdom/happy-dom renders, no mock stores.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The wire carries ledger progress and drops what is not waiting | done | `e5fdad6d7` |
| #step-2 | The deck derives the true gesture | done | `b124066bf` |
| #step-3 | The join archives the adopted plan | done | `d14472605` |
| #step-4 | The doctrine and this repository catch up | done | `69626697c` |
| #step-5 | Integration checkpoint | done | `f06e95732` |

#### Step 1: The wire carries ledger progress and drops what is not waiting {#step-1}

**Commit:** `Carry ledger progress on PlanDocEntry and drop finished and adopted plans`

**References:** [P01], [P03], [P06], [#scan-today](#scan-today), [#wire-readers](#wire-readers), [#adoption-does-not-clean](#adoption-does-not-clean)

**Tasks:**
- [ ] `tugrust/crates/tugcast-core/src/types.rs`: add `pub steps_done: u32` and `pub steps_begun: u32` to `PlanDocEntry`; update the struct's serde tests and every in-crate constructor the compiler names.
- [ ] `tugrust/crates/tugcast/src/feeds/changeset.rs`, `plan_doc_entries_in`: count over `doc.ledger_rows` — `steps_done` = rows with status `done`, `steps_begun` = rows with status ≠ `pending` (an unknown spelling counts as `pending`); when the ledger is non-empty and every row is `done`, skip the entry entirely.
- [ ] Same file: `plan_doc_entries` and `plan_doc_entries_in` take an `adopted: &HashSet<String>` of repo-relative plan paths and skip any document whose `rel` path is in it ([P06]). Exact match, no normalization ([L29]).
- [ ] `tugrust/crates/tugcast/src/feeds/changeset_all.rs`: at the `plan_doc_entries` call site, collect the adopted set from the already-composed `snapshot` — every `ChangesetEntry::Dash`'s `plan_path` that is `Some` — and pass it in.
- [ ] Extend `write_plan_at` (test helper) to write ledger rows with chosen statuses; add unit tests: fully-done dropped, partial counted, empty-ledger yields `0`/`0` and is kept, unknown status counts as pending, a path in the adopted set dropped, a path not in it kept.
- [ ] `tugdeck/src/lib/changeset-types.ts`: add the two fields to `PlanDocEntry` and the `isPlanDocEntry` guard.
- [ ] Update `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json`: project 0 currently carries `dash/dash-cockpit.md` (reviewed, `step_total` 5) and `dash/dash-hardening.md` (never-reviewed, `step_total` 3). Give the first the begun fields (`steps_done` 1, `steps_begun` 2) and the second the unstarted ones (`0`/`0`), then update `changeset-types.test.ts` expectations.

**Tests:** the Rust units above; `cd tugrust && cargo nextest run -p tugcast -p tugcast-core`; `cd tugdeck && bun test src/__tests__/changeset-types.test.ts`.

**Checkpoint:** both test commands green; `bunx tsc --noEmit` green in tugdeck; a unit test proves a plan named by a dash entry's `plan_path` is absent from that project's `plans`.

#### Step 2: The deck derives the true gesture {#step-2}

**Commit:** `Derive Resume for begun plans and order work in flight first`

**Depends on:** #step-1

**References:** [P03], [P04], [#wire-readers](#wire-readers)

**Tasks:**
- [ ] `tugdeck/src/lib/dash-prompts.ts`: `planNextGestureLabel` and `planNextGesturePrompt` take the entry's begun-ness — begun → `Resume` / `/tugplug:dash-implement <path>` regardless of review; unstarted keeps today's mapping. Keep both as pure functions over primitives (pass `steps_begun` or the entry, whichever reads cleaner at the call sites).
- [ ] `tugdeck/src/components/lens/sections/dashes-section.tsx`: `comparePlanRows` ranks begun above `reviewed` above `stale` above `never-reviewed`; `PlanCell` renders the begun meta line `plan · <review> · <steps_done> of <total> done` (unstarted keeps `plan · <review> · N steps`), and passes begun-ness into the label/prompt calls; `data-review` stays, add `data-begun` for the app-test.
- [ ] Replace the `PlanRow` docstring's "by construction unadopted" claim outright — it is false ([#adoption-does-not-clean](#adoption-does-not-clean)). Say what is now true: the scan lists only documents no dash has adopted and no ledger has finished, so a plan row is waiting paperwork by *filter*, not by construction.
- [ ] `tugdeck/src/lib/__tests__/dash-prompts.test.ts` and `dashes-section.test.ts`: table rows for all four gesture states, the new ordering, the meta strings.
- [ ] `tests/app-test/dash-fixture.ts`: `fixturePlanDocument` grows per-row status control; `tests/app-test/at0473-dash-cockpit.test.ts`: add a begun plan (assert Resume label, `data-prompt`, meta line) and a fully-done plan (assert absent). Confirm the file's existing three-plan-row and empty-state assertions still hold — the fixture plans are written all-`pending` by `fixturePlan`, so they stay listed.
- [ ] Add an app-test case for [P06]: with a fixture plan listed as a row, create a dash adopting it (`makeDashScratchRepo` + the dash fixture helpers already used in this file), and assert the plan row disappears while the dash row appears — the act-2 case, end to end.

**Tests:** `cd tugdeck && bun test src/lib/__tests__/dash-prompts.test.ts src/components/lens/sections/__tests__/dashes-section.test.ts`; `just app-test tests/app-test/at0473-dash-cockpit.test.ts`.

**Checkpoint:** both green; `bunx vite build` green; the [P06] app-test case fails if the dedup is removed.

#### Step 3: The join archives the adopted plan {#step-3}

**Commit:** `Sweep the adopted plan into the docs archive as part of the join`

**References:** [P02], [P05], [#join-integrate-paths](#join-integrate-paths), R01, R02

**Tasks:**
- [ ] `tugrust/crates/tugdash-core/src/ops.rs`: add `archive_adopted_plan(repo_root, name, warnings) -> Option<(String, String)>` exactly per [#join-integrate-paths](#join-integrate-paths) — resolve plan path, docs dir, source presence, collision (warning + skip), create `archive/` when absent, `git mv`.
- [ ] Call it in both squash arms between successful staging and `git commit`; in the merge and rebase arms (candidate and branch), call it after the integrate and, when it returns `Some`, commit `tugdash(<name>): archive the plan` before `write_join_journal`.
- [ ] Tests: squash join lands one commit with the plan at `<docs>/archive/` and absent at top level; candidate-squash same; merge and rebase land the follow-up commit; collision skips with a warning and the join succeeds; no adopted plan and no declared docs dir are no-ops; a forced commit failure after staging leaves the tree clean (`reset --hard` reverts the mv).

**Tests:** `cd tugrust && cargo nextest run -p tugdash-core`.

**Checkpoint:** the new tests plus the whole existing join suite green.

#### Step 4: The doctrine and this repository catch up {#step-4}

**Commit:** `Record the docs-directory lifecycle and archive this repository's finished plans`

**Depends on:** #step-1, #step-3

**References:** [P01], [P02], [#context](#context)

**Tasks:**
- [ ] `tuglaws/design-decisions.md`: add `[D159]` (the highest number in the file today is D158; confirm before writing) — **the docs directory's top level means live paperwork, and only a filter can say so.** Record the three facts: a *committed, clean* base plan copy is never removed by adoption ([D139]'s own words, routinely misread — quote them), so presence in the docs dir says nothing about ownership and only a dash entry's `plan_path` answers it; the join archives the adopted plan into `<docs>/archive/`; and the changeset scan lists a plan only when no dash has adopted it and its ledger is not fully `done`. Cite [D138], [D139], [D141].
- [ ] `tuglaws/plan-review-rubric.md`: add one clause to the reading discipline — a plan that projects repository files must trace the file's whole lifecycle, and its verification must include one render over the real repository's data, not only fixtures.
- [ ] `git mv` this repository's fully-done plans from `dash/` into `dash/archive/`: `dash-cockpit.md`, `dash-hardening.md`, `dash-hardening-2.md`, `dash-on-ramp.md`, `ink-anchored-ordering.md`, `paperwork-formats.md` (verify each ledger is fully `done` before moving; leave `dash-notes.md` and `dash-hardening-brief.md` — not plans).

**Tests:** none new — `tugutil plan lint` still exits 0 on this plan; the moved files are inert.

**Checkpoint:** the six files exist under `dash/archive/` and not at top level; both tuglaws edits read cleanly in context.

#### Step 5: Integration checkpoint {#step-5}

**Commit:** `Close the integration checkpoint`

**Depends on:** #step-1, #step-2, #step-3, #step-4

**References:** [#success-criteria](#success-criteria)

**Tasks:**
- [ ] `cd tugrust && cargo nextest run` across the workspace.
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`.
- [ ] `just app-test-changed` (or the core tier on a CORE TIER ADVISED advisory).
- [ ] Walk the Success Criteria and confirm each holds.

**Tests:** the sweeps above.

**Checkpoint:** every Success Criterion in this plan checked and holding; Step Status Ledger fully `done`.

---

### Deliverables {#deliverables}

- A wire whose `plans` list means exactly "actionable paperwork": progress carried, finished plans absent, adopted plans absent.
- A Dashes section whose rows state real facts — Implement, Review, or Resume with a true fraction — and never offer to implement work that is finished or already in flight.
- A join that archives its own paperwork into `<docs>/archive/` as part of landing, collision-safe and abort-safe, so the docs top level stays truthful by construction.
- Doctrine that records the lifecycle and a review rubric that asks for a render over real data.
- A docs directory in this repository containing only live paperwork at its top level.
