# The cycle keeper: a model pass that tends a cycle from evidence

**Purpose:** Arcs and briefs on a cycle do not lead back to the conversations they came from, and nothing looks across sessions to keep a long run of work true as it changes. This brief adds a keeper: a model pass that wakes on a few events, reads the evidence, and tends the cycle on its own.

---

## Purpose {#purpose}

Shown a cycle whose later entries had no visible sketch, the user said:

> A *sketchless brief* seems wrong. … Those arcs and briefs need to be grounded on *something*, eh? They didn't just spring up out of the ground!

> We need a mechanism to trace where arcs and briefs come from, and find the conversations, or the interactions in the transcript, even if it's in other sessions … there's *always a sketch*, even if we need to fill one in after the fact.

> maybe we need some kind of process that is running. Or can run when needed that is informed and driven by an AI interaction and perhaps a skill or a prompt of some sort that is helping us construct and keep track of this cycle structure.

On whether it asks before it acts: "this should be automatic, I think." On cost: "this is fine, as long as we aren't running the thing all the time."

This brief is the third of three. It is written from `briefs/work-records-brief.md`, which gives the records and facts the keeper reads and writes, and `briefs/work-statement-brief.md`, which records the lists a session states.

---

## Evidence {#evidence}

**[F01] A cycle is written only at the two moments a skill runs.** `/tugplug:brief` and `/arc` each write what they can see from inside one session at one instant. Nothing goes back afterwards and nothing reads another session. **(verified, from `tugplug/skills/brief/SKILL.md` and `tugplug/skills/arc/SKILL.md`)**

**[F02] A sketch written by the door from a brief leads nowhere.** Sketch A of liven's cycle `bb8f39b5` restates its brief. The turns of `liven/rotund-plaid` that settled the hundred cast members, their batches and their order are not reachable from it. **(verified)**

**[F03] Work that was on no list changed the briefs ahead, and nothing said so.** Two review rounds, `liven-cast-rig-fixes` and `liven-people-animals-round`, landed in other sessions in the middle of the run. The user then asked the steward session by hand, in its turn 21, to read both sessions and revise the remaining briefs before continuing. **(verified, from the steward's transcript)**

**[F04] The Observer is the wrong home.** It narrates one session at a time. It reads only its own digest of the session that woke it, with each assistant answer cut to a hundred characters. It is given no tools, and a test pins that it never uses the semantic index. One of its wakes is a sixty-second timer. By design it writes nothing toward any work. Read from `tugrust/crates/tugcast/src/feeds/observer.rs`, `observer_wake.rs` and `overview_agent.rs`. **(verified, by a delegated search)**

**[F05] The shared agent pool is the right runner.** `SharedAgentPool` in `tugrust/crates/tugcast/src/feeds/shared_agent.rs` keeps isolated `claude` workers with no tools, runs only jobs named in a fixed table, and refuses to spawn under app-test. No path accepts an arbitrary prompt. **(verified, by a delegated search)**

**[F06] The Operator's pattern already reads what the keeper needs.** One job names read-only verbs, Rust runs them, and a second job answers, for at most two rounds of six verbs. The verbs in `tugrust/crates/tugcast/src/feeds/operator.rs` read any session's transcript by turn, on any project on the machine, plus the semantic index, the facts table, the changes ledger and git. Private sessions are refused throughout. **(verified, by a delegated search)**

**[F07] The Observer and the Operator share one lane of the pool.** An Observer post can make an Operator question wait. **(verified, by a delegated search)**

**[F08] The Observer's references are checked against what the model was shown.** A post may cite only what its input contained. The same rule fits a keeper's changes. **(verified, by a delegated search)**

---

## Decisions {#decisions}

**[B01] The keeper is a third occupant of the shared pool, shaped like the Operator, and never part of the Observer.** It is two jobs in the pool's table: one that names read-only verbs to run, and one that decides. It reuses the Operator's verbs for reading. It runs in a lane of its own, so it never delays a narration or a question ([F07]).

**[B02] The model returns changes, and Rust applies them.** The deciding job returns a list of cycle changes, each with the evidence it rests on as a session and a turn. Rust checks every change against what the model was shown ([F08]) and applies it through the core's verbs, which still refuse a broken chain. The model never writes a record.

**[B03] It wakes on events, never on a timer.** The events are facts from the other two briefs: a list of arcs was stated, a brief was committed, an arc joined, an arc was discarded. The user can also ask for a cycle to be kept, with a verb. Nothing polls.

**[B04] No model turn runs unless the evidence changed.** A list restated word for word, and any event the mechanical rules already settled, wake nothing. One run tends one cycle at a time, and events that arrive during a run fold into the next. This is what keeps it from running all the time.

**[B05] It grounds every entry in a sketch with sources.** For a sketch whose only source is a brief ([F02]), and for arcs held with no cycle because none of their briefs had a sketch, the keeper finds the turns where the work was settled and writes the sketch from them, in the doctrine's shape and the user's words. The sketch's record says it was filled in afterwards and names each source. There is always a sketch, and it always leads somewhere.

**[B06] It keeps the queue true where judgment is needed.** A session's own restated list is replaced mechanically by the statement brief. The keeper handles what that rule cannot: two sessions that state different lists for one cycle, and an arc that was opened under a name no list used.

**[B07] It places work that was on no list.** An arc that landed in the middle of a run is put on the cycle where it landed, marked as unlisted, and tied to the session that ran it ([F03]).

**[B08] It says when the briefs ahead are stale.** When work has landed since the briefs still ahead were last changed, the keeper records that on the cycle, naming what landed. It does not edit a brief. Revising a brief is a session's work, and the surface offers to fill a prompt asking for it.

**[B09] It never touches the arc link of an entry that is running or has landed.** That link is the invariant `920f2ab2a` protects. The keeper's reach is sketches and their sources, entries no arc has opened, the unlisted mark, the stale note and its own log.

**[B10] It acts on its own and shows what it did.** There is no confirm step. Every change is written to a log on the cycle with its evidence, and the cycle's surfaces show the log, so the user can follow any change back to the turn it came from. The user corrects it by saying so in a session, which is new evidence.

**[B11] It reads no private session.** The Operator's verbs already refuse one, and the keeper uses those verbs.

**[B12] It has its own switch and its own model setting.** Both are tugbank settings read on every wake, as the Observer's are. Off means no model turn; the mechanical rules of the other two briefs keep working.

**[B13] An ended cycle is left alone.** A closed cycle wakes nothing. A model turn writing on work the user has finished is not help.

---

## Open Questions {#open-questions}

- **How the keeper finds the turns that settled a piece of work.** The candidates are the sessions that wrote the brief, the sessions those cite, and the semantic index over transcripts. The index is an aid and may not answer. What would settle it: running the retrieval against liven's steward session and seeing whether the sources the Cycle Progression spike drew for sketch A are the ones found.
- **What a correction looks like.** "That arc does not belong on this cycle", said in a session, has to reach the keeper as evidence it will not overrule next time. Whether that is a fact kind of its own or a mark on the record is not settled.
- **Whether a run's cost is shown.** Each run is at most two retrieval turns and one deciding turn. Liven's day would have been about fifteen runs. The Observer's posts record their tokens; whether the keeper's log does the same is the user's call.

---

## Non-goals {#non-goals}

- **Editing a brief.** The keeper flags a stale brief and never rewrites one ([B08]).
- **Starting, stopping, joining or discarding an arc.** It tends records. It runs no arc verb.
- **Narrating.** The Observer narrates sessions. The keeper posts nothing to the Overview.
- **A confirm step.** Rejected by the user in favour of automatic action with a visible log.
- **Living inside the Observer.** Rejected on [F04].
- **A timer or a sweep.** Rejected by the user and by the product's rule against polling.

---

## Exit {#exit}

**An arc**, opened after the other two have landed:

- The keeper's two jobs in the pool's table, its lane, its switch and its model setting.
- The wake: the fact kinds it follows, the changed-evidence test, and one run per cycle.
- The change envelope, the check of each change against what the model was shown, and the apply through the core.
- The log on the cycle record and the stale note, carried on the wire.
- The verb that asks for a cycle to be kept.
- A replay over liven's recorded day as the test of whether it grounds and tends as intended, in the manner of the Operator's evaluation, on real model turns and outside the fast lane.

How the shade shows the log and the sources is drawn in the Cycle Progression spike and waits on the user confirming that spike.
