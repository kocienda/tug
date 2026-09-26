# A closed step ends its jobs

**Purpose:** Arcs keep hanging between implement steps. The step closes, the stage's turn ends, and nothing happens for twenty to thirty minutes until a person types into the card. The hang is not a missing watchdog: the runner's clock ticked on schedule the whole time and decided nothing, because a background job the stage had orphaned kept the session from ever reading idle, and the only timed remedy the machine has is to stop the arc.

---

## Purpose {#purpose}

The user's report, verbatim in its load-bearing parts:

> Too many times lately, arcs have gotten hung up in between steps. We need a better solution than just *hoping and trusting* that the current AI-driven Wheel mechanism will work. I think we actually need a watchdog that runs periodically to check the status of inflight arcs and ensures that they are not stuck.

And, from inside the hung stage itself, in the session the report points at:

> We're stuck. WHY are we stuck. What is the Wheel doing? What is it waiting for?

The report's premise is that nothing was watching. The records say something was watching every minute and saw the whole thing. So the problem is stated as a wrong definition rather than a missing poll: at a step boundary, the wheel treats a background job the stage left running as work still in progress, and it has no bounded way to move past one except a thirty-minute stop.

---

## Evidence {#evidence}

Times are UTC. The tugcast log is `instances/release-main/Logs/tugcast.log.2026-09-26` under the Tug application-support directory; the arc log is `projects/-Users-kocienda-Mounts-u-src-tug/arc-log.md` beside it; the stage's transcript is the claude JSONL for session `271311bb-4804-4ce1-ab7e-f4f6b5ef9bac`.

**[F01] The hang was a 23-minute gap between step 7 closing and step 8 opening.** The arc log for `motion-never-on-the-main-thread` reads `step-done 7/8` at 15:58:16 and `step-start 8/8` at 16:21:41. Nothing else about the arc changed in between except a base replay at 16:10. **(verified)**

**[F02] The runner's clock ticked forty times in that window and decided nothing every time.** Forty `arc.tick` lines fell between 15:58 and 16:22, one a minute from the 60-second interval in `run_arc_engine` plus a handful on edges. Every one read `step_just_done=true turn_active=false open_jobs=1 idle=false quiet_turns=0 decided=none action=none`. The tick the user's watchdog would have added would have read the same facts. **(verified)**

**[F03] The open job was an orphaned wait loop the stage itself launched and could never collect.** At 15:50:10 the stage ran a background `until tugtool deck motion probe … ; do sleep; done` to wait for a debug app instance to come up. At 15:53:52 it quit that app. The loop could then never exit. The supervisor logged `job_opened task_id=bbul6rv6k` at 15:50:11 and `job_closed` at 16:21:14, the moment the stage called `TaskStop` on it. No progress frame arrived for it in between. **(verified)**

**[F04] The stage closed the step and ended its turn with the orphan still running.** The transcript shows `tugtool arc step … done 7` at 15:58:16 and the turn's closing text at 15:58:20. The stage did not mention the background task and had no reason to; from its side the step was finished. **(verified)**

**[F05] The wheel's continue prompt is gated on idle, and idle means no turn and no open jobs.** `LedgerEntry::is_quiet` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` is `!self.turn_active && self.open_jobs.is_empty()`. The runner's `read` folds that into `session_idle`, and `implement_action` in `tugrust/crates/tugcast/src/feeds/arc.rs` reaches `Prompt { Continue }` only on a reading the settle gate passes, which requires idle. A step closed with a job open is a reading the predicate has no arm for: it returns `None` and the tick records `decided=none`. **(verified)**

**[F06] A person unstuck it, not the machine.** The user typed at 16:17:47 and 16:19:00. The stage diagnosed itself, found its own task, and stopped it at 16:21:14. The session read idle at 16:21:31, the five-second settle passed, and `arc.prompt kind=prompt:continue` landed at 16:21:36. **(verified)**

**[F07] Neither existing thirty-minute bound would have helped.** `JOB_REAP_HORIZON` is thirty minutes and `reap_stuck_jobs` runs only at the busy-set read point, never on a timer, and returns early while a turn is active, which the user's 16:19 prompt made true. The arc stall clock, `ARC_STALL_SECS_DEFAULT` of 1800 seconds measured from the 15:58 step-done stamp, would have fired at about 16:28, and its remedy is `arc-stop stalled` with the hand-back armed. The arc would have been stopped and waiting for a Resume press, which is a worse state than the hang. **(verified, read from the code; the 16:28 fire is arithmetic, not observed)**

**[F08] This one shape accounts for essentially all of the long between-step gaps in the last three weeks.** A census of the arc log over 21 days counted 622 step boundaries with a median of 12 seconds; 51 took over three minutes and 8 took over ten. Of the four longest, three carry the identical tick signature, open jobs with the step just done and decision none: `wizard-downloads` at 34 minutes on 2026-09-26 with `open_jobs=1` across 85 ticks, `non-modal-app-updates` at 32 minutes on 2026-09-22 with `open_jobs=2`, and `network-resilience` at 25 minutes on 2026-09-21 with `open_jobs=1`. The fourth, `cross-project-editing-contract` at 93 minutes, was a stop and a resume and is a different problem. **(verified)**

**[F09] A stage that backgrounds a job and means to collect it is a legitimate shape, and it is happening right now.** In the same session, step 8 launched a 50-file app-test selection in the background at 16:26:58 and said it would pick the result up when it landed. The step was still open. The distinction the machine has to draw is not "does a job exist" but "did the stage close the step while one existed". **(verified)**

**[F10] The card said nothing about what the wheel was waiting for.** `tugtool arc status` reported the stage, the step, and a last-activity time. The reason for the wait was only in the `arc.tick` line's `open_jobs` field in the tugcast log, which the stage had to locate and grep to answer the user. **(verified)**

---

## Decisions {#decisions}

**[B01] A step's background jobs do not outlive the step.** `tugtool arc step done` is the stage's own declaration that the step's work is over, so anything still running in the background at that moment is a leftover and not work. When the step-done line lands, the supervisor drops that session's open jobs from the busy set and tugcode stops the tasks behind them, and the step-done receipt names what was reaped so the stage sees it in its own transcript. This removes the cause behind [F03], [F04], and three of the four gaps in [F08]. It rules out the alternative of asking the wheel to guess which jobs matter: the step-done line already says. A job the stage means to collect, as in [F09], is collected before the step is closed, and the arc-implement skill states that rule in words. It would be revisited only if a stage turned out to need a job that legitimately spans two steps, and no arc in the census did.

**[B02] The card says what the wheel is waiting for.** `tugtool arc status` grows a `waiting:` line, and the card's arc strip shows the same words, whenever a tick decides nothing on a reading that is not idle: which jobs are open, what kind they are, and how long. The tick line already carries every one of these facts ([F02], [F10]); this is a display of them, not a new measurement. It lands with [B01] because [B01] removes the cause that is known and this makes the next cause visible without a log. The user's question in Purpose should be answerable from the card.

**[B03] At a step boundary the wheel fails toward motion, not toward a stop.** Where the predicate now returns `None` for a reading of step just done, turn ended, and jobs open, it gets a boundary horizon of about two minutes measured from the step-done stamp. Past it the wheel sends the continue prompt anyway and writes an `arc-note` naming the jobs it walked past. A prompt landing on a session with a background job is safe: claude queues it, and if the job later completes its wake is just another turn. This is the bound under [B01] for a shape nobody has foreseen yet, and it is the direction `briefs/arc-never-stops-brief.md` already chose: an arc never stops while its stage is working. The thirty-minute stall stop keeps its job, which is mid-turn silence, a different disease. The rule in one sentence: a boundary is a place the wheel may prompt, and mid-turn is a place it may only wait or stop.

**[B04] The job reaper runs on the runner's clock.** `reap_stuck_jobs` today runs only when the busy set is recomputed ([F07]), so its thirty-minute horizon is a bound only if something else changes. The arc runner's 60-second sweep already visits every seated entry; having it call the reaper makes the horizon a wall-clock bound. This adds no poll: the sweep exists, and the call is one more read on its way past.

**[B05] One app-test proves the boundary cannot be held open.** A test seats an implement stage in the real bundle, has it launch a never-ending background shell, close a step, and end its turn, then asserts the continue prompt arrives within the boundary horizon. This is the shape that has been red since the busy latch landed ([F05]), and it is what keeps [B01] and [B03] from regressing when the wire shape changes again.

**[B06] The order is [B01] and [B02] first, then [B03], then [B04], then [B05].** [B01] removes the cause; [B02] makes the next cause visible; [B03] is the bound; [B04] closes the reaper's hole; [B05] pins it all. The user approved this order explicitly.

---

## Open Questions {#open-questions}

- **Whether step-done kills leftover jobs or only stops counting them.** Killing is cleaner and loses nothing the step claimed; stop-counting is gentler if a stage backgrounded something it wanted in the next step. The recommendation is to kill and say so in the receipt, and the user has not yet said. Settled by the user.
- **The boundary horizon's length.** Two minutes is the proposal. The alternative is a multiple of the five-second idle settle. Settled by the user, or by the tripwire's measurements once [B05] exists.

---

## Non-goals {#non-goals}

- **A separate watchdog process or a second poll loop.** The runner already wakes on turn end, changeset recompute, settle, and a 60-second interval, and forty of those wakes read the hang and did nothing ([F02]). A second poller reads the same facts and reaches the same answer. The user rejected this explicitly after seeing the evidence.
- **A shorter stall clock.** Its remedy is a stop ([F07]). Shortening it stops more arcs sooner instead of unsticking them.
- **Making the wheel infer what the model meant by a job.** The step-done line is the stage's statement of intent; nothing is gained by second-guessing it.
- **Reaping jobs mid-step.** A stage that backgrounds a long test run and collects it before closing ([F09]) is doing the right thing, and the busy latch exists to protect exactly that window.

---

## Exit {#exit}

An arc. Its first move is [B01]: the step-done edge reaches the supervisor, the supervisor clears the session's open jobs and tugcode stops the tasks, and the receipt names them, with the arc-implement skill's text saying the rule. Beside it lands [B02], the `waiting:` line in `arc status` and on the card, since both read the same fields the tick already logs. Then [B03], the boundary horizon in `implement_action` and the runner with its `arc-note`, then [B04], the reaper call in the runner's sweep, and last [B05], the app-test that holds a step boundary open with an orphaned shell and asserts the prompt arrives anyway. The census in [F08] is the number to re-run when the arc is done: the count of boundaries over ten minutes should fall to zero for this shape.
