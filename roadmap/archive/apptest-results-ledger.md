## App-Test Results Ledger {#apptest-results-ledger}

**Purpose:** The app-test runner remembers every run's per-file results in a durable ledger and annotates each red file with its recorded history, so a failure on a dash can be told from a pre-existing failure by lookup instead of by bisection.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-21 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-21, opus.** Reviewed `plan:5bce8ef61dbbbaa5`. Lint: 0 errors, 1 warning (the missing Review Record this round adds).
Oriented on: the plan as devised this session, read against the tree.
Applied: the plan's second feature — a pid-mode refusal for "menu key equivalent" chords — was **cut**, and its causal claim recorded as falsified in [P04]. Three facts from the code killed it: 24 background tests post ⌘Return today (`at0425`, `at0435`, `at0436`, `at0442`, `at0444` among them, all verified green in the join-arc-2 run), so the motivating incident's stated cause cannot be right; ⌘A *is* a menu key equivalent (`AppDelegate.swift`, "Select All") and `at0339-session-find-bar` posts it in a background run and passes, so the predicate is false in the direction it mattered; and ⌘Return is not a menu key equivalent at all (no `\r` key equivalent exists), so the proposed refusal would never have fired on the case that motivated it. `tests/app-test/README.md` already documents a *different* hazard — multi-modifier chords intercepted by **windowserver**, whose remedy is synthetic `evalJS` dispatch — and windowserver is the foreground path that pid mode bypasses, so the plan's direction was arguably backwards. Asked the user, who chose to cut it rather than spend a step diagnosing.
Also applied: `tugutil-core` has no `rusqlite` dependency today (`Cargo.toml` lists only tugcore/serde/toml/thiserror/dirs/sha2), so Step 1 now names that addition, with `tugchanges-core` cited as the precedent for a `-core` crate owning a ledger; run provenance was being lost because `app-test-changed` and `app-test-all` both delegate to `just app-test <files>` and would record as `explicit-files`, so S01/S02 gained an explicit `selection` field fed by an env passthrough; the recipe's root argument became `{{justfile_directory()}}` rather than `$PWD`, since the runner body `cd`s into `tests/app-test` in its subshells; interrupted runs and dirty-tree greens were unaddressed, and both now have answers ([P06], [R04]).
Deferred: nothing. No Open Questions remain.

---

### Phase Overview {#phase-overview}

#### Context {#context}

`at0417-join-mode.test.ts` failed during the `join-arc-2` run. It had been red on `main` all along — but nothing anywhere records which app-tests are currently red, so proving "already broken, not yours" took roughly 35 minutes of reverse-patch probe-bisection at about six minutes a cycle. The information needed to answer it in one second had existed, in memory, at the end of every prior run.

The runner already computes everything a history needs. The `app-test` recipe in `Justfile` accumulates one `RESULT_ROWS` entry per file (`STATUS:file:passed:total:secs`), renders the `APP-TEST SUMMARY` text report from those rows, and — when `TUG_APPTEST_JSON` names a path — serializes the same arrays into a JSON document through `jq`, deliberately from the arrays rather than by re-parsing the printed text so the two renderings cannot drift. `START_EPOCH` / `END_EPOCH` bound the run, `SWEEP_LABEL` names it (`core` or `explicit-files`), and `FG_QUEUE` holds the files that took the screen. All of it dies with the shell. This plan persists it and reads it back.

One structural fact shapes the design: **every other app-test recipe delegates to `just app-test <files>`.** `app-test-changed` resolves its selection through `select-tests.ts` and then calls `just app-test $FILES`; `app-test-all` lists the corpus and does the same. So there is exactly one runner body to change — and, as a consequence, exactly one `SWEEP_LABEL` vocabulary, which cannot distinguish a changed-derived run from a hand-named one without help ([P05]).

Machinery this plan builds on, verified in the tree:

- **Ledger discipline.** Every writable ledger open goes through `tugcore::ledger_db` (`open`, `apply_pragmas`, `claim_writer`, in `tugrust/crates/tugcore/src/ledger_db.rs`), enforced by the `no_ad_hoc_ledger_opens` test, which scans production sources via `tugcore::source_scan::production_sources` (it excludes per-crate `tests/`, `fixtures/`, and trailing `#[cfg(test)] mod` blocks).
- **Machine-global paths.** `tugrust/crates/tugcore/src/instance.rs` holds `changes_db_path()` and `prompt_history_db_path()`. Each reads an env override first (`ENV_CHANGES_DB` / `ENV_PROMPT_HISTORY_DB`) so isolated test runs never touch the user's real ledger, then falls back to `base_data_dir().join(<name>)`, and each passes through `guard_isolated`. Each carries a doc comment arguing *why* it is machine-global rather than per-instance.
- **Migration regime.** `tugrust/crates/tugcast/src/prompt_ledger.rs` gates its schema on `PRAGMA user_version` against a registered migration list (`PROMPT_HISTORY_MIGRATIONS: &[(i64, &str)]`, seeded empty). This is the house pattern for a new ledger.
- **Worktree identity.** `tugcore::registry::linked_worktree_base(cwd: &Path) -> Option<PathBuf>` (`tugrust/crates/tugcore/src/registry.rs`) resolves a linked worktree to its base checkout — the same seam `same_project` binding uses. A dash worktree and its checkout are one project; history keyed by raw cwd would split it in exactly the situation this plan exists to serve.
- **Crate shape.** `tugutil-core` (`tugrust/crates/tugutil-core/`) depends on tugcore, serde, toml, thiserror, dirs, sha2 — **not** rusqlite. `tugchanges-core` is the precedent for a `-core` crate owning a ledger: it takes both `rusqlite` and `tugcore`. The `tugutil` binary already depends on rusqlite, serde_json, tugcore, and tugutil-core.

#### Strategy {#strategy}

Persist what the runner already computes, and read it back at the one moment it matters — when a file is red and the reader is about to ask "is this me?".

A new machine-global ledger, `apptest_results.db`, written and read only through two new `tugutil apptest` verbs, so the bash recipe never opens SQLite and no foreign SQLite ever touches a live ledger. The recipe pipes the per-file rows it already holds to `tugutil apptest record` after the summary, and asks `tugutil apptest history` about the red files before printing the `Failures:` section. Recording is telemetry: it can fail, and the run's verdict does not move.

#### Success Criteria (Measurable) {#success-criteria}

- A red file in any `just app-test*` run is annotated in both the text summary and `TUG_APPTEST_JSON` with one of exactly three history answers: last-recorded-green (sha, date, runs-ago), red-streak (count, oldest sha), or no-recorded-history.
- Two consecutive runs of one file produce two run rows and two result rows, readable through `tugutil apptest history` and `just db-inspect apptest_results`.
- A run recorded from a dash worktree is found by a history query keyed from the base checkout, and vice versa.
- The ledger prunes to a bounded size without operator action.
- A green run's stdout is byte-identical to today's — the ledger adds nothing to a passing report.
- A run with `tugutil` absent or failing still prints its report and exits on its own verdict, naming the skip on stderr.

#### Scope {#scope}

- New ledger module in `tugutil-core` (with the `rusqlite` dependency that requires), plus `apptest_results_db_path()` and its env override in `tugcore::instance`.
- Two new `tugutil apptest` subcommands: `record` and `history`.
- The `app-test` recipe body in `Justfile`: record after the summary, annotate red files, and a selection-label passthrough so delegating recipes keep their provenance.
- Documentation: `tests/app-test/README.md`, `tuglaws/app-test-harness.md`, `CLAUDE.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No chord-refusal work.** Cut in review; the reasoning is [P04], and it is recorded so it is not re-proposed from the same falsified premise.
- No automatic re-run, quarantine, or skip of known-red tests — the ledger informs the reader; selection policy does not change.
- No per-failure titles, messages, or notes in the ledger — the JSON document already carries those per run, and history needs only verdicts.
- No UI surface (Lens, cards) for test history — CLI and report only.
- No change to `select-tests.ts` selection logic or to the foreground ask flow.

#### Dependencies / Prerequisites {#dependencies}

- `tugutil` on PATH for the record and history calls. Absence is a named skip, never a failure ([P02]).
- `jq` for assembling the record payload and merging annotations — already a soft dependency of the `TUG_APPTEST_JSON` path, and its absence is already handled there by a named stderr line.

#### Constraints {#constraints}

- **Never open a live Tug ledger with a non-Tug SQLite.** The recipe shells to `tugutil`, never to `sqlite3` or bun's sqlite (the 2026-07-27 corruption doctrine).
- Warnings are errors (`-D warnings`) across the Rust workspace.
- **The app-test output is the report.** Recording must not write to stdout, must not filter or pipe the summary, and must not change a green run's rendering.
- Shared-ledger schema changes ride `PRAGMA user_version` with registered migrations, from v1 onward.
- Errors never fail silently: a history lookup that fails prints why, in place, rather than omitting the line.

#### Assumptions {#assumptions}

- App-test invocations are serialized behind the machine-wide gate, so ledger write contention is not a live concern; `ledger_db`'s pragmas (WAL, busy timeout) cover the residual case of a stray concurrent write.
- A run's `HEAD` does not move mid-run. The recipe reads it once, at record time, and a run that spans a checkout is mis-recorded — accepted, and named in [R03].

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. Scoping, retention, provenance, and the cut of the chord work are all decided below ([P01]–[P06]).

---

### Risks and Mitigations {#risks}

- **[R01] The ledger grows without bound.** Mitigation: retention is part of the schema's contract from v1 — pruning happens at record time, not by a janitor nobody runs ([P03]).
- **[R02] History keyed wrong splits across worktrees.** A dash run and a base run of the same file must share one history, or the feature fails exactly where the motivating incident happened. Mitigation: rows carry the resolved base root ([P01]); Step 1 proves a worktree-recorded run answers a base-keyed query.
- **[R03] A recorded sha can misrepresent the tree.** A dirty tree's sha names bytes that were not what ran, and an interrupted run records nothing at all. Mitigation: `dirty` is stored and **surfaced in the annotation** — a green recorded on a dirty tree says so, because it is materially weaker evidence than a clean one ([P06]). Interrupted runs are simply absent, which is why the annotation counts *recorded* runs and says so in those words.
- **[R04] Recipe integration breaks the "output is the report" contract.** Mitigation: recording writes only to the ledger and stderr; annotation adds lines inside the existing `Failures:` section, which only exists on a red run; a green run's stdout is unchanged, and Step 3's checkpoint asserts that by comparison rather than by inspection.

---

### Design Decisions {#design-decisions}

#### [P01] Machine-global ledger, keyed by resolved base root (DECIDED) {#p01-machine-global}

`apptest_results.db` sits beside `changes.db` in the top-level Tug data dir — **machine-global, deliberately independent of `TUG_INSTANCE_ID`** — for the reason `changes.db` gives in its own doc comment: the working tree is machine-global, so splitting the record per instance splits the truth. A debug instance would not see what the release instance's runs proved, and the question the ledger answers ("was this file red before I touched it?") is about the checkout, not about which build was driving.

Every run row stores two roots: the literal root the run executed in (`run_root`) and the **resolved base root** (`linked_worktree_base(run_root).unwrap_or(run_root)`, canonicalized). History queries key on the resolved base, so a dash worktree and its checkout share one history — the case the motivating incident lived in. Env override `TUG_APPTEST_RESULTS_DB` follows the `ENV_CHANGES_DB` convention exactly, so this plan's own tests never touch the real ledger.

#### [P02] The recipe writes through `tugutil`; recording never gates a run (DECIDED) {#p02-tugutil-writes}

The bash recipe shells to `tugutil apptest record` (payload on stdin) and `tugutil apptest history --json`. The Rust side opens the database exclusively through `tugcore::ledger_db::open`, which keeps `no_ad_hoc_ledger_opens` green and keeps a foreign SQLite away from a live WAL.

Recording is telemetry. When `tugutil` is absent, or the verb exits non-zero, the recipe prints one stderr line naming the skip and its reason (`[app-test] results not recorded: …`) and the run's verdict and exit code are untouched. A test runner that fails because its diagnostics failed would be a worse tool than the one we have.

#### [P03] Retention: the most recent 500 runs per base root, pruned at record time (DECIDED) {#p03-retention}

`prompt_history.db` has no retention because it is the user's corpus. This ledger is the opposite kind of thing: diagnostic telemetry whose whole value is "what happened recently on this checkout". `record` deletes run rows beyond the most recent 500 for that base root, and result rows follow by `ON DELETE CASCADE`. At the observed selective-run cadence that is months of history. The constant lives in one named place in the ledger module so the policy is legible and adjustable; pruning at record time means no janitor and no unbounded growth between maintenance passes.

#### [P04] The chord refusal is cut; its premise was falsified (DECIDED) {#p04-chord-cut}

This plan was devised with a second feature: a runtime refusal in the Swift test harness for background-mode chords that match a menu key equivalent, motivated by `at0418-join-outcomes.test.ts` reading as red in background runs and passing in the foreground. Review falsified it, and the finding is recorded here so nobody rebuilds it from the same premise.

- **⌘Return works in background.** Twenty-four background (non-`@foreground`) tests post `nativeKey("Return", ["cmd"])` today, including `at0425`, `at0435`, `at0436`, `at0442`, and `at0444` — all verified green in the `join-arc-2` run. Whatever made at0418 red, it was not that its gesture was ⌘Return in pid mode.
- **The predicate is false where it mattered.** ⌘A is a real menu key equivalent (`AppDelegate.swift`, "Select All", `keyEquivalent: "a"`), and `at0339-session-find-bar` posts it in a background run and passes. Menu-equivalent chords are not categorically dead in pid mode.
- **The predicate would have missed its own motivating case.** There is no Return key equivalent anywhere in the menu; ⌘Return is handled by the CodeMirror keymap in the web layer (`tugdeck/src/components/tugways/tug-text-editor/keymap.ts`). The proposed check could not have fired on at0418.
- **The documented hazard is a different one.** `tests/app-test/README.md` warns that multi-modifier native chords can be intercepted **by windowserver**, and its remedy is synthetic `evalJS` dispatch rather than the foreground tier. Windowserver is the session-mode path that pid mode bypasses, so if anything the proposed rule pointed the wrong way.

at0418 is deleted, so its actual failure cause is not cheaply recoverable, and there is no reproducible silent-chord case in the tree to design against. Building an enforcement mechanism against an unproven failure mode would add a refusal that fires on ~30 currently-green files and blocks nothing real. The user chose to cut it. If a genuine silent-chord case appears, it starts with a reproduction, not with a rule.

#### [P05] The ledger records how a run was selected, not just what it was labeled (DECIDED) {#p05-selection-provenance}

`SWEEP_LABEL` has two values (`core`, `explicit-files`) and cannot say more, because `app-test-changed` and `app-test-all` both reach the runner by delegating to `just app-test <files>` — so a changed-derived run and a hand-named run are indistinguishable at the point of record. That distinction is exactly what a reader wants later ("was this file selected because I touched its `@covers` source?").

So the delegating recipes export `TUG_APPTEST_SELECTION` (`changed` | `all` | `core` | `explicit`) before delegating, and the runner records it as `selection` alongside `sweep`. Absent variable means `explicit`; the runner never guesses.

#### [P06] History has exactly three answers, computed in Rust, rendered from one source (DECIDED) {#p06-three-answers}

`history` returns, per file, one of three answers, with `SKIP` rows excluded from consideration entirely:

- **`last-green`** — `{sha, date, runsAgo, dirty}` of the most recent PASS.
- **`red-streak`** — `{count, backToSha, backToDate}` over the consecutive most-recent FAIL/ERR rows, carrying `lastGreen` too when one exists further back.
- **`no-history`** — no recorded rows for this base root and file.

Two properties are deliberate. `runsAgo` counts **recorded** runs, and the rendering says "recorded" in those words, because an interrupted run leaves no row and a count that implied otherwise would be a quiet lie. And `dirty` rides the answer, because "last green at `f1c9cdbfb` (dirty tree)" is materially weaker evidence than a clean green and the reader is entitled to tell them apart.

Both renderings — the text line and the `TUG_APPTEST_JSON` field — are formatted from the verb's single JSON output. The recipe formats; it never re-derives. This mirrors the existing rule that the document and the summary serialize the same arrays.

---

### Specification {#specification}

#### S01 — Schema v1 {#s01-schema}

```sql
CREATE TABLE runs (
  id          INTEGER PRIMARY KEY,
  started_at  INTEGER NOT NULL,   -- unix epoch seconds
  ended_at    INTEGER NOT NULL,
  base_root   TEXT NOT NULL,      -- canonical resolved base checkout ([P01])
  run_root    TEXT NOT NULL,      -- literal root the run executed in
  branch      TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  dirty       INTEGER NOT NULL,   -- 0|1, `git status --porcelain` non-empty
  sweep       TEXT NOT NULL,      -- SWEEP_LABEL: core | explicit-files
  selection   TEXT NOT NULL,      -- changed | all | core | explicit ([P05])
  wall_secs   INTEGER NOT NULL,
  verdict     TEXT NOT NULL       -- PASS | FAIL
);
CREATE TABLE results (
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  file        TEXT NOT NULL,      -- e.g. at0445-join-prompt.test.ts
  status      TEXT NOT NULL,      -- PASS | FAIL | ERR | SKIP
  passed      INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  secs        INTEGER NOT NULL,
  foreground  INTEGER NOT NULL    -- 0|1, ran from FG_QUEUE
);
CREATE INDEX results_by_file ON results (file, run_id);
CREATE INDEX runs_by_base ON runs (base_root, id);
```

`PRAGMA user_version = 1`, with `APPTEST_RESULTS_MIGRATIONS: &[(i64, &str)] = &[]` seeded empty — the `prompt_ledger.rs` regime. `PRAGMA foreign_keys` must be on for the cascade; assert it in the module's open path rather than assuming `ledger_db::apply_pragmas` sets it.

#### S02 — `tugutil apptest record` input (stdin JSON) {#s02-record-input}

```json
{
  "startedAt": 1755820000, "endedAt": 1755820140,
  "runRoot": "/abs/run/root", "branch": "main", "headSha": "f1c9cdbfb",
  "dirty": true, "sweep": "explicit-files", "selection": "changed",
  "wallSecs": 140, "verdict": "PASS",
  "files": [
    {"file": "at0445-join-prompt.test.ts", "status": "PASS",
     "passed": 6, "total": 6, "secs": 41, "foreground": false}
  ]
}
```

The verb resolves `baseRoot` from `runRoot` itself ([P01]) — the recipe never computes it, so the resolution rule lives in exactly one language. Output on stdout: `{"recorded": true, "runId": N, "pruned": M}`. Exits non-zero only on malformed input or an unopenable database, and writes nothing in either case.

#### S03 — `tugutil apptest history` output {#s03-history-output}

`tugutil apptest history --root <run-root> --json <file>…` →

```json
{"files": [
  {"file": "at0417-join-mode.test.ts", "answer": "red-streak",
   "count": 4, "backToSha": "dac7cfc", "backToDate": "2026-08-19",
   "lastGreen": {"sha": "0519182", "date": "2026-08-18", "runsAgo": 7, "dirty": false}},
  {"file": "at0500-new.test.ts", "answer": "no-history"}
]}
```

`answer` is one of `last-green`, `red-streak`, `no-history` ([P06]). `--root` is resolved through the same base-root rule as `record`. Dates are the UTC date of `ended_at`.

#### S04 — Failures-section annotation {#s04-annotation}

One added line beneath each red file's entry in the existing `Failures:` section, one of:

```
      history: last green 0519182 (2026-08-18, 7 recorded runs ago)
      history: last green 0519182 (2026-08-18, 7 recorded runs ago, dirty tree)
      history: red in the last 4 recorded runs, back to dac7cfc (2026-08-19); last green 0519182 (2026-08-18)
      history: no recorded runs for this file
      history: unavailable (tugutil apptest history exited 1)
```

The same object lands as `history` on that file's entry in the `TUG_APPTEST_JSON` document. A green run gains no line anywhere — the `Failures:` section does not exist on a green run, and nothing else moves.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

- `tugrust/crates/tugutil-core/src/apptest_ledger.rs` — schema, open/migrate, record, history, retention.
- `tugrust/crates/tugutil/src/apptest.rs` — the `apptest record` and `apptest history` verbs.

#### Symbols to add / modify {#symbols}

- `tugcore::instance::apptest_results_db_path()` and `ENV_APPTEST_RESULTS_DB` (`tugrust/crates/tugcore/src/instance.rs`), with a doc comment arguing [P01] in the register of its neighbors.
- `tugutil_core::apptest_ledger::{open_ledger, record_run, file_history, RunRecord, FileResult, FileHistory, MAX_RUNS_PER_ROOT}`.
- `tugrust/crates/tugutil-core/Cargo.toml` — add `rusqlite.workspace = true` (the crate has no SQLite dependency today; `tugchanges-core` is the precedent).
- `tugutil` `cli.rs` — an `Apptest` subcommand with `Record` and `History` arms, registered beside the existing verbs.
- `Justfile` — the `app-test` recipe body (record after the summary; history before `Failures:`; `history` merged into the JSON document), and `TUG_APPTEST_SELECTION` exported by `app-test-changed` and `app-test-all` ([P05]).

---

### Documentation Plan {#documentation-plan}

- `tests/app-test/README.md` — a "Results history" subsection: what a run records, the three answers and how to read them, the `TUG_APPTEST_RESULTS_DB` override, and `just db-inspect apptest_results` as the way to look.
- `tuglaws/app-test-harness.md` — the ledger as doctrine: it informs the reader and never gates a run; a red file arrives with its history attached.
- `CLAUDE.md` — `apptest_results.db` named in the ledger passage alongside `changes.db` and `prompt_history.db`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Ledger open, migrate, record, history, retention against tempdir databases | Step 1 |
| **Integration (CLI)** | The `tugutil apptest` verbs end to end through `TUG_APPTEST_RESULTS_DB` | Step 2 |
| **Integration (recipe)** | A real `just app-test <file>` run records, and a red run annotates | Step 3 |

#### What stays out of tests {#test-non-goals}

- No fixture SQLite files — every test builds its database through the module's own `open_ledger`, so the tests exercise the real open path rather than a hand-made file that can drift from it.
- No app-test of the annotation. The annotation is bash rendering over a verb's JSON; the verb's answers are proven in Rust and the rendering is proven by Step 3's real two-run integration check. An app-test here would launch Tug.app to observe text the app never produces.
- No assertion pinning the retention constant's exact value beyond the pruning test — the number is policy, the pruning is the behavior.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The ledger module: schema, record, history, retention | done | `076955840` |
| #step-2 | The `tugutil apptest` verbs | done | `ad34971d6` |
| #step-3 | The recipe records and annotates | done | `6392a2e0d` |
| #step-4 | Documentation sync | done | `ed4732af5` |
| #step-5 | Integration Checkpoint | done | `f42d05208` |

#### Step 1: The ledger module: schema, record, history, retention {#step-1}

**Commit:** `tugutil-core: app-test results ledger with history and retention`

**References:** [P01] (#p01-machine-global), [P03] (#p03-retention), [P06] (#p06-three-answers), S01 (#s01-schema), (#context)

**Artifacts:**
- `tugrust/crates/tugutil-core/src/apptest_ledger.rs`, its `rusqlite` dependency, and `apptest_results_db_path()` + `ENV_APPTEST_RESULTS_DB` in `tugrust/crates/tugcore/src/instance.rs`.

**Tasks:**
- [ ] Add `rusqlite.workspace = true` to `tugrust/crates/tugutil-core/Cargo.toml` (the crate has none today; `tugchanges-core/Cargo.toml` shows the shape).
- [ ] Add `apptest_results_db_path()` to `tugcore::instance`, following `changes_db_path` exactly: env override first, then `base_data_dir().join("apptest_results.db")`, through `guard_isolated`, with a doc comment arguing [P01].
- [ ] Write `apptest_ledger.rs`: `open_ledger(path)` opens through `tugcore::ledger_db::open`, creates S01 on a fresh database, enables `foreign_keys`, and gates on `PRAGMA user_version` against `APPTEST_RESULTS_MIGRATIONS` (seeded empty), following `prompt_ledger.rs`.
- [ ] `record_run(conn, RunRecord) -> RecordedRun`: resolve `base_root` via `tugcore::registry::linked_worktree_base` with canonicalization, insert the run and its results in one transaction, then prune beyond `MAX_RUNS_PER_ROOT` (500) for that base root and report how many runs were pruned.
- [ ] `file_history(conn, base_root, files) -> Vec<FileHistory>`: the three answers of [P06], excluding `SKIP` rows, carrying `dirty` on a green and counting recorded runs for `runsAgo`.

**Tests:**
- [ ] Fresh-database open creates the schema at version 1, and reopening is idempotent.
- [ ] Record two runs, then query: two run rows, and history reads `last-green` with `runsAgo` 1.
- [ ] FAIL after PASS after two FAILs yields `red-streak` with count 1 and `lastGreen` present — the streak counts only the consecutive tail, not every red ever recorded.
- [ ] A run recorded from a linked worktree answers a history query keyed from the base checkout root, and the reverse ([R02]).
- [ ] A green recorded on a dirty tree comes back with `dirty: true` ([R03]).
- [ ] Insert 502 runs for one base root: the oldest two are pruned and their result rows cascade away, while a second base root's runs are untouched.
- [ ] `SKIP` rows never produce or influence any of the three answers.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core -p tugcore` green, including `no_ad_hoc_ledger_opens`.

---

#### Step 2: The `tugutil apptest` verbs {#step-2}

**Depends on:** #step-1

**Commit:** `tugutil: apptest record and apptest history verbs`

**References:** [P02] (#p02-tugutil-writes), [P05] (#p05-selection-provenance), S02 (#s02-record-input), S03 (#s03-history-output)

**Artifacts:**
- `tugrust/crates/tugutil/src/apptest.rs`, and the `Apptest { Record, History }` subcommand in `cli.rs`.

**Tasks:**
- [ ] `tugutil apptest record` reads S02 from stdin, calls `record_run`, and prints `{"recorded":true,"runId":N,"pruned":M}`; malformed input exits non-zero with a message naming the offending field.
- [ ] `tugutil apptest history --root <path> --json <file>…` resolves its root the same way `record` does and prints S03.
- [ ] Both honor `TUG_APPTEST_RESULTS_DB`, so the CLI suite and the recipe test can point at a temporary database.
- [ ] A missing `selection` in the payload records `explicit` rather than failing ([P05]).

**Tests:**
- [ ] CLI round trip against a tempdir database via the env override: record S02, `history` answers `last-green`; record a FAIL run, `history` flips to `red-streak` carrying `lastGreen`.
- [ ] `history` for a file with no rows answers `no-history` rather than erroring.
- [ ] `record` with a required field missing exits non-zero and leaves the database untouched.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil` green.

---

#### Step 3: The recipe records and annotates {#step-3}

**Depends on:** #step-2

**Commit:** `just app-test: record results and annotate red files with history`

**References:** [P02] (#p02-tugutil-writes), [P05] (#p05-selection-provenance), [P06] (#p06-three-answers), S04 (#s04-annotation), [R04] (#risks), (#constraints)

**Artifacts:**
- The `app-test` recipe body in `Justfile`, plus `TUG_APPTEST_SELECTION` exports in `app-test-changed` and `app-test-all`.

**Tasks:**
- [ ] After the summary's arrays are final, assemble S02 with `jq` from `RESULT_ROWS` (foreground from `FG_QUEUE` membership), `SWEEP_LABEL`, `TUG_APPTEST_SELECTION`, `START_EPOCH`/`END_EPOCH`, and `git rev-parse HEAD` / `rev-parse --abbrev-ref HEAD` / `status --porcelain`, and pipe it to `tugutil apptest record`. Pass `--root {{justfile_directory()}}`, not `$PWD` — the runner body `cd`s into `tests/app-test` inside its subshells.
- [ ] Absence of `tugutil` or `jq`, or a non-zero exit from either, prints one stderr line naming the skip and its reason; the verdict and exit code do not move ([P02]).
- [ ] Before rendering `Failures:`, when red files exist, call `tugutil apptest history --root {{justfile_directory()}} --json <red files>` **once** for the whole set, and format S04's line per file from that JSON. On any failure print `history: unavailable (<reason>)` rather than nothing.
- [ ] Attach the same per-file history objects to the `TUG_APPTEST_JSON` document as a `history` key on each file entry, from the same JSON the text line formats ([P06]).
- [ ] Export `TUG_APPTEST_SELECTION` from `app-test-changed` (`changed`) and `app-test-all` (`all`) before they delegate; the runner defaults to `core` when invoked with no files and `explicit` otherwise.

**Tests:**
- [ ] Against an env-pointed temporary database, run one small stable green file twice: the second run's `tugutil apptest history` reports `last-green` with `runsAgo` 1, and both runs are present.
- [ ] A red run annotates: point `TUG_APPTEST_RESULTS_DB` at a temp database seeded through the verbs so a chosen file has a recorded green, then run a file made to fail (via `tugutil file probe`, which restores bytes and mtime), and read the `history:` line in the `Failures:` section and the `history` key in a `TUG_APPTEST_JSON` document.
- [ ] `just hooks-test` green — the app-test output-gate pins the summary's shape.

**Checkpoint:**
- [ ] Both integration runs above behave as described, and a green run's stdout is byte-identical to the same run with recording disabled ([R04]).

---

#### Step 4: Documentation sync {#step-4}

**Depends on:** #step-3

**Commit:** `docs: the app-test results ledger and how to read a history line`

**References:** (#documentation-plan), [P01] (#p01-machine-global), [P03] (#p03-retention), [P06] (#p06-three-answers)

**Tasks:**
- [ ] `tests/app-test/README.md`: a "Results history" subsection — what is recorded, the three answers and what each licenses the reader to conclude, `TUG_APPTEST_RESULTS_DB`, and `just db-inspect apptest_results`.
- [ ] `tuglaws/app-test-harness.md`: the ledger as doctrine — telemetry that informs and never gates, and a red file that arrives carrying its own history.
- [ ] `CLAUDE.md`: `apptest_results.db` named in the ledger-databases passage.

**Tests:**
- [ ] None (prose).

**Checkpoint:**
- [ ] `grep -n "apptest_results" tests/app-test/README.md tuglaws/app-test-harness.md CLAUDE.md` finds all three, and each surface shipped in Steps 1–3 is named in prose.

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [D149] by reference

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what is verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with `sh scripts/verify-fit.sh <base-sha> <head-sha>`.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every app-test run leaves a durable record, and every red file arrives pre-labeled with its own history — so "is this me, or was it already broken?" is a line in the report rather than an afternoon.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Two consecutive runs are recorded and readable back through the verbs (recipe integration test, Step 3).
- [ ] A red file carries one of the three answers in both the text summary and the JSON document (verb tests, Step 2; recipe wiring, Step 3).
- [ ] A dash worktree and its base checkout share one history (Rust test, Step 1).
- [ ] Retention prunes past 500 runs per base root, cascading result rows (Rust test, Step 1).
- [ ] A green run's stdout is unchanged, and a run with `tugutil` missing still reports and exits on its own verdict (Step 3 checkpoint).
- [ ] The ledger is documented where a reader will meet it (grep checkpoint, Step 4).

**Acceptance tests:**
- [ ] The two-run recording check against an env-pointed temporary database (Step 3).
- [ ] The seeded-history red-run annotation check (Step 3).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- Teach `app-test-changed`'s selection printout to mark files the ledger currently shows as red-streaked, so a known-red file is visible *before* the run spends minutes on it.
- A human (non-`--json`) rendering of `tugutil apptest history` for hand queries.
- Surface a "first green after a streak" note for files that recover, if reading the reports reveals a want for it.
