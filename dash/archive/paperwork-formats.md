<!-- devise-skeleton v5 -->

## Dash Paperwork Formats {#paperwork-formats}

**Purpose:** Give the brief a written format for the first time (`tuglaws/brief-skeleton.md`, deliberately lighter than the plan skeleton and deliberately unlinted), and bring `tuglaws/devise-skeleton.md` back into agreement with `tugutil plan lint` — which currently rejects the skeleton itself — pruning the sections real plans have stopped using and folding in what the last two months of runs taught.

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

**Round 1 — 2026-08-23, opus.** Reviewed `plan:6a94c76eac95a733`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document (first review), against the code and corpus read this session — `tugutil-core/src/plan.rs` in full (`lint()` rule by rule, `REQUIRED_SECTIONS`, `LEDGER_STATUSES`, `BANNED_TEST_SHAPES`, `LABEL_LETTERS`, `classify_label`, `carries_citation`, `cites_line_numbers`, `content_stamp`, `parse()`'s positive detection, `the_real_corpus_carries_no_errors`), `tuglaws/devise-skeleton.md` end to end, `tuglaws/INDEX.md`, `tugplug/skills/plan-devise/SKILL.md`, five briefs read in full for structure, and a section census over the fourteen plans archived this month.
Applied: the review's main work was verification rather than repair, because the plan was authored directly from the code it describes. Every row of the [#linter-contract](#linter-contract) table was checked against `lint()`; the claims backing [P03] were confirmed at the source (`classify_label` returns `None` for `B` and `F`, so a plan citing `[B01]` raises no PL005/PL006/PL007, and `carries_citation` accepts any `[`, so such a citation satisfies PL021). Test-plan sanity — the Test Plan Concepts section named a guard that does not exist (`the_real_capture_corpus`) beside the real one; corrected to `the_real_corpus_carries_no_errors` and made precise about what it actually asserts (no *error* diagnostics, and that every document claiming `{#execution-steps}` parses). The load-bearing empirical claims were each re-run rather than trusted: the skeleton's 3 errors / 5 warnings, its 544 lines, the 36-brief corpus, `ledger-reliability.md` as the one already-unlisted tuglaws document, and the census counts in [#section-census](#section-census).
Tuglaws cross-check: this phase introduces no tugdeck or tugways state, so no State Zone Mapping applies and no `[L01]`–`[L06]` exposure exists; `[L29]` is untouched (no path is persisted or compared). The two governing decisions are `[D149]`, whose ending procedure [P05] preserves while deleting only the `N/A` commit fiction layered on top of it — the plan's Non-goals state this explicitly so the change cannot be read as reopening the verification-at-the-join question — and `[D151]`, whose degradation pattern Step 4 reuses when naming the brief format to a project that lacks it. The shell-edit discipline is honored: every step edits through `Edit`/`Write` or `tugutil file edit`.
Deferred: nothing. Both design questions raised during authoring were settled by the user and are recorded as [P03] and [P05] rather than left open.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Dash paperwork comes in two documents. One has a format contract; the other has never had one.

**The brief has no format at all.** Thirty-six briefs exist in this repository (`dash/dash-hardening-brief.md` plus 35 under `dash/archive/`), and they were each invented from scratch. They do converge — a census of five recent ones (`dash-hardening-brief.md`, `aug01-perf-brief.md`, `join-hardening-brief.md`, `dash-closure-brief.md`, `quit-hardening-brief.md`) shows a real house style nobody wrote down: an `#` H1 title where plans use `##`, a numbered catalogue of findings (`F1`–`F12` in join-hardening, `F1`–`F5` in quit-hardening, an `S`/`I`/`F` series in aug01-perf), a Non-goals section, and a closing section literally named "Open questions for the devise round". Length runs 73–248 lines. Writing that down costs little and stops the next brief from re-deriving it.

The boundary is already enforced by accident and should be kept on purpose: `parse()` in `tugrust/crates/tugutil-core/src/plan.rs` detects a plan **positively**, by the presence of an `{#execution-steps}` section, so `tugutil plan lint dash/dash-hardening-brief.md` exits 2 with *"not a plan document"*. Briefs are outside the linter today and stay outside it here.

**The plan skeleton has drifted from the linter, and the drift runs in both directions.** `tuglaws/devise-skeleton.md` (544 lines, marked `v5`) is declared the mandatory format by `tugplug/skills/plan-devise/SKILL.md`, and its mechanical half is supposed to be `tugutil plan lint`. Running the linter on the skeleton itself:

```
tuglaws/devise-skeleton.md: 3 errors, 5 warnings   (exit 1)
```

Three `PL016` errors, because the template's example Step Status Ledger carries rows for `#step-1` and `#step-2` while the template goes on to show Steps 1 through 5 — the format contract violates the rule it exists to teach. Five `PL004` warnings from the five unanchored `#### 1)`…`#### 5)` headings in the Reference and Anchor Conventions section. A skeleton that cannot pass its own linter is not a contract; it is a suggestion.

The drift also runs the other way — things the linter enforces that the skeleton never says:

- **Which sections are mandatory.** `REQUIRED_SECTIONS` is exactly five anchors — `plan-metadata`, `phase-overview`, `execution-steps`, `step-status-ledger`, `deliverables` (PL001). The skeleton shows perhaps twenty sections and never distinguishes the five that fail a build from the fifteen that do not.
- **The banned test shapes, by name.** PL020 greps a Tests block for four literals: `happy-dom`, `jsdom`, `@testing-library/react`, and `mock-store`/`mock store`. The skeleton gestures at them once ("e.g. mock-store assertion tests, fake-DOM render tests") without naming the list a rule actually matches on.
- **That progress does not stale a plan.** `content_stamp` deliberately excludes the Review Record span, blank lines, thematic breaks, and reduces every ledger row to `| #anchor | title |` while unticking checkboxes — so implementing a plan cannot move its stamp. This is the single most reassuring fact about the review discipline and the skeleton never states it.
- **`--through`, the arming contract.** The word "through" does not appear in the skeleton. Yet closing the step declared by `dash step start <n> --through <m>` is what arms the join arc, which is the difference between a run that finished and a run that stopped early.

And one claim the skeleton makes that practice contradicts: the Integration Checkpoint is told to use `**Commit:** N/A (verification only)` "to signal no separate commit". Five of six recent plans wrote exactly that — and every one of them still recorded a real sha in its ledger row (`dash-generality.md`'s step 9 carries `af6cd361e`), because closing a step writes the ledger edit and that edit is committed as a round. The convention describes a state that never occurs.

**What the plans actually use.** A census of the fourteen plans archived this month (`dash/archive/`: `dash-docs-home`, `dash-generality`, `dash-entry-points`, `dash-join-tail`, `dash+join-workflow-fixes`, `durable-commit-stability`, `join-landing-parity`, `join-narration`, `join-receipt-mechanics`, `join-voice`, `layout-miniature-instrument`, `slot-stack-split-affordances`, `unified-changes`, `z2-mods`) gives the usage table in [#section-census](#section-census). The headline: `{#rollout}` appears in 1 of 14, and `{#new-crates}` in 9 of 251 plans corpus-wide. Everything else earns its place.

#### Strategy {#strategy}

- Write the brief format from the corpus rather than from imagination: the census in [#brief-census](#brief-census) is the source, and the skeleton codifies what good briefs already do.
- Keep the brief unlinted and say so in the document, so the omission reads as a decision rather than an oversight ([P02]).
- Fix the skeleton's disagreement with the linter first, as correctness, and pin it with a test that lints the skeleton on every run — the drift that produced three errors must not be able to recur silently ([P04]).
- Prune second, as editorial judgment, using the census rather than taste — and record what went and why in this plan rather than accreting a changelog in the artifact ([P06]).
- State the four things the linter enforces that the skeleton never said, and delete the one claim practice contradicts.
- Make both formats reachable: a format nobody is pointed at is a format nobody uses.

#### Success Criteria (Measurable) {#success-criteria}

- `tuglaws/brief-skeleton.md` exists, carries every section named in [S01](#s01-brief-skeleton), and `tugutil plan lint tuglaws/brief-skeleton.md` exits 2 with "not a plan document" — the brief is outside the plan linter by construction (Step 1).
- `tugutil plan lint tuglaws/devise-skeleton.md` exits 0 with zero errors and zero warnings, where it reports 3 errors and 5 warnings today (Step 2).
- A Rust test in `tugrust/crates/tugutil-core/src/plan.rs` lints the skeleton and fails on any diagnostic, skipping cleanly when the file is absent so the crate stays testable outside this repository (Step 2).
- The skeleton names the five `REQUIRED_SECTIONS` as the mandatory set, lists PL020's four banned literals verbatim, states that ledger and checkbox progress sit outside the content stamp, and describes the `--through` arming contract (Step 2).
- No occurrence of `N/A (verification only)` remains in the skeleton (Step 2).
- `{#rollout}` and `{#new-crates}` are gone from the skeleton; `grep -c "{#rollout}\|{#new-crates}" tuglaws/devise-skeleton.md` returns 0 (Step 3).
- The Follow-ons section's anchor reads `{#follow-ons}`; `grep -c "{#roadmap}" tuglaws/devise-skeleton.md` returns 0 (Step 3).
- `tuglaws/INDEX.md` lists `brief-skeleton.md`, and `tugplug/skills/plan-devise/SKILL.md` names it as the format for a brief (Step 4).
- Every plan already in the docs directory still lints clean — the skeleton's revision changes no existing document (Steps 2–5, and the standing `the_real_corpus_carries_no_errors` test).

#### Scope {#scope}

1. `tuglaws/brief-skeleton.md`, new, per [S01](#s01-brief-skeleton).
2. `tuglaws/devise-skeleton.md` reconciled with the linter per [S02](#s02-drift-fixes), and made lint-clean.
3. A regression test that lints the skeleton.
4. The skeleton pruned per the census: `{#rollout}` and `{#new-crates}` removed, `{#roadmap}` renamed, optional sections marked optional.
5. `tuglaws/INDEX.md` and the tugplug skills pointed at both formats.

#### Non-goals {#non-goals}

- **No brief linter, and no brief parser.** [P02] states the reasoning; a format that has never been written down has not earned a checker, and `tugutil plan lint` continues to exit 2 on a brief rather than growing a second mode.
- **No rewriting of existing briefs or plans.** Thirty-six briefs and 251 plans stay exactly as they are. The skeleton governs what is written next; a format change is not a migration.
- **No change to `tugutil plan lint`'s rules.** Where the skeleton and the linter disagree, the linter is right by definition (`plan-devise`'s own words: "the linter is what the format actually means"), so every fix in this plan is to the document. The one code change is a test.
- **No change to the plan-review rubric or the stamp mechanism.** `tuglaws/plan-review-rubric.md` and `content_stamp` are described more accurately here, not altered.
- **No new label letters in the plan namespace.** `[B##]` and `[F##]` are the brief's, and `LABEL_LETTERS` stays `P Q S T L R M` — see [P03].

#### Dependencies {#dependencies}

- `tugutil plan lint` and `tugutil plan stamp` as they ship today (`tugrust/crates/tugutil-core/src/plan.rs`); this plan reads their behavior and does not change it.
- The docs directory declaration from the just-landed `docs` work (`[tugtool.dash].docs = "dash"`), which is where both skeletons' output lands.

#### Constraints {#constraints}

- **ONLY THE USER CAN COMMIT TO GIT** on `main`; rounds commit via `tugutil dash commit` on the dash worktree.
- **WARNINGS ARE ERRORS** for Rust (`-D warnings` via `tugrust/.cargo/config.toml`) — the one Rust change here is a test and must build clean.
- No hard-wrapped prose in markdown documents.
- No plan-step identifiers in durable artifacts; the skeleton and the brief skeleton are durable artifacts.
- Editing repo files goes through `Edit`/`Write` or `tugutil file edit` — never a scripting-language heredoc.

#### Assumptions {#assumptions}

- The fourteen-plan census is representative of current practice. It covers every plan authored since the format last changed materially, which is the population the skeleton governs; older plans in `dash/archive/` were written against earlier versions and are deliberately excluded.
- Making the skeleton lint-clean does not require abandoning its instructional headings: `PL004` is satisfied by adding `{#anchor}` to the five numbered headings, which is a one-line-each edit and not a restructuring.

---

### Open Questions {#open-questions}

None. Two design questions were raised and settled with the user during authoring: the brief's citable unit (answered — two label families, `[F01]` findings and `[B01]` decisions, recorded as [P03]) and the Integration Checkpoint's commit convention (answered — state what actually happens, recorded as [P05]).

---

### Risks {#risks}

- **R01 — Making the skeleton lint-clean changes what it teaches.** The `PL016` errors come from an example ledger that does not list every example step. Filling it in is the obvious fix, but it makes the template longer and slightly more tedious to copy. Mitigation: the ledger example is the one place where completeness *is* the lesson (PL016 exists because a step with no row is a step the machinery cannot drive), so the extra rows are the teaching, not noise.
- **R02 — Pruning a section some future plan wanted.** `{#rollout}` is used by 1 plan in 14, but a genuine migration phase would want it. Mitigation: the census measures *skeleton sections*, not the ability to write a section — a plan can always add a heading with an anchor, and the skeleton's Deep Dives section explicitly invites topic sections. Removal from the template is not prohibition, and [P06] says so in the pruning record.
- **R03 — The brief format calcifies early despite the intent.** Writing a format down tends to make it binding even when it says it is not. Mitigation: [P02] puts the provisional status in the document itself, and the skeleton states that a brief may omit any section that has nothing to say — the opposite of the plan skeleton's posture.

---

### Design Decisions {#design-decisions}

- **[P01] The brief is a decision record, not a small plan.** It captures what was observed and what was decided *before* an implementable document exists, and it is explicitly not implementable: no steps, no ledger, no commit boundaries, no checkpoints. The test of a brief is whether a devise round can be run from it, not whether an implementer can work from it. This is why it gets its own skeleton rather than a "lite" mode of the plan skeleton — the two documents answer different questions and share no machinery.
- **[P02] The brief is unlinted, deliberately and visibly.** No parser, no rules, no `tugutil brief lint`. A format with thirty-six instances and zero written specification has not earned a checker; premature linting of an exploratory format calcifies exactly the thing that should stay soft. The boundary already holds for free: `parse()` detects a plan by `{#execution-steps}`, so a brief exits 2 as "not a plan document" and no accidental linting is possible. The brief skeleton says this about itself, so a reader knows the absence is a decision.
- **[P03] The brief carries two label families: `[F01]` findings and `[B01]` decisions.** The corpus enumerates findings (`F1`–`F12`, `F1`–`F5`) far more often than decisions, because a brief's characteristic shape is a catalogue of verified observations; but the whole point of writing decisions down is that a plan can cite them. So both are labelled: `[F01]…` under Evidence for what was observed or measured, `[B01]…` under Decisions for the calls made. Neither collides with the plan namespace — `classify_label` in `plan.rs` maps `D` to the global-decision namespace and every letter in `LABEL_LETTERS` (`P Q S T L R M`) to a plan label, and returns `None` for everything else, so a plan citing `[B01]` or `[F01]` is silently accepted: no `PL005`, no `PL006`, no `PL007`. A `**References:**` line citing `[B01]` also satisfies `PL021`, because `carries_citation` accepts any `[`.
- **[P04] The skeleton is pinned by a test, because prose drift is invisible.** The skeleton disagreeing with the linter is exactly the failure this plan exists to fix, and fixing it once without a guard invites the next drift. A test in `plan.rs` lints `tuglaws/devise-skeleton.md` and fails on any diagnostic — error or warning. It resolves the path from `CARGO_MANIFEST_DIR` and returns cleanly when the file is absent, matching the shape of the existing `the_real_corpus_carries_no_errors` test so the crate remains testable outside this repository.
- **[P05] The Integration Checkpoint takes a real commit message.** `**Commit:** N/A (verification only)` describes a state that never occurs: closing the step with `tugutil dash step <name> done <n>` writes the ledger row, that write dirties the tree, and the round commits it — which is why `dash-generality.md`'s integration step records `af6cd361e` in a ledger row whose step body says `N/A`. The skeleton stops teaching the fiction. The step is still not a second sweep — [D149]'s procedure is unchanged and remains the whole of what the step does.
- **[P06] Pruning is decided by the census, and the record lives in this plan.** Sections are removed on evidence of disuse, not on taste: `{#rollout}` (1/14) and `{#new-crates}` (9/251 corpus-wide) go; `{#documentation-plan}` (5/14) and `{#symbol-inventory}` (7/14) stay but are marked optional, because when they are used they carry real content rather than boilerplate. The record of what went and why is [#pruning-record](#pruning-record) in this document — a durable archived artifact — rather than a changelog comment accreting inside the skeleton, which would grow without bound and is the kind of history a durable artifact should not carry.
- **[P07] The Follow-ons anchor stops being called `#roadmap`.** The section is "Roadmap / Follow-ons {#roadmap}", and it means *future work* — but this repository just migrated `roadmap/` to `dash/` precisely because that word had become a false piece of infrastructure. Leaving an anchor spelled `#roadmap` in the format contract re-teaches the collision. It becomes `{#follow-ons}`. Existing plans keep their own anchors and are untouched; the rename governs what is written next.

---

### Deep Dives {#deep-dives}

#### What the linter actually enforces {#linter-contract}

Read from `lint()` in `tugrust/crates/tugutil-core/src/plan.rs`. This is the authoritative list the revised skeleton must agree with; **Sev** is `E` for error (exit 1) and `W` for warning.

| Rule | Sev | What it checks |
|---|---|---|
| PL001 | E | Each of `REQUIRED_SECTIONS` is declared: `plan-metadata`, `phase-overview`, `execution-steps`, `step-status-ledger`, `deliverables` |
| PL002 | E | Anchor declared twice |
| PL003 | E | Anchor uses characters outside `[a-z0-9-]` |
| PL004 | W | An `###` or `####` heading declares no `{#anchor}` |
| PL005 | E | `[D##]` used as a plan-local label (that namespace is `design-decisions.md`) |
| PL006 | E | A label is declared twice |
| PL007 | W | A label carries other than two digits |
| PL008 | E | A step has no `**Commit:**` line |
| PL009 | E | A step has no `**References:**` line |
| PL010 | E | A step has no Tasks block |
| PL011 | W | A step has no Tests block |
| PL012 | E | A step has no Checkpoint block |
| PL013 | E | `**Depends on:**` names an anchor the plan does not declare |
| PL014 | E | `**Depends on:**` names a step that comes later |
| PL015 | E | The ledger section carries no table rows |
| PL016 | E | A step has no ledger row, or a ledger row names no step (checked both directions) |
| PL017 | E | A ledger status is not one of `pending` / `in progress` / `done` |
| PL018 | W | A ledger row is `done` with no commit recorded |
| PL019 | W | A `**References:**` line cites line numbers |
| PL020 | E | A Tests block names `happy-dom`, `jsdom`, `@testing-library/react`, `mock-store`, or `mock store` |
| PL021 | W | A `**References:**` line carries no citation at all |
| PL022 | W | A step's anchor does not match its number (`#step-N`) |
| PL023 | W | No `{#review-record}` section |
| PL024 | E | No step in the plan carries a Tests block |
| PL025 | W | A review round records no content stamp |
| PL026 | E | A step heading's `Step N:` prefix does not parse as an integer |
| PL027 | E | The plan has execution steps but no Step Status Ledger at all |

Two structural facts sit beside the rules. **Detection is positive**: `parse()` treats a document as a plan only if it declares `{#execution-steps}`, and the CLI exits 2 on anything else — this is what keeps briefs out. And **the content stamp is narrower than the file**: `content_stamp` drops the Review Record span entirely (the stamp lives inside it), drops blank lines and thematic breaks, reduces each ledger row to `| #anchor | title |`, and unticks every checkbox — so ledger status, commit cells, and task ticks are all outside the hash, and a plan cannot go stale by being implemented.

#### The section census {#section-census}

Fourteen plans, archived this month, counted by `grep -l -F "{#anchor}"`:

| Section anchor | Plans | Disposition |
|---|---|---|
| `specification` | 14/14 | keep |
| `risks` | 14/14 | keep |
| `open-questions` | 14/14 | keep |
| `design-decisions` | 14/14 | keep |
| `review-record` | 14/14 | keep |
| `test-plan-concepts` | 14/14 | keep |
| `state-zone-mapping` | 12/14 | keep (conditional on tugdeck work) |
| `test-categories` | 12/14 | keep |
| `test-non-goals` | 12/14 | keep |
| `exit-criteria` | 10/14 | keep |
| `deep-dives` | 9/14 | keep (already optional) |
| `roadmap` | 9/14 | keep, renamed `follow-ons` ([P07]) |
| `symbol-inventory` | 7/14 | keep, marked optional ([P06]) |
| `documentation-plan` | 5/14 | keep, marked optional ([P06]) |
| `rollout` | 1/14 | **remove** ([P06]) |
| `new-crates` | 9/251 corpus-wide | **remove** ([P06]) |

The `**Artifacts:**` block in the step template was measured separately, since it is not an anchored section: six of eight sampled recent plans use it (`join-voice` 7 occurrences, `durable-commit-stability` 8, `unified-changes` 6, `z2-mods` 5, `join-narration` 3, `join-landing-parity` 2). It stays.

#### The pruning record {#pruning-record}

The audit's editorial deliverable, per [P06]. What was removed, and why:

- **`#### Compatibility / Migration / Rollout (Optional) {#rollout}` — removed.** One plan in fourteen. Rollout concerns that do come up are already served: a migration hazard is a Risk, a staged landing is a step sequence, and a compatibility contract is a Spec. The section's presence invited a heading with nothing under it.
- **`#### New crates (if any) {#new-crates}` — removed.** Nine plans in the entire 251-plan corpus, and none this month. A new crate is a notable enough event to describe in prose under `{#new-files}` or in the Strategy; a standing heading for it is a heading that reads "None." in 96% of plans.
- **`**Commit:** N/A (verification only)` — removed** (a convention rather than a section). It described a state that never occurs; see [P05].
- **`{#roadmap}` — renamed to `{#follow-ons}`**, not removed. See [P07].

Marked optional rather than removed: `{#documentation-plan}` and `{#symbol-inventory}`. Both are used by a minority of plans, and both carry real, specific content when used — `join-voice.md`'s documentation plan names four exact documents and what changes in each; `z2-mods.md`'s symbol inventory is a table of functions with kinds and locations. A section that is valuable-when-used and honestly optional should say so rather than be deleted or be implied mandatory.

#### The brief corpus {#brief-census}

Thirty-six briefs exist (`dash/dash-hardening-brief.md` and 35 in `dash/archive/`). Five recent ones were read in full for their structure; the convergent shape, which [S01](#s01-brief-skeleton) codifies:

- An `#` H1 title, where a plan opens at `##`. This is a real and useful signal — the two document kinds look different at a glance and in any table of contents.
- A framing section under various names ("The finding this brief rests on", "Where we stand", "The two promises", "Why now").
- A numbered catalogue of findings, which is the brief's characteristic content: `F1`–`F12` in `join-hardening-brief.md`, `F1`–`F5` in `quit-hardening-brief.md`, an `S`/`I`/`F` series in `aug01-perf-brief.md`. Several carry a bold **(verified)** marker distinguishing what was measured from what is suspected — worth keeping as a convention.
- Non-goals, in the same sense the plan skeleton means.
- A closing "Open questions for the devise round" — the brief's own hand-off, naming what the next document must settle.

What briefs do **not** have, and should not acquire: steps, a ledger, checkpoints, commit boundaries, or a Review Record. No brief in the corpus has any of these.

---

### Specification {#specification}

#### S01 — The brief skeleton {#s01-brief-skeleton}

`tuglaws/brief-skeleton.md`. An H1 title, a one-line purpose, then six sections. Every section may be omitted when it has nothing to say — the brief skeleton's posture is permissive where the plan skeleton's is mandatory, and it says so.

| Section | Anchor | Content |
|---|---|---|
| Purpose | `{#purpose}` | The problem in the user's words. What is wrong, or what is wanted, before any solution is proposed. |
| Evidence | `{#evidence}` | What was observed or measured. Labelled findings `[F01]…`, each stating what was seen and how; a finding confirmed by measurement or a reproduction carries **(verified)**, and one that is inference says so. |
| Decisions | `{#decisions}` | The calls this brief makes, labelled `[B01]…` so a plan's `**References:**` line can cite them. A decision states what was chosen and the argument for it. |
| Open Questions | `{#open-questions}` | What the devise round must settle. A question here is a question genuinely still open, not one nobody asked. |
| Non-goals | `{#non-goals}` | What this work is explicitly not, including approaches considered and rejected, so they are not re-proposed. |
| Exit | `{#exit}` | What the brief expects to spawn: a plan, a design spike, a wontfix — and for a plan, what its first steps look like. |

The document also carries, as prose rather than as rules: that a brief is not implementable and carries no steps or ledger ([P01]); that it is deliberately unlinted and why ([P02]); and that `tugutil plan lint` exits 2 on it by construction, which is the mechanism keeping it that way.

The version marker is `<!-- brief-skeleton v1 -->`, matching the devise skeleton's convention.

#### S02 — The devise-skeleton reconciliation {#s02-drift-fixes}

Every change to `tuglaws/devise-skeleton.md`, and the authority for each.

**Lint-clean (the skeleton must pass its own contract):**

| Diagnostic | Count | Fix |
|---|---|---|
| PL016 | 3 | The example Step Status Ledger gains rows for `#step-3`, `#step-4`, `#step-5`, so the template's ledger names every step the template shows |
| PL004 | 5 | The five `#### 1)`…`#### 5)` headings in `{#reference-conventions}` gain explicit anchors |

**Say what the linter enforces (four additions):**

1. The five `REQUIRED_SECTIONS` are named as the mandatory set, distinguished from every other section in the template.
2. PL020's banned literals are listed verbatim — `happy-dom`, `jsdom`, `@testing-library/react`, `mock-store` / `mock store` — rather than gestured at.
3. The content stamp's exclusions are stated: Review Record, blank lines, thematic breaks, ledger status and commit cells, checkbox ticks. Therefore **implementing a plan never stales its review.**
4. The `--through` arming contract is stated: `dash step start <n> --through <m>` declares where the run ends, and closing step `m` is what arms the join arc.

**Delete the claim practice contradicts:** `**Commit:** N/A (verification only)` is removed from the Integration Checkpoint pattern; the step takes an ordinary commit message ([P05]). The [D149] procedure the step performs is unchanged.

**Bump the version marker** from `v5` to `v6`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust unit test** (`tugrust/crates/tugutil-core/src/plan.rs`, `mod tests`): lint `tuglaws/devise-skeleton.md` and assert zero diagnostics of any severity. Resolves the path from `CARGO_MANIFEST_DIR` and returns early when the file is absent, mirroring `the_real_corpus_carries_no_errors` so the crate stays testable outside this repository. This is the guard [P04] asks for.
- **CLI assertions** run as step checkpoints: `tugutil plan lint tuglaws/devise-skeleton.md` exits 0; `tugutil plan lint tuglaws/brief-skeleton.md` exits 2.
- **Corpus regression**: the existing `the_real_corpus_carries_no_errors` test in `plan.rs` already lints every document in the declared docs directory — it asserts no *error* diagnostics and that every document claiming `{#execution-steps}` parses — and must stay green, proving the skeleton's revision broke no existing plan.
- **Prose assertions**: the greps named in [#success-criteria](#success-criteria).

#### What stays out of tests {#test-non-goals}

- No test parses `brief-skeleton.md` or asserts anything about its structure — [P02] makes the brief unlinted, and a test would be a linter with extra steps.
- No fake-DOM, RTL, or mock-store tests anywhere in this plan; nothing here touches tugdeck.
- No app-test: this phase changes documentation and adds one Rust unit test. No surface has a face.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The brief has a written format | done | `e47fb1620` |
| #step-2 | The skeleton matches its linter | done | `e8c656429` |
| #step-3 | The skeleton is pruned to what plans use | done | `5ba84734c` |
| #step-4 | Both formats are reachable | done | `49bb91010` |
| #step-5 | Integration checkpoint | done | `3a471fc2d` |

#### Step 1: The brief has a written format {#step-1}

**Commit:** `tugdash(paperwork-formats): write the brief skeleton`

**References:** [P01] the brief is a decision record, [P02] deliberately unlinted, [P03] two label families, [S01](#s01-brief-skeleton), (#brief-census)

**Artifacts:**
- `tuglaws/brief-skeleton.md` (new)

**Tasks:**
- [ ] Write `tuglaws/brief-skeleton.md` per [S01](#s01-brief-skeleton): `<!-- brief-skeleton v1 -->`, an `#` H1 title line, a one-line purpose, and the six sections with their anchors.
- [ ] State in the document that a brief is not implementable — no steps, no ledger, no checkpoints, no Review Record ([P01]) — and that any section may be omitted when it has nothing to say.
- [ ] State that the format is deliberately unlinted, that `tugutil plan lint` exits 2 on a brief because plan detection is positive on `{#execution-steps}`, and that this is the mechanism rather than a convention ([P02]).
- [ ] Specify the two label families: `[F01]…` findings under Evidence with the **(verified)** convention, `[B01]…` decisions under Decisions ([P03]). Note that a plan may cite either, and that neither collides with the plan namespace.
- [ ] Write the section bodies as guidance-plus-example in the devise skeleton's voice, not as bare headings.

**Tests:**
- [ ] `tugutil plan lint tuglaws/brief-skeleton.md` exits 2 ("not a plan document") — the brief is outside the plan linter by construction.

**Checkpoint:**
- [ ] `tugutil plan lint tuglaws/brief-skeleton.md`; exit status is 2 and the message reads "not a plan document".
- [ ] The file contains all six anchors from [S01](#s01-brief-skeleton): `grep -c "{#purpose}\|{#evidence}\|{#decisions}\|{#open-questions}\|{#non-goals}\|{#exit}"` returns 6.

#### Step 2: The skeleton matches its linter {#step-2}

**Commit:** `tugdash(paperwork-formats): reconcile the plan skeleton with the linter`

**References:** [P04] pinned by a test, [P05] the checkpoint commits, [S02](#s02-drift-fixes), (#linter-contract)

**Artifacts:**
- `tuglaws/devise-skeleton.md` (revised)
- `tugrust/crates/tugutil-core/src/plan.rs` (one new test)

**Tasks:**
- [ ] Fix the three `PL016` errors: add `#step-3`, `#step-4`, `#step-5` rows to the template's example Step Status Ledger so it names every step the template shows.
- [ ] Fix the five `PL004` warnings: give the `#### 1)` through `#### 5)` headings in `{#reference-conventions}` explicit kebab-case anchors.
- [ ] Add the four missing statements per [S02](#s02-drift-fixes): the five required sections named as the mandatory set; PL020's four banned literals listed verbatim; the content stamp's exclusions with the consequence stated plainly (implementing a plan never stales its review); the `--through` arming contract.
- [ ] Remove `**Commit:** N/A (verification only)` from the Integration Checkpoint pattern and give the step an ordinary commit message, leaving [D149]'s procedure otherwise unchanged ([P05]).
- [ ] Add the Rust test per [P04]: lint `tuglaws/devise-skeleton.md`, assert zero diagnostics at any severity, resolve from `CARGO_MANIFEST_DIR`, return early when the file is absent.

**Tests:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core` — the new skeleton-lint test passes, and every existing plan test stays green.

**Checkpoint:**
- [ ] `tugutil plan lint tuglaws/devise-skeleton.md` reports 0 errors, 0 warnings and exits 0 (it reports 3 errors, 5 warnings before this step).
- [ ] `cd tugrust && cargo nextest run -p tugutil-core` passes with no warnings.
- [ ] `grep -c "N/A (verification only)" tuglaws/devise-skeleton.md` returns 0.

#### Step 3: The skeleton is pruned to what plans use {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(paperwork-formats): prune the skeleton to what plans use`

**References:** [P06] the census decides, [P07] the follow-ons anchor, (#section-census), (#pruning-record)

**Artifacts:**
- `tuglaws/devise-skeleton.md` (revised further)

**Tasks:**
- [ ] Remove `#### Compatibility / Migration / Rollout (Optional) {#rollout}` and its body ([P06]).
- [ ] Remove `#### New crates (if any) {#new-crates}` and its body ([P06]).
- [ ] Rename `#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}` to use the anchor `{#follow-ons}`, keeping the section ([P07]).
- [ ] Mark `{#documentation-plan}` and `{#symbol-inventory}` optional in their headings, in the same style the skeleton already uses for Deep Dives ("(Optional)").
- [ ] Bump the version marker from `<!-- devise-skeleton v5 -->` to `<!-- devise-skeleton v6 -->`.
- [ ] Do **not** add a changelog to the skeleton; the record is [#pruning-record](#pruning-record) in this plan ([P06]).

**Tests:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core` — the skeleton-lint test from [#step-2](#step-2) still passes after the pruning.

**Checkpoint:**
- [ ] `grep -c "{#rollout}\|{#new-crates}\|{#roadmap}" tuglaws/devise-skeleton.md` returns 0.
- [ ] `grep -c "{#follow-ons}" tuglaws/devise-skeleton.md` returns 1.
- [ ] `tugutil plan lint tuglaws/devise-skeleton.md` still exits 0 with no diagnostics.
- [ ] `head -1 tuglaws/devise-skeleton.md` reads `<!-- devise-skeleton v6 -->`.

#### Step 4: Both formats are reachable {#step-4}

**Depends on:** #step-1

**Commit:** `tugdash(paperwork-formats): point the index and the skills at both formats`

**References:** [P01] two document kinds, [P02] unlinted by decision, (#brief-census)

**Artifacts:**
- `tuglaws/INDEX.md` (one entry added)
- `tugplug/skills/plan-devise/SKILL.md` (brief format named)

**Tasks:**
- [ ] Add a `brief-skeleton.md` entry to `tuglaws/INDEX.md`, beside the existing `devise-skeleton.md` entry, in the file's one-line-description voice. The existing entry reads "Template for plan documents … Kept here per user decision; it is a template, not a tuglaws law or architecture doc" — match that framing and say the brief is unlinted by decision.
- [ ] In `tugplug/skills/plan-devise/SKILL.md`, name `tuglaws/brief-skeleton.md` as the format when the work being written up is a brief rather than a plan, with the same absent-project degradation the skill already states for the devise skeleton ([D151]'s pattern: proceed at a named lower fidelity and say so).
- [ ] Verify no other skill needs the reference: `dash-implement`, `plan-review`, and `dash-audit` all consume plans by explicit path and never author a brief.

**Tests:**
- [ ] Prose assertions — the greps in the Checkpoint below.

**Checkpoint:**
- [ ] `grep -c "brief-skeleton.md" tuglaws/INDEX.md` returns at least 1.
- [ ] `grep -c "brief-skeleton" tugplug/skills/plan-devise/SKILL.md` returns at least 1.
- [ ] Every `tuglaws/*.md` except `INDEX.md` and the known-unlisted `ledger-reliability.md` appears in `INDEX.md`, so the new document did not become the third unlisted one.

#### Step 5: Integration checkpoint {#step-5}

**Depends on:** #step-1, #step-2, #step-3, #step-4

**Commit:** `tugdash(paperwork-formats): integration checkpoint`

**References:** (#success-criteria), [D149]'s ending procedure

**Tasks:**
- [ ] `cd tugrust && cargo nextest run` — the full Rust suite, including the new skeleton-lint test and the standing live-corpus test that lints every plan in the declared docs directory.
- [ ] `tugutil plan lint` over the skeleton (exit 0) and the brief skeleton (exit 2).
- [ ] Re-run every grep in [#success-criteria](#success-criteria) and record the results in the round summary.
- [ ] Verify the fit per [D149]: `tugutil dash replay <name>`, then the project's declared verify command **only** if the replay reports `Replayed` or `Recorded`; `Current` re-runs nothing.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` — the whole workspace green.

**Checkpoint:**
- [ ] The full Rust suite passes with no warnings.
- [ ] Every Success Criteria assertion holds, recorded in the round summary.

---

### Deliverables and Checkpoints {#deliverables}

- `tuglaws/brief-skeleton.md` — the brief's first written format: six sections, two label families, unlinted by decision.
- `tuglaws/devise-skeleton.md` at `v6` — lint-clean against its own contract, stating the four things the linter enforced silently, with the `N/A` commit fiction deleted and the census's dead sections pruned.
- A Rust test that lints the skeleton, so the drift this phase repaired cannot recur unseen.
- `tuglaws/INDEX.md` and `plan-devise` pointing at both formats.
- [#pruning-record](#pruning-record) — the audit's written record of what was removed and why.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- A brief author has a document to write against, and it tells them the format is provisional.
- `tugutil plan lint tuglaws/devise-skeleton.md` exits 0, and a test keeps it that way.
- Nothing the skeleton claims is contradicted by the linter or by what runs actually do.
- No existing plan or brief was rewritten.

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- A `tugutil brief lint`, if and only if several briefs written against the new skeleton show the format has stabilized — [P02] is explicit that this is not now.
- Teaching the `/dash` orchestrator (a later phase) to decide brief-or-plan and to write against these two skeletons.
- A census of the *plan-review rubric*'s axes against what reviews actually apply, which is the same kind of drift audit one level up.
