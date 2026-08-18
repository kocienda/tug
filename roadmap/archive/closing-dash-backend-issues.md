## Closing the Dash Backend {#closing-dash-backend}

**Purpose:** Carry out the work ledger of [`roadmap/closing-dash-backend-issues-brief.md`](closing-dash-backend-issues-brief.md), items 1–4 and 6: the hygiene round (wrong-year timestamps, a NUL byte in a load-bearing source file, tempdir pollution of the live data directory), landing observability, the engine/instance race, an environment guard for the app-tests, and the tactical layer over the dash lane. At the end, the dash backend is the solid foundation the UI campaign builds on: every landing leaves a receipt, no instance acts on another's dashes, no test dirties the real data directory, and a refusing lane control says why — in the face, not in a tooltip that cannot render.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via a dash worktree) |
| Last updated | 2026-08-16 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-16, opus.** Reviewed `plan:019bc4064cb0e8e9`. Lint: 0 errors, 1 warning (the missing Review Record this paragraph creates).
Oriented on: the whole document — a first pass on a never-reviewed plan.
Applied, in descending severity. **S01 would have broken dash generation reset:** `dash.rs::is_terminal` matches the note with exact equality (`note == "joined"`), and `read_declarations` uses it to discard everything at or before a dash's last terminal line, so appending a route suffix would silently make every future join non-terminal and a reused dash name would inherit the prior generation's declarations — the exact failure that function's doc comment warns about. S01 now requires widening `is_terminal` to a prefix match, #step-4 carries the task and a `read_declarations` reuse test pins it. **Two wrong paths corrected:** S03 and #step-10 named `changeset-types.ts` as the deck mirror for the archaeology type, but that file has no join-outcome fields — the real homes are `changeset-verb-store.ts` (parse) and `join-mode-controller.ts` (carry to the face); #step-10 now also depends on #step-2, because until the NUL byte is gone `changeset-verb-store.ts` is binary to `grep` and `git diff` (demonstrated during this review: `grep -n conflicts` on it prints nothing while `rg -l` matches). **A hole in [P05]:** the landing face has a fourth control the brief never named — `Resume teardown`, which completes an interrupted join and is the most base-mutating act on the surface; it was unclassified and now stays gated, and [P05] records each control's actual `disabled` expression, since #step-7's task had attributed Resume teardown's `joinPhase === "pending"` clause to Resolve, which has no such clause. **The [P09] diagnosis was right but imprecise:** the displacement is a fixed 365 days, not a year — traced by hand to `1969-01-01` at epoch zero — so it reads as one year *and one day* across a leap boundary; the decision, the success criterion, and #step-1's pins now say so, and [P09] records that `append_dash_log` is the function's only caller, narrowing the blast radius the brief assumed. **Test-layer:** #step-7's fallback ("pin via the store layer") invited a reflexive per-mutator pin, which the rubric bans — it now says to drop the assertion rather than substitute a mock; #step-9 gained the un-animated-property requirement, because a mid-flight transition returns interpolated `oklab(…)`. **Checkpoint realism:** #step-11 called for `just app-test-changed`, which will refuse with exit 3 on this diff (the fixture change alone selects most of the dash corpus); the step now expects the refusal and names the core-tier fallback. Added the mandatory law cross-check ([L02]/[L06]/[L13]/[L24] engaged, [L22]/[L01]/[L03] not).
Deferred: nothing new. [Q01] (instance-scoped engines) was already asked and deferred by the owner during devise and stands as written; the per-dash opt-out in [P01] is verified against the code — `read_autoreplay` is currently hoisted out of the per-dash loop, and the plan correctly places the new per-dash read inside the same blocking hop that builds each `DashReading`.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dash lifecycle program of `roadmap/join-assessment.md` is landed: the draft contract (`0664fca77`), clean base at creation, and base-motion replay (`9bfae24bd`) all shipped, and all five join-surface app-tests (at0405, at0417, at0418, at0425, at0426) are green on `main`. The 2026-08-15 investigation that confirmed this also surfaced a set of smaller defects that undermine the "solid foundation" claim: dash-log timestamps are one year early; a literal NUL byte makes `changeset-verb-store.ts` invisible to `rg` and `git diff`; ~720 tempdir-slug directories pollute `~/Library/Application Support/Tug/projects/`; the landing routes write nothing to any log (the two recent joins are unattributable to a route); a base-motion engine replayed an app-test's scratch dash mid-test; and the corpus goes red when run from a dash worktree with nothing naming why. Separately, the dash lane's refusal presentation makes a correctly-refusing lane indistinguishable from a dead one — the live "non-functional Join sheet" report cannot be diagnosed until that ambiguity is removed.

Item 5 of the brief (catching the Join sheet live) is a protocol, not a build, and item 7 (deferred lifecycle features) is explicitly out of scope here. This plan is items 1–4 and 6.

#### Strategy {#strategy}

- Land the three hygiene fixes first — each is small, independent, and pins with a test, and none should sit behind larger work.
- Make every landing and engine action attributable before touching the lane's presentation, so the next incident report is a log read, not archaeology.
- Close the engine race with the smallest correct scoping (a per-dash opt-out the fixtures set), leaving the broader instance-scoping question open ([Q01]).
- Make the app-test corpus refuse the environment that breaks it, with the root cause named in the refusal.
- Then the tactical layer, in dependency order: gate scope, in-face reasons, disabled appearance, conflict archaeology — the first three convert "dead click" into a labeled refusal, which is the diagnostic prerequisite for the brief's item 5.
- Rust and deck work interleave; every step is committed as its own round on the dash worktree.

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil-core`'s timestamp function produces the correct calendar date for known epochs — including a leap-day instant, where the pre-fix error is one year *and one day* ([P09]) — pinned by unit test; a fresh dash-log line carries the current date.
- The dash-log's `joined` line still ends a dash generation after gaining its route suffix: a dash name reused across a route-suffixed join starts with no inherited declarations (S01, pinned in #step-4).
- `rg -uu --files-with-matches '\x00' tugdeck/src tugrust tugproto/src tests` reports no source files (verify: run it before and after Step 2).
- A full `cargo nextest run` leaves `~/Library/Application Support/Tug/projects/` with the same entry count it started with (verify: count before/after).
- Every join (CLI and card), release, and engine decision leaves a log line naming dash, route/origin, and outcome; the dash-log's `joined` note carries the route.
- A dash carrying `tugautoreplay=false` branch config is never replayed by any engine, pinned by a Rust test; `dash-fixture.ts` sets it on every fixture dash.
- `just app-test <file>` run from a dash worktree refuses with a message naming the reason and the supported alternative, instead of failing on assertions.
- `Resolve`, `Adopt`, and `Leave` are clickable mid-turn; `Join` and `Release` remain gated; at0425 pins the new scope.
- A refused `Join` renders its reason as visible text inside the landing face; no disabled lane control carries a `title` as its only explanation.
- A disabled filled button is visually distinct from an enabled one at a glance; `bun run audit:theme-contrast` stays within the brio budget.
- A conflicted join preview lists, per conflicted path, the base commits that touched it (short SHA + subject), rendered in the expanded landing face.

#### Scope {#scope}

1. `tugutil-core` timestamp correctness and its tests.
2. Source-tree NUL hygiene.
3. Projects-dir pollution: one-time sweep plus an enforcement tripwire.
4. Landing observability: dash-log route notes and tracing at the tugcast call sites.
5. Engine scoping: per-dash autoreplay opt-out, honored by the engine, set by test fixtures.
6. App-test environment guard for dash-worktree runs.
7. Tactical layer: turn-gate scope, in-face refusal reasons, disabled appearance, conflict archaeology.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The Join-sheet live capture (brief item 5) — a protocol that runs when the symptom recurs, not a build step.
- The deferred lifecycle items (brief item 7): queue-a-landing-for-turn-end, replay-by-click for unbound dashes, checkpoint-running injected turns.
- Instance-scoped engines ("an engine only acts on dashes its own clients opened") — deferred as [Q01].
- Repairing existing wrong-year dash-log lines — the log is append-only; the era before the fix is consistently one year early and readers are told so in the doctrine.
- Any visual redesign of the lane beyond the four tactical fixes — the UI campaign follows this plan.

#### Dependencies / Prerequisites {#dependencies}

- `main` at or past `c1d77cb06` (all prior dash programs landed).
- git ≥ 2.40 in the environment (already required by base-motion replay).
- No schema changes to `changes.db` are needed; nothing here touches `CHANGES_SCHEMA_VERSION`.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace (`-D warnings`).
- `tugdash-core` has no `tracing` dependency and stays that way — logging lives in callers ([P02]).
- App-tests run against the live repository; fixtures must leave no worktrees, `tugdash/*` branches, or config behind.
- Deck changes verify with `bunx vite build` (the debug app loads the prod rollup bundle); Rust changes need `just build-app` before app-tests can see them.
- A step that adds a field to a shared wire type owes a workspace-wide test compile, not a crate-scoped one (the base-motion plan's checkpoint-gap lesson).
- Theme token edits must respect the light-theme CVD floor: darkening or restyling around `--tugx-accent` can collide accent with danger under CVD; run both halves of `bun run audit:theme-contrast`.

#### Assumptions {#assumptions}

- The at0405/at0426 dash-worktree failures are environmental and reproducible from a dash worktree; Step 6 confirms the mechanism before encoding it in the refusal message.
- The `ConflictBoard`/engine wiring from base-motion replay is stable; this plan extends its logging and gating without restructuring it.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Instance-scoped engines (DEFERRED) {#q01-instance-scoped-engines}

Should a base-motion engine act only on dashes belonging to workspaces its own clients have open? Asked 2026-08-16; the owner chose the per-dash opt-out ([P01]) as the fix for this plan and deferred instance scoping. Rationale: the opt-out closes the observed race (fixtures) with a one-line config write, while instance scoping needs new "my clients" state in the engine and its own design pass. Plan to resolve: revisit when the deferred lifecycle items (brief item 7) are taken up, since replay-by-click forces the "who owns this dash" question anyway.

---

### Risks and Mitigations {#risks}

- **R01 — Disabled-appearance change trips the contrast audit or the CVD floor.** Mitigation: scope the change to `tug-button.css`'s disabled rules (no per-theme token edits), and run `bun run audit:theme-contrast` in the step checkpoint; if the audit objects, prefer a non-color cue (outline/weight) over darker fills.
- **R02 — Archaeology cost on a large base delta.** `git log` over many commits × many conflicted paths could be slow on the preview round-trip. Mitigation: cap at the last 5 commits per path and compute only on the conflicted preview path (Spec S03); the cap is stated in the UI ("+N earlier").
- **R03 — The worktree guard refuses a run someone genuinely wants.** Mitigation: an explicit escape hatch (`TUG_APPTEST_ALLOW_WORKTREE=1`) that names itself in the refusal text.
- **R04 — The projects-dir tripwire fires in a legitimate context** (a real repo under a temp path). Mitigation: the tripwire is debug-assertion-shaped — release builds are untouched; tests that legitimately exercise tempdir repos set `TUG_DATA_DIR`, which is the behavior being enforced.
- **R05 — Ungating `Resolve` mid-turn lets the ladder run while the bound agent edits the dash worktree.** The ladder builds candidates off to the side (`merge-tree`, no checkout), so the worktree is safe; the residual risk is a candidate built against a tree the agent is about to change, which the review gate already forces a human to read. Accepted.

---

### Design Decisions {#design-decisions}

#### [P01] Per-dash autoreplay opt-out via branch config (DECIDED) {#p01-per-dash-optout}

A dash opts out of engine replay with `git config branch.tugdash/<name>.tugautoreplay false`, beside the existing `.tugbase`/`.tugplan` keys (`tugdash-core/src/ops.rs` uses the `branch.tugdash/<name>.<key>` convention throughout). The engine reads it per dash during evaluation and treats `false` as an unconditional skip, before any other input. The repo-wide `tugdash.autoreplay` gate is unchanged. `tests/app-test/dash-fixture.ts` sets the key in `createDash` immediately after `tugutil dash create` succeeds, so every fixture dash is invisible to every engine. Decided over instance-scoping (deferred, [Q01]) and over fixture-name matching (couples the engine to test naming).

#### [P02] Observability lives at the call sites; the dash-log carries the route (DECIDED) {#p02-observability-at-call-sites}

`tugdash-core` stays free of `tracing`. Attribution is two-layered: (1) `join_in` and the release path accept an `origin: &str` ("cli" or "card") threaded from their two callers — `tugutil`'s dash commands and `agent_supervisor`'s `do_changeset_join` — and append it to the dash-log's `joined`/`released` note, making the durable record route-attributed; (2) `do_changeset_join` and `do_changeset_join_resolve` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` emit one `tracing::info!` line each on completion (dash, outcome, blockers-or-candidate), matching the engine's existing `base-motion: replayed` lines in `base_motion.rs`. The engine additionally logs its `Skip` decisions at `debug!` with the skip reason, so a silent engine is explicably silent.

#### [P03] The projects-dir tripwire is a guarded write, not a scan (DECIDED) {#p03-projects-tripwire}

`append_dash_log` (`tugrust/crates/tugdash-core/src/dash.rs`) — the one function that creates project state dirs for dash activity — gains a debug-assertion: if `repo_root` resolves under the OS temp directory and `TUG_DATA_DIR` is unset, panic with a message naming the fix ("test writes dash state for a tempdir repo without redirecting TUG_DATA_DIR"). Debug builds (all test runs) enforce; release builds are untouched. Decided over a janitor sweep of slug-decoded paths (the slug encoding is lossy — `-` in a real path is indistinguishable from a separator, so decode-and-check cannot be exact) and over a CI directory-count check alone (which reports the leak without locating the leaker). The one-time cleanup of existing pollution is a manual sweep in the same step, matching `-private-var-folders-*` / `-var-folders-*` slugs, which are temp paths by construction.

#### [P04] The worktree guard refuses in the recipe, names the mechanism, and offers the exit (DECIDED) {#p04-worktree-guard}

The `just app-test` recipe (justfile, `app-test *FILES:`) gains a preamble check: if the invoking repo root is a linked worktree (`git rev-parse --git-common-dir` differs from `<root>/.git`) or HEAD is a `tugdash/*` branch, refuse before launching anything, printing the reason established by this step's root-cause task and the escape hatch (`TUG_APPTEST_ALLOW_WORKTREE=1`). The guard goes in the recipe rather than per-test fixtures so it covers the whole corpus at one seam, before any app builds or launches spend time.

#### [P05] Turn gating narrows to the two acts that mutate the base (DECIDED) {#p05-turn-gate-scope}

`Join`, `Release`, and **`Resume teardown`** keep the `turnInProgress` gate — all three mutate shared state (the base branch; the dash's existence) while an agent may be mid-edit. `Resume teardown` is easy to miss because the brief never named it: it is the fourth control in the landing face, rendered when `entry.stage === "landing"`, and it *completes an interrupted join* — the most base-mutating act on the surface. It stays gated.

`Resolve`, `Adopt`, and `Leave` drop the gate: `Resolve` builds an off-to-the-side candidate and touches no checkout; `Adopt`/`Leave` change only the card's binding. Today the gate is blanket — in `session-changes-dash-landing.tsx` every control disables on `turnInProgress`, and `session-changes-view.tsx` folds it into the landing actions and the adopt/leave frames. The brief's judgment stands: blocking `Resolve` locks a conflicted dash's only escape hatch.

Note the exact current expressions, since they differ per control and the obvious guess is wrong: `Resolve` is `disabled={turnInProgress}` and nothing else (its visibility is already gated by `resolveFace === "offer"`, so removing the turn clause leaves it plainly enabled); `Resume teardown` is `disabled={turnInProgress || joinPhase === "pending"}`; `Join` is `disabled={disabledReason !== null}`, where the turn input reaches it *inside* `evaluateJoinLandGate` rather than as a separate clause; `Release` is `disabled={releaseHint !== null}`, where `releaseHint` is the turn hint itself.

#### [P06] Refusal reasons render in the face, not on the control (DECIDED) {#p06-in-face-reasons}

`.tug-button:disabled` sets `pointer-events: none` (`tugdeck/src/components/tugways/internal/tug-button.css`), so a disabled control never hovers and a `title` on it is dead code — the current shape at `session-changes-dash-landing.tsx` (`title={disabledReason ?? undefined}`). The fix renders the reason as a visible text line inside the landing face adjacent to the refused control, reusing the derivation that exists (`joinDisabledReason` over the gate's reason and outcome). The dead `title` attributes on lane controls are removed rather than left as decoys. No new state: the reason is derived at render from store-held inputs ([L06] appearance stays in CSS/DOM; the reason text is ordinary render output of existing store state).

#### [P07] Archaeology rides the conflicted preview, capped, into the expanded face (DECIDED) {#p07-archaeology-on-preview}

Decided by the owner 2026-08-16: conflict archaeology surfaces in the expanded landing face. The data is computed server-side on the preview path only, in `tugdash-core`: for each conflicted path, the base commits since the merge-base that touched it (`git log <merge-base>..<base> --format=… -- <path>`, newest first, capped at 5 with a total count). It rides `JoinOutcome` as an additive field (absent when empty, like the existing preview-only fields), through the existing `changeset_join` preview round-trip — no new store, no new request. The face renders it under each conflicted path: short SHA + subject (+ "+N earlier" past the cap).

#### [P08] Disabled looks disabled via component CSS, not theme tokens (DECIDED) {#p08-disabled-appearance}

The fix is scoped to `tug-button.css`'s disabled rules: filled variants lose their fill when disabled (falling back to an outlined/ghost treatment at the existing disabled opacity), so a disabled action button no longer presents as a live filled control. `--tugx-control-disabled-opacity` and the six theme files are untouched — a token change would move every disabled control in the app and re-open the light-theme CVD floor problem. Verified against the contrast audit (R01).

#### [P09] The timestamp fix replaces the algorithm, not the constant (DECIDED) {#p09-timestamp-algorithm}

`now_iso8601` (`tugrust/crates/tugutil-core/src/session.rs`) computes the civil date by hand with `DAYS_TO_EPOCH = 719162` (days measured from year 1) combined with `year_to_days` (measured from year 0, giving 719527 days to 1970) — the two disagree by 365 days. Rather than patch the constant atop the "simplified algorithm", the date computation is replaced with the proven days-to-civil conversion (Howard Hinnant's `civil_from_days` shape), pinned by tests at known epochs including both leap-year sides.

**The error is 365 days, not "one year".** Traced by hand: at `secs = 0`, `total_days = 719162`; the approximate-then-refine loop settles on `year_to_days(1969) = 719162`, so epoch zero renders `1969-01-01`. Because the displacement is a fixed *day* count, it reads as exactly one year only for instants whose 365-day-earlier date is the same calendar day — which fails across a leap day, where the rendered date is one year **and one day** early. This matters twice: a test pin written as "expect the same date one year back" is wrong near a leap boundary, and the pre-fix dash-log era must be described as 365 days early rather than a clean year shift, or an incident timeline reconstructed across February 2024 will be off by a day.

**The only caller is `dash.rs::append_dash_log`.** A workspace grep for `now_iso8601` outside its own module returns exactly one hit (`crates/tugdash-core/src/dash.rs:16,181`); `session.rs` defines it and does not itself use it, and the module is 82 lines with no test module of its own. The blast radius is therefore the dash-log alone — narrower than the brief assumed — and the new tests are this function's first.

---

### Deep Dives {#deep-dives}

#### The investigation record {#investigation-record}

Everything this plan fixes was established live on 2026-08-15/16; the full narrative is the brief's ["What the investigation settled"](closing-dash-backend-issues-brief.md#what-the-investigation-settled-2026-08-15) section. The facts a cold implementer needs restated: at0405/at0426 pass on `main` and were red only from a dash worktree; the release instance's log carries no line for either of that evening's two joins; the dash-log recorded `at0405-lane  replayed  onto c1d77cb06: 4d0d5eb01->5194e7a3a` — an engine (attribution unknown, which is the point of [P02]) replaying a fixture dash mid-test; the projects dir held 721 entries of which one is real; the dash-log's timestamps read `2025-08-16` on 2026-08-16.

#### Where the seams are {#seam-map}

| Concern | Seam |
|---|---|
| Timestamp | `tugutil-core/src/session.rs` `now_iso8601`, helpers `is_leap_year` / `days_in_year` / `year_to_days` |
| Dash-log writes | `tugdash-core/src/dash.rs` `append_dash_log(repo_root, dash, marker, note)` |
| State-dir resolution | `tugutil-core/src/paths.rs` `project_state_dir` → `tugcore::instance::base_data_dir()` (honors `TUG_DATA_DIR`) |
| Join execution | `tugdash-core/src/ops.rs` `join_in`, outcome type `JoinOutcome` (fields `strategy`, `commit`, `conflicts`, `previewed`, `blockers`) |
| Server join handlers | `tugcast/src/feeds/agent_supervisor.rs` `do_changeset_join` (~line 4908 region), `do_changeset_join_resolve` |
| Engine decision + wiring | `tugcast/src/feeds/base_motion.rs` — `DashInputs`, `decide_for_dash`, `evaluate_workspace` (assembles `DashReading` via `dash_detail_entries_in`), `read_autoreplay` (repo-wide `git config --bool tugdash.autoreplay`) |
| Branch-config convention | `branch.tugdash/<name>.{tugbase,tugplan,description}` in `tugdash-core/src/ops.rs` |
| Fixture | `tests/app-test/dash-fixture.ts` `createDash` (runs `tugutil dash create … --json` via the lock-retrying `tugutil()` helper) |
| App-test recipe | justfile `app-test *FILES:` |
| Lane landing face | `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx` — props include `turnInProgress`, `joinDisabledReason`; disabled+title pattern on Resolve/Join/Release/Adopt |
| Gate derivation | `tugdeck/src/lib/join-mode-controller.ts` `evaluateJoinLandGate`, `joinDisabledReason` |
| Button chrome | `tugdeck/src/components/tugways/internal/tug-button.css` (`:disabled` → `pointer-events: none`, opacity via `--tugx-control-disabled-opacity`) |
| NUL byte | `tugdeck/src/lib/changeset-verb-store.ts`, `verbKey` — a literal `0x00` in a template literal where `\x00` belongs |

---

### Specification {#specification}

#### S01 Dash-log route notes {#s01-dash-log-route}

The two terminal lines are spelled differently by their two writers, and the spec has to respect that. `ops.rs`'s join teardown writes `append_dash_log(repo_root, name, &short, "joined")` — **marker** is the squash's short SHA, **note** is the word `joined`. `release_in` writes `append_dash_log(&repo_root, name, "released", "")` — marker `released`, note empty. So the route suffix lands as: note `joined via card` / `joined via cli` for a join, and note `via card` / `via cli` for a release (whose marker already carries the word).

**This edit requires a companion change, and without it the plan breaks generation reset.** `dash.rs::is_terminal(marker, note)` is `marker == "released" || note == "joined"` — an **exact** equality on the note. `read_declarations` uses it to discard everything at or before a dash's last terminal line, and its own doc comment states the stake: "without that reset a name reused after a join would be born `audited`". Appending a suffix to the note makes `is_terminal` return false for every future join, so a reused dash name silently inherits the previous generation's declarations. `is_terminal` must therefore become a prefix match on the note (`note == "joined" || note.starts_with("joined ")`), pinned by a test that reuses a dash name across a route-suffixed `joined` line. The release side is unaffected — it is recognized by its marker.

Readers are otherwise positional: `split_log_line` does `splitn(4, "  ")` and trims, so a longer note stays parseable and `read_step_fields` (which reads only step-declaration notes) is untouched.

The origin string is threaded, not guessed. The idiomatic seam is the options struct that already exists: `join_in(repo_root, name, opts)` takes `JoinOptions`, which derives `Default`, so `origin` becomes a field on it rather than a fourth positional parameter — and the ~12 test construction sites in `ops.rs` that use struct literals will be found by the compiler. `release_in(repo_root, name)` has no options struct and takes the origin as a parameter. `tugutil`'s dash commands pass `"cli"`; `agent_supervisor`'s handlers pass `"card"`.

#### S02 Engine skip logging {#s02-engine-skip-logging}

`run_base_motion_engine`'s evaluation loop logs each non-acting decision once per wake at `debug!` level: dash name plus the `Skip` reason string already carried by `Decision::Skip(&'static str)`, or the opt-out ([P01]) as `skip: autoreplay-off (dash)`. Acting decisions already log at `info!` (`base-motion: replayed`, the conflict lines); those stay.

#### S03 Archaeology payload {#s03-archaeology-payload}

Additive field on `JoinOutcome` (`#[serde(default, skip_serializing_if = …)]`, matching the convention its `blockers` and `message` fields already use): per conflicted path, an ordered list of `{sha: String (short), subject: String}` for base commits since the merge-base touching that path, newest first, capped at 5, plus `total: u32`. Computed only when `previewed` and `conflicts` is non-empty.

The deck mirror does **not** live in `changeset-types.ts` — a grep for `conflicts:` there returns nothing. The join outcome's conflict list is parsed in `tugdeck/src/lib/changeset-verb-store.ts` and carried to the face through `tugdeck/src/lib/join-mode-controller.ts` (which holds `conflicts: readonly string[]` on both its input and snapshot types, and whose `deriveOutcome` reads `conflicts.length > 0`). Those two files are where the archaeology type is added; the landing face reads it from the same snapshot it already reads `conflicts` from.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Rationale |
|---|---|---|
| Refusal reason text | Derived at render from existing store state (gate inputs via `useSyncExternalStore`-backed stores) | No new state; [L02] untouched, [L06] — the reason is content, not appearance state |
| Turn-gate scope | Existing `turnInProgress` external-store read in `session-changes-view.tsx`; only which props consume it changes | No new state |
| Archaeology data | Server-computed, arrives in the join preview snapshot held by the existing join store | External state enters through the store's existing `useSyncExternalStore` path [L02] |
| Disabled appearance | CSS only (`tug-button.css`) | [L06] — appearance changes go through CSS, never React state |
| Discard confirm (`confirmingDiscard`) | Unchanged view-scope React state in the landing face | [L24] — a half-armed confirm is not something to remember; this plan does not touch it |

**Law cross-check.** [L02] — the archaeology payload enters through the join store's existing `useSyncExternalStore` path; no step reads external state directly, and no new store is introduced. [L06] — honored twice: Step 9 is CSS-only, and Step 8's refusal text is *content* derived at render from store state, not appearance state. [L13] — Step 9 must not hang the disabled look off an animation; motion is `TugAnimator`'s, and a background app-test window runs no rAF. [L24] — the one view-scope state on this surface is untouched. [L22] — not engaged; nothing here adds per-keystroke state. [L01]/[L03] — not touched.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Rust unit tests**: timestamp pins at known epochs ([P09]); the tripwire fires for a tempdir repo without `TUG_DATA_DIR` and stays quiet with it ([P03]); the engine's decision skips an opted-out dash ([P01], at the `decide_for_dash`/inputs layer in `base_motion.rs`'s existing test module); archaeology computation on a scratch repo with a known touching commit (S03, in `ops.rs`'s test module style — tempdir repos with `TUG_DATA_DIR` redirected, per the tripwire this same plan adds).
- **Existing-test updates**: at0425 pins the narrowed turn gate and the in-face refusal reason (it already drives a conflicted preview and asserts on the face); at0426 gains an assertion that the review-gate refusal reason is visible in the face.
- **Shell-observable checks**: the worktree guard's refusal text (run `just app-test-select` from a scratch worktree in the step checkpoint — select, not a full run); the dash-log route suffix after a fixture join.

#### What stays out of tests {#test-non-goals}

- No fake-DOM/RTL/jsdom render tests, no mock-store assertion tests, no reflexive per-mutator pins.
- No app-test exercising base motion itself (the corpus runs against the live repository; branch-motion coverage stays at the Rust layer in tempdir repos — established by the base-motion plan).
- No test that drives `tugutil dash join --resolve` anywhere (it lands; the ladder is covered by `resolve.rs`'s inline tests).

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The clock tells the truth | done | `b2a89afe1` |
| #step-2 | No NUL bytes in source | done | `35ed34988` |
| #step-3 | The projects dir stays clean | done | `1b02591db` |
| #step-4 | Every landing leaves a receipt | done | `8a054b15b` |
| #step-5 | The engine keeps its hands off opted-out dashes | done | `117ecd5c8` |
| #step-6 | The corpus refuses the wrong environment | done | `b8abed084` |
| #step-7 | The turn gate narrows to the two landing acts | done | `f0aacb540` |
| #step-8 | A refusal says why, in the face | done | `36faf8b8a` |
| #step-9 | Disabled looks disabled | done | `dbf87700b` |
| #step-10 | A conflict names its history | done | `d9bbc87ed` |
| #step-11 | Integration checkpoint | done | `3b1338f18` |

#### Step 1: The clock tells the truth {#step-1}

**Commit:** `tugutil-core(session): compute civil dates with a proven algorithm, pin the year`

**References:** [P09] timestamp algorithm, (#investigation-record, #seam-map)

**Artifacts:**
- Rewritten date conversion inside `now_iso8601` (`tugrust/crates/tugutil-core/src/session.rs`); `year_to_days` / `DAYS_TO_EPOCH` and the approximate-then-refine loop replaced by the days-to-civil conversion.
- Unit tests pinning known instants.

**Tasks:**
- [ ] Extract the seconds→(y,m,d,h,m,s,ms) conversion into a pure function of `(secs, nanos)` so it is testable without the system clock.
- [ ] Implement days-to-civil per the proven shape; delete `year_to_days` and `DAYS_TO_EPOCH` (keep `is_leap_year` only if still referenced).
- [ ] Confirm the two callers (`session.rs` record writes, `dash.rs::append_dash_log`) need no change.

**Tests:**
- [ ] Pins: `0 → 1970-01-01T00:00:00.000Z` (the pre-fix algorithm renders `1969-01-01`, so this pin alone falsifies the bug); `1786500000 → 2026-08-12T02:00:00.000Z` (verified with `date -u -r 1786500000`); a leap-day instant (`2024-02-29`) and the day after it, which is where the 365-day displacement stops looking like a clean year; a year-boundary instant (`Dec 31 23:59:59 UTC`); sub-second millis on at least one pin.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core`
- [ ] `tugrust/target/debug/tugutil dash list --json` still works, and a scratch `append_dash_log` exercised via the test suite stamps the current year (the pin tests are the proof; no live-log write needed).

---

#### Step 2: No NUL bytes in source {#step-2}

**Commit:** `tugdeck(changeset-verb-store): spell the verb-key separator as an escape, not a raw NUL`

**References:** (#seam-map), [P06] is unaffected — this is pure hygiene

**Artifacts:**
- `verbKey` in `tugdeck/src/lib/changeset-verb-store.ts` uses `"\x00"` instead of a literal byte.

**Tasks:**
- [ ] Replace the raw byte (offset ~8099, inside the template literal `` `${projectDir}<NUL>${dash}` ``) with the escape. Use `tugutil file edit` or a byte-safe editor path — `Edit` on a "binary" file may refuse.
- [ ] Sweep: `rg -uu --files-with-matches '\x00'` over `tugdeck/src`, `tugrust`, `tugproto/src`, `tugcode/src`, `tests` — fix any other source hit the same way.

**Tests:**
- [ ] Existing `changeset-verb-store` unit tests still green (`bun test tugdeck/src/lib/__tests__/changeset-verb-store-join.test.ts` and neighbors) — the key's runtime value is unchanged.

**Checkpoint:**
- [ ] `rg -n "verbKey" tugdeck/src/lib/changeset-verb-store.ts` returns text matches (the file is no longer binary to rg).
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 3: The projects dir stays clean {#step-3}

**Commit:** `tugdash-core(dash): refuse tempdir dash-log writes without TUG_DATA_DIR; sweep the pollution`

**References:** [P03] projects tripwire, (#investigation-record, #seam-map)

**Artifacts:**
- The debug-assertion tripwire in `append_dash_log`.
- A clean `~/Library/Application Support/Tug/projects/` (one real entry).

**Tasks:**
- [ ] Add the tripwire per [P03]: `repo_root` under `std::env::temp_dir()` (compare canonicalized — macOS `/var` vs `/private/var`) + `TUG_DATA_DIR` unset ⇒ `debug_assert!`-style panic naming the fix.
- [ ] Audit the workspace's existing tests that call dash ops on tempdir repos; add `TUG_DATA_DIR` redirection (tempdir-scoped, `#[serial]` where the plan's rule requires) to any that lack it — the tripwire will find them by failing.
- [ ] One-time sweep: remove `projects/` entries matching `-private-var-folders-*` / `-var-folders-*` (temp slugs by construction). Count before and after; report both.

**Tests:**
- [ ] Tripwire fires for a tempdir repo without `TUG_DATA_DIR`; quiet with it set (a `#[should_panic]` + a positive twin, in `dash.rs`'s test module).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (workspace-wide — this is the step that proves no test still writes to the live dir)
- [ ] `ls "$HOME/Library/Application Support/Tug/projects" | wc -l` unchanged by the test run.

---

#### Step 4: Every landing leaves a receipt {#step-4}

**Depends on:** #step-1

**Commit:** `tugdash(observability): route-attributed dash-log notes, join receipts in the tugcast log`

**References:** [P02] observability at call sites, S01 dash-log route, S02 engine skip logging, (#seam-map)

**Artifacts:**
- `join_in` / the release path in `tugdash-core/src/ops.rs` accept and record an origin.
- `tracing::info!` receipts in `do_changeset_join` / `do_changeset_join_resolve`; `debug!` skip lines in `base_motion.rs`.

**Tasks:**
- [ ] Add `origin` to `JoinOptions` and a parameter to `release_in` per S01; pass `"cli"` from `tugutil`'s dash commands and `"card"` from `agent_supervisor`'s handlers. The compiler finds the ~12 `JoinOptions` struct literals in `ops.rs`'s tests.
- [ ] **Widen `is_terminal` to a prefix match on the note** (S01). This is not optional bookkeeping — without it, a route-suffixed `joined` note stops ending a dash generation and a reused dash name inherits the prior generation's declarations.
- [ ] Add the two handler receipts: dash, outcome (clean/conflicted/blocked + blocker kinds), candidate/landed commit when present.
- [ ] Add the engine's per-wake `debug!` skip lines per S02.

**Tests:**
- [ ] A Rust test at the `join_in` layer asserts the dash-log line's note carries the origin (tempdir repo, `TUG_DATA_DIR` redirected per #step-3).
- [ ] A `read_declarations` test reusing a dash name across a route-suffixed `joined` line: the new generation starts with no declarations. This is the pin for the `is_terminal` widening, and it fails loudly if a later edit narrows the match again.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil -p tugcast`

---

#### Step 5: The engine keeps its hands off opted-out dashes {#step-5}

**Depends on:** #step-4

**Commit:** `tugcast(base-motion): honor a per-dash autoreplay opt-out; fixtures set it`

**References:** [P01] per-dash opt-out, [Q01] instance scoping (deferred), S02 engine skip logging, (#investigation-record)

**Artifacts:**
- The engine reads `branch.tugdash/<name>.tugautoreplay` during evaluation; `false` ⇒ skip before all other inputs.
- `dash-fixture.ts`'s `createDash` sets the key on every fixture dash.

**Tasks:**
- [ ] Read the per-dash key in the same blocking hop that assembles `DashReading` (`evaluate_workspace` in `base_motion.rs`), surfacing it as a `DashInputs` field consumed first by `decide_for_dash`.
- [ ] Skip logs per S02 (`autoreplay-off (dash)`).
- [ ] `createDash` in `tests/app-test/dash-fixture.ts` runs `git config branch.tugdash/<name>.tugautoreplay false` (through the existing lock-retrying helper) right after create returns.

**Tests:**
- [ ] `decide_for_dash`-layer test in `base_motion.rs`'s module: opted-out inputs decide `Skip` regardless of divergence.
- [ ] A `replay`-layer sanity is unnecessary — the engine never reaches `spawn_replay` for a skipped dash by construction; the decision test is the pin.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `just build-app`, then `just app-test tests/app-test/at0405-changes-dash-lane.test.ts` — and the project dash-log gains **no** `replayed` line for the fixture dash during the run.

---

#### Step 6: The corpus refuses the wrong environment {#step-6}

**Commit:** `app-test(harness): refuse runs from a dash worktree, naming the mechanism`

**References:** [P04] worktree guard, (#investigation-record)

**Artifacts:**
- The guard in the justfile `app-test` recipe preamble (shared by `app-test-changed`'s delegation).
- The root cause of the at0405/at0426 worktree failures, written into the refusal text and this plan's implementation notes.

**Tasks:**
- [ ] Root-cause first: from a scratch dash worktree, run at0405 once and identify the failing mechanism (candidate hypotheses: `tugutilPath` resolution vs the worktree's `tugrust/target`; dash-on-dash creation making the fixture's base a `tugdash/*` branch and changing lane labels; the app bundle serving `main`'s dist against worktree paths). Record the finding in the refusal message and as a comment at the guard.
- [ ] Implement the guard per [P04]: linked-worktree or `tugdash/*` HEAD ⇒ refuse with the reason + `TUG_APPTEST_ALLOW_WORKTREE=1` escape.

**Tests:**
- [ ] From a scratch worktree: `just app-test-select` (or the guard path of the recipe) prints the refusal and exits non-zero; with the env var set it proceeds to selection. Torn down in the same session.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0405-changes-dash-lane.test.ts` from the main checkout still runs (the guard does not misfire on the supported environment).

---

#### Step 7: The turn gate narrows to the two landing acts {#step-7}

**Commit:** `tugdeck(dash-lane): gate only Join and Release on a turn in progress`

**References:** [P05] turn-gate scope, R05, (#seam-map, #state-zone-mapping)

**Artifacts:**
- `session-changes-dash-landing.tsx`: `Resolve`, `Adopt`, `Leave` no longer disabled by `turnInProgress`; `Join`/`Release` unchanged.

**Tasks:**
- [ ] Drop the `disabled`/`title` pair from Resolve entirely — the expression is `disabled={turnInProgress}` with no other clause, and `resolveFace === "offer"` already governs whether it renders at all.
- [ ] Drop the turn clause from the adopt/leave frames' disable paths in `session-changes-view.tsx`.
- [ ] Leave `Join` (gated inside `evaluateJoinLandGate`), `Release` (`releaseHint`), and **`Resume teardown`** (`turnInProgress || joinPhase === "pending"`) gated — per [P05], Resume teardown completes a join and is the most base-mutating control on the face.
- [ ] Verify the composer join route's gate (`evaluateJoinLandGate`) is untouched — its turn input guards the *landing*, which stays gated.

**Tests:**
- [ ] at0425 asserts `Resolve` is clickable while a turn is in flight, driven end to end: the fixture already builds a bound card and a conflicted preview, so hold a real turn open and press Resolve, asserting the offer face leaves (the store's synchronous flip, which the test already knows how to observe). If the turn window cannot be held open reliably, **drop the assertion rather than substitute a mock** — a store-layer test asserting that a prop maps to a `disabled` attribute is a reflexive per-mutator pin, which is banned, and `tsc` already covers the prop's type.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0425-dash-conflicted-landing.test.ts`

---

#### Step 8: A refusal says why, in the face {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck(dash-lane): render refusal reasons in the landing face, retire dead titles`

**References:** [P06] in-face reasons, (#state-zone-mapping)

**Artifacts:**
- A visible reason line in the landing face when `Join` (or another control) is refused; dead `title`s on disabled lane controls removed.

**Tasks:**
- [ ] Render `disabledReason` (the existing `joinDisabledReason` product) as face text adjacent to the Join control; same for the turn-gate hint on `Release`.
- [ ] Remove `title={…}` from controls whose `disabled` state makes the title unreachable; keep titles on enabled controls where they still render.
- [ ] Reuse existing face text styling (the review block's prose row is the in-family precedent — the review gate's reason already reaches users only through it).

**Tests:**
- [ ] at0425: the conflicted outcome's refusal text ("Resolve the conflicts first") is asserted as visible face text, not via `title`.
- [ ] at0426: the review-gate refusal ("Review what the ladder resolved first") asserted the same way.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0425-dash-conflicted-landing.test.ts tests/app-test/at0426-dash-resolution-review.test.ts`

---

#### Step 9: Disabled looks disabled {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(tug-button): disabled filled buttons drop their fill`

**References:** [P08] disabled appearance, R01, (#seam-map)

**Artifacts:**
- Disabled-state rules for filled variants in `tug-button.css`.

**Tasks:**
- [ ] Add `:disabled` / `[aria-disabled="true"]` rules for the filled variants that remove the fill (transparent background, outlined border, dimmed text at the existing opacity token).
- [ ] Eyeball the lane with a whole cluster disabled — the calibration failure named in the brief is "no full-strength control adjacent".

**Tests:**
- [ ] Covered by the contrast audit and the two lane app-tests' style assertions. **Assert an un-animated property.** A mid-flight transition returns an interpolated `oklab(…)` and poisons the comparison; if the disabled state transitions, assert on a property the transition does not touch (or on the settled value after it completes). Motion itself stays out of React — [L13], and a background app-test window runs no rAF at all.

**Checkpoint:**
- [ ] `bun run audit:theme-contrast` (both halves; no theme exceeds the brio budget)
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 10: A conflict names its history {#step-10}

**Depends on:** #step-2, #step-8

**Commit:** `tugdash(archaeology): a conflicted preview names the base commits behind each path`

**References:** [P07] archaeology on preview, S03 archaeology payload, R02, (#seam-map, #state-zone-mapping)

**Artifacts:**
- The archaeology computation in `tugdash-core/src/ops.rs` on the conflicted preview path; the additive `JoinOutcome` field.
- Deck type mirror + rendering under each conflicted path in the expanded landing face.

**Tasks:**
- [ ] Compute per S03: `git log --format=%h%x00%s <merge-base>..<base> -- <path>`, newest first, cap 5, total count; only when `previewed && !conflicts.is_empty()`.
- [ ] Serialize additively (skip when empty); mirror the type in `tugdeck/src/lib/changeset-verb-store.ts` (where the outcome is parsed) and `tugdeck/src/lib/join-mode-controller.ts` (where `conflicts` is carried to the face) — **not** `changeset-types.ts`, which has no join-outcome fields.
- [ ] Render in the conflicted face: per path, `<sha> <subject>` rows, "+N earlier" past the cap.
- [ ] **Workspace-wide test compile** after the wire-type change (the base-motion checkpoint-gap lesson): every constructor of `JoinOutcome` in every crate's tests must build.

**Tests:**
- [ ] Rust: a scratch repo where the base gains two commits touching the conflicted path and one not — archaeology lists exactly the two, newest first (tempdir + `TUG_DATA_DIR`, per #step-3).
- [ ] at0425: the conflicted face shows at least one archaeology row naming the base commit its fixture creates.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (workspace-wide, per the wire-type rule)
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app`, then `just app-test tests/app-test/at0425-dash-conflicted-landing.test.ts`

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9, #step-10

**Commit:** N/A (verification only)

**References:** (#success-criteria)

**Artifacts:**
- A green, launchable build carrying all ten steps.

**Tasks:**
- [ ] Walk the success criteria (#success-criteria) one by one; each has a stated verification.
- [ ] Confirm the projects-dir count is stable across the full Rust run (criterion 3) and that no fixture dash drew a `replayed` line across the app-test runs (criterion 5).

**Tests:**
- [ ] The suites below are the test.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test` (`bun test` has one pre-existing red — the `layout-imposer-solutions` golden table, red on `main`. Do not regenerate it.)
- [ ] `just build-app`, then the app-test run. **Expect `app-test-changed` to refuse here with exit 3 — the selection blows its 20-file budget.** This plan's diff touches Rust, tugdeck, the justfile, and `tests/app-test/dash-fixture.ts`, and the fixture alone selects most of the dash corpus; the same refusal hit the base-motion run at 24 files. When it refuses, run the core tier (`just app-test`) plus the named lane files (`at0405`, `at0417`, `at0418`, `at0425`, `at0426`) rather than the full corpus. Do not pipe the output — the pipeline's exit status becomes the filter's, so a green run reads as a silent failure.

---

### Deliverables {#deliverables}

- Correct timestamps from `tugutil-core`, pinned; the dash-log's era discontinuity documented by this plan and the brief.
- A grep-visible `changeset-verb-store.ts` and a NUL-free source tree.
- A projects directory with one real entry and a tripwire that keeps it that way.
- Route-attributed dash-log lines and tugcast-log receipts for every landing; an engine whose silence is explicable at `debug!`.
- An engine that never touches an opted-out dash, and fixtures that opt out every dash they make.
- An app-test corpus that refuses a dash-worktree run with the mechanism named.
- A dash lane where `Resolve`/`Adopt`/`Leave` work mid-turn, every refusal states its reason in the face, disabled controls look disabled, and a conflicted path carries its base-side history.
