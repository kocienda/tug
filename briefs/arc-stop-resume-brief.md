# Stop is a protocol with an end, and Resume picks up what it left

**Purpose:** Pressing Stop on an arc in the Arcs card records a stop and flips the row to Resume, but on every real arc the session keeps working: the interrupt misses the card, background work is never touched, and the record is written before anything has actually stopped. Resume then trusts a record that does not describe the tree. Both gestures must be rock solid: a stop that ends all the arc's work, and a resume that picks the arc up from exactly where the stop left it.

---

## Purpose {#purpose}

The user's ask, verbatim:

> When I hit the stop on an arc in the Arcs card, the session really should stop all its work (including background tasks), and set it up in a way that hitting *play/resume* later can pick up the arc from where it left off.
>
> This *sorta* works right, but not completely. Investigate why and make a sketch to fill out the behaviors properly. This stop/resume must be *rock solid and completely reliable*.

"Sorta works" is exact. The record flips and the button settles green, which is the visible half; the invisible half — the claude, its background jobs, its shell children — carries on. This brief says why, and what a stop and a resume have to be for the visible half to be true.

The button itself is [D178]'s transport control, decided in `briefs/arc-start-stop-brief.md`. The wheel's own stops and their vocabulary are `briefs/arc-never-stops-brief.md`. This brief is about what the user's Stop and Resume *do*, and it changes neither the control nor the vocabulary.

---

## Evidence {#evidence}

**[F01] The Stop button's interrupt, hand-back and receipt all miss the card on any arc that has dispatched a stage.** `arc_api::arc_stop` (`tugrust/crates/tugcast/src/arc_api.rs:430-482`) resolves the pressed id through `calling_segment` to the line's *live segment*, and returns that as `session_id`. `stop_arc_now` (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs:6446-6508`) then does `self.ledger.get(&session_id)` — a map keyed by the card's own tug session id, which never moves. A rotation records the stage's claude session id as a fresh ledger row and moves the binding onto it, so after any stage dispatch the live segment is an id no supervisor entry wears. The lookup finds nothing, `turn_active` reads false, and **no interrupt is sent**. `stop_arc_for_session` (`arc_runner.rs:2542-2612`) addresses `wheel::hand_back` and `record_arc_receipt` by the same id: the hand-back returns `UnknownSession` and is only logged, and the receipt is broadcast to a session id no card matches. The `arc-stop` line still lands and `arc_stop_ok` still answers green. The lineage walk that resolves a segment to its card exists — `AgentSupervisor::card_entry_for_segment` (`agent_supervisor.rs:7913`) and `arc_runner::card_session_for_segment` (`arc_runner.rs:392`) — and the wheel's own stops use it; the button's path does not. **(verified)**

**[F02] The one app-test for Stop runs in the only case where [F01] cannot bite.** `tests/app-test/at0523-arc-transport-stop.test.ts` deliberately seats no claude and rotates nothing, so the segment id and the card id are one string and the direct key matches. Its docblock says the interrupt branch "is pinned in Rust over a `LedgerEntry` with a captured `input_rx`" — and that Rust pin also uses a pre-rotation id. Nothing in the tree drives a Stop against a rotated, working stage. **(verified)**

**[F03] Where the interrupt does fire, it is one fire-and-forget control request and nothing else.** `stop_arc_now` sends `{"type":"interrupt"}` through `dispatch_one`, which is awaited only as far as the per-session mpsc send (`agent_supervisor.rs:10829`). tugcode's `handleInterrupt` (`tugcode/src/session.ts:7597-7614`) writes a `control_request` of subtype `interrupt` to the CLI's stdin and arms a 2-second ack grace; unacked, `forceTerminateAndRespawn` sends SIGINT with a 1.5-second grace, then SIGKILL, then respawns (`session.ts:4024-4041`, `:4180-4188`). The stop path does not wait for any of it and nothing correlates the eventual `turn_cancelled` back to the stop. **(verified)**

**[F04] Background work the stage launched is never stopped, and the stop path never looks at it.** The supervisor already tracks every backgrounded `Bash`, `Agent` and `Monitor` per session in `LedgerEntry::open_jobs` (`agent_supervisor.rs:490-532`), keyed by task id with a provisional launch key. `stop_arc_now` does not read it. The only frame that ends a background job is `stop_task`, and its sole producer is the Jobs card (`tugdeck/src/lib/code-session-store.ts:1272-1285` → `tugcode/src/inbound-dispatch.ts:110`); no Rust code sends it. Subagent tailers are flushed, not killed, and only on `killAndCleanup`. Workflow, Monitor, `ScheduleWakeup` and cron are observed by tugcode only to predict wakes (`session.ts:6556-6620`); no cancellation path exists for any of them. **(verified)**

**[F05] Shell children of the stage are never signalled.** tugcast puts itself in its own process group at startup (`tugrust/crates/tugcast/src/main.rs:145-149`) and tugcode, bun, the claude CLI and every command it runs inherit it; the only group-wide signal in the tree is tugcast's own shutdown (`main.rs:2113-2120`). tugcode's escalation ladder signals `child` alone — the CLI pid — so even a SIGKILL orphans a running `just app-test` or `cargo build` rather than ending it. The shell feed does this correctly for its own children with `setsid` before exec (`feeds/shell.rs:669-678`) so that `kill(-pid)` reaps the tree; the arc path has no equivalent. **(verified)**

**[F06] The survivors wake the session, and the model resumes working on a card the deck believes is stopped.** A background completion opens a wake turn (`arc-lifecycle.md:77`). A user stop is correctly excluded from the runner's silence-reversal path (`feeds/arc.rs:361-367`; the stopped-record arm at `arc_runner.rs:566-599` reverses only judged silence), so the runner ignores those wakes — but the model does not. It reads the completion, continues editing, and may commit, on a card the record calls stopped and the deck has handed back. **(verified by reading; not reproduced live)**

**[F07] The stop records first and stops later.** In `stop_arc_now` the interrupt send, the model-change hand-back, the receipt, the `arc-stop` line and `arc_stop_ok` are one await chain, milliseconds apart, while the claude in the wedged case takes about 3.5 seconds and a respawn to actually stop. The hand-back therefore reaches a card that is mid-turn by construction — the act `briefs/arc-never-stops-brief.md` [B08] recorded a decision against for the wheel's stops, whose `HandBack::Send` is earned only by a settled idle (`arc_runner.rs:2626-2644`). The pin named there constrains the wheel's path, not the button's. **(verified)**

**[F08] A rotation in flight erases a stop pressed during it.** `read_arc`'s fold clears `stopped` on any `arc-stage` line (`tugarc-core/src/arc.rs:558-567`), and a rotation's `arc-stage` line is written by the bridge only when claude announces its segment (`feeds/agent_bridge.rs:1572-1620`). Runner dispatches → user presses Stop → `arc-stop` appended → segment arrives → `arc-stage` appended → the arc reads as running again with no stop and a Stop face. `arc_api::arc_stop` has no in-flight check; the runner's `in_flight_at` latch (`arc_runner.rs:110`, `:663-679`) is private to the runner. **(verified)**

**[F09] The button's stop and the wheel's sweep share no lock.** Both read the record and append independently. `evaluate`'s early return on `record.stopped` and `arc_stop`'s refusal of an already-stopped arc are both post-hoc, so a press landing between the wheel's read and its own `append_arc_stop` stacks two stop lines with different reasons; last wins, and the receipt the user sees may be the machine's. **(verified)**

**[F10] A user stop evicts nothing from the runner's memory.** `finish` evicts the arc's `ArcState` and re-seeds `StopMarks` (`arc_runner.rs:2647-2668`); `stop_arc_now` and `stop_arc_for_session` never touch the map, so a stale `last_motion_at`, `quiet_turns` and `pending` survive the stop with no `stop_marks`. Benign today only because `StoppedByUser` is never reversed and the resume arm outranks the clock (`feeds/arc.rs:387-410`) — the same shape as the [F09] incident in the never-stops brief, held off by arm order. **(verified)**

**[F11] Resume is sound in shape.** `arc_resume` (`arc_api.rs:308-342`) refuses another live holder before writing, appends `arc-resume <stage>` only when a stop stands (so a double press is a no-op), then binds; the bump wakes the runner within seconds. The resume arm (`feeds/arc.rs:403-427`) sits above the stall clock, waits for idle, and yields `Continue` on the stage's own still-seated session (same transcript, [P08]) or `Rotate` on a taken card. `continue_stage` (`arc_runner.rs:2276-2415`) puts the stage's model back, re-makes the seat idempotently, and composes the ask with a `where` line and a resume clause read from `last_stop`. The step ledger's first row that is neither `done` nor `withdrawn` is the resume pointer (`arc_runner.rs:1451-1458`). **(verified)**

**[F12] The rotate-resume path drops the resume clause.** `opening_prompt` reads `reading.record.stopped` (`arc_runner.rs:1621-1625`), which the `arc-resume` line has already cleared; `prompt::compose`'s own docblock (`wheel/prompt.rs:238-242`) warns that a caller reading that field "would drop the clause on exactly the prompts it exists for". So a fresh session resumed onto a taken card is never told the arc was stopped or why. Only the continue path is pinned (`arc_runner.rs:6013-6018`). **(verified)**

**[F13] The continue path runs no doctor and no document check.** `rotate` runs `tugarc_core::doctor::doctor` and stops as `RecordsDisagree` before seating (`arc_runner.rs:1932-1974`) and stops as `DocumentMissing` (`:1978-1981`); `continue_stage` does neither. `tugplug/skills/arc-implement/SKILL.md:45` tells the stage the runner "ran `arc doctor`'s comparison … immediately before" its `where` line, which is false on the continue path. The doctor already has findings for an interrupted step — `open-step-status`, `open-step-missing-row`, `undeclared-open-row` (`tugarc-core/src/doctor.rs:252-296`). **(verified)**

**[F14] Nothing reconciles a step interrupted mid-way.** No code on the resume path reads the worktree's dirty state, a row left `in progress`, or a test the interrupted turn started; the reconciliation is one sentence of skill prose (`arc-implement/SKILL.md:34`: re-enter the `in progress` row, which `arc step start` accepts idempotently). A same-session resume can recover from its transcript. A rotated one is handed `implement Step N` for the half-done step over a dirty tree it was never told about. `worktree_dirty` exists only in `arc status` and `join_ready`. **(verified)**

**[F15] Two resume states the runner cannot leave.** A Resume pressed while the card's turn never ends leaves `stopped` clear and `resume` set, and the resume arm's own idle check returns `None` above the stall clock (`feeds/arc.rs:403-406`, `:434`), so the hung turn is unreachable by the one arm that exists for it. And a Resume on a card whose claude has died is caught by `!session_live` above the resume arm (`feeds/arc.rs:380-386`), which writes a fresh `session gone` stop over the reason the user was reading — the press produced a different stop, not a resume. **(verified)**

**[F16] A resume on an unspawned card is clocked as a stall.** `session_snapshot` is `None` for an entry parked `Idle` that this process never saw live, so `evaluate` diverts to `watch_the_clock_unseated` (`arc_runner.rs:874-971`), which returns early only for `done` or `stopped` — a resumed record is neither, so the resume waits on an idle that arrives only when the deck spawns the card and is otherwise stopped as `stalled`. **(verified)**

**[F17] The press has no horizon.** `arcPressStore` (`tugdeck/src/lib/arc-press-store.ts`) releases a pending press only on an `_ok` or `_err` frame; a frame nobody answers is a permanently greyed control, and a refusal that arrives without a session id is released but its reason is dropped (`action-dispatch.ts:1456-1461`). **(verified)**

---

## Decisions {#decisions}

**[B01] A user stop is a protocol with an end, and the record is the last thing it writes.** Today the `arc-stop` line is written first and everything it claims happens later, if at all ([F07]). Reversed: the stop resolves its card, quiesces the session, and only then hands back, records, and answers. The receipt and the row's Resume face therefore say something true, and `arc_stop_ok` means the arc has stopped rather than that a line was appended. What would revisit this is a reason to want a stop that reports before it lands, and there is none: the whole complaint is that the report ran ahead of the act.

**[B02] Every effect of the stop is addressed to the card, resolved from the pressed segment through the lineage walk.** The decide half may keep resolving to the live segment for the holder comparison it needs, but the perform half converts back through `card_entry_for_segment` before it reads `turn_active`, sends the interrupt, hands back, or records the receipt ([F01]). A segment with no live card is a refusal by sentence, never a green answer. This is `briefs/wheel-rotation-strands-the-arc.md`'s rule applied on the way out as it was applied on the way in.

**[B03] "Stop all its work" means the turn, every background job, every scheduled wake, and the process group — in that order, each awaited.** The quiesce is: interrupt the turn and wait for the cancel edge or for tugcode's escalation to finish; send `stop_task` for every open job in the session's `open_jobs`, dropping the launch-keyed provisional entries; cancel every Monitor, Workflow, `ScheduleWakeup` and cron tugcode knows of for the session; then signal the claude's process group so that shell children the stage launched end with it ([F04], [F05]). The group signal is the hard reading of the ask and it is chosen deliberately: a stop that leaves a test sweep or a build running is exactly the surprise this brief exists to remove. It requires tugcode to spawn the CLI as its own process group, the way the shell feed already does with `setsid`.

**[B04] The stop is done when the session is quiet in the supervisor's existing sense — no turn active and no open jobs — and it is bounded.** `is_quiet` is already the two facts read together ([F04]); the stop waits on that edge rather than on a timer, with a ceiling on the order of tugcode's escalation ladder plus a margin. A stop that cannot reach quiet inside the ceiling answers `arc_stop_err` naming the step it stalled on, and keeps its pending mark ([B05]) so the next press retries the protocol rather than reporting a second stop.

**[B05] A stop-pending mark is set before anything else and outranks a rotation in flight.** Set on the arc's runner state and the record before the interrupt is sent, it does three things: the wheel's sweep stands down for the arc ([F09]); an `arc-stage` line arriving from a rotation dispatched before the press cannot clear the stop, because the fold reads the mark ([F08]); and a Resume pressed during the protocol is refused by sentence rather than interleaved ([F11]'s idempotence is not enough when the stop has not finished). The mark is cleared by the `arc-stop` line that ends the protocol or by the `arc_stop_err` that abandons it.

**[B06] The user's stop evicts the runner's memory the way the wheel's stops do.** `stop_arc_now` performs `finish`'s eviction and seeds `StopMarks` ([F10]). A stopped record is read for one thing only, and a stale clock left behind by the button is the wedge the never-stops brief already paid for once.

**[B07] Resume runs `arc doctor` on both paths and lets its open-step findings choose the pointer.** The continue path gains the same five-record comparison the rotate path runs ([F13]), and a row left `in progress` is handled by which session is resuming: the stage's own session re-enters it, since its transcript knows what it changed; a rotated session has the row reset to `pending` first, since it has no way to know. The skill sentence at `arc-implement/SKILL.md:45` becomes true rather than being edited.

**[B08] Every resume prompt says the arc was stopped and why, and names a dirty tree when there is one.** `opening_prompt` reads `last_stop` as `continue_stage` already does ([F12]). Both prompts gain one clause when the worktree carries uncommitted changes: that the tree is dirty and that the edits are the arc's own from the step it was stopped in ([F14]). A rotated session resuming onto a half-done step then knows the two things it cannot see in its transcript.

**[B09] A resume never strands the arc in a state no arm can leave.** A resume waiting on an idle that does not arrive inside the stall deadline stops as `stalled` with the resume retained, so the clock is reachable again and the next press means something ([F15]). A resume on a card whose claude has died spawns and rotates rather than re-stopping as `session gone`: the user has just said go, and a second stop over their press is the wrong answer ([F15]). A resume on an unspawned card is not clocked; it waits for the spawn, which is the deck's act, and the unseated clock path treats a standing `resume` as it treats a standing `stopped` ([F16]).

**[B10] A press has a horizon.** `arcPressStore` releases a press that no frame answers within a bound on the order of the stop ceiling ([B04]) and speaks "no answer" through the pane bulletin; a refusal with no session to route to is spoken through the followed card rather than dropped ([F17]).

**[B11] The end-to-end test seats a claude and rotates it first.** The stop's claim is only reachable on a rotated, working stage ([F02]). One app-test stops an arc with a real stage seated, a background job open and a shell child running, and asserts in order: the turn cancelled, the job ended, the child gone, the receipt on the card, the model handed back, the record written last, and the row reading Resume. Rust pins cover the segment-to-card resolution ([B02]), the stop-pending guard against an in-flight rotation ([B05]), the eviction ([B06]), the resume clause on the rotate path ([B08]), and each of the three strandings ([B09]).

---

## Open Questions {#open-questions}

- **[B03]'s process-group kill and [B04]'s wait were recommended in the sketch and not contradicted, but not explicitly affirmed either.** Both follow from "stop all its work" and "rock solid" and this brief takes them as decided. If the softer reading is wanted — interrupt the model and let running commands drain — say so before the arc opens, since it changes what tugcode's spawn has to do.

---

## Non-goals {#non-goals}

- **The control's face, sizes, refusals and the surfaces it sits on.** Decided by [D178] and `briefs/arc-start-stop-brief.md`; nothing here changes how the button looks or which card it acts as.
- **The wheel's own stops and their vocabulary.** `briefs/arc-never-stops-brief.md` owns judged silence, reversal, the settle gate and `ArcStopReason`; this brief adds no reason word and changes no reversal rule. A user stop stays unreversible.
- **A stop that lets the turn finish.** Rejected in the start/stop brief ("halt now") and not reopened: the user's Stop halts.
- **Interrupting through the Jobs card's `stop_task` from the deck.** The stop is one server-side protocol so that `tugtool arc stop`, a closing card and the button all quiesce the same way; putting any of it in the deck would give the CLI door a different stop.
- **Making a user stop reversible by a wake.** The survivors in [F06] are to be ended, not listened to; a stop that a background completion can undo is the opposite of reliable.
- **Killing the tugcast process group.** [B03] signals the claude's own group, which tugcode has to create; the tugcast-wide signal is shutdown and stays so.

---

## Exit {#exit}

**An arc.** The shape, in the order the pieces stand on each other:

1. **Address the card.** [B02] in `stop_arc_now` and `stop_arc_for_session`, with the Rust pin that a post-rotation stop interrupts, hands back and delivers its receipt to the card. This alone turns "sorta works" into "works for the current turn".
2. **The pending mark and the eviction.** [B05] on the record fold and the runner, [B06] in `stop_arc_now`, with pins for the in-flight rotation and the stacked-stop race.
3. **The quiesce.** [B03] and [B04]: tugcode spawns the CLI in its own process group and gains a `stop_session_work` handling that ends jobs, cancels scheduled wakes, and signals the group; the supervisor drives interrupt → jobs → wakes → group and waits on `is_quiet`, bounded, answering `_ok` only at the end and `_err` with the stalled step.
4. **Resume reconciles.** [B07], [B08], [B09] in `continue_stage`, `rotate`, `opening_prompt`, the resume arm and the unseated clock path, with a pin per stranding.
5. **The deck's horizon.** [B10] in `arc-press-store.ts` and `action-dispatch.ts`.
6. **The chain.** [B11]'s app-test, carrying `@covers`, run last because every earlier piece is a link in it.

Each piece verifies with `cargo nextest run` for the crates it moved and `just app-test-changed` for the deck.
