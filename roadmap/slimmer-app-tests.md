<!-- devise-skeleton v5 -->

## Slimmer App-Tests — the run scopes to the session, and the corpus stops growing by default {#slimmer-app-tests}

**Purpose:** Make `just app-test-changed` select only the tests the *current session's* changes can affect, retire the tests that cost maintenance without guarding a behavior, and give the harness the cost and completeness signals it currently lacks — so an app-test run stops being a tax every session pays for every other session's work.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-21 |

---

### Review Record {#review-record}

<!-- Appended by /tugplug:plan-review. One paragraph per round, never rewritten. -->

**Round 1 — 2026-08-21, opus.** Reviewed `plan:cb6eb1cdeafe074a`. Lint: 0 errors, 0 warnings, clean on first authoring and again after the fixups below.
Oriented on: the whole document — a first pass on a plan devised in the same session.
Applied: **factual correction** — [P06]'s rationale asserted the core tier prints `VERDICT: PASS (20/20 files green)` while five files skipped; the recorded 2026-08-21 run actually prints `Files skipped: 5` in the summary block and `VERDICT: PASS (15/20 files green; 29/29 tests passed)`. The defect is real but narrower than stated — the VERDICT line reports `files_passed`/`files_run` with `files_run` counting skips, so it reads `15/20 green` *and* `PASS` while never accounting for the five. Rewrote [P06], Spec S02 (which now shows today's grammar beside the replacement), the `#skip-path` deep dive, and Step 9's tasks, which now say explicitly not to re-add the `Files skipped:` row that already exists. **Implementation hazard** — verified that `RESULT_ROWS` is parsed in *three* places, not the two [P09] claimed (tally loop, per-file table, JSON block), and that `read`'s last variable absorbs the remainder, so appending a fifth field to a four-variable read yields `rtotal="1:7"` and kills the tally loop with an arithmetic error; reproduced it in a shell and recorded the reproduction in `#skip-path`, with Step 10's task now requiring all three reads to change in one commit. **Missing law cross-check** — added `#tuglaws-cross-check`, naming [L29] and [L31], and with it Risk R05: `select-tests.ts` derives `REPO_ROOT` from `import.meta.dir`, this checkout is reachable as both `/Users/…/Mounts/u/src/tugtool` and `/u/src/tugtool`, and a spelling mismatch on `--project` would return an empty `files` array with exit 0 — a total selection failure indistinguishable from a clean tree. Verified both spellings currently agree because `tugutil` canonicalizes behind the gateway, and turned that into the design rule: the selector passes the raw root and never canonicalizes in TypeScript. **Sequencing** — Step 5 depended on Step 4 for ordering reasons only; the deletion pass needs nothing from session scoping, so the dependency now names Step 1 and Strategy states that ledger order is payoff order while `Depends on:` lines stay minimal. **Falsifiability** — Step 6's checkpoint said "materially below 233" and now names ≤ 180, with an explicit escape if an honest review cannot reach it. Also confirmed against the tree: `ForeignChange` already derives `Serialize`, `ChangesReport` has no `Deserialize` (so Risk R04 has no Rust-side strict-decode path), the `--core`/`--foreground` early exits do precede the ledger call (Risk R03), and the 696-vs-632 figures in Table T01 use different root sets — now stated so a cold reader does not read them as contradictory.
Deferred: nothing new. [Q01] (core-tier membership) and [Q02] (subtree `@covers` breadth) were both raised during devising and deliberately left open because each needs data this plan's own steps produce; neither is a question the user declined to settle so much as one no one can answer yet, and both carry a concrete re-open trigger.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The app-test corpus is 233 `at*.test.ts` files plus 11 in `harness-smoke/` — 86,510 lines carrying 723 `launchTugApp` calls. **112 of the 233 were created in August 2026 alone**, so the corpus roughly doubled in three weeks with no retirement counterweight. Running everything costs ~27 minutes of serialized `Tug.app` launches.

Two independent failures make that corpus more expensive than it needs to be, and this plan attacks both.

**The selector cannot see sessions.** `changedFromGit()` in `tests/app-test/scripts/select-tests.ts` shells `git status --porcelain -z --untracked-files=all` over the whole worktree. There is no read of `$TUG_SESSION_ID` and no read of the changes ledger anywhere in that file. Meanwhile `tugutil changes` already exists and is documented as *"Which files this session changed (ledger ∩ git status)"*, and `tugchanges-core::changes.rs` already computes three buckets in `compute_changes` — `attributed` (this session holds a live proof row), `unattributed` (no proof owner anywhere, sometimes carrying a bracket hint), and **`foreign` (another session holds the proof row)**. The selector consumes the union of all three and cannot tell them apart, so every session is tested on every other session's work. Measured by merging *k* consecutive commits as a stand-in for *k* concurrent sessions' dirty state: 1 → 13 tests selected, **2 → 24, which exceeds the 20-file budget and is REFUSED outright**, 3 → 31, 5 → 46. At *k*=3 roughly 58% of a selected run is other sessions' work; at *k*≥2 the tool refuses and tells the developer to "narrow the diff" — advice they cannot act on, because the offending files are not theirs.

**The corpus grows and nothing shrinks it.** `ACCEPTED_FANOUT` in the same file carries a comment insisting that a budget with an override is not a budget and that raising an entry "should be a deliberate, argued act, not a reflex". Its git history says otherwise: `tugdeck/src/components/tugways/focus-manager.ts` went 63 → 64 → 65 → 66 → 67 → 68 in six separately-argued `+1` bumps between 2026-08-10 and 2026-08-11, dropped to 26 in one real deletion pass (`b80947798`), then was raised to 29 the same day (`c9ac83564`). One deletion pass beat six rounds of ratcheting, and the ratchet resumed immediately. Alongside that, 25 test files have a `@covers` set that is a strict subset of another test's — they can never be selected alone — and of the 168 tests with three or more commits, **112 have only ever been modified in the same commit as their source**, which is the change-detector signature: they cost maintenance on every source edit and can only fail when you already knew you changed the behavior.

Three smaller defects surfaced during the same investigation and are folded in because they are cheap and because two of them block honest measurement of the first two problems.

#### Strategy {#strategy}

- **Steps are ordered by payoff**, per the investigation's ranking, with two cheap enablers pulled to the front because later checkpoints cannot be verified without them: the orphaned pure-logic tests need a home before new selector tests can be run by anything, and `--print` must actually print before any selection size can be measured from a script.
- **Build on the ledger that ships.** Session attribution is a solved problem in `tugchanges-core`; this plan wires the selector to it rather than growing a second notion of "whose change is this".
- **Extend, never fork, the JSON contract.** `changes --json` gains two additive fields; no existing consumer changes.
- **Delete before locking.** The fan-out ratchet is made one-way *after* the deletion pass, so the recorded numbers lock in at their post-deletion floor rather than their inflated present.
- **Guard the deletion with a measured invariant.** A deletion pass that quietly abandons a surface is worse than no deletion pass; `--holes` gives a before/after count that makes abandonment falsifiable.
- **Measure cost before tuning the budget.** The only cost model in the repo today is a hardcoded 15s/file; measured cost is ~7s/file. The budget constant is corrected from data, last, once per-file durations exist.
- **Step order is by payoff; `**Depends on:**` lines are minimal and real.** The two do not always agree — the deletion pass (Steps 5–6) needs nothing from session scoping (Step 4) and could land first or in parallel. The ledger order expresses the intended walk; the dependency lines express what actually blocks what, so a step is never serialized behind work it does not need.

#### Success Criteria (Measurable) {#success-criteria}

- With two or more sessions' work dirty in the tree simultaneously, `just app-test-changed` selects only the invoking session's files and no longer hits `EXIT_OVER_BUDGET` for that reason. Verify by seeding two `TUG_SESSION_ID`s with disjoint proof rows and running the selector under each: neither selection contains a test selected solely by the other's files.
- `bun scripts/select-tests.ts --print <paths>` writes the selected filenames to **stdout** (today it writes none). Verify: `bun scripts/select-tests.ts --print tugdeck/src/components/tugways/focus-manager.ts | wc -l` is non-zero.
- The corpus is smaller than it is today by a stated count, with **no increase in coverage holes**: `bun scripts/select-tests.ts --holes | wc -l` is ≤ 632 after the deletion pass.
- No `ACCEPTED_FANOUT` entry can be raised: `just app-test-covers-check` fails when an entry's recorded number is increased without the entry being removed and re-added.
- A run in which any file was skipped never prints a bare `VERDICT: PASS`. Verify: `TUG_APPTEST_ASSUME=background just app-test` prints a skipped count in the VERDICT line, and `TUG_APPTEST_JSON` records `filesSkipped > 0`.
- Every file in a run has a recorded duration in the JSON document, and `MAX_SELECTED`'s user-facing minute estimate is derived from measured data rather than the literal `15`.

#### Scope {#scope}

1. Session-scoped selection input for `select-tests.ts`, backed by an additive extension to `tugutil changes --json`.
2. A deletion pass over the corpus: the 25 mechanical subset duplicates, then a reviewed cut of the 112 change-detectors.
3. A one-way-downward `ACCEPTED_FANOUT` ratchet and a total-corpus ceiling, both enforced by `app-test-covers-check`.
4. The `--print` stdout defect.
5. Skipped-file visibility in the `VERDICT` line and the JSON document.
6. Per-file duration capture in the runner and the JSON document, and a measured replacement for the hardcoded cost constant.
7. A home in `just test-ts` for the 69 orphaned pure-logic tests under `tests/app-test/scripts/` and `tests/app-test/_harness/`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the `@covers` mechanism itself. Colocated declarations stay; this plan narrows what feeds them and how many tests they can select, not how they are written.
- Rewriting the core tier's membership. Its composition is a real question but needs the timing data this plan produces first — see [Q01].
- Parallelizing app-test execution. The machine-wide gate exists because native CGEvent input and key-window status are login-session singletons; that is not negotiable here.
- Touching the accessibility-grant or bundle-identity machinery.
- Any change to how `tugchanges-core` *decides* attribution. This plan consumes `compute_changes`' existing verdicts; it does not re-grade evidence.

#### Dependencies / Prerequisites {#dependencies}

- `tugrust/target/debug/tugutil` must be buildable — the selector will shell it. The `app-test` recipe already builds it for the gate, so this is not a new dependency for the recipe path, but it is new for a bare `bun scripts/select-tests.ts` invocation.
- `bun` for the selector and its tests; `jq` for the existing `TUG_APPTEST_JSON` document path.
- A built app-test bundle (`just build-app`) for any step whose checkpoint runs real tests.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace (`tugrust/.cargo/config.toml` enforces `-D warnings`).
- `changes --json` is a shipped contract consumed elsewhere; changes to it must be **additive only**.
- The runner loop in the `app-test` recipe runs under `/bin/bash`, and **macOS ships bash 3.2** — the loop already carries a comment about avoiding negative array indices for exactly this reason. No bash 4+ constructs (associative arrays, `${var,,}`, negative indices).
- App-tests must never be run as a full sweep on the implementer's own initiative; selective runs are the default and `just app-test` (core tier) is the answer to an unscopeable change.
- `tugutil changes` exits **2** when the session cannot be resolved (verified: `tugutil changes --session bogus --json` → exit 2). The selector must treat that as "no session information", not as a hard error.

#### Assumptions {#assumptions}

- `TUG_SESSION_ID` is present in the environment of a session-driven `just app-test-changed`. It is exported in Tug's Session card shell route (verified: it is set in this session), and its absence is handled by the fallback in [P03].
- The measured per-file cost (~7s) is representative. It was taken from two real runs on 2026-08-21: a 3-file run at 8s wall, and the 20-file core tier at 106s wall of which 15 files actually executed.
- The 25 subset pairs and 112 change-detectors are candidate lists, not verdicts. Step 6 reviews them; some will be kept.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should the core tier's membership change once per-file timing exists? (DEFERRED) {#q01-core-tier-membership}

**Question:** The 20-file core tier costs 106s and yields 29 `bun:test` cases — about 1.5 cases per file per 5.3s. Is that the right sample, and is 20 the right size?

**Why it matters:** The core tier is the answer to every unscopeable change and to the `CORE TIER ADVISED` advisory, so its cost is paid often. If a third of it is redundant with another third, that is a recurring tax on the most common broad run.

**Options (if known):**
- Keep the 20 as-is; the tier's value is surface coverage, not case count.
- Re-derive membership from measured cost-per-surface once Step 10 lands.
- Shrink to a faster tier and add a second, slower "broad" tier.

**Plan to resolve:** Re-open after Step 10 has recorded per-file durations across a full `just app-test-all`, so the decision is made against measured cost rather than the current guess. Deliberately deferred rather than guessed — the data this plan produces is exactly what the answer needs.

**Resolution:** DEFERRED — revisit after [#step-10](#step-10); a follow-on plan, not a step here.

#### [Q02] Should subtree `@covers` declarations be banned outright? (DEFERRED) {#q02-subtree-covers}

**Question:** 20 of the 529 distinct `@covers` values name a whole subtree or glob, including `tugrust/crates/tugcast/` (6 tests fire on any change anywhere in the crate), `tugcode/` (6), `tugdeck/src/components/tugways/tug-text-editor/` (10), and `tugapp/Sources/`. Should the lint reject subtree declarations above some breadth?

**Why it matters:** These are the cheapest declarations to write and the widest to fire. One observed commit had `tugrust/crates/tugcast/src/feeds/changeset.rs` drag in three *permission* tests and a *usage sheet* test.

**Options (if known):**
- Ban trailing-`/` declarations above N files in the subtree.
- Leave them; the per-path fan-out budget already bounds the harm.
- Require a subtree declaration to carry a justification comment, checked by the lint.

**Plan to resolve:** Measure after the deletion pass. Steps 5–6 will remove some of the tests that make these subtrees expensive, and the honest breadth of the survivors is not knowable until then. Re-open with post-deletion fan-out numbers.

**Resolution:** DEFERRED — revisit after [#step-6](#step-6).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Deletion pass abandons a live surface | high | med | `--holes` count guard; core tier must stay green | `--holes` count rises above 632 |
| Session scoping under-selects, missing a real regression | high | med | Unattributed-with-hint inclusion ([P02]); whole-tree fallback ([P03]) | A regression lands that the old selector would have caught |
| Ledger unavailable or slow in the recipe's hot path | med | low | Exit-2 and error paths fall back to `git status`, with a printed reason | Selector adds >1s to `app-test-changed` |
| bash 3.2 incompatibility in the runner loop | med | med | No bash 4+ constructs; checkpoint runs the real recipe | Runner errors on `/bin/bash` |
| Project-path spelling mismatch empties the selection silently | high | low | Canonicalize only in Rust ([L29]); distinguishable note on all-empty-but-dirty | `app-test-changed` reports nothing to run on a dirty tree |

**Risk R01: The deletion pass silently abandons a surface** {#r01-deletion-abandons-surface}

- **Risk:** Retiring a change-detector test removes the only selector for a source file, turning a covered surface into a coverage hole nobody notices.
- **Mitigation:**
  - Capture the hole baseline before the pass: today `bun scripts/select-tests.ts --holes | wc -l` reports **632**.
  - Every deletion commit's checkpoint asserts the count has not risen.
  - The retired file list, with a one-line reason each, goes in the commit message — not in a code comment (no bug-history in comments).
- **Residual risk:** A surface covered by two tests that both get retired shows no hole-count change if a third test still names the path while asserting nothing about it. `--holes` measures selection, not assertion quality; it cannot catch that.

**Risk R02: Session scoping hides a real regression** {#r02-scoping-hides-regression}

- **Risk:** A session edits file A; another session's concurrent edit to file B breaks a test that A's change also touches. Scoped selection runs neither session into that test.
- **Mitigation:**
  - This is the pre-existing state for *sequential* work and is what commit-time verification is for; scoping does not make it worse than testing each change alone.
  - The core tier remains the answer to "did I break everything", unchanged.
  - `--include-unattributed`-style breadth stays available via the explicit-paths form: `just app-test-changed <paths…>` still accepts hand-named paths and bypasses ledger scoping entirely.
- **Residual risk:** Genuine cross-session interaction bugs are found at landing rather than during the session. Accepted: that is where `just app-test` and the user's landing gesture already sit.

**Risk R03: The ledger call becomes a latency tax on every selection** {#r03-ledger-latency}

- **Risk:** `select-tests.ts` shells `tugutil changes --json` on every invocation, including the pre-gate `--core` and `--foreground` calls in the `app-test` recipe.
- **Mitigation:** Only the *derived* path (no explicit paths, no `--core`, no `--foreground`) calls the ledger; the early-exit branches for `--core` and `--foreground` in `select-tests.ts` return before `changedFromGit()` is ever reached, and that ordering is preserved.
- **Residual risk:** A cold `tugutil` build makes the first derived selection slow. The recipe already builds `tugutil` for the gate, so this only bites a bare script invocation.

**Risk R04: An additive JSON field breaks a strict consumer** {#r04-json-additive}

- **Risk:** Some consumer of `changes --json` deserializes strictly and rejects unknown fields.
- **Mitigation:** Grep every consumer before landing Step 3. `ChangesReport` carries no `Deserialize` derive anywhere in `changes.rs` (verified), so the Rust side has no strict-decode path at all. Checkpoint greps for TypeScript/Swift consumers.
- **Residual risk:** An out-of-tree consumer. Accepted — the schema carries `schema_version` for exactly this.

**Risk R05: A project-path spelling mismatch empties the selection silently** {#r05-path-spelling}

- **Risk:** `select-tests.ts` derives `REPO_ROOT` from `import.meta.dir`, whose spelling depends on invocation. This checkout is reachable as both `/Users/kocienda/Mounts/u/src/tugtool` and `/u/src/tugtool`. If the spelling handed to `--project` did not match the ledger's key, `changes` would return an empty `files` array with exit 0, and `app-test-changed` would print "no app-test covers the changed files — nothing to run" and exit 0 — a total selection failure that is indistinguishable from a clean tree.
- **Mitigation:**
  - Canonicalization stays in Rust, behind the [L29] gateway (`CanonicalPath::from_raw`), which `tugutil` already applies to `--project`. Verified: both spellings return identical results on the current tree.
  - The selector never canonicalizes in TypeScript ([#step-4](#step-4) task).
  - All-three-buckets-empty on a dirty tree prints a distinguishable note rather than the ordinary nothing-to-run line ([L31]).
- **Residual risk:** A checkout reached by a spelling the Rust gateway itself mishandles would still fail. That is an [L29] defect in `path_resolver.rs`, not in the selector, and it would break attribution everywhere else first — so this plan is not where it would be caught.

---

### Design Decisions {#design-decisions}

#### [P01] Derived selection reads the session ledger, and `foreign` files are excluded (DECIDED) {#p01-session-scoped-selection}

**Decision:** When a session can be resolved, `select-tests.ts` derives its changed-path set from `tugutil changes --json` rather than `git status`, using the `files` (attributed) bucket and excluding the `foreign` bucket entirely.

**Rationale:**
- `foreign` is, by construction, "a dirty file another session holds the live proof row for". Selecting tests from it is the precise defect: a session tested on work it did not do.
- The grading is already done. `compute_changes` in `tugrust/crates/tugchanges-core/src/changes.rs` decides ownership from proof rows (`exact`/`replay`) and nothing else; re-deriving that in TypeScript would be a second, weaker answer to a settled question.
- Measured effect: a 3-session-equivalent tree drops from 31 selected tests to roughly the single-session 13, and the spurious `EXIT_OVER_BUDGET` refusals at *k*≥2 disappear.

**Implications:**
- `select-tests.ts` gains a subprocess dependency on `tugutil`.
- The budget refusal now means what it says — a genuinely wide *own* diff — rather than "someone else is also working".

#### [P02] Unattributed files are included only when they carry this session's bracket hint (DECIDED) {#p02-unattributed-hint}

**Decision:** A file in the `unattributed` bucket is added to the changed-path set **only if** its `origin` field is not `"none"` — i.e. this session's Bash/turn bracket saw the path change.

**Rationale:**
- A `python3` heredoc or `python3 -c` that writes a repo file is unreadable to `shell_ops` and lands unattributed. Those *are* the session's edits and should select tests.
- The same whole-tree delta also sweeps up the user's own hand-save made in an editor while a command ran. Including every unattributed file would re-import exactly the noise this plan removes.
- The `origin` field already encodes this distinction: `print_preflight_plain` in `tugrust/crates/tugutil/src/changes.rs` renders it as `likely this session's (<origin> bracket)` for precisely this reason. This decision consumes that grading rather than inventing one.

**Implications:**
- The `unattributed` bucket must be reachable from `changes --json`, which today it is not — hence [P04].
- A hand-save during an unrelated `bash` window can still be swept in. Accepted: it is a hint, and over-selecting one's own file is a far smaller harm than over-selecting someone else's.

#### [P03] No resolvable session falls back to whole-tree `git status`, out loud (DECIDED) {#p03-fallback}

**Decision:** When `TUG_SESSION_ID` is unset, or `tugutil changes` exits 2 (unresolvable session), or the binary is missing, the selector falls back to today's `changedFromGit()` behavior and prints a one-line reason to stderr naming which of those it was.

**Rationale:**
- A bare terminal invocation outside a Tug session is legitimate and must keep working.
- A silent fallback would make the whole feature invisible when it stopped working — the failure mode would be "selection got big again" with no way to tell why. Errors never fail silently.

**Implications:**
- Three distinct stderr messages, not one, so the cause is legible.
- Exit 2 is a fallback trigger, never a hard error.

#### [P04] `changes --json` gains `unattributed` and `foreign`, additively (DECIDED) {#p04-changes-json-buckets}

**Decision:** `ChangesReport` in `tugrust/crates/tugchanges-core/src/changes.rs` gains `unattributed: Vec<Change>` and `foreign: Vec<ForeignChange>`, populated from the `ResolvedChanges` that `changes()` already computes and currently discards.

**Rationale:**
- `resolve_changes` already returns all three buckets; `changes()` throws two away when constructing `ChangesReport`. The data is computed and dropped — surfacing it costs nothing at runtime.
- The alternative, `tugutil preflight --json`, already carries all three (`PreflightReport` in `tugrust/crates/tugchanges-core/src/preflight.rs` has `files`/`unattributed`/`foreign`) — but preflight **always attaches a diff to every changed file** and additionally runs a git log. Paying for diffs and log entries to obtain a list of paths is the wrong trade on a hot path.
- `changes` is also the semantically correct verb: "which files this session changed". Selection is not a landing preflight.

**Implications:**
- Additive only; `session`, `project`, `files` are untouched. `ForeignChange` must be `Serialize` (confirm during implementation).
- The plain-text `changes` output is deliberately **not** changed — only `--json` gains fields, so no human-facing surface shifts.

#### [P05] `--print` writes the selection to stdout (DECIDED) {#p05-print-stdout}

**Decision:** Remove the `printOnly` condition from the final stdout write in `select-tests.ts`, so `--print` emits selected filenames on stdout as its name and its usage text both promise.

**Rationale:**
- Today the final write is guarded by `if (!printOnly)`, so `--print` emits nothing on stdout; the selection reaches stderr only. `just app-test-select`, documented as "print that selection without running it", produces empty stdout.
- `--print`'s actual distinguishing behavior is *not running the budget refusal* — that is the `!printOnly` guard on the `EXIT_OVER_BUDGET` block, which is correct and stays. The stdout guard is a second, unintended effect of the same flag.

**Implications:**
- `--print` becomes scriptable, which every measurement step in this plan needs.
- `app-test-select` starts producing output; no recipe consumes its stdout today, so nothing breaks.

#### [P06] A skipped file is named in the VERDICT line; the run still exits 0 (DECIDED) {#p06-skip-in-verdict}

**Decision:** When `files_skipped > 0`, the `VERDICT` line reports it — e.g. `VERDICT: PASS (15/20 files green; 5 skipped)` — while the exit code stays 0.

**Rationale:**
- Declining the screen-takers is a legitimate, designed choice, and `TUG_APPTEST_ASSUME=background` is what every scripted and agent run sets. Failing those runs would make red the default and train dismissal.
- The 2026-08-21 core-tier run printed, verbatim: a summary block containing `Files run: 20`, `Files passed: 15`, `Files skipped: 5`, and then `VERDICT: PASS  (15/20 files green; 29/29 tests passed)`. So the skip is **not** invisible — the summary block names it — but the VERDICT line, which is the one line a reader or a script reduces the run to, says `PASS` alongside `15/20 green` and never accounts for the other five. Fifteen-of-twenty green *and* PASS reads as a contradiction unless you scroll up.
- A third verdict word (`PARTIAL`) was considered and rejected: it adds a state every `TUG_APPTEST_JSON` consumer must learn, to carry information the totals already hold.

**Implications:**
- `filesSkipped` is already in the JSON document's `totals`, and `Files skipped:` is already in the summary block — neither is added by this decision; only the VERDICT line changes.
- The `(N/M files green)` denominator changes meaning: today `M` is `files_run` (which counts skipped files), and it becomes the count that actually executed.

#### [P07] `ACCEPTED_FANOUT` entries may only be lowered (DECIDED) {#p07-one-way-ratchet}

**Decision:** `--check` fails when a recorded `ACCEPTED_FANOUT` number is *raised* relative to the committed value, in addition to today's check that actual fan-out has not outgrown the record. Raising requires deleting the entry and re-adding it in a separate act.

**Rationale:**
- The existing comment already states the intent — "the lint holds that line so the fan-out can shrink but never grow" — but nothing enforces it, and the history shows six consecutive `+1` bumps in two days followed by a `26 → 29` raise hours after a deletion pass took it `68 → 26`.
- Each bump was individually argued and collectively a ratchet. Making the raise require an explicit delete-then-add turns a reflex into a visible act in the diff.

**Implications:**
- The check needs the committed value to compare against: read it from `git show HEAD:tests/app-test/scripts/select-tests.ts`. In a detached or shallow state where that read fails, the check skips this rule with a printed warning rather than failing.
- Landing Steps 5–6 lowers the numbers first, so the ratchet locks at the post-deletion floor.

#### [P08] A total-corpus ceiling is enforced by `app-test-covers-check` (DECIDED) {#p08-corpus-ceiling}

**Decision:** `--check` fails when the corpus exceeds `MAX_CORPUS` files, a constant set to the post-deletion count plus a small headroom, so that adding a test past the ceiling forces retiring one.

**Rationale:**
- 112 new files in three weeks with no retirement policy is the root cause behind every other symptom here. Per-path fan-out budgets bound how *wide* one change fires; nothing bounds how *large* the corpus gets.
- Making the trade explicit at the moment of addition is the only point where the author has the context to judge which existing test the new one supersedes.

**Implications:**
- The ceiling is a number in the same file as the other budgets, changed by the same deliberate act.
- Raising `MAX_CORPUS` is subject to [P07]-style scrutiny by convention, but is not mechanically gated — a single constant with a clear name in a linted file is enough friction.

#### [P09] Per-file duration is recorded in `RESULT_ROWS` and the JSON document (DECIDED) {#p09-per-file-duration}

**Decision:** The runner loop records each file's elapsed seconds and carries it through `RESULT_ROWS` into both the summary table and the per-file objects in `TUG_APPTEST_JSON`.

**Rationale:**
- There is no per-file duration recorded anywhere today. The only cost model in the repo is the literal `15` in `select-tests.ts`'s refusal message; measured cost is ~7s/file. The refusal therefore threatens roughly twice the time it actually costs.
- The deletion pass, the corpus ceiling, and [Q01] all want cost ranking, and none of them can have it without this.

**Implications:**
- `RESULT_ROWS` entries gain a trailing field, and **all three** `IFS=':' read` sites must gain the matching variable in the same commit — the tally loop, the per-file table, and the JSON block. Missing one does not degrade gracefully: `read`'s last variable absorbs the remainder, so a four-variable read of a five-field row yields `rtotal="1:7"` and an arithmetic error. See [#skip-path](#skip-path) for the verified reproduction.
- All five `RESULT_ROWS+=(…)` producer sites must append the field, including both SKIP branches.
- Must stay bash 3.2-compatible.

#### [P10] Deletion proceeds by two criteria, mechanical first (DECIDED) {#p10-deletion-criteria}

**Decision:** Retire in two commits: first the 25 files whose entire `@covers` set is a strict subset of another test's, then a reviewed cut of the 112 tests that have only ever been modified alongside their source.

**Rationale:**
- The subset criterion is mechanical and arguable only in the rare case where two tests legitimately share a surface but assert different rules — cheap to review, and it establishes the hole-count guard before the judgment-heavy pass.
- The change-detector criterion needs judgment and must not be applied blindly. The precedent is explicit: `c9ac83564` **restored** two suites (`at0397`, `at0399`) that a prior pass graded as deletable pixel cosmetics, because what they assert is an engine rule even though they read computed style. Reading style is not the criterion; asserting no rule is.

**Implications:**
- Step 6's task list is a review, not a delete-list; some candidates will be kept and the commit message says which and why.
- Both commits carry the retired list with reasons in the message, never in a comment.

#### [P11] The orphaned pure-logic tests get a home in `just test-ts` (DECIDED) {#p11-orphaned-tests-home}

**Decision:** `test-ts` gains a third line running `bun test` over `tests/app-test/scripts/` and `tests/app-test/_harness/`.

**Rationale:**
- Those directories hold 69 passing pure-logic tests across 6 files (`scripts/select-tests-foreground.test.ts`, `_harness/errors.test.ts`, `_harness/fnv1a.test.ts`, `_harness/matchers.test.ts`, `_harness/rpc.test.ts`, `_harness/__tests__/transcript.test.ts`) that complete in 580ms and are run by nothing: `test-ts` covers only `tugdeck` and `tugcode`.
- Every selector change in this plan needs a test that CI actually runs. Adding tests to a directory nothing executes would be theatre.

**Implications:**
- `just ci` gains 580ms and 69 real assertions.
- These are pure-logic tests over data and subprocess invocations of the real script — no app launch, so they are invisible to `testFiles()` and carry no `@covers` obligation.

#### [P12] Selector tests drive the real script over a real corpus copy (DECIDED) {#p12-real-script-tests}

**Decision:** New tests for session scoping follow the pattern already established in `tests/app-test/scripts/select-tests-foreground.test.ts`: spawn the real `select-tests.ts` as a subprocess against a copied corpus, with a stub `tugutil` on `PATH` emitting real-shaped ledger JSON.

**Rationale:**
- That file's own docblock states the principle — "what is under test is the actual script reading actual test files — not a re-implementation of its parser" — and it is the house style.
- Mock-store assertion tests and fake-DOM tests are banned; a hand-rolled re-implementation of the bucket logic would be the same mistake in a different costume.

**Implications:**
- The stub emits fixed JSON documents matching the real `changes --json` schema, including `schema_version`. Schema drift between stub and real command is caught by Step 3's Rust test, not by the stub.

---

### Specification {#specification}

**Spec S01: The derived-selection input contract** {#s01-selection-input}

`changedFromGit()` is replaced by `changedPaths()`, which resolves its input in this order:

1. If `TUG_SESSION_ID` is unset → whole-tree `git status`, printing `[select-tests] no TUG_SESSION_ID — selecting from the whole working tree.`
2. Else run `tugutil changes --json --project <REPO_ROOT>`.
   - Exit 2 → whole-tree fallback, printing `[select-tests] session <id> not resolvable — selecting from the whole working tree.`
   - Binary missing or non-zero non-2 exit → whole-tree fallback, printing `[select-tests] tugutil unavailable (<reason>) — selecting from the whole working tree.`
   - Exit 0 → the union of:
     - every `data.files[].path` (attributed), and
     - every `data.unattributed[].path` whose `origin !== "none"` ([P02]).
   - `data.foreign` is never consulted ([P01]).
3. Explicit paths passed as arguments bypass all of the above, unchanged from today.

The selector prints a one-line attribution summary to stderr on the ledger path: `[select-tests] session <id>: N attributed + M unattributed-hinted (K foreign ignored)`.

**Spec S02: The VERDICT line grammar** {#s02-verdict-grammar}

Today's grammar, for comparison — the numerator is `files_passed` and the denominator is `files_run`, which **includes** skipped files:

```
VERDICT: PASS  (15/20 files green; 29/29 tests passed)
```

The replacement:

```
VERDICT: PASS  (<ran_green>/<ran> files green; <tests_passed>/<tests_total> tests passed)
VERDICT: PASS  (<ran_green>/<ran> files green; <skipped> skipped; <tests_passed>/<tests_total> tests passed)
VERDICT: FAIL  (<ran_green>/<ran> files green; <failed> file(s) failed; <skipped> skipped; <tests_passed>/<tests_total> tests passed)
```

The `; <skipped> skipped` clause appears if and only if `files_skipped > 0`. `<ran>` counts files that executed — `files_run - files_skipped` — so the numerator and denominator both describe work that actually happened. Exit code is unchanged in every case ([P06]).

**Spec S03: JSON document additions** {#s03-json-additions}

Each object in `files[]` gains `"seconds": <number>`. `totals` is unchanged (`filesSkipped` already exists). No field is removed or renamed.

---

### Deep Dives {#deep-dives}

#### Measured baseline, 2026-08-21 {#measured-baseline}

**Table T01: Corpus and cost as measured** {#t01-baseline}

| Quantity | Value | How measured |
|---|---|---|
| `at*.test.ts` files | 233 | `ls tests/app-test/*.test.ts` |
| Files the selector sees (incl. `harness-smoke/`) | 244 | `--check` output |
| Total lines | 86,510 | `wc -l` over the corpus |
| `launchTugApp` call sites | 723 | grep over the corpus |
| Files created in Aug 2026 | 112 of 233 | first-commit date per file |
| Core tier wall time | 106s for 20 files, **15 executed** | `TUG_APPTEST_JSON` on `just app-test` |
| 3-file run wall time | 8s | `TUG_APPTEST_JSON` |
| Implied per-file cost | ~7s | 106s ÷ 15 executed |
| Cost constant in `select-tests.ts` | 15s | the literal in the refusal message |
| `@covers` declarations | 1,276 over 244 files (mean 5.2) | parsed from headers |
| Source files considered | 1,496 | `git ls-files` over `tugdeck/src`, `tugdeck/styles`, `tugrust`, `tugapp/Sources`, `tugcode/src` |
| Source files selecting nothing | 696 (47%) | fan-out computed with the real `matches()`, same wide root set as the row above |
| Coverage holes | 632 | `--holes`, whose `HOLE_ROOTS` is the narrower `tugdeck/src/`, `tugdeck/styles/`, `tugcode/src/` — this is why 632 and 696 differ; they are not two measurements of one quantity |
| Mean fan-out among covered files | 3.6 | as above |
| Files exceeding the budget alone | 2 (`focus-manager.ts` 29, `deck-canvas.tsx` 21) | as above |
| `@foreground` files | 33 corpus-wide; 5 of the 20 core tier | `--foreground` |
| Subset-duplicate pairs | 25 | `@covers` set containment |
| Always-co-changed tests (≥3 commits) | 112 of 168 | git history per file |

**Table T02: Selection size vs. concurrent work** {#t02-k-curve}

Merging *k* consecutive commits stands in for *k* sessions' simultaneously-dirty state. Sampled at six offsets across the last 40 commits.

| Concurrent work | Tests selected | Outcome |
|---|---|---|
| 1 session | 13 | runs |
| 2 sessions | 24 | **REFUSED** (`MAX_SELECTED` = 20) |
| 3 sessions | 31 | refused |
| 4 sessions | 39 | refused |
| 5 sessions | 46 | refused |

The refusal is the visible harm; the invisible one is that below the threshold the run is roughly *k*× larger than the session's own footprint.

#### Why the fan-out budget is not the main lever {#fanout-not-the-lever}

It is tempting to read the `ACCEPTED_FANOUT` entries as the problem, but the measured distribution says otherwise: of 1,496 source files, only **two** fan out past the 20-file budget on their own, and the mean among covered files is 3.6. Single-file changes are already well-scoped.

What blows the budget is **multi-file diffs** — and the dominant reason a diff is multi-file is that it contains more than one session's work. That is why [P01] leads this plan and the ratchet ([P07]) follows the deletion pass rather than leading it: fixing the input shrinks selections far more than tightening the declarations would.

#### Tuglaws cross-check {#tuglaws-cross-check}

This is test-infrastructure work — a `bun` script, a `just` recipe, and an additive Rust field. The rendering laws ([L01]–[L28]) have no surface here: nothing mounts, renders, subscribes to a store, or animates, so the **State Zone Mapping is deliberately omitted** per the skeleton's own instruction for non-frontend plans. Two laws do apply, and both are load-bearing.

**[L29] — every persisted or compared path routes through the canonicalization gateway.** This plan makes the selector pass a project root to a ledger lookup, which is exactly a path used as a lookup argument. The hazard is live in this repository: the checkout is reachable as both `/Users/kocienda/Mounts/u/src/tugtool` and `/u/src/tugtool`, and `select-tests.ts` computes its `REPO_ROOT` with `resolve(APP_TEST_DIR, "..", "..")` from `import.meta.dir` — a raw path whose spelling depends on how the process was invoked. A mismatch here would not error; it would return an empty `files` array, and `app-test-changed` would print *"no app-test covers the changed files — nothing to run"* and exit 0. A silent under-selection is the worst possible failure for this plan, since it looks exactly like success.

The plan **honors** the law by keeping canonicalization on the Rust side, where the gateway lives: `tugutil` routes `--project` through `CanonicalPath::from_raw` already. Verified on the current tree — `tugutil changes --project` with each of the two spellings returns identical results. The selector therefore passes its raw root and **must not** call `realpath`, `fs.realpathSync`, or any TypeScript-side canonicalization; doing so would be the bare-`canonicalize` half of the law's prohibition, wearing a different language. This is recorded as a task in [#step-4](#step-4) and as [Risk R05](#r05-path-spelling).

**[L31] — a gesture produces either the act or a visible reason, never silence.** Two of this plan's decisions are direct applications. [P03] requires three *distinct* stderr reasons for the three fallback causes rather than one generic line, because "selection got wide again" with no stated cause is the swallowed-internal-fault shape the law names. [P06] is the same law applied to the VERDICT line: the run already computed `files_skipped`, and a computed reason that is discarded is, in the law's words, worse than one never computed. The plan **honors** both.

#### The SKIP path in the runner {#skip-path}

Two distinct paths produce a `SKIP` row in `RESULT_ROWS`, and [P06] must cover both:

1. **Declined screen-taker.** The recipe checks the `@foreground` set against the ask-answer and emits `RESULT_ROWS+=("SKIP:$f:0:0")` with the progress line `(skipped — takes the screen)`, then `continue`s before `bun test` runs.
2. **Ran but reported nothing.** After `bun test`, `rc -eq 0 && total -eq 0` is classified `SKIP` — a file that executed but produced no test cases.

Both are already counted into `files_skipped` by the tally loop, and the summary block already prints a `Files skipped: N` row. What neither reaches is the **VERDICT line**, which branches only on `files_failed` and `files_errored` and reports `files_passed`/`files_run` — so a skipped file silently deflates the numerator without ever being named there.

**The `RESULT_ROWS` row format is parsed in three places, not two** — the tally loop, the per-file results table, and the `TUG_APPTEST_JSON` block — all with `IFS=':' read -r … <<< "$row"`. This matters acutely for [P09], because `read` assigns the **remainder** of the line to its last variable: appending a fifth field to a row parsed by a four-variable `read` puts `1:7` into `rtotal`, and the tally loop's `$((tests_total + rtotal))` then dies with `arithmetic syntax error`. Verified directly:

```
$ IFS=":" read -r a b c d <<< "PASS:file.ts:1:1:7"; echo "[$d]"
[1:7]
```

All three reads must gain the trailing variable in the same commit.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun:test)** | The selector's path resolution, bucket handling, fallback branches | Steps 2, 4, 7, 8 — pure logic over data and subprocess runs of the real script |
| **Unit (cargo nextest)** | `ChangesReport` carries all three buckets | Step 3 |
| **Integration (real recipe)** | The runner's verdict line, duration capture, end-to-end selection | Steps 9, 10, 11 — run the real `just` recipe and read `TUG_APPTEST_JSON` |
| **Invariant guard** | Coverage holes do not grow across a deletion | Steps 5, 6 |

#### What stays out of tests {#test-non-goals}

- **No fake-DOM or RTL tests.** There is no in-process DOM substrate; nothing in this plan touches rendering.
- **No mock-store assertion tests.** The selector's ledger input is exercised through a stub `tugutil` emitting real-shaped JSON ([P12]), not by hand-rolling and asserting on a mocked interface.
- **No new app-tests.** This plan's whole purpose is to shrink that corpus; every behavior it adds is testable at the pure-logic or recipe layer. Adding `at*` files here would be self-defeating.
- **No reflexive per-mutator pin tests** on the new constants. `MAX_CORPUS` and the ratchet are covered by one test each that drives the real `--check`.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.**

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Give the orphaned pure-logic tests a home | pending | — |
| #step-2 | `--print` writes the selection to stdout | pending | — |
| #step-3 | `changes --json` carries all three buckets | pending | — |
| #step-4 | Session-scoped selection | pending | — |
| #step-5 | Retire the subset duplicates | pending | — |
| #step-6 | Retire the reviewed change-detectors | pending | — |
| #step-7 | The fan-out ratchet turns one way | pending | — |
| #step-8 | A corpus ceiling | pending | — |
| #step-9 | Skipped files are named in the verdict | pending | — |
| #step-10 | Per-file duration, and a measured cost constant | pending | — |
| #step-11 | Integration checkpoint | pending | — |

---

#### Step 1: Give the orphaned pure-logic tests a home {#step-1}

**Commit:** `apptest(test-home): run the harness and selector unit tests in the TS gate`

**References:** [P11] Orphaned tests home, (#measured-baseline, #context)

**Artifacts:**
- `justfile` — `test-ts` recipe gains a third line.

**Tasks:**
- [ ] Add `cd tests/app-test && bun test scripts/ _harness/` to the `test-ts` recipe, after the `tugdeck` and `tugcode` lines.
- [ ] Confirm the run does not pick up `*.test.ts` from the corpus root: the two named directories are the only arguments, and `testFiles()` scans only the corpus root and `harness-smoke/`, so the two sets are disjoint.

**Tests:**
- [ ] The 6 existing files (`scripts/select-tests-foreground.test.ts`, `_harness/errors.test.ts`, `_harness/fnv1a.test.ts`, `_harness/matchers.test.ts`, `_harness/rpc.test.ts`, `_harness/__tests__/transcript.test.ts`) run and pass — 69 tests, ~580ms.

**Checkpoint:**
- [ ] `just test-ts` passes and its output includes the `tests/app-test` run.
- [ ] `cd tests/app-test && bun test scripts/ _harness/` reports `69 pass, 0 fail` and launches no `Tug.app`.

---

#### Step 2: `--print` writes the selection to stdout {#step-2}

**Depends on:** #step-1

**Commit:** `apptest(select): --print prints the selection`

**References:** [P05] `--print` stdout, (#s01-selection-input)

**Artifacts:**
- `tests/app-test/scripts/select-tests.ts` — the final stdout write.
- `tests/app-test/scripts/select-tests-print.test.ts` — new.

**Tasks:**
- [ ] Remove the `printOnly` condition from the final `for (const s of selected) process.stdout.write(...)` block so the selection always reaches stdout.
- [ ] Leave the `!printOnly` guard on the `EXIT_OVER_BUDGET` block untouched — suppressing the refusal is `--print`'s real and correct distinguishing behavior.
- [ ] Update the usage comment at the top of the file so `--print` is described as "print the selection and skip the budget refusal".

**Tests:**
- [ ] `--print` with a path that selects a known-non-empty set writes those filenames to stdout, one per line.
- [ ] `--print` with an over-budget selection still exits 0 and still writes the selection (the refusal remains suppressed).
- [ ] Without `--print`, an over-budget selection exits 3 and writes nothing to stdout.

**Checkpoint:**
- [ ] `cd tests/app-test && bun scripts/select-tests.ts --print tugdeck/src/components/tugways/focus-manager.ts | wc -l` prints 29 (today: 0).
- [ ] `just test-ts` passes.

---

#### Step 3: `changes --json` carries all three buckets {#step-3}

**Depends on:** #step-1

**Commit:** `tugchanges(changes): surface the unattributed and foreign buckets in JSON`

**References:** [P04] Additive JSON buckets, Risk R04, (#s01-selection-input)

**Artifacts:**
- `tugrust/crates/tugchanges-core/src/changes.rs` — `ChangesReport` and the `changes()` constructor.

**Tasks:**
- [ ] Add `unattributed: Vec<Change>` and `foreign: Vec<ForeignChange>` to `ChangesReport`, populated in `changes()` from the `ResolvedChanges` it already receives from `resolve_changes` (which computes all three and currently discards two).
- [ ] `ForeignChange` already derives `Serialize` (verified on the current tree) and its fields are `path`/`git_status`/`sessions`/`diff` — no derive change is needed, so this is a pure field addition on `ChangesReport`.
- [ ] Leave the plain-text `changes` output untouched — only `--json` gains fields ([P04]).
- [ ] Grep for consumers of `changes --json` across `tugdeck/`, `tugcode/`, `tugapp/`, `tugplug/` and confirm none decode strictly (Risk R04).

**Tests:**
- [ ] A `cargo nextest` case in `changes.rs`'s test module: a fixture with one attributed, one unattributed and one foreign file produces a `ChangesReport` whose three vectors have the expected lengths and paths. Extend the existing `changeset_joins_git_status_and_drops_committed_files` fixture setup rather than building a new one.
- [ ] Serializing that report yields JSON containing all three keys.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core` passes with no warnings.
- [ ] `tugutil changes --json | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(sorted(k for k in d))"` lists `files`, `foreign`, `project`, `session`, `unattributed`.
- [ ] `just lint` passes.

---

#### Step 4: Session-scoped selection {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `apptest(select): derive the selection from this session's changes, not the whole tree`

**References:** [P01] Session-scoped selection, [P02] Unattributed hint, [P03] Fallback, [P12] Real-script tests, Spec S01, Risk R02, Risk R03, (#t02-k-curve, #fanout-not-the-lever)

**Artifacts:**
- `tests/app-test/scripts/select-tests.ts` — `changedFromGit()` becomes `changedPaths()`.
- `tests/app-test/scripts/select-tests-session.test.ts` — new.
- `tuglaws/app-test-harness.md` — the "Selection is derived, not remembered" section.
- `CLAUDE.md` — the app-test selection paragraph.

**Tasks:**
- [ ] Implement `changedPaths()` per Spec S01, keeping the existing `git status --porcelain -z --untracked-files=all` parser (including its rename-record skip) as the fallback body.
- [ ] Resolve `tugutil` by absolute path from `REPO_ROOT` (`tugrust/target/debug/tugutil`), never from `PATH` — `~/.local/bin` symlinks point at the main checkout, so a bare `tugutil` from a worktree silently runs another checkout's binary.
- [ ] Pass `--project <REPO_ROOT>` so selection is scoped to the checkout under test rather than the process cwd. Pass the **raw** root and let `tugutil` canonicalize it — never `realpath`/`fs.realpathSync` it in TypeScript, which would be a bare canonicalize outside the [L29] gateway (#tuglaws-cross-check).
- [ ] Treat an exit-0 response with an empty `files` array as a real answer only when `unattributed` and `foreign` are also empty; when all three are empty but `git status` is dirty, print a distinguishable note rather than the ordinary "nothing to run" — that combination is the signature of a project-spelling mismatch (Risk R05).
- [ ] Filter `unattributed` on `origin !== "none"` ([P02]); never read `foreign` ([P01]).
- [ ] Print the attribution summary line from Spec S01, and the three distinct fallback reasons from [P03].
- [ ] Verify the `--core` and `--foreground` early-exit branches still return before `changedPaths()` is reached (Risk R03).
- [ ] Update the doctrine paragraph in `tuglaws/app-test-harness.md` and the corresponding paragraph in `CLAUDE.md` to say the selection derives from the session's changes, naming the foreign-bucket exclusion.

**Tests:**
- [ ] With a stub `tugutil` emitting one attributed, one hinted-unattributed, one `origin: "none"` unattributed, and one foreign file: the selection includes tests for the first two and excludes any test selected *only* by the last two.
- [ ] Stub exiting 2 → falls back to whole-tree and prints the not-resolvable reason.
- [ ] `TUG_SESSION_ID` unset → falls back and prints the no-session reason.
- [ ] Stub absent → falls back and prints the unavailable reason.
- [ ] Explicit path arguments bypass the ledger entirely (the stub is never invoked).

**Checkpoint:**
- [ ] `just test-ts` passes.
- [ ] Real two-session disjointness. Draw two session ids that both have ledger rows — `just db-inspect changes "SELECT tug_session_id, COUNT(*) n FROM file_events GROUP BY 1 ORDER BY n DESC LIMIT 2"` (never point `sqlite3` at the live file) — then run `TUG_SESSION_ID=<id> bun scripts/select-tests.ts --print` under each. The two selections differ, and each matches its own `tugutil changes --session <id> --json`.
- [ ] The fallback fires and says why: `TUG_SESSION_ID=$(uuidgen) bun scripts/select-tests.ts --print` prints the not-resolvable reason on stderr and still produces a whole-tree selection (an unknown uuid exits 2 from `tugutil changes` — verified).
- [ ] `just app-test-select` in a tree dirtied by this session alone reports an attributed count matching `tugutil changes --json`'s `files` length.

---

#### Step 5: Retire the subset duplicates {#step-5}

**Depends on:** #step-1

**Commit:** `apptest(diet): retire tests whose covered surface is contained in another`

**References:** [P10] Deletion criteria, Risk R01, (#t01-baseline)

**Artifacts:**
- Deleted `at*.test.ts` files.
- `tests/app-test/scripts/select-tests.ts` — lowered `ACCEPTED_FANOUT` numbers if the deletions reduce them.

**Tasks:**
- [ ] Record the pre-pass hole count: `bun scripts/select-tests.ts --holes | wc -l` (expected 632).
- [ ] For each of the 25 candidates whose `@covers` set is a strict subset of another test's, read both files and decide: retire when the superset test asserts the same rule, keep when they assert genuinely different rules over a shared surface.
- [ ] Delete the retired files. List each in the commit message with a one-line reason and the superset test that subsumes it. No reasons in code comments.
- [ ] Lower any `ACCEPTED_FANOUT` number the deletions reduce.

**Tests:**
- [ ] Existing selector tests still pass (`just test-ts`).

**Checkpoint:**
- [ ] `bun scripts/select-tests.ts --holes | wc -l` is ≤ the recorded pre-pass count (Risk R01).
- [ ] `just app-test-covers-check` exits 0.
- [ ] `just app-test-foreground-check` exits 0.
- [ ] `just app-test` (core tier) is green, with any skipped files accounted for.

---

#### Step 6: Retire the reviewed change-detectors {#step-6}

**Depends on:** #step-5

**Commit:** `apptest(diet): retire change-detector tests that pin no engine rule`

**References:** [P10] Deletion criteria, Risk R01, [Q02] Subtree covers, (#t01-baseline)

**Artifacts:**
- Deleted `at*.test.ts` files.
- `tests/app-test/scripts/select-tests.ts` — lowered `ACCEPTED_FANOUT` numbers.

**Tasks:**
- [ ] Regenerate the change-detector candidate list against the post-Step-5 corpus: tests with ≥3 commits where every commit that touched the test also touched non-test source.
- [ ] Review each candidate against one question: **does it assert a rule the engine owns, or does it only restate the current implementation?** Retire only the latter.
- [ ] Honor the recorded precedent: `c9ac83564` restored `at0397` and `at0399` after they were wrongly graded deletable as pixel cosmetics. **Reading computed style is not the criterion**; asserting no rule is. Where a test reads style to prove an engine rule (the ring's attribute-green/pixel-dark failure mode), keep it.
- [ ] Delete the retired files; list each with its reason in the commit message.
- [ ] Lower every `ACCEPTED_FANOUT` number the deletions reduce, and record the resulting corpus count for [P08].

**Tests:**
- [ ] Existing selector tests still pass.

**Checkpoint:**
- [ ] `bun scripts/select-tests.ts --holes | wc -l` is ≤ 632 (Risk R01).
- [ ] `just app-test-covers-check` exits 0.
- [ ] `ls tests/app-test/*.test.ts | wc -l` is **≤ 180** — at least 53 files retired across Steps 5 and 6 against the 233 baseline. The exact figure is recorded in the commit message and becomes [P08]'s baseline. If the review cannot honestly reach 180, stop at the honest number and say so in the commit message rather than retiring a test that guards a rule; the ceiling in [#step-8](#step-8) is then set from that number instead.
- [ ] `just app-test` (core tier) is green.

---

#### Step 7: The fan-out ratchet turns one way {#step-7}

**Depends on:** #step-6

**Commit:** `apptest(select): accepted fan-out may be lowered, never raised`

**References:** [P07] One-way ratchet, (#context)

**Artifacts:**
- `tests/app-test/scripts/select-tests.ts` — `--check`.
- `tests/app-test/scripts/select-tests-ratchet.test.ts` — new.

**Tasks:**
- [ ] In `--check`, read the committed `ACCEPTED_FANOUT` via `git show HEAD:tests/app-test/scripts/select-tests.ts` and parse its entries.
- [ ] Fail when a key present in both has a working-tree number **greater** than the committed one, naming the key, both numbers, and the delete-then-re-add remedy.
- [ ] A key absent from the committed version is a new entry and is not subject to this rule — that is the deliberate re-add path.
- [ ] When the `git show` fails (detached, shallow, or the file is new), skip the rule and print a warning rather than failing ([P07]).
- [ ] Replace the `ACCEPTED_FANOUT` doc comment's aspiration ("the lint holds that line") with a statement of what the check now enforces.

**Tests:**
- [ ] A working tree that raises an entry fails `--check` with the key named.
- [ ] Lowering an entry passes.
- [ ] Adding a wholly new key passes.
- [ ] An unreadable committed version warns and passes.

**Checkpoint:**
- [ ] `just app-test-covers-check` exits 0 on the clean tree.
- [ ] Manually raising `deck-canvas.tsx`'s number by 1 makes it exit non-zero; reverting restores 0.
- [ ] `just test-ts` passes.

---

#### Step 8: A corpus ceiling {#step-8}

**Depends on:** #step-6

**Commit:** `apptest(select): cap the corpus so a new test displaces an old one`

**References:** [P08] Corpus ceiling, (#context)

**Artifacts:**
- `tests/app-test/scripts/select-tests.ts` — `MAX_CORPUS` and a `--check` rule.
- `tests/app-test/scripts/select-tests-ceiling.test.ts` — new.
- `tuglaws/app-test-harness.md` — a paragraph stating the ceiling and its intent.

**Tasks:**
- [ ] Add `MAX_CORPUS`, set to Step 6's recorded post-deletion count plus modest headroom, with a comment stating that exceeding it means retiring a test, not raising the number.
- [ ] Fail `--check` when `coverage.length` exceeds it, printing the current count, the ceiling, and the widest-fan-out tests as retirement candidates.
- [ ] Document the ceiling in `tuglaws/app-test-harness.md` beside the selection doctrine.

**Tests:**
- [ ] A corpus copy with files added past the ceiling fails `--check` with the count named.
- [ ] The real corpus passes.

**Checkpoint:**
- [ ] `just app-test-covers-check` exits 0.
- [ ] Adding `MAX_CORPUS + 1` empty annotated files to a temp corpus copy makes `--check` exit non-zero.
- [ ] `just test-ts` passes.

---

#### Step 9: Skipped files are named in the verdict {#step-9}

**Depends on:** #step-1

**Commit:** `apptest(verdict): a run that skipped files says so`

**References:** [P06] Skip in verdict, Spec S02, (#skip-path)

**Artifacts:**
- `justfile` — the `app-test` recipe's closing verdict block.

**Tasks:**
- [ ] Compute `ran = files_run - files_skipped` and use it as the green-count denominator. Note `files_run` is `${#FILES[@]}` — the requested count, which includes skipped files — so today's `15/20` becomes `15/15`.
- [ ] Append `; <N> skipped` to both the PASS and FAIL verdict lines when `files_skipped > 0`, per Spec S02.
- [ ] Do **not** add a `Files skipped:` row to the summary block — one is already printed there when `files_skipped > 0`. This step changes the VERDICT line only.
- [ ] Verify both SKIP producers reach it: the declined screen-taker path and the ran-but-reported-nothing path (#skip-path).
- [ ] Keep exit codes unchanged; keep every construct bash 3.2-compatible.

**Tests:**
- [ ] Covered by the checkpoint against the real recipe — this is shell in a `just` recipe with no unit-test seam, and the behavior under test is the recipe's own output.

**Checkpoint:**
- [ ] `TUG_APPTEST_ASSUME=background TUG_APPTEST_JSON=/tmp/v.json just app-test` prints a VERDICT line naming the skipped count, and `/tmp/v.json`'s `totals.filesSkipped` matches it.
- [ ] `TUG_APPTEST_ASSUME=background just app-test at0000-smoke.test.ts` (no skips) prints a VERDICT line with **no** skipped clause.
- [ ] Both runs still exit 0.

---

#### Step 10: Per-file duration, and a measured cost constant {#step-10}

**Depends on:** #step-9

**Commit:** `apptest(timing): record each file's duration and price the budget from it`

**References:** [P09] Per-file duration, Spec S03, [Q01] Core tier membership, (#t01-baseline)

**Artifacts:**
- `justfile` — the runner loop, the summary table, and the `TUG_APPTEST_JSON` block.
- `tests/app-test/scripts/select-tests.ts` — the cost constant in the refusal message.

**Tasks:**
- [ ] Capture `date +%s` either side of each file's `bun test` and append the elapsed seconds as a **trailing** field on every `RESULT_ROWS` entry, for all five status branches (SKIP-declined, SKIP-empty, PASS, FAIL, ERR).
- [ ] Update **all three** `RESULT_ROWS` parse sites in the same commit — the tally loop, the per-file results table, and the JSON block — each gaining the trailing variable. Missing one is not a cosmetic miss: the tally loop dies with an arithmetic error, because `read`'s last variable absorbs the remainder (#skip-path).
- [ ] Add `"seconds"` to each `files[]` object in the JSON document (Spec S03).
- [ ] Show the duration in the per-file summary row.
- [ ] Replace the literal `15` in `select-tests.ts`'s refusal message with a named constant set from measured data (~7s), commented with when and how it was measured.
- [ ] Keep every construct bash 3.2-compatible ([P09]).

**Tests:**
- [ ] Covered by the checkpoint against the real recipe, for the same reason as Step 9.

**Checkpoint:**
- [ ] `TUG_APPTEST_JSON=/tmp/t.json TUG_APPTEST_ASSUME=background just app-test at0000-smoke.test.ts at0003-pane-activation.test.ts` produces a document where every `files[]` entry has a positive `seconds`, and their sum is within a second or two of `wallSeconds`.
- [ ] A skipped file's entry carries `seconds` of 0 or near-0 rather than a missing field.
- [ ] The over-budget refusal message quotes a minute figure consistent with the measured constant.

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-4, #step-6, #step-7, #step-8, #step-10

**Commit:** `N/A (verification only)`

**References:** [P01] Session-scoped selection, [P06] Skip in verdict, [P08] Corpus ceiling, [P09] Per-file duration, (#success-criteria, #t02-k-curve)

**Tasks:**
- [ ] Re-measure the *k*-curve from Table T02 with session scoping active and confirm a single session's selection no longer grows with other sessions' dirty files.
- [ ] Re-measure the baseline row set in Table T01 (corpus count, holes, per-file cost) and record the post-plan figures in this document's Table T01 as a second column.
- [ ] Confirm no step left a `@covers` line dangling or a test unannotated.

**Tests:**
- [ ] The full pure-logic gate: `just test-ts`.
- [ ] The Rust gate: `just test-rust`.

**Checkpoint:**
- [ ] `just ci` passes.
- [ ] `just app-test-covers-check` and `just app-test-foreground-check` both exit 0.
- [ ] `just app-test` (core tier) is green, and its VERDICT line accounts for every file as run or skipped.
- [ ] With a second session's files dirty in the tree, `just app-test-changed` selects only this session's tests and does not hit `EXIT_OVER_BUDGET` on account of the other session.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** An app-test selection that scopes to the invoking session's own changes, a corpus that cannot grow without a retirement, and a runner that reports what it skipped and what each file cost.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `just app-test-changed` selects from the session ledger, excluding foreign files (`select-tests-session.test.ts` green; two-session check in [#step-11](#step-11))
- [ ] `--print` writes the selection to stdout (`--print <path> | wc -l` non-zero)
- [ ] Corpus is materially below 233 files with holes ≤ 632 (`ls | wc -l`, `--holes | wc -l`)
- [ ] `ACCEPTED_FANOUT` cannot be raised (`app-test-covers-check` fails on a raise)
- [ ] The corpus ceiling is enforced (`app-test-covers-check` fails past `MAX_CORPUS`)
- [ ] No run reports a bare PASS while files were skipped (Spec S02)
- [ ] Every file in a run has a recorded duration (Spec S03)
- [ ] The 69 orphaned pure-logic tests run in `just ci`

**Acceptance tests:**
- [ ] `just ci`
- [ ] `just test-ts` (now including `tests/app-test/scripts/` and `_harness/`)
- [ ] `just app-test-covers-check`, `just app-test-foreground-check`
- [ ] `just app-test` (core tier), green with a skip-accounted verdict

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] Re-derive the core tier's membership from measured per-file cost.
- [ ] [Q02] Decide whether subtree `@covers` declarations should be bounded by breadth.
- [ ] Consider a cost-ranked view (`--print --with-cost`) once durations accumulate.

| Checkpoint | Verification |
|------------|--------------|
| Session scoping works | Two seeded sessions select disjointly ([#step-4](#step-4)) |
| Corpus shrank without abandoning a surface | `--holes` ≤ 632 ([#step-6](#step-6)) |
| Ratchet is one-way | Raising an entry fails `--check` ([#step-7](#step-7)) |
| Ceiling is enforced | Corpus past `MAX_CORPUS` fails `--check` ([#step-8](#step-8)) |
| Skips are visible | VERDICT names the count ([#step-9](#step-9)) |
| Cost is measured | Every `files[]` entry has `seconds` ([#step-10](#step-10)) |
