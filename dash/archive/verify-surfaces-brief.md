# Verify the fit: a project declares its surfaces, and the dash verifies the tree it will land

**Purpose:** A dash ends by verifying the fit — the dash replayed onto the live base, which is the tree a join will actually land ([D149]). Today that verification is a shell command the project declares as one string, run by a skill reading prose. Tug's own declaration is a script that knows two of the repository's directories, and it has been discovered blind at the end of four runs. The requirement is not "verify Tug". It is: **verify whatever project the dash is on, on that project's own terms, and make the verification something the dash can prove rather than something a run remembers to do.**

---

## Purpose {#purpose}

A dash can be created in any project that has a `.tugtool/` marker. The project may be a Rust workspace, a Rails app, a Swift package, a repository with one `Makefile`, or a directory of prose. Tug cannot know what "this tree is good" means there; the project has to say. What Tug *can* own is the shape of the saying and the enforcement of it: every path the replay moved is claimed by something the project declared, every claim's checks ran, and the result is a fact the dash carries into its join.

The feature is therefore two things — a declaration a project writes once, and a verb that reads it — and neither may know anything about Tug's own tree.

---

## Evidence {#evidence}

**[F01] The declaration is one command string, and the consumer is prose.** `DashConfig::verify: Option<String>` in `tugrust/crates/tugutil-core/src/config.rs`, with `{base}`/`{head}` substituted from the replayed range and run via `sh -c` from the worktree root. Nothing in Rust runs it. The readers are `dash-implement/SKILL.md` §3, `dash-on/SKILL.md`, `tuglaws/dash-work-doctrine.md`, and the devise skeleton's Integration Checkpoint pattern, each instructing the model to fetch the string from `tugutil dash config --json`, substitute, and run it. `tugutil dash config` reports the string and does nothing with it. **(verified)**

**[F02] A string cannot say what it covers.** The command is opaque to Tug: whether it checks every path the replay moved, some of them, or none is not a question the verb can ask of it. Tug's own instance, `scripts/verify-fit.sh`, branches on two directory prefixes and exits 0 with "no built surface moved" for a diff touching anything else — the same exit as a verified tree. Of the last three dash joins on `main`, two moved files under directories the script does not name. The model noticed each time, verified by hand, and reported the gap; the dash-notes hold one such report verbatim. A declaration that can be silently partial is one that will be. **(verified)**

**[F03] The scoping a real check needs is per-path, and the contract cannot express it.** A project's checks are not all "build the world": a test-selection command wants the paths that moved, a per-package build wants the packages that moved. `{base}` and `{head}` give a command the range and leave it to re-derive the paths itself, which is exactly what the script does in shell and exactly what a declared command in a foreign project would have to reinvent. **(verified)**

**[F04] "Declares none" is already a state, and it degrades honestly.** A project with no `verify` sends the ending to the plan's own checkpoint commands over what the replay moved, stated plainly. That fallback is right for a project that has declared nothing and stays; what is missing is the middle state — a project that declared *something*, for *some* of its paths — which today reads as fully verified. **(verified)**

**[F05] The verify never gates the join, and the join never reads it.** [D149]: the join gate is reconcile-clean alone; a red verify is ordinary work in the warm worktree. But because the result is never recorded, nothing on the dash — not `dash status`, not the Lens row, not the join receipt — can say whether the tree about to land was verified, or at which head. **(verified)**

---

## Decisions {#decisions}

**[B01] A project declares surfaces, not a command.** A surface is a name, the repo-relative path prefixes (or exact paths) it claims, and the list of check commands that verify it. The declaration lives in the project's `.tugtool/config.toml` as `[[tugtool.dash.surface]]` entries and replaces `verify` outright: a config still declaring `verify =` is refused by the loader with a message naming the table. No shim and no both-forms period — the string had one consumer and it was prose. The schema knows nothing about any particular project; it is path prefixes and shell commands.

**[B02] A touched path matching no surface is a refusal.** The verb diffs the replayed range, resolves every path to a surface by longest declared prefix, and if any path resolves to none, prints them and exits non-zero *before running a check*. The message names the paths and says what to do: declare a surface for them. This is the enforcement: a project's table is complete exactly when the verb never refuses, and the first incomplete dash is the one that says so.

**[B03] A surface may declare no checks, and that is a declaration.** `check = []` says *these paths are claimed and there is nothing to run* — prose, fixtures, generated artifacts. The receipt lists such surfaces as `claimed, unchecked` so the claim is visible. An unlisted path is never treated as prose by default; that is the difference between this and a script's "nothing built here".

**[B04] A surface may be checked by other surfaces' checks.** `checked_by = ["a", "b"]` runs those surfaces' commands as its own, for a source directory that has no build of its own and is verified by its consumers. One level deep; the loader refuses a cycle.

**[B05] Three placeholders.** `{base}` and `{head}` keep their meaning. `{paths}` is new: the shell-quoted list of touched paths *within that surface*, for the selection- and package-scoped checks of [F03]. A command carrying none of the three runs unscoped.

**[B06] The verb is `tugutil dash verify <name>`.** `<name>` resolves the worktree; the range defaults to what the dash's last `replay` moved, with `--base`/`--head` for an explicit one. Checks run from the worktree root in declared order; a red command ends its surface, but every surface runs so one report names every failure. Output is a per-surface table and a closing `TUG-VERIFY-RECEIPT:` — `verified <head> · N surfaces checked · M claimed unchecked`, or the refusal with its paths, or the first red command per surface with its exit. `--json` carries the same document. `tugutil dash config` reports the table.

**[B07] The result is a document fact.** A green verify writes `verified <head>` to the dash-log. `dash status`, the Lens row, and the join receipt read it and say *fit verified at `<head>`* or *not verified since `<head>`* when the branch has moved past it — and say it only ([D149], [F05]). This is what lets an ending — the skill's or the arc's implement stage — rest on a fact it can read rather than on remembering to run something.

**[B08] "Declares none" stays, and is the empty table.** A project with no `[[surface]]` entries keeps [F04]'s degrade: the verb says the project declares no surfaces and the ending falls back to the plan's own checkpoint commands, stated plainly. It does not refuse — refusal is for a project that declared and left a gap, not for one that has not declared yet.

**[B09] The consumers name the verb, and Tug's script is deleted.** The four prose readers of [F01] stop describing a substitute-and-run procedure and say *run `tugutil dash verify <name>`; a refusal names the paths to declare; red is ordinary work*. `scripts/verify-fit.sh` goes, and this repository's own `.tugtool/config.toml` gets its surface table as part of the same change — as an instance of the feature, written against the same schema any project would use, and carrying no decision this brief needs to make.

---

## Open Questions {#open-questions}

- **Where does the replayed range live between `replay` and `verify`?** Whether the dash-log records the range `replay` moved decides whether `verify <name>` can default it ([B06]). The devise round reads `run_replay` and the dash-log writers and either finds the line or adds one.

---

## Non-goals {#non-goals}

- **Knowing any project's build.** The verb runs what the table says. It infers nothing from a `Makefile`, a `package.json`, or a `justfile`, and it ships no default table.
- **Gating the join on the verify.** [D149] stands; [B07] records, never blocks.
- **A task runner.** Declared commands, declared order, one report. No caching, no parallelism across surfaces, no retries.
- **Globs in `paths`.** Prefixes and exact paths. A surface that needs a glob is two surfaces.

---

## Exit {#exit}

**A plan**, at `dash/verify-surfaces.md`. Its shape:

1. The schema — `Surface { name, paths, check, checked_by }` in `tugutil-core/src/config.rs` — with the loader's refusal of `verify =`, of a cycle, and of two surfaces claiming one prefix; `tugutil dash config` reporting the table. Table tests over resolution: longest prefix wins, exact root paths, an unmatched path is a named refusal, an empty table is the declared-none state.
2. The verb — `tugutil dash verify <name> [--base --head] [--json]` — over a pure `tugdash-core` resolver (paths → surfaces → expanded commands), the run-and-report, and the `verified <head>` dash-log line.
3. The faces: `dash status`, the Lens row, and the join receipt reading the line.
4. The consumers ([B09]): the four documents, the script's deletion, and this repository's table in `.tugtool/config.toml`.
5. Cover it: a Rust test per [B02]/[B03]/[B04]/[B08] rule against a synthesized project directory that is not Tug; an app-test that a dash whose replay moved an unclaimed path shows the refusal on the card and that declaring the surface clears it.

The devise round settles the one open question by reading `run_replay`; nothing here is left for the owner to decide.
