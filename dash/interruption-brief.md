# Interruptions: what an arc does when something gets in its way

**Purpose:** A dash arc runs unattended across three sessions on one card, and everything that can happen to a card can happen to it mid-stage — a cancel, a `/new`, a model switch, a second `/dash`, a discard from a terminal, a closed card, a relaunch. Some of those have answers the code holds well; some have answers that are wrong; several have no answer at all, and those are where the turds come from. This brief reads every cell against the code as it stands after the conductor landed (`215c57df2`) and decides what each one must do.

---

## Purpose {#purpose}

The rule every cell has to satisfy is one sentence, and it is [L31] applied to a schedule: **every interruption leaves the dash in a state that is both sayable and resumable, and the user is told which one.** *Sayable* means `tugutil dash arc <name>` and the card agree on what stage the arc is in and why it is not moving. *Resumable* means there is exactly one gesture that picks it back up, and the receipt names it. *Told* means the card shows a receipt at the moment the interruption lands, not a dash-log line the user would have to go looking for.

Four real runs on 2026-08-25 (`ornate-fairy`, `reedy-buoy`, `loose-shake`, `gauzy-snack`) supplied the evidence the original note said it wanted before the table was written. The conductor brief's non-goal held: nothing here reopens what a rotation is. This brief is about what happens *between* rotations when the user, or the machine, intervenes.

---

## Evidence {#evidence}

Each finding is one interruption, read against `tugrust/crates/tugcast/src/feeds/dash_arc.rs` (the predicate), `dash_arc_runner.rs` (the act), `agent_supervisor.rs` (the turn edge), `session_ledger.rs` (the binding), `dash_api.rs` / `server.rs` (the ops), `tugutil/src/dash.rs` (the verbs), and `tugcode/src/session.ts`.

**[F01] A cancelled turn is read as a finished one, and the arc judges the documents as if the stage had answered.** `is_turn_end` in `feeds/session_metadata.rs` matches `turn_complete` *and* `turn_cancelled`; the dispatcher's edge in `agent_supervisor.rs` fires the arc tick on both and increments `turns_ended` on both. The predicate has no fact for "cancelled" — `ArcFacts` carries `stage_turn_ended` and `stage_api_error`, nothing else about how the turn ended. So a devise cancelled mid-write stops as `lint` ("the plan does not lint"), a review cancelled mid-pass counts as a review round toward `REVIEW_CAP`, and an implement cancelled between steps sits still, which is the only one of the three that is honest. The `loose-shake` run showed the worst version — a cancel followed by a "ready to join" — and the `join_ready` half was fixed in `a9c0d1235`; the arc half is untouched. **(verified)**

**[F02] `/new` on a scored card is overridden, not honored.** `newSession` in `tugcode/src/session.ts` mints a fresh claude id and clears `TUG_DASH_ARC` (`this.currentArc = stage?.arc ?? null`). The runner's `read` then computes `stage_session_current` as `claude_session_id == record.stages.last().session_id`, which is now false; the predicate's "a recorded stage that is not the one running is a stage that died" arm fires at the fresh session's first idle — which is immediately, since a seated session reads idle before its first turn — and re-rotates the stage, on the stage's model, with `TUG_DASH_ARC` set again. The user asked for a clean card and got the arc's stage back within a second, attributed to the Conductor. Nothing distinguishes this from the case the arm was written for (a restart, a crash). **(verified by code reading; not yet reproduced live)**

**[F03] A model switch mid-stage is honored silently, and the arc never learns.** `handleModelChange` sends `set_model` as a control request to the live claude — no respawn, so the claude id is unchanged and `stage_session_current` stays true. The stage's next turn runs on the user's model; the stage divider still says the stage's model; and because the dispatcher records every WebSocket `model_change` as `deck_model`, the eventual hand-back "returns" the card to the model the user already switched to. No wrong state results, but the transcript's divider is now a resting lie about the model a review ran on, and `plan status` will carry that model's name in the Review Record. **(verified)**

**[F04] A second `/dash` on a bound card is three different things, and only one of them is refused.** `open_arc` in `tugutil/src/dash.rs`: the same document is a resume (a no-op on a live arc); a different document on the *same dash name* is refused with a reason that names the running document; a different *dash name* goes to `arc_run` → `dash_api::bind`, which checks only that the dash is in the session's project and then `set_dash_binding` displaces the card's previous binding. The first arc drops out of `bound_arcs` — the sweep is live-bindings-only — with no stop, no receipt, and a record that reads live forever. `conductor::score_is_running` would still call that first dash's score live if anything rebound to it. **(verified)**

**[F05] `dash discard` mid-stage ends the record and the binding, and leaves the stage session working in a directory that no longer exists.** `run_discard` calls `ops::discard` (branch and worktree gone; `discarded` marker written, which `is_terminal` turns into `read_arc == None`) and then `broadcast_dash_gone`, whose server half `dash_api::dash_gone` clears every session's binding for that dash id and drops the draft. The runner's `read` returns `None` and `evaluate` returns silently. Nothing reaches the stage's claude: it still has `TUG_DASH_ARC` in its environment, its cwd is a deleted worktree, its next `tugutil dash step` fails "Dash not found", and its card shows nothing that says why — the card is still on the stage's model with no hand-back armed, because only the runner's `finish` calls `restore_deck_model` and `finish` never ran. This is the exact shape of `gauzy-snack`'s leftovers, now on the session side rather than the plan side. **(verified; the plan-side half was fixed in `a9c0d1235`)**

**[F06] Closing the card, or `dash unbind`, takes the arc out of the sweep with no record of it.** `SessionLedger::mark_closed` sets `state = 'closed'` and nulls the binding ([L27]); `bound_sessions_by_dash` selects `state = 'live'` only. The arc record stays live — `tugutil dash arc` says "review", no stop, no `done` — and no receipt is written anywhere because there is no card to show one on. Resuming it is possible but unnamed: `dash run <name>` from another card is a no-op on the record (`resume_arc` returns early because `stopped` is `None`), but the bind puts the arc back in the sweep, `stage_session_current` is false on the new card, and the stage re-rotates there. That is the right outcome reached by accident, and the receipt says "resuming" for a resume that never wrote a line. **(verified)**

**[F07] Relaunch is the one interruption with a written answer, and it holds.** The startup sweep runs before any deck reconnects; `session_snapshot` reads a `SpawnState::Idle` entry as a wait rather than a death (`a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop`); rebind seeds `turns_ended` and the claude id from the ledger row, so a stage that was idle between turns reads current and continues, and a stage whose claude died mid-turn reads not-current and is re-rotated. A pending *conductor* rotation does not survive the restart, by design (`tuglaws/conductor.md`, "A pending rotation does not survive a tugcast restart"). **(verified)**

**[F08] The machine-side failures have receipts; the user-side ones do not.** `format_arc_stop_receipt` knows six reasons — `lint`, `api error`, `review did not stamp`, `document missing`, `plan missing`, `session gone` — and every one is something that happened *to* the arc. There is no reason spelled for anything the user did. A stopped arc is resumable by `tugutil dash run <name>` in every case, and the receipt says so; that half is right and stays. **(verified)**

**[F09] A side question inside a stage is benign.** A `/btw` is a control-request overlay, never transcript ink, and it does not end the stage's turn; a question the stage itself raises (`AskUserQuestion`) blocks the turn until answered and ends it normally afterwards. Both leave the documents untouched, so the predicate at the next idle sees no edge. The `loose-shake` run's two `AskUserQuestion`s during devise behaved exactly this way. **(inferred from the turn model and one live observation)**

**[F10] The verbs do not cover the meanings.** `tugutil dash` has `discard` (everything gone), `join` (landed), `run` (open or resume), `unbind` (drop this card's binding, [F06]). There is no verb that means *stop the arc, keep the dash* — the only way to reach a stopped-and-resumable state today is to make something fail. `tugutil session rotate --cancel` withdraws a *pending* rotation and is unrelated. **(verified)**

---

## Decisions {#decisions}

**[B01] The doctrine is one table, in `tuglaws/dash-lifecycle.md`, under a new `## Interruptions` section after "Arcs and stages".** Rows are interruptions; columns are *what the arc does*, *what the user sees*, *how the work resumes*. Every row must have a non-empty third column, and every second column names a receipt on the card — a row whose "what the user sees" is "nothing" is a defect by definition. The table is the contract the plan's tests are written against, one test per row.

**[B02] A user gesture on a scored card takes the card, and the arc stops for it.** This is the rule behind [F01], [F02], and half of [F04], and it replaces the current behavior of overriding the gesture ([F02]) or misreading it as a document fact ([F01]). Concretely: a cancelled devise or review turn, a `/new`, or a bind to a different dash on a card running a score stops the arc with the reason `card taken`, hands the card back to the user's model, clears `TUG_DASH_ARC` on the next spawn, and writes the stop receipt. The stopped arc resumes through `tugutil dash run <name>` like every other stop ([F08]). The predicate gains one fact for it — `stage_turn_cancelled`, computed at the same edge that sets `turns_ended` — and one arm, placed with the API-error arm: a stage whose turn was cancelled did not answer, and is not judged.

**A cancel during implement sits.** The owner's call, made 2026-08-25. An implement stage is the one whose progress lives in the ledger rather than in the turn: a cancelled implement turn leaves the Step Status Ledger exactly as it was, the predicate at the next idle sees no `step_just_done` edge and returns `None`, and the user types the redirect into the same stage — which is what a cancel mid-implement almost always means. Stopping there would hand the card back and cost a rotation to say what the user was about to say anyway. So `card taken` on a cancel applies to devise and review only, where the turn *is* the product and a cancelled one has no document to be judged on.

**[B03] A model switch mid-stage is not a taking; it is honored, and it is recorded.** The user is steering the stage, not leaving it, and stopping the arc for a selector change would be hostile. What has to change is the resting lie in [F03]: the stage divider and the Review Record's model name must reflect the model that ran. The cheapest true answer is a `model_change` frame arriving on a scored card writing an `arc-note` line (`model → sonnet`) so the dash-log says it, and the deck's divider being re-rendered from the *session row's* `stage_model`, which the switch updates. The hand-back keeps returning the card to `deck_model`, which the switch already wrote.

**[B04] `dash discard` reaches the stage.** [F05] is the last discard turd. `dash_gone`'s server half, for every session it unbinds that is *currently seated by a stage* — the session row's `stage_label` is set and the arc it names is this dash — asks the conductor to hand the card back at that session's next turn end and, when the session is mid-turn, writes a receipt on the card now: `arc discarded · <dash> · the stage's turn will end and the card returns to <model>`. The stage's own tools already refuse correctly in a deleted worktree ("Dash not found"); what was missing is that anyone told the card. The stage session is not killed mid-turn — that would violate the conductor's turn-end rule — it is retired at its turn's end with the card handed back.

**[B05] A closed card stops the arc as `card closed`, and the stop is written even though no card can show it.** [F06]'s accidental resume becomes the designed one: `mark_closed` (already the binding's release under [L27]) also lets the runner write `arc-stop <stage> card closed` for any arc the closing session was seated on, so `tugutil dash arc` and the Lens both say the arc is stopped rather than silently live. `dash run <name>` from a fresh card then resumes it through the ordinary `arc-resume` path, and the receipt's "resuming" is finally true. `dash unbind` on a scored card is the same act with the same reason.

**[B06] One score per card is refused at the bind, not discovered at the sweep.** The conductor already refuses a rotation on a scored card (`Refusal::ArcRunning`); `dash_api::bind` must refuse the same way when the calling card is seated by a live score for a *different* dash: `card runs <dash> — stop it before binding <other>`. A bind that displaces a running score is the one interruption in the table that has no honest row, so it is removed rather than described. Binding the *same* dash again stays a no-op.

**[B07] One verb for the meaning the table needs: `tugutil dash stop <name>`.** It writes `arc-stop <current stage> stopped by user`, hands the card back, and prints the same receipt every other stop prints. It is what [B02] does implicitly, made explicit for a user who wants to stop an arc from a terminal without cancelling anything on the card. It is not `pause` — there is no paused state distinct from stopped, and a second word for the same record would be a lie about the record. `discard` keeps its meaning (everything gone); `join` keeps its; `run` stays open-or-resume.

**[B08] Every stop reason is a fixed word with a fixed sentence.** `format_arc_stop_receipt`'s table grows by `card taken`, `card closed`, `stopped by user`, and `discarded`, and the `other =>` arm that formats an unknown reason verbatim goes away: a reason the receipt cannot explain is a reason the arc must not write. The receipt's second line stays `resume with tugutil dash run <name>` in every case except `discarded`, where there is nothing to resume and the line says so.

**[B09] Relaunch stays as it is, and gets its row.** [F07] is right; the table records it so that the next person does not re-derive it from `session_snapshot`'s comment. The row for a pending conductor rotation lost to a restart points at `tuglaws/conductor.md` rather than restating it.

**[B10] Side questions get a row that says "nothing happens", and that is the only row allowed to say it.** [F09] is the one interruption whose correct handling is no handling; the row exists so that the table's completeness can be checked against the list of things a card can do, not so that anything is built for it.

---

## Open Questions {#open-questions}

- **Should a resume after `card taken` re-rotate the stage at once, or wait for the user's next turn to end?** Today the `resume` arm sits after the idle check, so `dash run` from inside a turn lands at that turn's end ([P05]). A user who typed `/new`, did something else, and then typed `tugutil dash run` probably wants the same. The devise round confirms the existing placement is right and says so in the row.
- **Does [B03]'s divider re-render need a deck change, or does the session row already drive it?** The conductor plan claimed no deck file changed because the divider reads `session_stage`'s `model` field, which is written once at rotation. If the divider is a render of the frame rather than of the row, [B03] costs a reducer case. The devise round reads `handleSessionStage` and decides.

---

## Non-goals {#non-goals}

- **A `pause` verb or a paused state.** Stopped-and-resumable is the one shape; see [B07].
- **Killing a stage session mid-turn on discard.** The conductor's turn-end rule holds; [B04] retires the stage at its turn's end.
- **Fanning an arc across cards.** One score per card ([B06]); a closed card's arc resumes on *a* card, never on two.
- **Any change to what a rotation is.** `tuglaws/conductor.md` is settled; this brief consumes it.
- **jj-style operation-log undo for arcs.** The dash-log is append-only and that is enough; a stopped arc is resumed by a line, not by rewinding one.

---

## Exit {#exit}

**A plan**, at `dash/interruption.md`. Its shape:

1. The predicate: `stage_turn_cancelled` in `ArcFacts`, computed at the dispatcher's edge beside `turn_api_error`; the `card taken` arm; `stage_session_current` false *because of a deck-originated `/new`* distinguished from *because the process died* — the distinguishing fact is whether the ledger row's `stage_label` still names the arc's stage (a rotation writes it; a `/new` clears it). Table tests over `arc_action`, one per row of [B01]'s table.
2. The receipts: [B08]'s table, with the `other` arm deleted; a test that every reason the predicate can emit has a sentence.
3. The bind refusal ([B06]) and `dash stop` ([B07]), with `tugutil dash stop` sharing `finish`'s hand-back path.
4. `dash_gone` → conductor hand-back and the on-card receipt ([B04]); `mark_closed` → `arc-stop card closed` ([B05]).
5. [B03]'s model note, and whatever the second open question decides about the divider.
6. The doctrine: the `## Interruptions` table in `tuglaws/dash-lifecycle.md`, every row citing the test that pins it.
7. Cover it live: one app-test per user-side row (`cancel`, `/new`, second `/dash`, discard from the shell route, close the card), each asserting the receipt on the card and the `tugutil dash arc --json` state, and each ending with a `dash run` that resumes.

The devise round settles both open questions by reading `handleSessionStage` and the resume arm's placement; nothing in this brief is left for the owner to decide.

The phase boundary is the table: once every row has a test and a receipt, the third brief in the series (`verify-fit` as a `tugutil dash verify` verb covering all of Tug) can assume that a dash it refuses to verify is a dash the user can see and stop.
