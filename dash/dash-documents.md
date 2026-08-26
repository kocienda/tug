## Dash documents live under the dash {#dash-documents}

**Purpose:** Move every dash document — the brief and the plan — to `<repo>/.tug/dashes/<name>/`, make the dash name the document's address on every verb, and delete the apparatus (adoption, `docs-dir`, the join-time archive, the repository's `dash/` tree) that existed only because the plan was a tracked file crossing the base/worktree boundary. Implements `dash/dash-documents-brief.md`, honoring [B01]–[B09].

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash `dash-documents`) |
| Last updated | 2026-08-25 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-25, opus.** Reviewed `plan:3be3e01b535117a6`. Lint: 0 errors, 1 warning (fixed — this section did not exist). Oriented on: the whole document; this is a first pass.
Applied: **Step 12 scope** — the tuglaws sweep named 17 files and omitted `design-decisions.md`, which alone carries 43 lines citing 53 distinct plan documents, and `focus-language.md`, while including `plan-review-rubric.md`, which carries none; the step could not have passed its own `grep -rn '\bdash/' tuglaws` gate as written, so the list is now derived and the design-decisions treatment is spelled out. **Root resolution** — [P01] asserted `repo` is always the main root, but `main_repo_root` is `pub(crate)` in `tugdash-core/src/ops.rs:3306` and unreachable from both callers that hold possibly-worktree paths (`dash_arc_runner.rs::read`'s `project`, the CLI's cwd); the path functions now normalize internally the way `join_preflight_in` does, and Steps 3 and 4 say so at their sites. **[P02]** — `validate_dash_name` (`tugdash-core/src/dash.rs:39`) already refuses `/`, `\`, `.`, and any `.md` suffix via its `^[a-z][a-z0-9-]*[a-z0-9]$` character class, so Step 1's "extend the validator" task was a no-op against a function with many callers; it is a pin test now, and the Assumptions entry says the assumption holds rather than that it will be checked. Also added the implication that the `Name` form is cwd-root-bound because `find_repo_root_from` does not walk up, while the `Path` form is not. **[P08]** — `git_exclude.rs` uses a `# tug:attachments` / `# end tug:attachments` **marked block** with start/end arithmetic, not "a preceding `# tug` marker line"; the task now names the real shape, gives the port its own marker pair, and carries over the module's three constraints. **Step 11** — the doctrine's "Never write to the base checkout. Not code, not a plan, not a ledger" bullet becomes false under this plan and was not in the edit list; added, along with the `dash discard` sentence that compares itself to returning an adopted plan. **Facts** — `at0478` is taken by `at0478-dash-fit-verified.test.ts` (new test renumbered `at0479`); `dash/archive` holds 515 tracked files, not 499; `dash/assets/` holds none, so `git rm` on it fails and `rm -rf` is what removes it.
Asked and settled: how a `tuglaws` citation of a deleted plan should read — the owner chose deleting the path token outright over an italic title; recorded as [P12] rather than left as a `[Q##]`.
Left alone: the plan's step order, its choice of mtime over commit for the "what changed" clause ([P07]), and the decision to put the documents strip on the Changes shade rather than in a card of its own — each is a defensible call the code supports, and none is mine to re-make.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The brief and the plan exist to carry decisions across the arc's cold session boundaries, and nothing in the machinery needs them to be tracked files: the runner resolves the document as `project.join(record.document)` (`tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs`, `read`), the step verbs need the plan at a known path (`tugrust/crates/tugdash-core/src/ops.rs`, `step_in`), and the deck displays plan paths without ever opening them. Being tracked is what made the documents a chore — [D139] adoption, base-copy divergence detection, `restore_plan_to_base`, the join-time `archive_adopted_plan` sweep into `dash/archive/`, and the `[tugtool.dash].docs` declaration read through `tugutil dash docs-dir` — and it left 517 tracked files under `dash/` that nothing reads.

This plan gives every dash one home, `<repo>/.tug/dashes/<name>/` holding `brief.md` and `plan.md`, beside the worktree home `.tug/worktrees/<name>` that already exists and is already gitignored here. The name becomes the address the verbs take, and every mechanism that managed the document's residence is deleted rather than adapted.

#### Strategy {#strategy}

- **Address first, then re-point, then delete.** Land the new home and the name resolver in `tugdash-core` with tests before any consumer moves; re-point the step verbs, the plan verbs, and the arc runner; only then remove adoption and `docs-dir`, so no step leaves a verb with nowhere to read from.
- **The arc reads the same things it reads today.** The document is still a file; `cited_paths` still harvests backticked paths from it; the ledger is still a table `plan::set_ledger_status` drives. Only where the file lives and how it is named on the wire change ([B07]).
- **Derive, never declare** ([D138]). "This dash has a plan" is the existence of `plan.md`; no config key records it. The `branch.tugdash/<name>.tugplan` key goes away with adoption.
- **The wire carries absolute document paths, composed where the main root is known** ([D138]). The deck composes nothing.
- **A dash that exists only as documents is a dash.** A `.tug/dashes/<name>/` with no branch is the planning phase in flight; the changeset feed lists it, which is what the Lens and the Session card render ([B08]) and what replaces the docs-directory scan behind the Lens's "waiting paperwork" rows.
- **The repository deletion is last**, because this plan's own copy lives in `dash/` under the old machinery for the length of the run (see Risk R04).

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil dash run <name>` with no `--document` opens an arc on `.tug/dashes/<name>/brief.md` (or `plan.md` when only that exists); `dash step`, `plan status|stamp|lint` accept the bare name (Rust tests, Steps 3–4).
- `grep -rn 'docs_dir\|docs-dir\|adopt_plan\|adopt-plan\|restore_plan_to_base\|archive_adopted_plan\|tugplan' tugrust tugdeck tugplug tuglaws tests` returns nothing outside the git history (grep, Steps 5–6, 11).
- `git ls-files dash` prints only this plan and its brief at the run's end, and nothing after the join residue is cleared (prose assertion, Step 12; Risk R04).
- On a scratch repository with no `.gitignore`, no `dash/`, and no `docs` key: `/dash` writes the brief under `.tug/dashes/<name>/`, devise writes `plan.md` beside it, review stamps it by name, implement walks the ledger by name, the join lands a commit whose tree contains no document, and `git status --porcelain` on the base is empty at every stage (Rust test, Step 5; app-tests, Step 10).
- The Session card bound to a dash shows its brief the moment `brief.md` exists and its plan the moment `plan.md` exists, before any branch is cut (app-test, Step 10).

#### Scope {#scope}

1. `tugdash-core`: the documents home, enumeration, the name-or-path argument rule, `.tug/` exclusion, and re-pointing `step_in`, `dash_detail_entries_in`, `reconcile_ledger_cells`, `join_ready`, `discard_in`, and the join teardown.
2. `tugutil`: `dash run <name>`, `dash step` without `--plan`, `dash create` without `--plan`, a new `dash documents <name>` reporter, `plan lint|status|stamp <name-or-path>`, deletion of `dash adopt-plan` and `dash docs-dir`.
3. `tugcast`: the arc runner and conductor prompts by name, the changeset feed's `documents` on dash entries and its document-only dash list, deletion of `plan_doc_entries`.
4. `tugdeck`: wire types, the Lens Dashes section's document-dash rows, the Session card's documents strip, the identity line, `/plan-review` target resolution.
5. Skills and doctrine: `tugplug/CLAUDE.md`, the `dash`, `plan-devise`, `plan-review`, `dash-implement` skills, `tuglaws/dash-work-doctrine.md`, `tuglaws/dash-lifecycle.md`, the [D139] rewrite.
6. Repository: delete `dash/` (517 tracked files), the `docs` key and the `dash/` prose-surface path in `.tugtool/config.toml`, the `dash/` row in `CLAUDE.md`, and the `dash/*.md` links in `tuglaws/` and `Justfile`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Storing documents in a ledger database (brief, Non-goals).
- App-support as the documents' home; the dash-log stays where it is ([B09]).
- Preserving archived plans anywhere (brief, Non-goals; [F06]).
- Changing `brief-skeleton.md`, `devise-skeleton.md`, `plan lint`, the content stamp, or the arc's stage sequence ([B07]).
- Retiring the path form of the `plan` verbs — a hand-written plan outside any dash stays lintable and reviewable by path ([B02]).
- Redesigning the Lens dash row or the `DashMetaLine` grammar beyond the one string the brief's Open Question names (`dash/dash-notes.md`'s styling items are separate work).
- Deleting `tugcast/src/attachments.rs::draft_docs_dir` or its `draft_gc.rs` caller — see [#the-other-docs-dir](#the-other-docs-dir).

#### Dependencies / Prerequisites {#dependencies}

- A built `tugutil` in the dash worktree (`cd tugrust && cargo build -p tugutil`) for the app-tests that shell the CLI — `tests/app-test/dash-fixture.ts::tugutilPath` prefers the worktree's own `tugrust/target` binary.
- `just build-app` before any app-test that exercises tugcast changes (Steps 7–10): the app-test recipe refreshes `dist` but never rebuilds the app bundle.

#### Constraints {#constraints}

- Warnings are errors across the Rust workspace (`-D warnings`).
- No fake-DOM, RTL, or mock-store tests; browser behavior is proved in `tests/app-test/` via `just app-test <file>` with `@covers` lines.
- Every tugdeck change under `components/tugways/` or `components/lens/` names the laws it upholds in its round's commit body.
- Never write to the base checkout from the worktree; every path in this run is absolute into the worktree.
- `tugplug/` edits do nothing live until the app bundle is rebuilt; the skills are read by Claude Code from the bundle's `Resources/tugplug/`.

#### Assumptions {#assumptions}

- `tugdash_core::validate_dash_name` already rejects every path-shaped name: its pattern is `^[a-z][a-z0-9-]*[a-z0-9]$` over a lowercase/digit/hyphen character class, so `/`, `\`, and `.` are all refused and a `.md` suffix is unreachable (`tugdash-core/src/dash.rs`, verified 2026-08-25). A validated name is therefore already safe as a single directory component; Step 1 pins the property with a test rather than changing the validator.
- Nothing outside `tugutil-core/src/lib.rs` calls `resolve_plan` / `find_tugplans` / `plan_search_dirs` (verified by grep on 2026-08-25; Step 6 re-greps before deleting).
- A join's `undo` need not restore the removed documents directory; the squash commit is the record ([B05], Risk R03).

---

### Reference and Anchor Conventions {#reference-conventions}

Explicit `{#anchor}` on every heading cited below; kebab-case, no phase numbers. Plan-local decisions are `[P##]`; global decisions are cited as `[D##]` from `tuglaws/design-decisions.md`; the brief's decisions are cited as `[B##]` from `dash/dash-documents-brief.md`. Steps cite anchors, never line numbers.

---

### Open Questions {#open-questions}

None open. The brief's one question — what the identity line says once there is no repo path — is decided in [P09]: the line never showed the path; it showed `no plan adopted` when none was recorded, and that string becomes `no plan yet`. Review round 1 raised one more — how a `tuglaws` citation of a deleted plan should read — and it was asked and settled rather than deferred; it is [P12].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A project with no `.gitignore` shows `.tug/` as untracked, dirtying the base | med | high | `ensure_tug_excluded` writes `/.tug/` to `.git/info/exclude` ([P08]) | `git status` on a scratch repo lists `.tug/` |
| Losing the "what changed since this document was written" clause once the document is untracked | med | high | key it on the file's mtime instead of its last commit ([P07]) | a devise prompt with cited paths but no `what changed` clause on a repo with commits since |
| `undo` of a join cannot restore the removed documents | low | low | accept; the squash commit is the record ([B05]); the receipt says the directory was removed | a user asks for a joined dash's brief back |
| This dash's own plan lives under the old machinery for the run | med | certain | Step 12 keeps `dash/dash-documents.md` and its brief until the join; the join's old-binary archive residue is cleared by hand afterwards (Risk R04) | `git ls-files dash` non-empty after the join |

**Risk R01: A branchless dash has no owner key the binding store can match** {#r01-branchless-owner-key}

- **Risk:** Session bindings are keyed by `dash_owner_key(repo, name)`, which reads `branch.tugdash/<name>.tugid` and falls back to the name; a document-only dash has no branch config, so its entry's `owner_id` must be composed the same way or the bound card will not find its own row.
- **Mitigation:** Step 7 composes `owner_id` for document-only dashes with the same `tugdash_core::ops::dash_owner_key`, which already handles the id-less case via `legacy_owner_key`. Step 10's app-test binds a card to a branchless dash and asserts the strip appears.
- **Residual risk:** A dash created later under the same name mints a `tugid` and the owner key changes; the binding store already re-reads on `bind_dash_ok`, and the card is re-bound by `dash create`'s `claim_dash`.

**Risk R02: The Lens plan-row gesture prompts change spelling** {#r02-lens-gesture-spelling}

- **Risk:** `dash-prompt-target.ts::planNextGesturePrompt` builds `/tugplug:plan-review <path>` and `/tugplug:dash-implement <path>`; by name those become `<name>`, and `at0473` asserts the exact prompt strings.
- **Mitigation:** Step 9 rewrites the prompt builder and the test together; the `data-prompt` attribute stays the single rendered string.
- **Residual risk:** none beyond the test.

**Risk R03: A join's undo does not bring the documents back** {#r03-undo-no-documents}

- **Risk:** `finish_join_teardown` removes `.tug/dashes/<name>/`; `tugutil dash undo` restores branches and the base, not that directory.
- **Mitigation:** The join receipt names the removal. The documents' content survives as the squash commit's argument (the join draft) and the dash-log's rounds; nothing in the code reads a joined dash's documents ([F06]).
- **Residual risk:** a user who wanted the brief's prose after the join reads the commit instead.

**Risk R04: This dash retires the machinery that is walking it** {#r04-self-hosting}

- **Risk:** The run's `tugutil dash step` calls go through `~/.local/bin/tugutil`, which is main's *old* binary, driving the plan copy adopted into the worktree at `dash/dash-documents.md`. Deleting `dash/` in Step 12 would delete the ledger the run is writing, and the release app's old `archive_adopted_plan` will move the plan into `dash/archive/` at the join.
- **Mitigation:** Step 12 deletes everything under `dash/` except `dash/dash-documents.md` and `dash/dash-documents-brief.md`. The Integration Checkpoint's report tells the user that the join will land `dash/archive/dash-documents.md` plus the brief under `dash/`, and that `git rm -r dash/` on main afterwards is the one-line residue of the old machinery joining the dash that retired it.
- **Residual risk:** one follow-up commit on main by the user.

---

### Design Decisions {#design-decisions}

#### [P01] The documents home is `<repo>/.tug/dashes/<name>/`, spelled in one place (DECIDED) {#p01-documents-home}

**Decision:** `tugdash_core::ops` gains `documents_dir(repo, name) -> PathBuf` (`<repo>/.tug/dashes/<name>`), `brief_file(repo, name)` (`…/brief.md`), `plan_file(repo, name)` (`…/plan.md`), and `document_dashes(repo) -> Vec<String>` (every child directory of `<repo>/.tug/dashes/` whose name passes `validate_dash_name`). The directory component is the validated raw name — not `sanitize_branch_name`'s spelling — so enumeration maps a directory back to its dash with no inverse function.

**Rationale:**
- [B01]: per-repo, beside `.tug/worktrees/<name>` (`new_worktree_path`), already gitignored in this repository.
- One spelling, the way `plan_config_key`/`base_config_key` are each spelled once today (`tuglaws/dash-lifecycle.md`).
- The worktree directories use `sanitize_branch_name` because git branch names constrain them; nothing constrains a directory name beyond `validate_dash_name`, and a raw name round-trips.

**Implications:**
- `repo` is always the **main** repository root, whichever checkout asked — the same rule every dash op already follows. Each of these functions **normalizes its `repo` argument through `main_repo_root` itself**, the way `join_preflight_in` does, rather than trusting the caller: `main_repo_root` is `pub(crate)` in `tugdash-core/src/ops.rs:3306` and so is unreachable from `tugutil` and `tugcast`, and both of them hold paths that may be linked worktrees (`dash_arc_runner.rs::read`'s `project` is a card's project directory; the CLI's is the cwd's root). Without the internal normalization a dash worktree would resolve its own empty `.tug/dashes/`, and the run would write a second ledger nothing reads.
- `documents_dir` is created lazily by whichever verb first writes into it (`dash run`, the brief write, devise), never by `dash create`.

#### [P02] The name is the address; the argument's shape decides name versus path (DECIDED) {#p02-name-or-path}

**Decision:** `tugdash_core::ops::DocumentArgument::parse(arg: &str) -> DocumentArgument::{Name(String), Path(PathBuf)}`: an argument containing `/` (or `\`), starting with `.`, or ending in `.md` is a path; anything else is a dash name. `tugutil plan lint|status|stamp` and `plan-review`'s target resolution use it; a `Name` resolves to `plan_file(main_repo_root(cwd), name)`, a `Path` resolves relative to the cwd exactly as today. `tugutil dash run|step|documents` take names only.

**Rationale:**
- [B02] verbatim: "a name that is a dash resolves to its `plan.md`, anything containing a separator or ending `.md` is a path."
- The rule is pure and lives in `tugdash-core` so the CLI and tugcast (the Lens's `/plan-review` target, `session-card.tsx`'s `resolvePlanReviewTarget`) agree.

**Implications:**
- A dash named `foo.md` is impossible to address by name, and needs no new rule to make it so: `validate_dash_name` already refuses `.` (Assumptions). Step 1 pins the property so a later loosening of the validator cannot silently reopen the ambiguity.
- The `Name` form resolves against the repository root found from the cwd, and `tugutil_core::find_repo_root_from` does **not** walk up parent directories — it answers only for a checkout root or a linked-worktree root. So `tugutil plan status <name>` run from `tugrust/` fails the same way `tugutil dash list` already does there, while the `Path` form keeps working from anywhere. That asymmetry is the existing behavior of the whole `dash` namespace, not a new rule; the refusal names it (`not in a git repository — run from the checkout root, or pass the plan's path`).

#### [P03] The `tugplan` branch config key is deleted; "has a plan" is `plan_file(...).is_file()` (DECIDED) {#p03-no-tugplan-key}

**Decision:** `plan_config_key`, `dash_plan_path`, `set_dash_plan_path`, and `resolve_plan_rel` in `ops.rs` are deleted. Every reader — `step_in`, `dash_detail_entries_in`, `join_ready`'s `has_plan`, `replay.rs::reconcile_ledger_cells`, `discard_in`, `join_blockers_from_detail` — asks the filesystem through [P01].

**Rationale:**
- [D138]: anything git (or the filesystem) can see is derived on every read and never stored.
- The key existed to remember *where in the worktree* the adopted copy was; there is no longer a choice to remember.

**Implications:**
- `DashDetail.plan_path: Option<String>` becomes `documents: DashDocuments { brief: Option<String>, plan: Option<String> }`, both **absolute** paths, present only when the file exists ([P05]).
- `dash step` loses `--plan`; `dash create` loses `--plan`; `StepOutcome.plan_path` becomes `plan: String` (absolute).

#### [P04] A dash directory with no branch is a dash the feed lists (DECIDED) {#p04-document-only-dash}

**Decision:** `ProjectChangeset.plans: Vec<PlanDocEntry>` is replaced by `document_dashes: Vec<DocumentDashEntry>` — one per name in `document_dashes(repo)` that has no `tugdash/<name>` branch — carrying `owner_id`, `display_name`, `documents` ([P05]), `review`, `step_total`, `steps_done`, `steps_begun`, and `arc: Option<DashArcState>`. Dashes with branches keep their `ChangesetEntry::Dash` and gain `documents` on it. The Lens's Dashes section renders document-only dashes where it rendered plan rows; the Session card renders one as its fronted dash when bound to it.

**Rationale:**
- [B04] deletes the docs-directory scan that produced `PlanDocEntry`; the honest replacement lists what the new home holds.
- [B08]: "what makes the planning phase visible as in-flight instead of the dash appearing only when the plan lands" — a dash whose brief exists is already in the feed.
- One row per name whether or not a branch exists; a `dash create` turns the document row into a live row rather than adding a second one (the `adopted` dedup in `changeset_all.rs` disappears with it).

**Implications:**
- `owner_id` is `dash_owner_key(repo, name)` for both kinds (Risk R01).
- `DashChangesetEntry.branch` is already `Option<String>` on the deck; a document-only dash is *not* a `ChangesetEntry::Dash` (that entry carries `worktree`, `base`, `rounds`, `files` that have no value for it) — it is its own list, rendered by its own cell, exactly as `PlanRow` is today.

#### [P05] The wire carries absolute document paths under one `documents` object (DECIDED) {#p05-documents-on-the-wire}

**Decision:** `tugcast_core::types::DashDocuments { brief: Option<String>, plan: Option<String> }`, absolute paths, omitted when neither exists; on `ChangesetEntry::Dash` as `documents` (replacing `plan_path`) and on `DocumentDashEntry`. The deck's `plan-review.ts::resolvePlanReviewTarget` takes `boundDash: { plan: string } | null` and returns it verbatim.

**Rationale:**
- [D138]: a path handed outward is absolute, resolved where the main root is known; today's `worktree` + `plan_path` join on the deck is exactly the composition this removes.
- The deck never opens the files ([F07]) except through `openFileInCard`, which takes an absolute path.

**Implications:**
- `changeset-types.ts::isDashChangesetEntry` validates `documents` as an optional record of optional strings; `PlanDocEntry`/`isPlanDocEntry` are deleted.

#### [P06] The Session card's documents strip is rows that open the file in a Text card (DECIDED) {#p06-documents-strip}

**Decision:** The Changes shade's dash lane (`session-changes-dash-lane.tsx`) renders, on the fronted dash's row, a **documents strip**: one `TugListRow` per existing document (`brief`, `plan`), each carrying the document's role, its first heading's text, and for the plan its `review` and `steps_done/step_total`, and each opening the file in a Text card through `openFileInCard(store, absPath)` on click. When the card is bound to a document-only dash ([P04]) the lane renders that dash as its fronted row with the strip and no diff, join, or discard affordances.

**Rationale:**
- [B08]: the documents were readable because they were files the user could open; opening them in the Text card is the same act on the same file, and hand-editing is the same gesture.
- `openFileInCard` (`tugdeck/src/lib/open-file-in-card.ts`) already routes `.md` to the Text card and reuses an open card by path; no new viewer is hand-rolled ([L19]).
- The strip is a face on the room where the dash's facts already live — the doctrine's argument for the dash lane (`session-changes-dash-lane.tsx` module docblock).

**Implications:**
- The first heading is read on the server (`DashDocuments` gains `brief_title: Option<String>`, `plan_title: Option<String>`), because the card has no filesystem.
- State Zone Mapping: see [#state-zone-mapping](#state-zone-mapping).

#### [P07] "What changed since this document was written" is keyed on the file's mtime (DECIDED) {#p07-commits-since-mtime}

**Decision:** `dash_arc_runner.rs::read` replaces `last_commit_touching(project, doc)` with the document file's modification time and calls a new `tugdash_core::ops::commits_touching_after(repo, since: SystemTime, paths, cap)` running `git log --since=<ISO-8601> --format=%h %s -- <paths>`. `last_commit_touching` and `commits_touching_since` are deleted if the runner was their only caller (Step 4 greps).

**Rationale:**
- An untracked document has no last commit; without this the clause vanishes silently, which is the regression Risk R01 in the table names.
- The clause's meaning was always "since the author wrote this"; mtime is that fact more directly than the commit that landed it.

**Implications:**
- The runner test `a_devise_prompt_names_the_files_its_document_cites` and its `what changed` companions set the fixture document's mtime with `filetime`-free `std::fs::File::set_modified` (stable since Rust 1.75) before committing.

#### [P08] `.tug/` is excluded by the verb that first needs it (DECIDED) {#p08-tug-excluded}

**Decision:** `tugdash_core::ops::ensure_tug_excluded(repo)` appends `/.tug/` to `<git-common-dir>/info/exclude` when `git check-ignore -q .tug` fails, idempotently and quietly. Called from `create` (before `worktree add`) and from every writer that creates `documents_dir` (`dash run`, `dash documents --ensure`, the step verbs).

**Rationale:**
- The brief's exit proof is `git status` clean on a scratch repository with no `.gitignore`; today `.tug/worktrees/` already dirties such a base and nothing addresses it.
- `tugcast/src/git_exclude.rs::ensure_assets_excluded` proves the shape (anchored line, marked block, never touches the project's `.gitignore`); it is `pub(crate)` in tugcast, so the core gets its own small copy of the exclude-line logic rather than a cross-crate dependency from `tugdash-core` on `tugcast`.

**Implications:**
- The existing `ops.rs` fixtures that write `.gitignore` with `.tug/` keep working; a new test creates a repo without one and asserts `git status --porcelain` is empty after `dash run` writes a brief.

#### [P09] The identity line says `no plan yet` (DECIDED) {#p09-identity-line}

**Decision:** `dash-meta-line.tsx`'s empty-note case, `no plan adopted`, becomes `no plan yet`, rendered when `entry.documents?.plan` is undefined. Nothing else on the line changes.

**Rationale:**
- The brief's Open Question. The line never rendered the path (the deck's ten readers display `plan_path` only as an existence fact); "adopted" was the vocabulary of the mechanism this plan deletes.

**Implications:**
- `dash-review.ts::dashReviewTooltip` keeps its `planPath` clause with the absolute path — it is actionable there.

#### [P10] The stage asks name the dash; the divider names the file (DECIDED) {#p10-stage-asks}

**Decision:** `conductor::prompt::stage_ask` composes `devise` as `/tugplug:plan-devise a plan for <brief-rel>, honoring every [B##] decision it records 🢂 <name>`, `review` as `/tugplug:plan-review <name>`, and `implement` as `/tugplug:dash-implement <name>[ Steps N-M]`, where `<brief-rel>` is the repo-relative document path (`.tug/dashes/<name>/brief.md`). `RotationRequest.document` stays the repo-relative path, so `stageNoteText` (`tugdeck/src/lib/code-session-store/stages.ts`) renders `devise · opus · .tug/dashes/foo/brief.md` unchanged.

**Rationale:**
- [B02]: the arc never needs the path form; the skills resolve a name through `tugutil dash documents <name>`.
- The devise ask keeps a readable path for the model's first read because the brief is what it opens; the *target* is the name so the skill cannot write anywhere else.

**Implications:**
- `ArcRecord.document` and `ArcRecord.plan` keep holding repo-relative paths; the dash-log format does not move ([B09]).
- `at0474` expectations change from `dash/foo-brief.md` to `.tug/dashes/foo/brief.md` and from `dash/foo.md` to `foo`.

#### [P11] The join removes the documents; the discard keeps them and says so (DECIDED) {#p11-join-removes-discard-keeps}

**Decision:** `finish_join_teardown` removes `documents_dir(repo, name)` after the branch is deleted and before the terminal dash-log line, pushing a `removed .tug/dashes/<name>/` entry into the join receipt's lines. `discard_in` leaves the directory in place and `DiscardOutcome.plan_restored` becomes `documents_kept: Option<String>` (the directory, when it exists); the CLI receipt and the deck's discard confirmation sentence say the documents stay and that `dash run <name>` reopens on them.

**Rationale:**
- [B05] verbatim.
- The `arc_devised` branch in `discard_in` (a devised plan "went with the dash") is exactly the kind of residence bookkeeping [B03] deletes.

**Implications:**
- `archive_adopted_plan`, `commit_archived_plan`, and the four `test_join_*_archives_the_plan*` tests are deleted (Step 5).

#### [P12] A deleted plan leaves no citation behind (DECIDED) {#p12-provenance-deleted}

**Decision:** Where `tuglaws/design-decisions.md` cites the plan that produced a decision — 43 lines, 53 distinct documents, in the trailing form `` `dash/plan-adoption.md` [P01], [P05], [P08]. [D138], [L23] `` — Step 12 deletes the path token **and its `[P##]` pins**, keeping the `[D##]`/`[L##]` cross-references. No italic title replaces it. In the other seventeen `tuglaws/*.md`, where a `dash/…` reference is usually a prose "see X for the rationale" pointer rather than a footer, the italic-title rule in Step 12 stands.

**Rationale:**
- [B06]: the durable record of a landed change is its commit. A title naming a document deleted in the same step is a pointer to nothing, which is worse than silence because it reads as retrievable.
- `[P##]` pins into a deleted document are the exact failure `3fbe941f8` (*citation-cleanup: drop stale internal pin citations from doc comments*) already corrected in the code — the same argument, one surface later.
- The two surfaces differ in what the reference *does*: a footer asserts provenance and nothing else, while a prose pointer is load-bearing in its sentence and needs a noun left where it stood.

**Implications:**
- Asked and settled in review round 1; recorded here rather than left as a `[Q##]`.
- The sweep is mechanical but not blind: `design-decisions.md` line 319 (`Z1B`) carries a live markdown link, not a footer, and is edited by hand (Step 12).

---

### Deep Dives {#deep-dives}

#### Where the plan is read and written today {#plan-read-write-map}

| Site | Today | After |
|---|---|---|
| `ops.rs::step_in` | `worktree.join(dash_plan_path(...))`, refuses on `base_plan_dirt` | `plan_file(repo, name)`; no base check |
| `ops.rs::dash_detail_entries_in` | `plan_path = dash_plan_path(...)` | `documents = DashDocuments::read(repo, name)` |
| `ops.rs::join_ready` / `dash.rs::unfinished_tracked_dirt` | excludes the plan from worktree dirt; `has_plan = plan_path.is_some()` | the plan is never in the worktree, so `unfinished_tracked_dirt` is `!dirt.is_empty()` and takes no plan argument; `has_plan = plan_file(...).is_file()` |
| `replay.rs::reconcile_ledger_cells` | reads `worktree/plan_path`, rewrites cells, `commit_remap` commits them | reads `plan_file(repo, name)`, rewrites cells, **no commit** (`Reconciled.commit` and `commit_remap` are deleted; the `replayed` dash-log line still records the remap) |
| `ops.rs::discard_in` | `restore_plan_to_base` / `arc_devised` | leaves `documents_dir`; receipt names it ([P11]) |
| `ops.rs::finish_join_teardown` + `integrate_join` | `archive_adopted_plan` into `<docs>/archive/` | `remove_dir_all(documents_dir)` ([P11]) |
| `changeset.rs::dash_plan_reading` | `worktree_abs.join(plan_path)` | takes the absolute `documents.plan` |
| `changeset.rs::plan_doc_entries_in` | scans `config.docs_dir(root)` | deleted; `document_dash_entries_in(root)` scans `document_dashes(root)` minus branches ([P04]) |
| `dash_arc_runner.rs::read` | `project.join(record.document)`; `devise_target = <docs>/<dash>.md`; `plan_for_prompt` = worktree copy after adoption | `document_abs = brief_file or plan_file`; `devise_target = plan_file` (repo-relative); `plan_for_prompt = name` |
| `tugutil/src/plan.rs` | `Path::new(&path)` | `DocumentArgument::parse` → name or path ([P02]) |
| `tugdeck` `plan-review.ts` | `joinPath(worktree, plan_path)` | `boundDash.plan` verbatim ([P05]) |

#### The arc's document is the brief or the plan {#arc-document-rule}

`tugutil/src/dash.rs::open_arc` takes `document: Option<&str>` today and refuses `(None, None)`. After Step 3 the verb has no `--document`: `open_arc(root, name)` looks for `brief_file` then `plan_file`, records the first that exists as the `arc-start` note (repo-relative, e.g. `.tug/dashes/foo/brief.md`), and refuses with `dash 'foo' has no brief or plan at .tug/dashes/foo/ — write one first` when neither exists. A second `run` on a name with an open arc resumes it (the existing `resume_arc` path). `lints_as_plan` in the runner still decides whether devise is skipped: an arc whose document is `plan.md` skips straight to review.

#### The other `docs_dir` {#the-other-docs-dir}

The brief's [F04] lists `tugcast/src/attachments.rs` and `draft_gc.rs` among `docs_dir` consumers. Read them: `attachments.rs::draft_docs_dir()` is `data_dir().join("draft-docs")` — the per-instance asset home for **not-yet-saved Text-card drafts** — and `draft_gc.rs` prunes it. Neither reads `[tugtool.dash].docs`. They are a naming coincidence, not consumers, and Step 6 does not touch them.

#### What `tugutil dash documents <name>` reports {#documents-verb}

```
tugutil dash documents <name> [--json] [--ensure]
```

Prints the directory and both files with existence, e.g.

```
dash:   foo
dir:    /repo/.tug/dashes/foo
brief:  /repo/.tug/dashes/foo/brief.md (exists)
plan:   /repo/.tug/dashes/foo/plan.md (absent)
```

JSON: `{ "dash", "dir", "brief", "plan", "brief_exists", "plan_exists" }`. `--ensure` creates the directory (calling `ensure_tug_excluded`, [P08]) so a skill can write into it with one prior call. It takes a name only; a dash that has no directory is a state, not an error (exit 0, both `false`). This is the verb the skills use where they used `docs-dir`.

#### The skills after this plan {#skills-after}

- **`/dash`** Orient: `tugutil dash list --json`, `tugutil dash status`, and `tugutil dash arc <name> --json` per dash; no `docs-dir`. "Find what this conversation already wrote" intersects `tugutil changes --json` with `.tug/dashes/*/` — but those files are gitignored and never appear in the changes ledger, so that paragraph becomes: for each name in `dash list` and each directory under `.tug/dashes/`, `tugutil dash documents <name>` says whether a brief or plan exists. Sharpen ends by settling the name, then `tugutil dash documents <name> --ensure --json` and writing the brief to the `brief` path it prints; hand off with `tugutil dash run <name>`.
- **`plan-devise`** "Where the plan goes": an explicit path in the invocation wins; a bare **name** resolves through `tugutil dash documents <name> --ensure --json` to its `plan` path; with neither, ask once for the name. The `docs-dir` section, its `declared: false` dialog, and the guardrail bullet are deleted.
- **`plan-review`** Input: `<name-or-path>` per [P02]; the off-arc hand-off chip becomes `` `/tugplug:dash-implement <name>` `` (or the path when reviewing by path).
- **`dash-implement`** Setup: `tugutil dash create <name> --description "…" --json` with no `--plan`; the plan is read from `tugutil dash documents <name>`'s `plan` path; the review gate is `tugutil plan status <name> --json`; the `adopt-plan` ask-fork bullet under "Refusals" is deleted; `dash step … [--plan <path>]` loses the option; the `[D139]` paragraph is replaced by one sentence — the plan lives at `.tug/dashes/<name>/plan.md` and nothing copies it anywhere.

---

### Specification {#specification}

**Spec S01: `DashDocuments`** {#s01-dash-documents}

Rust (`tugdash-core/src/ops.rs`, re-exported from `lib.rs`; mirrored in `tugcast-core/src/types.rs` for the wire):

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashDocuments {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub brief: Option<String>,        // absolute
    #[serde(default, skip_serializing_if = "Option::is_none")] pub brief_title: Option<String>,  // first `#`/`##` heading text
    #[serde(default, skip_serializing_if = "Option::is_none")] pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub plan_title: Option<String>,
}
impl DashDocuments {
    pub fn read(repo: &Path, name: &str) -> Self;   // stats both files; a title read failure leaves the title None
    pub fn is_empty(&self) -> bool;
}
```

TypeScript (`tugdeck/src/lib/changeset-types.ts`): `interface DashDocuments { brief?: string; brief_title?: string; plan?: string; plan_title?: string }` with `isDashDocuments`.

**Spec S02: `DocumentDashEntry`** {#s02-document-dash-entry}

```rust
pub struct DocumentDashEntry {
    pub owner_id: String,          // dash_owner_key(repo, name)
    pub display_name: String,      // the name
    pub documents: DashDocuments,  // never empty — an empty directory is not listed
    #[serde(default, skip_serializing_if = "Option::is_none")] pub review: Option<String>,
    pub step_total: u32, pub steps_done: u32, pub steps_begun: u32,   // 0 when there is no plan
    #[serde(default, skip_serializing_if = "Option::is_none")] pub arc: Option<DashArcState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub bound_sessions: Vec<String>,
}
```

`ProjectChangeset.document_dashes: Vec<DocumentDashEntry>`, sorted by name, replacing `plans`. TypeScript mirror `DocumentDashEntry` / `isDocumentDashEntry`.

**Spec S03: `DocumentArgument`** {#s03-document-argument}

```rust
pub enum DocumentArgument { Name(String), Path(PathBuf) }
impl DocumentArgument {
    /// Path when the argument contains `/` or `\`, starts with `.`, or ends in `.md`; else Name.
    pub fn parse(arg: &str) -> Self;
}
```

**Spec S04: CLI surface** {#s04-cli-surface}

| Verb | Before | After |
|---|---|---|
| `dash create <name>` | `[--plan <path>] [--carry] [--base <b>]` | `[--carry] [--base <b>]` |
| `dash adopt-plan <name>` | exists | **deleted** |
| `dash docs-dir [--set]` | exists | **deleted** |
| `dash documents <name>` | — | **new** ([#documents-verb](#documents-verb)) |
| `dash run <name>` | `[--document <path>]` | no `--document`; opens on brief then plan |
| `dash step <name> start <n> --through <m>` | `[--plan <path>]` | no `--plan` |
| `plan lint\|status\|stamp <arg>` | path | name-or-path ([P02]) |

**Spec S05: Join and discard receipts** {#s05-receipts}

- Join receipt lines gain `removed .tug/dashes/<name>/` when the directory existed.
- `DiscardOutcome.documents_kept: Option<String>` (absolute directory); CLI prints `  Documents kept at <dir> — tugutil dash run <name> reopens on them`; the deck's discard confirmation (`session-changes-dash-lane.tsx::discardConfirmationSentence` or the function that composes the `The plan is restored to <base>.` clause) says `Its documents stay at .tug/dashes/<name>/.`

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `documents` on a dash entry / `document_dashes` list | structure | changeset store → `useChangesetAll` (`useSyncExternalStore`) | [L02] |
| documents strip expanded/collapsed | local-data | `useState` beside the existing per-row fold state | [L24] |
| strip row hover / review tone | appearance | `data-review`, `data-role` attributes + CSS | [L06] |
| open-in-card gesture | — | `openFileInCard(store, path)` with `transferFocusForActivation` | [L23] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-documents.tsx` (+ `.css`) | the documents strip ([P06]) |
| `tests/app-test/at0479-dash-documents-strip.test.ts` | the strip on a bound branchless dash and on a live one |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `documents_dir`, `brief_file`, `plan_file`, `document_dashes` | fn | `tugdash-core/src/ops.rs` | [P01] |
| `DashDocuments` | struct | `tugdash-core/src/ops.rs`, `tugcast-core/src/types.rs` | Spec S01 |
| `DocumentArgument` | enum | `tugdash-core/src/ops.rs` | Spec S03 |
| `ensure_tug_excluded` | fn | `tugdash-core/src/ops.rs` | [P08] |
| `commits_touching_after` | fn | `tugdash-core/src/ops.rs` | [P07] |
| `DashDetail.documents` | field | `tugdash-core/src/ops.rs` | replaces `plan_path` |
| `StepOutcome.plan` | field | `tugdash-core/src/ops.rs` | absolute; replaces `plan_path` |
| `DiscardOutcome.documents_kept` | field | `tugdash-core/src/ops.rs` | replaces `plan_restored` |
| `DocumentDashEntry`, `ProjectChangeset.document_dashes` | struct/field | `tugcast-core/src/types.rs` | Spec S02; replaces `PlanDocEntry`/`plans` |
| `document_dash_entries_in` | fn | `tugcast/src/feeds/changeset.rs` | replaces `plan_doc_entries_in` |
| `DashCommands::Documents` | variant | `tugutil/src/cli.rs` | Spec S04 |
| `run_documents` | fn | `tugutil/src/dash.rs` | |
| `resolve_document_argument` | fn | `tugutil/src/plan.rs` | [P02] |
| `SessionChangesDashDocuments` | component | new file above | [P06] |
| `DocumentDashRow`, `DocumentDashCell` | type/component | `tugdeck/src/components/lens/sections/dashes-section.tsx` | replaces `PlanRow`/`PlanCell` |
| `documentDashNextGesturePrompt` | fn | `tugdeck/src/components/lens/sections/dash-prompt-target.ts` | replaces `planNextGesturePrompt` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | pure rules: `DocumentArgument::parse`, `DashDocuments::read`, `stage_ask` wording, `stageNoteText` | every pure function this plan adds |
| **Integration** | real git repos in `tempfile` dirs through `ops.rs`, `replay.rs`, `changeset.rs`, `dash_arc_runner.rs` | every verb and feed change |
| **Golden / Contract** | wire shape round-trips in `tugcast-core/src/types.rs` and `changeset-types.ts` guards | `documents`, `document_dashes` |
| **Real-app** | Lens rows, the documents strip, divider labels, prompts by name | `tests/app-test/at0473`, `at0474`, `at0476`, `at0477`, new `at0479` (`at0478` is taken by `at0478-dash-fit-verified.test.ts`) |

#### What stays out of tests {#test-non-goals}

- Rendering of markdown inside the strip — the strip opens the Text card, which has its own coverage.
- The skills' prose — read by a model, exercised by the run itself.
- Any fake-DOM or mock-store shape; the deck's pure functions are tested as functions and the rows in the real app.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The documents home and the argument rule | done | `3dbc92a80` |
| #step-2 | Step verbs, detail entries, replay, and readiness read the new home | done | `137dd4ae5` |
| #step-3 | CLI: `dash run <name>`, `dash documents`, `plan` verbs by name | done | `d67d73978` |
| #step-4 | Arc runner and conductor prompts by name | done | `5c3bbe03c` |
| #step-5 | Delete adoption, restore, and the join-time archive | done | `c66bcd8e6` |
| #step-6 | Delete `docs-dir` and the plan search cascade | done | `1769a1145` |
| #step-7 | Wire: `documents` on dash entries and the document-dash list | done | `cb1506cc2` |
| #step-8 | Deck data layer on the new wire | done | `167500800` |
| #step-9 | Lens: document-dash rows by name | done | `849150e95` |
| #step-10 | Session card: the documents strip, the identity line, the discard sentence | done | `4ce7bc6e1` |
| #step-11 | Skills, doctrine, and the [D139] rewrite | done | `d63d8a1c4` |
| #step-12 | Delete `dash/` and its references | done | `34f134350` |
| #step-13 | Integration Checkpoint | done | `b359bb57e` |

#### Step 1: The documents home and the argument rule {#step-1}

**Commit:** `tugdash-core: give every dash a documents home under .tug/dashes/<name>`

**References:** [P01] documents home, [P02] name-or-path, [P08] `.tug/` excluded, Spec S01, Spec S03, (#plan-read-write-map)

**Artifacts:**
- `documents_dir`, `brief_file`, `plan_file`, `document_dashes`, `DashDocuments`, `DocumentArgument`, `ensure_tug_excluded` in `tugrust/crates/tugdash-core/src/ops.rs`, re-exported from `lib.rs`.

**Tasks:**
- [ ] Add the four path functions beside `new_worktree_path` (`ops.rs:358`) in `ops.rs`; `documents_dir` uses the validated raw name and normalizes `repo` through `main_repo_root` ([P01]); `brief_file`, `plan_file`, `document_dashes`, and `DashDocuments::read` go through `documents_dir` so the normalization is spelled once.
- [ ] `validate_dash_name` (`tugdash-core/src/dash.rs:39`) needs **no change** — its character class already refuses `/`, `\`, and `.`. Add the pin test below and leave the function alone.
- [ ] `DashDocuments::read(repo, name)`: stat `brief_file`/`plan_file`; read the first line starting with `#` of each existing file as its title (strip leading `#`s, a trailing `{#anchor}`, and surrounding `**`); `is_empty`.
- [ ] `document_dashes(repo)`: `read_dir(<repo>/.tug/dashes)`, keep directories whose name passes `validate_dash_name` and whose `DashDocuments::read` is non-empty, sorted; absent `.tug/dashes` → empty.
- [ ] `DocumentArgument::parse` per Spec S03.
- [ ] `ensure_tug_excluded(repo)`: `git -C repo check-ignore -q .tug` success → return; else read `<git rev-parse --path-format=absolute --git-common-dir>/info/exclude` and write back the contents carrying `/.tug/`. Port the **marked-block** shape from `tugcast/src/git_exclude.rs::exclude_contents_with` — a `# tug:dashes` / `# end tug:dashes` marker pair with its own start/end arithmetic, returning `None` when the line is already inside the block, which is what makes the call idempotent. (Its own markers, not `tug:attachments`: two owners editing one block is the drift the pair exists to prevent.) Keep the module's three constraints: the common dir rather than `<root>/.git` (every dash is a linked worktree), an anchored exact path rather than a bare pattern, and never the project's `.gitignore`. Failures logged and ignored.

**Tests:**
- [ ] `documents_home_is_spelled_from_the_raw_name` — `documents_dir(root, "foo-bar")` ends in `.tug/dashes/foo-bar`.
- [ ] `a_validated_dash_name_is_one_safe_directory_component` — `a/b`, `..`, `.hidden`, `foo.md` refused by the validator as it stands; `foo-bar`, `at0473-adopter` accepted. The test pins the property [P01] and [P02] rest on, so a later loosening fails here rather than in a path join.
- [ ] `documents_dir_answers_the_main_root_from_a_linked_worktree` — create a dash, call `documents_dir(worktree_abs, name)`, assert it is under the **main** root's `.tug/dashes/`, not the worktree's ([P01]).
- [ ] `dash_documents_read_reports_existence_and_titles` — write `brief.md` with `# The brief`, no plan; assert `brief_title == Some("The brief")`, `plan == None`.
- [ ] `document_dashes_lists_directories_with_documents_only` — an empty directory and a file at the top level are skipped.
- [ ] `document_argument_parse_splits_on_shape` — `foo` → Name; `foo.md`, `./foo`, `a/b`, `/abs` → Path.
- [ ] `ensure_tug_excluded_makes_git_status_clean_without_a_gitignore` — `git init` a temp repo with no `.gitignore`, create `.tug/dashes/x/brief.md`, call, assert `git status --porcelain` empty; call twice, assert one line in `info/exclude`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`
- [ ] `cd tugrust && cargo clippy -p tugdash-core --all-targets -- -D warnings`

---

#### Step 2: Step verbs, detail entries, replay, and readiness read the new home {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash-core: step verbs, detail entries, replay, and readiness read the plan from its dash directory`

**References:** [P03] no `tugplan` key, [P01], Spec S01, (#plan-read-write-map)

**Artifacts:**
- `step_in` reads/writes `plan_file(repo, name)`; `DashDetail.documents`; `StepOutcome.plan` absolute; `unfinished_tracked_dirt(dirt)`; `reconcile_ledger_cells` without a commit.

**Tasks:**
- [ ] `ops.rs::step_in`: drop the `plan: Option<&str>` parameter and `resolve_plan_rel`; `abs = plan_file(repo_root, name)`; error `dash '<name>' has no plan at <abs>` when absent; delete the `base_plan_dirt` refusal; `StepOutcome { plan: abs.to_string_lossy() }`. `step_start`/`step_done` signatures follow.
- [ ] `ops.rs::dash_detail_entries_in`: replace `plan_path` with `documents: DashDocuments::read(repo_root, name)`; `join_ready(..., has_plan = documents.plan.is_some())`.
- [ ] `dash.rs::unfinished_tracked_dirt(dirt: &[String]) -> bool { !dirt.is_empty() }` and update its docblock — the plan is never in the worktree; update the one caller.
- [ ] `replay.rs::reconcile_ledger_cells`: read `plan_file(repo, name)`, write back with `write_atomic`, delete `commit_remap` and `Reconciled.commit`; update every reader of `Reconciled.commit` (grep `\.commit` near `Reconciled` in `replay.rs` and `tugutil/src/dash.rs::run_replay`) and the `replayed` dash-log note if it named the commit.
- [ ] Delete `plan_config_key`, `dash_plan_path`, `set_dash_plan_path`, `resolve_plan_rel` and the `tugplan` mention in `tuglaws/dash-lifecycle.md`'s branch-config list (item 3) — leave the prose edits to Step 11 but remove the key from the list now so the doc never names a key that does not exist.
- [ ] `tugutil/src/dash.rs::run_step` and `cli.rs::StepAction::Start`: drop `--plan`; print `Step i/N of <abs plan> is <status>`.
- [ ] Rewrite the affected tests: `step_verbs_refuse_while_a_base_plan_copy_diverges` (delete), `detail_entries_carry_the_recorded_plan_path` → `detail_entries_carry_the_dash_documents`, `detail_entries_carry_base_divergence` (delete the plan half; keep any non-plan overlap assertion), the `step-dash`/`roadmap/plan.md` fixtures in `ops.rs` tests (around `started.plan_path`) → write the plan at `plan_file(root, name)` first.

**Tests:**
- [ ] `step_verbs_drive_the_plan_in_the_dash_directory` — create a dash, write a two-step plan at `plan_file`, `step_start(name, 1, 2)`, `step_done(name, 1, None)`; the ledger row at that path is `done` with the branch's short sha; the worktree is clean throughout (`git status --porcelain` in the worktree empty).
- [ ] `join_ready_counts_every_tracked_worktree_edit` — `unfinished_tracked_dirt(&["a.rs".into()])` true, empty false.
- [ ] `reconcile_ledger_cells_rewrites_the_dash_plan_without_committing` — after a replay the cell moves and the branch tip is unchanged.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`

---

#### Step 3: CLI: `dash run <name>`, `dash documents`, `plan` verbs by name {#step-3}

**Depends on:** #step-2

**Commit:** `tugutil: dash run, dash documents, and the plan verbs take the dash name`

**References:** [P02] name-or-path, [P08], Spec S03, Spec S04, (#arc-document-rule, #documents-verb)

**Artifacts:**
- `DashCommands::Documents`, `run_documents`; `Run` without `--document`; `open_arc(root, name)`; `plan.rs::resolve_document_argument`.

**Tasks:**
- [ ] `cli.rs`: remove `document` from `DashCommands::Run` (update the docblock: "opens on the dash's brief, or its plan when only that exists; resumes a stopped arc"); add `Documents { name, ensure: bool }` with the docblock from [#documents-verb](#documents-verb).
- [ ] `dash.rs::open_arc(root, name)`: per [#arc-document-rule](#arc-document-rule); the `arc-start` note is the repo-relative path (`brief_file(root, name).strip_prefix(root)`); `run_arc_run` drops `document`; the human receipt stays `Arc opened on '<name>' for <document>`.
- [ ] `dash.rs::run_documents`: `--ensure` → `std::fs::create_dir_all(documents_dir)` + `ensure_tug_excluded`; print/JSON per the Deep Dive; exit 0 when nothing exists.
- [ ] `plan.rs`: `resolve_document_argument(arg) -> Result<PathBuf, AppError>`: `DocumentArgument::Name(n)` → `plan_file(root, &n)` where `root` is `tugutil_core::find_repo_root_from(cwd)?` — `plan_file` normalizes to the main root itself ([P01]), so a cwd inside a dash worktree resolves correctly. `find_repo_root_from` does not walk up, so a cwd below the root is `NotAGitRepository`: surface it as exit 2 with `not in a git repository — run from the checkout root, or pass the plan's path` ([P02]). Absent plan → exit 2 with `dash '<n>' has no plan at <path>`. `Path(p)` → `p` as today. Update the module docblock (it says "there is no search cascade" — still true, and stays true: a name is an exact address, not a search; say the name form and say that).
- [ ] `cli_integration_tests.rs`: add `test_plan_status_accepts_a_dash_name` (temp repo, write a plan at `plan_file`, `tugutil plan status <name> --json` → `data.path` is the absolute file) and `test_dash_documents_reports_a_state_not_an_error`.

**Tests:**
- [ ] `open_arc_opens_on_the_brief_then_the_plan` — brief only → document ends `brief.md`; plan only → `plan.md`; neither → the named refusal.
- [ ] `document_argument_resolves_a_name_to_the_dash_plan` — in `plan.rs` tests, with cwd set to a temp repo (`#[serial]` as the ops tests do).
- [ ] The two CLI integration tests above.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`

---

#### Step 4: Arc runner and conductor prompts by name {#step-4}

**Depends on:** #step-3

**Commit:** `tugcast: the arc reads the dash's documents and asks each stage by name`

**References:** [P07] commits since mtime, [P10] stage asks, [P01], (#plan-read-write-map, #arc-document-rule)

**Artifacts:**
- `dash_arc_runner.rs::read` on `DashDocuments`; `conductor::prompt::stage_ask` by name; `commits_touching_after`.

**Tasks:**
- [ ] `ops.rs`: add `commits_touching_after(repo, since: SystemTime, paths, cap) -> Vec<String>` (`git log --since=<rfc3339> --format=%h %s -- paths`); delete `last_commit_touching`/`commits_touching_since` after grepping that the runner was their only caller.
- [ ] `dash_arc_runner.rs::read`: `document_abs = project.join(record.document)` stays (the record holds the repo-relative path); `commits_since` keyed on `document_abs.metadata().modified()`; `devise_target = plan_file(project, dash)` made repo-relative — `project` here is a card's project directory and may itself be a linked worktree, which is why `plan_file` normalizes through `main_repo_root` internally ([P01]) rather than being handed a pre-normalized root; `plan_for_prompt = Some(dash.to_string())` whenever `plan_file` exists (no `detail`/`worktree` branch, no `record.plan` fallback); `ArcFacts.plan_path` → the absolute plan path when it exists (the predicate only tests `is_some`). Delete the `after_adoption_the_facts_come_from_the_worktree_copy` and `the_devise_prompt_names_the_document_and_the_declared_docs_dir` tests; rewrite the fixtures' `project_with_document(root, "dash/demo-brief.md")` helper to write `.tug/dashes/<dash>/brief.md` and record that path.
- [ ] `conductor/prompt.rs::stage_ask(stage, document, dash, steps)`: per [P10]; update its tests (`ASK` constant and the wording assertions).
- [ ] `rotate`: the `append_arc_plan` on devise records `devise_target`; the review-stage fallback records `plan_file` repo-relative; `RotationRequest::plan(...)` carries the name.
- [ ] `format_arc_receipt` unchanged (it prints `record.document`).

**Tests:**
- [ ] `the_devise_ask_names_the_brief_and_targets_the_dash` — `stage_ask("devise", Some(".tug/dashes/foo/brief.md"), "foo", None)` equals the [P10] string.
- [ ] `review_and_implement_asks_name_the_dash` — `/tugplug:plan-review foo`, `/tugplug:dash-implement foo Steps 2-4`.
- [ ] `what_changed_is_keyed_on_the_documents_mtime` — write a brief citing `src/a.rs`, set its mtime to an hour ago with `File::set_modified`, commit a change to `src/a.rs` now; the reading's `commits_since` names that commit; a brief with a fresh mtime yields none.
- [ ] Every existing runner test green against the relocated fixture.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`

---

#### Step 5: Delete adoption, restore, and the join-time archive {#step-5}

**Depends on:** #step-2

**Commit:** `tugdash-core: delete plan adoption, base-copy restore, and the join-time archive`

**References:** [B03], [B05], [P11] join removes / discard keeps, [P08], Spec S05, (#plan-read-write-map)

**Artifacts:**
- `create` without `plan`; `adopt_plan_in`/`adopt_plan`/`AdoptOutcome`/`CreateOutcome.plan`, `clean_base_plan_copy`, `base_plan_dirt`/`BasePlanState`, `resolve_plan_rel_anywhere`, `replay_ledger_progress`, `warn_on_superseded_worktree_edits`, `read_plan_file`, `git_show_raw` (if unused after), `restore_plan_to_base`, `archive_adopted_plan`, `commit_archived_plan`, `plan_remedy_sentence` gone; `DashCommands::AdoptPlan` gone.

**Tasks:**
- [ ] `ops.rs::create(name, description, carry, base)`: drop `plan`; `carry_working_set_in(&repo_root, &worktree, None)` → drop its `skip` parameter; call `ensure_tug_excluded(&repo_root)` before `worktree add` ([P08]).
- [ ] Delete every function above and `DashCommands::AdoptPlan`, `run_adopt_plan`, `adopt_receipt_line`, `print_adopt_receipt` in `tugutil/src/dash.rs`; `run_create` loses `plan`.
- [ ] `base_dirt_detail`/`untracked_overwrite_detail`: drop the `plan`/`name` parameters and the remedy sentence; `join_blockers_from_detail` and the `join_in_with_progress` preamble follow.
- [ ] `discard_in`: delete the `arc_devised` block and `restore_plan_to_base`; `working_set_hand_back(repo_root, worktree)` loses `plan_rel`; `DiscardOutcome.documents_kept = documents_dir(...).is_dir().then(...)`; `tugutil dash discard` prints the Spec S05 line; `changeset.rs`'s discard receipt formatter (`discarded <dash> · N round(s)` … `Restored <rel> to the base checkout.`) says `Documents kept at .tug/dashes/<name>/` instead.
- [ ] `integrate_join`: remove the three `archive_adopted_plan`/`commit_archived_plan` call sites; `finish_join_teardown`: after the branch delete and before the terminal `append_dash_log`, `remove_dir_all(documents_dir)` when it exists and push `removed .tug/dashes/<name>/` onto the receipt lines (find the receipt's `lines`/`warnings` vector the join outcome carries).
- [ ] Delete tests: `adopt_*` (ten), `carry_leaves_the_adopted_plan_to_its_own_transplant`, `create_with_a_plan_*` (two), `an_adopted_plan_is_not_censused_as_base_dirt`, `preflight_names_the_plan_when_the_base_copy_is_what_jails_the_join`, `a_plan_adopted_at_birth_survives_the_whole_run_and_lands`, `a_discarded_dash_hands_its_plan_back_to_base`, `discard_of_an_untouched_or_planless_dash_restores_nothing`, `test_join_*_archives_the_plan*` (four), `test_join_without_an_adopted_plan_is_unchanged`, `test_join_without_a_declared_docs_dir_is_unchanged`; keep the `carry_*` tests that do not involve a plan.
- [ ] Update `tests/app-test/dash-fixture.ts` (two `adopt`/`--plan` mentions) and `tugplug/skills/dash-implement/SKILL.md`'s `--plan` usages minimally so they do not name a flag that no longer exists (the full prose rewrite is Step 11).

**Tests:**
- [ ] `a_planned_dash_lands_a_commit_whose_tree_holds_no_document` — write brief and plan under `documents_dir`, create the dash, one round, `join_in`; `git ls-tree -r HEAD --name-only` on the base contains no `.tug/`; `documents_dir` is gone; the receipt names it; `git status --porcelain` on the base is empty (fixture repo **without** a `.gitignore`, exercising [P08]).
- [ ] `a_discarded_dash_keeps_its_documents_and_says_so` — same setup, `discard_in`; the directory remains with both files; `documents_kept` names it.
- [ ] `create_over_a_clean_base_reports_nothing` still green with the new signature.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `grep -rn 'adopt_plan\|adopt-plan\|restore_plan_to_base\|archive_adopted_plan\|base_plan_dirt\|tugplan' tugrust/crates` prints nothing

---

#### Step 6: Delete `docs-dir` and the plan search cascade {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `tugutil-core: delete the docs directory declaration and the plan search cascade`

**References:** [B04], (#the-other-docs-dir)

**Artifacts:**
- `DashConfig.docs`, `Config::docs_dir`, `validate_docs_dir`, `DocsDirRejection`, `set_docs_dir`, `DocsDirWrite`, `plan_search_dirs`, `find_tugplans`, `tugplan_name_from_path`, `RESERVED_FILES`, the whole `tugutil-core/src/resolve.rs` module and its `lib.rs` re-exports gone; `DashCommands::DocsDir`, `run_docs_dir`, `DocsDirPayload`, `DocsDirSetPayload` gone; the `docs` comment block in `DEFAULT_CONFIG` gone.

**Tasks:**
- [ ] Re-grep `resolve_plan\|find_tugplans\|plan_search_dirs\|tugplan_name_from_path` across `tugrust/crates`; delete `resolve.rs` and the config helpers when only `lib.rs` names them (verified 2026-08-25).
- [ ] `config.rs`: remove the field, the helpers, the `docs` block in `DEFAULT_CONFIG` (and the `name = "docs"` surface example may stay — it is a surface named docs, not the key), and the five `docs_dir`/`set_docs_dir` tests; keep `toml_edit` only if another writer still uses it (grep `toml_edit::`).
- [ ] `tugutil-core/src/plan.rs::the_real_corpus_carries_no_errors`: iterate `document_dashes(project_root)` and lint each `plan_file`; skip cleanly when `.tug/dashes` is absent. (`tugutil-core` cannot depend on `tugdash-core`; inline the two-line directory walk over `<root>/.tug/dashes/*/plan.md`.)
- [ ] `cli.rs`/`dash.rs`: delete `DocsDir`, `run_docs_dir`, the payloads, and the `dash docs-dir`'s precedent comment on `run_arc_report`; `cli_integration_tests.rs`: delete the four `test_dash_docs_dir_*` tests.
- [ ] `.tugtool/config.toml` (this repository): delete the `docs = "dash"` key and its comment; remove `"dash/"` from the `prose` surface's `paths`.
- [ ] `tugutil/src/commands/init.rs`: confirm it only writes `DEFAULT_CONFIG` (no separate `docs` scaffold); adjust any test asserting the `docs` comment.

**Tests:**
- [ ] `the_real_corpus_carries_no_errors` runs (and is a no-op when no dash directories exist).
- [ ] `config` tests green without the docs field; a config file still carrying `docs = "…"` parses (serde ignores unknown keys — pin with `a_stale_docs_key_is_ignored`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run --workspace`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `grep -rn 'docs_dir\|docs-dir\|DocsDir' tugrust/crates` prints nothing

---

#### Step 7: Wire: `documents` on dash entries and the document-dash list {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast: dash entries carry their documents, and a dash that is only documents is listed`

**References:** [P04] document-only dash, [P05] documents on the wire, Spec S01, Spec S02, Risk R01, (#plan-read-write-map)

**Artifacts:**
- `tugcast_core::types::{DashDocuments, DocumentDashEntry}`; `ChangesetEntry::Dash.documents`; `ProjectChangeset.document_dashes`; `changeset.rs::document_dash_entries_in`.

**Tasks:**
- [ ] `types.rs`: replace `plan_path` on `ChangesetEntry::Dash` with `documents: DashDocuments` (`skip_serializing_if = "DashDocuments::is_empty"`), delete `PlanDocEntry`, add `DocumentDashEntry`, rename `plans` → `document_dashes`; fix the serialization tests (`plan_path: None` fixtures, the `!json.contains("plan_path")` assertion).
- [ ] `changeset.rs::dash_plan_reading(plan_abs: &Path)` takes the absolute path from `detail.documents.plan`; `dash_entries` maps `documents: detail.documents.into()`.
- [ ] `changeset.rs`: delete `plan_doc_entries`/`plan_doc_entries_in` and their eight tests; add `document_dash_entries(project_dir, ledger)` → for each `document_dashes(root)` name with no `tugdash/<name>` branch (`branch_exists`), compose Spec S02 with `dash_plan_reading` for review/steps, `read_arc` for `arc`, `dash_owner_key` for `owner_id`, `bound_by_dash` for `bound_sessions`; honor `dashes_hidden_for`.
- [ ] `changeset_all.rs`: delete the `adopted` set; `document_dashes: document_dash_entries(&project_dir, ledger).await`.
- [ ] Every other `plan_path` reader in tugcast (grep `plan_path` in `tugrust/crates/tugcast`) moves to `documents`.

**Tests:**
- [ ] `dash_entries_carry_absolute_document_paths` — a dash with a brief and a plan; the entry's `documents.plan` is absolute and `review` is read from it.
- [ ] `a_document_only_dash_is_listed_until_its_branch_exists` — write `.tug/dashes/foo/brief.md`; `document_dash_entries` lists `foo` with `documents.brief` and no plan facts; `create` the dash; the list is empty and the dash entry carries the same `documents`.
- [ ] `document_dash_entries_read_review_and_steps` — port the three review/steps assertions from the deleted `plan_doc_entries_*` tests onto `plan_file`.
- [ ] Wire round-trip: `ProjectChangeset` with `document_dashes` serializes and deserializes; an empty list is omitted.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugcast-core`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `just build-app`

---

#### Step 8: Deck data layer on the new wire {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck: read dash documents from the wire instead of composing a plan path`

**References:** [P05], [P02], Spec S01, Spec S02, (#state-zone-mapping)

**Artifacts:**
- `changeset-types.ts`: `DashDocuments`, `isDashDocuments`, `DocumentDashEntry`, `isDocumentDashEntry`, `documents` on `DashChangesetEntry`, `document_dashes` on `ProjectChangeset`; `PlanDocEntry`/`isPlanDocEntry`/`plan_path` deleted.

**Tasks:**
- [ ] `changeset-types.ts` per the artifact list; the `isDashChangesetEntry` guard validates `documents`.
- [ ] `plan-review.ts`: `boundDash: { plan: string } | null`; `resolvePlanReviewTarget` returns `input.boundDash.plan`; delete `joinPath` if unused; rewrite the module docblock's "The dash branch joins `plan_path` onto the dash's worktree" paragraph to say the server hands an absolute path ([D138]). Update `__tests__` for it.
- [ ] `session-card.tsx` (the `/plan-review` route near `resolvePlanReviewTarget`): `boundDash: entry?.documents?.plan === undefined ? null : { plan: entry.documents.plan }`; also match a document-only dash — look the bound name up in `document_dashes` when `dashes.find` misses.
- [ ] `dash-session-index.ts`: `hasPlan: entry.documents?.plan !== undefined`; index document-only dashes too (their `bound_sessions`).
- [ ] `dash-review.ts::dashReviewTooltip` unchanged in shape; callers pass `documents.plan ?? null`.
- [ ] `spikes/spike-changes-dashes.tsx`: `plan_path: "dash/changes-and-dashes.md"` → `documents: { plan: "/repo/.tug/dashes/changes-and-dashes/plan.md" }`.
- [ ] `session-changes-dash-lane.test.ts`: the `plan_path` fixtures → `documents`.

**Tests:**
- [ ] `bun test tugdeck/src/lib` — `plan-review`, `changeset-types` guards (`isDashChangesetEntry` accepts/rejects `documents` shapes), `dash-session-index` with a document-only dash.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/lib`

---

#### Step 9: Lens: document-dash rows by name {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(lens): the Dashes section lists document-only dashes by name`

**References:** [P04], [P02], Risk R02, (#skills-after)

**Artifacts:**
- `dashes-section.tsx`: `DocumentDashRow`/`DocumentDashCell` replacing `PlanRow`/`PlanCell`; `dash-prompt-target.ts::documentDashNextGesturePrompt`; `at0473` rewritten.

**Tasks:**
- [ ] `dashes-section.tsx`: rows come from `project.document_dashes`; key `doc:${projectDir}:${name}`; the cell shows the name with `TugDashName` (the same atom the dash rows use, so one dash reads the same before and after its branch exists), the `DashStageMark` from `arc` when present, and a facts line `brief` / `plan · <review> · <steps>` built from `documents`; `data-slot="lens-document-dash-row"`, `data-dash={name}`; ordering: begun first, then review rank, then name (port `PLAN_REVIEW_RANK`); `dashesCollapsedSummary` counts `N planning` instead of `N plans`.
- [ ] `dash-prompt-target.ts`: `documentDashNextGesturePrompt(review, name, begun, hasPlan)`: no plan → `/dash <name>`; `never-reviewed`/`stale` → `/tugplug:plan-review <name>`; `reviewed` or begun → `/tugplug:dash-implement <name>`; labels follow the existing `planNextGestureLabel`.
- [ ] `tests/app-test/at0473-dash-cockpit.test.ts`: scratch projects write `.tug/dashes/<name>/plan.md` (via `makeDashScratchRepo`'s `files`, plus a `.gitignore` line `.tug/` so the fixture commit does not track them — or rely on [P08] by writing them after the commit); stamp `REVIEWED` with `tugutil plan stamp <name>`; assertion 4 becomes "creating the dash turns its document row into a live row and does not add a second"; update `@covers`.

**Tests:**
- [ ] `bun test` for `dash-prompt-target` (pure prompt strings by name).
- [ ] `just app-test tests/app-test/at0473-dash-cockpit.test.ts`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0473-dash-cockpit.test.ts`

---

#### Step 10: Session card: the documents strip, the identity line, the discard sentence {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(session): show the bound dash's brief and plan as a face on the Changes shade`

**References:** [P06] documents strip, [P09] identity line, [P10], [P11], Spec S05, Risk R01, (#state-zone-mapping)

**Artifacts:**
- `session-changes-dash-documents.tsx` (+ `.css`); `dash-meta-line.tsx` string; `session-changes-dash-lane.tsx` fronted document-only dash + strip + discard sentence; `at0474`/`at0476`/`at0477` updated; new `at0479-dash-documents-strip.test.ts`.

**Tasks:**
- [ ] `SessionChangesDashDocuments({ documents, review, steps })`: one `TugListRow` per existing document with `data-slot="session-dash-document"`, `data-role="brief"|"plan"`, the title (or the role when the title is absent), the plan's `review` and `steps_done/step_total`; click → `openFileInCard(deckStore, path)`; a keyboard-activatable row (the responder/`TugListRow` affordance the lane's other rows use). Module docblock per `tuglaws/component-authoring.md`, laws named ([L02], [L06], [L19], [L23]).
- [ ] `session-changes-dash-lane.tsx`: render the strip inside the fronted row's fold, above the files; when the bound name matches no `ChangesetEntry::Dash` but a `document_dashes` entry, render that as the fronted row — name atom, `DashMetaLine` with `arc`, the strip, `Unbind` — and none of the diff/join/discard affordances; discard sentence → `Its documents stay at .tug/dashes/<name>/.` (drop `The plan is restored to <base>.`).
- [ ] `dash-meta-line.tsx`: `no plan adopted` → `no plan yet`, keyed on `entry.documents?.plan`.
- [ ] `at0474-dash-arc-transcript.test.ts`: `STAGE_PROMPT` → `/tugplug:plan-devise a plan for .tug/dashes/foo/brief.md, honoring every [B##] decision it records 🢂 foo`; `REVIEW_PROMPT` → `/tugplug:plan-review foo`; frames' `document` → `.tug/dashes/foo/brief.md`; label assertions accordingly (`not.toContain("dash/")` → `not.toContain(".tug/")` on the document-less divider).
- [ ] `at0476-arc-interruptions.test.ts`, `at0477-transcript-copy-atoms.test.ts`: `BRIEF` → `.tug/dashes/<name>/brief.md` written into the scratch repo; `dash run <name>` without `--document`.
- [ ] `at0479-dash-documents-strip.test.ts`: scratch repo, write `.tug/dashes/strip/brief.md`, spawn a session on it, `tugutil dash bind strip`; open the Changes shade; assert the fronted row names `strip` and the strip shows one `brief` row; write `plan.md` (unstamped, two steps); assert a `plan` row with `never-reviewed · 2 steps`; click the brief row; assert a Text card opened on that absolute path (`findTextCardByPath` via the store, or the card title). `@covers` the new component, the lane, and `dash-meta-line.tsx`.

**Tests:**
- [ ] The four app-tests above.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app`
- [ ] `just app-test tests/app-test/at0474-dash-arc-transcript.test.ts tests/app-test/at0476-arc-interruptions.test.ts tests/app-test/at0477-transcript-copy-atoms.test.ts tests/app-test/at0479-dash-documents-strip.test.ts`

---

#### Step 11: Skills, doctrine, and the [D139] rewrite {#step-11}

**Depends on:** #step-10

**Commit:** `tugplug+tuglaws: the dash's documents live under the dash — skills and doctrine say so, [D139] rewritten`

**References:** [B03], [B04], [B08], [P01], [P02], Spec S04, (#skills-after)

**Artifacts:**
- `tugplug/CLAUDE.md`, `tugplug/skills/{dash,plan-devise,plan-review,dash-implement}/SKILL.md`, `tuglaws/dash-work-doctrine.md`, `tuglaws/dash-lifecycle.md`, `tuglaws/design-decisions.md` [D139].

**Tasks:**
- [ ] `tugplug/CLAUDE.md`: replace the **Location discipline** paragraph — a dash's documents live at `.tug/dashes/<name>/` (`brief.md`, `plan.md`), addressed by name through `tugutil dash documents <name>`; nothing is written to the working tree; the worktree-root sentence stays. Update the `plan-devise` bullet ("Writes to an explicit path (no assumed directory)" → "writes the dash's `plan.md`, or an explicit path").
- [ ] `dash/SKILL.md`: Orient, "Find what this conversation already wrote", Sharpen's brief location, the hand-off command (`tugutil dash run <name>` with no `--document`), and the guardrail bullet, per [#skills-after](#skills-after); the "you wrote `dash/foo-brief.md` this session" example → `tugutil dash documents foo` reporting a brief.
- [ ] `plan-devise/SKILL.md`: rewrite "Where the plan goes" per [#skills-after](#skills-after); the invocation grammar becomes `<idea> [🢂 <name-or-path>]`; delete the `docs-dir` guardrail.
- [ ] `plan-review/SKILL.md`: Input takes `<name-or-path>`; the chip example → `` `/tugplug:dash-implement my-dash` ``.
- [ ] `dash-implement/SKILL.md`: Setup items 2–3 and the step-open command per [#skills-after](#skills-after); delete the `adopt-plan` refusal bullet; "If no plan exists yet" points at `/dash`.
- [ ] `tuglaws/dash-work-doctrine.md`, **The one and only working root**: delete the "If the document a run is driving lives on the base branch, a verb moves it…" bullet and the "There is no canonical directory… `[tugtool.dash].docs`" paragraph; add one paragraph — the documents live under `<main-repo>/.tug/dashes/<name>/`, are never tracked, and the verbs take the name.
- [ ] Same document, same section: the bullet **"Never write to the base checkout. Not code, not a plan, not a ledger, not a scratch file"** becomes false as stated — the plan and the ledger rows this run drives now live under the *base checkout's* `.tug/`. Rewrite it so the rule keeps its force and states its one exclusion: never write to the base checkout's **working tree** — not code, not a scratch file — and the dash's own `.tug/dashes/<name>/` is not an exception to that but the reason there is no longer anything to except, since it is gitignored, invisible to `git status`, and reached only through a verb. The "a stray write to the base root also *blocks* the join" bullet below it stays true and unchanged.
- [ ] Same document, **Starting from a dirty base**: `dash discard` "returns the worktree's uncommitted work to the base **the same way it already returns an adopted plan**" — the clause names a mechanism [B03] deletes. Drop the comparison; the sentence stands without it, and [P11] is what discard now does with the documents.
- [ ] `tuglaws/dash-lifecycle.md`: replace the **Plan adoption** section with **The dash's documents** (home, name resolution, join removes / discard keeps, the ledger is written in place and never in the worktree); fix line 138's "commit cells are committed content on the branch" to say the ledger lives outside the tree and replay rewrites it in place; the decisions list's `[D139] (one plan home)` stays (it still is).
- [ ] `tuglaws/design-decisions.md` [D139]: rewrite in full — the document has one copy because it has one home, `<repo>/.tug/dashes/<name>/`; the name is the address; the verbs read it there and nothing transplants, restores, archives, or detects divergence; the join removes the directory and the discard leaves it. Keep the entry number; no "superseded by" text anywhere.
- [ ] Copy the edited `tugplug/` into the built bundle's `Resources/tugplug/` (or `just build-app`) and run one `/tugplug:plan-review dash-documents`-shaped invocation on a scratch dash to confirm the skill resolves a name.

**Tests:**
- [ ] None mechanical; `grep -rn 'docs-dir\|adopt-plan\|--plan\|--document' tugplug tuglaws` prints nothing.

**Checkpoint:**
- [ ] The grep above is empty.
- [ ] `just build-app` (the bundle carries the new skills).

---

#### Step 12: Delete `dash/` and its references {#step-12}

**Depends on:** #step-11

**Commit:** `Delete the dash/ tree: the durable record of a joined dash is its commit`

**References:** [B06], [P12] provenance deleted, [F06], Risk R04, (#success-criteria)

**Artifacts:**
- `dash/archive/` (515 tracked files), `dash/assets/` (untracked), `dash/legacy-sweep-brief.md`, `dash/dash-notes.md` deleted; `dash/dash-documents.md` and `dash/dash-documents-brief.md` **kept** for the length of the run (Risk R04); `CLAUDE.md`, `Justfile`, and `tuglaws/*.md` links updated.

**Tasks:**
- [ ] In the worktree: `git rm -r --quiet dash/archive dash/legacy-sweep-brief.md dash/dash-notes.md`, then `rm -rf dash/assets`. `dash/assets/` holds **no tracked files** (verified 2026-08-25: 515 in `archive` + the two top-level briefs = the 517 `git ls-files dash` reports), so `git rm` on it fails with "did not match any files" — it is an untracked directory and a plain `rm -rf` is what removes it.
- [ ] Before removing `dash-notes.md`, copy its open items verbatim into the run's final report under a heading **Open notes from dash/dash-notes.md — for your Jots**, so they reach the owner ([B06]). Count them at the time rather than trusting a number here: the owner appends to this file, and it grew from five items to six on 2026-08-25 while this plan was being reviewed.
- [ ] `CLAUDE.md` (root): delete the `dash/` row from Repository Structure; add to the `tugplug/` row or a new sentence under it: dash briefs and plans live at `.tug/dashes/<name>/` and are never tracked.
- [ ] `Justfile`: the two comment blocks citing `dash/tug-multi-instance.md` ([D16]/[D17]) → cite `tuglaws/code-signing-mac.md` and drop the file name.
- [ ] `tuglaws/design-decisions.md` — **the bulk of the sweep**: 43 lines carrying 53 distinct `` `dash/…` `` plan citations, almost all of them trailing provenance footers of the form `` `dash/plan-adoption.md` [P01], [P05], [P08]. [D138], [L23] ``. **Delete the path token and its `[P##]` pins outright**, leaving the `[D##]`/`[L##]` cross-references that follow: a title pointing at a document deleted in this same step is a dead pointer, and [B06]'s answer is that the reasoning behind a landed change is read in its commit — the same call `3fbe941f8` already made for the pin citations in doc comments. Two lines are not footers and need reading individually: the `Z1B` row (line 319) carries a live markdown link `../dash/tugplan-tide-session-wake.md#step-5-6`, which becomes plain prose with no path, and [D139]'s footer goes with the rewrite in Step 11.
- [ ] The other 17 `tuglaws/*.md` with a `dash/…` reference — `animation-doctrine`, `app-test-harness`, `code-signing-mac`, `component-authoring`, `entity-presentation`, `focus-language`, `lifecycle-delegates`, `pane-model`, `responder-chain`, `route-lifecycle`, `scroll-intent`, `slash-commands`, `state-preservation`, `theme-engine`, `tracking-changes`, `tuglaws`, `wasm-crates` — replace the markdown link with plain text naming the plan by title in italics and no path, and delete "See … for the full rationale/history" sentences whose only content was the pointer; a bulleted "References" entry that was only a link is deleted. (`plan-review-rubric.md` carries none and is not in the sweep; the list is derived from `grep -rn '\bdash/' tuglaws/*.md | grep -v 'tugdash/\|\.tug/dashes'` on 2026-08-25 — re-run it before starting rather than trusting this list.) `grep -rn 'dash/' tuglaws` afterwards matches only `.tug/dashes/` and `tugdash/`.
- [ ] `.tugtool/config.toml`: confirm the `prose` surface no longer lists `dash/` (Step 6).
- [ ] `tests/app-test`: the string literals `dash/find-route.md` (`at0225`, `at0346`) and `dash/kbf-mode.md`-style comments are prose about atoms, not file reads; leave them.

**Tests:**
- [ ] `git ls-files dash` prints exactly `dash/dash-documents-brief.md` and `dash/dash-documents.md`.
- [ ] `grep -rn '\bdash/' CLAUDE.md Justfile tuglaws | grep -v 'tugdash/\|\.tug/dashes/'` prints nothing.

**Checkpoint:**
- [ ] The two assertions above.
- [ ] `just app-test-covers-check`

---

#### Step 13: Integration Checkpoint {#step-13}

**Depends on:** #step-12

**Commit:** `dash-documents: integration checkpoint`

**References:** [P08], [P11], Risk R04, (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay dash-documents` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with `tugutil dash verify dash-documents`; a refusal names paths no surface claims and is fixed by declaring one (`.tug/` is gitignored and lands nothing; `dash/` deletions resolve to the `prose` surface until Step 6 removed the path — if verify refuses on a deleted `dash/…` path, declare nothing and note that a deletion under a retired surface is the expected refusal, then run the plan's own checkpoint commands over what the replay moved).
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.
- [ ] In the report, per Risk R04: the join will land `dash/archive/dash-documents.md` and leave `dash/dash-documents-brief.md`; the owner's one follow-up on main is `git rm -r dash/`.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every dash's brief and plan live at `<repo>/.tug/dashes/<name>/`, addressed by name on every verb and rendered on the Session card; adoption, `docs-dir`, the join-time archive, and the repository's `dash/` tree are gone.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `dash run <name>`, `dash step`, `plan lint|status|stamp <name>` work by name; the path form of the `plan` verbs still works (Rust tests, Steps 2–3).
- [ ] A planned dash's join lands a commit whose tree holds no document and removes the dash directory; a discard keeps it and says so (Rust test, Step 5).
- [ ] `git status --porcelain` is empty on a scratch base with no `.gitignore` after `dash run` and after a join (Rust tests, Steps 1 and 5).
- [ ] No `docs_dir`/`docs-dir`/`adopt`/`tugplan` symbol survives in `tugrust`, `tugdeck`, `tugplug`, `tuglaws` (grep, Steps 5, 6, 11).
- [ ] The Lens lists a document-only dash by name with a next gesture by name (app-test `at0473`, Step 9).
- [ ] The Session card bound to a dash shows its brief and plan rows and opens each in a Text card (app-test `at0479`, Step 10).
- [ ] The stage dividers and asks name `.tug/dashes/<name>/brief.md` and the dash name (app-test `at0474`, Step 10).
- [ ] `git ls-files dash` is down to this plan and its brief (Step 12), with the post-join `git rm -r dash/` named in the report (Step 13).

**Acceptance tests:**
- [ ] `a_planned_dash_lands_a_commit_whose_tree_holds_no_document` (Step 5)
- [ ] `a_document_only_dash_is_listed_until_its_branch_exists` (Step 7)
- [ ] `at0479-dash-documents-strip.test.ts` (Step 10)

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- [ ] [B07]: the Step Status Ledger as a verb-owned state block, declared cited paths, frontmatter stamp and review record.
- [ ] `dash/dash-notes.md`'s styling and progress-surface items (pill typeface consistency, the yellow dash name, the persisting join indicator).
- [ ] An `undo` for a join that restores the removed documents from the op log (Risk R03), if anyone ever wants one.

| Checkpoint | Verification |
|------------|--------------|
| Documents home and argument rule | `cargo nextest run -p tugdash-core` (Step 1) |
| Verbs by name | `cargo nextest run -p tugutil` (Step 3) |
| Arc by name | `cargo nextest run -p tugcast` (Step 4) |
| Apparatus deleted | greps (Steps 5, 6) |
| Deck on the new wire | `tsc`, `vite build`, app-tests (Steps 8–10) |
| Repository clean of `dash/` | `git ls-files dash` (Step 12) |
| Fit on the live base | `tugutil dash replay` + `verify` (Step 13) |
