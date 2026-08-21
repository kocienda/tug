<!-- devise-skeleton v5 -->

## Join Endgame Workflow {#join-endgame-workflow}

**Purpose:** The join arc arms itself from recorded machine facts — a declared step selection completing, or a plan-less round landing — instead of waiting for an agent to remember `dash mark built`. A run that forgets every chore still ends with the join prompt raising on the bound session, showing the exact message the join will land with and where that message came from.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-20 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-20, opus.** Reviewed `plan:f4647ca6c612c112`. Lint: 0 errors, 0 warnings, clean before and after.
Oriented on: the whole document — a first round, with no prior stamp to diff against.
Applied: the round's central finding is that the plan deleted the server's `built` gate and missed the client's three copies of it. `tugdeck/src/lib/dash-join-register.ts` returns `null` unless `stage === "built"`, so the join register would have gone dark on all three [D143] surfaces — the Lens row, the shade lane, the session masthead — while the modal fired; the same file's no-verdict beat keys on `built` again, and `dash-meta-line.tsx`'s `STAGES_PAST_THE_WALK` decides whether `implementing (8/8)` reads as a finished walk. That is a face contradicting the arc, and it was invisible from the plan alone. Raised as a dialog; the user chose a derived `ready` stage word over a parallel boolean, now [P07], with Spec S02 fixing its precedence position (above the `Step` arm, below `built`/`audited`) and new Spec S04 tabulating the four client sites. Second finding: removing the gate widens the pilot's population from "explicitly marked" to "every dash with a round", and its attempt mark is keyed on the head pair — so one commit on the base re-fires Tier 0 (`cargo check --workspace --all-targets` here) for every such dash at once. Asked; the user scoped the pilot to dashes bound to a live session, now [P08], with the predicate gaining `bound: bool` and `pilot_action` moving out of the `spawn_blocking` closure into the async dispatch loop where `bound_sessions_by_dash()` is already in scope. That decision then broke at0445 as written — line 249 waits for the *unbound* dash's register to reach `ready`, which a bound-only pilot can never satisfy — so Step 8 now names that wait, says why it must become a bounded negative assertion, and removes the second `markDashBuilt` (which would otherwise arm the dash the claim needs unarmed). Also: verified and rewrote the watcher assumption rather than trusting it — `.tug/` is gitignored, which looked fatal until `file_watcher.rs` proved events flow unfiltered; added Risk R03 (a run dying mid-selection strands finished work) and R04 (closing the last bound card stops the pilot); noted that the 2 s probe arm is gated `if self.ledger.is_some()` and the dash-log stat must not inherit that gate; added the laws cross-check (#laws-cross-check), naming [L02], [L06], [L11], [L19], [L20], [L31] and why [L31] is the plan's spine; and extended Steps 2, 4, 6, 8 and 9 with the work all of the above implies.
Deferred: nothing. [Q01]–[Q03] arrived already decided, and both questions this round raised were settled in the dialog rather than filed.

**Round 2 — 2026-08-20, fable.** Reviewed `plan:95d15b397bab7416`. Lint: 0 errors, 0 warnings, clean before and after.
Oriented on: the Review Record — the plan was tracked and clean at round start (the stamped round-1 document is committed at `cb0487d21`), so there was no diff to read; this round re-read the whole document against the code on a different model.
Applied: four corrections, all from re-reading the code rather than the plan. First, `status_in` (`ops.rs`) computes only the untracked-inclusive `worktree_dirty` — Step 2's claim that every `derive_stage` call site already holds the inputs was true for `dash_detail_entries_in` (which calls `dirty_tracked_paths`) but not there, and an implementer following it as written would feed untracked dirt into `join_ready` and make `dash status` disagree with the feed over a scratch file — the exact case [P04]'s tracked-dirt distinction excludes; Step 2 now names the extra `dirty_tracked_paths` call and that it sits on the CLI path, off the recompute. Second, `dash_detail_entry_in` is a find-wrapper delegating to `dash_detail_entries_in`, not a third composition site — Step 2's task and artifact no longer send anyone hunting for one. Third, `standing_prompt`'s user-visible question copy opens `"{name} is built, reconciled with …"` in both variants — a resting lie for a dash that arms without ever building; Step 4 gains the rewrite to readiness terms (the "joined tree builds" half is Tier 0's fact and stays), held to the same [L31] bar as the provenance work. Fourth, `integrate_message` has five named tests, not six. Also verified rather than asserted: the [P06] probe's enumeration path exists (`ChangesetAllFeed.registry.project_dirs()` + `tugutil_core::project_state_dir`, with the crate dependency already in `tugcast/Cargo.toml`) — now recorded in the decision so a cold reader need not re-derive it; and re-confirmed round 1's central claims against the source (the three client `built` gates at `dash-join-register.ts`, `STAGES_PAST_THE_WALK`, at0445's `markDashBuilt` pair and its line-249 unbound wait, `pilot_action` inside the `spawn_blocking` closure with `bound_by_dash` already on the async side).
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

On 2026-08-20 a `dash-implement` run walked steps 6–8 of a plan on the `imposer-polish` dash. Every step committed, every ledger row flipped to `done`, the join draft was written — and no join offer ever appeared, because the run never executed the skill's phase 3 and so never ran `tugutil dash mark <name> built`. The server-side join pilot's first gate is `stage == "built"` (`pilot_action` in `tugrust/crates/tugcast/src/feeds/join_pilot.rs`), and the standing prompt has the identical gate (`standing_prompt` in `tugrust/crates/tugcast/src/feeds/join_board.rs`), so the entire [D142] arc sat dark behind one unmade declaration. The brief is `roadmap/join-endgame-workflow-brief.md`; its principle: **skills narrate; verbs record; the server derives.** Nothing the user experiences may depend on a skill executing chores.

The user settled the two design questions during devise (they are recorded as [P01] and [P02], with the asks noted in [Q01]–[Q02]): completion is *declared knowledge plus ledger arithmetic*, never a quiet-window timer. The run's step selection becomes a recorded fact (`dash step start … --through <m>`, refused without it), and `dash step done <m>` is the exact completion event. Plan-less dashes arm on every committed round.

#### Strategy {#strategy}

- Make the selection durable at the only moment it is guaranteed to exist: the step verb the run cannot walk without. A required flag on a mandatory verb has the same forced-by-the-work property as the verbs themselves.
- Derive joinability in `tugdash-core` where every input already lives (dash-log declarations, rounds, worktree dirt), expose it on `DashDetail`, and key both the pilot and the prompt off it. `mark built` survives as telemetry that *also* arms — the manual/legacy path, gating nothing new.
- Grow the prompt payload with the landing message and its provenance so a forgotten draft is visible before the join, not after.
- Rewrite the two skills last, to narration and prose only, once the machine no longer needs them for anything but the draft.
- Bottom-up sequencing: tugdash-core facts → tugcast predicate/prompt → wire + sheet → skills → app-test pins → doctrine.

#### Success Criteria (Measurable) {#success-criteria}

- A scratch dash driven purely by `dash step start --through` / `dash commit` / `dash step done` — with `dash mark` never invoked — raises the join prompt on its bound session (at0445's new no-mark path passes).
- A plan-less scratch dash raises the prompt after its first committed round with a clean worktree, with `mark` never invoked (Rust unit tests on the readiness derivation + at0445).
- `tugutil dash step start <name> <n>` without `--through` exits 1 with a message naming the flag (CLI unit test).
- The prompt payload carries the landing message and a provenance of `draft`, `description`, or `fallback`, and the sheet renders both; a dash with no draft shows its provenance visibly (unit tests + the at0445 provenance pin).
- A dash mid-selection (latest step declaration is a `step-start`, or `done` short of the declared `--through`) never arms (unit tests on `pilot_action` and the readiness fn).
- A joinable dash reads stage `ready`, and its join register renders on the Lens row, the shade lane, and the masthead rather than returning null (Rust `derive_stage` test + the `dashJoinRegister` table test).
- A ready but **unbound** dash is never piloted (`pilot_action(true, false, …) == None`), and at0445's unbound dash never reaches a green register.
- `cargo nextest run` green under `-D warnings`; `bunx tsc --noEmit` and `bunx vite build` exit 0.

#### Scope {#scope}

1. `tugdash-core`: the declared-run fact (`--through`), its dash-log grammar, and the derived join readiness on `DashDetail`.
2. `tugdash-core`: landing-message preview with provenance, sharing `integrate_message`'s precedence.
3. `tugcast`: `pilot_action` and `standing_prompt` re-keyed off readiness, the pilot scoped to bound dashes; the prompt payload grows message + provenance; the 2 s probe learns to observe dash-log writes.
4. `tugutil` CLI: the `--through` flag, required, with a refusal that names the fix.
5. `tugdeck`: the three stage-keyed surfaces learn `ready`; wire mirror + the prompt sheet renders the message and its provenance.
6. `tugplug`: `dash-implement` and `dash-on` SKILL.md rewritten to narration and prose.
7. Tests: Rust unit coverage of every new derivation; at0445 gains the no-mark and provenance pins.
8. `tuglaws/design-decisions.md`: [D146], amending [D142].

#### Non-goals (Explicitly out of scope) {#non-goals}

- The one-decision UX: Join now / Review first / Not yet, the decision-keyed re-ask policy, and the `branch.tugdash/<n>.tugjoinprompted` mark are untouched.
- The composer ⬆ as the one join door; `/join <name>` as the gesture.
- The candidate/strategy separation and the squash guarantee ([D144]).
- Occupancy, blockers, question/stuck yields, the head-pair attempt mark — every existing pilot restraint stays.
- `dash commit` mechanics, the round format, and the plan ledger format.
- Any timer, quiet-window, or quiescence heuristic — explicitly rejected during devise (see [Q01]).

#### Dependencies / Prerequisites {#dependencies}

- The shipped [D142] arc: `join_pilot.rs`, `join_board.rs`, the prompt sheet, at0441/at0445.
- `tugutil plan` ledger parsing (`tugutil_core::plan`) — read-only dependency; the ledger format does not change.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- `pilot_action` stays pure over values the recompute already holds — no new git subprocesses on the recompute's hot path (the module's own doctrine, kept).
- The dash-log is append-only and its grammar has exactly one reader (`split_log_line` / `read_declarations`); new markers must parse as ordinary lines under the existing splitter and be ignored by older readers.
- App-tests run selectively via `@covers` (`just app-test-changed`); output is never piped.
- Skill files in `tugplug/` run from the app bundle — repo edits are inert until rebuild; live testing requires copying into the bundle.

#### Assumptions {#assumptions}

- No caller of `dash step start` exists outside the two skills and hand invocations; making `--through` required breaks no machinery (verified: `ops::step_start` callers are the CLI in `tugrust/crates/tugutil/src/dash.rs` and tests).
- Dash worktrees under `.tug/worktrees/` are inside the watched workspace root, so plan-ledger edits and round commits already bump the CHANGESET_ALL recompute. **Verified specifically**, because `.tug/` is gitignored and the obvious worry is that ignored paths are filtered out: `feeds/file_watcher.rs` states and implements "gitignore filtering is NOT done here — events flow through unfiltered" (`convert_event` relativizes and emits without consulting the matcher), and `feeds/git_watch.rs` pings the process-global bump on **every** batch. Only `EventKind::Modify(ModifyKind::Data(_))` counts as a modification — metadata-only touches are dropped — which is fine for real writes but means a `probe`-style mtime restore is invisible.
- The 2 s drafts-version probe in `feeds/changeset_all.rs` already turns out-of-process `tugutil draft set` writes into bumps, so a late-written draft refreshes the standing prompt's message without new plumbing (see [Q03]).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Quiescence window (OPEN → DECIDED) {#q01-quiescence-window}

**Question:** The brief asked how long after the last round the pilot may act, and where the quiet is measured.

**Resolution:** DECIDED (see [P01]) — the user rejected the premise during devise: *"We know from the user's prompt what steps they asked to run, and we should know from the telemetry what steps are done."* There is no window. Completion is the declared selection's final step going `done`; no timing enters the derivation anywhere in this plan.

#### [Q02] `dash-on` parity (OPEN → DECIDED) {#q02-dash-on-parity}

**Question:** Plan-less dashes have no ledger — what arms them?

**Resolution:** DECIDED (see [P02]) — asked during devise; the user chose "every round arms." Each `dash commit` that lands a round with a clean worktree is itself the completed unit of asked work. A premature offer self-corrects when the next round moves the head (the request id changes, the stale candidate demotes), and "Not yet" still silences by decision.

#### [Q03] Prompt refresh on a late draft (OPEN → DECIDED) {#q03-late-draft-refresh}

**Question:** When a draft is written after the prompt was raised, does the standing prompt re-derive its shown message?

**Resolution:** DECIDED — settled from the code, no ask needed. `standing_prompt` re-derives the whole prompt on every recompute, and the 2 s drafts-version probe (`MAX(updated_at)` over `changes.changeset_drafts`, `feeds/changeset_all.rs`) fires the bump on out-of-process draft writes. A late draft therefore updates the shown message within ~2 s by construction. Step 5 pins it with a unit test (write description-only → prompt says `description`; write draft → recompute → prompt says `draft`).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Mid-run offers on multi-round plan-less dashes | low | med | Decision-keyed re-ask; offer self-retracts on next round | Users report prompt churn on `dash-on` |
| Tier 0 cost per plan-less round | med | med | Bound-only pilot ([P08]); head-pair mark bounds to once per pair; Tier 0 only after a candidate exists | Build noise on a machine with several bound dashes |
| Legacy in-flight dashes stay dark | low | high (once) | `mark built` still arms — the documented manual unblock | — |
| `--through` breaks an unknown caller | low | low | Refusal names the flag; skills updated in the same plan | A refused step in the wild |
| A run dies mid-selection; the work is done but undeclared | med | low | `/join <name>` and `mark built` both still work | Reports of stranded finished work |
| Closing the last bound card stops the pilot | low | med | Rebinding re-enters it on the next recompute | Users see a dash stop advancing after closing a card |

**Risk R01: A plan-less dash offers while the agent is still working** {#r01-midrun-offer}

- **Risk:** Between rounds of a multi-round `dash-on` run the worktree is briefly clean, so the pilot reconciles and may raise the prompt before the run is really over.
- **Mitigation:** The next round moves the dash head: the candidate demotes as stale, the request id changes, and an unanswered sheet closes with the fact. "Not yet" is keyed to the decision, so it never nags. Accepted explicitly by the user ([Q02]).
- **Residual risk:** One wasted reconcile + Tier 0 per landed round on a dash the user isn't ready to join; bounded by the head-pair mark.

**Risk R03: A run that dies mid-selection strands finished work** {#r03-interrupted-selection}

- **Risk:** An agent walking steps 6–8 that crashes after `done(7)` leaves `run_complete` false forever. The work is committed and the worktree clean, but nothing arms — the incident's own shape, in a narrower case.
- **Mitigation:** Honest by construction (the selection genuinely did not finish), and both escapes stand: `/join <name>` at any time, `tugutil dash mark <name> built` to arm. A resumed run's next `step start … --through` re-declares and the completion arithmetic picks up.
- **Residual risk:** A user who never resumes and never looks sees no offer. Accepted: the alternative is arming on incomplete work, which is the false-positive this design refuses.

**Risk R04: Closing the last bound card stops the pilot** {#r04-unbound-goes-quiet}

- **Risk:** [P08] scopes the pilot to dashes bound to a **live** session, so closing the last card bound to a dash — or a tugcast restart before the card reconnects — takes it out of the pilot's population mid-arc.
- **Mitigation:** Reopening/rebinding re-enters it on the next recompute, and no durable fact is lost (the candidate, verdict, and marks all persist in git config). `/join <name>` is unaffected.
- **Residual risk:** A reconcile in flight when the card closes finishes (occupancy holds it); the *next* one waits for a binding.

**Risk R02: Dashes created before this change never declare a run** {#r02-legacy-dashes}

- **Risk:** A plan-driven dash whose generation predates `--through` (e.g. `imposer-polish` today: steps 6–8 `done`, no declared run) has step declarations but no `run-through` line, so it derives as an incomplete run and stays dark.
- **Mitigation:** `built`/`audited` declarations still arm ([P03]); `tugutil dash mark <name> built` is the one-line manual unblock, and `/join <name>` works regardless. Recorded in [#rollout].
- **Residual risk:** None once the next selection runs under the new verb.

---

### Design Decisions {#design-decisions}

#### [P01] The selection is declared through the step verb, and completion is ledger arithmetic (DECIDED) {#p01-declared-selection}

**Decision:** `tugutil dash step start <name> <n>` requires `--through <m>` — the final step of the run's resolved selection. The verb refuses without it. `dash step done <k>` with `k >= m` (against the latest declared `m`) is the completion fact that arms the join arc. No timer, window, or quiescence heuristic exists anywhere in the derivation.

**Rationale:**
- The skill already resolves "Steps 6–8" into a concrete list in its Setup phase — before it can walk anything — so the declaration costs nothing it doesn't already have.
- A required flag on a verb the run cannot skip has the same forced-by-the-work property that makes the verbs trustworthy: forgetting is a refused command, not a silent dark arc.
- The user rejected timing outright during devise ([Q01]): known intent + recorded telemetry, deterministically compared.

**Implications:**
- New dash-log marker (`run-through`, Spec S01), new `DashDeclarations`/`DashDetail` fields, a CLI flag change, and both skills updated to pass the flag.
- Single-step runs declare `--through <n>` (the step itself); whole-plan runs declare the ledger's last step number.

#### [P02] A plan-less dash arms on every committed round (DECIDED) {#p02-planless-every-round}

**Decision:** A dash whose current generation has no step declarations is joinable whenever it has ≥1 round and no uncommitted tracked changes. Every `dash commit` is treated as the completed unit of asked work.

**Rationale:**
- There is no ledger to compare against, and inventing a wrap-up verb reintroduces a forgettable chore — the exact failure this plan removes.
- Deterministic and timer-free; a premature offer self-corrects (Risk R01). Confirmed by the user ([Q02]).

**Implications:**
- The readiness derivation must distinguish "plan-driven, run incomplete" (dark) from "plan-less" (armed) by the presence of step declarations, not by `plan_path`.

#### [P03] `mark built`/`audited` still arm; they gate nothing (DECIDED) {#p03-mark-still-arms}

**Decision:** The `stage == "built"` *gate* dies in both `pilot_action` and `standing_prompt`, but a `built` or `audited` declaration remains a sufficient arming condition inside the readiness derivation.

**Rationale:**
- It is the manual unblock for legacy dashes (Risk R02) and the hand-driven "I say it's done" gesture; keeping it costs one `||` arm.
- Deleting it would strand every in-flight dash and remove the only human override.

**Implications:**
- `mark`'s CLI and dash-log line are untouched; only what reads the derived stage changes.

#### [P04] Joinability is derived once, in tugdash-core, and exposed on `DashDetail` (DECIDED) {#p04-derive-in-core}

**Decision:** A pure function in `tugdash-core` computes join readiness from the declaration set + rounds + tracked worktree dirt, and `dash_detail_entries_in` stamps it onto `DashDetail` as `join_ready: bool`. `pilot_action` and `standing_prompt` read that bool.

**Rationale:**
- Every input is already in the detail composition's hands — no new git subprocess on the recompute hot path (the join_pilot module's own performance doctrine, preserved).
- One derivation, three readers (pilot, prompt, and any future surface) — the [D123] one-resolver shape.

**Implications:**
- `pilot_action(stage: &str, …)` becomes `pilot_action(join_ready: bool, bound: bool, state: &DashJoinState)`; its `stage != "built"` first line is replaced by `!join_ready` ([P08] supplies the second gate). The `joining` stage is excluded inside the derivation (a joining dash is never "ready" — it is landing).
- The same bool feeds `derive_stage`'s new `ready` arm ([P07]), so the word a face shows and the fact the pilot acts on cannot disagree — one derivation, one truth.
- Tracked dirt (`worktree_dirty_tracked`), not `worktree_dirty`: the join preamble commits tracked dirt, and an untracked scratch file must not hold the arc hostage — the same distinction the join blockers already draw.

#### [P05] The prompt shows the landing message and its provenance (DECIDED) {#p05-prompt-provenance}

**Decision:** `DashJoinPrompt` grows `message: String` (the subject+body the join would land with, trailers omitted) and `message_source: String` ∈ {`draft`, `description`, `fallback`}, composed server-side from the same precedence `integrate_message` applies. The sheet renders both; a non-`draft` source is visibly annotated.

**Rationale:**
- `integrate_message`'s silent fallback (draft → branch description → "Dash work") means a forgotten draft lands a join with the wrong words and the user finds out afterward. Visibility turns the failure from silent to bounceable — the brief's move 3.
- Server-composed for the same reason the options are: the durable fact and the rendered one are the same bytes.

**Implications:**
- A shared helper in `ops.rs` so the preview and the landing cannot drift (Spec S03); wire mirror + sheet rendering; an at0445 pin.

#### [P06] The recompute observes dash-log writes through the existing 2 s probe (DECIDED) {#p06-dashlog-probe}

**Decision:** The `feeds/changeset_all.rs` 2 s probe additionally stats each open workspace's `dash-log.md` mtime and fires the existing bump when it moves.

**Rationale:**
- The dash-log lives under the data dir (`project_state_dir` → `base_data_dir()/projects/<slug>`, verified), outside the watched workspace root, so a log-only write (`dash mark`, and the `run-through` line if written alone) reaches no watcher today. The step verbs and commits happen to bump via their worktree side-effects; the mark path is a real hole — the manual unblock in Risk R02 must actually raise the prompt.
- Same doctrine as the drafts probe: the event is real, only its observation is polled.

**Implications:**
- One `stat` per open workspace per 2 s; the probe tick itself still never recomputes without a change. The enumeration is in hand: `ChangesetAllFeed` already holds `registry: Arc<WorkspaceRegistry>`, whose `project_dirs()` yields each open workspace root, and `tugutil_core::project_state_dir(root)` (tugcast already depends on the crate) resolves the `dash-log.md` path — verified 2026-08-20.
- The existing probe arm is gated `if self.ledger.is_some()` (it exists to poll the drafts table). The dash-log stat must not inherit that gate — split the arm or drop the guard for the log half, so a harness without a ledger still observes marks.

#### [P07] A joinable dash reads `ready` — a derived stage word, not a second parallel fact (DECIDED) {#p07-ready-stage}

**Decision:** `derive_stage` gains a `ready` arm, returned when the dash is join-ready and has declared neither `built` nor `audited`. The three client surfaces that key on the stage vocabulary learn the word; nothing else changes.

**Rationale:**
- The client already carries its own copy of the `built` gate, in three places the plan's first draft missed entirely: `tugdeck/src/lib/dash-join-register.ts` returns `null` unless `stage === "built"` (so the join register would go dark on the Lens row, the shade lane, and the session masthead — all three [D143] surfaces — while the modal fired), the same file's no-verdict beat keys on `built` again, and `dash-meta-line.tsx`'s `STAGES_PAST_THE_WALK` decides whether `implementing (8/8)` reads as a finished walk or as step eight still being worked. Removing the server gate without these leaves a face that contradicts the modal.
- The stage word is the fact every dash display already consults, so one word fixes all of them at once — versus a parallel boolean each surface must additionally learn.
- The vocabulary already agrees: `dash-join-register.ts` prints the word `ready` for a green Tier 0. `built` is deliberately *not* reused: the brief's move 4 decouples the debug build from the join, so re-welding the word to "joinable" would make it lie in the other direction.
- `DASH_STAGE_ICONS` falls back to `Sprout` for an unrecognized stage, so an older client meeting a `ready` entry degrades to a glyph rather than an error.

**Implications:**
- `derive_stage` precedence becomes `joining > built|audited declared > ready > step declared (implementing) > draft-ready > working > created` (Spec S02). The `ready` arm must sit **above** the `Step` declaration arm — a completed run's latest declaration is a `step-done`, which would otherwise return `implementing` forever — and **below** `built`/`audited`, so an explicitly marked dash keeps its own word.
- `derive_stage` gains a `join_ready: bool` parameter; every call site already computes the inputs.
- Client: one entry in `DASH_STAGE_ICONS`, one in `STAGES_PAST_THE_WALK`, and both `dash-join-register.ts` gates accept `ready` alongside `built` (Spec S04).
- The pilot and the prompt still gate on the `join_ready` **bool**, not on the word — a dash declared `built` reads stage `built` and is join-ready, so a word test would miss it.

#### [P08] The pilot works only for dashes bound to a live session (DECIDED) {#p08-bound-only-pilot}

**Decision:** `pilot_action` gains a `bound: bool` and returns `None` for an unbound dash. Reconcile and Tier 0 happen eagerly only where the answer can be offered.

**Rationale:**
- Removing the `built` gate widens the pilot's population from "dashes somebody explicitly declared finished" to "every dash with a round and a clean worktree", and the attempt mark is keyed `<base_sha>:<dash_head>` — so a single commit on the base re-qualifies *all* of them at once. Tier 0 in this repository is `sh scripts/verify-tier0.sh`, which runs `cargo check --workspace --all-targets` for any candidate touching `tugrust/`. Unbounded, an ordinary commit on `main` becomes N workspace builds.
- The verdict would be spent on nobody: the prompt raises only on a card whose session is bound to the dash (`join-prompt-sheet.tsx`'s reach rule, pinned by at0445). An eager Tier 0 on an unbound dash produces a green nobody is asked about.
- Nothing is lost: `/join <name>` reconciles and verifies on demand, and binding a card re-enters the dash into the pilot's population on the next recompute.

**Implications:**
- `bound_sessions_by_dash()` is already read in `dash_entries` before the blocking hop. Compute `pilot_action` on the **async** side, in the existing dispatch loop where that map is already in scope, rather than inside the `spawn_blocking` closure — the predicate is pure and cheap, so moving it out costs nothing and avoids cloning the map into the closure.
- `standing_prompt` needs no boundness gate of its own: with no pilot there is no candidate and no settled verdict, so it returns `None` on its existing gates. The prompt fact stays a property of the dash rather than of a card.
- Boundness is over **live** sessions, so closing the last card bound to a dash stops its pilot (Risk R04).
- at0445's unbound-dash claim changes shape — see (#step-8).

---

### Deep Dives {#deep-dives}

#### How the pieces sit today (investigation record) {#current-machinery}

For a cold reader — everything below was verified against the code on 2026-08-20:

- **The predicate:** `pilot_action(stage, state)` in `tugrust/crates/tugcast/src/feeds/join_pilot.rs`. Ordered gates: `stage != "built"` → None; `state.run.is_some()` → None; blockers → None; question/stuck → None; no candidate → `Reconcile`; Tier 0 absent/`unrun` → `CheckTier0`; else None. It is pure by module doctrine; the dispatch (`run_dispatch`) owns occupancy and the head-pair attempt mark (`branch.tugdash/<n>.tugjoinpilot`, written *before* the run).
- **The prompt:** `standing_prompt(repo_root, detail, verification, quiet)` in `feeds/join_board.rs`, first line `if detail.stage != "built" || !quiet { return None; }` where `quiet = run.is_none() && question.is_none() && stuck.is_none()` (composed in `join_state_for`). It then requires a settled Tier 0 (`green`→`clean`, `red`→`red`), compares the decision against `verify::read_prompt_mark`, and builds `DashJoinPrompt { request_id: "<name>:<base>:<head>:<decision>", … }` with three server-composed options.
- **The call site:** `dash_entries` in `feeds/changeset.rs` — one `spawn_blocking` hop composes `DashDetail` + `DashJoinState` + `pilot_action` per dash; the async side dispatches pilots after the hop.
- **Recompute triggers:** a process-global `Notify` (`changeset_all_bump`) pinged by every workspace FileWatcher batch (`feeds/git_watch.rs` — batches flow unfiltered, `.git` and `.tug` included), by ledger/registry hooks, and by a 2 s drafts-version probe in `feeds/changeset_all.rs` (`BUMP_FLOOR` 150 ms coalescing). There is no general poll.
- **The dash-log:** `<data-dir>/projects/<key>/dash-log.md`, append-only, four two-space-separated fields (`split_log_line` in `tugdash-core/src/dash.rs`). Writers: `created`, `step-start`/`step-done` (note `i/N <tail>`; start tail `Step {i}: {title}`, done tail the round's short sha), `built`/`audited`, `replayed`, round commits (marker = short sha, from `ops::commit`), terminal lines (`discarded`/`released`/note `joined…`). `read_declarations` folds a generation into `DashDeclarations { latest, step, step_title, last_replay, last_activity }`; unknown markers date the dash but declare nothing — which is what makes a new marker backward-safe.
- **Stage:** `derive_stage(rounds, worktree_dirty, has_draft, joining, declared)` in `ops.rs` — precedence `joining > declared > draft-ready > working > created`.
- **The step verb:** `step_in` (`ops.rs`) — parses the worktree plan, refuses on base-plan dirt, rewrites the ledger row, then `append_step_declaration`. CLI in `tugrust/crates/tugutil/src/dash.rs` (`run_step`, `StepAction::Start { step, plan }` / `Done { step, commit }`).
- **The message precedence:** `integrate_message(repo, name, branch, override)` (`ops.rs`) — override → `dash_draft_message` → branch description → `"Dash work"`, scope-stripped, `tugdash(<name>): ` prefixed, trailers appended by `with_dash_trailers`.
- **The sheet:** `tugdeck/src/components/tugways/cards/join-prompt-sheet.tsx` maps `DashJoinPromptWire` (`tugdeck/src/lib/changeset-types.ts`) into a `QuestionWizard`; the store is `tugdeck/src/lib/changeset-join-store.ts`; at0445 drives the full arc on a scratch repo and currently arms both dashes with `markDashBuilt` (`tests/app-test/_harness` dash fixture).

#### The laws this plan touches {#laws-cross-check}

Named rather than gestured at, per the review rubric. Most of this plan is Rust, so the tugdeck laws bear on Step 6 only.

- **[L02] — external state enters React through `useSyncExternalStore` only.** *Honored.* Nothing new is stored client-side: `message`, `message_source`, and the `ready` stage all ride the CHANGESET_ALL frame the join store already publishes, and reach the sheet and the register as props. This is why (#state-zone-mapping) is a single row — the plan introduces no client state at all.
- **[L06] — appearance changes go through CSS and DOM, never React state.** *Honored.* `DashStageMark` already writes `data-stage`, so `ready` becomes a CSS-selectable attribute value plus one icon-map entry; no component gains a state variable to express it.
- **[L11] — controls emit actions, they do not mutate structure.** *Untouched.* The sheet's answer path is unchanged; this plan adds display above the wizard, not a new control.
- **[L19] — component authoring shape.** *Honored.* The message block is a prop-driven addition to an existing component; no new component is introduced.
- **[L20] — compose `Tug*` components, never hand-roll.** *Watch in Step 6.* The message block must borrow the shade draft-fold's existing treatment rather than hand-roll a mono block; Step 6's task says so explicitly, and "borrowing its CSS" is still hand-rolling.
- **[L31] — a refused gesture produces the act or a visible reason; never a quiet early return.** *This is the plan's spine.* The whole defect was a silent early return in `pilot_action` (`stage != "built"`) with no surface anywhere saying the arc was disarmed. Two of the fixes are directly [L31]: the CLI's `--through` refusal names the flag rather than defaulting, and [P05]'s provenance turns a silent draft fallback into a stated one. [P07] closes the third silence — the register that returned `null` for a joinable dash.
- **[D142]** (the arc, amended here), **[D143]** (the three faces the register mounts on — all three are the surfaces [P07] repairs), **[D144]** (same failure class: an internal mechanism deciding a user-visible outcome).

#### Why completion is not inferable without the declaration {#why-declare}

The ledger after `done(8)` of a 15-step plan reads: 1–8 `done`, 9–15 `pending`, none `in progress` — byte-identical whether the run was asked for "Steps 6–8" (complete — offer now) or "the whole plan" (mid-run — stay dark). The selection exists only in the user's prompt and the skill's working memory. Parsing it server-side out of free prose (`; M02 truthful zones, steps 6–8`) is the fragile inference this project refuses elsewhere; recording it through a verb the run must call anyway makes it a fact. That is the whole of [P01].

---

### Specification {#specification}

**Spec S01: The declared-run grammar** {#s01-run-grammar}

- CLI: `tugutil dash step start <name> <n> --through <m> [--plan <path>]`. `--through` is required; omitting it exits 1 with: `dash step start requires --through <m>: the final step of this run's selection (the machine arms the join from it)`. `m >= n` is required; `m` must name an existing ledger row (validated against the parsed plan, same as `n`).
- `ops::step_start(name, step, plan, through: u32)`. Before the step's own declaration, `step_in` appends a `run-through` dash-log line — marker `run-through`, note `{m}` — but only when the latest declared value differs (idempotent re-entry of an interrupted step writes no duplicate).
- `dash step done` is unchanged in signature. Its existing `step-done` declaration is the completion event; nothing new is written.
- `read_declarations` gains: `run_through: Option<u32>` (latest `run-through` note, reset at terminal lines like everything else); `step_in_flight: bool` (the latest step declaration is a `step-start`); `run_complete: bool` (the latest step declaration is a `step-done` whose `current >= run_through`, `false` when `run_through` is `None`). Older readers ignore `run-through` lines by construction (unknown markers only date the dash).

**Spec S02: The readiness predicate** {#s02-readiness}

New pure function in `tugdash-core` (in `dash.rs`, beside the declarations it reads):

```rust
pub fn join_ready(
    rounds: u32,
    worktree_dirty_tracked: bool,
    joining: bool,
    decls: &DashDeclarations,
) -> bool
```

`true` iff: `!joining` ∧ `rounds >= 1` ∧ `!worktree_dirty_tracked` ∧ *armed*, where *armed* is any of:

1. `decls.run_complete` — the declared selection finished ([P01]);
2. `decls.latest` is `Built` or `Audited` — the manual/legacy arm ([P03]);
3. `decls.step.is_none()` — a plan-less generation: every round arms ([P02]).

A `step-start` as the latest step declaration makes both 1 and 3 false — a mid-step dash is never ready. `dash_detail_entries_in` computes this once per dash and stamps `DashDetail.join_ready` (plus pass-throughs `run_through`, `run_complete` for display/tests).

`derive_stage` gains a `join_ready: bool` parameter and a `ready` arm ([P07]), placed exactly here:

```
joining
  > declared Built | Audited      → "built" | "audited"
  > join_ready                    → "ready"          ← new
  > declared Step { .. }           → "implementing"
  > has_draft → "draft-ready" > rounds>0 || dirty → "working" > "created"
```

Above the `Step` arm because a completed run's latest declaration *is* a `step-done`, which would otherwise read `implementing` forever; below `built`/`audited` so an explicitly marked dash keeps its own word.

`pilot_action(join_ready: bool, bound: bool, state: &DashJoinState)` replaces its stage gate with `!join_ready`, and returns `None` for `!bound` ([P08]). `standing_prompt` replaces `detail.stage != "built"` with `!detail.join_ready`. All downstream gates (occupancy, blockers, question/stuck, candidate, Tier 0, decision mark, head-pair mark) are untouched.

**Spec S04: The client's stage-keyed surfaces** {#s04-client-stage}

Three sites in `tugdeck` carry their own copy of the `built` gate and must learn `ready` ([P07]). All three are pure data → the wire's `stage` string; no new client state, which is why (#state-zone-mapping) stays a single row.

| Site | Today | After |
|---|---|---|
| `lib/dash-join-register.ts` — the arc-begins gate | `if (input.stage !== "built" && !acted) return null` | accepts `built` **or** `ready` |
| `lib/dash-join-register.ts` — the no-verdict beat | `if (input.stage === "built")` → "Building the joined tree" | same for `ready` |
| `components/tugways/dash-meta-line.tsx` — `STAGES_PAST_THE_WALK` | `built, audited, draft-ready, joining, landing` | adds `ready`, so `implementing (8/8)` on a finished run turns the ring success |
| `components/tugways/dash-stage-mark.tsx` — `DASH_STAGE_ICONS` | no `ready` key (falls back to `Sprout`) | a lucide glyph for `ready`, in lifecycle order between `implementing` and `built` |

**Spec S03: The landing-message preview** {#s03-message-preview}

New in `ops.rs`:

```rust
pub enum LandingMessageSource { Draft, Description, Fallback }
pub fn landing_message_preview(repo: &Path, name: &str, branch: &str)
    -> (String, LandingMessageSource)
```

Same precedence and scope-stripping as `integrate_message` (no override arm — the preview is for the standing state), refactored so both call one shared composition; the preview returns the `tugdash(<name>): <subject/body>` text **without** trailers. `standing_prompt` calls it only on the branch that will actually ask (after the decision-mark check, beside the existing `rev-parse` pair) and fills `DashJoinPrompt.message` / `message_source` (`"draft" | "description" | "fallback"`). Wire mirror: `DashJoinPromptWire` in `tugdeck/src/lib/changeset-types.ts` gains `message: string; message_source: string;`. The sheet renders the message in the muted-mono draft treatment the shade's draft fold already uses, headed by provenance: source `draft` shows the message plainly; `description` shows "landing with the branch description — no draft was written"; `fallback` shows "no draft or description — this join would land as 'Dash work'".

**Table T01: What arms, what stays dark** {#t01-arming-matrix}

| Dash state | Armed? | Why |
|---|---|---|
| Plan run, `done(m)` where `m` = declared `--through` | yes | [P01] completion arithmetic |
| Plan run, `done(k)`, `k < m` | no | selection incomplete |
| Plan run, latest declaration `step-start` | no | mid-step |
| Plan run complete, later fix rounds (no step verbs) | yes | `run_complete` persists until a new `step-start` |
| Plan-less, ≥1 round, clean tracked worktree | yes | [P02] |
| Plan-less, dirty tracked worktree | no | work in progress |
| Any dash, `built`/`audited` declared | yes | [P03] manual/legacy arm |
| Legacy plan dash, steps done, no `run-through` line | no (until marked) | Risk R02 |
| `joining`, or rounds = 0 | no | landing / nothing to join |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `prompt.message`, `prompt.message_source` | server-derived feed data | rides the existing CHANGESET_ALL frame → `changeset-join-store` → props into the sheet; no new client state | [L02] |

---

### Compatibility / Migration / Rollout {#rollout}

- **CLI:** `--through` is a new required flag on `dash step start` only. The refusal message names it. Both skills are updated in this plan; no other caller exists (see [#assumptions]).
- **Dash-log:** the `run-through` marker is additive; `split_log_line` parses it as an ordinary line and pre-change readers ignore it. Logs are never rewritten.
- **Wire:** `DashJoinPrompt` gains two fields; `serde` default-tolerant on the TS side (optional until the binary ships, then required by the fixtures).
- **Legacy dashes:** any generation with step declarations but no `run-through` stays dark until `tugutil dash mark <name> built` (Risk R02). The live `imposer-polish` dash is exactly this case and is the first live test: after Step 5 lands and the app rebuilds, `tugutil dash mark imposer-polish built` must raise its prompt (now genuinely — [P06] closes the log-only-write observation hole).
- **Rollback:** every step is a dash round; the join squashes; reverting the squash restores the `built` gate wholesale.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `run-through` | dash-log marker | `tugrust/crates/tugdash-core/src/dash.rs` | note = the declared final step |
| `DashDeclarations::{run_through, step_in_flight, run_complete}` | fields | `dash.rs` | derived in `read_declarations` |
| `join_ready` | fn | `dash.rs` | Spec S02 |
| `derive_stage` | fn (signature) | `ops.rs` | gains `join_ready: bool` and the `ready` arm ([P07]) |
| `DashDetail::{join_ready, run_through, run_complete}` | fields | `ops.rs` | stamped in `dash_detail_entries_in` |
| `step_start` | fn (signature) | `ops.rs` | gains `through: u32` |
| `LandingMessageSource`, `landing_message_preview` | enum/fn | `ops.rs` | Spec S03; shares composition with `integrate_message` |
| `StepAction::Start` | enum variant | `tugrust/crates/tugutil/src/dash.rs` | gains `through`; parse + refusal |
| `pilot_action` | fn (signature) | `tugrust/crates/tugcast/src/feeds/join_pilot.rs` | `stage: &str` → `join_ready: bool, bound: bool` |
| `standing_prompt` | fn | `tugrust/crates/tugcast/src/feeds/join_board.rs` | gate swap + message fields |
| `DashJoinPrompt::{message, message_source}` | fields | `tugrust/crates/tugcast-core/src/types.rs` | server-composed |
| dash-log mtime probe | probe arm | `tugrust/crates/tugcast/src/feeds/changeset_all.rs` | [P06] |
| `DashJoinPromptWire.{message, message_source}` | TS fields | `tugdeck/src/lib/changeset-types.ts` | mirror |
| provenance block | TSX/CSS | `tugdeck/src/components/tugways/cards/join-prompt-sheet.tsx` / `.css` | Spec S03 rendering |
| the two `built` gates | conditions | `tugdeck/src/lib/dash-join-register.ts` | accept `ready` (Spec S04) |
| `STAGES_PAST_THE_WALK` | const | `tugdeck/src/components/tugways/dash-meta-line.tsx` | adds `ready` |
| `DASH_STAGE_ICONS` | const | `tugdeck/src/components/tugways/dash-stage-mark.tsx` | a glyph for `ready` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | The derivations: declarations folding, `join_ready` truth table (Table T01), preview precedence, predicate gates | every core step |
| **Integration (Rust)** | `standing_prompt` end-to-end on a scratch repo: no-mark arming, provenance, late-draft refresh | join_board tests |
| **App-test** | The pressed arc: prompt raised with `mark` never called; provenance visible in the sheet | at0445 |
| **Unit (TS)** | Sheet mapping of the new fields | `join-prompt-sheet.test.ts` |

#### What stays out of tests {#test-non-goals}

- Timing behavior — there is none; nothing waits, so nothing races (the design's point).
- The pilot dispatch/occupancy machinery — unchanged; its existing tests stand.
- Fake-DOM render tests of the sheet — banned shape; the at0445 pin covers the rendered surface.
- The skills' prose — not executable; the doctrine cross-check is review, not test.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The declared run: `--through`, the `run-through` marker, the folded facts | pending | — |
| #step-2 | Join readiness derived in tugdash-core; a ready dash says so | pending | — |
| #step-3 | The landing-message preview with provenance | pending | — |
| #step-4 | The pilot and the prompt key off readiness | pending | — |
| #step-5 | The prompt carries the message; the probe observes the dash-log | pending | — |
| #step-6 | The ready stage reaches the faces; the sheet names its message | pending | — |
| #step-7 | The skills shrink to narration and prose | pending | — |
| #step-8 | at0445: the no-mark path and the provenance pin | pending | — |
| #step-9 | Doctrine: [D146] amends [D142] | pending | — |
| #step-10 | Integration checkpoint | pending | — |

#### Step 1: The declared run: `--through`, the `run-through` marker, the folded facts {#step-1}

**Commit:** `tugdash(run-declaration): dash step start requires --through; the log carries the selection`

**References:** [P01] Declared selection, Spec S01, (#why-declare, #current-machinery)

**Artifacts:**
- `ops::step_start` gains `through: u32`; `step_in` validates `m >= n` and that `#step-<m>` exists in the ledger, and appends the `run-through` line (only when the latest declared value differs).
- `read_declarations` folds `run_through` / `step_in_flight` / `run_complete` per Spec S01; terminal lines reset them with everything else.
- CLI: `StepAction::Start` gains `through`; missing flag exits 1 with the Spec S01 message; `--json` output includes `through`.

**Tasks:**
- [ ] Extend `append`-side: write `run-through` from `step_in` before the `step-start` declaration; idempotent on re-entry.
- [ ] Extend `read_declarations` + `DashDeclarations`; a `run-through` line alone (no step decl yet) yields `run_complete == false`.
- [ ] CLI parse + refusal in `tugrust/crates/tugutil/src/dash.rs`; update `run_step`'s human output to say `Step i/N … (run through m)`.
- [ ] Update existing `step_start` call sites in Rust tests to pass a `through`.

**Tests:**
- [ ] Declarations fold: start(6,through 8) → in-flight; done(6), done(7) → incomplete; done(8) → `run_complete`; a later start(9,through 12) → in-flight again, `run_through == 12`.
- [ ] Terminal line resets the run facts; a reused name is born undeclared.
- [ ] CLI refusal without `--through`; refusal on `m < n` and on `m` naming no ledger row.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`

---

#### Step 2: Join readiness derived in tugdash-core; a ready dash says so {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(readiness): join_ready derives from declarations, rounds, and tracked dirt; a ready dash says so`

**References:** [P02] Plan-less arming, [P03] Mark still arms, [P04] Derive in core, [P07] The ready stage word, Spec S02, Table T01

**Artifacts:**
- `join_ready(rounds, worktree_dirty_tracked, joining, &DashDeclarations) -> bool` in `dash.rs`.
- `derive_stage` gains `join_ready: bool` and the `ready` arm at the precedence position Spec S02 fixes.
- `DashDetail.{join_ready, run_through, run_complete}` stamped in `dash_detail_entries_in` from values the composition already holds (`dash_detail_entry_in` delegates to it and needs no edit).

**Tasks:**
- [ ] Implement Spec S02 exactly; document each arm with the decision it implements.
- [ ] Add the `ready` arm **above** the `Step` declaration arm and **below** `built`/`audited`; update both real `derive_stage` call sites — `dash_detail_entries_in` and `status_in` (`dash_detail_entry_in` is a find-wrapper over `dash_detail_entries_in` and inherits by delegation; it composes nothing itself).
- [ ] Stamp the fields. In `dash_detail_entries_in` every input is already computed per dash (`worktree_dirt_tracked` via `dirty_tracked_paths`) — no new git subprocess on the recompute hot path. `status_in` computes only the untracked-inclusive `worktree_dirty` today: give it a `dirty_tracked_paths` call for the `join_ready` input rather than passing `worktree_dirty`, or `dash status` disagrees with the feed over an untracked scratch file — the exact case [P04]'s tracked-dirt distinction exists to exclude. That call is on the CLI path, not the recompute, so the hot-path doctrine is untouched.

**Tests:**
- [ ] The full Table T01 truth table as unit tests over `join_ready`, one assertion per row.
- [ ] `derive_stage` precedence: a completed run reads `ready`, not `implementing`; the same dash with `built` declared reads `built`; mid-step reads `implementing`; a joining dash reads `joining`.
- [ ] `dash_detail_entry_in` integration: a scratch dash with one round and a clean worktree reads `join_ready == true` and `stage == "ready"` with `mark` never called; the same dash mid-step reads `false`/`implementing`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 3: The landing-message preview with provenance {#step-3}

**Depends on:** #step-1

**Commit:** `tugdash(landing-preview): the message a join would land with, and where it came from`

**References:** [P05] Prompt provenance, Spec S03

**Artifacts:**
- `LandingMessageSource` + `landing_message_preview` in `ops.rs`; `integrate_message` refactored onto the shared composition so preview and landing cannot drift.

**Tasks:**
- [ ] Extract the precedence walk (draft → description → fallback) into one function both callers use; preview omits trailers, landing keeps them.
- [ ] Preserve `integrate_message`'s existing behavior byte-for-byte (its five `integrate_message_*` tests must pass unchanged).

**Tests:**
- [ ] Preview precedence: draft present → (`draft`, draft text); description only → (`description`, …); neither → (`fallback`, `tugdash(<name>): Dash work`).
- [ ] Scope-stripping parity: a draft wearing a foreign `tugdash(x): ` prefix previews exactly as it would land.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 4: The pilot and the prompt key off readiness {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(join-pilot): the arc arms from derived readiness, not the built mark`

**References:** [P03] Mark still arms, [P04] Derive in core, [P08] Bound-only pilot, Spec S02, (#current-machinery)

**Artifacts:**
- `pilot_action(join_ready: bool, bound: bool, state: &DashJoinState)`; the `stage != "built"` line becomes `!join_ready`, and an unbound dash returns `None`.
- `changeset.rs::dash_entries`: `pilot_action` moves **out of** the `spawn_blocking` closure into the existing async dispatch loop, where `bound_by_dash` is already in scope — the predicate is pure and cheap, so this costs nothing and avoids cloning the map into the closure.
- `standing_prompt`: `detail.stage != "built"` → `!detail.join_ready`; the `quiet` composition and every later gate unchanged. No boundness gate here — an unpiloted dash has no verdict, so the existing gates already return `None`.
- Module docstrings in `join_pilot.rs` / `join_board.rs` rewritten: the arc's trigger is a machine fact; `built` is telemetry that also arms; the pilot works where the answer can be offered.
- `standing_prompt`'s **question copy** rewritten too — both variants currently open `"{name} is built, reconciled with {base} …"`, which becomes a lie for a dash that arms without ever building. Speak readiness, not the build: `"{name} is ready, reconciled with {base}, and the joined tree builds — join it?"` / `"… but the joined tree does not build — join it anyway?"` (the "joined tree builds" half is Tier 0's fact and stays). This is user-visible sheet text, not a comment — the same [L31]/no-resting-lies bar the provenance work holds elsewhere.

**Tasks:**
- [ ] Swap both gates; add the boundness gate; update the pilot's rule list ("1. Not ready — the pilot acts on a finished selection, a plan-less round, or a declared mark. 2. Unbound — the ask can only be raised on a bound card, so an eager verdict would be spent on nobody").
- [ ] Rewrite `only_a_built_dash_is_piloted` into readiness terms; keep every other pilot/prompt test's intent (each existing `pilot_action("built", …)` call becomes `pilot_action(true, true, …)`).

**Tests:**
- [ ] `pilot_action(false, true, …) == None` for all states; `pilot_action(true, true, bare()) == Some(Reconcile)`.
- [ ] `pilot_action(true, false, bare()) == None` — a ready but unbound dash is left alone ([P08]).
- [ ] join_board integration: a scratch dash armed purely by rounds + clean worktree (no `mark`) reaches a standing prompt once verified green — the Rust-level no-mark pin.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core`

---

#### Step 5: The prompt carries the message; the probe observes the dash-log {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugcast(join-prompt): the prompt shows its landing message and provenance; log writes reach the recompute`

**References:** [P05] Prompt provenance, [P06] Dash-log probe, Spec S03, [Q03]

**Artifacts:**
- `DashJoinPrompt.{message, message_source}` in `tugcast-core/src/types.rs`, filled by `standing_prompt` via `landing_message_preview` on the ask branch only.
- The `changeset_all.rs` 2 s probe stats each open workspace's `dash-log.md` mtime beside the drafts version; a moved mtime fires the existing bump.

**Tasks:**
- [ ] Fill the fields; the request id derivation is untouched (the message is display, not identity — a draft edit must not orphan an in-flight answer).
- [ ] Probe arm + a comment tying it to [P06] and the drafts-probe doctrine.

**Tests:**
- [ ] Prompt integration: description-only dash prompts with `message_source == "description"`; writing a draft and recomposing flips it to `draft` with the draft's text — the [Q03] pin.
- [ ] No-draft-no-description dash prompts with `fallback` and the `Dash work` subject.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 6: The ready stage reaches the faces; the sheet names its message {#step-6}

**Depends on:** #step-2, #step-5

**Commit:** `tugdeck(join-arc): the ready stage reaches the faces; the sheet names its landing message`

**References:** [P05] Prompt provenance, [P07] The ready stage word, Spec S03, Spec S04, (#state-zone-mapping)

**Artifacts:**
- `DashJoinPromptWire.{message, message_source}` in `tugdeck/src/lib/changeset-types.ts` (+ fixtures).
- The three Spec S04 sites learn `ready`: both `lib/dash-join-register.ts` gates, `dash-meta-line.tsx`'s `STAGES_PAST_THE_WALK`, and a lucide glyph in `dash-stage-mark.tsx`'s `DASH_STAGE_ICONS`.
- `join-prompt-sheet.tsx`/`.css`: a message block above the wizard — muted mono for the text, a provenance line for `description`/`fallback` per Spec S03. Tokens only; compose existing Tug components; no new store state ([L02] — the fields ride the frame already subscribed).

**Tasks:**
- [ ] Apply Spec S04's table; the register's arc-begins comment must be rewritten — its stated reason ("the arc begins at `built`") is no longer the rule.
- [ ] Mirror + render the message block; reuse the shade draft-fold's mono treatment rather than inventing one ([L20] — compose, never hand-roll).
- [ ] Update `join-prompt-sheet.test.ts`, `changeset-join-store.test.ts`, and the `dash-join-register` / `dash-meta-line` unit tests' fixtures.

**Tests:**
- [ ] Sheet mapping unit test: the three sources produce the three renderings.
- [ ] `dashJoinRegister` table test: a `ready` dash with no verdict yields the "Building the joined tree" beat rather than `null` — the pin that the client gate actually moved.
- [ ] `dash-meta-line` walk test: `ready` with `8/8` reads as a finished walk (its table test lives beside the component; `dash-join-register.test.ts` is under `src/lib/__tests__/`).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test src/components/tugways/cards/__tests__/join-prompt-sheet.test.ts src/lib/__tests__/changeset-join-store.test.ts src/lib/__tests__/dash-join-register.test.ts`

---

#### Step 7: The skills shrink to narration and prose {#step-7}

**Depends on:** #step-1

**Commit:** `tugplug(skills): dash-implement and dash-on narrate; the server owns the endgame`

**References:** [P01] Declared selection, [P02] Plan-less arming, [P03] Mark still arms, (#context)

**Artifacts:**
- `tugplug/skills/dash-implement/SKILL.md`: phase 2's step-open command becomes `tugutil dash step start <name> <n> --through <m>` with `m` from the Setup-resolved selection; phase 3 rewritten — the build is an offer ("build and vet when the work wants it"), `dash mark built` is optional telemetry, the join draft remains the one obligation, the `/join <name>` pointer stays as narration, and the phase states plainly that the join prompt raises from the recorded facts whether or not phase 3 runs.
- `tugplug/skills/dash-on/SKILL.md`: the mark/build weld removed; the draft obligation and `/join` pointer stay; a sentence notes that each committed round makes the dash offerable.

**Tasks:**
- [ ] Rewrite both files; keep every rule that isn't the endgame (doctrine pointers, worktree discipline, ledger verbs).
- [ ] Note in the run report (this plan's, not the skill text): repo edits to `tugplug/` are inert until the app bundle rebuilds — live verification of the skill text requires `cp` into the bundle or `just build-app`.

**Tests:**
- [ ] None executable — prose. The at0445 no-mark pin (#step-8) is what proves the machinery no longer needs the prose.

**Checkpoint:**
- [ ] `grep -n "through" tugplug/skills/dash-implement/SKILL.md` shows the new verb form; `grep -cn "mark <name> built" tugplug/skills/dash-on/SKILL.md` shows the weld gone (mark appears only as optional telemetry, if at all).

---

#### Step 8: at0445: the no-mark path and the provenance pin {#step-8}

**Depends on:** #step-5, #step-6

**Commit:** `app-test(join-prompt): a dash never marked built still prompts, and a missing draft shows itself`

**References:** [P01]–[P05], [P07] The ready stage word, [P08] Bound-only pilot, Table T01, (#success-criteria)

**Artifacts:**
- `tests/app-test/at0445-join-prompt.test.ts`: `markDashBuilt(scratch, DASH, cli)` is removed — the primary dash's round + clean worktree are the arming facts ([P02], since the fixture dashes are plan-less). A header claim states the no-mark guarantee.
- The **unbound-dash claim is rewritten**, because [P08] changes what it can prove. Today the file does `await registerReaches(app, QUIET_DASH, "ready", 240000)` — it waits for the *unbound* dash's register to go green before asserting the sheet does not name it. Under a bound-only pilot that dash is never reconciled, so that wait can only time out. The claim becomes the stronger and simpler one it was always reaching for: an unbound dash is left alone entirely — its register never reaches `ready` within a bounded window, and no prompt ever names it. `markDashBuilt(scratch, QUIET_DASH, cli)` goes too: a mark now arms ([P03]), so leaving it in would make the unbound dash *ready* and test the opposite of the intent.
- A provenance assertion reads the sheet's message block: the flow that lands has a draft (expects the draft's text), and a second pass with the draft cleared expects the `description`/`fallback` annotation.
- `@covers` gains `tugrust/crates/tugdash-core/src/dash.rs`, `tugrust/crates/tugdash-core/src/ops.rs`, and `tugdeck/src/lib/dash-join-register.ts`.

**Tasks:**
- [ ] Rework the fixture arming; keep the four existing claims intact (ask once, durable dismissal, same-decision silence via the base move, changed-decision re-ask).
- [ ] Rewrite the unbound claim per the artifact above — replace the `registerReaches(QUIET_DASH, "ready")` wait with a bounded negative assertion, and say in the header *why* it is negative now.
- [ ] Confirm the surviving `registerReaches(app, DASH, "ready", …)` waits still pass: the register's word for a green Tier 0 is already `ready`, and it is now reachable from stage `ready` as well as `built` (Spec S04).
- [ ] `just build-app` first — at0445 drives the compiled binary, and app-test never rebuilds it.

**Tests:**
- [ ] `just app-test tests/app-test/at0445-join-prompt.test.ts` green, diagnostics noting the no-mark arming and the provenance read.

**Checkpoint:**
- [ ] `just build-app` then `just app-test at0445-join-prompt.test.ts`

---

#### Step 9: Doctrine: [D146] amends [D142] {#step-9}

**Depends on:** #step-4, #step-7

**Commit:** `tuglaws(design-decisions): D146 — the join arc arms from recorded facts, never from a skill's chore`

**References:** [P01]–[P08], (#context, #why-declare, #laws-cross-check)

**Artifacts:**
- `tuglaws/design-decisions.md` gains **[D146]**: the incident, the principle (skills narrate; verbs record; the server derives), the declared-run grammar, the plan-less rule, the mark's demotion to telemetry-that-arms, the `ready` stage word and the three client gates it repairs, the bound-only pilot, the provenance rule, and the observation-probe note. Amends [D142] (the trigger) and [D143] (the stage vocabulary the faces key on), and cites [D144] (the same failure class: an internal mechanism deciding a user-visible outcome).
- Note in the entry that the client carried its own copy of the server's gate — the durable lesson, and the reason the sweep was wider than the one-line fix it looked like.

**Tasks:**
- [ ] Write the entry in the file's established voice and format; name the files and tests, no line numbers, no hard wrapping.

**Tests:**
- [ ] None — documentation.

**Checkpoint:**
- [ ] The entry exists, cites [D142] and [D144], and names at0445's new pins.

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full Rust suite; tugdeck typecheck + build + unit tests; the derived app-test selection.
- [ ] Live smoke on the dash's debug instance: create a scratch plan-less dash, land one round, watch the prompt raise with `mark` never typed.

**Tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test-changed` (name files explicitly if the derived selection exceeds the budget)

**Checkpoint:**
- [ ] All of the above green; the success criteria in (#success-criteria) each verified.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A join endgame that cannot be forgotten: the prompt raises from recorded machine facts on every finished selection and every plan-less round, showing the message it will land with and its provenance — with the skills reduced to walking steps and writing prose.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] at0445 passes with `markDashBuilt` absent from the primary arming path, and its unbound dash never reaches a green register (app-test).
- [ ] A joinable dash's join register renders on all three [D143] surfaces instead of returning null (`dashJoinRegister` table test + at0445's `registerReaches`).
- [ ] `dash step start` refuses without `--through`; both skills pass it (CLI test + grep).
- [ ] The prompt payload and sheet carry message + provenance across all three sources (Rust + TS tests).
- [ ] `imposer-polish` (or its successor legacy case) prompts after the one-line `mark built` recovery, proving [P06]'s observation path (live smoke).
- [ ] [D146] recorded.

**Acceptance tests:**
- [ ] `just app-test at0445-join-prompt.test.ts`
- [ ] `cd tugrust && cargo nextest run`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap-follow-ons}

- [ ] Spell the *selection* on the Lens dash rows and `DashMetaLine` ("ran 6–8 of 15") — [P07] makes the stage word right, but the run's range is still unsaid; display only.
- [ ] Consider whether `dash-audit` should read `run_complete` instead of the `audited` mark's neighborhood.

| Checkpoint | Verification |
|------------|--------------|
| Core derivations | `cargo nextest run -p tugdash-core` |
| Arc end-to-end | `just app-test at0445-join-prompt.test.ts` |
| Client surfaces | `bunx tsc --noEmit && bunx vite build && bun test` |
