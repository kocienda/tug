## Dash Integration Phase 3 — Lifecycle codification (CLI + skills) {#dash-integration-3-codification}

**Purpose:** The workflow the dash skills improvise in prose becomes `tugutil dash` verbs — `dash step start|done` drives the plan's Step Status Ledger, `dash mark built|audited` declares the stages git cannot see, and status/feed derive `implementing (i/N)` from the record — while the skill roster takes its ratified `dash-*` names and sheds its duplicated doctrine text. Implements phase 3 of [dash-integration-plan.md](dash-integration-plan.md#phase-3).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (runs as a dash) |
| Program plan | [dash-integration-plan.md](dash-integration-plan.md#phase-3) |
| Last updated | 2026-08-14 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-14, fable.** Lint: 0 errors, 1 warning (this section discharges it). Applied: sequencing — Step 4 depended only on #step-2 but its `status_in` work reads `dash_plan_path`, which #step-3 introduces; the dependency now names both. Holes — the transition rule made `start` refuse an `in progress` row, so a run interrupted mid-step could not resume without a hand-edit; `start` is now idempotent on `in progress` ([P04], with the byte-identical round-trip pinned in Step 1's tests), and Step 7's `dash-implement` rewrite states the corrected resume rule (first row not `done`, replacing the old prose's first-`pending` rule, which would skip an interrupted step). Verified against the real code rather than taken from the plan: `find_repo_root` resolves the base repo root from inside a linked worktree (`tugutil-core/src/worktree.rs`, `--git-common-dir`), so the verbs' cwd-independence constraint is inherited, not new work; `git branch -D` removes the branch's whole config section (per the `dash_owner_key` teardown warning in `tugdash-core/src/ops.rs`), so [P08]'s cleanup-for-free claim holds; ledger commit cells in the shipped 2.1 plan are backticked shas, matching [P04]; `tugcode/src/capabilities.ts` discovers skills by walking `skills/*/SKILL.md` frontmatter, so the rename needs no allowlist edit — the Assumptions hedge was firmed into a citation. Tuglaws cross-check: the phase adds no frontend state (State Zone Mapping omitted with rationale in the Specification); the one tugdeck edit is a submission constant, implicating no law; the Rust-side derivation honors the [P06] derive-don't-record program decision. Deferred: nothing — [Q01]–[Q03] were resolved in-plan and no new question was raised.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Phases 1 and 2 built the substrate: dashes have a creation identity and session bindings (phase 1), and they are visible in the Changes lane, the card chrome, and the Lens (phase 2). Phase 2.1 built the plan machinery this phase inherits: `tugutil-core::plan` parses the devise skeleton — including the Step Status Ledger's strict grammar — and `tugutil plan lint` runs over it.

But the lifecycle itself is still prose. The `implement` skill tells the model to hand-edit the ledger table, keep a task list in lockstep, and remember that "task, ledger, and commit move together"; `dash status` and the CHANGESET_ALL feed carry `step_current`/`step_total` slots that are hardwired to `None` (`tugdash-core/src/ops.rs` `status_in`, `tugcast/src/feeds/changeset.rs` `dash_entries`); the `built` and `audited` stages in the program plan's state model exist nowhere; and the `dash` and `implement` skills carry ~70% duplicated doctrine text that drifts every time one is edited. Program decision [P04] rules that the triple bookkeeping collapses to a verb; [P06] rules that stages are declared only where git cannot derive them; [P05] rules the `dash-*` naming. This phase implements all three.

The UI is already waiting: `tugdeck/src/components/lens/sections/dashes-section.tsx` and `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx` both render `step ${entry.step_current}/${entry.step_total}` whenever the fields are present, and both render the `stage` string verbatim. Populating the Rust side lights the whole surface up with zero frontend work.

#### Strategy {#strategy}

- **Bottom-up, additive, verifiable at each layer:** ledger-edit primitive first (pure function in `tugutil-core::plan`), then the dash-log declaration grammar (pure-ish in `tugdash-core`), then the CLI verbs over both, then the derivation into `dash status` and the feed, then the doctrine/skill rewrites that consume the verbs.
- **One grammar, two consumers ([P04]):** `dash step` edits the ledger through the *same parse* `plan lint` checks, so a plan that lints is a plan the verbs can drive, and a plan the verbs refuse is telling the author to fix the document, not the tool.
- **Readers derive from the dash-log, not from re-parsing markdown:** the feed recomputes on every changeset snapshot; it must not read and parse a plan file per dash per recompute. The verbs write both records in one gesture, so the append-only log is trustworthy for derivation and the ledger stays the durable human-readable record.
- **Refuse, never fuzzy-match:** every verb that edits a plan exits 1 with a precise diagnostic when the document does not strictly parse; the skill's documented fallback is hand-editing (program plan risk table, "Ledger-table editing by `dash step` mangles a hand-edited plan").
- **Skills shrink to policy:** the rewritten skills say *when* to call the verbs and *what judgment* to apply; the mechanics (which file, which table row, which log line) live in the verbs. The shared worktree doctrine is factored into one citable tuglaws document.
- **Renames land last**, after the verbs exist, so the rewritten skill text references machinery that is already real.

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil dash step start <n>` flips exactly one ledger row `pending` → `in progress`, appends one dash-log line, and changes no other byte of the plan (byte-diff assertion in tests).
- `tugutil dash step done <n>` flips the row to `done`, records the commit sha in the ledger row, and appends one dash-log line.
- Both verbs exit 1 without touching the file on: not-a-plan, missing ledger, unknown step anchor, invalid transition, unparseable row (unit tests per refusal).
- `tugutil dash status <name> --json` reports `stage: "implementing"`, `step_current`, `step_total`, and `plan_path` for a stepped dash; `built`/`audited` after the corresponding `dash mark` (integration test in `tugdash-core`).
- The Lens Dashes section and the Changes dash lane display `step i/N` and the declared stage for a live stepped dash with no tugdeck code changes beyond the `/join` submission rename (verified via `just app-test-changed`).
- A dash name reused after a `joined`/`released` terminal line derives no stage or step data from the previous generation's log lines (unit test).
- `tugplug/skills/` contains `dash-implement`, `dash-run`, `dash-join`, `dash-audit` as real skills and `implement`, `dash`, `join`, `audit` as one-release redirect stubs; the Session card's `/join` gesture submits `/tugplug:dash-join`.
- The rewritten `dash-run` and `dash-implement` skills contain no duplicated doctrine block — each cites `tuglaws/dash-work-doctrine.md` (grep for the previously duplicated sentences finds them in exactly one file).
- Standard bar: `cargo nextest run`, `bun test`, `bunx vite build`, `just app-test-changed` all green.

#### Scope {#scope}

1. `tugutil-core::plan`: a strict single-row ledger edit primitive.
2. `tugdash-core`: dash-log declaration grammar (writer + reader with terminal-line reset), stage derivation extension, plan-path association.
3. `tugutil` CLI: `dash step <name> start|done`, `dash mark <name> built|audited`; `dash status` gains `plan_path` and populated `step_current`/`step_total`.
4. `tugcast` feed: `dash_entries` populates `stage`, `step_current`, `step_total` from the shared derivation.
5. `tuglaws/dash-work-doctrine.md`: the factored worktree-work doctrine.
6. Skill renames + rewrites per [P05]/[P07]: `dash-implement`, `dash-run`, `dash-join`, `dash-audit`; alias stubs; hand-off strings in `devise` and `review-plan`; the card's `/join` submission; `tugplug/CLAUDE.md` and repo `CLAUDE.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No join mode, no landing surface changes — that is phase 4. `dash-join` is rewritten (fallback branch retired, name changed) but its landing mechanics are untouched.
- No new UI. The Lens and Changes surfaces light up from the feed fields they already render; the only tugdeck edit is the `/join` submission string and any tests that pin it.
- No dash database, no new persistence ([P06] — the dash-log and the plan document are the records).
- No deletion of the `vet` stub or the new alias stubs — dropping one-release aliases is phase 5.
- No relitigating the ratified names ([P05] is closed; `audit`→`dash-audit` included).
- Memory-index renaming (the `project_*`/`feedback_*` memory files that name old skill spellings) is conversational bookkeeping for the session that lands this, not plan work.

#### Dependencies / Prerequisites {#dependencies}

- Phase 1 (dash id, `dash status`, bindings) — shipped `a4477d50b`.
- Phase 2 (dash lane, Lens section, `/dash` gesture) — shipped `b53bdd718`.
- Phase 2.1 (`tugutil-core::plan` parser + `plan lint`, `review-plan` skill, `vet` deleted) — shipped `eb5953baa` plus the audit fixup round; this phase rewrites one merged plan-skill roster, which is exactly why 2.1 was sequenced first.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace (`-D warnings`).
- The changeset feed recompute path (`dash_detail_entries_in` → `dash_entries`) is called on every snapshot; the derivation added there may read the dash-log file once per repo per recompute but must not read or parse plan markdown.
- Skills execute from the app bundle (`Tug.app/Contents/Resources/tugplug/`), not the repo — live-testing a rewritten skill requires a rebuild (`just app-debug` on the dash worktree) or a manual copy into the bundle.
- `tugutil dash` verbs must work when invoked from either the base checkout or inside the dash worktree (the skills' Bash cwd is not reliable); every path the verbs touch is resolved from the repo root and the dash's worktree path, never from cwd.
- No plan-step numbers in durable artifacts: the dash-log `instruction` field and the plan ledger are bookkeeping and may say "Step N"; code, comments, and commit messages may not.

#### Assumptions {#assumptions}

- The devise-skeleton ledger grammar is stable for this phase; `LEDGER_STATUSES = ["pending", "in progress", "done"]` is the complete vocabulary (`tugutil-core/src/plan.rs`).
- Step anchors follow the `step-N` convention (PL022 warns otherwise); `dash step` may refuse plans whose step anchors do not.
- The `tugcode` skill inventory is discovered dynamically — `tugcode/src/capabilities.ts` walks the plugin's `skills/` directories and reads each `SKILL.md`'s frontmatter — so renamed skill directories appear without an allowlist edit.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where does the shared skill doctrine live? (DECIDED — see [P05]) {#q01-doctrine-home}

**Question:** The ~70% duplicated text between `dash` and `implement` (worktree discipline, verification bar, test discipline, law discipline) needs one home both skills cite. `tugplug/` beside the skills, or `tuglaws/`?

**Why it matters:** A file inside `tugplug/skills/` risks being mistaken for a skill by the plugin loader; a file elsewhere in `tugplug/` ships in the bundle but is invisible to the durable-doc surface.

**Resolution:** DECIDED (see [P05]) — `tuglaws/dash-work-doctrine.md`, following the exact precedent of `tuglaws/plan-review-rubric.md` from phase 2.1: doctrine a skill applies belongs on the curated durable surface, cited by repo-relative path.

#### [Q02] Does the plain-dash lane get a `dash draft` convenience verb? (DECIDED — see [P06]) {#q02-dash-draft-verb}

**Question:** The program plan offers two mechanisms for draft symmetry: "via `dash-run` skill text or a `dash draft` convenience".

**Why it matters:** A wrapper verb that only re-spells `tugutil draft set --owner dash:<name>` is a second name for one action, and this repo deletes unread registries rather than maintaining them.

**Resolution:** DECIDED (see [P06]) — skill text only. `tugutil draft set --owner dash:<name>` already exists, is already what `implement` uses, and needs no wrapper.

#### [Q03] What does `dash-join` do when no draft exists, once its compose-fallback is retired? (DECIDED — see [P07]) {#q03-join-no-draft}

**Question:** Today `join`'s "No draft →" branch composes a message from the dash's rounds and writes the draft itself. The program plan retires that branch. What replaces it?

**Why it matters:** A dash worked outside the lane (hand-driven, or from before this phase) can still reach `/join` draftless; the gesture must fail usefully, not land the bare dash description.

**Resolution:** DECIDED (see [P07]) — stop and instruct. Message authorship belongs to the working skill that has the rounds' context, not to the landing gesture.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `dash step` mangles a hand-edited plan | med | low | strict parse; single-line byte-preserving rewrite; refuse (exit 1) on anything unparseable; skill falls back to hand-editing (Risk R01) | any report of a corrupted plan file |
| Reused dash name inherits a dead dash's log declarations | med | med | terminal-line reset in the log reader ([P02]); unit test pins it | a fresh dash showing `audited` at creation |
| Feed recompute slows on the dash-log read | low | low | one file read per repo per recompute, parsed line-by-line; the log is small and append-only | changeset snapshot latency regressions |
| Renaming `join` breaks the card's `/join` gesture | high | med | the submission string and the skill rename land in the same commit; `just app-test-changed` derives the covering test | `/join` producing a redirect chip instead of a landing |
| Rewritten skills reference verbs that behave differently than the prose claims | med | low | verbs land (steps 1–5) before skills are rewritten (step 7); skill text quotes real invocations | skill runs failing on verb syntax |
| Alias stubs answer with a stale roster for one release | low | high (by design) | vet-precedent stubs print the exact replacement command as a clickable chip; phase 5 deletes them | user confusion reports |

**Risk R01: `dash step` edits a plan it misreads** {#r01-ledger-mangle}

- **Risk:** A strict-looking edit that matched the wrong row, or rewrote more than one line, silently corrupts the plan document — the durable record of the run.
- **Mitigation:** The edit primitive re-parses its own output and refuses to return a result whose ledger does not round-trip ([P04]); the row is located by parsed line number, and only that line is replaced; every refusal path is a unit test.
- **Residual risk:** A plan hand-edited *between* `start` and `done` can legitimately change the row's line number; the primitive re-parses at each call, so this is only a risk if the anchor itself was renamed — which is a refusal, not a mismatch.

---

### Design Decisions {#design-decisions}

#### [P01] Readers derive step and stage from the dash-log; the ledger stays the durable record (DECIDED) {#p01-log-derivation}

**Decision:** `dash status` and the changeset feed derive `implementing (i/N)`, `built`, and `audited` from structured dash-log lines. They never read or parse the plan document. The plan's Step Status Ledger remains the durable, human-readable record; the verbs write both in one gesture, which is what makes the log trustworthy for derivation.

**Rationale:**
- The feed path (`dash_detail_entries_in`) runs on every changeset recompute; a markdown parse per dash per recompute is the wrong cost in the wrong place.
- Ledger and log cannot drift because no code path writes one without the other — that is the whole point of [P04] in the program plan.
- The dash-log already carries the lifecycle's terminal declarations (`joined`, `released`); extending its marker vocabulary is the smallest possible mechanism.

**Implications:**
- The log reader must handle name reuse across dash generations ([P02]).
- `derive_stage` grows a declared-stage input but stays a pure function of its arguments.

#### [P02] Declaration log-line grammar, with terminal reset (DECIDED) {#p02-log-grammar}

**Decision:** Declarations use the existing four-field line format (`<iso8601>  <dash>  <marker>  <note>`) with four new markers: `step-start` and `step-done` (note begins `i/N`, followed by the step title or commit sha), `built`, and `audited` (note free-form, may be empty). The reader scans the log for lines whose dash field matches, discards everything at or before the **last terminal line** for that dash (marker `released`, or note `joined`), and takes the latest surviving declaration.

**Rationale:**
- One log, one line shape — `append_dash_log` in `tugdash-core/src/dash.rs` is reused unmodified.
- The log is append-only across dash generations; without the terminal reset, a reused name would be born `audited`.
- "Latest declaration wins" makes re-entry natural: a `step-start` after `built` (a follow-up step range) correctly demotes the dash back to `implementing`.

**Implications:**
- The join path writes `append_dash_log(root, name, &short_sha, "joined")` (marker = sha, note = `joined`) and release writes marker `released` — the reader must treat **both** spellings as terminal, exactly as they are written today (`tugdash-core/src/ops.rs`, the join teardown and `release_in`).
- `i/N` is parsed from the first whitespace-delimited token of the note; an unparseable note is skipped, never guessed at.

#### [P03] Stage precedence: landing > last-declared > draft-ready > working > created (DECIDED) {#p03-stage-precedence}

**Decision:** `derive_stage` keeps its current derived chain and inserts declarations between `landing` and `draft-ready`: an in-flight landing outranks everything; otherwise the latest declared stage (`implementing`, `built`, `audited`) wins; only a dash with no declarations falls through to the current `draft-ready`/`working`/`created` logic.

**Rationale:**
- `implement` writes the join draft at build-stop, *before* audit — if `draft-ready` outranked declarations, `audited` could never be displayed on a planned dash.
- A plain `dash-run` dash makes no declarations, so its stage readout is byte-identical to today — the extension is invisible where it isn't used.
- Log order resolves succession without timestamps on the draft row: the last thing declared is the truest current answer.

**Implications:**
- `stage` stays a plain word (`"implementing"`, not `"implementing (3/9)"`); `step_current`/`step_total` travel in their existing dedicated fields and displays compose the parenthetical, as `dashes-section.tsx` and `session-changes-dash-lane.tsx` already do.
- `derive_stage`'s signature changes; its two call sites (`status_in`, `dash_detail_entries_in`) update together.

#### [P04] The ledger edit is a strict, byte-preserving, single-row rewrite that round-trips (DECIDED) {#p04-strict-edit}

**Decision:** The edit primitive lives in `tugutil-core::plan` beside the parse. It parses the document, locates the ledger row by step anchor via the parsed `LedgerRow.line`, rewrites exactly that one line (status cell, and commit cell on `done`), re-parses its own output, and returns an error — leaving the file untouched — if the document is not a plan, has no ledger, lacks the row, or fails to round-trip.

**Rationale:**
- One grammar, two consumers: the same parse `plan lint` trusts is the only thing allowed to find the row (`read_ledger_row` in `tugutil-core/src/plan.rs`).
- The program plan's risk table demands refuse-over-fuzzy-match; a re-parse of the output is the cheapest possible proof the edit did what it claimed.
- Living in `tugutil-core` keeps `tugdash-core`'s existing dependency direction (it already depends on `tugutil-core`) — no new crate, no inversion.

**Implications:**
- The commit cell is written backticked (`` `a4477d5` ``) to match the house ledger style; `read_ledger_row` already trims backticks on the way back in.
- Transitions are strict where strictness protects the record and lenient where the workflow needs re-entry: `start` accepts `pending` and — idempotently — `in progress`, because an interrupted run leaves its row `in progress` and the resume must be able to re-enter it without a hand-edit; `done` accepts `pending` or `in progress`; a `done` row refuses both verbs, naming its current status.

#### [P05] The shared doctrine is `tuglaws/dash-work-doctrine.md` (DECIDED) {#p05-doctrine-home}

**Decision:** The duplicated worktree-work doctrine is factored into `tuglaws/dash-work-doctrine.md`; `dash-run` and `dash-implement` cite it by repo-relative path and keep only their own flow.

**Rationale:**
- Exact precedent: phase 2.1 promoted the vet rubric to `tuglaws/plan-review-rubric.md` "because that's where the judgment actually lived"; the worktree discipline is the same kind of durable, multi-consumer doctrine.
- A markdown file inside `tugplug/skills/` risks being read as a skill by tooling that walks that directory.
- Phase 5's planned `tuglaws/dash-lifecycle.md` covers the *state model*; this document covers *how an agent works on a dash worktree* — distinct subjects, distinct files.

**Implications:**
- `tuglaws/INDEX.md` gains the entry.
- Contents: the one-and-only-working-root rule (absolute paths, never write the base checkout), the verification bar (warnings are errors, green before commit), test discipline including the banned shapes, law discipline (name the tuglaws in commit bodies), commit-per-round via `tugutil dash commit`, no plan numbers in durable artifacts, fix-what-you-touch.

#### [P06] Draft symmetry by skill text; no wrapper verb (DECIDED) {#p06-draft-symmetry}

**Decision:** `dash-run` gains the same stop-point obligation `implement` already has: before stopping for the user's vet, compose the join draft from the rounds and write it with `tugutil draft set --owner dash:<name>`. No `dash draft` convenience verb is added.

**Rationale:**
- The verb already exists; a wrapper would be a second spelling of one action with its own doc and test burden.
- Making both working skills write the draft is what lets the landing gesture stop composing ([P07]).

**Implications:**
- After this phase, every lane-driven dash arrives at `/join` with a draft on file.

#### [P07] Draftless `dash-join` stops and instructs (DECIDED) {#p07-join-stops}

**Decision:** `dash-join`'s compose-fallback branch is retired. On a missing draft it reports that the dash has no join draft, prints the exact `tugutil draft set --owner dash:<name> --message "…"` command for whoever worked the dash, and stops. It never composes the message itself and never lands the bare dash description.

**Rationale:**
- Message authorship needs the working context (what the rounds did and why); the landing gesture has only the log lines. The skill that worked the dash writes the draft ([P06]); the landing gesture lands it.
- A silent fall-through to the dash description is exactly the durable lie the draft machinery exists to prevent.

**Implications:**
- Hand-driven dashes (worked outside the skills) hit this stop; the printed command is their one-step unblock.

#### [P08] Plan association: `branch.tugdash/<name>.tugplan`, recorded at first `step start` (DECIDED) {#p08-plan-assoc}

**Decision:** `dash step start` takes `--plan <path>` on first use and records the plan's worktree-relative path in git config at `branch.tugdash/<name>.tugplan`, beside the phase-1 `tugid`. Subsequent `step` calls read it; `dash status` reports it as `plan_path`. The verbs resolve it against the dash's worktree directory, never against cwd.

**Rationale:**
- Same home and lifetime as the dash id: branch-scoped config dies with the branch, so join/release clean it up for free.
- Worktree-relative because the plan `implement` edits is the worktree copy (its rule: never write the base checkout), and because the same relative path is meaningful in both trees.
- Derive-don't-record ([P06] in the program plan) does not apply: git cannot see which document a dash is driving; this is precisely a declaration.

**Implications:**
- `step start <n>` without a stored path and without `--plan` is a refusal naming the flag.
- A missing file at the resolved path is a refusal, not a fallback search — there is no `PLAN_SEARCH_DIRS` anywhere in this system, deliberately.

#### [P09] `dash mark <name> built|audited` is a closed vocabulary (DECIDED) {#p09-mark-verbs}

**Decision:** Stage declarations get one verb, `tugutil dash mark <name> <stage>`, accepting exactly `built` and `audited` (a clap `ValueEnum`). It appends the dash-log line and nothing else.

**Rationale:**
- [P06] in the program plan names exactly these two declared transitions; an open vocabulary would grow a folksonomy no reader is prepared for.
- `dash-implement` calls `mark built` after `just app-debug` succeeds; `dash-audit` calls `mark audited` when its verdict is good-shape *and* the audited work is a dash — declarations come from the verbs/skills that reach the transition, not from the user's memory.

**Implications:**
- `dash-audit` keeps its no-code-edits guardrail; a dash-log append is bookkeeping, the one write the skill is allowed, and only on a good-shape verdict for dash-resident work.

#### [P10] Renames are directory moves with vet-precedent stubs; the card submission moves in the same commit (DECIDED) {#p10-rename-mechanics}

**Decision:** `dash-implement`, `dash-run`, `dash-join`, `dash-audit` are created as real skill directories with the rewritten text; `implement`, `dash`, `join`, `audit` become redirect stubs modeled byte-for-byte on `tugplug/skills/vet/SKILL.md` (print the replacement command as a clickable chip, do nothing else, deleted in phase 5). `session-card.tsx`'s `buildCommandSubmission("tugplug:join", args)` becomes `"tugplug:dash-join"` in the same commit as the rename.

**Rationale:**
- The vet stub shipped in 2.1 and is the established alias shape; muscle memory and old-transcript chips keep working for one release.
- The card's `/join` gesture must never resolve to a stub — a landing gesture that prints a chip instead of landing is a broken gesture; same-commit is the only safe granularity.

**Implications:**
- `devise` and `review-plan` print `/tugplug:implement <path>` as the post-review hand-off; both strings become `/tugplug:dash-implement <path>` in the rename commit.
- tugdeck tests that pin the `/join` submission string update in the same commit; fixture strings in editor/annotator tests that merely need *some* command spelling are left alone.

---

### Deep Dives {#deep-dives}

#### Current state: where the slots already exist {#current-slots}

Findings an implementer would otherwise re-derive:

- **`DashStatus`** (`tugrust/crates/tugdash-core/src/ops.rs`) carries `step_current: Option<i64>` and `step_total: Option<i64>` with the doc comment "Phase 3's slots ([P06]); always absent here", set to `None` in `status_in`. It has **no** plan-path field yet — the program plan's phase-1 sketch listed one, but it was not implemented; this phase adds `plan_path: Option<String>`.
- **`ChangesetEntry::Dash`** (`tugrust/crates/tugcast-core/src/types.rs`) carries `step_current: Option<u32>`, `step_total: Option<u32>`, `stage: Option<String>`, all `skip_serializing_if`, with a legacy-decode test asserting absence when `None`.
- **`dash_entries`** (`tugrust/crates/tugcast/src/feeds/changeset.rs`) maps `tugdash_core::dash_detail_entries_in` onto the wire type and hardwires `step_current: None, step_total: None`; `stage` comes from `DashDetail.stage`.
- **`DashDetail`** (`ops.rs`) computes `stage` via `derive_stage(rounds, worktree_dirty, /* has_draft */ false, journal_present)` — note the feed path passes `has_draft: false` today; this phase does not change that, only adds the declaration input.
- **`derive_stage(rounds, worktree_dirty, has_draft, landing)`** returns `&'static str`, precedence `landing > draft-ready > working > created`. Its doc comment already promises "Declared stages (`implementing (i/N)`, `built`, `audited`) arrive with the step verbs".
- **Frontend:** `dashes-section.tsx` (`step ${entry.step_current}/${entry.step_total}` when both defined; `entry.stage` rendered verbatim or omitted when null) and `session-changes-dash-lane.tsx` (same composition). `tugdeck/src/lib/changeset-types.ts` already validates the optional fields.

#### Current state: the dash-log {#current-dash-log}

`append_dash_log` (`tugrust/crates/tugdash-core/src/dash.rs`) writes `<iso8601>  <dash>  <marker>  <note>\n` to `<project_state_dir>/dash-log.md`, creating the directory on first write; newlines in the note are flattened to spaces. Existing writers:

- `commit` — marker = short sha, note = verbatim instruction.
- join teardown — marker = short sha of the squash, note = `joined`.
- `release_in` — marker = `released`, note empty.

So "terminal" is spelled two ways: **marker** `released`, or **note** `joined`. The declaration reader ([P02]) must honor both as generation boundaries.

#### Current state: the ledger grammar {#current-ledger-grammar}

`read_ledger_row` (`tugutil-core/src/plan.rs`) splits a `|`-delimited row into trimmed cells: `[0]` must start with `#` (the anchor), `[1]` title, `[2]` status (lowercased), `[3]` commit (backticks trimmed; `—`/`-`/`–` and empty read as `None`). Rows with fewer than 3 cells are skipped by the parser — which is why the edit primitive must refuse rather than "fix" anything it cannot round-trip. `LedgerRow.line` is the 1-indexed source line, which is what the editor rewrites. Step→row correspondence is checked by PL016; status vocabulary by PL017 against `LEDGER_STATUSES`.

#### The doctrine duplication inventory {#doctrine-duplication}

The blocks shared (near-verbatim) between `tugplug/skills/dash/SKILL.md` and `tugplug/skills/implement/SKILL.md`, which move to `tuglaws/dash-work-doctrine.md`:

- "You are the worker/implementer" + no-sub-agents framing.
- Worktree root discipline (capture absolute `worktree` from `dash create --json`; every subsequent operation by absolute path; never write the base checkout; stray base writes block join).
- The verification bar (typecheck, `bun test` scope, `cargo nextest run`, `just app-test <file>` where it matters; warnings are errors; never commit red).
- Test discipline including the banned shapes (fake-DOM/RTL, mock-store assertions) and the never-hand-roll-`TUGAPP_*` rule.
- Law discipline (consult tuglaws for tugdeck/tugways work; name the laws in the dash commit body).
- `tugutil dash commit` round mechanics (message + stdin meta; one command = git commit + dash-log line).
- Guardrail boilerplate: never commit to base, stop before merge, fix what you touch, no plan numbers in durable artifacts.

What stays per-skill: `implement`'s ledger/selector/task-list mechanics and five-phase flow; `dash`'s input grammar and plan-less framing; each skill's own hand-off text.

---

### Specification {#specification}

**Spec S01: Declaration log lines** {#s01-log-lines}

| Marker | Note | Written by |
|---|---|---|
| `step-start` | `<i>/<N> Step <i>: <title>` | `tugutil dash step <name> start <i>` |
| `step-done` | `<i>/<N> <short-sha>` | `tugutil dash step <name> done <i>` |
| `built` | free-form, may be empty | `tugutil dash mark <name> built` |
| `audited` | free-form, may be empty | `tugutil dash mark <name> audited` |

Reader semantics ([P02]): filter lines by dash-name field → drop everything at or before the last terminal line (marker `released` or note `joined`) → the latest surviving declaration determines the declared stage; the latest `step-start`/`step-done` note's leading `i/N` token supplies `step_current`/`step_total`. Unparseable notes are skipped.

**Spec S02: CLI surface** {#s02-cli-surface}

```
tugutil dash step <name> start <n> [--plan <path>] [--json]
tugutil dash step <name> done <n> [--commit <sha>] [--json]
tugutil dash mark <name> <built|audited> [--note <text>] [--json]
```

- `step start`: resolves the plan ([P08]) — `--plan` records it (worktree-relative) at `branch.tugdash/<name>.tugplan`; absent flag reads the stored value; neither → exit 1. Applies the ledger edit ([P04]) `pending → in progress` on row `#step-<n>` of the worktree copy of the plan, then appends the `step-start` line. `N` is the ledger row count.
- `step done`: ledger edit `pending|in progress → done`, commit cell = `--commit` else the short sha of `tugdash/<name>`'s tip; then the `step-done` line.
- Both refuse with exit 1 and a located message, file untouched, on: dash not found; no stored plan and no `--plan`; plan file missing at the resolved path; not-a-plan (`NotAPlan`); no ledger; no row `#step-<n>`; invalid transition (message names the row's current status); post-edit round-trip failure.
- `mark`: appends the log line; refuses only an unknown dash. `--json` responses use the standard `{schema_version, command, status, data, issues}` envelope.

**Spec S03: `dash status` additions** {#s03-status-additions}

`DashStatus` gains `plan_path: Option<String>` (worktree-relative, from git config) and populates `step_current`/`step_total`/declared `stage` from the log reader. All additive; JSON omits absent fields per the existing serialization. `DashDetail` gains `step_current: Option<u32>`/`step_total: Option<u32>` and its `stage` gains the declaration input; `dash_entries` maps them through. No tugproto/TS type changes — the wire fields already exist end to end.

**State Zone Mapping:** omitted — this phase adds no frontend state. The only tugdeck change is the `/join` submission constant ([P10]); the dash surfaces render feed fields they already subscribe to.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/dash-work-doctrine.md` | Factored worktree-work doctrine ([P05]) |
| `tugplug/skills/dash-implement/SKILL.md` | Rewritten `implement` on the new verbs |
| `tugplug/skills/dash-run/SKILL.md` | Rewritten `dash` with draft symmetry |
| `tugplug/skills/dash-join/SKILL.md` | Rewritten `join`, compose-fallback retired |
| `tugplug/skills/dash-audit/SKILL.md` | Rewritten `audit` with `mark audited` |

(The four old skill directories become redirect stubs, not new files.)

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `LedgerEditError` | enum | `tugutil-core/src/plan.rs` | NotAPlan / NoLedger / NoRow / BadTransition / RoundTrip variants |
| `set_ledger_status` | fn | `tugutil-core/src/plan.rs` | `(source, anchor, status, commit) -> Result<String, LedgerEditError>` ([P04]) |
| `DashDeclaration` | enum | `tugdash-core/src/dash.rs` | `Step { current, total }`, `Built`, `Audited` |
| `read_declarations` | fn | `tugdash-core/src/dash.rs` | log reader with terminal reset ([P02]) |
| `step_start` / `step_done` | fn | `tugdash-core/src/ops.rs` | verb bodies: plan resolve, ledger edit, log line |
| `mark` | fn | `tugdash-core/src/ops.rs` | `built`/`audited` declaration append ([P09]) |
| `dash_plan_path` / `set_dash_plan_path` | fn | `tugdash-core/src/ops.rs` | `branch.tugdash/<name>.tugplan` config access ([P08]) |
| `derive_stage` | fn (modified) | `tugdash-core/src/ops.rs` | gains `declared: Option<&DashDeclaration>` input ([P03]) |
| `DashStatus.plan_path` | field | `tugdash-core/src/ops.rs` | additive (Spec S03) |
| `DashDetail.step_current` / `.step_total` | fields | `tugdash-core/src/ops.rs` | additive (Spec S03) |
| `DashCommands::Step` / `DashCommands::Mark` | enum variants | `tugutil/src/cli.rs` | Spec S02 |
| `dash_entries` | fn (modified) | `tugcast/src/feeds/changeset.rs` | maps the new detail fields |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Ledger edit round-trip and refusals; log grammar parse; terminal reset; stage precedence | Steps 1–2, 4 |
| **Integration** | Verb end-to-end against a real temp repo + worktree (the existing serial home-redirect harness in `ops.rs` tests) | Steps 3–4 |
| **Golden / Contract** | `--json` envelope shapes; `ChangesetEntry::Dash` legacy-decode stays green | Steps 4–5 |
| **Real-app** | Lens/lane rendering of stage + step; `/join` gesture still lands | Steps 5, 7 via `just app-test-changed` |

#### What stays out of tests {#test-non-goals}

- Skill prose behavior — skills are instructions to a model, not code; their correctness is exercised by the real gestures that invoke them and by the verbs' own tests. No fixture-driven "skill tests".
- Fake-DOM/RTL or mock-store shapes — banned in this codebase; frontend rendering of the new fields is already pinned by the existing pure-logic `dashes-section` tests and the app-test corpus.
- Re-testing `plan lint` rules — untouched by this phase; only the new edit primitive gets new coverage.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Ledger edit primitive | done | `23dfb86ef` |
| #step-2 | Dash-log declaration grammar | done | `196e02ec3` |
| #step-3 | `dash step start` / `dash step done` | done | `69b075613` |
| #step-4 | `dash mark` + stage/step derivation | done | `bd041c9c6` |
| #step-5 | Feed carries stage and step | done | `fd08f9f40` |
| #step-6 | The dash-work doctrine | done | `f7b604673` |
| #step-7 | Skill renames, rewrites, and stubs | done | `ad2fed815` |
| #step-8 | Integration checkpoint | done | `52517c8e1` |

#### Step 1: Ledger edit primitive {#step-1}

**Commit:** `tugdash(dash-codification): strict single-row Step Status Ledger edit in tugutil-core::plan`

**References:** [P04] strict edit, Risk R01, (#current-ledger-grammar, #s02-cli-surface)

**Artifacts:**
- `LedgerEditError` and `set_ledger_status(source, anchor, status, commit) -> Result<String, LedgerEditError>` in `tugrust/crates/tugutil-core/src/plan.rs`.

**Tasks:**
- [ ] Parse via the existing `parse()`; refuse `NotAPlan`, absent ledger, absent row for the anchor.
- [ ] Enforce transitions per [P04]: to `in progress` from `pending`, or idempotently from `in progress` (the output round-trips byte-identical); to `done` from `pending` or `in progress`; a `done` row refuses both, and error messages name the row's current status.
- [ ] Rewrite only the matched row's line (`LedgerRow.line`), replacing the status cell and — on `done` — the commit cell as backticked short sha; preserve every other byte of the document, including the row's title cell verbatim.
- [ ] Re-parse the output and verify the edited row reads back with the requested status/commit; failure is `RoundTrip` and the caller gets no edited text.

**Tests:**
- [ ] `pending → in progress` and `in progress → done` round-trip; output differs from input on exactly one line (byte-diff assertion).
- [ ] Refusals: not-a-plan, no ledger section, unknown anchor, `done → in progress`, `done → done`.
- [ ] Idempotent re-entry: `in progress → in progress` succeeds and returns byte-identical text.
- [ ] A plan with prose and fenced samples around the ledger is untouched outside the row.
- [ ] Commit cell renders backticked and `read_ledger_row` reads it back.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core`

---

#### Step 2: Dash-log declaration grammar {#step-2}

**Commit:** `tugdash(dash-codification): declaration markers and generation-aware reader for the dash-log`

**References:** [P01] log derivation, [P02] log grammar, Spec S01, (#current-dash-log)

**Artifacts:**
- `DashDeclaration` enum and `read_declarations(repo_root, dash) -> Option<DashDeclaration>` plus a step-fields accessor (latest `i/N`) in `tugrust/crates/tugdash-core/src/dash.rs`.

**Tasks:**
- [ ] Writer side: nothing new — declarations go through the existing `append_dash_log` with the Spec S01 markers/notes; add small helpers that format the notes so call sites cannot drift.
- [ ] Reader: filter by the dash-name field; honor **both** terminal spellings (marker `released`, note `joined`) as generation boundaries; latest surviving declaration wins; parse `i/N` from the first note token, skipping unparseable notes.
- [ ] Missing log file, empty log, and no-surviving-lines all read as `None`.

**Tests:**
- [ ] `step-start` then `built` then `step-start` derives `Step` (re-entry demotes).
- [ ] Reused name: declarations before a `released` line and before a `joined` line are both invisible to the new generation.
- [ ] `i/N` parses from `step-start` and `step-done`; garbage note is skipped without failing the read.
- [ ] Lines for other dashes never leak in.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 3: `dash step start` / `dash step done` {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `tugdash(dash-codification): dash step verbs drive the plan ledger and the dash-log in one gesture`

**References:** [P04] strict edit, [P08] plan association, Spec S01, Spec S02, Risk R01, (#s02-cli-surface)

**Artifacts:**
- `DashCommands::Step` in `tugrust/crates/tugutil/src/cli.rs`; `step_start`/`step_done` + `dash_plan_path`/`set_dash_plan_path` in `tugrust/crates/tugdash-core/src/ops.rs`; dispatch in `tugrust/crates/tugutil/src/dash.rs`.

**Tasks:**
- [ ] Plan association per [P08]: `--plan` stores the worktree-relative path at `branch.tugdash/<name>.tugplan` (relativize an absolute path that lies inside the worktree; refuse one that does not); absent flag reads the stored value; neither is exit 1 naming the flag.
- [ ] Resolve the plan against the dash's worktree path (from the repo root, never cwd); read, apply `set_ledger_status` on `#step-<n>`, write back atomically (temp file + rename), then append the Spec S01 log line. `N` = ledger row count; the `step-start` note carries the row's title.
- [ ] `done`: commit sha from `--commit` else `git rev-parse --short tugdash/<name>`.
- [ ] Every `LedgerEditError` maps to exit 1 with the plan path and row named; the file is untouched on every refusal (the edit is compute-then-write).
- [ ] `--json` envelopes report `{dash, plan_path, step, total, status, commit?}`.

**Tests:**
- [ ] End-to-end on the serial home-redirect harness: create a dash, seed a skeleton-valid plan in the worktree, `step start 1` → ledger row reads `in progress`, log line present; `step done 1` → `done` + tip sha recorded.
- [ ] Refusals: no stored plan and no `--plan`; plan path outside the worktree; missing file; `start` on a `done` row.
- [ ] The stored config value survives to a second invocation without `--plan`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 4: `dash mark` + stage/step derivation {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdash(dash-codification): built/audited declarations and derived implementing stage in dash status`

**References:** [P01] log derivation, [P03] stage precedence, [P09] mark verbs, Spec S02, Spec S03, (#current-slots)

**Artifacts:**
- `DashCommands::Mark` + dispatch; `mark` in `ops.rs`; `derive_stage` extended; `status_in` and `DashStatus` populate `stage`/`step_current`/`step_total`/`plan_path`.

**Tasks:**
- [ ] `dash mark <name> <built|audited>` as a clap `ValueEnum` ([P09]); refuses an unknown dash; appends the log line with optional `--note`.
- [ ] Extend `derive_stage` with the declaration input per [P03]: `landing` still first; then the latest declaration (`implementing` for step markers, `built`, `audited`); then the unchanged `draft-ready`/`working`/`created` chain. Update both call sites.
- [ ] `status_in`: call `read_declarations`, populate `step_current`/`step_total` from the latest step marker, `plan_path` from config (Spec S03).

**Tests:**
- [ ] Stage table test over the precedence matrix: declarations beat `draft-ready`; `landing` beats declarations; a declaration-free dash derives byte-identically to today (pin the four existing outcomes).
- [ ] `status_in` end-to-end: stepped dash reports `implementing` + `i/N` + `plan_path`; `mark built` flips stage to `built`; a later `step start` demotes to `implementing`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 5: Feed carries stage and step {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(dash-codification): changeset feed derives declared stage and step progress per dash`

**References:** [P01] log derivation, [P03] stage precedence, Spec S03, (#current-slots)

**Artifacts:**
- `DashDetail` gains `step_current`/`step_total` and declaration-aware `stage`; `dash_entries` in `tugrust/crates/tugcast/src/feeds/changeset.rs` maps them instead of hardwiring `None`.

**Tasks:**
- [ ] `dash_detail_entries_in`: one `read_declarations` pass per dash (the log is read per repo; keep the read out of the per-branch git loop if it can be hoisted), feeding the extended `derive_stage` and the new fields.
- [ ] `dash_entries` maps `detail.step_current`/`detail.step_total` through; delete the hardwired `None`s.
- [ ] Confirm the `ChangesetEntry::Dash` legacy-decode test still passes untouched (fields were already optional on the wire).

**Tests:**
- [ ] `tugdash-core` test: `dash_detail_entries_in` reports `implementing` + step fields for a stepped dash and today's derived stages for a plain one.
- [ ] Update the `changeset.rs` tests that construct dash entries with `None` slots only where their fixtures now flow real values.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed` (derives the dash-surface coverage; the Lens section and dash lane render `step i/N` from the live feed)

---

#### Step 6: The dash-work doctrine {#step-6}

**Commit:** `tugdash(dash-codification): factor the shared worktree-work doctrine into tuglaws/dash-work-doctrine.md`

**References:** [P05] doctrine home, [Q01], (#doctrine-duplication)

**Artifacts:**
- `tuglaws/dash-work-doctrine.md`; an entry in `tuglaws/INDEX.md`.

**Tasks:**
- [ ] Write the doctrine from the inventory at (#doctrine-duplication): worktree-root discipline, verification bar, test discipline with the banned shapes, law discipline, `dash commit` round mechanics, no plan numbers in durable artifacts, fix-what-you-touch, stop-before-merge. Written as doctrine a worker applies — not as skill prose, and with no skill names baked into the rules themselves (the skills cite the doctrine, not the reverse).
- [ ] Do **not** edit the skills yet — step 7 rewires them onto this document.

**Tests:**
- [ ] None (documentation). The success criterion's grep — each formerly duplicated sentence appears in exactly one file — is discharged at step 7.

**Checkpoint:**
- [ ] `tuglaws/INDEX.md` lists the new document; the file renders clean in preview.

---

#### Step 7: Skill renames, rewrites, and stubs {#step-7}

**Depends on:** #step-3, #step-4, #step-6

**Commit:** `tugdash(dash-codification): dash-* skill roster — renames, verb rewrites, redirect stubs, /join submission`

**References:** [P05] doctrine home, [P06] draft symmetry, [P07] join stops, [P09] mark verbs, [P10] rename mechanics, [Q02], [Q03], (#doctrine-duplication)

**Artifacts:**
- Four new skill directories, four redirect stubs, the card submission change, `tugplug/CLAUDE.md` + repo `CLAUDE.md` updates, hand-off strings in `devise` and `review-plan`.

**Tasks:**
- [ ] **`dash-implement`** (from `implement`): replace the hand-edit ledger instructions with `tugutil dash step <name> start|done` (the verb now owns "task, ledger, and commit move together"; the TaskCreate/TaskUpdate progress surface stays); first `step start` passes `--plan` with the worktree-relative plan path; after a successful `just app-debug`, run `tugutil dash mark <name> built`; keep the join-draft obligation; cite `tuglaws/dash-work-doctrine.md` and delete the duplicated blocks; document the refusal fallback (a `dash step` exit 1 means fix the plan or hand-edit, per Risk R01); state the resume rule over the verb — resume at the first ledger row not `done`, since an interrupted run leaves its row `in progress` and `step start` re-enters it idempotently ([P04]) — replacing the current prose's "first step still marked `pending`", which would skip an interrupted step.
- [ ] **`dash-run`** (from `dash`): cite the doctrine, delete the duplicated blocks; add the [P06] stop-point obligation — compose the join draft from the rounds and `tugutil draft set --owner dash:<name>` before stopping for the user's vet.
- [ ] **`dash-join`** (from `join`): retire the compose-fallback branch per [P07] — on a missing draft, report, print the `tugutil draft set` command, stop; everything else (preview, land, teardown, receipt) unchanged.
- [ ] **`dash-audit`** (from `audit`): unchanged pass, plus — when the audited work lives on a dash and the verdict is good-shape — `tugutil dash mark <name> audited` ([P09]); the no-code-edits guardrail explicitly carves out this one bookkeeping append.
- [ ] **Stubs**: `implement`, `dash`, `join`, `audit` become vet-precedent redirect stubs (frontmatter intact, print the replacement command as its own backticked chip with the user's arguments substituted, do nothing else, "deleted in a later release").
- [ ] **Card**: `session-card.tsx` `buildCommandSubmission("tugplug:join", args)` → `"tugplug:dash-join"`; update tugdeck tests that pin that submission string (grep `tugplug:join` and judge each site — fixture strings that merely need any command spelling stay).
- [ ] **Hand-offs**: `devise/SKILL.md` and `review-plan/SKILL.md` print `/tugplug:dash-implement <plan-path>` as the post-review command.
- [ ] **Docs**: `tugplug/CLAUDE.md` roster and flow line; repo `CLAUDE.md` — the repository-structure row naming the skill list and the Git Policy exception naming "the `implement` and `dash` skills" (now `dash-implement` / `dash-run`).
- [ ] Verify the skill inventory picks up the new directories dynamically (Assumptions); if an allowlist exists in tugcode, update it here.

**Tests:**
- [ ] `bun test` (the updated submission-string pins).
- [ ] `bunx tsc --noEmit` in `tugdeck/`; `bunx vite build`.

**Checkpoint:**
- [ ] `just app-test-changed` (derives the `/join` gesture coverage; the gesture must land, not print a redirect chip)
- [ ] grep: each sentence from (#doctrine-duplication) lives in exactly one file

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-5, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01] log derivation, [P10] rename mechanics, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] One real pass over the whole lane on this phase's own dash: `tugutil dash step <name> start/done` drove this plan's actual ledger during implementation (the phase eats its own cooking — verify the ledger above shows verb-written rows and the dash-log shows the paired lines); `dash status <name> --json` reports `implementing`/`built` with `i/N` and `plan_path`; the Lens section and dash lane display them.
- [ ] `just app-debug` from the worktree; confirm the `(debug, <branch>)` instance shows the stepped dash in the Lens Dashes section with stage and step.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (full workspace)
- [ ] `bun test` (repo root)

**Checkpoint:**
- [ ] `bunx vite build` clean
- [ ] `just app-test-changed` green
- [ ] `tugutil plan lint dash/dash-integration-3-codification.md` exit 0 (the plan this phase ran on still lints with its verb-edited ledger)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The dash lifecycle's improvised bookkeeping is verbs — `dash step`, `dash mark`, a derivation that lights up `implementing (i/N)`/`built`/`audited` across `dash status`, the feed, the Lens, and the Changes lane — and the skill roster carries its ratified `dash-*` names over one shared doctrine document.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `dash step start|done` and `dash mark built|audited` exist, are strict, and are the way this very plan's ledger was driven (verification: this document's ledger rows carry verb-written statuses and commits; the dash-log shows the paired lines).
- [ ] `dash status --json` reports declared stage, `step_current`/`step_total`, and `plan_path`; the feed carries them; both dash surfaces display them (verification: step 8's live check + `just app-test-changed`).
- [ ] The four `dash-*` skills are real, the four old names redirect, the card lands `/join` through `tugplug:dash-join`, and `devise`/`review-plan` hand off to `/tugplug:dash-implement` (verification: step 7 checkpoint).
- [ ] The duplicated doctrine lives once, in `tuglaws/dash-work-doctrine.md` (verification: step 7's grep).
- [ ] Standard bar green: `cargo nextest run`, `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `just app-test-changed`.

**Acceptance tests:**
- [ ] Reused-name generation test (a released dash's declarations are invisible to its successor).
- [ ] Ledger edit byte-diff test (exactly one line changes).
- [ ] Stage precedence matrix test (declarations vs. draft-ready vs. landing).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Phase 4 — join mode (the landing surface) builds on the now-populated stage/step readouts.
- [ ] Phase 5 — deletes the redirect stubs (including `vet`) and writes `tuglaws/dash-lifecycle.md`, which cites this phase's derive-vs-declare mechanics.
- [ ] Session-memory naming updates for the renamed skills (conversational, per Non-goals).

| Checkpoint | Verification |
|------------|--------------|
| Verbs are strict and byte-safe | step 1–3 unit/integration tests; Risk R01 refusal ladder |
| Derivation is generation-safe | step 2 reused-name test |
| Surfaces light up with no new UI | step 5 `just app-test-changed` |
| Roster renamed without breaking `/join` | step 7 `just app-test-changed` |
