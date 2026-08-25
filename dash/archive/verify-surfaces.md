## Verify the fit: a project declares its surfaces, and a verb checks the tree a join will land {#verify-surfaces}

**Purpose:** Replace `[tugtool.dash].verify` — one opaque command string consumed only by prose — with a per-project **surface table** and a `tugutil dash verify <name>` verb that resolves every path a replay moved to a declared surface, refuses when any path resolves to none, runs the declared checks, and records the result as a fact the dash's faces can read.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | `tugdash/verify-surfaces` |
| Last updated | 2026-08-25 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-25, opus.** Reviewed `plan:a56497a231aa6d78`. Lint: 0 errors, 1 warning (this section, added). Oriented on: the whole document — a first pass, `rounds: 0`.
Applied, all grounded in the code the plan names: **staleness** — [S05] derived `FitFact.current` from the dash branch tip alone, so a base that moved after a green verify left every face saying `fit verified` about a tree a join would no longer land; asked, and the user chose to record the base sha too, so `FitFact` is now `{ head, base, current }` and the dash-log note carries both endpoints ([S05], [P09], Steps 4–6). **A hole in the resolver** — an empty range fell through to `Planned(vec![])`, whose green path under [P09] would have appended a `verified` line for a run that checked no bytes, which is [F02] in a quieter voice; added [P13] and the `NothingTouched` variant ahead of `DeclaresNone`. **A parser that would have broken** — Step 6 said to parse the new `fit:` line "exactly as `FILES_PREFIX` is handled", but `parseJoinReceipt` tests `lines[1]?.startsWith(FILES_PREFIX)` at a *fixed index*, so inserting a line above `files:` silently orphans the file list on every future join; rewritten as a cursor, with a regression case per shape. **Facts corrected against the tree** — Step 1's "the one existing assertion that reads the retired key" is four sites, and one of them (`cli_integration_tests.rs` ~L278) *writes* a config declaring `verify`, which under [P01] stops loading rather than stops asserting; `branch_name`/`dash_base`/`worktree_path`/`main_repo_root` are `pub(crate)`, so Step 3's range derivation must live inside `tugdash-core` rather than in `tugutil/src/dash.rs`; the fixture's `tugutil()` helper throws on non-zero exit and cannot express Step 5's exit-2 assertion; and a bare `tugutil` from a worktree resolves through `~/.local/bin` to the **main** checkout's build, so Steps 5, 7 and 8 now name the binary by absolute path. **Two unrunnable checkpoints** — Step 7's tree-wide `verify-fit` grep cannot pass while `dash/` holds this feature's own brief, notes and plan, and its `{base}` grep hits [D151]; both rescoped. **A missing artifact** — no step recorded the decision, leaving [D151]'s *"Two optional keys join it: `verify`…"* as a resting lie about a key the loader now refuses; added the `[D###]` task to Step 7 in that document's own supersession voice. **Law discipline** — Step 5 touches `tugdeck/src/components/tugways/`, so the round's commit body must name [L02] and [L06]; added as a task.
Not changed: [T01] was checked against `git ls-files` and genuinely claims every tracked top-level entry, including the three tracked `tests/` subdirectories; the plan's readings of `read_declarations`, `is_terminal`, `format_join_summary`, `JoinOutcome` and `ConflictMessage` are all accurate; and the `wasm`-shadows-`deck` and `proto`-`checked_by` cases are real instances in this tree, not invented ones. Nothing was deferred — the one judgment call was asked and settled, so this plan carries no `[Q##]` beyond the already-decided [Q01].

---

### Phase Overview {#phase-overview}

#### Context {#context}

A dash ends by verifying the **fit** — the dash replayed onto the live base, which is the tree a join will actually land ([D149]). Today that verification is a single command string a project declares as `[tugtool.dash].verify`, and *nothing in Rust runs it*. The consumers are four prose documents and one Rust message composer, each instructing a model to fetch the string from `tugutil dash config --json`, substitute `{base}`/`{head}`, and run it via `sh -c` from the worktree root.

A string cannot say what it covers. Tug's own instance, `scripts/verify-fit.sh`, branches on exactly two directory prefixes (`tugrust/`, `tugdeck/`) and exits **0** with `no built surface moved by this replay` for a diff touching anything else — the same exit code as a verified tree. Of the last three dash joins on `main`, two moved files under directories the script does not name; `dash/dash-notes.md` records one such report verbatim (a run whose tugcode and tugproto changes the declared fit check was blind to). A declaration that can be silently partial is one that will be.

The scoping a real check needs is also per-path, and `{base}`/`{head}` cannot express it: a test-selection command wants the paths that moved, a per-package build wants the packages that moved, and a declared command is left to re-derive both in shell — which is exactly what `verify-fit.sh` does.

Finally, the result is never recorded. Nothing on a dash — not `tugutil dash status`, not the Lens row, not the join receipt — can say whether the tree about to land was verified, or at which head.

The declaration seam this plan extends is [D151]'s: optional keys under `[tugtool.dash]` in a project's own committed `.tugtool/config.toml`, parsed by `DashConfig` in `tugrust/crates/tugutil-core/src/config.rs`, reported by `tugutil dash config`. The full argument for the feature's shape is in [verify-surfaces-brief.md](verify-surfaces-brief.md), whose `[B01]`–`[B09]` decisions this plan implements without reopening.

#### Strategy {#strategy}

- Land the **schema and its refusals first** (`Surface` in `tugutil-core`), so every later step has a validated table to read and the retired `verify` key is refused from the first commit.
- Put the resolution rules — paths → surfaces → expanded commands — in a **pure module** in `tugdash-core` with no IO, so `[B02]`/`[B03]`/`[B04]`/`[B05]`/`[B08]` are table tests over a synthesized table rather than integration tests over Tug's own tree.
- Then the **verb**: range derivation, the runner, the report, `--json`, the exit codes.
- Then the **fact and the faces**, in the order the fact travels: dash-log line → `DashDeclarations` → `dash status` → the changeset wire entry → the meta line → the join receipt. Each is additive and reads as *nothing to say* when absent.
- Then the **consumers**: the five readers of the old string, the script's deletion, and this repository's own table — last, so the table is written against a schema that already exists and a verb that can be run against it.
- Never touch the join gate. [D149] stands: the fit fact records, it never blocks.

#### Success Criteria (Measurable) {#success-criteria}

- A config declaring `verify = "…"` fails to load with a message naming `[[tugtool.dash.surface]]` (Rust test, [Step 1](#step-1)).
- A touched path matching no declared surface makes `tugutil dash verify` exit non-zero, name the paths, and run **no check** (Rust table test, [Step 2](#step-2); CLI test, [Step 3](#step-3)).
- A surface declaring `check = []` reports `claimed, unchecked` and is counted separately from a checked surface in the receipt (Rust table test, [Step 2](#step-2)).
- A surface declaring `checked_by = ["deck", "code"]` runs those surfaces' commands as its own; a cycle and an unknown name are both loader refusals (Rust tests, [Step 1](#step-1), [Step 2](#step-2)).
- `{base}`, `{head}`, and `{paths}` expand as [Spec S02](#s02-placeholders) says, with `{paths}` shell-quoted and scoped to the surface the command runs for (Rust table test, [Step 2](#step-2)).
- A project with no `[[surface]]` entries gets the declared-none report and **exit 0** (Rust table test, [Step 2](#step-2); CLI test, [Step 3](#step-3)).
- A green verify writes one `verified` line to the dash-log naming both endpoints, and `tugutil dash status` reports `Fit: verified at <head>` — and `not verified since <head>` once **either** the dash branch or the base moves past the recorded pair (Rust tests, [Step 4](#step-4)).
- A range that touched nothing exits 0, says so, and writes no fit fact (Rust table test, [Step 2](#step-2); CLI test, [Step 3](#step-3)).
- A dash's lane row in the Changes shade shows a `fit verified` fact after a green verify, and the refusal is visible from the same fixture (app-test, [Step 5](#step-5)).
- `scripts/verify-fit.sh` no longer exists and no document instructs a model to substitute `{base}`/`{head}` into a declared command (prose assertion + `grep`, [Step 7](#step-7)).
- This repository's `.tugtool/config.toml` declares a surface table under which `tugutil dash verify` refuses nothing for a diff touching any tracked top-level path (prose assertion, [Step 7](#step-7)).

#### Scope {#scope}

1. The `Surface` schema and its loader refusals in `tugutil-core/src/config.rs`; `tugutil dash config` reporting the table; the `DEFAULT_CONFIG` template.
2. A pure resolver module in `tugdash-core` — path resolution, `checked_by` expansion, placeholder substitution, command de-duplication.
3. The `tugutil dash verify <name> [--base <sha>] [--head <sha>] [--json]` verb: range derivation, runner, report, receipt line, exit codes.
4. The fit fact: the `verified` dash-log line, `DashDeclarations.last_verified`, and `tugutil dash status`.
5. The fit fact on the wire and on the faces: `DashDetail` → the changeset entry → `dashMetaFacts` in the Lens row and the Changes shade.
6. The join receipt's optional `fit:` line — server format and deck parser.
7. The consumers: five prose/code readers of the old string, the deletion of `scripts/verify-fit.sh`, the design-decision entry that retires [D151]'s `verify` key, and this repository's own surface table.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Knowing any project's build.** The verb runs what the table says. It infers nothing from a `Makefile`, a `package.json`, or a `Justfile`, and it ships no default table.
- **Gating the join on the verify.** [D149] stands; the fit fact records, never blocks. No declared command is ever run at join time.
- **A task runner.** Declared commands, declared order, one report. No caching, no parallelism across surfaces, no retries. (De-duplicating two *identical* expanded command strings within one run is not caching — see [P07].)
- **Globs in `paths`.** Prefixes and exact paths only. A surface that needs a glob is two surfaces.
- **A migration shim.** `verify` had one consumer and it was prose; there is no both-forms period.
- **Changing what `dash replay` records.** The `replayed` note keeps its current shape; the range is derived instead ([P06]).

#### Dependencies / Prerequisites {#dependencies}

- [D151]'s declaration seam: `DashConfig` in `tugrust/crates/tugutil-core/src/config.rs`, `run_config` in `tugrust/crates/tugutil/src/dash.rs`, `DEFAULT_CONFIG` (also in `config.rs`, consumed by `tugutil/src/commands/init.rs`).
- [D149]'s ending doctrine: the run ends at the replay + the scoped verification; the join gate is reconcile-clean alone.
- `toml_edit` is already a direct dependency of `tugutil-core` (used by `set_docs_dir`); no new crate is needed for the schema work.
- The app-test dash fixture `tests/app-test/dash-fixture.ts`, which owns a **scratch repository** and a redirected `TUG_DATA_DIR` — the only sanctioned way to cut a real dash from an app-test.

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` enforces `-D warnings`; `cargo build` and `cargo nextest run` both fail on any warning.
- `Config::load_from_project` is called from hot-ish paths (`plan_search_dirs`, `dash_detail_entries_in` neighbours, `tugcast`'s base-motion feed at `tugrust/crates/tugcast/src/feeds/base_motion.rs`). Validation must be cheap and must not turn a missing config file into an error — a missing file still yields `Config::default()` and exits 0.
- Dash-log lines are **append-only and never rewritten**; a new marker must be invisible to stage derivation (`read_declarations` in `tugrust/crates/tugdash-core/src/dash.rs` matches markers by name and ignores unknown ones, but `last_activity` is set for every surviving line).
- The join receipt's summary string is formatted **once, on the server** (`format_join_summary` in `tugrust/crates/tugcast/src/feeds/changeset.rs`) and parsed in the deck; a live append and a ledger restore must render byte-identically.
- Tug's own `.tugtool/config.toml` is comment-heavy by design. Edits to it are hand-authored, not serde round-trips.

#### Assumptions {#assumptions}

- Every project that declares surfaces commits `.tugtool/config.toml`, so the table rides the dash branch into every worktree — the same property `post_create`/`verify`/`build` already rely on.
- A dash's contribution is exactly `merge-base(<base branch>, tugdash/<name>) .. tugdash/<name>`, which is what a join lands and therefore what "the fit" means ([P06]).
- Surface names are short identifiers a human types on a report line; they are not paths and carry no ordering meaning beyond declaration order.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where does the replayed range live between `replay` and `verify`? (DECIDED) {#q01-replayed-range}

**Question:** The brief left one question open: whether the dash-log records the range `dash replay` moved, so that `tugutil dash verify <name>` can default its range from it — and, if not, whether a line should be added.

**Why it matters:** If the default range is wrong, every check runs over the wrong diff and the refusal in [P02] fires on paths that did not move.

**Plan to resolve:** Read `run_replay` and the dash-log writers in the devise round.

**Resolution:** DECIDED (see [P06]). The devise round read `replay_onto` and `replayed_note` in `tugrust/crates/tugdash-core/src/replay.rs` and found the recorded note to be an unsuitable source on two counts, both load-bearing:

1. **It is abbreviated.** `replayed_note` writes `onto <base>: <old>-><new>[, …]` with every hash passed through `abbreviate(repo, …, 9)`. Nine characters is a display convenience, not an identity a later verb should re-derive a diff from.
2. **Its tail is not the head.** `reconcile_ledger_cells` can land a *remap* commit **after** the compare-and-swap, so the branch tip a replay leaves is one commit past the mapping's last `new` id whenever the plan ledger had cells to rewrite. A range defaulted from the note would silently omit that commit's changes.

So no dash-log line is added for the range, and `replayed_note` is left exactly as it is. The range is **derived live** from git instead — see [P06], which also makes `verify` answerable for a dash that has never been replayed at all.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A loader refusal breaks every read path | high | med | Refusals fire only on a *present and malformed* table; a missing file and an absent table both stay `Ok` | Any caller of `Config::load_from_project` starts reporting an error for a config it read yesterday |
| `just build-app` on the `tugapp` surface makes some endings slow | med | med | Declaration is per-project and one line to change; the surface exists so a Swift change is checked *at all*, which today it is not | An ending routinely spends minutes on a Swift-only round |
| A surface table drifts behind a new directory | med | high | This is the feature working: [P02] refuses and names the path | — |
| The join receipt's new line breaks the deck's parser on old rows | med | low | The line is optional and prefix-detected, exactly like `files:`; an absent line takes the same path a pre-line receipt already takes | A restored receipt falls back to the generic shell block |

**Risk R01: the loader refusal is too broad** {#r01-loader-refusal}

- **Risk:** `Config::load_from_project` is read from `tugcast`'s base-motion feed, from `plan_search_dirs`, and from `dash create`'s hydration; a validation error thrown for an unrelated reason would take all of them down at once.
- **Mitigation:**
  - Validate only what [Spec S01](#s01-surface-schema) declares, and only when the key that declares it is present.
  - A missing config file keeps returning `Config::default()` with no validation at all.
  - Cover each refusal with a Rust test that also asserts a *neighbouring valid* config still loads.
- **Residual risk:** A project whose committed config declares `verify =` cannot be read at all until it is edited. That is the intended [B01] behavior, not an accident — but it means the first `git pull` after this lands is the moment a stale config announces itself.

**Risk R02: the fit fact is read as a gate** {#r02-fact-read-as-gate}

- **Risk:** A face that says *not verified since `<head>`* invites somebody to make the join wait for it, reopening the debate [D149] closed.
- **Mitigation:** The fact is worded as a statement, never a blocker; it is not added to `join_blockers_from_detail`, and the plan's non-goals name this explicitly.
- **Residual risk:** None mechanical; the discipline is prose, held by [D149].

---

### Design Decisions {#design-decisions}

#### [P01] A project declares surfaces, not a command; a surviving `verify =` is a loader refusal (DECIDED) {#p01-surfaces-replace-verify}

**Decision:** `[tugtool.dash].verify` is retired. A project declares zero or more `[[tugtool.dash.surface]]` entries — a `name`, the repo-relative `paths` it claims, and either `check` (a list of shell commands) or `checked_by` (a list of other surface names). A config that still declares `verify = "…"` is refused by the loader with a message naming `[[tugtool.dash.surface]]`. No shim and no both-forms period.

**Rationale:**
- Follows [B01]. The string had exactly one class of consumer — prose — and prose is what this plan is rewriting anyway.
- A silently-ignored retired key is the failure mode that produced [F02]: a declaration that looks like coverage and is not.
- The schema knows nothing about any particular project; it is path prefixes and shell commands.

**Implications:**
- `DashConfig` keeps a field bound to the `verify` key, but only so the loader can *detect and refuse* it — nothing reads its value.
- `tugutil dash config` reports the table instead of the string; `run_config`'s `ConfigPayload` changes shape.
- `DEFAULT_CONFIG` (the template `tugutil init` writes) replaces its commented `verify` example with a commented surface example.

#### [P02] A touched path matching no surface is a refusal, before any check runs (DECIDED) {#p02-unclaimed-is-refusal}

**Decision:** `tugutil dash verify` diffs the range, resolves every touched path to a surface by **longest declared prefix**, and if any path resolves to none it prints them, prints how to declare a surface for them, and exits non-zero **without running a single check**.

**Rationale:**
- Follows [B02]. This is the enforcement the string could never carry: a project's table is complete exactly when the verb never refuses, and the first incomplete dash is the one that says so.
- Refusing *before* running means the report is about the gap, not about a green check that happened to be beside it.

**Implications:**
- Resolution is pure and total: it returns either a full assignment or the list of unclaimed paths.
- Exit code `2`, distinct from a red check's `1` — see [P08].
- The empty table is not a refusal; it is [P11].

#### [P03] `check = []` is a declaration, reported as `claimed, unchecked` (DECIDED) {#p03-empty-check-is-a-declaration}

**Decision:** A surface may declare an empty `check` list. It means *these paths are claimed and there is nothing to run* — prose, fixtures, generated artifacts. The report lists such surfaces as `claimed, unchecked`, and the receipt counts them separately from checked surfaces.

**Rationale:**
- Follows [B03]. The difference between this and a script's "nothing built here" is that somebody wrote the claim down and the receipt shows it.
- An unlisted path is never treated as prose by default; that is what [P02] is for.

**Implications:**
- The receipt's shape is `verified <head> · N surfaces checked · M claimed unchecked`, so the two counts can never be conflated.
- A surface with `check = []` and no `checked_by` is legal; a surface with **both** `check` and `checked_by` is legal too (its own commands run first, then the borrowed ones).

#### [P04] `checked_by` borrows one level; a cycle and an unknown name are loader refusals (DECIDED) {#p04-checked-by}

**Decision:** `checked_by = ["a", "b"]` runs surfaces `a` and `b`'s **own** `check` commands as this surface's own. Borrowing is **one level deep**: the loader refuses a `checked_by` naming a surface that itself declares `checked_by`, and refuses a `checked_by` naming a surface that does not exist.

**Rationale:**
- Follows [B04]. The motivating case is a source directory with no build of its own that is verified by its consumers — in this repository, `tugproto/` (one file, `tugproto/src/inbound.ts`) consumed by both `tugdeck/` and `tugcode/`.
- One level is enough for that shape and makes "refuse a cycle" a single check rather than a graph walk.

**Implications:**
- Refusal happens at load, so the resolver in `tugdash-core` may assume a well-formed table.
- Borrowed commands expand their placeholders against the **borrowing** surface — see [P05].

#### [P05] Three placeholders, expanded against the surface the command runs for (DECIDED) {#p05-placeholders}

**Decision:** `{base}` and `{head}` keep their meaning (the range's endpoints). `{paths}` is new: the shell-quoted, space-joined list of touched paths **within the surface the command is running for**. A command carrying none of the three runs unscoped. Full grammar in [Spec S02](#s02-placeholders).

**Rationale:**
- Follows [B05], and answers [F03]: a test-selection command wants the paths that moved and a per-package build wants the packages that moved, and neither should re-derive them in shell.
- Scoping `{paths}` to the *borrowing* surface is the only reading that makes [P04] coherent — a borrowed command is running "as its own", so the paths it is about are this surface's.

**Implications:**
- Quoting is single-quote wrapping with `'\''` escaping, so a path with a space or a quote survives `sh -c` intact.
- A surface whose command carries `{paths}` and whose touched set is empty never runs at all, because a surface with no touched paths is not in the run.
- This repository's own table declares no `{paths}` consumer (see [P12]); the placeholder is proven by table test over a synthesized table, which is where a portable contract should be proven anyway.

#### [P06] The verified range is derived from git, never remembered (DECIDED) {#p06-range-is-derived}

**Decision:** `tugutil dash verify <name>` defaults `--base` to `git merge-base <base branch> tugdash/<name>` and `--head` to the tip of `tugdash/<name>`, both read live. `--base`/`--head` override either. No dash-log line records the range, and `replayed_note` is unchanged.

**Rationale:**
- Resolves [Q01]. The `replayed` note's hashes are abbreviated to nine characters, and its tail is not the branch tip whenever `reconcile_ledger_cells` lands a remap commit after the swap.
- The derived range is *the dash's own contribution* — exactly what a join lands, which is what "the fit" means under [D149]. After a replay the merge-base **is** the base tip, so the derived range and the replayed range coincide; before one, the derived range is still the honest answer to "what would this dash land".
- It makes `verify` answerable for a dash that has never been replayed, which a log-derived range could not be.

**Implications:**
- `verify` needs no coordination with `replay` and no ordering contract between them.
- The verb resolves the worktree and the base branch through the existing `tugdash-core` helpers (`branch_name`, `dash_base`, `worktree_path` in `tugrust/crates/tugdash-core/src/ops.rs`), so it answers the same from the base checkout and from inside a dash worktree.
- Touched paths come from `git diff --name-only <base>..<head>` run in the main repo, with rename destinations reported (the same reading `parse_name_status` in `ops.rs` already takes).

#### [P07] Every surface runs; an identical expanded command runs once (DECIDED) {#p07-every-surface-runs}

**Decision:** Checks run from the **worktree root**, in declared surface order, and within a surface in declared command order. A red command **ends its surface** but not the run: every surface runs, so one report names every failure. An expanded command string identical to one already run in this invocation is not run again; the report shows it as `already run for <surface>`.

**Rationale:**
- Follows [B06]'s "a red command ends its surface, but every surface runs so one report names every failure".
- De-duplication is not caching (the non-goal): it is the direct consequence of [P04], where two surfaces legitimately ask for the same command in one run, and running `bunx vite build` twice in one ending is a cost with no reader.
- Attributing the run to the first surface that asked keeps the report honest about what actually executed.

**Implications:**
- The de-dup key is the **expanded** string, so two surfaces whose `{paths}` differ correctly run twice.
- The report's per-surface table therefore has three result shapes per command: ran, already-run, and not-reached (after a red command earlier in the same surface).

#### [P08] The verb's report, receipt line, and exit codes (DECIDED) {#p08-verb-output}

**Decision:** `tugutil dash verify` prints a per-surface table and closes with a single `TUG-VERIFY-RECEIPT:` line. `--json` carries the same document. Exit codes: **0** verified, declared-none ([P11]), or nothing in range ([P13]); **1** at least one check failed; **2** a path resolved to no surface (or the config refused to load). Full grammar in [Spec S03](#s03-verb-output).

**Rationale:**
- Follows [B06]. `TUG-<VERB>-RECEIPT:` is the established stdout convention in this tree (`TUG-FILE-RECEIPT` in `tugrust/crates/tugutil/src/commands/file.rs`, `TUG-ROTATION-RECEIPT` in `tugrust/crates/tugutil/src/session.rs`), so the closing line is legible to a reader who has seen one before.
- Two distinct non-zero codes because the two failures want different responses: `1` is ordinary work in the warm worktree, `2` is *edit the table*.

**Implications:**
- The report is a finished document, as `just app-test`'s is — there is nothing a filter can extract that the receipt has not already extracted.
- `--json` is serialized from the same structs the text renders, so the two cannot drift.

#### [P09] The result is a document fact, read by the faces and gating nothing (DECIDED) {#p09-fit-is-a-fact}

**Decision:** A green verify appends one dash-log line: marker `verified`, note leading with the **full** head sha and the **full** base sha it was verified onto. `read_declarations` collects it into `DashDeclarations.last_verified`, deliberately **not** as a `latest` declaration — verifying does not move a dash's stage, exactly as replaying does not. Every face reads it and *says* it: `Fit: verified at <head>` when both recorded endpoints still stand, `Fit: not verified since <head>` when either the dash branch or the base has moved past them, and nothing at all when there is no line.

**Rationale:**
- Follows [B07]. This is what lets an ending — a skill's or an arc's implement stage — rest on a fact it can read rather than on remembering to run something.
- The `replayed` marker is the exact precedent, and it already travels the whole rail: dash-log → `DashDeclarations.last_replay` → `DashDetail.last_replay` → the changeset wire entry → `dashMetaFacts` in `tugdeck/src/components/tugways/dash-meta-line.tsx`. The fit fact rides the same rail.
- Says it **only** ([D149], and [R02](#r02-fact-read-as-gate)): it is never added to the join blockers.

**Implications:**
- A red or refused verify writes **nothing**. The absence of a line is the honest record of "not verified", and a line saying "red at `<head>`" would be a durable fact about a state the next fix erases.
- A run with **nothing in range** writes nothing either ([P13]) — a `verified` line for a run that checked no bytes is the same lie in a quieter voice.
- Staleness is derived, never stored: both recorded shas are compared with the live tips at read time.
- The wire field is one object, `fit: { head, base, current }`, so a face cannot show a head without knowing whether it is current.
- The existing `replayed` fact on the dash lane is gated on `ahead === 0`; the fit fact needs no such gate, because base motion is already inside its own `current`.

#### [P10] The join receipt carries the fit as an optional line (DECIDED) {#p10-join-receipt-line}

**Decision:** `format_join_summary` gains an optional `fit: verified <head>` / `fit: stale <head>` line, placed between the header and the `files:` line, and **omitted entirely** when the dash carried no fit fact. The deck parses it by prefix, exactly as it parses `files:`.

**Rationale:**
- Follows [B07]'s third face. The `files:` line is the precedent in the same function and it states the discipline: one degradation, not two — a legacy row and a join with nothing to say take the same path.
- The join tears the dash down (branch deleted, terminal line written), so the fact must be captured **before** teardown and carried on the outcome. `JoinOutcome` in `tugrust/crates/tugdash-core/src/ops.rs` is where the join's other receipt facts already live.

**Implications:**
- `JoinOutcome` gains an additive `fit: Option<FitFact>` field, absent from the JSON when there is none.
- `ParsedJoinReceipt` in `tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx` gains an optional field, and a parse miss still falls back to the generic block.

#### [P11] The empty table is the declared-none state, and it exits 0 (DECIDED) {#p11-declares-none}

**Decision:** A project with no `[[surface]]` entries is not refused. `tugutil dash verify` reports that the project declares no surfaces, exits **0**, and says the ending falls back to the plan's own checkpoint commands over what the replay moved.

**Rationale:**
- Follows [B08], and preserves [F04]'s honest degrade. Refusal is for a project that declared and left a gap, not for one that has not declared yet.
- It matches every other [D151] key: absence is a state with a stated sentence, never an invention.

**Implications:**
- No fit fact is written in this state; the faces say nothing, which is correct — nothing was verified.
- The prose consumers ([P12]'s step) must carry this sentence, because it is the sentence a foreign project will actually hit first.

#### [P12] This repository's own table is written last, as an instance (DECIDED) {#p12-tugtool-table}

**Decision:** Tug's `.tugtool/config.toml` gets its surface table in the same change that deletes `scripts/verify-fit.sh` and rewrites the prose consumers — after the schema and verb exist, so the table is written against a live loader and proven by running the verb. The table is in [Table T01](#t01-tugtool-surfaces).

**Rationale:**
- Follows [B09]. The table carries no decision this plan needs to make; it is an instance of the feature, written against the same schema any project would use.
- Writing it last means the first run of `tugutil dash verify` on this repository is a real test of [P02] against a real tree, not a rehearsal.

**Implications:**
- `tests/` is claimed only at `tests/app-test/`, `tests/build-info/`, and `tests/model-eval/`; a new `tests/<something>` correctly refuses until somebody declares it. That is the feature, and the step says so rather than pre-claiming a bare `tests/`.
- `tugdeck/crates/` is a surface of its own, longest-prefix-shadowing `tugdeck/` — a real instance of [P02]'s resolution rule in this repository's own table.

#### [P13] An empty range is its own state, and it records no fit (DECIDED) {#p13-empty-range}

**Decision:** A range that touched no paths — a dash with no rounds, or `--base`/`--head` naming the same commit — is neither a refusal nor a verification. `tugutil dash verify` reports that the range moved nothing, exits **0**, and writes **no** fit fact. It is checked before the table is consulted, so a project that declares surfaces and a project that declares none reach it identically.

**Rationale:**
- Without this state the empty range falls through to `Planned(vec![])`, whose report is green, whose exit is 0, and whose green path under [P09] would append a `verified` line. A dash would be recorded as verified having run nothing — precisely [F02]'s failure mode, in a quieter voice.
- The other two absences already have stated sentences ([P11] for the empty table, [P03] for `check = []`), and the degradation doctrine [D151] generalizes says every absence gets one rather than an invention.

**Implications:**
- `plan_verification` gains a fourth variant, `NothingTouched`, returned before the `DeclaresNone` check so the two cannot race — a project with no table and no touched paths reports the range, which is the more specific fact.
- The receipt line is `TUG-VERIFY-RECEIPT: nothing in range <base>..<head>`.
- This is the state the ending hits when a replay reports `Current` and somebody runs the verb anyway; the honest answer there is "these bytes were already covered", not "verified".

---

### Specification {#specification}

#### [S01] The surface schema {#s01-surface-schema}

Declared as TOML array-of-tables under the existing `[tugtool.dash]` table:

```toml
[[tugtool.dash.surface]]
name  = "deck"                 # required, non-empty, unique across the table
paths = ["tugdeck/"]           # required, non-empty; repo-relative prefixes or exact paths
check = [                      # optional, defaults to []
  "cd tugdeck && bunx tsc --noEmit",
  "cd tugdeck && bunx vite build",
]

[[tugtool.dash.surface]]
name       = "proto"
paths      = ["tugproto/"]
checked_by = ["deck", "code"]  # optional, defaults to []
```

Rust shape, in `tugrust/crates/tugutil-core/src/config.rs`:

```rust
pub struct Surface {
    pub name: String,
    pub paths: Vec<String>,
    pub check: Vec<String>,
    pub checked_by: Vec<String>,
}
```

bound into `DashConfig` as `#[serde(default, rename = "surface")] pub surfaces: Vec<Surface>`.

**Loader refusals**, all raised by a `validate()` pass run after parse in `Config::load`, each naming the offending value:

| # | Refused | Message names |
|---|---------|---------------|
| 1 | `verify = "…"` present at all | the retired key and `[[tugtool.dash.surface]]` |
| 2 | empty `name`, or two surfaces with the same `name` | the name |
| 3 | empty `paths` list, or an empty path string | the surface name |
| 4 | a path that is absolute, contains `..`, or contains `*`, `?`, or `[` | the surface name and the path |
| 5 | two surfaces declaring the **same** path prefix | both surface names and the prefix |
| 6 | `checked_by` naming a surface that does not exist | the surface name and the missing name |
| 7 | `checked_by` naming a surface that itself declares `checked_by` | both names ("one level deep") |
| 8 | `checked_by` naming the surface itself | the name |

A missing config file is not validated at all: `Config::load_from_project` keeps returning `Config::default()` for an absent file, so a project with no `.tugtool/config.toml` is unaffected.

Refusal #5 is about an *identical* prefix, not an overlapping one. `tugdeck/` and `tugdeck/crates/` are both legal and are resolved by [S04](#s04-resolution); two surfaces both claiming `tugdeck/` are ambiguous by construction and refused.

#### [S02] Placeholder expansion {#s02-placeholders}

Expansion happens once per (surface, command) pair, on the raw command string, before it is handed to `sh -c`:

| Placeholder | Expands to |
|---|---|
| `{base}` | the range's base sha, verbatim |
| `{head}` | the range's head sha, verbatim |
| `{paths}` | the touched paths **within the surface this command is running for**, each shell-quoted, joined by a single space, in the order the diff reported them |

Shell-quoting wraps each path in single quotes and replaces any embedded `'` with `'\''`. A command carrying no placeholder is run verbatim. Placeholders are substituted literally — there is no escaping mechanism for a command that wants a literal `{paths}`, and there is no need for one.

Under [P04], a borrowed command's `{paths}` is the **borrowing** surface's touched paths, not the lending surface's.

#### [S03] The verb's output {#s03-verb-output}

Text output, in this order: an optional refusal block, the per-surface table, then exactly one receipt line.

```text
surface      paths  checks  result
rust             7       1  ok
deck             3       2  ok
proto            1       2  ok (checked by deck, code)
prose            4       0  claimed, unchecked

TUG-VERIFY-RECEIPT: verified 3f0a1c9e… · 3 surfaces checked · 1 claimed unchecked
```

Refusal ([P02]):

```text
3 paths match no declared surface:
  tugcode/src/relay.ts
  tugcode/src/types.ts
  tests/probes/run.ts

Declare a surface for them in .tugtool/config.toml:

  [[tugtool.dash.surface]]
  name  = "<name>"
  paths = ["tugcode/", "tests/probes/"]
  check = []

TUG-VERIFY-RECEIPT: unclaimed 3 paths
```

Red ([P07]) — every surface still ran, and the first red command of each red surface is quoted with its exit status:

```text
TUG-VERIFY-RECEIPT: red 2 surfaces · deck: `cd tugdeck && bunx tsc --noEmit` (exit 2)
```

Declared-none ([P11]):

```text
TUG-VERIFY-RECEIPT: this project declares no surfaces
```

Nothing in range ([P13]):

```text
TUG-VERIFY-RECEIPT: nothing in range 91c4de70f2a3…..3f0a1c9e2b7d…
```

`--json` emits the same document through `print_ok("dash verify", …)`, carrying: the resolved range, the unclaimed path list, a per-surface array (`name`, `paths`, `commands` with each command's expanded string / status / exit code / whether it was already run), the two counts, and the receipt string itself.

#### [S04] Path resolution {#s04-resolution}

A declared path `p` **claims** a touched path `t` when either:

- `p == t` (exact path), or
- `t` starts with `p` and (`p` ends with `/` or `t[p.len()] == '/'`).

Among all claiming declarations, the **longest** `p` wins. Ties cannot occur: two surfaces declaring the same prefix are refused at load ([S01] #5).

A touched path claimed by nothing is unclaimed, and a non-empty unclaimed list is [P02]'s refusal.

An **empty** touched list short-circuits all of it: `plan_verification` returns `NothingTouched` before it looks at the table at all ([P13]).

A surface with no touched paths is **not in the run**: it is absent from the table, runs no commands, and is counted in neither of the receipt's two counts.

#### [S05] The fit fact {#s05-fit-fact}

Dash-log line, written only on a green verify ([P09]):

```text
2026-08-25T18:04:11Z  verify-surfaces  verified  3f0a1c9e2b7d4f6a8c0e1d3b5a7f9c2e4d6b8a01 onto 91c4de70f2a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1 · 3 surfaces checked · 1 claimed unchecked
```

Read back by `read_declarations` into `DashDeclarations.last_verified: Option<String>` — the note verbatim; the head is its first whitespace-delimited token and the base is the token after `onto`. A note that does not parse into that pair is ignored rather than half-believed, exactly as `read_step_fields` skips an unparseable step note.

Derived into a single object at every consumer:

```rust
pub struct FitFact {
    /// The head the fit was verified at, full sha.
    pub head: String,
    /// The base tip that head was verified *onto*, full sha — the other half
    /// of the range, without which "verified" cannot name a tree.
    pub base: String,
    /// Whether both endpoints still stand: `head` is the dash branch's tip
    /// **and** `base` is the base branch's tip.
    pub current: bool,
}
```

`current` needs both endpoints because the fit is the dash *replayed onto the live base* ([D149]): a base that moved after a green verify leaves the recorded head untouched while making the verified tree no longer the tree a join would land. Recording one sha and deriving staleness from it would say `verified` about a tree that no longer exists — the shape [F02] exists to kill. Both comparisons are one `rev-parse` each, at read time; nothing about the staleness is stored.

Wire spelling on the changeset entry, additive and absent when there is no fact:

```json
"fit": { "head": "3f0a1c9e2b7d…", "base": "91c4de70f2a3…", "current": true }
```

Face wording, everywhere: `fit verified` (tone `subtle`) when `current`, `fit unverified` (tone `caution`) when not, nothing when absent.

#### [T01] This repository's surface table {#t01-tugtool-surfaces}

The table [Step 7](#step-7) writes into `.tugtool/config.toml`. Every tracked top-level entry is claimed by exactly one surface, so the verb refuses nothing for today's tree.

| Surface | Paths | Checks |
|---|---|---|
| `rust` | `tugrust/` | `cd tugrust && cargo check --workspace --all-targets` |
| `deck` | `tugdeck/` | `cd tugdeck && bunx tsc --noEmit`; `cd tugdeck && bunx vite build` |
| `wasm` | `tugdeck/crates/` | `just wasm` |
| `code` | `tugcode/` | `cd tugcode && bunx tsc --noEmit` |
| `proto` | `tugproto/` | *(none — `checked_by = ["deck", "code"]`)* |
| `app` | `tugapp/` | `just build-app` |
| `app-tests` | `tests/app-test/` | `cd tests/app-test && bunx tsc --noEmit` |
| `prose` | `tuglaws/`, `dash/`, `CLAUDE.md`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` | *(none — `check = []`)* |
| `plugin` | `tugplug/`, `.claude-plugin/` | *(none — `check = []`)* |
| `project` | `Justfile`, `scripts/`, `.github/`, `.gitattributes`, `.gitignore`, `.tugtool/`, `capabilities/`, `diag/`, `products/`, `resources/`, `tests/build-info/`, `tests/model-eval/` | *(none — `check = []`)* |

Two entries in this table are load-bearing beyond their own contents:

- `wasm` shadows `deck` by longest prefix ([S04]) — a change under `tugdeck/crates/` runs `just wasm`, not `vite build`.
- `proto` is the [P04] case: one tracked file (`tugproto/src/inbound.ts`) with no build of its own, verified by both consumers that import it.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `entry.fit` on the changeset entry | structure (server-owned) | already-existing changeset subscription; `DashMetaLine` takes the entry as a prop and derives the fact purely | [L02] |
| the fact's tone (`subtle` / `caution`) | appearance | `data-tone` attribute the CSS paints, as every other `dash-meta-fact` does | [L06] |
| the fit line on a parsed join receipt | local-data | parsed from the row's own summary string at render, held in no store | [L02] |

No new store, no new subscription, no new state: the fit fact arrives on an entry that already reaches both faces.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust, table-driven)** | Schema refusals, path resolution, `checked_by` expansion, placeholder substitution, receipt formatting | [Step 1](#step-1), [Step 2](#step-2), [Step 4](#step-4), [Step 6](#step-6) |
| **Integration (Rust, tempdir repo)** | The verb end to end against a synthesized project that is **not** Tug — refusal, green, red, declared-none, and the dash-log line | [Step 3](#step-3), [Step 4](#step-4) |
| **Pure-logic (bun:test)** | `dashMetaFacts` gaining a fit fact; the join receipt parser's optional line | [Step 5](#step-5), [Step 6](#step-6) |
| **Real-app (app-test)** | That the composed entry reaches the lane and paints the fact, and that a real dash's unclaimed path really refuses | [Step 5](#step-5) |

Every synthesized fixture for the Rust tests is a scratch repository under `TUG_DATA_DIR` redirect — `tugrust/.cargo/config.toml` sets it for every cargo-driven process, and `refuse_unredirected_temp_repo` in `tugrust/crates/tugdash-core/src/dash.rs` panics in debug builds if it is not.

#### What stays out of tests {#test-non-goals}

- **The declared commands themselves.** A test that ran `cargo check` to prove the runner works would be testing cargo. The runner is proven with `true`, `false`, and `printf` as the declared commands.
- **Tug's own surface table's coverage over time.** [P02] is the mechanism that keeps it honest; a test asserting today's directory list would need editing every time a directory is added, and would fail *later* than the verb does.
- **Fake-DOM render tests.** There is no in-process DOM substrate: `dashMetaFacts` is a pure function over an entry and is tested as one; anything needing the real lane is an app-test.
- **The join gate.** Nothing here touches it, and a test asserting the fit fact does not block would be asserting the absence of code that was never written.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The surface schema and its loader refusals | done | `bef726bbc` |
| #step-2 | The pure resolver | done | `f4c3219d9` |
| #step-3 | The `tugutil dash verify` verb | done | `07ec918d5` |
| #step-4 | The fit fact: dash-log line and `dash status` | done | `6f4e25122` |
| #step-5 | The fit fact on the wire and on the lane | done | `e42eebd4a` |
| #step-6 | The join receipt's `fit:` line | done | `7f95e199d` |
| #step-7 | The consumers, the script's deletion, and this repository's table | done | `8e4cd0215` |
| #step-8 | Integration Checkpoint | done | `c9af9cf8d` |

---

#### Step 1: The surface schema and its loader refusals {#step-1}

**Commit:** `tugutil(config): declare dash surfaces, and refuse the retired verify key`

**References:** [P01] surfaces replace verify, [P04] checked_by, [Spec S01](#s01-surface-schema), [R01](#r01-loader-refusal), (#dependencies)

**Artifacts:**
- `Surface` struct and `DashConfig.surfaces` in `tugrust/crates/tugutil-core/src/config.rs`
- A `validate()` pass in `Config::load`, with a `ConfigRefusal` enum carrying [S01]'s eight cases
- `DEFAULT_CONFIG` (same file) with the `verify` example replaced by a commented surface example
- `ConfigPayload` in `tugrust/crates/tugutil/src/dash.rs` reporting the table

**Tasks:**
- [ ] Add `Surface` per [S01], with `#[serde(default)]` on `check` and `checked_by`, bound into `DashConfig` as `#[serde(default, rename = "surface")] pub surfaces: Vec<Surface>`.
- [ ] Keep a field bound to the `verify` key so the loader can *see* it — name it for what it is (it is read only to be refused) and document that nothing consumes its value.
- [ ] Write `ConfigRefusal` and a `Display` impl in the shape of the existing `DocsDirRejection` in the same file, one variant per [S01] refusal row.
- [ ] Call the validation from `Config::load` after `toml::from_str`, mapping a refusal to `TugError::Config`. Leave `Config::load_from_project`'s missing-file path returning `Config::default()` untouched ([R01](#r01-loader-refusal)).
- [ ] Replace `DEFAULT_CONFIG`'s commented `verify = "sh scripts/check.sh {base} {head}"` block with a commented `[[tugtool.dash.surface]]` example naming all four fields and the three placeholders, and stating that an unclaimed path is a refusal.
- [ ] Change `run_config` in `tugrust/crates/tugutil/src/dash.rs`: drop `verify` from `ConfigPayload`, add `surfaces`. Text output prints one line per surface (`name`, paths joined by spaces, check count or `checked by <names>`), or `surfaces: (none declared)`.
- [ ] Fix every existing test that reads the retired key — there are four sites, and one of them stops *loading*, not just asserting:
  - `tugutil-core/src/config.rs`'s own tests parse `verify = "sh scripts/verify-fit.sh {base} {head}"` and assert it round-trips (~L447–451), and two more assert `verify.is_none()` (~L461, ~L466). The parsing one becomes a refusal test; the `is_none` pair becomes assertions about an empty `surfaces` list.
  - `tugutil/tests/cli_integration_tests.rs` asserts `config.tugtool.dash.verify.is_none()` (~L85), and — the load-bearing one — **writes a config file declaring `verify = "sh check.sh {base} {head}"`** and asserts `json["data"]["verify"]` (~L278, ~L294). Under [P01] that config no longer loads at all, so the test fails at `dash config` rather than at the assertion; rewrite it around a surface table.
  - `tugcast/src/feeds/base_motion.rs`'s tests build `ConflictMessage { verify: Some("sh scripts/verify-fit.sh {base} {head}"), … }` (~L1195, ~L1273) and assert the text contains it (~L1222). Those die with the field in [Step 7](#step-7); named here so the grep for the retired key is done once and the two steps do not each discover half of it.

**Tests:**
- [ ] Table test over [S01]'s eight refusals: each malformed config fails to load with a message naming the offending value, and a valid neighbour config still loads.
- [ ] A config declaring `verify = "…"` fails to load with a message naming `[[tugtool.dash.surface]]`.
- [ ] `tugdeck/` and `tugdeck/crates/` both declared is **accepted** (overlap is legal); two surfaces both declaring `tugdeck/` is refused.
- [ ] A missing `.tugtool/config.toml` yields `Config::default()` with an empty surface list and no error.
- [ ] `DEFAULT_CONFIG` parses and validates clean.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core -p tugutil`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`

---

#### Step 2: The pure resolver {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(surfaces): resolve touched paths to declared surfaces and expanded commands`

**References:** [P02] unclaimed is a refusal, [P03] empty check, [P04] checked_by, [P05] placeholders, [P07] every surface runs, [P11] declares none, [Spec S02](#s02-placeholders), [Spec S04](#s04-resolution)

**Artifacts:**
- `tugrust/crates/tugdash-core/src/surfaces.rs`, registered in `lib.rs`
- `Resolution`, `SurfacePlan`, `PlannedCommand` types and a `plan_verification(...)` entry point — pure, no IO, no `Command`

**Note on the module name.** `tugdash-core` already has a `verify.rs`, and it is **not** this: it holds the join arc's two branch-config pilot marks, and its module doc opens with *"Verification does not live here, because it does not live at the join."* That doc becomes half-true the moment this verb exists — the sentence is still right about the join, but a reader hunting for the verify verb now lands there and finds pilot marks. Hence `surfaces.rs`, and hence the one-line pointer added to `verify.rs`'s module doc in [Step 3](#step-3).

**Tasks:**
- [ ] Write the claim rule of [S04] as a free function taking a declared path and a touched path, and the longest-prefix pick over a whole table.
- [ ] `plan_verification(surfaces, base, head, touched) -> Resolution` returning one of: `NothingTouched`, `DeclaresNone`, `Unclaimed(Vec<String>)`, or `Planned(Vec<SurfacePlan>)`, checked **in that order** — the empty range is answered before the table is consulted ([P13]), so a project with neither a table nor a diff reports the range. Surfaces with no touched paths are absent from `Planned` ([S04]).
- [ ] Expand `checked_by` into each `SurfacePlan`'s command list per [P04] — own commands first, then each named surface's own `check` in declaration order — recording which surface each borrowed command came from, for the report's `checked by …` note.
- [ ] Substitute `{base}`, `{head}`, `{paths}` per [S02], with `{paths}` scoped to the plan's **own** touched paths, including for borrowed commands. Write the shell-quoter as its own function.
- [ ] Mark a `PlannedCommand` whose expanded string equals an earlier one in the whole plan as `already_run_for: Some(<surface>)` ([P07]), so the runner in [Step 3](#step-3) has nothing to decide.

**Tests:**
- [ ] Longest prefix wins: `tugdeck/crates/x/Cargo.toml` resolves to `wasm` when both `tugdeck/` and `tugdeck/crates/` are declared.
- [ ] An exact root path resolves: `CLAUDE.md` declared exactly claims `CLAUDE.md` and does **not** claim `CLAUDE.md.bak`.
- [ ] A prefix without a trailing slash does not claim a sibling: `tugdeck` declared does not claim `tugdeck-old/x.ts`.
- [ ] An unmatched path yields `Unclaimed` naming exactly the unmatched paths, and **no** `SurfacePlan` is produced ([P02]).
- [ ] An empty table yields `DeclaresNone` even when paths were touched ([P11]).
- [ ] An empty touched list yields `NothingTouched` — with a table, and with an empty table, which must not report `DeclaresNone` ([P13]).
- [ ] `check = []` yields a `SurfacePlan` with zero commands, distinguishable from a surface that is not in the run ([P03]).
- [ ] `checked_by = ["a","b"]` yields `a`'s then `b`'s commands, each attributed to its lender ([P04]).
- [ ] `{paths}` expands to the borrowing surface's paths, shell-quoted; a path containing a space and a path containing `'` both survive.
- [ ] A command carrying no placeholder is byte-identical to its declaration.
- [ ] Two surfaces declaring the same unscoped command produce one runnable and one `already_run_for` ([P07]); two surfaces whose `{paths}` differ produce two runnables.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core surfaces`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`

---

#### Step 3: The `tugutil dash verify` verb {#step-3}

**Depends on:** #step-2

**Commit:** `tugutil(dash): add the verify verb over a project's declared surfaces`

**References:** [P02] unclaimed is a refusal, [P06] the range is derived, [P07] every surface runs, [P08] verb output, [P11] declares none, [Spec S03](#s03-verb-output), [Q01](#q01-replayed-range)

**Artifacts:**
- `DashCommands::Verify { name, base, head }` in `tugrust/crates/tugutil/src/cli.rs`, dispatched in `tugrust/crates/tugutil/src/dash.rs`
- A `verify_in(repo_root, name, base, head)` runner in `tugrust/crates/tugdash-core/src/surfaces.rs` (or a sibling module), returning a serializable report
- `tugrust/crates/tugutil/tests/dash_verify_cli.rs`

**Tasks:**
- [ ] Add the subcommand: `tugutil dash verify <name> [--base <sha>] [--head <sha>] [--json]`, following the `Replay`/`Status` dispatch shape already in `dash.rs`.
- [ ] Resolve the dash the way `replay` does — `find_repo_root` then `main_repo_root` normalization — so the verb answers the same from the base checkout and from inside any worktree. `branch_name`, `dash_base`, `worktree_path` and `main_repo_root` are all **`pub(crate)`** in `tugrust/crates/tugdash-core/src/ops.rs`, so every one of these lines lives inside `tugdash-core` — the tugutil side passes the repo root, the name, and the two overrides and gets a report back. Widening any of them to `pub` to move the logic into `tugutil/src/dash.rs` is the wrong repair.
- [ ] Derive the range per [P06]: `--base` defaults to `git merge-base <base_branch> <branch>`, `--head` to `rev-parse <branch>`. Read touched paths with `git -c core.quotepath=false diff --name-status -M <base>..<head>`, taking the rename destination the way `parse_name_status` in `ops.rs` does.
- [ ] Call `plan_verification`; on `Unclaimed`, print [S03]'s refusal block with the declaration snippet, emit the receipt, and exit 2 **without running anything**. On `DeclaresNone`, print [S03]'s declared-none receipt and exit 0. On `NothingTouched`, print [S03]'s nothing-in-range receipt and exit 0 ([P13]).
- [ ] Add the pointer sentence to `tugdash-core/src/verify.rs`'s module doc: verification of the *fit* lives in `surfaces.rs` and is run by `tugutil dash verify`; what stays here is the join arc's pilot marks. The doc's existing claim is about the join and stays true — it just needs to name where the answer went.
- [ ] Run each planned command via `sh -c` with `current_dir` = the dash worktree root, following `run_post_create` in `ops.rs` — except that a non-zero exit ends **that surface** and the run continues ([P07]). Skip commands marked `already_run_for`.
- [ ] Print the per-surface table and exactly one `TUG-VERIFY-RECEIPT:` line; exit 1 if any surface went red. Serialize the same report through `print_ok("dash verify", …)` under `--json`.
- [ ] Refuse a `<name>` that names no dash with the same message `status` uses (`Dash not found: <name>`), and a dash whose worktree is missing with a message saying so.

**Tests:**
- [ ] CLI test against a tempdir project that is **not** Tug: two surfaces with `true`-style commands, a commit touching both, green report, exit 0, receipt naming both counts.
- [ ] A commit touching an unclaimed path: exit 2, the path named, the declaration snippet printed, and — asserted by a declared command that would have written a sentinel file — **nothing ran**.
- [ ] A surface whose declared command is `false`: exit 1, the surface red with its exit status quoted, and a *second* surface's commands still ran ([P07]).
- [ ] A project with no surfaces: exit 0 and the declared-none receipt.
- [ ] `--base` and `--head` naming the same commit: exit 0, the nothing-in-range receipt, no command ran, and — asserted against the dash-log — **no `verified` line** ([P13]).
- [ ] `{paths}` reaches the shell: a declared `printf '%s\n' {paths} > out.txt` writes exactly the touched paths of its own surface.
- [ ] `--base`/`--head` override the derived range; with neither, the derived range equals `merge-base(base, branch)..branch` on a dash with two rounds.
- [ ] `--json` carries the same verdict, counts, and receipt string as the text output.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`

---

#### Step 4: The fit fact: dash-log line and `dash status` {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(verify): record the verified head, and say it on dash status`

**References:** [P09] the fit is a fact, [Spec S05](#s05-fit-fact), [R02](#r02-fact-read-as-gate)

**Artifacts:**
- The `verified` dash-log line, written from the verb's green path via `append_dash_log`
- `DashDeclarations.last_verified` and a `FitFact` derivation in `tugrust/crates/tugdash-core/src/dash.rs`
- `DashStatus.fit` in `tugrust/crates/tugdash-core/src/ops.rs`; the `Fit:` line in `run_status`

**Tasks:**
- [ ] On a green verify only, append one line: marker `verified`, note = `<full head sha> onto <full base sha>`, then ` · N surfaces checked · M claimed unchecked`. Write nothing on a red run, a refused run, or a `NothingTouched` run ([P09], [P13]).
- [ ] Add `last_verified: Option<String>` to `DashDeclarations` and a `"verified" =>` arm to `read_declarations`'s match. Do **not** set `found.latest` — a verify does not move the stage, exactly as `replayed` does not. (`found.last_activity` *is* set, as it is for every surviving line; that is correct — a verify is activity.)
- [ ] Add `FitFact { head, base, current }` per [S05] and a helper that parses `last_verified` into the pair and compares both against the live tips — the dash branch's for `head`, the base branch's for `base`. An unparseable note yields `None` rather than a half-populated fact.
- [ ] Add `fit: Option<FitFact>` to `DashStatus`; populate it in `status_in`, which already has both the branch and the base branch in hand.
- [ ] Print it in `run_status` in `tugrust/crates/tugutil/src/dash.rs`: `Fit: verified at <head[..9]>` / `Fit: not verified since <head[..9]>`, and nothing when absent.

**Tests:**
- [ ] A green verify appends exactly one `verified` line whose note leads with the full head sha and names the full base sha after `onto`.
- [ ] A red verify, a refused verify, and a nothing-in-range verify each append nothing ([P13]).
- [ ] `read_declarations` collects it into `last_verified` and leaves `latest` — and therefore the derived stage — unchanged.
- [ ] A terminal line resets `last_verified` with everything else, so a reused dash name is not born verified.
- [ ] `FitFact.current` is true at the recorded pair; false after one more round lands on the dash; **and false after the base branch alone gains a commit, with the dash untouched** — the case the head-only derivation could not see.
- [ ] A `verified` note that does not parse into a head/base pair yields `fit: None`, not a fact with an empty base.
- [ ] `dash status --json` carries `fit`, and omits it for a dash that has never been verified.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`
- [ ] `cd tugrust && cargo clippy --workspace --all-targets -- -D warnings`

---

#### Step 5: The fit fact on the wire and on the lane {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(dash-meta-line): say whether the tree about to land was verified`

**References:** [P09] the fit is a fact, [Spec S05](#s05-fit-fact), (#state-zone-mapping)

**Artifacts:**
- `DashDetail.fit` in `tugrust/crates/tugdash-core/src/ops.rs`
- The `fit` field on the dash changeset entry in `tugrust/crates/tugcast-core/src/types.rs`, populated in `tugrust/crates/tugcast/src/feeds/changeset.rs`
- `fit` on `DashChangesetEntry` and its validator in `tugdeck/src/lib/changeset-types.ts`
- A fit fact in `dashMetaFacts` in `tugdeck/src/components/tugways/dash-meta-line.tsx`
- `tests/app-test/at0478-dash-fit-verified.test.ts`

**Tasks:**
- [ ] Add `fit: Option<FitFact>` to `DashDetail` beside `last_replay`, populated in `dash_detail_entries_in` from the same `declarations` it already reads plus the branch tip it already has.
- [ ] Carry it onto the wire entry with `#[serde(default, skip_serializing_if = "Option::is_none")]`, matching how `last_replay` travels, and set it in `changeset.rs` where `last_replay: detail.last_replay` is set.
- [ ] Mirror the type in `changeset-types.ts` (`fit?: { head: string; base: string; current: boolean }`) and add its clause to the `isDashChangesetEntry` validator beside the `last_replay` clause.
- [ ] Add the fact to `dashMetaFacts`: `fit verified` tone `subtle` when `current`, `fit unverified` tone `caution` when not, nothing when absent. Order it with the caution facts (after `base overlap`, before `uncommitted`) when stale, and with the quiet receipts (beside `replayed`) when current — two push sites in the existing linear sequence, not one push with a computed index. Unlike `replayed`, it carries **no** `ahead === 0` gate: base motion is already inside `current` ([S05]). Tooltips name the head and the base it was verified onto, and say the fit was verified at that pair — never that a join is blocked ([R02](#r02-fact-read-as-gate)).
- [ ] Name the laws in the round's commit body — [L02] (the fact arrives on an already-subscribed changeset entry; `dashMetaFacts` derives it purely) and [L06] (the tone is a `data-tone` attribute the CSS paints) — per `tuglaws/dash-work-doctrine.md`'s *Law discipline*, which binds this file's directory.
- [ ] Write the app-test with `dash-fixture.ts`: in its scratch repo, declare a two-surface table, cut a dash, commit a round touching an **unclaimed** path, run `tugutil dash verify` and assert the refusal text and exit 2; then declare the surface, re-run, assert green; then assert the lane row shows `fit verified`. Carry `@covers` lines for `dash-meta-line.tsx`, `changeset-types.ts`, `ops.rs`, and `surfaces.rs`.
- [ ] The fixture's `tugutil()` helper **throws** on a non-zero exit, so it cannot express the exit-2 assertion. Spawn that one invocation directly with `Bun.spawnSync([tugutilPath(projectDir), …])` and read `exitCode` — `tugutilPath` is already exported from `dash-fixture.ts` and is the *only* correct way to name the binary, because `~/.local/bin/tugutil` is a symlink into the **main** checkout's `target/debug` and would run a build with no `verify` subcommand at all.

**Tests:**
- [ ] `bun:test` over `dashMetaFacts`, extending the existing `tugdeck/src/components/tugways/__tests__/dash-meta-arc.test.ts` rather than adding a second file for the same pure function: an entry with `fit.current === true` yields the `fit verified` fact; `false` yields `fit unverified` with tone `caution`; an entry with no `fit` yields neither, and the existing facts and their order are unchanged in all three.
- [ ] The app-test above: the refusal is real (exit 2, path named), declaring the surface clears it, and the lane paints the verified fact.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast-core -p tugcast`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/dash-meta-arc.test.ts`
- [ ] `just app-test at0478-dash-fit-verified.test.ts`

---

#### Step 6: The join receipt's `fit:` line {#step-6}

**Depends on:** #step-4

**Commit:** `tugcast(join-receipt): carry the fit the landed dash was verified at`

**References:** [P10] the join receipt line, [Spec S05](#s05-fit-fact)

**Artifacts:**
- `JoinOutcome.fit` in `tugrust/crates/tugdash-core/src/ops.rs`
- The `fit:` line in `format_join_summary` in `tugrust/crates/tugcast/src/feeds/changeset.rs`
- `ParsedJoinReceipt.fit` and its parse + render in `tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx`

**Tasks:**
- [ ] Add `fit: Option<FitFact>` to `JoinOutcome`, additive (`skip_serializing_if = "Option::is_none"`), captured **before** teardown on the landed path — the branch still exists there and the dash-log's terminal line has not been written.
- [ ] Emit the line from `format_join_summary`, between the header and the `files:` line: `fit: verified <head[..10]>` when `current`, `fit: stale <head[..10]>` when not, omitted when `fit` is `None`. Extend the doc comment's `text` block to show it.
- [ ] Pass the fact through at the call site in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`, where `format_join_summary` is already called with `rounds` and the landing file stats.
- [ ] Parse it in the deck by a `fit: ` prefix — but **`parseJoinReceipt` is positional today, not a prefix scan**: it tests `lines[1]?.startsWith(FILES_PREFIX)` at a fixed index and advances `messageStart` to 2. Inserting `fit:` ahead of `files:` moves the files line to index 2 and silently breaks the file list on every future join. Rewrite the head of the parser as a cursor: start at index 1, consume a `fit: ` line if present, consume a `files: ` line if present, and let `messageStart` be wherever the cursor stops. Then render the fit as one line of the receipt near the `dash → base` line. An unparseable line is ignored, not a parse miss — the generic-block fallback stays reserved for a header that does not match.
- [ ] Emit `fit: verified <head[..10]> onto <base[..10]>` / `fit: stale <head[..10]> onto <base[..10]>`, so the receipt names the same pair [S05] records rather than half of it.

**Tests:**
- [ ] Rust: `format_join_summary` with a current fit, a stale fit, and no fit — three exact strings, including the line's position relative to `files:`.
- [ ] Rust: a summary with a fit line **and** no files line, and with both, both parse-stable.
- [ ] `bun:test` over the receipt parser, one case per shape the cursor must survive: header+fit+files+message, header+files+message (**the pre-fit shape, files still at index 1** — the regression the positional parser would have introduced), header+fit+message, and header+message alone. All four yield the message verbatim and the right file list.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/components/tugways/cards/__tests__/session-join-receipt-block.test.ts`

---

#### Step 7: The consumers, the script's deletion, and this repository's table {#step-7}

**Depends on:** #step-3, #step-5, #step-6

**Commit:** `dash(verify-surfaces): name the verb everywhere, delete verify-fit.sh, declare Tug's surfaces`

**References:** [P01] surfaces replace verify, [P11] declares none, [P12] this repository's table, [Table T01](#t01-tugtool-surfaces)

**Artifacts:**
- `tugplug/skills/dash-implement/SKILL.md`, `tugplug/skills/dash-on/SKILL.md`
- `tuglaws/dash-work-doctrine.md`, `tuglaws/devise-skeleton.md`
- `tugrust/crates/tugcast/src/feeds/base_motion.rs` (`ConflictMessage`, `compose_conflict_message`, and the three tests that build the retired field)
- `tuglaws/design-decisions.md` — the new `[D###]`
- `.tugtool/config.toml`
- `scripts/verify-fit.sh` — **deleted**

**Tasks:**
- [ ] Rewrite the four prose readers. Each currently instructs a model to fetch a string from `tugutil dash config --json`, substitute `{base}`/`{head}`, and run it; each now says: **run `tugutil dash verify <name>`**; a refusal names the paths to declare and is fixed by declaring a surface, not by working around it; red is ordinary work in the warm worktree; and a project that declares no surfaces falls back to the plan's own checkpoint commands over what the replay moved, said plainly ([P11]). The specific sites are `dash-implement/SKILL.md` §3's `Replayed`/`Recorded` bullet, `dash-on/SKILL.md`'s `Replayed`/`Recorded` paragraph, `dash-work-doctrine.md`'s *Verify before every commit* section (the *checkpoint that passed is spent* paragraph), and `devise-skeleton.md`'s Integration Checkpoint pattern **and** its Step 5 template task list — the second is the one a future plan copies, so it must not be missed.
- [ ] Delete every mention of `sh scripts/verify-fit.sh {base} {head}` as "this repo's declaration"; the repo-specific sentence becomes a pointer to the surface table, not a command.
- [ ] Change the fifth consumer, which is Rust: `ConflictMessage.verify: Option<&str>` and its paragraph in `compose_conflict_message` (`tugrust/crates/tugcast/src/feeds/base_motion.rs`) tell the agent to substitute placeholders by hand. Replace the field and the paragraph with a fixed instruction to run `tugutil dash verify <dash>` after the replay records, and drop the config read at the `Speak::Conflict` call site.
- [ ] Write [Table T01](#t01-tugtool-surfaces) into `.tugtool/config.toml` by hand, above the retired-`verify` block, with a comment on `wasm` saying it shadows `deck` by longest prefix and one on `proto` saying it is checked by its consumers. Remove the `verify = …` key and its comment — the loader now refuses it, so leaving it makes this repository's own config unloadable.
- [ ] `git rm scripts/verify-fit.sh`.
- [ ] Record the decision in `tuglaws/design-decisions.md`. [D151] currently reads *"Two optional keys join it: `verify`, the run-ending's scoped fit check, and `build`…"* and spells out the `{base}`/`{head}` substitution contract in its own prose — with `verify` retired that paragraph is a resting lie about a key the loader now refuses. Write the new `[D###]`: the surface table, the refusal on an unclaimed path ([P02]), the fit as a recorded fact that gates nothing ([P09], holding [D149]), and the sentence that it supersedes [D151]'s `verify` key while leaving `post_create`/`build`/`docs`/the model keys exactly where they are. Supersession is this document's convention ([D149] supersedes [D142] in the same voice); do not edit [D151]'s text out from under itself.
- [ ] Run the verb on this dash and confirm it refuses nothing; add any surface the refusal names. Invoke it by **absolute path** — `<dash-worktree>/tugrust/target/debug/tugutil dash verify verify-surfaces` — because `~/.local/bin/tugutil` is a symlink into the main checkout's build and a bare `tugutil` from a worktree would report `unrecognized subcommand`.

**Tests:**
- [ ] Rust: `compose_conflict_message` names `tugutil dash verify` and carries no `{base}`/`{head}` substitution instruction.
- [ ] Rust: this repository's own `.tugtool/config.toml` loads and validates (a test that parses the committed file through `Config::load`, which is cheap and catches a hand-edit typo at commit time rather than at the next dash's ending).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugutil-core`
- [ ] `grep -rn 'verify-fit' tugplug tuglaws tugrust tugdeck tugcode scripts .tugtool` returns nothing but `tuglaws/design-decisions.md`'s historical [D149]/[D151] entries. **The tree-wide grep the earlier draft named cannot pass**: `dash/` is this feature's own paperwork — `dash-notes.md`, `verify-surfaces-brief.md`, `interruption-brief.md`, and this plan all name the script by design — so the sweep is scoped to the surfaces that are supposed to be clean rather than exception-listed after the fact.
- [ ] `grep -rn '{base}' tugplug tuglaws | grep -v design-decisions.md` returns nothing. The unfiltered form hits [D151], which quotes the substitution contract as history; that entry is not a consumer and the new `[D###]` is what re-points a reader.
- [ ] `<worktree>/tugrust/target/debug/tugutil dash config` prints the ten surfaces and no `verify:` line.

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `dash(verify-surfaces): integration checkpoint`

**References:** [P02] unclaimed is a refusal, [P12] this repository's table, (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay verify-surfaces` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: run the verb from the worktree by **absolute path** — `<dash-worktree>/tugrust/target/debug/tugutil dash verify verify-surfaces`, never a bare `tugutil`, which resolves through `~/.local/bin` to the main checkout's build and would not have the subcommand. This is the verb this plan built, over the table this plan wrote, which is the first real exercise of both. A refusal names a path [Table T01](#t01-tugtool-surfaces) missed: declare the surface, commit it as a round, re-run.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.
- [ ] Confirm the ending's own fact landed: `<dash-worktree>/tugrust/target/debug/tugutil dash status verify-surfaces` reports `Fit: verified at <head>`.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now — and that the feature verifies its own fit.

**Checkpoint:**
- [ ] The replay reports its outcome, and `tugutil dash verify` is green **or** the replay was correctly `Current`.
- [ ] `tugutil dash status verify-surfaces` shows the fit fact at the replayed head.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A project declares its surfaces in `.tugtool/config.toml`, and `tugutil dash verify <name>` proves that every path the dash would land is claimed by one, ran its checks, and recorded the result where the dash's faces can read it.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `[[tugtool.dash.surface]]` parses, and all eight [S01] refusals fire with the offending value named (Rust table test, [Step 1](#step-1))
- [ ] A config still declaring `verify =` refuses to load, naming the table (Rust test, [Step 1](#step-1))
- [ ] Longest-prefix resolution, exact root paths, `checked_by` expansion, and placeholder substitution are each a table test over a synthesized table (Rust tests, [Step 2](#step-2))
- [ ] An unclaimed path refuses with exit 2 before any check runs (Rust test, [Step 2](#step-2); CLI test, [Step 3](#step-3))
- [ ] A red surface does not stop the run, and the receipt names every failure (CLI test, [Step 3](#step-3))
- [ ] A project declaring no surfaces exits 0 with the declared-none receipt (CLI test, [Step 3](#step-3))
- [ ] A green verify writes one `verified` dash-log line and leaves the derived stage unchanged (Rust tests, [Step 4](#step-4))
- [ ] `dash status`, the dash lane row, and the join receipt each say the fit and never gate on it (Rust + `bun:test`, [Step 4](#step-4), [Step 5](#step-5), [Step 6](#step-6))
- [ ] A real dash whose round touches an unclaimed path shows the refusal, and declaring the surface clears it (app-test, [Step 5](#step-5))
- [ ] No document instructs a model to substitute `{base}`/`{head}` into a declared command, and `scripts/verify-fit.sh` is gone (prose assertion + `grep`, [Step 7](#step-7))
- [ ] This repository's committed config loads, validates, and claims every tracked top-level path (Rust test + a real run, [Step 7](#step-7), [Step 8](#step-8))

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run` — the workspace, on the last step that touches Rust
- [ ] `just app-test at0478-dash-fit-verified.test.ts`
- [ ] `tugutil dash verify verify-surfaces` on the replayed tree, green ([Step 8](#step-8))

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- A `tugutil dash verify --explain <path>` that answers "which surface claims this?" without running anything — useful while a project is first writing its table, and cheap once the resolver is pure.
- A surface-level `{paths}` consumer in this repository's own table (a `sh -n` sweep over changed shell scripts, a scoped app-test selection), once there is a command worth scoping. [P05] is deliberately proven by table test rather than by inventing one here.
- Teaching the arc's implement stage to read the fit fact and refuse to declare an ending without one — a real use of [P09] that is a separate decision about the arc, not about this verb.
