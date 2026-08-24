<!-- devise-skeleton v5 -->

## Dash Docs Home {#dash-docs-home}

**Purpose:** The dash paperwork directory (briefs + plans) stops being a culturally-blessed name and becomes a per-project declaration: a `docs` key under `[tugtool.dash]` in `.tugtool/config.toml`, read through a new `tugutil dash docs-dir` verb with a set-once write path, consumed by plan search in place of the hardcoded `roadmap` entry in `PLAN_SEARCH_DIRS`, and spoken by the tugplug skills through an ask-once contract. Tugtool becomes the first consumer: `docs = "dash"`, `roadmap/` migrates to `dash/` with every cross-reference updated, and the one human-facing surface that names `tugutil` gets human copy.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-23 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-23, fable.** Reviewed `plan:840550adbbfbda42`. Lint: 1 error (fixed: PL015, ledger rows now title-and-anchor keyed in the house form), 0 warnings.
Oriented on: the whole document (first review), against the code read this session — `tugutil-core/src/config.rs` (`DashConfig`, `PLAN_SEARCH_DIRS`, `find_tugplans`, `Config::load_from_project`), `tugutil-core/src/resolve.rs` (stages 2–5), `tugutil-core/src/lib.rs` (the `resolve_plan` export), `tugutil/src/plan.rs` (the explicit-path doctrine), `tugutil/src/cli.rs` (`DashCommands`), `tugutil/src/dash.rs` (`run_config`, `ConfigPayload`), `tugutil/src/commands/init.rs` (`DEFAULT_CONFIG`), `Cargo.lock` (toml_edit 0.22.27 present), [D151] in full, the three SKILL.md files, `tugplug/CLAUDE.md`, `dashes-section.tsx`, `shell-interactive-staging.ts`, and the app-test greps behind the empty-state assumption.
Applied: technical grounding — the seam decision was cited as [D157] four times; the real number is [D151] (verified against `design-decisions.md` and the `cda0deb72` commit message), corrected throughout. Coherence — Step 6's live pass claimed `tugutil plan lint` resolves a plan by slug; the plan verbs take explicit paths by design (`plan.rs`'s own doctrine comment), so the task now lints a migrated plan at its explicit new path and leaves derived-search proof to Step 2's Rust tests. Holes — the plan-search deep dive now records that `resolve_plan`/`find_tugplans` have no live caller in the workspace, which is what makes deleting the `roadmap` entry safe now and names the dash-cockpit phase as the first real consumer. Tuglaws cross-check: the only tugdeck change is copy-only (Step 5), introducing no state — no State Zone Mapping applies and no [L01]–[L06] exposure exists; [L29] is untouched (the `docs` value is project config, not a session path crossing the canonicalization gateway); the shell-edit discipline is honored by Step 4's edit-with-tools instruction; the seam extension is judged against [D151] and stays inside its doctrine (optional, absent-by-default, one reader, stated degradation).
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dash workflow's paperwork — briefs and plans — has always lived in `roadmap/` in this repository, a name picked off the cuff months ago that hardened into apparent infrastructure. The skills already disclaim it (`tugplug/skills/plan-devise/SKILL.md`: "never assume `roadmap/`, `.tugtool/`, or any other home"), but the disclaimer is only half true:

1. **One real blessing survives in the machinery.** `PLAN_SEARCH_DIRS: &[&str] = &[".tugtool", "roadmap"]` in `tugrust/crates/tugutil-core/src/config.rs` hardcodes `roadmap` as a plan search directory. It is consumed by `find_tugplans` (same file) and by the staged plan resolver in `tugrust/crates/tugutil-core/src/resolve.rs` (stages 2 and 3 probe each search dir for `tugplan-*.md` filenames and slugs). A foreign project whose plans live in `docs/plans/` gets no resolution help; Tugtool's own convention gets special treatment. That is exactly the kind of baked-in dialect [D151]'s declaration seam exists to retire.

2. **The skills ask every time.** `plan-devise` asks the user for an output path on every invocation that does not name one. The answer never changes within a project, so the question is a toll, not a decision. There is no place the answer can be recorded.

3. **A human surface names the internal tool.** The Lens Dashes section's empty state (`tugdeck/src/components/lens/sections/dashes-section.tsx`, the `No dashes. <code>tugutil dash create</code> starts one.` copy) tells a human to type a `tugutil` command. `tugutil` is machinery for the engine and the models — no human is ever expected to type it. This is the known instance; the sweep in this plan audits for others.

The declaration seam this plan extends already exists and is one day old: [D151] (the dash-generality phase, landed `a18557090`) put `post_create`, `verify`, and `build` under `[tugtool.dash]` in `.tugtool/config.toml`, parsed by `DashConfig` in `tugrust/crates/tugutil-core/src/config.rs`, reported uniformly by `tugutil dash config` (`run_config` in `tugrust/crates/tugutil/src/dash.rs`), with commented examples written by `tugutil init` (`DEFAULT_CONFIG` in `tugrust/crates/tugutil/src/commands/init.rs`). `docs` is the fourth key in that table, and it rides every part of the pattern: optional, absent-by-default, project-committed, one reader, stated degradation when undeclared.

The repository migration is the proof-by-consumption: this repo declares `docs = "dash"`, `roadmap/` (13 live documents, an `assets/` directory, and a 467-file `archive/`) moves to `dash/`, and roughly 100 cross-references across `tuglaws/`, `CLAUDE.md`, `Justfile`, `scripts/`, and source comments in `tugdeck/` and `tugrust/` are updated in the same pass.

**A self-referential constraint discovered during investigation:** this plan's own file is dash paperwork living in `roadmap/`, and the dash step machinery writes the Step Status Ledger *into the plan document at the path recorded at adoption* (`tugutil dash step … done` edits the ledger row in the plan file; see the `Step` verb in `tugrust/crates/tugutil/src/cli.rs` and the step ops in `tugrust/crates/tugdash-core/src/ops.rs`). Moving the plan mid-run would strand the ledger writes. The migration step therefore moves everything *except* this plan file, and the plan file itself moves in a tail round after the final step closes — see [P05] and the Rollout section.

#### Strategy {#strategy}

- Extend the `[tugtool.dash]` seam rather than inventing a new home: `docs` beside `post_create`/`verify`/`build`, committed in the project's own config.
- Give the key one reader *and one writer*: `tugutil dash docs-dir` reports the declaration; `tugutil dash docs-dir --set <dir>` records it. The write path is what makes the skills' ask-once contract real — the answer lands in config, attributably, instead of evaporating with the session.
- Delete the last blessing: `PLAN_SEARCH_DIRS` stops naming `roadmap` and derives its secondary entry from the declaration. `.tugtool/` remains the primary (it marks the project root and holds engine-adjacent plans).
- The skills stop asking every time: resolve through the verb; declared → propose a filename in the declared directory; undeclared → ask once, `--set` the answer, proceed. An explicit path in the invocation always wins, unchanged.
- Migrate this repository as the worked example, with the live-plan exclusion stated rather than discovered.
- Sweep human-facing copy for `tugutil` mentions, with the exemption boundary stated as a decision ([P04]) rather than judged ad hoc.

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil dash docs-dir --json` in this repository reports `docs = "dash"` with the absolute path; in a repo with no declaration it reports undeclared and exits 0 (Rust tests, Step 1; observed live in Step 6).
- `tugutil dash docs-dir --set <dir>` writes the key into `.tugtool/config.toml` preserving existing content and comments, creates the directory if absent, and refuses absolute paths and paths escaping the project root (Rust tests, Step 1).
- `grep -n "roadmap" tugrust/crates/tugutil-core/src/config.rs` finds no search-dir entry — plan resolution by slug finds a plan in the declared directory and no longer probes `roadmap/` (Rust tests, Step 2).
- `tugutil dash config` reports `docs` alongside the other three declarations (Rust test, Step 1).
- The three skills (`plan-devise`, `plan-review`, `dash-implement`) and `tugplug/CLAUDE.md` describe the resolve-through-the-verb contract; `grep -rn "roadmap/" tugplug/skills/*/SKILL.md` finds no example path that presents `roadmap/` as a live location (prose assertion, Step 3).
- `git ls-files roadmap/` is empty except for this plan document until its tail-round move; `ls dash/` shows the migrated corpus; `grep -rn "roadmap/" tuglaws/ CLAUDE.md Justfile scripts/ tugdeck/src tugrust/crates --include="*.md" --include="*.rs" --include="*.ts" --include="*.tsx" --include="*.sh"` finds only the exemptions inventoried in [P06] (Step 4).
- The Lens Dashes empty state renders human copy with no `tugutil` mention; no other graphical surface names the tool (Step 5, verified by the [P04] sweep).
- Full checkpoint green: `cargo nextest run`, `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `just app-test-changed` (Step 6).

#### Scope {#scope}

1. `DashConfig` gains an optional `docs` declaration; `tugutil init`'s default config gains its commented example; `tugutil dash config` reports it.
2. A `tugutil dash docs-dir` verb: reporter and `--set` writer.
3. Plan search (`PLAN_SEARCH_DIRS`, `find_tugplans`, the staged resolver) derives from the declaration; the hardcoded `roadmap` entry is deleted.
4. The three paperwork skills and `tugplug/CLAUDE.md` rewritten against the resolver with the ask-once contract.
5. This repository's migration: `docs = "dash"`, `roadmap/` → `dash/`, cross-reference sweep.
6. The human-copy sweep for `tugutil` mentions in graphical surfaces.

#### Non-goals {#non-goals}

- **No change to `.tug/` (worktrees, workshops).** The machine area stays exactly where and what it is — that decision is settled. Nothing in this plan touches `worktree_path`, `workshop` paths, or the ensure-ignored guard in `tugrust/crates/tugdash-core/`.
- **No new UI affordance.** The Dashes empty state gets interim human copy only; the real "Start a dash…" affordance is a later phase (the dash-cockpit plan).
- **No brief format work.** The brief skeleton is its own phase (the paperwork-formats plan).
- **No change to plan adoption or the dash verbs.** `dash create --plan` takes an explicit path and continues to; the declaration only feeds search, skills, and future surfaces.
- **No renaming of the `tugplan-` filename prefix or the reserved-files list.** Filename conventions are untouched; only the directory becomes a declaration.

#### Dependencies {#dependencies}

- [D151]'s declaration seam and `tugutil dash config` verb (landed `a18557090`) — `docs` extends them.
- The `toml` crate's editing companion `toml_edit` (already in `tugrust/Cargo.lock` as a transitive dependency) for the comment-preserving `--set` write.

#### Constraints {#constraints}

- **ONLY THE USER CAN COMMIT TO GIT** on `main`; rounds commit via `tugutil dash commit` on the dash worktree.
- **WARNINGS ARE ERRORS** (`-D warnings` via `tugrust/.cargo/config.toml`).
- Skills run from the app bundle, not the repo — repo edits to `tugplug/` are invisible to a live app until a rebuild ([R02]).
- No hard-wrapped prose in markdown documents.
- App-tests are selective (`just app-test-changed`), never a sweep.

#### Assumptions {#assumptions}

- `git mv` of the `roadmap/` tree (≈480 files including `archive/`) replays cleanly onto base at join: renames ride git's content tracking, and base churn touching `roadmap/` files mid-dash is unlikely over this plan's short life ([R01] covers the conflict case).
- No app-test pins the Dashes empty-state string — verified during investigation: `grep -rln "No dashes" tests/app-test/` matches only shell-receipt assertions in `at0408-dash-gesture.test.ts` (which asserts an exec'd command echo, not the empty-state copy).

---

### Open Questions {#open-questions}

None. The shape was settled in conversation (config key under `[tugtool.dash]`, `.tug/` untouched, `dash/` as this repo's name); the remaining choices had conventional defaults and are recorded as decisions below.

---

### Risks {#risks}

- **R01 — Rename-vs-edit conflicts at replay.** If base lands an edit to a `roadmap/` file while this dash is open, the replay of the `git mv` round meets a rename/edit conflict. Mitigation: keep the dash short-lived; the `Conflicted` arm of `tugutil dash replay` names the round, and the resolution is ordinary (take the edit at its new `dash/` path, commit as a round).
- **R02 — Skill prose changes are invisible until rebuild.** The bundle copies of `tugplug/skills/*/SKILL.md` are what a live app serves. The repo edit is the deliverable; verifying live behavior requires `just app-debug` (offered at the run's end) or waiting for the next release build. The checkpoint for Step 3 is therefore a prose assertion on the repo files, not a live-skill observation.
- **R03 — External references go stale.** Old chat transcripts, user memory, and any bookmarks name `roadmap/…` paths. Nothing in-repo can fix those; the migration accepts it. In-repo, the sweep in Step 4 is the mitigation, with its exemption inventory in [P06] so the residue is deliberate rather than missed.

---

### Design Decisions {#design-decisions}

- **[P01] `docs` is a declaration in the [D151] seam, with one reader and one writer.** The key is `docs` under `[tugtool.dash]`: a project-root-relative directory path where dash paperwork lives. `tugutil dash docs-dir` reports it (text and `--json`); `tugutil dash docs-dir --set <dir>` records it. Absent is not an error: the reporter exits 0 with `declared: false`, and every consumer states its degradation (search runs on `.tugtool/` alone; skills ask once). The setter exists because the ask-once contract needs a durable, attributable write path — a skill hand-editing TOML is a shell-edit-discipline violation waiting to happen, and a setter verb prints a receipt.
- **[P02] The `roadmap` blessing is deleted, not grandfathered.** `PLAN_SEARCH_DIRS` becomes a derivation: `.tugtool/` (primary, always) plus the declared docs directory (when declared). No compatibility entry for `roadmap` — this repository migrates in the same plan, and no other known project relies on the old entry. A search-dir list that quietly kept the old name would be the blessing under a rug.
- **[P03] The ask-once contract lives in the skills and writes through the setter.** When a skill needs the directory and the invocation gave no explicit path: run `tugutil dash docs-dir --json`; declared → propose `<docs>/<slug>.md` and proceed; undeclared → ask the user once (one question, proposing a name), then `tugutil dash docs-dir --set <answer>`, then proceed. An explicit path in the invocation always wins and never triggers the question or the write. The contract is stated once in `plan-devise` (the skill that authors into the directory) and referenced by `plan-review` and `dash-implement` (which only ever receive explicit paths, but must stop naming `roadmap/` in their example chips).
- **[P04] Human graphical surfaces never name `tugutil`; the shell's own voice is exempt.** The sweep boundary: copy rendered in graphical UI (Lens sections, cards, sheets, empty states, tooltips, dialogs) must not name the tool — it speaks in gestures and product nouns. Text that appears *in the shell transcript as the shell's refusal voice* (e.g. the interactive-staging refusal in `tugdeck/src/lib/shell-interactive-staging.ts`, which suggests `tugutil file stage --patch` after first offering the Changes shade) is exempt: its audience is whoever typed a shell command — predominantly the model, and any human there is terminal-literate by choice. Fixture data (`tugdeck/src/fixtures/fixture-transcript-copy.tsx`) mimics model output and is exempt. The known violation is the Dashes empty state; Step 5's audit applies this boundary to anything else it finds.
- **[P05] The live plan migrates last, in a tail round.** The dash machinery writes ledger rows into the plan document at the path recorded at adoption, so `roadmap/dash-docs-home.md` must stay put while any step verb can still run. Step 4's `git mv` excludes this one file; after the final step's `done` closes, the plan moves to `dash/dash-docs-home.md` in an ordinary tail round (`git mv` + `tugutil dash commit`), before the replay and draft. The Rollout section carries the exact sequence so the run's ending doesn't have to re-derive it.
- **[P06] The reference sweep has a stated exemption inventory.** Updated: `tuglaws/*.md` (≈79 references across 19 files, heaviest in `design-decisions.md` at 40), `CLAUDE.md` (repo-structure table row), `Justfile` (comment references at the signing/bundle recipes), `scripts/setup-dev-signing.sh` (header comment), `tugdeck/src` comment references (`main.tsx`, `deck-trace.ts`, `protocol.ts`, `spikes/spike-configure-tug.tsx`), `tugrust/crates/tugcore/src/{ports,instance,registry}.rs` (doc-comment citations of `roadmap/tug-multi-instance.md`, now in `archive/`). Exempt, deliberately: scratch-repo test literals in `tugrust/crates/tugdash-core/src/{ops,replay}.rs` (they create their own `roadmap/plan.md` in temp repos — arbitrary strings with no link to this repo's tree; renaming them is churn with no reader); sample-fiction strings in `tugdeck/src/spikes/spike-pulse-display.tsx` (fake activity copy, not path references); `tuglaws/dash-work-doctrine.md`'s "no canonical directory" sentence keeps naming `roadmap/` — as the example of a name that must *not* be assumed, which the migration makes truer, though the sentence should be touched to read naturally post-move (Step 4 task).

---

### Deep Dives {#deep-dives}

#### The last blessing: how plan search consumes the name {#plan-search-blessing}

`tugrust/crates/tugutil-core/src/config.rs` declares `PLAN_SEARCH_DIRS: &[&str] = &[".tugtool", "roadmap"]` with a doc comment calling `.tugtool/` canonical and `roadmap/` "a secondary location for longer-lived or proposed plans". Three consumers:

- `find_tugplans(project_root)` (same file) — enumerates `tugplan-*.md` across the search dirs; requires the primary to exist, skips absent secondaries.
- `resolve.rs` stage 2 (bare `tugplan-*` filename) and stage 3 (slug → `tugplan-{input}.md`) — probe each search dir in order.
- `tugrust/crates/tugutil/src/plan.rs` — a doc comment naming the const (prose only; the plan verbs take explicit paths by design and never resolve).

**The blessing is real but dormant:** `resolve_plan` and `find_tugplans` are exported from `tugutil-core` (`lib.rs`) with no live caller anywhere in the workspace today — the plan CLI verbs deliberately refuse to guess, and `tugdash-core`'s `resolve_plan_rel*` functions are a separate, path-based mechanism. That makes this the cheapest possible moment to delete the entry: no behavior anyone depends on changes, and the dash-cockpit phase (which will list plans in the declared directory) becomes the first live consumer of the derived search.

The replacement is a function, not a const: `plan_search_dirs(project_root) -> Vec<String>` returning `[".tugtool"]` plus the declared docs directory when config declares one and it differs from `.tugtool`. It loads config via the existing `Config::load_from_project` (cheap: one small TOML read; the resolver already runs `find_project_root` per invocation, so this adds no new I/O class). `find_tugplans` and both resolver stages call it; the const is deleted. Precedence is unchanged: `.tugtool/` first, so an identically-named plan there still shadows the docs directory.

#### Writing config without destroying it {#config-write-path}

`Config` serializes via serde, but a serde round-trip drops comments and formatting — and `.tugtool/config.toml` is comment-heavy by design (the `DEFAULT_CONFIG` template in `init.rs` is mostly comments). The `--set` write therefore goes through `toml_edit` (already in `Cargo.lock` as the `toml` crate's editing backend; add it as a direct dependency of `tugutil-core` at the locked version): parse the existing document (or start from an empty one; if no config file exists, start from `DEFAULT_CONFIG` so a bare `--set` still yields a well-commented file), ensure the `[tugtool.dash]` table, set `docs = "<dir>"`, write atomically (write-temp-then-rename, matching the `write_atomic` convention in `tugrust/crates/tugdash-core/src/ops.rs`).

Validation before writing: the value must be a relative path, must not begin with `/` or contain `..` components, must not be `.tug` or `.tugtool` (those are machine/canonical areas, not paperwork homes). After writing, create the directory if it does not exist (`fs::create_dir_all`) — the ask-once flow ends with a directory that exists, so the very next action (writing a plan into it) cannot fail on a missing parent.

#### The verb's shape {#docs-dir-verb-shape}

`DashCommands` in `tugrust/crates/tugutil/src/cli.rs` gains:

```rust
/// Report the project's dash paperwork directory declaration, or record it.
DocsDir {
    /// Record the declaration (project-root-relative directory), creating
    /// the directory if absent. Without this flag, report only.
    #[arg(long)]
    set: Option<String>,
},
```

Handled in `tugrust/crates/tugutil/src/dash.rs` beside `run_config`. Report output — text: `docs: dash (/abs/path/dash)` or `docs: (not declared)`; JSON via the standard `print_ok` envelope: `{"docs": "dash" | null, "path": "/abs/..." | null, "declared": true|false}`. Exit 0 in both cases — undeclared is a state, not an error, matching `dash config`'s treatment of absent keys. Set output: a receipt naming the config path, the key written, and whether the directory was created. `run_config`'s `ConfigPayload` gains the `docs` field so the one-reader verb stays complete.

#### The migration's blast radius {#migration-blast-radius}

`roadmap/` today: 13 live documents (`dash-entry-points.md`, `dash-generality.md`, `dash-join-tail.md`, `dash+join-workflow-fixes.md`, `durable-commit-stability.md`, `join-landing-parity.md`, `join-narration.md`, `join-receipt-mechanics.md`, `join-voice.md`, `layout-miniature-instrument.md`, `slot-stack-split-affordances.md`, `unified-changes.md`, `z2-mods.md`), an `assets/` directory, and `archive/` (467 files). Plus this plan, excluded per [P05]. One `git mv roadmap dash` moves the tree (minus the exclusion, restored with `git mv dash/dash-docs-home.md roadmap/` immediately after, or by moving the siblings individually — the implementer picks whichever is cleaner in practice; the invariant is that this plan's path is unchanged when the move commits).

The cross-reference update is a mechanical `roadmap/` → `dash/` rewrite across the [P06] inventory, executed with `tugutil file edit --replace 'roadmap/' --with 'dash/'` per file (attributed, receipt-bearing) or `Edit` where context demands care. Anchored links (`roadmap/foo.md#anchor`) rewrite identically — anchors don't move. The working diff `M roadmap/archive/dash-notes.md` on base at plan time: if still uncommitted when the dash is created, it stays on base untouched (the dash forks from the committed tip); it will collide at join only if it survives uncommitted that long, which the join preflight reports intersection-aware.

---

### Specification {#specification}

#### S01 — The `docs` declaration {#s01-docs-declaration}

```toml
[tugtool.dash]
# Where dash paperwork (briefs, plans) lives, relative to the project root.
# Consumed by plan search and by the authoring skills. Declare none and
# search runs on .tugtool/ alone; skills ask once and record the answer here.
docs = "dash"
```

`DashConfig` in `tugrust/crates/tugutil-core/src/config.rs`:

```rust
/// The project's dash paperwork directory (briefs + plans), relative to the
/// project root. Read by plan search and reported by `dash docs-dir` /
/// `dash config`. Absent means undeclared: search runs on `.tugtool/` alone
/// and the authoring skills ask the user once, recording the answer here.
#[serde(default)]
pub docs: Option<String>,
```

#### S02 — `tugutil dash docs-dir` {#s02-docs-dir-verb}

| Invocation | Behavior | Exit |
|---|---|---|
| `dash docs-dir` | Text report: `docs: <value> (<abs path>)` or `docs: (not declared)` | 0 |
| `dash docs-dir --json` | `print_ok("dash docs-dir", {docs, path, declared})` | 0 |
| `dash docs-dir --set <dir>` | Validate ([#config-write-path]), write via `toml_edit`, `create_dir_all`, print receipt | 0; 1 on invalid value or write failure |

#### S03 — The ask-once contract (skill prose) {#s03-ask-once-contract}

The normative text, stated in `plan-devise`'s "Where the plan goes" section and referenced from the other two skills:

> A plan is a markdown file at an explicit path, and an explicit path in the invocation always wins. When the invocation names none: run `tugutil dash docs-dir --json`. Declared → propose `<docs>/<slug>.md` and proceed without asking. Undeclared → ask the user once where dash paperwork should live (propose a name), record the answer with `tugutil dash docs-dir --set <answer>`, and proceed — the question is asked once per project, ever, because the answer now lives in the project's config.

---

### Test Plan Concepts {#test-plan-concepts}

- **Rust unit tests** (in `config.rs` and the dash CLI integration tests in `tugrust/crates/tugutil/tests/`): declaration parses; absent defaults to `None`; `docs-dir` reports declared/undeclared; `--set` writes preserving an existing comment, creates the directory, refuses `/abs`, `../up`, `.tug`, `.tugtool`; `plan_search_dirs` returns the declared dir and never `roadmap`; slug resolution finds a plan in the declared dir.
- **No new app-test.** The tugdeck change is copy-only (no state, no behavior); `just app-test-changed` selects whatever `@covers` resolves for the touched files, and that selection is the bar.
- **Prose assertions** for skill and doc changes: the greps named in Success Criteria.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The `docs` declaration and its verb | done | `307fc4b4a` |
| #step-2 | Plan search derives from the declaration | done | `9fca5677b` |
| #step-3 | The skills speak the resolver | done | `e7787ffea` |
| #step-4 | This repository migrates | done | `a760c4545` |
| #step-5 | Human surfaces stop naming the tool | done | `879d2aab6` |
| #step-6 | Integration checkpoint | done | `f620157ac` |

#### Step 1: The `docs` declaration and its verb {#step-1}

**Commit:** `tugdash(dash-docs-home): declare the docs directory in config`

**References:** [P01], [S01](#s01-docs-declaration), [S02](#s02-docs-dir-verb), [#config-write-path](#config-write-path), [#docs-dir-verb-shape](#docs-dir-verb-shape)

**Tasks:**
- Add `docs: Option<String>` to `DashConfig` in `tugrust/crates/tugutil-core/src/config.rs` per S01.
- Add `toml_edit` as a direct dependency of `tugutil-core` at the version already in `Cargo.lock`.
- Implement the write path in `tugutil-core` (beside the config loader): parse-or-seed from `DEFAULT_CONFIG`'s shape, ensure `[tugtool.dash]`, set `docs`, atomic write, validation per [#config-write-path]. Note: `DEFAULT_CONFIG` currently lives in `tugrust/crates/tugutil/src/commands/init.rs`; either move the const into `tugutil-core` or duplicate the minimal seed — moving it is preferred so init and the setter share one template.
- Add `DocsDir { set: Option<String> }` to `DashCommands` in `tugrust/crates/tugutil/src/cli.rs`; implement `run_docs_dir` in `tugrust/crates/tugutil/src/dash.rs` per S02.
- Extend `run_config`'s `ConfigPayload` and text output with `docs`.
- Add the commented `docs` example to `DEFAULT_CONFIG`.
- Tests per Test Plan Concepts (declaration parsing, verb report both states, `--set` behaviors and refusals).

**Tests:** `cd tugrust && cargo nextest run -p tugutil-core -p tugutil`

**Checkpoint:** All named tests pass; `cargo build` clean (warnings are errors); `tugutil dash docs-dir` in a scratch repo with no declaration prints `docs: (not declared)` and exits 0.

#### Step 2: Plan search derives from the declaration {#step-2}

**Depends on:** [#step-1](#step-1)

**Commit:** `tugdash(dash-docs-home): plan search reads the docs declaration`

**References:** [P02], [#plan-search-blessing](#plan-search-blessing)

**Tasks:**
- Replace `PLAN_SEARCH_DIRS` with `plan_search_dirs(project_root) -> Vec<String>` in `tugrust/crates/tugutil-core/src/config.rs`: `.tugtool` always first, the declared docs dir appended when declared and distinct.
- Update `find_tugplans` and both resolver stages in `tugrust/crates/tugutil-core/src/resolve.rs` to call it.
- Update the doc comment in `tugrust/crates/tugutil/src/plan.rs` that names the const.
- Tests: slug and filename resolution find a plan in a declared `paperwork/` dir; a plan in `roadmap/` with no declaration is *not* found (the blessing is gone); `.tugtool/` still shadows the declared dir on filename collision.

**Tests:** `cd tugrust && cargo nextest run -p tugutil-core -p tugutil`

**Checkpoint:** Tests pass; `grep -n '"roadmap"' tugrust/crates/tugutil-core/src/config.rs` finds nothing.

#### Step 3: The skills speak the resolver {#step-3}

**Commit:** `tugdash(dash-docs-home): skills resolve the docs directory through the verb`

**References:** [P03], [S03](#s03-ask-once-contract), [R02]

**Tasks:**
- Rewrite `tugplug/skills/plan-devise/SKILL.md`'s "Where the plan goes" section to the S03 contract (the section currently instructs asking on every unnamed invocation; it becomes resolve-then-ask-once). Keep the explicit-path-wins rule and the "report the path you wrote" obligation.
- Update the example chips in `plan-devise` (`/tugplug:plan-review roadmap/my-plan.md`) and `plan-review` (`/tugplug:dash-implement roadmap/my-plan.md`) to `dash/my-plan.md` — honest examples in this repository post-migration, and no longer a blessing since the prose beside them names the contract.
- Update `tugplug/CLAUDE.md`'s location-discipline paragraph: the no-hardcoded-home rule stands, now stated as "resolved through `tugutil dash docs-dir`, never assumed".
- Touch `dash-implement`'s SKILL.md only where it names `roadmap/` in examples; its plan-path input contract (always explicit) is unchanged.

**Tests:** Prose assertions — `grep -rn "roadmap/" tugplug/` returns only `dash-audit`'s generic "roadmap step X" banned-identifier example (or nothing, if that line reads better generalized — implementer's call, either satisfies the criterion).

**Checkpoint:** The greps hold; the S03 text appears verbatim-or-equivalent in `plan-devise/SKILL.md`.

#### Step 4: This repository migrates {#step-4}

**Depends on:** [#step-2](#step-2)

**Commit:** `tugdash(dash-docs-home): roadmap/ becomes dash/, declared in config`

**References:** [P05], [P06], [#migration-blast-radius](#migration-blast-radius), [R01]

**Tasks:**
- `tugutil dash docs-dir --set dash` in the worktree (dogfooding the verb; alternatively edit config directly and reserve the verb for the checkpoint — the config end-state is what matters: `docs = "dash"` under `[tugtool.dash]`).
- `git mv roadmap dash`, then restore this plan: `mkdir roadmap && git mv dash/dash-docs-home.md roadmap/dash-docs-home.md` — the plan's recorded path must be live until the final `done` ([P05]).
- Cross-reference rewrite per the [P06] inventory: `tuglaws/*.md`, `CLAUDE.md` (repo-structure table row: `roadmap/` → `dash/`, description unchanged), `Justfile`, `scripts/setup-dev-signing.sh`, `tugdeck/src/{main.tsx,deck-trace.ts,protocol.ts,spikes/spike-configure-tug.tsx}`, `tugrust/crates/tugcore/src/{ports,instance,registry}.rs`. Use `tugutil file edit` or `Edit`; never scripting-language heredocs.
- Touch `tuglaws/dash-work-doctrine.md`'s "no canonical directory" sentence so it reads naturally post-move (the rule text may keep `roadmap/` as the cautionary example of an assumed name, per [P06]).
- Sweep for stragglers: `grep -rn "roadmap" --include="*.md" --include="*.rs" --include="*.ts" --include="*.tsx" --include="*.sh" --include="Justfile" .` (excluding `.tug/`, `node_modules`, `dash/` itself) and disposition every hit against the [P06] inventory.

**Tests:** `cd tugrust && cargo nextest run` (comment edits in `tugcore` must not break the build); `bun test` from `tugdeck/`; the Success Criteria greps.

**Checkpoint:** `tugutil dash docs-dir` reports `docs: dash`; `tugutil plan lint roadmap/dash-docs-home.md` still resolves and exits 0 (the plan's ledger remains drivable); the straggler grep returns only [P06] exemptions.

#### Step 5: Human surfaces stop naming the tool {#step-5}

**Commit:** `tugdash(dash-docs-home): human copy for the Dashes empty state`

**References:** [P04]

**Tasks:**
- Replace the empty-state copy in `tugdeck/src/components/lens/sections/dashes-section.tsx` (currently `No dashes. <code>tugutil dash create</code> starts one.`) with interim human copy that speaks in product gestures, e.g. `No dashes. Ask your session to start one.` — final affordance arrives in the dash-cockpit phase; this copy just stops naming the tool. Drop the `<code>` wrapper if the replacement carries no command.
- Audit every rendered string in `tugdeck/src` for `tugutil` against the [P04] boundary (`grep -rn "tugutil" tugdeck/src --include="*.tsx" --include="*.ts"`, dispositioning each hit: exec paths and comments are not copy; the staging refusal and fixture copy are exempt per [P04]; anything else rendered in graphical UI gets rewritten).

**Tests:** `cd tugdeck && bunx tsc --noEmit && bunx vite build`; `just app-test-changed` for the touched surface.

**Checkpoint:** The empty state renders the new copy (visible in the selected app-test run or the debug instance); no graphical surface names `tugutil`.

#### Step 6: Integration checkpoint {#step-6}

**Depends on:** [#step-1](#step-1), [#step-2](#step-2), [#step-3](#step-3), [#step-4](#step-4), [#step-5](#step-5)

**Commit:** `tugdash(dash-docs-home): integration checkpoint`

**References:** Success Criteria, [P05], Rollout

**Tasks:**
- Full Rust suite: `cd tugrust && cargo nextest run`.
- Full deck suite: `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`; `cd tests/app-test && bunx tsc --noEmit`.
- Live verb pass in the worktree: `tugutil dash docs-dir` and `tugutil dash config` report `docs = dash`; `tugutil plan lint dash/dash-generality.md` reads a migrated plan at its new explicit path and exits 0, proving the corpus moved intact (the plan verbs never resolve slugs — that discipline is theirs by design; derived search is covered by the Step 2 Rust tests).
- `just app-test-changed` from the worktree.
- Re-run every Success Criteria grep and record results in the round summary.

**Tests:** The commands above — this step's work *is* the verification.

**Checkpoint:** Everything green; the Success Criteria hold. (If no source changed since Step 5's checkpoint, the suites may be folded into Step 5's round per doctrine, with this step's `done` pointing at that commit.)

---

### Rollout {#rollout}

After Step 6's `dash step done` closes the run, and before the replay/draft ending: move the plan itself in a tail round — `git mv roadmap/dash-docs-home.md dash/dash-docs-home.md`, remove the now-empty `roadmap/` directory, commit via `tugutil dash commit` with the round summary naming [P05]. The ledger is complete by then; nothing writes to the plan's recorded path afterward. The join squashes the exclusion-and-restore dance invisibly — `main` receives one commit in which `roadmap/` simply became `dash/`, plan included.

---

### Deliverables {#deliverables}

- `docs` declaration in `DashConfig`; `tugutil dash docs-dir` (reporter + setter); `docs` in `dash config` and `init`'s template.
- Plan search derived from the declaration; the `roadmap` blessing deleted.
- The three paperwork skills and `tugplug/CLAUDE.md` carrying the ask-once contract.
- This repository migrated: `docs = "dash"`, `dash/` holding the corpus, cross-references updated, plan itself moved in the tail round.
- The Dashes empty state in human copy; the [P04] sweep clean.
