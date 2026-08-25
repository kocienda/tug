# The server-driven dash arc {#server-driven-dash-arc}

**Purpose:** Make `/dash` the last gesture a dash needs: a document is handed to a tugcast-owned arc that rotates devise → review → implement as fresh claude sessions under the one card's own tugcode, rendered as one transcript with stage dividers, and stops at the join offer the user already knows.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | dash branch cut by `tugutil dash create` at implement |
| Last updated | 2026-08-24 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-24, opus.** Reviewed `plan:6b2a338a6bc23375`. Lint: 0 errors, 1 warning (the missing Review Record this paragraph answers).
Oriented on: the plan as devised, read against `agent_supervisor.rs`, `agent_bridge.rs`, `session_ledger.rs`, `tugdash-core/src/dash.rs` and `ops.rs`, `tugutil-core/src/config.rs` and `plan.rs`, `tugcode/src/session.ts` and `inbound-dispatch.ts`, `tugdeck/src/lib/code-session-store/{types,reducer,compaction}.ts`, and the tuglaws.
Applied: **a correctness hole in the hand-off** — `tugutil dash run` is issued from inside the conversation session's own turn, so rotating on receipt would kill claude mid-turn; the request now records and returns, and the first rotation belongs to that session's `turn_complete` ([P05], [#step-6]). **A working-directory hole** — [B03] reads as though the implement stage runs in the dash worktree, but a tugcode subprocess's cwd is fixed at spawn and rotating a session under it cannot change one; recorded as [P14], which honors the decision the way the lane already works (absolute paths into the worktree, as a hand-driven `dash-implement` does). **A stale spelling in the brief** — [B05]'s `<root>-A1/A2/A3` lineage suffixes were retired (`migrate_collapse_lineage_chains` drops `tag_lineage_points`), so stages inherit the parent callsign verbatim, recorded as [P03] rather than deferred. **Sequencing** — the `/api/dash` `arc_run` POST moved out of [#step-2] into [#step-6] so no step ships a caller whose receiver does not exist; [#step-11] gained its real dependency on [#step-6], since its app-test drives a live rotation. **Verified claims replaced guesses**: the relay forwards every tugcode line to CODE_OUTPUT unconditionally, so `session_stage` reaches the deck for free ([#step-5]); tugcast already depends on `tugutil-core`, so lint/status are in-process calls rather than a subprocess ([#step-8]); `SessionLedger::get_context_breakdown` is the read-back ([#step-9]); `DashDetail` lives in `tugdash-core/src/ops.rs` and already carries the neighbouring fields ([#step-13]); `TUG_DASH_ARC` belongs in `spawnClaude`'s existing explicit `env` object, not in `liveSpawnConfig`, which carries flags only ([#step-4]). **Test-plan sanity** — two "read-back grep" items posing as tests in [#step-10] and [#step-14] were moved to checkpoints, with the honest statement that prose contracts have no automatable test at that layer. **Doctrine** — added the tuglaws cross-check naming [L02], [L06]/[L24], [L22], [L29], [L31], [L23], and cited [D151] under [P13] and [D156] under [P12].
Deferred: nothing. No question arose that the code could not settle, so the plan carries no `[Q##]`.

**Round 2 — 2026-08-24, fable.** Reviewed `plan:1bc943059b0cf4fc`. Lint: 0 errors, 0 warnings before the round.
Oriented on: the Review Record — the plan is untracked, so there is no diff to read; the whole document was re-read against `agent_supervisor.rs` (the idle transition, `turn_complete_tx`, `PendingFork`, `do_request_replay`), `dash_api.rs` and `server.rs`'s `DashApiRequest`, `session_ledger.rs` (`set_dash_binding`, `bound_sessions_by_dash`, `get_context_breakdown`), `tugdash-core/src/ops.rs` (`ensure_dash_id`, `DashDetail`) and `dash.rs` (`read_declarations`), `tugcode/src/session.ts` (`handleNewSession`, `spawnClaude`'s env, `handleSessionFork`'s docblock), `tugproto/src/inbound.ts`, `tugdeck/src/lib/use-model.ts`, and `tugplug/skills/dash/SKILL.md`.
Applied: **four correctness holes.** The arc record never said whose card it was — no line carries a tug session id, and the tick, the restart resume, and the receipt all need one; settled by making `arc_run` bind the calling session through the existing dash binding, which `ensure_dash_id` can mint before any branch exists ([P01], [#step-6], [#step-8]). [B04] was only half honored — `handleModelChange` persists the selector across every later spawn, so a card would have stayed on the implement model after the arc; the supervisor now records the deck's last selector and the runner restores it at `arc-done`/`arc-stop` ([P15], [#step-6], [#step-8]), and the success criterion that claimed `/new` would restore it was rewritten, because the code says the opposite. The plan file **moves** at adoption — `create --plan` cleans the base copy — so a runner reading the devise path would stop a healthy arc at implement; the runner now reads the worktree copy from `DashDetail` and completion from `read_declarations` ([P16], [#step-8], [#step-9]), and `arc-plan` is written at the devise rotation because the path is the runner's choice. The tick was specified against the bridge's `turn_complete` substring match; the supervisor already has the idle transition, replay-bracket-aware, feeding `turn_complete_tx` to `base_motion.rs`, and the tick is now a second consumer of it ([P05], [#step-8]). **Cold-reader gaps:** the opening prompts were never written down — Spec S09 names all four, plus the skip-devise rule for a document that already lints as a plan; `TUG_DASH_ARC` had no clearing path, so a plain `/new` after an arc would have carried it forever ([#step-4]); `handleSessionFork`'s docblock still describes the retired lineage-suffix allocator, which [P03] rests on — a task to correct it while there. **Rollout:** added [#milestones] — five contiguous, dependency-clean `dash-implement` ranges on one dash, joined once at the end; the user chose one dash over five when asked.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Starting a dash today is six hand-driven steps — devise, compact, review, compact, commit the plan, implement — and the user is the pipeline runner. The brief [`dash/streamline-dash-workflow-brief.md`](streamline-dash-workflow-brief.md) establishes that only two of the three reasons for that shape are load-bearing ([F01]), that both share one root — *a running model cannot drive its own arc* ([F02]) — and that everything a runner would need already exists: stage boundaries are machine-readable document facts ([F04]), claude sessions already rotate under a card's tugcode as first-class commands ([F06]), and the plan doctrine already demands each stage be startable cold ([F03]).

What does not exist is the one primitive in [F07]: **tugcast originating frames on a card's own tugcode**, rather than relaying frames a WebSocket client sent. Everything else in this plan is a state machine over documents, three text edits to skill endings, one transcript row, and a restore that walks a lineage instead of one file.

#### Strategy {#strategy}

- **Bottom-up, record first.** The arc record ([B16]) and its verbs land before anything reads them, so every later step has a durable fact to test against.
- **The new primitive lands alone.** Originating a stage on a card's tugcode ([B05], [F07]) is one step, provable by hand (`tugutil dash run` on a live card visibly starts a session), before any runner drives it.
- **Predicate and dispatch split**, exactly as the join pilot splits them ([F05], `join_pilot.rs` module docstring): a pure function over facts the caller already holds, and a separate dispatcher that performs the act under an occupancy guard.
- **Skills change only at their endings** ([B11]). No skill learns to sequence.
- **The transcript work is last-but-one**, because it is the only part that cannot be verified without the runner actually running.
- **Nothing here touches the Lens Dashes cleanup** ([B12]) — sibling work, no shared code.

#### Success Criteria (Measurable) {#success-criteria}

- A bare `/dash` on a session that just wrote `dash/foo-brief.md` produces, without further typing: a devise session, a written plan, a review session, a stamped review, an implement run, and an armed join. (Verify: run it on a small real brief; `tugutil dash arc <name> --json` reports `stage: done`, `tugutil plan status <plan> --json` reports `reviewed`, the Changes shade summons itself.)
- Each stage's boundary is decided from documents only. (Verify: `dash_arc::arc_action` unit tests drive every transition from synthesized `plan lint` / `plan status` / ledger facts, with no model text as input.)
- The whole arc happens in one card, one scroll. (Verify: app-test `at0474-dash-arc-transcript.test.ts` asserts the pre-arc conversation rows and the post-rotation rows are in one transcript, separated by a `system_note` divider naming the stage.)
- A relaunch re-renders the whole arc in order. (Verify: the same app-test's restore leg asserts conversation → devise → review rows in that order, with dividers, after a `request_replay`.)
- A failed stage stops visibly and resumes. (Verify: `tugutil dash arc <name> --json` reports `stopped` with a stage and reason; a subsequent `tugutil dash run <name>` continues from that stage, appending no duplicate `arc-stage` line for a stage that already completed.)
- The user's card model is never written, and is theirs again the moment the arc ends. (Verify: a Rust test asserting the rotation's `model_change` frame carries the *stage's* declared model, and a supervisor test asserting that `arc-done` and `arc-stop` each send one `model_change` carrying the last selector the *deck* sent for that session — `"default"` when it never sent one, [P15].)

#### Scope {#scope}

1. The arc record as dash-log lines, keyed by dash name from hand-off ([B16]).
2. `tugutil dash run` / `tugutil dash arc` verbs.
3. `[tugtool.dash]` stage models and the implement rotation threshold ([B04], [B15]).
4. tugcode's `session_stage` announcement and the stage-aware `session_command`.
5. tugcast originating a stage on a card's tugcode ([F07]) — the one new primitive.
6. The runner: predicate, dispatch, tick, restart resumption, stop state.
7. Skill endings under an arc ([B11]).
8. The stage divider row and the lineage-aware restore ([B13]).
9. The arc's card receipt and stopped-state faces ([B09], [B10]).
10. `tugplug:dash`'s hand-off for a bare `/dash` ([B01], [B14]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **The Lens Dashes cleanup** ([B12]) — a sibling plan sharing no code with this one.
- **A graphical kick-off** on the Session card or the Lens. `/dash` in the composer is the door.
- **Sub-agents, swarms, or the `Workflow` tool as the runner** — the lane is agentless by charter, and the runner is not a model at all ([B02]).
- **`SharedAgent` as the stage substrate** ([F08]).
- **Headless stages.** Every stage is a card-visible session ([B05]).
- **Automating the join.** Landing stays the user's act ([B08], [B09]).
- **Retiring the hand-driven skills.** `/tugplug:plan-devise`, `/tugplug:plan-review`, `/tugplug:dash-implement` stay the expert path ([B11]).
- **Any change to `SessionLedger`'s callsign minting.** Stages inherit identity through the existing transfer path ([P03]).

#### Dependencies / Prerequisites {#dependencies}

- `tugdash_core::dash` dash-log grammar (`append_dash_log`, `split_log_line`, `is_terminal`, `read_declarations`) — `tugrust/crates/tugdash-core/src/dash.rs`.
- `tugutil plan lint | status | stamp` — `tugrust/crates/tugutil/src/plan.rs`; exit codes 0/1/2 and the `review: reviewed | stale | never-reviewed` field ([F04]).
- `AgentSupervisor`'s CODE_INPUT dispatcher and its `input_tx` path — `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`.
- The tugcode relay loop in `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` (the `session_fork` / `session_init` handling around the relay loop).
- tugcode's inbound verb registry — `tugcode/src/inbound-dispatch.ts`, `tugproto/src/inbound.ts`, `tugcode/src/types.ts` ([reference: three edits are needed for any new inbound verb](#tugcode-inbound-allowlist)).
- `SessionLedger::inherit_fork_identity` / `set_fork_provenance` / `resolve_to_lineage_head` — `tugrust/crates/tugcast/src/session_ledger.rs`.
- `DashDetail.join_ready` and the join pilot ([D147], [F04]) — nothing in this plan changes them.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace (`tugrust/.cargo/config.toml`).
- **Only the user commits to `main`** — the arc commits nothing there ([B08]).
- **The card's model is the user's** ([B04]); the runner may set a model only on a session it started, and hands the card back on the deck's own last selector when the arc ends ([P15]).
- **No new ledger database.** The arc record is dash-log lines ([B16]); no `changes.db` schema change, no `CHANGES_SCHEMA_VERSION` bump.
- **`AskUserQuestion` shape is fixed upstream** — 1–4 questions, 2–4 options; the runner never generates one ([B06]).
- **App-tests are selective** — `just app-test-changed`, never the full corpus.

#### Assumptions {#assumptions}

- A stage's opening prompt is an ordinary slash-command invocation the skills already accept (`/tugplug:plan-devise <idea> 🢂 <path>`, `/tugplug:plan-review <path>`, `/tugplug:dash-implement <path> [Steps N-M]`).
- The project declares a docs dir (this repo declares `docs = "dash"` in `.tugtool/config.toml`); an undeclared project asks once through the existing `tugutil dash docs-dir --set` contract.
- `claude` accepts the declared stage model selectors; an unset stage model means "the account default", which is what an un-`set_model`'d fresh session already gets.

---

### Reference and Anchor Conventions {#reference-conventions}

Anchors are explicit and kebab-case; plan-local decisions are `[P01]…`, global ones `[D##]`; brief citations are `[F##]` (evidence) and `[B##]` (decisions) and refer to [`dash/streamline-dash-workflow-brief.md`](streamline-dash-workflow-brief.md).

---

### Open Questions {#open-questions}

None. The brief closed every question it opened, and this plan opened none it could not settle from the code — including the one place the brief's spelling has gone stale, which is settled as [P03] rather than deferred.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A runner tick fires twice and starts two stages | high | med | One in-flight arc per dash held in the dispatcher; the dash-log's own last `arc-stage` line is the durable mark | Two `arc-stage` lines for one stage appear in a real log |
| A rotation lands mid-turn and interrupts the user | high | low | Rotation is dispatched only on `turn_complete` for the arc-owned session ([P05]) | Any observed rotation with an open turn bracket |
| A stage's `session_stage` is mistaken for a rewind-fork | med | low | Distinct IPC type, empty `fork_point`, distinct divider `source` ([P03], [P09]) | A stage row showing a rewind affordance |
| A relaunch renders only the last stage | med | med | Lineage-aware restore ([P10]) with an app-test on the restore leg | A restored card missing its conversation |
| The review loop never terminates | med | low | Hard cap of one further round ([P06]); on the cap the arc proceeds with a note | A third review round observed |

**Risk R01: two runners, one dash** {#r01-double-dispatch}

- **Risk:** The tick has two sources ([P05]); both could fire for the same arc.
- **Mitigation:** the dispatcher holds a per-dash in-flight set and re-reads the dash-log immediately before rotating; the log line is written *before* the frames go out.
- **Residual risk:** a tugcast restart between the log write and the frames leaves a recorded stage with no session — resolved by the resume path in [#step-8], which treats a recorded stage with no live session as "rotate it again".

**Risk R02: a stage session the user takes over** {#r02-user-takeover}

- **Risk:** the user types into a stage session mid-arc.
- **Mitigation:** none needed by decision — the card is theirs, the stage is visible, and a user turn is just more context for the stage. The runner's next tick still reads documents ([B02]), so a user detour cannot corrupt the transition.
- **Residual risk:** a user who types `/new` mid-arc orphans the stage; the arc stops on its next tick with `session gone` ([B10]).

---

### Design Decisions {#design-decisions}

#### [P01] The arc record is dash-log lines, read through one typed reader (DECIDED) {#p01-arc-record}

**Decision:** The arc is recorded as new markers in the existing per-project dash-log (`project_state_dir/dash-log.md`), keyed by dash name, and read by a new `tugdash_core::arc` module — never by an ad-hoc grep.

**Rationale:**
- [B16]: the record must exist before a branch does, so nothing git-scoped can hold it; the dash-log is already per-project, append-only, keyed by name, and already the file tugcast's recompute walks.
- The generation reset that `read_declarations` performs at `is_terminal` (`dash.rs`) gives the arc the same free property: a reused dash name is not born mid-arc.
- `read_declarations` matches its markers exhaustively and ignores everything else, so new markers are additive.

**Implications:**
- New markers only; no change to `split_log_line`'s four-field grammar or to `is_terminal`.
- `tugcast` gains a reader, not a writer of a new file.
- **The record says what the arc is doing; the dash binding says whose card it is.** No arc line names a tug session, because that fact already has a home: the session↔dash binding in `sessions.db` (`SessionLedger::set_dash_binding`, keyed by the dash's owner key), which is what the join pilot already reads for *bound*. The `arc_run` request binds the calling session to the dash on arrival ([#step-6]) — `ensure_dash_id` mints the owner key as a git config entry and needs no branch to exist, so a pre-branch arc binds exactly as a created dash does, and `dash create` later finds the same `tugid`. The tick resolves "which arc does this session own" through that binding, and a tugcast restart resumes by walking `bound_sessions_by_dash` rather than guessing which projects have logs ([#step-8]).

#### [P02] A stage is three CODE_INPUT frames, model first (DECIDED) {#p02-three-frames}

**Decision:** tugcast originates a stage by sending, in order, `model_change` → `session_command {command:"new", stage:{…}}` → `user_message` on the card's existing tugcode CODE_INPUT channel.

**Rationale:**
- [B05], [F07]: exactly the frames the deck sends today; the only new thing is who sends them.
- Model **first** because `handleModelChange` records the selector and `liveSpawnConfig` re-applies it on the next spawn (`tugcode/src/session.ts`) — so a model recorded before `handleNewSession` is the model the fresh claude is *spawned* with, rather than one flipped underneath it a moment later.
- `do_request_replay` in `agent_supervisor.rs` is the working precedent for the supervisor putting a frame on `input_tx` itself, including its `Spawning` / `Idle` / `Errored` state handling, which the new sender copies rather than reinvents.

**Implications:**
- The rotation must handle the same `SpawnState` matrix `do_request_replay` handles; an `Idle` card has no claude to rotate and the arc waits.
- No card rebinding, no headless spawn, no second tugcode.

#### [P03] Stage lineage reuses the fork provenance columns with an empty fork point (DECIDED) {#p03-stage-lineage}

**Decision:** tugcode announces `session_stage` (the `session_fork` shape with `forkPoint: ""` and no copied history); tugcast's bridge calls the same `SessionLedger::inherit_fork_identity` and stages the same `PendingFork`, whose `fork_point` becomes `Option<String>` (`None` for a stage).

**Rationale:**
- [B05] wants stages announced as lineage, not strangers, and the fork path is the only lineage edge the ledger has: `forked_from_session_id` / `fork_point` are what `resolve_to_lineage_head` walks and what `resolve_ink_session` keys durable ink on (`agent_supervisor.rs`).
- **The brief's spelling here is stale.** [B05] says tugcast names stages `<root>-A1/A2/A3`; that lineage-suffix grammar is retired — `session_ledger.rs`'s module docstring records that `tag_lineage_points` is dropped, `migrate_collapse_lineage_chains` collapses existing chains onto their root spelling, and a fork now inherits its parent's callsign **verbatim by transfer**. Honoring [B05]'s intent means inheriting verbatim, which is what the code already does; minting a suffix would be re-adding a retired grammar.
- An empty fork point is honest: a stage has no branch point, because nothing was copied.

**Implications:**
- The whole arc wears one callsign — the conversation's — so the session ledger, the Lens Sessions list, and the ink store all read it as one line of work.
- Ink written in any stage restores into the same scroll, unchanged, because `resolve_ink_session` already resolves to the lineage head.

#### [P04] The runner is a pure predicate plus a separate dispatcher (DECIDED) {#p04-predicate-dispatch}

**Decision:** `tugcast/src/feeds/dash_arc.rs` exports `arc_action(&ArcRecord, &ArcFacts) -> Option<ArcAction>`, pure over facts the caller already holds; the act lives beside the changeset recompute, as the join pilot's does.

**Rationale:**
- `join_pilot.rs`'s module docstring states the reasons in full — the predicate sits on a path that already does a blocking git walk, and a mark checked in the predicate and acted on a scheduling hop later is a time-of-check/time-of-use window two recomputes walk straight through.
- A pure predicate is testable against synthesized document facts, which is how [#success-criteria] gets proven without running a model.

**Implications:**
- `ArcFacts` is a plain struct the dispatcher fills (lint exit code, review status, ledger rows, latest context reading, whether the arc's session is live and idle).
- No I/O inside the predicate.

#### [P05] The tick is `turn_complete` on an arc-owned session, with the recompute as a floor (DECIDED) {#p05-tick}

**Decision:** The arc advances when the supervisor sees a session an arc owns go idle — the same idle transition that already feeds `turn_complete_tx` — and the changeset recompute also ticks arcs, as a slower floor.

**Rationale:**
- A stage finishes by finishing a turn; that is the moment the document facts have just changed. The supervisor already recognizes it: in `agent_supervisor.rs`'s CODE_OUTPUT loop, a non-wake frame with `replay_brackets_open == 0` flips `entry.turn_active = false` and sends the tug session id on `turn_complete_tx`, which `base_motion.rs` consumes to catch up a dash parked behind a mid-turn gate. The arc's tick is a second consumer of that one signal, not a second recognizer of the line.
- Rotating only at turn end is also the mitigation for [#r02-user-takeover] and for interrupting the user mid-work.
- The recompute floor covers the case where the stage session died without a `turn_complete` (a crash mid-turn never sends one — the bridge clears `turn_active` on child exit and says so).

**Implications:**
- Replay-bracketed frames are already excluded at the source (`replay_brackets_open == 0`), so the tick inherits the exclusion rather than re-deriving it.
- **The first rotation is a tick like every other one, never a synchronous act on the request.** `tugutil dash run` is issued *from inside the conversation session's own turn* — the model typing it is mid-turn on the card the arc is about — so rotating on receipt of the `arc_run` request would kill claude in the middle of the turn that asked for the arc. The request records the arc and returns; the devise stage rotates on the conversation session's own `turn_complete`.

#### [P06] Review runs at most twice (DECIDED) {#p06-review-cap}

**Decision:** Devise → review when `plan lint` exits 0 and the plan file exists; review → implement when `plan status` reports `reviewed`; review → review once more when the round left the plan `stale`; on the cap, proceed to implement and record a note.

**Rationale:** [B07] verbatim. A plan a second review could not settle is one `dash-implement`'s own setup gate will raise anyway.

**Implications:** the arc record carries a review-round count, derived by counting `arc-stage review` lines in the current generation rather than stored separately.

#### [P07] Implement rotates at step boundaries on a measured context reading (DECIDED) {#p07-implement-rotation}

**Decision:** When a step goes `done`, the runner reads the stage session's latest `context_breakdown`; above `[tugtool.dash].implement_rotate_at` (default `0.6`) it rotates with opening prompt `/tugplug:dash-implement <plan> Steps N-M`, where `N` is the ledger's first non-`done` row and `M` the run's declared last step.

**Rationale:** [B15] verbatim; tugcode already emits `context_breakdown` and tugcast already records the latest per session (`do_record_context_breakdown` / `SessionLedger::record_context_breakdown`), so this is a measurement, not a guess.

**Implications:** never mid-step; a step that blows the window is the model's to survive by auto-compact, as today.

#### [P08] Under-arc is one environment variable the stage's claude carries (DECIDED) {#p08-under-arc-env}

**Decision:** A stage session is spawned with `TUG_DASH_ARC=<dash-name>` in its environment; the three skills read it and stop at their natural end instead of printing a chip or reviewing inline.

**Rationale:** [B11] — the skills stay the stage contracts and only their endings change. An env var is what a skill can actually read from a Bash step, and it is per-session, so a hand-driven `/tugplug:plan-review` in another card is unaffected.

**Implications:** the rotation's `session_command` carries the stage metadata; tugcode adds the variable to the spawn env for that session (it already composes spawn args and env per session in `spawnClaude` / `liveSpawnConfig`).

#### [P09] The divider is a `system_note` with `source: "stage"` (DECIDED) {#p09-divider-row}

**Decision:** The stage boundary renders as the existing `SystemNote` message kind with a new `source` value `"stage"`, carrying the stage name, model, and document path in its `text`.

**Rationale:** `tugdeck/src/lib/code-session-store/types.ts` documents the `source` union as the extension point ("future kinds extend the `source` union without changing the substrate shape"), and `compaction.ts` is the working precedent — the compaction divider is exactly this shape. No new row kind, no new renderer.

**Implications:** the deck's event union gains a `session_stage` event; the reducer folds it into a `system_note`. `handleSessionInit` already does **not** clear the transcript ([B13], verified in `reducer.ts`), so nothing else has to change for the live case.

#### [P10] Restore replays the lineage, in order, through `request_replay` (DECIDED) {#p10-lineage-restore}

**Decision:** `request_replay`'s payload gains an optional ordered `lineage` array of claude session ids; tugcast fills it by walking `forked_from_session_id` back from the lineage head, and tugcode replays each JSONL in order, synthesizing the divider at each boundary from the ledger-supplied stage metadata carried alongside.

**Rationale:**
- `tugcode/src/replay.ts` replays exactly one JSONL — `resumeSessionId`'s — so a relaunched card shows only the last stage ([B13]).
- `request_replay` already carries an optional `window` the supervisor forwards verbatim without interpreting, so the payload is already an extension point, and `do_request_replay`'s front-push ordering keeps working untouched.
- The alternative — a spawn-arg list — would bake the lineage at spawn time, before a later stage exists.

**Implications:** the arc's stage metadata must be recoverable per session id; it is, from the dash-log's `arc-stage` lines ([P01]).

#### [P11] A stopped arc is a resumable one (DECIDED) {#p11-stopped-arc}

**Decision:** A stage that exits red writes `arc-stop <stage> <reason>`; the arc shows stopped on the card and in the Lens row; `/dash` (Orient) finds it and continues from that stage.

**Rationale:** [B10] verbatim — the arc never silently retries and never restarts from the top, because the documents hold the progress.

**Implications:** resuming re-rotates the stopped stage only; earlier stages are never re-run.

#### [P12] "All done" is the join offer plus one receipt (DECIDED) {#p12-terminal-state}

**Decision:** The terminal state is the fact the join pilot already reads — final declared step `done` → `join_ready` → the Changes shade summons itself — plus one arc receipt row on the card. No `/join` chip.

**Rationale:** [B09], [D147], [D152], [D156]. The runner adds no new progress UI; it advances facts the existing surfaces already read ([F10]). Under [D156] the shade's arrival is *route entry* on a quiet moment, gated on subscribed signals and remembered once per dash head — the arc supplies the head-moving fact and nothing else.

**Implications:** nothing in this plan touches `join_pilot.rs`, `DashDetail.join_ready`, or the reveal's gates.

#### [P13] Stage models are `[tugtool.dash]` keys (DECIDED) {#p13-stage-models}

**Decision:** `devise_model`, `review_model`, `implement_model` (each `Option<String>`) and `implement_rotate_at` (`Option<f32>`, default `0.6`) join `DashConfig` in `tugrust/crates/tugutil-core/src/config.rs`, are reported by `tugutil dash config --json`, and are documented in `DEFAULT_CONFIG`.

**Rationale:** [B04], [F11], and [D151] — a project declares how its own tree is hydrated, checked, and built in `[tugtool.dash]`, and `tugutil dash config` is the single reader, absent keys as `null`, a missing config file exit 0. These four keys are that pattern's next entry, not a new mechanism.

**Implications:** unset means the account default, and [D151]'s degradation doctrine applies — every absence gets a sentence, so the arc's receipt names which stages ran on the account default rather than implying a choice nobody made. `dev.plan-review-last` and the "review on whatever is selected" contract survive untouched for the hand-driven `/plan-review` (`tugdeck/src/lib/plan-review.ts`).

#### [P14] Every stage runs in the card's own project dir; the implement stage reaches the worktree by absolute path (DECIDED) {#p14-stage-cwd}

**Decision:** A stage never changes the card's working directory. Devise and review write into the base checkout's docs dir; the implement stage creates the dash and works in its worktree the way a hand-driven `dash-implement` already does — through absolute paths, with `tugutil dash commit` taking the rounds.

**Rationale:**
- A tugcode subprocess's cwd is fixed at spawn (`projectDir`, the path tugdeck sent on `spawn_session`); rotating a claude session under it cannot change it, so [B03]'s "implement runs in the dash worktree" cannot mean a different cwd for the same card.
- It does not have to. That is already how the lane works: `dash-implement` runs from a base-checkout-rooted session and operates on the worktree by absolute path — and the standing hazard is that a shell's cwd silently reverts to the base checkout between calls, which is why the doctrine says to `cd` explicitly every time.
- The alternative — respawning tugcode with a different `projectDir` — would rebind the card, which [B05] forbids in as many words.

**Implications:**
- The implement stage's opening prompt names the plan by a path valid from the card's project dir; `dash-implement`'s own setup gate resolves the worktree from there, unchanged.
- The stage session's `TUG_SESSION_ID` and card binding are unchanged across every rotation ([P03]), so changes attribution keeps working through the arc without a claim gesture.

#### [P15] The arc hands the card back on the deck's own model (DECIDED) {#p15-model-restore}

**Decision:** The supervisor remembers, per tug session, the last `model_change` selector that arrived from a WebSocket client — the deck's own act — and at `arc-done` or `arc-stop` the runner sends exactly one `model_change` carrying it (`"default"` when the deck never sent one, which `handleModelChange` maps to "no `--model`").

**Rationale:**
- Without this, [B04] is only half true. `handleModelChange` records the selector on the manager (`currentModel`) and every later spawn — including the user's own `/new` — reuses it, so a card whose arc ended on the implement model would *stay* there. The deck's per-card persistence (`use-model.ts`, `writePersistedModel`) is untouched by the arc and would only correct the drift on the next mount, through `evaluateMountRestore`; live, the card would read the stage's model as its own.
- The deck's selector display follows `system_metadata`, so during a stage it honestly shows the stage's model; the restore is what makes it honest again afterwards.

**Implications:** the recorded deck selector is in-memory on the supervisor's ledger entry — it is a live fact, not a durable one; a tugcast restart mid-arc resumes on whatever the card sends next, which the deck's mount restore already does. No new frame type: the restore is frame (1) of Spec S01 with the deck's value in it.

#### [P16] The runner reads the plan where it currently lives (DECIDED) {#p16-plan-location}

**Decision:** Before the implement stage, the plan is at the path the runner chose when it composed the devise prompt — `<docs>/<dash-name>.md` in the base checkout, recorded as `arc-plan` at that rotation. From the implement stage's `dash create --plan` onward, the runner reads it at `<DashDetail.worktree_abs>/<DashDetail.plan_path>`, and reads run completion from `DashDeclarations::run_complete`, never from the base path.

**Rationale:**
- Adoption ([D139]) commits the plan on the dash branch and **cleans the base copy** — the file the devise and review stages wrote no longer exists at that path once implement starts. A runner that kept reading the base path would see "plan gone" and stop a healthy arc.
- `DashDetail` already carries `plan_path` (relative to the worktree) and `worktree_abs`, and `read_declarations` already derives `run_through` / `run_complete` from the `run-through` and `step-done` lines — the implement stage's own `dash step … --through` declarations are the document facts, so the ledger rows are read for `N` and completion is read from the log.

**Implications:** `arc-plan` is written by the runner at devise rotation, not "when first seen" — the path is the runner's choice, made so the devise prompt can name it. `ArcFacts` carries the resolved current path; `arc_action` never resolves one.

---

### Deep Dives {#deep-dives}

#### What a stage rotation actually is, frame by frame {#rotation-anatomy}

The deck sends all three of these today; the runner sends the same three. On the wire they are CODE_INPUT frames carrying a `tug_session_id`, dispatched by `AgentSupervisor`'s dispatcher and relayed to tugcode's stdin.

**Spec S01: the rotation frames** {#s01-rotation-frames}

| # | Frame | Payload | Handled by |
|---|---|---|---|
| 1 | `model_change` | `{ model: <stage model> }` | `handleModelChange` — records the selector, sends a live `set_model` control request |
| 2 | `session_command` | `{ command: "new", stage: { name, document, plan?, arc } }` | `handleSessionCommand` → `handleNewSession` — kills claude, mints a fresh id, spawns with empty history |
| 3 | `user_message` | `{ text: <the stage's opening prompt> }` | the ordinary prompt path |

Between (2)'s spawn and its synthetic `session_init`, tugcode writes the new `session_stage` line (Spec S02) — the same placement `session_fork` occupies today, and for the same reason: the bridge must stage the identity transfer *before* the `session_init` that consumes it.

**Spec S02: the `session_stage` IPC line** {#s02-session-stage}

```json
{"type":"session_stage","parentSessionId":"<previous claude id>","newSessionId":"<fresh claude id>",
 "stage":"devise|review|implement","model":"<selector or empty>","document":"<repo-relative path>",
 "arc":"<dash name>","ipc_version":2}
```

The bridge's handling mirrors the `session_fork` branch in `agent_bridge.rs`: parse, `inherit_fork_identity(parent, new)`, stage a `PendingFork { tag, user_name, parent_session_id, fork_point: None }` keyed by the new claude id, and let the `session_init` that follows consume it. The line is also relayed to the deck like every other tugcode IPC line, which is what feeds [P09]'s divider.

**Spec S09: the opening prompt per stage** {#s09-opening-prompts}

The runner composes frame (3) from the arc record and the config alone; nothing in it is model text. `<docs>` is the project's declared docs dir (`tugutil dash docs-dir`), `<name>` the dash name, `<document>` the `arc-start` path, `<plan>` the current plan path ([P16]).

| Stage | Prompt |
|---|---|
| devise | `/tugplug:plan-devise a plan for <document>, honoring every [B##] decision it records 🢂 <docs>/<name>.md` |
| review | `/tugplug:plan-review <plan>` |
| implement (first) | `/tugplug:dash-implement <plan>` — no selector; the whole plan, and `dash-implement`'s own setup declares `--through` |
| implement (continued) | `/tugplug:dash-implement <plan> Steps N-M` ([P07]) |

When the input document is already a plan (`tugutil plan lint` exits 0 on it), the devise stage is skipped: `arc-plan` records the document itself and the first rotation is `review`. A brief exits 2 and takes the full arc.

#### The state machine, as documents {#arc-state-machine}

**Spec S03: transitions** {#s03-transitions}

| From | Condition (all document facts) | To |
|---|---|---|
| `start` | an input document exists at the recorded path | rotate `devise` |
| `devise` | stage session idle **and** the plan path exists **and** `plan lint` exits 0 | rotate `review` |
| `devise` | stage session idle **and** lint still non-zero after the stage's own turn ended | `stop(devise, "lint")` |
| `review` | `plan status` → `reviewed` | rotate `implement` |
| `review` | `plan status` → `stale` **and** fewer than 2 `arc-stage review` lines this generation | rotate `review` |
| `review` | `plan status` → `stale` **and** the cap reached | rotate `implement`, note recorded ([P06]) |
| `implement` | a step went `done`, more steps remain, context reading above threshold | rotate `implement` at `Steps N-M` ([P07]) |
| `implement` | the run's declared final step is `done` | `done` ([P12]) |
| any | the arc's session is gone, or the stage exited red | `stop(stage, reason)` ([P11]) |

Nothing in this table reads a word a model wrote ([B02], [F04]).

**The dash itself comes into being at implement, not at hand-off.** The arc record is keyed by name from the moment `/dash` hands off ([B16]), but no branch or worktree exists until the implement stage's own `dash-implement` setup runs `tugutil dash create --plan`, which commits the plan on the dash branch and cleans the base copy ([D139], [F01]) — which is why the plan is never committed on `main` ([B08]). `create` is idempotent on the name, and the name was settled at hand-off, so the arc's `arc-stage` lines and the dash's later `step-start` / `step-done` / `run-through` lines are one record under one key.

#### The tuglaws cross-check {#tuglaws-cross-check}

| Law | Where it bites | Verdict |
|---|---|---|
| **[L02]** external state enters React through `useSyncExternalStore` only | the divider row and the arc's stage/stopped faces are store data rendered by React | Honored — the divider is a `system_note` in the existing message array ([P09]); the arc fields ride the dash detail payload the Changes stores already publish ([#step-13]) |
| **[L06]/[L24]** appearance goes through CSS and DOM | the divider's treatment, and any accent the stopped state wears | Honored — the row's *text* is data (a non-rendering consumer, the restore, reads it); its treatment is CSS keyed on `data-source="stage"` ([#state-zone-mapping]) |
| **[L22]** store-driven DOM updates observe the store directly | nothing here drives direct DOM writes from a store | Not engaged — every new deck surface renders |
| **[L29]** every persisted or compared path routes through the gateway | `dash run --project`, and the arc record keyed per project | Honored — the CLI passes the path as the user spelled it and `/api/dash` resolves it through the gateway, the rule `dash.rs` already states and [D150] paid for breaking |
| **[L31]** a gesture produces the act or a visible reason | a rotation tugcode refuses; a stage that exits red; a `run` with no calling session | Honored, and it is the reason the refusal chain is spelled out end to end: `drive_stage` returns its refusal ([#step-6]), the dispatcher writes `arc-stop <stage> <reason>` ([#step-8]), and the faces show it ([#step-13]). A silent early return anywhere on that chain is the exact failure the join arc already paid for |
| **[L23]** teardown captures and replays | a stage rotation tears down a claude process under a live card | Honored by construction — the transcript is not torn down (`handleSessionInit` mutates only the jobs ledger), and the restore replays the lineage ([P10]) |

Global decisions this plan inherits rather than reopens: **[D147]** (finished is derived, never declared), **[D149]** (the run's ending verifies the fit; the join gate is reconcile-clean alone), **[D151]** (the project declares its own commands; every absence gets a sentence), **[D152]**/**[D156]** (the Changes shade is the room the join decision happens in, entered on a quiet moment).

#### tugcode's inbound allowlist is three edits, not one {#tugcode-inbound-allowlist}

Adding or extending an inbound verb touches three files or the message is rejected at the boundary with `Invalid message type`: the shape in `tugproto/src/inbound.ts` (interface **and** the `INBOUND_VERBS` array), the type guard in `tugcode/src/types.ts`, and the handler in `tugcode/src/inbound-dispatch.ts`'s `INBOUND_HANDLERS`. A coverage test already asserts the registry has an entry for every verb in `INBOUND_VERBS`; it will fail loudly if the third edit is missed. This plan extends `session_command` rather than adding a verb, but the `stage` field must still be added to the interface for the guard to admit it.

---

### Specification {#specification}

#### The dash-log arc grammar {#arc-grammar}

**Spec S04: arc markers** {#s04-arc-markers}

Lines keep the existing four-field shape `<iso8601>  <dash>  <marker>  <note>` (`append_dash_log` / `split_log_line`).

| Marker | Note | Meaning |
|---|---|---|
| `arc-start` | `<document path>` | The arc opened on this document ([B14], [B16]) |
| `arc-stage` | `<stage> <claude session id> <model or "-">` | A stage was rotated |
| `arc-plan` | `<plan path>` | The path the runner named in the devise prompt, written at the devise rotation ([P16]); base-relative, and superseded by the worktree copy from adoption on |
| `arc-note` | free text | A recorded runner note (e.g. the review cap, [P06]) |
| `arc-stop` | `<stage> <reason>` | The arc stopped ([P11]) |
| `arc-done` | *(empty)* | The arc reached its terminal state ([P12]) |

**Spec S05: `ArcRecord`** {#s05-arc-record}

```rust
pub enum ArcStage { Devise, Review, Implement }

pub struct ArcStageLine {
    pub stage: ArcStage,
    pub session_id: String,
    pub model: Option<String>,
    pub at: String,
}

pub struct ArcRecord {
    pub dash: String,
    pub document: Option<String>,
    pub plan: Option<String>,
    pub stages: Vec<ArcStageLine>,      // in log order, current generation only
    pub notes: Vec<String>,
    pub stopped: Option<(ArcStage, String)>,
    pub done: bool,
    pub last_activity: Option<String>,
}
```

`read_arc(repo_root, dash) -> Option<ArcRecord>` applies the same generation reset `read_declarations` applies: everything at or before the last `is_terminal` line is discarded. `None` means this dash has no arc — which is every dash created by hand.

#### CLI surface {#cli-surface}

**Spec S06: `tugutil dash run`** {#s06-dash-run}

```
tugutil dash run <name> --document <path> [--project <dir>] [--session <id>] [--json]
tugutil dash run <name> [--project <dir>] [--json]      # resume a stopped arc ([P11])
```

Writes `arc-start` (new arc) or nothing (resume), then POSTs the arc kick to the instance that owns the calling session, over the existing `POST /api/dash` route (`tugrust/crates/tugcast/src/dash_api.rs`, `server.rs`'s `dash_handler`), which is already the CLI's write surface into a live tugcast and already resolves `project_dir` through the [L29] gateway. Refuses with an actionable message when there is no calling session (the arc must run on a card).

**Spec S07: `tugutil dash arc`** {#s07-dash-arc}

```
tugutil dash arc <name> [--project <dir>] [--json]
```

Reports the `ArcRecord` — stage, document, plan, stopped reason, done. Exit 0 for "no arc" (a state, not an error), matching `dash docs-dir`'s precedent.

#### Configuration schema {#config-schema}

**Spec S08: new `[tugtool.dash]` keys** {#s08-config-keys}

| Key | Type | Default | Meaning |
|---|---|---|---|
| `devise_model` | string | unset | Model for the devise stage ([P13]) |
| `review_model` | string | unset | Model for the review stage |
| `implement_model` | string | unset | Model for the implement stage |
| `implement_rotate_at` | float | `0.6` | Context fraction above which implement rotates at a step boundary ([P07]) |

#### State Zone Mapping (tugdeck) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Stage divider row in the transcript | structure | store + `useSyncExternalStore` — a `system_note` message in the reducer's message array | [L02] |
| Arc stage / stopped reason on the Z2 DASH cell and Lens row | structure | store + `useSyncExternalStore` over the existing dash detail payload | [L02] |
| The divider's visual treatment | appearance | CSS on the existing `system_note` row, keyed by a `data-source="stage"` attribute | [L06], [L24] |
| Arc receipt row | structure | durable ink, keyed to the lineage head by `resolve_ink_session` — no new store state | [L02] |

---

### Rollout {#rollout}

#### Milestones {#milestones}

Fifteen steps is too many for one sitting, so the run is five, each a separate `dash-implement` invocation on **the same dash** — one `create --plan` at M01, one join at the end, decided 2026-08-24. Every milestone ends on a step whose checkpoint proves something by itself, and every milestone but the last leaves `main` no different in behaviour: the arc is inert until `/dash` hands off ([#step-14]), so a partially built arc is additive code nobody calls. The boundaries are dependency-clean — no step in a milestone depends on a step in a later one — which is what lets each invocation resolve its selection without stopping on an unfinished base.

| Milestone | Steps | What it proves when it closes |
|---|---|---|
| M01 — The record | [#step-1]–[#step-3] | `tugutil dash arc` reads a synthesized arc back; the four config keys report from `dash config` |
| M02 — The primitive | [#step-4]–[#step-6] | `tugutil dash run <name> --document …` visibly starts a stage session on a live card, by hand, with no runner |
| M03 — The runner | [#step-7]–[#step-9] | the predicate passes one test per transition; a dispatcher tick rotates once and only once |
| M04 — One transcript | [#step-10]–[#step-12] | `at0474` shows conversation → divider → stage rows live, and again after a reload |
| M05 — The door | [#step-13]–[#step-15] | a bare `/dash` on a real brief runs to the join offer; the fit is verified |

The invocations, in order — each declares its own `--through`, so the join offer arms after each ([D147]); close the shade and carry on until M05:

`/tugplug:dash-implement dash/streamline-dash-workflow.md Steps 1-3`
`/tugplug:dash-implement dash/streamline-dash-workflow.md Steps 4-6`
`/tugplug:dash-implement dash/streamline-dash-workflow.md Steps 7-9`
`/tugplug:dash-implement dash/streamline-dash-workflow.md Steps 10-12`
`/tugplug:dash-implement dash/streamline-dash-workflow.md Steps 13-15`

M02 and M04 both change tugcode and Rust, so each ends with `just build-app` before its checkpoint's live leg — the app bundle is not rebuilt by an app-test.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | Where |
|---|---|---|
| **Unit (Rust)** | The arc grammar reader, the transition predicate, config parsing | `tugdash-core`, `tugcast`, `tugutil-core` — `cargo nextest run` |
| **Unit (TS)** | Reducer folding of `session_stage` into a `system_note`; replay lineage ordering | `bun test` in `tugdeck` / `tugcode` |
| **Integration (Rust)** | The rotation sender against a fake tugcode: three frames, right order, right payloads | `tugcast` tests, in the style of the existing supervisor dispatcher tests |
| **App-test** | One card, one transcript, dividers, restore order | `tests/app-test/at0474-dash-arc-transcript.test.ts` |

#### What stays out of tests {#test-non-goals}

- **A full live arc end-to-end in CI** — a real devise stage is minutes of model work; the app-test drives the rotation primitive and the transcript, and the transitions are proven by the predicate's unit tests over synthesized facts.
- **DOM-level rendering of the divider** — there is no in-process DOM substrate; the divider is asserted in the real app by the app-test, and its store-side shape by a `bun test` over the reducer.
- **The join arm** — unchanged by this plan ([P12]) and already covered by the join pilot's own tests.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The arc record grammar and reader | done | `06af4c29a` |
| #step-2 | `tugutil dash run` and `tugutil dash arc` | done | `7f4c9c8c0` |
| #step-3 | Stage models in `[tugtool.dash]` | done | `702c79344` |
| #step-4 | tugcode announces a stage | pending | — |
| #step-5 | tugcast reads the stage as lineage | pending | — |
| #step-6 | tugcast originates a stage on a card's tugcode | pending | — |
| #step-7 | The arc transition predicate | pending | — |
| #step-8 | The runner: tick, dispatch, resume | pending | — |
| #step-9 | Implement-stage rotation at step boundaries | pending | — |
| #step-10 | The skills' endings under an arc | pending | — |
| #step-11 | The stage divider row | pending | — |
| #step-12 | Lineage-aware restore | pending | — |
| #step-13 | Arc faces: receipt, stopped, Z2 and Lens | pending | — |
| #step-14 | Bare `/dash` hands off | pending | — |
| #step-15 | Integration Checkpoint | pending | — |

---

#### Step 1: The arc record grammar and reader {#step-1}

**Commit:** `tugdash(dash-arc): record the arc as dash-log lines, keyed by name before any branch exists`

**References:** [P01] ([#p01-arc-record]), Spec S04 (#s04-arc-markers), Spec S05 (#s05-arc-record), [B16], [F04]

**Artifacts:**
- New `tugrust/crates/tugdash-core/src/arc.rs`, exported from `lib.rs`.
- `ArcStage`, `ArcStageLine`, `ArcRecord`, `read_arc`, and the append helpers (`append_arc_start`, `append_arc_stage`, `append_arc_plan`, `append_arc_note`, `append_arc_stop`, `append_arc_done`).

**Tasks:**
- [ ] Write `arc.rs` against Spec S04/S05, reusing `append_dash_log`, `split_log_line`, and `is_terminal` from `dash.rs` — do not re-derive the grammar (the docstring on `split_log_line` says why two parsers of one grammar is a defect).
- [ ] Apply the same generation reset `read_declarations` applies: discard everything at or before the last terminal line for this dash.
- [ ] Derive the review-round count from the `arc-stage review` lines rather than storing it ([P06]).
- [ ] Confirm `read_declarations`' marker `match` ignores the new markers, and pin it with a test rather than a comment.

**Tests:**
- [ ] `read_arc` on a log with no arc lines returns `None`.
- [ ] A full arc log reads back document, plan, three stages in order, and `done`.
- [ ] A log whose arc predates a `joined` teardown reads as `None` (generation reset).
- [ ] `arc-stop` reads as `stopped` with stage and reason; a later `arc-stage` for the same stage clears it.
- [ ] `read_declarations` over an arc-bearing log is byte-identical to the same log with arc lines stripped, except `last_activity`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`
- [ ] `cd tugrust && cargo clippy -p tugdash-core --all-targets`

---

#### Step 2: `tugutil dash run` and `tugutil dash arc` {#step-2}

**Depends on:** #step-1

**Commit:** `tugutil(dash-arc): add the run and arc verbs, so a hand-off is a recorded fact`

**References:** [P01] ([#p01-arc-record]), Spec S06 (#s06-dash-run), Spec S07 (#s07-dash-arc), [B02], [B16]

**Artifacts:**
- `DashCommands::Run` / `DashCommands::Arc` in `tugrust/crates/tugutil/src/cli.rs`, implemented in `tugrust/crates/tugutil/src/dash.rs`.

**Tasks:**
- [ ] Add the two subcommands, following the existing `--project` handling in `dash.rs` (resolve as the user spelled it; never canonicalize — [L29], and `/api/dash` is the gateway).
- [ ] `run` with `--document` appends `arc-start`; `run` without one resumes a stopped arc and refuses with an actionable message when there is no arc to resume.
- [ ] `arc --json` reports the `ArcRecord`; no arc exits 0 with `arc: null`.
- [ ] Refuse `run` with no calling session, naming what to do (the arc must run on a card, [B05]) — the existing session-resolution helper in `dash.rs` already produces that actionable error for the other verbs.
- [ ] Stop at the record. **The POST that tells a live tugcast about the arc lands in [#step-6]**, with the handler that receives it, so this step ships nothing whose receiver does not exist. Until then `run` writes the record and says the runner is not wired yet.

**Tests:**
- [ ] `run --document` on a fixture repo writes exactly one `arc-start` line with the document path.
- [ ] `run` twice on the same document does not write a second `arc-start`.
- [ ] `arc --json` round-trips a synthesized log into the documented payload.
- [ ] `arc --json` on an unknown dash exits 0 with `arc: null`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil -p tugutil-core`
- [ ] `cd tugrust && cargo run -p tugutil -- dash arc nonexistent --json` prints `arc: null` and exits 0

---

#### Step 3: Stage models in `[tugtool.dash]` {#step-3}

**Depends on:** #step-1

**Commit:** `tugutil(dash-arc): declare stage models and the implement rotation threshold`

**References:** [P13] ([#p13-stage-models]), Spec S08 (#s08-config-keys), [B04], [F11]

**Artifacts:**
- Four new fields on `DashConfig` in `tugrust/crates/tugutil-core/src/config.rs`, documented in `DEFAULT_CONFIG`.
- The same four reported by `tugutil dash config --json` (`dash.rs`'s config payload, which already reports `null` rather than absent for undeclared values).

**Tasks:**
- [ ] Add `devise_model`, `review_model`, `implement_model` (`Option<String>`) and `implement_rotate_at` (`Option<f32>`) with `#[serde(default)]`.
- [ ] Extend `DEFAULT_CONFIG`'s commented template with all four, in the same voice as the existing entries.
- [ ] Report them from `dash config --json`, `null` when undeclared.
- [ ] Add the four keys to this repo's own `.tugtool/config.toml` as comments only — declaring a model here is the user's call, not this plan's.

**Tests:**
- [ ] A config declaring all four parses into the expected values.
- [ ] A config declaring none reads all four as `None` and `implement_rotate_at` defaults to `0.6` at the consumer.
- [ ] `dash config --json` reports the four fields on a project that declares none.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core -p tugutil`

---

#### Step 4: tugcode announces a stage {#step-4}

**Depends on:** #step-1

**Commit:** `tugcode(dash-arc): announce a stage rotation as lineage, with the arc env on the fresh session`

**References:** [P02] ([#p02-three-frames]), [P03] ([#p03-stage-lineage]), [P08] ([#p08-under-arc-env]), Spec S01 (#s01-rotation-frames), Spec S02 (#s02-session-stage), [B05], [B11], [F06], (#tugcode-inbound-allowlist)

**Artifacts:**
- `stage?: { name, document, plan?, arc }` on the `session_command` inbound message — `tugproto/src/inbound.ts`, `tugcode/src/types.ts`, `tugcode/src/inbound-dispatch.ts`.
- `session_stage` on the outbound side, written by `handleNewSession` when a stage is present.
- `TUG_DASH_ARC` in the stage session's spawn environment.

**Tasks:**
- [ ] Make all three inbound edits (#tugcode-inbound-allowlist) — the shape, the `INBOUND_VERBS`/guard, and the handler — or the frame is rejected at the boundary.
- [ ] Thread the stage through `handleSessionCommand` → `handleNewSession`; write the `session_stage` line **before** the synthetic `session_init`, the placement `handleSessionFork` already uses and documents.
- [ ] Set `TUG_DASH_ARC` in `spawnClaude`'s **existing explicit `env` object** — the one that already exists to scrub the Anthropic auth vars so claude authenticates from `~/.claude.json`. `liveSpawnConfig` carries spawn *flags* (`pluginDir`, `permissionMode`, `effort`, `model`, `additionalDirectories`), not environment, so record the arc name on the manager beside `currentModel` and read it in `spawnClaude`; that is what makes it survive tugcode's own respawns (an `--effort` change, an `--add-dir`), exactly as `currentModel` survives them.
- [ ] Leave the no-stage path byte-identical on the wire: a plain `/new` from the deck must emit exactly what it emits today — **and it clears the recorded arc name**, so the first session the user starts after an arc spawns without `TUG_DASH_ARC`. The variable is per-arc, not per-card.
- [ ] While in `handleSessionFork`, correct its docblock: it still says tugcast allocates a `<root>-<Letter><Number>` lineage callsign, which `session_ledger.rs` retired ([P03]) — the fork inherits the parent's callsign verbatim. A comment that contradicts the ledger is the kind of thing the next reader builds on.

**Tests:**
- [ ] `bun test` in `tugcode`: a `session_command` with a stage produces `session_stage` then `session_init`, in that order, with the documented fields.
- [ ] A `session_command` without a stage produces no `session_stage` line, and a spawn after it carries no `TUG_DASH_ARC`.
- [ ] The inbound coverage test still passes (every `INBOUND_VERBS` entry has a handler).

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `cd tugcode && bunx tsc --noEmit`
- [ ] `cd tugproto && bunx tsc --noEmit`

---

#### Step 5: tugcast reads the stage as lineage {#step-5}

**Depends on:** #step-4

**Commit:** `tugcast(dash-arc): inherit identity across a stage boundary, with no fork point`

**References:** [P03] ([#p03-stage-lineage]), Spec S02 (#s02-session-stage), [B05], [F06]

**Artifacts:**
- A `session_stage` branch in the relay loop of `tugrust/crates/tugcast/src/feeds/agent_bridge.rs`, beside the `session_fork` branch.
- `PendingFork::fork_point` becomes `Option<String>` (`agent_supervisor.rs`), and `SessionLedger::set_fork_provenance` accepts an absent fork point.

**Tasks:**
- [ ] Add `parse_session_stage`, mirroring `parse_session_fork`, and stage a `PendingFork` with `fork_point: None`.
- [ ] Widen `fork_point` to `Option<String>` and update the `session_init` consumption path and `set_fork_provenance` (the column stays, written `NULL` for a stage).
- [ ] Nothing to do for delivery: the relay loop forwards **every** tugcode stdout line to the deck — `splice_tug_session_id` then `Frame::new(FeedId::CODE_OUTPUT, spliced)`, unconditionally, after the type-specific branches. `session_stage` reaches the deck for free, which is what [#step-11] consumes.
- [ ] Log the stage transfer at the same level the fork transfer logs, naming stage and parent.

**Tests:**
- [ ] A ledger test: after a stage announcement plus `session_init`, `resolve_to_lineage_head(parent)` returns the stage's id and the callsign is unchanged (inherited verbatim — [P03]).
- [ ] A stage row's `fork_point` column is `NULL` while a rewind-fork's is the prompt uuid.
- [ ] `resolve_ink_session` on the conversation's id resolves to the newest stage.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo clippy -p tugcast --all-targets`

---

#### Step 6: tugcast originates a stage on a card's tugcode {#step-6}

**Depends on:** #step-2, #step-3, #step-5

**Commit:** `tugcast(dash-arc): send a stage's three frames on a card's own tugcode`

**References:** [P02] ([#p02-three-frames]), Spec S01 (#s01-rotation-frames), [B05], [F07]

**Artifacts:**
- `AgentSupervisor::drive_stage(tug_session_id, StageSpec)` in `agent_supervisor.rs`.
- A `dash_arc_run` CONTROL action arm beside `request_replay`'s; an `op: "arc_run"` arm on `DashApiRequest` in `server.rs` (which already carries `tug_session_id`, `project_dir`, and `dash`); and the CLI's POST from [#step-2], reusing the existing per-instance walk in `dash.rs` — the one that tries the cwd-derived instance first and treats `unknown_session` as "not this one" — because `sessions.db` is per-instance and a session-addressed write must land on the owning instance.

**Tasks:**
- [ ] Write `drive_stage` modelled directly on `do_request_replay`: same ledger lookup, same `SpawnState` matrix (`Live` → send; `Spawning` → queue in order; `Idle`/`Errored`/`Closed` → log skipped and **return** the refusal so the runner can stop the arc, [P11], [L31] — never a bare early return).
- [ ] Have the `arc_run` request **bind, record, and return**, never rotate: it calls `dash_api::bind` for the calling session and the dash (minting the owner key through `ensure_dash_id`, branch or no branch — [P01]), and the first rotation belongs to that session's idle transition ([P05]), because the request arrives mid-turn on the conversation's own session.
- [ ] In the CODE_INPUT dispatcher, when a `model_change` arrives **from a WebSocket client**, record its selector on the session's ledger entry (`deck_model: Option<String>`); frames the runner originates never write it. This is the value [P15]'s restore sends, and it lands here because this is the one place every deck-originated frame passes.
- [ ] Send the three frames in the order of Spec S01 — model first, for the reason in [P02].
- [ ] Take the stage's model from the project's `[tugtool.dash]` declaration ([#step-3]); omit frame (1) entirely when the stage declares no model, so an undeclared stage inherits the account default rather than being set to anything.
- [ ] Write the `arc-stage` dash-log line **before** the frames go out ([R01] — the log line is the durable mark).

**Tests:**
- [ ] A supervisor test with a fake tugcode: `drive_stage` on a `Live` session emits exactly three frames, in order, with the documented payloads.
- [ ] With no declared model, exactly two frames are emitted and neither is `model_change`.
- [ ] On a `Spawning` session the frames are queued and drain in order after `session_init`.
- [ ] On an `Idle` session nothing is sent and the call reports the refusal.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] With a live app and a card open: `tugutil dash run <name> --document dash/<some-brief>.md` starts a visible session on that card whose first prompt is the devise invocation

---

#### Step 7: The arc transition predicate {#step-7}

**Depends on:** #step-1, #step-3

**Commit:** `tugcast(dash-arc): decide the arc's next act from documents alone`

**References:** [P04] ([#p04-predicate-dispatch]), [P06] ([#p06-review-cap]), Spec S03 (#s03-transitions), [B02], [B07], [F04]

**Artifacts:**
- New `tugrust/crates/tugcast/src/feeds/dash_arc.rs` with `ArcFacts`, `ArcAction`, and `arc_action`.

**Tasks:**
- [ ] Define `ArcFacts { plan_path: Option<String>, lint_ok: bool, review: ReviewStatus, ledger: StepLedgerFacts, session_live: bool, session_idle: bool, context_fraction: Option<f32> }` — plain data, filled by the dispatcher.
- [ ] Implement `arc_action` as a first-match-wins rule list in the order of Spec S03, with a module docstring stating the ordering the way `join_pilot.rs`'s does.
- [ ] Keep it pure: no filesystem, no git, no process spawn. The docstring says so and a reviewer will check.
- [ ] Model the review cap by counting `arc-stage review` lines ([P06]) and emit the `arc-note` text the cap records.

**Tests:**
- [ ] One test per row of Spec S03, driven by synthesized `ArcFacts`.
- [ ] A stale plan at the cap rotates to implement and carries the note.
- [ ] A dead session yields `Stop` whatever the documents say.
- [ ] A mid-turn session (`session_idle: false`) yields nothing — no rotation mid-turn ([R02]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast dash_arc`

---

#### Step 8: The runner: tick, dispatch, resume {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `tugcast(dash-arc): run the arc — tick on turn end, dispatch under a guard, resume after a restart`

**References:** [P04] ([#p04-predicate-dispatch]), [P05] ([#p05-tick]), [P11] ([#p11-stopped-arc]), Spec S03 (#s03-transitions), Risk R01 (#r01-double-dispatch), [B02], [B10], [F05]

**Artifacts:**
- An arc dispatcher beside the changeset recompute (`tugcast/src/feeds/changeset.rs`), registered with the supervisor the way `join_pilot`'s `PilotRunner` is.
- A tick from the bridge's non-replayed `turn_complete` branch in `agent_bridge.rs`.

**Tasks:**
- [ ] Fill `ArcFacts` in the dispatcher: `read_arc`, the plan's lint/status via `tugutil_core::plan::{parse, lint, has_errors, review_state}` **in process** — tugcast already depends on `tugutil-core` and `tugdash-core` (`tugcast/Cargo.toml`), so shelling out to the CLI would be a subprocess for a function call — the ledger rows from the same `PlanDoc`, and the session's liveness and `turn_active` from the supervisor.
- [ ] Read the plan at its **current** location ([P16]): the `arc-plan` path until the dash has a worktree, then `<worktree_abs>/<plan_path>` from `DashDetail`; read `run_complete` from `read_declarations`, which is the implement stage's `--through` declaration met.
- [ ] Resolve "which arc owns this session" through the dash binding ([P01]) — the session's `dash_name` on its ledger row — never through a field on the arc record.
- [ ] Hold a per-dash in-flight set; re-read the dash-log immediately before rotating ([R01]).
- [ ] Tick from the supervisor's idle transition — a second consumer of `turn_complete_tx`, beside `base_motion.rs`, or a sibling channel set the same way in `main.rs` — which already excludes replay brackets ([P05]).
- [ ] Tick from the changeset recompute as the floor, for a stage that died without going idle.
- [ ] On tugcast start, walk `bound_sessions_by_dash` and `read_arc` each bound dash: a recorded stage whose session is gone is rotated again; a `stopped` arc waits for `/dash` ([P11]).
- [ ] Write `arc-stop` with a reason naming the stage on every refusal path, including a rotation tugcode refused ([#step-6]'s `Idle` arm).
- [ ] At `arc-done` and at `arc-stop`, send the model restore ([P15]): one `model_change` with the session's recorded `deck_model`, or `"default"` — before the receipt, so the card the user is handed back is already theirs.

**Tests:**
- [ ] A dispatcher test: two ticks for one arc produce one rotation.
- [ ] A tick during an open turn produces no rotation.
- [ ] A restart with a recorded stage and no live session re-rotates that stage exactly once.
- [ ] A `stopped` arc is not resumed by a tick, only by an explicit run.
- [ ] `arc-done` and `arc-stop` each emit exactly one `model_change`, carrying the recorded deck selector, and `"default"` when none was recorded ([P15]).
- [ ] After adoption moves the plan into the worktree, the dispatcher's facts come from the worktree copy and the base path's absence is not a stop ([P16]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo clippy -p tugcast --all-targets`

---

#### Step 9: Implement-stage rotation at step boundaries {#step-9}

**Depends on:** #step-8

**Commit:** `tugcast(dash-arc): rotate the implement stage on a measured context reading, never mid-step`

**References:** [P07] ([#p07-implement-rotation]), Spec S03 (#s03-transitions), [B15]

**Artifacts:**
- The implement arm of the dispatcher: reading the session's latest `context_breakdown` and composing the `Steps N-M` opening prompt.

**Tasks:**
- [ ] Read the latest reading with `SessionLedger::get_context_breakdown(session_id)` — the read-back for the row `do_record_context_breakdown` writes — rather than from a live frame, because the recorded value is the one that survives a rotation. The row's `payload` is the `context_breakdown` JSON blob; parse the used-fraction out of it at one named helper in `dash_arc.rs`, so a payload shape change breaks in one place.
- [ ] Compute `N` from the plan's Step Status Ledger — the **worktree** copy, `<worktree_abs>/<plan_path>` ([P16]) — as its first non-`done` row, and `M` from the run's declared `run_through` (`DashDeclarations::run_through`).
- [ ] Rotate only when a step just went `done`; never mid-step ([B15]).
- [ ] Compose the divider text for a continued stage: `implement, continued · steps N–M` ([B13]).
- [ ] Fall back to not rotating when there is no context reading at all — a missing measurement is not a reason to guess.

**Tests:**
- [ ] Above threshold at a step boundary rotates with the right `Steps N-M`.
- [ ] Below threshold does not rotate.
- [ ] Above threshold mid-step does not rotate.
- [ ] No reading recorded → no rotation.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast dash_arc`

---

#### Step 10: The skills' endings under an arc {#step-10}

**Depends on:** #step-4

**Commit:** `tugplug(dash-arc): stop the stage skills at their natural end when an arc is running them`

**References:** [P08] ([#p08-under-arc-env]), [P12] ([#p12-terminal-state]), [B09], [B11]

**Artifacts:**
- `tugplug/skills/plan-devise/SKILL.md` §5, `tugplug/skills/plan-review/SKILL.md` §7, `tugplug/skills/dash-implement/SKILL.md`'s ending.

**Tasks:**
- [ ] In each skill, add the under-arc clause: when `TUG_DASH_ARC` is set, finish at the natural end — a written plan, a stamped review, a closed ledger — and print no chip; the runner is watching the documents.
- [ ] Keep every hand-driven ending exactly as it reads today; the arc clause is additive, and `plan-devise`'s Opus-reviews-inline fork stays true off-arc.
- [ ] Say in `plan-devise` that under an arc the review is a *separate stage* ([B03]) and must not be run inline, whatever model the stage is on.
- [ ] Note in `dash-implement` that under an arc the ending is unchanged — the fit is verified and the join arms itself; the arc adds only its own receipt ([P12]).
- [ ] Remember the hooks run from the app bundle: a repo edit to `tugplug/` does nothing live until the app is rebuilt.

**Tests:**
- [ ] None automatable at this layer: the artifacts are three prose contracts, and the only honest verification is the end-to-end arc in [#step-15]. Say that rather than writing a grep and calling it a test.

**Checkpoint:**
- [ ] `just hooks-test`
- [ ] `grep -l TUG_DASH_ARC tugplug/skills/*/SKILL.md` names exactly `plan-devise`, `plan-review`, `dash-implement`
- [ ] `just build-app` (the hooks and skills run from the app bundle; a repo edit to `tugplug/` does nothing live until this)

---

#### Step 11: The stage divider row {#step-11}

**Depends on:** #step-5, #step-6

**Commit:** `tugdeck(dash-arc): draw a stage boundary as a divider, so the arc is one scroll`

**References:** [P09] ([#p09-divider-row]), [B13], [F10], (#state-zone-mapping)

**Artifacts:**
- A `session_stage` event in `tugdeck/src/lib/code-session-store/events.ts`.
- A reducer arm folding it into a `SystemNote` with `source: "stage"` (`reducer.ts`, `types.ts`).
- Divider styling keyed off `data-source="stage"` on the existing system-note row.

**Tasks:**
- [ ] Extend the `SystemNote.source` union with `"stage"` — the type's own docstring names this as the extension point.
- [ ] Add a `stageNoteText(stage, model, document)` helper beside `compactionNoteText` in `compaction.ts`'s sibling position, or a new `stages.ts` if the file's docstring no longer fits — one small pure module either way.
- [ ] Fold the event in the reducer; do not touch `handleSessionInit`, which correctly does not clear the transcript ([B13], verified).
- [ ] Style the divider as a soft separator in the same family as the compaction divider; appearance is CSS only ([L06]).

**Tests:**
- [ ] `bun test` in `tugdeck`: a `session_stage` event appends exactly one `system_note` with `source: "stage"` and the documented text, and mutates nothing else.
- [ ] The compaction divider's text is unchanged.
- [ ] `tests/app-test/at0474-dash-arc-transcript.test.ts` (new, with `@covers` for the reducer and the store types): drive a stage rotation on a live card and assert the pre-rotation rows and the divider are in one transcript.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0474-dash-arc-transcript.test.ts`
- [ ] `just app-test-covers-check`

---

#### Step 12: Lineage-aware restore {#step-12}

**Depends on:** #step-11

**Commit:** `tugcode(dash-arc): replay the arc's lineage in order, dividers and all`

**References:** [P10] ([#p10-lineage-restore]), [P03] ([#p03-stage-lineage]), [B13]

**Artifacts:**
- An optional `lineage` array on the `request_replay` payload (`tugproto/src/inbound.ts`, `tugcode/src/types.ts`, `tugcode/src/inbound-dispatch.ts`).
- `do_request_replay` in `agent_supervisor.rs` filling it from the session ledger.
- `tugcode/src/replay.ts` / `session.ts`'s `runReplay` iterating the lineage.

**Tasks:**
- [ ] In tugcast, walk `forked_from_session_id` back from the lineage head to build the ordered chain, and attach each entry's stage metadata from the dash-log's `arc-stage` lines ([P01]).
- [ ] Forward the array verbatim in the `request_replay` body, alongside the existing `window` — keep `do_request_replay`'s front-push ordering untouched.
- [ ] In tugcode, replay each JSONL in order, emitting the `session_stage`-shaped divider frame at each boundary before the next file's turns.
- [ ] Leave the single-session path byte-identical when no lineage is supplied — every card that is not an arc must replay exactly as today.

**Tests:**
- [ ] `bun test` in `tugcode`: a two-entry lineage replays file A's turns, then a divider, then file B's; a one-entry lineage is identical to today's output.
- [ ] A Rust test: the lineage array for a three-stage arc is conversation → devise → review → implement, in that order.
- [ ] The restore leg of `at0474-dash-arc-transcript.test.ts`: after a reload, the conversation rows precede the stage rows and each boundary carries its divider.

**Checkpoint:**
- [ ] `cd tugcode && bun test && bunx tsc --noEmit`
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `just app-test at0474-dash-arc-transcript.test.ts`

---

#### Step 13: Arc faces: receipt, stopped, Z2 and Lens {#step-13}

**Depends on:** #step-8, #step-11

**Commit:** `tugdeck(dash-arc): show where the arc stands, and say when it stopped`

**References:** [P11] ([#p11-stopped-arc]), [P12] ([#p12-terminal-state]), [B09], [B10], [F10], [D147], [D152], (#state-zone-mapping)

**Artifacts:**
- The arc's stage/stopped state on the existing dash detail payload, rendered on the Z2 DASH cell, its placard, and the Lens Dashes row.
- One durable-ink receipt row written at `arc-done`.

**Tasks:**
- [ ] Carry `arc` (stage, stopped reason) on `tugdash_core::ops::DashDetail` — the one composition the CLI and the Changes card's snapshot both read, which already carries `stage`, `step_current`/`step_total`, `plan_path`, and `join_ready` — and mirror it in `tugdeck/src/lib/changeset-types.ts`'s entry type and its validator. A field on an existing payload, not a new feed. The arc's stage is reported beside the derived `stage`, never folded into it: `derive_stage` answers "what is this dash doing in git", and the arc answers "which stage of the arc is driving it".
- [ ] Render the stage on the Z2 cell and its placard beside what they already show ([F10]); render the stopped reason where the row already has room for a meta line.
- [ ] Write the arc receipt as durable ink at `arc-done` — stages, sessions, plan path, what to look at — and nothing else; no `/join` chip ([P12]).
- [ ] Verify the receipt restores after a relaunch through the existing ink census (`GET /api/ink-census`), not by counting DOM rows.

**Tests:**
- [ ] `bun test` in `tugdeck` over the payload→display derivation for stage and stopped states.
- [ ] An app-test leg asserting a stopped arc shows its reason on the Z2 cell.
- [ ] An ink-census assertion that the arc receipt survives a relaunch.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 14: Bare `/dash` hands off {#step-14}

**Depends on:** #step-2, #step-10

**Commit:** `tugplug(dash-arc): make bare /dash the hand-off — a document, then the runner`

**References:** [P01] ([#p01-arc-record]), [B01], [B14], [F09]

**Artifacts:**
- `tugplug/skills/dash/SKILL.md` — Orient extended, a new hand-off stage replacing the Delegate→review-gate→Continue sequence for the plan-arc route.

**Tasks:**
- [ ] Extend Orient to find the conversation's product: a brief or plan this session wrote, located through `tugutil dash docs-dir` and this session's own attribution in `tugutil changes --json` ([B14]).
- [ ] When the session wrote nothing, keep Sharpen as it is — write the brief **in the conversation session, on the user's model**, as an ordinary interactive turn — and hand off only once a document exists ([B14]). Never start an arc from an idea string.
- [ ] Settle the dash name at hand-off (Orient/Sharpen already settle it; `create` is idempotent on it) and run `tugutil dash run <name> --document <path>` ([B16]).
- [ ] Replace the review-gate stanza for the arc route: under an arc the review is a stage, not a chip. Keep the hand-driven fork intact for someone who invokes `plan-devise` directly ([B11]).
- [ ] Add the stopped-arc continuation to Orient: an arc reading `stopped` is resumed with `tugutil dash run <name>` ([P11], [B10]).
- [ ] Say what the user will see next — one card, dividers, and the join offer at the end — because the narration is what `/dash` owns.

**Tests:**
- [ ] None automatable at this layer, for the reason given in [#step-10]; the behavior is proven by the end-to-end run in [#step-15].

**Checkpoint:**
- [ ] `just hooks-test`
- [ ] `just build-app`
- [ ] A bare `/dash` on a session that just wrote a brief starts a devise stage on the same card, after that session's own turn ends ([P05])

---

#### Step 15: Integration Checkpoint {#step-15}

**Depends on:** #step-9, #step-12, #step-13, #step-14

**Commit:** `tugdash(dash-arc): close the run — replay onto the live base and verify the fit`

**References:** [P12] ([#p12-terminal-state]), (#success-criteria), [D149]

**Artifacts:**
- The run's rounds replayed onto the live base; the ledger closed.

**Tasks:**
- [ ] `tugutil dash replay <name>` — replay the rounds onto the live base, moving the branch and worktree together.
- [ ] On `Replayed` or `Recorded`, run this project's declared verify command from the warm worktree with the replayed range substituted: `sh scripts/verify-fit.sh {base} {head}` (`tugutil dash config --json` reports it).
- [ ] On `Current`, nothing re-runs — the tree the last checkpoint verified is the deliverable.
- [ ] On `Conflicted`, resolve the named round in the warm worktree as ordinary work, then verify as above.
- [ ] Run the arc once end-to-end on a small real brief and confirm every line of [#success-criteria].

**Tests:**
- [ ] None beyond the verify command and the end-to-end run — every per-step checkpoint already ran against these bytes.

**Checkpoint:**
- [ ] `tugutil dash replay <name>` reports its outcome
- [ ] The verify command exits 0 (or nothing re-runs on `Current`)
- [ ] `tugutil dash arc <name> --json` reports `done` after the end-to-end run

---

### Deliverables {#deliverables}

- `tugdash_core::arc` — the arc record grammar, reader, and writers ([#step-1]).
- `tugutil dash run` / `tugutil dash arc` ([#step-2]) and four new `[tugtool.dash]` keys ([#step-3]).
- tugcode's stage-aware `session_command`, its `session_stage` announcement, and `TUG_DASH_ARC` on a stage session ([#step-4]).
- tugcast's stage lineage handling ([#step-5]) and `drive_stage` — the one new primitive ([#step-6]).
- `tugcast::feeds::dash_arc` — the transition predicate ([#step-7]), its dispatcher, tick and resume ([#step-8]), and the implement rotation ([#step-9]).
- Under-arc endings in `plan-devise`, `plan-review`, `dash-implement` ([#step-10]).
- The stage divider row ([#step-11]), the lineage-aware restore ([#step-12]), and the arc's faces and receipt ([#step-13]).
- `tugplug:dash`'s hand-off for a bare `/dash` ([#step-14]).
- `tests/app-test/at0474-dash-arc-transcript.test.ts`, plus Rust and `bun` unit coverage named per step.
