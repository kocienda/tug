<!-- written against devise-skeleton v3 -->

## Retire `state.db` and Plan Validation — Keep the Skeleton, Cut the Scaffolding {#retire-statedb-validation}

**Purpose:** Remove the dash state database, the plan parser/validator, and the
`tugutil validate` gate — the mechanization that grew up around the plan format — while
keeping the [devise-skeleton](../tuglaws/devise-skeleton.md) structure intact, so
`devise` / `implement` / `dash` read and act on plan files and code directly.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | done |
| Target branch | `main` |
| Last updated | 2026-06-01 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Two pieces of tugutil infrastructure have outlived their reason to exist, and a third —
the skills' validation ceremony — exists only to feed them.

`state.db` is a 2-table SQLite database (`dashes`, `dash_rounds`) used by exactly one
caller, `tugutil dash`; its own schema header admits *"the only surviving consumer is the
dash flow."* A dash **is** a git branch (`tugdash/<name>`) plus a worktree
(`.tugtree/tugdash__<name>`), and `dash_rounds` is `git log` + `git show --stat` copied
into rows — ~90% of the database duplicates state git already holds. Its original
justification, visibility into long-running `/implement` runs, is gone, and the artifact
that visibility produced — `.tugtool/tugplan-implementation-log.md` — was created by
`tugutil init` but **never written to.** A committed fossil.

Meanwhile `/implement` opens by running `tugutil validate`, which drags in a 1967-line
`validator.rs` and a 1698-line `parser.rs` to turn a markdown plan into an AST and assert
metadata/anchor/dependency rules before a single line of real work. The parser's only
non-validation consumer, `tugutil list`, uses it to count checkboxes.

The plan *format* earns its keep — it keeps work on track. What we remove is the compiler
that grew around it. See [P01].

#### Strategy {#strategy}

- **Keep the language, delete the compiler.** The skeleton structure stays a required
  authoring convention; the parser/validator/state.db/validate-gate that mechanized it go.
- **Git is the source of truth for dash lifecycle** ([P02]); the one datum git lacks — the
  verbatim instruction — lands in a flat append-only markdown log ([P04]).
- **Hydrate the worktree at creation, from config** ([P07]); a fresh `tugdash/` worktree
  arrives with deps installed, so the skills get to work instead of rediscovering `bun install`.
- **Sequence for a green build at every step.** `StateDb` spans all dash subcommands, so the
  dash rewrite is one atomic step. `parser`/`types` can only be deleted after *both* their
  consumers (`validator`, `list`) are gone, so validation removal precedes parser removal.
- **Docs and skills last**, once the commands they describe no longer exist.
- **Prune as we cut** — dead `TugError` variants and unused deps fail the `-D warnings` build,
  so they are removed in the same step that orphans them.

#### Success Criteria (Measurable) {#success-criteria}

- `rg 'StateDb|parse_tugplan|validate_tugplan|state\.db'` returns zero hits in live code
  (outside `dash/archive/`). (grep)
- `tugutil-core/Cargo.toml` no longer depends on `rusqlite` or `sha2`. (file inspection)
- `cargo build` and `cargo nextest run` pass clean under `-D warnings` across the workspace. (CI/local)
- A full `dash create → commit → show → join` cycle works with no `.tugtool/state.db`
  present, leaving a `tugdash(...)` commit on `main` and lines in the dash-log under
  `project_state_dir()`. (manual)
- A fresh `dash create` leaves the worktree hydrated (`tugdeck/node_modules` present) with no
  manual `bun install`. (manual)
- Per-user runtime state (dash-log, code-sign sentinel) lives under `…/Tug/projects/<slug>/`; the
  repo's `.tugtool/` holds only `config.toml`; and a Claude Read of a file under
  `project_state_dir()` completes without a permission prompt. (manual)
- `tuglaws/devise-skeleton.md` retains every structural section; only its two
  `tugutil validate` references are removed. (diff inspection)

#### Scope {#scope}

1. Rewrite `tugutil dash` on git primitives + config-driven worktree hydration; add
   `project_state_dir()` and write the flat dash-log there; delete `state.db` / `StateDb`.
2. Delete `validator.rs`, `parser.rs`, `types.rs`, the `validate` command, and `tugutil list`.
3. Strip the `validate` gate and round-ledger plumbing from the `devise`/`implement`/`dash`
   skills and `tugplug/CLAUDE.md`; strip the validation references from `devise-skeleton.md`.
4. Relocate per-user runtime state out of the repo to per-project `project_state_dir()` (dash-log,
   code-sign sentinel) and register it for frictionless Claude reads; the repo's `.tugtool/` keeps
   only the committed hook config.
5. Cleanup: deps, `lib.rs` exports, the `init` log fossil, dead error variants, gitignore,
   orphaned `.tugtool` files, integration tests.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Changing the plan format.** No skeleton section is added, removed, or restructured.
- **Touching tugbank/tugcast's own rusqlite usage.** Those are legitimate and unrelated.
- **Reworking the dash UX** beyond what dropping the DB forces (no new flags, no new outputs).
- **Building a richer visibility surface** (feed cards, etc.) — the flat log is the whole answer.

#### Dependencies / Prerequisites {#dependencies}

- None external. The removal is self-contained: verified that no justfile recipe, CI job,
  `.claude` hook, or skill *other than the prose being rewritten* calls `tugutil validate`,
  `tugutil list`, or drives `tugutil dash` (see [Q01]).

#### Constraints {#constraints}

- **Warnings are errors** (`tugrust/.cargo/config.toml` enforces `-D warnings`): every step
  must leave zero dead code, including orphaned enum variants and unused deps.
- **Green build at every commit boundary** — the step sequence is ordered to guarantee it.
- This repo commits directly to `main`; implement runs on a `tugdash/` worktree and joins.

#### Assumptions {#assumptions}

- `git`, `git worktree`, and `git config` are available in every environment that runs `dash`
  (already true — the current dash flow shells out to git throughout).
- Losing the joined/released "graveyard" and structured round metadata is acceptable for
  lightweight jobs; the durable record is the squash commit on `main` plus the log (see
  *Deliberately dropped*).

---

### Reference and Anchor Conventions {#reference-conventions}

This plan follows the [devise-skeleton](../tuglaws/devise-skeleton.md) anchor rules.
Anchors used here: `#step-N` for execution steps; `pNN-...` for plan-local decisions
(`[P01]`); `qNN-...` for open questions (`[Q01]`); `rNN-...` for risks. Plan-local
decisions use `[P##]`; no `[D##]` (global) decisions are cited.

---

### Open Questions {#open-questions}

#### [Q01] Does anything outside the skills depend on the removed commands? (DECIDED) {#q01-external-callers}

**Question:** Would deleting `tugutil validate` / `tugutil list` or changing `tugutil dash`
output break CI, justfile recipes, hooks, or other automation?

**Why it matters:** A silent external caller would turn a clean removal into a breakage.

**Resolution:** DECIDED — no. Grepped `Justfile`, `.github`, `.claude`, `tugplug`, and the
Rust tree: `validate` appears only in skill prose (rewritten in [#step-6]); `list` has zero
callers anywhere; no non-skill caller drives `dash`. Safe to remove.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Dead `TugError` variants fail `-D warnings` | med | high | Prune variants in the step that orphans them ([#step-1], [#step-2], [#step-3]) | build error |
| `parser`/`types` deleted while still referenced | med | low | Order: remove `validator` + `list` first, then `parser`/`types` ([#step-3]) | compile error |
| A dash mid-flight when `state.db` is removed loses its row | low | low | Removal targets a clean tree; existing `tugdash/` branches keep working (git-derived) | user has a live dash |

**Risk R01: Git-derived dash status loses the joined/released distinction** {#r01-terminal-status}

- **Risk:** Once a dash branch is deleted, git cannot say whether it was joined or released.
- **Mitigation:** The dash-log line (under `project_state_dir()`) records the terminal action;
  joins also leave a `tugdash(<name>):` squash commit on `main`.
- **Residual risk:** No queryable history of long-since-deleted dashes — accepted per [P04].

---

### Design Decisions {#design-decisions}

#### [P01] Retain the devise-skeleton structure in full; remove only its mechanization (DECIDED) {#p01-keep-skeleton}

**Decision:** The plan format — Phase Overview, named anchors, `[P01]` decisions,
`**References:**`/`**Depends on:**` lines, the Step Status Ledger, the step/checkpoint shape —
is kept exactly. What is removed is the tooling that enforced or consumed it: the validator,
the parser/AST, and the `tugutil validate` gate.

**Rationale:**
- The structure is the bare-bones infrastructure that keeps work on track; it has earned its place.
- The skeleton was always a contract for the author and the main loop to *follow and read* —
  it does not need a compiler.

**Implications:**
- `devise` still authors against the skeleton; `implement` still walks it via the ledger.
- `devise-skeleton.md` loses only its two `tugutil validate` references ([#step-6]).
- Conformance to the skeleton is upheld by authorship and review, not a CLI gate.

#### [P02] Git is the source of truth for dash lifecycle (DECIDED) {#p02-git-source-of-truth}

**Decision:** A dash's existence and status derive from the presence of its `tugdash/<name>`
branch and `.tugtree/tugdash__<name>` worktree — not a database row.

**Rationale:**
- ~90% of the `dashes`/`dash_rounds` columns duplicate git; a dash *is* a branch + worktree.
- Eliminates a SQLite dependency and ~400 lines of CRUD for state git already holds.

**Implications:**
- `list` ⇒ `git worktree list` + `git branch --list 'tugdash/*'`; round count ⇒
  `git rev-list --count <base>..tugdash/<name>`.
- `show` ⇒ `git log <base>..tugdash/<name>` + `git status` of the worktree.

#### [P03] Base branch lives in git config (DECIDED) {#p03-base-in-git-config}

**Decision:** `create` stores the base in `git config branch.tugdash/<name>.tugbase` (and the
description in `branch.tugdash/<name>.description`); `join` reads it back, falling back to
`detect_default_branch` if absent.

**Rationale:**
- `join` is the one operation that genuinely needs remembered state (where to merge); git
  config is the natural, git-local home for per-branch metadata.

**Implications:**
- No external store needed for the only non-derivable dash datum.

#### [P04] Visibility is a flat append-only markdown log (DECIDED) {#p04-flat-log}

**Decision:** `dash commit` appends one line to `project_state_dir()/dash-log.md` ([P08], out of
the repo): `<iso8601>  <dash>  <commit-hash>  <instruction>`. `release` appends a `released` line.
Per-developer runtime state, never committed. This replaces both `dash_rounds` and the
never-built implementation-log.

**Rationale:**
- Human-readable, greppable, `tail -f`-able, diffable, no schema — the original
  long-running-`/implement` visibility need, met with a fraction of the complexity.

**Implications:**
- The verbatim `instruction` (git's one gap) is preserved in the log, sourced from the
  existing stdin `DashRoundMeta` JSON.

#### [P05] The plan's Step Status Ledger remains the "where are we?" source (DECIDED) {#p05-ledger-is-truth}

**Decision:** `implement` resumes and scopes from the plan's own **Step Status Ledger**
(read directly from the markdown), never from an external state store.

**Rationale:**
- The ledger already lives in the plan and is the natural, in-place record; no DB needed.

**Implications:**
- The no-ledger fallback reads `git log` on the dash branch instead of `tugutil dash show`.

#### [P06] `tugutil list` is scaffolding on the skeleton — remove it (DECIDED) {#p06-drop-list}

**Decision:** Delete `tugutil list`; it parses plans solely to count checkboxes and has zero
callers ([Q01]). If a need resurfaces, it returns as a trivial line scan (`- [ ]` vs `- [x]`),
no AST.

**Rationale:**
- It is the last non-validation consumer of `parser`/`types`; removing it lets those go too.

**Implications:**
- Removed alongside `parser.rs`/`types.rs` in [#step-3].

#### [P07] `dash create` hydrates the worktree via a config-declared post-create hook (DECIDED) {#p07-worktree-hydration}

**Decision:** After `git worktree add`, `dash create` runs the commands declared in
`[tugtool.dash].post_create` (from `.tugtool/config.toml`), with the new worktree as cwd —
e.g. `bun install --cwd tugdeck`. The hook runs **only on actual creation**, not on the idempotent
resume path. A non-zero exit **rolls back the just-added worktree and branch, then fails** `create`
with the command's output — otherwise the worktree would survive un-hydrated and the next
(idempotent) `create` would skip the hook, stranding it.

**Rationale:**
- A git worktree never inherits gitignored files, so `tugdeck/node_modules` is *always* absent
  in a fresh `tugdash/` worktree — a structural certainty, not a per-dash discovery. The skills
  currently rediscover it as prose and get diverted into an ad-hoc `bun install` before reaching
  the task.
- Keeping the command in config keeps `tugutil` generic — it runs what the project *declares*,
  never a hardcoded `bun`/`tugdeck` path in the Rust binary.
- This is also what gives `.tugtool/config.toml` a durable purpose once the validation fields
  (`validation_level`, `show_info`) are removed — see [#step-4].

**Implications:**
- `config.rs` gains a `[tugtool.dash].post_create: Vec<String>` field; `init`'s `DEFAULT_CONFIG`
  seeds it with `bun install --cwd tugdeck`.
- The skills no longer install deps or check for `node_modules` — the worktree arrives hydrated
  ([#step-6] removes that prose).
- Hydration is the *tool's* job; establishing a green test **baseline** stays the *skill's* job
  (contextual: which suites, Rust vs JS).
- **Rejected:** symlinking the base checkout's `node_modules` into the worktree — fragile with
  native bindings and bun's layout; `bun install` from bun's global cache is fast enough.

---

### Specification {#specification}

#### Internal Architecture — dash on git {#dash-on-git}

Post-rewrite command behavior (all shell out to `git`, as the current flow already does):

- **`create <name>`** — `git worktree add .tugtree/tugdash__<name> -b tugdash/<name> <base>`;
  `git config branch.tugdash/<name>.tugbase <base>` and `…​.description <desc>` per [P03].
  Idempotent: existing worktree/branch returns as-is. Keeps `validate_dash_name` +
  `detect_default_branch`. No DB.
- **`commit <name>`** — `git add -A` + `git commit` in the worktree (unchanged), then append a
  log line per [P04]. `DashRoundMeta` JSON on stdin still supplies `instruction`/`summary`.
- **`join <name>`** — unchanged squash-merge flow (preflight clean base, verify current branch
  == base, squash `tugdash/<name>`, `tugdash(<name>):` commit, remove worktree + branch). Base
  from `branch.*.tugbase` ([P03]). Drops the DB status flip.
- **`release <name>`** — remove worktree + delete branch; append a `released` line.
- **`list`** / **`show`** — git-derived per [P02].

#### Worktree hydration (contract) {#worktree-hydration-spec}

`[tugtool.dash].post_create` is an ordered list of shell commands. On a real `create` (a freshly
added worktree), `dash create` runs each from the worktree root, in order; the first non-zero exit
**removes the just-added worktree and branch**, then aborts `create` surfacing the failing
command's stderr — so a retry re-creates and re-hydrates cleanly, and the idempotent skip never
strands a half-hydrated worktree. On the idempotent path (worktree already existed) the hook is
skipped. Default seeded by `init`:

```toml
[tugtool.dash]
post_create = ["bun install --cwd tugdeck"]
```

#### Log format (contract) {#log-format}

`project_state_dir()/dash-log.md` ([P08]), append-only, one record per line:

```
2026-06-01T14:22:09Z  retire-statedb  9f3c1a2  Step 1: dash on git
```

Released dashes: `… <dash>  released  <reason-or-blank>`. No header, no schema, no parsing —
consumers `grep`/`tail`.

#### Error and Warning Model {#error-model}

`TugError` loses every now-dead variant (e.g. `StateDbOpen`, `StateDbQuery`, and
validation-only variants). Because `-D warnings` rejects unused variants, each is removed in
the step that orphans it.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Files to delete {#delete-files}

| File | Lines | Reason |
|------|------:|--------|
| `tugrust/crates/tugutil-core/src/validator.rs` | 1967 | plan-rule validation |
| `tugrust/crates/tugutil-core/src/parser.rs` | 1698 | markdown → AST |
| `tugrust/crates/tugutil-core/src/types.rs` | 328 | AST types (`TugPlan`, …) |
| `tugrust/crates/tugutil-core/src/state.rs` | 71 | `StateDb` open + schema |
| `tugrust/crates/tugutil/src/commands/validate.rs` | 428 | `validate` command |
| `tugrust/crates/tugutil/src/commands/list.rs` | 174 | `list` command ([P06]) |

#### New files {#new-files}

| Path | Purpose |
|------|---------|
| `project_state_dir()/dash-log.md` | runtime append-only visibility log ([P04], [P08]); out of the repo, not a source file |

#### Symbols to modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `project_state_dir` | fn | `tugutil-core/src/` (new) | `dirs::data_dir()/Tug/projects/<slug>/` ([P08]); `$HOME/.local/share` fallback; from the **main** repo root |
| `state-dir` subcommand | cli | `tugutil` (cli.rs/main.rs/commands) | prints `project_state_dir(find_repo_root())` for the `Justfile` + host ([P08]) |
| `run_dash_{create,commit,join,release,list,show}` | fn | `tugutil/src/commands/dash.rs` | rewrite on git; drop `StateDb`; dash-log → `project_state_dir()`; drop vestigial `--all`/`--all-rounds` |
| `DashRoundMeta` | struct | `tugutil-core/src/dash.rs` | trim to `instruction`/`summary` (the log's fields); drop unused `files_*` |
| `impl crate::state::StateDb` | impl block | `tugutil-core/src/dash.rs` | delete (~335 lines) |
| Claude-session launch (`additionalDirectories`) | host path | `tugcode`/`tugcast` (site TBD by [#step-5] spike) | register `dirs::data_dir()/Tug` (parent, one entry) as an allowed read root — `--add-dir` or settings ([P10]) |
| code-sign sentinel path | const/recipe | `Justfile` | resolve via `tugutil state-dir` (not a hardcoded path) ([P08]) |
| `lib.rs` module decls + re-exports | mod/use | `tugutil-core/src/lib.rs` | drop `parser`/`validator`/`types`/`state` + their exports + smoke tests |
| `Commands::{Validate,List}` | enum variants | `tugutil/src/cli.rs` | remove |
| `Commands::{Validate,List}` dispatch | match arms | `tugutil/src/main.rs` | remove |
| `commands` exports | mod/use | `tugutil/src/commands/mod.rs` | drop `validate`, `list`, `run_validate`, `run_list` |
| `DashConfig`/`post_create` | struct/field | `tugutil-core/src/config.rs` | add `[tugtool.dash].post_create: Vec<String>` ([P07]); remove dead `validation_level`/`show_info` |
| `run_init` / `DEFAULT_CONFIG` | fn/const | `tugutil/src/commands/init.rs` | stop creating `tugplan-implementation-log.md`; seed `post_create` default; drop validation fields |
| `TugError` | enum | `tugutil-core/src/error.rs` | prune dead variants |
| `[dependencies]` | manifest | `tugutil-core/Cargo.toml` | drop `rusqlite`, `sha2` |

---

### Documentation Plan {#documentation-plan}

- [x] `tuglaws/devise-skeleton.md` — stripped the two `tugutil validate` references, bumped to `v4`;
      every structural section kept ([#step-6], [P01]).
- [x] `tugplug/CLAUDE.md` + `devise`/`implement`/`dash`/`audit` SKILL.md — removed the validate gate
      and round-ledger framing ([#step-6]).
- [x] `tuglaws/design-decisions.md` + `dash/` sweep — no live plan-validation refs to reword;
      archived plans left as history ([#step-6]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **Integration (CLI)** | Drive `tugutil dash` end-to-end against a temp git repo, asserting git state (branch/worktree/log) | [#step-1] |
| **Drift / grep gates** | Assert removed symbols have zero live references | [#step-7] |

#### What stays out of tests {#test-non-goals}

- No tests for the deleted parser/validator (the code is gone).
- No mock-store or call-count tests for dash — assert real git state, per project test policy.

---

### Execution Steps {#execution-steps}

> Commit after each step's checkpoint passes. Each step leaves a green `-D warnings` build.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Dash on git + `project_state_dir()`/`state-dir` + hydration + log; delete `state.db`/`StateDb` | done | `964bc9a1` |
| #step-2 | Delete `validator.rs` + the `validate` command | done | `8a516fa7` |
| #step-3 | Delete `tugutil list`, then `parser.rs` + `types.rs` | done | `865c5aff` |
| #step-4 | tugutil cleanup: deps, config fields, `init` fossil, orphans | done | `ef04e84c` |
| #step-5 | Relocate runtime state out of the repo + register Claude reads | done | `8938a7b3` |
| #step-6 | De-ceremony skills + skeleton/docs | done | `48cb79ab` |
| #step-7 | Integration checkpoint | done | (verify) |

#### Step 1: Dash on git + `project_state_dir()` + hydration + log; delete `state.db`/`StateDb` {#step-1}

**Commit:** `refactor(tugutil): drive dash on git primitives, retire state.db`

**References:** [P02] git-source-of-truth, [P03] base-in-git-config, [P04] flat-log,
[P07] worktree-hydration, [P08] project-state-dir,
(#dash-on-git, #worktree-hydration-spec, #log-format, #runtime-relocation)

**Artifacts:**
- New `project_state_dir(repo_root)` in `tugutil-core` ([P08]) + a `tugutil state-dir` subcommand
  that prints it; the dash-log append path points there.
- Rewritten `run_dash_*` in `commands/dash.rs`.
- `[tugtool.dash].post_create` field in `config.rs` + a seeded default in `init`'s `DEFAULT_CONFIG`.
- Deleted `tugutil-core/src/state.rs` and the `impl StateDb` block in `dash.rs`.

**Tasks:**
- [x] Add `project_state_dir(repo_root) -> PathBuf` to `tugutil-core` ([P08]): `dirs::data_dir()`
      (fallback `$HOME/.local/share` if `None`) `/Tug/projects/<slug>`; slug = the **main** repo
      root path flattened `/` → `-` (`find_repo_root` resolves a worktree's `.git` to the main root).
      *(New `paths.rs`; honors a `TUG_DATA_DIR` override for hermetic tests/host control.)*
- [x] Add a `tugutil state-dir` subcommand printing `project_state_dir(find_repo_root())`, for the
      shell/host consumers in [#step-5] ([P08]). *(Creates the dir so consumers can write into it.)*
- [x] Rewrite `run_dash_create` on `git worktree add` + `git config` ([P03]); drop `StateDb`.
- [x] On real creation only, run `[tugtool.dash].post_create` from the worktree root; **on a
      non-zero exit, remove the just-added worktree and branch, then fail** so a retry re-creates
      clean ([P07], #worktree-hydration-spec). Add the field to `config.rs` and seed `DEFAULT_CONFIG`.
- [x] Rewrite `run_dash_commit` to append a log line ([P04]) instead of `record_round`; **trim
      `DashRoundMeta`** to the fields the log uses (`instruction`, `summary`) — drop the now-unused
      `files_created`/`files_modified` rather than accept and discard them.
- [x] Rewrite `run_dash_join` / `run_dash_release` to read base from git config; drop status flip.
- [x] Rewrite `run_dash_list` / `run_dash_show` to read git ([P02]); **drop the now-vestigial
      `list --all` / `show --all-rounds` flags** (no DB graveyard left to show).
- [x] Delete `state.rs` + the `impl crate::state::StateDb` block; drop `state` from `lib.rs`;
      `DashStatus`/`DashInfo`/`DashRound` dropped entirely (commands use plain strings/git output).
- [x] Prune `TugError::StateDb*` variants; delete the on-disk `.tugtool/state.db*`.

**Tests:**
- [x] Dash command tests rewritten to assert git state + dash-log lines (in `commands/dash.rs`'s
      inline suite — the actual home of the dash tests; `tugutil-core/tests/integration_tests.rs`
      holds only parser/validator cases).
- [x] `post_create` runs once on creation, **not** on idempotent resume; and on a **failing** hook,
      leaves **no** worktree/branch behind (rollback) so a re-run succeeds.
- [x] Explicit `join` (squash-merge to base, base read from git config, worktree+branch removed) and
      `release` (worktree+branch removed, `released` log line) cases.

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run -p tugutil -p tugutil-core` (205 passed)
- [x] Manual: `create → commit → show → join` on a throwaway dash confirmed the `tugdash(...)`
      commit on base, the dash-log lines under `tugutil state-dir`; a real `dash create` on this
      repo hydrated `tugdeck/node_modules` (208 entries) via `bun install`.

---

#### Step 2: Delete `validator.rs` + the `validate` command {#step-2}

**Commit:** `refactor(tugutil): remove plan validator and validate command`

**References:** [P01] keep-skeleton, (#symbol-inventory)

**Artifacts:**
- Deleted `tugutil-core/src/validator.rs` and `tugutil/src/commands/validate.rs`.

**Tasks:**
- [x] Delete `validator.rs`; remove `pub mod validator` + validator re-exports from `lib.rs`.
- [x] Delete `commands/validate.rs`; remove `Validate` from `cli.rs`, its `main.rs` dispatch arm,
      and the `run_validate` export from `commands/mod.rs`. *(Also decoupled `output.rs` from
      `ValidationIssue`/`ParseDiagnostic` — removed `JsonDiagnostic`, `ValidateData`,
      `ValidatedFile`, the `From` impls, and the now-dead `ok_with_issues`.)*
- [x] Prune validation-only `TugError` variants — **done in [#step-4]'s error sweep.** They are
      `pub` variants of a library enum, so they do *not* trip `-D warnings`; one comprehensive purge
      after parser/types were also gone was cleaner than editing the exhaustive match arms each step.

**Tests:**
- [x] Removed validate cases from `tugutil/tests/cli_integration_tests.rs`; deleted the all-fixtures
      `tugutil-core/tests/integration_tests.rs` (parser+validator).

**Checkpoint:**
- [x] `cargo build` (whole workspace) + `cargo nextest run -p tugutil -p tugutil-core` clean under
      `-D warnings` (149 passed).

---

#### Step 3: Delete `tugutil list`, then `parser.rs` + `types.rs` {#step-3}

**Depends on:** #step-2

**Commit:** `refactor(tugutil): remove list command and plan parser/AST`

**References:** [P06] drop-list, [P01] keep-skeleton, (#delete-files)

**Artifacts:**
- Deleted `commands/list.rs`, `parser.rs`, `types.rs`.

**Tasks:**
- [x] Delete `commands/list.rs`; remove `List` from `cli.rs`, its `main.rs` arm, the `run_list`
      export ([P06]). Removed list payloads (`ListData`/`PlanSummary`/`Progress`) from `output.rs`.
- [x] Now that `validator` (#step-2) and `list` are gone, deleted `parser.rs` + `types.rs`; removed
      `pub mod parser`/`types` + `parse_tugplan`/`TugPlan`/`ParseDiagnostic` re-exports from `lib.rs`.
      No surviving incidental use — no local type needed.

**Tests:**
- [x] Removed the `list` cases from `cli_integration_tests.rs` (and the now-orphaned `MINIMAL_PLAN`
      / `create_test_plan` helpers); parser cases went with the deleted core integration test in #step-2.

**Checkpoint:**
- [x] `cargo build` (workspace) + `cargo nextest run` clean under `-D warnings` (107 passed).

---

#### Step 4: tugutil cleanup — deps, config fields, `init` fossil, orphans {#step-4}

**Depends on:** #step-1, #step-3

**Commit:** `chore(tugutil): drop dead deps, validation config, init fossil, and orphans`

**References:** [P07] worktree-hydration, [P09] config-stays, (#error-model)

**Tasks:**
- [x] `tugutil-core/Cargo.toml` — dropped `rusqlite` + `sha2` (and the now-dead `regex` +
      `serde_json`); deleted the `dependency_smoke_tests` module in `lib.rs`.
- [x] `config.rs` + `DEFAULT_CONFIG` — removed the dead validation fields (`validation_level`,
      `show_info`) and the entire `NamingConfig` (zero runtime consumers — `find_tugplans`
      hardcodes the `tugplan-` prefix). `[tugtool.dash].post_create` ([P07]) is config.toml's
      whole content. Added a test that legacy configs (with the old keys) still parse.
- [x] Updated the committed `.tugtool/config.toml` itself: now just `[tugtool.dash].post_create`.
- [x] `commands/init.rs` — stopped creating `tugplan-implementation-log.md`; removed the committed
      fossil. `init` still creates `.tugtool/` + `config.toml` (needed by `resolve`).
- [x] Removed the orphaned, tracked `.tugtool/session-memory.md` (zero references confirmed).
- [x] **Error sweep (folded from [#step-2]):** reduced `TugError` to the 7 live variants and
      removed the dead `code()`/`line()`/`exit_code()` machinery (unused for `tugutil_core` — its
      consumer was the deleted `validate` command).

**Tests:**
- [x] Updated the `init` integration cases to assert the log fossil is **not** created.
- [x] `project_state_dir` slug/path covered by `paths.rs` unit tests (added in #step-1).

**Checkpoint:**
- [x] `cargo build` (workspace) + `cargo nextest run` clean under `-D warnings` (101 passed).

---

#### Step 5: Relocate runtime state out of the repo + register Claude reads {#step-5}

**Depends on:** #step-1, #step-4

**Commit:** `feat(tug): relocate runtime state to project_state_dir, register reads`

**References:** [P08] project-state-dir, [P09] config-stays, [P10] additional-directories,
(#runtime-relocation, #p10-additional-directories)

**Investigate first (spike):**
- [x] **Resolved:** tugcode builds the claude argv in `buildClaudeArgs()`
      (`tugcode/src/session.ts`), shared by all three spawn paths. The lever is `--add-dir` at spawn
      (not a settings write). Recorded in [P10].

**Tasks:**
- [x] Relocated the `code-sign-fingerprint` sentinel from `.tugtool/` to the path printed by
      `tugutil state-dir`; the `Justfile` (`build-app` write + `teardown-dev-signing` clear) resolves
      it via the subcommand (PATH `tugutil`, falling back to `tugrust/target/debug/tugutil`) — no
      hardcoded OS path, no slug re-derived in shell ([P08]). Moved the existing sentinel across.
- [x] Wired the registration: `buildClaudeArgs` appends `--add-dir <tugDataRoot()>` where
      `tugDataRoot()` = `<data_dir>/Tug` (parent — one entry) ([P10]).
- [x] `.gitignore` — dropped the `.tugtool/state.db*` and `.tugtool/code-sign-fingerprint` entries.
      Confirmed `.tugtool/` holds only `config.toml` (tracked) ([P09]).

**Tests:**
- [x] `Justfile` sentinel round-trips (write → read → clear) at the `tugutil state-dir` path.
- [x] `buildClaudeArgs` unit test asserts the `--add-dir <…/Tug>` registration artifact.

**Checkpoint:**
- [x] `cargo build` + `cargo nextest run` clean under `-D warnings` (Rust unchanged this step);
      tugcode `bunx tsc --noEmit` clean + `buildClaudeArgs` tests pass.
- [x] **Registration verified by inspecting the launch artifact** — `buildClaudeArgs` emits
      `--add-dir /…/Tug`. The live default-permission `Read`-without-prompt check needs a rebuilt
      tugcode (bun-compiled, no HMR) + a running Tug session — a host step for the user ([P10]).

---

#### Step 6: De-ceremony the skills + skeleton/docs {#step-6}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `docs(tugplug): drop validate gate and round-ledger framing; keep skeleton`

**References:** [P01] keep-skeleton, [P05] ledger-is-truth, (#documentation-plan)

**Tasks:**
- [x] `skills/implement/SKILL.md` — deleted the `tugutil validate` setup gate + input clause;
      replaced `tugutil dash show`/round references with `git log` + the Step Status Ledger ([P05]);
      removed the Setup step's `bun install` check (the worktree arrives hydrated, [P07]). Kept the
      baseline green check.
- [x] `skills/devise/SKILL.md` — replaced the closing `tugutil validate` step with a skeleton
      self-check; removed the "implement gates on the same check" language.
- [x] `skills/dash/SKILL.md` — dropped the "records a round"/`dash show` framing (a round is a
      commit; trimmed the commit-meta heredoc to instruction/summary) and the `bun install` framing.
- [x] `skills/audit/SKILL.md` — replaced the `dash show`-lists-rounds note with `git log <base>..`.
- [x] `tugplug/CLAUDE.md` — removed the `tugutil validate` mention; kept `create → commit → join`.
- [x] `tuglaws/devise-skeleton.md` — removed both validate references; bumped to `v4`. Every
      section kept ([P01]).
- [x] `tuglaws/design-decisions.md` + `dash/` sweep — no live plan-validation refs found
      (design-decisions L07 is code action-validation); validate refs remain only in
      `dash/archive/`, left untouched.

**Checkpoint:**
- [x] `rg 'tugutil validate|tug validate' tugplug tuglaws` → none; only `dash/archive/` hits.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Tasks:**
- [x] Verified the prior code steps work together: a clean dash lifecycle with no `state.db`.

**Tests:**
- [x] `cargo build` + `cargo nextest run` clean under `-D warnings` across the whole workspace
      (992 passed, 4 skipped — the real-claude network tests).

**Checkpoint:**
- [x] `rg 'StateDb|parse_tugplan|validate_tugplan|state\.db'` → zero live hits (archive excepted).
- [x] End-to-end `dash` cycle confirmed the log (under `tugutil state-dir`) + the `tugdash(...)`
      base commit + worktree removal; the repo's `.tugtool/` holds only `config.toml`. The
      registration artifact (`--add-dir <…/Tug>`) is verified; the live default-permission
      `Read`-without-prompt needs a rebuilt tugcode + Tug session (a host step, per [P10]).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A tugutil with no plan parser/validator and no dash state database — dash runs
on git + a flat log, and the skills act on skeleton-structured plans directly.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `state.db`, `StateDb`, `validator.rs`, `parser.rs`, `types.rs`, `validate`/`list` commands
      all gone; `rusqlite`/`sha2` (and `regex`/`serde_json`) dropped from `tugutil-core`. (grep + file check)
- [x] `cargo build` + `cargo nextest run` green under `-D warnings` (992 passed). (local)
- [x] `devise-skeleton.md` structurally intact, validation references removed, at `v4`. (diff)
- [x] A real `dash` cycle works with no `state.db`. (manual)
- [x] Per-user runtime state lives under `…/Tug/projects/<slug>/`; the repo's `.tugtool/` holds only
      `config.toml`; the Claude read-root registration (`--add-dir <…/Tug>`) is in place. (artifact;
      live no-prompt check is a host step per [P10])

| Checkpoint | Verification |
|------------|--------------|
| No live references to removed symbols | `rg` sweep ([#step-7]) |
| Green workspace | `cargo nextest run` ([#step-7]) |
| Skeleton preserved | diff of `devise-skeleton.md` shows only validation-ref removals |

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `.tugtool/config.toml` now earns its keep via `[tugtool.dash].post_create` ([P07]); it stays
      the lone committed file in `.tugtool/` ([P09]). Revisit only if a project ever needs a
      *different* hydration command (per-project override).
- [ ] Decide if `resolve` should absorb the "find the plan" convenience the skills currently
      hand-roll, now that `list` is gone.

---

### Runtime State Relocation {#runtime-relocation}

> **Required for phase close.** Per-user runtime state leaves the repo. The decisions below are
> implemented by [#step-1] (`project_state_dir()` + the dash-log) and [#step-5] (the sentinel
> relocation, the `additionalDirectories` registration, and confirming `.tugtool/` = config only).

#### Context {#followon-context}

After this phase, the repo's `.tugtool/` holds exactly one committed file — `config.toml` (the
[P07] hook). That stays: shared, versioned config belongs in the repo. Everything else `tugutil`
writes is **per-user runtime state that should not sit in the source tree** — the [P04] dash-log
and the `code-sign-fingerprint` Justfile sentinel today, and a coming feature: Tug-extended
slash-commands that run "side commands" whose text/JSON output Claude Code reads back. That output
needs a home that is (a) out of the repo, (b) portable, and (c) read by Claude Code without a
permission prompt.

#### [P08] Per-user runtime state lives in an OS-conventional app-data dir, behind a function (DECIDED) {#p08-project-state-dir}

**Decision:** Add `tugutil_core::project_state_dir(repo_root) -> PathBuf`, returning
`dirs::data_dir()/Tug/projects/<project-slug>/`. All per-user runtime state goes there, **broken
down per project** — one subdirectory per checkout, never a shared flat dir.

**Project slug:** mirror Claude Code's own `.claude/projects/` convention exactly — the project's
absolute path (git root) flattened by replacing each `/` with `-`. For this repo,
`/Users/kocienda/Mounts/u/src/tugtool` → `-Users-kocienda-Mounts-u-src-tugtool`, giving
`…/Tug/projects/-Users-kocienda-Mounts-u-src-tugtool/`.

**Rationale:**
- Matches the house convention — `tugbank` already stores at `~/Library/Application Support/Tug/…`
  via the same `dirs` crate (already a workspace dep).
- Portable, **not** Mac-locked: `dirs::data_dir()` resolves to `~/Library/Application Support` on
  macOS, `~/.local/share` (XDG) on Linux, `%APPDATA%` on Windows.
- Keeps `tugutil` a standalone CLI — no coupling to Claude Code's private directory.
- Reusing Claude's path-flattening scheme means a human browsing `~/.claude/projects/` and
  `…/Tug/projects/` sees **matching, recognizable folder names** for the same checkout.

**Implications:**
- The function is the single source of the path (the indirection the design calls for); it derives
  the slug from `repo_root`, so it is stable across runs for the same checkout path.
- `repo_root` is the **main** repo root — `find_repo_root` resolves a worktree's `.git` *file* to
  it — so every `tugdash/` worktree of a project shares **one** state dir, not one per worktree.
- `dirs::data_dir()` returns `Option`; if `None` (rare), fall back to `$HOME/.local/share`
  (mirroring `tugcore::instance_data_dir_for`) so the function always yields a real `PathBuf`.
- A thin `tugutil state-dir` subcommand prints `project_state_dir(find_repo_root())`, so shell
  consumers (the `Justfile`) and the host resolve the path without re-deriving the slug.
- **Rejected:** `~/.claude/projects/<…>` as the *parent* — Claude-locked and a layering inversion
  (a general CLI writing into Claude Code's data dir; breaks when `tugutil` runs outside Claude).
  We borrow Claude's *naming scheme*, not its *directory*.

#### [P09] The committed hook config stays in the repo (DECIDED) {#p09-config-stays}

**Decision:** `.tugtool/config.toml` ([P07]) remains the one committed file in the repo's
`.tugtool/`; it is **not** relocated.

**Rationale:**
- The hydration command is a property of the repo — every clone, worktree, and fresh machine must
  read the same value. Per-user app-data would de-version it and silently break fresh checkouts.

**Implications:**
- The repo keeps a one-file `.tugtool/`; "out of the repo" applies to runtime state only.

#### [P10] Claude reads the location via registered permission, not by luck (DECIDED) {#p10-additional-directories}

**Decision:** Tug — the host that both writes side-command output and manages Claude Code's
settings — registers `project_state_dir()` (or its `Tug/` root) in Claude Code's
`additionalDirectories` (equivalently, a `Read(<dir>/**)` allow-rule or a Read-aware hook), so
reads of relocated state and side-command outputs need no prompt.

**Rationale:**
- Out-of-tree reads prompt by default. Verified: `settings.local.json` carries codified
  `Read(//tmp/**)`, `Read(//Users/kocienda/cyber/**)`, and Xcode `DerivedData/**` rules — which are
  only written after a read prompt is approved. The `auto-approve-tug.sh` hook covers the **Skill**
  tool and a few **Bash** prefixes only, **not Read**.
- Because registration makes any path frictionless, read-friction does **not** drive the location
  choice — [P08] is decided on portability/layering, and a stable well-known path (vs. a per-project
  path scattered under `.claude`) is registered with a single entry.

**Implications:**
- Registration is a Tug (host) responsibility, wired once; document it for the side-command feature.
- **Lever resolved by the [#step-5] spike:** tugcode builds the claude argv in
  `buildClaudeArgs()` (`tugcode/src/session.ts`), shared by all three interactive spawn paths
  (`spawnClaude`, `handleSessionFork`, `handleSessionContinue`). Registration is `--add-dir
  <tugDataRoot()>` appended there — **not** an `additionalDirectories` settings write (that file is
  the user-managed Workspace shape per the parity roadmap; injecting Tug's data dir there would be
  surprising). `tugDataRoot()` returns `<data_dir>/Tug` (the parent — one entry covers every
  per-project subdir), honoring `TUG_DATA_DIR` to match `tugutil_core::project_state_dir`.
- **Verified by inspecting the launch artifact** (the `--add-dir` argv via the `buildClaudeArgs`
  unit test), not by observing "no prompt". The live default-permission Read check needs a *rebuilt*
  tugcode (bun-compiled, no HMR) + a running Tug session — a host step for the user to confirm.

#### What moves, what stays {#followon-moves}

| Artifact | Before this plan | End state (this plan) |
|----------|------------------|------------------------|
| dash-log ([P04]) | — (new; replaces `dash_rounds`) | `…/Tug/projects/<slug>/dash-log.md` (born here, never in `.tugtool/`) |
| code-sign sentinel | `.tugtool/code-sign-fingerprint` | `…/Tug/projects/<slug>/code-sign-fingerprint` (Justfile updated) |
| side-command outputs (future) | — | `…/Tug/projects/<slug>/…` |
| hook config ([P07]/[P09]) | `.tugtool/config.toml` (validation settings) | `.tugtool/config.toml` (the `post_create` hook) — committed |

#### Implemented by these steps {#followon-steps}

- `project_state_dir(repo_root)` + the dash-log writing there → **[#step-1]**.
- `code-sign-fingerprint` sentinel relocation (+ `Justfile`), the `additionalDirectories`
  registration ([P10]), `.gitignore` cleanup, and confirming `.tugtool/` = `config.toml` only
  → **[#step-5]**.

#### Resolved {#followon-open}

- **Slug scheme for `<project>`** — DECIDED ([P08]): mirror Claude Code's `.claude/projects/`
  path-flattening (absolute git-root path, `/` → `-`), so the same checkout has matching folder
  names under both `~/.claude/projects/` and `…/Tug/projects/`. (The side-command feature itself is
  out of scope here; this section only guarantees it a portable, frictionless, per-project home.)
