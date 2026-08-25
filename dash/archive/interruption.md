## Interruptions: what an arc does when something gets in its way {#interruptions}

**Purpose:** Make every interruption to a running dash arc leave a state that is sayable, resumable, and told — one closed vocabulary of stop reasons, one shared stop path, one doctrine table in `tuglaws/dash-lifecycle.md`, and one test per row.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | `main` (dash worktree `tugdash/interruption`) |
| Last updated | 2026-08-25 |
| Source brief | `dash/archive/interruption-brief.md` |

---

### Review Record {#review-record}

**Round 1 — 2026-08-25, opus.** Reviewed `plan:dec31279fb43cf42`. Lint: 0 errors, 0 warnings, clean before and after.
Oriented on: the whole document — a first round, with the code read at `tugcast/src/feeds/dash_arc.rs`, `dash_arc_runner.rs`, `agent_supervisor.rs`, `agent_bridge.rs`, `dash_api.rs`, `conductor/mod.rs`, `session_ledger.rs`, `tugdash-core/src/arc.rs`, `tugdash-core/src/dash.rs`, `tugdash-core/src/ops.rs`, `tugutil/src/dash.rs`, `tugutil-core/src/paths.rs`, and `tugcode/src/session.ts`.
Applied: three findings the plan was wrong about the tree on, each asked and settled with the owner. **The cancel's cause** — `turn_cancelled` is written from one flag, `ActiveTurn.interrupted`, that `handleInterrupt` and `forceTerminateAndRespawn` both set, so the result-liveness watchdog's wedge recovery is indistinguishable from a user's cancel; since that recovery resumes the *same* claude id, `agent_bridge.rs`'s reset never fires and Step 2's arm would have stopped a healthy stage saying "you took the card back". Added [P12] and Spec S05 (a `is_recovery` marker on the frame, mirroring `TurnComplete.is_api_error`), grew Step 2 with the tugcode half and its `bun test`. **The join** — `broadcast_dash_gone` is called from `run_join` and `run_join_resolve` as well as `run_discard`, so Step 7 would have painted "arc discarded" on a card whose dash had just joined; added [P13], an `ArcStopReason::Joined`, a gesture on the `dash_gone` op, and rewrote Step 7 around both endings. **The phantom generation** — `ops::discard` appends its terminal `discarded` line *before* the CLI broadcasts, and `read_arc` resets at the last terminal line, so Step 7's `append_arc_stop` would have opened a next generation that a dash reusing the name is born carrying; the append is removed, the rule is now a Constraint, and `an_ending_writes_no_arc_line_after_the_terminal_one` guards it. Also corrected: [P05] claimed `finish` already hands back before recording the receipt — it does the opposite, and the doc comment saying otherwise dangles above `format_arc_receipt`, so Step 4 now states the reordering as a behavior change and pins it, and `stop_arc_for_session` takes a `StopDelivery` rather than one `receipt` bool because the hand-back has three answers; [P03] now says the `card taken` stop lands at the card's next spawn, since `do_reset_session` parks the entry `Idle` and `session_snapshot` returns `None` there — with the matching warning in Step 11, whose app-test would otherwise time out; `SeatedArcStage` carries the dash name and project because `dash_gone` holds only an id, and `dash_api::unbind` must fetch the row rather than call `owns_session`, which throws that row away; `DashApiOutcome::Cleared` named as the tuple→struct reshape it is; Spec S01 corrected on `Refusal`'s eight variants (`UnknownSession` maps onto the existing `SessionGone` — a total mapping, not a bijection); Step 1 and Step 4 reconciled on `rotate`'s three `stop(..)` call sites, exactly one of which is a refusal; and Step 10 told to amend `dash-lifecycle.md`'s Binding bullet, which [P06] makes false.
Laws cross-checked: [L31] holds throughout and is the plan's spine — the two fixes that matter most, the recovery mislabel and the discard-worded join receipt, were both visible-but-wrong reasons, which is the failure [L31] is usually read as excluding. [L23] holds: Step 7 keys off the captured dash id and takes the name from the bound row rather than re-deriving a key the teardown destroyed. [L29] holds: no new `project_dir` bypasses the gateway. [L27] holds at Step 8. No State Zone Mapping applies — [P10] changes no tugdeck file, verified against `handleSessionStage` in `code-session-store/reducer.ts` and the `replay_stage` restore path, and Step 9's `git status --short tugdeck/` checkpoint keeps it honest.
Deferred: nothing. Both of the brief's open questions were already settled in the document, and the three judgment calls this round found were asked and answered rather than left as `[Q##]`.

---

### Phase Overview {#phase-overview}

#### Context {#context}

A dash arc is a **score**: a schedule of rotations that carries one dash from a brief through devise, review, and implement on a single Session card, unattended. The machinery landed across `215c57df2` (the conductor) and `a9c0d1235` (arc hardening). What did not land is an answer for what happens *between* rotations when the user, or the machine, intervenes.

The arc's decision half is `arc_action` in `tugrust/crates/tugcast/src/feeds/dash_arc.rs` — a pure first-match-wins rule list over `ArcFacts`. Its act half is `tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs`, which gathers those facts, performs what the predicate returns, and records the result in the dash-log. The seating itself is `tugrust/crates/tugcast/src/conductor/mod.rs`. The verbs are `tugrust/crates/tugutil/src/dash.rs`; the binding write surface is `tugrust/crates/tugcast/src/dash_api.rs` behind `POST /api/dash` in `tugrust/crates/tugcast/src/server.rs`; the binding itself lives in `tugrust/crates/tugcast/src/session_ledger.rs`.

`dash/archive/interruption-brief.md` read every interruption against that code and decided ten things, `[B01]`–`[B10]`. Four real runs on 2026-08-25 (`ornate-fairy`, `reedy-buoy`, `loose-shake`, `gauzy-snack`) supplied the evidence. The defects the brief names are all still present at the head this plan is written against:

- A **cancelled** turn is indistinguishable from a finished one. `is_turn_end` (`feeds/session_metadata.rs`) matches `turn_complete` *and* `turn_cancelled`; the dispatcher's edge in `feeds/agent_supervisor.rs` clears `turn_active`, increments `turns_ended`, and sets `turn_api_error` on both. `ArcFacts` carries no fact for a cancel, so a devise cancelled mid-write stops on `lint` and a review cancelled mid-pass burns a round against `REVIEW_CAP`.
- And a **cancel does not say who caused it**. `turn_cancelled` is written from two places in `tugcode/src/session.ts` — `signalEofToActiveTurn` and `emitInflightTurnFromActiveTurn` — and both key on one flag, `ActiveTurn.interrupted`. `handleInterrupt` sets it for the user's cancel; `forceTerminateAndRespawn` sets it for a *machine* wedge recovery, fired by the result-liveness watchdog (`result_timeout`) with no user in the loop. That recovery respawns `--resume` against the **same** claude id, so `agent_bridge.rs`'s reset (keyed on a *different* id) never fires and the stage is genuinely still alive. A fact that read every cancel as a taking would stop a healthy stage and blame the user for it ([P12]).
- A **fresh session on a scored card** — a `/new`, a reset, a rewind fork — leaves `stage_session_current` false, which the predicate reads as "the stage died" and re-rotates the stage back onto the card the user just cleared.
- A **second `/dash`** naming a different dash goes straight to `dash_api::bind`, which checks only that the dash is in the session's project and then displaces the binding. The first arc drops out of `bound_arcs` (the sweep is live-bindings-only) with no stop, no receipt, and a record that reads live forever.
- **`dash discard`** clears every binding through `dash_api::dash_gone` and never reaches the stage's claude: it keeps `TUG_DASH_ARC`, its cwd is a deleted worktree, and its card is still on the stage's model with no hand-back armed, because only the runner's `finish` calls `conductor::hand_back` and `finish` never ran.
- The same is true of a **join**, which nothing in the brief covers. `broadcast_dash_gone` is called from three places in `tugutil/src/dash.rs` — `run_discard`, `run_join`, and `run_join_resolve` — so `dash_gone` is the teardown of *any* ending, not the discard's alone. A scored dash that joins tears its binding down exactly as silently ([P13]).
- **Closing the card** nulls the binding in `SessionLedger::mark_closed` ([L27]); `bound_sessions_by_dash` filters `state = 'live'`, so the arc silently leaves the sweep while its record still says `review`.
- `format_arc_stop_receipt` knows six reasons, all of them machine-side, and ends with an `other => other.to_string()` arm that renders an unknown reason verbatim.
- There is **no verb** meaning *stop the arc, keep the dash*. `discard` means everything gone, `join` means landed, `run` means open-or-resume, `unbind` means drop this card's binding.

#### Strategy {#strategy}

- **Give the predicate the two facts it is missing, and nothing else.** `stage_turn_cancelled` and `stage_seated` are both computed at edges the runner already reads. The predicate stays pure and stays table-testable; every new behavior is one arm and one row of tests.
- **Close the stop vocabulary in the type system.** `ArcStopReason` replaces the free strings, `append_arc_stop` takes it, and the receipt formatter matches it exhaustively. That is what makes [B08]'s "a reason the receipt cannot explain is a reason the arc must not write" a compiler fact rather than a hope.
- **One stop path.** Every stop — the predicate's, a refused rotation's, a discard's, a close's, a user's `dash stop` — writes the record, hands the card back, and leaves the receipt through the same function. Four call sites that each remembered three of the four steps is exactly how [F05] happened.
- **Refuse at the door rather than describe at the sweep.** A bind that displaces a live score has no honest row in the table, so it is removed ([B06]) instead of documented.
- **Order the work so nothing is written twice.** The vocabulary first, then the predicate arms that use it, then the shared path, then the four callers that hang off it, then the doctrine, then the live cover.
- **The table is the contract.** `tuglaws/dash-lifecycle.md` gains a `## Interruptions` section whose every row cites the test that pins it, and every row's second column names a receipt.

#### Success Criteria (Measurable) {#success-criteria}

- A devise or review stage whose turn is cancelled writes `arc-stop <stage> card taken`, hands the card back to `deck_model`, and shows the stop receipt — verified by a `dash_arc` table test and an app-test asserting both the on-card receipt and `tugutil dash arc --json`.
- An implement stage whose turn is cancelled writes nothing and rotates nothing — `arc_action` returns `None` (unit).
- A `turn_cancelled` carrying `is_recovery: true` — tugcode's wedge recovery — leaves `stage_turn_cancelled` false and stops nothing, in devise and review alike (tugcode `bun test` for the marker, unit for the arm).
- A fresh claude session on a scored card that no rotation seated stops the arc as `card taken` instead of re-rotating the stage, at the card's next spawn (unit + app-test).
- `cargo nextest run` contains a test that fails if any `ArcStopReason` variant lacks a receipt sentence; the `other =>` arm no longer exists in `format_arc_stop_receipt` (grep, Step 1's checkpoint).
- `tugutil dash stop <name>` on a live arc exits 0, prints the same receipt shape every other stop prints, and `tugutil dash arc --json` reports `stopped` with reason `stopped by user`; `tugutil dash run <name>` afterwards reports `resuming` (integration).
- `POST /api/dash` `op: "bind"` naming a different dash while the calling card runs a live score returns an error whose message names both dashes; the card's binding is unchanged (unit over `dash_api::bind`).
- `dash discard` on a dash whose arc is seated on a live card writes a receipt on that card naming the dash and the model it returns to, and the card is on `deck_model` at that stage turn's end (app-test). `dash join` does the same and its receipt says *joined*, not *discarded* (server integration).
- Neither ending appends a dash-log line: after a discard or a join, `read_arc` on that dash returns `None` rather than a phantom record carrying a stop (server integration).
- Closing a card seated by a stage leaves `tugutil dash arc <name>` reading `stopped: card closed`, and `tugutil dash run <name>` from another card resumes it through the ordinary `arc-resume` path (integration).
- `tuglaws/dash-lifecycle.md` has a `## Interruptions` table in which every row's *how the work resumes* cell is non-empty, every row but the side-question row names a receipt, and every row cites a test by name (prose assertion, Step 10).

#### Scope {#scope}

1. `ArcStopReason` — the closed reason vocabulary, in `tugdash-core`, consumed by `append_arc_stop`, `ArcAction::Stop`, and the receipt formatter.
2. `ArcFacts::stage_turn_cancelled` and the `card taken` arm for a cancelled devise/review turn — including the tugcode marker that tells a user's cancel from a machine wedge recovery.
3. `ArcFacts::stage_seated` and the `card taken` arm for a session no rotation seated.
4. `stop_arc_for_session` — the one path that records, hands back, and leaves the receipt.
5. The bind refusal for a card already running a different dash's score.
6. `tugutil dash stop <name>` and the `arc_stop` op behind it.
7. `dash_gone` reaching the seated stage on either ending — discard or join: a hand-back armed at the turn's end and a receipt now, naming which ending it was.
8. `mark_closed` and `dash unbind` writing `arc-stop … card closed`.
9. The model-switch `arc-note`, and the settled answer about the stage divider.
10. The `## Interruptions` doctrine table in `tuglaws/dash-lifecycle.md`.
11. Live cover: one app-test file exercising the user-side rows.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **A `pause` verb or a paused state.** Stopped-and-resumable is the one shape ([B07]); a second word for the same record would be a lie about the record.
- **Killing a stage session mid-turn on an ending.** The conductor's turn-end rule holds ([conductor.md](../tuglaws/conductor.md), "The turn-end rule"); the stage is retired at its turn's end, on a discard and a join alike.
- **Changing what a join or a discard does to the dash.** This plan gives those endings a receipt and a hand-back on the card the stage is seated on. It does not change the teardown, the terminal dash-log line, or the join's landing behavior.
- **Fanning an arc across cards.** One score per card ([B06]); a closed card's arc resumes on *a* card, never on two.
- **Any change to what a rotation is.** `tuglaws/conductor.md` is settled and this plan consumes it. Nothing here adds a `RotationRequest` field, a perform-at-request-time path, or a surviving pending rotation.
- **Rewriting the stage divider already in the transcript.** See [P10].
- **jj-style operation-log undo for arcs.** The dash-log is append-only and that is enough.
- **A `--score` flag on `tugutil session rotate`.** `conductor.md` states why it is withheld; nothing here needs it.

#### Dependencies / Prerequisites {#dependencies}

- The conductor as it stands at `215c57df2`: `conductor::rotate`, `conductor::hand_back`, `conductor::score_is_running`, `ConductorState::arm_hand_back`, `Refusal`.
- The arc-hardening fixes at `a9c0d1235` (arc-only plans resume; arc-only dashes discard).
- `AgentSupervisor::record_arc_receipt`, which is already the durable-ink + `arc_receipt` CONTROL frame gateway for anything the arc puts on a card.
- `SessionLedger::stage_provenance` / `set_stage_provenance` (the `stage_label` / `stage_model` columns), written from `feeds/agent_bridge.rs` at the rotation's `session_init`.
- A Rust change means `just build-app` before any app-test — `app-test` refreshes `dist` but never rebuilds the binary.

#### Constraints {#constraints}

- **`-D warnings`.** The Rust workspace treats warnings as errors (`tugrust/.cargo/config.toml`).
- **The predicate is pure.** `arc_action` may not read the filesystem, git, a clock, or a process. Every new fact is gathered in the runner's blocking `read` pass or in `session_snapshot`.
- **Nothing rotates or retires mid-turn.** Every act this plan adds either happens at a turn-end edge or arms one.
- **The dash-log is append-only.** A stop is a new line, never an edit.
- **The dash-log outlives the dash, and its generation reset is load-bearing.** It is `project_state_dir(repo_root)/dash-log.md` — `~/Library/Application Support/Tug/projects/<slug>/dash-log.md` (`tugutil-core/src/paths.rs`), outside the repository and shared by every worktree of a project. A discard deletes the branch and the worktree and never touches it. `read_arc` discards everything at or before the dash's last **terminal** line (`discarded`, `released`, `joined …` — `tugdash_core::dash::is_terminal`), so an arc line appended *after* one becomes the first line of a phantom next generation, which a dash reusing that name would be born carrying. **Nothing this plan adds may append an arc line after a terminal line** ([P13]).
- **Ledger writes go through `tugcore::ledger_db`**; a `changes.db` schema change would need `CHANGES_SCHEMA_VERSION` bumped. This plan adds no ledger column and no schema change — `stage_label` already exists.
- **`/api/dash` is loopback-only**, and every `project_dir` on it passes the [L29] gateway (`path_resolver::resolve_to_claude_form`) on arrival. New ops inherit both.
- **`~/.local/bin/tugutil` points at `main`.** Any test or checkpoint invoking the verb from the dash worktree must use an absolute path to the worktree's own build.

#### Assumptions {#assumptions}

- A stage session's claude id is what `stage_session_current` compares, and `set_stage_provenance` is keyed by that same claude id (`record_id` in `agent_bridge.rs`). Verified by reading both sites.
- `turns_ended` and `turn_api_error` are reset in `agent_bridge.rs` when a `session_init` names a different claude id; a new per-turn flag resets in the same block or it latches across a rotation.
- A card's fresh-session gesture always ends with a `session_init` naming a claude id the arc's record does not name. The plan deliberately keys on that outcome rather than on any one door, because the deck reaches it through more than one (see [P03]). **It ends there eventually, not immediately** — `do_reset_session` parks the entry `Idle`, and `session_snapshot` returns `None` for `SpawnState::Idle`, so the arc decides nothing until the card spawns again. See [P03]'s implications.
- `dash discard` and `dash join` both run from a CLI process, so anything that must reach a card goes through `POST /api/dash`, not through the ending process.

---

### Open Questions {#open-questions}

Both questions `dash/archive/interruption-brief.md` left open were settled in this round by reading the code, as the brief's Exit required. Neither survives as a `[Q##]`.

- *Should a resume after `card taken` re-rotate at once, or wait for the user's next turn to end?* Settled — see [P11]. The existing placement is right and is now pinned by a named test.
- *Does [B03]'s divider re-render need a deck change, or does the session row already drive it?* Settled — see [P10]. It would need both a deck change and a rewrite of durable ink, and it would introduce a live/restored divergence, so it is not done at all.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A latched `turn_cancelled` flag stops a healthy stage | high | med | Reset in the same `agent_bridge.rs` block that resets `turns_ended`; a unit test rotates after a cancel and asserts no stop | any `card taken` stop nobody caused |
| A machine wedge recovery reads as a user's cancel | high | med | tugcode marks the cause on the frame and only a user's cancel takes the card ([P12]); the watchdog's recovery resumes the *same* claude id, so the reset above cannot cover it and the flag must carry the cause | a `card taken` stop whose transcript shows no cancel |
| `stage_seated` misreads a genuine restart as a taking | high | low | The arm requires *both* `!stage_session_current` and `!stage_seated`; a restart's rebind seeds the recorded claude id, so `stage_session_current` is true and the arm is unreachable | a relaunch that stops an in-flight arc |
| The bind refusal breaks `dash create` / `dash step start`'s `claim_dash` | med | med | The refusal fires only when a *different* dash is named while a live score runs; same-dash binds stay a no-op, and `claim_dash` is best-effort and warns rather than failing its verb | a dash verb failing on a scored card |
| `dash_gone`'s new async half slows the discard round-trip | low | low | The blocking half still returns first; the hand-back is armed, not awaited on the stage's turn | a discard that visibly hangs |
| The arc-note on every model switch floods the dash-log | low | med | One note per switch, and only while a live score is seated on that session | a dash-log a person cannot read |

**Risk R01: A stop reason written by an older build has no sentence** {#r01-legacy-reason}

- **Risk:** `ArcRecord.stopped` is read back from a dash-log written before this change and carries a word `ArcStopReason` does not know.
- **Mitigation:** the record's `stopped` tuple keeps its `String` reason on the read side; only the *write* side and the receipt formatter take the enum. `print_arc` and the resume prompt print the stored word verbatim, exactly as they do today.
- **Residual risk:** an old record's stop reads with its old wording. That is the correct outcome — the log says what happened when it happened.

**Risk R02: Two stop writers race on one arc** {#r02-double-stop}

- **Risk:** the sweep decides `Stop` at the same moment `dash discard` or a close writes one.
- **Mitigation:** `arc_action` returns `None` for a record whose `stopped` is set, so the second writer's next tick is a no-op; the dash-log is append-only, so the worst case is two `arc-stop` lines and `read_arc` taking the newest.
- **Residual risk:** a duplicate line in the log. Acceptable — it is a record of two things having happened, not a wrong state.

---

### Design Decisions {#design-decisions}

#### [P01] A user gesture on a scored card takes the card, and the arc stops for it {#p01-card-taken}

**Decision:** A cancelled devise or review turn, and a fresh claude session on the card that no rotation seated, stop the arc with the reason `card taken`, hand the card back to `deck_model`, and write the stop receipt. The stopped arc resumes through `tugutil dash run <name>` like every other stop.

**Rationale:**
- This is [B02]. It replaces two wrong behaviors: overriding the gesture (the arc re-rotates the stage onto the card the user just cleared) and misreading it as a document fact (a cancelled devise stops on `lint`, which blames the plan for the user's cancel).
- The card belongs to the user. An unattended schedule that argues with a gesture is the failure mode a score must not have.
- `card taken` is one reason with one sentence, so all of these arrive on the card as the same kind of event.

**Implications:**
- `ArcFacts` gains `stage_turn_cancelled` and `stage_seated`; `arc_action` gains one arm for each, both placed with the API-error arm — *after* the never-run guard and *before* the per-stage arms, because a stage that did not answer is not judged on documents.
- `stage_turn_cancelled` means **the user cancelled**, not merely that a `turn_cancelled` frame arrived. A machine wedge recovery writes the same frame today, and telling the two apart is [P12].
- Nothing else about a cancel changes: `is_turn_end` keeps matching `turn_cancelled`, and the turn-end edge keeps firing all three tick channels.

#### [P02] A cancel during implement sits {#p02-implement-cancel-sits}

**Decision:** The `card taken` arm for a cancelled turn applies to `devise` and `review` only. A cancelled `implement` turn produces no action at all.

**Rationale:**
- The owner's call, made 2026-08-25 and recorded in the brief.
- An implement stage's progress lives in the Step Status Ledger, not in the turn. A cancelled implement turn leaves the ledger exactly as it was, the predicate at the next idle sees no `step_just_done` edge, and `implement_action` already returns `None`.
- A cancel mid-implement almost always means "let me redirect you", and the user types that redirect into the same stage. Stopping would hand the card back and cost a rotation to say what the user was about to say anyway.
- In devise and review the turn *is* the product, and a cancelled one leaves no document to be judged on.

**Implications:**
- The arm is written as a match on the stage, not as a blanket check, and the asymmetry gets its own named test so nobody "fixes" it later.

#### [P03] `stage_seated` is the fact that tells a taken card from a dead stage {#p03-stage-seated}

**Decision:** `ArcFacts` gains `stage_seated: bool` — whether the claude session currently running on the card carries a `stage_label` on its `sessions.db` row. When `stage_session_current` is false, `stage_seated` decides: seated → re-rotate the recorded stage (today's behavior, for a restart or a stage that died); not seated → stop with `card taken`.

**Rationale:**
- `set_stage_provenance` is called from exactly one place — `feeds/agent_bridge.rs`, on the `session_init` that follows a rotation's announcement, keyed by the same claude id `stage_session_current` compares. So "this session was seated by a rotation" is already a durable, unambiguous fact, and nothing but the conductor can write it.
- It is **door-independent**. The deck reaches a fresh session through more than one route — the `reset_session` CONTROL action (`do_reset_session` in `feeds/agent_supervisor.rs`, which clears `claude_session_id`, flips `session_mode` to `New`, and parks the entry `Idle` for the next spawn), a rewind fork, a re-spawn onto a picked session. Keying on the outcome covers all of them; keying on one frame type would cover one.
- It cannot misfire on a relaunch: the startup rebind seeds `claude_session_id` from the ledger row, so `stage_session_current` is *true* and this arm is never reached. `feeds/dash_arc_runner.rs`'s `a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop` already pins that path.

**Implications:**
- `session_snapshot` gains one `session_ledger.stage_provenance(claude_session_id)` read, next to the `get_context_breakdown` read it already does there. `stage_provenance` returns `Option<(String, Option<String>)>` directly — no `Result`, so no `.ok()`.
- The existing "a recorded stage that is not the one running is a stage that died" arm keeps its behavior for the seated case and its existing tests keep passing, with `stage_seated: true` in the fixture.
- **The stop lands at the card's next spawn, not at the gesture.** `do_reset_session` cancels the bridge worker and parks the entry `Idle`; `session_snapshot` returns `None` for `SpawnState::Idle`, so `evaluate` returns before the predicate is consulted. That early return is deliberate and load-bearing elsewhere — it is what makes a tugcast restart a wait rather than a stop (`a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop`) — so this decision does **not** reach into it. The consequence is that a `/new` followed by silence leaves the record reading live until the user's next prompt spawns a session, and the `card taken` stop lands then. That is the right trade: a card parked `Idle` is indistinguishable from a card whose tugcast just restarted, and stopping on that reading would stop every in-flight arc on every relaunch.

#### [P04] Stop reasons are a closed enum, and the receipt has no fallback arm {#p04-closed-reasons}

**Decision:** `ArcStopReason` lands in `tugdash-core` beside `ArcStage` and `append_arc_stop`, carrying every reason the arc can write: `Lint`, `ApiError`, `ReviewDidNotStamp`, `DocumentMissing`, `PlanMissing`, `SessionGone`, `CardTaken`, `CardClosed`, `StoppedByUser`, `Discarded`, `PromptUnavailable`, plus one variant per conductor `Refusal` (`SessionIdle`, `SessionErrored`, `SessionClosed`, `SpawnQueueFull`, `NoStdin`, `StdinClosed`, `ArcRunning`). `append_arc_stop` takes it; `ArcAction::Stop` carries it; `format_arc_stop_receipt` matches it exhaustively and the `other => other.to_string()` arm is deleted.

**Rationale:**
- This is [B08]. "A reason the receipt cannot explain is a reason the arc must not write" is only true if the compiler says so; a `&str` with a fallback arm is a promise nobody checks.
- The receipt is the thing the user reads at the moment the interruption lands. A verbatim internal word ("no stdin", "spawn queue full") on the card is the surface admitting it has nothing to say.
- `tugdash-core` is the right home because the dash-log is where the word lands, and both `dash_arc.rs` and `conductor/mod.rs` can reach it.

**Implications:**
- `Refusal` gains `stop_reason(&self) -> ArcStopReason`; `Refusal::reason()` stays for logging.
- `ArcRecord.stopped` keeps `(ArcStage, String)` on the **read** side, so a log written by an older build still parses ([R01](#r01-legacy-reason)).
- `Discarded` is the one reason whose second receipt line is not `resume with tugutil dash run <name>` — there is nothing to resume, and the line says so.

#### [P05] One stop path, used by every stopper {#p05-one-stop-path}

**Decision:** `dash_arc_runner` exposes one function that performs a stop end to end — format the receipt, `record_arc_receipt`, `conductor::hand_back`, `append_arc_stop` — and every stopper calls it: the predicate's `Stop`, a refused rotation, `dash discard`, a card close, and `tugutil dash stop`.

**Rationale:**
- Today `finish` does all four and the local `stop` helper does two (hand back, append) with no receipt. [F05]'s missing hand-back on discard is exactly the shape of a caller that remembered three of four steps.
- The ordering matters and should be written once: the model restore goes **before** the record and the receipt, so the card the user is handed back is already theirs by the time the terminal line lands ([P15] of the conductor plan).
- **That ordering is not what `finish` does today, and this is a behavior change, not a refactor.** `finish` calls `record_arc_receipt` first and `conductor::hand_back` second. The doc comment stating the opposite is real but *dangling*: it sits above `format_arc_receipt`, not above `finish`, so nothing has been enforcing it. Consolidating the four callers is the moment to make the code agree with the rule, and the step says so rather than describing the change as preservation.
- The ordering is a best effort rather than a guarantee, and the plan claims no more: `hand_back` reaches the card over `input_tx`/the spawn queue while `record_arc_receipt` publishes on `control_tx`, so the two travel different channels and their arrival order is not something either caller can pin. What the ordering buys is that the restore is *issued* first.

**Implications:**
- The function takes the pieces a caller can always supply — supervisor, tug session id, project dir, dash, stage, `ArcStopReason` — rather than an `ArcReading`, because three of the five callers have no reading.
- `finish` keeps its done branch; its stop branch delegates. The done branch keeps its own receipt-then-hand-back body unless a later decision moves it, so this plan changes the ordering on the **stop** path only and says which one it changed.

#### [P06] One score per card is refused at the bind {#p06-bind-refusal}

**Decision:** `dash_api::bind` refuses when the calling session is seated by a **live** score for a *different* dash: `card runs <dash> — stop it before binding <other>`. Binding the same dash again stays a no-op. `op: "arc_run"` inherits the refusal, since it binds through the same function.

**Rationale:**
- This is [B06]. A bind that displaces a running score leaves the first arc's record reading live forever with no stop and no receipt, and `conductor::score_is_running` would still call it live if anything rebound to it. That interruption has no honest row, so it is removed rather than described.
- The conductor already refuses a *rotation* on a scored card by name (`Refusal::ArcRunning`). Refusing the bind is the same rule one layer earlier, where it can still be said to the person who asked.
- `conductor::score_is_running(ledger, session_id)` is the exact predicate, and it reads the binding the bind is about to displace — so it answers about the arc being displaced, which is the one this refusal protects.

**Implications:**
- `run_bind` and `run_arc_run` in `tugutil/src/dash.rs` surface the server's message on stderr and exit 1 through the existing `DashApiOutcome::Error` path.
- `claim_dash` (called by `dash create` and `dash step start`) is best-effort and already warns rather than failing its verb, so a refusal there costs a warning line and nothing else.

#### [P07] `tugutil dash stop <name>` — the verb for the meaning the table needs {#p07-dash-stop}

**Decision:** A new verb `tugutil dash stop <name>` writes `arc-stop <current stage> stopped by user`, hands the card back, and prints the same receipt every other stop prints. It is **not** `pause`.

**Rationale:**
- This is [B07]. Today the only way to reach a stopped-and-resumable arc is to make something fail, which is a lousy thing to have to do on purpose.
- There is no paused state distinct from stopped — a stopped arc is already resumable by `tugutil dash run <name>` — so a second word for the same record would be a lie about the record.
- It runs from a terminal, so it must reach the card through the server: a new `op: "arc_stop"` on `POST /api/dash`, which already carries every session-addressed dash write.

**Implications:**
- The op's async half (in `dash_handler`, which holds the `Arc<AgentSupervisor>`) calls the [P05] path; the blocking half resolves the session and the project.
- `--project` follows the same [L29] discipline as every other verb: the CLI ships its own spelling and the server canonicalizes.

#### [P08] Discard reaches the stage, and retires it at its turn's end {#p08-discard-reaches-stage}

**Decision:** `dash_api::dash_gone`, for every session it unbinds that is currently **seated by a stage of this dash's arc**, arms a conductor hand-back at that session's next turn end and records a receipt on the card now, naming the gesture that ended the dash ([P13]): `arc <ended> · <dash> · the stage's turn will end and the card returns to <model>`. The stage session is never killed mid-turn.

**Rationale:**
- This is [B04], and [F05] is the last discard turd. The stage's own tools already refuse correctly in a deleted worktree ("Dash not found"); what was missing is that anybody told the card.
- Killing mid-turn would violate the conductor's turn-end rule for the same reason a rotation does not: the model is running inside the session being retired.
- `ConductorState::arm_hand_back` already exists and already fires on the turn-end tick, so the retirement needs no new machinery.

**Implications:**
- `dash_gone` must identify seated sessions **before** it clears the bindings, since the binding is how it finds them. `DashApiOutcome::Cleared` — a tuple variant today, `Cleared(usize)` — becomes a struct variant carrying both the count and the list it found, so the handler's async half can act on it.
- `dash_gone`'s parameters are `(ledger, project_dir, dash_id)`: it holds an **id**, never a name. The dash name and its project come off each bound session's own row (`dash_name`, `project_dir`), which is why the list it returns carries them rather than the handler re-deriving a key the teardown has already destroyed ([L23]).
- **No `arc-stop` is written on this path.** The ending's own terminal dash-log line already closed the arc's generation, and a line appended after it would open a phantom one — see the generation-reset constraint and [P13]. The receipt on the card is the whole record, which is the correct outcome for a dash that no longer exists.
- The reason handed to the receipt is `Discarded` or `Joined` per the gesture, and neither offers a resume ([P04], [P13]).

#### [P09] A closed card stops the arc as `card closed`, and the stop is written with no card to show it {#p09-card-closed}

**Decision:** Closing a card seated by a stage, and `tugutil dash unbind` on such a card, both write `arc-stop <stage> card closed` before the binding is released. No receipt is attempted — there is no card to paint it on.

**Rationale:**
- This is [B05]. Today the arc leaves the sweep silently (`bound_sessions_by_dash` is `state = 'live'` only) while `tugutil dash arc` still says `review`, so the record is a resting lie.
- Writing the stop makes [F06]'s accidental resume the designed one: `dash run <name>` from a fresh card then goes through the ordinary `arc-resume` path, and the verb's "Arc on 'x' is stopped in review — resuming" line is finally true.
- A stop with no receipt is not a silent failure ([L31]): the record says it, `tugutil dash arc` says it, and the Lens says it. The only surface missing is one that does not exist.

**Implications:**
- The write goes in `do_close_session`'s phase 6, beside `sessions_recorder.mark_closed(&claude_id)`, and in `dash_api::unbind` before `set_dash_binding(session, None)` — both while the binding still names the dash.
- No hand-back is sent to a closing card; the entry is going `Closed` and `conductor::hand_back` refuses `Closed` by design.

#### [P10] The stage divider records the seating and never moves; the model switch is an arc-note {#p10-divider-records-seating}

**Decision:** A `model_change` from a WebSocket client on a card seated by a stage of a live score writes one `arc-note` line to the dash-log (`model → <selector> in <stage>`). The transcript's stage divider is **not** touched, and `stage_model` on the session row is **not** rewritten. This resolves the brief's second open question.

**Rationale:**
- The brief guessed the divider is a render of the session row. It is half that. **Live**, it is one-shot ink: `handleSessionStage` in `tugdeck/src/lib/code-session-store/reducer.ts` mints a `system_note` (`source: "stage"`) from the `session_stage` frame's `model` field and appends it to the committed transcript through an `append-stage-note` effect. **On restore**, it is composed from the row: `feeds/agent_supervisor.rs` builds the replay lineage from `stage_provenance`, and tugcode's `collectLineagePrefix` emits a `replay_stage` frame per entry carrying that model.
- So rewriting `stage_model` on a switch would make the live divider and the restored divider disagree about the same boundary — a new resting lie in place of the old one — and rewriting the live note means editing durable ink, which this codebase does not do.
- The divider's true subject is what the stage was **seated on**, and that stays true forever. Live and restored agree, because both report the seating.
- The switch is real and belongs in the record, so it goes where a switch belongs: the dash-log, which `tugutil dash arc` prints and the Lens reads. That is exactly the "cheapest true answer" [B03] preferred.
- The Review Record's model name is written into the plan by `/tugplug:plan-review` itself (`**Round N — <date>, <model>.**`, parsed by `read_review_round_lead_in` in `tugutil-core/src/plan.rs`). It is the reviewing session's own statement about itself, so a mid-round switch is already reflected there and there is nothing for the arc to correct.

**Implications:**
- **Zero deck files change.** No reducer case, no new event, no store field.
- The hand-back keeps returning the card to `deck_model`, which the dispatcher's `model_change` intercept already wrote — that half of [F03] was never wrong.
- The write hangs off the dispatcher's existing `model_change` intercept in `feeds/agent_supervisor.rs`, which is the one place that can tell the deck's selector from the arc's (the conductor's frames go straight onto `input_tx`).

#### [P11] The resume arm stays where it is {#p11-resume-placement}

**Decision:** `arc_action`'s `record.resume` arm stays **after** the `session_idle` check, so a `tugutil dash run` typed from inside a turn rotates at that turn's end. This resolves the brief's first open question; no code moves.

**Rationale:**
- The placement is already right and already pinned by `a_resume_waits_for_the_asking_turn_to_end` in `feeds/dash_arc.rs`. A user who typed `/new`, did something else, and then asked for the arc back wants the same thing a user who asked for it mid-turn wants: the turn they are in to finish first.
- Rotating on receipt would kill the claude running the turn that asked — the conductor's turn-end rule, applied to a resume.

**Implications:**
- The doctrine table's *how the work resumes* cells all say `tugutil dash run <name>`, and the table's prose states the timing once rather than per row.

#### [P12] A cancel carries its cause, and only the user's takes the card {#p12-cancel-cause}

**Decision:** `turn_cancelled` gains an optional `is_recovery` field, written by tugcode. The user's cancel leaves it absent; a cancel synthesized because tugcode force-terminated a wedged claude sets it `true`. `ArcFacts::stage_turn_cancelled` is true only for the former. A recovery cancel decides nothing at the predicate — no stop, no rotation.

**Rationale:**
- `turn_cancelled` today means "the turn's `ActiveTurn.interrupted` flag was set", and two very different things set it. `handleInterrupt` sets it for the user. `forceTerminateAndRespawn` sets it for the result-liveness watchdog (`armResultWatchdog` → `result_timeout`), which fires when a turn goes `RESULT_WATCHDOG_MS` with no `result` — a wedged claude, no user anywhere. Both then reach `signalEofToActiveTurn`, which writes one indistinguishable frame.
- Without the distinction, [P01]'s arm stops a healthy arc and its receipt says *you took the card back* to a user who did nothing. That is the resting lie this phase exists to remove, reintroduced one layer down.
- The reset in `agent_bridge.rs` cannot cover it. `forceTerminateAndRespawn` respawns `--resume` against the **current** claude id, so the `claude_session_id != id` guard that zeroes `turns_ended` never fires and the flag would latch on a session that is still alive and still working.
- The frame is the right place to carry it because the frame is where the cause is known. tugcast can only observe that a turn ended; tugcode is the process that decided why.
- `is_recovery` rather than a `cause` string because `turn_complete` already carries exactly this shape — an optional `is_api_error: boolean` that `turn_ended_in_api_error` reads. One idiom, already proven on the wire, and an older frame with no field reads as a user cancel, which is what every frame written before this change was.
- **The escalation ladder is a user cancel, not a recovery.** `handleInterrupt` also reaches `forceTerminateAndRespawn` (`interrupt_unacked`) when claude does not acknowledge the interrupt. The user cancelled; tugcode merely had to press harder. So the cause is set by the *originating* gesture and a recovery never overwrites a cause already claimed by the user.

**Implications:**
- `ActiveTurn` gains a field recording why it was interrupted; `handleInterrupt` claims it first, and `forceTerminateAndRespawn` sets `recovery` only when nothing has claimed it.
- Both emit sites read that field: `signalEofToActiveTurn` and `emitInflightTurnFromActiveTurn` (the suppressed-window re-synthesis), or a suppressed cancel would lose its cause.
- This is a **tugcode** change, so the binary must be rebuilt before anything downstream is exercised — `bun build --compile`, which `just build` and `just build-app` already run.
- A recovery cancel returning `None` means the stage sits and the *next* turn decides. That is the same shape as every other "the stage did not answer" case, and it is why the arm is written as a positive test for a user cancel rather than as a negative test for a recovery.

#### [P13] A join is an ending too, and `dash_gone` says which one it was {#p13-join-is-an-ending}

**Decision:** The `dash_gone` op carries the gesture that ended the dash. `ArcStopReason` gains `Joined` beside `Discarded`, and the receipt [P08] paints names the gesture: a discarded dash says the dash was discarded, a joined one says the work landed. Neither offers a resume.

**Rationale:**
- `broadcast_dash_gone` is called from three places in `tugutil/src/dash.rs`, and only one is a discard: `run_discard`, `run_join`, and `run_join_resolve`. The brief read `dash_gone` as the discard's teardown and it is not — it is the teardown of any ending, which is exactly why the binding vanishes just as silently after a join.
- A card that shows *arc discarded* when the user just joined their work is worse than the silence it replaces. The gesture is known at the call site and costs one field to carry.
- `join` is the verb, and the receipt says so — the umbrella word is reserved for the shared `commit | join` sense and does not belong on either half.
- A joined dash is not resumable for the same reason a discarded one is not: `read_arc` resets at the terminal `joined …` line and returns `None`, so `tugutil dash run` would open a new arc rather than resume this one. The receipt says there is nothing to resume, truthfully.

**Implications:**
- `server.rs`'s `dash_gone` arm reads one more optional field; an older `tugutil` that omits it is read as a discard, which is what every caller before this change was.
- Nothing writes an `arc-stop` on this path at all ([P08]), so `Joined` and `Discarded` are the two `ArcStopReason` variants that exist for their **sentence** and are never written as a log word. The variant table marks them.
- The doctrine table gains a `dash join` row beside `dash discard`.

---

### Deep Dives {#deep-dives}

#### Where each new fact is gathered {#fact-gathering}

The predicate is pure ([P04] of the arc plan, restated in `dash_arc.rs`'s module doc), so both new facts are gathered by the runner. Neither costs a new read of anything.

| Fact | Gathered in | From |
|---|---|---|
| `stage_turn_cancelled` | `session_snapshot` (`dash_arc_runner.rs`) | `LedgerEntry::turn_cancelled`, a new field written at the same dispatcher edge that writes `turn_api_error` — true only for a *user* cancel, per the frame's `is_recovery` marker ([P12]) |
| `stage_seated` | `session_snapshot` | `SessionLedger::stage_provenance(claude_session_id).is_some()` |

`turn_cancelled` must be reset where `turn_api_error` is reset: `feeds/agent_bridge.rs`, inside the `if entry.claude_session_id.as_deref() != Some(id.as_str())` block that also zeroes `turns_ended` on a `session_init` naming a different claude id. Without that reset the flag latches and the *next* stage stops the moment it ends its first turn.

The predicate arm order is load-bearing and stated in `dash_arc.rs`'s module doc: a dead session outranks everything, an open turn outranks every rotation, a resume outranks the documents, a not-current stage outranks the per-stage arms. The two new arms slot in as follows, first-match-wins:

1. `!session_live` → `Stop { SessionGone }` *(unchanged)*
2. `!session_idle` → `None` *(unchanged)*
3. `record.resume` → `Rotate` *(unchanged — [P11])*
4. `!stage_session_current` → **`!stage_seated` → `Stop { CardTaken }`**, else `Rotate` the recorded stage *(new branch inside the existing arm — [P03])*
5. `stage.is_some() && !stage_turn_ended` → `None` *(unchanged)*
6. `stage_api_error` → `Stop { ApiError }` *(unchanged)*
7. **`stage_turn_cancelled && stage != Implement` → `Stop { CardTaken }`** *(new, beside the API-error arm — [P01], [P02])*
8. the per-stage arms *(unchanged)*

Arm 7 sits **after** the never-run guard because a session that has ended no turn cannot have cancelled one, and **after** the API-error arm because a turn that ended in a 529 is a machine failure with its own reason, not a taking.

#### The stop path, and who calls it {#stop-path}

```
stop_arc_for_session(supervisor, state, session, project, dash, stage, reason, how)
  1. summary = format_arc_stop_receipt(record, stage, reason)
  2. how.hand_back:  Send  → conductor::hand_back(supervisor, session)   ← first, so the card is theirs
                     Arm   → state.arm_hand_back(session)               ← the stage is mid-turn ([P08])
                     None  → nothing                                    ← the card is closing ([P09])
  3. how.receipt:    supervisor.record_arc_receipt(session, dash, project, summary)
  4. how.record:     append_arc_stop(project, dash, stage, reason)
```

`how` is two enums and a bool, not five booleans: the hand-back has three genuinely different answers and each is stated by a decision above, while the receipt and the record are independent yes/no. Every caller in the table below names its combination explicitly, so a new caller cannot inherit a default nobody chose.

Callers:

| Caller | Where | Reason |
|---|---|---|
| the predicate's `Stop` | `dash_arc_runner::finish` | whatever the predicate returned |
| a refused rotation | `dash_arc_runner::rotate` | `refusal.stop_reason()` |
| `dash discard` / `dash join` | `dash_api::dash_gone` → `dash_handler` | `Discarded` / `Joined` (hand-back armed, not sent; receipt only, no record — [P08], [P13]) |
| card close / `dash unbind` | `do_close_session`, `dash_api::unbind` | `CardClosed` (record only, no receipt — [P09]) |
| `tugutil dash stop` | `dash_handler`, `op: "arc_stop"` | `StoppedByUser` |

The ending and close callers each take documented deviations from the full path, and every deviation is the point of its decision. An ending (discard or join) **arms** the hand-back rather than sending it, because the stage is mid-turn, and writes no `arc-stop` at all, because the gesture's own terminal dash-log line has already closed the arc's generation and a later line would open a phantom one. A close writes the record and skips the receipt, because there is no card.

Only three of the five callers therefore run all four numbered acts. `stop_arc_for_session` takes the two deviations as parameters rather than growing two near-copies: whether to send the hand-back or arm it, and whether to append the record. A caller that wants a receipt and nothing else is one call with two flags, which is the whole reason the path is shared.

#### Why the bind refusal cannot fire on the arc's own binds {#bind-refusal-safety}

`dash_api::bind` is reached by three ops: `bind`, `arc_run`, and the `bind_dash` CONTROL verb's server half. The refusal predicate is:

```
score_is_running(ledger, tug_session_id) && row.dash_name.as_deref() != Some(dash)
```

`score_is_running` reads the session's *current* binding, looks its arc up, and answers `!done && stopped.is_none()`. So:

- `tugutil dash run <same dash>` on a live arc — a resume — has `dash_name == dash`, so it does not refuse.
- `tugutil dash run <other dash>` while a live arc runs — the [F04] case — refuses.
- `dash create` / `dash step start` calling `claim_dash` on the dash the card is already running — no refusal.
- Any bind at all on a card with no binding, no arc record, or a `done`/`stopped` one — no refusal, because `score_is_running` is false.

`open_arc` in `tugutil/src/dash.rs` already refuses a *different document on the same dash name* with its own message; the two refusals do not overlap.

---

### Specification {#specification}

**Spec S01: `ArcStopReason`** {#s01-arc-stop-reason}

Lands in `tugrust/crates/tugdash-core/src/arc.rs`.

| Variant | Log word | Receipt sentence |
|---|---|---|
| `Lint` | `lint` | the plan does not lint |
| `ApiError` | `api error` | its turn ended in an API error, not a response |
| `ReviewDidNotStamp` | `review did not stamp` | two review rounds ended without stamping the plan |
| `DocumentMissing` | `document missing` | the document it opened on is gone |
| `PlanMissing` | `plan missing` | the plan is gone |
| `SessionGone` | `session gone` | its session ended |
| `CardTaken` | `card taken` | you took the card back |
| `CardClosed` | `card closed` | the card it ran on closed |
| `StoppedByUser` | `stopped by user` | you stopped it |
| `Discarded` † | `discarded` | the dash was discarded |
| `Joined` † | `joined` | the dash joined and the work landed |
| `PromptUnavailable` | `prompt unavailable` | its opening prompt could not be composed |
| `SessionIdle` | `session idle` | its session had no claude running to rotate |
| `SessionErrored` | `session errored` | its session errored out |
| `SessionClosed` | `session closed` | its session was closed |
| `SpawnQueueFull` | `spawn queue full` | the card's spawn queue was full |
| `NoStdin` | `no stdin` | the card's session had no input channel |
| `StdinClosed` | `stdin closed` | the card's input channel closed |
| `ArcRunning` | `arc running` | the card was already running another score |

`as_str()` returns the log word; `sentence()` returns the receipt sentence. Both match exhaustively — no `_ =>` arm in either.

† `Discarded` and `Joined` exist for their sentence alone. Nothing writes them to the dash-log, because the gesture's own terminal line has already closed the arc's generation ([P08], [P13]); they carry a log word so `as_str()` stays total and so the vocabulary reads as one list.

The last seven rows are the conductor's `Refusal` variants, and `Refusal` has **eight**. The one with no twin is `UnknownSession`, whose `reason()` is already `"session gone"` — it maps onto `SessionGone` above rather than growing a duplicate. That is what `every_conductor_refusal_maps_to_a_stop_reason` asserts: a total mapping, not a bijection.

**Spec S02: the stop receipt** {#s02-stop-receipt}

```
arc stopped · <dash> · in <stage> — <sentence>
resume with tugutil dash run <dash>
```

The second line is present for every reason **except** `Discarded` and `Joined`, the two endings with nothing left to resume:

```
arc stopped · <dash> · in <stage> — the dash was discarded
there is nothing to resume
```

The receipt [P08] paints on a card whose dash has just ended is a different string — it announces a retirement that has not happened yet, rather than a stop that has:

```
arc discarded · <dash> · the stage's turn will end and the card returns to <model>
arc joined · <dash> · the stage's turn will end and the card returns to <model>
```

`<model>` is the entry's `deck_model`, or `the account default` when it has none.

**Spec S05: the `turn_cancelled` cause marker** {#s05-cancel-cause}

`TurnCancelled` in `tugcode/src/types.ts` gains `is_recovery?: boolean`, mirroring `TurnComplete.is_api_error`. Absent or `false` means the user cancelled; `true` means tugcode force-terminated a wedged claude to recover it.

| Path | `is_recovery` | Why |
|---|---|---|
| `handleInterrupt` — the user cancelled | absent | the gesture is the user's |
| `handleInterrupt` → `forceTerminateAndRespawn("interrupt_unacked")` | absent | still the user's cancel; tugcode only had to press harder |
| `armResultWatchdog` → `forceTerminateAndRespawn("result_timeout")` | `true` | no user in the loop; a wedged turn recovered by resuming the same claude id |
| a frame from a build before this change | absent | reads as a user cancel, which is what it was |

The cause is claimed by whichever path interrupts the turn **first**, and a recovery never overwrites a claim the user already made.

**Spec S03: the `arc_stop` op** {#s03-arc-stop-op}

`POST /api/dash`, request `{ "op": "arc_stop", "tug_session_id": <id>, "project_dir": <path>, "dash": <name> }`.

- Unknown session → `404 unknown_session`, so the CLI's try-each-instance loop walks on.
- Session known, no binding to that dash → error naming what the card is bound to.
- Binding present, arc record absent / `done` / already `stopped` → error saying there is no live arc to stop (a state the verb reports, not a crash).
- Otherwise: the [P05] path with `StoppedByUser`, and `200 { "status": "ok", "dash": <name>, "stage": <stage> }`.

**Spec S04: the interruptions table's columns** {#s04-table-columns}

Three columns, per [B01]: *what the arc does*, *what the user sees*, *how the work resumes*. Every row's third cell is non-empty. Every row's second cell names a receipt, with exactly one exception — the side-question row, whose whole content is that nothing happens ([B10]). Every row cites the test that pins it.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|---|---|
| `tests/app-test/at0476-arc-interruptions.test.ts` | the live cover for the user-side rows |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|---|---|---|---|
| `ArcStopReason` | enum | `tugrust/crates/tugdash-core/src/arc.rs` | Spec S01; `as_str()`, `sentence()` |
| `append_arc_stop` | fn | `tugrust/crates/tugdash-core/src/arc.rs` | reason param becomes `ArcStopReason` |
| `ArcAction::Stop` | enum variant | `tugcast/src/feeds/dash_arc.rs` | `reason: ArcStopReason` |
| `ArcFacts::stage_turn_cancelled` | field | `tugcast/src/feeds/dash_arc.rs` | [P01] |
| `ArcFacts::stage_seated` | field | `tugcast/src/feeds/dash_arc.rs` | [P03] |
| `LedgerEntry::turn_cancelled` | field | `tugcast/src/feeds/agent_supervisor.rs` | written at the turn-end edge, reset in `agent_bridge.rs`; a *user* cancel only |
| `turn_ended_in_user_cancel` | fn | `tugcast/src/feeds/agent_supervisor.rs` | beside `turn_ended_in_api_error`; `turn_cancelled` with no `is_recovery` |
| `TurnCancelled.is_recovery` | field | `tugcode/src/types.ts` | Spec S05 |
| `ActiveTurn.interruptCause` | field | `tugcode/src/session.ts` | `"user"` \| `"recovery"`, claimed first-writer-wins ([P12]) |
| `SessionSnapshot::{turn_cancelled, stage_seated}` | fields | `tugcast/src/feeds/dash_arc_runner.rs` | gathered in `session_snapshot` |
| `stop_arc_for_session` | fn | `tugcast/src/feeds/dash_arc_runner.rs` | [P05]; `pub(crate)` |
| `StopDelivery` | struct | `tugcast/src/feeds/dash_arc_runner.rs` | hand-back `Send`\|`Arm`\|`None` + receipt/record bools; no `Default` |
| `format_arc_stop_receipt` | fn | `tugcast/src/feeds/dash_arc_runner.rs` | takes `ArcStopReason`; `other` arm deleted |
| `Refusal::stop_reason` | fn | `tugcast/src/conductor/mod.rs` | `Refusal → ArcStopReason` |
| `SeatedArcStage` | struct | `tugcast/src/dash_api.rs` | session id, dash name, project dir, stage — a `dash_gone` holds only a dash **id**, so the name comes off each bound row |
| `DashApiOutcome::Cleared` | variant | `tugcast/src/dash_api.rs` | tuple → struct: `{ cleared: usize, seated: Vec<SeatedArcStage> }` |
| `DashGoneReason` | enum | `tugcast/src/dash_api.rs` | `Discarded` \| `Joined`, off the op's new field ([P13]); absent reads as `Discarded` |
| `DashApiOutcome::ArcStopped` | variant | `tugcast/src/dash_api.rs` | Spec S03 |
| `dash_api::arc_stop` | fn | `tugcast/src/dash_api.rs` | blocking half of Spec S03 |
| `DashCommands::Stop` | variant | `tugrust/crates/tugutil/src/cli.rs` | `tugutil dash stop <name> [--project]` |
| `run_arc_stop` | fn | `tugrust/crates/tugutil/src/dash.rs` | [P07] |
| `broadcast_dash_gone` | fn | `tugrust/crates/tugutil/src/dash.rs` | gains the gesture parameter; three call sites — `run_discard`, `run_join`, `run_join_resolve` ([P13]) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|---|---|---|
| **Unit (predicate)** | `arc_action` over synthesized `ArcFacts` | every new arm and its non-firing neighbours |
| **Unit (pure format)** | `ArcStopReason::sentence`, `format_arc_stop_receipt` | the whole reason table, plus exhaustiveness |
| **Integration (runner)** | `sweep` over a real temp project + a real in-memory `SessionLedger` + `test_minimal_supervisor` | the stop path's frames and the dash-log lines it writes |
| **Integration (server)** | `dash_api` functions over a real in-memory ledger | the bind refusal, `arc_stop`, `dash_gone`'s seated list |
| **App-test** | the real `Tug.app` | the user-side rows: the receipt on the card and the `--json` state |

#### What stays out of tests {#test-non-goals}

- **The deck.** [P10] changes no tugdeck file, so there is nothing to render-test. `at0474-dash-arc-transcript` already covers the divider, live and restored, and it must keep passing unchanged — that is the assertion, not a new test.
- **`/btw` and `AskUserQuestion` inside a stage.** [B10]'s row exists so the table's completeness can be checked, not so anything is built. The claim it makes — a side question leaves the documents untouched, so the predicate sees no edge — is already what every "no document changed" predicate test asserts.
- **A relaunch mid-arc.** [B09]: `a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop` in `dash_arc_runner.rs` already pins it. The doctrine row cites that test rather than adding a second one.
- **jsdom / happy-dom / @testing-library/react / mock stores.** Banned; nothing here needs a DOM substrate.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The closed stop vocabulary | done | `1d0b2c2ac` |
| #step-2 | The cancelled-turn fact and its arm | done | `c4283576d` |
| #step-3 | `stage_seated` and the taken-card arm | done | `3956bd85e` |
| #step-4 | One stop path | done | `56494b6fd` |
| #step-5 | The bind refusal | done | `ddbad7a92` |
| #step-6 | `tugutil dash stop` | done | `6337ed2cc` |
| #step-7 | An ending reaches the stage | done | `41f8f990e` |
| #step-8 | A closed card stops the arc | done | `0a29422a5` |
| #step-9 | The model-switch note | done | `f0d6ef37e` |
| #step-10 | The Interruptions doctrine table | done | `3395a879b` |
| #step-11 | The live cover | done | `064984a3e` |
| #step-12 | Integration Checkpoint | done | `5b539c672` |

---

#### Step 1: The closed stop vocabulary {#step-1}

**Commit:** `dash(interruptions): close the stop-reason vocabulary and delete the receipt's fallback arm`

**References:** [P04] Closed reason enum, Spec S01, Risk R01, (#stop-path)

**Artifacts:**
- `ArcStopReason` in `tugrust/crates/tugdash-core/src/arc.rs`, with `as_str()` and `sentence()`.
- `append_arc_stop` taking it.
- `format_arc_stop_receipt` in `tugcast/src/feeds/dash_arc_runner.rs` matching it exhaustively.
- `Refusal::stop_reason()` in `tugcast/src/conductor/mod.rs`.

**Tasks:**
- [ ] Add `ArcStopReason` to `tugdash-core/src/arc.rs` with every variant in Spec S01. Derive `Debug, Clone, Copy, PartialEq, Eq`. `as_str(&self) -> &'static str` returns the log word; `sentence(&self) -> &'static str` returns the receipt sentence. No `_ =>` arm in either match.
- [ ] Change `append_arc_stop(project, dash, stage, reason)`'s `reason` parameter from `&str` to `ArcStopReason`, writing `reason.as_str()` into the log line. Leave the **read** side alone: `ArcRecord.stopped` stays `(ArcStage, String)` so a log written by an older build still parses ([R01](#r01-legacy-reason)).
- [ ] Change `ArcAction::Stop`'s `reason` field from `String` to `ArcStopReason` in `feeds/dash_arc.rs`, and update every construction site and every test in that file.
- [ ] Rewrite `format_arc_stop_receipt` to take `ArcStopReason`, call `reason.sentence()`, and **delete the `other => other.to_string()` arm**. Give `Discarded` and `Joined` the alternate second line from Spec S02.
- [ ] Add `Refusal::stop_reason(&self) -> ArcStopReason` in `conductor/mod.rs`, mapping all **eight** variants to their Spec S01 twin — `UnknownSession` maps onto `SessionGone`, whose word it already returns. Keep `Refusal::reason()` — the log lines and the existing `warn!` calls use it.
- [ ] Update `dash_arc_runner::rotate`'s three `stop(..)` call sites — `prompt unavailable`, `document missing`, and the one refusal path (`Err(refusal)`) — to pass `ArcStopReason`.

**Tests:**
- [ ] Unit: `every_stop_reason_has_a_sentence_and_a_word` — iterate a `const ALL: &[ArcStopReason]` and assert both accessors return non-empty, distinct strings. The array is what a new variant must be added to, and the exhaustive matches are what the compiler enforces.
- [ ] Unit: `every_conductor_refusal_maps_to_a_stop_reason` — iterate every `Refusal` variant and assert `stop_reason()` round-trips its word.
- [ ] Unit: `the_stop_receipt_says_what_stopped_it_and_how_to_resume` — one assertion per reason over `format_arc_stop_receipt`, including `Discarded`'s "there is nothing to resume".

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast`
- [ ] `grep -n 'other => other' tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs` returns nothing.

---

#### Step 2: The cancelled-turn fact and its arm {#step-2}

**Depends on:** #step-1

**Commit:** `dash(interruptions): stop a devise or review stage whose turn the user cancelled`

**References:** [P01] Card taken, [P02] Implement sits, [P12] Cancel cause, Spec S01, Spec S05, (#fact-gathering)

**Artifacts:**
- `ActiveTurn.interruptCause` and `TurnCancelled.is_recovery` in tugcode.
- `LedgerEntry::turn_cancelled` and `turn_ended_in_user_cancel` in `feeds/agent_supervisor.rs`.
- Its reset in `feeds/agent_bridge.rs`.
- `SessionSnapshot::turn_cancelled` and `ArcFacts::stage_turn_cancelled`.
- The `card taken` arm for a cancelled devise/review turn.

**Tasks:**
- [ ] **tugcode first.** Add `is_recovery?: boolean` to `TurnCancelled` in `tugcode/src/types.ts`, beside the shape `TurnComplete.is_api_error` already has. It is outbound, so no inbound-allowlist edit is involved.
- [ ] Add an interrupt-cause field to `ActiveTurn` in `tugcode/src/session.ts`. `handleInterrupt` claims it `"user"`; `forceTerminateAndRespawn` sets `"recovery"` **only when nothing has claimed it**, so the `interrupt_unacked` escalation stays the user's cancel (Spec S05).
- [ ] Emit it from **both** cancel sites — `signalEofToActiveTurn` and `emitInflightTurnFromActiveTurn` — writing `is_recovery: true` only for the recovery cause, so a suppressed cancel does not lose it and an absent field keeps meaning a user cancel.
- [ ] Add `pub turn_cancelled: bool` to `LedgerEntry` beside `turn_api_error`, defaulting `false` in the constructor. Document it the way `turn_api_error` is documented: overwritten at every turn end, reset when a `session_init` names a different claude session — and note that it means a *user* cancel, because a recovery resumes the same claude id and would never hit that reset.
- [ ] Add `pub(crate) fn turn_ended_in_user_cancel(payload: &[u8]) -> bool` beside `turn_ended_in_api_error`: the payload's `type` is `"turn_cancelled"` **and** `is_recovery` is not `true`.
- [ ] In the dispatcher's turn-end edge — the block that clears `turn_active`, increments `turns_ended`, and sets `turn_api_error` — set `entry.turn_cancelled = turn_ended_in_user_cancel(&frame.payload)`.
- [ ] In `feeds/agent_bridge.rs`, inside the `if entry.claude_session_id.as_deref() != Some(id.as_str())` block that zeroes `turns_ended` and `turn_api_error`, zero `turn_cancelled` too. **This is the reset that stops the flag latching across a rotation**; without it the next stage stops the moment it ends its first turn.
- [ ] Add `turn_cancelled` to `SessionSnapshot` in `dash_arc_runner.rs` and read it in `session_snapshot` from the same locked block that reads `turn_api_error`.
- [ ] Add `pub stage_turn_cancelled: bool` to `ArcFacts` with a doc comment saying what it means and why implement is exempt, and populate it in `read`.
- [ ] Add the arm to `arc_action`, immediately after the `stage_api_error` arm: for `Some(stage)` where `facts.stage_turn_cancelled && stage != ArcStage::Implement`, return `Stop { stage, reason: ArcStopReason::CardTaken }`.

**Tests:**
- [ ] Unit (`dash_arc.rs`): `a_cancelled_devise_or_review_turn_stops_the_arc_as_card_taken` — for `Devise` and `Review`, `stage_turn_cancelled = true` yields `Stop { CardTaken }`, and specifically **not** `lint` even with `lint_ok = false`.
- [ ] Unit: `a_cancelled_implement_turn_sits` — `Implement` with `stage_turn_cancelled = true` and no `step_just_done` yields `None`.
- [ ] Unit: `an_api_error_outranks_a_cancel` — both flags set yields `Stop { ApiError }`, pinning the arm order.
- [ ] Unit: `a_cancel_before_the_stage_has_ended_a_turn_decides_nothing` — `stage_turn_ended = false` with `stage_turn_cancelled = true` yields `None`.
- [ ] Unit (`agent_supervisor.rs`): `turn_ended_in_user_cancel` accepts a bare `turn_cancelled` payload, rejects a `turn_complete` one, and rejects a `turn_cancelled` carrying `is_recovery: true`.
- [ ] tugcode (`bun test`): a watchdog force-terminate emits `turn_cancelled` with `is_recovery: true`, and a user interrupt — including one that escalates through `interrupt_unacked` — emits one without it. This is the assertion that keeps [P12]'s distinction from silently collapsing back into one flag.

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `cd tugrust && cargo nextest run -p tugcast dash_arc`
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 3: `stage_seated` and the taken-card arm {#step-3}

**Depends on:** #step-2

**Commit:** `dash(interruptions): tell a card the user took back from a stage that died`

**References:** [P03] stage_seated, [P01] Card taken, Spec S01, (#fact-gathering)

**Artifacts:**
- `SessionSnapshot::stage_seated` and `ArcFacts::stage_seated`.
- The branch inside the existing not-current arm.

**Tasks:**
- [ ] Add `stage_seated: bool` to `SessionSnapshot`, computed in `session_snapshot` as `claude_session_id.as_deref().is_some_and(|id| ctx.session_ledger.stage_provenance(id).is_some())` — next to the `get_context_breakdown` read already there.
- [ ] Add `pub stage_seated: bool` to `ArcFacts`. Document it as: the claude session running on the card carries a `stage_label`, which only a rotation writes (`feeds/agent_bridge.rs`, `set_stage_provenance` on the rotation's `session_init`). Populate it in `read`.
- [ ] Inside `arc_action`'s `!facts.stage_session_current` arm, branch: when `!facts.stage_seated`, return `Stop { stage, reason: ArcStopReason::CardTaken }`; otherwise keep the existing re-rotation. Extend the arm's comment to name both cases and say why a relaunch never reaches the stop (the rebind seeds the recorded claude id, so `stage_session_current` is true).
- [ ] Set `stage_seated: true` in the existing `facts()` fixture in `dash_arc.rs` and in `snapshot(..)` in `dash_arc_runner.rs`, so every existing test keeps testing what it tested.
- [ ] Add a comment at the `SpawnState::Idle` early return in `session_snapshot` recording what it costs this decision: a card parked `Idle` by a reset is not judged until it spawns again, so the `card taken` stop lands at the user's next prompt, not at the gesture ([P03]). The early return stays as it is — it is what makes a relaunch a wait.

**Tests:**
- [ ] Unit (`dash_arc.rs`): `a_session_no_rotation_seated_is_a_card_taken_back` — `stage_session_current = false`, `stage_seated = false` yields `Stop { CardTaken }`.
- [ ] Unit: `a_seated_stage_the_record_does_not_name_is_rotated_again` — `stage_session_current = false`, `stage_seated = true` still yields the existing re-rotation, including the implement step range.
- [ ] Integration (`dash_arc_runner.rs`): `a_fresh_unseated_session_stops_the_arc_and_hands_the_card_back` — a temp project with an `arc-stage` line naming `gone`, a harness entry whose claude id is `claude-1` with no `stage_label` row, one `sweep`: exactly one `model_change` frame carrying the deck's model, and `read_arc(..).stopped == Some((Devise, "card taken"))`.
- [ ] Integration: `a_restart_re_rotates_the_recorded_stage_exactly_once` keeps passing with a `stage_label` written for `claude-1` — the existing test, extended by one setup line, is the proof the arm did not swallow the restart case.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast dash_arc`

---

#### Step 4: One stop path {#step-4}

**Depends on:** #step-1

**Commit:** `dash(interruptions): give every stopper one path that records, hands back, and leaves a receipt`

**References:** [P05] One stop path, Spec S02, Risk R02, (#stop-path)

**Artifacts:**
- `stop_arc_for_session` in `dash_arc_runner.rs`.
- `finish`'s stop branch and `stop` delegating to it.

**Tasks:**
- [ ] Add `pub(crate) async fn stop_arc_for_session(supervisor: &AgentSupervisor, state: &ConductorState, session: &TugSessionId, project: &Path, dash: &str, stage: ArcStage, reason: ArcStopReason, how: StopDelivery)`. It reads the record (for the receipt's dash name and stage list), performs the hand-back **first** in whichever of the three forms `how` names (warning on refusal exactly as `finish` does today), records the receipt through `supervisor.record_arc_receipt` when `how` asks for one, and appends the stop on the blocking pool when `how` asks for a record.
- [ ] Add `StopDelivery` beside it: the hand-back is `Send | Arm | None` and the receipt and record are independent bools. No `Default` — a caller states its combination, because the three deviations are each a decision ([P05], [P08], [P09]).
- [ ] **Change the ordering while consolidating, and say so in the commit.** `finish` today records the receipt *before* the hand-back; the doc comment claiming otherwise is dangling above `format_arc_receipt` rather than attached to `finish`, so nothing has enforced it. The new function issues the restore first, per [P05]. Document in the function that this is issue-order, not arrival-order — the two travel different channels.
- [ ] Rewrite `finish`'s `Some((stage, reason))` branch to call it with `Send`/receipt/record; keep the `None` branch (the done receipt + `append_arc_done`) where it is, and note in the plan-facing comment that the done path's ordering is deliberately untouched by this step.
- [ ] Delete the local `stop` helper and point `rotate`'s three `stop(..)` call sites at the new function — this is where the missing receipt on a refused rotation gets fixed.
- [ ] Add a `pub(crate)` re-export or accessor as needed so `dash_api` / `server.rs` can call it in Steps 6–8.

**Tests:**
- [ ] Integration: `a_refused_rotation_leaves_a_receipt_as_well_as_a_record` — drive a rotation into a refusal (a `Closed` entry), assert the dash-log's `arc-stop` line **and** that `record_arc_receipt` wrote a landing row for the session.
- [ ] Integration: `a_stop_hands_the_card_back_on_the_decks_own_model` — the existing test, unchanged, still passes through the new path. It asserts one `model_change` frame and the recorded reason, neither of which the reordering moves.
- [ ] Integration: `a_stop_issues_the_hand_back_before_it_records_the_receipt` — the ordering [P05] asserts, pinned now that it is real rather than only documented.
- [ ] Integration: `a_stop_with_no_receipt_still_records_and_hands_back` — the `CardClosed` combination writes the `arc-stop` line and the `model_change` and no landing row.
- [ ] Integration: `an_armed_stop_records_no_line_and_sends_no_frame` — the ending combination ([P08]) leaves a receipt and an armed hand-back only: no `model_change` on the queue and no new dash-log line.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 5: The bind refusal {#step-5}

**Depends on:** #step-1

**Commit:** `dash(interruptions): refuse a bind that would displace a card's running score`

**References:** [P06] Bind refusal, (#bind-refusal-safety)

**Artifacts:**
- The refusal in `dash_api::bind`.

**Tasks:**
- [ ] In `dash_api::bind`, after the existing `same_project` guard and before `ensure_dash_id`, refuse when `conductor::score_is_running(ledger, tug_session_id)` and the row's `dash_name` is not the dash being bound: `DashApiOutcome::Error(format!("card runs {running} — stop it before binding {dash}"))`.
- [ ] Document why the check reads the *current* binding (it is the arc being displaced, which is the one the refusal protects) and why it cannot fire on `claim_dash` or on a resume of the same dash.
- [ ] Verify the message reaches the CLI unchanged: `dash_handler` already maps `DashApiOutcome::Error` to a 500 whose `message` `post_dash_api` surfaces, and `dispatch` exits 1 on any `Err`.

**Tests:**
- [ ] Integration (`dash_api.rs`): `a_card_running_a_score_refuses_a_bind_to_another_dash` — a real in-memory ledger, a real temp project with a live arc record for `alpha`, a session bound to `alpha`; binding `beta` errors with both names in the message and leaves `dash_name == "alpha"`.
- [ ] Integration: `binding_the_same_dash_again_is_still_a_no_op` — binding `alpha` on the same fixture succeeds.
- [ ] Integration: `a_stopped_or_done_arc_does_not_refuse_a_bind` — append a stop (and separately a done) to the record; both binds of `beta` succeed.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast dash_api`

---

#### Step 6: `tugutil dash stop` {#step-6}

**Depends on:** #step-4

**Commit:** `dash(interruptions): add tugutil dash stop, the verb for stopping an arc and keeping the dash`

**References:** [P07] dash stop, [P05] One stop path, Spec S03, Spec S02

**Artifacts:**
- `DashCommands::Stop` in `tugutil/src/cli.rs`.
- `run_arc_stop` in `tugutil/src/dash.rs`.
- `op: "arc_stop"` in `dash_api.rs` + `server.rs`.

**Tasks:**
- [ ] Add `Stop { name: String, #[arg(long)] project: Option<PathBuf> }` to `DashCommands`, documented as *stop the arc, keep the dash* — and explicitly not a pause, with the reason from [P07].
- [ ] Add `run_arc_stop` in `tugutil/src/dash.rs`: resolve the calling session (`calling_session_id`) and the project (`binding_project`), `post_dash_api({ "op": "arc_stop", … })`, and print the server's stage in the human read-out or the whole payload under `--json`.
- [ ] Add `DashApiOutcome::ArcStopped { dash, stage }` and `dash_api::arc_stop(ledger, project, session, dash)` implementing Spec S03's blocking half: resolve the row, check the binding names the dash, read the arc record, and return the stage to stop — refusing by name for each state Spec S03 lists.
- [ ] Wire the op in `apply_dash_request`, and in `dash_handler`'s async half call `stop_arc_for_session(supervisor, …, ArcStopReason::StoppedByUser, receipt: true)` before responding.
- [ ] Add the verb to `dash`'s dispatch match.

**Tests:**
- [ ] Integration (`dash_api.rs`): `arc_stop_refuses_a_card_bound_to_another_dash`, `arc_stop_refuses_when_there_is_no_live_arc` (absent, `done`, and already `stopped`), and `arc_stop_names_the_stage_it_will_stop`.
- [ ] Integration (`dash_arc_runner.rs`): `a_user_stop_writes_the_record_the_receipt_and_the_hand_back` — call `stop_arc_for_session` with `StoppedByUser` against the harness and assert all three.
- [ ] Unit (`tugutil`): the CLI parses `dash stop <name> --project <p>`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugutil`
- [ ] `cd tugrust && cargo build` (warnings are errors)

---

#### Step 7: An ending reaches the stage {#step-7}

**Depends on:** #step-4

**Commit:** `dash(interruptions): tell the card when the dash under its stage is discarded or joined`

**References:** [P08] Discard reaches the stage, [P13] A join is an ending too, Spec S01, Spec S02, (#stop-path)

**Artifacts:**
- `SeatedArcStage`, `DashGoneReason`, and the reshaped `DashApiOutcome::Cleared` in `dash_api.rs`.
- The gesture parameter on `broadcast_dash_gone` and its three call sites in `tugutil/src/dash.rs`.
- The async half in `dash_handler`.

**Tasks:**
- [ ] Add `pub(crate) struct SeatedArcStage { pub session_id: String, pub dash_name: String, pub project_dir: String, pub stage: ArcStage }`. The name and project come off the bound row because `dash_gone` is handed a dash **id** and the teardown has already destroyed the branch config that would translate it ([L23]).
- [ ] Add `DashGoneReason { Discarded, Joined }`, read from a new optional field on the `dash_gone` op in `server.rs`. **A missing field reads as `Discarded`** — that is what every caller before this change was, and an older `tugutil` must not fail.
- [ ] Give `broadcast_dash_gone` a gesture parameter and pass it from all three call sites: `run_discard` → `Discarded`, `run_join` and `run_join_resolve` → `Joined`. Missing one is the whole defect this task exists to close.
- [ ] In `dash_api::dash_gone`, **before** `clear_dash_bindings_for_dash`, collect the sessions bound to `dash_id` whose row carries a `stage_label` and whose bound dash's arc record is live, pairing each with the arc's current stage. Change `DashApiOutcome::Cleared` from `Cleared(usize)` to `Cleared { cleared: usize, seated: Vec<SeatedArcStage> }` and update its existing match arms.
- [ ] In `dash_handler`'s `Cleared` arm, for each seated session: `conductor.arm_hand_back(&session_id)` and `supervisor.record_arc_receipt(..)` with Spec S02's ending receipt, worded from the gesture — `arc discarded · …` or `arc joined · …` — where `model` is the entry's `deck_model` or `"the account default"`.
- [ ] **Write no `arc-stop` on this path.** The gesture's own terminal dash-log line — `discarded` from `ops::discard`, `joined …` from the join — is appended *before* the CLI broadcasts, and `read_arc` resets the arc's generation at the last terminal line. A stop appended after it would become the first line of a phantom next generation that a dash reusing the name would be born carrying. Add a comment saying exactly that, so the absence reads as decided rather than forgotten ([L31]).
- [ ] Do **not** call `conductor::hand_back` directly here: the stage may be mid-turn, and arming is what respects the turn-end rule.

**Tests:**
- [ ] Integration (`dash_api.rs`): `dash_gone_finds_the_sessions_a_stage_is_seated_on` — two bound sessions, one with a `stage_label` and one without; only the seated one comes back in `seated`, carrying its dash name and project, and both bindings are cleared.
- [ ] Integration: `dash_gone_on_a_dash_with_no_arc_finds_nothing_seated` — the ordinary discard of a hand-made dash returns an empty `seated`.
- [ ] Integration: `an_ending_writes_no_arc_line_after_the_terminal_one` — append a terminal `discarded` line, run the `dash_gone` path, and assert `read_arc` still returns `None`. This is the phantom-generation guard, and it fails loudly if anybody adds the `append_arc_stop` back.
- [ ] Integration: `a_joined_dash_says_joined_and_a_discarded_one_says_discarded` — the two receipts over the same fixture, so the gesture cannot be dropped on the way through.
- [ ] Unit (`tugutil`): every `broadcast_dash_gone` call site names its gesture — asserted by the two join paths and the discard path each producing their own request body.
- [ ] Integration (`conductor`): `an_armed_hand_back_fires_on_the_next_turn_end` — the existing conductor behavior, asserted here as the mechanism this step relies on.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugutil`

---

#### Step 8: A closed card stops the arc {#step-8}

**Depends on:** #step-4

**Commit:** `dash(interruptions): write the stop when a scored card closes or unbinds`

**References:** [P09] Card closed, Spec S01, [L27]

**Artifacts:**
- The write in `do_close_session`.
- The write in `dash_api::unbind`.

**Tasks:**
- [ ] In `AgentSupervisor::do_close_session`, in phase 6 and **before** `sessions_recorder.mark_closed(&claude_id)`, read the row's dash binding; when the dash has a live arc record whose current stage is seated on this claude id, `append_arc_stop(project, dash, stage, ArcStopReason::CardClosed)`. No receipt and no hand-back: the entry is going `Closed`, and `conductor::hand_back` refuses `Closed` by design.
- [ ] In `dash_api::unbind`, before `set_dash_binding(session, None)`, do the same — `dash unbind` on a scored card is the same act with the same reason ([B05]). It must **fetch the row** rather than call `owns_session`, which answers the ownership question by throwing away the `dash_name` and `project_dir` this write needs; keep the `UnknownSession` outcome for a missing row so the CLI's try-each-instance loop still walks on.
- [ ] Unlike Step 7's path, this one *does* write the record: nothing terminal has been appended to the dash-log, so the arc's generation is still open and the stop lands inside it. That asymmetry with the ending path is the point of both decisions and belongs in the comment.
- [ ] Add a comment at both sites naming why there is no receipt, so the absence reads as decided rather than forgotten ([L31]).

**Tests:**
- [ ] Integration (`dash_api.rs`): `unbinding_a_scored_card_stops_the_arc_as_card_closed` — the record reads `stopped == Some((stage, "card closed"))` and the binding is cleared.
- [ ] Integration: `unbinding_a_card_with_no_arc_writes_nothing` — no dash-log line appears.
- [ ] Integration (`agent_supervisor.rs`): `closing_a_card_seated_by_a_stage_stops_its_arc` — drive `do_close_session` against a fixture whose row is bound to a dash with a live arc, and assert the log line.
- [ ] Integration (`tugutil`): after such a stop, `open_arc(root, dash, None)` returns `resumed == true` and writes `arc-resume` naming the stopped stage — the accidental resume of [F06] made designed.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugutil`

---

#### Step 9: The model-switch note {#step-9}

**Depends on:** #step-1

**Commit:** `dash(interruptions): record a mid-stage model switch in the dash-log`

**References:** [P10] Divider records the seating, (#p10-divider-records-seating)

**Artifacts:**
- One `append_arc_note` call hanging off the dispatcher's `model_change` intercept.

**Tasks:**
- [ ] In `dispatch_one`'s existing `model_change` intercept — the block that writes `entry.deck_model` — additionally: when the session's row names a dash whose arc record is live and whose current stage is seated on this session's claude id, `append_arc_note(project, dash, &format!("model → {selector} in {stage}"))` on the blocking pool.
- [ ] Guard on a *change*: writing a note when the selector already equals `deck_model` would put a line in the log for a no-op repaint.
- [ ] Add a comment stating [P10]: the transcript's stage divider records what the stage was **seated** on and is deliberately not rewritten, live or on restore, because the live divider is one-shot ink (`handleSessionStage`) and the restored one is composed from `stage_provenance` — moving one and not the other would make them disagree about the same boundary.
- [ ] Confirm nothing in `tugdeck/` changes: `git status` after this step names no file under `tugdeck/`.

**Tests:**
- [ ] Integration (`agent_supervisor.rs`): `a_model_switch_on_a_scored_card_lands_in_the_dash_log` — a fixture bound to a dash with a live arc; dispatch a `model_change`; the record's `notes` gains `model → sonnet in review`.
- [ ] Integration: `a_model_switch_on_an_unscored_card_writes_no_note` — the same dispatch with no binding leaves the log untouched.
- [ ] Integration: `repeating_the_selector_writes_no_second_note`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `git status --short tugdeck/` is empty.

---

#### Step 10: The Interruptions doctrine table {#step-10}

**Depends on:** #step-2, #step-3, #step-5, #step-6, #step-7, #step-8, #step-9

**Commit:** `tuglaws(dash-lifecycle): write the interruptions table every arc row is now tested against`

**References:** [B01] via Spec S04, [P01]–[P13], (#s04-table-columns, #success-criteria)

**Artifacts:**
- A `## Interruptions` section in `tuglaws/dash-lifecycle.md`, placed after "Arcs and stages".

**Tasks:**
- [ ] Open the section with the rule the brief states: *every interruption leaves the dash in a state that is both sayable and resumable, and the user is told which one*, and say once — rather than per row — that a resume is `tugutil dash run <name>` and that it lands at the asking turn's end ([P11]).
- [ ] Write the table with Spec S04's three columns and one row per interruption: cancel during devise, cancel during review, cancel during implement, a machine wedge recovery mid-stage ([P12]), a fresh session on the card (`/new`, reset, rewind), a model switch mid-stage, a second `/dash` naming another dash, `dash discard`, `dash join`, `dash stop`, closing the card, `dash unbind`, a tugcast relaunch mid-stage, a pending conductor rotation lost to a relaunch, and a side question inside a stage.
- [ ] **Amend the `## Binding` section in the same file.** Its bullet "A bind displaces only *this* card's previous binding" is stated flatly and [P06] makes it false; it must now say that a card running a live score refuses a bind naming a different dash. Leaving it would put the contradiction inside one document, which is worse than the silence this phase set out to fix.
- [ ] Give the fresh-session row an honest *what the arc does* cell: the stop lands at the card's next spawn, not at the gesture ([P03]).
- [ ] Cite the pinning test by name in every row. The relaunch rows cite `a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop` and point at `tuglaws/conductor.md` for the pending-rotation rule rather than restating it ([B09]).
- [ ] Give the side-question row the one "nothing happens" cell the table allows, and say in the prose that it is the only one ([B10]).
- [ ] Add the closed reason vocabulary as a short list under the table, so a reader can see what a stop can say without reading `arc.rs`.
- [ ] Add the section to `dash-lifecycle.md`'s "See also" cross-links where relevant, and check no hard-wrapped prose is introduced.

**Tests:**
- [ ] Prose assertion, checked by reading: every row's third cell is non-empty; every row but the side-question row names a receipt; every row names a test that exists.
- [ ] Unit (`dash_arc.rs`): `every_user_side_row_of_the_interruptions_table_has_an_arm` — a table test over `(fact set → expected ArcAction)` with one case per predicate-visible row, so the doctrine and the predicate cannot drift.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast dash_arc`
- [ ] Every test name cited in the table resolves: `cargo nextest list -p tugcast | grep -f <the cited names>` finds each one.

---

#### Step 11: The live cover {#step-11}

**Depends on:** #step-10

**Commit:** `test(app-test): cover the arc's user-side interruptions end to end`

**References:** [P01] Card taken, [P07] dash stop, [P08] Discard reaches the stage, Spec S02, (#test-categories)

**Artifacts:**
- `tests/app-test/at0476-arc-interruptions.test.ts`.

**Tasks:**
- [ ] Write the file with a header docblock explaining why it exists and `@covers` lines for `tugrust/crates/tugcast/src/feeds/dash_arc.rs`, `feeds/dash_arc_runner.rs`, `dash_api.rs`, `tugrust/crates/tugutil/src/dash.rs`, and `tugcode/src/session.ts` — `just app-test-covers-check` fails on a missing or unresolvable declaration.
- [ ] One test per user-side row, each: open an arc on a scratch dash, reach the interruption, then assert **both** the receipt text on the card and `tugutil dash arc --json`'s `stopped` reason, and finish with a `tugutil dash run` that resumes.
- [ ] Cover: a cancelled devise turn (`card taken`), `tugutil dash stop` (`stopped by user`), a second `/dash` naming another dash (refused, binding unchanged, first arc still live), and `dash discard` from the shell route (receipt on the card, the card back on `deck_model`).
- [ ] Any case that goes through a **reset** must send a prompt afterwards before asserting the stop. A reset parks the entry `Idle` and `session_snapshot` returns `None` for `Idle`, so the arc decides nothing until the card spawns again ([P03]) — a test that asserts straight after the gesture waits for a stop that has not happened yet and fails as a timeout.
- [ ] `@covers` must include `tugcode/src/session.ts`, since Step 2 puts the cancel's cause on the wire there and no other declaration would select this file when that changes.
- [ ] Invoke `tugutil` by **absolute path into the dash worktree's own build** — `~/.local/bin/tugutil` points at `main` and would silently run old code.
- [ ] Do not use `TUG_FORCE_BUNDLE_ID`; run through the `just` recipes. Where a gesture needs a menu chord, use `foreground: true` or click the affordance — chords die silently in a background app-test.

**Tests:**
- [ ] App-test: the four cases above, each asserting a receipt, a `--json` state, and a working resume.

**Checkpoint:**
- [ ] `just build-app` (a Rust change means the app bundle is stale; `app-test` refreshes `dist` and never the binary)
- [ ] `just app-test at0476-arc-interruptions.test.ts` — read the report bare; the `VERDICT:` line is the answer.
- [ ] `just app-test-covers-check`

---

#### Step 12: Integration Checkpoint {#step-12}

**Depends on:** #step-10, #step-11

**Commit:** `dash(interruptions): integration checkpoint`

**References:** [P05] One stop path, [P10] Divider records the seating, (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay interruption` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json` reports it — in this repo `sh scripts/verify-fit.sh {base} {head}`), substituting `{base}` / `{head}` with the replayed range.
- [ ] `Current`: the base never moved, so Step 11's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every interruption to a running dash arc leaves a record the arc can say, a receipt the card shows, and one gesture that picks the work back up — pinned by one test per row of a doctrine table in `tuglaws/dash-lifecycle.md`.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A cancelled devise or review turn stops the arc as `card taken`; a cancelled implement turn does nothing; a machine wedge recovery does nothing anywhere (unit + tugcode, Step 2)
- [ ] A fresh session no rotation seated stops the arc instead of re-rotating the stage onto it (unit + runner integration, Step 3)
- [ ] Every stop reason has a receipt sentence and there is no fallback arm (unit + grep, Step 1)
- [ ] Every stop records, hands the card back, and leaves a receipt through one function (runner integration, Step 4)
- [ ] A bind that would displace a live score is refused by name (server integration, Step 5)
- [ ] `tugutil dash stop <name>` exists, stops, and resumes through `dash run` (server integration + CLI, Step 6)
- [ ] `dash discard` and `dash join` each reach the seated stage's card with their own receipt and an armed hand-back, and neither appends a dash-log line after the terminal one (server integration, Step 7; live, Step 11)
- [ ] Closing a card or unbinding a scored one writes `arc-stop … card closed` (server + supervisor integration, Step 8)
- [ ] A mid-stage model switch lands in the dash-log and changes no tugdeck file (integration + `git status`, Step 9)
- [ ] `tuglaws/dash-lifecycle.md` carries the `## Interruptions` table, every row cited to a test that exists (prose assertion + test-name resolution, Step 10)
- [ ] The user-side rows hold in the real app (app-test, Step 11)

**Acceptance tests:**
- [ ] `every_user_side_row_of_the_interruptions_table_has_an_arm` (Step 10)
- [ ] `every_stop_reason_has_a_sentence_and_a_word` (Step 1)
- [ ] `an_ending_writes_no_arc_line_after_the_terminal_one` (Step 7)
- [ ] `at0476-arc-interruptions.test.ts` (Step 11)

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- **`tugutil dash verify`** — the third brief in the series, which may assume that a dash it refuses to verify is one the user can see and stop. That assumption is what this phase's table buys.
- **A Lens affordance for `dash stop`.** The verb lands first; whether a stopped arc deserves a control on the dash row is a separate design question.
- **Widening `TUG_DASH_ARC` into a general score handle.** `conductor.md` states the blast radius; the next score to need it pays for it.
