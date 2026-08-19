<!-- plan authored against devise-skeleton v5 -->

## Dash Universe Scope: App-Tests From Any Worktree {#dash-universe-scope}

**Purpose:** Make the dash machinery a citizen of the instance model by giving repo-root resolution an explicit universe boundary (`TUG_REPO_UNIVERSE`), so app-tests run from any worktree with their fixture dashes born, listed, joined, and torn down entirely inside the checkout under test — then delete the `just app-test` worktree refusal and its banned override, and give at0441 the landing beat it had to leave uncovered.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-18 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-18, fable.** Reviewed `plan:9be57dbc7055e6f9`. Lint: 0 errors, 0 warnings on the first pass; nothing mechanical to fix.
Oriented on: the plan as authored plus the tree it targets — `tugutil-core/src/worktree.rs` (`find_repo_root_from`, the primitive), every `main_repo_root` call site in `tugdash-core/src/ops.rs` and `replay.rs`, `ops::create`/`join_in`/`dash_base`/`project_state_dir`, the changesets feed's two resolution rules (`dash_entries` hop vs `repo_root_for` ancestor walk), `dash-fixture.ts`, the justfile's refusal block and stale-fixture sweep, the harness's `forwardableEnv`, and the headers of at0418/at0427/at0436/at0441 — plus two live spikes: a scratch-repo `dash create` from a linked worktree (confirming the hop's exact artifacts) and a nested `git worktree add` from a worktree (confirming the scoped-create mechanics).
Applied: **(sequencing)** the one real defect — Step 4's checkpoint ran dash-lane app-tests from the main checkout, whose built `tugutil` mid-dash predates `--base`; `tugutilPath` resolves the invoking checkout's binary first, so the run would fail on the flag — a stale build reported as a broken feature. Step 4's checkpoint is now `tsc` + covers-check, and Step 5's gained the explicit worktree `cargo build -p tugutil` so the fixtures and the sweep find the new CLI. **(holes)** at0436 already presses the land control — deliberately into a server refusal (journal injected between preview and press), which its header justifies by claiming a successful landing is untestable; that claim goes stale the moment the scratch-repo fixture exists. Step 6 gained the at0436 header-update task, and the Spec S02 landing beat now states precisely what is new (press→wire→landed vs at0436's press→wire→refusal). Also in Spec S02: `git init -b main` made explicit (the machine's `init.defaultBranch` is not a fixture's to inherit), and the landing-beat deck assertion sharpened from "row reflects the landing" to the falsifiable "the lane does not keep offering a landed dash." **(laws)** [L29] — the universe comparison canonicalizes ephemeral paths at a filesystem boundary and persists no key, so the gateway doctrine is untouched; the Constraints section states the distinction so nobody reads the seam as a tolerance shim. [L31] — an invalid universe errs loudly by spec (S01 row four); `main_repo_root`'s pre-existing error swallow is documented and deliberately not widened. Non-frontend plan; no State Zone Mapping required.
Deferred: nothing — no open questions were raised and none remain.

---

### Phase Overview {#phase-overview}

#### Context {#context}

This is Round 1 of `roadmap/close-dash-join-gaps.md`. The join-truth arc (landed 2026-08-18) shipped Steps 6–10 with every app-test checkpoint skipped, because `just app-test` refuses to run from a dash worktree (`justfile`, the refusal block in the `app-test` recipe) and the `TUG_APPTEST_ALLOW_WORKTREE=1` override is banned. A whole verification tier went dark for exactly the duration of working in the parallel environment the dash lane exists to provide.

The refusal is a confession, not a harness limitation. The harness already derives per-worktree identity end to end: branch-slugged instance ids (`TUG_APPTEST_ID_PREFIX=apptest-<wtslug>`), per-worktree DerivedData, sweeps scoped to the worktree's own instances, and a machine-wide invocation gate — `tuglaws/app-test-harness.md` doctrine-izes all of it ("one worktree's run can never disturb, or even reach, another worktree's"). What breaks is one function: `tugdash_core::ops::main_repo_root`, which routes every dash verb through `tugutil_core::find_repo_root_from` — and that primitive, on seeing a `.git` *file* (a linked worktree), hops to the common dir's parent, the developer's main checkout. Verified empirically in a scratch repo: `tugutil dash create` run from a linked worktree on branch `feature` creates the dash worktree under **base**`/.tug/worktrees/`, forks the branch from **base's default branch**, and dirties base — while the app under test has the *worktree* open as its project. The dash lane and its fixtures then live in different universes.

The hop is right for the developer flow — a human running `tugutil dash create` from inside a dash worktree means "against base" — and wrong exactly when the worktree is itself the project an app instance has open. The fix is an explicit boundary, never a heuristic (see [P01]).

The second debt this plan pays: at0441 (the join-arc poster child) stops one beat short of pressing the land control, because `join_in` lands by running `git merge --squash` + `git commit` **in the base checkout's live working tree** on its checked-out branch — a fixture landing would squash onto the developer's live branch. A scratch-repo fixture (which at0239/at0268 already set precedent for, binding sessions to mkdtemp repos) removes that hazard entirely and lets the arc land ([P06]).

#### Strategy {#strategy}

- **One seam, at the resolution primitive.** The universe boundary lives in `tugutil_core::find_repo_root_from` — the single function under `find_repo_root` (CLI cwd entry), `main_repo_root` (every tugdash-core verb), `resolve_conflicts_cwd`, `base_motion.rs`, and `tugchanges-core/src/git.rs`. Every consumer scopes at once; no per-verb plumbing.
- **Explicit env, instance-granular.** Instances already differ by env (`TUG_INSTANCE_ID`, `TUG_CHANGES_DB`, `TUG_FORCE_BUNDLE_ID`), and the harness forwards every `TUG*` variable to the app (`forwardableEnv` in `tests/app-test/_harness/index.ts`), so `TUG_REPO_UNIVERSE` reaches tugcast and every fixture CLI call with zero new plumbing.
- **Default behavior byte-identical.** With the variable unset, nothing changes anywhere. The developer flow keeps its hop; only the app-test recipe sets the variable, unconditionally (`$(pwd -P)`), which is a no-op on the main checkout.
- **Bottom-up: Rust seam → CLI flag → Rust integration proof → TS fixtures → justfile → at0441.** Each step is independently green; the refusal is deleted only after every layer below it works.
- **Delete, don't widen.** The refusal block and `TUG_APPTEST_ALLOW_WORKTREE` are removed outright. No escape hatch survives.
- **Dogfood mid-run.** This plan is implemented on a dash worktree; from the justfile step onward, its own app-test checkpoints run from that worktree — the feature verifying itself.

#### Success Criteria (Measurable) {#success-criteria}

- From a dash worktree: `just build-app && just app-test tests/app-test/at0405-changes-dash-lane.test.ts` exits 0 with a green verdict, and afterwards `git -C <main-checkout> status --porcelain` shows nothing the run created (fixture branches, worktrees, dash-log lines all confined to the worktree universe).
- `grep -rn "TUG_APPTEST_ALLOW_WORKTREE" justfile tests/ tugplug/` returns nothing (checkpoint grep, not a permanent test — see [#test-non-goals](#test-non-goals)).
- at0441 presses the land control and asserts the squash commit landed on the scratch repo's base branch, the feed reported the landing, and teardown left no trace. The test passes both from the main checkout and from a dash worktree.
- `cd tugrust && cargo nextest run` green (including the new universe tests); `cd tugdeck && bun test` green; `just app-test-covers-check` green.
- `tugutil dash create <n> --base <branch>` forks the dash branch from `<branch>` and records `branch.tugdash/<n>.tugbase = <branch>`; omitting `--base` behaves exactly as today (`detect_default_branch`).

#### Scope {#scope}

1. `TUG_REPO_UNIVERSE` honored by `tugutil_core::find_repo_root_from` (Spec S01), with unit and integration coverage.
2. `tugutil dash create --base <branch>` — explicit base override on the CLI and in `ops::create`.
3. Universe-aware TS fixtures: `tests/app-test/dash-fixture.ts` derives `--base` from the checkout's current branch; the hand-rolled hop mirrors in at0418 / at0427 / at0436 read the universe first.
4. `justfile`: refusal deleted, `TUG_REPO_UNIVERSE` exported by the `app-test` recipe, stale-fixture sweep hardened for cross-universe strandings.
5. at0441 rebuilt on a scratch-repo fixture, gaining the landing beat.
6. Documentation: the universe row in `tuglaws/app-test-harness.md`'s identity table, `tests/app-test/README.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **The verified landing (Round 2 of the brief).** No build/test verification of candidate merges here; that round depends on this one.
- **Changing the default base of `dash create`.** It stays `detect_default_branch`; `--base` is opt-in.
- **Per-request universe plumbing** through the dash message surface — rejected in [P02].
- **Migrating at0417/at0418/at0425/at0426/at0427/at0435/at0436 to scratch repos.** They keep their real-repo fixtures (none of them lands); only their hop mirrors change.
- **The `~/.local/bin` symlink staleness problem.** `dash-fixture.ts::tugutilPath` already resolves by absolute path; the broader landmine is separate work.
- **Removing the machine-wide app-test gate or the shared `dev.tugtool.app.apptest` bundle identity.** Serialization stays as-is.

#### Dependencies / Prerequisites {#dependencies}

- The join-truth arc is on `main` (server-owned join state; at0441 exists) — landed 2026-08-18.
- git ≥ 2.38 (already required by the join pipeline's `merge-tree --write-tree`).
- `cargo nextest` (process-per-test execution is what makes env-var tests safe — see [#nextest-env](#nextest-env)).

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings`, workspace-wide).
- With `TUG_REPO_UNIVERSE` unset, every code path must behave byte-identically to today — the developer flow and the release app never set it.
- Banned test shapes per dash-work doctrine: no mock-store assertions, no fake-DOM render tests, no pixel measurement. Everything here drives real git repos and the real app.
- No plan-step numbers in durable artifacts (code, comments, commit messages, test names).
- Path comparison in the seam must survive spelling aliases (`/u/src/tugtool` vs `/Users/kocienda/Mounts/u/src/tugtool`) — canonicalize both sides at the point of comparison (Spec S01). This is symlink *resolution* at a filesystem boundary, not a key-tolerance shim; the L29 gateway doctrine governs persisted keys and is not in play here.

#### Assumptions {#assumptions}

- The changesets feed composes correctly for a session bound to a scratch repo — at0239/at0268 bind sessions to mkdtemp repos today, and `repo_root_for` (attribution.rs) is a plain ancestor walk. The at0441 rewrite step proves this end to end before relying on it.
- Nested `git worktree add` from a linked worktree works and places the nested tree under the worktree's own path — verified empirically during planning (git 2.x on macOS).
- `.tug/` is gitignored (repo `.gitignore`), so fixture dash worktrees under a worktree universe do not dirty its status.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the devise-skeleton anchor and label conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `[Q##]` for open questions, `Spec S##` / `Risk R##` labels, `**Depends on:**` with `#step-N` anchors, and `**References:**` lines citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None remain open. The candidate questions from the brief were resolved during planning, in the document: the scope mechanism ([P01], [P02]), the scratch-base shape for the landing fixture ([P06]), and the variable's name ([P01] rationale). No question was deferred.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Universe var affects non-dash resolvers | med | low | default-unset unchanged; only app-test sets it; full nextest sweep | any non-app-test consumer starts setting it |
| Path-spelling mismatch defeats the boundary check | med | med | canonicalize both sides (Spec S01); symlinked-universe unit test | a universe set via an alias fails to scope |
| Cross-universe stranded fixture dashes | low | low | sweep removes the worktree by its global `git worktree list` path before discard | `swept stranded fixture dash` lines naming missing trees |
| Fixture dashes transiently visible in the user's live instance | low | high | pre-existing (refs are repo-global); nonce names + `tugautoreplay=false` | user reports a fixture row that outlives its run |

**Risk R01: The universe variable reaches resolvers beyond the dash machinery** {#r01-blast-radius}

- **Risk:** `find_repo_root_from` is also under `tugcast/src/feeds/base_motion.rs`, `tugchanges-core/src/git.rs`, and `tugutil/src/commands/state_dir.rs`; scoping them changes an app-test instance's whole repo-resolution behavior at once.
- **Mitigation:** That is the intended semantic — an app-test instance's project *is* the universe, and today those consumers already disagree with the changesets feed's `repo_root_for` (a plain ancestor walk that never hops), which is the same two-universes shape the join-truth incident had. Unset ⇒ byte-identical behavior is pinned by unit tests.
- **Residual risk:** A future consumer that genuinely wants the base checkout from inside a universe must opt out explicitly; none exists today.

**Risk R02: The ref namespace stays repo-global** {#r02-refs-global}

- **Risk:** A universe scopes *paths*, not refs: `tugdash/<name>` branches and branch config live in the shared common dir, so a fixture dash in a worktree universe is visible (and name-collidable) repo-wide.
- **Mitigation:** Per-run nonce names (the existing at0426/at0441 discipline) prevent collision; `tugautoreplay=false` (set by `createDash`) keeps every instance's base-motion engine off fixture dashes; teardown deletes the branch and its config section.
- **Residual risk:** The user's release instance may transiently list a fixture dash mid-run — already true today for main-checkout runs; cosmetic.

**Risk R03: The journal state-dir slug moves with the universe** {#r03-journal-slug}

- **Risk:** `project_state_dir(repo)` slugs the resolved repo-root path into `~/Library/Application Support/Tug/projects/<slug>/`, so a scoped universe changes where `join-journal-<dash>.json` lives; the TS mirrors in at0418/at0436 (`journalPath`) and at0427 (`mainRepoRoot`) would look in the old place and read nothing — a silent divergence.
- **Mitigation:** Those mirrors become universe-aware in the same step that makes fixtures universe-aware ([P08], #step-4), before the refusal is deleted (#step-5), so no ordering window exists in which a worktree run uses stale mirrors.
- **Residual risk:** A future test hand-rolling the hop again; the fixture module exports one shared `universeRoot()` helper to make the right thing the easy thing.

---

### Design Decisions {#design-decisions}

#### [P01] Repo-root resolution honors an explicit universe boundary, at the primitive (DECIDED) {#p01-universe-seam}

**Decision:** `tugutil_core::find_repo_root_from` gains one rule, checked first: when `TUG_REPO_UNIVERSE` is set and the start path is inside (or equal to) the universe path, resolution returns the universe root and never hops. Outside the universe, and whenever the variable is unset, behavior is unchanged.

**Rationale:**
- The hop's real meaning is "resolve from a checkout to the checkout that *owns* it." A universe names the owner explicitly instead of assuming the common dir's parent — which is wrong exactly when the linked worktree is itself the project an instance has open.
- One primitive underlies every consumer (`find_repo_root`, `main_repo_root`, `resolve_conflicts_cwd`, base motion, tugchanges), so a single seam scopes them coherently. Per-verb overrides would reintroduce the two-universes disagreement this exists to kill.
- Explicit beats heuristic: "hop only from Tug-created dash worktrees" was considered and rejected — it silently changes CLI behavior for every hand-made worktree, and a boundary you cannot see in `env` is a boundary you cannot debug.
- Named `TUG_REPO_UNIVERSE` (not `TUG_DASH_UNIVERSE`) because the primitive it gates is repo-root resolution generally, and dash is only its loudest consumer.

**Implications:**
- Both sides of the containment check are canonicalized (`std::fs::canonicalize`) at comparison time, so `/u/src/…` and `/Users/kocienda/Mounts/u/src/…` spellings agree (Spec S01).
- A set-but-invalid universe (path missing, or no `.git` under it) is a loud error from `find_repo_root_from`, never a silent fallthrough — errors never fail silently. (`main_repo_root`'s existing `unwrap_or_else(start)` swallow is pre-existing behavior for *unset* operation and is not widened.)
- Inside a universe, a fixture dash worktree at `<universe>/.tug/worktrees/<n>` resolves to the universe — the hop's "dash worktree → owner" semantic is preserved one level down, by the same containment rule.

#### [P02] The boundary is instance-granular env, not per-request plumbing (DECIDED) {#p02-env-not-per-request}

**Decision:** The universe is a process-environment fact, set at instance launch, not a parameter threaded through the dash message surface.

**Rationale:**
- An app-test instance is under test *as a whole*, on one checkout; there is no scenario in which one workspace of the instance wants a scoped universe and another wants the hop.
- The propagation already exists: the justfile exports it → the `bun test` process inherits it (fixture CLI calls) → `forwardableEnv` forwards every `TUG*` var to Tug.app → tugcast inherits from the app. Zero new plumbing, and the same channel `TUG_CHANGES_DB` / `TUG_PROMPT_HISTORY_DB` isolation already rides.
- Per-request plumbing would touch every `*_in` signature and every wire message for a distinction no caller can meaningfully make.

**Implications:**
- The variable's value is set once by the recipe (`$(pwd -P)` — physical path, symlink-free) and never computed by tests.
- Bare `bun test` outside the recipe (already discouraged) runs without a universe: from the main checkout that is correct; from a worktree it reproduces today's mismatch, which the recipe path exists to prevent.

#### [P03] `dash create` gains `--base <branch>`; the default is unchanged (DECIDED) {#p03-create-base}

**Decision:** `tugutil dash create <name> --base <branch>` forks the dash branch from `<branch>` and records it as `branch.tugdash/<name>.tugbase`; omitted, `detect_default_branch` decides exactly as today.

**Rationale:**
- `ops::create` currently forks from `detect_default_branch` (origin/HEAD → `main` → `master`). In a worktree universe checked out on a feature or `tugdash/*` branch, a fixture dash forked from `main` would carry the wrong content — not the code under test — and its join preflight would refuse on "base has a different branch checked out."
- The mechanism already exists at the git level: `create` passes `base_branch` to `git worktree add -b … <base_branch>` and to the `tugbase` config write; the flag only makes the input explicit.
- Changing the *default* to the current branch was considered and rejected: it silently alters every real `dash create` a human runs while parked off `main`.

**Implications:**
- `--base` validates the branch exists (`branch_exists`) and refuses loudly otherwise.
- The `create --json` receipt's `base_branch` field reports the effective base, as it already does.
- The idempotent revisit path (dash already exists) ignores `--base` rather than rewriting `tugbase` — a dash's base is set at birth; changing it later is a different verb this plan does not add.

#### [P04] Fixtures derive `--base` from the checkout's current branch (DECIDED) {#p04-fixture-base}

**Decision:** `dash-fixture.ts::createDash` passes `--base <current branch of projectDir>` (from `git -C <projectDir> branch --show-current`), so every dash-lane fixture forks from — and preflights against — the branch the universe actually has out.

**Rationale:**
- One helper, every dash-lane test: at0405, at0408, at0417, at0418, at0425, at0426, at0427, at0435, at0436, at0441 all create through it.
- On the main checkout this resolves to `main` — today's behavior, unchanged. On a worktree universe it resolves to the branch under test, which is the entire point.

**Implications:**
- Fixtures that rewind relative to commits (at0441-style `reset --hard <sha>~1`) now resolve those SHAs and the fork point from the same branch — the coherence the hop currently breaks.

#### [P05] The refusal is deleted, and the recipe always exports the universe (DECIDED) {#p05-delete-refusal}

**Decision:** The `app-test` recipe's refusal block (both triggers: linked worktree, `tugdash/*` HEAD) and every mention of `TUG_APPTEST_ALLOW_WORKTREE` are removed. In their place the recipe exports `TUG_REPO_UNIVERSE="$(pwd -P)"` unconditionally.

**Rationale:**
- Unconditional export is branch-free and self-documenting; on the main checkout it is a no-op (`.git` is a directory — resolution never consults the hop).
- The doctrine (`tuglaws/app-test-harness.md`) already promises per-worktree disjointness; the refusal was the one place the promise didn't hold. Deleting it makes the recipe agree with its own laws.
- No escape hatch: an override that "proceeds anyway" into a known-broken configuration is exactly the class of quiet wrongness this repo bans.

**Implications:**
- `app-test-changed` needs no edit — it delegates to `just app-test $FILES`, which now exports the variable.
- The stale-fixture sweep (`tugdash/at04??-*` branches) learns to remove a stranded worktree at its *globally listed* path (`git worktree list --porcelain`) before `dash discard`, so a fixture stranded by a run in one universe is reclaimable from another.

#### [P06] at0441 moves to a scratch-repo fixture and presses the land control (DECIDED) {#p06-scratch-repo}

**Decision:** at0441's fixture becomes a mkdtemp scratch git repo (Spec S02): the session binds `projectDir: <scratch>`, the dash is created there, and the arc runs through the actual landing — squash commit on the scratch repo's base branch, feed-reported, torn down by `rm -rf`.

**Rationale:**
- `join_in` lands by mutating the base checkout's live working tree (`merge --squash` + `commit` on the checked-out base branch, after requiring `current_branch == tugbase`). The only way to press land safely is a checkout whose HEAD the test owns — which no shared checkout is, from anywhere.
- A scratch *repo* needs no universe variable at all: its `.git` is a directory, so resolution returns it identically with the var set or unset — the fixture is correct from the main checkout, from a worktree, and from bare `bun test`.
- Precedent: at0239/at0268 bind sessions to scratch repos today; `repo_root_for` is a plain ancestor walk.
- The scratch repo also deletes at0441's most fragile hygiene: the per-run nonce against real `tugdash/*` refs, the `rr-cache` cleanup, and the "nothing touches the base branch" caveat all become structural instead of disciplined.

**Implications:**
- `dash-fixture.ts` splits binary resolution from working directory: `tugutilPath` keeps resolving the built CLI from the checkout under test, while `createDash`/`commitRound`/`discardDash` accept the scratch repo as cwd.
- The stub merge driver (`tugdash.mergedriver`) and rerere config are written into the scratch repo's own config.
- at0441's exit criterion from the join-truth plan — "the poster child lands with no CLI intervention" — is finally discharged as a pressed button, not a Rust-layer proxy (`test_dash_join_lands_resolved_candidate` remains as the unit-level pin).

#### [P07] Universes scope paths, never refs (DECIDED) {#p07-paths-not-refs}

**Decision:** No attempt is made to namespace `tugdash/*` branches, branch config, or `git worktree list` per universe; the shared common dir stays the single ref store, and collision avoidance stays a naming discipline (nonces for fixtures).

**Rationale:**
- Refs-by-construction *are* repo-global; pretending otherwise would need a second git, and the failure mode of half-hiding refs is worse than seeing them.
- The visible consequences are already today's (fixture dashes appear transiently to any instance watching the repo) and already mitigated (`tugautoreplay=false`, nonce names, teardown).

**Implications:**
- Two universes creating a dash with the *same name* genuinely fight over one branch. Fixtures nonce; humans don't run two universes by hand. Documented, not defended against.

#### [P08] TS hop mirrors become universe-aware, through one shared helper (DECIDED) {#p08-ts-mirrors}

**Decision:** `dash-fixture.ts` exports `universeRoot(projectDir)`: `TUG_REPO_UNIVERSE` when set (realpath'd), else the existing common-dir hop. at0418's and at0436's `journalPath` and at0427's `mainRepoRoot` are rewritten onto it.

**Rationale:**
- Those three functions are hand-written copies of `main_repo_root`'s current semantics; leaving any copy un-updated recreates the exact class of silent divergence (state read from the wrong universe's slug) this plan exists to kill.
- One exported helper makes the next test's right choice the path of least resistance.

**Implications:**
- With the recipe always exporting the variable, the helper's env branch is the live one under `just`; the hop branch remains only for bare `bun test` from the main checkout.

---

### Deep Dives {#deep-dives}

#### The hop's anatomy {#hop-anatomy}

`tugutil_core::find_repo_root_from(start)` (`tugrust/crates/tugutil-core/src/worktree.rs`) checks exactly `start/.git` — no upward walk. A `.git` **directory** means `start` is a main checkout: return `start`. A `.git` **file** means a linked worktree: shell `git rev-parse --path-format=absolute --git-common-dir` and return the common dir's parent — the hop. Anything else is `TugError::NotAGitRepository`.

`tugdash_core::ops::main_repo_root(start)` wraps it as `find_repo_root_from(start).unwrap_or_else(|_| start.to_path_buf())` and is called at the top of every dash verb's `*_in` entry point (`dash_detail_entries_in`, `dash_detail_entry_in`, `join_preflight_in`, `join_conflicts_in`, `join_in`, `discard_in`, `adopt_plan_in`, `rev_parse`, `current_branch`) and inside `replay.rs`. The cwd-based CLI wrappers (`create`, `list`, `status`, `join`, …) reach the same primitive through `find_repo_root()`.

The asymmetry that makes this a live bug rather than a design choice: tugcast's changesets feed resolves its own root with `attribution.rs::repo_root_for` — a plain ancestor walk that **never hops** — while the dash entries inside the same feed hop via `dash_detail_entries_in`. Two resolution rules in one snapshot is the identical shape to the join-truth incident's two-key deadlock, one layer down.

Empirical ground truth (scratch repo, linked worktree `wt` on branch `feature`): `tugutil dash create spiketest` run from `wt` created `base/.tug/worktrees/spiketest`, forked `tugdash/spiketest` from base's `main` (not `feature`), wrote `branch.tugdash/spiketest.tugbase = main` into the shared config, and reported `base_dirt` on base. Nested `git worktree add .tug/worktrees/nested -b tugdash/nested` from `wt` succeeds and lands the nested tree under `wt`'s own path — the scoped-create mechanics work at the git layer.

#### What landing does to the base checkout {#landing-mechanics}

`join_in` (`tugrust/crates/tugdash-core/src/ops.rs`) — after the preview and journal branches — requires the process cwd outside the dash worktree, requires `current_branch(repo_root) == tugbase`, runs the intersection preflight, `commit_worktree_dirt`, then either fast-forwards a ladder candidate (`merge --ff-only`) or runs `merge --squash <branch>` + `git commit` **directly in the resolved root's working tree**, followed by the journaled teardown. A landing is therefore a mutation of the base checkout's HEAD and working tree — the reason at0441 could never press the control against a shared checkout, from any run location, and the reason the fixture that finally presses it must own its checkout outright ([P06]).

Related state off to the side: `join_journal_path` = `project_state_dir(repo)` + `join-journal-<dash>.json`, where the state-dir slug is derived from the resolved repo-root *path*. A scoped universe therefore moves the journal's home — which is correct (the journal belongs to the universe that landed) but is exactly why the TS mirrors must move in the same commit wave ([P08], Risk R03).

#### Environment propagation {#env-propagation}

The chain, all existing machinery: the `app-test` recipe exports `TUG_REPO_UNIVERSE="$(pwd -P)"` → the `bun test` child inherits it (so every fixture `tugutil` call scopes) → `_harness/index.ts::forwardableEnv` forwards every `TUG*` variable into Tug.app's launch env (alongside `TUG_INSTANCE_ID`, `TUG_CHANGES_DB`, `TUG_PROMPT_HISTORY_DB`) → tugcast inherits from the app → every `tugdash-core` call inside tugcast scopes. `app-test-changed` delegates to `just app-test`, so one export covers both entry points.

#### nextest and env-dependent tests {#nextest-env}

Setting a process-global env var inside a test is normally a parallelism hazard. `cargo nextest` runs **one process per test**, so a test that sets `TUG_REPO_UNIVERSE` for itself cannot leak into a sibling. The new Rust tests rely on this; they must not be written as `#[test]`-in-shared-process assumptions, and a comment in the test module states the nextest dependency.

---

### Specification {#specification}

**Spec S01: Universe resolution semantics** {#s01-universe-resolution}

`TUG_REPO_UNIVERSE` — absolute path to the checkout that owns this process's repo universe. Consulted only by `tugutil_core::find_repo_root_from`, before any `.git` inspection:

| Condition | Result |
|---|---|
| Var unset | Current behavior, byte-identical (`.git` dir → start; `.git` file → common-dir parent; else `NotAGitRepository`) |
| Var set; canonicalized `start` is inside or equal to canonicalized universe; `<universe>/.git` exists | The universe root (no hop, no subprocess) |
| Var set; `start` outside the universe | Current behavior (the var is a boundary, not a global override — scratch repos in `/tmp` resolve normally) |
| Var set; universe path missing or `<universe>/.git` absent | `Err` naming the variable, its value, and what was missing — loud, never a fallthrough |

Canonicalization is `std::fs::canonicalize` on both sides at comparison time (resolves the `/u/src/tugtool` ↔ `/Users/kocienda/Mounts/u/src/tugtool` aliasing). The recipe sets the value with `$(pwd -P)`; the Rust side still canonicalizes rather than trusting the writer. The env const (`TUG_REPO_UNIVERSE`) lives beside `find_repo_root_from` in `tugutil-core/src/worktree.rs` as the single named string.

**Spec S02: The at0441 scratch-repo fixture** {#s02-scratch-fixture}

A `beforeAll`-built repo under `mkdtempSync(join(tmpdir(), "at0441-"))`:

1. `git init -b main` (explicit — the machine's `init.defaultBranch` may be anything) + identity config; initial commit containing the conflict file with a known body. With no origin, `detect_default_branch` finds the local `main`.
2. `createDash(scratch, DASH, …)` — through the fixture helper, which resolves the CLI binary from the checkout under test (`tugutilPath(PROJECT_DIR)`) but runs with `cwd: scratch`. `--base` derives to `main`.
3. The conflict: a base commit on scratch `main` rewriting the file, the dash round rewriting the same lines — the at0426 shape, minus the rewind (scratch history is authored, not excavated).
4. `tugdash.mergedriver` stub and rerere config written into the scratch repo's config; the driver script lives inside the scratch tmpdir.
5. The session binds `projectDir: scratch`; every existing beat (conflicted → resolve → progress → resolved → reload → reviewed → route → typed message → armed) runs as today, against the scratch workspace.
6. **The new beat:** press the land control; assert the feed reports the landed outcome, `git -C scratch log -1 main` is the squash commit carrying the draft/integrate message, the `tugdash/<n>` branch and worktree are gone (the journaled teardown ran), and the deck agrees — the dash's entry leaves the lane (its branch no longer exists) or shows its landed receipt, whichever the lane renders; the assertion pins that the lane does not keep offering a landed dash.

The *successful* press is the genuinely new coverage: at0436 already walks press → gate → wire, but deliberately injects an interrupted-teardown journal so the server *refuses* — the strongest safe test against a shared checkout. This fixture owns its checkout, so the refusal workaround is no longer the ceiling.
7. `afterAll`: `rm -rf` the tmpdir. No nonce, no `rr-cache` scrubbing, no real-repo refs — the hygiene is structural.

The `@covers` header keeps its current list and adds `tugrust/crates/tugdash-core/src/ops.rs` (the landing path it now exercises).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| _none_ | every change lands in existing files |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `REPO_UNIVERSE_ENV` | const | `tugrust/crates/tugutil-core/src/worktree.rs` | `"TUG_REPO_UNIVERSE"`, the one named string |
| `find_repo_root_from` | fn (modify) | `tugrust/crates/tugutil-core/src/worktree.rs` | Spec S01 semantics |
| `ops::create` | fn (modify) | `tugrust/crates/tugdash-core/src/ops.rs` | `base: Option<&str>` parameter; validate via `branch_exists`; feeds `git worktree add … <base>` and the `tugbase` write |
| `DashCommands::Create` | enum variant (modify) | `tugrust/crates/tugutil/src/dash.rs` | `--base <branch>` clap arg, threaded to `run_create` |
| `universeRoot` | fn (new export) | `tests/app-test/dash-fixture.ts` | env-first universe resolution for TS mirrors ([P08]) |
| `createDash` | fn (modify) | `tests/app-test/dash-fixture.ts` | derives and passes `--base`; cwd/binary-root split for scratch repos |
| `journalPath` | fn (modify) | `tests/app-test/at0418-join-outcomes.test.ts`, `at0436-join-land-press.test.ts` | rewritten onto `universeRoot` |
| `mainRepoRoot` | fn (modify) | `tests/app-test/at0427-dash-divergence-marks.test.ts` | rewritten onto `universeRoot` |
| `app-test` recipe | just recipe (modify) | `justfile` | refusal deleted; `TUG_REPO_UNIVERSE` export; sweep hardening |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/app-test-harness.md`: add `TUG_REPO_UNIVERSE` to the per-instance identity table and a short paragraph in the isolation section stating that dash-verb repo resolution is scoped to the checkout under test; delete any surviving reference to the worktree refusal.
- [ ] `tests/app-test/README.md`: note that the corpus runs from any checkout, that the recipe pins the universe automatically, and what `--base` means for dash fixtures.
- [ ] Propose (do not self-add) a global design-decision entry for `tuglaws/design-decisions.md`: *repo-root resolution honors an explicit universe boundary; the hop is the unowned default, never the only rule* — the user accepts or declines at landing time.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Spec S01's four rows, each as its own nextest-process test (set/unset, inside/outside, symlinked spelling, invalid universe) | `tugutil-core/src/worktree.rs` |
| **Integration (Rust)** | Dash verbs under a scoped universe: create-with-`--base` forks and records correctly; detail entries, preflight, and a full `join_in` landing run entirely inside a linked-worktree universe | `tugdash-core` test modules, scratch repos per test |
| **App-test** | at0441 (scratch repo, full arc through the landing); at0405 as the smoke test that a worktree-universe run leaves the main checkout untouched | `tests/app-test/` |
| **Golden / Contract** | `dash create --json` receipt's `base_branch` under `--base` | existing receipt tests' home in `tugdash-core` |

#### What stays out of tests {#test-non-goals}

- **No permanent absence assertions.** That `TUG_APPTEST_ALLOW_WORKTREE` is gone is verified once by a checkpoint grep, never pinned by a test — a test asserting a removed thing stays removed is crud (per explicit owner direction on exactly this pattern).
- **No re-pinning of unchanged join behavior.** The join pipeline's own coverage (at0417–at0436 minus the mirror edits, the `join-resolve-face` table tests, the Rust ladder tests) stands; this plan tests what it changes.
- **No mock repos, no fake filesystems.** Every test drives real git in real directories; banned shapes per doctrine.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The universe seam in tugutil-core | done | `c9bb95110` |
| #step-2 | `dash create --base` | done | `f185d5d52` |
| #step-3 | Dash verbs proven under a scoped universe | done | `d8a11ef76` |
| #step-4 | Universe-aware TS fixtures and hop mirrors | done | `a183edb1e` |
| #step-5 | Delete the refusal; the recipe pins the universe | done | `ab63d764b` |
| #step-6 | at0441 lands, on a scratch repo | done | `21bb1d6d3` |
| #step-7 | Documentation sync | done | `6afcf233a` |
| #step-8 | Integration checkpoint | done | `6ab3ac298` |

#### Step 1: The universe seam in tugutil-core {#step-1}

**Commit:** `tugutil-core(universe): repo-root resolution honors an explicit TUG_REPO_UNIVERSE boundary`

**References:** [P01] Universe seam, [P02] Env not per-request, Spec S01, Risk R01, (#hop-anatomy, #nextest-env)

**Artifacts:**
- `REPO_UNIVERSE_ENV` const and the Spec S01 rule in `find_repo_root_from` (`tugrust/crates/tugutil-core/src/worktree.rs`).

**Tasks:**
- [ ] Implement Spec S01: env check first; canonicalize both sides; containment ⇒ universe root; outside ⇒ existing logic; invalid universe ⇒ loud `Err` naming variable, value, and defect.
- [ ] Doc-comment the function with the boundary semantics and why the check precedes `.git` inspection.

**Tests:**
- [ ] Unset ⇒ byte-identical behavior for `.git`-dir, `.git`-file, and non-repo starts (the existing tests keep passing untouched).
- [ ] Set + start inside a linked-worktree universe ⇒ universe root, no hop.
- [ ] Set + start addressed through a symlinked spelling of the universe ⇒ still scopes (canonicalization).
- [ ] Set + start outside the universe (a scratch repo elsewhere) ⇒ existing behavior.
- [ ] Set + universe with no `.git` ⇒ `Err`, message names `TUG_REPO_UNIVERSE`.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugutil-core`

---

#### Step 2: `dash create --base` {#step-2}

**Depends on:** #step-1

**Commit:** `tugutil(dash): create --base forks and records an explicit base branch`

**References:** [P03] Create base flag, (#hop-anatomy)

**Artifacts:**
- `--base <branch>` on `DashCommands::Create` (`tugrust/crates/tugutil/src/dash.rs`), threaded through `run_create` into `ops::create`'s new `base: Option<&str>`.

**Tasks:**
- [ ] `ops::create`: when `base` is given, validate with `branch_exists` (loud refusal naming the branch), use it for the `git worktree add … -b … <base>` fork and the `tugbase` config write; when absent, `detect_default_branch` exactly as today.
- [ ] The idempotent revisit path ignores `--base` (a dash's base is set at birth); the receipt still reports the effective `base_branch`.

**Tests:**
- [ ] Create with `--base feature` in a scratch repo parked on `main` ⇒ branch forks from `feature`'s tip, `tugbase = feature`, receipt agrees.
- [ ] Create with `--base nonexistent` ⇒ `Err` naming the branch; no branch, worktree, or config residue.
- [ ] Create without `--base` ⇒ unchanged default (existing create tests still green).

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 3: Dash verbs proven under a scoped universe {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `tugdash-core(universe): dash verbs operate inside a scoped worktree universe`

**References:** [P01] Universe seam, [P04] Fixture base, [P07] Paths not refs, Spec S01, Risk R02, (#landing-mechanics, #nextest-env)

**Artifacts:**
- Integration tests in `tugdash-core` exercising the whole verb surface inside a linked-worktree universe (scratch base repo + `git worktree add` sibling + `TUG_REPO_UNIVERSE` set per test; nextest's process-per-test noted in the module comment).

**Tasks:**
- [ ] Prove: `create --base <worktree-branch>` from inside the universe puts the dash worktree at `<universe>/.tug/worktrees/<n>`, forks from the worktree's branch, and leaves the scratch *base* checkout untouched (no new worktree dirs, no dash-log line, clean `git status`).
- [ ] Prove: `dash_detail_entries_in(<universe path>)` lists the dash with `worktree_abs` under the universe.
- [ ] Prove: `join_preflight_in` reads `current_branch` of the universe (coherent, no off-base blocker), and a full `join_in` lands the squash on the universe's checked-out branch, journal written under the universe's `project_state_dir` slug.
- [ ] Prove: `discard_in` tears down branch + worktree inside the universe.

**Tests:**
- [ ] The four proofs above, each its own test with its own scratch universe.

**Checkpoint:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run -p tugdash-core`

---

#### Step 4: Universe-aware TS fixtures and hop mirrors {#step-4}

**Depends on:** #step-2

**Commit:** `app-test(dash-fixture): fixtures derive --base and resolve state through the universe`

**References:** [P04] Fixture base, [P08] TS mirrors, Risk R03, (#env-propagation)

**Artifacts:**
- `universeRoot(projectDir)` exported from `tests/app-test/dash-fixture.ts`; `createDash` passing `--base`; cwd/binary-root split (`tugutilPath` root vs. call cwd) so a later scratch-repo caller can use the checkout's binary against another repo.
- at0418 / at0436 `journalPath` and at0427 `mainRepoRoot` rewritten onto `universeRoot`.

**Tasks:**
- [ ] `createDash` reads `git -C <projectDir> branch --show-current` and passes `--base` (empty/detached ⇒ omit the flag, preserving today's behavior).
- [ ] `universeRoot`: `process.env.TUG_REPO_UNIVERSE` realpath'd when set; else the existing common-dir hop — one implementation, three call sites converted, none left hand-rolled (grep the corpus for `git-common-dir` to confirm only `tugutilPath`'s binary probe remains).
- [ ] Update the three tests' header comments to state the universe rule instead of the hop rule.

**Tests:**
- [ ] Existing dash-lane app-tests, unchanged in behavior — proven by the Step 5 checkpoint run, not by new unit tests. (They cannot run here: mid-dash, the main checkout's built `tugutil` predates `--base`, and `tugutilPath` resolves the invoking checkout's own binary first — an app-test run from main would exercise the old CLI against the new fixture and fail on the flag, a stale build reported as a broken feature.)

**Checkpoint:**
- [ ] `cd <worktree>/tests/app-test && bunx tsc --noEmit`
- [ ] `cd <worktree> && just app-test-covers-check`

---

#### Step 5: Delete the refusal; the recipe pins the universe {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `justfile(app-test): the corpus runs from any checkout — universe pinned, refusal deleted`

**References:** [P05] Delete refusal, [P02] Env not per-request, Risk R02, (#env-propagation, #success-criteria)

**Artifacts:**
- `justfile`: refusal block gone, `TUG_APPTEST_ALLOW_WORKTREE` gone from the file entirely, `export TUG_REPO_UNIVERSE="$(pwd -P)"` beside the existing identity exports, stale-fixture sweep removing `DASH_TREE` at its globally listed path before `dash discard`.

**Tasks:**
- [ ] Delete the refusal and its comment block; write a short replacement comment stating the universe export's contract and pointing at Spec S01's home in `tugutil-core`.
- [ ] Harden the sweep: `git worktree remove --force "$DASH_TREE"` (best-effort, same silence discipline as the surrounding sweep) before the discard, so cross-universe strandings reclaim.
- [ ] `grep -rn "TUG_APPTEST_ALLOW_WORKTREE"` across the repo ⇒ zero hits.

**Tests:**
- [ ] None new — this step's proof is its checkpoint.

**Checkpoint:**
- [ ] From this plan's own dash worktree: `cd tugrust && cargo build -p tugutil` (the fixtures and the sweep resolve the worktree's own `tugrust/target/debug/tugutil`, which must carry `--base`), then `just build-app` (the harness never rebuilds the binary; the worktree's Rust must be in the bundle), then `just app-test tests/app-test/at0405-changes-dash-lane.test.ts tests/app-test/at0427-dash-divergence-marks.test.ts` ⇒ green verdict.
- [ ] After that run: `git -C /u/src/tugtool status --porcelain` shows nothing the run created, and `git -C /u/src/tugtool branch --list 'tugdash/at04*'` is empty — the fixtures lived and died inside the worktree universe.

---

#### Step 6: at0441 lands, on a scratch repo {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `app-test(join-arc): the poster child lands — scratch-repo fixture through the pressed land control`

**References:** [P06] Scratch repo, Spec S02, (#landing-mechanics)

**Artifacts:**
- at0441 rebuilt per Spec S02: scratch-repo fixture, existing beats preserved, the landing beat added, nonce/`rr-cache`/real-refs hygiene deleted as structurally obsolete, `@covers` extended with `tugrust/crates/tugdash-core/src/ops.rs`.

**Tasks:**
- [ ] Build the fixture per Spec S02 (authored history, not excavated; stub driver and rerere config in scratch config).
- [ ] Rewrite the header doc: the "where it stops, and why" section becomes "where it lands, and why that is safe now."
- [ ] Update at0436's header rationale in the same commit: its "a join that succeeds squashes onto a branch no test may touch" paragraph is superseded by the scratch-repo pattern — at0436 remains the press→wire→**refusal** pin, and its comment should point at at0441 for the press→wire→**landed** half rather than claiming the landed half is untestable.
- [ ] Add the landing beat's assertions: feed-reported landed outcome, squash commit on scratch `main` carrying the integrate message, branch + worktree torn down, deck row consistent after the landing.
- [ ] `just app-test-covers-check` for the header edit.

**Tests:**
- [ ] at0441 itself — the arc now runs conflicted → resolved → reviewed → armed → **landed**.

**Checkpoint:**
- [ ] From the dash worktree: `just app-test tests/app-test/at0441-join-arc-end-to-end.test.ts` ⇒ green.
- [ ] `cd /u/src/tugtool && just app-test-covers-check`

---

#### Step 7: Documentation sync {#step-7}

**Depends on:** #step-5, #step-6

**Commit:** `tuglaws(app-test): the universe boundary joins the instance-identity doctrine`

**References:** [P01] Universe seam, [P05] Delete refusal, (#documentation-plan)

**Artifacts:**
- The three Documentation Plan items: `tuglaws/app-test-harness.md` identity-table row + isolation paragraph; `tests/app-test/README.md` update; the drafted-but-not-self-added `[D##]` proposal text for `tuglaws/design-decisions.md`, included in the commit body for the user to accept or strike at landing.

**Tasks:**
- [ ] Write the doc edits; keep the proposal out of `design-decisions.md` itself (the global ledger is the user's).

**Tests:**
- [ ] None — documentation.

**Checkpoint:**
- [ ] `grep -n "refus" tuglaws/app-test-harness.md tests/app-test/README.md` shows no surviving claim that app-tests must run from the main checkout.

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify every artifact works together across both universes: the derived selection from the dash worktree, the full Rust and bun suites, the covers lint.

**Tests:**
- [ ] `cd /u/src/tugtool/tugrust && cargo nextest run`
- [ ] `cd /u/src/tugtool/tugdeck && bun test && bunx vite build`

**Checkpoint:**
- [ ] From the dash worktree: `just build-app && just app-test-changed` ⇒ green verdict on the derived selection (the dash-lane family plus whatever the diff resolves).
- [ ] From the dash worktree, post-run: main checkout status clean of run residue (the Step 5 assertion, re-run against the full selection).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** App-tests run from any worktree with dash fixtures fully confined to the checkout under test; the refusal and its banned override no longer exist; at0441 covers the join arc through a pressed, landed join.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `just app-test <dash-lane file>` is green from a dash worktree, with zero residue in the main checkout (Step 5 checkpoint).
- [ ] `TUG_APPTEST_ALLOW_WORKTREE` appears nowhere in the tree (grep, Step 5).
- [ ] at0441 lands its dash and is green from both the main checkout and a worktree (Step 6 + Step 8).
- [ ] `cargo nextest run`, `bun test`, `bunx vite build`, `just app-test-covers-check` all green (Step 8).
- [ ] Docs state the universe rule; the global `[D##]` proposal is in the user's hands, not self-added (Step 7).

**Acceptance tests:**
- [ ] The Step 3 Rust integration suite (verbs inside a scoped universe, including a real landing).
- [ ] at0441 with its landing beat.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Round 2 of `roadmap/close-dash-join-gaps.md` — the verified landing (merged-tree build + `@covers`-derived selection as a server-owned feed fact), which consumes this round's worktree-capable harness.
- [ ] Migrating the remaining dash-lane fixtures to scratch repos if real-repo fixture hygiene ever bites again.
- [ ] The `~/.local/bin` symlink staleness landmine, separately.

| Checkpoint | Verification |
|------------|--------------|
| Worktree run, zero residue | Step 5 checkpoint commands |
| Poster child lands | at0441 green, both universes |
| Whole-suite health | Step 8 commands |
