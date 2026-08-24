<!-- devise-skeleton v5 -->

## Dash Generality {#dash-generality}

**Purpose:** Make the dash/join workflow general-purpose again. The engine already is — this phase moves the two places Tugtool-specificity has pooled behind a per-project declaration seam: the run's ending (verify and build commands declared in `[tugtool.dash]`, beside `post_create`) and the tugplug skill prose (rewritten against the declaration, with a stated degradation for every absence). The proof is a scratch project with none of Tugtool's machinery walked end to end.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, fable.** Reviewed `plan:ee8d6dec55275189`. Lint: 1 error (fixed: PL015, ledger rows now anchor-keyed), 0 warnings.
Oriented on: the whole document (first review), against the code read this session — `tugutil-core/src/config.rs` (`DashConfig`, `Config::load_from_project`, `find_project_root`, the legacy-keys tolerance test), `tugutil/src/commands/init.rs` (`DEFAULT_CONFIG` and both write paths), `tugutil/src/cli.rs` and `tugutil/src/dash.rs` (`DashCommands`, `run_replay`, `print_ok`, `ReplayOutcome` serialization), `tugdash-core/src/ops.rs` (`run_post_create`), `scripts/verify-fit.sh`, [D149] and [D150] in full, the skeleton's Integration Checkpoint pattern and worked example, the doctrine's ending sections, all seven target SKILL.md files, all three hooks plus `hooks.json`, and `tugplug/hooks/tests/run-gate-tests.sh` with its cases file.
Applied: coherence — Step 7's declared arc would have run the verify after a `Current` replay, contradicting [P02]; the arc now moves the scratch base mid-dash so the replay reports `Replayed` and the run is legitimate. Holes — the plan had no red-verify path; the `#seam-read-at-ending` deep dive and Step 3's skeleton task now state it (fix in the warm worktree, commit as a round, re-run — the `Conflicted` arm's aftermath, never a join-time concern). Sequencing — Step 6's `Depends on: #step-1` was not a real dependency and is removed. Technical grounding — Step 6's cases-harness task was conditional ("if the harness has no cwd axis"); the runner was read (`jq -n '{tool_name,tool_input}'`, no `cwd`, executed from the checkout) and the task now specifies the fourth-column extension and why every existing case stays green through the `$PWD` fallback. Tuglaws cross-check: no tugdeck/tugways state is introduced, so no State Zone Mapping and no [L01]–[L06] exposure; the load-bearing cross-check here is [D149], held by [P02], the Non-goals, and Step 3's re-read task; [L29] is untouched (no path is persisted or compared anywhere in this plan); the shell-edit discipline is honored by Step 8's edit-with-tools instruction. Verified against the code rather than the plan's own claims: `at0441` no longer exists (deleted at `79586c29f`) — the Context cites the fixture suite instead; `tugutil init`'s bun default was confirmed in both write paths; no existing init test pins the old default text, so Step 1's conditional update note stands.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dash/join workflow is the product's spine, and tugplug ships inside the app bundle — it is the onboarding voice for every project a user points Tug at. The engine underneath is already project-agnostic: `tugdash-core` knows no Justfile, the dash verbs are proven against repositories that are not Tugtool by the scratch-repo fixture arc (`tests/app-test/dash-fixture.ts` — `makeDashScratchRepo`, `createDash` refusing the developer's checkout outright — exercised by the at044x join suite), and `dash create --base` plus the universe seam let a dash live on any repo. Nothing in this phase touches the verb layer or the join arc.

The specificity has pooled in two places, and the second was created deliberately by [D149]:

1. **The verification seam.** [D149] deleted the `verify_tier0`/`verify_tier1` config keys — the only per-project declaration the workflow ever had for "how do I check this tree." What replaced them is skill prose plus a repo-local `scripts/verify-fit.sh` that a brand-new project will not have. The one declaration seam that survived is the `[tugtool.dash].post_create` hook pattern in `.tugtool/config.toml`, parsed by `DashConfig` in `tugrust/crates/tugutil-core/src/config.rs` and run by `run_post_create` in `tugrust/crates/tugdash-core/src/ops.rs`. It is the right pattern: a declaration in the project's own committed config, read at the moment it is needed, absent by default.

2. **The skills speak only Tugtool.** `dash-implement` establishes its baseline with `bun test` and `cargo nextest run`, says `post_create` "runs `bun install`", names `sh scripts/verify-fit.sh` at the ending, offers `just app-debug` as *the* build, and teaches Vite HMR in its iterate phase. `dash-on` mirrors all of it. `plan-devise` declares `tuglaws/devise-skeleton.md` the mandatory format with no word for a project that has no `tuglaws/`. `dash-audit` sends real-app tests to `tests/app-test/` and bans fake-DOM shapes as if every project had signed Tugtool's doctrine. `dash-join` and `draft` lean on tuglaws paths and tugdeck/tugrust examples. And `tugutil init` — the verb that onboards a brand-new project — writes `post_create = ["bun install --cwd tugdeck"]` into *any* repository (`DEFAULT_CONFIG` in `tugrust/crates/tugutil/src/commands/init.rs`), a Tugtool-ism baked into the front door itself.

The hooks have the same exposure at a smaller scale: `tugplug/hooks/gate-app-test-output.sh` rewrites any `just app-test*` invocation on the strength of Tugtool's report contract, which a foreign project's own `just app-test` recipe never signed.

One model already exists for what absence should sound like: `plan-review`'s missing-rubric clause — *"If the rubric is absent — a project without `tuglaws/` — proceed on the criteria above and say so. A missing rubric degrades the review; it does not cancel it."* That is the degradation doctrine this phase generalizes: every absence has a stated sentence, the work proceeds at a named lower fidelity, and nothing is invented to fill the gap.

#### Strategy {#strategy}

- Extend the seam that survived rather than inventing a new one: `verify` and `build` become optional keys beside `post_create` in `[tugtool.dash]`, committed in the project's `.tugtool/config.toml`, riding the dash branch like everything else in the tree.
- Give the skills one reader for the seam — a `tugutil dash config` verb — so no skill parses TOML in prose and absence is reported uniformly.
- Tugtool becomes the first consumer: its own config declares `scripts/verify-fit.sh` and `just app-debug`, and the hardcoded references in `tuglaws/devise-skeleton.md`, `tuglaws/dash-work-doctrine.md`, and the skills route through the declaration, keeping Tugtool's values as the worked example rather than the assumed universe.
- Rewrite the skills against the declaration with a stated degradation for every absence, in the plan-review pattern. Never an invented command, never a silent skip.
- Hooks detect their subject before acting: a gate whose doctrine does not apply to this project exits 0 untouched. A broken or inapplicable gate must never block work.
- The proof is real, not asserted: a local scratch repository with no Justfile, no app-tests, no tuglaws, walked end to end through the CLI arc — created, stepped, committed, drafted, replayed, landed — with the degradation behavior observed in the actual transcript, then walked a second time with declarations present to prove the seam consumes.
- The seam and the degradation doctrine land as a global design decision so the next skill author writes against the declaration instead of the dialect.

#### Success Criteria (Measurable) {#success-criteria}

- `.tugtool/config.toml` in this repository declares `verify` and `build`, and `tugutil dash config --json` reports them; in a repo with no config (or none of the keys) it reports each as null and exits 0 (Rust tests, Step 2; observed live in Step 7).
- `tugutil init` in an empty repository writes a config with no Tugtool-specific command in it — `grep -n "bun\|tugdeck\|just " .tugtool/config.toml` in a fresh init finds only commented examples (Rust test, Step 1; observed live in Step 7).
- `grep -rn "verify-fit\|just app-debug\|cargo nextest\|bun install\|bun test" tugplug/skills/*/SKILL.md` finds no line that presents these as *the* commands — every remaining occurrence is inside an "in this repo" example subordinate to the declaration (prose assertion, Steps 4–5).
- Each of the seven skills carries an explicit degradation sentence for each Tugtool artifact it leans on (verify command, build command, `tuglaws/` docs, app-test harness), greppable by the shared phrase "and say so" (prose assertion, Steps 4–5).
- `tugplug/hooks/gate-app-test-output.sh`, fed a PreToolUse payload whose `cwd` is a project with no `tests/app-test/`, exits 0 with no output — the command passes untouched (hooks-test case, Step 6).
- A scratch repository with none of Tugtool's machinery goes create → step → commit → draft → replay → join through the real CLI, landing a squash on its own main, with `TUG_DATA_DIR` redirected and nothing left behind (transcript evidence, Step 7).
- `tuglaws/design-decisions.md` carries the new [D##] recording the seam and the degradation doctrine (Step 8).

#### Scope {#scope}

1. `DashConfig` gains optional `verify` and `build` declarations; `tugutil init`'s default config becomes project-neutral; Tugtool's own config declares its values.
2. A `tugutil dash config` read verb, JSON and text.
3. `tuglaws/devise-skeleton.md` and `tuglaws/dash-work-doctrine.md` route their ending/build prose through the declaration.
4. The seven skills — `dash-implement`, `dash-on`, `plan-devise`, `plan-review`, `dash-join`, `dash-audit`, `draft` — rewritten against the seam with stated degradations.
5. The tugplug hooks sweep: applicability guards so gates no-op cleanly off-Tugtool; hooks-test cases pinning both directions.
6. The scratch-project proof, both arcs (undeclared and declared).
7. The global design decision.

#### Non-goals {#non-goals}

- **No change to the verb layer or the join arc.** `tugdash-core`'s ops, replay, join, pilot, prompt, and resolve paths do not move. The seam is read by prose (the skills) and by one new read-only verb.
- **No re-proposal of what [D149] rejected.** This seam serves the **run's ending** under [D149]'s own doctrine: verification stays out of the join, the join gate remains reconcile-clean alone, and the two forbidden alternatives — a terminal sandbox sweep, and join-time verification kept as advisory — stay forbidden. A declared `verify` command is the *ending's* scoped check made portable, run at exactly the moments `dash replay` already defines (`Replayed`/`Recorded`), never at join time, and never as a sweep. Nothing in this plan may be read as reopening that decision.
- **No test-selection declaration.** See [P03].
- **No VM-lab onboarding proof.** The factory-fresh VM lab is the eventual venue for the full onboarding story; the bar here is a local scratch repository.
- **No `spike-card` or `history` skill rewrite.** `spike-card` is inherently a tugdeck design tool — its subject is this repository's spikes sandbox — and `history` reads the machine-global prompt ledger, which is project-independent already. Neither is in the user-named set.
- **No plugin-shipped copy of the devise skeleton.** Two copies of the format contract would drift; the portable contract is `tugutil plan lint` plus the format summary the `plan-devise` skill already carries ([P06]).

#### Dependencies {#dependencies}

- `dash/join-voice.md` landed (`e289fe517` on main) — the doctrine's ending prose this plan edits is the post-[D149]/[D150] text.
- The scratch-repo dash machinery: `tests/app-test/dash-fixture.ts` conventions (`TUG_DATA_DIR` redirect, absolute-path CLI) inform Step 7's manual walk.
- `just hooks-test` (Justfile recipe `hooks-test`, driving `tugplug/hooks/tests/run-gate-tests.sh` over `gate-app-test-output.cases`) — the pinning harness Step 6 extends.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace; every step's Rust work builds under `-D warnings`.
- **Skills and hooks run from the app bundle**, not the repo — a repo edit does nothing for live sessions until the app is rebuilt or the files are copied into the bundle (`Tug.app/Contents/Resources/tugplug/`). Any step that wants to observe a rewritten skill or hook live must copy it in first; the landed artifact is still the repo bytes.
- **Only the user lands on main.** All work happens on the dash worktree via `tugutil dash commit`.
- **`~/.local/bin` tug symlinks point at main.** Every CLI invocation in Step 7's proof uses the dash worktree's freshly built binary by absolute path.
- **Config schema changes here are TOML-parse-level only** — no shared-ledger schema is touched, so no `CHANGES_SCHEMA_VERSION` bump is implicated.

#### Assumptions {#assumptions}

- Unknown config keys are ignored on parse (proven by `test_unknown_keys_are_ignored` in `config.rs`), so old checkouts reading a config that declares `verify`/`build` keep working, and new code reading an old config sees `None`.
- The Claude Code PreToolUse hook payload carries the session's working directory (`cwd`); where it does not, the guard falls back to `$PWD`, and any read failure falls through to exit 0.

---

### Open Questions {#open-questions}

None. The design calls that could have been questions are decided below with their rationale ([P01]–[P07]); none crossed the bar of needing the user's judgment over a conventional default.

---

### Risks {#risks}

- **R01 — Bundle staleness.** The rewritten skills and hooks are inert for live sessions until the app rebuilds. Mitigation: Step 6 and Step 7 copy the changed files into the bundle for live observation; the plan says so explicitly so the proof is not run against stale prose.
- **R02 — Degradation prose drift.** The degradation sentences live in seven SKILL.md files and nothing mechanical holds them. Mitigation: [D##] (Step 8) records the doctrine and the canonical sentences; the success criterion greps for the shared "and say so" phrase as a floor.
- **R03 — Hook guard false negatives.** An applicability guard that misreads `cwd` could disable the gate inside Tugtool. Mitigation: the guard's Tugtool-positive direction is pinned by an explicit hooks-test case (existing cases already run with the repo as subject and must stay green).
- **R04 — `tugutil init` default change.** Projects that relied on a fresh `init` writing the bun hydration line would lose it. Assessment: Tugtool's own `.tugtool/config.toml` is committed and never re-initialized; the default only ever reaches new projects, where the bun line was wrong. No mitigation needed beyond the neutral-default test.

---

### Design Decisions {#design-decisions}

- **[P01] Declarations live where `post_create` lives.** Two new optional keys in `[tugtool.dash]` in the project's committed `.tugtool/config.toml`, parsed by `DashConfig` (`tugrust/crates/tugutil-core/src/config.rs`): `verify` — the run-ending's scoped fit check — and `build` — the command that produces an inspectable instance from the worktree. Committed config means the declarations ride the dash branch and reach every worktree the way `post_create` already does. Rejected: a per-user or data-dir location (the declaration is a fact about the project, not the user) and a new file (the seam that survived [D149] is this one; extending it is the point).

- **[P02] The seam serves the run's ending, under [D149], full stop.** `verify` is consumed at exactly the moments the ending already defines: after `tugutil dash replay` reports `Replayed` or `Recorded` (and after a resolved `Conflicted`), scoped to `{base}..{head}`, in the warm worktree. `Current` still runs nothing. The join gate remains reconcile-clean alone; no declared command is ever run at join time, and the two [D149]-rejected shapes — the terminal sandbox sweep and the join-time advisory — remain rejected. This decision exists so no reader can mistake a portable verify declaration for a reopened verification-at-the-join debate.

- **[P03] Test selection stays the plan's business.** No third key. A plan's per-step checkpoints already name the exact test commands for the work they verify — that is what a checkpoint *is* — and the ending deliberately runs only the scoped fit check, never a selection sweep ([D149]: a checkpoint that passed is spent). A declared test-selection command would have no consumer moment that is not either a step (where the plan speaks) or the ending (where verify speaks); it would be a sweep-shaped key waiting to be misused.

- **[P04] One reader: `tugutil dash config`.** A read-only subcommand reporting the resolved `[tugtool.dash]` declarations as JSON (`verify`, `build`, `post_create`; absent keys as null) and as text (with "(not declared)" markers). Skills call it instead of parsing TOML in prose, absence is reported uniformly, and the project root resolves through the same `.tugtool/` marker walk every other verb uses — from a dash worktree it reads the worktree's committed copy, which is the copy the run is about. Rejected: folding the verify command into `dash replay --json` (the replay's JSON is a direct serialization of `tugdash-core::ReplayOutcome`; injecting config would mix a core outcome type with CLI-layer convenience, and `build` has no home there at all).

- **[P05] Placeholder contract: `{base}` and `{head}`, literal, substituted by the consumer.** The declared `verify` string may carry `{base}` and `{head}`; the consumer (skill prose, per the skeleton's ending procedure) substitutes the sha pair the replay reported and runs the result via `sh -c` from the worktree root. A command with no placeholders runs as-is (a project whose check is unscoped is allowed to say so). Tugtool declares `verify = "sh scripts/verify-fit.sh {base} {head}"`. Rejected: positional-argument appending (ambiguous against `sh -c` strings that end in flags) and a Rust-side runner verb (the ending is skill-driven prose today by [D149]'s design; a runner verb is machinery this phase does not need and the verb layer is a stated non-goal).

- **[P06] The portable format contract is the linter, not a shipped skeleton copy.** On a project with no `tuglaws/devise-skeleton.md`, `plan-devise` proceeds on the format summary its own prose carries — section order, anchors, labels, step fields, ledger — with `tugutil plan lint` as the enforcement, and says so. The linter is in the product and is project-agnostic; a second skeleton copy in the plugin would drift from the tuglaws original. The skill's summary is already sufficient to write a lintable plan (it is what the linter checks, restated).

- **[P07] The degradation doctrine: absence has a stated sentence, never an invention.** Modeled on `plan-review`'s missing-rubric clause. The canonical set (Spec S03): no `verify` declared → the ending's verification is the plan's own checkpoint commands over what the replay moved, said plainly — never an invented command; no `build` declared → no build is offered, and the report says the work is inspectable at the worktree; no `tuglaws/` → the review/audit names its criteria inline and says the doctrine docs are absent; no app-test harness → real-app behavior claims are stated as unverified at that layer, and the test-discipline bans (fake-DOM, RTL) are named as Tugtool doctrine that applies where `tuglaws/dash-work-doctrine.md` exists rather than imposed on a project that never signed it. Every sentence ends by *saying so* in the transcript — visible degradation, in plan-review's exact pattern.

- **[P08] Hooks act only on their subject.** `gate-app-test-output.sh` gates Tugtool's app-test report contract, so it first establishes that the command's project *has* that contract: resolve the project directory from the hook payload's `cwd` (fallback `$PWD`, then `git rev-parse --show-toplevel`), and exit 0 untouched unless `tests/app-test/` exists there. Any failure to resolve exits 0 — the existing "a broken gate must never block work" rule extends to "an inapplicable gate must never fire." `auto-approve-tug.sh` (generic safe prefixes + `tugutil`) and `gate-file-ops.sh` (delegates to `tugutil file gate`, which is project-agnostic, and already exits 0 without `tugutil`) are audited as already-clean and not changed.

---

### Deep Dives {#deep-dives}

#### The Tugtool-ism inventory {#tugtoolism-inventory}

What each artifact assumes today, found by direct read. Line references are for the implementer's orientation and will drift; the quoted phrases are the stable keys to grep for.

**`tugrust/crates/tugutil/src/commands/init.rs`** — `DEFAULT_CONFIG` writes `post_create = ["bun install --cwd tugdeck"]` into any project. The comment block above it is fine; the value is the defect.

**`tugplug/skills/dash-implement/SKILL.md`** — Setup: "`create` also hydrates the fresh worktree itself (its `[tugtool.dash].post_create` hook runs `bun install`)"; "Establish a green baseline (`bun test`, and for Rust changes `cd tugrust && cargo nextest run`)". Ending: "verify it, scoped to what the diff touches: `sh scripts/verify-fit.sh <base-sha> <head-sha>` in this repo, or the project's equivalent" (the escape hatch exists but names no way to *find* the project's equivalent). Build offer: a fenced `just app-debug` block plus `just instances` / `just launch-debug` / `just logs-debug` / `just stop-debug`. Iterate: "tugdeck (frontend) changes are live via Vite HMR… Rust / tugcode / Swift changes need a rebuild — `just app-debug` again".

**`tugplug/skills/dash-on/SKILL.md`** — mirrors all four: the `bun install` hydration line, the `just app-debug` / `just instances` block, the ending's `scripts/verify-fit.sh` line, and tuglaws doctrine links.

**`tugplug/skills/plan-devise/SKILL.md`** — "following the devise skeleton, `tuglaws/devise-skeleton.md` — this is the mandatory format", with relative links `../../../tuglaws/…` that resolve only inside a Tugtool checkout; the never-ask link into `dash-work-doctrine.md`; the Opus-review path reads `tuglaws/plan-review-rubric.md`. No absence clause for any of them.

**`tugplug/skills/plan-review/SKILL.md`** — already carries the model degradation for the rubric. Still unhandled: the re-review rules link, the never-ask link, and an example Review Record that cites an app-test rewrite as the canonical fix.

**`tugplug/skills/dash-audit/SKILL.md`** — has a partial absence clause for the rubric axes ("when it is absent, the axes carried here stand on their own"). Unhandled: the tuglaws-adherence section ("Confirm the code adheres to the tuglaws as defined in `tuglaws/tuglaws.md` — with an actual audit"), and test discipline stated as universal: "any real-app behavior tested outside `tests/app-test/`" and the fake-DOM/RTL bans presented as law rather than as Tugtool doctrine.

**`tugplug/skills/dash-join/SKILL.md`** — the never-ask link. Otherwise verb-layer narration, already general.

**`tugplug/skills/draft/SKILL.md`** — cosmetic: worked examples name `tugdeck/src/foo.ts`, `tugrust/src/bar.rs`. The procedure itself is general.

**`tuglaws/devise-skeleton.md`** — the Integration Checkpoint procedure, twice: the pattern prose ("in this repo, `sh scripts/verify-fit.sh <base-sha> <head-sha>`, which scopes `cargo check` / `tsc` + `vite build` to the surfaces the diff touches") and the worked example step's task list ("verify the replayed tree with `sh scripts/verify-fit.sh <base-sha> <head-sha>`"). Also the sweep warning naming `cargo nextest run`, `tsc`, `vite build`, `bun test`, `app-test-changed` — that list is illustrative and may stay as the example of the banned shape.

**`tuglaws/dash-work-doctrine.md`** — "The build is an offer" names `just app-debug`; the verification-bar section names `bun test <scope>`, `cargo nextest run`, and `just app-test <file>` as the layers. The doctrine is Tugtool's own repo-local law, so Tugtool commands may remain as the local instance — but the ending and build sentences should name the declaration as the source with Tugtool's values as this repo's declared answers, since this is the text the skills cite as the portable rule.

**`tugplug/hooks/`** — `gate-app-test-output.sh` fires on any `just app-test*` segment with no test of whether this project is Tugtool. `auto-approve-tug.sh` and `gate-file-ops.sh` audited clean ([P08]).

#### How the seam is read at the ending {#seam-read-at-ending}

The ending's consumer moment already exists in three texts that must stay in agreement: the skeleton's Integration Checkpoint procedure, `dash-implement` phase 3, and `dash-on`'s ending. After this phase all three say the same thing: run `tugutil dash replay <name>`; on `Replayed`/`Recorded`, read the declaration with `tugutil dash config --json`, substitute `{base}`/`{head}` with the replay's sha pair, and run it from the worktree root; on a null `verify`, the degradation sentence ([P07]); on `Current`, nothing runs, declared or not. The replay's JSON already carries the sha pair (`base_head` on `Replayed`/`Recorded`; the round mapping names the new heads), so no new plumbing is needed to know what to substitute.

A declared verify that **fails** is ordinary red work, not a new state: fix it in the warm worktree, commit the fix as a round, and re-run — the same aftermath the `Conflicted` arm already teaches. Nothing about a red verify reaches the join; the gate stays reconcile-clean ([P02]), and a run that stops with a red verify has simply not finished its ending.

#### The scratch project's shape {#scratch-project-shape}

Deliberately below every Tugtool assumption: a git repository containing a `README.md`, one executable artifact (`hello.sh`), and one runnable check (`tests/run.sh`, plain POSIX sh, exits non-zero on failure). No Justfile, no `package.json`, no Cargo workspace, no `tests/app-test/`, no `tuglaws/`. It is initialized with the *new* neutral `tugutil init`, so the walk also proves the front door. Its Tug state is isolated with `TUG_DATA_DIR` pointed at a sibling temp directory, the convention `tests/app-test/dash-fixture.ts` established, so nothing lands in the live data root. The declared-arc pass writes `verify = "sh tests/run.sh"` (no placeholders — the unscoped form [P05] allows) into its config to prove consumption.

The join *prompt* arc on non-Tugtool repositories is already machine-pinned: the at044x suite drives prompt → answer → landing on `makeDashScratchRepo` repositories inside the real app. Step 7 therefore proves the CLI arc and the skill-transcript behavior, and cites the fixture suite for the prompt surface rather than re-proving it by hand.

---

### Specification {#specification}

#### S01 — The `[tugtool.dash]` declaration schema {#s01-declaration-schema}

```toml
[tugtool.dash]
# Hydration: run from a new dash worktree root after `dash create` adds it.
post_create = ["bun install --cwd tugdeck", "bun install --cwd tugcode"]

# The run-ending's scoped fit check ([D149]): run from the worktree root via
# `sh -c` after the replay moved the tree. `{base}` and `{head}` are replaced
# with the replayed range's shas; a command without them runs unscoped.
verify = "sh scripts/verify-fit.sh {base} {head}"

# The command that produces an inspectable instance from this worktree, for
# the build offer at the end of a run with a face.
build = "just app-debug"
```

Rust shape (`DashConfig` in `tugrust/crates/tugutil-core/src/config.rs`):

```rust
#[serde(default)]
pub post_create: Vec<String>,
/// The run-ending's scoped fit check. `{base}`/`{head}` are substituted by
/// the consumer with the replayed range before running via `sh -c` from the
/// worktree root. Absent means undeclared: the ending degrades to the plan's
/// own checkpoint commands, stated plainly.
#[serde(default)]
pub verify: Option<String>,
/// The command that produces an inspectable instance from the worktree.
/// Absent means no build is offered.
#[serde(default)]
pub build: Option<String>,
```

The values above are Tugtool's own declarations, landed in this repository's `.tugtool/config.toml` in Step 1.

#### S02 — `tugutil dash config` {#s02-dash-config-verb}

`DashCommands::Config` in `tugrust/crates/tugutil/src/cli.rs`, dispatched in `tugrust/crates/tugutil/src/dash.rs`. Resolves the project root by the standard `.tugtool/` upward walk (`find_project_root`), loads via `Config::load_from_project`, and reports. A missing config file is not an error — it is the all-undeclared state, exit 0.

JSON (via the shared `print_ok` envelope, command string `"dash config"`):

```json
{ "verify": "sh scripts/verify-fit.sh {base} {head}", "build": "just app-debug", "post_create": ["bun install --cwd tugdeck", "bun install --cwd tugcode"] }
```

Absent keys serialize as `null` (`post_create` as `[]`). Text mode:

```
verify:       sh scripts/verify-fit.sh {base} {head}
build:        just app-debug
post_create:  bun install --cwd tugdeck; bun install --cwd tugcode
```

with `(not declared)` in place of an absent value. No flags beyond the global `--json`/`--quiet`; the verb takes no dash name because the declaration is the project's, not a dash's.

#### S03 — The degradation sentences {#s03-degradation-sentences}

The canonical absences and what each skill says and does. "Says so" means the sentence appears in the run's transcript, not only in the skill file.

| Absence | Behavior | The sentence's shape |
|---|---|---|
| `verify` undeclared | The ending's verification after a moved replay is the plan's own per-step checkpoint commands re-run over what the replay moved — the commands the plan already names, never an invented one. | "This project declares no verify command; verifying the replayed tree with the plan's own checkpoint commands — and say so." |
| `build` undeclared | No build is offered. The report states the work is inspectable at the worktree path. | "This project declares no build command, so no build is offered; the work is inspectable at `<worktree>`." |
| No `tuglaws/` (rubric, doctrine, skeleton, laws) | Review/audit proceeds on the criteria the skill itself carries, named inline; `plan-devise` writes against its own format summary with `tugutil plan lint` as the contract ([P06]). | plan-review's existing clause, extended verbatim in pattern: "proceed on the criteria above and say so." |
| No app-test harness (`tests/app-test/` absent) | Real-app behavior claims are stated as unverified at that layer; the fake-DOM/RTL bans are named as Tugtool doctrine, applicable where `tuglaws/dash-work-doctrine.md` exists, not imposed. | "This project has no app-test harness; the real-app claims in this plan are verified only as far as its own tests reach — and say so." |

---

### Test Plan Concepts {#test-plan-concepts}

- **Rust, `tugutil-core` (`config.rs` tests):** parse a config declaring `verify`+`build` (both `Some`); parse one declaring neither (both `None`); the existing legacy-keys test stays green (forward tolerance).
- **Rust, `tugutil` (init tests, existing module in `init.rs`/its test file):** a fresh `init` writes a config whose parsed `DashConfig` has empty `post_create` and `None` for `verify`/`build`, and whose text contains no `bun`/`tugdeck` outside comments.
- **Rust, `tugutil` (dash tests):** `dash config --json` in a temp repo with a declaring config reports the values; in a temp repo with no `.tugtool/config.toml` reports nulls and exits 0.
- **Hooks (`tugplug/hooks/tests/gate-app-test-output.cases` via `just hooks-test`):** a new case class carrying a non-Tugtool `cwd` → decision `none` (pass-through) for a piped `just app-test` command; the existing Tugtool-cwd cases stay green (the guard must not disable the gate at home). The cases file format is whatever `run-gate-tests.sh` already consumes — read it before adding cases.
- **Prose assertions (checkpoint greps, not committed tests):** the success-criteria greps over `tugplug/skills/*/SKILL.md` and the fresh-init config.
- **The real-layer proof is Step 7's transcript**, not a mock: real CLI, real scratch repo, real hooks invoked with real payloads. No fake-DOM shapes, no mocked stores — nothing here has a DOM at all.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The declaration seam in config | done | `48e927242` |
| #step-2 | The `tugutil dash config` verb | done | `bcdb1563a` |
| #step-3 | Skeleton and doctrine route through the declaration | done | `acb871d7c` |
| #step-4 | The run skills speak the declaration | done | `8ca984f73` |
| #step-5 | The judgment skills degrade by name | done | `8bbcc9505` |
| #step-6 | Hooks act only on their subject | done | `4b08f584a` |
| #step-7 | The scratch-project proof | done | `1e02a065f` |
| #step-8 | The design decision | done | `cda0deb72` |
| #step-9 | Integration Checkpoint | done | `af6cd361e` |

#### Step 1: The declaration seam in config {#step-1}

**Commit:** `tugdash(dash-generality): declare verify and build beside post_create`

**References:** [P01], [P02], [P05], Spec S01, (#tugtoolism-inventory)

**Tasks:**
- [ ] `tugrust/crates/tugutil-core/src/config.rs`: add `verify: Option<String>` and `build: Option<String>` to `DashConfig` with the doc comments in Spec S01 (the placeholder contract and the absence meaning live in these comments — they are the schema's documentation of record).
- [ ] `tugrust/crates/tugutil/src/commands/init.rs`: rewrite `DEFAULT_CONFIG` to the project-neutral form — `post_create = []` and commented-out example lines for all three keys (the examples may show generic commands, e.g. `# post_create = ["npm install"]`, `# verify = "sh scripts/check.sh {base} {head}"`, `# build = "make app"`), keeping the existing explanatory comment block. Update any init test that asserts the old default text.
- [ ] `.tugtool/config.toml` (this repository): add Tugtool's declarations — `verify = "sh scripts/verify-fit.sh {base} {head}"`, `build = "just app-debug"` — with one comment line each pointing at the schema comments in `config.rs`.
- [ ] Confirm nothing else parses this file ad hoc: `grep -rn "config.toml" tugrust/crates --include="*.rs"` and route any stray reader through `Config`.

**Tests:**
- [ ] `config.rs`: `dash_declarations_parse` (both keys `Some` with the S01 values) and `dash_declarations_default_to_none`; existing `test_unknown_keys_are_ignored` stays green.
- [ ] Init: fresh-init config parses to empty/None and contains no uncommented Tugtool command.

**Checkpoint:** `cd tugrust && cargo nextest run -p tugutil-core -p tugutil` green under `-D warnings`; `git -C <worktree> diff --stat` shows `.tugtool/config.toml` carrying the two declarations.

#### Step 2: The `tugutil dash config` verb {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(dash-generality): read the declarations with dash config`

**References:** [P04], Spec S02

**Tasks:**
- [ ] `tugrust/crates/tugutil/src/cli.rs`: add `Config` to `DashCommands` with the long-about naming what it reports and that absent keys are not errors.
- [ ] `tugrust/crates/tugutil/src/dash.rs`: dispatch arm + `run_config(json, quiet)` per Spec S02 — root via `find_project_root`, load via `Config::load_from_project`, `print_ok("dash config", …)` for JSON, the text layout with `(not declared)` markers otherwise. Exit 0 in every non-error case including no-config.
- [ ] Outside a project (`find_project_root` fails): the standard not-initialized error path other dash verbs use, exit non-zero.

**Tests:**
- [ ] Temp repo with a declaring `.tugtool/config.toml`: JSON carries the three fields verbatim.
- [ ] Temp repo with `.tugtool/` present but no `config.toml`: JSON carries nulls/empty, exit 0.

**Checkpoint:** `cd tugrust && cargo nextest run -p tugutil` green; from this dash's worktree root, `<worktree>/tugrust/target/debug/tugutil dash config --json` prints Tugtool's Step 1 declarations.

#### Step 3: Skeleton and doctrine route through the declaration {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(dash-generality): the ending's docs read the declaration`

**References:** [P02], [P05], [P07], (#seam-read-at-ending), (#tugtoolism-inventory)

**Tasks:**
- [ ] `tuglaws/devise-skeleton.md`, the Integration Checkpoint pattern prose: the `Replayed`/`Recorded` sentence becomes — verify with the project's declared verify command (`tugutil dash config --json`, substitute `{base}`/`{head}` with the replayed range), which in this repo is `scripts/verify-fit.sh`, declared in `.tugtool/config.toml`; when no verify is declared, the plan's own checkpoint commands over what the replay moved, said plainly. Add one sentence for the red case: a failing verify is fixed in the warm worktree and committed as a round, then re-run — the `Conflicted` arm's own aftermath (#seam-read-at-ending). The `Current`/`Conflicted` arms and the sweep warning stay as they are.
- [ ] `tuglaws/devise-skeleton.md`, the worked Integration Checkpoint step's task list: the verify task names the declared command per above instead of the literal script.
- [ ] `tuglaws/dash-work-doctrine.md`, "The build is an offer": the build is the project's declared build command (`tugutil dash config`); in this repo that is `just app-debug`; a project that declares none offers none, and the report says the work is inspectable at the worktree.
- [ ] `tuglaws/dash-work-doctrine.md`, the verification-bar list: keep Tugtool's commands as this repo's instances but open the list with one sentence stating the portable rule — a step's checkpoint runs the commands the plan names; the ending runs the declared verify.
- [ ] No prose anywhere states or implies a join-time check; re-read the edited sections against [P02] before committing.

**Tests:**
- [ ] Prose assertions: `grep -n "verify-fit" tuglaws/devise-skeleton.md` hits only lines that also mention the declaration or "in this repo"; `grep -n "dash config" tuglaws/devise-skeleton.md tuglaws/dash-work-doctrine.md` hits both files.

**Checkpoint:** The two greps above; a read of the skeleton's ending procedure describes a project with no `scripts/` directory without breaking.

#### Step 4: The run skills speak the declaration {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(dash-generality): dash-implement and dash-on go project-general`

**References:** [P05], [P07], Spec S03, (#tugtoolism-inventory), (#seam-read-at-ending)

**Tasks:**
- [ ] `tugplug/skills/dash-implement/SKILL.md` — four rewrites: (1) Setup hydration: `post_create` "runs whatever the project declares — in Tugtool, `bun install` for the web surfaces"; (2) Setup baseline: establish it with the project's own test commands — the ones the plan's checkpoints name; when the plan names none and the project declares nothing, say the baseline is unestablished and proceed (S03 pattern); (3) the ending: replace the `scripts/verify-fit.sh` line with the declaration read + substitution + the S03 no-verify sentence, keeping the `Current`-runs-nothing and `Conflicted` arms verbatim; (4) the build offer: replace the `just app-debug` block with the declared build command (run it, confirm what it reports, relay it), the S03 no-build sentence when absent, and Tugtool's commands demoted to an "in this repo" example.
- [ ] `dash-implement` iterate phase: replace the HMR/rebuild table with the general rule — re-run the declared build when the changed surface needs it; project-specific rebuild knowledge (which surfaces hot-reload) belongs to the project's own docs, and in Tugtool it is in `CLAUDE.md`.
- [ ] `tugplug/skills/dash-on/SKILL.md` — the same four rewrites (hydration line, build block, ending's verify line, doctrine links), matching `dash-implement`'s wording so the two run skills speak identically.
- [ ] Both skills' `tuglaws/dash-work-doctrine.md` links gain the absence clause: when the project has no `tuglaws/`, the rules carried inline in this skill are the discipline, and say so.

**Tests:**
- [ ] The success-criteria grep over both files: no line presents a Tugtool command as *the* command.
- [ ] `grep -c "and say so" tugplug/skills/dash-implement/SKILL.md` ≥ 2 (verify absence + doctrine absence at minimum); ≥ 1 for `dash-on`.

**Checkpoint:** Both greps pass; a read-through of each skill imagining a repo with only `git` and `sh` produces a coherent, non-inventing run.

#### Step 5: The judgment skills degrade by name {#step-5}

**Depends on:** #step-3

**Commit:** `tugdash(dash-generality): reviews and audits name their criteria inline`

**References:** [P06], [P07], Spec S03, (#tugtoolism-inventory)

**Tasks:**
- [ ] `tugplug/skills/plan-devise/SKILL.md`: the skeleton reference gains [P06]'s clause — absent skeleton → the format summary this skill carries plus `tugutil plan lint` is the contract, and say so; the never-ask and rubric links gain the same absent-tuglaws clause as Step 4's.
- [ ] `tugplug/skills/plan-review/SKILL.md`: the existing rubric clause is the model and stays; extend the same pattern to the re-review-rules link and the never-ask link; leave the Review Record example as is (an example is allowed to be from Tugtool).
- [ ] `tugplug/skills/dash-audit/SKILL.md`: the tuglaws-adherence section gains — no `tuglaws/tuglaws.md` → audit against the axes this skill carries and name each criterion inline in the findings, and say so; the test-discipline bullet is reworded per S03's app-test row — the banned shapes are Tugtool doctrine, flagged where `tuglaws/dash-work-doctrine.md` exists; on a project without it, audit the tests against the plan's own Test Plan.
- [ ] `tugplug/skills/dash-join/SKILL.md`: the never-ask link gains the absence clause.
- [ ] `tugplug/skills/draft/SKILL.md`: neutralize the worked example paths (`src/app.ts`-style, no `tugdeck/`/`tugrust/`); no doctrinal change.

**Tests:**
- [ ] `grep -c "and say so" tugplug/skills/plan-devise/SKILL.md tugplug/skills/dash-audit/SKILL.md` each ≥ 1; `grep -n "tugdeck\|tugrust" tugplug/skills/draft/SKILL.md` empty.

**Checkpoint:** The greps pass; `plan-review`'s original rubric clause is byte-identical (the model is preserved, not paraphrased).

#### Step 6: Hooks act only on their subject {#step-6}

**Commit:** `tugdash(dash-generality): gates no-op off their subject project`

**References:** [P08], (#tugtoolism-inventory)

**Tasks:**
- [ ] `tugplug/hooks/gate-app-test-output.sh`: after the existing jq/tool/command guards, resolve the subject directory — `.cwd` from the hook payload, else `$PWD` — then the project root via `git -C "$DIR" rev-parse --show-toplevel` (fallback: the directory itself); `[ -d "$ROOT/tests/app-test" ] || exit 0`. Every resolution failure exits 0. Add the applicability rationale to the header comment block in its existing voice.
- [ ] Audit `auto-approve-tug.sh` and `gate-file-ops.sh` against [P08]; record the audit's conclusion (clean, unchanged) in the round's commit body rather than editing files that need nothing.
- [ ] `tugplug/hooks/tests/`: the runner (`run-gate-tests.sh`) builds its payload as `jq -n '{tool_name:"Bash",tool_input:{command:$c}}'` — no `cwd` field — and executes from inside the checkout, so once the guard exists every existing case resolves through the `$PWD` fallback to the Tugtool root and stays green unchanged. Extend the payload with an optional per-case `cwd` (a fourth tab-separated field in `gate-app-test-output.cases`, absent meaning "omit the field"), then add the guard cases: a piped `just app-test X` with `cwd` set to a non-Tugtool temp dir passes untouched; the same command with `cwd` set to the checkout root is still rewritten.
- [ ] Copy the changed hook into the app bundle (`Tug.app/Contents/Resources/tugplug/hooks/`) and note in the round summary that live sessions need the copy or a rebuild.

**Tests:**
- [ ] `just hooks-test` green, including the new applicability cases in both directions.

**Checkpoint:** `just hooks-test` green; manually piping a synthetic PreToolUse payload with a `/tmp` cwd through the script exits 0 with empty output.

#### Step 7: The scratch-project proof {#step-7}

**Depends on:** #step-2, #step-4, #step-5, #step-6

**Commit:** `tugdash(dash-generality): a bare project walks the whole arc`

**References:** [P05], [P07], Spec S03, (#scratch-project-shape)

**Tasks:**
- [ ] Build the worktree's CLI (`cd <worktree>/tugrust && cargo build -p tugutil`) and use it by absolute path throughout — the `~/.local/bin` symlinks run main's old code.
- [ ] Create the scratch repo per (#scratch-project-shape) under a fresh temp dir; `git init`, commit the three files; export `TUG_DATA_DIR` to a sibling temp dir for every CLI call.
- [ ] `tugutil init` there; verify the written config is the Step 1 neutral default (parse + grep).
- [ ] **Undeclared arc:** author a two-step micro-plan for the scratch project against the skeleton format (the plan's checkpoints name `sh tests/run.sh` themselves); `tugutil plan lint` exits 0 on it; `dash create <name> --plan <path>`; walk both steps with `dash step start/done` + `dash commit`; `tugutil dash config --json` reports all-undeclared; state the S03 no-verify and no-build sentences in the transcript at the moments they apply; `draft set --owner dash:<name>`; `dash replay` (expect `Current`); land with `tugutil dash join <name>` — safe here, the base is the scratch repo's own main; verify the squash landed with the draft's subject.
- [ ] **Declared arc:** second dash on the same scratch repo after writing `verify = "sh tests/run.sh"` into its config; `dash config --json` reports it. While the dash is open, land an unrelated commit directly on the scratch repo's main so `dash replay` reports `Replayed` rather than `Current` — the moved tree is what makes running the declared verify legitimate under [P02]. Run it, say the declaration was consumed, and land the dash the same way.
- [ ] **Hook applicability, live-shaped:** pipe a real-shaped PreToolUse payload (cwd = the scratch repo) with a piped `just app-test` command through the repo's `gate-app-test-output.sh`; confirm exit 0, no output.
- [ ] Record the observed transcript facts in the round's commit body (which degradation sentences fired and where); remove the scratch repo and its data dir; confirm `tugutil dash list` in the checkout shows no scratch residue.
- [ ] Note for the user (narration, not a task): the join-prompt surface on non-Tugtool repos is already pinned by the at044x fixtures; an interactive skill-driven walk in a live session on a scratch project is offered as an iterate-phase follow-up, since the prompt press is the user's.

**Tests:**
- [ ] The walk itself is the test — real CLI, real repo, both arcs, cleanup verified. No committed test artifact; the durable proof is the transcript plus the commit body.

**Checkpoint:** Both scratch dashes landed on the scratch main (two squash commits with the drafted subjects); every S03 sentence that applied appears in the transcript; no residue in the checkout's dash list or the live data root.

#### Step 8: The design decision {#step-8}

**Depends on:** #step-7

**Commit:** `tugdash(dash-generality): record the seam and the degradation doctrine`

**References:** [P01]–[P08], Spec S01, Spec S03

**Tasks:**
- [ ] Append the next `[D##]` to `tuglaws/design-decisions.md` (next free number at authoring time: D151 — confirm against the file's tail before writing): the `[tugtool.dash]` declaration seam (`post_create`/`verify`/`build`, the placeholder contract, committed config, the `dash config` reader); the degradation doctrine — absence has a stated sentence, never an invented command, in plan-review's pattern, with the S03 set named; the [D149] boundary reaffirmed — the seam serves the run's ending, the join gate stays reconcile-clean, the two rejected shapes stay rejected; init's neutral default. Cite [D149], this plan's path, and the consuming files. Use the file's existing voice and cross-reference style; edit with the file-editing tools, never a shell append.

**Tests:**
- [ ] Prose assertion: the new entry names both halves (seam + degradation doctrine) and the [D149] boundary.

**Checkpoint:** The entry reads correctly in place; its number is unique; `grep -c "D151" tuglaws/design-decisions.md` matches the expected citation count.

#### Step 9: Integration Checkpoint {#step-9}

**Depends on:** #step-8

**Commit:** `N/A (verification only)`

**References:** [P02], (#success-criteria), (#seam-read-at-ending)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command — which, as of this very plan's Step 1, `tugutil dash config --json` reports as `sh scripts/verify-fit.sh {base} {head}`; substitute and run it.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now — and it is this plan's own seam, consumed.

**Checkpoint:** The replay outcome is reported; on a moved tree the declared verify exits 0; the join draft is written and the arc is armed.

---

### Deliverables {#deliverables}

- `DashConfig` with `verify`/`build`; a neutral `tugutil init`; Tugtool's own declarations in `.tugtool/config.toml` (Step 1).
- `tugutil dash config`, JSON and text (Step 2).
- `tuglaws/devise-skeleton.md` and `tuglaws/dash-work-doctrine.md` routing the ending and the build offer through the declaration (Step 3).
- Seven skills rewritten against the seam with stated degradations: `dash-implement`, `dash-on` (Step 4); `plan-devise`, `plan-review`, `dash-audit`, `dash-join`, `draft` (Step 5).
- Applicability-guarded hooks with hooks-test pins in both directions (Step 6).
- The scratch-project proof, both arcs, in the transcript and the round record (Step 7).
- The global design decision (Step 8).
