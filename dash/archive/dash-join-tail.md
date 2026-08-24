<!-- devise-skeleton v5 -->

## Dash/Join Tail {#dash-join-tail}

**Purpose:** Close the small items left standing after the dash/join arc landed — delete the orphaned dash-facts component, teach the injected conflict turn to verify the fit after its rebase, and stop capped review diffs from swallowing their own endings. Everything larger is cut by name into Non-goals with a pointer.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, fable.** Reviewed `plan:dbddda23fe3512b0`. Lint: 0 errors, 1 warning (PL023, cleared by this section). Oriented on: the whole document — first pass, same turn as devise. The review re-verified the plan's load-bearing claims against the tree rather than the devise notes: `dash-facts.tsx`'s only importer is `spike-dash-progress.tsx` and the shared review logic lives in `lib/dash-review.ts`; `compose_conflict_message` is IO-free with its caller (`compose_for`) already doing git IO, and `tugcast` already depends on `tugutil-core`, so [P02]'s split costs nothing; `DIFF_LINE_CAP = 400` takes head-only and the existing `resolve.rs` cap test asserts `+DRIVER` falls past the cap — the exact deficiency Step 3 inverts; the card-taxonomy pin is 13 (twelve spikes plus index), so deletion lands it at 12. Applied: commit-line convention — the three work steps carried crate-scoped subjects (`tugdeck(dash-tail)`, `tugcast(dash-tail)`, `tugdash-core(dash-tail)`), rewritten to the house round form `tugdash(dash-join-tail): …` that dash-entry-points' reviewed plan uses; Spec S02 — the elision marker now preserves the singular/plural handling the current marker has, so `N = 1` does not print "1 lines". Tuglaws cross-check: the plan introduces no frontend state (Step 1 is pure deletion), so no zone mapping applies and no React-state law is at risk; the taxonomy test is the drift gate the deletion moves; Step 4 follows [D149] (verify the fit, not a sweep). Test plan is at the right layers — Rust unit extensions in place, build gates for the deletion, no banned shapes. Deferred: nothing — the plan's one judgment call (which candidates survive triage) was asked and answered before authoring.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Five plans closed the dash/join arc: join-voice, dash-generality, unified-changes, join-landing-parity, and dash-entry-points — all five are joined on `main` (`e289fe517`, `a18557090`, `51bb1eaae`, `01a78ec28`, `31da0ece7`). What remains is the tail the archived closure brief (`dash/archive/dash-closure-brief.md` §4) predicted: small items each conceived during a larger campaign and parked. This plan is the triage the brief asked for — "landed or explicitly re-parked with an owner's decision, not by default." Six candidates were put to the owner by name on 2026-08-22; three stay (this plan's three work steps), three are cut into Non-goals with the reasoning recorded.

This is a closure sweep, not a campaign. Each kept item is one step with its own commit and checkpoint; nothing here designs a new surface.

#### Strategy {#strategy}

- Three independent work steps — a tugdeck deletion, a tugcast turn-text change, a tugdash-core diff-shape change — ordered cheapest-first, with no dependencies between them.
- Deletion before behavior changes, so the tree gets smaller before it gets different.
- Each behavior change extends an existing test in place rather than growing a new suite: the conflict-turn tests in `base_motion.rs` and the cap test in `resolve.rs` already pin exactly the behaviors these steps move.
- The Integration Checkpoint verifies the fit per [D149]; no terminal sweep.

#### Success Criteria (Measurable) {#success-criteria}

- `dash-facts.tsx`, `dash-facts.css`, and `spike-dash-progress.tsx` no longer exist; `bunx tsc --noEmit` and `bunx vite build` are green; the card-taxonomy spike pin matches the new count (Step 1's checkpoint).
- The injected conflict turn's text names the project's declared verify command and instructs running it over the replayed range; a project with no declaration produces a turn without the sentence (Rust tests, Step 2).
- A capped review diff shows its final lines: the existing `resolve.rs` cap test asserts the tail's `+DRIVER` line is present and an elision marker sits between head and tail (Rust test, Step 3).
- `tugutil dash replay` on this dash reports its outcome and the declared verify (`sh scripts/verify-fit.sh {base} {head}`) is green over the replayed range, or the replay reported `Current` (Step 4).

#### Scope {#scope}

1. Delete the orphaned `DashFactsRun`/`dash-facts.tsx` component, its CSS, and the spike that is its only importer.
2. Extend the injected conflict turn (`compose_conflict_message`, `tugcast/src/feeds/base_motion.rs`) with a fit-verification instruction sourced from the project's declared verify command.
3. Change `resolution_diff`'s cap (`tugdash-core/src/resolve.rs`) from head-only to head+tail with an elision marker.

#### Non-goals (Explicitly out of scope) {#non-goals}

Each of these was put to the owner by name on 2026-08-22 and cut:

- **A "joined" archaeology surface for browsing past landed dashes.** Today a landed dash's only trace is the squash commit on `main` (subject scoped `tugdash(<name>):`, body carrying `joined <sha> · <dash> → <base> · N round(s)` — composed in `tugcast/src/feeds/changeset.rs`, `format_join_receipt` region); `broadcast_dash_gone` (`tugutil/src/dash.rs`) sweeps every live face. A browsing surface needs either a persisted join record or a git-log-derived view — real design, more than a step or two. Cut with a pointer: a future plan of its own, starting from the question of whether the record should be derived from `git log` by scope or persisted at join time.
- **`--instance`/`--port` selection on `tugutil dash bind|unbind`.** `post_dash_api` (`tugutil/src/dash.rs`) already walks every live instance cwd-first, taking `unknown_session` as "not this one," so the multi-instance case works today; an explicit override flag is a convenience with no reported failure behind it. Cut until the walk demonstrably guesses wrong.
- **Queue-a-landing-for-turn-end** (from the closure brief's pull-driven tail). Mooted: the Changes shade's quiet-moment reveal (`session-card.tsx`, the effect gated on turn-in-flight / landing-up / non-empty composer / shade-showing) fires on its own the moment the turn settles, which is what this item wanted back when the join offer was a prompt. The prompt is gone; the standing offer cannot be missed at turn end. Cut as covered.

#### Dependencies / Prerequisites {#dependencies}

- All five predecessor plans joined on `main` (verified 2026-08-22; see Context).
- `.tugtool/config.toml` declares `verify = "sh scripts/verify-fit.sh {base} {head}"` — Step 2's instruction text and Step 4's checkpoint both lean on the declaration seam dash-generality built (`tugutil_core::config::DashConfig`).

#### Constraints {#constraints}

- Rust workspace enforces `-D warnings`; never commit red.
- `compose_conflict_message` composes with no IO by design — its docblock says so, and the callers' lock-holding context depends on it. Step 2 keeps that property: the caller loads the config, the composer receives a value.
- Frontend deletions must survive `bunx vite build`, not just `tsc` — the debug app loads the prod rollup bundle.

#### Assumptions {#assumptions}

- `spike-changes-dashes.tsx` mentions `dash-facts.tsx` only as a fixture-data string (a synthetic changed-file path), not an import; deleting the component does not touch it. Verified 2026-08-22.
- The shared review-mark logic (`dashReviewPaints`, `dashReviewTooltip`) lives in `tugdeck/src/lib/dash-review.ts` and is what shipping surfaces (`dash-sigil.tsx`, `tug-session-identity.tsx`, `dash-picker-sheet.tsx`) import — nothing shipping imports from `dash-facts.tsx`. Verified 2026-08-22.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The one triage question this plan needed — which candidates stay — was asked and answered before any step was written (see Context and Non-goals).

---

### Risks and Mitigations {#risks}

**Risk R01: Mid-hunk elision confuses a reader of the capped diff** {#r01-mid-hunk-elision}

- **Risk:** Cutting a unified diff between head and tail can land the marker mid-hunk, so the tail resumes without its hunk header and the `+`/`-` context reads unanchored.
- **Mitigation:** The marker line says plainly that lines were elided and how many (`… N lines elided …`), which is the same honesty the current tail-drop marker has; the counts (`added`/`removed`) remain git's over the whole diff, so the stat never lies.
- **Residual risk:** A reader who needs the elided middle still opens the file — which was already true, and the cap's docblock says the payload is for the shape of a change, not its entirety.

**Risk R02: The conflict turn's verify instruction goes stale against the config** {#r02-verify-staleness}

- **Risk:** The verify command is read when the turn is composed; if the project edits `.tugtool/config.toml` between injection and the agent acting, the instruction names the old command.
- **Mitigation:** The window is one agent turn on one machine; the instruction also names where the declaration lives, so a failed command leads the agent to the config rather than a dead end.
- **Residual risk:** Accepted — the same staleness applies to every fact in every injected turn.

---

### Design Decisions {#design-decisions}

#### [P01] The spike goes with the component (DECIDED) {#p01-spike-goes-too}

**Decision:** Step 1 deletes `spike-dash-progress.tsx` alongside `dash-facts.tsx`, rather than inlining a copy of `DashFactsRun` to keep the spike alive.

**Rationale:**
- The spike's subject — graphical treatments for dash step/progress — shipped (column badges, the dash sigil, the Lens dash rows). A spike has two exits, graduate or delete, and this one graduated long ago; the file outlived its question.
- Inlining the run would preserve dead exploration at the cost of a second copy of retired code.

**Implications:**
- The spike registry (`tugdeck/src/spikes/spike-registry.tsx`) loses the import and the `SPIKES` entry; the card-taxonomy spike-count pin (`tugdeck/src/__tests__/card-taxonomy.test.ts`, "the spike set is the twelve spikes plus their index", `expect(spikes.length).toBe(13)`) drops to 12 and the test's prose count is updated with it.
- A saved layout holding an open spike-dash-progress card drops that pane on next launch with a `[DeckManager] filterRegisteredCards` console warning — correct behavior, worth knowing.

#### [P02] The composer stays IO-free; the caller reads the config (DECIDED) {#p02-composer-io-free}

**Decision:** `ConflictMessage` gains a `verify: Option<String>` field carrying the project's declared verify command verbatim (placeholders intact); `compose_for` in `base_motion.rs` populates it by loading `tugutil_core::config::Config::load_from_project` against the dash worktree (`job.worktree_abs`), treating a load error or missing declaration as `None`.

**Rationale:**
- `compose_conflict_message`'s contract is "composing it needs no IO" — the field keeps that true while the caller, which already does git IO (`resolve_intent`), absorbs one config read.
- The worktree's committed copy of `.tugtool/config.toml` is the copy the run is about — the same root `tugutil dash config` resolves from a worktree cwd.

**Implications:**
- `tugcast` already depends on `tugutil-core` (workspace dep), so no Cargo change.
- A `None` verify produces a turn byte-identical in shape to today's plus nothing — the sentence only exists when there is a command to name.

#### [P03] The turn instructs verify after the replay records, using the replay's own range (DECIDED) {#p03-verify-after-replay}

**Decision:** The new instruction sits after the existing `tugutil dash replay <name> --json` sentence and tells the agent to substitute the replay JSON's reported range into the declared command's `{base}`/`{head}` placeholders and run it from the worktree.

**Rationale:**
- The turn is composed before the rebase, so the shas cannot be printed into it; the replay's JSON receipt is the one artifact the turn already instructs producing that carries both ends of the range.
- Verifying after `dash replay` means the fit check runs over exactly what the bookkeeping recorded — the same ordering the run-ending procedure uses ([D149]).

**Implications:**
- The instruction must name the placeholders explicitly ("substitute `{base}` and `{head}` from the replay's JSON"), because the command string rides verbatim with placeholders intact.
- A red verify is ordinary work in the worktree, and the turn says so in one clause — the same doctrine the Integration Checkpoint pattern states.

#### [P04] Head+tail split inside the same 400-line budget (DECIDED) {#p04-head-tail-split}

**Decision:** `resolution_diff` keeps `DIFF_LINE_CAP = 400` as the total budget but splits it: the first 300 lines, an elision marker line (`… N lines elided …`), and the last 100 lines. A diff at or under 400 lines is unchanged.

**Rationale:**
- The cap exists so a CONTROL broadcast stays bounded; splitting the same budget changes the payload's shape, not its size.
- The tail is where a rewrite's outcome lives — the existing cap test documents the deficiency by asserting the resolution's own `+DRIVER` addition falls past the cap, which is exactly the fact a reviewer needed to see.
- Head-heavy (300/100) because a diff's opening context orients the reader and hunk headers front-load; the tail only needs to show how it ends.

**Implications:**
- The existing marker text ("… N more lines") is replaced by the elision marker; the marker names the count of elided lines, which is `total − 400`.
- The test at the "cap should have bitten" site inverts: `+DRIVER` must now be present, and the marker must sit between head and tail.

---

### Specification {#specification}

**Spec S01: The conflict turn's verify sentence** {#s01-verify-sentence}

Appended to the resolve-sequence paragraph of `compose_conflict_message`, only when `verify` is `Some`:

```
After the replay records, verify the fit from the worktree: run
  <verify command verbatim, placeholders intact>
substituting {base} and {head} from the replay's JSON (`base_head` and the dash tip).
If it comes back red, fix it in the worktree as ordinary work and re-run it.
```

The exact wording may be tuned at implementation; what is contractual: the command appears verbatim with placeholders intact, the substitution source is named, the red-verify clause is present, and a `None` verify emits nothing.

**Spec S02: The elided diff shape** {#s02-elided-diff-shape}

For a patch body of `L` lines:

- `L ≤ 400`: the body verbatim (today's behavior, unchanged).
- `L > 400`: first 300 lines, then one marker line `… N lines elided …` where `N = L − 400` (singular `line` when `N = 1`, matching the current marker's care), then the last 100 lines.

`added`/`removed` counts remain git's `--numstat` over the whole diff in both cases.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

This plan adds no frontend state. Step 1 is pure deletion; Steps 2–3 are server-side. No zone mapping applies.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Pin the turn text and the diff shape | Steps 2 and 3 — both behaviors already have unit tests in place to extend |
| **Build gates** | Prove the deletion left no dangling reference | Step 1 — `tsc`, `vite build`, and the taxonomy test are the whole proof |

#### What stays out of tests {#test-non-goals}

- No app-test — nothing here changes a gesture, a face, or a flow an app-test could see. The deleted spike had no test; the turn text and diff cap are server-side facts pinned at the Rust layer.
- No new test file — every assertion extends a suite that already pins the behavior being moved (`base_motion.rs` message tests, `resolve.rs` cap test, `card-taxonomy.test.ts` spike pin).

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Delete the orphaned dash-facts component and its spike | done | `9c7bee71e` |
| #step-2 | The conflict turn instructs the declared fit check | done | `35baf3097` |
| #step-3 | Capped review diffs keep their tails | done | `597c58e87` |
| #step-4 | Integration Checkpoint | done | `597c58e87` |

#### Step 1: Delete the orphaned dash-facts component and its spike {#step-1}

**Commit:** `tugdash(dash-join-tail): delete the orphaned dash-facts run and its spike`

**References:** [P01] The spike goes with the component, (#context, #assumptions)

**Artifacts:**
- `tugdeck/src/components/lens/sections/dash-facts.tsx` — deleted.
- `tugdeck/src/components/lens/sections/dash-facts.css` — deleted.
- `tugdeck/src/spikes/spike-dash-progress.tsx` — deleted (its only importer).
- `tugdeck/src/spikes/spike-registry.tsx` — the `dashProgressSpike` import and its `SPIKES` entry removed.
- `tugdeck/src/__tests__/card-taxonomy.test.ts` — spike pin 13 → 12, test title's prose count updated.

**Tasks:**
- [ ] Confirm the orphan claim one more time at implementation: `grep -rn "dash-facts" tugdeck/src --include="*.tsx" --include="*.ts"` finds only the spike import and the inert fixture string in `spike-changes-dashes.tsx` (which stays untouched — it is data, not an import).
- [ ] Delete the four files/edits listed in Artifacts.
- [ ] Adjust the card-taxonomy spike pin and its title.

**Tests:**
- [ ] `bun test src/__tests__/card-taxonomy.test.ts` (from `tugdeck/`) — the pin proves the registry and the count moved together.

**Checkpoint:**
- [ ] From `tugdeck/`: `bunx tsc --noEmit`, `bunx vite build`, `bun test src/__tests__/card-taxonomy.test.ts` — all green.

---

#### Step 2: The conflict turn instructs the declared fit check {#step-2}

**Commit:** `tugdash(dash-join-tail): conflict turn runs the declared verify after rebase`

**References:** [P02] The composer stays IO-free, [P03] Verify after the replay records, Spec S01, (#constraints, #r02-verify-staleness)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/base_motion.rs` — `ConflictMessage` gains `verify: Option<String>`; `compose_conflict_message` appends Spec S01's sentence when `Some`; `compose_for`'s `Speak::Conflict` arm loads the config from `job.worktree_abs` and populates the field.

**Tasks:**
- [ ] Add the `verify` field and the Spec S01 sentence to `compose_conflict_message`, after the existing `dash replay` instruction and before the design-collision escape clause.
- [ ] In `compose_for`, populate it: `tugutil_core::config::Config::load_from_project(Path::new(&job.worktree_abs))` → `config.tugtool.dash.verify`, any error folded to `None`.
- [ ] Update the two existing message tests' fixture (`conflict_text()`) to pass a verify command, and keep the no-intent test passing `None` so it also pins the absent-declaration shape.

**Tests:**
- [ ] Extend `the_conflict_turn_says_where_it_stopped_and_how_to_finish`: with `verify: Some("sh scripts/verify-fit.sh {base} {head}".into())`, the text contains the command verbatim (placeholders intact), names the substitution source, and keeps the ordering — `dash replay` sentence before the verify sentence.
- [ ] New or extended test: with `verify: None`, the text contains no verify sentence — the turn is today's turn.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast base_motion` — green, no warnings.

---

#### Step 3: Capped review diffs keep their tails {#step-3}

**Commit:** `tugdash(dash-join-tail): capped review diffs keep head and tail`

**References:** [P04] Head+tail split, Spec S02, Risk R01, (#success-criteria)

**Artifacts:**
- `tugrust/crates/tugdash-core/src/resolve.rs` — `resolution_diff`'s capping arm rewritten per Spec S02; `DIFF_LINE_CAP` doc and the `ResolutionDiff.text` doc updated to describe the split.

**Tasks:**
- [ ] Rewrite the capping arm: collect the body's lines once, and when over 400, emit first 300 + `… N lines elided …` + last 100.
- [ ] Update the two doc comments that describe the cap as head-only.
- [ ] Rewrite the existing cap test (the one asserting `+DRIVER` falls past the cap, with its own self-warning that the assertion exists to cover truncation): it now asserts the marker line is present, `+DRIVER` **is** present in the tail, the head's opening lines are present, and the total line count is 401 (300 + marker + 100).

**Tests:**
- [ ] The rewritten cap test in `resolve.rs` (Spec S02's shape, both arms: over-cap elided, under-cap verbatim — add the under-cap assertion if no existing test pins it).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core` — green, no warnings.

---

#### Step 4: Integration Checkpoint {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `N/A (verification only)`

**References:** [P02], [P03], [P04], (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: run the declared verify — `sh scripts/verify-fit.sh {base} {head}` over the replayed range.
- [ ] `Current`: the base never moved; the last step's checkpoints already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree as ordinary work, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The dash/join tail is closed: the orphaned facts component is gone, an injected conflict turn finishes with the project's own fit check, capped review diffs show how they end, and the three larger candidates are re-parked by name with owner's decisions on record.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No file under `tugdeck/src` imports from `dash-facts`; the spike registry and taxonomy pin agree at 12 (build gates + taxonomy test, Step 1).
- [ ] `compose_conflict_message` with a declared verify names it per Spec S01; without one, the turn is unchanged (Rust tests, Step 2).
- [ ] `resolution_diff` over a >400-line patch returns head + marker + tail per Spec S02 (Rust test, Step 3).
- [ ] The fit is verified on the live base or correctly skipped as `Current` (procedure, Step 4).

**Acceptance tests:**
- [ ] The extended `base_motion.rs` message tests (Step 2).
- [ ] The rewritten `resolve.rs` cap test (Step 3).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A "joined" archaeology surface — its own future plan; see Non-goals for the starting question.
- [ ] `--instance`/`--port` bind targeting — reopen only on a demonstrated mis-guess by the instance walk.

| Checkpoint | Verification |
|------------|--------------|
| Deletion left nothing dangling | `tsc` + `vite build` + taxonomy test (Step 1) |
| Turn text contract | `cargo nextest run -p tugcast base_motion` (Step 2) |
| Diff shape contract | `cargo nextest run -p tugdash-core` (Step 3) |
| Fit on the live base | `dash replay` + declared verify (Step 4) |
