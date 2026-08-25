## The legacy sweep: execute the kill list {#legacy-sweep}

**Purpose:** Retire the apparatus left behind by three rebuilds of the dash workflow — the archived conversation card, the uncited root probes, the placement-experiment spike, the `dash-join` skill, `plan-devise`'s off-arc branch, and `diag/` — repair eight stale claims in prose and comments, and leave two permanent mechanical checks so the next stale claim fails a test instead of waiting for a sweep.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | `tugdash/legacy-sweep` |
| Last updated | 2026-08-25 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-25, opus.** Reviewed `plan:2cc4f3fa2414f654`. Lint: 0 errors, 1 warning (PL023, cleared by this section). Oriented on: the whole document — first pass, never reviewed. Every load-bearing claim was re-verified against the tree rather than against the brief or the devise notes, and the five strikes hold: `tugcode/probes/` is 43 tracked files with `wake-reinit-drift.test.ts` reading its captures; `capabilities/2.1.222/` is present; `tests/model-eval/` is a full tracked harness with its `__pycache__` ignored at `.gitignore:72`; both "uncited" tuglaws are cited. The inventory is right: 12 `_archive` files, 17 root probes, 13 `diag/` files, 40 tuglaws with `ledger-reliability.md` the one unindexed — so Spec S01's expected red run is exactly correct as written. `[F08]` is real and its subtlety is right: `spike-dash-progress.tsx` was deleted by `dash/archive/dash-join-tail.md` Step 1, and `[D143]` spells it as a bare name, so Spec S02 genuinely cannot see it.

Applied: **Spec S02 was unimplementable, and that was the round's finding.** Its expected first red run said "exactly the four CSS cites"; simulating its extraction against the real tree returned 707 hits, 216 of them real dangles under the strictest sensible reading. Its scan set also omitted `tugdeck/styles`, so it would have missed `focus-ring.css` — the one cite [#f03-grows](#f03-grows) exists to point out the brief missed. The dominant failure is the same one the sweep repairs, under `dash/` instead of `roadmap/`, at fifty times the scale. Rewrote the spec around two extraction rules matched to their syntax (document-relative markdown links in `*.md`, repo-relative pointers everywhere else), which both kills the 406-item bare-filename noise and makes the check see the tuglaws' 332 sibling-relative cross-references — without rule 1 the check was blind to every intra-tuglaws link and Step 12's checkpoint asserted nothing. Re-measured under the final rule: **247 citations, 105 targets, all four CSS cites among them.** The scope call that followed was the owner's, raised as a dialog and decided in-round as `[P11]`: broad check over a recorded allowlist, seeded from the red run, with a two-sided assertion so a repaired entry fails rather than rotting.

Also applied: **two unsatisfiable success conditions** — Step 10's closing grep and the matching criterion both demanded that `roadmap/` appear nowhere in source, while `tugdash-core`'s `ops.rs` and `replay.rs` carry 91 occurrences of `"roadmap/plan.md"` inside `#[cfg(test)]` as dash-worktree path literals; scoped both away from `tugrust/` and said why, since the plan elsewhere states it touches no Rust. **Step 3 named four files and there are five** — `session-card-telemetry-renderers.tsx` carries a comment threading a value "through `useSessionPlacementSlots`", which its own final grep would have caught after the fact; added it as a task. **Step 11's checkpoint was vacuous** — it asked `doc-link-resolution.test.ts` to prove the brief moves dangled nothing, but Spec S02 excludes `dash/` and `dash/archive/` outright, so the check cannot see anything that step touches; replaced it with the grep that actually proves it, added the four `dash/archive/` back-citations the move breaks, and recorded that `at0477` and `atom-text.test.ts` carry `"dash/verify-surfaces-brief.md"` as an atom **display label**, not a filesystem read, so a grep will surface two tests that must not be "fixed". Propagated the corrected counts through the success criteria, Risk R02, and the follow-ons, where the allowlist's 243 entries are now named as the largest piece of work this sweep hands forward.

Tuglaws cross-check: the plan introduces no frontend state — Step 3 is deletion restoring production defaults, so no State Zone Mapping applies and [L02]/[L06] are not at risk; Step 3's `bunx vite build` checkpoint is the right gate given the debug app loads the prod rollup bundle. `[P05]`'s test home is verified — `tests/app-test/scripts/` holds four `select-tests-*.test.ts` precedents, the justfile's `test-ts` runs `bun test scripts/`, and `testFiles()` does not scan it, so neither new check needs `@covers`. Both new checks are file reads and string work, clear of the banned fake-DOM and mock-store shapes. Step 4's keep-list and Risk R01 are correct: `deprecatedFor: "dash-join"` and the four DOM slots are live and the six edit sites are exactly six.

Deferred: nothing. The one judgment call was asked and answered in-round.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dash workflow was rebuilt three times in a month — the join arc, the conductor, the interruption doctrine, the surface table. Each rebuild retired a design without always retiring its apparatus. `dash/legacy-sweep-brief.md` is the read-only inventory that named the suspects: sixteen findings `[F01]`–`[F16]`, eight binding decisions `[B01]`–`[B08]`, and five owner calls it deferred to this devise round.

This plan is the deletions. Per `[B01]` it investigates nothing: every step names files the brief found or that this devise round verified, and no step decides whether something is dead.

Two rules from the house style govern the whole sweep, and telling them apart is the work. **A retired design is deleted, text and apparatus together — never marked "superseded by".** And **a retired *spelling* is kept as an alias** (`tuglaws/slash-commands.md#retire-a-spelling`), because an unmatched `/verb` is submitted to claude as a prompt, which is worse than a rename. `/join → /dash-join` is that document's own exemplar and is not touched by this plan; what changes is the prose that names the alias as the verb.

The devise round re-verified all sixteen findings against the tree, as the brief's own method demands — the brief struck three original suspects that turned out alive (`[F10]`), and the same read struck four more of its own and grew one. Those corrections are the substance of [#inventory-corrections](#inventory-corrections), and they are the reason the step list below does not match the brief's Exit one-for-one. An implementer who reads only the brief will delete a live test fixture; read [#inventory-corrections](#inventory-corrections) first.

#### Strategy {#strategy}

- **Verify-then-strike, once more.** The brief's premise — inventory before cleaning, because a sweep that trusts its memory deletes live code — applies to the brief itself. Four findings dissolved on re-reading and one grew; they are recorded as struck rather than silently dropped, so the next sweep does not re-raise them.
- **Certain kills first**, each whole (`[B02]`): the design goes with its tests, its fixtures, its registry lines, its `tsconfig` exclusion, and its roster entries, one commit per finding.
- **Then the owner's four answers**, all of them deletes, applied the same way.
- **Then the prose repairs** (`[B04]`), one commit per file family, each stating what is true today rather than what a document once explained.
- **Then the two permanent checks** (`[B08]`), each landing in the same commit as the fix it names — a check that lands green has never been shown to work.
- **Then the paperwork** (`[B06]`) and one doctrine sentence (`[B03]`).
- The run ends at the Integration Checkpoint, which verifies the fit rather than re-running spent checkpoints.

#### Success Criteria (Measurable) {#success-criteria}

- `tugdeck/src/_archive/` is absent from `git ls-files`, and `tugdeck/tsconfig.json` carries an empty or absent `exclude` array — no exclusion naming a path that does not exist. (Step 1)
- `git ls-files 'tugcode/probe-*.ts'` returns exactly `probe-case-a.ts` and `probe-case-a-race.ts`. (Step 2)
- `grep -r tugSessionPlacement tugdeck/src` returns nothing. (Step 3)
- `tugplug/skills/dash-join/` is absent, and no `.md` or `.json` outside `dash/archive/` names `dash-join` as a *skill*. The card verb `/dash-join` and the `/join` alias are untouched — `slash-commands.ts` still registers `join` with `deprecatedFor: "dash-join"`. (Step 4)
- `tugplug/skills/plan-devise/SKILL.md` contains no non-arc review branch and no `/tugplug:plan-review` chip fallback. (Step 5)
- `diag/` is absent from `git ls-files`. (Step 6)
- No source comment or tuglaw under `tugdeck/`, `tugcode/`, or `tuglaws/` contains the string `roadmap/`. `tugrust/` is excluded and stays as it is: its 91 occurrences are `"roadmap/plan.md"` path literals in `#[cfg(test)]` dash-worktree fixtures, not document citations. (Step 10)
- Two new pure-logic tests run under `just test-ts` and are green: one asserting every `tuglaws/*.md` is linked from `tuglaws/INDEX.md`, one asserting every repo-relative document path cited in a source comment or a tuglaw resolves to a file that exists or is on the recorded allowlist. Each was observed red against the unfixed tree — the index check naming exactly `ledger-reliability.md`, the doc-link check naming all four CSS cites among 247 citations, which is the measurement `[P11]` was decided on. (Steps 9, 10)
- `tests/app-test/scripts/doc-link-allowlist.txt` exists, contains no `roadmap/` path, and every pair in it is still a real dangle. (Step 10)
- `dash/` holds `legacy-sweep-brief.md`, `legacy-sweep.md`, `dash-notes.md`, `archive/`, and `assets/` — nothing else. (Step 11)
- `just ci` is green at the Integration Checkpoint, or the checkpoint records `Current` and re-runs nothing. (Step 13)

#### Scope {#scope}

1. Six deletions: `[F01]`, `[F02]` (the root probes only), `[F11]`, `[F12]`, `[F13]`, `[F14]`.
2. Six prose repairs: `[F03]`, `[F04]`, `[F05]`, `[F06]`, `[F08]`, `[F15]`.
3. Two permanent mechanical checks (`[B08]`), each landing with the fix it names.
4. One doctrine sentence naming the kill/alias split (`[B03]`).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Renaming `tugutil` → `tug`.** Skipped outright. It was tried and rolled back: the binary `tug` collides with Tug.app's own `Tug` executable on a case-insensitive APFS volume. Step 11 deletes the note proposing it, and the commit body records the collision so the proposal does not return.
- **Retiring `dash-on` or the quick-dash route.** `/dash` routes plan-less work there deliberately.
- **The `join_*` feeds, `/dash-bind`, and `dash-bind-error-store.ts`.** Alive (`[F10]`); not touched.
- **The `/dash-join` card verb and the `/join` alias.** Live, and the exemplar the alias rule is written around. Only the *skill* of that name is deleted (Step 4).
- **`tugcode/probes/`.** Struck — it is a documented discipline with a live fixture consumer. See [#f02-probes-struck](#f02-probes-struck).
- **Untracked directories.** `aside/` is not in git.
- **A general dead-export hunt in tugdeck.** `[B08]` declines it: no `knip`, no unused-export sweep. The Rust side is already under `-D warnings`.

#### Dependencies / Prerequisites {#dependencies}

- A dash worktree from `tugutil dash create legacy-sweep`, whose absolute path is the only working root. Every path in this plan is repo-relative and must be addressed absolutely into that worktree.
- `bun`, `cargo nextest`, and a built `tugutil` on the checkout. No app build and no app-test run is required by any step — nothing here changes a real-app behavior.

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` enforces `-D warnings`. No step in this plan touches Rust, but Step 13 may.
- **Never commit red**, and every commit goes through `tugutil dash commit` onto the dash worktree.
- **No plan numbers in durable artifacts.** No commit message, comment, or test name in this plan may contain a step identifier.
- **`bun`, never `npm`.**
- Deleting a file that a live source comment cites turns that comment into a dangling pointer. Every deletion step must therefore also carry the comment repairs its deletion causes, in the same commit.

#### Assumptions {#assumptions}

- The four owner calls answered in this devise round (`[P06]`–`[P09]`) stand as decided; a run that reaches them does not re-ask.
- `just test-ts` runs `cd tugdeck && bun test`, `cd tugcode && bun test`, and `cd tests/app-test && bun test scripts/ _harness/` (justfile `test-ts`), so a new pure-logic test placed in `tests/app-test/scripts/` is executed by `just ci` without a justfile edit.
- No step needs the real app. `tests/app-test/` corpus files are touched only by Step 4's grep audit, which reads and does not edit.

---

### Open Questions {#open-questions}

None. The brief deferred five owner calls to this round (`[B07]`); four were raised as a dialog and answered, and the fifth dissolved on verification before it could be asked.

- `[F11]` placement experiment → **delete** ([P06]).
- `[F12]` `dash-join` skill → **delete** ([P07]).
- `[F13]` `plan-devise` off-arc path → **cut** ([P08]).
- `[F14]` `diag/` → **delete** ([P09]).
- `[F07]` two "uncited" tuglaws → **struck, not asked.** Both are cited. See [#f07-struck](#f07-struck).

A sixth call was raised in the review round and answered the same way: the doc-link check's true blast radius (`[P11]`). It was measured, put to the owner as a dialog, and decided — broad check over a recorded allowlist — before this document was stamped.

Nothing in this plan is deferred. A `[Q##]` here would mean a question that was asked and declined; there is none.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A deletion dangles a live citation | med | high | Every deletion step greps for its own paths across `--exclude-dir=.git --exclude-dir=node_modules` before deleting, and repairs the hits in the same commit | Step 10's link test goes red after a deletion step |
| The `dash-join` deletion catches the live card verb | high | med | Risk R01 below; the audit grep and the explicit keep-list in Step 4 | `slash-commands.ts` or a `session-changes-dash-join` DOM slot appears in Step 4's diff |
| The link test is too broad and flags intentional prose | low | high | Risk R02 below; the test's scan set is narrowed to source comments and `tuglaws/`, excluding `dash/archive/` | The test's first red run names something outside the four known CSS cites and the one design-decisions cite |

**Risk R01: `dash-join` is overwhelmingly a live name** {#r01-dash-join-collision}

- **Risk:** The string `dash-join` appears across the tree as the **live card verb** (`slash-commands.ts` registers `join` with `deprecatedFor: "dash-join"`; `session-card.tsx` routes it through `runRetiredVerb`), as **live DOM slots** (`session-changes-dash-join`, `session-changes-dash-join-account`, `session-changes-dash-join-question`, `dash-join-register`), as a **live component** (`session-changes-dash-join.tsx`), and in **live app-tests** (`at0435`, `at0442`, `at0462`). A `grep -rl dash-join | xargs` deletion pass would destroy the join surface.
- **Mitigation:**
  - Step 4's Tasks name the exactly six edit sites and nothing else.
  - Its checkpoint asserts `slash-commands.ts` still carries `deprecatedFor: "dash-join"`.
- **Residual risk:** None material — the surviving sites are pinned by app-tests that would go red.

**Risk R02: a doc-link test that flags prose is a test nobody keeps** {#r02-link-test-noise}

- **Risk:** A check that "every relative document path resolves" will flag illustrative paths in prose, archived plans citing files that were correctly deleted, and `roadmap/` mentions that are *about* the name rather than pointers to a file (`tugplug/skills/plan-devise/SKILL.md` says `roadmap/` is deliberately not a blessed name — the correct sentence to keep, per `[F10]`). **Measured, this is not hypothetical**: a naive extraction over the scan set produces 707 hits, of which 406 are bare filenames like `` `SKILL.md` `` being discussed by name and 28 are globs and interpolations.
- **Mitigation:**
  - Scan set is bounded (Spec S02): source comments under `tugdeck/src`, `tugdeck/styles`, `tugcode/src`, `tugrust/crates/*/src`, plus `tuglaws/*.md`. `dash/` and `dash/archive/` are excluded outright — an archived plan is a historical record and its dead pointers are part of the history.
  - The repo-relative-pointer test (Spec S02's extraction rules) drops bare directory names, bare filenames, globs, and `../`/`~` paths. That is what takes 707 down to 247.
  - The remaining 247 are real dangles, and `[P11]` handles them with a recorded allowlist rather than by loosening the rule until the noise stops.
- **Residual risk:** The test cannot tell a correct pointer from a plausible one; it only proves the target exists. And an allowlist can be grown to silence a real failure — mitigated only by the two-sided assertion (a repaired entry fails) and by review; nothing mechanical stops someone appending a line instead of fixing a pointer.

---

### Design Decisions {#design-decisions}

#### [P01] A finding whose premise dissolved is struck, not implemented (DECIDED) {#p01-strike-dissolved}

**Decision:** Where this devise round's re-verification contradicts the brief, the finding is **struck** and recorded in [#inventory-corrections](#inventory-corrections) with the evidence, and no step implements it.

**Rationale:**
- It is the brief's own method. `[F10]` struck three original suspects for exactly this reason: *a sweep that trusts its memory deletes live code.*
- `[B01]` forbids the plan from *investigating*, not from being correct. A step that deleted `tugcode/probes/` would break `bun test` in tugcode — a plan is not obliged to execute a mistake.

**Implications:**
- `[F02]`'s `probes/` half, `[F07]`, `[F09]`, and `[F16]` produce no step.
- `[F03]` grows from three items to four.
- Each strike is written down, so the next sweep inherits the verification instead of repeating it.

#### [P02] "Cited by nothing" is tested against live source, live tests, and tuglaws (DECIDED) {#p02-citation-test}

**Decision:** A candidate is dead when nothing **live** names it: no source file, no test, no tuglaw, no skill, no justfile recipe. Build manifests (`package.json`, the justfile) are one input among those, never the whole test. `dash/archive/` citations do not count as consumers.

**Rationale:**
- `[F02]` declared `tugcode/probes/` unreferenced on the strength of three manifests. In fact `tugcode/src/__tests__/wake-reinit-drift.test.ts` reads its captures as fixtures and `tuglaws/slash-commands.md#probe-discipline` names it *the reference shape*. Three of the seventeen root probes are cited from live source comments for the same reason.
- The inverse also holds: `dash/archive/` is where finished paperwork goes, so a path cited only from there has no live consumer.

**Implications:**
- The kill list is smaller than the brief's and better argued.
- Step 10's permanent check is the mechanical version of this rule for documents.

#### [P03] The seventeen root probes split three ways (DECIDED) {#p03-root-probe-split}

**Decision:** Of `tugcode/probe-*.ts`:
- **Fourteen are killed** — cited by nothing live (see [#l01-root-probe-disposition](#l01-root-probe-disposition)).
- **Two are kept** — `probe-case-a.ts` and `probe-case-a-race.ts`, cited from live source at `tugdeck/src/lib/code-session-store/reducer.ts` (three sites) as runnable empirical grounding for the `pendingCaseAEchoes` counter.
- **One is killed with a repair** — `probe-tool-overlap.ts`, whose only live citation (`tugcode/src/session.ts`, the `pendingTurnInputs` docstring) is re-pointed at the authoritative corpus finding.

**Rationale:**
- A live citation is a consumer ([P02]); the case-a pair has three.
- `probe-tool-overlap.ts` is the exception because the tree has already **retracted** it by name: `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.181-steering-spike/README.md` calls its transcript *"a labelled false start … Not evidence for anything"* and names `queued-command-mechanism.md` as the authoritative finding. A comment citing a retracted probe is a stale claim under `[B04]`.

**Implications:**
- Step 2 deletes fifteen files and edits one docstring, in one commit.
- The kept pair is recorded here so the next sweep does not re-raise it.

#### [P04] A permanent check lands in the same commit as the fix it names (DECIDED) {#p04-check-with-fix}

**Decision:** The two `[B08]` checks are not separate steps from the `[F06]`, `[F03]`, and `[F08]` repairs. Each check is written first, run against the unfixed tree, its red output recorded in the round's `summary`, and then the fix applied and the check re-run green — all inside one step, one commit.

**Rationale:**
- The brief requires each check be *"red against the tree before its finding was fixed."* A check committed after its fix has only ever been observed green, which proves nothing about whether it can fail.
- **Never commit red** forbids the obvious alternative of a test-only commit. Landing both halves together satisfies both rules with no exception.

**Implications:**
- Step 9 is "INDEX-coverage check + `[F06]`". Step 10 is "doc-link check + `[F03]` + `[F08]`".
- The red observation is a **task**, and the round's `summary` is where it is recorded — never a comment in the test file, which would be a comment narrating history (`[B04]`).

#### [P05] Both checks are pure-logic `bun:test` files under `tests/app-test/scripts/` (DECIDED) {#p05-check-home}

**Decision:** The two checks live at `tests/app-test/scripts/tuglaws-index-coverage.test.ts` and `tests/app-test/scripts/doc-link-resolution.test.ts`.

**Rationale:**
- The brief said *"wherever the existing doc-consistency tests live."* There are none — this devise round looked. So the home is a decision, not a lookup.
- `tests/app-test/scripts/` is already run by the justfile's `test-ts` recipe (`cd tests/app-test && bun test scripts/ _harness/`), so both checks reach `just ci` with no justfile edit.
- Its four existing `select-tests-*.test.ts` files are the precedent: pure-logic tests about the repository itself, launching no app, invisible to the app-test corpus scanner (`testFiles()` scans only the corpus root and `harness-smoke/`).
- The repo-root idiom is established there: `const APP_TEST_DIR = resolve(dirname(import.meta.dir)); const REPO_ROOT = resolve(APP_TEST_DIR, "..", "..");`.

**Implications:**
- Neither file needs an `@covers` header — `just app-test-covers-check` scans the corpus, not `scripts/`.
- Neither may use a fake-DOM or mock-store shape; both are file reads and string work.

#### [P06] The placement experiment is deleted (DECIDED) {#p06-placement-delete}

**Decision:** `session-card-placement-experiment.tsx`, its test, its `main.tsx` install, its three `session-card.tsx` call sites, and the two `session-card-transcript.tsx` comments that name it all go.

**Rationale:** Owner's call this round: the placement question it was built to answer has been answered. It is a spike that never got deleted, and the spikes README already says spikes are deleted when they graduate.

**Implications:** `window.tugSessionPlacement` ceases to exist. The Z1/Z2/Z4B slots revert to their production defaults, which is what a release build has always rendered — the harness was dev-gated, so no shipping behavior changes.

#### [P07] The `dash-join` skill is deleted; the card verb is not (DECIDED) {#p07-dash-join-skill-delete}

**Decision:** `tugplug/skills/dash-join/` is deleted, with its four roster and prose references. `/dash-join` the **card verb**, the `/join` **alias**, `session-changes-dash-join.tsx`, and every `dash-join` DOM slot stay exactly as they are.

**Rationale:**
- Owner's call this round. Since `[D147]` the shade summons itself and the join is a composer gesture; the doctrine's stop-before-join obligation already answers *no* to a model joining on the user's behalf for every other skill, and there is no reason this one is different.
- Its only caller in the tree is `dash-on/SKILL.md`'s ending, which is exactly the sentence `dash-implement`'s ending does not have.

**Implications:**
- `dash-on`'s ending says *the shade is the door*, matching `dash-implement`.
- The plugin roster shrinks in three places: `CLAUDE.md`, `tugplug/CLAUDE.md`, `tugplug/.claude-plugin/plugin.json` (both `description` and `keywords`).
- See Risk R01 — this is the one step where a careless grep is destructive.

#### [P08] `plan-devise`'s off-arc path is cut (DECIDED) {#p08-plan-devise-arc-only}

**Decision:** `tugplug/skills/plan-devise/SKILL.md` §5 loses its non-arc branch, its `tugutil session rotate` fallback prose, and its `/tugplug:plan-review` chip. The skill states that it runs under an arc, and that a run with no `TUG_DASH_ARC` stops and says so.

**Rationale:** Owner's call this round: `plan-devise` is an implementation detail of `/dash` and is never run by hand. Prose describing a door nobody uses is the exact shape of the drift this sweep exists to clear — §5's *previous* stale fork (`[F04]`) is the same failure one revision earlier.

**Implications:**
- A terminal claude loses the ability to devise a plan through this skill. That is the decision, not a side effect.
- Step 5 depends on Step 7 in spirit but not in fact: `[F04]` replaces `dash/SKILL.md`'s stale fork with a **pointer** at `plan-devise` §5 rather than a restatement (`[B03]`), so the pointer stays correct whatever §5 says. Step 7 must not quote §5.
- The skill's guardrail list loses "never review and never print a chip *under an arc*" as a conditional and gains it as the rule.

#### [P09] `diag/` is deleted (DECIDED) {#p09-diag-delete}

**Decision:** `diag/` — seven shell scripts and `deck-probes/`'s six JS probes — is deleted in one commit.

**Rationale:** Owner's call this round: the perf campaign moved to `just` recipes. The scripts are referenced by nothing in the justfile or tuglaws.

**Implications:** Thirteen tracked files go. Nothing cites them, so no repair rides along — Step 6's grep confirms that rather than assuming it.

#### [P10] `dash-notes.md` is folded, not archived (DECIDED) {#p10-dash-notes-fold}

**Decision:** `dash/dash-notes.md` stays in `dash/`. Its five numbered sections and the trailing `/dash` prompt transcript are deleted; its open items at the head of the file remain.

**Rationale:**
- `[B06]` says the note is archived *"once nothing in it is still open."* Something is: the head of the file carries six open items (dash inflight display during planning, brief formalization, a custom `/dash-arc` display, inconsistent dash atom styling, the yellow dash name, join progress persistence in the transcript). None of them is this sweep's.
- All five numbered sections are finished: §1 landed as the conductor, §2 as the interruption doctrine, §3 as `tugutil dash verify`, §4 is the abandoned `tugutil` rename, and §5 is this plan. Deleting them is `[B04]` applied to a planning note.

**Implications:** Step 11 archives the three landed briefs and folds the note; `dash/` ends with five entries.

#### [P11] The doc-link check ships broad, over an allowlist of the debt it finds (DECIDED) {#p11-doc-link-allowlist}

**Decision:** Spec S02 asserts the full rule — every repo-relative `.md` pointer in the scan set resolves — and reads `tests/app-test/scripts/doc-link-allowlist.txt`, a checked-in list of the dangles that exist on the day it lands. Step 10 repairs the four CSS cites and seeds the allowlist with the rest. A pointer that dangles and is **not** listed fails the build.

**Rationale:**
- Owner's call this round, on a measurement the brief and the devise round both missed. The check as first specified expected four failures; the tree has 247 ([#s02-doc-link](#s02-doc-link)). That is not a tuning error — it means the `roadmap/` prefix this sweep repairs is the small half of a failure the tree has at fifty times the scale under the `dash/` prefix.
- Repairing all 247 inside Step 10 would make the sweep a different piece of work: 134 citations (79 targets) re-point mechanically to `dash/archive/`, and 113 citations (26 targets) point at documents that exist nowhere, each needing the same judgment `[F03]`'s two unresolvable cites needed. `[B01]` says this plan investigates nothing.
- Narrowing the check to the `roadmap/` prefix would land green and prove almost nothing — the next stale pointer will not be spelled `roadmap/`, because that prefix is already extinct after this step.
- An allowlist keeps `[B08]`'s promise exactly: *the day a doc claim goes stale, a test fails.* It fails for every **new** dangle from the moment it lands, which is the whole of what a drift check can honestly do about debt it did not create.

**Implications:**
- The allowlist file is an artifact of Step 10 and is named in the exit criteria.
- It is a to-do list with a green build, not an exemption: [#follow-ons](#follow-ons) carries the 243 surviving entries forward as their own brief, and `dash/dev-atoms.md` — 45 citations to a document that exists nowhere — is that brief's first question.
- `[P04]`'s red-run discipline holds and is *strengthened*: the first red run is recorded in the round's `summary` with its true count, so the artifact records what the check actually found rather than what the plan predicted.
- The check must fail on an allowlist entry whose dangle has since been **repaired** — a stale allowlist is the same disease one layer up. Spec S02's assertion is two-sided: every listed pair must still be a real dangle.

**List L01: root-probe disposition** {#l01-root-probe-disposition}

| Probe | Live citations | Disposition |
|---|---|---|
| `probe-btw-overlap.ts` | `dash/archive/tide-assistant-turns.md` only | delete |
| `probe-case-a.ts` | `tugdeck/.../reducer.ts` (2 sites) | **keep** |
| `probe-case-a-race.ts` | `tugdeck/.../reducer.ts` (1 site) | **keep** |
| `probe-compact.ts` | none | delete |
| `probe-fresh.ts` | none | delete |
| `probe-image.ts` | none | delete |
| `probe-interrupt.ts` | none | delete |
| `probe-model.ts` | none | delete |
| `probe-multi.ts` | its own usage line only | delete |
| `probe-overlap.ts` | `dash/archive/tide-assistant-turns.md` only | delete |
| `probe-raw-claude.ts` | none | delete |
| `probe-raw-stdin.ts` | none | delete |
| `probe-resume.ts` | none | delete |
| `probe-session.ts` | none | delete |
| `probe-skill.ts` | its own usage lines only | delete |
| `probe-tool-overlap.ts` | `tugcode/src/session.ts` — **retracted** by the steering-spike README | delete + repair |
| `probe-websocket.ts` | `dash/archive/` only, and under its old `tugtalk/` path | delete |

---

### Deep Dives {#deep-dives}

#### Inventory corrections: what this devise round found (MANDATORY READING) {#inventory-corrections}

The brief's findings were re-verified against the tree. Five corrections follow; an implementer who skips them will delete a live fixture and miss a stale comment.

##### [F02]'s `probes/` half is struck {#f02-probes-struck}

**The brief said:** `tugcode/probes/` — three investigations, 61 tracked files, 772 KB — is a kill after one read, referenced by nothing.

**What the tree says:** `tugcode/probes/` is 43 tracked files, and it is a **documented discipline with a live fixture consumer**:

- `tuglaws/slash-commands.md#probe-discipline` prescribes it as a convention: *"Probes live under `tugcode/probes/<topic>/` as runnable `.mjs` scripts plus timestamped captures and a `FINDINGS.md`; `tugcode/probes/wake-investigation/` is the reference shape."*
- `tugcode/src/__tests__/wake-reinit-drift.test.ts` **reads the captures at run time**. Its `loadCapture()` resolves `../../probes/wake-investigation/`, `readdirSync`s for `capture-sw-60-*.stdout` and `capture-cron-1m-*.stdout`, and **throws** if none is found. Deleting the directory turns `bun test` in tugcode red.
- `tuglaws/design-decisions.md` cites the `FINDINGS.md` files by path in `[D102]` and `[D108]`; `tuglaws/session-card-unsupported-slash-commands.md` cites both; roughly a dozen live source and test files under `tugdeck/src/lib/code-session-store/` and `tugcode/src/` carry `#q01-goal` / `#q02-loop` deep links; `tests/app-test/at0197-scheduled-survives-respawn.test.ts` cites one.

The brief checked `package.json`, the justfile, and `tugcode/CLAUDE.md`, and concluded from three misses that nothing referenced it. **Struck** under [P01]/[P02]. `[B05]` — read the probe findings before burning them — is discharged by the strike: nothing is burned, so nothing needs relocating, and `[D102]` and `[D108]` already carry the conclusions in `tuglaws/`.

Only the **seventeen loose `tugcode/probe-*.ts`** at the tugcode root remain in scope, and they split three ways ([P03], [#l01-root-probe-disposition](#l01-root-probe-disposition)). They are outside the documented `probes/<topic>/` layout, which is what made them look like the same finding.

##### [F07] is struck: both documents are cited {#f07-struck}

**The brief said:** `framework-architecture.md` and `list-surface-grammar.md` are referenced by no other tuglaw, no skill, no source comment, no test, and no dash document — only by `INDEX.md`.

**What the tree says:**

- `framework-architecture.md` is `INDEX.md`'s **first entry, under "Start here", with the words "Read first."** It is also cited by `THIRD_PARTY_NOTICES.md:45` as the document recording where a third-party dependency is used, and by five archived dash plans.
- `list-surface-grammar.md` is indexed with a full "read before" line — *"Read before adding a surface that lists files, dashes, or sessions"* — and states a live component rule (`TugSectionLabel`, `TugMetaRun`, `TugDashName`) that the Changes shade, the Lens's Dashes section, and the `/dash-bind` picker all obey.

Both are live reference laws that nobody has needed to argue with, which is what the brief allowed for. **Struck**, and not raised with the owner — a question with a conventional default is one the doctrine's never-ask list forbids.

##### [F09] is struck: `capabilities/2.1.222` exists {#f09-struck}

**The brief said:** `capabilities/LATEST` names `2.1.222`; the newest snapshot directory is `2.1.217`.

**What the tree says:** `capabilities/2.1.222/system-metadata.jsonl` is tracked and present — the same single-file shape as every other snapshot including `2.1.217`. `LATEST` is correct and the snapshot was committed. **Struck**; no step.

##### [F16] is struck: `tests/model-eval/` is a live directory and its cache is already ignored {#f16-struck}

**The brief said:** `tests/model-eval/` contains only a `__pycache__/`.

**What the tree says:** `tests/model-eval/` is a full, tracked eval harness — `README.md`, `harness.py`, `run.py`, `score.py`, `classify.py`, `analyze.py`, `liveness.py`, `verbs.txt`, `veto-filter.ts`, and a `corpus/` of paired `.json`/`.digest.txt` fixtures. It backs the open local-scribe evaluation. The `__pycache__/` is **untracked and already gitignored** at `.gitignore:72`. There is no `.gitignore` gap. **Struck**; no step.

##### [F03] grows from three to four {#f03-grows}

The brief named three CSS comments citing unresolvable `roadmap/` paths. There are **four**, and they need two different repairs:

| Site | Cites | Resolves? | Repair |
|---|---|---|---|
| `tugdeck/styles/focus-ring.css:10` | `roadmap/tugplan-focus-language.md` | yes, at `dash/archive/tugplan-focus-language.md` | re-point the prefix |
| `tugdeck/src/components/tugways/tug-pane.css:139` | `roadmap/jul30-perf-brief.md#i1-sparkline-exception` | yes, at `dash/archive/jul30-perf-brief.md` | re-point the prefix |
| `tugdeck/src/components/tugways/cards/tug-atom-text-body.css:51` | `roadmap/dev-atoms.md#d08-tool-block-only` | **no** — nothing under `dash/` or `dash/archive/` | reduce to what the code does |
| `tugdeck/src/components/tugways/chrome/session-permission-dialog.css:16` | `roadmap/archive/dev-interactive-dialogs.md` | **no** | reduce to what the code does |

`focus-ring.css` is the one the brief missed. All four are Step 10's, which is also where the check that would have caught them lands.

#### What the two permanent checks are for {#why-permanent-checks}

`[B08]`: the sweep leaves a method behind, not a habit. Both checks are cheap greps, and both would have caught their findings the day they became stale — `[F06]` (a tuglaw indexed nowhere) and `[F03]`/`[F08]` (a pointer resolving to nothing) are failures of the same kind: a claim in a durable document that stopped being true and had nobody to tell.

Nothing broader is adopted. `[B08]` explicitly declines `knip` and an unused-export sweep; the Rust side is already under `-D warnings`, and tugdeck's dead exports are a different brief if they are one at all.

---

### Specification {#specification}

**Spec S01: `tuglaws-index-coverage.test.ts`** {#s01-index-coverage}

- **Input:** the filenames of every `*.md` under `tuglaws/`, and the text of `tuglaws/INDEX.md`.
- **Assertion:** every such filename other than `INDEX.md` itself appears in `INDEX.md` as a markdown link target — the substring `](<filename>)`.
- **Failure message:** names each unindexed document, so the diagnostic *is* the to-do.
- **Not asserted:** that the index entry is accurate, well-placed, or in the right section. The check proves coverage, not quality.
- **Expected first (red) run:** exactly one name — `ledger-reliability.md`, which `conductor.md` cites twice and the index never (`[F06]`).

**Spec S02: `doc-link-resolution.test.ts`** {#s02-doc-link}

- **Scan set:** every file under `tugdeck/src`, **`tugdeck/styles`**, `tugcode/src`, and `tugrust/crates/*/src`, plus every `*.md` under `tuglaws/`. `dash/`, `dash/archive/`, `node_modules`, and build outputs are excluded — an archived plan's dead pointers are part of the history it records. `tugdeck/styles` is in the set because `focus-ring.css` lives there and is one of the four cites [#f03-grows](#f03-grows) exists to repair; a scan set that omitted it would go red naming three of four.
- **Extraction — two rules, each matching what its own syntax means.** Candidates are tokens ending in `.md`, optionally followed by a `#anchor` which is stripped before resolution, taken from backticked spans and markdown link targets. How a candidate resolves depends on how it was written:
  1. **A markdown link target inside a `*.md` file resolves against the citing document**, because that is what a markdown link means. This is the rule that makes the check see the tuglaws' own cross-references, which are written sibling-relative: `[ledger-reliability.md](ledger-reliability.md)`. There are 332 of them and 306 resolve; without this rule the check is blind to every one, and Step 12's checkpoint asserts nothing.
  2. **Everything else resolves against the repo root**, and only if the token is a **repo-relative pointer**: it contains a `/`, contains none of `* < > $ { }`, and does not begin with `.`, `~`, or `/`. This covers backticked spans everywhere and markdown links in source comments — the form `tug-atom-text-body.css` uses (`[D08](roadmap/dev-atoms.md#d08-tool-block-only)`), which rule 1 would otherwise miss because a `.css` file is not markdown.
- These are two conventions, not one convention with a tolerance shim: a document-relative markdown link and a repo-relative backticked path are distinguishable by syntax and are resolved by the rule that matches. Nothing is tried twice.
- **Not a pointer, and not extracted** — this is what takes a naive 707 hits down to 247:
  - a bare directory token such as `roadmap/` — `tugplug/skills/plan-devise/SKILL.md` says `roadmap/` is deliberately not a blessed name, which is the correct sentence to keep (`[F10]`);
  - a bare filename in a *non*-markdown context (`` `SKILL.md` ``, `` `MEMORY.md` ``) — 406 of these exist and every one is a name being discussed, not a path being followed;
  - a glob or interpolation (`` `*.md` ``, `` `<name>/SKILL.md` ``, `` `${c}.md` ``);
  - a file-relative or home-relative *backticked* path (`` `../probes/btw/FINDINGS.md` ``, `` `~/.claude/CLAUDE.md` ``). Note the asymmetry with rule 1 and that it is deliberate: `../` inside a markdown **link** is resolved, because there the base is defined; inside a backtick span it is not, because there it is prose about a path whose base is anybody's guess.
- **Allowlist ([P11]):** the check reads `tests/app-test/scripts/doc-link-allowlist.txt` — one `<citing-file> <cited-path>` pair per line, `#` comments permitted. A pair on the list is reported as known debt and does not fail. A dangle **not** on the list fails. The list is seeded from the first red run minus the pointers this step repairs, so it is the debt inventory, not an exemption mechanism.
- **Assertion (two-sided):** every extracted repo-relative pointer not on the allowlist resolves to a file that exists relative to the repo root; **and** every pair on the allowlist is still a real dangle. An entry whose target has since been created, or whose citing file no longer cites it, fails — a stale allowlist is the same disease one layer up, and the failure message says to delete the line.
- **Failure message:** the citing file, the cited path, and the sentence that an intentional survivor belongs on the allowlist with a reason.
- **Expected first (red) run:** **247 citations across 105 unique targets**, not four. This review round measured it against the tree at the head this plan is written on. All four `roadmap/*.md` CSS cites of [#f03-grows](#f03-grows) are among them — that is the check working — and the other 243 are the *same* failure mode under a different prefix: `dash/<plan>.md` for a plan that has since moved to `dash/archive/` or been deleted. The distribution is 110 in `tuglaws/*.md`, 105 in `tugdeck/src` and `tugcode/src` sources, 28 under `src/__tests__` and its fixtures, 4 in CSS. The largest single target is `dash/dev-atoms.md` with **45 citations to a document that exists nowhere**, then `dash/tugplan-session-wake.md` (18) and `dash/tugplan-session-mid-turn-replay.md` (11). Treat a total far from 247 as evidence the extraction has drifted from the two rules above — the count moves with the tree, but not by an order of magnitude.
- **Not asserted:** that an allowlisted pointer is acceptable. The list is a to-do with a green build, and [#follow-ons](#follow-ons) carries it forward.
- `spike-dash-progress` from `tuglaws/design-decisions.md` is **not** in the red run: `[D143]` spells it `` `spike-dash-progress` §5 ``, a bare spike name with no `.md`, so the extraction never sees it. `[F08]` is therefore fixed by hand in the same step; say so in the round's summary rather than widening the check to catch one case.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Existing suites, unchanged** | Prove a deletion took nothing live with it | Every deletion step: `bunx tsc --noEmit` plus the affected package's `bun test` |
| **Drift prevention (new)** | Catch the next stale doc claim the day it appears | The two `[B08]` checks (Spec S01, Spec S02) |
| **Prose assertion** | Prove a text repair says the true thing | The prose-repair steps, whose checkpoint is a grep for the retired sentence returning nothing |

#### What stays out of tests {#test-non-goals}

- **The deleted code.** A deletion needs no new test; the proof is that the existing suites stay green with the files gone.
- **The accuracy of an index entry or a doc pointer.** Spec S01 and Spec S02 prove existence, not correctness. A check that tried to judge whether a cross-reference was *apt* would be a judgment nobody could encode, and it would go stale faster than what it guards.
- **Real-app behavior.** Nothing in this plan changes a rendered surface. The placement experiment (Step 3) was dev-gated, so a release build's zones are unaffected; no app-test is written or run.
- **The project's banned fake-DOM and mock-store shapes**, per the doctrine's test discipline. Both new checks are file reads and string comparisons over real repository content, so neither is tempted toward one.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Delete the archived conversation card | done | `ce3cdb9b8` |
| #step-2 | Delete the uncited root probes | done | `d027b92d4` |
| #step-3 | Delete the placement experiment | done | `dd2f57d99` |
| #step-4 | Delete the `dash-join` skill | done | `b65068ad0` |
| #step-5 | Cut `plan-devise`'s off-arc path | done | `441b0184c` |
| #step-6 | Delete `diag/` | done | `98098aa14` |
| #step-7 | Retire `dash/SKILL.md`'s pre-conductor review fork | done | `f8d274688` |
| #step-8 | Correct the join vocabulary in the project instructions | done | `1ee29034f` |
| #step-9 | Index-coverage check, and index the fortieth tuglaw | done | `0e707157f` |
| #step-10 | Doc-link check, and repair the pointers it names | done | `7cbb9fa90` |
| #step-11 | Archive the landed briefs and fold the planning note | done | `b17d4652d` |
| #step-12 | Name the kill/alias split in the doctrine | done | `df22d2230` |
| #step-13 | Integration Checkpoint | done | `81ec6b9f4` |

---

#### Step 1: Delete the archived conversation card {#step-1}

**Commit:** `tugdeck(archive): delete the conversation card and the tests that kept it`

**References:** [P02] Citation test, [B01], [B02], (#context, #f02-probes-struck)

**Artifacts:**
- `tugdeck/src/_archive/` removed (12 tracked files under `cards/conversation/`).
- `tugdeck/src/__tests__/ordering.test.ts` and `tugdeck/src/__tests__/conversation-types.test.ts` removed.
- `tugdeck/tsconfig.json` `exclude` array emptied or removed.

**Background for a cold reader:** the directory is last-touched 2026-07-07 and is excluded from the build by `tugdeck/tsconfig.json`'s `exclude` array, which lists the archive glob *and both test files by name*. The only importers of the archive are those two tests — an archive whose sole consumers are tests of the archive has no consumers. `session-cache.ts` is also the last IndexedDB code in the deck, which the project has already slated for removal.

**Tasks:**
- [ ] `git rm -r tugdeck/src/_archive`.
- [ ] `git rm tugdeck/src/__tests__/ordering.test.ts tugdeck/src/__tests__/conversation-types.test.ts`.
- [ ] Remove all three entries from `tugdeck/tsconfig.json`'s `exclude` array; if that leaves it empty, remove the key — an empty exclusion list is a line that says nothing.
- [ ] `grep -rn "_archive" tugdeck/ --exclude-dir=node_modules` and confirm no hit remains outside `dash/archive/`.

**Tests:**
- [ ] No new test. The existing tugdeck suite staying green with the files gone is the proof.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test`
- [ ] `git ls-files tugdeck/src/_archive` prints nothing.

---

#### Step 2: Delete the uncited root probes {#step-2}

**Depends on:** #step-1

**Commit:** `tugcode(probes): delete the uncited root probes, keep the two live source cites`

**References:** [P02] Citation test, [P03] Root-probe split, List L01, [B02], [B04], (#f02-probes-struck, #l01-root-probe-disposition)

**Artifacts:**
- Fifteen files removed from `tugcode/`.
- `tugcode/src/session.ts`'s `pendingTurnInputs` docstring re-pointed.

**Background for a cold reader:** these are the *loose* probes at the tugcode root, not `tugcode/probes/`. `tugcode/probes/` **stays** — it is a documented discipline whose captures a live test reads; see [#f02-probes-struck](#f02-probes-struck) before touching anything named "probe".

**Tasks:**
- [ ] `git rm` the fifteen files marked `delete` in [#l01-root-probe-disposition](#l01-root-probe-disposition). Do **not** remove `tugcode/probe-case-a.ts` or `tugcode/probe-case-a-race.ts`.
- [ ] In `tugcode/src/session.ts`, find the `pendingTurnInputs` docstring's sentence *"it does this at an agent-loop iteration boundary; see `probe-tool-overlap.ts`"*. Replace the citation with the authoritative corpus finding: `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.181-steering-spike/queued-command-mechanism.md`. That README explicitly retracts the probe's single-run reading as *"a labelled false start … Not evidence for anything"*, so a comment resting on it is a stale claim under `[B04]`.
- [ ] In the same steering-spike README, delete the `merge-midturn-probe-transcript.txt` bullet's reference to `tugcode/probe-tool-overlap.ts` as a runnable script — the transcript file stays as the labelled false start it already is; only the pointer to the deleted probe goes.
- [ ] `grep -rn "probe-" tugcode/src tugdeck/src tugrust/crates --include='*.ts' --include='*.rs' --include='*.md'` and confirm every surviving hit names `tugcode/probes/…`, `probe-case-a`, or `probe-case-a-race`.

**Tests:**
- [ ] No new test. The tugcode suite — including `wake-reinit-drift.test.ts`, which reads `tugcode/probes/wake-investigation/`'s captures — staying green is what proves the right directory survived.

**Checkpoint:**
- [ ] `cd tugcode && bunx tsc --noEmit`
- [ ] `cd tugcode && bun test`
- [ ] `git ls-files 'tugcode/probe-*.ts'` prints exactly `tugcode/probe-case-a-race.ts` and `tugcode/probe-case-a.ts`.
- [ ] `git ls-files tugcode/probes | wc -l` prints 43.

---

#### Step 3: Delete the placement experiment {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(session-card): delete the placement-experiment harness`

**References:** [P06] Placement experiment deleted, [B02], (#p06-placement-delete)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/session-card-placement-experiment.tsx` removed.
- `tugdeck/src/components/tugways/cards/__tests__/session-card-placement-experiment.test.ts` removed.
- `main.tsx`, `session-card.tsx`, `session-card-transcript.tsx`, and `session-card-telemetry-renderers.tsx` cleaned of its traces.

**Background for a cold reader:** a dev-gated A/B harness for the Session card's display zones, driven from a `window.tugSessionPlacement` global. It was built to answer a placement question that has since been answered. In a release build it returns the production defaults, so removing it changes no shipping behavior — the deletion is about the code, not the render.

**Tasks:**
- [ ] `git rm` the component and its test.
- [ ] Remove `main.tsx`'s `installSessionPlacementGlobal` import and its call site.
- [ ] Remove `session-card.tsx`'s `useSessionPlacementSlots` import and all three consumption sites, restoring each to the production default the harness was overriding — the Z1 turn-trailing renderer, the Z2/Z4B slot assignment, and the third site's default datum. The surrounding comments name which default each falls back to; keep the code's behavior and delete the harness branch.
- [ ] Delete the two `session-card-transcript.tsx` comments that describe the placement-experiment renderer and its memoization, and rewrite the surrounding sentences so they describe what the code does without it (`[B04]`).
- [ ] `session-card-telemetry-renderers.tsx`: repair the comment that says the value is *"threaded down through `useSessionPlacementSlots`"*. This file is a fifth site the finding did not name — it holds no code, only a sentence about a hook that is about to stop existing. State how the value reaches the renderer without it (`[B04]`).
- [ ] `grep -rn "tugSessionPlacement\|placement-experiment\|SessionPlacement" tugdeck/src` returns nothing.

**Tests:**
- [ ] No new test. The removed test covered only the harness's own parser.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build` — the debug app loads the production rollup bundle, so a build is the only proof the three call sites still compose.

---

#### Step 4: Delete the `dash-join` skill {#step-4}

**Depends on:** #step-3

**Commit:** `tugplug(dash-join): delete the skill; the shade is the only door`

**References:** [P07] Skill deleted, card verb kept, Risk R01, [B02], [B03], (#p07-dash-join-skill-delete, #r01-dash-join-collision)

**Artifacts:**
- `tugplug/skills/dash-join/` removed.
- Roster entries removed from `CLAUDE.md`, `tugplug/CLAUDE.md`, and `tugplug/.claude-plugin/plugin.json`.
- `tugplug/skills/dash-on/SKILL.md`'s two references removed.

**Background for a cold reader:** **read Risk R01 before running any grep.** The string `dash-join` is overwhelmingly a *live* name in this tree — the card verb, four DOM slots, a shipping component, and three app-tests. Exactly six sites change, listed below. Nothing else named `dash-join` is touched.

**Tasks:**
- [ ] `git rm -r tugplug/skills/dash-join`.
- [ ] `CLAUDE.md`: drop `dash-join` from the `tugplug/` row's skill roster.
- [ ] `tugplug/CLAUDE.md`: delete the `dash-join` roster bullet entirely. (It also carries the same `/join`-vs-`/dash-join` drift Step 8 fixes; deleting the bullet resolves it here.)
- [ ] `tugplug/.claude-plugin/plugin.json`: remove `dash-join` from `description` and from `keywords`.
- [ ] `tugplug/skills/dash-on/SKILL.md`: in the sentence *"Joining belongs to `/join` and `dash-join`…"*, drop the skill and name the live verb — joining belongs to the `/dash-join` card verb, of which `/join` is the retired spelling (`[B03]`).
- [ ] `tugplug/skills/dash-on/SKILL.md`: delete the second sentence of the ending's chip paragraph — *"If the user asks you to run the join instead, `/tugplug:dash-join <name>` is the same join in skill form."* — leaving the ending saying the shade is the door, as `dash-implement`'s does.
- [ ] Audit: `grep -rn "dash-join" --exclude-dir=.git --exclude-dir=node_modules . | grep -v "dash/archive/"` and confirm every surviving hit is the card verb, a DOM slot, a component, an app-test, or this plan.

**Tests:**
- [ ] No new test. The card verb's app-tests (`at0435`, `at0442`, `at0462`) already pin the surface this step must not touch; they are not run here because nothing this step edits reaches them.

**Checkpoint:**
- [ ] `git ls-files tugplug/skills/dash-join` prints nothing.
- [ ] `grep -n 'deprecatedFor: "dash-join"' tugdeck/src/lib/slash-commands.ts` still matches — the alias survives.
- [ ] `git ls-files 'tugdeck/src/**/session-changes-dash-join*'` still lists all three of `session-changes-dash-join.tsx`, `.css`, and `__tests__/session-changes-dash-join.test.ts` — the join surface and its pure-logic test survive.
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 5: Cut `plan-devise`'s off-arc path {#step-5}

**Depends on:** #step-4

**Commit:** `tugplug(plan-devise): the skill runs under an arc, and says so`

**References:** [P08] Off-arc path cut, [B02], (#p08-plan-devise-arc-only)

**Artifacts:**
- `tugplug/skills/plan-devise/SKILL.md` §5 reduced to the arc contract.

**Background for a cold reader:** §5 currently forks — an arc branch (finish, print no chip, end the turn; the runner rotates) and a non-arc branch (ask the conductor with `tugutil session rotate --stage review`, fall back to a `/tugplug:plan-review` chip on refusal). The owner's position, settled this round, is that `plan-devise` is an implementation detail of `/dash` and is never run by hand, so the non-arc branch is prose for a door nobody uses. Note the shape of the drift being retired: §5's *previous* fork was the pre-conductor one that Step 7 deletes from `dash/SKILL.md`.

**Tasks:**
- [ ] Rewrite §5 as a single contract: this stage runs under an arc; finish at a written, lint-clean plan at the given path; review no plan on any model; print no chip; name no next command; ask for no rotation; end the turn, because ending the turn is the hand-off.
- [ ] State what a run with no `TUG_DASH_ARC` does: it stops and says the skill is a stage of `/dash` rather than a standalone command. Do not leave a fallback path behind a refusal.
- [ ] Delete the `tugutil session rotate --stage review` invocation and the surrounding non-arc prose, and delete the chip fallback paragraph.
- [ ] In §6 "Hand off", remove the "or, if the rotation was refused…" alternative — there is no rotation to refuse.
- [ ] In "Guardrails", change *"Under an arc, never review and never print a chip"* from a conditional into the unconditional rule, and delete the guardrail bullet that describes naming a model for a stage, which now has no caller.
- [ ] `grep -n "session rotate\|plan-review\`\|chip" tugplug/skills/plan-devise/SKILL.md` returns nothing outside prose that is *about* not printing one.

**Tests:**
- [ ] No new test. The skill is prose consumed by a model; the checkpoint is the grep.

**Checkpoint:**
- [ ] `grep -c "TUG_DASH_ARC" tugplug/skills/plan-devise/SKILL.md` is at least 1 — the arc contract is still stated.
- [ ] `grep -n "tugutil session rotate" tugplug/skills/plan-devise/SKILL.md` prints nothing.

---

#### Step 6: Delete `diag/` {#step-6}

**Depends on:** #step-5

**Commit:** `diag: delete the imposer lab scripts and deck probes`

**References:** [P09] `diag/` deleted, [B02], (#p09-diag-delete)

**Artifacts:**
- `diag/` removed: seven shell scripts (`anim-island.sh`, `imposer-cadence-run.sh`, `imposer-hold-run.sh`, `imposer-lab.sh`, `imposer-q-run.sh`, `imposer-q2-run.sh`, `imposer-walk-run.sh`) and `deck-probes/`'s six JS probes.

**Background for a cold reader:** ad-hoc drivers from the perf campaign, last touched 2026-08-23, referenced by nothing in the justfile or tuglaws. The owner's call this round is that the campaign moved to `just` recipes.

**Tasks:**
- [ ] `grep -rn "diag/" --exclude-dir=.git --exclude-dir=node_modules . | grep -v "^./diag/"` first, and confirm no live consumer. If one turns up, repair it in this commit rather than deleting around it.
- [ ] `git rm -r diag`.

**Tests:**
- [ ] No new test.

**Checkpoint:**
- [ ] `git ls-files diag` prints nothing.
- [ ] `grep -rn "diag/" --exclude-dir=.git --exclude-dir=node_modules . | grep -v "^./dash/"` returns nothing. (`just lint` is Rust-only — clippy plus `cargo fmt --check` — so it cannot speak to a deleted shell script. The grep is the whole proof.)

---

#### Step 7: Retire `dash/SKILL.md`'s pre-conductor review fork {#step-7}

**Depends on:** #step-6

**Commit:** `tugplug(dash): replace the pre-conductor review fork with a pointer`

**References:** [P08] Off-arc path cut, [B03] Retired claims go, [B04], (#p08-plan-devise-arc-only)

**Artifacts:**
- `tugplug/skills/dash/SKILL.md` §5's hand-driven fork replaced by one paragraph.

**Background for a cold reader:** §5 carries the pre-conductor fork verbatim — *"On Opus — the review runs inline … On anything else — stop … print `/tugplug:plan-review` … Never switch the user's model, in either direction, and never schedule a turn on their behalf."* Every sentence of that is contradicted by `tuglaws/conductor.md`, which retires the never-switch guardrail by name and states that a client may name the model for the stage it asks for. The orchestrator was describing a hand-off the delegated skill no longer performs.

**Tasks:**
- [ ] Delete the two-bullet fork and the *"Never switch the user's model…"* paragraph.
- [ ] Replace them with **one paragraph pointing at `plan-devise` §5** rather than restating it. `[B03]` is explicit about why: a second copy of the hand-off is how the first one drifted. The paragraph must not quote §5's contents, so it stays correct across Step 5's rewrite.
- [ ] Keep the surrounding arc prose intact — the section's opening (*"Under an arc, that is a stage rather than a gate"*) and the review-model-is-a-declaration paragraph are both current and correct.
- [ ] `grep -n "On Opus\|Never switch the user's model" tugplug/skills/dash/SKILL.md` returns nothing.

**Tests:**
- [ ] No new test.

**Checkpoint:**
- [ ] `grep -n "plan-devise" tugplug/skills/dash/SKILL.md` matches — the pointer exists.
- [ ] `grep -cn "On Opus" tugplug/skills/dash/SKILL.md` is 0.

---

#### Step 8: Correct the join vocabulary in the project instructions {#step-8}

**Depends on:** #step-7

**Commit:** `docs(claude-md): name the join gesture as the verb, not its retired spelling`

**References:** [B03] Retired spellings stay, retired claims go, [B04], (#context)

**Artifacts:**
- `CLAUDE.md`'s landing-gesture sentence corrected.

**Background for a cold reader:** `CLAUDE.md` names the dash-lane landing gesture `/join <name>`. The code names it `/dash-join`, with `/join` a retired spelling: `tugdeck/src/lib/slash-commands.ts` registers `join` with `deprecatedFor: "dash-join"`, `session-card.tsx` routes it through `runRetiredVerb`, and `tuglaws/slash-commands.md#retire-a-spelling` holds `/join → /dash-join` up as **the exemplar** of the alias rule. The doctrine and the code agree; the project instructions are what drifted. The alias itself is untouched — that is the whole point of `[B03]`.

**Tasks:**
- [ ] In `CLAUDE.md`, change the landing sentence so the dash-lane gesture is `/dash-join <name>`, noting `/join` as its retired spelling in the same breath — the sentence has to teach the split, not just swap a token.
- [ ] Confirm `tugplug/CLAUDE.md` carries no surviving instance: Step 4 deleted the bullet that said *"Backs the Session card's `/join` verb"*. If a `/join`-as-verb sentence remains anywhere in `tugplug/`, correct it here.
- [ ] `grep -rn '`/join`' CLAUDE.md tugplug/ tuglaws/` and confirm every hit describes `/join` as a *retired spelling*, never as the verb.

**Tests:**
- [ ] No new test.

**Checkpoint:**
- [ ] `grep -n "dash-join" CLAUDE.md` matches.
- [ ] `grep -n 'deprecatedFor: "dash-join"' tugdeck/src/lib/slash-commands.ts` still matches — the alias survives the sentence that described it wrongly.

---

#### Step 9: Index-coverage check, and index the fortieth tuglaw {#step-9}

**Depends on:** #step-8

**Commit:** `tests(tuglaws): pin index coverage, and index ledger-reliability`

**References:** [P04] Check lands with its fix, [P05] Check home, Spec S01, [B08], (#s01-index-coverage, #why-permanent-checks)

**Artifacts:**
- `tests/app-test/scripts/tuglaws-index-coverage.test.ts` added.
- `tuglaws/INDEX.md` gains a `ledger-reliability.md` entry.

**Background for a cold reader:** thirty-nine of forty `tuglaws/*.md` are indexed. The fortieth, `ledger-reliability.md`, is cited by `conductor.md` twice and by the index never. There is no existing doc-consistency test in this repository — `tests/app-test/scripts/` is chosen as the home because the justfile's `test-ts` recipe already runs `bun test scripts/`, and its four `select-tests-*.test.ts` files are the precedent for pure-logic tests about the repository itself.

**Tasks:**
- [ ] Write the check per Spec S01. Resolve the repo root with the idiom already used in that directory: `const APP_TEST_DIR = resolve(dirname(import.meta.dir)); const REPO_ROOT = resolve(APP_TEST_DIR, "..", "..");`.
- [ ] Run it against the unfixed tree and confirm it is **red naming exactly `ledger-reliability.md`** ([P04]). Record that output in the round's `summary`. If it names anything else, that is a second unindexed law and it gets indexed in this commit too.
- [ ] Add the `ledger-reliability.md` entry to `tuglaws/INDEX.md`, in the section its subject belongs to, with a one-line description in the file's established style — what the document is the single source of truth for.
- [ ] Re-run green.

**Tests:**
- [ ] `tuglaws-index-coverage.test.ts` — every `tuglaws/*.md` other than `INDEX.md` is linked from `INDEX.md`; the failure message names each missing document.

**Checkpoint:**
- [ ] `cd tests/app-test && bun test scripts/tuglaws-index-coverage.test.ts` is green.
- [ ] The round's `summary` records the red run's output.

---

#### Step 10: Doc-link check, and repair the pointers it names {#step-10}

**Depends on:** #step-9

**Commit:** `tests(docs): pin document-path resolution, and repair four stale comments`

**References:** [P04] Check lands with its fix, [P05] Check home, [P01] Strike dissolved findings, [P11] Broad check over an allowlist, Spec S02, Risk R02, [B04], [B08], (#s02-doc-link, #f03-grows, #r02-link-test-noise, #p11-doc-link-allowlist)

**Artifacts:**
- `tests/app-test/scripts/doc-link-resolution.test.ts` added.
- `tests/app-test/scripts/doc-link-allowlist.txt` added, seeded from the red run (`[P11]`).
- Four CSS comments repaired (`[F03]`).
- One `tuglaws/design-decisions.md` sentence repaired (`[F08]`).

**Background for a cold reader:** read [#f03-grows](#f03-grows) — the brief named three stale CSS comments; there are **four**, and they split into two repairs. Two cite documents that still exist under a renamed prefix (`roadmap/` → `dash/archive/`) and are re-pointed. Two cite documents that exist nowhere and are reduced to what the code does. A comment pointing at a document that does not exist is a comment saying nothing, and `[B04]` forbids replacing one stale backstory with a fresher one.

**Then read [P11], because the red run will not look like the finding.** The check goes red naming **247 citations**, of which these four are four. The other 243 are the identical failure under the `dash/` prefix rather than the `roadmap/` one, and they are **not this step's to repair** — they are seeded into the allowlist and carried as a follow-on. Do not widen this step to chase them, and do not narrow the check to make the red run match the finding.

`[F08]` is repaired by hand in this same commit: `tuglaws/design-decisions.md` `[D143]` ends *"Design spike: `spike-dash-progress` §5."* No such spike exists under `tugdeck/src/spikes/` — it graduated or was deleted, as the spikes README says spikes should be. It is spelled as a bare spike name rather than a `.md` path, so Spec S02's extraction does not see it; say that in the round's summary rather than widening the check to catch one case (Risk R02).

**Tasks:**
- [ ] Write the check per Spec S02, with the scan set and extraction rules exactly as specified — in particular, do not extract bare directory tokens, bare filenames, globs, or `../`-relative paths, or the check will flag `plan-devise`'s correct sentence about `roadmap/` not being a blessed name and some four hundred discussions of the *name* `SKILL.md`.
- [ ] Run it against the unfixed tree with an empty allowlist and confirm it is red naming the four CSS cites of [#f03-grows](#f03-grows) **among 247 citations** ([P04], [P11]). Record the count and the four in the round's `summary`. If the total is far from 247, the extraction rules have drifted from Spec S02 — fix the check, not the number.
- [ ] Seed `tests/app-test/scripts/doc-link-allowlist.txt` from that red run, minus the four this step repairs. Head the file with a comment saying what it is: the doc-pointer debt as of this sweep, a to-do rather than an exemption, owned by the follow-on brief.
- [ ] `tugdeck/styles/focus-ring.css`: re-point `roadmap/tugplan-focus-language.md` → `dash/archive/tugplan-focus-language.md`.
- [ ] `tugdeck/src/components/tugways/tug-pane.css`: re-point `roadmap/jul30-perf-brief.md#i1-sparkline-exception` → `dash/archive/jul30-perf-brief.md#i1-sparkline-exception`.
- [ ] `tugdeck/src/components/tugways/cards/tug-atom-text-body.css`: the `roadmap/dev-atoms.md#d08-tool-block-only` target does not exist under `dash/` or `dash/archive/`. Rewrite the comment to state the line-height rule the code implements, with no pointer.
- [ ] `tugdeck/src/components/tugways/chrome/session-permission-dialog.css`: same treatment — `roadmap/archive/dev-interactive-dialogs.md` does not exist. State what the code does.
- [ ] `tuglaws/design-decisions.md` `[D143]`: replace *"Design spike: `spike-dash-progress` §5."* with either one sentence saying what the spike found, or the words *(spike since deleted)* if the finding is already carried by the decision's own text — which it is, at length. Do not leave a dangling pointer.
- [ ] Re-run the check green.
- [ ] `grep -rn "roadmap/" tugdeck/src tugdeck/styles tugcode/src tuglaws --include='*.css' --include='*.ts' --include='*.tsx' --include='*.md'` returns nothing. **`tugrust/` is deliberately not in that scope**: `tugdash-core`'s `ops.rs` and `replay.rs` carry 91 occurrences of `"roadmap/plan.md"` and `"roadmap/p.md"` inside `#[cfg(test)]`, and they are plan-file *path literals* in dash-worktree fixtures, not citations of a document. They are correct, they are not this sweep's, and a grep that included them could never return nothing.

**Tests:**
- [ ] `doc-link-resolution.test.ts` — every repo-relative `.md` path cited in a source comment or a tuglaw resolves or is on the allowlist, and every allowlist entry is still a real dangle; the failure message names the citing file and the cited path.

**Checkpoint:**
- [ ] `cd tests/app-test && bun test scripts/doc-link-resolution.test.ts` is green.
- [ ] `cd tugdeck && bunx vite build` — the CSS files still parse and bundle.
- [ ] `grep -c . tests/app-test/scripts/doc-link-allowlist.txt` is non-zero, and no line of it names a `roadmap/` path — the four this step repaired must not have been allowlisted instead.
- [ ] The round's `summary` records the red run's count and its four named cites, and notes that `[F08]` was fixed by hand outside the check's reach.

---

#### Step 11: Archive the landed briefs and fold the planning note {#step-11}

**Depends on:** #step-10

**Commit:** `dash: archive the landed briefs and fold the planning note`

**References:** [P10] `dash-notes.md` folded not archived, [B04], [B06], (#p10-dash-notes-fold, #non-goals)

**Artifacts:**
- `conductor-brief.md`, `interruption-brief.md`, `verify-surfaces-brief.md` moved to `dash/archive/`.
- `dash/dash-notes.md` reduced to its open items.

**Background for a cold reader:** each of the three briefs spawned a plan that is now in `dash/archive/`; the briefs are still in the live directory, where `plan search` and the next `/dash` will find them. A brief whose exit has landed is finished paperwork and moves with its plan.

`dash-notes.md` is different, and `[B06]`'s *"archived once nothing in it is still open"* is the reason. Its head carries six genuinely open items — the dash-inflight display during planning, brief formalization, a custom `/dash-arc` display, inconsistent dash atom styling in pills, the yellow dash name, and persisting the join progress indicator in the transcript. Its five numbered sections are all finished: §1 landed as the conductor, §2 as the interruption doctrine, §3 as `tugutil dash verify`, §4 is the abandoned `tugutil` rename, and §5 is this sweep. So the note is folded, not archived.

**Tasks:**
- [ ] `git mv dash/conductor-brief.md dash/interruption-brief.md dash/verify-surfaces-brief.md dash/archive/`.
- [ ] In `dash/dash-notes.md`, delete the five numbered sections, the `## The order, and why` section, the `## Response` / `## Short answer` preamble, and the trailing `/dash` prompt transcript. Keep the open items at the head of the file.
- [ ] Record in the commit body why §4 goes and does not come back: the `tugutil` → `tug` rename was tried and rolled back, because the binary `tug` collides with Tug.app's own `Tug` executable on a case-insensitive APFS volume. That is the durable fact the section was hiding.
- [ ] Repair the citations the move breaks. `dash/archive/interruption.md` names `` `dash/interruption-brief.md` `` three times and `dash/archive/conductor.md` names `` `dash/conductor-brief.md` `` once; after the move those paths are wrong. Re-point them at `dash/archive/`. Note that each of those two files *also* carries a sibling-relative markdown link (`](conductor-brief.md)`, `](verify-surfaces-brief.md)`) that currently dangles and that this move **repairs** — leave those alone.
- [ ] Do **not** touch `tests/app-test/at0477-transcript-copy-atoms.test.ts` or `tugdeck/src/lib/__tests__/atom-text.test.ts`, which both carry the literal `"dash/verify-surfaces-brief.md"`. This devise round read them: in both, the string is a **file-atom's display label** in a synthesized transcript, asserted as clipboard and render text. Neither reads the filesystem, so neither breaks. A grep for the moved names will surface them; this is the note that stops you from "fixing" a passing test.
- [ ] `ls dash/` prints exactly `archive`, `assets`, `dash-notes.md`, `legacy-sweep-brief.md`, `legacy-sweep.md`.

**Tests:**
- [ ] No new test.

**Checkpoint:**
- [ ] `git ls-files dash --  ':!dash/archive' ':!dash/assets'` lists exactly the three surviving markdown files.
- [ ] `grep -rn 'dash/conductor-brief\.md\|dash/interruption-brief\.md\|dash/verify-surfaces-brief\.md' --exclude-dir=.git --exclude-dir=node_modules .` returns only hits under `dash/archive/` that read `dash/archive/…`, plus the two app-test display-label strings and this plan. **This grep, not the doc-link check, is the proof**: Spec S02's scan set excludes `dash/` and `dash/archive/` outright, so `doc-link-resolution.test.ts` cannot see anything this step moves and would stay green whether or not the move dangled a pointer.
- [ ] `cd tugdeck && bun test src/lib/__tests__/atom-text.test.ts` is green — the display-label strings are untouched.

---

#### Step 12: Name the kill/alias split in the doctrine {#step-12}

**Depends on:** #step-11

**Commit:** `tuglaws(dash-work-doctrine): state the kill/alias split for a retirement`

**References:** [B03] Retired spellings stay, retired claims go, [B08] Leave a method behind, (#context, #p07-dash-join-skill-delete)

**Artifacts:**
- One sentence added to `tuglaws/dash-work-doctrine.md`.

**Background for a cold reader:** this is the sweep's one piece of durable doctrine, and it exists because the two rules are easy to confuse. A retired **design** is deleted, apparatus and all. A retired **spelling** is kept as an alias, because an unmatched `/verb` is submitted to claude as a prompt — worse than a rename. `[F04]`, `[F05]`, and Step 4 are all instances of getting the split right; `tuglaws/slash-commands.md#retire-a-spelling` owns the alias half and must not be restated here, only cited.

**Tasks:**
- [ ] Add one sentence to `tuglaws/dash-work-doctrine.md` naming the split as the rule for the next retirement: the design goes whole, the spelling stays as an alias, and the two are told apart by asking whether anything is left that a user could still type.
- [ ] Place it where the document's other cross-cutting rules live — near "No plan numbers in durable artifacts", which is the same kind of rule.
- [ ] Cite `slash-commands.md`'s alias rule by link rather than restating it. One home per rule; a second copy is how the first one drifts. Write it as the tuglaws' own sibling-relative markdown link — `[slash-commands.md](slash-commands.md#retire-a-spelling)` — which is both the house form and the form Spec S02's rule 1 resolves.

**Tests:**
- [ ] No new test.

**Checkpoint:**
- [ ] `cd tests/app-test && bun test scripts/doc-link-resolution.test.ts` is green — the new cross-reference resolves. This checkpoint is load-bearing only because Spec S02's **rule 1** resolves markdown links against the citing document; a check that read repo-relative paths alone would be blind to every sibling-relative tuglaws link, including this one, and would pass without looking.
- [ ] `cd tests/app-test && bun test scripts/tuglaws-index-coverage.test.ts` is green.

---

#### Step 13: Integration Checkpoint {#step-13}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9, #step-10, #step-11, #step-12

**Commit:** `legacy-sweep: integration checkpoint`

**References:** [P04] Check lands with its fix, (#success-criteria, #dependencies)

**Tasks:**
- [ ] `tugutil dash replay legacy-sweep` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: the tree moved, so verify it with `tugutil dash verify legacy-sweep`, run in the warm worktree. A refusal names paths no surface claims and is fixed by declaring a surface for them, not by substituting a command. If the project declares no surfaces, it says so and exits 0 — then verify with this plan's own checkpoint commands over what the replay moved (`bunx tsc --noEmit` and `bun test` in the touched packages, `bunx vite build` if any CSS or `tugdeck/src` path moved, the two new checks under `tests/app-test/scripts/`), never an invented one, and say so.
- [ ] `Current`: the base never moved, so the tree Step 12's checkpoint verified *is* the deliverable, byte for byte. Re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.
- [ ] Whatever the arm, walk [#success-criteria](#success-criteria) once as a prose read — each criterion names the step that established it, and this is a confirmation that the claims are still true on the replayed tree, not a re-run.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A tree with six retired designs deleted whole, eight stale claims saying what is true today, two permanent checks that fail the day a doc claim goes stale, and one doctrine sentence telling a kill from an alias.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tugdeck/src/_archive/` and its two tests are gone; `tsconfig.json` excludes nothing that does not exist (tugdeck suite + `tsc`, Step 1).
- [ ] Fifteen root probes are gone; `probe-case-a.ts` and `probe-case-a-race.ts` remain; `tugcode/probes/` is intact and its fixture-reading test is green (tugcode suite, Step 2).
- [ ] `window.tugSessionPlacement` no longer exists (grep + `vite build`, Step 3).
- [ ] The `dash-join` **skill** is gone from four rosters; the `/dash-join` **verb** and the `/join` alias are untouched (grep assertions, Step 4).
- [ ] `plan-devise` describes one contract, under an arc (grep, Step 5).
- [ ] `diag/` is gone (`git ls-files`, Step 6).
- [ ] `dash/SKILL.md` points at `plan-devise` §5 instead of restating a fork it no longer performs (grep, Step 7).
- [ ] The project instructions name `/dash-join` as the verb and `/join` as its retired spelling (grep, Step 8).
- [ ] Every `tuglaws/*.md` is indexed, pinned by a check observed red first (bun test, Step 9).
- [ ] No source comment or tuglaw under `tugdeck/`, `tugcode/`, or `tuglaws/` contains `roadmap/`, and no cited `.md` path dangles except the ones recorded in `doc-link-allowlist.txt`, pinned by a check observed red first at its true count of 247 (bun test + grep, Step 10).
- [ ] `tests/app-test/scripts/doc-link-allowlist.txt` records the 243 surviving dangles as debt, names no `roadmap/` path, and contains no entry that has since been repaired (Step 10, `[P11]`).
- [ ] `dash/` holds five entries (`git ls-files`, Step 11).
- [ ] The doctrine names the kill/alias split (prose assertion, Step 12).
- [ ] The work holds on the base as it stands (replay + scoped verify, Step 13).

**Acceptance tests:**
- [ ] `tests/app-test/scripts/tuglaws-index-coverage.test.ts` green, and demonstrated red against the pre-fix tree.
- [ ] `tests/app-test/scripts/doc-link-resolution.test.ts` green, and demonstrated red against the pre-fix tree.

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- [ ] The six open items surviving in `dash/dash-notes.md` — dash inflight display during planning, brief formalization, a custom `/dash-arc` display, dash atom styling consistency, the yellow dash name, and persisting the join progress indicator in the transcript.
- [ ] **The 243 doc pointers on `doc-link-allowlist.txt`** — the largest follow-on this sweep creates, and the reason `[P11]` exists. 134 citations across 79 targets re-point mechanically from `dash/<plan>.md` to `dash/archive/<plan>.md`; 113 citations across 26 targets name documents that exist nowhere and need the judgment `[F03]`'s two unresolvable cites needed. `dash/dev-atoms.md`, cited 45 times and existing nowhere, is that brief's first question. The allowlist shrinking to empty is its exit.
- [ ] A dead-export hunt in tugdeck, if it turns out to be a brief at all (`[B08]` declines it here).
- [ ] Reading `tuglaws/list-surface-grammar.md` and `tuglaws/framework-architecture.md` once each on their merits. Both are struck from this sweep as cited and live ([#f07-struck](#f07-struck)); neither has been re-read for accuracy, which is a different question from whether it is dead.

| Checkpoint | Verification |
|------------|--------------|
| Deletions took nothing live | tugdeck + tugcode suites and `tsc` green after each deletion step |
| The join surface survived its skill's deletion | `deprecatedFor: "dash-join"` and the `session-changes-dash-join` component still present (Step 4) |
| The permanent checks can fail | Red output recorded in the rounds for Steps 9 and 10 |
| The tree still bundles | `bunx vite build` after Steps 3 and 10 |
| The work fits the live base | `tugutil dash replay` + scoped verify (Step 13) |
