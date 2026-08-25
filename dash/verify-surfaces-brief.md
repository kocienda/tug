# Verify the fit over every surface: the surface table and `tugutil dash verify`

**Purpose:** The run-ending's fit check — "does the tree that will actually land still build?" — is a 49-line shell script that knows two of the repository's seven built surfaces. Every dash that touches `tugcode/`, `tugproto/`, `tugplug/`, `tugapp/`, or `tests/` ends with the model noticing the blindness and covering it by hand, which is a manual pass on a step [D149] was written to make automatic. The fix is structural, not another `if touched` branch: the declaration moves from a command string to a table of surfaces, and the check becomes a Rust verb that refuses to call a tree verified while any touched path belongs to no surface.

---

## Purpose {#purpose}

In the user's words: *"Why is `scripts/verify-fit.sh` just a shell script? It feels like this should be a better, more robust piece of infrastructure. It also should cover all the code in Tug, not just some directories or sub-projects."*

What "cover all of Tug" has to mean, if it is going to be enforced rather than promised: every path a replay moved is claimed by exactly one declared surface, every surface says what checks it, and a path nobody claims stops the ending. Coverage is then a property of the table, checkable by reading it, rather than a property of whoever last edited the script.

This is cohesion, part two: the conductor brief grouped the *act* under `tugutil session`; this groups the *fit* under `tugutil dash`, where the run's other endings already live (`replay`, `mark`, `draft`).

---

## Evidence {#evidence}

**[F01] The script knows two surfaces.** `scripts/verify-fit.sh` diffs `<base>..<head>`, and its whole vocabulary is two `touched` branches: `tugrust/` → `cargo check --workspace --all-targets`; `tugdeck/` → `bunx tsc --noEmit` + `bunx vite build`. A diff touching neither prints *"no built surface moved by this replay"* and exits 0 — the same exit as a verified tree. Its `touched` helper also matches the prefix anywhere in the path (`grep -q "$1"` without an anchor as the fallback), so a file named `tugdeck-notes.md` under `dash/` would trigger the tugdeck build. **(verified)**

**[F02] Real dashes touch the surfaces it cannot see.** Of the last three dash joins on `main`: `215c57df2` (conductor) moved 2 files in `tugcode/`, 1 in `tugproto/`, 2 in `tugplug/`, 1 in `tests/`; `0acdb76a7` moved 4 in `tugcode/`, 4 in `tugplug/`, 1 in `tugproto/`, 2 in `tests/`. Both ended with the script verifying `tugrust/` and `tugdeck/` and silently passing the rest. The dash-notes carry the model's own report of the gap from an earlier run: *"`scripts/verify-fit.sh` has no `tugcode/` branch … I covered that half with the plan's own checkpoint commands and left the script alone rather than quietly changing the project's fit contract mid-run."* That sentence has now been written, in one form or another, at the end of four milestones. **(verified)**

**[F03] The declaration is a string, and four documents name the script by name.** `DashConfig::verify: Option<String>` in `tugrust/crates/tugutil-core/src/config.rs`, substituted `{base}`/`{head}` and run via `sh -c` by whoever reads it. Nothing in Rust runs it: the consumers are prose — `dash-implement/SKILL.md` §3, `dash-on/SKILL.md`, `tuglaws/dash-work-doctrine.md` ("A checkpoint that passed is spent"), and the devise skeleton's Integration Checkpoint pattern — and each one says *"in Tugtool that is `sh scripts/verify-fit.sh {base} {head}`"*. `tugutil dash config` reports the string and does nothing with it. **(verified)**

**[F04] Every surface already has a check; they are just declared in five different places.** `justfile` `build`/`lint`/`test-rust`/`test-ts`, `build-app` steps 1–4, `app-test-covers-check`/`app-test-foreground-check`, and the two `package.json` files between them name: for `tugrust/`, `cargo clippy --workspace --all-targets -- -D warnings` (subsumes `check`) and `cargo nextest run --workspace`; for `tugdeck/`, `bunx tsc --noEmit`, `bunx vite build`, `bun test`; for `tugcode/`, `bun test` and a `bun build --compile` of `src/main.ts` and `src/pulse/main-pulse.ts`, plus `bunx tsc --noEmit` (no `check` script declared, but the compiler runs clean there — the dash-notes report "tsc clean in both consumers"); for `tugapp/`, `xcodebuild … -scheme Tug -configuration Debug build` through `tugrust/scripts/xcodebuild-quiet.sh`; for `tests/`, `bun test scripts/ _harness/` and the two `select-tests.ts` checks. `just ci` is `lint test` and runs the union of these unscoped. **(verified)**

**[F05] `tugproto/` has no check of its own and needs none — it is checked by its consumers.** It is `src/` alone, no `package.json` scripts; `tugdeck/tsconfig.json` and `tugcode/tsconfig.json` both alias `@tugproto/*` to `../tugproto/src/*`. A change there is verified by `tsc` in both consumers and by nothing else, so a surface has to be able to say "my check is these other surfaces' checks". **(verified)**

**[F06] `tugplug/` has no check at all.** Two shell hooks (`auto-approve-tug.sh`, `gate-file-ops.sh`), a `hooks.json`, and ten `skills/*/SKILL.md` with YAML frontmatter that Claude Code parses at load. Nothing in the tree runs `sh -n` on the hooks, parses the JSON, or reads a skill's frontmatter for the fields the plugin loader requires. A malformed `SKILL.md` is discovered when a user types the slash command and gets nothing. **(verified)**

**[F07] `tests/` is a surface whose check is a selection, not a command.** The corpus is never swept; `just app-test-changed <paths>` derives the run from `@covers` declarations over the paths it is given. So the right fit check for a replay that moved `tugdeck/`, `tugapp/`, or `tests/` files is that selection over exactly the moved paths — which is a placeholder the current `{base}`/`{head}` contract cannot express. **(verified)**

**[F08] The replay is where `base` and `head` come from, and the verify never gates the join.** `tugutil dash replay` reports `Replayed`/`Recorded`/`Current`/`Conflicted` (`Integration` in `tugdash-core/src/ops.rs`); the range the ending verifies is the replayed one. [D149]: the join gate is reconcile-clean alone; a red verify is "ordinary work" that never reaches the join. Nothing about that changes here — the verb is the ending's, and the join stays ignorant of it. **(verified)**

**[F09] The repository has more unbuilt paths than built ones.** `tuglaws/`, `dash/`, `aside/`, `assets/`, `capabilities/`, `diag/`, `products/`, `resources/`, `scripts/`, `.tugtool/`, and the root files (`CLAUDE.md`, `README.md`, `justfile`, `THIRD_PARTY_NOTICES.md`, `LICENSE`). A refusal-on-unmatched rule that did not let a surface declare *no checks* would refuse every dash that edited a tuglaw. **(verified)**

---

## Decisions {#decisions}

**[B01] The declaration is a surface table, and it replaces `verify` outright.** `[[tugtool.dash.surface]]` entries in `.tugtool/config.toml`, each with a `name`, a list of `paths` (repo-relative prefixes, or exact paths for root files), and a list of `check` commands. `DashConfig::verify` is deleted; a config that still declares `verify =` is refused by the loader with a message naming the table. No compatibility shim, no both-forms period — the string had one consumer and it was prose.

**[B02] A touched path matching no surface is a refusal.** `tugutil dash verify` diffs the range, resolves every path to a surface by longest declared prefix, and if any path resolves to none, prints them and exits non-zero *before running a single check*. The message names the paths and says what to do: declare a surface for them. This is the mechanism that turns "covers all of Tug" from a sentence into a property: the table is complete iff the verb never refuses, and the verb refuses the first time it is not.

**[B03] A surface may declare no checks, and that is a declaration.** `check = []` on `tuglaws/`, `dash/`, and the rest of [F09] says *these paths are claimed and there is nothing to run*; the receipt lists them as `claimed, unchecked` so a reader can see the claim was deliberate. An unlisted path is never silently treated as prose — that is the difference between this and the script's "no built surface moved".

**[B04] A surface may be checked by other surfaces' checks.** `checked_by = ["tugdeck", "tugcode"]` on `tugproto/` runs those surfaces' `check` lists as its own ([F05]). Resolution is one level deep and the loader refuses a cycle. This is what keeps the table from repeating a command under two names.

**[B05] Three placeholders, and `{paths}` is the new one.** `{base}` and `{head}` keep their meaning. `{paths}` expands to the space-separated, shell-quoted list of touched paths *within that surface*, which is what `tests/`' selection needs ([F07]) and what lets `tugdeck/`'s checks include `just app-test-changed {paths}` rather than a sweep. A command carrying none of the three runs unscoped, exactly as today.

**[B06] The verb is `tugutil dash verify <name>`.** It runs from anywhere: `<name>` resolves the dash's worktree, and the range defaults to what the dash's last `replay` moved — the plan settles where that range is recorded (the dash-log's replay line or the replay's own receipt) and adds `--base`/`--head` for an explicit one. Checks run from the worktree root with the surface's commands in declared order, stopping at the first red inside a surface but running every surface so one report names every failure. The output is a per-surface table and a closing `TUG-VERIFY-RECEIPT:` line — `verified <head> · 4 surfaces checked · 2 claimed unchecked`, or the refusal, or the first red command's exit and its surface. `--json` carries the same document.

**[B07] The result is a document fact.** A green verify writes `verified <head>` to the dash-log, so the Lens, the join receipt, and the arc can all say whether the tree that is about to land was verified at that head — and *say so*, never gate on it ([F08], [D149]). A verify at a head the branch has since moved past is stale, and the faces say that too. This is what lets the arc's implement stage end on a fact it read rather than on the skill remembering to run something.

**[B08] This repository's table, as the plan lands it.** `tugrust/` → clippy `-D warnings` and `cargo nextest run --workspace`; `tugdeck/` → `bunx tsc --noEmit`, `bunx vite build`, `bun test`, `just app-test-changed {paths}`; `tugcode/` → `bunx tsc --noEmit`, `bun test`, both `bun build --compile` lines; `tugproto/` → `checked_by = ["tugdeck", "tugcode"]`; `tugapp/` → the quiet `xcodebuild … build` from `build-app` step 4 and `just app-test-changed {paths}`; `tugplug/` → `sh -n` over `hooks/*.sh`, a JSON parse of `hooks/hooks.json`, and a skill-frontmatter check over `skills/*/SKILL.md` — the last is new and small, and lands as `tugutil skill lint` so the check is a verb rather than a one-liner nobody can run by hand ([F06]); `tests/` → `bun test scripts/ _harness/`, `just app-test-covers-check`, `just app-test-foreground-check`, `just app-test-changed {paths}`; and every path in [F09] as `check = []`. `just ci` is not changed by this brief, but the table is now the one place the per-surface commands are written, and a later change may make `ci` read it.

**[B09] The four prose consumers name the verb, and the script is deleted.** `dash-implement`, `dash-on`, `dash-work-doctrine.md`, and the devise skeleton's Integration Checkpoint pattern stop saying *"in Tugtool that is `sh scripts/verify-fit.sh …`"* and say *run `tugutil dash verify <name>`; a refusal names the paths to declare; red is ordinary work*. `scripts/verify-fit.sh` goes with them. The "project declares none" fallback survives only as the empty table: a project with no `[[surface]]` entries gets the current degrade — the plan's own checkpoint commands, stated plainly — and the verb says so rather than refusing.

---

## Open Questions {#open-questions}

- **Where does the replayed range live between `replay` and `verify`?** `Integration` is computed and printed; whether the dash-log records the moved range is what decides whether `tugutil dash verify <name>` can default it ([B06]). The devise round reads `run_replay` and the dash-log writers and either finds the line or adds one.
- **Is `cargo nextest run --workspace` too much for `tugrust/`'s fit check?** The three-crate run is 37 s; the workspace is longer, and the script today runs only `cargo check`. The argument for tests in the fit is [D149]'s own: the per-step checkpoints proved the sandbox, and a replay onto a moved base can break a test without breaking the build. The devise round times the workspace run and, if it is under two minutes, keeps it; otherwise the table names the crates the diff touched via `{paths}` → `-p` resolution, which the plan then has to build.

---

## Non-goals {#non-goals}

- **Making the verify gate the join.** [D149] stands: reconcile-clean is the gate; the verify is the ending's, and [B07] records rather than blocks.
- **A generic task runner.** The verb runs declared shell commands in declared order and reports. It does not cache, parallelize across surfaces, or retry; `just` and `cargo` do their own.
- **Replacing `just ci`.** Named as a seam in [B08], deliberately not crossed here.
- **Globs in `paths`.** Prefixes and exact paths only. A surface that needs a glob is two surfaces.
- **Renaming `tugutil`.** Settled elsewhere; cohesion is grouping under it.

---

## Exit {#exit}

**A plan**, at `dash/verify-surfaces.md`. Its shape:

1. The schema: `Surface { name, paths, check, checked_by }` in `tugutil-core/src/config.rs`, the loader's refusal of `verify =`, cycle and duplicate-prefix refusals, and `tugutil dash config` reporting the table. Table tests over parsing and resolution — longest-prefix wins, root files as exact paths, an unmatched path is a named refusal.
2. The verb: `tugutil dash verify <name> [--base --head] [--json]` in `tugutil/src/dash.rs` over a pure `tugdash-core` resolver (diff paths → surfaces → command list with placeholders expanded), the per-surface run-and-report, and the `verified <head>` dash-log line.
3. `tugutil skill lint` and the `tugplug/` surface ([F06]).
4. This repository's table ([B08]), the deletion of `scripts/verify-fit.sh`, and the prose consumers ([B09]).
5. The faces: the dash-log line read by `dash status`, the Lens row, and the join receipt as `fit verified at <head>` / `not verified since <head>`.
6. Cover it: a Rust test per [B02]/[B03]/[B04] rule; an app-test that a dash whose replay moved an undeclared path shows the refusal on the card and that declaring the surface clears it; the conductor dash's own ending run through the verb as the live check — the first time a `tugcode/` change is verified by the declared fit rather than by the model's conscience.

The devise round settles both open questions by reading `run_replay` and timing the workspace test run; nothing here is left for the owner to decide.

The phase boundary is the deletion of the script: once `tugutil dash verify` is what every consumer names and the table refuses an unclaimed path, the legacy sweep (the fourth brief in this series) can treat "a path no surface claims" as one of its own findings rather than as a fit gap.
